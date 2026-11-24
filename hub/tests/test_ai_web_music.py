from unittest.mock import AsyncMock

import httpx
import pytest

from app.ai.web_music import parse_page
from tests.test_ai_agent import chat, completion, tool_call

pytest_plugins = ["tests.test_ai_agent"]

HTML = b'''<html><head><title>Game 2 | Soundtrack - Composer</title></head><body>
<ul><li data-title="First" data-artist="Composer"><span class="track-time">3:44</span>
<a href="https://audio.example/first.mp3">First</a></li>
<li data-title="Second" data-artist="Composer"><span class="track-time">2:00</span>
<a href="https://audio.example/second.mp3">Second</a></li>
<li data-title="Rare bonus" data-artist="Composer"><a href="https://audio.example/bonus.mp3">Bonus</a></li></ul>
<a href="https://store.example/preview.mp3">Uncredited store preview</a>
<a href="/soundtracks">Soundtracks</a></body></html>'''
URL = "https://composer.example/game2"


def test_page_uses_published_metadata_and_order():
    page = parse_page(HTML, URL)
    assert page["title"] == "Game 2"
    assert [t["title"] for t in page["tracks"]] == ["First", "Second", "Rare bonus"]
    assert page["tracks"][0]["duration_s"] == 224
    assert {x["url"] for x in page["links"]} >= {"https://composer.example/soundtracks"}


@pytest.mark.parametrize("direct", [True, False])
async def test_web_release_queues_only_fetched_tracks_after_empty_catalog(env, monkeypatch, direct):
    from sqlalchemy import select

    from app.ai import album_scope, web_music
    from app.db import session_scope
    from app.models import DownloadItem

    monkeypatch.setattr(album_scope, "album_candidates", AsyncMock(return_value=[]))
    page = parse_page(HTML, URL)
    if not direct:
        for track in page["tracks"]:
            track["audio_url"] = None
    monkeypatch.setattr(web_music, "read_page", AsyncMock(return_value=page))
    ref = parse_page(HTML, URL)["release_ref"]
    out = await chat(env, "Собери плейлист из OST Game 2",
                     completion(calls=[tool_call("read_music_page", url=URL)]),
                     completion(calls=[tool_call("download_web_release", release_ref=ref, track_numbers=[2, 1])]))
    assert "2 трека" in out["reply"] and "по мере загрузки" in out["reply"]
    assert URL in out["reply"]
    async with session_scope() as s:
        items = list(await s.scalars(select(DownloadItem).order_by(DownloadItem.id)))
        assert [i.query_json["query"]["title"] for i in items] == ["First", "Second"]
        assert [i.query_json["meta"]["track_no"] for i in items] == [1, 2]
        assert all(i.chosen_candidate_json["provider"] == "web_audio" if direct else i.chosen_candidate_json is None
                   for i in items)
    assert len(env["state"]["playlists"]) == 2


@pytest.mark.parametrize("complete", [True, False])
async def test_apple_album_reads_complete_tracklist_without_preview_downloads(monkeypatch, complete):
    import json

    from app.ai import web_music

    rows = [{"wrapperType": "collection", "collectionName": "Game 2 OST", "trackCount": 1 if complete else 2},
            {"kind": "song", "collectionId": 123, "artistName": "Composer", "trackName": "First",
             "trackNumber": 1, "trackTimeMillis": 224000, "previewUrl": "https://store.example/preview.m4a"}]
    reader = AsyncMock(side_effect=[HTML, json.dumps({"results": rows}).encode()])
    monkeypatch.setattr(web_music, "public_read", reader)
    if not complete:
        with pytest.raises(ValueError, match="полный список"):
            await web_music.read_page("https://music.apple.com/us/album/game/123")
        return
    page = await web_music.read_page("https://music.apple.com/us/album/game/123")
    assert page["title"] == "Game 2 OST"
    assert page["tracks"] == [{"number": 1, "artist": "Composer", "title": "First", "duration_s": 224,
                               "audio_url": None}]
    assert "lookup?id=123" in reader.call_args.args[0]


async def test_web_release_rejects_unread_or_wrong_album(env, monkeypatch):
    from app.ai import album_scope, web_music

    monkeypatch.setattr(album_scope, "album_candidates", AsyncMock(return_value=[]))
    monkeypatch.setattr(web_music, "read_page", AsyncMock(return_value=parse_page(HTML, URL)))
    ref = parse_page(HTML, URL)["release_ref"]
    out = await chat(env, "Собери плейлист из OST Another Game",
                     completion(calls=[tool_call("download_web_release", release_ref=ref)]),
                     completion(calls=[tool_call("read_music_page", url=URL)]),
                     completion(calls=[tool_call("download_web_release", release_ref=ref)]), completion("Нет"))
    assert not out["done"]
    assert len(env["state"]["playlists"]) == 1


async def test_web_release_queue_failure_removes_empty_playlist(env, monkeypatch):
    from app.ai import album_scope, web_music
    from app.jobs import downloads

    monkeypatch.setattr(album_scope, "album_candidates", AsyncMock(return_value=[]))
    monkeypatch.setattr(web_music, "read_page", AsyncMock(return_value=parse_page(HTML, URL)))
    monkeypatch.setattr(downloads, "create_items", AsyncMock(side_effect=ValueError("queue unavailable")))
    ref = parse_page(HTML, URL)["release_ref"]
    out = await chat(env, "Собери плейлист из OST Game 2",
                     completion(calls=[tool_call("read_music_page", url=URL)]),
                     completion(calls=[tool_call("download_web_release", release_ref=ref)]), completion("Нет"))
    assert not out["done"]
    assert len(env["state"]["playlists"]) == 1


async def test_internet_followup_preserves_release_context(env, monkeypatch):
    from app.ai import album_scope

    candidates = AsyncMock(return_value=[])
    monkeypatch.setattr(album_scope, "album_candidates", candidates)
    env["state"]["script"] = [completion("Нет")]
    r = await env["client"].post("/api/assistant/chat", json={"messages": [
        {"role": "user", "content": "Найди треки из ost c&c red alert 2, скачай их в библиотеку и создай из них плейлист"},
        {"role": "assistant", "content": "Не нашёл в каталоге"},
        {"role": "user", "content": "найди в интернете, сохрани в библиотеку, и создай плейлист"},
    ]})
    assert r.status_code == 200
    assert candidates.call_args.args == ("c and c red alert 2",)
    assert candidates.call_args.kwargs["soundtrack"] is True
    assert {t["function"]["name"] for t in env["state"]["llm_requests"][0]["tools"]} == {
        "search_music_sources", "read_music_page", "download_web_release"}


@pytest.mark.parametrize("url", ["http://example.com/a", "https://user:pass@example.com/a", "https://example.com:8443/a"])
async def test_public_fetch_rejects_unsafe_url(url):
    from app.public_web import public_address

    with pytest.raises(ValueError):
        await public_address(url)


async def test_public_fetch_rejects_private_dns(monkeypatch):
    import socket

    from app.public_web import public_address

    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("127.0.0.1", 443))])
    with pytest.raises(ValueError):
        await public_address("https://example.com/")


async def test_public_fetch_pins_checked_address_and_rechecks_redirect(monkeypatch):
    from contextlib import asynccontextmanager

    from app import public_web

    addresses = AsyncMock(side_effect=[(httpx.URL("https://example.com/"), "93.184.215.14"),
                                      ValueError("private")])
    monkeypatch.setattr(public_web, "public_address", addresses)
    requests = []

    @asynccontextmanager
    async def stream(self, method, url, **kwargs):
        requests.append((str(url), kwargs))
        yield httpx.Response(302, headers={"location": "https://localhost/private"})

    monkeypatch.setattr(httpx.AsyncClient, "stream", stream)
    with pytest.raises(ValueError, match="private"):
        await public_web.public_read("https://example.com/")
    assert requests[0][0] == "https://93.184.215.14/"
    assert requests[0][1]["headers"]["Host"] == "example.com"
    assert requests[0][1]["extensions"]["sni_hostname"] == "example.com"
