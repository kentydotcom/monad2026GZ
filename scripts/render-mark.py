#!/usr/bin/env python3
"""Draw the WYRVEL hash-seal disc as a PNG icon."""

import struct
import zlib
from pathlib import Path


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: Path, size: int) -> None:
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            raw.extend(pixel(x, y, size))
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def pixel(x: int, y: int, size: int) -> bytes:
    cx = (x + 0.5) / size - 0.5
    cy = (y + 0.5) / size - 0.5
    r = (cx * cx + cy * cy) ** 0.5
    espresso = (22, 17, 13, 255)
    disc = (36, 25, 16, 255)
    brass = (198, 163, 110, 255)
    cream = (243, 236, 223, 255)
    if 0.40 <= r <= 0.46 or 0.33 <= r <= 0.355:
        return brass
    if r > 0.46:
        return espresso
    # Geometric ## inside the disc, in unit coordinates around the centre.
    nx = cx / 0.62
    ny = cy / 0.62
    vertical = (abs(abs(nx) - 0.22) < 0.045) and abs(ny) < 0.46
    horizontal = (abs(abs(ny) - 0.16) < 0.045) and abs(nx) < 0.48
    if vertical or horizontal:
        return cream
    if r <= 0.40:
        return disc
    return espresso


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    write_png(root / "web/public/icons/icon-192.png", 192)
    write_png(root / "web/public/icons/icon-512.png", 512)
