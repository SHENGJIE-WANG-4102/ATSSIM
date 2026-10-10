/**
 * Schematic geometry: maps the track graph (chainage based) onto a drawing
 * of one or more rows. Used for the line overview (whole line, wrapped over
 * N rows) and the station / interlocking view (a window around one
 * station, one row, more space for trackwork).
 *
 * x positions use a two-level mapping: every station interval gets a share
 * of the row width from its length and the amount of trackwork in it, and
 * inside an interval the node breakpoints are spread with a per-span pad so
 * switches and signals stay readable.
 */
import type { Topology, TLink } from '../sim/topology';

export interface P { row: number; x: number; y: number }

export interface GeomParams {
  chainFrom: number;
  chainTo: number;
  rows: number;
  width: number;
  marginL: number;
  marginR: number;
  rowH: number;
  top: number;
  /** y of the up / middle / down track relative to the row top */
  upY: number;
  midY: number;
  dnY: number;
  /** depot structure offsets above the up track: switches, junction, transfer, gate */
  depotDy: { q: number; z: number; j1: number; j2: number; gate: number };
  detail: boolean;
  /** main-line nodes this far outside the window are still placed (continuous track at the view edges) */
  nodeMargin?: number;
  /** screen px kept free below the last row when zoomed out (labels are not scaled with the geometry) */
  padBottom?: number;
  /** same above the first row (train windows stacked above the up track) */
  padTop?: number;
}

export interface RowDef { from: number; to: number; x0: number; x1: number; top: number }

const isMain = (l: TLink) => l.track === 'DN' || l.track === 'UP';

export class Geometry {
  readonly p: GeomParams;
  readonly topo: Topology;
  rows: RowDef[] = [];
  private maps: { pts: number[]; xs: number[] }[] = [];
  /** node position (first row the node appears in) or null when outside the window */
  pos: (P | null)[] = [];
  linkVisible: boolean[] = [];
  /** world size */
  width: number;
  height: number;

  constructor(topo: Topology, p: GeomParams) {
    this.topo = topo;
    this.p = p;
    this.width = p.width;
    this.height = p.top + p.rows * p.rowH;
    this.buildX();
    this.placeNodes();
  }

  // ---------------------------------------------------------------- x mapping

  private buildX() {
    const { topo, p } = this;
    const chains = topo.stations.map((s) => s.chain);
    const mainNodes = topo.nodes.filter((n) => n.links.some((l) => isMain(topo.links[l])));
    const swCh = topo.nodes.filter((n) => n.kind === 'switch' && n.links.some((l) => isMain(topo.links[l]))).map((n) => n.chain);
    const inWin = (c: number) => c >= p.chainFrom - 0.5 && c <= p.chainTo + 0.5;
    const stIn = chains.filter((c) => c > p.chainFrom + 1 && c < p.chainTo - 1);
    const bounds = [p.chainFrom, ...stIn, p.chainTo];
    // interval weights
    const weights: number[] = [];
    for (let k = 0; k + 1 < bounds.length; k++) {
      const a = bounds[k];
      const b = bounds[k + 1];
      const d = b - a;
      const nsw = swCh.filter((c) => c > a && c < b).length;
      const isStationInterval = chains.includes(a) && chains.includes(b);
      if (p.detail) weights.push(0.6 + Math.pow(d / 1000, 0.5) * 0.5 + 0.12 * nsw);
      else weights.push((isStationInterval ? 1 : 0.42) + 0.13 * Math.min(4, d / 1000) + 0.075 * nsw);
    }
    // rows: split the cumulative weight; wraps at the middle of a station interval clear of switches
    const total = weights.reduce((a, b) => a + b, 0);
    const wraps: number[] = [];
    let acc = 0;
    let r = 1;
    for (let k = 0; k < weights.length && r < p.rows; k++) {
      const target = (total * r) / p.rows;
      if (acc + weights[k] >= target) {
        const a = bounds[k];
        const b = bounds[k + 1];
        // largest switch-free gap inside the interval, preferring the middle
        const pts = [a + 150, ...swCh.filter((c) => c > a + 150 && c < b - 150), b - 150].sort((x, y) => x - y);
        let best = (a + b) / 2;
        let bestGap = -1;
        for (let i = 0; i + 1 < pts.length; i++) {
          const gap = pts[i + 1] - pts[i];
          const mid = (pts[i] + pts[i + 1]) / 2;
          const score = gap - Math.abs(mid - (a + b) / 2) * 0.3;
          if (score > bestGap) { bestGap = score; best = mid; }
        }
        wraps.push(Math.round(best));
        r++;
      }
      acc += weights[k];
    }
    const rowBounds = [p.chainFrom, ...wraps, p.chainTo];
    const bps = Array.from(new Set(mainNodes.map((n) => Math.round(n.chain * 10) / 10).filter(inWin))).sort((a, b) => a - b);
    const weightOf = (a: number, b: number) => {
      // weight of a sub-interval [a,b] of the station interval containing it
      let w = 0;
      for (let k = 0; k + 1 < bounds.length; k++) {
        const lo = Math.max(a, bounds[k]);
        const hi = Math.min(b, bounds[k + 1]);
        if (hi > lo) w += weights[k] * ((hi - lo) / (bounds[k + 1] - bounds[k]));
      }
      return w;
    };
    for (let ri = 0; ri < rowBounds.length - 1; ri++) {
      const from = rowBounds[ri];
      const to = rowBounds[ri + 1];
      const x0 = p.marginL;
      const x1 = p.width - p.marginR;
      const top = p.top + ri * p.rowH;
      this.rows.push({ from, to, x0, x1, top });
      // sub-intervals of this row (station bounds inside)
      const sb = [from, ...bounds.filter((c) => c > from + 0.5 && c < to - 0.5), to];
      const rowW = weightOf(from, to);
      const pts: number[] = [];
      const xs: number[] = [];
      let xAcc = x0;
      for (let k = 0; k + 1 < sb.length; k++) {
        const a = sb[k];
        const b = sb[k + 1];
        const W = (weightOf(a, b) / rowW) * (x1 - x0);
        const inside = Array.from(new Set([a, ...bps.filter((c) => c > a + 0.05 && c < b - 0.05), b]));
        const sw = [0];
        for (let i = 1; i < inside.length; i++) {
          const len = inside[i] - inside[i - 1];
          sw.push(sw[i - 1] + (p.detail ? 14 + Math.pow(len, 0.72) : 4 + Math.pow(len, 0.6)));
        }
        const tot = sw[sw.length - 1] || 1;
        for (let i = k === 0 ? 0 : 1; i < inside.length; i++) {
          pts.push(inside[i]);
          xs.push(xAcc + (sw[i] / tot) * W);
        }
        xAcc += W;
      }
      this.maps.push({ pts, xs });
    }
  }

  chainRow(ch: number): number {
    for (let r = 0; r < this.rows.length; r++) if (ch < this.rows[r].to || r === this.rows.length - 1) return r;
    return this.rows.length - 1;
  }

  chainX(ch: number, row: number): number {
    const { pts, xs } = this.maps[row];
    const n = pts.length - 1;
    if (ch <= pts[0]) return xs[0] - (pts[0] - ch) * (n > 0 ? Math.min(0.6, (xs[1] - xs[0]) / (pts[1] - pts[0] || 1)) : 0.05);
    if (ch >= pts[n]) return xs[n] + (ch - pts[n]) * (n > 0 ? Math.min(0.6, (xs[n] - xs[n - 1]) / (pts[n] - pts[n - 1] || 1)) : 0.05);
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (pts[m] <= ch) lo = m; else hi = m;
    }
    const t = (ch - pts[lo]) / (pts[hi] - pts[lo] || 1);
    return xs[lo] + t * (xs[hi] - xs[lo]);
  }

  // ---------------------------------------------------------------- nodes

  private placeNodes() {
    const { topo, p } = this;
    const pos: (P | null)[] = topo.nodes.map(() => null);
    const m = p.nodeMargin ?? 1;
    const inWin = (c: number) => c >= p.chainFrom - m && c <= p.chainTo + m;
    const at = (ch: number, dy: number): P => {
      const row = this.chainRow(ch);
      return { row, x: this.chainX(ch, row), y: this.rows[row].top + dy };
    };
    // main tracks
    for (const n of topo.nodes) {
      if (!inWin(n.chain)) continue;
      const main = n.links.map((l) => topo.links[l]).find(isMain);
      if (main) pos[n.id] = at(n.chain, main.track === 'UP' ? p.upY : p.dnY);
    }
    // sidings
    for (const n of topo.nodes) {
      if (pos[n.id] || !inWin(n.chain)) continue;
      if (n.links.some((l) => topo.links[l].track === 'SID')) pos[n.id] = at(n.chain, p.midY);
    }
    // depot structures
    for (const d of topo.depots) {
      if (!inWin(d.junctionChain)) continue;
      const gate = topo.nodes[d.gateNode];
      const t2 = topo.links[d.gateLink];
      const j2 = topo.nodes[t2.a === gate.id ? t2.b : t2.a];
      const t1 = topo.links[j2.links.find((l) => l !== t2.id)!];
      const j1 = topo.nodes[t1.a === j2.id ? t1.b : t1.a];
      const t0 = topo.links[j1.links.find((l) => l !== t1.id)!];
      const z = topo.nodes[t0.a === j1.id ? t0.b : t0.a];
      const J = d.junctionChain;
      const row = this.chainRow(J);
      const top = this.rows[row].top;
      const xJ = this.chainX(J, row);
      pos[gate.id] = { row, x: xJ, y: top + p.upY - p.depotDy.gate };
      pos[j2.id] = { row, x: xJ, y: top + p.upY - p.depotDy.j2 };
      pos[j1.id] = { row, x: xJ, y: top + p.upY - p.depotDy.j1 };
      pos[z.id] = { row, x: xJ, y: top + p.upY - p.depotDy.z };
      for (const lid of [z.normal!, z.reverse!]) {
        const l = topo.links[lid];
        const q = topo.nodes[l.a === z.id ? l.b : l.a];
        pos[q.id] = { row, x: this.chainX(q.chain, row), y: top + p.upY - p.depotDy.q };
      }
    }
    // the rest (diagonal halves: crossovers, connectors, depot legs) sit between their neighbours
    for (let pass = 0; pass < 4; pass++) {
      for (const n of topo.nodes) {
        if (pos[n.id] || !inWin(n.chain)) continue;
        const nb = n.links.map((l) => { const lk = topo.links[l]; return pos[lk.a === n.id ? lk.b : lk.a]; }).filter((x): x is P => !!x);
        if (nb.length >= 2) pos[n.id] = { row: nb[0].row, x: (nb[0].x + nb[1].x) / 2, y: (nb[0].y + nb[1].y) / 2 };
      }
    }
    this.pos = pos;
    this.linkVisible = topo.links.map((l) => !!pos[l.a] && !!pos[l.b]);
  }

  // ---------------------------------------------------------------- links

  /** drawing segments of a link (main links may wrap across rows) */
  linkSegs(lid: number): { row: number; x1: number; y1: number; x2: number; y2: number }[] {
    const { topo } = this;
    const l = topo.links[lid];
    const a = this.pos[l.a];
    const b = this.pos[l.b];
    if (!a || !b) return [];
    if (a.row === b.row) return [{ row: a.row, x1: a.x, y1: a.y, x2: b.x, y2: b.y }];
    // wraps (main links only): split at each row boundary
    const out: { row: number; x1: number; y1: number; x2: number; y2: number }[] = [];
    const y = a.y - this.rows[a.row].top;
    let c0 = Math.min(l.chainA, l.chainB);
    const c1 = Math.max(l.chainA, l.chainB);
    for (let r = this.chainRow(c0); r <= this.chainRow(c1); r++) {
      const rd = this.rows[r];
      const s = Math.max(c0, rd.from);
      const e = Math.min(c1, rd.to);
      out.push({ row: r, x1: this.chainX(s, r), y1: rd.top + y, x2: this.chainX(e, r), y2: rd.top + y });
      c0 = e;
    }
    return out;
  }

  /** point at an offset along a link */
  linkPoint(lid: number, off: number): P | null {
    const { topo } = this;
    const l = topo.links[lid];
    const a = this.pos[l.a];
    const b = this.pos[l.b];
    if (!a || !b) return null;
    const t = Math.min(1, Math.max(0, off / l.len));
    if (a.row === b.row) return { row: a.row, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const ch = l.chainA + (l.chainB - l.chainA) * t;
    const row = this.chainRow(ch);
    return { row, x: this.chainX(ch, row), y: this.rows[row].top + (a.y - this.rows[a.row].top) };
  }

  /** link drawing segments covering [from,to] offsets (train bodies) */
  linkSpan(lid: number, from: number, to: number): { x1: number; y1: number; x2: number; y2: number }[] {
    const { topo } = this;
    const l = topo.links[lid];
    const a = this.pos[l.a];
    const b = this.pos[l.b];
    if (!a || !b) return [];
    if (a.row === b.row) {
      const p1 = this.linkPoint(lid, from)!;
      const p2 = this.linkPoint(lid, to)!;
      return [{ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }];
    }
    const out: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const chAt = (o: number) => l.chainA + (l.chainB - l.chainA) * Math.min(1, Math.max(0, o / l.len));
    const ca = Math.min(chAt(from), chAt(to));
    const cb = Math.max(chAt(from), chAt(to));
    const yRel = a.y - this.rows[a.row].top;
    let c0 = ca;
    for (let r = this.chainRow(ca); r <= this.chainRow(cb); r++) {
      const rd = this.rows[r];
      const e = Math.min(cb, rd.to);
      out.push({ x1: this.chainX(c0, r), y1: rd.top + yRel, x2: this.chainX(e, r), y2: rd.top + yRel });
      c0 = e;
    }
    return out;
  }

  /** world x/y of a station centre on the down track */
  stationX(st: number): { row: number; x: number } {
    const ch = this.topo.stations[st].chain;
    const row = this.chainRow(ch);
    return { row, x: this.chainX(ch, row) };
  }
}

/** chain window (with margin) covering a station and all its trackwork */
export function stationWindow(topo: Topology, st: number): [number, number] {
  const s = topo.stations[st];
  let lo = s.chain - 420;
  let hi = s.chain + 420;
  for (const sw of topo.switches) {
    if (sw.station !== st) continue;
    for (const n of sw.nodes) {
      lo = Math.min(lo, topo.nodes[n].chain - 160);
      hi = Math.max(hi, topo.nodes[n].chain + 160);
    }
  }
  for (const n of topo.nodes) {
    if (n.kind !== 'end') continue;
    if (Math.abs(n.chain - s.chain) < 1500) { lo = Math.min(lo, n.chain - 60); hi = Math.max(hi, n.chain + 60); }
  }
  for (const d of topo.depots) if (d.station === st) { lo = Math.min(lo, d.junctionChain - 300); hi = Math.max(hi, d.junctionChain + 300); }
  return [lo, hi];
}

/** whole-line chain window */
export function lineWindow(topo: Topology): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of topo.nodes) { lo = Math.min(lo, n.chain); hi = Math.max(hi, n.chain); }
  return [lo - 20, hi + 20];
}
