import { useState } from 'react';
import { api } from '../api/client';
import type { Candidate } from '../api/types';
import { useAsync } from '../lib/hooks';
import { providerLabel } from '../lib/format';
import { navigate } from '../lib/router';
import { attempt } from '../lib/ui';
import { CandidateRow, fileRef, listenFiles } from './candidate';
import { ListenButton } from './catalog';
import { Button, Empty, ErrorState, Field, Loading, Notice, Sheet } from './ui';

export function SourcePicker({ title, artist, track_id, nd_song_id, refId, importItemId, onClose }: {
  title: string; artist: string; track_id?: number; nd_song_id?: string | null; refId?: string | null;
  importItemId?: number; onClose: () => void;
}) {
  const [query, setQuery] = useState(`${artist} - ${title}`);
  const [search, setSearch] = useState(query);
  const [url, setUrl] = useState('');
  const [selected, setSelected] = useState<{ candidate?: Candidate; url?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const current = useAsync(s => api.trackSource({ track_id, nd_song_id, ref: refId }, s),
    [track_id, nd_song_id, refId], !importItemId || !!nd_song_id || !!track_id);
  const results = useAsync(s => api.searchProviders(search, s), [search]);
  const candidates = results.data?.candidates ?? [];
  const canSave = !!selected && !busy && (importItemId || current.data?.track_id);
  const save = async () => {
    if (!canSave || !selected) return;
    setBusy(true);
    const body = { candidate_ref: selected.candidate ? fileRef(selected.candidate) : undefined,
      url: selected.url, expected_acquired_at: current.data?.acquired_at };
    const result = await attempt(() => importItemId ? api.importSource(importItemId, body)
      : api.replaceSource(current.data!.track_id, body));
    setBusy(false);
    if (result) { onClose(); navigate(`/downloads/${result.id}`); }
  };

  return <Sheet open onClose={() => { if (!busy) onClose(); }} title="Выбрать аудиоисточник"
    footer={selected ? <div className="space-y-2">
      <p className="text-sm text-muted">После проверки новый файл заменит аудио. Название, плейлисты и лайки сохранятся. Прежний файл останется в резервной копии.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" busy={busy} disabled={!canSave} onClick={() => void save()}>Подтвердить выбор аудио</Button>
        <Button disabled={busy} onClick={() => setSelected(null)}>К вариантам</Button>
      </div>
    </div> : undefined}>
    <div className="space-y-4">
      <div><p className="font-semibold">{title}</p><p className="text-sm text-muted">{artist}</p></div>
      <Notice kind="info">Для сохранённого трека меняется аудио в общей библиотеке. Старое будет доступно, пока новое не скачается и не пройдёт проверку.</Notice>
      {current.data && <p className="text-sm text-muted">Текущий источник: {providerLabel(current.data.source ?? '') || 'не указан'}
        {current.data.source_url && <> · <a href={current.data.source_url} target="_blank" rel="noreferrer" className="underline">Открыть</a></>}</p>}
      {current.loading && <Loading text="Проверяем текущий источник…" />}
      {current.error && !importItemId && <ErrorState text={current.error} onRetry={() => current.reload()} />}
      {selected ? <div aria-label="Выбранное аудио">
        {selected.candidate ? <CandidateRow c={selected.candidate} /> : <p className="break-all text-sm">{selected.url}</p>}
      </div> : <>
        <form className="flex items-end gap-2" onSubmit={e => { e.preventDefault(); if (query.trim()) { setSearch(query.trim()); results.reload(); } }}>
          <Field label="Поиск другого файла" className="min-w-0 flex-1"><input className="input" value={query} onChange={e => setQuery(e.target.value)} /></Field>
          <Button type="submit" disabled={!query.trim()} busy={results.loading}>Найти</Button>
        </form>
        <form className="space-y-2" onSubmit={e => { e.preventDefault(); if (url.trim()) setSelected({ url: url.trim() }); }}>
          <Field label="Или ссылка на другой файл"><input type="url" className="input" value={url} onChange={e => setUrl(e.target.value)} placeholder="Страница трека на YouTube, SoundCloud или другом источнике" /></Field>
          <Button small type="submit" disabled={!url.trim()}>Использовать ссылку</Button>
        </form>
        {results.loading ? <Loading text="Ищем варианты аудио…" /> : results.error ? <ErrorState text={results.error} onRetry={() => results.reload()} /> : <>
          {!!results.data?.errors.length && <Notice>Некоторые источники недоступны. Можно выбрать найденный файл или повторить поиск.</Notice>}
          {!candidates.length && <Empty icon="search" title="Варианты не найдены" text="Измените запрос или укажите ссылку на нужную запись." />}
          <ul className="-mx-4 divide-y divide-line/60" aria-label="Варианты аудио">{candidates.map((candidate, i) => <li key={`${fileRef(candidate)}:${i}`}>
            <CandidateRow c={candidate} action={<div className="flex items-center gap-2">
              <ListenButton track={{ ref: fileRef(candidate), title: candidate.title }} onListen={() => listenFiles(candidates, candidate)} />
              <Button small onClick={() => setSelected({ candidate })}>Выбрать этот файл</Button>
            </div>} />
          </li>)}</ul>
        </>}
      </>}
    </div>
  </Sheet>;
}
