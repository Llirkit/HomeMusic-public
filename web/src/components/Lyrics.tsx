import { useEffect, useRef, useState } from 'react';
import { errorMessage, request, withQuery } from '../api/client';
import { fmtDuration } from '../lib/format';
import { seek, toggle, useListen, type ListenTrack } from '../lib/listen';
import { Button, IconButton, Spinner, cx } from './ui';

interface LyricsOut {
  ref: string;
  status: 'found' | 'not_found' | 'instrumental' | 'temporarily_unavailable';
  plain: string;
  lines: { start_ms: number; text: string }[];
  synced: boolean;
  duration_s: number | null;
  source: string | null;
  source_url: string | null;
}

/** Один экран для браузера, Electron и онлайн-плеера Android. */
export function LyricsButton({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const track = useListen((s) => s.track);
  return <>
    {compact ? (
      <IconButton icon="lyrics" label="Текст песни" onClick={() => setOpen(true)} />
    ) : (
      <Button icon="lyrics" block onClick={() => setOpen(true)}>Текст песни</Button>
    )}
    {open && track && <LyricsDialog onClose={() => setOpen(false)} />}
  </>;
}

function LyricsDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const track = useListen((s) => s.track);
  const phase = useListen((s) => s.phase);
  const position = useListen((s) => s.position);
  const duration = useListen((s) => s.duration);
  const playing = phase === 'playing' || phase === 'loading' || phase === 'resolving';
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // React StrictMode repeats effects; close() would enqueue a close event and dismiss the reopened dialog.
    return () => { document.body.style.overflow = previous; };
  }, []);

  return (
    <dialog ref={dialog} onClose={onClose} aria-labelledby="lyrics-title"
      className="m-auto h-[min(90dvh,56rem)] max-h-[100dvh] w-[min(100%,48rem)] max-w-full overflow-hidden rounded-2xl border border-line bg-bg p-0 text-fg shadow-2xl backdrop:bg-black/75">
      <div className="flex h-full flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="lyrics-title" className="text-lg font-bold">Текст песни</h2>
            <p className="truncate text-sm text-muted">{track?.artist} — {track?.title}</p>
          </div>
          <IconButton icon="x" label="Закрыть текст песни" onClick={onClose} autoFocus />
        </header>
        {track && <LyricsContent key={track.ref} track={track} />}
        <footer className="flex shrink-0 items-center gap-3 border-t border-line px-4 py-3">
          <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Пауза' : 'Слушать'} onClick={toggle} />
          <input type="range" className="hm-range min-w-0 flex-1" aria-label="Перемотка песни"
            min={0} max={duration || 1} step={0.1} value={Math.min(position, duration || 1)}
            disabled={!duration || phase === 'resolving' || phase === 'error'}
            onChange={(e) => seek(Number(e.target.value))} />
          <span className="text-xs tabular-nums text-muted">{fmtDuration(position) || '0:00'}</span>
        </footer>
      </div>
    </dialog>
  );
}

function LyricsContent({ track }: { track: ListenTrack }) {
  const [data, setData] = useState<LyricsOut | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [sync, setSync] = useState(true);
  const [follow, setFollow] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLButtonElement>(null);
  const position = useListen((s) => s.position);
  const duration = useListen((s) => s.duration);
  const preview = useListen((s) => s.info?.kind === 'preview');
  const canSync = !!data?.synced && !preview && duration > 0 &&
    (!data.duration_s || Math.abs(duration - data.duration_s) <= 3);
  const syncing = sync && canSync;
  let active = -1;
  if (syncing && data) {
    for (let i = 0; i < data.lines.length && data.lines[i].start_ms <= position * 1000; i++) active = i;
  }

  useEffect(() => {
    const ctl = new AbortController();
    setData(null);
    setError('');
    const path = withQuery('/api/lyrics', {
      ref: track.ref, artist: track.artist, title: track.title, album: track.album,
      duration_s: track.duration_s || undefined,
    });
    void request<LyricsOut>('GET', path, { signal: ctl.signal }).then((out) => {
      if (!ctl.signal.aborted && out.ref === track.ref) setData(out);
    }).catch((e: unknown) => { if (!ctl.signal.aborted) setError(errorMessage(e)); });
    return () => ctl.abort();
  }, [track.ref, track.artist, track.title, track.album, track.duration_s, attempt]);

  useEffect(() => {
    const box = scroll.current;
    const line = current.current;
    if (!syncing || !follow || !box || !line) return;
    const top = line.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTo({ top: Math.max(0, top - box.clientHeight / 3),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [active, syncing, follow]);

  const unavailable = error || (data?.status === 'temporarily_unavailable' ? 'Источник текстов временно недоступен. Попробуйте ещё раз.' : '');
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Слова песни">
      {data?.status === 'found' && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2">
          {canSync ? <Button aria-pressed={sync} onClick={() => { setSync(!sync); setFollow(true); }}
            className={sync ? '!text-accent' : ''}>Синхронизация: {sync ? 'включена' : 'выключена'}</Button>
            : <span className="py-3 text-sm text-muted">{preview ? 'Для превью доступен текст без синхронизации' : 'Текст без синхронизации'}</span>}
          {syncing && !follow && <Button onClick={() => setFollow(true)}>К текущей строке</Button>}
        </div>
      )}
      <div ref={scroll} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4"
        onWheel={() => setFollow(false)} onTouchMove={() => setFollow(false)}
        onKeyDown={(e) => { if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(e.key)) setFollow(false); }}>
        {!data && !error && <p role="status" className="flex items-center justify-center gap-3 py-12 text-muted"><Spinner />Ищем текст…</p>}
        {unavailable && <div role="status" className="space-y-4 py-10 text-center">
          <p className="text-muted">{unavailable}</p><Button onClick={() => setAttempt(attempt + 1)}>Повторить</Button>
        </div>}
        {data?.status === 'not_found' && <p role="status" className="py-12 text-center text-muted">Текст пока не найден. Попробуйте другую песню.</p>}
        {data?.status === 'instrumental' && <p role="status" className="py-12 text-center text-muted">Инструментальная композиция — без слов</p>}
        {data?.status === 'found' && (syncing ? (
          <div className="space-y-1 pb-24">
            {data.lines.map((line, i) => <button type="button" key={i} ref={i === active ? current : undefined}
              aria-current={i === active ? 'true' : undefined} disabled={!line.text.trim()}
              aria-label={line.text ? `Перейти к строке: ${line.text}` : 'Музыкальный проигрыш'}
              className={cx('block min-h-11 w-full rounded-lg px-3 py-3 text-left text-xl leading-relaxed transition-colors motion-reduce:transition-none sm:text-2xl',
                i === active ? 'bg-accent/10 font-bold text-fg' : 'text-muted hover:bg-fg/5')}
              onClick={() => { seek(line.start_ms / 1000); setFollow(true); }}>
              {line.text || '♪'}
            </button>)}
          </div>
        ) : <p className="whitespace-pre-wrap break-words text-xl leading-relaxed">{data.plain}</p>)}
      </div>
      {data?.source && <p className="shrink-0 px-5 py-2 text-xs text-muted">Источник: {data.source_url ?
        <a href={data.source_url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center underline">{data.source}</a> : data.source}</p>}
    </section>
  );
}
