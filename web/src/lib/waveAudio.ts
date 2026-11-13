import { isDesktop } from './desktop';

/** Smoothed-loudness source for the «Моя волна» glow (`components/WaveGlow.tsx`, mounted only by the desktop hero): an
 * `AnalyserNode` on the page player's `<audio>` (`createMediaElementSource`). Once connected, the sound of that element
 * goes only through the AudioContext, so this is careful:
 *  - only on a computer in a plain browser (`isDesktop()`): nothing else ever touches the `<audio>`, and inside the app
 *    the native player plays and the page has no sound,
 *  - the element is connected only while it is playing and the context is already `running` (a suspended context
 *    would make it silent) and plays from the same origin (a cross-origin source without CORS would be muted),
 *  - the context is resumed again on every `play` and when the browser suspends it,
 *  - `localStorage['hm-wave-audio'] = '0'` switches it off.
 * Without it the glow has no loudness input at all (a still, calm shape) — nothing else depends on it. */

const FLAG = 'hm-wave-audio';

export function loudnessEnabled(): boolean {
  if (!isDesktop() || typeof AudioContext === 'undefined') return false;
  try {
    if (localStorage.getItem(FLAG) === '0') return false;
  } catch { /* storage unavailable: the default below */ }
  return true;
}

type OutputAudioContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };
let ctx: OutputAudioContext | null = null;
let pendingContext: OutputAudioContext | null = null;
let analyser: AnalyserNode | null = null;
let source: MediaElementAudioSourceNode | null = null;
let connecting = false;
let buf: Float32Array<ArrayBuffer> | null = null;
let outputId = '';

/** Once connected, Web Audio owns the sound, so switching only the media element is insufficient. */
export async function setLoudnessOutput(id: string): Promise<void> {
  const context = ctx ?? pendingContext;
  if (context) {
    if (typeof context.setSinkId !== 'function') {
      if (id) throw new Error('AudioContext output selection is unavailable');
    } else await context.setSinkId(id);
  }
  outputId = id;
}

/** Connects the analyser to `a` (once). Safe to call on every `playing`; does nothing when it isn't safe. */
export async function attachLoudness(a: HTMLAudioElement): Promise<void> {
  if (source || connecting || !loudnessEnabled() || a.paused || !a.src) return;
  try {
    if (new URL(a.src, location.href).origin !== location.origin) return;
  } catch { return; }
  connecting = true;
  try {
    const c: OutputAudioContext = new AudioContext();
    pendingContext = c;
    if (outputId) {
      if (typeof c.setSinkId !== 'function') { await c.close(); return; }
      try { await c.setSinkId(outputId); }
      catch { await c.close(); return; }
    }
    if (c.state !== 'running') await c.resume().catch(() => undefined);
    // Still not running (no user gesture yet): connecting would silence the player, so leave it as it is.
    if (c.state !== 'running' || a.paused) { void c.close().catch(() => undefined); return; }
    const an = c.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0;
    const src = c.createMediaElementSource(a);
    src.connect(an);
    an.connect(c.destination);
    ctx = c; analyser = an; source = src;
    buf = new Float32Array(new ArrayBuffer(an.fftSize * 4));
    const wake = () => { if (c.state !== 'running') void c.resume().catch(() => undefined); };
    a.addEventListener('play', wake);
    a.addEventListener('playing', wake);
    c.addEventListener('statechange', wake);
  } catch (e) {
    console.warn('Wave loudness is unavailable', e);
  } finally {
    pendingContext = null;
    connecting = false;
  }
}

/** Instantaneous RMS of what plays, 0..1 (0 when not connected). The caller smooths it. */
export function readRms(): number {
  if (!analyser || !buf || ctx?.state !== 'running') return 0;
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
}
