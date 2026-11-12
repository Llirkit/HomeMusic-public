"""Track-list CSV exports (Exportify-style); account IDs and service IDs are ignored."""

from __future__ import annotations

import csv
import io
import re
from collections.abc import Iterator

from app.imports.sources import text
from app.imports.sources.base import SnapItem, Snapshot, SourceError


def _field(row: dict[str, str], name: str, line: int) -> str:
    value = row.get(name, "").strip()
    if len(value) > text.MAX_LINE_CHARS:
        raise SourceError(f"Строка {line}: значение {name} слишком длинное")
    return value


def _rows(decoded: str, delimiter: str) -> Iterator[tuple[int, list[str]]]:
    stream = io.StringIO(decoded, newline="")
    reader = csv.reader(stream, delimiter=delimiter, strict=True)
    while True:
        start = stream.tell()
        try:
            values = next(reader)
        except StopIteration:
            return
        except csv.Error as original:
            # Some external exports use JSON-style \" instead of CSV's "". Retry only
            # the failed logical record: valid rows and their literal backslashes stay intact.
            record = decoded[start:stream.tell()]
            if '\\"' not in record:
                raise SourceError(f"Строка {reader.line_num}: проверьте кавычки и разделители CSV") from original
            # csv's escapechar also consumes \ in paths/names; protect all non-quote backslashes.
            protected = re.sub(r'\\(?!")', r'\\\\', record)
            try:
                repaired = list(csv.reader(io.StringIO(protected, newline=""), delimiter=delimiter,
                                           escapechar="\\", strict=True))
                if len(repaired) != 1:
                    raise csv.Error("ambiguous record")
                values = repaired[0]
            except csv.Error as e:
                raise SourceError(f"Строка {reader.line_num}: проверьте кавычки и разделители CSV") from e
        yield reader.line_num, values


def parse(data: bytes, filename: str = "") -> Snapshot:
    decoded = text.decode(data)
    try:
        header_line = next((line for line in decoded.splitlines() if line.strip()), "")
        if not header_line:
            raise SourceError("В CSV нет песен")
        dialect = csv.Sniffer().sniff(header_line, delimiters=",;\t")
        rows = _rows(decoded, dialect.delimiter)
        _, header = next((line, row) for line, row in rows if any(v.strip() for v in row))
        headers = [name.strip().casefold() for name in header]
        if len(headers) > 128 or len(set(headers)) != len(headers):
            raise SourceError("В CSV повторяются названия колонок или их слишком много")
        required = {"track name", "artist name(s)"}
        if not required.issubset(headers):
            raise SourceError("Нужен CSV с колонками Track Name и Artist Name(s)")
        items: dict[str, SnapItem] = {}
        count = 0
        for line, values in rows:
            if not values or not any(value.strip() for value in values):
                continue
            count += 1
            if count > text.MAX_ITEMS:
                raise SourceError(f"В одном файле не больше {text.MAX_ITEMS} песен")
            if len(values) != len(headers):
                raise SourceError(f"Строка {line}: число значений не совпадает с колонками CSV")
            row = dict(zip(headers, values, strict=True))
            title, artist = _field(row, "track name", line), _field(row, "artist name(s)", line)
            artists = [name.strip() for name in artist.split(";") if name.strip()]
            if not title or not artists:
                raise SourceError(f"Строка {line}: укажите название песни и исполнителя")
            metadata: dict = {"artists": artists}
            if album := _field(row, "album name", line):
                metadata["album"] = album
            if duration := _field(row, "duration (ms)", line):
                if not duration.isascii() or not duration.isdecimal() or not 0 < int(duration) <= 86_400_000:
                    raise SourceError(f"Строка {line}: неверная длительность Duration (ms)")
                metadata["duration_s"] = max(1, round(int(duration) / 1000))
            item = text.track_item(", ".join(artists), title, **metadata)
            items.setdefault(item.external_id, item)
    except (csv.Error, StopIteration) as e:
        raise SourceError("Не удалось прочитать CSV. Проверьте заголовки, разделители и кавычки") from e
    if not items:
        raise SourceError("В CSV нет песен")
    return text.playlist(list(items.values()), filename)
