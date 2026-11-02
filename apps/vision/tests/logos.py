"""Logo-like test images drawn in code: shapes, gradients and text, so the tests carry no binary fixtures.

Each logo is deliberately asymmetric (text and shapes off centre), because a symmetric picture's mirror or rotation would
hash like the original and the orientation tests would prove nothing.
"""

from __future__ import annotations

import io
import math

from PIL import Image, ImageDraw, ImageFont

SIZE = 512


def _font(size: int) -> ImageFont.FreeTypeFont:
    # Pillow's built-in scalable font, so the tests need no font file.
    return ImageFont.load_default(size=size)


def frog(size: int = SIZE, transparent: bool = False) -> Image.Image:
    """A green frog face over a diagonal gradient, with a lily pad and a ticker off to one side."""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    s = size / SIZE
    if not transparent:
        for x in range(size):
            t = x / (size - 1)
            draw.line([(x, 0), (x, size)], fill=(int(250 - 120 * t), int(220 - 40 * t), int(90 + 120 * t), 255))
    draw.ellipse([60 * s, 300 * s, 260 * s, 420 * s], fill=(40, 120, 50, 255))
    draw.ellipse([120 * s, 110 * s, 430 * s, 370 * s], fill=(80, 170, 70, 255), outline=(20, 60, 20, 255), width=max(1, int(8 * s)))
    for cx, cy in ((200, 120), (340, 135)):
        draw.ellipse([(cx - 50) * s, (cy - 50) * s, (cx + 50) * s, (cy + 50) * s], fill=(255, 255, 255, 255), outline=(20, 60, 20, 255), width=max(1, int(6 * s)))
        draw.ellipse([(cx - 10) * s, (cy - 22) * s, (cx + 26) * s, (cy + 14) * s], fill=(10, 10, 10, 255))
    draw.arc([190 * s, 230 * s, 400 * s, 330 * s], start=15, end=150, fill=(160, 30, 40, 255), width=max(1, int(12 * s)))
    draw.text((300 * s, 470 * s), "FROG", fill=(25, 25, 25, 255), font=_font(max(8, int(64 * s))), anchor="mm")
    return image if transparent else image.convert("RGB")


def rocket(size: int = SIZE) -> Image.Image:
    """A white rocket under a yellow star, on purple stripes, with its ticker bottom left."""
    image = Image.new("RGB", (size, size), (25, 20, 70))
    draw = ImageDraw.Draw(image)
    s = size / SIZE
    for k in range(-size, size, int(64 * s)):
        draw.polygon([(k, 0), (k + 28 * s, 0), (k + 28 * s + size, size), (k + size, size)], fill=(70, 45, 150))
    cx, cy, outer, inner = 390 * s, 110 * s, 80 * s, 32 * s
    points = []
    for i in range(10):
        angle = math.pi / 2 + i * math.pi / 5
        radius = outer if i % 2 == 0 else inner
        points.append((cx + radius * math.cos(angle), cy - radius * math.sin(angle)))
    draw.polygon(points, fill=(255, 210, 40))
    draw.polygon([(120 * s, 400 * s), (200 * s, 150 * s), (280 * s, 400 * s)], fill=(245, 245, 250))
    draw.ellipse([175 * s, 260 * s, 225 * s, 310 * s], fill=(60, 150, 230))
    draw.polygon([(150 * s, 400 * s), (200 * s, 470 * s), (250 * s, 400 * s)], fill=(255, 120, 30))
    draw.text((300 * s, 430 * s), "MOON", fill=(255, 255, 255), font=_font(max(8, int(60 * s))), anchor="lm")
    return image


def coin(size: int = SIZE) -> Image.Image:
    """Concentric orange rings with a large letter, a third design unlike the other two."""
    image = Image.new("RGB", (size, size), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    s = size / SIZE
    for i, radius in enumerate(range(240, 40, -40)):
        shade = (255, 150 - i * 20, 20 + i * 30)
        draw.ellipse([(256 - radius) * s, (256 - radius) * s, (256 + radius) * s, (256 + radius) * s], fill=shade)
    draw.text((230 * s, 250 * s), "W", fill=(20, 20, 20), font=_font(max(8, int(200 * s))), anchor="mm")
    draw.rectangle([380 * s, 380 * s, 500 * s, 500 * s], fill=(30, 90, 200))
    return image


def flat(size: int = 256) -> Image.Image:
    """One colour and nothing else: PDQ has no gradients to hash, so its quality is low."""
    return Image.new("RGB", (size, size), (200, 40, 40))


def encode(image: Image.Image, format: str, **params) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format=format, **params)
    return buffer.getvalue()
