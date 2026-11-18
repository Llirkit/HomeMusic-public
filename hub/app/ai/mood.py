"""Taste and sound-space operations exposed to the HomeMusic assistant.

Selection is server-side: the language model supplies intent and quotas, never song ids or its own arithmetic.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.downloads import create_batch
from app.api.schemas import DownloadIn
from app.catalog.models import CatalogTrack
from app.library.owned import annotate_tracks
from app.mixes import embedder
from app.mixes.build import library_items
from app.mixes.resolve import catalog_track
from app.mixes.taste import artist_key, build_profile
from app.mixes.taste_math import V2Profile
from app.mixes.taste_select import facet_names, prepare
from app.models import MoodMix, Track, User, utcnow

MAX_PER_ARTIST = 2
RESERVE_MIN = 5


def _row(t: Track, sim: float, score: float | None = None) -> dict[str, Any]:
    return {"song_id": t.nd_song_id, "artist": t.artist, "title": t.title,
            "similarity": round(sim, 4), "taste_score": round(score, 3) if score is not None else None}


def _diverse(rows, n: int, artist):
    counts: Counter[str] = Counter()
    out = []
    for row in rows:
        key = artist_key(artist(row))
        if counts[key] >= MAX_PER_ARTIST:
            continue
        counts[key] += 1
        out.append(row)
        if len(out) >= n:
            break
    return out


async def taste_profile(s: AsyncSession, user: User, *, limit: int = 12) -> dict[str, Any]:
    p = await build_profile(s, user, model="v2")
    assert isinstance(p, V2Profile)
    await prepare(p)
    tracks = sorted(p.tracks.values(), key=lambda t: (-t.score, t.key))
    found = facet_names(p) if p.geometry is not None else None
    return {
        "model": p.model,
        "maturity": round(p.maturity, 3),
        "counts": {"total": len(tracks), "positive": sum(t.score > 0 for t in tracks),
                   "strong": sum(t.score >= 1 for t in tracks), "negative": sum(t.score < 0 for t in tracks)},
        "facets": None if found is None else [{"weight": round(f["weight"], 3), "artists": f["artists"],
                                                "tracks": len(f["members"])} for f in found],
        "top_tracks": [{"key": t.key, "artist": t.artist, "title": t.title, "score": round(t.score, 3)}
                       for t in tracks[:min(max(limit, 1), 30)]],
        "limitations": list(p.limitations),
        "sound": "available" if p.geometry is not None else "unavailable",
    }


async def taste_tracks(s: AsyncSession, user: User, *, flt: str = "all", query: str | None = None,
                       sort: str = "s", limit: int = 30) -> dict[str, Any]:
    from app.insights import taste_view

    out = await taste_view.tracks(s, user, model="v2", flt=flt, q=query, sort=sort,
                                  limit=min(max(limit, 1), 50), offset=0, now=utcnow())
    fields = ("key", "artist", "title", "owned", "s", "p", "n", "plays", "early_skips", "last_heard",
              "liked", "disliked", "downloaded", "facet_id")
    return {"total": out["total"], "rows": [{k: row.get(k) for k in fields} for row in out["rows"]]}


async def taste_track_history(s: AsyncSession, user: User, key: str) -> dict[str, Any]:
    from app.insights import taste_view

    out = await taste_view.track(s, user, key=key, model="v2", now=utcnow())
    if out is None:
        raise ValueError("track is not in the taste profile")
    return {k: out.get(k) for k in (
        "key", "artist", "title", "s", "p", "n", "plays", "early_skips", "starts", "finishes", "late_skips",
        "liked", "disliked", "downloaded", "formula", "facet_id", "facet_cos", "last_heard",
    )} | {"contributions": out.get("contributions", [])[:30], "artist": out.get("artist")}


async def library_by_sound(s: AsyncSession, user: User, query: str, *, limit: int) -> list[dict[str, Any]]:
    tracks = list((await s.execute(select(Track).where(Track.nd_song_id.is_not(None)))).scalars())
    if not tracks:
        return []
    # This queues only missing/changed files; already indexed files are cheap no-ops.
    async with embedder.EmbedderClient() as client:
        await client.embed(await library_items())
        matches = await client.text(query, limit=min(max(limit * 4, limit), 500),
                                    keys=[embedder.song_key(t.nd_song_id) for t in tracks if t.nd_song_id])
    by_key = {embedder.song_key(t.nd_song_id): t for t in tracks if t.nd_song_id}
    p = await build_profile(s, user, model="v2")
    ranked = []
    for match in matches:
        t = by_key.get(match.key)
        known = p.find(nd_song_id=t.nd_song_id) if t else None
        if t is None or p.disliked(ref=None, nd_song_id=t.nd_song_id, artist=t.artist, artist_ref=None):
            continue
        ranked.append((t, match.sim, known.score if known else None))
    return [_row(t, sim, score) for t, sim, score in _diverse(ranked, limit, lambda x: x[0].artist)]


async def _catalog_by_sound(s: AsyncSession, user: User, query: str, *, limit: int) -> list[CatalogTrack]:
    # Catalog vectors are previews encountered by mixes and waves. Ask generously, then remove owned/disliked rows.
    async with embedder.EmbedderClient() as client:
        matches = await client.text(query, limit=min(max(limit * 10, 100), 500), prefix="dz:")
    sem = asyncio.Semaphore(8)

    async def one(key: str):
        async with sem:
            return await catalog_track(key)

    tracks = [t for t in await asyncio.gather(*(one(m.key) for m in matches)) if t is not None]
    owned = await annotate_tracks(s, tracks, user.id)
    p = await build_profile(s, user, model="v2")
    fresh = [t for t, state in zip(tracks, owned, strict=True)
             if not state.owned and not p.disliked(ref=t.ref, nd_song_id=None, artist=t.artist,
                                                   artist_ref=t.artist_ref)]
    return _diverse(fresh, limit, lambda t: t.artist)


async def create_mood_mix(s: AsyncSession, user: User, *, name: str, query: str, total: int = 50,
                          library_percent: int = 50) -> dict[str, Any]:
    total = min(max(total, 2), 100)
    library_percent = min(max(library_percent, 0), 100)
    own_n = round(total * library_percent / 100)
    new_n = total - own_n
    reserve_n = max(RESERVE_MIN, (new_n + 2) // 3) if new_n else 0
    own = await library_by_sound(s, user, query, limit=own_n)
    fresh = await _catalog_by_sound(s, user, query, limit=new_n + reserve_n) if new_n else []
    if len(own) < own_n:
        raise ValueError(f"По звучанию «{query}» проиндексировано только {len(own)} из {own_n} нужных треков библиотеки")
    if len(fresh) < new_n:
        raise ValueError(f"По звучанию «{query}» найдено только {len(fresh)} из {new_n} нужных новых треков")

    nd = __import__("app.auth", fromlist=["user_navidrome"]).user_navidrome(user)
    playlist_id = None
    try:
        playlist = await nd.create_playlist(name.strip(), [x["song_id"] for x in own])
        playlist_id = playlist.get("id")
        if not playlist_id:
            raise RuntimeError("Navidrome не создал плейлист")
        chosen, reserve = fresh[:new_n], fresh[new_n:]
        out = await create_batch(s, user, DownloadIn(track_refs=[t.ref for t in chosen],
                                                      playlist_id=playlist_id),
                                 origin="assistant", title=name.strip())
        s.add(MoodMix(user_id=user.id, batch_id=out.batch_id, nd_playlist_id=playlist_id, name=name.strip(),
                      query=query, library_count=own_n, new_count=new_n,
                      reserve_json=[t.model_dump(mode="json") for t in reserve]))
        await s.flush()
    except Exception:
        if playlist_id:
            try:
                await nd.delete_playlist(playlist_id)
            except Exception:
                pass
        raise
    finally:
        await nd.aclose()
    return {"playlist_id": playlist_id, "name": name.strip(), "query": query, "total": total,
            "library": own_n, "new": new_n, "new_queued": len(chosen), "reserve": len(reserve),
            "library_tracks": own}
