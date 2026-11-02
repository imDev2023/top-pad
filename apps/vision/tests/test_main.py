"""`python -m vision` as the Container runs it: the port opens only once the service is ready, and SIGTERM stops it cleanly."""

from __future__ import annotations

import http.client
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import vision

APP_DIR = Path(vision.__file__).resolve().parent.parent


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def test_the_port_opens_ready_and_sigterm_stops_the_service():
    port = free_port()
    process = subprocess.Popen(
        [sys.executable, "-m", "vision"],
        cwd=APP_DIR,
        env={**os.environ, "VISION_PORT": str(port)},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + 60
        while True:
            try:
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
                connection.request("GET", "/health")
                response = connection.getresponse()
                body = json.loads(response.read())
                connection.close()
                break
            except ConnectionRefusedError:
                assert process.poll() is None, process.stderr.read().decode()
                assert time.monotonic() < deadline, "the service did not open its port within 60 s"
                time.sleep(0.05)
        # The very first answer the port gives is a ready one: nothing loads after it opens.
        assert response.status == 200 and body["ok"] is True
        assert body["readyMs"] > 0
        assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", body["startedAt"])

        process.send_signal(signal.SIGTERM)
        stdout, stderr = process.communicate(timeout=30)
        assert process.returncode == 0, stderr.decode()
        lines = [json.loads(line) for line in stdout.decode().splitlines()]
        assert lines[0]["event"] == "ready" and lines[0]["port"] == port
        assert {"method": "GET", "path": "/health", "status": 200} == {key: lines[1][key] for key in ("method", "path", "status")}
        assert lines[-1] == {"event": "stopped"}
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()


def test_a_bad_thread_count_stops_the_start_with_a_reason():
    result = subprocess.run(
        [sys.executable, "-m", "vision"],
        cwd=APP_DIR,
        env={**os.environ, "VISION_THREADS": "zero"},
        capture_output=True,
        timeout=60,
    )
    assert result.returncode == 1
    assert "VISION_THREADS must be a whole number from 1 to 64, got 'zero'" in result.stderr.decode()
