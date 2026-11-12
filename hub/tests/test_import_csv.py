"""External Spotify CSV exports are metadata lists, never shared service-ID assertions."""

import pytest

from app.imports.sources import text, track_csv
from app.imports.sources.base import SourceError


@pytest.mark.parametrize("encoding", ["utf-8", "utf-8-sig", "utf-16", "cp1251"])
def test_csv_quotes_unicode_metadata_order_and_duplicates(encoding):
    data = ('Track URI,ISRC,Track Name,Album Name,Artist Name(s),Duration (ms),Added By,Genres\r\n'
            'spotify:track:untrusted,USAAA2600001,"Песня, часть 1","Альбом ""Новый""",Кино;ДДТ,170584,private-id,"rock,indie"\r\n'
            ',,Song,,"Artist, The Creator",2000,,\r\n'
            'spotify:track:another-id,,"Песня, часть 1",Other,Кино;ДДТ,170584,,\r\n')
    snap = track_csv.parse(data.encode(encoding), r"C:\exports\Liked_Songs.csv")
    collection = snap.collections[0]
    assert collection.title == "Liked_Songs" and collection.kind == "playlist"
    assert [i.raw for i in collection.items] == [
        {"artist": "Кино, ДДТ", "title": "Песня, часть 1", "artists": ["Кино", "ДДТ"],
         "album": 'Альбом "Новый"', "duration_s": 171},
        {"artist": "Artist, The Creator", "title": "Song", "artists": ["Artist, The Creator"], "duration_s": 2},
    ]
    assert "private-id" not in repr(snap) and "untrusted" not in repr(snap)


def test_csv_semicolon_separator_multiline_titles_and_empty_rows():
    snap = track_csv.parse(b'\n  \nTrack Name;Artist Name(s);Album Name\n"First\nsecond";Artist;Album\n;;\n')
    assert snap.collections[0].items[0].raw["title"] == "First\nsecond"


@pytest.mark.parametrize("data", [
    "", "Track Name,Artist Name(s)\n", "Name,Artist\nSong,Artist\n",
    "Track Name,Artist Name(s),Track Name\nSong,Artist,Song\n",
    "Track Name,Artist Name(s)\nSong\n", "Track Name,Artist Name(s)\n,Artist\n",
    "Track Name,Artist Name(s)\nSong,;\n", 'Track Name,Artist Name(s)\n"Unclosed,Artist\n',
    "Track Name,Artist Name(s),Duration (ms)\nSong,Artist,NaN\n",
    "Track Name,Artist Name(s),Duration (ms)\nSong,Artist,-1\n",
    "Track Name,Artist Name(s),Duration (ms)\nSong,Artist,86400001\n",
])
def test_invalid_csv_has_no_partial_success(data):
    with pytest.raises(SourceError):
        track_csv.parse(data.encode())


def test_csv_limits_before_deduplication(monkeypatch):
    monkeypatch.setattr(text, "MAX_ITEMS", 2)
    with pytest.raises(SourceError, match="2 песен"):
        track_csv.parse(b"Track Name,Artist Name(s)\nSong,Artist\nSong,Artist\nSong,Artist")
    with pytest.raises(SourceError, match="слишком длинное"):
        track_csv.parse(("Track Name,Artist Name(s)\n" + "x" * 1001 + ",Artist").encode())
    with pytest.raises(SourceError, match="1 МБ"):
        track_csv.parse(b"x" * (text.MAX_BYTES + 1))
