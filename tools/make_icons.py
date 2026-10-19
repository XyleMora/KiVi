#!/usr/bin/env python3
"""Render the app icons (src-tauri/icons) from the logo.

    python3 tools/make_icons.py

Every size is assets/kivi-logo.svg on a light rounded tile, so the icons
read on light and dark desktops and taskbars.
"""
import io
from pathlib import Path

import gi

gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src-tauri" / "icons"
# Tauri's bundle config lists these files (tauri.conf.json → bundle.icon).
SIZES = {"32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512}
# icon.ico is the Windows executable and installer icon (needed to build there).
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
TILE = (245, 241, 230, 255)


def render(svg, width):
    pix = GdkPixbuf.Pixbuf.new_from_file_at_scale(str(svg), width, -1, True)
    ok, data = pix.save_to_bufferv("png", [], [])
    return Image.open(io.BytesIO(data)).convert("RGBA")


def icon(size):
    scale = 4  # draw large, then downsample for clean edges
    big = size * scale
    tile = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(tile).rounded_rectangle((0, 0, big - 1, big - 1), radius=big * 0.22, fill=TILE)
    svg = ROOT / "assets" / "kivi-logo.svg"
    pad = 0.08 if size <= 32 else 0.1  # less margin when small
    art = render(svg, round(big * (1 - 2 * pad)))
    tile.alpha_composite(art, ((big - art.width) // 2, (big - art.height) // 2))
    return tile.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    for name, size in SIZES.items():
        path = OUT / name
        icon(size).save(path)
        print(path.relative_to(ROOT))
    # Each size drawn on its own, so the small ones get the smaller margin too.
    ico = OUT / "icon.ico"
    images = [icon(s) for s in ICO_SIZES]
    images[-1].save(ico, sizes=[(s, s) for s in ICO_SIZES], append_images=images[:-1])
    print(ico.relative_to(ROOT))
