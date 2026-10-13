/**
 * The 02A05 inverter sound of the selected train, played from the
 * recordings by speed: short overlapping grains are read from where the
 * recording runs at the train's stator frequency (src/data/vvvf.ts), so the
 * pitch, and the steps between PWM modes, follow the train's speed rather
 * than the recording's clock. Under power the start recording, in electric
 * braking the stop recording down to a stand; holding speed (ATO cruise, the
 * inverter on at low torque) the steady stretch before the brake, which
 * sounds unlike a start at the same speed. Coasting is silent (the inverter is
 * off), as is a stand and the EB (friction brake only). Missing recordings
 * (they are not in the repository) leave it silent. Every train sounds like
 * an 02A05 for now; other stock needs its own recordings.
 */
import { VVVF_BRAKE, VVVF_HZ_PER_MS, VVVF_TRACTION } from '../data/vvvf';

export type VvvfMode = 'power' | 'brake' | 'cruise' | 'off';
type Clip = 'power' | 'brake';

/** grain length and spacing (s): triangular windows overlapping by half sum to a constant */
const GRAIN = 0.12;
const HOP = GRAIN / 2;
const LOOKAHEAD = 0.12;
/** random offset of each grain, so a held position does not buzz at the grain rate */
const JITTER = 0.025;
const VOLUME = 1.4;
/** stop scheduling grains this long after the sound faded out (s) */
const IDLE = 0.8;

/**
 * Steady stretches (s in the clip) and their f₁ (Hz), read back and forth.
 * Their harmonics are fixed multiples of f₁ (synchronous modulation: 5th,
 * 7th, 11th, 13th…), so away from their own f₁ they are resampled by the
 * ratio. 'power' ends the start (≈70 km/h); 'steady' opens the stop
 * recording, cruising before the brake — the same sound as p01 93–99 s.
 */
const PLATEAU: Record<'power' | 'steady', { clip: Clip; t: [number, number]; f: number }> = {
  power: { clip: 'power', t: [28.8, 33.1], f: 93.4 },
  steady: { clip: 'brake', t: [0.6, 7.9], f: 80.7 },
};
/** cruise below this f₁ blends into the start recording at the same f₁ (Hz), fully below CRUISE_LOW */
const CRUISE_HIGH = 64;
const CRUISE_LOW = 54;
/** the electric brake fades out in the last km/h of the recording: lift it below this f₁ (Hz) */
const BRAKE_TAIL = 8;

/** time in a recording where it runs at f₁, by linear interpolation of its table; NaN beyond its steady end */
function timeAt(table: [number, number][], f: number): number {
  const rising = table[table.length - 1][1] > table[0][1];
  const steady = rising ? table[table.length - 1][1] : table[0][1];
  if (f >= steady) return NaN;
  if (f <= 0) return rising ? table[0][0] : table[table.length - 1][0];
  for (let i = 1; i < table.length; i++) {
    const [t0, f0] = table[i - 1], [t1, f1] = table[i];
    if ((f - f0) * (f - f1) <= 0 && f0 !== f1) return t0 + (t1 - t0) * (f - f0) / (f1 - f0);
  }
  return NaN;
}

interface Grain { clip: Clip; pos: number; rate: number }

export class VvvfSound {
  private buf: Partial<Record<Clip, AudioBuffer>> = {};
  private out: GainNode;
  private timer = 0;
  private next = 0;
  private lastOn = 0;
  /** what is being played (kept while the sound fades out) */
  private voice: Exclude<VvvfMode, 'off'> = 'power';
  private f = 0;

  constructor(private ctx: AudioContext, dest: AudioNode) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);
    const base = import.meta.env.BASE_URL;
    for (const [k, file] of [['power', 'traction'], ['brake', 'brake']] as const) {
      fetch(`${base}sounds/vvvf/${file}.mp3`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((b) => ctx.decodeAudioData(b))
        .then((a) => { this.buf[k] = a; })
        .catch(() => { /* no recording: silent */ });
    }
  }

  /** the train listened to: what its inverter does, its speed (m/s) and how hard it pulls or brakes (0–1) */
  set(mode: VvvfMode, v: number, level: number) {
    const now = this.ctx.currentTime;
    const f = v * VVVF_HZ_PER_MS;
    let target = mode === 'off' ? 0 : VOLUME * (0.35 + 0.65 * Math.min(1, Math.max(0, level)));
    if (mode === 'brake' && f < BRAKE_TAIL) target *= 2 - f / BRAKE_TAIL;
    this.out.gain.setTargetAtTime(target, now, 0.12);
    if (mode === 'off') return;
    this.voice = mode;
    this.f = f;
    this.lastOn = now;
    if (!this.timer && this.buf.power && this.buf.brake) {
      this.next = now + 0.02;
      this.timer = window.setInterval(() => this.pump(), 30);
    }
  }

  /** a steady stretch wandered over at the recording's own pace, resampled to f₁ */
  private plateau(which: keyof typeof PLATEAU): Grain {
    const p = PLATEAU[which];
    const span = Math.min(p.t[1], this.buf[p.clip]!.duration) - p.t[0];
    const u = this.ctx.currentTime % (2 * span);
    return { clip: p.clip, pos: p.t[0] + (u < span ? u : 2 * span - u), rate: Math.max(0.3, this.f / p.f) };
  }

  private grain(): Grain {
    const f = this.f;
    if (this.voice === 'cruise') {
      const w = (f - CRUISE_LOW) / (CRUISE_HIGH - CRUISE_LOW);
      if (Math.random() < w) return this.plateau('steady');
    }
    if (this.voice === 'brake') {
      const t = timeAt(VVVF_BRAKE, f);
      return Number.isNaN(t) ? this.plateau('steady') : { clip: 'brake', pos: t, rate: 1 };
    }
    const t = timeAt(VVVF_TRACTION, f);
    return Number.isNaN(t) ? this.plateau('power') : { clip: 'power', pos: t, rate: 1 };
  }

  private pump() {
    const ctx = this.ctx;
    if (ctx.currentTime - this.lastOn > IDLE) { clearInterval(this.timer); this.timer = 0; return; }
    if (this.next < ctx.currentTime) this.next = ctx.currentTime;
    while (this.next < ctx.currentTime + LOOKAHEAD) {
      const at = this.next;
      const gr = this.grain();
      const buf = this.buf[gr.clip]!;
      const len = GRAIN * gr.rate;
      const pos = Math.min(buf.duration - len, Math.max(0, gr.pos - len / 2 + (Math.random() * 2 - 1) * JITTER));
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = gr.rate;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(1, at + GRAIN / 2);
      g.gain.linearRampToValueAtTime(0, at + GRAIN);
      src.connect(g).connect(this.out);
      src.start(at, pos);
      src.stop(at + GRAIN);
      this.next += HOP;
    }
  }
}
