"""One real-time MP3 encoder per listened station; public clients share its output.

The persisted radio clock remains authoritative. Pause and temporarily unavailable audio
produce silence, keeping ordinary HTTP players connected. Nothing is imported or scrobbled.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import shutil
import time
from dataclasses import dataclass

from fastapi import HTTPException

from app import listen
from app.db import session_scope

log = logging.getLogger(__name__)
RATE = 44100
FRAME_S = 0.1
FRAME_BYTES = int(RATE * FRAME_S) * 4  # stereo signed 16-bit PCM
SILENCE = bytes(FRAME_BYTES)
MAX_STATIONS = 8
MAX_LISTENERS = 32
MAX_STATION_LISTENERS = 8
_stations: dict[str, Station] = {}
_tasks: set[asyncio.Task] = set()


@dataclass(frozen=True)
class Snapshot:
    ref: str
    key: tuple
    position: float
    duration: float
    paused: bool
    received: float

    def position_now(self) -> float:
        return self.position + (0 if self.paused else time.monotonic() - self.received)


async def snapshot(token: str) -> Snapshot:
    # Short, fresh transactions: a stream must never hold a DB session open.
    from app.api.publications import advance_radio, find, station_lock

    async with station_lock(token), session_scope() as session:
        publication = await find(session, token, "radio")
        index, position = await advance_radio(publication, session)
        track = publication.tracks_json[index]
        ref = f"nd:{track['nd_song_id']}" if track.get("nd_song_id") else track["ref"]
        return Snapshot(ref, (ref, index, publication.revision), position,
                        float(track["duration_s"]), publication.paused_at is not None, time.monotonic())


async def stop_process(process: asyncio.subprocess.Process | None) -> None:
    if process is None:
        return
    if process.returncode is None:
        with contextlib.suppress(ProcessLookupError):
            process.kill()
    await process.communicate()


class Decoder:
    def __init__(self, station: Station):
        self.station = station
        self.frames: asyncio.Queue[bytes] = asyncio.Queue(maxsize=20)
        self.position: float | None = None
        self.task = asyncio.create_task(self.run(), name="radio-decode")

    async def run(self) -> None:
        media = None
        process = None
        feed = None
        try:
            async with asyncio.timeout(40):
                media = await listen.open_media(self.station.state.ref, None, full_only=True)
            if media.status != 200 or (media.path is None and media.body is None):
                return
            # Resolve first; the song may have advanced while a provider was searched.
            self.position = max(0, self.station.state.position_now())
            args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"]
            if media.path is not None:
                args += ["-ss", str(self.position), "-i", str(media.path)]
            else:
                # A growing server copy is not seekable; decode and discard its prefix.
                args += ["-i", "pipe:0", "-ss", str(self.position)]
            args += ["-vn", "-sn", "-dn", "-threads", "1", "-ac", "2", "-ar", str(RATE), "-f", "s16le", "pipe:1"]
            process = await asyncio.create_subprocess_exec(
                *args, stdin=asyncio.subprocess.PIPE if media.path is None else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            if media.path is None:
                async def pipe_source():
                    try:
                        async for chunk in media.body:
                            process.stdin.write(chunk)
                            await process.stdin.drain()
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    finally:
                        process.stdin.close()
                feed = asyncio.create_task(pipe_source(), name="radio-source")
            while True:
                try:
                    async with asyncio.timeout(15):
                        frame = await process.stdout.readexactly(FRAME_BYTES)
                except asyncio.IncompleteReadError as e:
                    if e.partial:
                        await self.frames.put(e.partial + bytes(FRAME_BYTES - len(e.partial)))
                    break
                await self.frames.put(frame)
        except (listen.ListenError, OSError, TimeoutError):
            log.warning("Radio audio unavailable; retrying while transmitting silence")
        finally:
            if feed is not None:
                feed.cancel()
                await asyncio.gather(feed, return_exceptions=True)
            await stop_process(process)
            if media is not None:
                if media.body is not None:
                    close = getattr(media.body, "aclose", None)
                    if close:
                        await close()
                if media.close:
                    await media.close()

    async def close(self):
        if not self.task.done() and not self.task.cancelling():
            self.task.cancel()
        await asyncio.shield(asyncio.gather(self.task, return_exceptions=True))

    def take(self) -> bytes | None:
        if self.frames.empty():
            return None
        self.position += FRAME_S
        return self.frames.get_nowait()


class Station:
    def __init__(self, token: str, state: Snapshot):
        self.token, self.state = token, state
        self.listeners: set[asyncio.Queue] = set()
        self.task = asyncio.create_task(self.run(), name="radio-mp3")
        _tasks.add(self.task)
        self.task.add_done_callback(_tasks.discard)

    def broadcast(self, data: bytes | None):
        for queue in tuple(self.listeners):
            if queue.full():
                # Drop a slow reader, never accumulate audio or delay the other listeners.
                self.listeners.discard(queue)
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait(None)
            else:
                queue.put_nowait(data)

    async def watch(self):
        while True:
            await asyncio.sleep(0.5)
            try:
                self.state = await snapshot(self.token)
            except HTTPException as e:
                if e.status_code == 404:
                    return
                # Keep sending silence on transient provider errors; next poll retries.
            except Exception:
                log.exception("Radio clock refresh failed")

    async def pcm(self, encoder):
        decoder = None
        key = None
        retry_at = 0.0
        deadline = time.monotonic()
        try:
            while True:
                state = self.state
                position = state.position_now()
                audible = not state.paused and position < state.duration and time.monotonic() - state.received < 5
                if state.key != key or not audible:
                    if decoder:
                        await decoder.close()
                    decoder = None
                    if state.key != key:
                        retry_at = 0
                    key = state.key
                if audible and decoder is None and time.monotonic() >= retry_at:
                    decoder = Decoder(self)
                frame = None
                if audible and decoder and decoder.position is not None:
                    drift = position - decoder.position
                    if not decoder.frames.empty() and (drift < -0.4 or drift > 5):
                        await decoder.close()
                        decoder = Decoder(self)  # seek, loop, or a large clock correction
                    else:
                        while decoder.position < position - FRAME_S and not decoder.frames.empty():
                            decoder.take()
                        frame = decoder.take()
                if decoder and decoder.task.done() and decoder.frames.empty():
                    await decoder.close()
                    decoder = None
                    retry_at = time.monotonic() + 5
                encoder.stdin.write(frame or SILENCE)
                async with asyncio.timeout(3):
                    await encoder.stdin.drain()
                deadline += FRAME_S
                now = time.monotonic()
                if deadline < now - FRAME_S:
                    deadline = now
                await asyncio.sleep(max(0, deadline - now))
        finally:
            if decoder:
                await decoder.close()

    async def run(self):
        process = None
        tasks = []
        try:
            process = await asyncio.create_subprocess_exec(
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                "-f", "s16le", "-ar", str(RATE), "-ac", "2", "-i", "pipe:0", "-vn",
                "-threads", "1", "-c:a", "libmp3lame", "-b:a", "128k",
                "-write_xing", "0", "-id3v2_version", "0", "-flush_packets", "1", "-f", "mp3", "pipe:1",
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)

            async def relay():
                while data := await process.stdout.read(4096):
                    self.broadcast(data)
                    if not self.listeners:
                        return

            tasks = [asyncio.create_task(self.watch()), asyncio.create_task(self.pcm(process)), asyncio.create_task(relay())]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except (OSError, TimeoutError, BrokenPipeError, ConnectionResetError):
            log.warning("Continuous radio encoder stopped")
        finally:
            if _stations.get(self.token) is self:
                _stations.pop(self.token)
            for task in tasks:
                if not task.done() and not task.cancelling():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await stop_process(process)
            self.broadcast(None)


class Subscription:
    def __init__(self, station: Station):
        self.station = station
        self.queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=30)
        self.closed = False
        station.listeners.add(self.queue)

    def __aiter__(self):
        return self

    async def __anext__(self) -> bytes:
        if self.closed:
            raise StopAsyncIteration
        try:
            chunk = await self.queue.get()
        except asyncio.CancelledError:
            await self.aclose()
            raise
        if chunk is None:
            await self.aclose()
            raise StopAsyncIteration
        return chunk

    async def aclose(self):
        if self.closed:
            return
        self.closed = True
        self.station.listeners.discard(self.queue)
        if not self.station.listeners:
            if _stations.get(self.station.token) is self.station:
                _stations.pop(self.station.token)
            if not self.station.task.done() and not self.station.task.cancelling():
                self.station.task.cancel()
            await asyncio.shield(asyncio.gather(self.station.task, return_exceptions=True))


def subscribe(token: str, state: Snapshot) -> Subscription:
    if shutil.which("ffmpeg") is None:
        raise HTTPException(503, "Непрерывный эфир временно недоступен: на сервере нет аудиокодировщика")
    station = _stations.get(token)
    if sum(len(s.listeners) for s in _stations.values()) >= MAX_LISTENERS or (
        station is None and len(_stations) >= MAX_STATIONS
    ) or (station and len(station.listeners) >= MAX_STATION_LISTENERS):
        raise HTTPException(429, "Слишком много подключений к радио. Попробуйте позже.", headers={"Retry-After": "10"})
    if station is None:
        station = Station(token, state)
        _stations[token] = station
    return Subscription(station)


async def reset():
    tasks = tuple(_tasks)
    for task in tasks:
        if not task.done() and not task.cancelling():
            task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    _stations.clear()
