import { settings } from "./settings";

/**
 * Sound effects, synthesised on the fly with the Web Audio API.
 *
 * No audio files are shipped: every effect is a few oscillators and filtered
 * noise bursts, so the whole soundtrack costs a few kilobytes and loads
 * instantly. Browsers only allow audio after a gesture, so `unlock()` is
 * called from the first tap/click.
 */
type Wave = OscillatorType;

class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly lastAt = new Map<string, number>();

  /** Create / resume the audio context. Safe to call repeatedly. */
  unlock(): void {
    if (typeof AudioContext === "undefined") return;
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 6;
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(comp).connect(this.ctx.destination);

      // One second of white noise, reused by every burst.
      const length = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** Mute everything while the page is hidden or the platform pauses us. */
  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume();
  }

  private get ready(): boolean {
    return settings.sound && this.ctx !== null && this.ctx.state === "running";
  }

  /** Drop a sound if the same one just played (stops machine-gun stacking). */
  private gate(name: string, minGapMs: number): boolean {
    const now = performance.now();
    if (now - (this.lastAt.get(name) ?? -1e9) < minGapMs) return false;
    this.lastAt.set(name, now);
    return true;
  }

  private tone(f0: number, f1: number, dur: number, type: Wave, vol: number, delay = 0, attack = 0.004): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private hiss(
    type: BiquadFilterType,
    f0: number,
    f1: number,
    q: number,
    dur: number,
    vol: number,
    delay = 0,
    attack = 0.004,
  ): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) filter.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(gain).connect(this.master!);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  /* ───────────────────────────── the effects ───────────────────────────── */

  click(): void {
    if (!this.ready || !this.gate("click", 40)) return;
    this.tone(520, 780, 0.07, "square", 0.07);
  }

  /** A man striking the ball. `power` 0..1. */
  kick(power: number): void {
    if (!this.ready || !this.gate("kick", 35)) return;
    const p = Math.min(1, Math.max(0.1, power));
    this.tone(150 + p * 90, 48, 0.14 + p * 0.06, "sine", 0.35 + p * 0.4);
    this.hiss("bandpass", 1500 + p * 1500, 700, 1.2, 0.05, 0.25 + p * 0.3);
    if (p > 0.55) this.tone(700, 300, 0.07, "triangle", 0.12);
  }

  /** The ball nudged or blocked: a drier, woodier clack. */
  clack(power: number): void {
    if (!this.ready || !this.gate("clack", 45)) return;
    const p = Math.min(1, Math.max(0.1, power));
    this.tone(1000 + p * 300, 480, 0.05, "triangle", 0.12 + p * 0.18);
    this.hiss("highpass", 3200, 3200, 0.7, 0.03, 0.12 + p * 0.1);
  }

  wall(power: number): void {
    if (!this.ready || !this.gate("wall", 60)) return;
    const p = Math.min(1, Math.max(0.1, power));
    this.tone(250, 130, 0.1, "triangle", 0.12 + p * 0.22);
    this.hiss("lowpass", 900, 500, 0.8, 0.06, 0.1 + p * 0.15);
  }

  whoosh(power = 0.6): void {
    if (!this.ready || !this.gate("whoosh", 120)) return;
    this.hiss("bandpass", 350, 2600, 1.5, 0.2, 0.1 + power * 0.12, 0, 0.06);
  }

  /** A word popping onto the screen. `i` raises the pitch word by word. */
  pop(i = 0): void {
    if (!this.ready || !this.gate("pop", 50)) return;
    this.tone(260 + i * 80, 560 + i * 110, 0.1, "sine", 0.17);
  }

  serve(): void {
    if (!this.ready) return;
    this.tone(380, 820, 0.09, "sine", 0.14);
  }

  tick(): void {
    if (!this.ready) return;
    this.tone(660, 660, 0.11, "square", 0.1);
  }

  go(): void {
    if (!this.ready) return;
    this.tone(990, 990, 0.34, "square", 0.12);
    this.tone(1320, 1320, 0.34, "triangle", 0.1, 0.02);
  }

  save(): void {
    if (!this.ready || !this.gate("save", 200)) return;
    this.tone(880, 880, 0.18, "triangle", 0.2);
    this.tone(1320, 1320, 0.22, "sine", 0.12, 0.05);
  }

  /** Time dropping into slow motion. */
  slowmo(): void {
    if (!this.ready) return;
    this.tone(700, 110, 0.5, "sine", 0.18);
    this.hiss("lowpass", 1800, 200, 0.7, 0.5, 0.12);
  }

  /** We scored: air-horn, sparkle run and a swelling crowd. */
  goal(): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    for (const [f, vol] of [
      [311, 0.11],
      [392, 0.1],
      [196, 0.09],
    ] as const) {
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      osc.type = "sawtooth";
      osc.frequency.value = f;
      osc.frequency.linearRampToValueAtTime(f * 1.02, t + 0.7);
      filter.type = "lowpass";
      filter.frequency.value = 1500;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(vol, t + 0.03);
      gain.gain.setValueAtTime(vol, t + 0.45);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
      osc.connect(filter).connect(gain).connect(this.master!);
      osc.start(t);
      osc.stop(t + 0.9);
    }
    [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, f, 0.2, "triangle", 0.12, 0.08 + i * 0.07));
    this.hiss("bandpass", 900, 1500, 0.5, 1.8, 0.2, 0.05, 0.5);
    this.hiss("highpass", 4000, 6000, 0.7, 0.4, 0.08, 0.02);
  }

  /** They scored on us: a sad trombone. */
  concede(): void {
    if (!this.ready) return;
    this.tone(330, 300, 0.22, "sawtooth", 0.1);
    this.tone(294, 262, 0.22, "sawtooth", 0.1, 0.22);
    this.tone(262, 233, 0.22, "sawtooth", 0.1, 0.44);
    this.tone(233, 110, 0.7, "sawtooth", 0.12, 0.66);
    this.hiss("lowpass", 700, 300, 0.7, 1.2, 0.1, 0.1, 0.3);
  }

  win(): void {
    if (!this.ready) return;
    [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => this.tone(f, f, 0.22, "triangle", 0.16, i * 0.11));
    this.hiss("bandpass", 1100, 1700, 0.5, 2.2, 0.18, 0.3, 0.6);
  }

  lose(): void {
    if (!this.ready) return;
    [392, 349, 311, 262].forEach((f, i) => this.tone(f, f * 0.98, 0.32, "triangle", 0.16, i * 0.2));
  }
}

export const sfx = new Sfx();

/** Haptic buzz where supported (mostly Android). */
export function buzz(pattern: number | number[]): void {
  if (!settings.haptics) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* some browsers throw without a user gesture */
  }
}
