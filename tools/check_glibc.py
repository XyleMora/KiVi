#!/usr/bin/env python3
"""Fail if an AppImage's binaries need a newer glibc than allowed.

The AppImage bundles GTK, WebKitGTK and the rest but uses the system's glibc,
so it runs only where glibc is at least the newest GLIBC_x.y symbol version any
bundled ELF file references. CI builds on the oldest supported Ubuntu LTS for
that reason; this check catches a library that slipped in from somewhere newer.

    python3 tools/check_glibc.py <AppDir> [--max 2.35]

--max defaults to this machine's glibc (in CI, the build runner's).
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

VERSION = re.compile(rb"GLIBC_(\d+)\.(\d+)")


def is_elf(path):
    """True for a regular ELF file (binaries and shared libraries)."""
    try:
        with open(path, "rb") as f:
            return f.read(4) == b"\x7fELF"
    except OSError:
        return False


def needed_glibc(path):
    """The newest GLIBC_x.y version the file's dynamic symbols reference, or None."""
    out = subprocess.run(["objdump", "-T", str(path)], capture_output=True).stdout
    found = [(int(a), int(b)) for a, b in VERSION.findall(out)]
    return max(found, default=None)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("appdir", type=Path)
    ap.add_argument("--max", help="highest allowed glibc, e.g. 2.35 (default: this system's)")
    args = ap.parse_args()

    limit = args.max or os.confstr("CS_GNU_LIBC_VERSION").split()[-1]
    limit = tuple(int(n) for n in limit.split(".")[:2])

    worst, checked, too_new = None, 0, []
    for path in sorted(args.appdir.rglob("*")):
        # A bundled glibc itself would define these versions, not need them.
        if path.is_symlink() or not path.is_file() or not is_elf(path) or path.name.startswith(("libc.so", "ld-linux")):
            continue
        checked += 1
        need = needed_glibc(path)
        if need is None:
            continue
        worst = max(worst or need, need)
        if need > limit:
            too_new.append((need, path.relative_to(args.appdir)))

    fmt = lambda v: "%d.%d" % v
    print(f"{checked} ELF files; newest glibc needed: {fmt(worst) if worst else 'none'} (allowed: {fmt(limit)})")
    for need, rel in too_new:
        print(f"  needs glibc {fmt(need)}: {rel}")
    if too_new:
        sys.exit(f"{len(too_new)} file(s) need a newer glibc than {fmt(limit)}: build on an older system")


if __name__ == "__main__":
    main()
