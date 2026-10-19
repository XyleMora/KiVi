#!/usr/bin/env python3
"""Rasterize an SVG to PNG (dev helper for visual checks).

usage: svg2png.py in.svg out.png [width_px]
"""
import sys

import gi

gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf  # noqa: E402

src, dst = sys.argv[1], sys.argv[2]
width = int(sys.argv[3]) if len(sys.argv) > 3 else 1600

pix = GdkPixbuf.Pixbuf.new_from_file_at_scale(src, width, -1, True)
# Flatten onto white so transparent SVGs are readable.
bg = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, True, 8, pix.get_width(), pix.get_height())
bg.fill(0xFFFFFFFF)
pix.composite(bg, 0, 0, pix.get_width(), pix.get_height(), 0, 0, 1, 1, GdkPixbuf.InterpType.BILINEAR, 255)
bg.savev(dst, "png", [], [])
print(dst, pix.get_width(), pix.get_height())
