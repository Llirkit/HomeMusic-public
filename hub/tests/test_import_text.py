"""Text exports are untrusted metadata: preserve user intent and keep matching out of the shared ID cache."""

import pytest

from app.imports.sources import text
from app.imports.sources.base import SourceError


@pytest.mark.parametrize("encoding", ["utf-8", "utf-8-sig", "utf-16", "cp1251"])
def test_text_list_encodings_order_duplicates_and_titles(encoding):
    data = "# Мой экспорт\r\n1. Кино — Группа крови\r\n• ДДТ - Осень\r\nКино – Группа крови\r\nНазвание без исполнителя\r\n"
    snap = text.parse(data.encode(encoding), r"C:\exports\Дорога.txt")
    assert snap.collections[0].title == "Дорога"
    assert [i.raw for i in snap.collections[0].items] == [
        {"artist": "Кино", "title": "Группа крови"},
        {"artist": "ДДТ", "title": "Осень"},
        {"artist": "", "title": "Название без исполнителя"},
    ]


@pytest.mark.parametrize("data", [b"", b"# Empty\n", b"abc\x00def", b"https://example.com/playlist", b"- "])
def test_bad_lists_are_rejected_without_partial_import(data):
    with pytest.raises(SourceError):
        text.parse(data)


def test_limits_count_input_rows_before_deduplication(monkeypatch):
    monkeypatch.setattr(text, "MAX_ITEMS", 2)
    with pytest.raises(SourceError, match="2 песен"):
        text.parse(b"Artist - Song\nArtist - Song\nArtist - Song")
    with pytest.raises(SourceError, match="1 МБ"):
        text.parse(b"a" * (text.MAX_BYTES + 1))
    with pytest.raises(SourceError, match="Строка 2"):
        text.parse(b"Good\n" + b"x" * (text.MAX_LINE_CHARS + 1))
