"""Validated electron-builder Windows feeds; publishing replaces the manifest last."""

from __future__ import annotations

import base64
import re
from pathlib import Path

import yaml

VERSION = re.compile(r"\d+\.\d+\.\d+")
ARTIFACT = re.compile(r"HomeMusic-Setup-\d+\.\d+\.\d+\.exe(?:\.blockmap)?")


def artifact(directory: Path, name: str) -> Path:
    if not ARTIFACT.fullmatch(name):
        raise ValueError("Недопустимое имя Windows-релиза")
    path = directory / name
    if path.is_symlink() or not path.is_file() or path.resolve().parent != directory.resolve():
        raise ValueError("Файл Windows-релиза не найден")
    return path


def read_release(directory: Path) -> dict:
    path = directory / "latest.yml"
    if path.is_symlink() or path.stat().st_size > 64 * 1024:
        raise ValueError("Недопустимый манифест Windows-релиза")
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8-sig"))
    except yaml.YAMLError as error:
        raise ValueError("Не удалось прочитать манифест Windows-релиза") from error
    if not isinstance(data, dict) or not isinstance(data.get("version"), str) or not VERSION.fullmatch(data["version"]):
        raise ValueError("Недопустимая версия Windows-релиза")
    name = f"HomeMusic-Setup-{data['version']}.exe"
    files = data.get("files")
    if not isinstance(files, list) or len(files) != 1 or not isinstance(files[0], dict):
        raise ValueError("Ожидается один установщик Windows x64")
    entry = files[0]
    if entry.get("url") != name or data.get("path") != name or data.get("sha512") != entry.get("sha512"):
        raise ValueError("Манифест ссылается на другой установщик")
    digest = entry.get("sha512")
    if not isinstance(digest, str) or len(base64.b64decode(digest, validate=True)) != 64:
        raise ValueError("Недопустимая контрольная сумма Windows-релиза")
    size = entry.get("size")
    if type(size) is not int or size <= 0 or artifact(directory, name).stat().st_size != size:
        raise ValueError("Размер Windows-релиза не совпадает с манифестом")
    artifact(directory, name + ".blockmap")
    return data
