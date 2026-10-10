/**
 * Planned vs actual train graph (运行图: 计划线 / 实迹线), time on x,
 * distance (stations) on y. Planned lines are drawn once per plan version in
 * hour-sized chunks; actual lines are appended incrementally.
 */
import { Container, Graphics, Text } from 'pixi.js';
import type { Topology } from '../sim/topology';
import type { Plan, Trip } from '../sim/model';
import type { Store } from './store';
import { C, FONT_CN, FONT_MONO, REGION, fmtTime } from './theme';

const ML = 196; // left margin (station names)
const MT = 104; // top margin (controls + time axis)
const MR = 16;
const MB = 18;

export class TrainGraph {
  root = new Container();
  private topo: Topology;
  private store: Store;
  private plotW: number;
  private plotH: number;
  private yOf: number[] = [];
  private window = 3 * 3600; // visible span (s)
  private pxPerSec = 0;
  private content = new Container();
  private planLayer = new Container();
  private actualLayer = new Container();
  private gridLayer = new Graphics();
  private axisLayer = new Container();
  private nowLine = new Graphics();
  private nowText: Text;
  private planChunks: Graphics[] = [];
  private actualG = new Map<number, Graphics>(); // chunk index → graphics
  private actualDrawn = new Map<number, number>(); // train → index of points drawn
  private planVersion = -1;
  private lastFlush = 0;
  private texts: Text[] = [];
  private timeLabels: Text[] = [];
  private tStart = 0;

  constructor(topo: Topology, store: Store) {
    this.topo = topo;
    this.store = store;
    const { x, y, w, h } = REGION.graph;
    this.root.position.set(x, y);
    this.plotW = w - ML - MR;
    this.plotH = h - MT - MB;
    // frame & background
    const bg = new Graphics().rect(0, 0, w, h).fill({ color: 0x060b11 }).stroke({ width: 1, color: C.gridStrong });
    this.root.addChild(bg);
    // station y positions (mildly distance-weighted)
    const st = topo.stations;
    const wts = [0];
    for (let i = 1; i < st.length; i++) wts.push(wts[i - 1] + 0.55 + 0.45 * Math.min(2.4, (st[i].chain - st[i - 1].chain) / 1600));
    const total = wts[wts.length - 1];
    this.yOf = wts.map((v) => MT + (v / total) * this.plotH);
    // station grid & labels
    const sg = new Graphics();
    st.forEach((s, i) => {
      const y = this.yOf[i];
      sg.moveTo(ML, y).lineTo(ML + this.plotW, y);
      const t = this.mkText(s.name, s.name.length > 7 ? 15 : 17, i === 4 || i === 22 ? C.line : 0xb7c4d1, false);
      t.anchor.set(1, 0.5);
      t.position.set(ML - 10, y);
      this.root.addChild(t);
    });
    sg.stroke({ width: 1, color: C.grid });
    this.root.addChild(sg);
    // content (scrolling in time)
    const mask = new Graphics().rect(ML, MT - 28, this.plotW, this.plotH + 32).fill({ color: 0xffffff });
    this.root.addChild(mask);
    this.content.mask = mask;
    this.content.addChild(this.gridLayer, this.planLayer, this.actualLayer);
    this.root.addChild(this.content, this.axisLayer, this.nowLine);
    this.nowText = this.mkText('', 17, C.nowLine, true);
    this.nowText.anchor.set(0.5, 1);
    this.root.addChild(this.nowText);
    this.setWindow(this.window);
  }

  allTexts() { return [...this.texts]; }

  private mkText(s: string, size: number, color: number, mono: boolean): Text {
    const t = new Text({ text: s, style: { fontFamily: mono ? FONT_MONO : FONT_CN, fontSize: size, fill: color } });
    this.texts.push(t);
    return t;
  }

  setWindow(span: number) {
    this.window = span;
    this.pxPerSec = this.plotW / span;
    this.planVersion = -1; // force rebuild
    for (const g of this.actualG.values()) g.destroy();
    this.actualG.clear();
    this.actualDrawn.clear();
    this.buildGrid();
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
    for (const t of this.timeLabels) t.destroy();
    this.timeLabels = [];
    const minor = this.window <= 3 * 3600 ? 600 : this.window <= 8 * 3600 ? 1800 : 3600;
    for (let t = 4 * 3600; t <= 28 * 3600; t += minor) {
      const x = this.tx(t);
      const hour = t % 3600 === 0;
      g.moveTo(x, MT).lineTo(x, MT + this.plotH).stroke({ width: hour ? 1.5 : 1, color: hour ? C.gridStrong : C.grid });
    }
    // planned period bands are drawn with the plan
  }

  private kindColor(t: Trip): number {
    if (t.cancelled) return 0x553333;
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
    for (const g of this.planChunks) g.destroy();
    this.planChunks = [];
    const chunks = new Map<number, Graphics>();
    for (const trip of plan.trips) {
      const idx = Math.floor(trip.stops[0].dep / 3600);
      let g = chunks.get(idx);
      if (!g) { g = new Graphics(); chunks.set(idx, g); }
      const col = this.kindColor(trip);
      const pts: number[] = [];
      for (const s of trip.stops) {
        const y = this.yOf[s.st];
        pts.push(this.tx(s.arr), y);
        if (s.dep !== s.arr) pts.push(this.tx(s.dep), y);
      }
      g.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
      g.stroke({ width: trip.revenue ? 1.6 : 1.2, color: col, alpha: trip.cancelled ? 0.5 : trip.revenue ? 0.85 : 0.6 });
    }
    // period labels along the top
    for (const p of plan.periods) {
      const x0 = this.tx(p.from);
      const x1 = this.tx(p.to);
      const band = new Graphics().rect(x0, MT - 26, Math.max(1, x1 - x0 - 2), 20).fill({ color: p.template.includes('AM') || p.template.includes('PM') ? 0x24320f : 0x121c27 });
      const t = this.mkText(p.label, 15, p.template.includes('AM') || p.template.includes('PM') ? C.line : C.textDim, false);
      t.anchor.set(0, 0.5);
      t.position.set(x0 + 6, MT - 16);
      const c = new Graphics();
      c.addChild(band, t);
      this.planChunks.push(c);
      this.planLayer.addChild(c);
    }
    for (const g of chunks.values()) {
      this.planChunks.push(g);
      this.planLayer.addChild(g);
    }
  }

  /** append new actual-line points (throttled) */
  private flushActual() {
    const traces = this.store.traces;
    for (const [train, pts] of traces) {
      let from = this.actualDrawn.get(train) ?? 0;
      if (from >= pts.length) continue;
      if (from > 0) from -= 3; // continue from the last drawn point
      for (let i = from; i + 3 < pts.length; i += 3) {
        const t0 = pts[i];
        const t1 = pts[i + 3];
        const ch0 = pts[i + 1];
        const ch1 = pts[i + 4];
        if (t1 - t0 > 900) continue;
        const chunk = Math.floor(t0 / 1800);
        let g = this.actualG.get(chunk);
        if (!g) { g = new Graphics(); this.actualG.set(chunk, g); this.actualLayer.addChild(g); }
        const service = pts[i + 2] > 0 && pts[i + 5] > 0;
        g.moveTo(this.tx(t0), this.chainY(ch0)).lineTo(this.tx(t1), this.chainY(ch1)).stroke({ width: 2.4, color: service ? C.actual : 0xb07070, alpha: service ? 0.95 : 0.6 });
      }
      this.actualDrawn.set(train, pts.length);
    }
  }

  update(nowMs: number) {
    const snap = this.store.snap;
    const plan = this.store.plan;
    if (!snap || !plan) return;
    if (this.planVersion !== this.store.planVersion) {
      this.planVersion = this.store.planVersion;
      this.buildPlan(plan);
      // actual lines must be rebuilt for the new scale as well
      for (const g of this.actualG.values()) g.destroy();
      this.actualG.clear();
      this.actualDrawn.clear();
    }
    if (nowMs - this.lastFlush > 400) {
      this.lastFlush = nowMs;
      this.flushActual();
    }
    // window: 2/3 past, 1/3 future
    const t = snap.t;
    this.tStart = t - this.window * 0.62;
    const ox = ML - this.tx(this.tStart);
    this.content.position.set(ox, 0);
    // visibility culling of chunks
    for (const [idx, g] of this.actualG) {
      const t0 = idx * 1800;
      g.visible = t0 + 1800 >= this.tStart - 600 && t0 <= this.tStart + this.window;
    }
    // time axis labels
    this.drawAxis();
    const nx = ML + this.tx(t) - this.tx(this.tStart);
    this.nowLine.clear();
    for (let y = MT; y < MT + this.plotH; y += 12) this.nowLine.moveTo(nx, y).lineTo(nx, y + 6);
    this.nowLine.stroke({ width: 2, color: C.nowLine });
    this.nowText.text = fmtTime(t, false);
    this.nowText.position.set(nx, MT - 52);
  }

  private axisPool: Text[] = [];
  private drawAxis() {
    const step = this.window <= 3 * 3600 ? 1800 : this.window <= 8 * 3600 ? 3600 : 7200;
    const first = Math.ceil(this.tStart / step) * step;
    let n = 0;
    for (let t = first; t <= this.tStart + this.window; t += step) {
      const x = ML + this.tx(t) - this.tx(this.tStart);
      let lab = this.axisPool[n];
      if (!lab) {
        lab = new Text({ text: '', style: { fontFamily: FONT_MONO, fontSize: 16, fill: C.textDim } });
        lab.anchor.set(0.5, 1);
        this.axisPool.push(lab);
        this.texts.push(lab);
        this.axisLayer.addChild(lab);
        this.store.emit('textsChanged');
      }
      const txt = fmtTime(t, false);
      if (lab.text !== txt) lab.text = txt;
      lab.position.set(x, MT - 30);
      lab.visible = x > ML + 20 && x < ML + this.plotW - 20;
      n++;
    }
    for (let i = n; i < this.axisPool.length; i++) this.axisPool[i].visible = false;
  }
}
