#!/usr/bin/env python3
"""Regenerate the shared Menlo Bold geometry and README SVGs.

Requires Pillow and fontTools; defaults to macOS's installed Menlo (Bold face).
Only the seven letters' outlines and sampled points are saved, not the font.
Usage: python3 scripts/wordmark.py [path/to/Menlo.ttc]
"""
import json
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

root = Path(__file__).resolve().parent.parent
source = sys.argv[1] if len(sys.argv) > 1 else "/System/Library/Fonts/Menlo.ttc"
font = TTFont(source, fontNumber=1)
assert font["name"].getDebugName(6) == "Menlo-Bold", "Expected Menlo Bold"
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
scale = 56 / font["head"].unitsPerEm
x = 10
paths = []
for letter in "unstale":
    glyph = cmap[ord(letter)]
    pen = SVGPathPen(glyphs, ntos=lambda n: str(round(n, 4)))
    glyphs[glyph].draw(TransformPen(pen, (scale, 0, 0, -scale, x, 60)))
    paths.append(pen.getCommands())
    x += font["hmtx"].metrics[glyph][0] * scale
mask = Image.new("L", (256, 80))
ImageDraw.Draw(mask).text((10, 60), "unstale", font=ImageFont.truetype(source, 56, index=1), fill=255, anchor="ls")
points = [[x, y] for x in range(256) for y in range(80) if mask.getpixel((x, y)) >= 128]
asset = root / "docs/assets/wordmark.json"
asset.write_text(json.dumps({"font": "Menlo Bold", "width": 256, "height": 80, "paths": paths, "points": points}, separators=(",", ":")) + "\n")
for theme, color in [("dark", "#67dc91"), ("light", "#1d8a4e")]:
    paths_svg = "".join(f'<path d="{path}"/>' for path in paths)
    (root / f"docs/assets/wordmark-{theme}.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="80" viewBox="4 14 248 50" fill="{color}" role="img" aria-label="unstale"><title>unstale</title>{paths_svg}</svg>\n')
print(f"Generated shared geometry ({len(points)} dots) and both README SVGs")
