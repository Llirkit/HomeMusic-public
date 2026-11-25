from datetime import timedelta

import pytest

from app.models import Publication, utcnow
from tests.support import app_client
from tests.test_mixes import env as env


@pytest.fixture
def playlist(monkeypatch):
    from app.library.navidrome import NavidromeClient

    songs = [{"id": "song1", "title": "Первая", "artist": "Кино", "duration": 120},
             {"id": "song2", "title": "Вторая", "artist": "Кино", "duration": 180}]

    async def get_playlist(self, id_):
        return {"id": id_, "owner": "admin", "name": "В дороге", "entry": songs if id_ != "empty" else []}

    monkeypatch.setattr(NavidromeClient, "get_playlist", get_playlist)
    return songs


async def publish(client, kind="share", source_kind="playlist", source_id="p1"):
    r = await client.post("/api/publications", json={"kind": kind, "source_kind": source_kind, "source_id": source_id})
    assert r.status_code == 200, r.text
    return r.json()


async def test_share_requires_login_but_another_account_can_listen_without_editing(env, playlist):
    c = env["client"]
    p = await publish(c)
    assert (await publish(c))["id"] == p["id"]  # double tap/retry returns the same snapshot
    async with app_client(env["app"], login=None) as guest:
        assert (await guest.get(f"/api/publications/{p['id']}")).status_code == 401
        assert (await guest.get("/api/publications")).status_code == 401
    async with app_client(env["app"], login=("alice", "pw")) as other:
        r = await other.get(f"/api/publications/{p['id']}")
        assert r.status_code == 200
        assert r.json()["owner"] is False
        assert [t["title"] for t in r.json()["tracks"]] == ["Первая", "Вторая"]
        assert (await other.delete(f"/api/publications/{p['id']}")).status_code == 404
        assert (await other.get("/api/publications")).json() == []
        assert (await other.post("/api/publications", json={"source_kind": "playlist", "source_id": "p1"})).status_code == 403
    assert (await c.delete(f"/api/publications/{p['id']}")).status_code == 200
    assert (await c.get(f"/api/publications/{p['id']}")).status_code == 404


async def test_radio_common_clock_repeat_scope_and_revoke(env, playlist, monkeypatch):
    from app.api import publications
    from app.db import session_scope

    c = env["client"]
    p = await publish(c, "radio")
    assert (await publish(c, "radio"))["id"] == p["id"]
    now = utcnow()
    async with session_scope() as s:
        row = await s.get(Publication, p["id"])
        row.started_at = now - timedelta(seconds=145)
    monkeypatch.setattr(publications, "utcnow", lambda: now)
    async with app_client(env["app"], login=None) as a, app_client(env["app"], login=None) as b:
        first = await a.get(f"/api/publications/{p['id']}/radio")
        second = await b.get(f"/api/publications/{p['id']}/radio")
        assert first.status_code == 200, first.text
        assert first.json() == second.json()
        assert first.json()["track"]["title"] == "Вторая"
        assert first.json()["position_s"] == 25
        assert (await a.get(f"/api/publications/{p['id']}/audio/0?v=nd:song1")).status_code == 409
        assert (await a.get(f"/api/publications/{p['id']}/audio/1?v=nd:other")).status_code == 409
        monkeypatch.setattr(publications, "utcnow", lambda: now + timedelta(seconds=300))
        assert (await a.get(f"/api/publications/{p['id']}/radio")).json()["position_s"] == 25
        assert (await c.delete(f"/api/publications/{p['id']}")).status_code == 200
        assert (await a.get(f"/api/publications/{p['id']}/radio")).status_code == 404
        assert (await a.get(f"/api/publications/{p['id']}/audio/1?v=nd:song2")).status_code == 404


async def test_empty_invalid_missing_and_station_limit(env, playlist):
    c = env["client"]
    assert (await c.post("/api/publications", json={"source_kind": "playlist", "source_id": "empty"})).status_code == 409
    assert (await c.post("/api/publications", json={"kind": "radio", "source_kind": "mix", "source_id": "1"})).status_code == 400
    assert (await c.post("/api/publications", json={"source_kind": "mix", "source_id": "not-a-number"})).status_code == 404
    assert (await c.get("/api/publications/missing")).status_code == 404
    for i in range(3):
        await publish(c, "radio", source_id=str(i))
    assert (await c.post("/api/publications", json={"kind": "radio", "source_kind": "playlist", "source_id": "fourth"})).status_code == 409
    assert len((await c.get("/api/publications")).json()) == 3


async def test_radio_only_exposes_its_current_audio(env, playlist, monkeypatch):
    from app.api import listen

    p = await publish(env["client"], "radio")
    called = []

    async def fake_stream(ref, request, **kwargs):
        from fastapi.responses import Response
        called.append((ref, kwargs))
        return Response(b"audio", media_type="audio/mpeg")

    monkeypatch.setattr(listen, "media_response", fake_stream)
    async with app_client(env["app"], login=None) as guest:
        r = await guest.get(f"/api/publications/{p['id']}/audio/0?v=nd:song1&ref=nd:private")
        assert r.content == b"audio"
        assert called[0][0] == "nd:song1"
        assert called[0][1]["full"] is True
        assert called[0][1]["record_listen"] is False


async def test_track_and_mix_snapshots_are_readable_after_login_and_hide_scoring(env):
    from app.db import session_scope
    from app.models import Mix, MixItem
    from app.services import svc

    track = svc.deezer.track
    shared_track = await publish(env["client"], source_kind="track", source_id=track.ref)
    assert (await env["client"].get(f"/api/publications/{shared_track['id']}")).json()["tracks"][0]["title"] == track.title
    async with session_scope() as s:
        mix = Mix(user_id=env["admin"], title="Личный микс", mode="normal")
        s.add(mix)
        await s.flush()
        mix_id = mix.id
        s.add(MixItem(mix_id=mix_id, position=0, state="active", ref=track.ref, generator="favorites",
                      score=123, features_json={"track": track.model_dump(mode="json")}))
    published = await publish(env["client"], source_kind="mix", source_id=str(mix_id))
    async with app_client(env["app"], login=("alice", "pw")) as other:
        data = (await other.get(f"/api/publications/{published['id']}")).json()
        assert data["title"] == "Личный микс"
        assert "score" not in data["tracks"][0]
        assert (await other.post("/api/publications", json={"source_kind": "mix", "source_id": str(mix_id)})).status_code == 404


async def test_wave_radio_owns_its_session_and_refills_once_for_all_listeners(env, monkeypatch):
    from app.api import publications
    from app.db import session_scope
    from app.mixes import wave
    from app.mixes.build import Cand
    from app.models import WaveSession
    from app.services import svc

    original = "original-wave"
    async with session_scope() as s:
        s.add(WaveSession(id=original, user_id=env["admin"], mode="discover", seed_json={"ref": "dz:100"}))
    starts, refills = [], []

    async def start(user, seed, mode, **kwargs):
        starts.append((user.id, seed, mode))
        return wave.Batch("radio-wave", "Волна по треку", mode, seed, [Cand(svc.deezer.track)], False)

    async def next_batch(user, sid):
        refills.append(sid)
        track = svc.deezer.track.model_copy(update={"ref": "dz:101", "id": "101", "title": "Следующая"})
        return wave.Batch(sid, "Волна по треку", "discover", None, [Cand(track)], False)

    monkeypatch.setattr(wave, "start", start)
    monkeypatch.setattr(wave, "radio_batch", next_batch)
    p = await publish(env["client"], "radio", "wave", original)
    assert starts == [(env["admin"], {"ref": "dz:100"}, "discover")]
    now = utcnow()
    async with session_scope() as s:
        row = await s.get(Publication, p["id"])
        assert row.wave_id != original
        row.started_at = now - timedelta(seconds=246)
    monkeypatch.setattr(publications, "utcnow", lambda: now)
    async with app_client(env["app"], login=None) as a, app_client(env["app"], login=None) as b:
        first = await a.get(f"/api/publications/{p['id']}/radio")
        second = await b.get(f"/api/publications/{p['id']}/radio")
        assert first.status_code == 200, first.text
        assert first.json() == second.json()
        assert first.json()["track"]["title"] == "Следующая"
        assert refills == ["radio-wave"]
