import { useEffect, useState } from 'react';
import { api, libraryCoverUrl, withQuery } from '../api/client';
import type { LibAlbumOut, LibTrackOut, ReleaseType } from '../api/types';
import { Icon, type IconName } from '../components/Icon';
import { Button, Cover, Empty, ErrorState, ExplicitBadge, Field, IconButton, SectionTitle, Segmented, Sheet, SkeletonRows } from '../components/ui';
import { LikeButton } from '../components/LikeButton';
import { STANDALONE } from '../lib/embedded';
import { useHubEvent } from '../lib/events';
import { fmtDuration, recordTypeLabel, toIntOrNull, tracksWord } from '../lib/format';
import { useAsync, useDebounced } from '../lib/hooks';
import { Link, navigate } from '../lib/router';
import { attempt } from '../lib/ui';
import { listen, type ListenTrack } from '../lib/listen';
import { canPlay, playList } from '../lib/player';

const PAGE = 50;

export function LibraryPage({ initialQuery }: { initialQuery: string }) {
  const [q, setQ] = useState(initialQuery);
  const [view, setView] = useState<'albums' | 'tracks'>('albums');
  const [trackSort, setTrackSort] = useState<'artist' | 'title' | 'album'>('artist');
  const dq = useDebounced(q.trim(), 350);
  const [extra, setExtra] = useState<LibAlbumOut[]>([]);
  const [trackExtra, setTrackExtra] = useState<LibTrackOut[]>([]);
  const [more, setMore] = useState<{ busy: boolean; done: boolean }>({ busy: false, done: false });
  const [trackMore, setTrackMore] = useState<{ busy: boolean; done: boolean }>({ busy: false, done: false });
  const [createOpen, setCreateOpen] = useState(false);
  const res = useAsync((s) => api.libAlbums(dq, 0, PAGE, s), [dq]);
  const trackRes = useAsync((s) => api.libTracks(dq, trackSort, 0, PAGE, s), [dq, trackSort], view === 'tracks');
  // «Перенести музыку» lives here too: the app has no «Ещё»; the banner shows until the first import
  const imports = useAsync((s) => api.imports(s), []);
  const offerImport = imports.data?.length === 0 && !dq;

  useEffect(() => {
    setExtra([]);
    setMore({ busy: false, done: false });
    const target = withQuery('/library', { q: dq });
    if (window.location.hash !== '#' + target) navigate(target, { replace: true });
  }, [dq]);

  useEffect(() => {
    setTrackExtra([]);
    setTrackMore({ busy: false, done: false });
  }, [dq, trackSort]);

  useHubEvent('library', () => {
    res.reload(true);
    trackRes.reload(true);
  });

  const albums = [...(res.data ?? []), ...extra];
  const tracks = [...(trackRes.data ?? []), ...trackExtra];
  const canMore = !more.done && (res.data?.length ?? 0) >= PAGE;
  const canMoreTracks = !trackMore.done && (trackRes.data?.length ?? 0) >= PAGE;

  const loadMore = async () => {
    setMore({ busy: true, done: false });
    const next = await attempt(() => api.libAlbums(dq, albums.length, PAGE));
    setExtra((x) => [...x, ...(next ?? [])]);
    setMore({ busy: false, done: !next || next.length < PAGE });
  };

  const loadMoreTracks = async () => {
    setTrackMore({ busy: true, done: false });
    const next = await attempt(() => api.libTracks(dq, trackSort, tracks.length, PAGE));
    setTrackExtra((x) => [...x, ...(next ?? [])]);
    setTrackMore({ busy: false, done: !next || next.length < PAGE });
  };

  return (
    <div>
      <header className="pt-safe sticky top-0 z-20 bg-bg/95 px-4 pb-3 backdrop-blur">
        <div className="flex items-center justify-between pb-3 pt-4">
          <h1 className="text-2xl font-bold">Библиотека</h1>
          <div className="flex gap-1">
            <IconButton icon="transfer" label="Перенести музыку из другого сервиса" onClick={() => navigate('/import')} />
            <IconButton icon="upload" label="Загрузить файлы" onClick={() => navigate('/upload')} />
            <IconButton icon="plus" label="Создать свой альбом" onClick={() => setCreateOpen(true)} />
          </div>
        </div>
        <div className="relative">
          <Icon name="search" size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim" />
          <input className="input pl-10" type="search" placeholder={view === 'tracks' ? 'Поиск по трекам' : 'Поиск по альбомам'} aria-label={view === 'tracks' ? 'Поиск по трекам' : 'Поиск по альбомам'} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <Segmented label="Вид библиотеки" value={view} onChange={setView} options={[{ value: 'albums', label: 'Альбомы' }, { value: 'tracks', label: 'Треки' }]} />
          {view === 'tracks' && (
            <select className="min-h-11 rounded-full border border-line bg-raised px-3 text-sm" aria-label="Сортировка треков" value={trackSort} onChange={(e) => setTrackSort(e.target.value as typeof trackSort)}>
              <option value="artist">По исполнителю</option>
              <option value="title">По названию</option>
              <option value="album">По альбому</option>
            </select>
          )}
        </div>
      </header>

      {STANDALONE && !dq && (
        // a browser has no app around it: the Navidrome library a player shows, then the files the Hub keeps
        <>
          <ul className="mx-4 mb-2 overflow-hidden rounded-xl bg-surface">
            <LibraryLink to="/liked" icon="heart" title="Понравившиеся" />
            <LibraryLink to="/playlists" icon="playlist" title="Плейлисты" />
            <LibraryLink to="/artists" icon="user" title="Исполнители" />
            <LibraryLink to="/lib/albums" icon="disc" title="Все альбомы" />
          </ul>
          <SectionTitle>Мои файлы</SectionTitle>
        </>
      )}
      {offerImport && (
        <Link to="/import" className="card mx-4 mb-4 flex items-center gap-3 p-3 hover:bg-hover">
          <Icon name="transfer" size={22} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">Перенести музыку из Яндекс Музыки</span>
            <span className="block text-xs text-muted">♥, плейлисты, любимые альбомы и исполнители</span>
          </span>
          <Icon name="chevron" size={18} className="shrink-0 text-dim" />
        </Link>
      )}
      {view === 'tracks' ? (
        trackRes.loading ? <SkeletonRows /> : trackRes.error ? <ErrorState text={trackRes.error} onRetry={() => trackRes.reload()} /> : tracks.length === 0 ? (
          <Empty icon={dq ? 'search' : 'note'} title={dq ? 'Ничего не найдено' : 'В библиотеке нет треков'} />
        ) : (
          <>
            <TrackList tracks={tracks} />
            {canMoreTracks && <div className="flex justify-center py-5"><Button busy={trackMore.busy} onClick={loadMoreTracks}>Показать ещё</Button></div>}
          </>
        )
      ) : res.loading ? (
        <SkeletonRows />
      ) : res.error ? (
        <ErrorState text={res.error} onRetry={() => res.reload()} />
      ) : albums.length === 0 ? (
        dq ? (
          <Empty icon="search" title="Ничего не найдено" />
        ) : (
          <Empty icon="library" title="Библиотека пуста" text="Скачайте музыку через поиск или загрузите свои файлы.">
            <div className="mt-2 flex gap-2">
              <Button small variant="primary" icon="search" onClick={() => navigate('/search')}>
                Поиск
              </Button>
              <Button small icon="upload" onClick={() => navigate('/upload')}>
                Загрузить
              </Button>
            </div>
          </Empty>
        )
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 px-4 pt-1 min-[520px]:grid-cols-3">
            {albums.map((a) => (
              <Link key={a.id} to={`/library/album/${a.id}`} className="hm-media-card min-w-0">
                <Cover src={a.has_cover ? libraryCoverUrl(a.id, 300) : null} alt={a.title} className="aspect-square w-full" icon="disc" />
                <div className="mt-2 truncate text-sm font-medium">{a.title}</div>
                <div className="truncate text-xs text-muted">{[a.album_artist, a.year].filter(Boolean).join(' · ')}</div>
                <div className="truncate text-xs text-dim">{[recordTypeLabel(a.release_type), tracksWord(a.track_count)].filter(Boolean).join(' · ')}</div>
              </Link>
            ))}
          </div>
          {canMore && (
            <div className="flex justify-center py-5">
              <Button busy={more.busy} onClick={loadMore}>
                Показать ещё
              </Button>
            </div>
          )}
        </>
      )}

      <CreateAlbumSheet open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function TrackList({ tracks }: { tracks: LibTrackOut[] }) {
  const playable = tracks.filter((t) => t.nd_song_id);
  const asListen = (t: LibTrackOut): ListenTrack => ({
    ref: `nd:${t.nd_song_id}`, title: t.title, artist: t.artist, album: t.album ?? undefined, duration_s: t.duration_s,
    cover_small_url: t.album_id ? libraryCoverUrl(t.album_id, 120) : null,
  });
  const playFrom = (track: LibTrackOut) => {
    if (canPlay()) return playList(playable, (t) => t.nd_song_id, track);
    const queue = playable.map(asListen);
    listen(asListen(track), queue, 'library');
  };
  return (
    <ul className="divide-y divide-line/60" aria-label="Треки библиотеки">
      {tracks.map((track) => (
        <li key={track.id} className="group flex min-h-16 items-center gap-3 px-4 py-2 transition-colors hover:bg-fg/5">
          <Cover src={track.album_id ? libraryCoverUrl(track.album_id, 120) : null} alt="" size={48} icon="note" />
          <Link to={track.album_id ? `/library/album/${track.album_id}` : '/library'} className="min-w-0 flex-1 rounded-md">
            <span className="flex items-center gap-1.5"><span className="truncate font-medium group-hover:text-accent">{track.title}</span>{track.explicit && <ExplicitBadge />}</span>
            <span className="block truncate text-sm text-muted">{[track.artist, track.album].filter(Boolean).join(' · ')}</span>
          </Link>
          <span className="hidden shrink-0 text-xs tabular-nums text-dim sm:block">{fmtDuration(track.duration_s)}</span>
          <LikeButton songId={track.nd_song_id} title={track.title} />
          {track.nd_song_id && <IconButton icon="play" label={`Слушать «${track.title}»`} className="text-accent" onClick={() => playFrom(track)} />}
        </li>
      ))}
    </ul>
  );
}

function CreateAlbumSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [year, setYear] = useState('');
  const [genre, setGenre] = useState('');
  const [type, setType] = useState<ReleaseType>('compilation');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    const a = await attempt(
      () => api.createAlbum({ title: title.trim(), album_artist: artist.trim() || 'Various Artists', year: toIntOrNull(year), genre: genre.trim() || null, release_type: type }),
      'Альбом создан',
    );
    setBusy(false);
    if (a) {
      onClose();
      navigate(`/library/album/${a.id}`);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Создать свой альбом"
      footer={
        <Button variant="primary" block busy={busy} disabled={!title.trim()} onClick={create}>
          Создать
        </Button>
      }
    >
      <p className="mb-4 text-sm text-muted">Пустой альбом или подборка: потом перенесите в него треки из других альбомов.</p>
      <div className="space-y-4">
        <Field label="Название">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <Field label="Исполнитель альбома">
          <input className="input" value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="Various Artists" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Год">
            <input className="input" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} />
          </Field>
          <Field label="Жанр">
            <input className="input" value={genre} onChange={(e) => setGenre(e.target.value)} />
          </Field>
        </div>
        <Field label="Тип">
          <ReleaseTypeSelect value={type} onChange={setType} />
        </Field>
      </div>
    </Sheet>
  );
}

export function ReleaseTypeSelect({ value, onChange }: { value: ReleaseType; onChange: (v: ReleaseType) => void }) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value as ReleaseType)}>
      <option value="album">Альбом</option>
      <option value="single">Сингл</option>
      <option value="ep">EP</option>
      <option value="compilation">Сборник</option>
    </select>
  );
}

function LibraryLink({ to, icon, title }: { to: string; icon: IconName; title: string }) {
  return (
    <li className="border-b border-line/60 last:border-0">
      <Link to={to} className="flex min-h-14 items-center gap-4 px-4 py-2 hover:bg-fg/5">
        <Icon name={icon} size={22} className="text-accent" />
        <span className="min-w-0 flex-1">{title}</span>
        <Icon name="chevron" size={18} className="text-dim" />
      </Link>
    </li>
  );
}
