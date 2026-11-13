"""Тексты: точность версии/таймингов, резерв, кеш и независимость от аудио."""

import asyncio
import gzip
import json
import os

import httpx
import pytest
import respx

from app import lyrics
from tests.support import FakeDeezer, app_client

real_metadata = lyrics.metadata


def record(**patch):
    return {"id": 1, "artistName": "Кино", "trackName": "Группа крови", "duration": 245,
            "plainLyrics": "Первая строка\nВторая строка", "syncedLyrics": "[00:01.50]Первая строка\n[00:04]Вторая строка",
            "instrumental": False, **patch}


@pytest.fixture
async def env(hub_env, monkeypatch):
    from app.main import create_app
    from app.services import svc

    monkeypatch.setenv("GENIUS_ACCESS_TOKEN", "")
    monkeypatch.setattr(lyrics, "metadata", _metadata)
    app = create_app()
    async with app.router.lifespan_context(app):
        svc.deezer = FakeDeezer()
        with respx.mock(assert_all_called=False) as mock:
            mock.route(host="navidrome.test").respond(200, json={"subsonic-response": {"status": "ok"}})
            async with app_client(app) as client:
                yield client, mock


async def _metadata(ref, hint):
    return lyrics.Metadata("Кино", "Группа крови", "Группа крови", 245)


def test_lrc_repeated_timestamps_offset_and_breaks():
    lines = lyrics.parse_lrc("[ar:Кино]\n[offset:+100]\n[00:02.5][01:02.050]Слова\n[00:03]\n[bad]Нет")
    assert [(line.start_ms, line.text) for line in lines] == [(2400, "Слова"), (2900, ""), (61950, "Слова")]


def test_no_false_sync_or_wrong_version():
    meta = lyrics.Metadata("Кино", "Группа крови", duration_s=245)
    assert lyrics.lrclib_result(record(trackName="Группа крови (Live)"), meta) is None
    assert lyrics.lrclib_result(record(artistName="Другой исполнитель"), meta) is None
    result = lyrics.lrclib_result(record(duration=260), meta)
    assert result.plain and not result.synced and not result.lines
    assert lyrics.lrclib_result(record(instrumental=True, duration=260), meta) is None


async def test_api_sync_and_cache(env):
    client, mock = env
    route = mock.get("https://lrclib.net/api/get").respond(200, json=record())
    a = await client.get("/api/lyrics", params={"ref": "dz:100"})
    b = await client.get("/api/lyrics", params={"ref": "nd:other"})
    assert a.status_code == b.status_code == 200
    assert a.json()["synced"] and a.json()["lines"][0]["start_ms"] == 1500
    assert b.json()["ref"] == "nd:other"
    assert route.call_count == 1
    assert "HomeMusic/" in route.calls[0].request.headers["user-agent"]


async def test_search_prefers_matching_duration(env):
    client, mock = env
    mock.get("https://lrclib.net/api/get").respond(404)
    mock.get("https://lrclib.net/api/search").respond(200, json=[record(duration=300), record()])
    result = (await client.get("/api/lyrics", params={"ref": "dz:100"})).json()
    assert result["synced"] and result["duration_s"] == 245


async def test_compressed_upstream_is_decoded_once(env):
    client, mock = env
    mock.get("https://lrclib.net/api/get").respond(200,
        content=gzip.compress(json.dumps(record()).encode()),
        headers={"Content-Encoding": "gzip", "Content-Type": "application/json"})
    result = (await client.get("/api/lyrics", params={"ref": "dz:100"})).json()
    assert result["status"] == "found" and result["synced"]


async def test_missing_without_genius_key_is_negatively_cached(env):
    client, mock = env
    exact = mock.get("https://lrclib.net/api/get").respond(404)
    search = mock.get("https://lrclib.net/api/search").respond(200, json=[])
    for _ in range(2):
        result = (await client.get("/api/lyrics", params={"ref": "dz:100"})).json()
        assert result["status"] == "not_found"
    assert exact.call_count == search.call_count == 1


async def test_metadata_prefers_library_and_handles_saved_files(env):
    from app.catalog.cache import cache_set
    from app.db import session_scope
    from app.models import Track

    async with session_scope() as session:
        session.add(Track(uid="lyrics-test", path="song.mp3", nd_song_id="song", artist="Кино",
                          title="Группа крови", duration_s=245, fingerprint="кино|группа крови"))
    hint = lyrics.Metadata("Wrong", "Wrong", duration_s=180)
    meta = await real_metadata("nd:song", hint)
    assert (meta.artist, meta.title, meta.duration_s) == ("Кино", "Группа крови", 245)
    await cache_set("listen:file:hitmoz:1", {
        "artist": "Кино", "title": "Группа крови", "duration_s": 245, "query": {"album": "Альбом"},
    }, 60)
    meta = await real_metadata("file:hitmoz:1", hint)
    assert meta.album == "Альбом" and meta.duration_s == 245


async def test_genius_free_token_fallback_and_plain_text(env):
    from app.config import get_settings

    client, mock = env
    get_settings().genius_access_token = "test-secret"
    mock.get("https://lrclib.net/api/get").respond(404)
    mock.get("https://lrclib.net/api/search").respond(200, json=[])
    search = mock.get("https://api.genius.com/search").respond(200, json={"response": {"hits": [{"result": {
        "title": "Группа крови", "primary_artist": {"name": "Кино"}, "url": "https://genius.com/Kino-song-lyrics",
    }}]}})
    page = mock.get("https://genius.com/Kino-song-lyrics").respond(200, text=(
        '<div data-lyrics-container="true">Первая<br>Вторая<a data-exclude-from-selection="true">Реклама</a></div>'
    ))
    result = (await client.get("/api/lyrics", params={"ref": "dz:100"})).json()
    assert result["source"] == "Genius" and result["plain"] == "Первая\nВторая"
    assert not result["synced"]
    assert search.calls[0].request.headers["authorization"] == "Bearer test-secret"
    assert "authorization" not in page.calls[0].request.headers


async def test_rate_limit_is_temporary_and_respects_retry_after(env):
    client, mock = env
    route = mock.get("https://lrclib.net/api/get").respond(429, headers={"Retry-After": "120"})
    result = (await client.get("/api/lyrics", params={"ref": "dz:100"})).json()
    assert result["status"] == "temporarily_unavailable"
    with pytest.raises(lyrics.UpstreamError):
        await lyrics.from_lrclib(lyrics.runtime(), lyrics.Metadata("Другой", "Трек"))
    assert route.call_count == 1


async def test_concurrent_callers_share_request_and_survive_cancellation(env):
    _, mock = env
    entered, release = asyncio.Event(), asyncio.Event()

    async def respond(request):
        entered.set()
        await release.wait()
        return httpx.Response(200, json=record())

    route = mock.get("https://lrclib.net/api/get").mock(side_effect=respond)
    hint = lyrics.Metadata("Кино", "Группа крови", duration_s=245)
    first = asyncio.create_task(lyrics.get_lyrics("dz:100", hint))
    await entered.wait()
    second = asyncio.create_task(lyrics.get_lyrics("dz:100", hint))
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    release.set()
    assert (await second).synced
    assert route.call_count == 1


async def test_requires_login_and_valid_reference(env):
    client, _ = env
    assert (await client.get("/api/lyrics", params={"ref": "http://invalid"})).status_code == 422
    client.cookies.clear()
    assert (await client.get("/api/lyrics", params={"ref": "dz:100"})).status_code == 401


@pytest.mark.network
@pytest.mark.skipif(os.getenv("HUB_NETWORK_TESTS") != "1", reason="set HUB_NETWORK_TESTS=1")
async def test_live_lrclib():
    try:
        result = await lyrics.from_lrclib(lyrics.runtime(), lyrics.Metadata(
            "Rick Astley", "Never Gonna Give You Up", duration_s=213))
        assert result is not None and result.status == "found" and result.plain
    finally:
        await lyrics.reset()
