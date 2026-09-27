"""HTTP fetching with snapshotting.

Every successful fetch is written to data/raw/<source>/ (one file per URL, overwritten on each
refresh) and recorded in that directory's manifest.json, keyed by URL. The manifest entry is the
citation for anything extracted from the response. A failed fetch leaves the previous snapshot and
manifest entry in place, so the last good copy is never lost.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

import httpx

from . import paths

log = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
EXTENSIONS = {
    "application/pdf": ".pdf",
    "application/json": ".json",
    "text/html": ".html",
    "text/plain": ".txt",
}


@dataclass
class Snapshot:
    """A fetched document and its citation metadata."""

    source: str
    url: str
    final_url: str
    retrieved_at: str
    sha256: str
    content_type: str
    path: str  # relative to repo root
    status: int

    @property
    def citation_id(self) -> str:
        return f"{self.source}:{self.sha256[:12]}"

    def read_bytes(self) -> bytes:
        return (paths.ROOT / self.path).read_bytes()

    def read_text(self) -> str:
        return self.read_bytes().decode("utf-8", errors="replace")


class FetchError(RuntimeError):
    pass


def _slug(url: str) -> str:
    p = urlparse(url)
    s = re.sub(r"[^A-Za-z0-9]+", "-", f"{p.netloc}{p.path}").strip("-")
    return s[-120:] or "index"


def _url_key(url: str) -> str:
    """Stable per-URL suffix, so truncated slugs or query strings never collide."""
    return hashlib.sha256(url.encode()).hexdigest()[:8]


# hosts that keep failing at the connection level are skipped for the rest of the run
DEAD_HOST_AFTER = 2


class Fetcher:
    """Polite HTTP client: honours robots.txt, rate-limits per host, retries, snapshots."""

    def __init__(self, source: str, *, delay: float = 1.5, respect_robots: bool = True):
        self.source = source
        self.delay = delay
        self.respect_robots = respect_robots
        self._last: dict[str, float] = {}
        self._robots: dict[str, RobotFileParser | None] = {}
        self._conn_failures: dict[str, int] = {}
        self.client = httpx.Client(
            headers={"User-Agent": USER_AGENT, "Accept-Language": "en-SG,en;q=0.9"},
            follow_redirects=True,
            timeout=30,
        )
        self.dir = paths.RAW / source
        self.dir.mkdir(parents=True, exist_ok=True)
        self.manifest_path = self.dir / "manifest.json"
        self.manifest: dict[str, dict] = (
            json.loads(self.manifest_path.read_text()) if self.manifest_path.exists() else {})

    # -- politeness -----------------------------------------------------------------------------

    def _allowed(self, url: str) -> bool:
        if not self.respect_robots:
            return True
        p = urlparse(url)
        host = f"{p.scheme}://{p.netloc}"
        if host not in self._robots:
            rp = RobotFileParser()
            try:
                r = self.client.get(f"{host}/robots.txt")
                rp.parse(r.text.splitlines() if r.status_code == 200 else [])
                self._robots[host] = rp
            except httpx.HTTPError:
                self._robots[host] = None
        rp = self._robots[host]
        return rp is None or rp.can_fetch(USER_AGENT, url)

    def _throttle(self, url: str) -> None:
        host = urlparse(url).netloc
        wait = self._last.get(host, 0) + self.delay - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self._last[host] = time.monotonic()

    # -- fetching -------------------------------------------------------------------------------

    def get(self, url: str, *, retries: int = 3, name: str | None = None) -> Snapshot:
        host = urlparse(url).netloc
        if self._conn_failures.get(host, 0) >= DEAD_HOST_AFTER:
            raise FetchError(f"skipping {url}: {host} unreachable earlier in this run")
        if not self._allowed(url):
            raise FetchError(f"robots.txt disallows {url}")
        last_exc: Exception | None = None
        for attempt in range(retries):
            self._throttle(url)
            try:
                r = self.client.get(url)
            except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError) as e:
                last_exc = e
                if attempt >= 1:  # connection-level failures rarely recover within seconds
                    break
            except httpx.HTTPError as e:
                last_exc = e
            else:
                self._conn_failures[host] = 0
                if r.status_code == 200 and not r.content:
                    last_exc = FetchError(f"empty response body for {url}")
                elif r.status_code == 200:
                    ctype = r.headers.get("content-type", "").split(";")[0].strip()
                    return self.save(url, str(r.url), r.content, ctype, r.status_code, name=name)
                if r.status_code in (403, 404, 410):
                    raise FetchError(f"HTTP {r.status_code} for {url}")
                last_exc = FetchError(f"HTTP {r.status_code} for {url}")
            time.sleep(2**attempt)
        if isinstance(last_exc, (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError)):
            self._conn_failures[host] = self._conn_failures.get(host, 0) + 1
        raise FetchError(f"giving up on {url}: {last_exc}")

    def get_json(self, url: str, **kw) -> tuple[Snapshot, object]:
        snap = self.get(url, **kw)
        return snap, json.loads(snap.read_bytes())

    def save(
        self,
        url: str,
        final_url: str,
        body: bytes,
        content_type: str,
        status: int = 200,
        *,
        name: str | None = None,
    ) -> Snapshot:
        digest = hashlib.sha256(body).hexdigest()
        ext = EXTENSIONS.get(content_type) or Path(urlparse(final_url).path).suffix or ".bin"
        fname = f"{name or _slug(final_url)}-{_url_key(url)}{ext}"
        fpath = self.dir / fname
        old = self.manifest.get(url)
        if old and old["path"] != str(fpath.relative_to(paths.ROOT)):
            (paths.ROOT / old["path"]).unlink(missing_ok=True)  # content type changed
        fpath.write_bytes(body)
        snap = Snapshot(
            source=self.source,
            url=url,
            final_url=final_url,
            retrieved_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            sha256=digest,
            content_type=content_type,
            path=str(fpath.relative_to(paths.ROOT)),
            status=status,
        )
        self.manifest[url] = asdict(snap)
        tmp = self.manifest_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.manifest, indent=1, sort_keys=True))
        tmp.replace(self.manifest_path)
        return snap

    def close(self) -> None:
        self.client.close()

    def __enter__(self) -> Fetcher:
        return self

    def __exit__(self, *exc) -> None:
        self.close()


class BrowserFetcher:
    """Headless Chromium for sites behind bot challenges (e.g. Cloudflare). Needs the `browser` extra
    and `playwright install chromium`."""

    def __init__(self, fetcher: Fetcher, *, challenge_timeout: int = 30):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as e:  # pragma: no cover
            raise FetchError(
                "playwright not installed: uv sync --extra browser && "
                "uv run playwright install chromium"
            ) from e
        self.fetcher = fetcher
        self.challenge_timeout = challenge_timeout
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(headless=True)
        self._page = self._browser.new_page(user_agent=USER_AGENT)

    def get(self, url: str, *, name: str | None = None) -> Snapshot:
        self.fetcher._throttle(url)
        resp = self._page.goto(url, wait_until="domcontentloaded")
        for _ in range(self.challenge_timeout):
            if "just a moment" not in self._page.title().lower():
                break
            self._page.wait_for_timeout(1000)
        else:
            raise FetchError(f"bot challenge not cleared for {url}")
        self._page.wait_for_load_state("load")
        html = self._page.content()
        status = resp.status if resp else 200
        return self.fetcher.save(
            url, self._page.url, html.encode(), "text/html", status, name=name
        )

    def close(self) -> None:
        self._browser.close()
        self._pw.stop()

    def __enter__(self) -> BrowserFetcher:
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def load_manifest(source: str) -> dict[str, Snapshot]:
    """Latest snapshot of every URL fetched for a source, keyed by URL."""
    path = paths.RAW / source / "manifest.json"
    if not path.exists():
        return {}
    return {url: Snapshot(**e) for url, e in json.loads(path.read_text()).items()}
