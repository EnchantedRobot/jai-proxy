#!/usr/bin/env python3
"""Compile userscript/src/*.js into userscript/saucepan-proxy-bridge.user.js.

The bridge is authored as small modules under userscript/src_saucepan/ and concatenated,
in the order below, inside a single IIFE. `00-banner.js` is the Tampermonkey
`==UserScript==` banner and sits ABOVE the IIFE; every other module is authored
already indented two spaces (as it appears inside the IIFE) and is emitted
verbatim, so template literals (e.g. the overlay CSS) are never re-indented.

Run via `make compile` or `python scripts/compile_userscript_saucepan.py`.
"""
from __future__ import annotations

import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "userscript" / "src_saucepan"
OUT = Path(__file__).resolve().parent.parent / "userscript" / "saucepan-proxy-bridge.user.js"

# Explicit concatenation order (NOT filename sort — the modules have logical,
# not alphabetical, dependencies).
BANNER = "00-banner.js"
MODULES = [
    "content.js",
]


def _read(name: str) -> str:
    path = SRC / name
    if not path.exists():
        sys.exit(f"compile_userscript: missing source module {path}")
    return path.read_text(encoding="utf-8").rstrip("\n")


def compile_userscript() -> str:
    banner = _read(BANNER)
    body = "\n\n".join(_read(name) for name in MODULES)
    return f'{banner}\n\n(function () {{\n  "use strict";\n\n{body}\n}})();\n'


def main() -> None:
    OUT.write_text(compile_userscript(), encoding="utf-8")
    print(f"compiled {len(MODULES) + 1} modules -> {OUT.relative_to(Path.cwd())}")


if __name__ == "__main__":
    main()
