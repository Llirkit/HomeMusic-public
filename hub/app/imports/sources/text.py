"""A local track list, independent of the service that exported it. No LLM or external IDs."""

from __future__ import annotations

import hashlib
import re
import unicodedata
from pathlib import PurePosixPath

from app.imports.sources.base import SnapCollection, SnapItem, Snapshot, SourceError

MAX_BYTES = 1024 * 1024
MAX_ITEMS = 10_000
MAX_LINE_CHARS = 1000
_PREFIX = re.compile(r"^\s*(?:\d+[.)]\s+|[-*•]\s+)")
_SEPARATOR = re.compile(r"\s+[-–—]\s+|\t+")


def parse(data: bytes, filename: str = "") -> Snapshot:
    if len(data) > MAX_BYTES:
        raise SourceError("Текстовый файл превышает 1 МБ")
    try:
        if data.startswith((b"\xff\xfe", b"\xfe\xff")):
            text = data.decode("utf-16")
        else:
            try:
                text = data.decode("utf-8-sig")
            except UnicodeDecodeError:
                text = data.decode("cp1251")
    except UnicodeError as e:
        raise SourceError("Не удалось прочитать текст. Сохраните файл в UTF-8") from e
    if any(ord(c) < 32 and c not in "\t\n\r" for c in text):
        raise SourceError("Нужен текстовый файл TXT со списком песен")

    items: dict[str, SnapItem] = {}
    count = 0
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        count += 1
        if count > MAX_ITEMS:
            raise SourceError(f"В одном файле не больше {MAX_ITEMS} песен")
        if len(line) > MAX_LINE_CHARS:
            raise SourceError(f"Строка {number} слишком длинная: не больше {MAX_LINE_CHARS} символов")
        line = _PREFIX.sub("", line, count=1).strip()
        parts = _SEPARATOR.split(line, maxsplit=1)
        artist, title = (parts[0].strip(), parts[1].strip()) if len(parts) == 2 else ("", line)
        if not title or title in {"-", "*", "•", "–", "—"} or re.search(r"\s[-–—]$", line) or (len(parts) == 2 and not artist):
            raise SourceError(f"Строка {number}: укажите название песни или «Исполнитель — Название»")
        if re.match(r"^(?:https?://|spotify:)", line, re.I):
            raise SourceError(f"Строка {number}: нужны названия песен, а не ссылки")
        key = unicodedata.normalize("NFKC", f"{artist}\0{title}").casefold()
        ident = hashlib.sha256(key.encode()).hexdigest()
        items.setdefault(ident, SnapItem(ident, {"artist": artist, "title": title}))
    if not items:
        raise SourceError("В файле нет песен. Добавьте по одной песне на строку")
    title = PurePosixPath(filename.replace("\\", "/")).stem.strip()[:120] or "Импорт из текста"
    return Snapshot(account=None, collections=[SnapCollection("playlist", "text", title, list(items.values()))])
