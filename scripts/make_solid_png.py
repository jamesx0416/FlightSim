from PIL import Image
import sys

if len(sys.argv) < 6:
    raise SystemExit('usage: make_solid_png.py <output.png> <size> <r> <g> <b>')

dst = sys.argv[1]
size = int(sys.argv[2])
r = int(sys.argv[3])
g = int(sys.argv[4])
b = int(sys.argv[5])

img = Image.new('RGB', (size, size), (r, g, b))
img.save(dst)
