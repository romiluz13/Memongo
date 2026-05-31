#!/usr/bin/env python3
"""Run official memory-benchmarks modules through Grove's OpenAI-compatible API.

This is a transport shim only. It does not modify benchmark prompts, scorers,
datasets, saved artifacts, or model outputs.
"""

from __future__ import annotations

import os
import runpy
import sys


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
    sys.argv = [module, *sys.argv[2:]]
    runpy.run_module(module, run_name="__main__")


if __name__ == "__main__":
    main()
