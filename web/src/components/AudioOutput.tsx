import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { hasNativeAudioOutput, hasOutputPicker, refreshAudioOutputs, requestAudioDeviceAccess, requestAudioOutput, selectAudioOutput,
  showNativeAudioOutput, supportsAudioOutput, useAudioOutput } from '../lib/audioOutput';
import { Button, IconButton, Sheet } from './ui';

export function AudioOutputButton({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const onClick = () => hasNativeAudioOutput() ? showNativeAudioOutput() : setOpen(true);
  return <>
    {compact ? <IconButton icon="speaker" label="Аудиовыход" onClick={onClick} /> :
      <Button icon="speaker" block onClick={onClick}>Аудиовыход</Button>}
    {open && createPortal(<AudioOutputSheet onClose={() => setOpen(false)} />, document.body)}
  </>;
}

function AudioOutputSheet({ onClose }: { onClose: () => void }) {
  const { selected, devices, busy, error } = useAudioOutput();
  const supported = supportsAudioOutput();
  useEffect(() => { void refreshAudioOutputs(); }, []);
  return <Sheet open onClose={onClose} title="Аудиовыход">
    {supported ? <div className="space-y-3" aria-busy={busy}>
      <p className="text-sm text-muted">Куда воспроизводить музыку на этом устройстве.</p>
      <label className="label" htmlFor="hm-audio-output">Устройство</label>
      <select id="hm-audio-output" className="input min-h-11" value={selected} disabled={busy}
        onChange={e => void selectAudioOutput(e.target.value)}>
        <option value="">Системный выход</option>
        {selected && !devices.some(d => d.deviceId === selected) && <option value={selected}>Сохранённое устройство</option>}
        {devices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
      </select>
      {busy && <p role="status" className="text-sm text-muted">Переключаем звук…</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button icon="refresh" disabled={busy} onClick={() => void refreshAudioOutputs()}>Обновить список</Button>
        {hasOutputPicker() && <Button disabled={busy} onClick={() => void requestAudioOutput()}>Выбрать устройство…</Button>}
      </div>
      {!devices.length && <p className="text-sm text-muted">Браузер пока показывает только системный выход. Выберите устройство в настройках звука системы{hasOutputPicker() ? ' или нажмите «Выбрать устройство…»' : ''}.</p>}
      {!devices.length && !hasOutputPicker() && typeof navigator.mediaDevices.getUserMedia === 'function' && <div className="space-y-2">
        <p className="text-sm text-muted">Для показа всех выходов этот браузер требует разрешение микрофона. Аудиопоток сразу закрывается, запись не ведётся.</p>
        <Button disabled={busy} onClick={() => void requestAudioDeviceAccess()}>Разрешить и показать устройства</Button>
      </div>}
    </div> : <p className="text-sm text-muted">Этот браузер не поддерживает выбор аудиовыхода. Выберите наушники или колонки в настройках звука устройства. В браузере на компьютере откройте HomeMusic по HTTPS.</p>}
  </Sheet>;
}
