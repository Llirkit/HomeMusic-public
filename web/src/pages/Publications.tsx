import { useEffect, useRef, useState } from 'react';
import { ApiError, request } from '../api/client';
import type { CatalogTrack, TrackOut } from '../api/types';
import { PublicationLink, type Publication } from '../components/PublicationActions';
import { TrackRow, playAll } from '../components/catalog';
import { Button, Cover, Empty, ErrorState, Loading, PageHeader } from '../components/ui';
import { useAsync } from '../lib/hooks';
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
}

declare global {
  interface Window {
    SpotikRadio?: { command(json: string): void };
    hmAndroidRadio?: (snapshot: { id: string; state: number; playing?: boolean; playWhenReady?: boolean }) => void;
  }
}

export function RadioPage({ token }: { token: string }) {
  const [data, setData] = useState<Broadcast>();
  const [error, setError] = useState<string>();
  const [playing, setPlaying] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const desired = useRef(false);
  const timing = useRef({ position: 0, received: 0 });
  const current = useRef('');
  const toggleRef = useRef<() => void>(() => {});
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    stopListening();
    const mountedAudio = audio.current;
    const native = window.SpotikRadio;
    if (native) window.hmAndroidRadio = (s) => {
      if (s.id !== `radio:${token}`) return;
      setPlaying(!!s.playing);
      setConnecting(s.state >= 0 && !!s.playWhenReady && !s.playing);
      if (s.state === -1) desired.current = false;
      else if (s.state === -2) setError('Не удалось подключиться к эфиру. Повторите попытку.');
      else desired.current = !!s.playWhenReady;
    };
    if (native && desired.current) native.command(JSON.stringify({ op: 'radio', id: `radio:${token}`, token }));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await request<Broadcast>('GET', `/api/publications/${token}/radio`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        timing.current = { position: value.position_s, received: performance.now() };
        setData(value); setError(undefined);
        const a = audio.current;
        if (a && !native) {
          if (current.current !== value.stream_url || a.error) {
            current.current = value.stream_url;
            a.src = value.stream_url;
            a.load();
          } else if (a.readyState >= 1 && Math.abs(a.currentTime - value.position_s) > 2) {
            a.currentTime = value.position_s;
          }
          if (desired.current && a.paused && !a.ended) void a.play().catch(() => { desired.current = false; setPlaying(false); setConnecting(false); setError('Нажмите «Слушать эфир», чтобы продолжить.'); });
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : 'Нет связи с эфиром');
        audio.current?.pause();
        setConnecting(false);
        if (e instanceof ApiError && e.status === 404) {
          setData(undefined); desired.current = false;
          audio.current?.removeAttribute('src'); audio.current?.load(); current.current = '';
          native?.command(JSON.stringify({ op: 'stop', id: `radio:${token}` }));
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
      }
    };
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
    if (a) a.currentTime = Math.max(0, timing.current.position + (performance.now() - timing.current.received) / 1000);
  };
  const toggle = () => {
    if (window.SpotikRadio) {
      if (!desired.current) stopListening();
      window.SpotikRadio.command(JSON.stringify({ op: desired.current ? 'stop' : 'radio', id: `radio:${token}`, token }));
      desired.current = !desired.current;
      setConnecting(desired.current);
      if (!desired.current) setPlaying(false);
      return;
    }
    const a = audio.current;
    if (!a || !data) return;
    if (desired.current) { desired.current = false; a.pause(); setPlaying(false); setConnecting(false); }
    else {
      stopListening(); sync(); desired.current = true; setConnecting(true);
      void a.play().catch(() => { desired.current = false; setPlaying(false); setConnecting(false); setError('Не удалось включить эфир. Попробуйте ещё раз.'); });
    }
  };
  toggleRef.current = toggle;
  return <main className="mx-auto min-h-dvh max-w-2xl p-4">
    <h1 className="py-4 text-2xl font-bold">{data?.title || 'Онлайн-радио'}</h1>
    <p className="mb-6 text-sm text-muted">Общий эфир · Вход не нужен</p>
    <audio ref={audio} preload="none" onLoadedMetadata={sync} onWaiting={() => setConnecting(desired.current)} onPlaying={() => { setPlaying(true); setConnecting(false); }} onPause={() => setPlaying(false)} onError={() => { setConnecting(false); setError('Не удалось загрузить песню. Повторите подключение или дождитесь следующей.'); }} />
    {!data && !error && <Loading text="Подключаемся к эфиру…" />}
    {data && <section className="flex flex-col items-center gap-4 text-center">
      <Cover src={data.track.cover_url} alt="" className="aspect-square w-56 max-w-full" />
      <div aria-live="polite"><h2 className="text-xl font-bold">{data.track.title}</h2><p className="text-muted">{data.track.artist}</p></div>
      <Button variant="primary" icon={playing || connecting ? 'pause' : 'play'} aria-busy={connecting} onClick={toggle}>{connecting ? 'Подключаемся… Отменить' : desired.current ? 'Отключиться от эфира' : 'Слушать эфир'}</Button>
      <p className="text-sm text-muted">При подключении вы услышите текущее место эфира.</p>
    </section>}
    {error && <ErrorState text={error} onRetry={() => { current.current = ''; setRetry((v) => v + 1); }} />}
    <Link to="/home" className="mt-6 flex min-h-12 items-center justify-center text-accent underline">Открыть HomeMusic</Link>
  </main>;
}
