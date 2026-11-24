from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.ai.album_scope import album_candidates, album_favorite_query, album_playlist_query


@pytest.mark.parametrize(("text", "query"), [
    ("собери плейлист из оста red alert 2", "red alert 2"),
    ("собери плейлист из ост треков игры red alert 2", "red alert 2"),
    ("Создай плейлист из Red Alert 2 OST", "red alert 2"),
    ("Сделай плейлист из саундтрека игры Red Alert 2", "red alert 2"),
    ("Составь плейлист из всех треков альбома Nevermind", "nevermind"),
    ("Собери плейлист из музыки в стиле Red Alert 2 OST", None),
    ("Собери плейлист из похожих на OST Red Alert 2 треков", None),
    ("Не создавай плейлист из Red Alert 2 OST", None),
    ("Удали плейлист Red Alert 2 OST", None),
    ("Собери плейлист из любимых", None),
])
def test_album_playlist_scope(text, query):
    assert album_playlist_query(text) == query


@pytest.mark.parametrize(("text", "query"), [
    ("добавь мне в любимое все треки из Gear Rising: Revengeance OST", "gear rising revengeance"),
    ("Добавь в избранное все песни из альбома Nevermind", "nevermind"),
    ("Добавь в любимое все треки из Яндекс Музыки", None),
    ("Добавь в любимое все треки из плейлиста OST", None),
    ("Найди саундтрек Gear Rising OST", None),
    ("Убери из любимого все треки из Game OST", None),
    ("Не добавь в любимое все треки из Game OST", None),
    ("Покажи в любимом все треки из Game OST", None),
])
def test_album_request_scope(text, query):
    assert album_favorite_query(text) == query


async def test_album_candidates_require_all_title_words_and_whole_releases(monkeypatch):
    from app.services import svc

    search = AsyncMock(return_value=SimpleNamespace(albums=[
        SimpleNamespace(ref="dz:1", title="METAL GEAR RISING REVENGEANCE Vocal Tracks Selection",
                        artist="Various", nb_tracks=27),
        SimpleNamespace(ref="dz:2", title="Revengeance", artist="Other", nb_tracks=12),
        SimpleNamespace(ref="dz:3", title="Rules (From Metal Gear Rising Revengeance)", artist="Cover", nb_tracks=1),
        SimpleNamespace(ref="dz:4", title="Metal Gear Rising Revengeance Iconic Themes", artist="Arcade", nb_tracks=13),
    ]))
    monkeypatch.setattr(svc, "deezer", SimpleNamespace(search=search))
    out = await album_candidates("gear rising revengeance")
    assert [a["ref"] for a in out] == ["dz:1", "dz:4"]
    assert out[0]["tracks"] == 27
    assert {call.args[0] for call in search.call_args_list} == {"gear rising", "gear rising revengeance"}
    original = await album_candidates("gear rising revengeance", soundtrack=True)
    assert [a["ref"] for a in original] == ["dz:1"]
