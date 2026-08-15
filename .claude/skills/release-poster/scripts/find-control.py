#!/usr/bin/env python3
"""
Locate a coloured control in a screenshot and print a SYMMETRIC ffmpeg crop.

Eyeballing a crop around a button reliably produces uneven padding — a first
attempt here left 11px on one side and 42px on the other, which reads as a
mistake the moment it is on a poster. Measure the control, pad it equally.

Usage:
  find-control.py <image.png> [--pad 26] [--region x0,y0,x1,y1]
                              [--color RRGGBB] [--tol 60]

Default colour is the SingZ accent (#ffa028), which is what every primary
control in the app is painted with.
"""
import argparse
import sys

from PIL import Image


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--pad", type=int, default=26)
    ap.add_argument("--color", default="ffa028")
    ap.add_argument("--tol", type=int, default=60)
    ap.add_argument("--region", help="x0,y0,x1,y1 to search within")
    ap.add_argument("--nth", type=int, default=0,
                    help="pick the nth largest accent region (0 = largest)")
    a = ap.parse_args()

    im = Image.open(a.image).convert("RGB")
    W, H = im.size
    px = im.load()

    x0, y0, x1, y1 = 0, 0, W, H
    if a.region:
        parts = a.region.split(",")
        if len(parts) != 4:
            print("--region needs exactly x0,y0,x1,y1", file=sys.stderr)
            return 1
        try:
            x0, y0, x1, y1 = (int(v) for v in parts)
        except ValueError:
            print("--region values must be integers", file=sys.stderr)
            return 1
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(W, x1), min(H, y1)
        if x0 >= x1 or y0 >= y1:
            print(f"--region is empty after clamping to the {W}x{H} image", file=sys.stderr)
            return 1

    tr, tg, tb = (int(a.color[i:i + 2], 16) for i in (0, 2, 4))
    hits = set()
    for y in range(y0, y1):
        for x in range(x0, x1):
            r, g, b = px[x, y]
            if abs(r - tr) < a.tol and abs(g - tg) < a.tol and abs(b - tb) < a.tol:
                hits.add((x, y))

    if not hits:
        print(f"no #{a.color} pixels found in that region", file=sys.stderr)
        return 1

    # The app paints every primary control with the accent, so a whole-image
    # search matches the wordmark, the logo bars and any active tab as well as
    # the button you meant. Group the hits and take the biggest blob, rather
    # than the bounding box of all of them — which spans the entire screen and
    # is never what anyone wants.
    blobs = []
    seen = set()
    for seed in hits:
        if seed in seen:
            continue
        stack, comp = [seed], []
        seen.add(seed)
        while stack:
            cx, cy = stack.pop()
            comp.append((cx, cy))
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    n = (cx + dx, cy + dy)
                    if n in hits and n not in seen:
                        seen.add(n)
                        stack.append(n)
        blobs.append(comp)

    blobs.sort(key=len, reverse=True)
    # Bounded both ways: a negative --nth used to index from the end and print
    # a confident crop around the smallest speck on the screen.
    if not 0 <= a.nth < len(blobs):
        print(f"--nth must be between 0 and {len(blobs) - 1} "
              f"({len(blobs)} accent regions found)", file=sys.stderr)
        return 1
    if len(blobs) > 1:
        which = "largest" if a.nth == 0 else f"#{a.nth} by size"
        sizes = ", ".join(str(len(b)) for b in blobs[:4])
        print(f"{len(blobs)} accent regions (sizes: {sizes}…); showing the {which} — "
              f"use --nth or --region to pick another", file=sys.stderr)

    comp = blobs[a.nth]
    bx0 = min(p[0] for p in comp)
    bx1 = max(p[0] for p in comp)
    by0 = min(p[1] for p in comp)
    by1 = max(p[1] for p in comp)
    bw, bh = bx1 - bx0 + 1, by1 - by0 + 1

    # Clamp so the crop stays inside the image and keeps equal padding.
    pad = min(a.pad, bx0, by0, W - bx1 - 1, H - by1 - 1)
    if pad != a.pad:
        print(f"note: padding reduced to {pad} to stay inside the image", file=sys.stderr)

    cw, ch = bw + 2 * pad, bh + 2 * pad
    print(f"control  x {bx0}..{bx1} (w {bw})  y {by0}..{by1} (h {bh})")
    print(f"crop={cw}:{ch}:{bx0 - pad}:{by0 - pad}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
