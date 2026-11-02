"""Shared fixtures: the service on the real ONNX model, the service over HTTP, and a local server for /signatures/fetch.

The tests run inside the Dockerfile's test stage, against the model the build just exported and the pdqhash it just
compiled, so a green run means the image that ships computes what the thresholds expect.
"""

from __future__ import annotations

import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pytest

from tests import logos
from vision import pdq, sscd
from vision.fetch import Fetcher
from vision.server import VisionService, make_server

MODEL = os.environ.get("VISION_MODEL", "/opt/vision/models/sscd_disc_mixup.onnx")


@pytest.fixture(scope="session")
def service() -> VisionService:
    # The fetch tests serve their images from 127.0.0.1, which the service refuses by default.
    instance = VisionService(sscd.Embedder(MODEL, threads=1), Fetcher(allow_private_networks=True))
    instance.started_at = "2026-11-02T00:00:00.000Z"
    instance.ready_ms = 0
    return instance


@pytest.fixture(scope="session")
def vision_url(service: VisionService):
    server = make_server(("127.0.0.1", 0), service)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


def cosine(a, b) -> float:
    """Embeddings are unit length, so this is their cosine similarity."""
    return float(np.dot(np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)))


def best_distance(candidate: dict, original: dict) -> int:
    """Spec 6.2's match distance: the candidate's 8 dihedral hashes against the original's hash."""
    return min(pdq.distance(variant, original["pdq"]["bits"]) for variant in candidate["pdq"]["dihedral"])


PNG_BYTES = logos.encode(logos.frog(), "PNG")


class _ImageHandler(BaseHTTPRequestHandler):
    """Serves the cases /signatures/fetch must tell apart."""

    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        path = self.path
        if path == "/logo.png":
            self._send(200, "image/png", PNG_BYTES)
        elif path.startswith("/denying-gateway/ipfs/"):
            # An IPFS gateway that refuses a CID, as ipfs.io refuses those on its denylist.
            self._send(403, "text/plain", b"forbidden")
        elif path.startswith("/serving-gateway/ipfs/"):
            self._send(200, "image/png", PNG_BYTES)
        elif path == "/rocket.jpg":
            self._send(200, "image/jpeg", logos.encode(logos.rocket(), "JPEG", quality=90))
        elif path == "/page.html":
            self._send(200, "text/html; charset=utf-8", b"<!doctype html><html><body>not a logo</body></html>")
        elif path.startswith("/redirect/"):
            # /redirect/<n> answers with n redirects in a row before the logo.
            remaining = int(path.rsplit("/", 1)[1])
            location = "/logo.png" if remaining <= 1 else f"/redirect/{remaining - 1}"
            self.send_response(302)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif path == "/redirect-file":
            self.send_response(302)
            self.send_header("Location", "file:///etc/passwd")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif path == "/big-declared":
            self._send(200, "image/png", b"\0" * (6 * 1024 * 1024))
        elif path == "/big-streamed":
            # No Content-Length, so only counting the bytes as they arrive can catch it.
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            chunk = b"\0" * (256 * 1024)
            try:
                for _ in range(24):
                    self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                self.wfile.write(b"0\r\n\r\n")
            except (BrokenPipeError, ConnectionResetError):
                pass
        elif path == "/slow-headers":
            time.sleep(3)
            self._send(200, "image/png", PNG_BYTES)
        elif path.startswith("/slow-redirect/"):
            # Each hop answers just inside a short deadline; only the chain as a whole overruns it.
            time.sleep(0.4)
            remaining = int(path.rsplit("/", 1)[1])
            self.send_response(302)
            self.send_header("Location", "/logo.png" if remaining <= 1 else f"/slow-redirect/{remaining - 1}")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif path == "/slow":
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(PNG_BYTES)))
            self.end_headers()
            try:
                # Trickles the body slower than any deadline the tests set.
                for start in range(0, len(PNG_BYTES), 64):
                    self.wfile.write(PNG_BYTES[start : start + 64])
                    self.wfile.flush()
                    time.sleep(0.2)
            except (BrokenPipeError, ConnectionResetError):
                pass
        else:
            self._send(404, "text/plain", b"not found")

    def _send(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, format: str, *args) -> None:
        pass


@pytest.fixture(scope="session")
def image_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _ImageHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()
