"""The fetcher's bounds: which URLs it takes, and how it fails on redirects, size, time and non-public addresses."""

from __future__ import annotations

import time

import pytest

from tests.conftest import PNG_BYTES
from vision.fetch import FetchError, Fetcher, normalise_url


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://example.com/logo.png", "https://example.com/logo.png"),
        ("  HTTP://Example.com/a.png ", "HTTP://Example.com/a.png"),
        ("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/logo.png", "https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/logo.png"),
        ("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", "https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"),
        ("ipfs://ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/a.png", "https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/a.png"),
    ],
)
def test_accepted_urls(url, expected):
    assert normalise_url(url) == expected


@pytest.mark.parametrize(
    ("url", "message"),
    [
        ("file:///etc/passwd", "'file' is not supported"),
        ("ftp://example.com/a.png", "'ftp' is not supported"),
        ("data:image/png;base64,iVBORw0KGgo=", "'data' is not supported"),
        ("ar://abc", "'ar' is not supported"),
        ("https:///no-host.png", "no host"),
        ("ipfs://", "no CID"),
        ("", "missing"),
        ("logo.png", "no scheme"),
    ],
)
def test_refused_urls(url, message):
    with pytest.raises(FetchError, match=message):
        normalise_url(url)


@pytest.fixture(scope="module")
def fetcher() -> Fetcher:
    return Fetcher(allow_private_networks=True)


def test_a_plain_fetch(fetcher, image_server):
    data, content_type = fetcher.fetch(f"{image_server}/logo.png")
    assert data == PNG_BYTES and content_type == "image/png"


def test_three_redirects_are_followed_and_a_fourth_is_not(fetcher, image_server):
    assert fetcher.fetch(f"{image_server}/redirect/3")[0] == PNG_BYTES
    with pytest.raises(FetchError, match="more than 3 redirects"):
        fetcher.fetch(f"{image_server}/redirect/4")


def test_a_redirect_to_a_file_url_is_refused(fetcher, image_server):
    with pytest.raises(FetchError, match="unsupported url"):
        fetcher.fetch(f"{image_server}/redirect-file")


def test_a_body_over_5_mb_is_refused_by_its_length_and_while_streaming(fetcher, image_server):
    with pytest.raises(FetchError, match="larger than 5 MB"):
        fetcher.fetch(f"{image_server}/big-declared")
    with pytest.raises(FetchError, match="larger than 5 MB"):
        fetcher.fetch(f"{image_server}/big-streamed")


def test_a_slow_body_times_out_at_the_deadline(image_server):
    started = time.monotonic()
    with pytest.raises(FetchError, match="timed out"):
        Fetcher(allow_private_networks=True, timeout=1.0).fetch(f"{image_server}/slow")
    # The deadline covers the whole body, not each read: the server would take over 30 s to send it all.
    assert time.monotonic() - started < 3


def test_slow_headers_time_out_at_the_deadline(image_server):
    started = time.monotonic()
    with pytest.raises(FetchError, match="timed out"):
        Fetcher(allow_private_networks=True, timeout=1.0).fetch(f"{image_server}/slow-headers")
    assert time.monotonic() - started < 2


def test_the_deadline_covers_a_whole_redirect_chain(image_server):
    # Three hops of 0.4 s each, every one well inside a 1 s timeout, overrun it together.
    fetcher = Fetcher(allow_private_networks=True, timeout=1.0)
    started = time.monotonic()
    with pytest.raises(FetchError, match="timed out"):
        fetcher.fetch(f"{image_server}/slow-redirect/3")
    assert time.monotonic() - started < 2
    assert Fetcher(allow_private_networks=True, timeout=3.0).fetch(f"{image_server}/slow-redirect/3")[0] == PNG_BYTES


def test_an_http_error_is_reported_by_its_status(fetcher, image_server):
    with pytest.raises(FetchError, match="^HTTP 404$"):
        fetcher.fetch(f"{image_server}/missing.png")


def test_a_closed_port_is_reported(fetcher):
    with pytest.raises(FetchError, match="refused"):
        fetcher.fetch("http://127.0.0.1:1/logo.png")


def test_non_public_addresses_are_refused_by_default(image_server):
    with pytest.raises(FetchError, match="refused to connect: 127.0.0.1 is not a public address"):
        Fetcher().fetch(f"{image_server}/logo.png")
    with pytest.raises(FetchError, match="not a public address"):
        Fetcher().fetch(image_server.replace("127.0.0.1", "localhost") + "/logo.png")


def test_an_ipfs_image_a_gateway_refuses_is_asked_of_the_next(image_server):
    fetcher = Fetcher(allow_private_networks=True, ipfs_fallbacks=(f"{image_server}/serving-gateway/ipfs/",))
    data, content_type = fetcher.fetch(f"{image_server}/denying-gateway/ipfs/bafkreigh2akiscaildc/logo.png?x=1")
    assert data == PNG_BYTES and content_type == "image/png"


def test_the_first_error_is_reported_when_no_gateway_serves_it(image_server):
    fetcher = Fetcher(allow_private_networks=True, ipfs_fallbacks=(f"{image_server}/denying-gateway/ipfs/",))
    with pytest.raises(FetchError, match="HTTP 404"):
        fetcher.fetch(f"{image_server}/missing/ipfs/bafkreigh2akiscaildc")


def test_a_url_outside_ipfs_is_not_asked_elsewhere(image_server):
    fetcher = Fetcher(allow_private_networks=True, ipfs_fallbacks=(f"{image_server}/serving-gateway/ipfs/",))
    # A 404 outside /ipfs/: had it been asked of the serving gateway, it would have come back as the logo.
    with pytest.raises(FetchError, match="HTTP 404"):
        fetcher.fetch(f"{image_server}/denying-gateway/logo.png")
