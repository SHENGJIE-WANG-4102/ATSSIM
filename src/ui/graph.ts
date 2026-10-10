/**
 * Planned vs actual train graph (运行图: 计划线 / 实迹线), time on x,
 * distance (stations) on y. Planned lines are thin and muted, drawn once
 * per plan version in hour chunks; actual lines are thick and coloured by
 * the train's deviation from plan, appended incrementally.
 */
import { Container, Graphics, Text } from 'pixi.js';
import type { Topology } from '../sim/topology';
import type { Plan, Trip } from '../sim/model';
import { TRACE_STRIDE, type Store } from './store';
import { C, FONT_CN, FONT_MONO, fmtTime } from './theme';
import { textWidth } from './labels';

const ML = 210; // left margin (station names)
const MT = 112; // top: controls bar (DOM) + time axis + period band
const MR = 16;
const MB = 10;

const DELAY_BUCKETS = [120, 300];

export function deviationColor(delay: number): number {
  if (delay <= DELAY_BUCKETS[0]) return C.actOnTime;
  if (delay <= DELAY_BUCKETS[1]) return C.actSlight;
  return C.actLate;
}

export class TrainGraph {
  root = new Container();
  private topo: Topology;
  private store: Store;
  private plotW = 0;
  private plotH = 0;
  private yOf: number[] = [];
  private window = 3 * 3600;
  private pxPerSec = 0;
  private bg = new Graphics();
  private frame = new Container();
  private content = new Container();
  private planLayer = new Container();
  private actualLayer = new Container();
  private gridLayer = new Graphics();
  private axisLayer = new Container();
  private nowLine = new Graphics();
  private nowText: Text;
  private mask = new Graphics();
  private planChunks: Container[] = [];
  private actualG = new Map<number, Container>();
  private actualDrawn = new Map<number, number>();
  private planVersion = -1;
  private traceReset = -1;
  private lastFlush = 0;
  private texts: Text[] = [];
  private tStart = 0;
  private lastNowX = -1;
  private axisPool: Text[] = [];
  visible = true;

  constructor(topo: Topology, store: Store) {
    this.topo = topo;
    this.store = store;
    this.nowText = this.mkText('', 20, C.nowLine, true);
    this.nowText.anchor.set(0.5, 1);
    this.content.addChild(this.gridLayer, this.planLayer, this.actualLayer);
    this.root.addChild(this.bg, this.frame, this.content, this.mask, this.axisLayer, this.nowLine, this.nowText);
    this.content.mask = this.mask;
  }

  allTexts() { return [...this.texts]; }

  private mkText(s: string, size: number, color: number, mono: boolean): Text {
    const t = new Text({ text: s, style: { fontFamily: mono ? FONT_MONO : FONT_CN, fontSize: size, fill: color } });
    this.texts.push(t);
    return t;
  }

  resize(x: number, y: number, w: number, h: number) {
    this.root.position.set(x, y);
    this.visible = h > 120;
    this.root.visible = h > 0;
    this.bg.clear().rect(0, 0, w, h).fill({ color: 0x060b11 }).stroke({ width: 1, color: C.gridStrong });
    if (!this.visible) return;
    this.plotW = w - ML - MR;
    this.plotH = h - MT - MB;
    // station y positions (mildly distance-weighted)
    const st = this.topo.stations;
    const wts = [0];
    for (let i = 1; i < st.length; i++) wts.push(wts[i - 1] + 0.55 + 0.45 * Math.min(2.4, (st[i].chain - st[i - 1].chain) / 1600));
    const total = wts[wts.length - 1];
    this.yOf = wts.map((v) => MT + (v / total) * this.plotH);
    // frame: station grid and labels (thinned so they never overlap)
    for (const c of this.frame.removeChildren()) c.destroy({ children: true });
    const sg = new Graphics();
    const prio = (i: number) => (i === 0 || i === st.length - 1 ? 3 : st[i].turnbackBerths.length || st[i].frontTurnback.DN ? 2 : 1) * 100 + (st[i].name.length < 5 ? 1 : 0);
    const order = st.map((_, i) => i).sort((a, b) => prio(b) - prio(a));
    const taken: [number, number][] = [];
    for (const i of order) {
      const y = this.yOf[i];
      const size = 20;
      if (taken.some(([a, b]) => y + size / 2 + 2 > a && y - size / 2 - 2 < b)) continue;
      taken.push([y - size / 2, y + size / 2]);
      const name = st[i].name.length > 7 ? st[i].name.replace('国家会计学院', '').replace('1号2号航站楼', '机场') : st[i].name;
      const t = this.mkText(name, size, i === 0 || i === st.length - 1 || prio(i) >= 200 ? 0xc6d2de : C.textDim, false);
      t.anchor.set(1, 0.5);
      t.position.set(ML - 10, y);
      void textWidth;
      this.frame.addChild(t);
    }
    st.forEach((_, i) => sg.moveTo(ML, this.yOf[i]).lineTo(ML + this.plotW, this.yOf[i]));
    sg.stroke({ width: 1, color: C.grid });
    this.frame.addChild(sg);
    this.store.emit('textsChanged');
    this.mask.clear().rect(ML, MT - 26, this.plotW, this.plotH + 28).fill({ color: 0xffffff });
    this.setWindow(this.window);
  }

  setWindow(span: number) {
    this.window = span;
    if (!this.visible) return;
    this.pxPerSec = this.plotW / span;
    this.planVersion = -1;
    this.resetActual();
    this.buildGrid();
  }

  private resetActual() {
    for (const g of this.actualG.values()) g.destroy({ children: true });
    this.actualG.clear();
    this.actualDrawn.clear();
  }

  private tx(t: number) { return t * this.pxPerSec; }

  private chainY(ch: number): number {
    const st = this.topo.stations;
    if (ch <= st[0].chain) return this.yOf[0];
    for (let i = 0; i + 1 < st.length; i++) {
      if (ch <= st[i + 1].chain) {
        const k = (ch - st[i].chain) / (st[i + 1].chain - st[i].chain);
        return this.yOf[i] + k * (this.yOf[i + 1] - this.yOf[i]);
      }
    }
    return this.yOf[st.length - 1];
  }

  private buildGrid() {
    const g = this.gridLayer;
    g.clear();
    const minor = this.window <= 3 * 3600 ? 600 : this.window <= 8 * 3600 ? 1800 : 3600;
    for (let t = 4 * 3600; t <= 28 * 3600; t += minor) {
      const x = this.tx(t);
      const hour = t % 3600 === 0;
      g.moveTo(x, MT).lineTo(x, MT + this.plotH).stroke({ width: hour ? 1.5 : 1, color: hour ? C.gridStrong : C.grid });
    }
  }

  private kindColor(t: Trip): number {
    if (t.cancelled) return 0x4a3030;
    switch (t.kind) {
      case 'big': return C.planBig;
      case 'small': return C.planSmall;
      case 'late': return C.planLate;
      case 'extra': return C.planExtra;
      case 'ins': case 'wd': return C.planIns;
      case 'empty': return C.planEmpty;
      case 'adj': return C.planAdj;
    }
  }

  private buildPlan(plan: Plan) {
    for (const g of this.planChunks) g.destroy({ children: true });
    this.planChunks = [];
    const chunks = new Map<number, Graphics>();
    for (const trip of plan.trips) {
      const idx = Math.floor(trip.stops[0].dep / 3600);
      let g = chunks.get(idx);
      if (!g) { g = new Graphics(); chunks.set(idx, g); }
      const pts: number[] = [];
      for (const s of trip.stops) {
        const y = this.yOf[s.st];
        pts.push(this.tx(s.arr), y);
        if (s.dep !== s.arr) pts.push(this.tx(s.dep), y);
      }
      g.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
      g.stroke({ width: trip.revenue ? 1.4 : 1, color: this.kindColor(trip), alpha: trip.cancelled ? 0.5 : trip.revenue ? 0.9 : 0.6 });
    }
    for (const p of plan.periods) {
      const x0 = this.tx(p.from);
      const x1 = this.tx(p.to);
      const peak = p.template.includes('AM') || p.template.includes('PM');
      const band = new Graphics().rect(x0, MT - 24, Math.max(1, x1 - x0 - 2), 22).fill({ color: peak ? 0x24320f : 0x121c27 });
      const t = this.mkText(p.label, 20, peak ? C.line : C.textDim, false);
      t.anchor.set(0, 0.5);
      t.position.set(x0 + 6, MT - 13);
      const c = new Container();
      c.addChild(band);
      if (x1 - x0 > textWidth(p.label, 20) + 14) c.addChild(t);
      this.planChunks.push(c);
      this.planLayer.addChild(c);
    }
    for (const g of chunks.values()) {
      const c = new Container();
      c.addChild(g);
      this.planChunks.push(c);
      this.planLayer.addChild(c);
    }
    this.store.emit('textsChanged');
  }

  /** append new actual-line points: one Graphics per flush and half-hour chunk, coloured by delay */
  private flushActual() {
    const S = TRACE_STRIDE;
    const batches = new Map<number, Map<number, number[]>>();
    for (const [train, pts] of this.store.traces) {
      let from = this.actualDrawn.get(train) ?? 0;
      if (from >= pts.length) continue;
      if (from > 0) from -= S;
      for (let i = from; i + S < pts.length; i += S) {
        const t0 = pts[i];
        const t1 = pts[i + S];
        if (t1 - t0 > 900) continue;
        const service = pts[i + 2] > 0 && pts[i + S + 2] > 0;
        if (!service && Math.abs(pts[i + S + 1] - pts[i + 1]) < 5) continue;
        const chunk = Math.floor(t0 / 1800);
        let b = batches.get(chunk);
        if (!b) { b = new Map(); batches.set(chunk, b); }
        const color = service ? deviationColor(Math.max(pts[i + 3], pts[i + S + 3])) : 0x6a7684;
        let arr = b.get(color);
        if (!arr) { arr = []; b.set(color, arr); }
        arr.push(this.tx(t0), this.chainY(pts[i + 1]), this.tx(t1), this.chainY(pts[i + S + 1]));
      }
      this.actualDrawn.set(train, pts.length);
    }
    for (const [chunk, b] of batches) {
      let c = this.actualG.get(chunk);
      if (!c) { c = new Container(); this.actualG.set(chunk, c); this.actualLayer.addChild(c); }
      const g = new Graphics();
      for (const [color, a] of b) {
        for (let i = 0; i < a.length; i += 4) g.moveTo(a[i], a[i + 1]).lineTo(a[i + 2], a[i + 3]);
        g.stroke({ width: color === 0x6a7684 ? 1.6 : 2.8, color, alpha: 0.95 });
      }
      c.addChild(g);
    }
  }

  update(nowMs: number) {
    const snap = this.store.snap;
    const plan = this.store.plan;
    if (!snap || !plan || !this.visible) return;
    if (this.planVersion !== this.store.planVersion) {
      this.planVersion = this.store.planVersion;
      this.buildPlan(plan);
      this.resetActual();
    }
    if (this.traceReset !== this.store.traceReset) {
      this.traceReset = this.store.traceReset;
      this.resetActual();
    }
    if (nowMs - this.lastFlush > 600) {
      this.lastFlush = nowMs;
      this.flushActual();
    }
    // window: 62 % past, 38 % future
    const t = snap.t;
    this.tStart = t - this.window * 0.62;
    this.content.position.set(ML - this.tx(this.tStart), 0);
    for (const [idx, g] of this.actualG) {
      const t0 = idx * 1800;
      g.visible = t0 + 1800 >= this.tStart - 600 && t0 <= this.tStart + this.window;
    }
    this.drawAxis();
    const nx = ML + this.tx(t) - this.tx(this.tStart);
    // the line sits at a fixed screen x; its label follows the clock
    const label = fmtTime(t, false);
    if (this.nowText.text !== label) this.nowText.text = label;
    if (Math.abs(nx - this.lastNowX) < 0.5) return;
    this.lastNowX = nx;
    this.nowLine.clear();
    for (let y = MT; y < MT + this.plotH; y += 12) this.nowLine.moveTo(nx, y).lineTo(nx, y + 6);
    this.nowLine.stroke({ width: 2, color: C.nowLine });
    this.nowText.position.set(nx, MT - 28);
  }

  private drawAxis() {
    const step = this.window <= 3 * 3600 ? 1800 : this.window <= 8 * 3600 ? 3600 : 7200;
    const first = Math.ceil(this.tStart / step) * step;
    let n = 0;
    const nowX = ML + this.tx(this.store.snap!.t) - this.tx(this.tStart);
    for (let t = first; t <= this.tStart + this.window; t += step) {
      const x = ML + this.tx(t) - this.tx(this.tStart);
      let lab = this.axisPool[n];
      if (!lab) {
        lab = new Text({ text: '', style: { fontFamily: FONT_MONO, fontSize: 20, fill: C.textDim } });
        lab.anchor.set(0.5, 1);
        this.axisPool.push(lab);
        this.texts.push(lab);
        this.axisLayer.addChild(lab);
        this.store.emit('textsChanged');
      }
      const txt = fmtTime(t, false);
      if (lab.text !== txt) lab.text = txt;
      lab.position.set(x, MT - 28);
      // never under the now label
      lab.visible = x > ML + 30 && x < ML + this.plotW - 30 && Math.abs(x - nowX) > 80;
      n++;
    }
    for (let i = n; i < this.axisPool.length; i++) this.axisPool[i].visible = false;
  }
}
