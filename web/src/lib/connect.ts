import { useSyncExternalStore } from 'react';
import { ApiError, errorMessage, request } from '../api/client';
import { adoptPlayback, getListenState, pause, playbackCheckpoint, previewPlayback, restoreListening, subscribeListening, type SavedSession } from './listen';
import { restoreWave } from './wave';

export interface PlaybackDevice { id: string; name: string }
interface AccountPlayback { revision: number; device_id: string | null; snapshot: SavedSession | null; devices: PlaybackDevice[] }
interface ConnectView extends AccountPlayback { busy: boolean; error: string | null; available: boolean }
let view: ConnectView = { revision: 0, device_id: null, snapshot: null, devices: [], busy: false, error: null, available: false };
const listeners = new Set<() => void>();
function emit(patch: Partial<ConnectView>) { view = { ...view, ...patch }; for (const fn of listeners) fn(); }
export const useConnect = () => useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => view);

// A tab is a player: separate browser tabs must not share a lease. sessionStorage survives reloads.
export const deviceId = (() => {
  let id: string | null = null;
  try { id = sessionStorage.getItem('hm-device-id'); } catch { /* optional storage */ }
  if (!id) { id = crypto.randomUUID?.() ?? `device-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  try { sessionStorage.setItem('hm-device-id', id); } catch { /* optional storage */ }
  return id;
})();
const deviceName = /HomeMusicMobile/.test(navigator.userAgent) ? 'Телефон Android' :
  /Electron/.test(navigator.userAgent) ? 'Приложение Windows' : /Android|iPhone|iPad/.test(navigator.userAgent) ? 'Браузер телефона' : 'Браузер компьютера';
let account: number | null = null;
let generation = 0;
let applying = false;
let initialized = false;
let inFlight = false;
let claim = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastLocal: SavedSession | null = null;
let adoptedRevision = -1;
let refreshOnly = false;
let actionError = false;
let dismissedRevision = -1;

function syncNative() {
  if (!initialized || account === null || !view.available) return;
  window.SpotikConnect?.command(JSON.stringify({ op: 'connect', enabled: true, account_id: account,
    device_id: deviceId, name: deviceName, revision: view.revision, owner: view.device_id === deviceId,
    snapshot: playbackCheckpoint() ?? lastLocal }));
}

function schedule(delay = 0) {
  clearTimeout(timer);
  if (account !== null) timer = setTimeout(() => void heartbeat(), delay);
}

function adopt(saved: SavedSession, autoplay: boolean, preview = false) {
  applying = true;
  try { if (preview) previewPlayback(saved); else adoptPlayback(saved, autoplay); restoreWave(account, true); }
  finally { applying = false; lastLocal = playbackCheckpoint(); }
}

function receive(result: AccountPlayback) {
  if (!Number.isInteger(result.revision) || !Array.isArray(result.devices)) return;
  const wasOwner = view.device_id === deviceId;
  emit({ ...result, available: true, error: actionError ? view.error : null });
  const owner = result.device_id === deviceId;
  if (initialized && wasOwner && !owner) {
    applying = true;
    try { pause(); } finally { applying = false; }
  }
  if (result.snapshot && (!initialized || owner && adoptedRevision !== result.revision)) {
    if (!initialized) restoreListening(account, false);
    adopt(result.snapshot, owner && result.snapshot.autoplay, !owner);
    adoptedRevision = result.revision;
  } else if (result.snapshot && !owner && !claim && dismissedRevision !== result.revision) {
    adopt(result.snapshot, false, true);
  }
}

async function heartbeat() {
  if (window.SpotikConnect && document.hidden) return schedule(2000);
  if (account === null || inFlight || view.busy) return schedule(1000);
  inFlight = true;
  const run = generation;
  const taking = claim;
  claim = false;
  try {
    const local = playbackCheckpoint() ?? lastLocal;
    const result = await request<AccountPlayback>('POST', '/api/playback/heartbeat', {
      json: { account_id: account, device_id: deviceId, name: deviceName, revision: view.revision,
        snapshot: initialized && !refreshOnly && (taking || view.device_id === deviceId) ? local : null, claim: taking },
      signal: AbortSignal.timeout(10000),
    });
    if (run !== generation) return;
    // A successful local claim already has the desired queue; do not reload its audio.
    if (taking && result.device_id === deviceId) adoptedRevision = result.revision;
    const valid = Number.isInteger(result.revision) && Array.isArray(result.devices);
    receive(result);
    if (refreshOnly && result.device_id === deviceId && result.snapshot) adopt(result.snapshot, result.snapshot.autoplay);
    refreshOnly = false;
    if (!initialized) {
      initialized = true;
      if (!valid || !result.snapshot) {
        restoreListening(account);
        restoreWave(account);
        lastLocal = playbackCheckpoint();
        claim = !!lastLocal;
      }
    }
    syncNative();
  } catch (e) {
    if (run !== generation) return;
    if (e instanceof ApiError && e.status === 409) {
      applying = true;
      try { pause(); } finally { applying = false; }
    }
    emit({ error: errorMessage(e) });
    if (!initialized) {
      initialized = true;
      restoreListening(account); restoreWave(account);
      lastLocal = playbackCheckpoint();
      claim = !!lastLocal;
    }
  } finally {
    if (run === generation) { inFlight = false; schedule(claim ? 0 : 2000); }
  }
}

subscribeListening(() => {
  const current = playbackCheckpoint();
  if (applying || !initialized || account === null) return;
  if (!current && lastLocal) dismissedRevision = view.revision;
  if (current?.autoplay && (!lastLocal?.autoplay || current.queue[current.index]?.ref !== lastLocal.queue[lastLocal.index]?.ref)
      && view.device_id !== deviceId) claim = true;
  const changed = current?.autoplay !== lastLocal?.autoplay || current?.index !== lastLocal?.index ||
    current?.queue !== lastLocal?.queue || Math.abs((current?.position ?? 0) - (lastLocal?.position ?? 0)) > 2;
  if (current) lastLocal = current;
  else if (lastLocal) lastLocal = { ...lastLocal, autoplay: false };
  if (changed) { schedule(100); syncNative(); }
});

export function connectAccount(next: number | null) {
  if (next === account) return;
  generation++; clearTimeout(timer);
  // Disable the native background lease before changing accounts.
  window.SpotikConnect?.command(JSON.stringify({ op: 'connect', enabled: false }));
  account = next; initialized = false; inFlight = false; claim = false; lastLocal = null; adoptedRevision = -1;
  refreshOnly = false;
  actionError = false;
  dismissedRevision = -1;
  emit({ revision: 0, device_id: null, snapshot: null, devices: [], busy: false, error: null, available: false });
  restoreListening(null); restoreWave(null);
  if (next !== null) schedule();
}

/** The same action handles resuming here and selecting a different logged-in player. */
export async function transferPlayback(target: string) {
  if (view.busy || account === null || !view.snapshot && !getListenState().track) return;
  const run = generation;
  actionError = false;
  emit({ busy: true, error: null });
  clearTimeout(timer);
  try {
    // Serialize after an outstanding heartbeat, then save the exact position before pausing the sender.
    while (inFlight && run === generation) await new Promise(resolve => setTimeout(resolve, 25));
    if (run !== generation) return;
    if (view.device_id === deviceId || claim) {
      const taking = claim;
      claim = false;
      applying = true;
      try { pause(); } finally { applying = false; }
      const saved = await request<AccountPlayback>('POST', '/api/playback/heartbeat', { json: {
        account_id: account, device_id: deviceId, name: deviceName, revision: view.revision, snapshot: playbackCheckpoint() ?? lastLocal,
        claim: taking,
      }, signal: AbortSignal.timeout(10000) });
      if (run !== generation) return;
      if (taking && saved.device_id === deviceId) adoptedRevision = saved.revision;
      receive(saved);
    }
    const result = await request<AccountPlayback>('POST', '/api/playback/transfer', { json: {
      device_id: target, revision: view.revision, autoplay: true,
    }, signal: AbortSignal.timeout(10000) });
    if (run !== generation) return;
    receive(result);
    syncNative();
  } catch (e) {
    if (run === generation) { actionError = true; emit({ error: errorMessage(e) }); }
  } finally {
    if (run === generation) { emit({ busy: false }); schedule(); }
  }
}

export function refreshPlaybackDevices() { actionError = false; emit({ error: null }); schedule(); }

window.addEventListener('hm:resume-playback', event => {
  if (account !== null && view.available && view.snapshot && view.device_id !== deviceId) {
    event.preventDefault();
    void transferPlayback(deviceId);
  }
});

document.addEventListener('visibilitychange', () => {
  if (window.SpotikConnect && !document.hidden) { refreshOnly = true; schedule(); }
});

declare global {
  interface Window { SpotikConnect?: { command(json: string): void }; hmConnect?: (result: AccountPlayback) => void }
}
