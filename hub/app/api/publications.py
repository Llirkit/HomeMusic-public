"""Authenticated collection snapshots and public, synchronized radio listening."""
from __future__ import annotations

import asyncio
import logging
import secrets
from typing import Literal
from urllib.parse import quote
from weakref import WeakValueDictionary

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.medialib import nd_call, songs_out
from app.api.mixes import mix_out
from app.api.schemas import TrackOut
from app.api.wave import wave_out
from app.auth import current_user
from app.config import get_settings
from app.db import get_session, session_scope
from app.mixes import wave
from app.mixes.resolve import catalog_track
from app.models import Mix, Publication, User, WaveSession, utcnow


def no_cache(response: Response):
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(prefix="/api/publications", tags=["sharing"], dependencies=[Depends(no_cache)])
# The Hub runs a single worker; broadcasts persist their clock and queue in SQLite.
_lock = asyncio.Lock()
_station_locks: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()
log = logging.getLogger(__name__)


def station_lock(token: str):
    lock = _station_locks.get(token)
    if lock is None:
        lock = asyncio.Lock()
        _station_locks[token] = lock
    return lock


class CreateIn(BaseModel):
    kind: Literal["share", "radio"] = "share"
    source_kind: Literal["track", "playlist", "mix", "wave"]
    source_id: str = Field(min_length=1, max_length=256)


def output(p: Publication, request: Request, user_id: int | None = None):
    origin = get_settings().public_hub_url or str(request.base_url).rstrip("/")
    return {"id": p.id, "title": p.title, "kind": p.kind, "source_kind": p.source_kind,
            "active": p.active, "owner": p.user_id == user_id,
            "url": f"{origin.rstrip('/')}/#/{'radio' if p.kind == 'radio' else 'shared'}/{p.id}"}


async def source(body: CreateIn, user: User, s: AsyncSession):
    if body.source_kind == "playlist":
        p = await nd_call(user, lambda nd: nd.get_playlist(body.source_id))
        if p.get("owner") not in (None, user.nd_username):
            raise HTTPException(403, "Можно делиться только своим плейлистом")
        return p.get("name") or "Плейлист", [t.model_dump(mode="json") for t in await songs_out(s, p.get("entry") or [])]
    if body.source_kind == "mix":
        if not body.source_id.isdecimal():
            raise HTTPException(404, "Микс не найден")
        mix = await s.get(Mix, int(body.source_id))
        if mix is None or mix.user_id != user.id:
            raise HTTPException(404, "Микс не найден")
        out = await mix_out(s, mix, user.id)
        return out.title, [t.model_dump(mode="json") for t in out.tracks]
    if body.source_kind == "track":
        if body.source_id.startswith("file:"):
            from app.listen import file_candidate

            candidate = await file_candidate(body.source_id)
            if candidate is None:
                raise HTTPException(404, "Файл больше недоступен. Найдите трек заново.")
            return candidate.title, [{"ref": body.source_id, "source": "file", "id": body.source_id[5:],
                "title": candidate.title, "artist": candidate.artist, "duration_s": candidate.duration_s,
                "owned": False, "downloading": False}]
        if body.source_id.startswith("nd:"):
            song = await nd_call(user, lambda nd: nd.get_song(body.source_id[3:]))
            tracks = await songs_out(s, [song])
            return tracks[0].title, [tracks[0].model_dump(mode="json")]
        try:
            track = await catalog_track(body.source_id)
        except ValueError:
            track = None
        if track is None:
            raise HTTPException(404, "Трек не найден")
        return track.title, [{**track.model_dump(mode="json"), "owned": False, "downloading": False}]
    raise HTTPException(400, "Волну можно опубликовать как радио")


@router.post("")
async def create(body: CreateIn, request: Request, user: User = Depends(current_user),
                 s: AsyncSession = Depends(get_session, scope="function")):
    async with _lock:
        if body.kind == "radio" and body.source_kind not in ("wave", "playlist", "mix"):
            raise HTTPException(400, "Создайте радио из волны, плейлиста или микса")
        previous = (await s.scalars(select(Publication).where(
            Publication.user_id == user.id, Publication.kind == body.kind, Publication.source_kind == body.source_kind,
            Publication.source_id == body.source_id, Publication.active.is_(True)))).all()
        if body.kind == "radio" and previous:
            return output(previous[0], request, user.id)
        if body.kind == "radio":
            count = await s.scalar(select(func.count()).select_from(Publication).where(
                Publication.user_id == user.id, Publication.kind == "radio", Publication.active.is_(True)))
            if count >= 3:
                raise HTTPException(409, "У вас уже три радиостанции. Остановите одну из них.")
        wave_id = None
        if body.source_kind == "wave":
            original = await s.get(WaveSession, body.source_id)
            if original is None or original.user_id != user.id:
                raise HTTPException(404, "Волна не найдена")
            seed, mode = original.seed_json, original.mode
            await s.commit()
            try:
                batch = await wave.start(user, seed, mode, origin="radio", client="hub")
            except wave.WaveError as e:
                raise HTTPException(e.status, str(e)) from e
            out = await wave_out(s, batch, user.id)
            title, tracks, wave_id = out.title, [t.model_dump(mode="json") for t in out.tracks], batch.session_id
        else:
            title, tracks = await source(body, user, s)
        if not tracks:
            raise HTTPException(409, "Здесь пока нет треков")
        tracks = [TrackOut.model_validate(t).model_dump(mode="json") for t in tracks]
        if body.kind == "share":
            for old in previous:
                if old.tracks_json == tracks:
                    return output(old, request, user.id)
        if body.kind == "radio" and any(not t.get("duration_s") for t in tracks):
            raise HTTPException(409, "Для эфира нужна длительность каждого трека. Обновите источник и попробуйте снова.")
        row = Publication(id=secrets.token_urlsafe(24), user_id=user.id, kind=body.kind,
                          source_kind=body.source_kind, source_id=body.source_id, title=title,
                          tracks_json=tracks, wave_id=wave_id)
        s.add(row)
        await s.flush()
        await s.commit()
        return output(row, request, user.id)


@router.get("")
async def own(request: Request, user: User = Depends(current_user),
              s: AsyncSession = Depends(get_session, scope="function")):
    rows = (await s.scalars(select(Publication).where(Publication.user_id == user.id,
                       Publication.active.is_(True)).order_by(Publication.created_at.desc()))).all()
    return [output(p, request, user.id) for p in rows]


async def find(s: AsyncSession, token: str, kind: str):
    p = await s.get(Publication, token)
    if p is None or not p.active or p.kind != kind or await s.get(User, p.user_id) is None:
        raise HTTPException(404, "Ссылка недоступна или отозвана")
    return p


@router.delete("/{token}")
async def revoke(token: str, user: User = Depends(current_user),
                 s: AsyncSession = Depends(get_session, scope="function")):
    p = await s.get(Publication, token)
    if p is None or p.user_id != user.id:
        raise HTTPException(404, "Ссылка не найдена")
    p.active = False
    return {"ok": True}


@router.get("/{token}")
async def shared(token: str, request: Request, user: User = Depends(current_user),
                 s: AsyncSession = Depends(get_session, scope="function")):
    p = await find(s, token, "share")
    return {**output(p, request, user.id), "tracks": p.tracks_json}


def on_air(p: Publication, now):
    durations = [max(1, t.get("duration_s") or 180) for t in p.tracks_json]
    elapsed = max(0, (now - p.started_at).total_seconds())
    total = sum(durations)
    # Playlists loop, waves replenish when their last track ends.
    offset = elapsed % total
    for i, duration in enumerate(durations):
        if offset < duration:
            return i, offset, elapsed >= total
        offset -= duration
    return 0, 0, elapsed >= total


async def advance_radio(p: Publication, s: AsyncSession):
    index, position, ended = on_air(p, utcnow())
    if ended and p.wave_id:
        owner = await s.get(User, p.user_id)
        sid = p.wave_id
        await s.commit()
        try:
            try:
                batch = await wave.radio_batch(owner, sid)
            except wave.WaveError as e:
                if e.status != 404:
                    raise
                original = await s.get(WaveSession, sid)
                if original is None:
                    raise
                seed, mode = original.seed_json, original.mode
                await s.commit()
                batch = await wave.start(owner, seed, mode, origin="radio", client="hub")
                p.wave_id = batch.session_id
            out = await wave_out(s, batch, owner.id)
            tracks = [TrackOut.model_validate(t.model_dump()).model_dump(mode="json") for t in out.tracks if t.duration_s]
            if not tracks:
                raise HTTPException(503, "Радио подбирает следующие песни. Подождите немного.")
            p.tracks_json = tracks
            p.started_at = utcnow()
            index, position = 0, 0
            await s.commit()
        except wave.WaveError as e:
            raise HTTPException(503, "Радио подбирает следующие песни. Попробуйте ещё раз.") from e
    return index, position


async def radio_loop():
    """Keep wave broadcasts advancing even with no listeners or suspended browser tabs."""
    limit = asyncio.Semaphore(3)

    async def advance(token):
        async with limit, station_lock(token), session_scope() as s:
            try:
                p = await find(s, token, "radio")
                await advance_radio(p, s)
            except HTTPException:
                pass  # transient empty sources retry on the next tick; revoked stations disappear
            except Exception:
                log.exception("radio %s: advance failed", token)

    while True:
        async with session_scope() as s:
            ids = list(await s.scalars(select(Publication.id).where(
                Publication.active.is_(True), Publication.kind == "radio", Publication.wave_id.is_not(None))))
        await asyncio.gather(*(advance(token) for token in ids))
        await asyncio.sleep(2)


@router.get("/{token}/radio")
async def radio(token: str, request: Request, s: AsyncSession = Depends(get_session, scope="function")):
    async with station_lock(token):
        p = await find(s, token, "radio")
        index, position = await advance_radio(p, s)
        track = p.tracks_json[index]
        return {**output(p, request), "track": track, "position_s": position,
                "duration_s": track.get("duration_s"), "server_time": utcnow().isoformat() + "Z",
                "stream_url": f"/api/publications/{token}/audio/{index}?v={quote(track['ref'], safe='')}"}


@router.get("/{token}/audio/{index}")
async def audio(token: str, index: int, request: Request, v: str,
                s: AsyncSession = Depends(get_session, scope="function")):
    from app.api.listen import media_response

    p = await find(s, token, "radio")
    current, _, _ = on_air(p, utcnow())
    if index != current:
        raise HTTPException(409, "В эфире уже следующая песня")
    t = p.tracks_json[index]
    if t["ref"] != v:
        raise HTTPException(409, "В эфире уже следующая песня")
    ref = f"nd:{t['nd_song_id']}" if t.get("nd_song_id") else t["ref"]
    owner = await s.get(User, p.user_id)
    await s.commit()
    # Only the station's current song, never an arbitrary ref. Public listening has no import side effects.
    return await media_response(ref, request, full=True, user=owner, record_listen=False)
