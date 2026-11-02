"""The HTTP interface as the Durable Object sees it: each endpoint's JSON shape and status codes, over a real socket."""

from __future__ import annotations

import hashlib
import http.client
import json
import socket
from urllib.parse import urlsplit

import pytest

from tests import logos
from tests.conftest import PNG_BYTES
from vision.server import MAX_BATCH, MAX_IMAGE_BYTES

SIGNATURE_FIELDS = {"sha256", "width", "height", "pdq", "sscd", "ms"}


def request(base: str, method: str, path: str, body=None, headers=None, **options):
    url = urlsplit(base)
    connection = http.client.HTTPConnection(url.hostname, url.port, timeout=120)
    try:
        connection.request(method, path, body=body, headers=headers or {}, **options)
        response = connection.getresponse()
        raw = response.read()
        return response.status, dict(response.getheaders()), json.loads(raw) if raw else None
    finally:
        connection.close()


def raw_request(base: str, data: bytes) -> tuple[int, bytes]:
    """Sends bytes as they are, for requests http.client will not make, and returns the status and the whole reply."""
    url = urlsplit(base)
    with socket.create_connection((url.hostname, url.port), timeout=30) as sock:
        sock.sendall(data)
        reply = b""
        while chunk := sock.recv(65536):
            reply += chunk
            if b"\r\n\r\n" in reply:
                head, _, body = reply.partition(b"\r\n\r\n")
                length = next((int(line.split(b":")[1]) for line in head.split(b"\r\n") if line.lower().startswith(b"content-length")), 0)
                if len(body) >= length:
                    break
    return int(reply.split(b" ", 2)[1]), reply


def assert_signature(result: dict, data: bytes) -> None:
    assert SIGNATURE_FIELDS <= set(result)
    assert result["sha256"] == hashlib.sha256(data).hexdigest()
    assert set(result["pdq"]) == {"bits", "quality", "dihedral"}
    assert len(result["pdq"]["bits"]) == 256 and set(result["pdq"]["bits"]) <= {"0", "1"}
    assert result["pdq"]["dihedral"][0] == result["pdq"]["bits"] and len(result["pdq"]["dihedral"]) == 8
    assert isinstance(result["pdq"]["quality"], int)
    assert len(result["sscd"]) == 512 and all(isinstance(value, float) for value in result["sscd"])
    assert result["ms"] > 0


def test_health(vision_url):
    status, headers, body = request(vision_url, "GET", "/health")
    assert status == 200 and headers["Content-Type"] == "application/json"
    assert body == {"ok": True, "model": "sscd_disc_mixup", "pdq": "pdqhash 0.2.8", "startedAt": "2026-11-02T00:00:00.000Z", "readyMs": 0}


def test_signatures_of_an_uploaded_png(vision_url):
    status, _, body = request(vision_url, "POST", "/signatures", PNG_BYTES, {"Content-Type": "image/png"})
    assert status == 200
    assert set(body) == SIGNATURE_FIELDS
    assert_signature(body, PNG_BYTES)
    assert (body["width"], body["height"]) == (512, 512)


def test_signatures_of_a_chunked_upload(vision_url):
    chunks = [PNG_BYTES[start : start + 10_000] for start in range(0, len(PNG_BYTES), 10_000)]
    status, _, body = request(vision_url, "POST", "/signatures", iter(chunks), encode_chunked=True)
    assert status == 200
    assert_signature(body, PNG_BYTES)


@pytest.mark.parametrize(
    ("data", "message"),
    [(b"definitely not an image", "not a PNG, JPEG, GIF or WebP image"), (b'<svg xmlns="http://www.w3.org/2000/svg"/>', "SVG")],
    ids=["garbage", "svg"],
)
def test_an_unreadable_upload_is_422(vision_url, data, message):
    status, _, body = request(vision_url, "POST", "/signatures", data)
    assert status == 422
    assert message in body["error"]


def test_an_upload_over_5_mb_is_413_before_its_body_is_read(vision_url):
    status, reply = raw_request(
        vision_url, f"POST /signatures HTTP/1.1\r\nHost: x\r\nContent-Length: {MAX_IMAGE_BYTES + 1}\r\n\r\n".encode()
    )
    assert status == 413
    assert b"Connection: close" in reply and b"larger than 5 MB" in reply


def test_a_chunked_upload_over_5_mb_is_413(vision_url):
    # One chunk that declares 6 MB is refused on its size line, before any of it is read.
    status, _ = raw_request(
        vision_url,
        b"POST /signatures HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n" + f"{6 * 1024 * 1024:x}\r\n".encode(),
    )
    assert status == 413


def test_an_upload_without_a_length_is_411(vision_url):
    status, _ = raw_request(vision_url, b"POST /signatures HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
    assert status == 411


def test_unknown_paths_and_wrong_methods(vision_url):
    assert request(vision_url, "GET", "/nope")[0] == 404
    status, headers, body = request(vision_url, "GET", "/signatures")
    assert status == 405 and headers["Allow"] == "POST" and "error" in body
    assert request(vision_url, "POST", "/health", b"{}")[0] == 405


def test_a_rejected_body_does_not_poison_the_connection(vision_url):
    # A 404 sent before reading a body must not leave that body to be parsed as the next request.
    url = urlsplit(vision_url)
    connection = http.client.HTTPConnection(url.hostname, url.port, timeout=30)
    try:
        # Were the body left on the connection, the next request's answer would be this smuggled request's 404.
        connection.request("POST", "/nope", body=b"GET /smuggled HTTP/1.1\r\nHost: x\r\n\r\n")
        response = connection.getresponse()
        response.read()
        assert response.status == 404
        connection.request("GET", "/health")
        assert connection.getresponse().status == 200
    finally:
        connection.close()


def test_fetch_answers_every_image_in_request_order(vision_url, image_server):
    images = [
        {"id": "logo", "url": f"{image_server}/logo.png"},
        {"id": "missing", "url": f"{image_server}/missing.png"},
        {"id": "page", "url": f"{image_server}/page.html"},
        {"id": "ftp", "url": "ftp://example.com/logo.png"},
        {"id": "rocket", "url": f"{image_server}/rocket.jpg"},
        {"id": "redirected", "url": f"{image_server}/redirect/2"},
    ]
    status, _, body = request(vision_url, "POST", "/signatures/fetch", json.dumps({"images": images}).encode())
    assert status == 200
    results = body["results"]
    assert [result["id"] for result in results] == [image["id"] for image in images]
    assert [result["ok"] for result in results] == [True, False, False, False, True, True]

    assert set(results[0]) == SIGNATURE_FIELDS | {"id", "ok"}
    assert_signature(results[0], PNG_BYTES)
    assert results[5]["sha256"] == results[0]["sha256"]
    assert results[1] == {"id": "missing", "ok": False, "error": "HTTP 404"}
    assert results[2]["error"] == "not a PNG, JPEG, GIF or WebP image (served as text/html)"
    assert "'ftp' is not supported" in results[3]["error"]


def test_fetched_and_uploaded_signatures_agree(vision_url, image_server):
    _, _, uploaded = request(vision_url, "POST", "/signatures", PNG_BYTES)
    _, _, fetched = request(
        vision_url, "POST", "/signatures/fetch", json.dumps({"images": [{"id": "a", "url": f"{image_server}/logo.png"}]}).encode()
    )
    result = fetched["results"][0]
    assert {key: result[key] for key in ("sha256", "width", "height", "pdq", "sscd")} == {
        key: uploaded[key] for key in ("sha256", "width", "height", "pdq", "sscd")
    }


def test_fetch_of_an_empty_batch(vision_url):
    assert request(vision_url, "POST", "/signatures/fetch", b'{"images": []}')[2] == {"results": []}


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"[]",
        b'{"images": "x"}',
        b'{"images": [{"id": 1, "url": "http://example.com/a.png"}]}',
        b'{"images": [{"id": "a"}]}',
        json.dumps({"images": [{"id": str(i), "url": "http://example.com/a.png"} for i in range(MAX_BATCH + 1)]}).encode(),
    ],
    ids=["not-json", "array", "images-not-a-list", "id-not-a-string", "url-missing", "too-many"],
)
def test_a_malformed_fetch_request_is_400(vision_url, body):
    status, _, answer = request(vision_url, "POST", "/signatures/fetch", body)
    assert status == 400 and answer["error"]


def test_a_big_batch_holds_its_order(vision_url, image_server):
    images = [{"id": f"i{i}", "url": f"{image_server}/{'logo.png' if i % 3 else 'missing.png'}"} for i in range(MAX_BATCH)]
    status, _, body = request(vision_url, "POST", "/signatures/fetch", json.dumps({"images": images}).encode())
    assert status == 200
    assert [result["id"] for result in body["results"]] == [image["id"] for image in images]
    assert [result["ok"] for result in body["results"]] == [bool(i % 3) for i in range(MAX_BATCH)]


def test_the_server_survives_a_garbage_request_line(vision_url):
    status, _ = raw_request(vision_url, b"\x16\x03\x01 garbage\r\n\r\n")
    assert status == 400
    assert request(vision_url, "GET", "/health")[0] == 200


def test_a_jpeg_upload(vision_url):
    data = logos.encode(logos.rocket(), "JPEG", quality=80)
    status, _, body = request(vision_url, "POST", "/signatures", data)
    assert status == 200
    assert_signature(body, data)
