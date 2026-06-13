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
from typing import Any


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

    try:
        from benchmarks.common.llm_client import LLMClient

        original_init = LLMClient.__init__
        original_generate_structured = LLMClient.generate_structured

        min_max_tokens = int(os.environ.get("MEMONGO_GROVE_LLM_MIN_MAX_TOKENS", "0"))

        def boosted_max_tokens(max_tokens: int) -> int:
            if min_max_tokens <= 0:
                return max_tokens
            return max(max_tokens, min_max_tokens)

        def init_with_memongo_defaults(self, *args: Any, **kwargs: Any):
            timeout = os.environ.get("MEMONGO_GROVE_LLM_TIMEOUT_SECONDS", "").strip()
            max_retries = os.environ.get("MEMONGO_GROVE_LLM_MAX_RETRIES", "").strip()
            if timeout and "timeout" not in kwargs:
                kwargs["timeout"] = float(timeout)
            if max_retries and "max_retries" not in kwargs:
                kwargs["max_retries"] = int(max_retries)
            return original_init(self, *args, **kwargs)

        LLMClient.__init__ = init_with_memongo_defaults

        async def generate_structured_with_min_tokens(
            self,
            system,
            user,
            response_format=None,
            temperature=0,
            max_tokens=4096,
        ):
            return await original_generate_structured(
                self,
                system,
                user,
                response_format,
                temperature,
                boosted_max_tokens(max_tokens),
            )

        LLMClient.generate_structured = generate_structured_with_min_tokens

        blank_retries = int(os.environ.get("MEMONGO_GROVE_BLANK_GENERATION_RETRIES", "3"))
        if blank_retries > 0:
            original_generate = LLMClient.generate

            async def generate_with_blank_retry(self, system, user, temperature=0, max_tokens=4096):
                for attempt in range(blank_retries + 1):
                    text = await original_generate(
                        self,
                        system,
                        user,
                        temperature,
                        boosted_max_tokens(max_tokens),
                    )
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
