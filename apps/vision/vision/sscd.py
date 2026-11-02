"""SSCD copy-detection embeddings: Meta's sscd_disc_mixup model, exported to ONNX and run with ONNX Runtime on CPU.

The preprocessing is the SSCD README's `small_288` transform, reproduced without torchvision so the runtime image carries
no torch: the build's parity check (build/export_sscd.py) runs this same module against the TorchScript original.
"""

from __future__ import annotations

import os

# ONNX Runtime 1.31 on Linux starts Microsoft's 1DS telemetry at import, which would report from inside the Container and
# logs a warning when it cannot write a device ID; the Dockerfile sets this too, so this only covers a run outside it.
os.environ.setdefault("ORT_DISABLE_TELEMETRY", "1")

import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402
from PIL import Image  # noqa: E402

INPUT_NAME = "image"
OUTPUT_NAME = "embedding"
DIMENSIONS = 512

SHORT_SIDE = 288
# small_288 has no cap on the long side, so a 1 x 10,000 pixel strip would become a 288 x 2,880,000 tensor and exhaust the
# Container's 1 GiB. torchvision's own max_size rule caps it here; every image up to 4:1 is resized exactly as small_288
# does, and a longer one keeps its aspect ratio with its long side at 1,152.
MAX_LONG_SIDE = 4 * SHORT_SIDE

_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def resized_size(width: int, height: int) -> tuple[int, int]:
    """The (width, height) torchvision's Resize(288, max_size=1152) gives a PIL image of this size, to the pixel."""
    short, long = (width, height) if width <= height else (height, width)
    new_short, new_long = SHORT_SIDE, int(SHORT_SIDE * long / short)
    if new_long > MAX_LONG_SIDE:
        # torchvision would let the short side reach 0 for an extreme strip; one pixel keeps the tensor valid.
        new_short, new_long = max(1, int(MAX_LONG_SIDE * new_short / new_long)), MAX_LONG_SIDE
    return (new_short, new_long) if width <= height else (new_long, new_short)


def preprocess(image: Image.Image) -> np.ndarray:
    """An RGB image as the model's float32 NCHW input: resized, scaled to [0, 1] and normalised with ImageNet's statistics."""
    if image.mode != "RGB":
        raise ValueError(f"expected an RGB image, got {image.mode}")
    # torchvision resizes a PIL image with PIL itself, whose bilinear filter widens its support when it shrinks, which is
    # the antialiasing small_288 relies on.
    resized = image.resize(resized_size(*image.size), Image.Resampling.BILINEAR)
    pixels = np.asarray(resized, dtype=np.float32) / np.float32(255)
    normalised = (pixels - _MEAN) / _STD
    return np.ascontiguousarray(normalised.transpose(2, 0, 1)[np.newaxis])


def normalise(vector: np.ndarray) -> np.ndarray:
    """The vector scaled to unit length, so the cosine of two embeddings is their dot product (pgvector's cosine needs no more)."""
    vector = np.asarray(vector, dtype=np.float32)
    norm = float(np.linalg.norm(vector))
    if not np.isfinite(norm) or norm == 0.0:
        raise ValueError("the model returned an empty embedding")
    return vector / np.float32(norm)


class Embedder:
    """One ONNX Runtime session over the exported model; callers serialise their calls (server.py holds one lock)."""

    def __init__(self, model_path: str, threads: int = 1) -> None:
        options = ort.SessionOptions()
        # A basic instance has a quarter of a vCPU, so more threads would only contend for it; VISION_THREADS raises this
        # on a bigger instance.
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(model_path, sess_options=options, providers=["CPUExecutionProvider"])

    def embed(self, image: Image.Image) -> np.ndarray:
        """The image's unit-length 512-dimension float32 embedding."""
        output = self.session.run([OUTPUT_NAME], {INPUT_NAME: preprocess(image)})[0]
        if output.shape != (1, DIMENSIONS):
            raise ValueError(f"the model returned shape {output.shape}, expected (1, {DIMENSIONS})")
        return normalise(output[0])


def to_json(vector: np.ndarray) -> list[float]:
    """The embedding as JSON numbers, each the shortest decimal that reads back as the same float32 (pgvector stores float32)."""
    return [float(np.format_float_positional(value, unique=True, trim="-")) for value in np.asarray(vector, dtype=np.float32)]
