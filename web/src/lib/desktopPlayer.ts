import type { ListenState } from './listen';

type PlayerCommand = 'toggle' | 'previous' | 'next';
interface DesktopPlayerState {
  active: boolean;
  playing: boolean;
  canNext: boolean;
  canPrevious: boolean;
  title: string;
  artist: string;
}

declare global {
  interface Window {
    HomeMusicDesktop?: {
      updatePlayer(state: DesktopPlayerState): void;
      onCommand(callback: (command: PlayerCommand) => void): () => void;
    };
  }
}

/** The Windows thumbnail toolbar controls this same player; no second queue or audio element. */
export function connectDesktopPlayer(player: {
  getState(): ListenState;
  subscribe(callback: () => void): () => void;
  toggle(): void;
  previous(): void;
  next(): unknown;
}) {
  const bridge = window.HomeMusicDesktop;
  if (!bridge) return;
  let last = '';
  const empty: DesktopPlayerState = { active: false, playing: false, canNext: false, canPrevious: false, title: '', artist: '' };
  const snapshot = (): DesktopPlayerState => {
    const s = player.getState();
    return s.track ? {
      active: true,
      playing: s.phase === 'playing' || s.phase === 'loading' || s.phase === 'resolving',
      canNext: s.index + 1 < s.queue.length || s.repeat === 'all' && !s.context.startsWith('wave:'),
      // Like the in-app button, previous restarts even the first track.
      canPrevious: true,
      title: s.track.title,
      artist: s.track.artist,
    } : empty;
  };
  const sync = () => {
    const state = snapshot();
    const key = JSON.stringify(state);
    if (key === last) return;
    try { bridge.updatePlayer(state); last = key; }
    catch (error) { console.warn('Не удалось обновить кнопки Windows', error); }
  };
  bridge.onCommand((command) => {
    const s = snapshot();
    if (!s.active) return;
    if (command === 'toggle') player.toggle();
    else if (command === 'previous' && s.canPrevious) player.previous();
    else if (command === 'next' && s.canNext) player.next();
  });
  player.subscribe(sync);
  window.addEventListener('pagehide', () => {
    last = '';
    try { bridge.updatePlayer(empty); } catch { /* the native window may already be closing */ }
  });
  window.addEventListener('pageshow', sync);
  sync();
}
