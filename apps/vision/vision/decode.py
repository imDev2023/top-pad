"""Turns uploaded or fetched bytes into the one RGB image every signature is computed from.

Signatures are only comparable when every image passes through the same steps, so this is the only place an image is
decoded: first frame, EXIF orientation applied, transparency composited over white, RGB. Anything it cannot read, or
refuses, raises ImageRejected with a message the API can show the creator as it is.
"""

from __future__ import annotations

import io
import warnings

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

ACCEPTED_FORMATS = ("PNG", "JPEG", "GIF", "WEBP")
ACCEPTED_TEXT = "PNG, JPEG, GIF or WebP"

# 40 million pixels is a 6,300 pixel square, far beyond any logo, and keeps one decoded image (and the copies its
# conversion makes) well inside the Container's 1 GiB.
MAX_PIXELS = 40_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
# Pillow only warns between one and two times its limit; set once at import (warnings filters are process-wide), this
# turns the warning into the same refusal as the error above it.
warnings.simplefilter("error", Image.DecompressionBombWarning)

_WHITE = (255, 255, 255, 255)


class ImageRejected(ValueError):
    """An image the service cannot read or will not process; its message is meant for the person who sent it."""


def decode(data: bytes) -> Image.Image:
    """The image in data as RGB, ready for both signatures."""
    if not data:
        raise ImageRejected("the image is empty")
    if _looks_like_svg(data):
        raise ImageRejected(f"SVG images are not supported; send a {ACCEPTED_TEXT} image")

    try:
        # Naming the formats keeps Pillow from trying its other decoders on untrusted bytes.
        image = Image.open(io.BytesIO(data), formats=ACCEPTED_FORMATS)
    except UnidentifiedImageError:
        raise ImageRejected(f"not a {ACCEPTED_TEXT} image") from None
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ImageRejected(f"the image has more than {MAX_PIXELS:,} pixels") from None
    except Exception as error:
        raise ImageRejected(f"could not read the image ({_reason(error)})") from None

    width, height = image.size
    if width < 1 or height < 1:
        raise ImageRejected("the image has no pixels")
    if width * height > MAX_PIXELS:
        raise ImageRejected(f"the image has more than {MAX_PIXELS:,} pixels")

    try:
        # An animated GIF or WebP is judged by its first frame, which is also what most wallets and explorers show.
        image.seek(0)
        image.load()
        image = _orient(image)
        return _to_rgb(image)
    except ImageRejected:
        raise
    except Exception as error:
        # A truncated or corrupt file fails here, after its header parsed; Pillow raises a handful of exception types for
        # that, none of which should take the request down.
        raise ImageRejected(f"could not decode the image ({_reason(error)})") from None


def _looks_like_svg(data: bytes) -> bool:
    head = data[:1024].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    return head.startswith(b"<svg") or (head.startswith((b"<?xml", b"<!doctype svg", b"<!--")) and b"<svg" in head)


def _orient(image: Image.Image) -> Image.Image:
    try:
        return ImageOps.exif_transpose(image)
    except Exception:
        # A malformed EXIF block says nothing reliable about orientation, so the pixels are taken as stored rather than
        # refusing an otherwise readable image.
        return image


def _to_rgb(image: Image.Image) -> Image.Image:
    if image.mode in ("I", "I;16", "I;16L", "I;16B", "I;16N"):
        # Pillow's own conversion clips 16-bit greys to 255 instead of scaling them, which would turn the image white.
        pixels = np.asarray(image).astype(np.int64)
        image = Image.fromarray(np.clip(pixels >> 8, 0, 255).astype(np.uint8), "L")
    if image.mode in ("RGBA", "LA", "PA", "RGBa", "La") or "transparency" in image.info:
        # Transparent pixels keep whatever colour the editor left behind them; compositing over white makes a logo with a
        # transparent background and the same logo on white hash alike, as they look alike on a page.
        rgba = image.convert("RGBA")
        return Image.alpha_composite(Image.new("RGBA", rgba.size, _WHITE), rgba).convert("RGB")
    return image.convert("RGB")


def _reason(error: Exception) -> str:
    text = str(error).strip() or type(error).__name__
    return text[:200]
