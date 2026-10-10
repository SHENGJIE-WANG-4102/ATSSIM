/**
 * ATS overview schematic (站场/线路总览图) rendered with PixiJS.
 *
 * Static geometry is built once from the topology; per-frame updates only
 * change tints, visibility and the train layer.
 */
import { Container, Graphics, Text, Rectangle, type FederatedPointerEvent } from 'pixi.js';
import type { Topology, TLink } from '../sim/topology';
import { linkEnds, linkPoint, GEOM } from '../sim/topology';
import type { Snapshot, TrainSnap } from '../sim/model';
import { SEC, SW, SIGF, PLT, SIG_ASPECT } from '../sim/model';
import { STATIONS, LAYOUT } from '../data/line2';
import type { Store, Selection } from './store';
import { C, FONT_CN, FONT_MONO } from './theme';

const LINE_COLORS: Record<string, number> = {
  '1': 0xe3002b, '2': 0x8cc220, '3': 0xfcd600, '4': 0x461d84, '6': 0xd40068, '7': 0xed6f00, '8': 0x0094d8,
  '9': 0x87caed, '10': 0xc6afd4, '11': 0x871c2b, '12': 0x007a61, '13': 0xe999c0, '14': 0x626020, '15': 0xbca886,
  '16': 0x98d1c0, '17': 0xbc796f, '18': 0xc4984f, '磁浮': 0x009090, '机场联络线': 0x00618b, '国铁': 0x5a6b7a,
};

interface SegHit { x1: number; y1: number; x2: number; y2: number }
class SegmentsHitArea {
  segs: SegHit[];
  r: number;
  constructor(segs: SegHit[], r: number) { this.segs = segs; this.r = r; }
  contains(x: number, y: number): boolean {
    for (const s of this.segs) {
      const dx = s.x2 - s.x1;
      const dy = s.y2 - s.y1;
      const l2 = dx * dx + dy * dy || 1;
      let t = ((x - s.x1) * dx + (y - s.y1) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      const px = s.x1 + t * dx - x;
      const py = s.y1 + t * dy - y;
      if (px * px + py * py <= this.r * this.r) return true;
    }
    return false;
  }
}

interface SignalGfx { lamp: Graphics; lamp2: Graphics; ring: Graphics; cross: Graphics; flag: Text; container: Container }
interface TrainGfx { body: Graphics; box: Container; boxBg: Graphics; label: Text; flags: Text; leader: Graphics; key: string; bodyKey: string; lastStatus: string }

export class Schematic {
  root = new Container();
  private topo: Topology;
  private store: Store;
  private sectionG: Graphics[] = [];
  private sectionIsMain: boolean[] = [];
  private tsrG: Graphics[] = [];
  private switchGap: { n: Graphics; r: Graphics; x: Graphics; label: Text }[] = [];
  private switchNodes: { sw: number; node: number }[] = [];
  private signalG: SignalGfx[] = [];
  private platG: { rect: Graphics; psd: Graphics; badge: Text; wait: Text; x: number; y: number; w: number; h: number }[] = [];
  private zoneBands: { g: Graphics; zone: number }[] = [];
  private zoneLabels: Text[] = [];
  private depotTexts: Text[] = [];
  private trainLayer = new Container();
  private leaderLayer = new Container();
  private selLayer = new Graphics();
  private trains = new Map<number, TrainGfx>();
  private lastSnap: Snapshot | null = null;
  private blink = false;
  private texts: Text[] = [];
  private preview = new Graphics();
  private signalNames: Text[] = [];
  private switchNames: Text[] = [];

  constructor(topo: Topology, store: Store) {
    this.topo = topo;
    this.store = store;
    this.build();
  }

  /** all Text objects (for resolution updates on resize) */
  allTexts(): Text[] {
    const t = [...this.texts];
    for (const tg of this.trains.values()) t.push(tg.label, tg.flags);
    return t;
  }

  private text(str: string, size: number, color: number, opts: { mono?: boolean; bold?: boolean; anchorX?: number; anchorY?: number } = {}): Text {
    const t = new Text({
      text: str,
      style: { fontFamily: opts.mono ? FONT_MONO : FONT_CN, fontSize: size, fill: color, fontWeight: opts.bold ? '700' : '400' },
    });
    t.anchor.set(opts.anchorX ?? 0.5, opts.anchorY ?? 0.5);
    this.texts.push(t);
    return t;
  }

  private sel(sel: Selection) {
    return (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.store.select(sel);
    };
  }
  private hov(sel: Selection) {
    return () => { this.store.hover = sel; this.store.emit('hover'); };
  }
  private unhov() {
    return () => { this.store.hover = null; this.store.emit('hover'); };
  }

  // ---------------------------------------------------------------- build

  private build() {
    const { topo } = this;
    const bgLayer = new Container();
    const trackLayer = new Container();
    const switchLayer = new Container();
    const platformLayer = new Container();
    const signalLayer = new Container();
    const labelLayer = new Container();
    this.root.addChild(bgLayer, platformLayer, trackLayer, switchLayer, signalLayer, labelLayer, this.leaderLayer, this.trainLayer, this.selLayer);

    // background click clears selection
    const bg = new Graphics().rect(0, 104, 3840, 990).fill({ color: C.bg, alpha: 0.001 });
    bg.eventMode = 'static';
    bg.on('pointertap', () => this.store.select(null));
    bgLayer.addChild(bg);

    // row frames & zone bands
    for (let r = 0; r < 2; r++) {
      const top = GEOM.rowTop[r];
      const frame = new Graphics()
        .rect(8, top - 14, 3824, GEOM.rowHeight - 4)
        .stroke({ width: 1, color: C.gridStrong });
      bgLayer.addChild(frame);
    }
    for (const z of topo.zones) {
      for (let r = 0; r < 2; r++) {
        const row = topo.rows[r];
        const from = Math.max(z.chainFrom, row.chainFrom === -Infinity ? -1e9 : row.chainFrom);
        const to = Math.min(z.chainTo, row.chainTo === Infinity ? 1e9 : row.chainTo);
        if (from >= to) continue;
        const x0 = from <= -1e8 ? 12 : topo.chainToX(from, r);
        const x1 = to >= 1e8 ? 3828 : topo.chainToX(to, r);
        if (x1 - x0 < 5) continue;
        const top = GEOM.rowTop[r];
        const g = new Graphics().rect(x0, top + 120, x1 - x0, 200).fill({ color: 0xffffff });
        g.alpha = 0;
        bgLayer.addChild(g);
        this.zoneBands.push({ g, zone: z.id });
        // boundary marker & label
        const lab = this.text(z.key, 17, C.textDim, { mono: true, anchorX: 0, anchorY: 0 });
        lab.position.set(x0 + 8, top - 8);
        bgLayer.addChild(lab);
        this.zoneLabels.push(lab);
        if (from > -1e8 && from > (row.chainFrom === -Infinity ? -1e9 : row.chainFrom) + 1) {
          const d = new Graphics();
          for (let y = top - 10; y < top + GEOM.rowHeight - 24; y += 14) d.moveTo(x0, y).lineTo(x0, y + 7);
          d.stroke({ width: 1.5, color: 0x3a5068 });
          bgLayer.addChild(d);
        }
      }
    }

    // direction labels
    for (let r = 0; r < 2; r++) {
      const top = GEOM.rowTop[r];
      const up = this.text('◀ 上行', 18, C.textDim, { anchorX: 0 });
      up.position.set(20, top + GEOM.upY - 18);
      const dn = this.text('下行 ▶', 18, C.textDim, { anchorX: 0 });
      dn.position.set(20, top + GEOM.dnY + 18);
      labelLayer.addChild(up, dn);
    }
    const contR = this.text('接第二行 ▶', 17, C.line, { anchorX: 1 });
    contR.position.set(3824, GEOM.rowTop[0] + GEOM.midY);
    const contL = this.text('接第一行', 17, C.line, { anchorX: 0 });
    contL.position.set(20, GEOM.rowTop[1] + GEOM.midY);
    labelLayer.addChild(contR, contL);

    // platforms
    for (const p of topo.platforms) {
      const st = topo.stations[p.station];
      const r = st.row;
      const x0 = topo.chainToX(st.chain - 95, r);
      const x1 = topo.chainToX(st.chain + 95, r);
      const top = GEOM.rowTop[r];
      const y0 = p.track === 'UP' ? top + GEOM.upY + 9 : top + GEOM.midY + 4;
      const y1 = p.track === 'UP' ? top + GEOM.midY - 4 : top + GEOM.dnY - 9;
      const rect = new Graphics().rect(x0, y0, x1 - x0, y1 - y0).fill({ color: 0xffffff });
      rect.tint = C.platform;
      const psd = new Graphics().rect(x0 + 2, p.track === 'UP' ? y0 : y1 - 3, x1 - x0 - 4, 3).fill({ color: 0xffffff });
      psd.tint = C.onTime;
      const badge = this.text('', 17, C.platformHold, { bold: true });
      badge.position.set((x0 + x1) / 2, (y0 + y1) / 2);
      const wait = this.text('', 13, C.textDim, { mono: true, anchorX: 0.5 });
      wait.position.set((x0 + x1) / 2, p.track === 'UP' ? y0 - 0 : y1 + 0);
      wait.visible = false;
      rect.eventMode = 'static';
      rect.cursor = 'pointer';
      rect.on('pointertap', this.sel({ kind: 'platform', id: p.id }));
      rect.on('pointerover', this.hov({ kind: 'platform', id: p.id }));
      rect.on('pointerout', this.unhov());
      platformLayer.addChild(rect, psd);
      labelLayer.addChild(badge);
      this.platG.push({ rect, psd, badge, wait, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }

    // station names, km and interchanges
    for (const st of topo.stations) {
      const top = GEOM.rowTop[st.row];
      const name = this.text(st.name, st.name.length > 5 ? 22 : 26, 0xe8eef5, { bold: true });
      name.position.set(st.x, top + GEOM.dnY + 92);
      const km = this.text(`K${Math.floor(st.chain / 1000)}+${String(Math.round(st.chain % 1000)).padStart(3, '0')}`, 14, C.textDim, { mono: true });
      km.position.set(st.x, top + GEOM.dnY + 117);
      labelLayer.addChild(name, km);
      const tr = STATIONS[st.index].transfers;
      if (tr.length) {
        const w = tr.reduce((a, t) => a + (t.length > 2 ? 18 * Math.min(t.length, 3) : 22) + 3, 0);
        let x = st.x - w / 2;
        for (const t of tr) {
          const short = t === '机场联络线' ? '机场' : t;
          const tw = short.length > 2 ? 18 * Math.min(short.length, 3) : 22;
          const chip = new Graphics().roundRect(x, top + GEOM.dnY + 128, tw, 18, 3).fill({ color: LINE_COLORS[t] ?? 0x666666 });
          const tt = this.text(short, 12, 0xffffff, { bold: true });
          tt.position.set(x + tw / 2, top + GEOM.dnY + 137);
          labelLayer.addChild(chip, tt);
          x += tw + 3;
        }
      }
      if (STATIONS[st.index].formerName) {
        const fn = this.text(`(原${STATIONS[st.index].formerName})`, 13, C.textDim);
        fn.position.set(st.x, top + GEOM.dnY + 160);
        labelLayer.addChild(fn);
      }
    }

    // depots
    topo.depots.forEach((d, i) => {
      const gate = topo.nodes[d.gateNode].pos[0];
      const w = 300;
      const x0 = gate.x - w / 2;
      const y0 = GEOM.rowTop[gate.row] + 6;
      const box = new Graphics().rect(x0, y0, w, GEOM.depotGateY - 6).fill({ color: 0x0b1520 }).stroke({ width: 1.5, color: 0x35506b });
      for (let k = 0; k < 5; k++) box.moveTo(x0 + 14, y0 + 40 + k * 8).lineTo(x0 + w - 14, y0 + 40 + k * 8);
      box.stroke({ width: 2, color: 0x24384c });
      box.eventMode = 'static';
      box.cursor = 'pointer';
      box.on('pointertap', this.sel({ kind: 'depot', id: i }));
      const t = this.text(d.name, 19, 0xdfe8f0, { anchorX: 0, anchorY: 0 });
      t.position.set(x0 + 10, y0 + 6);
      const cnt = this.text('', 19, C.line, { mono: true, anchorX: 1, anchorY: 0 });
      cnt.position.set(x0 + w - 10, y0 + 6);
      this.depotTexts.push(cnt);
      labelLayer.addChild(box, t, cnt);
    });

    // tracks by section
    const boundaryNode = (nid: number) => {
      const n = topo.nodes[nid];
      const secs = new Set(n.links.map((l) => topo.links[l].section));
      return secs.size > 1 || n.kind === 'end';
    };
    for (const s of topo.sections) {
      const g = new Graphics();
      const segs: SegHit[] = [];
      const main = s.track === 'DN' || s.track === 'UP';
      const width = main ? 6 : 5;
      for (const lid of s.links) {
        const l = topo.links[lid];
        let [a, b] = linkEnds(topo, l);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const gap = 1.6;
        const ax = a.x + (boundaryNode(l.a) && len > 6 ? (dx / len) * gap : 0);
        const ay = a.y + (boundaryNode(l.a) && len > 6 ? (dy / len) * gap : 0);
        const bx = b.x - (boundaryNode(l.b) && len > 6 ? (dx / len) * gap : 0);
        const by = b.y - (boundaryNode(l.b) && len > 6 ? (dy / len) * gap : 0);
        g.moveTo(ax, ay).lineTo(bx, by);
        segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        void a; void b;
        [a, b] = [a, b];
      }
      g.stroke({ width, color: 0xffffff, cap: 'butt', join: 'round' });
      g.tint = main ? C.trackFree : C.trackFreeSide;
      g.eventMode = 'static';
      g.cursor = 'pointer';
      g.hitArea = new SegmentsHitArea(segs, 9);
      g.on('pointertap', this.sel({ kind: 'section', id: s.id }));
      g.on('pointerover', this.hov({ kind: 'section', id: s.id }));
      g.on('pointerout', this.unhov());
      trackLayer.addChild(g);
      this.sectionG.push(g);
      this.sectionIsMain.push(main);
      // TSR overlay (offset parallel line)
      const t = new Graphics();
      for (const lid of s.links) {
        const l = topo.links[lid];
        const [a, b] = linkEnds(topo, l);
        const off = s.track === 'DN' ? 9 : s.track === 'UP' ? -9 : -8;
        for (let k = 0; k < 1; k++) t.moveTo(a.x, a.y + off).lineTo(b.x, b.y + off);
      }
      t.stroke({ width: 3, color: C.tsr });
      t.visible = false;
      trackLayer.addChild(t);
      this.tsrG.push(t);
    }

    // buffer stops
    const bufG = new Graphics();
    for (const n of topo.nodes) {
      if (n.kind !== 'end') continue;
      const l = topo.links[n.links[0]];
      const [a, b] = linkEnds(topo, l);
      const p = l.a === n.id ? a : b;
      const q = l.a === n.id ? b : a;
      const dx = p.x - q.x;
      const dy = p.y - q.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      if (n.endKind === 'depot') continue;
      bufG.moveTo(p.x + nx * 9, p.y + ny * 9).lineTo(p.x - nx * 9, p.y - ny * 9);
    }
    bufG.stroke({ width: 4, color: 0xb9c6d3 });
    trackLayer.addChild(bufG);

    // switch position gaps
    topo.switches.forEach((sw, si) => {
      for (const nid of sw.nodes) {
        const n = topo.nodes[nid];
        const p = n.pos[0];
        const mk = (lid: number) => {
          const l = topo.links[lid];
          const [a, b] = linkEnds(topo, l);
          const o = l.a === nid ? b : a;
          const dx = o.x - p.x;
          const dy = o.y - p.y;
          const len = Math.hypot(dx, dy) || 1;
          const g = new Graphics().moveTo(p.x + (dx / len) * 4, p.y + (dy / len) * 4).lineTo(p.x + (dx / len) * 15, p.y + (dy / len) * 15).stroke({ width: 10, color: C.bg });
          g.visible = false;
          return g;
        };
        const gn = mk(n.normal!);
        const gr = mk(n.reverse!);
        const x = new Graphics().moveTo(p.x - 7, p.y - 7).lineTo(p.x + 7, p.y + 7).moveTo(p.x + 7, p.y - 7).lineTo(p.x - 7, p.y + 7).stroke({ width: 3, color: C.sigRed });
        x.visible = false;
        const main = topo.links[n.toe!].track === 'UP' || topo.links[n.toe!].track === 'DN';
        const isUp = topo.links[n.toe!].track === 'UP';
        const label = this.text(sw.name.replace(/^P/, ''), 13, 0x7f93a7, { mono: true });
        label.position.set(p.x, p.y + (main ? (isUp ? -15 : 15) : -14));
        const hit = new Graphics().circle(p.x, p.y, 13).fill({ color: 0xffffff, alpha: 0.001 });
        hit.eventMode = 'static';
        hit.cursor = 'pointer';
        hit.on('pointertap', this.sel({ kind: 'switch', id: si }));
        hit.on('pointerover', this.hov({ kind: 'switch', id: si }));
        hit.on('pointerout', this.unhov());
        switchLayer.addChild(gn, gr, x, hit);
        labelLayer.addChild(label);
        this.switchGap.push({ n: gn, r: gr, x, label });
        this.switchNames.push(label);
        this.switchNodes.push({ sw: si, node: nid });
      }
    });

    // signals
    for (const s of topo.signals) {
      const n = topo.nodes[s.node];
      const l = topo.links[s.link];
      const [a, b] = linkEnds(topo, l);
      const p = l.a === s.node ? a : b;
      const o = l.a === s.node ? b : a;
      let dx = o.x - p.x;
      let dy = o.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      // right-hand side of travel (screen y down)
      let nx = -dy;
      let ny = dx;
      if (Math.abs(dy) > 0.8) { nx = 1; ny = 0; }
      const base = { x: p.x + nx * 8, y: p.y + ny * 8 };
      const tip = { x: p.x + nx * 21, y: p.y + ny * 21 };
      const lampC = { x: tip.x - dx * 11, y: tip.y - dy * 11 };
      const c = new Container();
      const mast = new Graphics()
        .moveTo(base.x, base.y).lineTo(tip.x, tip.y)
        .moveTo(tip.x, tip.y).lineTo(tip.x - dx * 4, tip.y - dy * 4)
        .stroke({ width: 2, color: C.sigMast });
      const lamp = new Graphics().circle(lampC.x, lampC.y, 6.5).fill({ color: 0xffffff });
      const lamp2 = new Graphics().circle(lampC.x - dx * 14, lampC.y - dy * 14, 6.5).fill({ color: 0xffffff });
      lamp2.tint = C.sigWhite;
      lamp2.visible = false;
      const ring = new Graphics().circle(lampC.x, lampC.y, 6.5).stroke({ width: 2, color: 0xffffff });
      ring.visible = false;
      const cross = new Graphics().moveTo(lampC.x - 6, lampC.y - 6).lineTo(lampC.x + 6, lampC.y + 6).moveTo(lampC.x + 6, lampC.y - 6).lineTo(lampC.x - 6, lampC.y + 6).stroke({ width: 2, color: C.sigWhite });
      cross.visible = false;
      const name = this.text(s.name, 13, 0x8296ab, { mono: true });
      const labOff = Math.abs(dy) > 0.8 ? { x: 30, y: 0 } : { x: -dx * 30, y: ny * 6 };
      name.position.set(lampC.x + labOff.x, lampC.y + labOff.y);
      const flag = this.text('', 13, C.disturbed, { bold: true });
      flag.position.set(lampC.x, lampC.y + ny * 15 + (Math.abs(dy) > 0.8 ? 0 : 0));
      name.visible = false;
      this.signalNames.push(name);
      c.addChild(mast, lamp, lamp2, ring, cross, name, flag);
      const hit = new Graphics().circle(lampC.x, lampC.y, 12).fill({ color: 0xffffff, alpha: 0.001 });
      hit.eventMode = 'static';
      hit.cursor = 'pointer';
      hit.on('pointertap', this.sel({ kind: 'signal', id: s.id }));
      hit.on('pointerover', this.hov({ kind: 'signal', id: s.id }));
      hit.on('pointerout', this.unhov());
      c.addChild(hit);
      signalLayer.addChild(c);
      this.signalG.push({ lamp, lamp2, ring, cross, flag, container: c });
      void n;
    }

    for (const p of this.platG) labelLayer.addChild(p.wait);
    this.root.addChild(this.preview);
  }

  // ---------------------------------------------------------------- per-frame

  private lastBlinkPhase = -1;
  private lastSelKey = '';
  update(snap: Snapshot, nowMs: number) {
    // state only changes with a new snapshot (20 Hz) or a blink phase
    const phase = Math.floor(nowMs / 250);
    const sel = this.store.selection;
    const selKey = sel ? `${sel.kind}:${sel.id}` : '';
    if (snap === this.lastSnap && phase === this.lastBlinkPhase && selKey === this.lastSelKey) return;
    this.lastBlinkPhase = phase;
    this.lastSelKey = selKey;
    this.lastSnap = snap;
    this.blink = Math.floor(nowMs / 500) % 2 === 0;
    const blinkSlow = Math.floor(nowMs / 800) % 2 === 0;


    // zones
    for (const b of this.zoneBands) {
      const st = snap.zones[b.zone];
      if (st === 'CBTC') b.g.alpha = 0;
      else {
        b.g.tint = st === 'TBTC' ? 0xffd400 : 0xff2020;
        b.g.alpha = st === 'TBTC' ? 0.06 : this.blink ? 0.12 : 0.05;
      }
    }

    // sections
    for (let i = 0; i < this.sectionG.length; i++) {
      const f = snap.sections[i];
      let c: number;
      if (f & SEC.DIST) c = this.blink ? C.disturbed : 0x7a3f0a;
      else if (f & SEC.PRESET) c = blinkSlow ? C.preset : 0x6a5a00;
      else if (f & SEC.OCC) c = f & SEC.COMM ? C.occComm : C.occAxle;
      else if (f & SEC.LOCK) c = f & SEC.ROUTEFLEET ? C.routeAuto : C.routeSet;
      else c = this.sectionIsMain[i] ? C.trackFree : C.trackFreeSide;
      if (this.sectionG[i].tint !== c) this.sectionG[i].tint = c;
      const tsr = (f & SEC.TSR) !== 0;
      this.tsrG[i].visible = tsr;
    }

    // switches
    for (let k = 0; k < this.switchNodes.length; k++) {
      const f = snap.switches[this.switchNodes[k].sw];
      const g = this.switchGap[k];
      const moving = (f & SW.MOVING) !== 0;
      const failed = (f & SW.FAILED) !== 0;
      const rev = (f & SW.R) !== 0;
      if (failed && !(f & SW.FIELD)) {
        g.n.visible = true;
        g.r.visible = true;
        g.x.visible = this.blink;
      } else if (moving) {
        g.n.visible = this.blink;
        g.r.visible = this.blink;
        g.x.visible = false;
      } else {
        g.n.visible = rev;
        g.r.visible = !rev;
        g.x.visible = false;
      }
      const lab = g.label;
      const col = failed ? C.sigRed : f & SW.FIELD ? C.disturbed : f & SW.SINGLE ? C.sigYellow : f & SW.LOCKED ? 0x9fd9b1 : 0x7f93a7;
      if (lab.style.fill !== col) lab.style.fill = col;
    }

    // signals
    for (let i = 0; i < this.signalG.length; i++) {
      const f = snap.signals[i];
      const g = this.signalG[i];
      const aspect = SIG_ASPECT[f & 7];
      g.lamp2.visible = false;
      g.cross.visible = false;
      g.ring.visible = false;
      g.lamp.visible = true;
      switch (aspect) {
        case 'R': g.lamp.tint = C.sigRed; break;
        case 'G': g.lamp.tint = C.sigGreen; break;
        case 'Y': g.lamp.tint = C.sigYellow; break;
        case 'GUIDE': g.lamp.tint = C.sigRed; g.lamp2.visible = this.blink; break;
        case 'DARK': g.lamp.visible = false; g.ring.visible = true; g.ring.tint = C.sigDark; break;
        case 'FAIL': g.lamp.visible = false; g.ring.visible = true; g.ring.tint = this.blink ? C.sigRed : 0x5a1010; g.cross.visible = true; break;
      }
      const flag = (f & SIGF.ARSOFF ? '人' : '') + (f & SIGF.MANUAL ? '◆' : '');
      if (g.flag.text !== flag) g.flag.text = flag;
    }

    // platforms
    for (let i = 0; i < this.platG.length; i++) {
      const f = snap.platforms[i];
      const g = this.platG[i];
      const esp = (f & PLT.ESP) !== 0;
      g.rect.tint = esp ? (this.blink ? 0x8a1010 : 0x3a0a0a) : f & PLT.SURGE ? 0x3a2a10 : C.platform;
      const fault = (f & PLT.PSDFAULT) !== 0;
      g.psd.tint = fault ? (f & PLT.BYPASS ? C.disturbed : this.blink ? C.sigRed : 0x500000) : f & PLT.PSDOPEN ? 0xffffff : C.onTime;
      let badge = '';
      if (esp) badge = 'ESP';
      else {
        if (f & PLT.HOLD) badge += '扣';
        if (f & PLT.SKIP) badge += '跳';
        if (f & PLT.BYPASS) badge += '互';
      }
      if (g.badge.text !== badge) {
        g.badge.text = badge;
        g.badge.style.fill = esp ? 0xffffff : f & PLT.HOLD ? C.platformHold : C.platformSkip;
      }
      const w = snap.platformWaiting[i];
      const showWait = w >= 400;
      g.wait.visible = showWait;
      if (showWait) {
        const txt = `候${w}`;
        if (g.wait.text !== txt) g.wait.text = txt;
        g.wait.style.fill = w > 1200 ? C.late : w > 800 ? C.slightLate : C.textDim;
      }
    }

    // depots
    snap.depotCounts.forEach((n, i) => {
      const t = `在段 ${n}`;
      if (this.depotTexts[i].text !== t) this.depotTexts[i].text = t;
    });

    this.updateTrains(snap);
    this.drawSelection();
  }

  private updateTrains(snap: Snapshot) {
    const { topo } = this;
    const seen = new Set<number>();
    const labels: { tg: TrainGfx; x: number; y: number; side: number; row: number; hx: number; hy: number; w: number }[] = [];
    for (const tr of snap.trains) {
      seen.add(tr.id);
      let tg = this.trains.get(tr.id);
      if (!tg) tg = this.createTrain(tr);
      // body
      const bodyKey = tr.body.map((v) => v.toFixed(0)).join(',') + tr.level + tr.comm + tr.failed + tr.mode + (tr.eb ? 1 : 0);
      const color = tr.failed ? (this.blink ? C.trainFail : 0x6a0000) : tr.mode === 'RM' ? C.trainRm : tr.level === 'CBTC' && tr.comm ? C.trainCbtc : C.trainTbtc;
      if (bodyKey !== tg.bodyKey || tr.failed) {
        tg.bodyKey = bodyKey;
        tg.body.clear();
        for (let i = 0; i < tr.body.length; i += 3) {
          const a = linkPoint(topo, tr.body[i], tr.body[i + 1]);
          const b = linkPoint(topo, tr.body[i], tr.body[i + 2]);
          tg.body.moveTo(a.x, a.y).lineTo(b.x, b.y);
        }
        tg.body.stroke({ width: 11, color, cap: 'round' });
      }
      // label
      const head = linkPoint(topo, tr.link, tr.off);
      const l = topo.links[tr.link];
      const [a, b] = linkEnds(topo, l);
      const screenDx = (b.x - a.x) * tr.dir;
      const side = this.labelSide(l, screenDx);
      const statusColor = !tr.inService ? C.nonService : tr.delay > 300 ? C.late : tr.delay > 120 ? C.slightLate : tr.delay < -60 ? C.early : C.onTime;
      const status = `${statusColor}|${screenDx >= 0 ? 'R' : 'L'}|${this.store.selection?.kind === 'train' && this.store.selection.id === tr.id}`;
      const key = `${tr.svc}-${tr.trip}`;
      if (tg.key !== key) { tg.key = key; tg.label.text = key; }
      let flags = '';
      if (tr.hold) flags += 'H';
      if (tr.mode !== 'AM') flags += tr.mode[0];
      if (tr.level === 'TBTC') flags += 'T';
      if (!tr.comm) flags += '×';
      if (tr.eb) flags += 'E';
      if (tr.failed) flags += '!';
      if (tg.flags.text !== flags) tg.flags.text = flags;
      const w = 118 + (flags ? flags.length * 11 + 4 : 0);
      if (status !== tg.lastStatus || tg.boxBg.width !== w) {
        tg.lastStatus = status;
        const selected = this.store.selection?.kind === 'train' && this.store.selection.id === tr.id;
        tg.boxBg.clear();
        tg.boxBg.roundRect(0, 0, w, 28, 3).fill({ color: C.trainBoxFill }).stroke({ width: selected ? 3 : 2, color: selected ? C.selection : statusColor });
        // direction arrow
        if (screenDx >= 0) tg.boxBg.poly([w + 2, 6, w + 10, 14, w + 2, 22]).fill({ color: statusColor });
        else tg.boxBg.poly([-2, 6, -10, 14, -2, 22]).fill({ color: statusColor });
      }
      tg.flags.position.set(116, 14);
      tg.flags.style.fill = tr.failed || tr.eb || !tr.comm ? C.late : C.slightLate;
      labels.push({ tg, x: screenDx >= 0 ? head.x - w : head.x, y: 0, side, row: head.row, hx: head.x, hy: head.y, w });
    }
    // remove gone trains
    for (const [id, tg] of this.trains) {
      if (!seen.has(id)) {
        tg.body.destroy();
        tg.box.destroy({ children: true });
        tg.leader.destroy();
        this.trains.delete(id);
      }
    }
    // label lanes (collision avoidance)
    const groups = new Map<string, typeof labels>();
    for (const lb of labels) {
      const k = `${lb.row}:${lb.side}:${Math.round(lb.hy / 20)}`;
      const arr = groups.get(k) ?? [];
      arr.push(lb);
      groups.set(k, arr);
    }
    for (const arr of groups.values()) {
      arr.sort((p, q) => p.x - q.x);
      const laneEnd = [-1e9, -1e9, -1e9];
      for (const lb of arr) {
        let lane = 0;
        while (lane < 1 && lb.x < laneEnd[lane] + 6) lane++;
        laneEnd[lane] = Math.max(laneEnd[lane], lb.x + lb.w + 12);
        const baseY = lb.side > 0 ? lb.hy + 16 : lb.hy - 44;
        const y = baseY + lb.side * lane * 31;
        lb.tg.box.position.set(lb.x, y);
        lb.tg.leader.clear();
        lb.tg.leader.moveTo(lb.hx, lb.hy).lineTo(lb.hx, lb.side > 0 ? y : y + 28).stroke({ width: 1, color: 0x6d8094, alpha: 0.8 });
      }
    }
  }

  private labelSide(l: TLink, screenDx: number): number {
    if (l.track === 'DEP') return -1;
    return screenDx >= 0 ? 1 : -1;
  }

  private createTrain(tr: TrainSnap): TrainGfx {
    const body = new Graphics();
    const box = new Container();
    const boxBg = new Graphics();
    const label = new Text({ text: '', style: { fontFamily: FONT_MONO, fontSize: 20, fill: 0xffffff, fontWeight: '600' } });
    label.anchor.set(0, 0.5);
    label.position.set(8, 14);
    const flags = new Text({ text: '', style: { fontFamily: FONT_MONO, fontSize: 17, fill: C.slightLate, fontWeight: '700' } });
    flags.anchor.set(0, 0.5);
    box.addChild(boxBg, label, flags);
    box.eventMode = 'static';
    box.cursor = 'pointer';
    box.on('pointertap', this.sel({ kind: 'train', id: tr.id }));
    box.on('pointerover', this.hov({ kind: 'train', id: tr.id }));
    box.on('pointerout', this.unhov());
    body.eventMode = 'static';
    body.cursor = 'pointer';
    body.on('pointertap', this.sel({ kind: 'train', id: tr.id }));
    const leader = new Graphics();
    this.leaderLayer.addChild(leader);
    this.trainLayer.addChildAt(body, 0);
    this.trainLayer.addChild(box);
    const tg: TrainGfx = { body, box, boxBg, label, flags, leader, key: '', bodyKey: '', lastStatus: '' };
    this.trains.set(tr.id, tg);
    this.store.emit('textsChanged');
    return tg;
  }

  private drawSelection() {
    const g = this.selLayer;
    g.clear();
    const sel = this.store.selection;
    if (!sel) return;
    const { topo } = this;
    const c = C.selection;
    if (sel.kind === 'section') {
      for (const lid of topo.sections[sel.id].links) {
        const [a, b] = linkEnds(topo, topo.links[lid]);
        g.moveTo(a.x, a.y).lineTo(b.x, b.y);
      }
      g.stroke({ width: 14, color: c, alpha: 0.35 });
    } else if (sel.kind === 'signal') {
      const s = topo.signals[sel.id];
      const p = topo.nodes[s.node].pos[0];
      g.circle(p.x, p.y, 26).stroke({ width: 3, color: c });
      // highlight active route
      const f = this.lastSnap ? this.lastSnap.signals[sel.id] : 0;
      void f;
    } else if (sel.kind === 'switch') {
      for (const n of topo.switches[sel.id].nodes) {
        const p = topo.nodes[n].pos[0];
        g.circle(p.x, p.y, 20).stroke({ width: 3, color: c });
      }
    } else if (sel.kind === 'platform') {
      const pg = this.platG[sel.id];
      g.rect(pg.x - 4, pg.y - 4, pg.w + 8, pg.h + 8).stroke({ width: 3, color: c });
    } else if (sel.kind === 'depot') {
      const d = topo.depots[sel.id];
      const p = topo.nodes[d.gateNode].pos[0];
      g.rect(p.x - 154, GEOM.rowTop[p.row] + 2, 308, GEOM.depotGateY + 2).stroke({ width: 3, color: c });
    }
  }

  /** route preview (when choosing a route in the command panel) */
  previewRoute(rid: number | null) {
    this.preview.clear();
    if (rid === null) return;
    const r = this.topo.routes[rid];
    for (const st of r.steps) {
      const [a, b] = linkEnds(this.topo, this.topo.links[st.link]);
      this.preview.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    this.preview.stroke({ width: 12, color: C.selection, alpha: 0.45 });
  }

  setDeviceNames(signals: boolean) {
    for (const t of this.signalNames) t.visible = signals;
  }

  hitBox(): Rectangle { return new Rectangle(0, 104, 3840, 990); }
  zoneOfLayout() { return LAYOUT.zones; }
}
