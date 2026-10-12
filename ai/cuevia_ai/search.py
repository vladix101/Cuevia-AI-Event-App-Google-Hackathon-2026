"""Raw Brave Web Search retrieval + URL safety.

* Only the selected term is sent to Brave - never CV text, background or identity.
* Uses the raw Web Search endpoint (``/res/v1/web/search``), not Brave AI answers/summarizer.
* Pages are NOT fetched: explanations are grounded in Brave's titles/snippets, so there is no
  server-side page retrieval and therefore no redirect/SSRF surface. URLs are still validated
  (public http(s) only) before being shown to users.
"""

from __future__ import annotations

import html
import ipaddress
import logging
import re
import time
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlsplit

import httpx

from .net import async_client

log = logging.getLogger("cuevia_ai.search")

BRAVE_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"
MAX_RESULTS = 5

_BLOCKED_HOST_SUFFIXES = (".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".intranet", ".arpa")
_OFFICIAL_HINTS = re.compile(r"^(docs|developer|developers|learn|dev|spec|specs|standards)\.|\.(org|gov|edu)$")
_DOC_PATH_HINTS = re.compile(r"/(docs?|documentation|reference|manual|spec|guide)s?(/|$)", re.IGNORECASE)
_TAGS = re.compile(r"<[^>]{0,200}>")


@dataclass
class SearchHit:
    title: str
    url: str
    snippet: str


def clean_text(text: str, limit: int = 500) -> str:
    """Strip markup and control characters from untrusted text; output is plain text."""
    text = html.unescape(_TAGS.sub("", text or ""))
    text = "".join(ch for ch in text if ch == "\n" or ch.isprintable())
    return re.sub(r"\s+", " ", text).strip()[:limit]


def is_safe_public_url(url: str) -> bool:
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return False
    if parts.username or parts.password:
        return False
    try:
        if parts.port not in (None, 80, 443):
            return False
    except ValueError:
        return False
    host = parts.hostname.lower().rstrip(".")
    if host == "localhost" or host.endswith(_BLOCKED_HOST_SUFFIXES) or "." not in host:
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        # Reject numeric-looking hosts that are not dotted quads (e.g. "2130706433", "0x7f.1").
        return not re.fullmatch(r"[0-9x.]+", host)
    return ip.is_global and not (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
                                 or ip.is_multicast or ip.is_unspecified)


def _official_rank(url: str) -> int:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    score = 0
    if _OFFICIAL_HINTS.search(host):
        score += 2
    if _DOC_PATH_HINTS.search(parts.path or ""):
        score += 1
    return score


class BraveSearch:
    def __init__(self, api_key: str, timeout: float = 8.0, http: Optional[httpx.AsyncClient] = None):
        self.api_key = api_key
        self.timeout = timeout
        self._http = http

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = async_client(self.timeout)
        return self._http

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()

    async def search(self, term: str) -> list[SearchHit]:
        """Return up to MAX_RESULTS safe hits, preferring official documentation. [] on failure."""
        if not self.enabled:
            return []
        query = clean_text(term, 200)
        started = time.perf_counter()
        status = "ok"
        try:
            r = await self._client().get(
                BRAVE_WEB_SEARCH_URL,
                params={"q": query, "count": 10, "safesearch": "strict", "text_decorations": "false"},
                headers={"Accept": "application/json", "X-Subscription-Token": self.api_key},
            )
            if r.status_code != 200:
                status = f"HTTP_{r.status_code}"
                return []
            results = ((r.json().get("web") or {}).get("results")) or []
        except (httpx.HTTPError, ValueError) as exc:
            status = type(exc).__name__
            return []
        finally:
            log.info("brave_search status=%s latency_ms=%d", status, int((time.perf_counter() - started) * 1000))

        hits: list[SearchHit] = []
        seen: set[str] = set()
        for item in results:
            url = str(item.get("url") or "").strip()
            if not is_safe_public_url(url) or url in seen:
                continue
            seen.add(url)
            hits.append(SearchHit(
                title=clean_text(item.get("title") or url, 200),
                url=url,
                snippet=clean_text(" ".join([item.get("description") or ""] + list(item.get("extra_snippets") or [])[:2]), 600),
            ))
        # Stable sort keeps Brave's relevance order within the same "officialness" tier.
        hits.sort(key=lambda h: -_official_rank(h.url))
        return hits[:MAX_RESULTS]
