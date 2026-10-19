#!/usr/bin/env python3
"""Copy the pages and their files into dist/web for the Tauri build (frontendDist).

    python3 tools/build_web.py

Only the files the app serves, so the desktop bundle doesn't embed tests,
tools or src-tauri/target.
"""
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dist" / "web"

if OUT.exists():
    shutil.rmtree(OUT)
OUT.mkdir(parents=True)
for f in ["index.html", "diff.html", "inbox.html"]:
    shutil.copy2(ROOT / f, OUT / f)
for d in ["src", "vendor", "assets"]:
    shutil.copytree(ROOT / d, OUT / d, ignore=shutil.ignore_patterns("README.md", "*.map"))
print(f"pages copied to {OUT.relative_to(ROOT)}")
