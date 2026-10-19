#!/usr/bin/env python3
"""Download the KiCad demo files the tests use, from KiCad's GitHub mirror.

    python3 tools/fetch_demos.py               # get/verify the files in tests/kicad-demos.txt
    python3 tools/fetch_demos.py --refresh 10.0.7   # rewrite the list for another KiCad tag

tests/kicad-demos.txt (committed) pins a KiCad release tag and lists the design
files the tests read (.kicad_pro/_sch/_pcb/_wks under 20 MB: no 3D models,
PDFs or Gerbers) with their git blob hash and size. Each file is fetched from
raw.githubusercontent.com/KiCad/kicad-source-mirror/<tag>/demos/<path> (not
subject to the API rate limit) into tests/kicad-demos/ (git-ignored) and
checked against its hash. Files already there and intact aren't downloaded
again, so a CI cache keyed on the list makes repeat runs offline.
"""
import argparse
import hashlib
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIST = ROOT / "tests" / "kicad-demos.txt"
OUT = ROOT / "tests" / "kicad-demos"
MIRROR = "KiCad/kicad-source-mirror"
EXTENSIONS = (".kicad_pro", ".kicad_sch", ".kicad_pcb", ".kicad_wks")
MAX_SIZE = 20_000_000  # tests/run.js and nets.js skip bigger boards anyway


def blob_sha(data: bytes) -> str:
    """Git's object id for file contents."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def read_list():
    tag, files = None, []
    for line in LIST.read_text().splitlines():
        if line.startswith("# tag "):
            tag = line.split()[2]
        elif line and not line.startswith("#"):
            sha, size, path = line.split("\t")
            files.append((sha, int(size), path))
    if not tag:
        sys.exit(f"{LIST.relative_to(ROOT)}: no '# tag' line")
    return tag, files


def refresh(tag):
    """Rewrite the list from the mirror's file tree at `tag` (one API request)."""
    req = urllib.request.Request(
        f"https://api.github.com/repos/{MIRROR}/git/trees/{urllib.parse.quote(tag)}:demos?recursive=1",
        headers={"Accept": "application/vnd.github+json", **({"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}"} if os.environ.get("GITHUB_TOKEN") else {})},
    )
    with urllib.request.urlopen(req) as r:
        tree = json.load(r)
    if tree.get("truncated"):
        sys.exit("the mirror's file tree came back truncated")
    files = sorted(
        ((e["sha"], e["size"], e["path"]) for e in tree["tree"] if e["type"] == "blob" and e["path"].endswith(EXTENSIONS) and e["size"] < MAX_SIZE),
        key=lambda f: f[2],
    )
    LIST.write_text(
        "# KiCad demo files for the tests (tools/fetch_demos.py); generated, don't edit.\n"
        f"# tag {tag}\n"
        "# git blob sha\tsize\tpath under demos/\n"
        + "".join(f"{sha}\t{size}\t{path}\n" for sha, size, path in files)
    )
    print(f"{LIST.relative_to(ROOT)}: {len(files)} files, {sum(f[1] for f in files) / 1e6:.0f} MB at KiCad {tag}")


def fetch(tag, sha, path):
    url = f"https://raw.githubusercontent.com/{MIRROR}/{urllib.parse.quote(tag)}/demos/{urllib.parse.quote(path)}"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                data = r.read()
            if blob_sha(data) != sha:
                raise ValueError("content doesn't match the listed hash")
            dest = OUT / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            return len(data)
        except Exception as e:  # network hiccups: retry with backoff
            if attempt == 3:
                raise RuntimeError(f"{path}: {e}") from e
            time.sleep(2**attempt)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--refresh", metavar="TAG", help="regenerate tests/kicad-demos.txt for this KiCad tag")
    args = ap.parse_args()
    if args.refresh:
        refresh(args.refresh)
    tag, files = read_list()

    missing = [(sha, path) for sha, _, path in files if not ((OUT / path).is_file() and blob_sha((OUT / path).read_bytes()) == sha)]
    if missing:
        print(f"downloading {len(missing)} of {len(files)} KiCad {tag} demo files from {MIRROR} …")
        t0 = time.time()
        with ThreadPoolExecutor(8) as pool:
            got = sum(pool.map(lambda f: fetch(tag, *f), missing))
        print(f"  {got / 1e6:.1f} MB in {time.time() - t0:.0f} s")
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "VERSION").write_text(f"{tag}\n")
    print(f"{OUT.relative_to(ROOT)}: {len(files)} KiCad {tag} demo files ready")


if __name__ == "__main__":
    main()
