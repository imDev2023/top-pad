"""Fetches logo images by URL for POST /signatures/fetch, within fixed bounds on time, size and redirects.

The URLs come from token metadata, which anyone can write, so every fetch is bounded (15 s, 5 MB, 3 redirects, http and
https only) and refuses to connect to a loopback, private or link-local address unless the service was started to allow
it (the tests serve their images from 127.0.0.1). The address is checked on the connected socket itself, so a hostname
that resolves to a public address for a check and a private one for the connection cannot slip through.
"""

from __future__ import annotations

import contextvars
import http.client
import ipaddress
import socket
import ssl
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

MAX_BYTES = 5 * 1024 * 1024
TIMEOUT_SECONDS = 15.0
MAX_REDIRECTS = 3
IPFS_GATEWAY = "https://ipfs.io/ipfs/"
# Asked for an IPFS image when its own gateway refuses or fails it. ipfs.io and dweb.link answer 403 for CIDs on their
# denylist, and so for about one verified logo in seven on 2026-11-02, which Pinata's public gateway served.
IPFS_FALLBACK_GATEWAYS = ("https://gateway.pinata.cloud/ipfs/",)

# Some image hosts and CDNs refuse or degrade requests that do not look like a browser's. AVIF is left out of Accept
# on purpose: the decoder takes PNG, JPEG, GIF and WebP only, and a CDN that negotiates formats would otherwise send AVIF.
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
ACCEPT = "image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8,*/*;q=0.5"

_CHUNK = 64 * 1024


# The deadline of the fetch running on this thread. urllib applies its timeout to each socket operation and starts every
# redirect afresh, so without this a server could spend 15 s on each of a chain's connections; the connection factory
# below caps every socket by what is left of this instead.
_deadline: contextvars.ContextVar[float | None] = contextvars.ContextVar("fetch_deadline", default=None)


class FetchError(Exception):
    """A URL that could not be fetched as an image; its message says why, for the result's error field."""


class _NonPublicAddress(OSError):
    pass


def normalise_url(url: object) -> str:
    """The URL to request: http and https as given, ipfs:// through the public gateway, anything else refused."""
    if not isinstance(url, str) or not url.strip():
        raise FetchError("the url is missing")
    url = url.strip()
    try:
        parts = urlsplit(url)
    except ValueError as error:
        raise FetchError(f"the url is malformed ({error})") from None
    scheme = parts.scheme.lower()
    if not scheme:
        raise FetchError("the url has no scheme; http, https and ipfs are accepted")
    if scheme == "ipfs":
        # Both ipfs://<cid>/<path> and the older ipfs://ipfs/<cid>/<path> appear in token metadata.
        path = url[len(parts.scheme) + 1 :].lstrip("/")
        if path.startswith("ipfs/"):
            path = path[len("ipfs/") :]
        if not path:
            raise FetchError("the ipfs url has no CID")
        return IPFS_GATEWAY + path
    if scheme not in ("http", "https"):
        raise FetchError(f"the url scheme {scheme!r} is not supported; http, https and ipfs are accepted")
    if not parts.hostname:
        raise FetchError("the url has no host")
    return url


class Fetcher:
    """Fetches one URL at a time per call; it holds no per-request state, so one instance serves every thread."""

    def __init__(
        self,
        allow_private_networks: bool = False,
        timeout: float = TIMEOUT_SECONDS,
        max_bytes: int = MAX_BYTES,
        ipfs_fallbacks: tuple[str, ...] = IPFS_FALLBACK_GATEWAYS,
    ) -> None:
        self.timeout = timeout
        self.max_bytes = max_bytes
        self.ipfs_fallbacks = ipfs_fallbacks
        connect = _within_deadline(_public_only if not allow_private_networks else socket.create_connection)
        # A bare OpenerDirector rather than build_opener: no file://, ftp:// or data: handlers, and no proxy settings
        # picked up from the environment.
        opener = urllib.request.OpenerDirector()
        for handler in (
            _HTTPHandler(connect),
            _HTTPSHandler(connect, ssl.create_default_context()),
            _RedirectHandler(),
            urllib.request.HTTPDefaultErrorHandler(),
            urllib.request.HTTPErrorProcessor(),
            urllib.request.UnknownHandler(),
        ):
            opener.add_handler(handler)
        self._opener = opener

    def fetch(self, url: str) -> tuple[bytes, str]:
        """
        The body at url and its Content-Type, or FetchError; url must already be normalised. An IPFS image (a path under
        /ipfs/ on any host) that its gateway refuses or fails is asked of the fallback gateways in turn, each with its
        own deadline; the first error is the one reported if none serves it.
        """
        try:
            return self._fetch_once(url)
        except FetchError as error:
            rest = _ipfs_rest(url)
            if rest is None or not _worth_another_gateway(error):
                raise
            for gateway in self.ipfs_fallbacks:
                if url.startswith(gateway):
                    continue
                try:
                    return self._fetch_once(gateway + rest)
                except FetchError:
                    continue
            raise

    def _fetch_once(self, url: str) -> tuple[bytes, str]:
        """One fetch of url, within the deadline, size and redirect bounds."""
        deadline = time.monotonic() + self.timeout
        request = urllib.request.Request(
            url, headers={"User-Agent": USER_AGENT, "Accept": ACCEPT, "Accept-Encoding": "identity"}
        )
        token = _deadline.set(deadline)
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                content_type = response.headers.get("Content-Type", "")
                declared = response.headers.get("Content-Length")
                if declared and declared.isdigit() and int(declared) > self.max_bytes:
                    raise FetchError(f"the image is larger than {self.max_bytes // (1024 * 1024)} MB")
                return self._read(response, deadline), content_type
        except FetchError:
            raise
        except urllib.error.HTTPError as error:
            message = str(error.msg)
            if message.startswith(urllib.request.HTTPRedirectHandler.inf_msg):
                raise FetchError(f"more than {MAX_REDIRECTS} redirects") from None
            # urllib itself refuses a redirect to a scheme other than http, https or ftp, with its own message.
            if message.startswith(_UNSUPPORTED_REDIRECT) or "Redirection to url" in message:
                raise FetchError(f"redirected to an unsupported url ({error.filename})") from None
            raise FetchError(f"HTTP {error.code}") from None
        except urllib.error.URLError as error:
            raise FetchError(_describe(error.reason)) from None
        except (TimeoutError, socket.timeout):
            raise FetchError(f"timed out after {self.timeout:g} s") from None
        except (http.client.HTTPException, OSError, ValueError) as error:
            raise FetchError(_describe(error)) from None
        finally:
            _deadline.reset(token)

    def _read(self, response, deadline: float) -> bytes:
        sock = _socket_of(response)
        chunks: list[bytes] = []
        total = 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise FetchError(f"timed out after {self.timeout:g} s")
            # The response closes its socket as soon as the declared body has arrived, and a closed socket refuses a
            # new timeout; the read below then just returns the end of the body.
            if sock is not None and not response.isclosed():
                # The socket timeout bounds each read, not the whole body; shrinking it to what is left of the deadline
                # stops a server that drips one byte at a time from holding a slot for long past 15 s.
                sock.settimeout(remaining)
            # read1 returns after one socket read; read would keep reading until it had a whole chunk, and a server
            # trickling bytes would never let the deadline check above run.
            chunk = response.read1(_CHUNK)
            if not chunk:
                return b"".join(chunks)
            total += len(chunk)
            if total > self.max_bytes:
                raise FetchError(f"the image is larger than {self.max_bytes // (1024 * 1024)} MB")
            chunks.append(chunk)


def _ipfs_rest(url: str) -> str | None:
    """
    What follows /ipfs/ in a gateway URL (the CID, its path and query), or None for a URL that is not one; a gateway may
    serve under a prefix, as dedicated ones do.
    """
    parts = urlsplit(url)
    at = parts.path.find("/ipfs/")
    if at < 0 or len(parts.path) <= at + len("/ipfs/"):
        return None
    return parts.path[at + len("/ipfs/") :] + (f"?{parts.query}" if parts.query else "")


def _worth_another_gateway(error: FetchError) -> bool:
    """A gateway's refusal, failure or slowness, which another gateway may not share; never a bad image or a size."""
    message = str(error)
    return message.startswith("HTTP ") or message.startswith("timed out") or "did not resolve" in message


def _within_deadline(connect):
    def create(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None, **kwargs):
        deadline = _deadline.get()
        if deadline is None:
            return connect(address, timeout, source_address, **kwargs)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("the fetch ran out of time")
        sock = connect(address, min(timeout, remaining) if isinstance(timeout, (int, float)) else remaining, source_address, **kwargs)
        # Connecting used some of the time; the response headers that come next get only what is left.
        sock.settimeout(max(0.001, deadline - time.monotonic()))
        return sock

    return create


def _public_only(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None, **kwargs):
    sock = socket.create_connection(address, timeout, source_address, **kwargs)
    peer = ipaddress.ip_address(sock.getpeername()[0])
    if isinstance(peer, ipaddress.IPv6Address) and peer.ipv4_mapped is not None:
        peer = peer.ipv4_mapped
    if not peer.is_global:
        sock.close()
        raise _NonPublicAddress(f"{address[0]} is not a public address")
    return sock


class _HTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, connect) -> None:
        super().__init__()
        self._connect = connect

    def http_open(self, request):
        return self.do_open(_connection_factory(http.client.HTTPConnection, self._connect), request)


class _HTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, connect, context: ssl.SSLContext) -> None:
        super().__init__(context=context)
        self._connect = connect
        self._ssl_context = context

    def https_open(self, request):
        return self.do_open(
            _connection_factory(http.client.HTTPSConnection, self._connect), request, context=self._ssl_context
        )


def _connection_factory(connection_class, connect):
    def make(host, **kwargs):
        connection = connection_class(host, **kwargs)
        # HTTPConnection.connect opens its socket through this attribute, before HTTPS wraps it in TLS, so the address
        # check sees the address actually connected to.
        connection._create_connection = connect
        return connection

    return make


_UNSUPPORTED_REDIRECT = "redirect to an unsupported url"


class _RedirectHandler(urllib.request.HTTPRedirectHandler):
    # urllib counts the URLs a chain has visited and refuses the next redirect once it reaches this, so 3 redirects
    # are followed and a fourth fails.
    max_redirections = MAX_REDIRECTS

    def redirect_request(self, request, fp, code, msg, headers, newurl):
        # urllib would also follow a redirect to ftp://.
        if urlsplit(newurl).scheme.lower() not in ("http", "https"):
            raise urllib.error.HTTPError(newurl, code, f"{_UNSUPPORTED_REDIRECT}: {msg}", headers, fp)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def _socket_of(response):
    # http.client keeps the socket behind the response's buffered reader; reaching it is the only way to shrink the
    # per-read timeout as the deadline nears. Without it each read is still bounded by the opener's 15 s.
    raw = getattr(getattr(response, "fp", None), "raw", None)
    sock = getattr(raw, "_sock", None)
    return sock if isinstance(sock, socket.socket) else None


def _describe(reason: object) -> str:
    if isinstance(reason, _NonPublicAddress):
        return f"refused to connect: {reason}"
    if isinstance(reason, (TimeoutError, socket.timeout)):
        return "timed out"
    if isinstance(reason, ssl.SSLError):
        return f"TLS failed ({reason.reason or reason})"
    if isinstance(reason, socket.gaierror):
        return "the host name did not resolve"
    if isinstance(reason, ConnectionRefusedError):
        return "the connection was refused"
    text = str(reason).strip() or type(reason).__name__
    return f"could not fetch ({text[:200]})"
