import { listenStreamUrl } from '../api/client';

// One upcoming file, in memory only. Large/lossless files and failed requests keep using normal streaming.
const MAX_BYTES = 32 * 1024 * 1024;
let upcoming: { ref: string; ctl: AbortController; url?: string } | null = null;

export function clearAudioPreload() {
  const previous = upcoming;
  upcoming = null;
  previous?.ctl.abort();
  if (previous?.url) URL.revokeObjectURL(previous.url);
}

export function preloadAudio(ref: string | null) {
  if (upcoming?.ref === ref) return;
  clearAudioPreload();
  if (!ref) return;
  const entry = { ref, ctl: new AbortController(), url: undefined as string | undefined };
  upcoming = entry;
  void (async () => {
    const timeout = window.setTimeout(() => entry.ctl.abort(), 120_000);
    try {
      const response = await fetch(listenStreamUrl(ref), {
        signal: entry.ctl.signal, credentials: 'same-origin', priority: 'low',
        headers: { 'X-HomeMusic-Prefetch': '1' },
      });
      const type = response.headers.get('content-type')?.split(';')[0] ?? '';
      if (!response.ok || response.status === 206 || !response.body ||
          !/^(audio\/|video\/|application\/(octet-stream|ogg))/.test(type) ||
          Number(response.headers.get('content-length')) > MAX_BYTES) return;
      const reader = response.body.getReader();
      const parts: ArrayBuffer[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES || entry.ctl.signal.aborted) return;
          parts.push(Uint8Array.from(value).buffer);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const expected = Number(response.headers.get('content-length'));
      if (upcoming === entry && !entry.ctl.signal.aborted && size > 0 && (!expected || expected === size)) {
        entry.url = URL.createObjectURL(new Blob(parts, { type }));
      }
    } catch { /* Preloading must never interrupt the current song. */ }
    finally {
      clearTimeout(timeout);
      // Also cancel rejected/oversized responses whose body was never consumed.
      entry.ctl.abort();
    }
  })();
}

/** Transfers ownership of a complete file to the player; unfinished downloads fall back to streaming. */
export function takePreloadedAudio(ref: string): string | null {
  const url = upcoming?.ref === ref ? upcoming.url ?? null : null;
  if (url && upcoming) upcoming.url = undefined;
  clearAudioPreload();
  return url;
}
