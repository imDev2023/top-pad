"""Exports Meta's SSCD sscd_disc_mixup TorchScript model to ONNX, then refuses the build unless the two agree.

It runs only in the Dockerfile's model stage, so torch never reaches the runtime image, which runs the ONNX file with ONNX
Runtime: a far smaller image that starts faster. The parity check feeds both models random tensors and logo-like images
put through the service's own preprocessing (vision/sscd.py), so a drift in either the export or the preprocessing's
input contract fails here rather than in production.

Usage: python export_sscd.py <model.torchscript.pt> <model.onnx>
"""

from __future__ import annotations

import json
import sys
import time

import numpy as np
import onnx
import onnxruntime as ort
import torch
from PIL import Image, ImageDraw

from vision import sscd

# TorchScript's ONNX exporter supports opsets 7 to 20; 17 is the newest every ONNX Runtime since 1.11 runs in full.
OPSET = 17
MIN_COSINE = 0.9999


def logo_like_images() -> list[Image.Image]:
    """A few drawn images shaped like coin logos, in the sizes and aspect ratios real logos come in."""
    images = []
    for index, (size, colours) in enumerate(
        [((400, 400), ("#f7c948", "#1b1b3a")), ((640, 360), ("#2ec4b6", "#ff3366")), ((300, 500), ("#ffffff", "#3a86ff"))]
    ):
        image = Image.new("RGB", size, colours[0])
        draw = ImageDraw.Draw(image)
        width, height = size
        if index == 1:
            for step in range(0, height, 4):
                shade = int(255 * step / height)
                draw.line([(0, step), (width, step)], fill=(shade, 128, 255 - shade), width=4)
        draw.ellipse([width * 0.2, height * 0.2, width * 0.8, height * 0.8], fill=colours[1], outline="#000000", width=6)
        draw.rectangle([width * 0.4, height * 0.35, width * 0.6, height * 0.65], fill=colours[0])
        draw.text((width * 0.1, height * 0.05), f"COIN {index}", fill="#000000", font_size=max(12, height // 10))
        images.append(image)
    return images


def cosine_rows(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a = a / np.linalg.norm(a, axis=1, keepdims=True)
    b = b / np.linalg.norm(b, axis=1, keepdims=True)
    return np.sum(a * b, axis=1)


def main(source: str, destination: str) -> None:
    torch.manual_seed(0)
    model = torch.jit.load(source, map_location="cpu").eval()

    started = time.perf_counter()
    with torch.no_grad():
        torch.onnx.export(
            model,
            (torch.zeros(1, 3, sscd.SHORT_SIDE, sscd.SHORT_SIDE),),
            destination,
            dynamo=False,
            opset_version=OPSET,
            do_constant_folding=True,
            input_names=[sscd.INPUT_NAME],
            output_names=[sscd.OUTPUT_NAME],
            dynamic_axes={sscd.INPUT_NAME: {0: "batch", 2: "height", 3: "width"}, sscd.OUTPUT_NAME: {0: "batch"}},
        )
    onnx.checker.check_model(destination, full_check=True)
    print(json.dumps({"export": "ok", "opset": OPSET, "seconds": round(time.perf_counter() - started, 1)}), flush=True)

    session = ort.InferenceSession(destination, providers=["CPUExecutionProvider"])
    cases: list[tuple[str, np.ndarray]] = []
    for shape in [(1, 3, 288, 288), (1, 3, 288, 384), (2, 3, 320, 288), (1, 3, 512, 288), (1, 3, 288, 1152)]:
        cases.append((f"random {shape}", torch.randn(*shape).numpy()))
    for index, image in enumerate(logo_like_images()):
        cases.append((f"logo {index} {image.size}", sscd.preprocess(image)))

    worst_cosine, worst_abs = 1.0, 0.0
    for name, batch in cases:
        with torch.no_grad():
            reference = model(torch.from_numpy(batch)).numpy()
        exported = session.run([sscd.OUTPUT_NAME], {sscd.INPUT_NAME: batch})[0]
        if reference.shape != exported.shape or reference.shape[1] != sscd.DIMENSIONS:
            raise SystemExit(f"{name}: TorchScript gave {reference.shape}, ONNX gave {exported.shape}")
        cosine = float(cosine_rows(reference, exported).min())
        max_abs = float(np.abs(reference - exported).max())
        worst_cosine, worst_abs = min(worst_cosine, cosine), max(worst_abs, max_abs)
        print(
            json.dumps(
                {
                    "case": name,
                    "cosine": round(cosine, 8),
                    "maxAbsDiff": float(f"{max_abs:.3g}"),
                    # Whether the model already returns unit vectors; the service normalises either way.
                    "referenceNorm": round(float(np.linalg.norm(reference, axis=1).mean()), 6),
                }
            ),
            flush=True,
        )

    print(json.dumps({"parity": "ok" if worst_cosine >= MIN_COSINE else "FAILED", "minCosine": worst_cosine, "maxAbsDiff": worst_abs}), flush=True)
    if worst_cosine < MIN_COSINE:
        raise SystemExit(f"ONNX export disagrees with TorchScript: cosine {worst_cosine} < {MIN_COSINE}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
