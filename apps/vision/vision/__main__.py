"""Starts the vision service on port 8080 only once it can answer: `python -m vision`.

The Container treats the port opening as the service being up, so everything slow happens before the server binds:
importing numpy, Pillow, ONNX Runtime and pdqhash, loading the ONNX session, and one warm-up through both signatures.

Environment: VISION_MODEL, the ONNX file (the image sets it); VISION_THREADS, ONNX Runtime's intra-op threads (default 1,
for the basic instance's quarter of a vCPU); VISION_PORT, 8080 unless a test or a local run needs another.
"""

import time

# Taken before the heavy imports below, for when /proc cannot say when the process started.
_MODULE_STARTED = time.time()

import datetime  # noqa: E402
import os  # noqa: E402
import signal  # noqa: E402
import sys  # noqa: E402
import threading  # noqa: E402

from . import sscd  # noqa: E402
from .fetch import Fetcher  # noqa: E402
from .server import VisionService, log, make_server  # noqa: E402

DEFAULT_PORT = 8080
DEFAULT_MODEL = "/opt/vision/models/sscd_disc_mixup.onnx"
# Cloudflare allows 15 minutes after SIGTERM; requests in flight get this long to finish before the process exits.
DRAIN_SECONDS = 30


def process_age() -> float:
    """Seconds since this process started, from the kernel's record of it, so interpreter start-up counts too."""
    try:
        with open("/proc/self/stat") as stat:
            # Field 22 is the start time in clock ticks after boot; the command name in field 2 may contain spaces, so the
            # fields are counted from the parenthesis that closes it, where field 3 begins.
            start_ticks = int(stat.read().rsplit(")", 1)[1].split()[19])
        return time.clock_gettime(time.CLOCK_BOOTTIME) - start_ticks / os.sysconf("SC_CLK_TCK")
    except (OSError, ValueError, IndexError, AttributeError):
        return time.time() - _MODULE_STARTED


def whole_number_from_environment(name: str, default: int, low: int, high: int) -> int:
    raw = os.environ.get(name, str(default)).strip()
    if not raw.isdigit() or not low <= int(raw) <= high:
        sys.exit(f"{name} must be a whole number from {low} to {high}, got {raw!r}")
    return int(raw)


def main() -> None:
    # As PID 1 in its Container the process ignores SIGTERM unless it handles it, so a stop while it is still loading
    # would wait out the platform's grace period; until the server exists there is nothing to drain.
    signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(0))
    threads = whole_number_from_environment("VISION_THREADS", 1, 1, 64)
    port = whole_number_from_environment("VISION_PORT", DEFAULT_PORT, 1, 65535)
    service = VisionService(sscd.Embedder(os.environ.get("VISION_MODEL", DEFAULT_MODEL), threads), Fetcher())
    service.warm_up()
    server = make_server(("0.0.0.0", port), service)

    age = process_age()
    started = datetime.datetime.fromtimestamp(time.time() - age, datetime.UTC)
    service.started_at = started.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    service.ready_ms = round(age * 1000)
    log({"event": "ready", "port": port, "readyMs": service.ready_ms, "threads": threads})

    def stop(signum, frame) -> None:
        # shutdown() waits for serve_forever to return, so it cannot run on the thread serve_forever is blocking.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        service.drain(DRAIN_SECONDS)
        log({"event": "stopped"})


if __name__ == "__main__":
    main()
