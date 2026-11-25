import { useEffect, useRef, useState, type RefObject } from 'react';
import { attachAudioOutput, audioOutputReady, selectedAudioOutput } from '../lib/audioOutput';
import { EQ_FREQUENCIES, RadioEqualizer, readRadioSound, saveRadioSound, type RadioSoundSettings } from '../lib/radioSound';
import { AudioOutputButton } from './AudioOutput';
import { Button } from './ui';

export function useRadioSound(audio: RefObject<HTMLAudioElement | null>, token: string) {
  const [settings, setSettings] = useState(readRadioSound);
  const settingsRef = useRef(settings);
  const graph = useRef<RadioEqualizer | null>(null);
  const [error, setError] = useState('');
  const [supported, setSupported] = useState(() => window.SpotikRadio
    ? typeof window.SpotikRadio.soundVersion === 'function' : typeof AudioContext !== 'undefined');
  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    element.volume = settingsRef.current.volume;
    if (window.SpotikRadio) return;
    const equalizer = new RadioEqualizer(element, selectedAudioOutput());
    graph.current = equalizer;
    const detach = attachAudioOutput(element, (id) => equalizer.setOutput(id));
    return () => { detach(); equalizer.dispose(); if (graph.current === equalizer) graph.current = null; };
  }, [token]);
  const nativeSettings = () => ({ volume: settingsRef.current.volume, eq_enabled: settingsRef.current.enabled, eq_gains: settingsRef.current.gains });
  const change = (next: RadioSoundSettings) => {
    settingsRef.current = next; setSettings(next); saveRadioSound(next); setError('');
    if (audio.current) audio.current.volume = next.volume;
    const bridge = window.SpotikRadio;
    if (bridge) {
      bridge.command(JSON.stringify({ op: 'volume', id: `radio:${token}`, volume: next.volume }));
      if (supported) bridge.command(JSON.stringify({ op: 'equalizer', id: `radio:${token}`, ...nativeSettings() }));
    } else void graph.current?.apply(next).catch((e) => {
      setError(e instanceof Error ? e.message : 'Не удалось включить эквалайзер');
      const fallback = { ...settingsRef.current, enabled: false };
      settingsRef.current = fallback; setSettings(fallback); saveRadioSound(fallback);
    });
  };
  const prepare = async () => {
    await audioOutputReady();
    if (!graph.current) return;
    try { await graph.current.apply(settingsRef.current); }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось включить эквалайзер');
      // The graph only takes ownership after successful setup, so direct audio remains usable.
    }
    await graph.current.resume();
  };
  return { settings, change, prepare, nativeSettings, supported, setSupported, error };
}

export type RadioSoundController = ReturnType<typeof useRadioSound>;

export function RadioSoundControls({ sound }: { sound: RadioSoundController }) {
  const { settings, change, supported, error } = sound;
  const lastVolume = useRef(settings.volume || 0.65);
  const volume = Math.round(settings.volume * 100);
  return <section aria-label="Настройки звука радио" className="space-y-3 rounded-xl bg-raised p-4 text-left">
    <p className="text-sm text-muted">Настройки звука действуют только на вашем устройстве.</p>
    <div className="flex flex-wrap items-center gap-3">
      <label htmlFor="radio-volume" className="text-sm font-semibold">Громкость <output>{volume}%</output></label>
      <Button small onClick={() => {
        if (settings.volume > 0) { lastVolume.current = settings.volume; change({ ...settings, volume: 0 }); }
        else change({ ...settings, volume: lastVolume.current });
      }}>{settings.volume ? 'Выключить звук' : 'Включить звук'}</Button>
    </div>
    <input id="radio-volume" aria-label="Громкость радио" type="range" min={0} max={100} step={1} value={volume}
      className="h-11 w-full accent-accent" onChange={(e) => change({ ...settings, volume: Number(e.target.value) / 100 })} />
    <AudioOutputButton small />
    <details>
      <summary className="min-h-11 cursor-pointer py-3 font-semibold">Эквалайзер</summary>
      {!supported ? <p className="text-sm text-muted">{window.SpotikRadio ? 'Эквалайзер требует актуального приложения и поддержки на устройстве.' : 'Этот браузер не поддерживает эквалайзер. Громкость и выбор аудиовыхода остаются доступны.'}</p> : <div className="space-y-2">
        <label className="flex min-h-12 items-center gap-3"><input type="checkbox" checked={settings.enabled} onChange={(e) => change({ ...settings, enabled: e.target.checked })} />Включить эквалайзер</label>
        {EQ_FREQUENCIES.map((frequency, i) => <label key={frequency} className="flex min-h-12 items-center gap-3 text-sm">
          <span className="w-20 shrink-0">{frequency >= 1000 ? `${frequency / 1000} кГц` : `${frequency} Гц`}</span>
          <input aria-label={`Эквалайзер ${frequency} Гц`} type="range" min={-12} max={12} step={1} value={settings.gains[i]} disabled={!settings.enabled}
            className="h-11 min-w-0 flex-1 accent-accent" onChange={(e) => change({ ...settings, gains: settings.gains.map((gain, n) => n === i ? Number(e.target.value) : gain) })} />
          <output className="w-14 text-right">{settings.gains[i] > 0 ? '+' : ''}{settings.gains[i]} дБ</output>
        </label>)}
        <Button small onClick={() => change({ ...settings, gains: [0, 0, 0, 0, 0] })}>Сбросить эквалайзер</Button>
      </div>}
    </details>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </section>;
}
