import { useRef, useState } from 'react';
import { request } from '../api/client';
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
  </div>;
}

export function PublicationActions({ sourceKind, sourceId, disabled, radio = false, share = true, inline = false }: {
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
      const result = await attempt(() => request<Publication>('POST', '/api/publications', {
        json: { kind, source_kind: sourceKind, source_id: sourceId },
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
