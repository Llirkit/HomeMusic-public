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
        assert not moved.json()["snapshot"]["autoplay"]  # transfer preserves pause
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


async def control(client, state, action, **extra):
    import uuid
    return await client.post("/api/playback/command", json={"command_id": uuid.uuid4().hex,
        "revision": state["revision"], "action": action, **extra})


async def test_remote_controls_keep_selected_output_and_require_acknowledgement(env):
    pc = env["client"]
    state = (await beat(pc, claim=True, snapshot=snapshot())).json()
    async with app_client(env["app"], login=("admin", "pw")) as phone:
        await beat(phone, "telephone-1", volume=0.2)
        state = (await control(phone, state, "play")).json()
        assert state["device_id"] == "computer-1" and state["snapshot"]["autoplay"]
        assert state["pending"]
        # A delayed heartbeat cannot undo a newer command.
        stale = (await beat(pc, revision=1, snapshot=snapshot(1))).json()
        assert stale["revision"] == state["revision"] and stale["snapshot"]["autoplay"]
        acknowledged = (await beat(pc, revision=state["revision"], snapshot=state["snapshot"])).json()
        assert not acknowledged["pending"]
        state = (await control(phone, state, "seek", position=64)).json()
        assert state["snapshot"]["position"] == 64
        state = (await control(phone, state, "pause")).json()
        assert not state["snapshot"]["autoplay"]
        state = (await control(phone, state, "volume", volume=0.35)).json()
        assert state["snapshot"]["volume"] == 0.35
        stale = (await beat(pc, revision=1, volume=1, snapshot=snapshot())).json()
        assert next(d["volume"] for d in stale["devices"] if d["id"] == "computer-1") == 0.35
        # Choosing another output keeps pause and uses that output's own loudness.
        state = (await phone.post("/api/playback/transfer", json={"revision": state["revision"], "device_id": "telephone-1"})).json()
        assert not state["snapshot"]["autoplay"] and state["snapshot"]["volume"] == 0.2
        state = (await control(pc, state, "play")).json()
        assert state["device_id"] == "telephone-1" and state["snapshot"]["autoplay"]


async def test_choose_device_before_music_and_start_remote_queue(env):
    pc = env["client"]
    await beat(pc)
    await beat(pc, "telephone-1", volume=0.4)
    state = (await pc.post("/api/playback/transfer", json={"revision": 0, "device_id": "telephone-1"})).json()
    assert state["snapshot"] is None and state["device_id"] == "telephone-1"
    response = await control(pc, state, "start", snapshot=snapshot())
    assert response.status_code == 200, response.text
    state = response.json()
    assert state["snapshot"]["index"] == 1 and state["snapshot"]["volume"] == 0.4
    assert state["snapshot"]["autoplay"] and state["device_id"] == "telephone-1"


async def test_queue_commands_retry_idempotency_concurrency_and_bounds(env):
    pc = env["client"]
    initial = snapshot()
    initial["index"] = 0
    initial["shuffle"] = False
    initial["originalOrder"] = None
    state = (await beat(pc, claim=True, snapshot=initial)).json()
    body = {"action": "next", "revision": state["revision"], "command_id": "retry-next-1"}
    first = await pc.post("/api/playback/command", json=body)
    assert first.status_code == 200, first.text
    state = first.json()
    assert state["snapshot"]["index"] == 1
    assert (await pc.post("/api/playback/command", json=body)).json()["revision"] == state["revision"]
    assert (await control(pc, {"revision": 1}, "pause")).status_code == 409
    state = (await control(pc, state, "add_next", tracks=[initial["queue"][0]])).json()
    state = (await control(pc, state, "append", tracks=[initial["queue"][0]])).json()
    assert len(state["snapshot"]["queue"]) == 4
    state = (await control(pc, state, "move", index=1, to_index=3)).json()
    assert state["snapshot"]["index"] == 3
    state = (await control(pc, state, "remove", index=0)).json()
    assert state["snapshot"]["index"] == 2
    assert (await control(pc, state, "remove", index=2)).status_code == 409
    assert (await control(pc, state, "play_index", index=40)).status_code == 422
    state = (await control(pc, state, "shuffle", shuffle=True)).json()
    assert state["snapshot"]["index"] == 0 and state["snapshot"]["shuffle"]
    state = (await control(pc, state, "shuffle", shuffle=False)).json()
    assert state["snapshot"]["index"] == 2
    state = (await control(pc, state, "repeat", repeat="one")).json()
    assert state["snapshot"]["repeat"] == "one"


async def test_commands_cannot_control_another_account_or_a_disconnected_output(env):
    from app.db import session_scope
    from app.models import PlaybackDevice, utcnow

    pc = env["client"]
    state = (await beat(pc, claim=True, snapshot=snapshot())).json()
    async with app_client(env["app"], login=("alice", "pw")) as other:
        assert (await control(other, state, "pause")).status_code == 409
    async with app_client(env["app"], login=None) as guest:
        assert (await control(guest, state, "pause")).status_code == 401
    async with session_scope() as s:
        (await s.get(PlaybackDevice, (env["admin"], "computer-1"))).seen_at = utcnow() - timedelta(minutes=1)
    assert (await control(pc, state, "pause")).status_code == 409
