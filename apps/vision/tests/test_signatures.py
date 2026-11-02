"""The signatures against spec 6.2's thresholds: the copies Vamp Shield must refuse match, and different logos do not.

PDQ matches at distance 31 or less across the candidate's 8 dihedral hashes; SSCD refuses at cosine 0.75 or more and
labels 0.60 to 0.75. If one of these fails for a drawn logo, find out why before moving a threshold: the thresholds are
the product's, these logos are only stand-ins for real ones.
"""

from __future__ import annotations

import numpy as np
import pdqhash
import pytest
from PIL import Image, ImageOps

from tests import logos
from tests.conftest import best_distance, cosine
from vision import pdq

MATCH = 31
TRUSTED_QUALITY = 50
COPY = 0.75
NEAR = 0.60


def sign(service, image: Image.Image, format: str = "PNG", **params) -> dict:
    return service.signatures(logos.encode(image, format, **params))


@pytest.fixture(scope="module")
def original(service) -> dict:
    return sign(service, logos.frog())


def test_the_original_orientation_comes_first(service, original):
    image = logos.frog()
    vector, quality = pdqhash.compute(np.asarray(pdq.downscaled(image), dtype=np.uint8))
    assert original["pdq"]["bits"] == original["pdq"]["dihedral"][0] == pdq.bits(vector)
    assert original["pdq"]["quality"] == quality


def test_shape_of_a_signature(original):
    assert len(original["pdq"]["bits"]) == 256 and set(original["pdq"]["bits"]) <= {"0", "1"}
    assert len(original["pdq"]["dihedral"]) == 8
    assert all(len(variant) == 256 for variant in original["pdq"]["dihedral"])
    assert len(original["sscd"]) == 512
    assert np.linalg.norm(original["sscd"]) == pytest.approx(1.0, abs=1e-5)
    assert (original["width"], original["height"]) == (512, 512)


def test_the_drawn_logos_hash_with_trusted_quality(service, original):
    assert original["pdq"]["quality"] >= TRUSTED_QUALITY
    assert sign(service, logos.rocket())["pdq"]["quality"] >= TRUSTED_QUALITY
    assert sign(service, logos.coin())["pdq"]["quality"] >= TRUSTED_QUALITY


def test_a_flat_image_hashes_with_untrusted_quality(service):
    assert sign(service, logos.flat())["pdq"]["quality"] < TRUSTED_QUALITY


# Pillow's transposes against pdqhash's dihedral order: rotations are counter-clockwise, as Pillow's are. The test below
# holds pdqhash to this order, so an upgrade that reorders the variants fails here rather than silently.
DIHEDRAL = {
    Image.Transpose.ROTATE_90: 1,
    Image.Transpose.ROTATE_180: 2,
    Image.Transpose.ROTATE_270: 3,
    Image.Transpose.FLIP_TOP_BOTTOM: 4,
    Image.Transpose.FLIP_LEFT_RIGHT: 5,
    Image.Transpose.TRANSPOSE: 6,
    Image.Transpose.TRANSVERSE: 7,
}


@pytest.mark.parametrize("transpose", list(DIHEDRAL), ids=lambda transpose: transpose.name)
def test_every_rotation_and_flip_matches_through_the_dihedral_hashes(service, original, transpose):
    turned = sign(service, logos.frog().transpose(transpose))
    # The turned copy's own orientation does not match: only its dihedral variants do.
    assert pdq.distance(turned["pdq"]["bits"], original["pdq"]["bits"]) > MATCH
    assert best_distance(turned, original) <= MATCH
    # And the original's variant at pdqhash's index for this transpose is the turned copy's hash.
    assert pdq.distance(original["pdq"]["dihedral"][DIHEDRAL[transpose]], turned["pdq"]["bits"]) <= MATCH


def test_a_mirrored_copy_matches_on_both_signatures(service, original):
    mirrored = sign(service, ImageOps.mirror(logos.frog()))
    assert best_distance(mirrored, original) <= MATCH
    assert cosine(mirrored["sscd"], original["sscd"]) >= COPY


def test_a_rotated_copy_matches_on_pdq(service, original):
    rotated = sign(service, logos.frog().transpose(Image.Transpose.ROTATE_90))
    assert pdq.distance(rotated["pdq"]["bits"], original["pdq"]["bits"]) > MATCH
    assert best_distance(rotated, original) <= MATCH


@pytest.mark.parametrize("side", [300, 128, 1024])
def test_a_resized_copy_matches_on_both_signatures(service, original, side):
    resized = sign(service, logos.frog().resize((side, side), Image.Resampling.LANCZOS))
    assert pdq.distance(resized["pdq"]["bits"], original["pdq"]["bits"]) <= MATCH
    assert cosine(resized["sscd"], original["sscd"]) >= COPY


@pytest.mark.parametrize("quality", [85, 50, 25])
def test_a_jpeg_recompressed_copy_matches_on_both_signatures(service, original, quality):
    recompressed = sign(service, logos.frog(), "JPEG", quality=quality)
    assert pdq.distance(recompressed["pdq"]["bits"], original["pdq"]["bits"]) <= MATCH
    assert cosine(recompressed["sscd"], original["sscd"]) >= COPY


@pytest.mark.parametrize("other", [logos.rocket, logos.coin], ids=["rocket", "coin"])
def test_different_logos_match_on_neither_signature(service, original, other):
    different = sign(service, other())
    assert best_distance(different, original) > MATCH
    assert cosine(different["sscd"], original["sscd"]) < NEAR


def test_the_same_bytes_give_the_same_signatures(service):
    data = logos.encode(logos.rocket(), "PNG")
    first, second = service.signatures(data), service.signatures(data)
    assert first["sha256"] == second["sha256"]
    assert first["pdq"] == second["pdq"]
    assert first["sscd"] == second["sscd"]
