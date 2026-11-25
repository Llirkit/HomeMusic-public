import { useEffect, useRef, useState } from 'react';
import { api, request } from '../api/client';
import type { CatalogTrack } from '../api/types';
import { fmtDuration } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { attempt } from '../lib/ui';
import { Button, ErrorState, IconButton, Loading } from './ui';

interface RadioQueue { tracks: CatalogTrack[]; revision: number; index: number; position_s: number; paused: boolean }

export function RadioManager({ token, revision, index, paused, position, duration, onChanged }: {
  token: string; revision: number; index: number; paused: boolean; position: number; duration: number; onChanged: () => void;
}) {
  const queue = useAsync((signal) => request<RadioQueue>('GET', `/api/publications/${token}/manage`, { signal }), [token, revision]);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [scrub, setScrub] = useState<number | null>(null);
  useEffect(() => { setScrub(null); }, [index]);
  const [adding, setAdding] = useState(false);
  const playlists = useAsync((signal) => api.playlists(signal), [], adding);
  const [playlist, setPlaylist] = useState('');
  const control = async (action: string, extra: Record<string, unknown> = {}) => {
    if (pending.current || !queue.data) return;
    const revision = queue.data.revision;
    pending.current = true; setBusy(true);
    try {
      const result = await attempt(() => request<RadioQueue>('POST', `/api/publications/${token}/control`, {
        json: { action, revision, ...extra },
      }));
      if (result) queue.setData(result);
      else queue.reload(true);
      onChanged();
    } finally { setBusy(false); pending.current = false; }
  };
  const disabled = busy || queue.loading || !queue.data;
  return <section aria-label="Управление эфиром" className="space-y-4 rounded-xl bg-raised p-4 text-left">
    <div><h2 className="text-lg font-bold">Управление эфиром</h2><p className="text-sm text-muted">Изменения услышат все слушатели. Доступно создателю и администраторам.</p></div>
    <div className="flex flex-wrap gap-2">
      <Button icon="prev" disabled={disabled} onClick={() => void control('previous')}>Предыдущий трек</Button>
      <Button icon={paused ? 'play' : 'pause'} disabled={disabled} onClick={() => void control(paused ? 'resume' : 'pause')}>{paused ? 'Продолжить эфир' : 'Пауза эфира'}</Button>
      <Button icon="next" disabled={disabled} onClick={() => void control('next')}>Следующий трек</Button>
    </div>
    <label className="block text-sm">Позиция в эфире
      <input aria-label="Позиция в эфире" type="range" min={0} max={Math.max(0, duration - 1)} step={1} value={scrub ?? Math.min(position, duration - 1)} disabled={disabled}
        className="h-11 w-full accent-accent" onChange={(e) => setScrub(Number(e.target.value))} />
    </label>
    {scrub !== null && <Button disabled={disabled} onClick={() => { void control('seek', { position_s: scrub }); setScrub(null); }}>Перейти к {fmtDuration(scrub)}</Button>}
    <div className="flex flex-wrap gap-2">
      <Button icon="shuffle" disabled={disabled || (queue.data?.tracks.length || 0) < 2} onClick={() => void control('shuffle')}>Перемешать очередь</Button>
      <Button icon="plus" onClick={() => setAdding(!adding)}>Добавить из плейлиста</Button>
    </div>
    {adding && <div className="space-y-2 rounded-lg border border-line p-3">
      {playlists.loading ? <Loading /> : playlists.error ? <ErrorState text={playlists.error} onRetry={() => playlists.reload()} /> : <>
        <label className="block text-sm">Ваш плейлист<select aria-label="Плейлист для добавления в эфир" className="input mt-2 w-full" value={playlist} onChange={(e) => setPlaylist(e.target.value)}>
          <option value="">Выберите плейлист</option>{playlists.data?.map((p) => <option key={p.id} value={p.id} disabled={!p.song_count}>{p.name}</option>)}
        </select></label>
        {!playlists.data?.length && <p className="text-sm text-muted">Создайте свой плейлист и добавьте в него песни.</p>}
        <Button disabled={disabled || !playlist} onClick={() => void control('add_playlist', { playlist_id: playlist })}>Добавить треки в эфир</Button>
      </>}
    </div>}
    {queue.error && <ErrorState text={queue.error} onRetry={() => queue.reload()} />}
    {queue.loading && !queue.data ? <Loading text="Загружаем очередь…" /> : <ol aria-label="Треки радио" className="divide-y divide-line">
      {queue.data?.tracks.map((track, n) => <li key={`${n}:${track.ref}`} aria-current={n === index ? 'true' : undefined} className="py-3">
        <div className="flex items-start gap-3"><span className="pt-2 text-sm text-muted">{n + 1}</span><div className="min-w-0 flex-1"><div className="break-words font-semibold">{track.title}</div><div className="text-sm text-muted">{track.artist} · {fmtDuration(track.duration_s || 0)}{n === index ? ' · В эфире' : ''}</div></div></div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button small disabled={disabled} onClick={() => void control('play', { index: n })}>Поставить в эфир</Button>
          <IconButton icon="up" label={`Поднять трек ${n + 1}`} disabled={disabled || n === 0} onClick={() => void control('move', { index: n, to_index: n - 1 })} />
          <IconButton icon="down" label={`Опустить трек ${n + 1}`} disabled={disabled || n === queue.data!.tracks.length - 1} onClick={() => void control('move', { index: n, to_index: n + 1 })} />
          <IconButton icon="trash" label={`Убрать трек ${n + 1} из эфира`} disabled={disabled || queue.data!.tracks.length === 1} onClick={() => void control('remove', { index: n })} />
        </div>
      </li>)}
    </ol>}
  </section>;
}
