/**
 * Cab driver display (DMI) of a followed train, drawn after the Casco DMI
 * fitted to Shanghai Line 2 (02A05) cabs: navy screen, terminus / next
 * station / train number across the top, 0–120 km/h dial with the permitted
 * speed in red on the rim, mode-level and door mode on the right, the
 * available-mode row and stopping-window hexagon under the dial, date / time
 * and the message log at the bottom. Elements that could not be read from the
 * reference photos are listed in the README (DMI section).
 *
 * The master controller (牵引/制动手柄) for manual CM / RM driving sits below it.
 */
import { h } from './dom';
import type { DmiData, TrainSnap } from '../sim/model';
import { FONT_CN, fmtTime } from './theme';

const W = 760;
const H = 640;
/** dial range and sweep: 0–120 km/h over 300°, 60 at 12 o'clock (Line 2 photos) */
const VMAX = 120;
const SWEEP = (300 * Math.PI) / 180;
const LATIN = 'Arial, "Helvetica Neue", Helvetica, "Liberation Sans", sans-serif';
const FONT = `${LATIN}, ${FONT_CN}`;

/** colours sampled from the clear Casco reference photo */
const C = {
  bg: '#161d49',
  logBg: '#19203d',
  logBorder: '#56618a',
  blue: '#108ce4',
  white: '#ffffff',
  green: '#18e713',
  hexGreen: '#2ccd3b',
  red: '#d93d4c',
  yellow: '#f0e000',
  hl: '#cdf2f1',
  hlText: '#13204a',
  btn: '#e2edf5',
  scroll: '#b7c0c8',
  scrollArrow: '#7a8592',
  dim: '#5d688f',
};

export const NOTCHES: { v: number; label: string; cls: string }[] = [
  { v: 4, label: 'P4', cls: 't' }, { v: 3, label: 'P3', cls: 't' }, { v: 2, label: 'P2', cls: 't' }, { v: 1, label: 'P1', cls: 't' },
  { v: 0, label: '惰行', cls: '' },
  { v: -1, label: 'B1', cls: 'b' }, { v: -2, label: 'B2', cls: 'b' }, { v: -3, label: 'B3', cls: 'b' }, { v: -4, label: 'B4', cls: 'b' },
  { v: -5, label: 'B5', cls: 'b' }, { v: -6, label: 'B6', cls: 'b' }, { v: -7, label: 'B7', cls: 'b' }, { v: -8, label: '紧急', cls: 'eb' },
];

/** on-screen wording */
const modeWord = (m: string) => (m === 'AM' ? 'DTO' : m);
const availWord = (a: DmiData['avail']) => (a.mode === 'RM' ? 'RM' : `${modeWord(a.mode)}-${a.level === 'CBTC' ? 'C' : 'T'}`);

// dial geometry
const CX = 205;
const CY = 268;
const R = 165;
const LOG = { x: 150, y: 500, w: 350, row: 26, rows: 5 };
const BTN_UP = { x: 506, y: 500, w: 56, h: 62 };
const BTN_DN = { x: 506, y: 570, w: 56, h: 62 };

export class Dmi {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private res = 1;
  lever: HTMLElement;
  private notchEls: HTMLElement[] = [];
  onNotch: (n: number) => void = () => undefined;
  /** selected log row (index into the newest-first log) and first visible row */
  private sel = 0;
  private top = 0;
  private newestKey = '';
  private last: { t: TrainSnap; d: DmiData | null; now: number } | null = null;

  constructor(resolution: () => number) {
    this.canvas = h('canvas', { class: 'dmi' }) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('click', (e) => this.click(e));
    this.lever = h('div', { class: 'lever', title: '牵引/制动手柄：↑/W 加牵引 · ↓/S 加制动 · X 惰行 · E 紧急制动' });
    for (const n of NOTCHES) {
      const e = h('div', { class: `notch ${n.cls}`, onclick: () => this.onNotch(n.v) }, n.label);
      this.notchEls.push(e);
      this.lever.append(e);
    }
    this.lever.addEventListener('wheel', (e) => {
      e.preventDefault();
      const cur = NOTCHES.findIndex((n) => n.v === this.curNotch);
      const next = Math.max(0, Math.min(NOTCHES.length - 1, cur + (e.deltaY > 0 ? 1 : -1)));
      this.onNotch(NOTCHES[next].v);
    }, { passive: false });
    this.el = h('div', { class: 'dmi-wrap' }, this.canvas, this.lever);
    this.setResolution(resolution());
  }

  private curNotch = 0;

  setResolution(r: number) {
    this.res = Math.max(1, r);
    this.canvas.width = Math.round(W * this.res);
    this.canvas.height = Math.round(H * this.res);
    if (this.last) this.draw(this.last.t, this.last.d, this.last.now);
  }

  showLever(on: boolean) {
    this.lever.style.display = on ? 'flex' : 'none';
  }

  /** a different train: start the log at its newest entry */
  reset() {
    this.sel = 0;
    this.top = 0;
    this.newestKey = '';
    this.last = null;
  }

  private click(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) * W) / r.width;
    const y = ((e.clientY - r.top) * H) / r.height;
    const inside = (b: { x: number; y: number; w: number; h: number }) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
    const n = this.last?.d?.log.length ?? 0;
    if (inside(BTN_UP)) this.select(this.sel - 1, n);
    else if (inside(BTN_DN)) this.select(this.sel + 1, n);
    else if (x >= LOG.x && x <= LOG.x + LOG.w && y >= LOG.y && y <= LOG.y + LOG.row * LOG.rows) this.select(this.top + Math.floor((y - LOG.y) / LOG.row), n);
    else return;
    if (this.last) this.draw(this.last.t, this.last.d, this.last.now);
  }

  private select(i: number, n: number) {
    this.sel = Math.max(0, Math.min(Math.max(0, n - 1), i));
    if (this.sel < this.top) this.top = this.sel;
    if (this.sel >= this.top + LOG.rows) this.top = this.sel - LOG.rows + 1;
  }

  draw(t: TrainSnap, d: DmiData | null, now: number) {
    this.last = { t, d, now };
    const c = this.ctx;
    c.setTransform(this.res, 0, 0, this.res, 0, 0);
    c.fillStyle = C.bg;
    c.fillRect(0, 0, W, H);
    c.textBaseline = 'alphabetic';
    const v = t.v * 3.6;
    const vp = Math.max(0, Math.min(VMAX, t.vPermit * 3.6));
    const eb = t.eb;
    const over = !eb && v > vp + 0.5;

    this.topBar(c, t, d, now);
    this.dial(c, v, vp, eb, over, t);
    this.rightColumn(c, t, d, now, eb);
    this.statusRow(c, t, d);
    this.bottom(c, t, d, now);

    this.curNotch = t.notch;
    this.notchEls.forEach((e, i) => e.classList.toggle('on', t.manual && NOTCHES[i].v === t.notch));
  }

  // ------------------------------------------------------------ top bar

  private topBar(c: CanvasRenderingContext2D, t: TrainSnap, d: DmiData | null, now: number) {
    const field = (x: number, label: string, value: string, maxW: number) => {
      c.textAlign = 'left';
      c.fillStyle = C.blue;
      c.font = `20px ${FONT}`;
      c.fillText(label, x, 28);
      c.font = `bold 22px ${FONT}`;
      c.fillText(value, x, 56, maxW);
    };
    field(16, '终点站', d?.dest ?? t.dest ?? '—', 170);
    field(196, '下一站', d?.next ?? '—', 112);
    field(318, '车次', t.trip, 72);
    c.fillStyle = C.white;
    c.font = `bold 24px ${FONT}`;
    c.fillText(d?.trainNo ?? '', 418, 36);
    c.font = `22px ${FONT}`;
    c.fillText(t.svc.replace(/^0+(?=\d)/, ''), 520, 36);
    // the white buttons at the top right (their captions are not legible on the photos)
    button(c, 676, 12, 70, 34);
    button(c, 576, 60, 170, 46);
    // departure time
    c.fillStyle = C.white;
    c.font = `18px ${FONT}`;
    c.textAlign = 'left';
    c.fillText('DEP', 418, 76);
    c.font = `bold 22px ${FONT}`;
    c.fillText(d && d.dep >= 0 ? fmtTime(d.dep) : '--:--:--', 418, 102);
    void now;
  }

  // ------------------------------------------------------------ speedometer

  private dial(c: CanvasRenderingContext2D, v: number, vp: number, eb: boolean, over: boolean, t: TrainSnap) {
    const ang = (s: number) => -Math.PI / 2 - SWEEP / 2 + (Math.max(0, Math.min(VMAX, s)) / VMAX) * SWEEP;
    const pt = (a: number, r: number): [number, number] => [CX + Math.cos(a) * r, CY + Math.sin(a) * r];
    // rim ring
    c.strokeStyle = C.white;
    c.lineWidth = 2;
    c.beginPath(); c.arc(CX, CY, R, ang(0), ang(VMAX)); c.stroke();
    // ticks: every 2 km/h, longer every 10, labelled every 20
    for (let s = 0; s <= VMAX; s += 2) {
      const a = ang(s);
      const long = s % 10 === 0;
      const [x1, y1] = pt(a, R);
      const [x2, y2] = pt(a, R - (s % 20 === 0 ? 20 : long ? 16 : 9));
      c.lineWidth = long ? 4 : 2;
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    }
    c.fillStyle = C.white;
    c.font = `bold 24px ${FONT}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let s = 0; s <= VMAX; s += 20) {
      const [x, y] = pt(ang(s), R - 42);
      c.fillText(String(s), x, y + 1);
    }
    // permitted speed: red arc on the outer rim from the permitted speed to the end of the scale + red marker
    if (t.phase !== 'failed') {
      c.strokeStyle = C.red;
      c.lineWidth = 6;
      c.lineCap = 'butt';
      c.beginPath(); c.arc(CX, CY, R + 5, ang(vp), ang(VMAX)); c.stroke();
      const a = ang(vp);
      const [tx, ty] = pt(a, R + 4);
      const [b1x, b1y] = pt(a - 0.07, R + 24);
      const [b2x, b2y] = pt(a + 0.07, R + 24);
      c.fillStyle = C.red;
      c.beginPath(); c.moveTo(tx, ty); c.lineTo(b1x, b1y); c.lineTo(b2x, b2y); c.closePath(); c.fill();
    }
    // needle: tapered white pointer from the hub
    const na = ang(v);
    const [nx, ny] = pt(na, R - 24);
    const [l1x, l1y] = pt(na - Math.PI / 2, 6);
    const [l2x, l2y] = pt(na + Math.PI / 2, 6);
    c.fillStyle = C.white;
    c.beginPath(); c.moveTo(l1x, l1y); c.lineTo(nx, ny); c.lineTo(l2x, l2y); c.closePath(); c.fill();
    // hub with the digital speed
    c.fillStyle = C.bg;
    c.beginPath(); c.arc(CX, CY, 32, 0, Math.PI * 2); c.fill();
    c.strokeStyle = C.white;
    c.lineWidth = 3;
    c.beginPath(); c.arc(CX, CY, 32, 0, Math.PI * 2); c.stroke();
    c.fillStyle = eb ? C.red : over ? C.yellow : C.white;
    c.font = `bold 28px ${FONT}`;
    c.fillText(String(Math.round(v)), CX, CY + 1);
    c.fillStyle = C.white;
    c.font = `bold 20px ${FONT}`;
    c.fillText('km/h', CX, CY + R - 16);
    c.textBaseline = 'alphabetic';
  }

  // ------------------------------------------------------------ right column

  private rightColumn(c: CanvasRenderingContext2D, t: TrainSnap, d: DmiData | null, now: number, eb: boolean) {
    // mode and level
    c.fillStyle = C.white;
    c.font = `bold 44px ${FONT}`;
    c.textAlign = 'left';
    c.fillText(modeWord(t.mode), 418, 172);
    c.fillText(t.level, 576, 172);
    // departure countdown bar (grey track, white remaining) + train status icon
    const bx = 418;
    const by = 204;
    c.fillStyle = '#7d869f';
    roundRect(c, bx, by, 128, 14, 7); c.fill();
    if (d && d.dwellTotal > 0 && d.dep >= 0) {
      const left = Math.max(0, d.dep - now);
      const f = Math.min(1, left / d.dwellTotal);
      c.fillStyle = C.white;
      roundRect(c, bx, by, Math.max(14, 128 * f), 14, 7); c.fill();
      c.font = `bold 20px ${FONT}`;
      c.fillText(`${Math.ceil(left)}s`, bx + 136, by + 15);
    }
    const state = eb ? 'eb' : t.a > 0.05 ? 'traction' : t.a < -0.12 && t.v > 0.05 ? 'brake' : 'coast';
    trainFront(c, 600, 188, state);
    // platform screen doors (pair of door leaves)
    const psd = d?.psd ?? 'none';
    const pc = psd === 'closed' ? C.green : psd === 'open' ? C.yellow : psd === 'fault' ? C.red : psd === 'bypass' ? '#ff9a2a' : C.dim;
    for (const x of [418, 460]) doorLeaf(c, x, 252, 32, 48, pc, psd === 'open');
    if (psd === 'bypass') { c.strokeStyle = '#ff9a2a'; c.lineWidth = 3; c.beginPath(); c.moveTo(414, 304); c.lineTo(496, 248); c.stroke(); }
    // door mode: bar + AA / MM, and the train door icon
    c.fillStyle = C.white;
    roundRect(c, 418, 330, 9, 40, 2); c.fill();
    c.font = `bold 40px ${FONT}`;
    c.fillText(t.mode === 'AM' ? 'AA' : 'MM', 434, 368);
    const dc = t.doors ? C.yellow : C.green;
    for (const x of [598, 624]) {
      c.fillStyle = dc;
      roundRect(c, x + (t.doors ? (x === 598 ? -4 : 4) : 0), 330, 20, 40, 3); c.fill();
      c.fillStyle = 'rgba(0,0,0,0.35)';
      c.fillRect(x + (t.doors ? (x === 598 ? -4 : 4) : 0) + 7, 336, 6, 28);
    }
    // supervision status line (extrapolated: the photos show no such state)
    let msg = '';
    let col = C.white;
    if (eb) { msg = '紧急制动'; col = C.red; }
    else if (t.v * 3.6 > t.vPermit * 3.6 + 0.5) { msg = '超速'; col = C.yellow; }
    else if (t.hold) { msg = '扣车'; col = C.yellow; }
    else if (t.manual) { msg = '人工驾驶'; col = C.white; }
    if (msg) {
      c.font = `bold 26px ${FONT}`;
      c.fillStyle = col;
      c.fillText(msg, 418, 424);
    }
  }

  // ------------------------------------------------------------ row under the dial

  private statusRow(c: CanvasRenderingContext2D, t: TrainSnap, d: DmiData | null) {
    const y = 468;
    wheel(c, 38, y);
    c.fillStyle = C.white;
    c.font = `bold 32px ${FONT}`;
    c.textAlign = 'left';
    c.fillText(d ? availWord(d.avail) : '', 72, y + 12);
    // train / door status: green = doors closed and locked, yellow = open, red = train fault
    trainIcon(c, 226, y, t.failed ? C.red : t.doors ? C.yellow : C.green);
    hexagon(c, 322, y, d?.stopWin ?? 'none');
  }

  // ------------------------------------------------------------ bottom: date / time, message log, target

  private bottom(c: CanvasRenderingContext2D, t: TrainSnap, d: DmiData | null, now: number) {
    c.fillStyle = C.white;
    c.textAlign = 'left';
    c.font = `bold 22px ${FONT}`;
    c.fillText(d?.date ?? '', 12, 546, 132);
    c.fillText(fmtTime(now), 24, 612);
    // log
    const log = d?.log ?? [];
    const key = log.length ? `${log[0].t}|${log[0].m}` : '';
    if (key !== this.newestKey) {
      if (this.newestKey && this.sel > 0) this.select(this.sel + 1, log.length);
      this.newestKey = key;
    }
    this.select(this.sel, log.length);
    c.fillStyle = C.logBg;
    c.fillRect(LOG.x, LOG.y, LOG.w, LOG.row * LOG.rows);
    c.strokeStyle = C.logBorder;
    c.lineWidth = 1;
    c.strokeRect(LOG.x + 0.5, LOG.y + 0.5, LOG.w - 1, LOG.row * LOG.rows - 1);
    c.font = `20px ${FONT}`;
    for (let i = 0; i < LOG.rows; i++) {
      const e = log[this.top + i];
      if (!e) break;
      const ry = LOG.y + i * LOG.row;
      const selected = this.top + i === this.sel;
      if (selected) { c.fillStyle = C.hl; c.fillRect(LOG.x + 2, ry + 2, LOG.w - 4, LOG.row - 2); }
      c.fillStyle = selected ? C.hlText : e.k === 'alarm' ? '#ff8a8a' : e.k === 'warn' ? '#ffe36a' : C.white;
      c.fillText(`${fmtTime(e.t, false)} ${e.m}`, LOG.x + 6, ry + 21, LOG.w - 12);
    }
    scrollButton(c, BTN_UP, true, this.sel > 0);
    scrollButton(c, BTN_DN, false, this.sel < log.length - 1);
    // target / authority readout (extrapolated, same visual language: blue label, white value)
    const x = 578;
    c.textAlign = 'left';
    if (t.phase === 'run' && t.tgtD >= 0 && t.tgtD < 5000) {
      c.fillStyle = C.blue;
      c.font = `20px ${FONT}`;
      c.fillText(`目标 ${t.tgtReason || ''}`, x, 518, W - x - 8);
      c.fillStyle = C.white;
      c.font = `bold 26px ${FONT}`;
      c.fillText(`${Math.round(t.tgtD)} m`, x, 548);
      c.font = `bold 22px ${FONT}`;
      c.fillText(`→ ${Math.round(t.tgtV * 3.6)} km/h`, x, 576);
    }
    if (d && d.maDist >= 0 && t.phase === 'run') {
      c.fillStyle = C.blue;
      c.font = `20px ${FONT}`;
      c.fillText('授权', x, 610);
      c.fillStyle = C.white;
      c.font = `bold 22px ${FONT}`;
      c.fillText(d.maDist >= 10000 ? `${(d.maDist / 1000).toFixed(1)} km` : `${Math.round(d.maDist)} m`, x + 46, 610);
    }
    if (!Number.isNaN(t.stopErr) && Math.abs(t.stopErr) < 5 && t.v < 0.05 && t.phase === 'run') {
      const e = t.stopErr;
      c.fillStyle = Math.abs(e) <= 0.5 ? C.green : C.yellow;
      c.font = `bold 22px ${FONT}`;
      c.fillText(`对标 ${e >= 0 ? '欠' : '过'}${Math.abs(e).toFixed(2)} m`, x, 632);
    }
  }
}

// ---------------------------------------------------------------- icons

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + hh, r);
  c.arcTo(x + w, y + hh, x, y + hh, r);
  c.arcTo(x, y + hh, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function button(c: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number) {
  c.fillStyle = C.btn;
  roundRect(c, x, y, w, hh, 3);
  c.fill();
}

function scrollButton(c: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }, up: boolean, active: boolean) {
  c.fillStyle = C.scroll;
  roundRect(c, b.x, b.y, b.w, b.h, 3);
  c.fill();
  c.fillStyle = active ? C.scrollArrow : '#a2abb4';
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const s = up ? -1 : 1;
  c.beginPath();
  c.moveTo(cx, cy + s * 12);
  c.lineTo(cx - 13, cy - s * 2);
  c.lineTo(cx - 5, cy - s * 2);
  c.lineTo(cx - 5, cy - s * 13);
  c.lineTo(cx + 5, cy - s * 13);
  c.lineTo(cx + 5, cy - s * 2);
  c.lineTo(cx + 13, cy - s * 2);
  c.closePath();
  c.fill();
}

/** wheel / axle status: scalloped ring with a letter (Line 2 photos) on an axle line (Casco) */
function wheel(c: CanvasRenderingContext2D, x: number, y: number) {
  c.strokeStyle = C.white;
  c.fillStyle = C.white;
  c.lineWidth = 3;
  c.beginPath(); c.moveTo(x - 30, y); c.lineTo(x - 17, y); c.moveTo(x + 17, y); c.lineTo(x + 30, y); c.stroke();
  c.beginPath();
  const n = 10;
  for (let i = 0; i <= n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? 17 : 14.5;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
  }
  c.closePath();
  c.stroke();
  c.beginPath(); c.arc(x, y, 10.5, 0, Math.PI * 2); c.lineWidth = 2; c.stroke();
  // the glyph inside reads as "B" on both Line 2 photos (blurry: see README)
  c.font = `bold 14px ${LATIN}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('B', x, y + 1);
  c.textAlign = 'left';
  c.textBaseline = 'alphabetic';
}

/** green train icon of the status row */
function trainIcon(c: CanvasRenderingContext2D, x: number, y: number, col: string) {
  c.fillStyle = col;
  roundRect(c, x - 26, y - 15, 52, 26, 6);
  c.fill();
  c.fillStyle = C.bg;
  c.fillRect(x - 19, y - 9, 13, 9);
  c.fillRect(x + 6, y - 9, 13, 9);
  c.fillStyle = col;
  c.fillRect(x - 22, y + 11, 8, 5);
  c.fillRect(x + 14, y + 11, 8, 5);
}

/** cab front in profile with the traction / brake arrow (right column) */
function trainFront(c: CanvasRenderingContext2D, x: number, y: number, state: 'traction' | 'brake' | 'coast' | 'eb') {
  const col = state === 'eb' ? C.red : C.white;
  c.fillStyle = col;
  c.beginPath();
  c.moveTo(x, y + 4);
  c.lineTo(x + 46, y + 4);
  c.quadraticCurveTo(x + 66, y + 6, x + 70, y + 32);
  c.lineTo(x, y + 32);
  c.closePath();
  c.fill();
  c.fillStyle = C.bg;
  c.fillRect(x + 8, y + 12, 14, 10);
  c.fillRect(x + 28, y + 12, 14, 10);
  c.beginPath(); c.moveTo(x + 48, y + 12); c.lineTo(x + 56, y + 12); c.lineTo(x + 62, y + 22); c.lineTo(x + 48, y + 22); c.closePath(); c.fill();
  if (state === 'coast') return;
  const ac = state === 'traction' ? C.green : state === 'brake' ? C.yellow : C.red;
  c.fillStyle = ac;
  const ax = x + 58;
  const ay = y + 38;
  c.beginPath();
  if (state === 'traction') { c.moveTo(ax, ay); c.lineTo(ax - 10, ay + 12); c.lineTo(ax + 10, ay + 12); }
  else { c.moveTo(ax, ay + 12); c.lineTo(ax - 10, ay); c.lineTo(ax + 10, ay); }
  c.closePath();
  c.fill();
}

/** a platform screen door leaf: outline with a glazed upper half */
function doorLeaf(c: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, col: string, open: boolean) {
  c.strokeStyle = col;
  c.lineWidth = 3;
  roundRect(c, x, y, w, hh, 3);
  c.stroke();
  c.fillStyle = col;
  if (open) c.fillRect(x + 5, y + 5, w - 10, hh - 10);
  else c.fillRect(x + 6, y + 6, w - 12, hh / 2 - 8);
}

/** stopping-window hexagon (vertical): green bands show where the train is relative to the stopping point */
function hexagon(c: CanvasRenderingContext2D, x: number, y: number, win: DmiData['stopWin']) {
  const w = 17;
  const hh = 30;
  const path = () => {
    c.beginPath();
    c.moveTo(x, y - hh);
    c.lineTo(x + w, y - hh / 2);
    c.lineTo(x + w, y + hh / 2);
    c.lineTo(x, y + hh);
    c.lineTo(x - w, y + hh / 2);
    c.lineTo(x - w, y - hh / 2);
    c.closePath();
  };
  path();
  c.fillStyle = C.white;
  c.fill();
  c.save();
  path();
  c.clip();
  const band = (y0: number, y1: number, col: string) => { c.fillStyle = col; c.fillRect(x - w, y0, w * 2, y1 - y0); };
  if (win === 'ahead') { band(y - hh, y - hh / 2, C.hexGreen); band(y + hh / 2, y + hh, C.hexGreen); }
  else if (win === 'aligned') band(y - hh / 2 - 4, y + hh / 2 + 4, C.hexGreen);
  else if (win === 'short') band(y - hh, y - hh / 2, C.yellow);
  else if (win === 'over') band(y + hh / 2, y + hh, C.yellow);
  c.restore();
}
