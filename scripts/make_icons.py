#!/usr/bin/env python3
"""Generate the extension icons (pure stdlib — no Pillow needed).

Draws a rounded purple square with a white diamond, at 16/32/48/128 px.
Run from the repo root:  python3 scripts/make_icons.py
"""
import os
import struct
import zlib

ACCENT = (124, 108, 245)   # matches --accent in the UI
WHITE = (255, 255, 255)


def make_icon(size: int) -> bytes:
    radius = size * 0.22
    cx = cy = (size - 1) / 2
    diamond = size * 0.28  # half-diagonal of the white diamond

    rows = []
    for y in range(size):
        row = bytearray([0])  # PNG filter byte: None
        for x in range(size):
            # rounded-rect coverage
            dx = max(abs(x - cx) - (size / 2 - radius), 0)
            dy = max(abs(y - cy) - (size / 2 - radius), 0)
            inside = (dx * dx + dy * dy) ** 0.5 <= radius
            if not inside:
                row += bytes((0, 0, 0, 0))
                continue
            if abs(x - cx) + abs(y - cy) <= diamond:
                row += bytes((*WHITE, 255))
            else:
                row += bytes((*ACCENT, 255))
        rows.append(bytes(row))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(b"".join(rows), 9)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", idat)
        + chunk(b"IEND", b"")
    )


def main() -> None:
    out_dir = os.path.join(os.path.dirname(__file__), "..", "icons")
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(out_dir, f"icon{size}.png")
        with open(path, "wb") as f:
            f.write(make_icon(size))
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
