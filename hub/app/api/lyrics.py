"""Тексты текущей песни; получение не запускает поиск или загрузку аудио."""

from fastapi import APIRouter, Depends, Query

from app.auth import current_user
from app.lyrics import LyricsOut, Metadata, get_lyrics
from app.models import User

router = APIRouter(prefix="/api/lyrics", tags=["lyrics"])


@router.get("", response_model=LyricsOut)
async def lyrics(
    ref: str = Query(min_length=3, max_length=512, pattern=r"^(dz|nd|hm|file):.+$"),
    title: str = Query(default="", max_length=512),
    artist: str = Query(default="", max_length=512),
    album: str = Query(default="", max_length=512),
    duration_s: float | None = Query(default=None, gt=0, le=86400),
    user: User = Depends(current_user),
):
    return await get_lyrics(ref, Metadata(artist, title, album, duration_s))
