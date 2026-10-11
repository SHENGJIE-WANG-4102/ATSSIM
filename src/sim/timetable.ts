/**
 * Parametric timetable (运行图) generation.
 *
 * Templates are parameter sets (pattern of big/small routes, core headway,
 * dwell factor). A day plan is a list of periods referencing templates. The
 * generator lays out departure streams at a reference station per direction,
 * builds trips, links them into train blocks (车底运用) by FIFO matching at
 * each terminal, and closes the gaps with depot insertions (出库) and
 * withdrawals (回库) — revenue partial trips placed into gaps of the stream,
 * or non-revenue moves before/after service.
 */
import type { Topology } from './topology';
import type { RunTimes } from './dynamics';
import type { Block, DayType, Plan, PlanStop, Task, Trip, TripKind, TrackDir } from './model';
import { STATIONS, OPERATIONS, LINE_INFO } from '../data/line2';

export interface Template {
  id: string;
  name: string;
  desc: string;
  pattern: ('big' | 'small')[];
  /** headway between successive trains at the reference station (s) */
  headway: number;
  dwellFactor: number;
}

export const TEMPLATES: Record<string, Template> = {
  weekdayAM: {
    id: 'weekdayAM', name: '工作日早高峰', desc: '大小交路交替：大—大—小，淞虹路—广兰路 2\'30"，外段平均 3\'45"',
    pattern: ['big', 'big', 'small'], headway: 150, dwellFactor: 1.15,
  },
  weekdayPM: {
    id: 'weekdayPM', name: '工作日晚高峰', desc: '大小交路交替：大—大—小，淞虹路—广兰路 2\'30"，外段平均 3\'45"',
    pattern: ['big', 'big', 'small'], headway: 150, dwellFactor: 1.1,
  },
  weekdayOff: {
    id: 'weekdayOff', name: '工作日平峰', desc: '单一大交路 5\'30"', pattern: ['big'], headway: 330, dwellFactor: 1.0,
  },
  weekdayEvening: {
    id: 'weekdayEvening', name: '工作日夜间平峰', desc: '单一大交路 7\'00"', pattern: ['big'], headway: 420, dwellFactor: 0.95,
  },
  weekend: {
    id: 'weekend', name: '双休日/节假日', desc: '全天单一大交路，日间 4\'30"', pattern: ['big'], headway: 270, dwellFactor: 1.05,
  },
  firstLast: {
    id: 'firstLast', name: '首末班及收车', desc: '首班 05:25 起 7\'00"；21:57 后蟠祥路—广兰路 8\'00"，末班后回段/存车',
    pattern: ['big'], headway: 420, dwellFactor: 0.95,
  },
};

export interface Period { from: number; to: number; template: string; headway?: number; label: string }

const H = (h: number, m = 0) => h * 3600 + m * 60;

export function dayPeriods(dayType: DayType): Period[] {
  if (dayType === 'weekday') {
    return [
      { from: H(4), to: H(6, 5), template: 'firstLast', label: '首班/早间' },
      { from: H(6, 5), to: H(6, 50), template: 'weekdayOff', headway: 300, label: '早高峰前过渡' },
      { from: H(6, 50), to: H(9, 30), template: 'weekdayAM', label: '早高峰' },
      { from: H(9, 30), to: H(16, 50), template: 'weekdayOff', label: '平峰' },
      { from: H(16, 50), to: H(19, 30), template: 'weekdayPM', label: '晚高峰' },
      { from: H(19, 30), to: H(21, 40), template: 'weekdayEvening', label: '夜间平峰' },
      { from: H(21, 40), to: H(28), template: 'firstLast', headway: 480, label: '末班/收车' },
    ];
  }
  return [
    { from: H(4), to: H(6, 40), template: 'firstLast', label: '首班/早间' },
    { from: H(6, 40), to: H(7, 40), template: 'weekend', headway: 360, label: '早间过渡' },
    { from: H(7, 40), to: H(21), template: 'weekend', label: '双休日日间' },
    { from: H(21), to: H(21, 40), template: 'weekdayEvening', label: '夜间' },
    { from: H(21, 40), to: H(28), template: 'firstLast', headway: 480, label: '末班/收车' },
  ];
}

// ---------------------------------------------------------------- overlays (加开)

export interface OverlayPreset { id: string; label: string; from: number; to: number; a: number; b: number; headway: number; desc: string }

export const OVERLAY_PRESETS: OverlayPreset[] = [
  { id: 'ciie', label: '进博会保障加开', from: H(9, 30), to: H(17, 30), a: 1, b: 22, headway: 900, desc: '国家会展中心 ↔ 广兰路 区间加开，平峰每15分钟一列（各方向）' },
  { id: 'hongqiao', label: '虹桥枢纽大客流加开', from: H(20), to: H(22, 30), a: 2, b: 22, headway: 720, desc: '虹桥火车站 ↔ 广兰路 区间加开，夜间每12分钟一列（虹桥火车站站前折返）' },
];

// ---------------------------------------------------------------- helpers

export interface PlanContext { topo: Topology; rt: RunTimes; dayType: DayType }

const TERMINAL_DEPOT: Record<number, string> = { 0: 'BZL', 30: 'CSD', 4: 'BZL', 22: 'LYD', 1: 'BZL', 2: 'BZL', 19: 'LYD', 28: 'CSD' };
/** trains a terminal can hold at once (two tail tracks + the departure platform, or the tails of an intermediate turnback) */
const TERMINAL_CAP: Record<number, number> = { 0: 3, 30: 3, 4: 2, 22: 2, 1: 2, 2: 2 };
/**
 * trains the circulation lets lay over at a terminal at once: one place less than the
 * terminal holds at the line ends, so a train going back to the depot or coming out of
 * it always finds a free track (D7)
 */
const MAX_PRESENT: Record<number, number> = { 0: 2, 30: 2, 4: 2, 22: 2, 1: 2, 2: 2 };
/** longest a train may wait at a terminal between trips (s) */
const MAX_LAYOVER = 1500;
/** spacing of a depot move from the neighbouring departures where it joins / leaves the line (s) */
const SLOT_GAP = 120;

export function depotIndex(topo: Topology, key: string): number {
  return topo.depots.findIndex((d) => d.key === key);
}

export function exitStation(topo: Topology, depot: number, dir: TrackDir): number {
  const J = topo.depots[depot].junctionChain;
  const st = topo.stations;
  if (dir === 'DN') return st.find((s) => s.chain > J)!.index;
  return [...st].reverse().find((s) => s.chain < J)!.index;
}
export function entryStation(topo: Topology, depot: number, dir: TrackDir): number {
  const J = topo.depots[depot].junctionChain;
  const st = topo.stations;
  if (dir === 'DN') return [...st].reverse().find((s) => s.chain < J)!.index;
  return st.find((s) => s.chain > J)!.index;
}

function minTurn(st: number): number {
  const id = STATIONS[st].id;
  return OPERATIONS.minTurnback[id] ?? 330;
}

export function dwellOf(st: number, factor: number): number {
  return Math.round((STATIONS[st].dwell * factor) / 5) * 5;
}

/** stations visited from a to b inclusive */
function seq(a: number, b: number): number[] {
  const out: number[] = [];
  if (a <= b) for (let i = a; i <= b; i++) out.push(i);
  else for (let i = a; i >= b; i--) out.push(i);
  return out;
}

/** dwellFactor: a constant, or the factor in force at a time (dwell follows the period at each stop, so successive trains never close up across a period change) */
export function buildStops(ctx: PlanContext, dir: TrackDir, from: number, to: number, originDep: number, revenue: boolean, dwellFactor: number | ((t: number) => number)): PlanStop[] {
  const sts = seq(from, to);
  const stops: PlanStop[] = [];
  let t = originDep;
  for (let k = 0; k < sts.length; k++) {
    const st = sts[k];
    if (k === 0) { stops.push({ st, arr: t, dep: t, stop: true }); continue; }
    const prev = sts[k - 1];
    const idx = Math.min(prev, st);
    const prevStops = stops[k - 1].stop;
    const isLast = k === sts.length - 1;
    const stopHere = revenue || isLast;
    let run: number;
    if (dir === 'DN') run = prevStops && stopHere ? ctx.rt.dn[idx] : ctx.rt.passDn[idx] + (prevStops ? 10 : 0) + (stopHere ? 12 : 0);
    else run = prevStops && stopHere ? ctx.rt.up[idx] : ctx.rt.passUp[idx] + (prevStops ? 10 : 0) + (stopHere ? 12 : 0);
    const arr = t + run;
    const dw = stopHere && !isLast ? dwellOf(st, typeof dwellFactor === 'number' ? dwellFactor : dwellFactor(arr)) : 0;
    stops.push({ st, arr, dep: arr + dw, stop: stopHere });
    t = arr + dw;
  }
  return stops;
}

function periodAt(periods: Period[], t: number): Period {
  for (const p of periods) if (t >= p.from && t < p.to) return p;
  return periods[periods.length - 1];
}

// ---------------------------------------------------------------- generation

interface GenTrip extends Trip { next?: number; prev?: number }

export function generatePlan(ctx: PlanContext): Plan {
  const { topo } = ctx;
  const periods = dayPeriods(ctx.dayType);
  const trips: GenTrip[] = [];
  const nS = topo.stations.length;
  const W = 0;
  const E = nS - 1;
  const SHR = 4;
  const GLL = 22;

  const addTrip = (dir: TrackDir, kind: TripKind, from: number, to: number, stops: PlanStop[], revenue: boolean, overlay?: string): GenTrip => {
    const tr: GenTrip = { id: trips.length, no: '', dir, kind, from, to, stops, revenue, block: -1, overlay };
    trips.push(tr);
    return tr;
  };

  const factorAt = (t: number) => TEMPLATES[periodAt(periods, t).template].dwellFactor;
  const headwayAt = (t: number) => {
    const p = periodAt(periods, t);
    return p.headway ?? TEMPLATES[p.template].headway;
  };

  // offsets from origin departure to reference departure
  const refOffset = (dir: TrackDir, from: number, ref: number, factor: number) => {
    const s = buildStops(ctx, dir, from, ref, 0, true, factor);
    return s[s.length - 1].dep + dwellOf(ref, factor);
  };

  // ---- DN stream (reference: 淞虹路 departure)
  {
    let idx = 0;
    let lastPeriod = '';
    let t = OPERATIONS.firstWestTerminusDep + refOffset('DN', W, SHR, factorAt(OPERATIONS.firstWestTerminusDep));
    for (let guard = 0; guard < 2000; guard++) {
      const p = periodAt(periods, t);
      const tpl = TEMPLATES[p.template];
      if (p.label !== lastPeriod) { idx = 0; lastPeriod = p.label; }
      let kind = tpl.pattern[idx % tpl.pattern.length] as 'big' | 'small' | 'late';
      const f = tpl.dwellFactor;
      if (kind === 'big' || kind === 'late') {
        const originDep = t - refOffset('DN', W, SHR, f);
        if (originDep > OPERATIONS.lastBigEastboundDep) kind = 'late';
        if (originDep > OPERATIONS.lastLateEastboundDep + 1) break;
        const to = kind === 'big' ? E : GLL;
        const stops = buildStops(ctx, 'DN', W, to, originDep, true, factorAt);
        addTrip('DN', kind, W, to, stops, true);
      } else {
        const stops = buildStops(ctx, 'DN', SHR, GLL, t, true, factorAt);
        addTrip('DN', 'small', SHR, GLL, stops, true);
      }
      idx++;
      t += headwayAt(t);
    }
  }
  // ---- UP stream (reference: 广兰路 departure)
  {
    let idx = 0;
    let lastPeriod = '';
    const fullUp = (f: number) => {
      const s = buildStops(ctx, 'UP', E, W, 0, true, f);
      return s[s.length - 1].arr;
    };
    const lastBigWestDep = OPERATIONS.lastBigWestboundArrival - fullUp(0.95);
    let t = OPERATIONS.firstEastTerminusDep + refOffset('UP', E, GLL, factorAt(OPERATIONS.firstEastTerminusDep));
    for (let guard = 0; guard < 2000; guard++) {
      const p = periodAt(periods, t);
      const tpl = TEMPLATES[p.template];
      if (p.label !== lastPeriod) { idx = 0; lastPeriod = p.label; }
      let kind = tpl.pattern[idx % tpl.pattern.length] as 'big' | 'small' | 'late';
      const f = tpl.dwellFactor;
      if (kind === 'big') {
        const originDep = t - refOffset('UP', E, GLL, f);
        if (originDep > lastBigWestDep) kind = 'late';
        else addTrip('UP', 'big', E, W, buildStops(ctx, 'UP', E, W, originDep, true, factorAt), true);
      }
      if (kind === 'late') {
        if (t > OPERATIONS.lastLateWestboundDep + 1) break;
        addTrip('UP', 'late', GLL, W, buildStops(ctx, 'UP', GLL, W, t, true, factorAt), true);
      }
      if (kind === 'small') addTrip('UP', 'small', GLL, SHR, buildStops(ctx, 'UP', GLL, SHR, t, true, factorAt), true);
      idx++;
      t += headwayAt(t);
    }
  }

  const blocks = circulate(ctx, trips, [W, E, SHR, GLL], periods, undefined);
  const plan: Plan = {
    dayType: ctx.dayType, trips, blocks,
    periods: periods.map((p) => ({ from: p.from, to: p.to, template: p.template, label: p.label })),
    overlays: [], fleetPeak: 0,
  };
  numberPlan(plan);
  plan.fleetPeak = fleetPeak(plan);
  return plan;
}

/**
 * Link trips into blocks at the given terminals, adding depot insertions,
 * withdrawals and terminal stabling. Mutates `trips` (adds new trips) and
 * returns the new blocks.
 */
function circulate(ctx: PlanContext, trips: GenTrip[], terminals: number[], periods: Period[], overlay?: string, baseTrips?: Trip[], blockBase = 0, baseOcc?: Map<number, { from: number; to: number }[]>): Block[] {
  const { topo } = ctx;
  const pool = trips.filter((t) => t.overlay === overlay && !t.cancelled);
  const allForGaps = () => [...(baseTrips ?? []), ...trips];
  const stabling: Record<number, number> = overlay ? {} : { 0: OPERATIONS.terminalStabling.PXL, [topo.stations.length - 1]: OPERATIONS.terminalStabling.PDA };
  const stablingNight: Record<number, number> = { ...stabling };
  const sources: GenTrip[] = [];
  const sinks: GenTrip[] = [];

  /**
   * An added-service trip into a terminal the base plan already fills does not run: the
   * train goes back to the depot after the trip before (or the trip is simply not run).
   */
  const dropArrival = (X: GenTrip) => {
    X.cancelled = true;
    if (X.prev !== undefined) {
      const P = trips[X.prev];
      P.next = undefined;
      X.prev = undefined;
      sinks.push(P);
    } else if (sources.includes(X)) sources.splice(sources.indexOf(X), 1);
  };
  for (const T of terminals) {
    const arrivals = pool.filter((t) => t.to === T).map((t) => ({ trip: t, time: t.stops[t.stops.length - 1].arr }));
    const departures = pool.filter((t) => t.from === T).map((t) => ({ trip: t, time: t.stops[0].dep }));
    type Ev = { time: number; kind: 0 | 1; trip: GenTrip };
    const evs: Ev[] = [
      ...arrivals.map((a) => ({ time: a.time, kind: 0 as const, trip: a.trip })),
      ...departures.map((d) => ({ time: d.time, kind: 1 as const, trip: d.trip })),
    ].sort((a, b) => a.time - b.time || a.kind - b.kind);
    const cap = MAX_PRESENT[T] ?? 2;
    const mt = minTurn(T);
    // FIFO matching of arrivals to departures
    const pairs: { a: GenTrip; d: GenTrip }[] = [];
    const out: GenTrip[] = [];
    const src: GenTrip[] = [];
    const present: { trip: GenTrip; ready: number }[] = [];
    for (const ev of evs) {
      // trains idle longer than the maximum layover go back to the depot
      for (let i = present.length - 1; i >= 0; i--) {
        if (ev.time - present[i].ready > MAX_LAYOVER) out.push(present.splice(i, 1)[0].trip);
      }
      if (ev.trip.cancelled) continue;
      if (ev.kind === 0) {
        // trains of the base plan turning back here (when adding an overlay) take places too
        const base = (baseOcc?.get(T) ?? []).filter((o) => o.from <= ev.time + mt && o.to > ev.time).length;
        if (overlay && base >= cap) { dropArrival(ev.trip); continue; }
        present.push({ trip: ev.trip, ready: ev.time + mt });
        if (present.length + base > cap) out.push(present.pop()!.trip);
      } else {
        const i = present.findIndex((p) => p.ready <= ev.time);
        if (i >= 0) pairs.push({ a: present.splice(i, 1)[0].trip, d: ev.trip });
        else src.push(ev.trip);
      }
    }
    for (const p of present) out.push(p.trip);
    const m = { pairs, out, src };
    for (const p of m.pairs) { p.a.next = p.d.id; p.d.prev = p.a.id; }
    sinks.push(...m.out);
    sources.push(...m.src);
  }

  // stream departures at a station in a direction (for gap placement)
  const streamDeps = (st: number, dir: TrackDir): number[] => {
    const out: number[] = [];
    for (const t of allForGaps()) {
      if (t.dir !== dir || t.cancelled) continue;
      for (const s of t.stops) if (s.st === st) { out.push(s.dep); break; }
    }
    return out.sort((a, b) => a - b);
  };
  // departures per station and direction, rebuilt whenever trips were added
  const depIndex = new Map<string, number[]>();
  let depIndexN = -1;
  const depsAt = (st: number, dir: TrackDir): number[] => {
    if (depIndexN !== allForGaps().length) { depIndex.clear(); depIndexN = allForGaps().length; }
    const k = `${st}${dir}`;
    let v = depIndex.get(k);
    if (!v) { v = streamDeps(st, dir); depIndex.set(k, v); }
    return v;
  };
  /** a trip keeps the minimum headway to every other train at every station on its path (P1) */
  const pathClear = (stops: PlanStop[], dir: TrackDir) =>
    stops.every((p) => depsAt(p.st, dir).every((x) => Math.abs(x - p.dep) >= MIN_HEADWAY));
  /** stops of a move starting at or before `latest` that fit between the other trains along the whole path */
  const fitBefore = (dir: TrackDir, latest: number, build: (t0: number) => PlanStop[]): PlanStop[] | null => {
    for (let k = 0; k <= 240; k++) {
      const st = build(latest - k * 10);
      if (pathClear(st, dir)) return st;
    }
    return null;
  };
  /** stops of a move starting at or after `earliest` that fit between the other trains along the whole path */
  const fitAfter = (dir: TrackDir, earliest: number, build: (t0: number) => PlanStop[]): PlanStop[] | null => {
    for (let k = 0; k <= 240; k++) {
      const st = build(earliest + k * 10);
      if (pathClear(st, dir)) return st;
    }
    return null;
  };
  /** latest slot ≤ latest keeping ≥SLOT_GAP from neighbouring departures */
  const placeBefore = (st: number, dir: TrackDir, latest: number): number => {
    const deps = streamDeps(st, dir).filter((x) => x > latest - 2400 && x < latest + 900);
    if (!deps.length || latest > deps[deps.length - 1] + SLOT_GAP) return Math.round(latest);
    let best = -Infinity;
    const bounds = [-Infinity, ...deps, Infinity];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const cand = Math.min(latest, bounds[i + 1] - SLOT_GAP);
      if (cand >= bounds[i] + SLOT_GAP && cand > best) best = cand;
    }
    if (best === -Infinity) {
      // no clean slot: take the midpoint of the widest gap before `latest`
      let gap = 0;
      for (let i = 0; i + 1 < deps.length; i++) if (deps[i + 1] - deps[i] > gap && (deps[i] + deps[i + 1]) / 2 <= latest) { gap = deps[i + 1] - deps[i]; best = (deps[i] + deps[i + 1]) / 2; }
      if (best === -Infinity) best = latest;
    }
    return Math.round(best);
  };
  /** earliest slot ≥ earliest keeping ≥SLOT_GAP s from neighbouring departures */
  const placeAfter = (st: number, dir: TrackDir, earliest: number): number => {
    const deps = streamDeps(st, dir).filter((x) => x > earliest - 900 && x < earliest + 2400);
    if (!deps.length || earliest < deps[0] - SLOT_GAP) return Math.round(earliest);
    let best = Infinity;
    const bounds = [-Infinity, ...deps, Infinity];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const cand = Math.max(earliest, bounds[i] + SLOT_GAP);
      if (cand <= bounds[i + 1] - SLOT_GAP && cand < best) best = cand;
    }
    if (best === Infinity) {
      let gap = 0;
      for (let i = 0; i + 1 < deps.length; i++) if (deps[i + 1] - deps[i] > gap && (deps[i] + deps[i + 1]) / 2 >= earliest) { gap = deps[i + 1] - deps[i]; best = (deps[i] + deps[i + 1]) / 2; }
      if (best === Infinity) best = earliest;
    }
    return Math.round(best);
  };

  const lastDepFrom = (T: number) => Math.max(...pool.filter((t) => t.from === T).map((t) => t.stops[0].dep), -Infinity);
  const firstDepFrom = (T: number) => Math.min(...pool.filter((t) => t.from === T).map((t) => t.stops[0].dep), Infinity);
  const startOf: Map<number, Block['start']> = new Map();
  const endOf: Map<number, Block['end']> = new Map();

  // ---- sources
  const queue = sources.sort((a, b) => a.stops[0].dep - b.stops[0].dep);
  /**
   * An added-service train that cannot be brought out of the depot between the other
   * trains (peak headway) does not run its first trip; the train is brought out for the
   * next trip of its chain instead.
   */
  const dropSource = (D: GenTrip) => {
    D.cancelled = true;
    if (D.next !== undefined) {
      const N = trips[D.next];
      N.prev = undefined;
      D.next = undefined;
      const i = queue.findIndex((x) => x.stops[0].dep > N.stops[0].dep);
      queue.splice(i < 0 ? queue.length : i, 0, N);
    } else sinks.splice(sinks.indexOf(D), 1);
  };
  for (let qi = 0; qi < queue.length; qi++) {
    const D = queue[qi];
    const T = D.from;
    const dep = D.stops[0].dep;
    const depot = depotIndex(topo, TERMINAL_DEPOT[T]);
    const early = dep <= firstDepFrom(T) + 1500 && !overlay;
    if (early && (stabling[T] ?? 0) > 0) {
      stabling[T]--;
      startOf.set(D.id, { kind: 'stable', station: T });
      continue;
    }
    const towardDir: TrackDir = topo.stations[T].chain < topo.depots[depot].junctionChain ? 'UP' : 'DN';
    const ex = exitStation(topo, depot, towardDir);
    if (ex === T) {
      startOf.set(D.id, { kind: 'depot', depot, time: 0 });
      continue;
    }
    const mt = minTurn(T);
    if (early) {
      // non-revenue positioning move before service
      const probe = buildStops(ctx, towardDir, ex, T, 0, false, 1);
      const run = probe[probe.length - 1].arr;
      const st = fitBefore(towardDir, placeBefore(ex, towardDir, dep - mt - 60 - run), (t0) => buildStops(ctx, towardDir, ex, T, t0, false, 1))
        ?? buildStops(ctx, towardDir, ex, T, dep - mt - 60 - run, false, 1);
      st[0].stop = false;
      const e = addTo(trips, towardDir, 'empty', ex, T, st, false, overlay);
      e.next = D.id;
      D.prev = e.id;
      startOf.set(e.id, { kind: 'depot', depot, time: 0 });
    } else {
      const f = 1;
      const probe = buildStops(ctx, towardDir, ex, T, 0, true, f);
      const run = probe[probe.length - 1].arr;
      const latest = dep - mt - run;
      let st = fitBefore(towardDir, Math.min(latest, placeBefore(ex, towardDir, latest)), (t0) => buildStops(ctx, towardDir, ex, T, t0, true, f));
      if (!st && overlay) { dropSource(D); continue; }
      st ??= buildStops(ctx, towardDir, ex, T, placeBefore(ex, towardDir, latest), true, f);
      const ins = addTo(trips, towardDir, overlay ? 'extra' : 'ins', ex, T, st, true, overlay);
      ins.next = D.id;
      D.prev = ins.id;
      startOf.set(ins.id, { kind: 'depot', depot, time: 0 });
    }
  }
  // ---- sinks
  // overnight stabling at terminal tails goes to the LAST arrivals, so that
  // earlier trains can still use the tails to turn back towards the depot
  const lastArr = (t: GenTrip) => t.stops[t.stops.length - 1].arr;
  for (const A of sinks.slice().sort((a, b) => lastArr(b) - lastArr(a))) {
    const T = A.to;
    if (lastArr(A) >= lastDepFrom(T) - 60 && (stablingNight[T] ?? 0) > 0) {
      stablingNight[T]--;
      endOf.set(A.id, { kind: 'stable', station: T });
    }
  }
  const sinkQueue = sinks.sort((a, b) => lastArr(a) - lastArr(b));
  for (let qi = 0; qi < sinkQueue.length; qi++) {
    const A = sinkQueue[qi];
    if (endOf.has(A.id) || A.cancelled) continue;
    const T = A.to;
    const arr = lastArr(A);
    const depot = depotIndex(topo, TERMINAL_DEPOT[T]);
    // (an added service ends inside the day: its trains go back as ordinary withdrawals)
    const night = !overlay && arr >= lastDepFrom(T) - 60;
    const awayDir: TrackDir = topo.stations[T].chain < topo.depots[depot].junctionChain ? 'DN' : 'UP';
    const en = entryStation(topo, depot, awayDir);
    if (en === T) { endOf.set(A.id, { kind: 'depot', depot }); continue; }
    const mt = minTurn(T);
    if (night) {
      const st = fitAfter(awayDir, arr + mt, (t0) => buildStops(ctx, awayDir, T, en, t0, false, 1)) ?? buildStops(ctx, awayDir, T, en, arr + mt, false, 1);
      st[st.length - 1].stop = false;
      const e = addTo(trips, awayDir, 'empty', T, en, st, false, overlay);
      A.next = e.id;
      e.prev = A.id;
      endOf.set(e.id, { kind: 'depot', depot });
    } else {
      let st = fitAfter(awayDir, placeAfter(T, awayDir, arr + mt), (t0) => buildStops(ctx, awayDir, T, en, t0, true, 1));
      if (!st && overlay && A.prev !== undefined) {
        // an added-service train that cannot get back to the depot between the other trains
        // (peak headway) does not run its last trip: it goes back after the trip before
        const P = trips[A.prev];
        A.cancelled = true;
        A.prev = undefined;
        P.next = undefined;
        const i = sinkQueue.findIndex((x, k) => k > qi && lastArr(x) > lastArr(P));
        sinkQueue.splice(i < 0 ? sinkQueue.length : i, 0, P);
        continue;
      }
      st ??= buildStops(ctx, awayDir, T, en, placeAfter(T, awayDir, arr + mt), true, 1);
      const wd = addTo(trips, awayDir, overlay ? 'extra' : 'wd', T, en, st, true, overlay);
      A.next = wd.id;
      wd.prev = A.id;
      endOf.set(wd.id, { kind: 'depot', depot });
    }
  }

  // ---- blocks
  const blocks: Block[] = [];
  const heads = trips.filter((t) => t.overlay === overlay && !t.cancelled && t.prev === undefined && t.block < 0);
  heads.sort((a, b) => a.stops[0].dep - b.stops[0].dep);
  for (const h of heads) {
    const b: Block = { id: blockBase + blocks.length, svc: '', start: startOf.get(h.id) ?? { kind: 'stable', station: h.from }, end: { kind: 'none' }, trips: [] };
    let cur: GenTrip | undefined = h;
    let guard = 0;
    while (cur && guard++ < 500) {
      cur.block = b.id;
      b.trips.push(cur.id);
      if (cur.next === undefined) { b.end = endOf.get(cur.id) ?? { kind: 'none' }; break; }
      cur = trips[cur.next];
    }
    if (b.start.kind === 'depot') b.start.time = depotStartTime(ctx, b.start.depot, trips[b.trips[0]]);
    blocks.push(b);
  }
  void periods;
  return blocks;
}

function addTo(trips: GenTrip[], dir: TrackDir, kind: TripKind, from: number, to: number, stops: PlanStop[], revenue: boolean, overlay?: string): GenTrip {
  const t: GenTrip = { id: trips.length, no: '', dir, kind, from, to, stops, revenue, block: -1, overlay };
  trips.push(t);
  return t;
}

/** time a train must leave the depot gate to make its first departure */
export function depotStartTime(ctx: PlanContext, depot: number, first: Trip): number {
  const { topo } = ctx;
  const J = topo.depots[depot].junctionChain;
  const st0 = first.stops[0].st;
  const dist = Math.abs(topo.stations[st0].chain - J);
  const firstStop = first.stops.find((s) => s.stop) ?? first.stops[0];
  const refTime = first.stops[0].stop ? first.stops[0].dep : firstStop.arr;
  // transfer track (~470 m at 25 km/h) + junction + run on the main line
  const travel = 95 + dist / 13 + 25;
  return Math.round(refTime - travel - (first.stops[0].stop ? 75 : 30));
}

function numberPlan(plan: Plan, startSvc = 1) {
  const cnt: Record<string, number> = {};
  const digit: Record<TripKind, string> = { big: '1', small: '2', late: '3', ins: '4', wd: '4', extra: '5', empty: '0', adj: '6' };
  const sorted = [...plan.trips].filter((t) => !t.no).sort((a, b) => a.stops[0].dep - b.stops[0].dep);
  for (const t of sorted) {
    const key = digit[t.kind] + t.dir;
    const n = (cnt[key] ?? 0) + 1;
    cnt[key] = n;
    const seqN = t.dir === 'DN' ? 2 * n - 1 : 2 * n;
    t.no = digit[t.kind] + String(seqN % 1000).padStart(3, '0');
  }
  const blocks = plan.blocks.filter((b) => !b.svc).sort((a, b) => blockStart(plan, a) - blockStart(plan, b));
  let svc = startSvc;
  for (const b of blocks) b.svc = String(svc++).padStart(3, '0');
}

function blockStart(plan: Plan, b: Block) {
  return b.start.kind === 'depot' ? b.start.time : plan.trips[b.trips[0]].stops[0].dep;
}

export function fleetPeak(plan: Plan): number {
  const ev: [number, number][] = [];
  for (const b of plan.blocks) {
    const first = plan.trips[b.trips[0]];
    const last = plan.trips[b.trips[b.trips.length - 1]];
    const s = b.start.kind === 'depot' ? b.start.time : first.stops[0].dep - 600;
    const e = last.stops[last.stops.length - 1].arr + (b.end.kind === 'depot' ? 300 : 0);
    if (b.start.kind === 'stable' || b.end.kind === 'stable') continue;
    ev.push([s, 1], [e, -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of ev) { cur += d; max = Math.max(max, cur); }
  const stabled = plan.blocks.filter((b) => b.start.kind === 'stable' || b.end.kind === 'stable').length;
  return max + stabled;
}

// ---------------------------------------------------------------- overlays

export function applyOverlay(ctx: PlanContext, plan: Plan, preset: { id: string; label: string; a: number; b: number; from: number; to: number; headway: number }): { trips: number; blocks: number; skipped: number } {
  const trips = plan.trips as GenTrip[];
  const tag = `${preset.id}@${preset.from}`;
  const n0 = trips.length;
  const { a, b } = preset;
  const dirAB: TrackDir = a < b ? 'DN' : 'UP';
  const dirBA: TrackDir = dirAB === 'DN' ? 'UP' : 'DN';
  const existing = [...plan.trips];
  // every added trip keeps the minimum headway (P1) to all other trains along its whole
  // path; it is moved by up to half the overlay headway to find such a slot, otherwise
  // it is not run (reported as a shortfall)
  const idx = new DepIndex(existing);
  const fit = (dir: TrackDir, from: number, to: number, t: number): PlanStop[] | null => {
    for (let k = 0; k * 10 <= preset.headway / 2; k++) {
      for (const t0 of k ? [t + k * 10, t - k * 10] : [t]) {
        const st = buildStops(ctx, dir, from, to, t0, true, 1);
        if (idx.clear(st, dir)) return st;
      }
    }
    return null;
  };
  let skipped = 0;
  for (let t = preset.from; t <= preset.to; t += preset.headway) {
    for (const [dir, from, to, t0] of [[dirAB, a, b, t], [dirBA, b, a, t + preset.headway / 2]] as [TrackDir, number, number, number][]) {
      const st = fit(dir, from, to, t0);
      if (!st) { skipped++; continue; }
      idx.add(addTo(trips, dir, 'extra', from, to, st, true, tag));
    }
  }
  const blocks = circulate(ctx, trips, [a, b], [], tag, existing, plan.blocks.length, terminalOccupancy(plan));
  plan.blocks.push(...blocks);
  plan.overlays.push({ id: tag, label: preset.label, from: preset.from, to: preset.to });
  const maxSvc = Math.max(0, ...plan.blocks.filter((x) => x.svc).map((x) => parseInt(x.svc, 10)));
  numberPlan(plan, maxSvc + 1);
  plan.fleetPeak = fleetPeak(plan);
  const live = trips.slice(n0).filter((t) => !t.cancelled);
  return { trips: live.length, blocks: blocks.length, skipped: skipped + trips.slice(n0).filter((t) => t.cancelled && t.revenue).length };
}

/** Single extra train (加开列车) from a depot to a turnback station and back. */
export function addExtraTrain(ctx: PlanContext, plan: Plan, depot: number, dir: TrackDir, to: number, time: number): Block | string {
  const { topo } = ctx;
  const ex = exitStation(topo, depot, dir);
  if ((dir === 'DN' && to <= ex) || (dir === 'UP' && to >= ex)) return '目的站不在出段方向前方';
  const back: TrackDir = dir === 'DN' ? 'UP' : 'DN';
  if (!turnbackAt(topo, to, dir)) return `${STATIONS[to].name} 无该方向折返条件`;
  const en = entryStation(topo, depot, back);
  const trips = plan.trips as GenTrip[];
  const index = new DepIndex(plan.trips);
  let s1: PlanStop[] = [], s2: PlanStop[] = [];
  for (let offset = 0; offset <= 900; offset += 10) {
    const out = buildStops(ctx, dir, ex, to, time + offset, true, 1);
    const into = buildStops(ctx, back, to, en, out[out.length - 1].arr + minTurn(to), true, 1);
    if (index.clear(out, dir) && index.clear(into, back)) { s1 = out; s2 = into; break; }
  }
  if (!s1.length) return '未来15分钟内无全路径可行的加开及回段时隙';
  const t1 = addTo(trips, dir, 'extra', ex, to, s1, true, 'adhoc');
  const t2 = addTo(trips, back, 'extra', to, en, s2, true, 'adhoc');
  const b: Block = { id: plan.blocks.length, svc: '', start: { kind: 'depot', depot, time: 0 }, end: { kind: 'depot', depot }, trips: [t1.id, t2.id] };
  t1.block = t2.block = b.id;
  b.start = { kind: 'depot', depot, time: depotStartTime(ctx, depot, t1) };
  plan.blocks.push(b);
  const maxSvc = Math.max(0, ...plan.blocks.filter((x) => x.svc).map((x) => parseInt(x.svc, 10)));
  numberPlan(plan, maxSvc + 1);
  plan.fleetPeak = fleetPeak(plan);
  return b;
}

// ---------------------------------------------------------------- turnback & tasks

export type Turnback = { kind: 'rear'; berths: number[] } | { kind: 'front'; arrBerth: number; depBerth: number };

/** how a train arriving at `station` travelling `arrDir` can reverse there */
export function turnbackAt(topo: Topology, station: number, arrDir: TrackDir): Turnback | null {
  const s = topo.stations[station];
  const rear = s.turnbackBerths.filter((bid) => {
    const b = topo.berths[bid];
    const l = topo.links[b.link];
    const west = (l.chainA + l.chainB) / 2 < s.chain;
    return arrDir === 'UP' ? west : !west;
  });
  if (rear.length) return { kind: 'rear', berths: rear };
  if (s.frontTurnback[arrDir]) {
    // arrive on the opposite platform against its normal direction
    const opp = arrDir === 'DN' ? s.platforms.UP : s.platforms.DN;
    const travel = arrDir === 'DN' ? 1 : -1;
    const arrBerth = topo.berths.find((b) => b.platform === opp && b.dir === travel)!.id;
    const depBerth = topo.berths.find((b) => b.platform === opp && b.dir !== travel)!.id;
    return { kind: 'front', arrBerth, depBerth };
  }
  return null;
}

export function platformBerth(topo: Topology, station: number, dir: TrackDir): number {
  const s = topo.stations[station];
  const p = dir === 'DN' ? s.platforms.DN : s.platforms.UP;
  const travel = dir === 'DN' ? 1 : -1;
  return topo.berths.find((b) => b.platform === p && b.dir === travel)!.id;
}

/** Task list for a block (from its first trip). */
export function blockTasks(topo: Topology, plan: Plan, block: Block, fromTrip = 0): Task[] {
  const tasks: Task[] = [];
  const ids = block.trips.slice(fromTrip);
  for (let k = 0; k < ids.length; k++) {
    const trip = plan.trips[ids[k]];
    if (trip.cancelled) continue;
    tripTasks(topo, trip, tasks, k === 0 && block.start.kind === 'depot' && fromTrip === 0);
    const next = ids.slice(k + 1).map((i) => plan.trips[i]).find((t) => !t.cancelled);
    if (next) addTurnback(topo, trip, tasks);
    else if (block.end.kind === 'depot') tasks.push({ k: 'depot', depot: block.end.depot });
    else if (block.end.kind === 'stable') {
      const tb = turnbackAt(topo, trip.to, trip.dir);
      if (tb && tb.kind === 'rear') tasks.push({ k: 'stable', berth: -1, reason: '存车' });
    }
  }
  return tasks;
}

export function tripTasks(topo: Topology, trip: Trip, tasks: Task[], fromDepot: boolean) {
  for (let i = 0; i < trip.stops.length; i++) {
    const s = trip.stops[i];
    if (!s.stop) continue;
    const isFirst = i === 0;
    tasks.push({
      k: 'stop', berth: platformBerth(topo, s.st, trip.dir), station: s.st, trip: trip.id,
      arr: isFirst && !fromDepot ? null : s.arr, dep: i === trip.stops.length - 1 ? null : s.dep,
      doors: trip.revenue, revenue: trip.revenue,
    });
  }
}

export function addTurnback(topo: Topology, trip: Trip, tasks: Task[]) {
  const tb = turnbackAt(topo, trip.to, trip.dir);
  if (!tb) return;
  if (tb.kind === 'rear') {
    tasks.push({ k: 'reverse', berths: tb.berths, chosen: tb.berths[0], station: trip.to, minTime: 40 });
  } else {
    // station-front: retarget the arrival stop to the opposite platform
    for (let i = tasks.length - 1; i >= 0; i--) {
      const t = tasks[i];
      if (t.k === 'stop' && t.station === trip.to) { t.berth = tb.arrBerth; break; }
    }
    tasks.push({ k: 'reverse', berths: [tb.arrBerth], chosen: tb.arrBerth, station: trip.to, minTime: 40 });
  }
}

// ---------------------------------------------------------------- validation

export interface PlanIssue {
  severity: 'error' | 'warn';
  code: 'TURN_SHORT' | 'BLOCK_BREAK' | 'TERMINAL_FULL' | 'HEADWAY' | 'FLEET' | 'TIME_ORDER' | 'UNASSIGNED';
  t: number;
  text: string;
}

/** shortest turnback the line can do (s): P1 table 1, CBTC 115–120 s */
const MIN_TURN_ABS = 120;
/** shortest station headway (s): P1 table 1, CBTC design headway ≤ 90 s */
const MIN_HEADWAY = 90;

/** time intervals trains spend turning back / laying over at each station (between two trips in opposite directions) */
export function terminalOccupancy(plan: Plan): Map<number, { from: number; to: number }[]> {
  const occ = new Map<number, { from: number; to: number }[]>();
  for (const b of plan.blocks) {
    const ts = b.trips.map((i) => plan.trips[i]).filter((t) => !t.cancelled);
    for (let i = 0; i + 1 < ts.length; i++) {
      const a = ts[i];
      const d = ts[i + 1];
      if (a.to !== d.from || a.dir === d.dir) continue;
      if (!occ.has(a.to)) occ.set(a.to, []);
      occ.get(a.to)!.push({ from: a.stops[a.stops.length - 1].arr, to: d.stops[0].dep });
    }
  }
  return occ;
}

/** departure times per station and direction, for headway checks while trips are added */
class DepIndex {
  private m = new Map<string, number[]>();
  constructor(trips: Iterable<Trip>) { for (const t of trips) this.add(t); }
  add(t: Trip) {
    if (t.cancelled) return;
    for (const p of t.stops) {
      const k = `${p.st}${t.dir}`;
      let a = this.m.get(k);
      if (!a) { a = []; this.m.set(k, a); }
      let i = a.length;
      while (i > 0 && a[i - 1] > p.dep) i--;
      a.splice(i, 0, p.dep);
    }
  }
  /** no other train departs / passes within the minimum headway at any stop */
  clear(stops: PlanStop[], dir: TrackDir, h = MIN_HEADWAY): boolean {
    for (const p of stops) {
      const a = this.m.get(`${p.st}${dir}`);
      if (!a) continue;
      let lo = 0, hi = a.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] <= p.dep - h) lo = mid + 1; else hi = mid; }
      if (lo < a.length && a[lo] < p.dep + h) return false;
    }
    return true;
  }
}

/**
 * Feasibility check of a plan (运行图校验): block continuity and turn times,
 * terminal occupancy, station headways, stop-time order and fleet size.
 * Errors make the plan infeasible for the signalling model; warnings are
 * tight but workable.
 */
export function validatePlan(ctx: PlanContext, plan: Plan): PlanIssue[] {
  const { topo } = ctx;
  const out: PlanIssue[] = [];
  const name = (st: number) => STATIONS[st].name;
  const live = plan.trips.filter((t) => !t.cancelled);
  for (const t of live) {
    if (t.block < 0 && t.revenue) out.push({ severity: 'error', code: 'UNASSIGNED', t: t.stops[0].dep, text: `车次 ${t.no} 未分配车底` });
    for (let i = 0; i < t.stops.length; i++) {
      const s = t.stops[i];
      const prev = t.stops[i - 1];
      if (s.dep < s.arr || (prev && s.arr < prev.dep)) { out.push({ severity: 'error', code: 'TIME_ORDER', t: s.arr, text: `车次 ${t.no} 在 ${name(s.st)} 时刻倒序` }); break; }
    }
  }
  // blocks: continuity, turn time, terminal occupancy
  const occ = terminalOccupancy(plan);
  for (const b of plan.blocks) {
    const ts = b.trips.map((i) => plan.trips[i]).filter((t) => !t.cancelled);
    for (let i = 0; i + 1 < ts.length; i++) {
      const a = ts[i];
      const d = ts[i + 1];
      const arr = a.stops[a.stops.length - 1].arr;
      const dep = d.stops[0].dep;
      if (a.to !== d.from) { out.push({ severity: 'error', code: 'BLOCK_BREAK', t: arr, text: `车底 ${b.svc}：${a.no} 终到 ${name(a.to)}，下一车次 ${d.no} 从 ${name(d.from)} 出发` }); continue; }
      if (dep - arr < MIN_TURN_ABS) out.push({ severity: 'error', code: 'TURN_SHORT', t: arr, text: `车底 ${b.svc} 在 ${name(a.to)} 折返仅 ${Math.round(dep - arr)} s（${a.no}→${d.no}，最小 ${MIN_TURN_ABS} s）` });
    }
  }
  for (const [st, list] of occ) {
    const cap = TERMINAL_CAP[st] ?? (topo.stations[st].turnbackBerths.length || 1);
    const evs = list.flatMap((o) => [[o.from, 1], [o.to, -1]] as [number, number][]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    let cur = 0;
    let reported = -Infinity;
    for (const [t, dlt] of evs) {
      cur += dlt;
      if (cur > cap && t - reported > 1800) {
        reported = t;
        out.push({ severity: 'error', code: 'TERMINAL_FULL', t, text: `${name(st)} 同时折返/待发 ${cur} 列，超过能力 ${cap} 列` });
      }
    }
  }
  // station headways per direction (passing / departing)
  for (const dir of ['DN', 'UP'] as TrackDir[]) {
    const byStation = new Map<number, { t: number; no: string }[]>();
    for (const t of live) {
      if (t.dir !== dir) continue;
      for (const s of t.stops) {
        if (!byStation.has(s.st)) byStation.set(s.st, []);
        byStation.get(s.st)!.push({ t: s.dep, no: t.no });
      }
    }
    for (const [st, list] of byStation) {
      list.sort((a, b) => a.t - b.t);
      let reported = -Infinity;
      for (let i = 1; i < list.length; i++) {
        const h = list[i].t - list[i - 1].t;
        if (h < MIN_HEADWAY && list[i].t - reported > 1800) {
          reported = list[i].t;
          out.push({ severity: h < MIN_HEADWAY - 30 ? 'error' : 'warn', code: 'HEADWAY', t: list[i].t, text: `${name(st)} ${dir === 'DN' ? '下行' : '上行'} ${list[i - 1].no}/${list[i].no} 间隔 ${Math.round(h)} s（最小 ${MIN_HEADWAY} s）` });
        }
      }
    }
  }
  if (plan.fleetPeak > LINE_INFO.fleet) out.push({ severity: 'error', code: 'FLEET', t: 0, text: `用车 ${plan.fleetPeak} 列，超过配属 ${LINE_INFO.fleet} 列` });
  return out.sort((a, b) => a.t - b.t);
}
