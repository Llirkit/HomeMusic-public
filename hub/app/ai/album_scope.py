"""Bound explicit album operations to matching releases, never sound-alike music."""

from __future__ import annotations

import asyncio
import re

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.matching.normalize import normalize_title
from app.models import Album, Track

SOUNDTRACK = r"\b(?:ost|ост(?:а|ов)?)\b|саундтрек\w*|soundtrack"


def album_playlist_query(text: str) -> str | None:
    """Recognize a playlist OF a release; playlists LIKE it stay on the mood path."""
    if not re.search(r"плейлист", text, re.I) or not re.search(SOUNDTRACK + r"|альбом", text, re.I):
        return None
    if re.search(r"\bне\s+(?:созда|соб|сдел)|похож|в стиле|по мотивам|настроени|звучани", text, re.I):
        return None
    if not re.search(r"созда|собер|собрать|сдела|состав", text, re.I):
        return None
    match = re.search(r"\bиз\s+(.+?)[.!?]*$", text, re.I)
    if not match:
        return None
    title = re.sub(SOUNDTRACK + r"|\b(?:original|альбома|треков|треков игры|треки|песен|песни|игры|игре|всех|все)\b",
                   " ", match[1], flags=re.I)
    return normalize_title(title).text or None


def _soundtrack_releases(candidates: list[dict]) -> list[dict]:
    # A game title also occurs on cover singles and arrangement compilations.
    return [a for a in candidates if re.search(
        r"\bost\b|soundtrack|vocal tracks|саундтрек", a["title"], re.I) and not re.search(
        r"cover|tribute|arrangement|кавер|трибьют", a["title"], re.I)]


def album_favorite_query(text: str) -> str | None:
    # Keep ordinary account/import/playlist operations on the existing general chat path.
    if not re.search(r"\b(?:добавь(?:те)?|добавить|поставь(?:те)?|отметь(?:те)?)\b", text, re.I):
        return None
    if re.search(r"\bне\s+(?:добав|став|постав|отмеч|отмет)", text, re.I):
        return None
    if not re.search(r"любим|понрав|избран|♥", text, re.I):
        return None
    if not re.search(r"\b(?:все|всех|весь)\s+(?:треки|треков|песни|песен|альбом)", text, re.I):
        return None
    if not re.search(r"\bost\b|саундтрек|альбом", text, re.I):
        return None
    match = re.search(r"\bиз\s+(?:альбома\s+|саундтрека\s+)?(.+?)\s*[.!?]*$", text, re.I)
    if not match:
        return None
    title = re.sub(r"\b(?:ost|original soundtrack)\b", " ", match[1], flags=re.I)
    query = normalize_title(title).text
    if re.search(r"импорт|плейлист|яндекс|spotify", query, re.I):
        return None
    return query or None


async def album_candidates(query: str, s: AsyncSession | None = None, *, soundtrack: bool = False) -> list[dict]:
    from app.services import svc

    words = query.split()
    if s is not None:
        library = []
        rows = (await s.execute(select(Album, func.count(Track.id)).join(Track, Track.album_id == Album.id)
                                .group_by(Album.id))).all()
        for album, count in rows:
            if set(words) <= set(normalize_title(album.title).text.split()):
                library.append({"ref": f"library:{album.id}", "library_id": album.id, "title": album.title,
                                "artist": album.album_artist, "tracks": count})
        if soundtrack:
            library = _soundtrack_releases(library)
        if library:
            return library
    queries = list(dict.fromkeys([query, " ".join(words[:2])]))
    results = await asyncio.gather(*(svc.deezer.search(q, kinds=("album",), limit=50) for q in queries))
    found = {}
    for result in results:
        for album in result.albums:
            title_words = set(normalize_title(album.title).text.split())
            # A song mentioning one title word, or a one-track cover single, is not the requested whole album.
            if not set(words) <= title_words or (album.nb_tracks or 0) < 2:
                continue
            found[album.ref] = {"ref": album.ref, "title": album.title,
                                "artist": album.artist, "tracks": album.nb_tracks}
    candidates = list(found.values())
    if soundtrack:
        candidates = _soundtrack_releases(candidates)
    return candidates
