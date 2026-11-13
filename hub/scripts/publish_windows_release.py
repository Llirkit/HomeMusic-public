"""Публикация проверенного NSIS-релиза: неизменяемые файлы, затем атомарный latest.yml.

Из hub/: uv run python scripts/publish_windows_release.py SOURCE TARGET
В контейнере: python scripts/publish_windows_release.py /data/release-staging /data/windows-releases
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.windows_releases import read_release


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return base64.b64encode(hashlib.file_digest(stream, "sha512").digest()).decode("ascii")


def publish(source: Path, target: Path) -> str:
    manifest = read_release(source)
    name = manifest["path"]
    if digest(source / name) != manifest["sha512"]:
        raise ValueError("Контрольная сумма установщика не совпадает с latest.yml")
    target.mkdir(parents=True, exist_ok=True)
    if (target / "latest.yml").exists():
        previous = read_release(target)
        version = lambda v: tuple(int(part) for part in v.split("."))  # noqa: E731
        if version(previous["version"]) > version(manifest["version"]):
            raise ValueError("Публикация более старой версии запрещена")
    for filename in (name, name + ".blockmap", "latest.yml"):
        destination = target / filename
        with tempfile.NamedTemporaryFile(dir=target, prefix=".publish-", delete=False) as stream:
            temporary = Path(stream.name)
            try:
                with (source / filename).open("rb") as incoming:
                    shutil.copyfileobj(incoming, stream)
                stream.flush()
                os.fsync(stream.fileno())
            except BaseException:
                temporary.unlink(missing_ok=True)
                raise
        try:
            if filename == "latest.yml":
                os.replace(temporary, destination)
            else:
                try:
                    if os.name == "nt":
                        # Windows rename is atomic and refuses to replace an existing destination;
                        # unlike hard links it also works on a WSL/SMB checkout.
                        os.rename(temporary, destination)
                    else:
                        os.link(temporary, destination)
                except FileExistsError:
                    if destination.is_symlink() or digest(destination) != digest(temporary):
                        raise ValueError(f"Опубликованный файл уже существует с другим содержимым: {filename}") from None
        finally:
            temporary.unlink(missing_ok=True)
    return manifest["version"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    args = parser.parse_args()
    print(f"Опубликован HomeMusic {publish(args.source, args.target)}")
