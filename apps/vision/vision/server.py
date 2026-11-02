"""The vision service's HTTP interface, on the standard library's threading HTTP server.

GET  /health              whether it is ready, and what it runs
POST /signatures          raw image bytes in, its signatures out
POST /signatures/fetch    {"images": [{"id", "url"}]} in, each image fetched and its signatures (or why not) out, in order

The Durable Object in front of it is the only client, so the server stays small: no framework, JSON in and out, one log
line per request. Signatures are computed one image at a time under one lock, because the instance has a quarter of a
vCPU (parallel inference would only interleave) and 1 GiB of memory (parallel decodes of large images would not fit),
while fetches, which only wait on the network, run 8 at a time.
"""

from __future__ import annotations

import hashlib
import json
import sys
import threading
import time
import traceback
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from PIL import Image

from . import MODEL_NAME, PDQ_VERSION, pdq, sscd
from .decode import ImageRejected, decode
from .fetch import FetchError, Fetcher, normalise_url

MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_BATCH = 50
FETCH_CONCURRENCY = 8
# 50 entries of id and url fit in a few kilobytes; the cap only stops a client from making the server buffer megabytes
# of JSON.
MAX_JSON_BYTES = 256 * 1024

_log_lock = threading.Lock()


def log(record: dict) -> None:
    """One JSON line on stdout, which Cloudflare's container logs collect."""
    line = json.dumps(record, separators=(",", ":"))
    with _log_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


class VisionService:
    """Everything a request needs: the SSCD session, the fetcher and the lock that serialises signature work."""

    def __init__(self, embedder: sscd.Embedder, fetcher: Fetcher) -> None:
        self.embedder = embedder
        self.fetcher = fetcher
        self.started_at = ""
        self.ready_ms = 0.0
        self._compute_lock = threading.Lock()
        self._fetch_pool = ThreadPoolExecutor(max_workers=FETCH_CONCURRENCY, thread_name_prefix="fetch")
        self._in_flight = 0
        self._idle = threading.Condition()

    def request_started(self) -> None:
        with self._idle:
            self._in_flight += 1

    def request_finished(self) -> None:
        with self._idle:
            self._in_flight -= 1
            self._idle.notify_all()

    def drain(self, seconds: float) -> bool:
        """Waits up to seconds for requests in flight to finish; True if none is left."""
        with self._idle:
            return self._idle.wait_for(lambda: self._in_flight == 0, timeout=seconds)

    def warm_up(self) -> None:
        """Runs one small image through both signatures, so the first real request does not pay ONNX Runtime's first-run setup."""
        image = Image.new("RGB", (sscd.SHORT_SIDE, sscd.SHORT_SIDE), (255, 255, 255))
        pdq.signature(image)
        self.embedder.embed(image)

    def health(self) -> dict:
        return {"ok": True, "model": MODEL_NAME, "pdq": PDQ_VERSION, "startedAt": self.started_at, "readyMs": self.ready_ms}

    def signatures(self, data: bytes) -> dict:
        """The signatures of one image's bytes, or ImageRejected."""
        digest = hashlib.sha256(data).hexdigest()
        with self._compute_lock:
            started = time.perf_counter()
            image = decode(data)
            hashes = pdq.signature(image)
            embedding = self.embedder.embed(image)
            elapsed = (time.perf_counter() - started) * 1000
        return {
            "sha256": digest,
            "width": image.width,
            "height": image.height,
            "pdq": hashes,
            "sscd": sscd.to_json(embedding),
            "ms": round(elapsed, 1),
        }

    def fetch_signatures(self, images: list[dict]) -> list[dict]:
        """Each image's signatures, or why it has none, in request order; no single image can fail the batch."""
        results: list[dict | None] = [None] * len(images)
        pending: deque[tuple[int, Future]] = deque()
        queue = iter(enumerate(images))

        def submit_next() -> bool:
            for index, item in queue:
                try:
                    url = normalise_url(item["url"])
                except FetchError as error:
                    results[index] = {"id": item["id"], "ok": False, "error": str(error)}
                    continue
                pending.append((index, self._fetch_pool.submit(self.fetcher.fetch, url)))
                return True
            return False

        # Only 8 fetches are ever submitted ahead of the one being computed, so a batch holds at most 8 bodies of up to
        # 5 MB at once rather than all 50.
        while len(pending) < FETCH_CONCURRENCY and submit_next():
            pass
        while pending:
            index, future = pending.popleft()
            results[index] = self._fetched_result(images[index]["id"], future)
            submit_next()
        return [result for result in results if result is not None]

    def _fetched_result(self, image_id: str, future: Future) -> dict:
        try:
            data, content_type = future.result()
        except FetchError as error:
            return {"id": image_id, "ok": False, "error": str(error)}
        except Exception:
            traceback.print_exc()
            return {"id": image_id, "ok": False, "error": "the fetch failed unexpectedly"}
        try:
            return {"id": image_id, "ok": True, **self.signatures(data)}
        except ImageRejected as error:
            served = f" (served as {content_type.split(';')[0].strip()})" if content_type else ""
            return {"id": image_id, "ok": False, "error": f"{error}{served}"}
        except Exception:
            traceback.print_exc()
            return {"id": image_id, "ok": False, "error": "computing the signatures failed unexpectedly"}


class HttpError(Exception):
    def __init__(self, status: int, message: str, headers: dict[str, str] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.headers = headers or {}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "heat-vision"
    sys_version = ""
    # A client that stops sending mid-body would otherwise hold its thread forever.
    timeout = 60

    service: VisionService  # set on the subclass make_server builds

    def do_GET(self) -> None:
        self._dispatch()

    def do_POST(self) -> None:
        self._dispatch()

    def do_HEAD(self) -> None:
        self._dispatch()

    def do_PUT(self) -> None:
        self._dispatch()

    def do_PATCH(self) -> None:
        self._dispatch()

    def do_DELETE(self) -> None:
        self._dispatch()

    def _dispatch(self) -> None:
        started = time.perf_counter()
        path = urlsplit(self.path).path
        extra: dict = {}
        self._body_read = False
        self.service.request_started()
        try:
            try:
                status, body, headers = self._route(path, extra)
            except HttpError as error:
                status, body, headers = error.status, {"error": str(error)}, error.headers
            except Exception:
                traceback.print_exc()
                status, body, headers = 500, {"error": "internal error"}, {}
            if not self._body_read and self._has_body():
                # A body left unread (a 404 or 405 before reading it) would be parsed as the next request on this
                # connection.
                self.close_connection = True
            self._respond(status, body, headers)
        finally:
            self.service.request_finished()
        elapsed = round((time.perf_counter() - started) * 1000, 1)
        log({"method": self.command, "path": path, "status": status, "ms": elapsed, **extra})

    def _route(self, path: str, extra: dict) -> tuple[int, dict, dict[str, str]]:
        routes = {"/health": "GET", "/signatures": "POST", "/signatures/fetch": "POST"}
        if path not in routes:
            raise HttpError(404, f"no route {path}")
        if self.command != routes[path]:
            raise HttpError(405, f"{path} takes {routes[path]}", {"Allow": routes[path]})
        if path == "/health":
            return 200, self.service.health(), {}
        if path == "/signatures":
            data = self._read_body(MAX_IMAGE_BYTES)
            extra["bytes"] = len(data)
            try:
                return 200, self.service.signatures(data), {}
            except ImageRejected as error:
                raise HttpError(422, str(error)) from None
        images = self._fetch_request()
        extra["images"] = len(images)
        results = self.service.fetch_signatures(images)
        extra["ok"] = sum(1 for result in results if result["ok"])
        return 200, {"results": results}, {}

    def _fetch_request(self) -> list[dict]:
        raw = self._read_body(MAX_JSON_BYTES)
        try:
            body = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise HttpError(400, "the body is not JSON") from None
        images = body.get("images") if isinstance(body, dict) else None
        if not isinstance(images, list):
            raise HttpError(400, 'the body must be {"images": [{"id": string, "url": string}]}')
        if len(images) > MAX_BATCH:
            raise HttpError(400, f"at most {MAX_BATCH} images per request, got {len(images)}")
        for position, item in enumerate(images):
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not isinstance(item.get("url"), str):
                raise HttpError(400, f"images[{position}] must be an object with a string id and a string url")
        return images

    def _has_body(self) -> bool:
        declared = self.headers.get("Content-Length", "0").strip()
        return "chunked" in self.headers.get("Transfer-Encoding", "").lower() or declared not in ("", "0")

    def _read_body(self, limit: int) -> bytes:
        # Set before reading: a body abandoned partway (413, malformed) closes the connection itself.
        self._body_read = True
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            return self._read_chunked(limit)
        declared = self.headers.get("Content-Length")
        if declared is None:
            raise HttpError(411, "Content-Length is required")
        if not declared.strip().isdigit():
            self.close_connection = True
            raise HttpError(400, "Content-Length is not a number")
        length = int(declared)
        if length > limit:
            # The body is left unread, so the connection cannot carry another request.
            self.close_connection = True
            raise HttpError(413, f"the body is larger than {_size(limit)}")
        data = self.rfile.read(length)
        if len(data) < length:
            self.close_connection = True
            raise HttpError(400, "the body ended before its Content-Length")
        return data

    def _read_chunked(self, limit: int) -> bytes:
        chunks: list[bytes] = []
        total = 0
        while True:
            line = self.rfile.readline(1024)
            try:
                size = int(line.split(b";", 1)[0].strip(), 16)
            except ValueError:
                self.close_connection = True
                raise HttpError(400, "malformed chunked body") from None
            if size == 0:
                # Trailer fields, if any, end with an empty line.
                while self.rfile.readline(1024) not in (b"\r\n", b"\n", b""):
                    pass
                return b"".join(chunks)
            total += size
            if total > limit:
                self.close_connection = True
                raise HttpError(413, f"the body is larger than {_size(limit)}")
            chunk = self.rfile.read(size)
            self.rfile.readline(1024)
            if len(chunk) < size:
                self.close_connection = True
                raise HttpError(400, "the chunked body ended early")
            chunks.append(chunk)

    def _respond(self, status: int, body: dict, headers: dict[str, str]) -> None:
        payload = json.dumps(body, separators=(",", ":")).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            for name, value in headers.items():
                self.send_header(name, value)
            if self.close_connection:
                self.send_header("Connection", "close")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            # The client went away; there is nobody left to tell.
            self.close_connection = True

    def log_request(self, code="-", size="-") -> None:
        # _dispatch logs every routed request as one JSON line with its timing, so the base class's line is dropped.
        pass

    def log_message(self, format: str, *args) -> None:
        # Only what the base class handles before routing reaches here, such as a malformed request line or a timeout.
        log({"event": "http", "message": format % args})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64


def make_server(address: tuple[str, int], service: VisionService) -> Server:
    """A listening server bound to address; port 0 picks a free port, as the tests do."""
    handler = type("BoundHandler", (Handler,), {"service": service})
    return Server(address, handler)


def _size(limit: int) -> str:
    return f"{limit // (1024 * 1024)} MB" if limit >= 1024 * 1024 else f"{limit // 1024} KB"
