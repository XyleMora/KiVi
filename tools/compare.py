#!/usr/bin/env python3
"""Side-by-side crop of two SVGs (e.g. kicad-cli reference vs ours).

usage: compare.py ref.svg ours.svg out.png x0 y0 x1 y1 [px_per_mm]
Coordinates are in SVG user units (mm for KiCad output).
"""
import sys

import gi

gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf  # noqa: E402
from PIL import Image  # noqa: E402
import re  # noqa: E402


def viewbox(path):
    head = open(path, encoding="utf-8", errors="ignore").read(4000)
    m = re.search(r'viewBox="([^"]+)"', head)
    return [float(v) for v in m.group(1).replace(",", " ").split()]


def crop(path, x0, y0, x1, y1, ppm):
    vb = viewbox(path)
    w_px = int(vb[2] * ppm)
    pix = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, w_px, -1, True)
    tmp = path + ".tmp.png"
    pix.savev(tmp, "png", [], [])
    img = Image.open(tmp).convert("RGBA")
    bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
    bg.alpha_composite(img)
    sx = img.size[0] / vb[2]
    sy = img.size[1] / vb[3]
    box = (int((x0 - vb[0]) * sx), int((y0 - vb[1]) * sy), int((x1 - vb[0]) * sx), int((y1 - vb[1]) * sy))
    return bg.crop(box).convert("RGB")


ref, ours, out = sys.argv[1:4]
x0, y0, x1, y1 = map(float, sys.argv[4:8])
ppm = float(sys.argv[8]) if len(sys.argv) > 8 else 20
a = crop(ref, x0, y0, x1, y1, ppm)
b = crop(ours, x0, y0, x1, y1, ppm)
canvas = Image.new("RGB", (a.size[0] + b.size[0] + 10, max(a.size[1], b.size[1])), (255, 0, 255))
canvas.paste(a, (0, 0))
canvas.paste(b, (a.size[0] + 10, 0))
canvas.save(out)
print(out, canvas.size)
