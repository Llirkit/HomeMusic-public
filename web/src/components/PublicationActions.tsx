import { useRef, useState } from 'react';
import { request } from '../api/client';
import { playbackCheckpoint } from '../lib/listen';
import { canShare, copyText, shareText } from '../lib/share';
import { attempt, toast } from '../lib/ui';
import { Link } from '../lib/router';
import { Button, Sheet } from './ui';

export interface Publication {
  id: string;
  title: string;
  kind: 'share' | 'radio';
  source_kind: string;
  active: boolean;
  owner: boolean;
  url: string;
  live_url?: string;
}

/** Use the queue's original mix/session, including a former daily mix still playing. */
export function PlayingRadioActions({ context, inline = false }: { context: string; inline?: boolean }) {
  const match = /^(mix|wave|playlist):(.+)$/.exec(context);
  if (!match) return null;
  return <PublicationActions sourceKind={match[1] as 'mix' | 'wave' | 'playlist'} sourceId={match[2]} radio share={false} inline={inline} />;
}

export function PublicationLink({ publication: p }: { publication: Publication }) {
  return <div className="space-y-3">
    <p className="text-sm text-muted">{p.kind === 'radio' ? 'Публичный эфир: все слушают одну песню одновременно. Вход не нужен.' : 'Слушать по этой ссылке можно после входа в HomeMusic. Состав подборки сохранён на момент публикации.'}</p>
    <label className="block text-sm">Ссылка<input className="input mt-1 w-full" readOnly value={p.url} onFocus={(e) => e.target.select()} /></label>
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => void copyText(p.url).then((ok) => toast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать. Выделите ссылку вручную.', ok ? 'success' : 'error'))}>Копировать ссылку</Button>
      {canShare() && <Button icon="send" onClick={() => void shareText(`${p.title}\n${p.url}`)}>Отправить</Button>}
    </div>
    {p.kind === 'radio' && <Link to={`/radio/${p.id}`} className="flex min-h-12 items-center text-accent underline">Открыть эфир</Link>}
    {p.kind === 'radio' && p.live_url && <RadioStreamLink url={p.live_url} />}
  </div>;
}

export function RadioStreamLink({ url }: { url: string }) {
  return <section aria-label="Поток для внешнего плеера" className="space-y-3 rounded-xl border border-line p-4 text-left">
    <h2 className="font-bold">Для бота или внешнего плеера</h2>
    <p className="text-sm text-muted">Непрерывный MP3-поток без входа. Вставьте эту ссылку в команду воспроизведения бота или откройте в VLC. Во время общей паузы передаётся тишина; звук может немного отставать от веб-плеера.</p>
    <label className="block text-sm">Ссылка на MP3-поток<input className="input mt-1 w-full" readOnly value={url} onFocus={(e) => e.target.select()} /></label>
    <Button icon="link" onClick={() => void copyText(url).then((ok) => toast(ok ? 'Ссылка на поток скопирована' : 'Не удалось скопировать. Выделите ссылку вручную.', ok ? 'success' : 'error'))}>Копировать ссылку на поток</Button>
  </section>;
}

export function PublicationActions({ sourceKind, sourceId, disabled, radio = sourceKind === 'playlist' || sourceKind === 'mix', share = true, inline = false }: {
  sourceKind: 'track' | 'playlist' | 'mix' | 'wave'; sourceId: string; disabled?: boolean; radio?: boolean; share?: boolean; inline?: boolean;
}) {
  const [busy, setBusy] = useState<string>();
  const pending = useRef(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [p, setP] = useState<Publication>();
  const create = async (kind: 'share' | 'radio') => {
    if (pending.current) return;
    pending.current = true;
    setBusy(kind);
    try {
      const playback = kind === 'radio' ? playbackCheckpoint() : null;
      const result = await attempt(() => request<Publication>('POST', '/api/publications', {
        json: { kind, source_kind: sourceKind, source_id: sourceId,
          ...(playback?.context === `${sourceKind}:${sourceId}` ? { playback } : {}) },
      }));
      if (result) setP(result);
    } finally { pending.current = false; setBusy(undefined); }
  };
  if (p && inline) return <PublicationLink publication={p} />;
  return <>
    <div className="flex flex-wrap gap-2">
      {share && <Button icon="send" disabled={disabled || !!busy} busy={busy === 'share'} onClick={(e) => { trigger.current = e.currentTarget; void create('share'); }}>Поделиться</Button>}
      {radio && <Button icon="radio" disabled={disabled || !!busy} busy={busy === 'radio'} onClick={(e) => { trigger.current = e.currentTarget; void create('radio'); }}>Создать онлайн-радио</Button>}
    </div>
    {p && <Sheet open title={p.kind === 'radio' ? 'Радио создано' : 'Поделиться музыкой'} onClose={() => { setP(undefined); requestAnimationFrame(() => trigger.current?.focus()); }}>
      <PublicationLink publication={p} />
      <Link to="/publications" className="mt-3 flex min-h-12 items-center text-sm text-accent underline">Мои ссылки и радиостанции</Link>
    </Sheet>}
  </>;
}
