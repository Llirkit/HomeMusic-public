import { useEffect, useRef, useState } from 'react';
import { ApiError, request } from '../api/client';
import type { CatalogTrack, TrackOut } from '../api/types';
import { PublicationLink, RadioStreamLink, type Publication } from '../components/PublicationActions';
import { RadioManager } from '../components/RadioManager';
import { RadioSoundControls, useRadioSound } from '../components/RadioSound';
import { TrackRow, playAll } from '../components/catalog';
import { Button, Cover, Empty, ErrorState, Loading, PageHeader } from '../components/ui';
import { useAsync } from '../lib/hooks';
import { fmtDuration } from '../lib/format';
import { stopListening } from '../lib/listen';
import { Link } from '../lib/router';
import { attempt, confirmDialog } from '../lib/ui';

export function SharedMusicPage({ token }: { token: string }) {
  const res = useAsync((signal) => request<Publication & { tracks: TrackOut[] }>('GET', `/api/publications/${token}`, { signal }), [token]);
  const p = res.data;
  return <>
    <PageHeader title={p?.title || 'Музыка по ссылке'} back="/home" />
    {res.loading ? <Loading /> : !p ? <ErrorState text={res.error || 'Ссылка недоступна'} onRetry={() => res.reload()} /> : <>
      <div className="space-y-3 p-4">
        <p className="text-sm text-muted">{p.tracks.length} треков · Подборка по ссылке</p>
        <Button variant="primary" icon="play" disabled={!p.tracks.length} onClick={() => playAll(p.tracks)}>Слушать всё</Button>
        {p.owner && <Link className="flex min-h-11 items-center text-accent underline" to="/publications">Управлять ссылкой</Link>}
      </div>
      {p.tracks.map((t, i) => <TrackRow key={`${i}:${t.ref}`} track={t} queue={p.tracks} link={false} />)}
    </>}
  </>;
}

export function PublicationsPage() {
  const res = useAsync((signal) => request<Publication[]>('GET', '/api/publications', { signal }), []);
  const [busy, setBusy] = useState<string>();
  const revoke = async (p: Publication) => {
    const isRadio = p.kind === 'radio';
    if (!await confirmDialog({ title: isRadio ? 'Остановить эфир?' : 'Отозвать ссылку?', body: isRadio ? 'Все слушатели будут отключены. Старый адрес перестанет работать.' : 'Получатели больше не смогут открыть подборку.', okLabel: isRadio ? 'Остановить' : 'Отозвать', danger: true })) return;
    setBusy(p.id);
    try {
      if (await attempt(() => request('DELETE', `/api/publications/${p.id}`))) res.reload();
    } finally { setBusy(undefined); }
  };
  return <>
    <PageHeader title="Мои ссылки и радио" back="/more" />
    {res.loading ? <Loading /> : res.error ? <ErrorState text={res.error} onRetry={() => res.reload()} /> : !res.data?.length ?
      <Empty icon="send" title="Пока нет ссылок" text="Поделитесь треком, плейлистом или миксом. Из плейлиста или играющей волны можно создать радио." /> :
      <div className="space-y-4 p-4">{res.data.map((p) => <section className="space-y-3 rounded-xl bg-raised p-4" key={p.id}>
        <h2 className="break-words font-bold">{p.kind === 'radio' ? 'Радио: ' : ''}{p.title}</h2>
        <PublicationLink publication={p} />
        <Button variant="danger" disabled={!!busy} busy={busy === p.id} onClick={() => void revoke(p)}>{p.kind === 'radio' ? 'Остановить эфир' : 'Отозвать ссылку'}</Button>
      </section>)}</div>}
  </>;
}

interface Broadcast extends Publication {
  track: CatalogTrack; position_s: number; duration_s: number; stream_url: string;
  paused: boolean; revision: number; index: number; queue_count: number; can_manage: boolean;
}

declare global {
  interface Window {
    SpotikRadio?: { command(json: string): void; soundVersion?: () => number };
    hmAndroidRadio?: (snapshot: { id: string; state: number; playing?: boolean; playWhenReady?: boolean; radioConnected?: boolean; eqSupported?: boolean }) => void;
  }
}

export function RadioPage({ token }: { token: string }) {
  const [data, setData] = useState<Broadcast>();
  const [error, setError] = useState<string>();
  const [playing, setPlaying] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const sound = useRadioSound(audio, token);
  const clockPaused = useRef(false);
  const reloadBroadcast = useRef<() => void>(() => {});
  const [, setTick] = useState(0);
  const desired = useRef(false);
  const timing = useRef({ position: 0, received: 0 });
  const current = useRef('');
  const toggleRef = useRef<() => void>(() => {});
  const [retry, setRetry] = useState(0);
  useEffect(() => { const timer = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    stopListening();
    const mountedAudio = audio.current;
    const native = window.SpotikRadio;
    if (native) window.hmAndroidRadio = (s) => {
      if (s.id !== `radio:${token}`) return;
      setPlaying(!!s.playing);
      setConnecting(!clockPaused.current && s.state >= 0 && !!s.playWhenReady && !s.playing);
      if (typeof s.eqSupported === 'boolean') sound.setSupported(s.eqSupported);
      if (s.state === -1) desired.current = false;
      else if (s.state === -2) setError('Не удалось подключиться к эфиру. Повторите попытку.');
      else if (typeof s.radioConnected === 'boolean') desired.current = s.radioConnected;
      else if (!clockPaused.current) desired.current = !!s.playWhenReady;
    };
    if (native && desired.current) {
      native.command(JSON.stringify({ op: 'radio', id: `radio:${token}`, token, ...sound.nativeSettings() }));
      native.command(JSON.stringify({ op: 'volume', id: `radio:${token}`, volume: sound.nativeSettings().volume }));
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let nonce = 0;
    const poll = async () => {
      const requestId = ++nonce;
      clearTimeout(timer);
      try {
        const value = await request<Broadcast>('GET', `/api/publications/${token}/radio`, { signal: controller.signal });
        if (controller.signal.aborted || requestId !== nonce) return;
        timing.current = { position: value.position_s, received: performance.now() };
        const changedPause = clockPaused.current !== !!value.paused;
        clockPaused.current = !!value.paused;
        setData(value); setError(undefined);
        if (value.paused) setConnecting(false);
        // Native 1.3.16+ also follows the shared clock in the background. Older clients can follow it while open.
        if (native && !native.soundVersion && desired.current && changedPause) native.command(JSON.stringify({ op: value.paused ? 'pause' : 'play', id: `radio:${token}` }));
        const a = audio.current;
        if (a && !native) {
          if (current.current !== value.stream_url || a.error) {
            current.current = value.stream_url;
            a.src = value.stream_url;
            a.load();
          } else if (a.readyState >= 1 && Math.abs(a.currentTime - value.position_s) > 2) {
            a.currentTime = value.position_s;
          }
          if (value.paused) a.pause();
          else if (desired.current && a.paused && !a.ended) {
            await sound.prepare();
            if (!controller.signal.aborted && requestId === nonce && desired.current && !clockPaused.current) void a.play().catch(() => { if (controller.signal.aborted) return; desired.current = false; setPlaying(false); setConnecting(false); setError('Нажмите «Слушать эфир», чтобы продолжить.'); });
          }
        }
      } catch (e) {
        if (controller.signal.aborted || requestId !== nonce) return;
        setError(e instanceof Error ? e.message : 'Нет связи с эфиром');
        audio.current?.pause();
        setConnecting(false);
        if (e instanceof ApiError && e.status === 404) {
          setData(undefined); desired.current = false;
          audio.current?.removeAttribute('src'); audio.current?.load(); current.current = '';
          native?.command(JSON.stringify({ op: 'stop', id: `radio:${token}` }));
        }
      } finally {
        if (!controller.signal.aborted && requestId === nonce) timer = setTimeout(poll, 3000);
      }
    };
    reloadBroadcast.current = () => { void poll(); };
    void poll();
    return () => {
      controller.abort(); clearTimeout(timer); mountedAudio?.pause(); current.current = '';
      native?.command(JSON.stringify({ op: 'stop', id: `radio:${token}` }));
      if (native) delete window.hmAndroidRadio;
    };
  }, [token, retry]);
  useEffect(() => {
    const bridge = window.HomeMusicDesktop;
    const unsubscribe = bridge?.onCommand((command) => { if (command === 'toggle') toggleRef.current(); });
    return () => {
      unsubscribe?.();
      bridge?.updatePlayer({ active: false, playing: false, canNext: false, canPrevious: false, title: '', artist: '' });
      if (!window.SpotikRadio && 'mediaSession' in navigator) navigator.mediaSession.metadata = null;
    };
  }, [token]);
  useEffect(() => {
    if (!data) return;
    document.title = `${data.title} · Радио HomeMusic`;
    window.HomeMusicDesktop?.updatePlayer({ active: true, playing: playing || connecting, canNext: false,
      canPrevious: false, title: data.track.title, artist: data.track.artist });
    if (!window.SpotikRadio && 'mediaSession' in navigator && typeof MediaMetadata !== 'undefined') {
      navigator.mediaSession.metadata = new MediaMetadata({ title: data.track.title, artist: data.track.artist, album: data.title });
      navigator.mediaSession.setActionHandler('play', () => { if (!desired.current) toggleRef.current(); });
      navigator.mediaSession.setActionHandler('pause', () => { if (desired.current) toggleRef.current(); });
      navigator.mediaSession.setActionHandler('nexttrack', null);
      navigator.mediaSession.setActionHandler('previoustrack', null);
      navigator.mediaSession.setActionHandler('seekto', null);
    }
  }, [data?.track.ref, data?.title, playing, connecting]);
  const sync = () => {
    const a = audio.current;
    if (a) a.currentTime = Math.max(0, timing.current.position + (clockPaused.current ? 0 : (performance.now() - timing.current.received) / 1000));
  };
  const toggle = () => {
    setTick((n) => n + 1);
    if (window.SpotikRadio) {
      if (!desired.current) stopListening();
      window.SpotikRadio.command(JSON.stringify({ op: desired.current ? 'stop' : 'radio', id: `radio:${token}`, token, ...sound.nativeSettings() }));
      desired.current = !desired.current;
      if (desired.current) window.SpotikRadio.command(JSON.stringify({ op: 'volume', id: `radio:${token}`, volume: sound.nativeSettings().volume }));
      setConnecting(desired.current && !clockPaused.current);
      if (!desired.current) setPlaying(false);
      return;
    }
    const a = audio.current;
    if (!a || !data) return;
    if (desired.current) { desired.current = false; a.pause(); setPlaying(false); setConnecting(false); }
    else {
      stopListening(); sync(); desired.current = true; setConnecting(!clockPaused.current);
      if (!clockPaused.current) void sound.prepare().then(() => { if (desired.current && !clockPaused.current) return a.play(); }).catch(() => { desired.current = false; setPlaying(false); setConnecting(false); setError('Не удалось включить эфир. Попробуйте ещё раз.'); });
    }
  };
  toggleRef.current = toggle;
  // A read-only timeline describes the shared broadcast, even when this listener is disconnected.
  const position = data ? Math.max(0, Math.min(data.duration_s, timing.current.position + (data.paused ? 0 : (performance.now() - timing.current.received) / 1000))) : 0;

  return <main className="mx-auto min-h-dvh max-w-2xl p-4">
    <h1 className="py-4 text-2xl font-bold">{data?.title || 'Онлайн-радио'}</h1>
    <p className="mb-6 text-sm text-muted">Общий эфир · Вход не нужен</p>
    <audio ref={audio} preload="none" onLoadedMetadata={sync} onWaiting={() => setConnecting(desired.current)} onPlaying={() => { setPlaying(true); setConnecting(false); }} onPause={() => setPlaying(false)} onError={() => { setConnecting(false); setError('Не удалось загрузить песню. Повторите подключение или дождитесь следующей.'); }} />
    {!data && !error && <Loading text="Подключаемся к эфиру…" />}
    {data && <section className="flex flex-col items-center gap-4 text-center">
      <Cover src={data.track.cover_url} alt="" className="aspect-square w-56 max-w-full" />
      <div aria-live="polite"><h2 className="text-xl font-bold">{data.track.title}</h2><p className="text-muted">{data.track.artist}</p></div>
      <div className="w-full space-y-1 text-sm text-muted">
        <progress aria-label="Ход текущей песни в эфире" className="h-2 w-full accent-accent" max={data.duration_s || 1} value={position} />
        <div className="flex justify-between"><span>{fmtDuration(position)}</span><span>{fmtDuration(data.duration_s)}</span></div>
      </div>
      {data.paused && <p role="status" className="font-semibold text-accent">Эфир на паузе</p>}
      <Button variant="primary" icon={playing || connecting ? 'pause' : 'play'} aria-busy={connecting} onClick={toggle}>{connecting ? 'Подключаемся… Отменить' : desired.current ? 'Отключиться от эфира' : 'Слушать эфир'}</Button>
      <p className="text-sm text-muted">При подключении вы услышите текущее место эфира.</p>
    </section>}
    <div className="mt-6"><RadioSoundControls sound={sound} /></div>
    {data?.live_url && <div className="mt-6"><RadioStreamLink url={data.live_url} /></div>}
    {data?.can_manage && <div className="mt-6"><RadioManager token={token} revision={data.revision} index={data.index} paused={!!data.paused} position={position} duration={data.duration_s} onChanged={() => reloadBroadcast.current()} /></div>}
    {error && <ErrorState text={error} onRetry={() => { current.current = ''; setRetry((v) => v + 1); }} />}
    <Link to="/home" className="mt-6 flex min-h-12 items-center justify-center text-accent underline">Открыть HomeMusic</Link>
  </main>;
}
