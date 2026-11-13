import base64
import hashlib
import importlib.util
from pathlib import Path

import httpx
import pytest
import yaml
from fastapi import FastAPI

from app.api import system


def release(directory, version="1.0.2", payload=b"windows-installer"):
    directory.mkdir(parents=True, exist_ok=True)
    name = f"HomeMusic-Setup-{version}.exe"
    digest = base64.b64encode(hashlib.sha512(payload).digest()).decode()
    (directory / name).write_bytes(payload)
    (directory / (name + ".blockmap")).write_bytes(b"blockmap")
    manifest = {"version": version, "files": [{"url": name, "sha512": digest, "size": len(payload)}], "path": name, "sha512": digest}
    (directory / "latest.yml").write_text(yaml.safe_dump(manifest), encoding="utf-8")
    return manifest


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(system, "_windows_dir", lambda: tmp_path)
    app = FastAPI()
    app.include_router(system.router)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_feed_is_public_fresh_and_supports_range_downloads(client, tmp_path):
    manifest = release(tmp_path)
    async with client:
        response = await client.get("/desktop/updates/windows/x64/latest.yml")
        assert response.status_code == 200
        assert yaml.safe_load(response.text) == manifest
        assert response.headers["cache-control"] == "no-store"
        latest = await client.get("/desktop/latest.exe")
        assert latest.status_code == 307
        result = await client.get(latest.headers["location"], headers={"Range": "bytes=0-6"})
        assert result.status_code == 206
        assert result.content == b"windows"
        assert "immutable" in result.headers["cache-control"]
        assert (await client.get(latest.headers["location"] + ".blockmap")).content == b"blockmap"


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["config.json", "..%2Fsecret.exe", "HomeMusic-Setup-1.0.2.exe.tmp", "latest.json"])
async def test_unpublished_and_unexpected_files_are_never_served(client, tmp_path, name):
    (tmp_path / "config.json").write_text("secret")
    async with client:
        assert (await client.get(f"/desktop/updates/windows/x64/{name}")).status_code == 404


@pytest.mark.asyncio
async def test_missing_broken_or_partial_releases_are_unavailable(client, tmp_path):
    async with client:
        assert (await client.get("/desktop/latest.exe")).status_code == 404
        (tmp_path / "latest.yml").write_text("[malformed")
        assert (await client.get("/desktop/updates/windows/x64/latest.yml")).status_code == 404
        manifest = release(tmp_path)
        (tmp_path / manifest["path"]).write_bytes(b"truncated")
        assert (await client.get("/desktop/latest.exe")).status_code == 404


def publisher():
    spec = importlib.util.spec_from_file_location("publish_windows", Path(__file__).parents[1] / "scripts/publish_windows_release.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.publish


def test_publishing_is_atomic_immutable_and_rejects_tampered_binaries(tmp_path):
    publish = publisher()
    source, target = tmp_path / "source", tmp_path / "published"
    original = release(source)
    assert publish(source, target) == "1.0.2"
    assert publish(source, target) == "1.0.2"  # repeat is safe
    release(source, version="1.0.3")
    (source / "HomeMusic-Setup-1.0.3.exe").write_bytes(b"wrong hash, but same size"[:17])
    with pytest.raises(ValueError):
        publish(source, target)
    assert yaml.safe_load((target / "latest.yml").read_text()) == original
    release(source, payload=b"different installer")
    with pytest.raises(ValueError, match="другим содержимым"):
        publish(source, target)
    assert (target / original["path"]).read_bytes() == b"windows-installer"
    release(source, version="1.0.1")
    with pytest.raises(ValueError, match="старой версии"):
        publish(source, target)
