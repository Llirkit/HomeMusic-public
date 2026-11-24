"""Music research beyond Deezer, and track lists actually published on artist websites."""

from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import urlencode, urljoin, urlsplit

import httpx
from selectolax.lexbor import LexborHTMLParser

from app.net import RateLimiter
from app.public_web import public_read

_mb_rate = RateLimiter(1)


async def search_sources(query: str, kind: str = "album") -> list[dict]:
    if not query.strip() or len(query) > 300 or kind not in ("album", "artist"):
        raise ValueError("Укажите название альбома или исполнителя")
    if kind == "artist":
        params = urlencode({"query": query, "fmt": "json", "limit": 1})
        await _mb_rate.wait()
        data = json.loads(await public_read("https://musicbrainz.org/ws/2/artist/?" + params))
        artists = []
        for artist in data.get("artists", [])[:1]:
            # Relations give the real official homepage, rather than a guessed domain.
            await _mb_rate.wait()
            warning = None
            try:
                details = json.loads(await public_read(
                    f"https://musicbrainz.org/ws/2/artist/{artist['id']}?inc=url-rels&fmt=json"))
            except httpx.HTTPError:
                details = {}
                warning = "Источник временно не вернул ссылки; можно прочитать известный официальный сайт напрямую"
            artists.append({"artist": artist["name"], "source_url": f"https://musicbrainz.org/artist/{artist['id']}",
                            "warning": warning,
                            "official_sites": [r["url"]["resource"] for r in details.get("relations", [])
                                               if r.get("type") == "official homepage" and r.get("url")]})
        return artists
    params = urlencode({"term": query, "entity": "album", "media": "music", "country": "us", "limit": 20})
    data = json.loads(await public_read("https://itunes.apple.com/search?" + params))
    return [{"title": a["collectionName"], "artist": a["artistName"], "tracks": a.get("trackCount"),
             "source_url": a["collectionViewUrl"]} for a in data.get("results", [])
            if a.get("collectionName") and a.get("artistName") and a.get("collectionViewUrl")]


def parse_page(html: bytes, url: str) -> dict:
    doc = LexborHTMLParser(html)
    title_node = doc.css_first('meta[property="og:title"]')
    title = title_node.attributes.get("content", "") if title_node else ""
    if not title:
        node = doc.css_first("title")
        title = node.text() if node else url
    album = title.split("|")[0].strip()
    tracks, seen = [], set()
    # Squarespace's album player exposes exact names, artists, durations and complete audio URLs.
    # Ordinary <audio> / downloadable audio anchors use the same path below.
    for anchor in doc.css('a[href], audio[src], audio source[src]'):
        audio_url = urljoin(url, anchor.attributes.get("href") or anchor.attributes.get("src", ""))
        if not re.search(r"\.(?:mp3|flac|m4a|ogg|wav)$", urlsplit(audio_url).path, re.I) or audio_url in seen:
            continue
        parent = anchor
        while parent.parent and not parent.attributes.get("data-title") and parent.tag not in ("li", "body"):
            parent = parent.parent
        artist = parent.attributes.get("data-artist", "")
        name = parent.attributes.get("data-title") or anchor.attributes.get("title") or anchor.text().strip()
        if not artist or not name:
            continue  # never invent the artist or the title from a file name
        duration_node = parent.css_first(".track-time")
        duration = None
        if duration_node and re.fullmatch(r"\d+:\d{2}", duration_node.text().strip()):
            minutes, seconds = map(int, duration_node.text().strip().split(":"))
            duration = minutes * 60 + seconds
        tracks.append({"number": len(tracks) + 1, "artist": artist, "title": name,
                       "duration_s": duration, "audio_url": audio_url})
        seen.add(audio_url)
        if len(tracks) >= 100:
            break
    for node in doc.css("script, style, nav, footer"):
        node.decompose()
    links = [{"title": a.text().strip()[:150], "url": urljoin(url, a.attributes["href"])}
             for a in doc.css("a[href]") if a.text().strip()
             and urljoin(url, a.attributes["href"]).startswith("https://")]
    return {"release_ref": "web:" + hashlib.sha256(html + url.encode()).hexdigest()[:24],
            "title": album, "source_url": url, "tracks": tracks,
            "links": list({a["url"]: a for a in links}.values())[:60], "text": doc.text(separator=" ")[:14000]}


async def read_page(url: str) -> dict:
    return parse_page(await public_read(url), url)
