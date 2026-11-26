"""Account-scoped playback handoff. Stale devices cannot overwrite a newer owner's checkpoint."""
from __future__ import annotations

import asyncio
import random
from copy import deepcopy
from datetime import UTC, timedelta
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
    volume: float = Field(default=1, ge=0, le=1, allow_inf_nan=False)
    phase: Literal["resolving", "loading", "playing", "paused", "ended", "error"] | None = None
    error: str | None = Field(default=None, max_length=1024)
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
    volume: float = Field(default=1, ge=0, le=1, allow_inf_nan=False)


class Transfer(BaseModel):
    device_id: str = Field(min_length=8, max_length=64)
    revision: int = Field(ge=0)
    autoplay: bool | None = None


class Command(BaseModel):
    command_id: str = Field(min_length=8, max_length=64)
    revision: int = Field(ge=0)
    action: Literal["start", "play", "pause", "toggle", "next", "previous", "seek", "volume", "shuffle", "repeat",
                    "add_next", "append", "remove", "move", "play_index"]
    snapshot: Checkpoint | None = None
    tracks: list[PlaybackTrack] = Field(default_factory=list, max_length=5000)
    index: int | None = Field(default=None, ge=0)
    to_index: int | None = Field(default=None, ge=0)
    position: float | None = Field(default=None, ge=0, le=86400, allow_inf_nan=False)
    volume: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)
    shuffle: bool | None = None
    repeat: Literal["off", "all", "one"] | None = None


async def devices(s, uid):
    return list(await s.scalars(select(PlaybackDevice).join(Session, PlaybackDevice.session_id == Session.id).where(
        PlaybackDevice.user_id == uid, PlaybackDevice.seen_at > utcnow() - PRESENCE,
        Session.expires_at > utcnow(), Session.user_id == uid)))


async def output(s, row, response):
    response.headers["Cache-Control"] = "no-store"
    command = next((c for c in reversed(row.commands_json or []) if c["revision"] == row.revision), None)
    return {"revision": row.revision, "applied_revision": row.applied_revision,
            "snapshot_age_s": min(PRESENCE.total_seconds(), max(0, (utcnow() - row.updated_at).total_seconds())),
            "updated_at_ms": row.updated_at.replace(tzinfo=UTC).timestamp() * 1000,
            "action": command["action"] if command else "transfer", "device_id": row.device_id,
            "snapshot": row.snapshot_json, "pending": bool(row.snapshot_json and row.applied_revision < row.revision),
            "devices": [{"id": d.id, "name": d.name, "volume": d.volume} for d in await devices(s, row.user_id)]}


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
            s.add(PlaybackDevice(user_id=user.id, id=body.device_id, name=body.name, seen_at=now, volume=body.volume,
                                 session_id=hash_token(request.cookies[COOKIE])))
        else:
            device.name, device.seen_at, device.session_id = body.name, now, hash_token(request.cookies[COOKIE])
        row = await s.get(PlaybackState, user.id)
        if row is None:
            row = PlaybackState(user_id=user.id, revision=0, updated_at=now)
            s.add(row)
            await s.flush()
        if device and (row.device_id != body.device_id or body.revision == row.revision):
            device.volume = body.volume
        if body.claim:
            if not body.ready or body.snapshot is None or body.revision != row.revision:
                raise HTTPException(409, "Воспроизведение изменилось на другом устройстве. Повторите действие.")
            if row.device_id != body.device_id:
                row.revision += 1
            row.device_id = body.device_id
        if body.ready and body.snapshot and row.device_id == body.device_id and (body.claim or body.revision == row.revision):
            row.snapshot_json = body.snapshot.model_dump(mode="json")
            row.updated_at = now
            row.applied_revision = row.revision
        await s.commit()
        return await output(s, row, response)


@router.post("/transfer")
async def transfer(body: Transfer, response: Response, user: User = Depends(current_user),
                   s: AsyncSession = Depends(get_session, scope="function")):
    async with account_lock(user.id):
        row = await s.get(PlaybackState, user.id)
        if row is None:
            raise HTTPException(409, "Сначала откройте HomeMusic на устройстве")
        if row.revision != body.revision:
            raise HTTPException(409, "Воспроизведение уже перенесено. Обновите список устройств.")
        target = next((d for d in await devices(s, user.id) if d.id == body.device_id), None)
        if target is None:
            raise HTTPException(409, "Устройство недоступно. Откройте на нём HomeMusic и повторите.")
        if row.device_id == body.device_id:
            return await output(s, row, response)
        snapshot = deepcopy(row.snapshot_json)
        if snapshot and snapshot["autoplay"]:
            duration = snapshot["queue"][snapshot["index"]].get("duration_s") or 86400
            # Presence is bounded; a disconnected player cannot advance the saved clock indefinitely.
            elapsed = min(PRESENCE.total_seconds(), max(0, (utcnow() - row.updated_at).total_seconds()))
            snapshot["position"] = min(duration, snapshot["position"] + elapsed)
        if snapshot:
            if body.autoplay is not None:
                snapshot["autoplay"] = body.autoplay
            snapshot["volume"] = target.volume
            snapshot["phase"] = "loading" if snapshot["autoplay"] else "paused"
        row.snapshot_json = snapshot
        row.device_id, row.revision, row.updated_at = body.device_id, row.revision + 1, utcnow()
        await s.commit()
        return await output(s, row, response)


@router.post("/command")
async def command(body: Command, response: Response, user: User = Depends(current_user),
                  s: AsyncSession = Depends(get_session, scope="function")):
    async with account_lock(user.id):
        row = await s.get(PlaybackState, user.id)
        if row is None or row.device_id not in {d.id for d in await devices(s, user.id)}:
            raise HTTPException(409, "Устройство воспроизведения недоступно. Выберите другое в аудиовыходе.")
        if any(c["id"] == body.command_id for c in row.commands_json or []):
            return await output(s, row, response)
        if body.revision != row.revision:
            raise HTTPException(409, "Очередь изменилась. Повторите действие.")
        saved = deepcopy(row.snapshot_json)
        if body.action == "start":
            if body.snapshot is None:
                raise HTTPException(422, "Нужна очередь воспроизведения")
            volume = saved.get("volume", 1) if saved else (await s.get(PlaybackDevice, (user.id, row.device_id))).volume
            saved = body.snapshot.model_dump(mode="json")
            saved.update(volume=volume, autoplay=True, phase="resolving", error=None)
        elif saved is None:
            raise HTTPException(409, "Сначала выберите музыку")
        else:
            queue, index = saved["queue"], saved["index"]
            if saved["autoplay"]:
                saved["position"] = min(queue[index].get("duration_s") or 86400,
                    saved["position"] + min(PRESENCE.total_seconds(), max(0, (utcnow() - row.updated_at).total_seconds())))
            action = body.action
            if action in ("play", "pause", "toggle"):
                saved["autoplay"] = not saved["autoplay"] if action == "toggle" else action == "play"
                if saved.get("phase") == "ended" and saved["autoplay"]:
                    saved["position"] = 0
                saved["phase"] = "loading" if saved["autoplay"] else "paused"
                saved["error"] = None
            elif action in ("next", "previous", "play_index"):
                new_index = index
                if action == "next":
                    if index + 1 < len(queue):
                        new_index += 1
                    elif saved["repeat"] == "all" and not saved["context"].startswith("wave:"):
                        new_index = 0
                    else:
                        return await output(s, row, response)
                elif action == "previous":
                    if saved["position"] < 3:
                        new_index = max(0, index - 1)
                else:
                    if body.index is None or body.index >= len(queue):
                        raise HTTPException(422, "Трек отсутствует в очереди")
                    new_index = body.index
                saved.update(index=new_index, position=0, autoplay=True, phase="resolving", error=None)
            elif action == "seek":
                if body.position is None:
                    raise HTTPException(422, "Нужна позиция")
                saved["position"] = min(body.position, queue[index].get("duration_s") or 86400)
            elif action == "volume":
                if body.volume is None:
                    raise HTTPException(422, "Нужна громкость")
                saved["volume"] = body.volume
                (await s.get(PlaybackDevice, (user.id, row.device_id))).volume = body.volume
            elif action == "repeat":
                saved["repeat"] = body.repeat or {"off": "all", "all": "one", "one": "off"}[saved["repeat"]]
            elif action == "shuffle":
                if not saved["context"].startswith("wave:"):
                    on = body.shuffle if body.shuffle is not None else not saved["shuffle"]
                    if on and not saved["shuffle"]:
                        order = [index, *random.sample([i for i in range(len(queue)) if i != index], len(queue) - 1)]
                        saved["queue"] = [queue[i] for i in order]
                        saved["originalOrder"] = [order.index(i) for i in range(len(queue))]
                        saved["index"] = 0
                    elif not on and saved.get("originalOrder"):
                        order = saved["originalOrder"]
                        saved["queue"] = [queue[i] for i in order]
                        saved["index"] = order.index(index)
                        saved["originalOrder"] = None
                    saved["shuffle"], saved["smart"] = on, False
            elif action in ("add_next", "append"):
                if len(queue) + len(body.tracks) > 5000:
                    raise HTTPException(422, "В очереди может быть до 5000 треков")
                at = index + 1 if action == "add_next" else len(queue)
                queue[at:at] = [t.model_dump(mode="json") for t in body.tracks]
                saved["originalOrder"] = None
            elif action in ("remove", "move"):
                at = body.index
                if at is None or at >= len(queue):
                    raise HTTPException(422, "Трек отсутствует в очереди")
                if action == "remove":
                    if at == index:
                        raise HTTPException(409, "Текущий трек нельзя удалить")
                    queue.pop(at)
                    saved["index"] -= int(at < index)
                else:
                    if body.to_index is None or body.to_index >= len(queue):
                        raise HTTPException(422, "Неверное место в очереди")
                    current = queue[index]
                    queue.insert(body.to_index, queue.pop(at))
                    saved["index"] = next(i for i, track in enumerate(queue) if track is current)
                saved["originalOrder"] = None
        saved = Checkpoint.model_validate(saved).model_dump(mode="json")
        row.snapshot_json = saved
        row.revision += 1
        row.updated_at = utcnow()
        row.commands_json = [*(row.commands_json or [])[-63:], {"id": body.command_id, "action": body.action, "revision": row.revision}]
        await s.commit()
        return await output(s, row, response)
