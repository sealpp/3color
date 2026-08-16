# -*- coding: utf-8 -*-
"""Generate 3color PWA icons (pure stdlib PNG encoder, no deps)."""
import struct
import zlib
import math
import os

def png_chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

def write_png(path, size, pixel):
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter: none
        for x in range(size):
            raw.extend(pixel(x, y))
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    data = (b'\x89PNG\r\n\x1a\n'
            + png_chunk(b'IHDR', ihdr)
            + png_chunk(b'IDAT', zlib.compress(bytes(raw), 9))
            + png_chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(data)
    print('wrote', path, size, 'x', size)

def clamp(v, a=0, b=255):
    return max(a, min(b, int(round(v))))

def soft(dist, radius, aa=1.4):
    """Anti-aliased circle coverage in [0,1]."""
    return max(0.0, min(1.0, (radius - dist) / aa + 0.5))

BG    = (20, 17, 14)
BRASS = (200, 164, 92)
RED   = (217, 83, 79)
GREEN = (124, 178, 106)
BLUE  = (111, 143, 209)

def build(size, maskable):
    w = h = float(size)
    c = w / 2.0
    maxr = math.hypot(c, c)
    if maskable:
        circles = [(0.50, 0.40, 0.175, RED), (0.35, 0.67, 0.175, GREEN), (0.65, 0.67, 0.175, BLUE)]
        ring = None
    else:
        circles = [(0.50, 0.36, 0.24, RED), (0.33, 0.70, 0.24, GREEN), (0.67, 0.70, 0.24, BLUE)]
        ring = (0.40, 0.022)  # radius + half stroke (fractions of w)

    def pixel(x, y):
        fx, fy = x + 0.5, y + 0.5
        dist_c = math.hypot(fx - c, fy - c)
        vig = 1.0 - 0.12 * (dist_c / maxr) ** 2
        r = BG[0] * vig
        g = BG[1] * vig
        b = BG[2] * vig
        for (cx_, cy_, rad, col) in circles:
            d = math.hypot(fx - cx_ * w, fy - cy_ * w)
            co = soft(d, rad * w)
            if co > 0:
                r += col[0] * co * 1.15
                g += col[1] * co * 1.15
                b += col[2] * co * 1.15
        if ring:
            rr, half = ring
            d = math.hypot(fx - c, fy - c)
            rc = 1.0 - min(1.0, abs(d - rr * w) / (half * w))
            if rc > 0:
                r = r * (1 - rc) + BRASS[0] * rc
                g = g * (1 - rc) + BRASS[1] * rc
                b = b * (1 - rc) + BRASS[2] * rc
        return (clamp(r), clamp(g), clamp(b))

    write_png(os.path.join(os.path.dirname(__file__), 'icon-{0}{1}.png'.format(size, '-maskable' if maskable else '')),
              size, pixel)

def main():
    build(512, False)   # icon-512.png
    build(192, False)   # icon-192.png
    build(512, True)    # icon-512-maskable.png
    build(180, False)   # apple-touch-icon.png -> rename after

    src = os.path.join(os.path.dirname(__file__), 'icon-180.png')
    dst = os.path.join(os.path.dirname(__file__), 'apple-touch-icon.png')
    if os.path.exists(dst):
        os.remove(dst)
    os.rename(src, dst)
    print('renamed icon-180.png -> apple-touch-icon.png')

if __name__ == '__main__':
    main()
