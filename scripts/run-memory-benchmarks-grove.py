#!/usr/bin/env python3
"""Run official memory-benchmarks modules through Grove's OpenAI-compatible API.

This is a transport shim only. It does not modify benchmark prompts, scorers,
datasets, saved artifacts, or model outputs.
"""

from __future__ import annotations

import os
import runpy
import sys
import asyncio
import logging


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(
            "usage: run-memory-benchmarks-grove.py <module> [module args...]",
        )

    grove_key = os.environ.get("GROVE_API_KEY", "").strip()
    if not grove_key:
        raise SystemExit("GROVE_API_KEY is required")

    grove_base_url = os.environ.get("GROVE_BASE_URL", "").strip()
    if not grove_base_url:
        raise SystemExit("GROVE_BASE_URL is required")

    os.environ.setdefault("OPENAI_API_KEY", grove_key)
    os.environ.setdefault("OPENAI_BASE_URL", grove_base_url)

    import openai

    original_async_openai = openai.AsyncOpenAI

    def grove_async_openai(*args, **kwargs):
        headers = dict(kwargs.pop("default_headers", {}) or {})
        headers.setdefault("api-key", grove_key)
        kwargs["default_headers"] = headers
        return original_async_openai(*args, **kwargs)

    openai.AsyncOpenAI = grove_async_openai

    module = sys.argv[1]
    sys.path.insert(0, os.getcwd())

    blank_retries = int(os.environ.get("MEMONGO_GROVE_BLANK_GENERATION_RETRIES", "3"))
    if blank_retries > 0:
        try:
            from benchmarks.common.llm_client import LLMClient

            original_generate = LLMClient.generate

            async def generate_with_blank_retry(self, system, user, temperature=0, max_tokens=4096):
                for attempt in range(blank_retries + 1):
                    text = await original_generate(self, system, user, temperature, max_tokens)
                    if text.strip():
                        return text
                    if attempt < blank_retries:
                        logging.getLogger("memory-benchmarks.grove").warning(
                            "Generation returned blank text; retrying %d/%d",
                            attempt + 1,
                            blank_retries,
                        )
                        await asyncio.sleep(2 * (attempt + 1))
                return text

            LLMClient.generate = generate_with_blank_retry
        except ModuleNotFoundError:
            pass

    sys.argv = [module, *sys.argv[2:]]
    runpy.run_module(module, run_name="__main__")


if __name__ == "__main__":
    main()
