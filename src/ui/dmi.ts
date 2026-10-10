/**
 * Driver display (DMI, 司机显示单元) for a followed train: circular
 * speedometer with permitted-speed hook and target-speed marker, target
 * distance bar, mode / level, movement authority and doors; plus the
 * master controller (牵引/制动手柄) used for manual CM / RM driving.
 */
import { h } from './dom';
import type { TrainSnap } from '../sim/model';
import { STATIONS } from '../data/line2';
import { FONT_CN, FONT_MONO } from './theme';

const W = 620;
const H = 560;
const VMAX = 100;

export const NOTCHES: { v: number; label: string; cls: string }[] = [
  { v: 4, label: 'P4', cls: 't' }, { v: 3, label: 'P3', cls: 't' }, { v: 2, label: 'P2', cls: 't' }, { v: 1, label: 'P1', cls: 't' },
  { v: 0, label: '惰行', cls: '' },
  { v: -1, label: 'B1', cls: 'b' }, { v: -2, label: 'B2', cls: 'b' }, { v: -3, label: 'B3', cls: 'b' }, { v: -4, label: 'B4', cls: 'b' },
  { v: -5, label: 'B5', cls: 'b' }, { v: -6, label: 'B6', cls: 'b' }, { v: -7, label: 'B7', cls: 'b' }, { v: -8, label: '紧急', cls: 'eb' },
];

export class Dmi {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private res = 1;
  lever: HTMLElement;
  private notchEls: HTMLElement[] = [];
  onNotch: (n: number) => void = () => undefined;

  constructor(resolution: () => number) {
    this.canvas = h('canvas', { class: 'dmi', style: `width:${W}px;height:${H}px` }) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
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
  }

  showLever(on: boolean) {
    this.lever.style.display = on ? 'flex' : 'none';
  }

  draw(t: TrainSnap) {
    const c = this.ctx;
    c.setTransform(this.res, 0, 0, this.res, 0, 0);
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#02060a';
    c.fillRect(0, 0, W, H);
    const v = t.v * 3.6;
    const vp = Math.max(0, t.vPermit * 3.6);
    const tv = t.tgtV * 3.6;
    const td = t.tgtD;
    const overspeedWarn = !t.eb && v > vp - 3 && vp > 0;
    const ebNow = t.eb;

    // ---- target distance bar (left)
    const bx = 22;
    const by = 70;
    const bh = 330;
    c.strokeStyle = '#2a3b4d';
    c.lineWidth = 1;
    c.font = `20px ${FONT_MONO}`;
    c.fillStyle = '#8195a8';
    c.textAlign = 'right';
    const scaleY = (d: number) => by + bh - (Math.log10(Math.max(1, d)) / 3) * bh; // 1 m .. 1000 m
    for (const d of [10, 100, 1000]) {
      const y = scaleY(d);
      c.beginPath(); c.moveTo(bx + 30, y); c.lineTo(bx + 46, y); c.stroke();
      c.fillText(d === 1000 ? '1k' : String(d), bx + 26, y + 7);
    }
    c.strokeRect(bx + 36, by, 18, bh);
    if (td >= 0) {
      const y = scaleY(Math.min(1000, td));
      c.fillStyle = td < 60 ? '#ffc400' : '#c6d2de';
      c.fillRect(bx + 37, y, 16, by + bh - y);
      c.fillStyle = '#ffffff';
      c.font = `600 26px ${FONT_MONO}`;
      c.textAlign = 'left';
      c.fillText(td >= 1000 ? `${(td / 1000).toFixed(1)}k` : `${Math.round(td)}`, bx, by + bh + 34);
    }
    // caption above the bar (below it would run into the info lines)
    c.font = `20px ${FONT_CN}`;
    c.fillStyle = '#8195a8';
    c.textAlign = 'left';
    c.fillText('目标距离 m', bx, by - 30);

    // ---- speedometer
    const cx = 330;
    const cy = 250;
    const R = 190;
    const a0 = (150 * Math.PI) / 180; // 0 km/h at bottom-left
    const span = (240 * Math.PI) / 180;
    const ang = (sp: number) => a0 + (Math.min(VMAX, Math.max(0, sp)) / VMAX) * span;
    // permitted-speed band (grey up to vp, hook at vp)
    c.lineCap = 'butt';
    c.lineWidth = 16;
    c.strokeStyle = '#26323e';
    c.beginPath(); c.arc(cx, cy, R, a0, a0 + span); c.stroke();
    c.strokeStyle = ebNow ? '#ff4040' : overspeedWarn ? '#ffc400' : '#5d6e80';
    c.beginPath(); c.arc(cx, cy, R, a0, ang(vp)); c.stroke();
    // hook
    c.lineWidth = 8;
    c.strokeStyle = ebNow ? '#ff4040' : overspeedWarn ? '#ffc400' : '#e8eef5';
    const ha = ang(vp);
    c.beginPath(); c.moveTo(cx + Math.cos(ha) * (R - 22), cy + Math.sin(ha) * (R - 22)); c.lineTo(cx + Math.cos(ha) * (R + 14), cy + Math.sin(ha) * (R + 14)); c.stroke();
    // target speed marker
    if (td >= 0 && tv < vp - 0.5) {
      const ta = ang(tv);
      c.fillStyle = '#5cc8ff';
      c.beginPath();
      c.moveTo(cx + Math.cos(ta) * (R + 22), cy + Math.sin(ta) * (R + 22));
      c.lineTo(cx + Math.cos(ta - 0.05) * (R + 40), cy + Math.sin(ta - 0.05) * (R + 40));
      c.lineTo(cx + Math.cos(ta + 0.05) * (R + 40), cy + Math.sin(ta + 0.05) * (R + 40));
      c.closePath(); c.fill();
    }
    // ticks
    c.lineWidth = 2;
    c.strokeStyle = '#9fb0c0';
    c.fillStyle = '#c6d2de';
    c.font = `20px ${FONT_MONO}`;
    c.textAlign = 'center';
    for (let s = 0; s <= VMAX; s += 10) {
      const a = ang(s);
      const r1 = s % 20 === 0 ? R - 40 : R - 30;
      c.beginPath(); c.moveTo(cx + Math.cos(a) * (R - 18), cy + Math.sin(a) * (R - 18)); c.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); c.stroke();
      if (s % 20 === 0) c.fillText(String(s), cx + Math.cos(a) * (R - 64), cy + Math.sin(a) * (R - 64) + 7);
    }
    // needle
    const na = ang(v);
    c.strokeStyle = ebNow ? '#ff4040' : overspeedWarn ? '#ffc400' : '#ffffff';
    c.lineWidth = 6;
    c.lineCap = 'round';
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(na) * (R - 30), cy + Math.sin(na) * (R - 30)); c.stroke();
    c.fillStyle = '#0b131c';
    c.beginPath(); c.arc(cx, cy, 52, 0, Math.PI * 2); c.fill();
    c.strokeStyle = c.fillStyle;
    c.fillStyle = ebNow ? '#ff4040' : '#ffffff';
    c.font = `600 40px ${FONT_MONO}`;
    c.fillText(String(Math.round(v)), cx, cy + 14);
    c.font = `20px ${FONT_CN}`;
    c.fillStyle = '#8195a8';
    c.fillText('km/h', cx, cy + 40);

    // ---- right info column
    const ix = 520;
    const box = (y: number, txt: string, fg: string, bg: string) => {
      c.fillStyle = bg;
      c.fillRect(ix, y, 88, 44);
      c.fillStyle = fg;
      c.font = `600 24px ${FONT_MONO}`;
      c.textAlign = 'center';
      c.fillText(txt, ix + 44, y + 31);
    };
    box(20, t.mode, t.mode === 'AM' ? '#c6d2de' : t.mode === 'CM' ? '#ffc400' : '#ffd400', '#13202d');
    box(72, t.level, t.level === 'CBTC' && t.comm ? '#46d47c' : '#ff9a3c', '#13202d');
    box(124, t.doors ? '门开' : '门关', t.doors ? '#ffc400' : '#46d47c', '#13202d');
    if (ebNow) box(176, 'EB', '#ffffff', '#b01818');
    if (t.manual) box(228, '人工', '#e08cff', '#2a1430');

    // ---- bottom texts
    c.textAlign = 'left';
    c.font = `22px ${FONT_CN}`;
    c.fillStyle = '#c6d2de';
    const lines: [string, string][] = [];
    lines.push(['允许', `${Math.round(vp)} km/h`]);
    lines.push(['目标', td >= 0 ? `${Math.round(tv)} km/h @ ${Math.round(td)} m（${t.tgtReason || '—'}）` : '—']);
    lines.push(['授权', t.maReason ? `${t.maReason} ${Math.round(t.maDist)} m` : `${Math.round(t.maDist)} m 线路空闲`]);
    const ns = t.nextStation >= 0 ? STATIONS[t.nextStation].name : '—';
    lines.push(['前方', t.dwellLeft > 0 ? `停站 剩 ${Math.ceil(t.dwellLeft)} s` : `${ns}${t.stopDist >= 0 && t.stopDist < 2000 ? ` · ${Math.round(t.stopDist)} m` : ''}`]);
    let y = 440;
    for (const [k, val] of lines) {
      c.fillStyle = '#8195a8';
      c.fillText(k, 96, y);
      c.fillStyle = '#ffffff';
      c.fillText(val, 150, y);
      y += 30;
    }
    if (!Number.isNaN(t.stopErr) && Math.abs(t.stopErr) < 40 && t.v < 4) {
      c.font = `600 26px ${FONT_MONO}`;
      const e = t.stopErr;
      c.fillStyle = Math.abs(e) <= 0.5 ? '#46d47c' : Math.abs(e) <= 1 ? '#ffc400' : '#ff8a2a';
      c.textAlign = 'right';
      c.fillText(`对标 ${e >= 0 ? '欠' : '过'}${Math.abs(e).toFixed(2)} m`, W - 16, 420 - 6);
    }
    if (t.ebReason) {
      c.font = `22px ${FONT_CN}`;
      c.fillStyle = t.eb ? '#ff8080' : '#ffc400';
      c.textAlign = 'right';
      c.fillText(t.ebReason, W - 16, 30 + 270);
    }
    // lever state
    this.curNotch = t.notch;
    this.notchEls.forEach((e, i) => e.classList.toggle('on', t.manual && NOTCHES[i].v === t.notch));
  }
}
