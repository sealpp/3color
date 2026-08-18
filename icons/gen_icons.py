# -*- coding: utf-8 -*-
"""Generate 3color PWA icons (pure stdlib PNG encoder, no deps).

   Layout v2 — symmetric equilateral triangle (centroid at canvas center).
   Red top, green bottom-left, blue bottom-right. No center occlusion.
"""
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

BG    = (18, 16, 13)
BRASS = (200, 164, 92)
RED   = (224, 85, 72)
GREEN = (109, 184, 96)
BLUE  = (90, 143, 216)

# 等边三角形参数（重心在画布中心）
# 圆心距 d=125, 半径 r=102 → 重叠自然呈现加法混色
# 三角形高 h = d * sqrt(3)/2 ≈ 108.3
# 重心到顶点距离 = h * 2/3 ≈ 72.2
# 顶点(红): (cx, cy - 72.2), 左下(绿): (cx - d/2, cy + 36.1), 右下(蓝): (cx + d/2, cy + 36.1)

def build(size, maskable):
    w = float(size)
    c = w / 2.0
    maxr = math.hypot(c, c)

    # 归一化坐标（相对于画布宽度的比例）
    if maskable:
        # maskable 版：圆稍小、更紧凑，确保在安全区内
        r_frac = 0.185          # radius / width
        d_frac = 0.230          # center distance / width
        h_frac = d_frac * math.sqrt(3) / 2
        cy_off = h_frac * 2 / 3  # centroid to vertex
        cx_off = d_frac / 2
        circles = [
            (0.50, 0.50 - cy_off, r_frac, RED),
            (0.50 - cx_off, 0.50 + cy_off / 2, r_frac, GREEN),
            (0.50 + cx_off, 0.50 + cy_off / 2, r_frac, BLUE),
        ]
        ring = None
    else:
        r_frac = 0.199
        d_frac = 0.244
        h_frac = d_frac * math.sqrt(3) / 2
        cy_off = h_frac * 2 / 3
        cx_off = d_frac / 2
        circles = [
            (0.50, 0.50 - cy_off, r_frac, RED),
            (0.50 - cx_off, 0.50 + cy_off / 2, r_frac, GREEN),
            (0.50 + cx_off, 0.50 + cy_off / 2, r_frac, BLUE),
        ]
        ring = (0.375, 0.006)  # brass ring: radius fraction + half-stroke fraction

    def pixel(x, y):
        fx, fy = x + 0.5, y + 0.5
        dist_c = math.hypot(fx - c, fy - c)
        vig = 1.0 - 0.10 * (dist_c / maxr) ** 2
        r = BG[0] * vig
        g = BG[1] * vig
        b = BG[2] * vig
        for (cx_, cy_, rad, col) in circles:
            d = math.hypot(fx - cx_ * w, fy - cy_ * w)
            co = soft(d, rad * w)
            if co > 0:
                r += col[0] * co * 1.12
                g += col[1] * co * 1.12
                b += col[2] * co * 1.12
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
