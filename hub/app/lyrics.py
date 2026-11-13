"""Тексты LRCLIB и бесплатный резерв Genius; общий TTL-кеш без изменения аудиофайлов."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
import unicodedata
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Literal
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, Field
from rapidfuzz.fuzz import ratio
from selectolax.lexbor import LexborHTMLParser
from sqlalchemy import select

from app.catalog.cache import cache_get, cache_set
from app.catalog.deezer import CatalogNotFound
from app.config import get_settings
from app.db import session_scope
from app.models import Track
from app.net import make_client
from app.services import svc

log = logging.getLogger(__name__)
STAMP = re.compile(r"\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]")
OFFSET = re.compile(r"\[offset:\s*([+-]?\d+)\]", re.I)
MAX_TEXT = 100_000


class LyricLine(BaseModel):
    start_ms: int
    text: str


class LyricsOut(BaseModel):
    ref: str = ""
    status: Literal["found", "not_found", "instrumental", "temporarily_unavailable"] = "not_found"
    plain: str = ""
    lines: list[LyricLine] = Field(default_factory=list)
    synced: bool = False
    duration_s: float | None = None
    source: str | None = None
    source_url: str | None = None


@dataclass
class Metadata:
    artist: str
    title: str
    album: str = ""
    duration_s: float | None = None


def parse_lrc(value: str) -> list[LyricLine]:
    """LRC: повторные метки, дробные секунды и положительный offset (раньше)."""
    offset = int(m.group(1)) if (m := OFFSET.search(value)) else 0
    lines = []
    for row in value[:MAX_TEXT].splitlines():
        stamps = list(STAMP.finditer(row))
        if not stamps:
            continue
        text = STAMP.sub("", row).strip()
        for stamp in stamps:
            minutes, seconds, fraction = stamp.groups()
            at = (int(minutes) * 60 + int(seconds)) * 1000 + int((fraction or "").ljust(3, "0"))
            lines.append(LyricLine(start_ms=max(0, at - offset), text=text))
    # Empty timed lines delimit instrumental breaks and must be kept.
    return sorted(lines, key=lambda line: line.start_ms)[:3000]


def normalized(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold().replace("ё", "е")
    return " ".join(re.findall(r"\w+", value))


def matches(meta: Metadata, artist: str, title: str) -> bool:
    # Retain version markers: a live/remix recording must not get studio timing.
    return normalized(meta.title) == normalized(title) and ratio(normalized(meta.artist), normalized(artist)) >= 90


class UpstreamError(Exception):
    pass


@dataclass
class Runtime:
    client: httpx.AsyncClient
    locks: dict[str, asyncio.Lock] = field(default_factory=dict)
    next_at: dict[str, float] = field(default_factory=dict)
    cooldown: dict[str, float] = field(default_factory=dict)
    tasks: dict[str, asyncio.Task] = field(default_factory=dict)

    async def get(self, url: str, *, provider: str, **kwargs) -> httpx.Response:
        # Serialize per provider, including response bodies. Never sleep through a long Retry-After.
        async with self.locks.setdefault(provider, asyncio.Lock()):
            now = time.monotonic()
            if self.cooldown.get(provider, 0) > now:
                raise UpstreamError("provider cooling down")
            await asyncio.sleep(max(0, self.next_at.get(provider, 0) - now))
            self.next_at[provider] = time.monotonic() + 1.1
            async with self.client.stream("GET", url, **kwargs) as response:
                if response.status_code in (429, 503):
                    delay = 60.0
                    raw = response.headers.get("retry-after", "")
                    try:
                        delay = float(raw)
                    except ValueError:
                        try:
                            delay = (parsedate_to_datetime(raw) - datetime.now(UTC)).total_seconds()
                        except (ValueError, TypeError, OverflowError):
                            pass
                    self.cooldown[provider] = time.monotonic() + max(1, delay) + 1
                    raise UpstreamError("provider rate limited")
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 2_000_000:
                        raise UpstreamError("response too large")
                # aiter_bytes() already decompresses gzip/br; do not decode the reconstructed body twice.
                headers = dict(response.headers)
                headers.pop("content-encoding", None)
                headers.pop("content-length", None)
                result = httpx.Response(response.status_code, headers=headers, content=bytes(body))
                if result.status_code != 404 and not result.is_success:
                    raise UpstreamError(f"provider HTTP {result.status_code}")
                return result


_runtime: Runtime | None = None


def runtime() -> Runtime:
    global _runtime
    if _runtime is None:
        _runtime = Runtime(make_client(timeout=8, headers={
            "User-Agent": "HomeMusic/0.2 (https://github.com/justman-1/HomeMusic-public)",
        }))
    return _runtime


async def reset() -> None:
    global _runtime
    rt, _runtime = _runtime, None
    if rt:
        tasks = list(rt.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await rt.client.aclose()


async def metadata(ref: str, hint: Metadata) -> Metadata:
    source, _, ident = ref.partition(":")
    async with session_scope() as session:
        condition = Track.nd_song_id == ident if source == "nd" else Track.deezer_track_id == ident
        track = (await session.execute(select(Track).where(condition).limit(1))).scalar_one_or_none() if source in ("nd", "dz") else None
        if track:
            return Metadata(track.artist, track.title, track.album or "", track.duration_s)
    remembered = await cache_get(f"listen:{ref}")
    if remembered:
        query = remembered.get("query") or {}
        return Metadata(remembered["artist"], remembered["title"], query.get("album") or hint.album,
                        remembered.get("duration_s") or hint.duration_s)
    if source == "dz" and svc.deezer:
        track = await svc.deezer.get_track(ident)
        return Metadata(track.artist, track.title, track.album_title or "", track.duration_s)
    return hint


def lrclib_result(record: dict, meta: Metadata) -> LyricsOut | None:
    if not matches(meta, record.get("artistName", ""), record.get("trackName", "")):
        return None
    duration = record.get("duration")
    if not isinstance(duration, (int, float)) or duration <= 0:
        duration = None
    close = bool(duration and meta.duration_s and abs(duration - meta.duration_s) <= 3)
    if record.get("instrumental"):
        return LyricsOut(status="instrumental", source="LRCLIB", duration_s=duration) if close else None
    lrc = record.get("syncedLyrics")
    lines = parse_lrc(lrc) if isinstance(lrc, str) else []
    if duration and any(line.start_ms > (duration + 5) * 1000 for line in lines):
        close = False
    plain = record.get("plainLyrics")
    plain = plain[:MAX_TEXT] if isinstance(plain, str) and plain.strip() else "\n".join(line.text for line in lines)
    if not plain.strip():
        return None
    return LyricsOut(status="found", plain=plain, lines=lines if close else [], synced=bool(lines and close),
                     duration_s=duration, source="LRCLIB", source_url="https://lrclib.net")


async def from_lrclib(rt: Runtime, meta: Metadata) -> LyricsOut | None:
    params = {"artist_name": meta.artist, "track_name": meta.title}
    if meta.album:
        params["album_name"] = meta.album
    if meta.duration_s and 1 <= meta.duration_s <= 3600:
        params["duration"] = str(round(meta.duration_s))
    response = await rt.get("https://lrclib.net/api/get", provider="lrclib", params=params)
    if response.is_success:
        result = lrclib_result(response.json(), meta)
        if result:
            return result
    # Search can find the same recording on another release; prefer its matching timing.
    response = await rt.get("https://lrclib.net/api/search", provider="lrclib",
                            params={"artist_name": meta.artist, "track_name": meta.title})
    if response.status_code == 404:
        return None
    records = response.json()
    if not isinstance(records, list):
        raise UpstreamError("invalid lyrics search")
    results = [result for record in records[:20] if isinstance(record, dict) and (result := lrclib_result(record, meta))]
    results.sort(key=lambda r: (r.synced, -(abs((r.duration_s or 0) - (meta.duration_s or 0)))), reverse=True)
    return results[0] if results else None


def genius_text(html: str) -> str:
    tree = LexborHTMLParser(html)
    containers = tree.css('[data-lyrics-container="true"]')
    parts = []
    for node in containers:
        for excluded in node.css('[data-exclude-from-selection="true"], script, style'):
            excluded.decompose()
        for br in node.css("br"):
            br.replace_with("\n")
        parts.append(node.text().strip())
    return "\n\n".join(parts)[:MAX_TEXT]


async def from_genius(rt: Runtime, meta: Metadata) -> LyricsOut | None:
    token = get_settings().genius_access_token
    if not token:
        return None
    response = await rt.get("https://api.genius.com/search", provider="genius",
                            params={"q": f"{meta.artist} {meta.title}"},
                            headers={"Authorization": f"Bearer {token}"})
    if response.status_code == 404:
        return None
    for hit in response.json().get("response", {}).get("hits", [])[:10]:
        song = hit.get("result", {})
        if not matches(meta, song.get("primary_artist", {}).get("name", ""), song.get("title", "")):
            continue
        url = song.get("url", "")
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.netloc != "genius.com" or not parsed.path.endswith("-lyrics"):
            continue
        # No API token or cookies on page requests; disallow redirects to arbitrary sites.
        page = await rt.get(url, provider="genius", follow_redirects=False)
        if page.status_code == 404:
            continue
        plain = genius_text(page.text)
        if not plain.strip():
            raise UpstreamError("Genius lyrics markup unavailable")
        return LyricsOut(status="found", plain=plain, source="Genius", source_url=url)
    return None


async def _fetch(rt: Runtime, key: str, meta: Metadata) -> LyricsOut:
    failed = False
    for provider in (from_lrclib, from_genius):
        try:
            async with asyncio.timeout(12):
                result = await provider(rt, meta)
            if result:
                await cache_set(key, result.model_dump(), 30 * 86400)
                return result
        except (httpx.HTTPError, UpstreamError, ValueError, TypeError, KeyError, AttributeError, TimeoutError):
            # Do not log request URLs/exception representations: Genius uses a secret header.
            log.warning("lyrics source %s unavailable", provider.__name__)
            failed = True
    result = LyricsOut(status="temporarily_unavailable" if failed else "not_found")
    await cache_set(key, result.model_dump(), 30 if failed else 6 * 3600)
    return result


async def get_lyrics(ref: str, hint: Metadata) -> LyricsOut:
    try:
        meta = await metadata(ref, hint)
    except (httpx.HTTPError, CatalogNotFound, ValueError, RuntimeError, KeyError, AttributeError):
        meta = hint
    if not meta.title.strip() or not meta.artist.strip():
        return LyricsOut(ref=ref, status="temporarily_unavailable")
    signature = json.dumps([meta.artist, meta.title, meta.album, meta.duration_s,
                            bool(get_settings().genius_access_token)], ensure_ascii=False)
    key = "lyrics:v1:" + hashlib.sha256(signature.encode()).hexdigest()
    cached = await cache_get(key)
    if cached is not None:
        return LyricsOut.model_validate(cached).model_copy(update={"ref": ref})
    rt = runtime()
    if key not in rt.tasks:
        if len(rt.tasks) >= 64:
            return LyricsOut(ref=ref, status="temporarily_unavailable")
        task = asyncio.create_task(_fetch(rt, key, meta))
        rt.tasks[key] = task

        def done(t: asyncio.Task) -> None:
            rt.tasks.pop(key, None)
            if not t.cancelled():
                t.exception()

        task.add_done_callback(done)
    result = await asyncio.shield(rt.tasks[key])
    return result.model_copy(update={"ref": ref})
