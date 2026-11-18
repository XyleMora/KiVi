#!/usr/bin/env python3
"""Write the updater's feed, `latest.json`, for a release.

    python3 tools/update_manifest.py bundles/ v0.3.0 XyleMora/KiVi

`bundles/` is where the release job downloaded the build artifacts (one folder
each). For every platform the in-app updater (src-tauri/src/update.rs) supports
it needs the file to download and its `.sig` (minisign signature, made in CI
when the signing key is set):

    linux-x86_64     KiVi_<v>_amd64.AppImage          (the AppImage itself)
    darwin-aarch64   KiVi_<v>_universal.app.tar.gz    (the .app, one for both Macs)
    darwin-x86_64    the same file
    windows-x86_64   KiVi_<v>_x64.exe                 (the bare .exe)

The result goes to `bundles/updater/latest.json`, which the release uploads next
to the files: https://github.com/<repo>/releases/latest/download/latest.json.

- No `.sig` file at all (no signing key in this repository): writes nothing and
  exits 0, so such releases still work and simply have no updates.
- Some but not all platforms signed: exits 1. The updater rejects a feed with an
  incomplete entry as a whole, so a partial one would break updates for everyone.
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# platform key → file name template ({v} = version)
ASSETS = {
    "linux-x86_64": "KiVi_{v}_amd64.AppImage",
    "darwin-aarch64": "KiVi_{v}_universal.app.tar.gz",
    "darwin-x86_64": "KiVi_{v}_universal.app.tar.gz",
    "windows-x86_64": "KiVi_{v}_x64.exe",
}


def build(bundles: Path, tag: str, repo: str, now: datetime | None = None) -> dict | None:
    """The feed as a dict, or None when nothing is signed. Raises ValueError when only part is."""
    version = tag.strip().removeprefix("v")
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version):
        raise ValueError(f'"{tag}" isn\'t a version tag like v1.2.3')
    if not any(bundles.rglob("*.sig")):
        return None
    found: dict[str, tuple[str, str]] = {}  # platform → (file name, signature)
    problems = []
    for platform, template in ASSETS.items():
        name = template.format(v=version)
        files = sorted(bundles.rglob(name))
        sigs = sorted(bundles.rglob(name + ".sig"))
        if not files:
            problems.append(f"{name} is missing ({platform})")
        elif not sigs:
            problems.append(f"{name}.sig is missing ({platform})")
        else:
            signature = sigs[0].read_text().strip()
            if not signature:
                problems.append(f"{name}.sig is empty ({platform})")
            else:
                found[platform] = (name, signature)
    if problems:
        raise ValueError("incomplete: " + "; ".join(problems))
    base = f"https://github.com/{repo}/releases/download/{tag if tag.startswith('v') else 'v' + tag}"
    stamp = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return {
        "version": version,
        "notes": "",
        "pub_date": stamp.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": {p: {"url": f"{base}/{name}", "signature": sig} for p, (name, sig) in found.items()},
    }


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    bundles, tag, repo = Path(argv[1]), argv[2], argv[3]
    try:
        feed = build(bundles, tag, repo)
    except ValueError as e:
        print(f"update_manifest: {e}", file=sys.stderr)
        return 1
    if feed is None:
        print("update_manifest: no .sig files (no signing key): not writing latest.json")
        return 0
    out = bundles / "updater" / "latest.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(feed, indent=2) + "\n")
    print(f"wrote {out}: {feed['version']}, {', '.join(feed['platforms'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
