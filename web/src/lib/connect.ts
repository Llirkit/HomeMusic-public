import { useSyncExternalStore } from 'react';
import { ApiError, errorMessage, request } from '../api/client';
import { adoptPlayback, applyPlayback, getDeviceVolume, getListenState, pause, playbackCheckpoint, previewPlayback,
  previewPosition, restoreListening, subscribeListening, type SavedSession } from './listen';
import { registerPlaybackController, type PlaybackCommand } from './playbackControl';
import { restoreWave } from './wave';

export interface PlaybackDevice { id: string; name: string; volume?: number }
interface AccountPlayback {
  revision: number; device_id: string | null; snapshot: SavedSession | null; devices: PlaybackDevice[];
  applied_revision?: number; updated_at_ms?: number; pending?: boolean; action?: string; snapshot_age_s?: number;
}
interface ConnectView extends AccountPlayback { busy: boolean; error: string | null; available: boolean }
const empty = (): ConnectView => ({ revision: 0, device_id: null, snapshot: null, devices: [], busy: false, error: null, available: false });
let view = empty();
const listeners = new Set<() => void>();
function emit(patch: Partial<ConnectView>) {
  view = { ...view, ...patch }; window.hmConnectRevision = view.revision;
  for (const fn of listeners) fn();
}
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const useConnect = () => useSyncExternalStore(subscribe, () => view);

const uuid = () => crypto.randomUUID?.() ?? `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const deviceId = (() => {
  let id: string | null = null;
  try { id = sessionStorage.getItem('hm-device-id'); } catch { /* optional storage */ }
  id ||= uuid();
  try { sessionStorage.setItem('hm-device-id', id); } catch { /* optional storage */ }
  return id;
})();
const deviceName = window.SpotikConnect?.deviceName?.() || (/HomeMusicMobile/.test(navigator.userAgent) ? 'Телефон Android' :
  /Electron/.test(navigator.userAgent) ? 'Приложение Windows' : /Android|iPhone|iPad/.test(navigator.userAgent) ? 'Браузер телефона' : 'Браузер компьютера');
let account: number | null = null, generation = 0, adoptedRevision = -1, dismissedRevision = -1;
let applying = false, initialized = false, inFlight = false, claim = false, refreshOnly = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastLocal: SavedSession | null = null;
let operations = Promise.resolve();
let remoteClock: { position: number; at: number; duration: number } | null = null;
const active = () => view.devices.some(d => d.id === view.device_id);
const controlled = (fn: () => void) => { const before = applying; applying = true; try { fn(); } finally { applying = before; } };
function syncNative() {
  if (!initialized || account === null || !view.available) return;
  window.SpotikConnect?.command(JSON.stringify({ op: 'connect', enabled: true, account_id: account, device_id: deviceId,
    name: deviceName, revision: view.revision, owner: view.device_id === deviceId,
    snapshot: view.device_id === deviceId ? playbackCheckpoint() ?? lastLocal : view.snapshot }));
}
function schedule(delay = 0) { clearTimeout(timer); if (account !== null) timer = setTimeout(() => void heartbeat(), delay); }
function receive(result: AccountPlayback) {
  if (!Number.isInteger(result.revision) || !Array.isArray(result.devices) || result.revision < view.revision) return;
  if (result.revision === view.revision && (result.updated_at_ms ?? 0) < (view.updated_at_ms ?? 0)) return;
  const wasOwner = view.device_id === deviceId;
  emit({ ...result, available: true });
  const owner = result.device_id === deviceId;
  if (!initialized && result.snapshot) restoreListening(account, false);
  if (wasOwner && !owner) controlled(pause);
  remoteClock = null;
  if (result.snapshot && owner && (!initialized || adoptedRevision !== result.revision || refreshOnly)) {
    controlled(() => { applyPlayback(result.snapshot!, result.action ?? 'transfer'); restoreWave(account, true); });
    adoptedRevision = result.revision;
    lastLocal = playbackCheckpoint();
  } else if (result.snapshot && !owner && !claim && dismissedRevision !== result.revision) {
    const saved = { ...result.snapshot };
    if (!active()) { saved.autoplay = false; saved.phase = 'paused'; }
    const duration = saved.queue[saved.index]?.duration_s || 86400;
    saved.position = Math.min(duration, saved.position + (saved.autoplay && !result.pending ? result.snapshot_age_s ?? 0 : 0));
    controlled(() => previewPlayback(saved));
    if (saved.autoplay && !result.pending) remoteClock = { position: saved.position, at: performance.now(), duration };
  }
}
async function poll(readOnly = false) {
  return await request<AccountPlayback>('POST', '/api/playback/heartbeat', { json: {
    account_id: account, device_id: deviceId, name: deviceName, volume: getDeviceVolume(), revision: view.revision,
    snapshot: !readOnly && initialized && view.device_id === deviceId ? playbackCheckpoint() ?? lastLocal : null,
  }, signal: AbortSignal.timeout(10000) });
}
async function heartbeat() {
  if (account === null || inFlight || view.busy || window.SpotikConnect && document.hidden) return schedule(1000);
  inFlight = true;
  const run = generation, taking = claim;
  claim = false;
  try {
    const result = taking ? await request<AccountPlayback>('POST', '/api/playback/heartbeat', { json: {
      account_id: account, device_id: deviceId, name: deviceName, volume: getDeviceVolume(), revision: view.revision,
      snapshot: playbackCheckpoint() ?? lastLocal, claim: true,
    }, signal: AbortSignal.timeout(10000) }) : await poll(refreshOnly || !initialized);
    if (run !== generation) return;
    if (taking && result.device_id === deviceId) adoptedRevision = result.revision;
    receive(result);
    refreshOnly = false;
    if (!initialized) {
      initialized = true;
      if (!result.snapshot) { restoreListening(account); restoreWave(account); lastLocal = playbackCheckpoint(); claim = !!lastLocal; }
    }
    syncNative();
  } catch (e) {
    if (run !== generation) return;
    if (e instanceof ApiError && e.status === 409) { controlled(pause); refreshOnly = true; }
    emit({ error: errorMessage(e) });
    if (!initialized) { initialized = true; restoreListening(account); restoreWave(account); }
  } finally { if (run === generation) { inFlight = false; schedule(claim ? 0 : 1000); } }
}

subscribeListening(() => {
  const current = playbackCheckpoint(), state = getListenState();
  if (applying || !initialized || account === null || state.remote) return;
  if (!current) dismissedRevision = view.revision;
  if (current?.autoplay && view.device_id !== deviceId) claim = true;
  const changed = current?.autoplay !== lastLocal?.autoplay || current?.index !== lastLocal?.index ||
    current?.queue !== lastLocal?.queue || current?.phase !== lastLocal?.phase;
  if (current) lastLocal = current;
  else if (lastLocal) lastLocal = { ...lastLocal, autoplay: false, phase: 'paused' };
  if (changed) { schedule(50); syncNative(); }
});

export function connectAccount(next: number | null) {
  if (next === account) return;
  generation++; clearTimeout(timer);
  window.SpotikConnect?.command(JSON.stringify({ op: 'connect', enabled: false }));
  account = next; initialized = false; inFlight = false; claim = false; refreshOnly = false;
  adoptedRevision = -1; dismissedRevision = -1; lastLocal = null; remoteClock = null; operations = Promise.resolve();
  view = empty(); emit({});
  controlled(() => { restoreListening(null); restoreWave(null); });
  if (next !== null) schedule();
}
const wait = () => new Promise(resolve => setTimeout(resolve, 25));
async function command(intent: PlaybackCommand, run: number) {
  const deadline = Date.now() + 11000;
  while ((!initialized || inFlight || view.busy) && run === generation && Date.now() < deadline) await wait();
  if (run !== generation) return;
  if (inFlight || view.busy) { emit({ error: 'Нет ответа от устройства. Повторите действие.' }); return; }
  if (!active() && (intent.action === 'start' || intent.action === 'play' || intent.action === 'toggle')) {
    const saved = intent.snapshot ?? view.snapshot;
    if (!saved) return;
    controlled(() => { adoptPlayback({ ...saved, volume: getDeviceVolume() }, true); restoreWave(account, true); });
    lastLocal = playbackCheckpoint(); claim = true; await heartbeat(); return;
  }
  emit({ busy: true, error: null });
  const id = uuid();
  const revision = view.revision;
  const indexed = ['remove', 'move', 'play_index'].includes(intent.action);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await request<AccountPlayback>('POST', '/api/playback/command', {
          json: { ...intent, command_id: id, revision: indexed ? revision : view.revision }, signal: AbortSignal.timeout(10000),
        });
        if (run === generation) { receive(result); syncNative(); }
        break;
      } catch (e) {
        if (run !== generation) return;
        if (attempt || indexed && e instanceof ApiError && e.status === 409) throw e;
        const result = await poll(true);
        if (run !== generation) return;
        receive(result);
      }
    }
  } catch (e) { if (run === generation) emit({ error: errorMessage(e) }); }
  finally { if (run === generation) { emit({ busy: false }); schedule(); } }
}
registerPlaybackController(intent => {
  if (applying || account === null) return false;
  if (initialized && (view.device_id === deviceId || !view.available && !getListenState().remote)) return false;
  const run = generation;
  operations = operations.then(() => command(intent, run)).catch(e => { if (run === generation) emit({ error: errorMessage(e) }); });
  return true;
});

/** Selecting an output transfers the shared session and preserves its paused/playing state. */
export async function transferPlayback(target: string) {
  if (view.busy || account === null || target === view.device_id) return;
  const run = generation;
  emit({ busy: true, error: null }); clearTimeout(timer);
  try {
    while (inFlight && run === generation) await wait();
    if (run !== generation) return;
    if (view.device_id === deviceId) {
      const saved = await poll();
      if (run !== generation) return;
      receive(saved);
    }
    const result = await request<AccountPlayback>('POST', '/api/playback/transfer', { json: {
      device_id: target, revision: view.revision,
    }, signal: AbortSignal.timeout(10000) });
    if (run === generation) { receive(result); syncNative(); }
  } catch (e) { if (run === generation) emit({ error: errorMessage(e) }); }
  finally { if (run === generation) { emit({ busy: false }); schedule(); } }
}
export function refreshPlaybackDevices() { emit({ error: null }); refreshOnly = true; schedule(); }
window.addEventListener('hm:connect-refresh', refreshPlaybackDevices);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshOnly = true; schedule(); } });
setInterval(() => {
  if (remoteClock && !document.hidden) controlled(() => previewPosition(Math.min(remoteClock!.duration,
    remoteClock!.position + (performance.now() - remoteClock!.at) / 1000)));
}, 250);
declare global {
  interface Window {
    SpotikConnect?: { command(json: string): void; deviceName?(): string };
    hmConnectRevision?: number;
  }
}
