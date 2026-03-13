from PIL import Image
import sys

if len(sys.argv) < 3:
    raise SystemExit('usage: dds_to_png.py <input.dds> <output.png>')

src = sys.argv[1]
dst = sys.argv[2]

img = Image.open(src)
img.save(dst)
