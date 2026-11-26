import { deviceId, refreshPlaybackDevices, transferPlayback, useConnect } from '../lib/connect';
import { Button } from './ui';

export function PlaybackDevices() {
  const state = useConnect();
  if (!state.available) return null;
  const owner = state.devices.find(d => d.id === state.device_id);
  return <section aria-label="Устройства аккаунта" className="space-y-3 border-b border-line pb-4">
    <h3 className="font-bold">Слушать на устройстве</h3>
    <p className="text-sm text-muted">{owner ? `Сейчас выбрано: ${owner.name}.` : 'Продолжите последнее прослушивание на любом устройстве.'} Откройте HomeMusic под тем же аккаунтом на телефоне или компьютере.</p>
    <ul className="space-y-2">{state.devices.map(device => <li key={device.id}>
      <Button block disabled={state.busy || !state.snapshot} onClick={() => void transferPlayback(device.id)}>
        {device.name}{device.id === deviceId ? ' (это устройство)' : ''}{device.id === state.device_id ? ' · Выбрано' : ''}
      </Button>
    </li>)}</ul>
    {!state.snapshot && <p className="text-sm text-muted">Включите трек, чтобы передать его на другое устройство.</p>}
    {state.busy && <p role="status" className="text-sm text-muted">Переносим воспроизведение…</p>}
    {state.error && <p role="alert" className="text-sm text-danger">{state.error}</p>}
    <Button small disabled={state.busy} onClick={refreshPlaybackDevices}>Обновить устройства</Button>
  </section>;
}

export function PlaybackLocation() {
  const state = useConnect();
  if (!state.snapshot || state.device_id === deviceId) return null;
  const owner = state.devices.find(d => d.id === state.device_id);
  return <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2 text-sm">
    <span className="text-muted">{owner ? `Выбрано: ${owner.name}` : 'Последнее прослушивание'}</span>
    <Button small disabled={state.busy} onClick={() => void transferPlayback(deviceId)}>Продолжить здесь</Button>
    {state.error && <p role="alert" className="w-full text-danger">{state.error}</p>}
  </div>;
}
