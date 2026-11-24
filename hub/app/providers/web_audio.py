"""Complete audio files explicitly linked by a researched music page; no similar-track fallback."""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from urllib.parse import urlsplit

from app.providers.base import Candidate, ProviderError, TrackQuery
from app.public_web import public_stream


class WebAudioProvider:
    name = "web_audio"

    async def search(self, q: TrackQuery, limit: int = 10) -> list[Candidate]:
        return []

    async def enrich(self, candidate: Candidate) -> Candidate:
        return candidate

    async def fetch(self, candidate: Candidate, dest_dir: Path, on_progress=None) -> Path:
        if not candidate.download_url:
            raise ProviderError("На странице нет ссылки на полный аудиофайл")
        suffix = Path(urlsplit(candidate.download_url).path).suffix.lower()
        if suffix not in (".mp3", ".flac", ".m4a", ".ogg", ".wav"):
            raise ProviderError("Ссылка не указывает на поддерживаемый аудиофайл")
        path = dest_dir / ("web_" + hashlib.sha256(candidate.download_url.encode()).hexdigest() + suffix)
        await asyncio.to_thread(dest_dir.mkdir, parents=True, exist_ok=True)
        size = 0
        try:
            async with public_stream(candidate.download_url) as response:
                total = int(response.headers.get("content-length", 0))
                with path.open("wb") as stream:
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > 256 * 1024 * 1024:
                            raise ProviderError("Аудиофайл больше 256 МиБ")
                        stream.write(chunk)
                        if on_progress and total:
                            on_progress(min(size / total, 1))
            if not size:
                raise ProviderError("Пустой аудиофайл")
            return path
        except BaseException:
            path.unlink(missing_ok=True)
            raise

    async def aclose(self) -> None:
        pass

    async def stream(self, candidate: Candidate):
        raise ProviderError("Дождитесь загрузки: этот источник доступен для скачивания в библиотеку")
