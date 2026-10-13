/**
 * Synthesised sounds (Web Audio, no assets): alarm tones by level, the
 * radio / phone ring while a call waits, a squelch burst when a call is
 * answered, and a short click for commands. Mute is persisted. The one
 * recorded sound, the inverter of the train listened to, is in vvvf.ts.
 */
import { loadPref, savePref } from './layout';
import { VvvfSound, type VvvfMode } from './vvvf';

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = loadPref('muted', false);
  /** the inverter sound of the selected train, switched on and off in 设置 › 走行音 */
  traction = loadPref('traction', true);
  private ringTimer = 0;
  private alarmTimer = 0;
  private overTimer = 0;
  private vvvf: VvvfSound | null = null;

  constructor() {
    const unlock = () => {
      this.ensure();
      void this.ctx?.resume();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  private ensure() {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.35;
      this.master.connect(this.ctx.destination);
      this.vvvf = new VvvfSound(this.ctx, this.master);
    } catch {
      this.ctx = null;
    }
  }

  setMuted(m: boolean) {
    this.muted = m;
    savePref('muted', m);
    if (this.master) this.master.gain.value = m ? 0 : 0.35;
    if (m) { this.stopRing(); this.stopAlarm(); this.setOverspeed(false); }
  }

  private tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', vol = 0.6) {
    if (!this.ctx || !this.master || this.muted) return;
    const t0 = this.ctx.currentTime + start;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.012);
    g.gain.setValueAtTime(vol, t0 + dur - 0.03);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  /** one alarm sound by level */
  alarm(level: 'A' | 'B' | 'C') {
    this.ensure();
    if (level === 'A') { this.tone(988, 0, 0.18, 'square', 0.35); this.tone(740, 0.22, 0.18, 'square', 0.35); this.tone(988, 0.44, 0.18, 'square', 0.35); }
    else if (level === 'B') { this.tone(880, 0, 0.16, 'triangle', 0.5); this.tone(660, 0.2, 0.22, 'triangle', 0.5); }
    else this.tone(660, 0, 0.18, 'sine', 0.5);
  }

  /** repeat the A tone while there are unacknowledged A alarms */
  setAlarmLoop(on: boolean) {
    if (on && !this.alarmTimer) {
      this.alarm('A');
      this.alarmTimer = window.setInterval(() => this.alarm('A'), 4000);
    } else if (!on) this.stopAlarm();
  }

  private stopAlarm() {
    if (this.alarmTimer) { clearInterval(this.alarmTimer); this.alarmTimer = 0; }
  }

  /** telephone-style double ring, repeated while a call is waiting */
  setRinging(on: boolean) {
    if (on && !this.ringTimer) {
      const ring = () => {
        for (let i = 0; i < 2; i++) {
          for (let k = 0; k < 8; k++) {
            this.tone(k % 2 ? 480 : 440, i * 0.45 + k * 0.05, 0.05, 'sine', 0.35);
          }
        }
      };
      this.ensure();
      ring();
      this.ringTimer = window.setInterval(ring, 2600);
    } else if (!on) this.stopRing();
  }

  private stopRing() {
    if (this.ringTimer) { clearInterval(this.ringTimer); this.ringTimer = 0; }
  }

  /** radio squelch: band-passed noise burst */
  squelch() {
    this.ensure();
    if (!this.ctx || !this.master || this.muted) return;
    const len = Math.floor(this.ctx.sampleRate * 0.22);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.value = 0.5;
    src.connect(bp).connect(g).connect(this.master);
    src.start();
    this.tone(1200, 0.2, 0.06, 'sine', 0.25);
  }

  /** overspeed warning in the cab of a manually driven train (above the permitted speed, before the EB) */
  setOverspeed(on: boolean) {
    if (on && !this.overTimer) {
      const beep = () => this.tone(1250, 0, 0.12, 'square', 0.25);
      this.ensure();
      beep();
      this.overTimer = window.setInterval(beep, 450);
    } else if (!on && this.overTimer) { clearInterval(this.overTimer); this.overTimer = 0; }
  }

  /** two-tone chime in the cab: a lower limit or the end of authority is announced */
  chime() {
    this.ensure();
    this.tone(880, 0, 0.16, 'sine', 0.45);
    this.tone(660, 0.2, 0.3, 'sine', 0.45);
  }

  /**
   * Door warning of the train listened to (synthesised 【假设】: the 02A05 tone is
   * not recorded): a few short beeps as the doors open, a beep train while they
   * close. Goes with the traction sound setting (the sounds on board).
   */
  doorChime(closing: boolean) {
    if (!this.traction) return;
    this.ensure();
    const n = closing ? 12 : 3;
    for (let i = 0; i < n; i++) {
      this.tone(2300, i * 0.25, 0.13, 'triangle', 0.22);
      this.tone(4600, i * 0.25, 0.13, 'sine', 0.05);
    }
  }

  setTractionOn(on: boolean) {
    this.traction = on;
    savePref('traction', on);
  }

  /** the inverter sound of the train listened to (see vvvf.ts) */
  setTraction(mode: VvvfMode, v: number, level: number) {
    this.vvvf?.set(this.muted || !this.traction ? 'off' : mode, v, level);
  }

  click() {
    this.ensure();
    this.tone(1400, 0, 0.03, 'square', 0.12);
  }
}
