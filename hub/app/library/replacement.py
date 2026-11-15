"""Explicit audio replacement: keep the library identity, publish only a checked file, retain a backup."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import uuid
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas import SourcePickIn
from app.config import get_settings
from app.jobs.queue import PermanentError, enqueue
from app.library import tagger
from app.library.importer import library_abs, library_lock, tagdata_for
from app.models import Album, DownloadBatch, DownloadItem, Track, User, utcnow
from app.providers.base import Candidate, TrackQuery

ACTIVE = ("queued", "searching", "downloading", "tagging", "importing")


async def picked_candidate(body: SourcePickIn, query: TrackQuery) -> Candidate:
    from app import listen
    from app.api.downloads import candidate_from_url

    if bool(body.candidate_ref) == bool(body.url):
        raise HTTPException(400, "Выберите один найденный файл или укажите ссылку")
    if body.url:
        return await candidate_from_url(body.url, query)
    candidate = await listen.file_candidate(body.candidate_ref or "")
    if candidate is None:
        raise HTTPException(409, "Список вариантов устарел. Повторите поиск")
    return candidate


async def queue_replacement(s: AsyncSession, user: User, track: Track, candidate: Candidate,
                            expected=None, import_info: dict | None = None) -> DownloadItem:
    """Caller holds library_lock until commit; duplicate clicks join the active replacement."""
    if expected is not None and expected != track.acquired_at:
        raise HTTPException(409, "Источник трека уже изменён. Откройте выбор заново")
    if candidate.page_url == track.source_url:
        raise HTTPException(400, "Этот файл уже используется. Выберите другой вариант")
    if track.album_id is None or not library_abs(track.path).is_file():
        raise HTTPException(409, "Файл трека недоступен. Обновите библиотеку")
    active = (await s.execute(select(DownloadItem).where(
        DownloadItem.status.in_(ACTIVE),
        DownloadItem.query_json["replace_track"]["id"].as_integer() == track.id,
    ))).scalars().first()
    if active:
        if (active.user_id != user.id or (active.chosen_candidate_json or {}).get("page_url") != candidate.page_url
                or (import_info and active.query_json.get("import") != import_info)):
            raise HTTPException(409, "Аудио этого трека уже заменяется. Дождитесь завершения")
        return active
    batch = DownloadBatch(user_id=user.id, origin="replacement", title=f"Замена аудио: {track.title}")
    s.add(batch)
    await s.flush()
    query = TrackQuery(artist=track.artist, title=track.title, album=track.album,
                       duration_s=track.duration_s, isrc=track.isrc, explicit=track.explicit)
    data = {"query": query.model_dump(), "meta": {"album": track.album}, "requested": True,
            "replace_track": {"id": track.id, "uid": track.uid, "revision": track.acquired_at.isoformat()}}
    if import_info:
        data["import"] = import_info
    item = DownloadItem(batch_id=batch.id, user_id=user.id, query_json=data, force=True,
                        chosen_candidate_json=candidate.model_dump(mode="json"))
    s.add(item)
    await s.flush()
    await enqueue(s, "download_item", {"item_id": item.id})
    return item


async def replace_downloaded(s: AsyncSession, item: DownloadItem, src: Path, spec) -> Track | None:
    """Commit DB and queue side effects while the filesystem rollback remains available."""
    from app.jobs.downloads import enqueue_scan

    target = item.query_json["replace_track"]
    async with library_lock:
        await s.refresh(item)
        if item.status == "cancelled":
            return None
        track = await s.get(Track, target["id"])
        if track is None or track.uid != target["uid"] or track.acquired_at.isoformat() != target["revision"]:
            raise PermanentError("Трек уже изменён или удалён. Откройте выбор источника заново")
        album = await s.get(Album, track.album_id)
        old = library_abs(track.path)
        destination = old.with_suffix(src.suffix.lower())
        backup_dir = get_settings().backups_dir / "source-replacements" / track.uid / str(item.id)
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup = backup_dir / old.name
        if backup.exists():
            # The DB revision is still the original one: a process died before commit. Roll its file move back.
            other = (await s.execute(select(Track.id).where(
                Track.path == str(Path(track.path).with_suffix(src.suffix.lower())).replace("\\", "/"),
                Track.id != track.id,
            ))).first()
            if other:
                raise PermanentError("Новый путь уже занят другим треком; требуется проверка резервной копии")
            os.replace(backup, old)
            if destination != old:
                destination.unlink(missing_ok=True)
        if album is None or not old.is_file():
            raise PermanentError("Исходный файл или альбом недоступен; замена не выполнена")
        if destination != old and destination.exists():
            raise PermanentError("Рядом уже есть файл в выбранном формате; замена не выполнена")
        temporary = old.with_name(f".replace-{uuid.uuid4().hex}{src.suffix.lower()}")
        old_path = track.path
        old_fields = {key: getattr(track, key) for key in (
            "path", "source", "source_url", "source_upload_date", "acquired_at", "duration_s", "bitrate_kbps", "codec", "warnings")}
        (backup_dir / "original.json").write_text(json.dumps(old_fields, default=str, ensure_ascii=False), encoding="utf-8")
        promoted = False
        try:
            cover = await asyncio.to_thread(tagger.read_cover, old)
            old_tags = await asyncio.to_thread(tagger.read_tags, old)
            track.source, track.source_url = spec.source, spec.source_url
            track.source_upload_date, track.acquired_at = spec.source_upload_date, utcnow()
            track.duration_s, track.bitrate_kbps, track.codec = spec.duration_s, spec.bitrate_kbps, spec.codec
            track.warnings = list(spec.warnings)
            await asyncio.to_thread(shutil.copy2, src, temporary)
            tags = tagdata_for(track, album, cover=cover, artists=old_tags.get("artists"), track_total=old_tags.get("track_total"))
            tags = tags.model_copy(update={"date": old_tags.get("date"), "disc_total": old_tags.get("disc_total")})
            await asyncio.to_thread(tagger.write_tags, temporary, tags)
            # Backup first; the old path remains playable until the new file is ready.
            await asyncio.to_thread(shutil.copy2, old, backup)
            with backup.open("rb") as stream:
                os.fsync(stream.fileno())
            with temporary.open("rb") as stream:
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
            promoted = True
            if destination != old:
                old.unlink()
            track.path = str(Path(old_path).with_suffix(src.suffix.lower())).replace("\\", "/")
            item.track_id, item.status, item.error, item.warnings = track.id, "importing", None, list(spec.warnings)
            item.progress = 1
            await enqueue_scan(s)
            if track.nd_song_id and get_settings().embedder_url:
                await enqueue(s, "refresh_replaced_audio", {"track_id": track.id})
            await s.commit()
        except BaseException:
            if promoted:
                if destination != old:
                    destination.unlink(missing_ok=True)
                os.replace(backup, old)
            else:
                backup.unlink(missing_ok=True)
            await s.rollback()
            raise
        finally:
            temporary.unlink(missing_ok=True)
        return track
