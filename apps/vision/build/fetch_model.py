"""Fetches a model file from the first of several sources whose bytes match a pinned SHA-256.

The Dockerfile's model stage runs it for SSCD's weights, with Heat's own copy first and Meta's URL after it, so the
build needs only one of them to answer: when Meta's certificate lapsed on 2026-11-11 the one URL the build then had
failed every build for 18.5 hours (#108). The pin is what the build trusts, not the source: a source that fails, stalls
or serves other bytes is passed over, nothing but the pinned bytes ever reaches the destination, and the build fails
only when no source gave them.

With --every, each source must give the pinned bytes, which is how the weekly check (the Dockerfile's sources stage)
finds a copy that died while the other kept the builds green.

Standard library only: it runs before anything is installed, and on the owner's Mac from publish_weights.sh.

Usage: python fetch_model.py [--every] [--rounds N] [--pause SECONDS] <sha256> <destination> <url>...
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.request

# Each connect and each read may take this long; a source that stalls longer is a source that failed.
SOCKET_TIMEOUT_SECONDS = 30
# A source that trickles bytes just under the socket timeout must not hold the build for hours.
SOURCE_DEADLINE_SECONDS = 600
CHUNK_BYTES = 1 << 20


def log(**fields: object) -> None:
    print(json.dumps(fields), flush=True)


def attempt(url: str, sha256: str, destination: str) -> str | None:
    """Downloads url beside destination and moves it into place only if its bytes match; returns what went wrong."""
    partial = f"{destination}.part"
    started = time.monotonic()
    digest = hashlib.sha256()
    received = 0
    try:
        with urllib.request.urlopen(url, timeout=SOCKET_TIMEOUT_SECONDS) as response, open(partial, "wb") as file:
            while chunk := response.read(CHUNK_BYTES):
                if time.monotonic() - started > SOURCE_DEADLINE_SECONDS:
                    return f"gave {received} bytes in {SOURCE_DEADLINE_SECONDS} s and was given up on"
                digest.update(chunk)
                file.write(chunk)
                received += len(chunk)
        if digest.hexdigest() != sha256:
            return f"its {received} bytes have SHA-256 {digest.hexdigest()}, not the pinned one"
        os.replace(partial, destination)
        return None
    except Exception as error:
        # Whatever one source does wrong (an HTTP error, a lapsed certificate, a timeout, a reset, a short body) is a
        # reason to ask the next, never to stop.
        return f"{type(error).__name__}: {error}"
    finally:
        if os.path.exists(partial):
            os.remove(partial)


def fetch(sources: list[str], sha256: str, destination: str, *, every: bool, rounds: int, pause: float) -> bool:
    failed = set(sources)
    for round_number in range(1, rounds + 1):
        for url in sources:
            if url not in failed:
                continue
            error = attempt(url, sha256, destination)
            if error is None:
                failed.discard(url)
                log(source=url, sha256=sha256, bytes=os.path.getsize(destination), round=round_number)
                if not every:
                    return True
            else:
                log(source=url, failed=error, round=round_number)
        if not failed:
            return True
        if round_number < rounds:
            time.sleep(pause)
    return False


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--every", action="store_true", help="every source must give the pinned bytes")
    parser.add_argument("--rounds", type=int, default=3, help="how many times the sources are gone through")
    parser.add_argument("--pause", type=float, default=5, help="seconds between two rounds")
    parser.add_argument("sha256")
    parser.add_argument("destination")
    parser.add_argument("url", nargs="+")
    args = parser.parse_args(argv)

    sha256 = args.sha256.lower()
    if len(sha256) != 64 or any(digit not in "0123456789abcdef" for digit in sha256):
        parser.error("the pin must be a SHA-256 in hex")
    os.makedirs(os.path.dirname(os.path.abspath(args.destination)), exist_ok=True)
    if fetch(args.url, sha256, args.destination, every=args.every, rounds=args.rounds, pause=args.pause):
        return 0
    what = "not every source" if args.every else "no source"
    print(f"{what} gave the bytes pinned by SHA-256 {sha256}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
