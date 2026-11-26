from datetime import timedelta

import pytest

from tests.support import app_client
from tests.test_mixes import env as env


def snapshot(position=43, autoplay=False):
    return {"queue": [{"ref": "nd:song1", "title": "Первая", "artist": "Кино", "duration_s": 180},
                      {"ref": "nd:song2", "title": "Вторая", "artist": "Кино", "duration_s": 120}],
            "index": 1, "context": "playlist:p1", "position": position, "autoplay": autoplay,
            "shuffle": True, "repeat": "all", "originalOrder": [1, 0]}


async def beat(client, device="computer-1", **kwargs):
    return await client.post("/api/playback/heartbeat", json={"device_id": device, "name": device, **kwargs})


async def test_handoff_resume_queue_fences_old_owner_and_survives_reconnect(env):
    pc = env["client"]
    async with app_client(env["app"], login=("admin", "pw")) as phone:
        assert (await beat(phone, "telephone-1")).status_code == 200
        result = await beat(pc, claim=True, snapshot=snapshot())
        assert result.status_code == 200, result.text
        state = result.json()
        assert state["revision"] == 1
        assert state["device_id"] == "computer-1"
        state = (await beat(phone, "telephone-1")).json()
        assert state["snapshot"]["position"] == 43
        assert state["snapshot"]["index"] == 1
        moved = await pc.post("/api/playback/transfer", json={"device_id": "telephone-1", "revision": 1})
        assert moved.status_code == 200, moved.text
        assert moved.json()["snapshot"]["autoplay"]
        assert moved.json()["snapshot"]["shuffle"]
        assert moved.json()["snapshot"]["originalOrder"] == [1, 0]
        stale = (await beat(pc, revision=1, snapshot=snapshot(2))).json()
        assert stale["snapshot"]["position"] == 43
        assert stale["device_id"] == "telephone-1"
        assert stale["revision"] == 2
        assert (await beat(pc, revision=1, claim=True, snapshot=snapshot())).status_code == 409
        assert (await pc.post("/api/playback/transfer", json={"device_id": "computer-1", "revision": 1})).status_code == 409
        assert (await beat(phone, "telephone-1", revision=2, snapshot=snapshot(60))).json()["snapshot"]["position"] == 60
    # A new authenticated session reads the same durable checkpoint.
    async with app_client(env["app"], login=("admin", "pw")) as reopened:
        checkpoint = (await beat(reopened, "reopened-1")).json()
        assert checkpoint["snapshot"]["position"] == 60
        assert checkpoint["snapshot"]["queue"][1]["ref"] == "nd:song2"


async def test_accounts_guests_and_expired_device_presence(env):
    from app.db import session_scope
    from app.models import PlaybackDevice, utcnow

    pc = env["client"]
    state = (await beat(pc, claim=True, snapshot=snapshot())).json()
    assert (await beat(pc, "telephone-1")).status_code == 200
    async with app_client(env["app"], login=("alice", "pw")) as other:
        assert (await beat(other, "computer-1")).json()["snapshot"] is None
        assert (await other.post("/api/playback/transfer", json={"device_id": "telephone-1", "revision": state["revision"]})).status_code == 409
        assert (await beat(other, account_id=env["admin"])).status_code == 403
    async with app_client(env["app"], login=None) as guest:
        assert (await beat(guest)).status_code == 401
        assert (await guest.post("/api/playback/transfer", json={"device_id": "telephone-1", "revision": 1})).status_code == 401
    async with session_scope() as s:
        device = await s.get(PlaybackDevice, (env["admin"], "telephone-1"))
        device.seen_at = utcnow() - timedelta(minutes=1)
    assert (await pc.post("/api/playback/transfer", json={"device_id": "telephone-1", "revision": 1})).status_code == 409
    assert [d["id"] for d in (await beat(pc)).json()["devices"]] == ["computer-1"]
    await beat(pc, ready=False)
    assert (await beat(pc, ready=False)).json()["devices"] == []


@pytest.mark.parametrize("update", [{"index": 8}, {"position": -1}, {"position": "Infinity"},
                                   {"queue": []}, {"originalOrder": [9]}])
async def test_invalid_checkpoint_rejected(env, update):
    body = {**snapshot(), **update}
    response = await beat(env["client"], claim=True, snapshot=body)
    assert response.status_code == 422
