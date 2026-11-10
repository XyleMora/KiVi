#!/usr/bin/env python3
"""Set KiVi's version everywhere it's written down.

    python3 tools/set_version.py v0.2.0        # or 0.2.0

A release takes its version from the tag: CI runs this with the pushed tag
(`v0.2.0`) before building, so the AppImage, the .exe, the .dmg and the source
archive all carry it, and nobody has to bump the files by hand first. The
files in the repository keep whatever version they have; it's only used for
local and manual builds.

It changes, keeping everything else as it is:
  src-tauri/tauri.conf.json   "version" (the app, bundle and file names)
  src-tauri/Cargo.toml        [package] version
  src-tauri/Cargo.lock        the kivi-desktop entry (so a --locked build agrees)
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Semantic versions, as Tauri and Cargo accept them: 1.2.3, or 1.2.3-beta.1.
VERSION = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")

# (file, pattern whose group 2 is the version, what it is)
PLACES = [
    ("src-tauri/tauri.conf.json", re.compile(r'^(\s*"version"\s*:\s*")([^"]*)(")', re.M), "tauri.conf.json version"),
    ("src-tauri/Cargo.toml", re.compile(r'(\[package\][^\[]*?^version\s*=\s*")([^"]*)(")', re.M | re.S), "Cargo.toml [package] version"),
    ("src-tauri/Cargo.lock", re.compile(r'(^name = "kivi-desktop"\nversion = ")([^"]*)(")', re.M), "Cargo.lock kivi-desktop entry"),
]


def set_version(version: str, root: Path = ROOT) -> list[str]:
    """Write `version` into every place; returns what changed. Raises ValueError for a bad version or a place not found."""
    version = version.strip().removeprefix("v")
    if not VERSION.match(version):
        raise ValueError(f'"{version}" isn\'t a version like 1.2.3 (tags are v1.2.3)')
    changed = []
    for rel, pattern, what in PLACES:
        path = root / rel
        text = path.read_text(encoding="utf-8")
        m = pattern.search(text)
        if not m:
            raise ValueError(f"no {what} found in {rel}")
        if m.group(2) != version:
            changed.append(f"{what}: {m.group(2)} -> {version}")
            text = text[: m.start(2)] + version + text[m.end(2) :]
            path.write_text(text, encoding="utf-8")
    return changed


def main() -> int:
    # Windows runners print through cp1252, which can't encode every character
    # (a "→" once failed the Windows release build after the files were written).
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    if len(sys.argv) != 2:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    try:
        changed = set_version(sys.argv[1])
    except ValueError as e:
        print(f"set_version: {e}", file=sys.stderr)
        return 1
    print("\n".join(changed) if changed else "already that version")
    return 0


if __name__ == "__main__":
    sys.exit(main())
