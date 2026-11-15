"""Real audio, isolated library and fake providers: replace bytes without replacing the song identity."""

from __future__ import annotations

import asyncio
import shutil
import subprocess

import pytest
from sqlalchemy import select

from tests.test_flow import drain_jobs, found
from tests.test_flow import env as env
from tests.test_flow import src_mp3 as src_mp3

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg required")


async def saved(env):
    from app.db import session_scope
    from app.models import Track

    response = await env["client"].post("/api/downloads", json={"track_refs": ["dz:100"], "star": True,
                                                               "new_playlist_name": "Избранный порядок"})
    assert response.status_code == 200, response.text
    await drain_jobs()
    async with session_scope() as s:
        track = (await s.execute(select(Track))).scalar_one()
    path = env["music"] / "library" / track.path
    return track, path, path.read_bytes()


async def alternative(env, tmp_path):
    destination = tmp_path / "studio.mp3"
    await asyncio.to_thread(subprocess.run, ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                    "sine=frequency=660:duration=4", "-c:a", "libmp3lame", "-b:a", "320k", str(destination)], check=True)
    env["fake"].src = destination
    candidate = found(type("Query", (), {"artist": "Кино", "title": "Группа крови"})())[0].model_copy(
        update={"provider_id": "studio", "page_url": "https://hm.test/song/studio"})
    env["fake"].cands = [candidate]
    response = await env["client"].get("/api/search/providers", params={"q": "Кино - Группа крови"})
    assert response.status_code == 200
    return candidate


async def request_replacement(env, track):
    return await env["client"].post(f"/api/library/tracks/{track.id}/replace-source", json={
        "candidate_ref": "file:hitmoz:studio", "expected_acquired_at": track.acquired_at.isoformat()})


async def test_replace_keeps_ids_stars_playlists_tags_and_archives_old_audio(env, tmp_path):
    from app.db import session_scope
    from app.library import tagger
    from app.models import Track

    original, path, content = await saved(env)
    stars = list(env["state"]["stars"])
    playlists = {key: list(value["songs"]) for key, value in env["state"]["playlists"].items()}
    await alternative(env, tmp_path)
    response = await request_replacement(env, original)
    assert response.status_code == 200, response.text
    assert response.json()["replacing_audio"]
    duplicate = await request_replacement(env, original)
    assert duplicate.json()["id"] == response.json()["id"]
    from app.library.replacement import library_lock, queue_replacement
    from app.models import User

    async with session_scope() as s:
        user = (await s.execute(select(User))).scalars().first()
        async with library_lock:
            from fastapi import HTTPException

            with pytest.raises(HTTPException) as conflict:
                await queue_replacement(s, user, await s.get(Track, original.id), env["fake"].cands[0],
                                        import_info={"id": 999, "item": 999})
            assert conflict.value.status_code == 409
    assert path.read_bytes() == content
    await drain_jobs()
    detail = (await env["client"].get(f"/api/downloads/{response.json()['id']}")).json()
    assert detail["status"] == "done", detail
    cancelled = await env["client"].post(f"/api/downloads/items/{response.json()['id']}/cancel")
    assert cancelled.status_code == 409
    async with session_scope() as s:
        rows = (await s.execute(select(Track))).scalars().all()
        assert len(rows) == 1
        track = rows[0]
        assert (track.id, track.uid, track.nd_song_id, track.album_id) == (
            original.id, original.uid, original.nd_song_id, original.album_id)
        assert track.source_url == "https://hm.test/song/studio"
        assert track.acquired_at != original.acquired_at
    assert path.read_bytes() != content
    tags = tagger.read_tags(path)
    assert tags["homemusic_track_id"] == original.uid
    assert tags["title"] == original.title
    assert env["state"]["stars"] == stars
    assert {key: value["songs"] for key, value in env["state"]["playlists"].items()} == playlists
    backups = list((env["music"] / ".backups" / "source-replacements").rglob("*.mp3"))
    assert len(backups) == 1 and backups[0].read_bytes() == content
    stale = await request_replacement(env, original)
    assert stale.status_code == 409


async def test_bad_audio_never_replaces_existing_file(env, tmp_path):
    from app.db import session_scope
    from app.models import Track

    original, path, content = await saved(env)
    await alternative(env, tmp_path)
    env["fake"].src.write_bytes(b"not an audio file")
    response = await request_replacement(env, original)
    await drain_jobs()
    detail = (await env["client"].get(f"/api/downloads/{response.json()['id']}")).json()
    assert detail["status"] in ("needs_review", "failed"), detail
    assert path.read_bytes() == content
    async with session_scope() as s:
        assert (await s.get(Track, original.id)).acquired_at == original.acquired_at


async def test_cancel_while_fetching_does_not_publish_audio(env, tmp_path, monkeypatch):
    from app.jobs.queue import _claim, run_job

    original, path, content = await saved(env)
    await alternative(env, tmp_path)
    response = await request_replacement(env, original)
    entered, release = asyncio.Event(), asyncio.Event()
    fetch = env["fake"].fetch

    async def delayed(*args, **kwargs):
        entered.set()
        await release.wait()
        return await fetch(*args, **kwargs)

    monkeypatch.setattr(env["fake"], "fetch", delayed)
    task = asyncio.create_task(run_job(await _claim("replacement-test")))
    await asyncio.wait_for(entered.wait(), 10)
    cancelled = await env["client"].post(f"/api/downloads/items/{response.json()['id']}/cancel")
    assert cancelled.status_code == 200
    release.set()
    await task
    assert path.read_bytes() == content
    detail = (await env["client"].get(f"/api/downloads/{response.json()['id']}")).json()
    assert detail["status"] == "cancelled"


async def test_publication_failure_restores_original_file_and_revision(env, tmp_path, monkeypatch):
    from app.db import sessionmaker
    from app.library.importer import ImportSpec
    from app.library.replacement import replace_downloaded
    from app.models import DownloadItem, Track

    original, path, content = await saved(env)
    await alternative(env, tmp_path)
    response = await request_replacement(env, original)
    async with sessionmaker()() as s:
        item = await s.get(DownloadItem, response.json()["id"])

        async def failed_commit():
            raise OSError("test DB commit failure")

        monkeypatch.setattr(s, "commit", failed_commit)
        with pytest.raises(OSError, match="test DB"):
            await replace_downloaded(s, item, env["fake"].src, ImportSpec(
                artist=original.artist, title=original.title, source="hitmoz", source_url="https://hm.test/song/studio"))
    assert path.read_bytes() == content
    async with sessionmaker()() as s:
        assert (await s.get(Track, original.id)).acquired_at == original.acquired_at


async def test_temporary_publication_failure_is_retried_instead_of_stuck_importing(env, tmp_path, monkeypatch):
    from app.library import replacement

    original, path, content = await saved(env)
    await alternative(env, tmp_path)
    response = await request_replacement(env, original)
    real = replacement.replace_downloaded
    attempts = 0

    async def fail_once(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise OSError("temporary filesystem failure")
        return await real(*args, **kwargs)

    monkeypatch.setattr(replacement, "replace_downloaded", fail_once)
    await drain_jobs()
    detail = (await env["client"].get(f"/api/downloads/{response.json()['id']}")).json()
    assert detail["status"] == "done", detail
    assert attempts == 2 and path.read_bytes() != content


@pytest.mark.parametrize("owned", [True, False])
async def test_exact_import_allows_explicit_audio_without_losing_match_or_order(env, tmp_path, owned):
    from app.db import session_scope
    from app.models import DownloadItem, Import, ImportCollection, ImportItem, User

    original = (await saved(env))[0] if owned else None
    await alternative(env, tmp_path)
    async with session_scope() as s:
        imp = Import(user_id=1, source="text", method="file", status="done")
        s.add(imp)
        await s.flush()
        coll = ImportCollection(import_id=imp.id, kind="playlist", external_id="p", title="Порядок", position=0)
        s.add(coll)
        await s.flush()
        row = ImportItem(import_id=imp.id, collection_id=coll.id, position=4, external_id="song",
                         raw_json={"artist": "Кино", "title": "Группа крови", "duration_s": 4},
                         match="exact", ref="dz:100", status="done" if owned else "waiting",
                         track_id=original.id if original else None)
        s.add(row)
        await s.flush()
        row_id = row.id
    response = await env["client"].post(f"/api/imports/items/{row_id}/source", json={"candidate_ref": "file:hitmoz:studio"})
    assert response.status_code == 200, response.text
    async with session_scope() as s:
        row = await s.get(ImportItem, row_id)
        item = await s.get(DownloadItem, row.download_item_id)
        assert row.match == "exact" and row.position == 4 and row.ref == "dz:100"
        assert item.chosen_candidate_json["provider_id"] == "studio"
        assert bool(item.query_json.get("replace_track")) is owned
    await drain_jobs()
    detail = (await env["client"].get(f"/api/downloads/{response.json()['id']}")).json()
    assert detail["status"] == "done", detail
    async with session_scope() as s:
        row = await s.get(ImportItem, row_id)
        assert row.match == "exact" and row.position == 4 and row.ref == "dz:100"
        s.add(User(id=999, nd_username="other", nd_password_enc="test"))
        await s.flush()
        imp = await s.get(Import, row.import_id)
        imp.user_id = 999
    foreign = await env["client"].post(f"/api/imports/items/{row_id}/source", json={"candidate_ref": "file:hitmoz:studio"})
    assert foreign.status_code == 404


async def test_format_change_retains_embedded_pids_and_recovers_interrupted_publication(env, tmp_path):
    from app.db import session_scope
    from app.library import tagger
    from app.library.importer import ImportSpec
    from app.library.replacement import replace_downloaded
    from app.models import DownloadItem, Track

    original, path, content = await saved(env)
    await alternative(env, tmp_path)
    response = await request_replacement(env, original)
    flac = tmp_path / "studio.flac"
    await asyncio.to_thread(subprocess.run, ["ffmpeg", "-loglevel", "error", "-i", str(env["fake"].src), str(flac)], check=True)
    backup = env["music"] / ".backups" / "source-replacements" / original.uid / str(response.json()["id"]) / path.name
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, backup)
    path.with_suffix(".flac").write_bytes(b"interrupted, not committed")
    path.unlink()
    async with session_scope() as s:
        item = await s.get(DownloadItem, response.json()["id"])
        await replace_downloaded(s, item, flac, ImportSpec(artist=original.artist, title=original.title,
                                                       source="hitmoz", source_url="https://hm.test/song/studio"))
        track = await s.get(Track, original.id)
        assert track.path.endswith(".flac") and track.nd_song_id == original.nd_song_id
        tags = tagger.read_tags(env["music"] / "library" / track.path)
        assert tags["homemusic_track_id"] == original.uid
        assert tags["homemusic_album_id"] == tagger.read_tags(backup)["homemusic_album_id"]
    assert backup.read_bytes() == content
