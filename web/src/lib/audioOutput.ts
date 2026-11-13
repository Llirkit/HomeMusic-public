import { useSyncExternalStore } from 'react';
import { setLoudnessOutput } from './waveAudio';
import { toast } from './ui';

const KEY = 'hm-audio-output';
type Output = { deviceId: string; label: string };
type OutputState = { selected: string; devices: Output[]; busy: boolean; error: string };
let saved = '';
try { saved = localStorage.getItem(KEY) ?? ''; } catch { /* optional storage */ }
let state: OutputState = { selected: saved, devices: [], busy: false, error: '' };
const subscribers = new Set<() => void>();
let audio: HTMLAudioElement | null = null;
let listening = false;
let refreshId = 0;
let restoring: Promise<void> = Promise.resolve();
export const audioOutputReady = () => restoring;
const subscribe = (fn: () => void) => { subscribers.add(fn); return () => { subscribers.delete(fn); }; };
const update = (patch: Partial<OutputState>) => { state = { ...state, ...patch }; subscribers.forEach(fn => fn()); };
export const useAudioOutput = () => useSyncExternalStore(subscribe, () => state);

type NativeOutput = { showAudioOutput?: () => void };
const native = () => (window as unknown as { SpotikOffline?: NativeOutput }).SpotikOffline;
export const hasNativeAudioOutput = () => typeof native()?.showAudioOutput === 'function';
export const showNativeAudioOutput = () => native()?.showAudioOutput?.();
export const supportsAudioOutput = () => typeof HTMLMediaElement.prototype.setSinkId === 'function' && !!navigator.mediaDevices;
type OutputPicker = MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };
export const hasOutputPicker = () => typeof (navigator.mediaDevices as OutputPicker | undefined)?.selectAudioOutput === 'function';

function save(id: string) {
  try { localStorage.setItem(KEY, id); } catch { /* optional storage */ }
}

async function route(id: string) {
  if (audio) await audio.setSinkId(id);
  await setLoudnessOutput(id);
}

export async function selectAudioOutput(id: string) {
  if (state.busy || !supportsAudioOutput()) return;
  update({ busy: true, error: '' });
  await restoring;
  const previous = state.selected;
  try {
    await route(id);
    update({ selected: id });
    save(id);
  } catch {
    await route(previous).catch(() => {});
    update({ error: 'Не удалось переключить звук. Проверьте подключение и разрешения устройства.' });
  } finally { update({ busy: false }); }
}

export async function refreshAudioOutputs() {
  if (!supportsAudioOutput()) return;
  const nonce = ++refreshId;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices())
      .filter(d => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Аудиоустройство ${i + 1}` }));
    if (nonce === refreshId) update({ devices });
  } catch { if (nonce === refreshId) update({ error: 'Не удалось получить список устройств. Попробуйте ещё раз.' }); }
}

/** Explicit browser dialog: no microphone access is requested just to play music. */
export async function requestAudioOutput() {
  const devices = navigator.mediaDevices as OutputPicker | undefined;
  if (!devices?.selectAudioOutput || state.busy) return;
  try {
    const device = await devices.selectAudioOutput();
    update({ devices: [...state.devices.filter(d => d.deviceId !== device.deviceId), device] });
    await selectAudioOutput(device.deviceId);
    await refreshAudioOutputs();
  } catch (error) {
    if ((error as Error).name !== 'NotAllowedError') update({ error: 'Не удалось открыть выбор устройства.' });
  }
}

/** Chromium may hide the output list until media-device access is granted. Only run after an explicit click. */
export async function requestAudioDeviceAccess() {
  if (state.busy) return;
  update({ busy: true, error: '' });
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());
    await refreshAudioOutputs();
  } catch {
    update({ error: 'Доступ к списку устройств не предоставлен. Можно использовать системный выход.' });
  } finally { update({ busy: false }); }
}

/** Register the one audio element; its output survives track and queue changes. */
export function attachAudioOutput(element: HTMLAudioElement) {
  audio = element;
  if (!supportsAudioOutput()) return;
  if (state.selected) {
    restoring = route(state.selected).catch(async () => {
      await route('').catch(() => {});
      save('');
      update({ selected: '', error: 'Сохранённый аудиовыход недоступен. Используется системный выход.' });
      toast('Сохранённый аудиовыход недоступен. Используется системный выход.');
    });
  }
  if (!listening) {
    listening = true;
    navigator.mediaDevices.addEventListener('devicechange', () => {
      const selected = state.selected;
      void refreshAudioOutputs().then(async () => {
        if (!selected || state.selected !== selected || state.devices.some(d => d.deviceId === selected)) return;
        await selectAudioOutput('');
        if (!state.selected) toast('Аудиоустройство отключено. Используется системный выход.');
      });
    });
  }
}
