"""SSCD's MIT license asks that its notice travel with every copy of the model: the image ships it beside the ONNX file."""

from __future__ import annotations

from pathlib import Path

from tests.conftest import MODEL


def test_the_models_license_notice_ships_beside_it():
    notice = (Path(MODEL).parent / "SSCD-LICENSE").read_text()
    assert "MIT License" in notice
    assert "Copyright (c) Meta Platforms, Inc. and affiliates." in notice
    assert "The above copyright notice and this permission notice shall be included in all" in notice
