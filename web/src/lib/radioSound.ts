export const EQ_FREQUENCIES = [60, 230, 910, 3600, 14000] as const;
export interface RadioSoundSettings { volume: number; enabled: boolean; gains: number[] }
const KEY = 'hm-radio-sound-v1';

export function readRadioSound(): RadioSoundSettings {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<RadioSoundSettings>;
    return {
      volume: typeof value.volume === 'number' && Number.isFinite(value.volume) ? Math.max(0, Math.min(1, value.volume)) : 0.65,
      enabled: value.enabled === true,
      gains: EQ_FREQUENCIES.map((_, i) => typeof value.gains?.[i] === 'number' && Number.isFinite(value.gains[i]) ? Math.max(-12, Math.min(12, value.gains[i])) : 0),
    };
  } catch { return { volume: 0.65, enabled: false, gains: [0, 0, 0, 0, 0] }; }
}

export function saveRadioSound(settings: RadioSoundSettings) {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* The current listening session still works. */ }
}

type RoutedContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

/** One graph per radio element; only connect after a user gesture successfully resumes the context. */
export class RadioEqualizer {
  private context: RoutedContext | null = null;
  private filters: BiquadFilterNode[] = [];
  private preamp: GainNode | null = null;
  private pending: Promise<void> | null = null;
  private disposed = false;
  constructor(private audio: HTMLAudioElement, private output: string) {}

  async setOutput(id: string) {
    if (this.context) {
      if (typeof this.context.setSinkId !== 'function') {
        if (id) throw new Error('Выбор выхода с эквалайзером не поддерживается этим браузером');
      } else await this.context.setSinkId(id);
    }
    this.output = id;
  }

  private async connect() {
    if (this.context) { await this.context.resume(); return; }
    if (typeof AudioContext === 'undefined') throw new Error('Эквалайзер недоступен в этом браузере');
    const context: RoutedContext = new AudioContext();
    try {
      if (this.output) {
        if (!context.setSinkId) throw new Error('Этот браузер не поддерживает эквалайзер на выбранном аудиовыходе');
        await context.setSinkId(this.output);
      }
      await context.resume();
      if (context.state !== 'running' || this.disposed) throw new Error('Нажмите кнопку воспроизведения, затем включите эквалайзер');
      const preamp = context.createGain();
      const filters = EQ_FREQUENCIES.map((frequency) => {
        const filter = context.createBiquadFilter();
        filter.type = 'peaking'; filter.frequency.value = frequency; filter.Q.value = 1;
        return filter;
      });
      preamp.connect(filters[0]);
      filters.forEach((filter, i) => filter.connect(filters[i + 1] || context.destination));
      const source = context.createMediaElementSource(this.audio);
      source.connect(preamp);
      this.context = context; this.preamp = preamp; this.filters = filters;
    } catch (e) { await context.close(); throw e; }
  }

  async apply(settings: RadioSoundSettings) {
    if (!this.context && !settings.enabled) return;
    if (!this.pending) this.pending = this.connect().finally(() => { this.pending = null; });
    await this.pending;
    const gains = settings.enabled ? settings.gains : [0, 0, 0, 0, 0];
    // Leave headroom for boosted bands instead of clipping the signal.
    if (this.preamp) this.preamp.gain.value = Math.pow(10, -Math.max(0, ...gains) / 20);
    this.filters.forEach((filter, i) => { filter.gain.value = gains[i]; });
  }

  async resume() { if (this.context?.state === 'suspended') await this.context.resume(); }
  dispose() { this.disposed = true; if (this.context) void this.context.close(); }
}
