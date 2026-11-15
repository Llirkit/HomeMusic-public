import type { ListenState } from './listen';

/** Media3 owns the sound and timeline; the web player remains the queue/UI source of truth. */
export type AudioTransport = Pick<HTMLAudioElement, 'src' | 'preload' | 'volume' | 'currentTime' | 'duration' | 'paused' | 'ended' | 'readyState' | 'addEventListener' | 'getAttribute' | 'removeAttribute' | 'load' | 'play' | 'pause'>;
type Snapshot = { id: string; index: number; position: number; duration: number; playing: boolean; playWhenReady: boolean; state: number; cycle: number; error: boolean };
declare global {
  interface Window {
    SpotikPlayback?: { command(json: string): void };
    hmAndroidPlayback?: (snapshot: Snapshot) => void;
  }
}
export const hasAndroidAudio = () => typeof window.SpotikPlayback?.command === 'function';

export class AndroidAudio extends EventTarget implements AudioTransport {
  preload: HTMLAudioElement['preload'] = 'auto';
  duration = 0;
  paused = true;
  ended = false;
  readyState = 0;
  private source = '';
  private position = 0;
  private loudness = 1;
  private id = '';
  private lastQueue: ListenState['queue'] | null = null;
  private lastIndex = -1;
  private lastRepeat = '';
  private cycle = 0;
  private adopting = false;
  private lastState = 0;

  constructor(private getState: () => ListenState, private advance: (index: number, position: number, autoplay: boolean) => void, private offline: () => void) {
    super();
    window.hmAndroidPlayback = snapshot => this.receive(snapshot);
  }

  private send(op: string, data: Record<string, unknown> = {}) {
    window.SpotikPlayback?.command(JSON.stringify({ op, id: this.id, ...data }));
  }
  get src() { return this.source; }
  set src(value: string) {
    this.source = new URL(value, location.href).href;
    if (this.adopting) return;
    this.id = crypto.randomUUID();
    this.readyState = 0;
    this.position = 0;
    this.ended = false;
    this.cycle = 0;
    this.lastState = 0;
    this.syncQueue(true);
  }
  syncQueue(load = false) {
    const s = this.getState();
    if (!this.source || !s.track || this.adopting) return;
    if (!load && s.queue === this.lastQueue && s.index === this.lastIndex && s.repeat === this.lastRepeat) return;
    this.lastQueue = s.queue;
    this.lastIndex = s.index;
    this.lastRepeat = s.repeat;
    this.send(load ? 'load' : 'queue', { queue: s.queue, index: s.index, repeat: s.context.startsWith('wave:') && s.repeat === 'all' ? 'off' : s.repeat, position: s.position, volume: s.volume });
  }
  get currentTime() { return this.position; }
  set currentTime(value: number) {
    this.position = value;
    this.dispatchEvent(new Event('seeking'));
    this.send('seek', { position: value });
    this.dispatchEvent(new Event('seeked'));
  }
  get volume() { return this.loudness; }
  set volume(value: number) { this.loudness = value; this.send('volume', { volume: value }); }
  getAttribute(name: string) { return name === 'src' && this.source ? this.source : null; }
  removeAttribute(name: string) { if (name === 'src') this.source = ''; }
  load() { if (!this.source) this.send('stop'); }
  async play() {
    if (!this.source) return;
    this.paused = false;
    this.ended = false;
    this.send('play');
    this.dispatchEvent(new Event('play'));
  }
  pause() { this.paused = true; this.send('pause'); this.dispatchEvent(new Event('pause')); }

  private receive(s: Snapshot) {
    if (!this.id || s.id !== this.id) return;
    if (s.state === -1) { this.offline(); return; }
    if (s.state === -2) { this.dispatchEvent(new Event('error')); return; }
    if (!this.source) return;
    const before = this.getState();
    if (s.index !== before.index || s.cycle !== this.cycle) {
      if (!before.queue[s.index]) return;
      this.adopting = true;
      this.cycle = s.cycle;
      this.lastState = 0;
      try { this.advance(s.index, s.position, s.playWhenReady); }
      finally { this.adopting = false; }
      this.lastQueue = this.getState().queue;
      this.lastIndex = s.index;
      this.lastRepeat = this.getState().repeat;
    }
    const wasPaused = this.paused;
    const wasEnded = this.ended;
    const durationChanged = this.duration !== s.duration;
    this.position = s.position;
    this.duration = s.duration;
    this.paused = !s.playWhenReady;
    this.ended = s.state === 4;
    this.readyState = s.state === 3 || s.state === 4 ? 4 : 0;
    if (durationChanged && this.duration > 0) this.dispatchEvent(new Event('loadedmetadata'));
    this.dispatchEvent(new Event('timeupdate'));
    if (s.error) this.dispatchEvent(new Event('error'));
    else if (this.ended && !wasEnded) this.dispatchEvent(new Event('ended'));
    else if (this.paused && !wasPaused) this.dispatchEvent(new Event('pause'));
    else if (s.playing && (this.lastState !== 3 || wasPaused)) this.dispatchEvent(new Event('playing'));
    else if (s.state === 2 && this.lastState !== 2) this.dispatchEvent(new Event('waiting'));
    this.lastState = s.state;
  }
}
