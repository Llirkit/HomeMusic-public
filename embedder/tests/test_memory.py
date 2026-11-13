import asyncio
import ctypes
import json
import subprocess
import sys
import threading
import time
import weakref
from types import SimpleNamespace

import pytest

from app import memory, models
from app.worker import Engine


@pytest.mark.parametrize("device", ["cpu", "cuda"])
def test_close_collects_model_cycles_before_releasing_allocator_caches(monkeypatch, device):
    class Cycle:
        pass

    weights = Cycle()
    weights.self = weights
    ref = weakref.ref(weights)
    model = models.MuQMuLan.__new__(models.MuQMuLan)
    model.model, model.device = weights, device
    del weights
    calls = []

    def released(kind):
        assert ref() is None
        calls.append(kind)

    model._torch = SimpleNamespace(cuda=SimpleNamespace(empty_cache=lambda: released("cuda")))
    monkeypatch.setattr(models, "trim_allocator", lambda: released("heap"))
    model.close()
    assert model.model is None
    assert calls == (["cuda", "heap"] if device == "cuda" else ["heap"])


@pytest.mark.parametrize("failure", [OSError, AttributeError])
def test_native_cleanup_is_optional_on_unsupported_allocators(monkeypatch, failure):
    def unavailable(_):
        raise failure("not supported")

    monkeypatch.setattr(memory.ctypes, "CDLL", unavailable)
    assert memory.trim_allocator() is False


@pytest.mark.skipif(sys.platform != "linux" or not hasattr(ctypes.CDLL(None), "malloc_trim"), reason="glibc/Linux RSS test")
def test_real_native_heap_pages_return_to_os_after_model_close():
    # A separate process makes the RSS comparison independent of pytest/PyTorch caches.
    # Small native allocations stay in malloc arenas; a live tail allocation prevents a simple heap shrink.
    script = """
import json
import numpy as np
from app.memory import resident_bytes
from app.models import MuQMuLan
base = resident_bytes()
model = MuQMuLan.__new__(MuQMuLan)
model.device = 'cpu'
weights = [np.full(65536, 7, dtype=np.uint8) for _ in range(2048)]
weights.append(weights)
model.model = weights
del weights
guard = np.full(65536, 42, dtype=np.uint8)
loaded = resident_bytes()
model.close()
idle = resident_bytes()
assert (guard == 42).all()
print(json.dumps({'base': base, 'loaded': loaded, 'idle': idle}))
"""
    result = subprocess.run([sys.executable, "-c", script], check=True, capture_output=True, text=True, timeout=30)
    rss = json.loads(result.stdout)
    assert rss["loaded"] - rss["idle"] > 64 * 2**20, rss
    assert rss["idle"] < rss["base"] + 32 * 2**20, rss


class Model:
    device = "cpu"

    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


async def test_queued_request_reloads_after_an_unload_instead_of_using_closed_model(settings):
    instances = []

    def factory(_):
        model = Model()
        instances.append(model)
        return model

    engine = Engine(settings, factory, name="test")
    first = await engine.ensure()
    await engine.busy.acquire()
    unload = asyncio.create_task(engine.unload())
    await asyncio.sleep(0)
    call = asyncio.create_task(engine.run(lambda model: not model.closed))
    await asyncio.sleep(0)
    engine.busy.release()
    await unload
    assert await call
    assert first.closed and len(instances) == 2


@pytest.mark.parametrize("cancel", [False, True])
async def test_unload_waits_for_native_inference_even_when_request_is_cancelled(settings, cancel):
    model = Model()
    engine = Engine(settings, lambda _: model, name="test")
    entered, release = threading.Event(), threading.Event()

    def inference(m):
        entered.set()
        assert release.wait(5)
        assert not m.closed

    call = asyncio.create_task(engine.run(inference))
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        if cancel:
            call.cancel()
            await asyncio.sleep(0)
        unload = asyncio.create_task(engine.unload())
        await asyncio.sleep(0)
        assert not model.closed and not unload.done()
    finally:
        release.set()
    if cancel:
        with pytest.raises(asyncio.CancelledError):
            await call
    else:
        await call
    await unload
    assert model.closed


async def test_idle_deadline_is_rechecked_after_waiting_for_a_request(settings):
    model = Model()
    engine = Engine(settings, lambda _: model, name="test")
    await engine.ensure()
    await engine.busy.acquire()
    cleanup = asyncio.create_task(engine.unload(idle_for=300))
    await asyncio.sleep(0)
    engine.last_used = 0
    # A request completed while cleanup was waiting for the busy lock.
    engine.last_used = time.monotonic()
    engine.busy.release()
    await cleanup
    assert engine.model is model and not model.closed
