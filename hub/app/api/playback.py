"""Account-scoped playback handoff. Stale devices cannot overwrite a newer owner's checkpoint."""
from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Literal
from weakref import WeakValueDictionary

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import COOKIE, current_user
from app.db import get_session
from app.models import PlaybackDevice, PlaybackState, Session, User, utcnow
from app.security import hash_token

router = APIRouter(prefix="/api/playback", tags=["playback"])
locks: WeakValueDictionary[int, asyncio.Lock] = WeakValueDictionary()
PRESENCE = timedelta(seconds=15)


def account_lock(uid):
    lock = locks.get(uid)
    if lock is None:
        lock = asyncio.Lock()
        locks[uid] = lock
    return lock


class PlaybackTrack(BaseModel):
    ref: str = Field(min_length=1, max_length=2048)
    title: str = Field(max_length=1024)
    artist: str = Field(max_length=1024)
    nd_song_id: str | None = None
    cover_url: str | None = None
    cover_small_url: str | None = None
    album_ref: str | None = None
    artist_ref: str | None = None
    album: str | None = None
    isrc: str | None = None
    year: int | None = None
    duration_s: float | None = Field(default=None, ge=0, le=86400, allow_inf_nan=False)
    artists: list[dict[str, str | None]] | None = None
    rec: dict[str, str] | None = None


class Checkpoint(BaseModel):
    version: Literal[1] = 1
    queue: list[PlaybackTrack] = Field(min_length=1, max_length=5000)
    index: int = Field(ge=0)
    context: str = Field(max_length=512)
    position: float = Field(ge=0, le=86400, allow_inf_nan=False)
    autoplay: bool
    shuffle: bool = False
    smart: bool = False
    repeat: Literal["off", "all", "one"] = "off"
    originalOrder: list[int] | None = None
    launch: dict[str, str | None] | None = None

    @model_validator(mode="after")
    def valid_index(self):
        if self.index >= len(self.queue):
            raise ValueError("Текущий трек отсутствует в очереди")
        if self.originalOrder and any(i < 0 or i >= len(self.queue) for i in self.originalOrder):
            raise ValueError("Некорректный порядок очереди")
        duration = self.queue[self.index].duration_s
        if duration and self.position > duration:
            self.position = duration
        return self


class Heartbeat(BaseModel):
    account_id: int | None = None
    device_id: str = Field(min_length=8, max_length=64, pattern=r"^[\w-]+$")
    name: str = Field(min_length=1, max_length=120)
    revision: int = Field(default=0, ge=0)
    snapshot: Checkpoint | None = None
    claim: bool = False
    ready: bool = True


class Transfer(BaseModel):
    device_id: str = Field(min_length=8, max_length=64)
    revision: int = Field(ge=0)
    autoplay: bool = True


async def devices(s, uid):
    return list(await s.scalars(select(PlaybackDevice).join(Session, PlaybackDevice.session_id == Session.id).where(
        PlaybackDevice.user_id == uid, PlaybackDevice.seen_at > utcnow() - PRESENCE,
        Session.expires_at > utcnow(), Session.user_id == uid)))


async def output(s, row, response):
    response.headers["Cache-Control"] = "no-store"
    return {"revision": row.revision, "device_id": row.device_id, "snapshot": row.snapshot_json,
            "devices": [{"id": d.id, "name": d.name} for d in await devices(s, row.user_id)]}


@router.post("/heartbeat")
async def heartbeat(body: Heartbeat, request: Request, response: Response, user: User = Depends(current_user),
                    s: AsyncSession = Depends(get_session, scope="function")):
    async with account_lock(user.id):
        if body.account_id is not None and body.account_id != user.id:
            raise HTTPException(403, "Аккаунт изменился. Откройте HomeMusic заново.")
        now = utcnow()
        await s.execute(delete(PlaybackDevice).where(PlaybackDevice.seen_at < now - timedelta(days=1)))
        device = await s.get(PlaybackDevice, (user.id, body.device_id))
        if not body.ready:
            if device:
                await s.delete(device)
        elif device is None:
            s.add(PlaybackDevice(user_id=user.id, id=body.device_id, name=body.name, seen_at=now,
                                 session_id=hash_token(request.cookies[COOKIE])))
        else:
            device.name, device.seen_at, device.session_id = body.name, now, hash_token(request.cookies[COOKIE])
        row = await s.get(PlaybackState, user.id)
        if row is None:
            row = PlaybackState(user_id=user.id, revision=0, updated_at=now)
            s.add(row)
            await s.flush()
        if body.claim:
            if not body.ready or body.snapshot is None or body.revision != row.revision:
                raise HTTPException(409, "Воспроизведение изменилось на другом устройстве. Повторите действие.")
            if row.device_id != body.device_id:
                row.revision += 1
            row.device_id = body.device_id
        if body.ready and body.snapshot and row.device_id == body.device_id and (body.claim or body.revision == row.revision):
            row.snapshot_json = body.snapshot.model_dump(mode="json")
            row.updated_at = now
        await s.commit()
        return await output(s, row, response)


@router.post("/transfer")
async def transfer(body: Transfer, response: Response, user: User = Depends(current_user),
                   s: AsyncSession = Depends(get_session, scope="function")):
    async with account_lock(user.id):
        row = await s.get(PlaybackState, user.id)
        if row is None or not row.snapshot_json:
            raise HTTPException(409, "Сначала включите музыку")
        if row.revision != body.revision:
            raise HTTPException(409, "Воспроизведение уже перенесено. Обновите список устройств.")
        if body.device_id not in {d.id for d in await devices(s, user.id)}:
            raise HTTPException(409, "Устройство недоступно. Откройте на нём HomeMusic и повторите.")
        snapshot = dict(row.snapshot_json)
        if snapshot["autoplay"]:
            duration = snapshot["queue"][snapshot["index"]].get("duration_s") or 86400
            # Presence is bounded; a disconnected player cannot advance the saved clock indefinitely.
            elapsed = min(PRESENCE.total_seconds(), max(0, (utcnow() - row.updated_at).total_seconds()))
            snapshot["position"] = min(duration, snapshot["position"] + elapsed)
        snapshot["autoplay"] = body.autoplay
        row.snapshot_json = snapshot
        row.device_id, row.revision, row.updated_at = body.device_id, row.revision + 1, utcnow()
        await s.commit()
        return await output(s, row, response)
