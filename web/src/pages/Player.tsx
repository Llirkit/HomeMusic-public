import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '../components/Icon';
import { PlayingRadioActions } from '../components/PublicationActions';
import { LikeButton } from '../components/LikeButton';
import { LyricsButton } from '../components/Lyrics';
import { AudioOutputButton } from '../components/AudioOutput';
import { PlaybackLocation } from '../components/PlaybackDevices';
import { TrackMenuButton } from '../components/TrackMenu';
import { Button, Cover, Empty, IconButton, Spinner, cx } from '../components/ui';
import { fmtDuration, providerLabel } from '../lib/format';
import {
  cycleRepeat,
  cycleShuffle,
  downloadRef,
  hasNext,
  hasPrev,
  moveInQueue,
  next,
  playQueueAt,
  prev,
  removeFromQueue,
  seek,
  toggle,
  useListen,
  type ListenTrack,
} from '../lib/listen';
import { Link, enc, goBack } from '../lib/router';
import { addRec, hideRec } from '../lib/smartShuffle';
import { canWave, seedKey, startWave, trackSeed, useWave } from '../lib/wave';

/** The full player of the PWA in a plain browser (`/player`, from a tap on the mini player): the big cover, seek,
 * shuffle / repeat, ♥, ⋯ and the queue — a tap plays a track, ↑ moves it up, × takes it out. Inside the app the
 * player is the app's own. */
export function PlayerPage() {
  const track = useListen((s) => s.track);
  const phase = useListen((s) => s.phase);
  const info = useListen((s) => s.info);
  const error = useListen((s) => s.error);
  const position = useListen((s) => s.position);
  const duration = useListen((s) => s.duration);
  const shuffle = useListen((s) => s.shuffle);
  const smart = useListen((s) => s.smart);
  const repeat = useListen((s) => s.repeat);
  const queue = useListen((s) => s.queue);
  const index = useListen((s) => s.index);
  const context = useListen((s) => s.context);
  const dl = useListen((s) => (s.track ? s.downloads.get(s.track.ref) : undefined));
  const canNext = useListen((s) => hasNext(s) || (s.repeat === 'all' && !s.context.startsWith('wave:')));
  const canPrev = useListen(hasPrev);
  const [scrub, setScrub] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const { starting } = useWave();

  if (!track)
    return (
      <div className="pt-safe">
        <div className="flex min-h-14 items-center px-2">
          <IconButton icon="down" label="Свернуть" onClick={() => goBack('/home')} />
        </div>
        <Empty icon="note" title="Сейчас ничего не играет" text="Выберите трек, альбом или «Мою волну»." />
      </div>
    );

  const onWave = context.startsWith('wave:');
  const waiting = phase === 'resolving' || phase === 'loading';
  const playing = phase === 'playing' || waiting;
  const owned = info?.kind === 'library';
  const source = info?.kind === 'full' ? providerLabel(info.provider) : owned ? 'из библиотеки' : info?.kind === 'preview' ? 'превью 30 сек' : null;
  const shownPos = scrub ?? Math.min(position, duration || position);
  const pct = duration ? Math.min(100, (shownPos / duration) * 100) : 0;
  const commit = () => {
    if (scrub !== null) seek(scrub);
    setScrub(null);
  };
  const download = async () => {
    setBusy(true);
    await downloadRef(track.ref);
    setBusy(false);
  };
  const firstArtist = track.artists?.find((a) => a.ref);
  const waveSeed = trackSeed({ ...track, nd_song_id: info?.nd_song_id });

  return (
    <div className="pt-safe mx-auto flex min-h-dvh max-w-2xl flex-col">
      <PlaybackLocation />
      <div className="flex min-h-14 items-center gap-1 px-2">
        <IconButton icon="down" label="Свернуть" onClick={() => goBack('/home')} />
        <div className="min-w-0 flex-1 text-center text-xs uppercase tracking-wide text-muted">{contextLabel(context)}</div>
        <TrackMenuButton track={{ ...track, nd_song_id: info?.nd_song_id }} inPlayer />
      </div>
      <div className="px-6 pb-3"><PlayingRadioActions context={context} /></div>

      <div className="px-6 pt-2">
        <Cover src={track.cover_url || track.cover_small_url} alt={track.title} className="mx-auto aspect-square w-full max-w-[22rem] shadow-2xl" />
      </div>

      <div className="flex items-center gap-2 px-6 pt-6">
        <div className="min-w-0 flex-1">
          {track.album_ref ? (
            <Link to={`/album/${enc(track.album_ref)}`} className="block truncate text-xl font-bold hover:underline">
              {track.title}
            </Link>
          ) : (
            <div className="truncate text-xl font-bold">{track.title}</div>
          )}
          <div className="flex items-center gap-1.5 text-[15px] text-muted">
            {onWave && <Icon name="wave" size={16} className="shrink-0 text-accent" />}
            {track.rec && (
              <span title="Рекомендация" className="shrink-0 text-accent">
                <Icon name="sparkle" size={15} />
              </span>
            )}
            {firstArtist?.ref ? (
              <Link to={`/artist/${enc(firstArtist.ref)}`} className="truncate hover:underline">
                {track.artist}
              </Link>
            ) : (
              <span className="truncate">{track.artist}</span>
            )}
          </div>
        </div>
        <LikeButton songId={info?.nd_song_id} refId={track.ref} title={track.title} data={{ ...track }} size={26} />
        {owned || dl ? (
          <span className="flex h-11 w-11 shrink-0 items-center justify-center text-accent" title={owned || dl === 'done' ? 'Есть в библиотеке' : 'В загрузках'}>
            <Icon name="check" size={22} stroke={2.6} />
          </span>
        ) : (
          <IconButton icon="download" label="Скачать" onClick={download} busy={busy} />
        )}
      </div>

      {track.rec && (
        <div className="mx-6 mt-4 flex items-center gap-1 rounded-xl bg-accent/10 py-1 pl-3 pr-1" role="group" aria-label="Рекомендация">
          <Icon name="sparkle" size={18} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 text-[13px] leading-tight">{track.rec.label}</span>
          <IconButton icon="plus" label={track.rec.label.includes('любим') ? 'В понравившиеся' : 'Добавить в плейлист'} onClick={() => void addRec(track)} className="!text-accent" />
          <IconButton icon="minus" label="Не рекомендовать здесь" onClick={() => void hideRec(track)} className="text-muted" />
        </div>
      )}

      <div className="px-6 pt-4">
        <input
          type="range"
          className="hm-range w-full"
          aria-label="Перемотка"
          min={0}
          max={Math.max(1, Math.round(duration))}
          step={1}
          value={Math.round(shownPos)}
          disabled={!duration || phase === 'resolving' || phase === 'error'}
          style={{ '--p': `${pct}%` } as CSSProperties}
          onChange={(e) => setScrub(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        <div className="flex justify-between pt-1 text-xs tabular-nums text-muted">
          <span>{fmtDuration(shownPos) || '0:00'}</span>
          <span className={cx('truncate px-2', phase === 'error' && 'text-danger')}>
            {phase === 'error' ? error : phase === 'resolving' && !info ? 'Ищу файл…' : waiting ? 'Загрузка…' : source}
          </span>
          <span>{fmtDuration(duration) || '–:––'}</span>
        </div>
      </div>

      <div className="flex items-center justify-between px-4 pt-3">
        <IconButton
          icon={smart ? 'shuffleSmart' : 'shuffle'}
          label={smart ? 'Умное перемешивание включено' : shuffle ? 'Перемешивание включено' : 'Перемешать'}
          aria-pressed={shuffle}
          disabled={onWave}
          onClick={cycleShuffle}
          className={shuffle && !onWave ? '!text-accent' : 'text-muted'}
        />
        <IconButton icon="prev" label={canPrev ? 'Предыдущий трек' : 'Сначала'} onClick={prev} size={30} className="h-14 w-14" />
        <button
          type="button"
          onClick={toggle}
          aria-label={phase === 'error' ? 'Повторить' : playing ? 'Пауза' : 'Слушать'}
          className="inline-flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-fg text-bg transition active:scale-95"
        >
          {phase === 'error' ? (
            <Icon name="refresh" size={28} stroke={2.4} />
          ) : waiting ? (
            <Spinner size={28} />
          ) : playing ? (
            <Icon name="pause" size={28} stroke={3} />
          ) : (
            <Icon name="play" size={28} stroke={2.4} className="translate-x-0.5" />
          )}
        </button>
        <IconButton icon="next" label="Следующий трек" onClick={() => void next()} disabled={!canNext} size={30} className="h-14 w-14" />
        <IconButton
          icon={repeat === 'one' ? 'repeat1' : 'repeat'}
          label={repeat === 'off' ? 'Повтор выключен' : repeat === 'all' ? 'Повтор очереди' : 'Повтор трека'}
          disabled={onWave && repeat !== 'one'}
          onClick={cycleRepeat}
          className={repeat !== 'off' ? '!text-accent' : 'text-muted'}
        />
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2 px-4 pt-4" role="group" aria-label="Действия с треком">
        {canWave() && waveSeed && (
          <Button icon="wave" small variant="ghost" aria-label="Моя волна по треку" disabled={starting !== null} busy={starting === seedKey(waveSeed)} onClick={() => void startWave(waveSeed, 'player')}>
            Волна
          </Button>
        )}
        <LyricsButton small />
        <AudioOutputButton small />
      </div>
      <Queue queue={queue} index={index} onWave={onWave} />
    </div>
  );
}

function contextLabel(context: string): string {
  if (context.startsWith('wave:')) return 'Моя волна';
  if (context.startsWith('mix:')) return 'Микс дня';
  if (context.startsWith('playlist:')) return 'Плейлист';
  return (
    { album: 'Альбом', artist: 'Исполнитель', playlist: 'Плейлист', liked: 'Понравившиеся', search: 'Поиск', queue: 'Очередь' } as Record<string, string>
  )[context] ?? 'Сейчас играет';
}

function Queue({ queue, index, onWave }: { queue: readonly ListenTrack[]; index: number; onWave: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLLIElement>(null);
  const upcoming = queue.length - index - 1;
  const currentRef = queue[index]?.ref;
  // Scroll only this panel. Manual browsing stays put until playback changes or the panel reopens.
  useEffect(() => {
    const panel = scroll.current;
    const row = current.current;
    if (expanded && panel && row) panel.scrollTop = row.offsetTop;
  }, [expanded, index, currentRef]);

  return (
    <section aria-label="Очередь" className="mt-4 rounded-t-2xl bg-surface pb-[calc(16px+env(safe-area-inset-bottom))]">
      <h2>
        <button type="button" aria-expanded={expanded} aria-controls="player-queue" onClick={() => setExpanded(!expanded)}
          className="flex min-h-14 w-full items-center gap-3 rounded-t-2xl px-4 py-3 text-left hover:bg-fg/5">
          <span className="min-w-0 flex-1">
            <span className="block text-base font-bold">Далее</span>
            <span className="block text-xs font-normal text-muted">{onWave ? 'Подбирается на ходу' : upcoming > 0 ? `${upcoming} в очереди` : 'Очередь закончится на этом треке'}</span>
          </span>
          <span className="text-xs font-normal text-muted">{expanded ? 'Свернуть' : 'Развернуть'}</span>
          <Icon name="down" size={18} className={expanded ? 'rotate-180' : ''} />
        </button>
      </h2>
      <div id="player-queue" ref={scroll} hidden={!expanded} role="region" aria-label="Список треков" tabIndex={0}
        className="relative h-[min(40dvh,22rem)] overflow-y-auto overscroll-contain [overflow-anchor:none]">
      <ul className="min-h-full after:block after:h-[max(0px,calc(min(40dvh,22rem)-64px))] after:content-['']">
        {queue.map((t, i) => (
          <li
            key={`${t.ref}:${i}`}
            ref={i === index ? current : undefined}
            aria-current={i === index ? 'true' : undefined}
            className={cx('flex min-h-16 items-center gap-1 pl-3 pr-1', i < index && 'opacity-50', i === index && 'bg-fg/5')}
          >
            <button type="button" onClick={() => playQueueAt(i)} className="flex min-w-0 flex-1 items-center gap-3 py-1.5 text-left" aria-label={`Слушать «${t.title}»`}>
              <Cover src={t.cover_small_url || t.cover_url} size={40} alt="" />
              <span className="min-w-0 flex-1">
                <span className={cx('block truncate text-[15px]', i === index && 'font-semibold text-accent')}>{t.title}</span>
                <span className="flex items-center gap-1 text-[13px] text-muted">
                  {t.rec && (
                    <span title="Рекомендация" className="shrink-0 text-accent">
                      <Icon name="sparkle" size={12} />
                    </span>
                  )}
                  <span className="truncate">{t.artist}</span>
                </span>
              </span>
            </button>
            <LikeButton songId={t.nd_song_id} refId={t.ref} title={t.title} data={{ ...t }} size={19} />
            {i > index + 1 && <IconButton icon="back" label="Поднять выше" onClick={() => moveInQueue(i, i - 1)} size={18} className="rotate-90 text-muted" />}
            {i !== index && <IconButton icon="x" label="Убрать из очереди" onClick={() => removeFromQueue(i)} size={18} className="text-muted" />}
            <TrackMenuButton track={t} inPlayer />
          </li>
        ))}
      </ul>
      </div>
    </section>
  );
}
