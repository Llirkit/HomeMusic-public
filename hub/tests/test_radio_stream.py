"""Real HTTP/MP3 consumer checks, with synthetic local audio instead of music providers."""
import asyncio
import math
import shutil
import socket
import struct
import time
import wave
from contextlib import asynccontextmanager
from datetime import timedelta
from itertools import pairwise
from types import SimpleNamespace

import httpx
import pytest
import respx
import uvicorn
from fastapi import HTTPException

from app import listen, radio_stream
from tests.support import app_client
from tests.test_publications import env as env
from tests.test_publications import playlist as playlist
from tests.test_publications import publish


@pytest.fixture
def tones(tmp_path):
    paths = []
    for number, frequency in enumerate((440, 660)):
        path = tmp_path / f"tone{number}.wav"
        with wave.open(str(path), "wb") as out:
            out.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            out.writeframes(b"".join(struct.pack("<h", int(6000 * math.sin(
                2 * math.pi * (220 if number == 0 and i < 3 * 16000 else frequency) * i / 16000
            ))) for i in range(30 * 16000)))
        paths.append(path)
    return paths


async def signal(mp3):
    process = await asyncio.create_subprocess_exec(
        "ffmpeg", "-v", "error", "-f", "mp3", "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1",
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    pcm, error = await process.communicate(mp3)
    assert process.returncode == 0, error
    samples = struct.unpack(f"<{len(pcm) // 2}h", pcm)[1600:-1600]  # discard MP3 reservoir warm-up at segment edges
    assert len(samples) > 4000  # at least 250 ms of decodable audio
    rms = math.sqrt(sum(x * x for x in samples) / len(samples)) / 32768
    crossings = sum(a <= 0 < b for a, b in pairwise(samples))
    return rms, crossings * 16000 / len(samples)


@asynccontextmanager
async def http_server(app):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False, lifespan="off"))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        async with asyncio.timeout(5):
            while not server.started:  # noqa: ASYNC110 - Uvicorn exposes readiness as a flag.
                await asyncio.sleep(0.01)
        with respx.mock(assert_all_called=False) as network:
            network.route(host="127.0.0.1").pass_through()
            yield f"http://127.0.0.1:{port}"
    finally:
        await radio_stream.reset()
        server.should_exit = True
        async with asyncio.timeout(5):
            await task
        sock.close()


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="requires ffmpeg")
async def test_mp3_over_http_joins_live_pauses_changes_tracks_revokes_and_cleans_up(env, playlist, tones, monkeypatch):
    from app.db import session_scope
    from app.models import Publication, utcnow

    opens = []

    async def open_media(ref, range_header, *, full_only):
        assert full_only and range_header is None
        opens.append(ref)
        return SimpleNamespace(status=200, path=tones[0 if ref == "nd:song1" else 1], body=None, close=None)

    monkeypatch.setattr(listen, "open_media", open_media)
    c = env["client"]
    p = await publish(c, "radio")
    url = f"/api/publications/{p['id']}/live.mp3"
    assert p["live_url"].endswith(url)
    async with session_scope() as s:
        row = await s.get(Publication, p["id"])
        row.tracks_json = [{**track, "duration_s": duration} for track, duration in zip(row.tracks_json, (10, 12), strict=True)]
        row.started_at = utcnow() - timedelta(seconds=5)
    chunks = []

    async def read(response):
        async for data in response.aiter_bytes():
            chunks.append((time.monotonic(), data))

    async def recent_signal():
        # Allow the source/encoder buffers to drain after a shared transport change.
        await asyncio.sleep(1.7)
        since = time.monotonic() - 0.8
        return await signal(b"".join(data for received, data in chunks if received >= since))

    async with http_server(env["app"]) as base, httpx.AsyncClient(base_url=base, timeout=6) as external:
        async with external.stream("GET", url, headers={"Range": "bytes=0-", "Icy-MetaData": "1"}) as response:
            assert response.status_code == 200 and response.headers["content-type"] == "audio/mpeg"
            assert "content-length" not in response.headers and response.headers["accept-ranges"] == "none"
            assert response.headers["x-accel-buffering"] == "no"
            reader = asyncio.create_task(read(response))
            await asyncio.sleep(1)
            rms, frequency = await recent_signal()
            assert rms > 0.03 and frequency == pytest.approx(440, abs=12)  # joined at 5 s, not the intro's 220 Hz
            async with external.stream("GET", url) as second:
                assert await anext(second.aiter_bytes())  # a later listener reuses the encoder
                assert len(radio_stream._stations) == 1 and len(opens) == 1
            async def command(action, revision, **extra):
                result = await c.post(f"/api/publications/{p['id']}/control", json={"action": action, "revision": revision, **extra})
                assert result.status_code == 200, result.text
            await command("pause", 0)
            rms, _ = await recent_signal()
            assert rms < 0.001 and not reader.done()
            await command("next", 1)  # a different track selected while the station is paused
            await command("resume", 2)
            rms, frequency = await recent_signal()
            assert rms > 0.03 and frequency == pytest.approx(660, abs=12)
            await command("play", 3, index=0)
            rms, frequency = await recent_signal()
            assert rms > 0.03 and frequency == pytest.approx(220, abs=12)
            await command("seek", 4, position_s=6)
            rms, frequency = await recent_signal()
            assert rms > 0.03 and frequency == pytest.approx(440, abs=12)
            await asyncio.sleep(2.5)
            rms, frequency = await recent_signal()
            assert rms > 0.03 and frequency == pytest.approx(660, abs=12)  # natural next song, same HTTP response
            assert (await c.delete(f"/api/publications/{p['id']}")).status_code == 200
            async with asyncio.timeout(3):
                await reader
            assert radio_stream._stations == {}
        assert (await external.get(url)).status_code == 404
        again = await publish(c, "radio", source_id="p2")
        async with external.stream("GET", f"/api/publications/{again['id']}/live.mp3") as disconnect:
            assert await anext(disconnect.aiter_bytes())
        async with asyncio.timeout(3):
            while radio_stream._tasks:  # noqa: ASYNC110 - observe cleanup triggered by the real socket disconnect.
                await asyncio.sleep(0.02)
        assert not radio_stream._stations


async def test_live_link_permissions_head_and_missing_station(env, playlist, monkeypatch):
    p = await publish(env["client"], "radio")
    share = await publish(env["client"])
    assert "live_url" not in share
    async with app_client(env["app"], login=None) as guest:
        head = await guest.head(f"/api/publications/{p['id']}/live.mp3")
        assert head.status_code == 200 and head.headers["content-type"] == "audio/mpeg"
        assert "content-length" not in head.headers and not radio_stream._stations
        assert (await guest.get("/api/publications/invalid/live.mp3")).status_code == 404
        assert (await guest.get(f"/api/publications/{share['id']}/live.mp3")).status_code == 404
        monkeypatch.setattr(radio_stream.shutil, "which", lambda _: None)
        assert (await guest.get(f"/api/publications/{p['id']}/live.mp3")).status_code == 503


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="requires ffmpeg")
async def test_subscriber_limits_slow_reader_and_early_disconnect(monkeypatch):
    state = radio_stream.Snapshot("nd:missing", ("missing", 0, 0), 0, 120, True, time.monotonic())
    monkeypatch.setattr(radio_stream, "MAX_STATION_LISTENERS", 2)
    a = radio_stream.subscribe("token", state)
    b = radio_stream.subscribe("token", state)
    try:
        with pytest.raises(HTTPException) as limit:
            radio_stream.subscribe("token", state)
        assert limit.value.status_code == 429
        station = radio_stream._stations["token"]
        for _ in range(30):
            a.queue.put_nowait(b"old audio")
        station.broadcast(b"live audio")
        assert await anext(b) == b"live audio"
        with pytest.raises(StopAsyncIteration):
            await anext(a)
        await b.aclose()  # even before the encoder task gets its first scheduling turn
        assert not radio_stream._stations and station.task.done()
    finally:
        await radio_stream.reset()


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="requires ffmpeg")
async def test_transient_source_failure_keeps_stream_open_then_decodes_a_growing_copy(tones, monkeypatch):
    state = radio_stream.Snapshot("nd:copy", ("copy", 0, 0), 5, 30, False, time.monotonic())
    attempts, closed = [], []

    async def clock(_):
        return radio_stream.Snapshot(state.ref, state.key, state.position_now(), 30, False, time.monotonic())

    async def body():
        try:
            data = tones[0].read_bytes()
            for offset in range(0, len(data), 32768):
                yield data[offset:offset + 32768]
        finally:
            closed.append("body")

    async def close():
        closed.append("media")

    async def source(*args, **kwargs):
        attempts.append(kwargs)
        if len(attempts) == 1:
            raise listen.ListenError(503, "Temporary source failure")
        return SimpleNamespace(status=200, path=None, body=body(), close=close)

    monkeypatch.setattr(radio_stream, "snapshot", clock)
    monkeypatch.setattr(listen, "open_media", source)
    stream = radio_stream.subscribe("copy-token", state)
    data = []
    try:
        async with asyncio.timeout(10):
            async for chunk in stream:
                data.append((time.monotonic(), chunk))
                if time.monotonic() - state.received > 7:
                    break
        rms, frequency = await signal(b"".join(chunk for received, chunk in data if received >= time.monotonic() - 0.8))
        assert rms > 0.03 and frequency == pytest.approx(440, abs=12)
        assert len(attempts) == 2 and all(a == {"full_only": True} for a in attempts)
    finally:
        await stream.aclose()
        await radio_stream.reset()
    assert "body" in closed and "media" in closed and not radio_stream._tasks
