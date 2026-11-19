"""build/fetch_model.py as the Dockerfile runs it: only the pinned bytes reach the destination, from the first source
that gives them, and --every asks them of each source."""

from __future__ import annotations

import hashlib
import json
import socket
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

import vision

SCRIPT = Path(vision.__file__).resolve().parent.parent / "build" / "fetch_model.py"

MODEL = bytes(range(256)) * 4096
PIN = hashlib.sha256(MODEL).hexdigest()
OTHER = b"not the model" * 1000


class Sources:
    """A local server with one path per way a source can behave, counting what was asked of it."""

    def __init__(self) -> None:
        asked: list[str] = []
        self.asked = asked

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - http.server's name
                asked.append(self.path)
                if self.path == "/model":
                    self.answer(200, MODEL)
                elif self.path == "/other":
                    self.answer(200, OTHER)
                elif self.path == "/short":
                    # Half the model under the whole model's length, then the connection closes.
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(MODEL)))
                    self.end_headers()
                    self.wfile.write(MODEL[: len(MODEL) // 2])
                elif self.path == "/redirect":
                    # As a GitHub release asset answers: a redirect to where the bytes are.
                    self.send_response(302)
                    self.send_header("Location", "/model")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                elif self.path == "/once-broken":
                    if asked.count(self.path) > 1:
                        self.answer(200, MODEL)
                    else:
                        self.answer(503, b"busy")
                else:
                    self.answer(404, b"no such file")

            def answer(self, status: int, body: bytes) -> None:
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def url(self, path: str) -> str:
        return f"{self.base}{path}"


@pytest.fixture
def sources():
    instance = Sources()
    yield instance
    instance.server.shutdown()
    instance.server.server_close()


def closed_port_url() -> str:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return f"http://127.0.0.1:{sock.getsockname()[1]}/model"


def run(destination: Path, urls: list[str], *options: str, pin: str = PIN) -> tuple[int, list[dict], str]:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--pause", "0", *options, pin, str(destination), *urls],
        capture_output=True,
        text=True,
        timeout=120,
    )
    return result.returncode, [json.loads(line) for line in result.stdout.splitlines()], result.stderr


def test_the_first_source_that_gives_the_pinned_bytes_is_the_only_one_asked(tmp_path, sources):
    destination = tmp_path / "models" / "model.pt"
    code, lines, _ = run(destination, [sources.url("/model"), sources.url("/other")])
    assert code == 0
    assert destination.read_bytes() == MODEL
    assert sources.asked == ["/model"]
    assert lines == [{"source": sources.url("/model"), "sha256": PIN, "bytes": len(MODEL), "round": 1}]


@pytest.mark.parametrize("broken", ["/missing", "/other", "/short", "closed port"])
def test_a_source_that_fails_or_serves_other_bytes_is_passed_over(tmp_path, sources, broken):
    first = closed_port_url() if broken == "closed port" else sources.url(broken)
    destination = tmp_path / "model.pt"
    code, lines, _ = run(destination, [first, sources.url("/model")])
    assert code == 0
    assert destination.read_bytes() == MODEL
    assert [line["source"] for line in lines] == [first, sources.url("/model")]
    assert "failed" in lines[0] and "failed" not in lines[1]
    assert list(tmp_path.iterdir()) == [destination]


def test_a_source_that_redirects_to_the_bytes_is_followed(tmp_path, sources):
    destination = tmp_path / "model.pt"
    code, _, _ = run(destination, [sources.url("/redirect")])
    assert code == 0
    assert destination.read_bytes() == MODEL
    assert sources.asked == ["/redirect", "/model"]


def test_other_bytes_never_reach_the_destination(tmp_path, sources):
    destination = tmp_path / "model.pt"
    code, lines, stderr = run(destination, [sources.url("/other"), sources.url("/missing")], "--rounds", "2")
    assert code == 1
    assert list(tmp_path.iterdir()) == []
    assert sources.asked == ["/other", "/missing", "/other", "/missing"]
    assert hashlib.sha256(OTHER).hexdigest() in lines[0]["failed"]
    assert "404" in lines[1]["failed"]
    assert f"no source gave the bytes pinned by SHA-256 {PIN}" in stderr


def test_a_source_that_fails_once_is_asked_again_in_the_next_round(tmp_path, sources):
    destination = tmp_path / "model.pt"
    code, lines, _ = run(destination, [sources.url("/once-broken")])
    assert code == 0
    assert destination.read_bytes() == MODEL
    assert [line["round"] for line in lines] == [1, 2]


def test_every_asks_the_pinned_bytes_of_each_source(tmp_path, sources):
    destination = tmp_path / "model.pt"
    code, lines, _ = run(destination, [sources.url("/model"), sources.url("/redirect")], "--every")
    assert code == 0
    assert destination.read_bytes() == MODEL
    assert [line["source"] for line in lines] == [sources.url("/model"), sources.url("/redirect")]


def test_every_fails_when_one_source_does_not_give_them(tmp_path, sources):
    destination = tmp_path / "model.pt"
    code, lines, stderr = run(destination, [sources.url("/model"), sources.url("/missing")], "--every", "--rounds", "2")
    assert code == 1
    # The good source is asked once, the dead one in both rounds.
    assert sources.asked == ["/model", "/missing", "/missing"]
    assert [("failed" in line) for line in lines] == [False, True, True]
    assert "not every source gave the bytes" in stderr


def test_a_pin_that_is_not_a_sha256_is_refused_before_anything_is_asked(tmp_path, sources):
    code, _, stderr = run(tmp_path / "model.pt", [sources.url("/model")], pin="9f26bd4c")
    assert code == 2
    assert sources.asked == []
    assert "SHA-256" in stderr
