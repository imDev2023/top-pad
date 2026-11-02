"""PDQ, Meta's 256-bit perceptual hash, with its quality score and its 8 dihedral variants, through pdqhash 0.2.8.

A copy that is mirrored or turned on its side is caught by comparing the protected logo's hash with all 8 variants of
the candidate's (spec 6.2: a match is Hamming distance 31 or less; hashes of quality 49 or less are not trusted).

Bit order. pdqhash returns each hash as 256 bits: element i is bit (255 - i) of PDQ's Hash256, whose bit k is bit
(k mod 16) of its 16-bit word w[k div 16] (pdqhash's hash_to_vector reverses that word-and-bit walk). That is exactly the
order of the canonical 64-digit hex form Meta's tools print (w[15] first, most significant digit first), so the
"0"/"1" strings returned here are that hex read as binary, and the text form pgvector's bit(256) takes.

Dihedral order (pdqhash's compute_dihedral, from ThreatExchange's pdqDihedralHash256esFromFloatLuma), with the Pillow
transpose each variant stands for, as measured on a drawn logo: 0 the original, 1 rotated 90 degrees counter-clockwise
(ROTATE_90), 2 rotated 180, 3 rotated 90 clockwise (ROTATE_270), 4 flipped top to bottom, 5 mirrored left to right,
6 flipped about the main diagonal (TRANSPOSE), 7 flipped about the anti-diagonal (TRANSVERSE). The original is first, as
returned, and equals the plain pdqhash.compute hash; tests/test_signatures.py holds pdqhash to this whole order.
"""

from __future__ import annotations

import numpy as np
import pdqhash
from PIL import Image

# Meta's guidance is to hash a picture of about 512 pixels: PDQ itself downsamples to 64 x 64, so a bigger input only
# costs time, and a fixed downscale makes the same logo at two upload sizes hash alike.
MAX_SIDE = 512


def downscaled(image: Image.Image) -> Image.Image:
    """The image with its longest side at most 512 pixels, shrunk with Lanczos and its aspect ratio kept."""
    width, height = image.size
    longest = max(width, height)
    if longest <= MAX_SIDE:
        return image
    scale = MAX_SIDE / longest
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    # resize, not thumbnail: thumbnail's reducing_gap takes a faster, approximate path whose output depends on the size.
    return image.resize(size, Image.Resampling.LANCZOS)


def bits(vector: np.ndarray) -> str:
    """A pdqhash bit vector as a 256-character string of 0 and 1."""
    array = np.asarray(vector, dtype=np.uint8)
    if array.shape != (256,) or array.max(initial=0) > 1:
        raise ValueError(f"not a 256-bit PDQ hash: shape {array.shape}")
    return (array + ord("0")).tobytes().decode("ascii")


def signature(image: Image.Image) -> dict:
    """The image's PDQ hash, quality (0 to 100) and its 8 dihedral hashes, the original first."""
    pixels = np.ascontiguousarray(np.asarray(downscaled(image).convert("RGB"), dtype=np.uint8))
    vectors, quality = pdqhash.compute_dihedral(pixels)
    dihedral = [bits(vector) for vector in vectors]
    if len(dihedral) != 8:
        raise ValueError(f"pdqhash returned {len(dihedral)} dihedral hashes, expected 8")
    return {"bits": dihedral[0], "quality": int(quality), "dihedral": dihedral}


def distance(a: str, b: str) -> int:
    """The Hamming distance between two hashes in this module's text form."""
    if len(a) != len(b):
        raise ValueError("hashes differ in length")
    return sum(x != y for x, y in zip(a, b))
