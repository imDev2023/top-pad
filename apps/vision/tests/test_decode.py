"""The decode pipeline every image goes through: the formats it takes, what it refuses, and the normalising it does.

A logo must sign the same however it was saved (transparent or on white, PNG or WebP, first frame of an animation,
rotated by its EXIF tag), or a copycat could dodge a match by re-saving the original.
"""

from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from tests import logos
from tests.conftest import cosine
from vision import pdq
from vision.decode import MAX_PIXELS, ImageRejected, decode


def test_a_transparent_png_is_composited_over_white(service):
    transparent = logos.frog(transparent=True)
    on_white = Image.alpha_composite(Image.new("RGBA", transparent.size, (255, 255, 255, 255)), transparent).convert("RGB")
    on_black = Image.alpha_composite(Image.new("RGBA", transparent.size, (0, 0, 0, 255)), transparent).convert("RGB")

    decoded = decode(logos.encode(transparent, "PNG"))
    assert decoded.mode == "RGB"
    assert decoded.getpixel((0, 0)) == (255, 255, 255)

    signed = service.signatures(logos.encode(transparent, "PNG"))
    assert signed["pdq"]["bits"] == service.signatures(logos.encode(on_white, "PNG"))["pdq"]["bits"]
    assert signed["pdq"]["bits"] != service.signatures(logos.encode(on_black, "PNG"))["pdq"]["bits"]


def test_a_palette_png_with_a_transparent_index_is_composited_over_white():
    image = logos.frog(transparent=True).convert("P", palette=Image.Palette.ADAPTIVE)
    assert decode(logos.encode(image, "PNG", transparency=image.getpixel((0, 0)))).getpixel((0, 0)) == (255, 255, 255)


def test_an_animated_gif_signs_as_its_first_frame(service):
    frames = [logos.frog(), logos.rocket()]
    animated = io.BytesIO()
    frames[0].save(animated, format="GIF", save_all=True, append_images=frames[1:], duration=200, loop=0)
    first_only = logos.encode(frames[0], "GIF")

    signed = service.signatures(animated.getvalue())
    assert signed["pdq"]["bits"] == service.signatures(first_only)["pdq"]["bits"]
    assert cosine(signed["sscd"], service.signatures(first_only)["sscd"]) > 0.9999
    assert signed["pdq"]["bits"] != service.signatures(logos.encode(frames[1], "GIF"))["pdq"]["bits"]


def test_a_lossless_webp_signs_exactly_as_the_png(service):
    png = service.signatures(logos.encode(logos.rocket(), "PNG"))
    webp = service.signatures(logos.encode(logos.rocket(), "WEBP", lossless=True))
    assert webp["pdq"]["bits"] == png["pdq"]["bits"]
    assert cosine(webp["sscd"], png["sscd"]) > 0.9999


def test_a_lossy_webp_and_an_animated_webp_decode(service):
    png = service.signatures(logos.encode(logos.rocket(), "PNG"))
    lossy = service.signatures(logos.encode(logos.rocket(), "WEBP", quality=75))
    assert pdq.distance(lossy["pdq"]["bits"], png["pdq"]["bits"]) <= 31

    animated = io.BytesIO()
    logos.rocket().save(animated, format="WEBP", save_all=True, append_images=[logos.coin()], duration=200, lossless=True)
    assert service.signatures(animated.getvalue())["pdq"]["bits"] == png["pdq"]["bits"]


@pytest.mark.parametrize(
    ("orientation", "stored"),
    [(6, Image.Transpose.ROTATE_90), (8, Image.Transpose.ROTATE_270), (3, Image.Transpose.ROTATE_180)],
)
def test_the_exif_orientation_is_applied(service, orientation, stored):
    # A camera stores the pixels turned and records how to turn them back; the service must sign the upright picture.
    upright = logos.frog().resize((512, 384))
    exif = Image.Exif()
    exif[0x0112] = orientation
    data = logos.encode(upright.transpose(stored), "JPEG", quality=95, exif=exif.tobytes())

    signed = service.signatures(data)
    assert (signed["width"], signed["height"]) == (512, 384)
    reference = service.signatures(logos.encode(upright, "JPEG", quality=95))
    assert pdq.distance(signed["pdq"]["bits"], reference["pdq"]["bits"]) <= 8


def test_a_cmyk_jpeg_and_a_greyscale_png_decode():
    assert decode(logos.encode(logos.coin().convert("CMYK"), "JPEG")).mode == "RGB"
    assert decode(logos.encode(logos.coin().convert("L"), "PNG")).mode == "RGB"


def test_a_16_bit_greyscale_png_keeps_its_tones():
    ramp = np.tile(np.linspace(0, 65535, 256, dtype=np.uint16), (64, 1))
    decoded = np.asarray(decode(logos.encode(Image.fromarray(ramp), "PNG")))
    # Pillow's own conversion would clip everything above 255 to white.
    assert decoded[0, 0, 0] == 0 and decoded[0, -1, 0] == 255 and 120 <= decoded[0, 128, 0] <= 135


def test_a_one_pixel_image_still_signs(service):
    signed = service.signatures(logos.encode(Image.new("RGB", (1, 1), (10, 200, 30)), "PNG"))
    assert (signed["width"], signed["height"]) == (1, 1)
    assert len(signed["sscd"]) == 512


def test_a_long_strip_is_capped_but_signs(service):
    signed = service.signatures(logos.encode(Image.new("RGB", (6000, 20), (10, 200, 30)), "PNG"))
    assert (signed["width"], signed["height"]) == (6000, 20)


def _half(data: bytes) -> bytes:
    """The first half of a file: its header parses, its pixel data ends early."""
    return data[: len(data) // 2]


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (b"", "empty"),
        (b"\x00\x01garbage bytes that are no image at all" * 10, "not a PNG, JPEG, GIF or WebP image"),
        (b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', "SVG"),
        (b'  <svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>', "SVG"),
        (logos.encode(logos.coin(), "BMP"), "not a PNG, JPEG, GIF or WebP image"),
        (logos.encode(logos.coin(), "TIFF"), "not a PNG, JPEG, GIF or WebP image"),
        (_half(logos.encode(logos.coin(), "PNG")), "could not"),
        (_half(logos.encode(logos.coin(), "JPEG")), "could not"),
    ],
    ids=["empty", "garbage", "svg-xml", "svg", "bmp", "tiff", "truncated-png", "truncated-jpeg"],
)
def test_unreadable_or_unsupported_images_are_rejected(data, message):
    with pytest.raises(ImageRejected, match=message):
        decode(data)


# decode.py turns this warning into an error at import; pytest records warnings per test instead, so the mark restores
# what production runs with.
@pytest.mark.filterwarnings("error::PIL.Image.DecompressionBombWarning")
def test_an_image_with_too_many_pixels_is_rejected_before_it_is_decoded():
    # A 1-bit 10,000 x 6,000 PNG is a few kilobytes on the wire and 60 million pixels once decoded.
    data = logos.encode(Image.new("1", (10_000, 6_000)), "PNG")
    assert len(data) < 200_000
    with pytest.raises(ImageRejected, match=f"more than {MAX_PIXELS:,} pixels"):
        decode(data)
    # Between one and two times the limit Pillow only warns, which decode turns into the same refusal.
    with pytest.raises(ImageRejected, match="pixels"):
        decode(logos.encode(Image.new("1", (8_000, 6_000)), "PNG"))
