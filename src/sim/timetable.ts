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
import { cancelTrip, type Block, type DayType, type Plan, type PlanStop, type StopTask, type Task, type Trip, type TripKind, type TrackDir } from './model';
import { plannedDwell } from './calibration';
import { STATIONS, OPERATIONS, LINE_INFO, FIXED_LATE_TRAINS, type FixedRun } from '../data/line2';
import { FIRST_LAST } from '../data/firstlast';

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
    id: 'weekdayPM', name: '工作日晚高峰', desc: '大小交路交替：大—大—小，淞虹路—广兰路 3\'00"，外段 4\'30"',
    pattern: ['big', 'big', 'small'], headway: 180, dwellFactor: 1.1,
  },
  weekdayOff: {
    id: 'weekdayOff', name: '工作日平峰', desc: '单一大交路 5\'00"', pattern: ['big'], headway: 300, dwellFactor: 1.0,
  },
  weekdayEvening: {
    id: 'weekdayEvening', name: '工作日夜间平峰', desc: '单一大交路 7\'00"', pattern: ['big'], headway: 420, dwellFactor: 0.95,
  },
  weekdayPMTail: {
    id: 'weekdayPMTail', name: '晚高峰延续', desc: '2:1 延至约20:55，间隔由2\'45"逐步增至4\'00"【假设：分段线性插值】',
    pattern: ['big', 'big', 'small'], headway: 165, dwellFactor: 0.95,
  },
  weekdayNight: {
    id: 'weekdayNight', name: '晚间大交路', desc: '21:00附近原小交路时隙改开机场车，3\'00"向末班8\'00"插值【假设】',
    pattern: ['big'], headway: 180, dwellFactor: 0.95,
  },
  weekend: {
    id: 'weekend', name: '双休日/节假日', desc: '全天单一大交路，日间 4\'30"', pattern: ['big'], headway: 270, dwellFactor: 1.05,
  },
  firstLast: {
    id: 'firstLast', name: '首末班及收车', desc: '首班 05:25 起 7\'00"；21:57 后蟠祥路—广兰路 8\'00"，末班后回段/存车',
    pattern: ['big'], headway: 420, dwellFactor: 0.95,
  },
};

export interface Period { from: number; to: number; template: string; headway?: number; headwayTo?: number; label: string }

const H = (h: number, m = 0) => h * 3600 + m * 60;

export function dayPeriods(dayType: DayType): Period[] {
  if (dayType === 'weekday') {
    return [
      { from: H(4), to: H(6, 5), template: 'firstLast', label: '首班/早间' },
      { from: H(6, 5), to: H(6, 50), template: 'weekdayOff', headway: 300, label: '早高峰前过渡' },
      { from: H(6, 50), to: H(9, 30), template: 'weekdayAM', label: '早高峰' },
      { from: H(9, 30), to: H(16, 50), template: 'weekdayOff', label: '平峰' },
      { from: H(16, 50), to: H(19, 30), template: 'weekdayPM', label: '晚高峰' },
      // D72: 19:44 observed ~165 s, 20:43 observed ~240 s. The
      // interpolation between observations is 【假设】, with a 12-min 2:1
      // cycle by 20:45. This band does not pre-position a second peak wave.
      { from: H(19, 30), to: H(19, 45), template: 'weekdayPMTail', label: '晚高峰延续' },
      { from: H(19, 45), to: H(20, 45), template: 'weekdayPMTail', headway: 165, headwayTo: 240, label: '晚高峰间隔渐长' },
      { from: H(20, 45), to: H(20, 55), template: 'weekdayPMTail', headway: 240, label: '小交路收车前' },
      { from: H(20, 55), to: H(21), template: 'weekdayNight', headway: 240, headwayTo: 180, label: '机场车接替时隙【假设】' },
      { from: H(21), to: H(21, 40), template: 'weekdayNight', headway: 180, headwayTo: 480, label: '晚间间隔插值【假设】' },
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

/** Margin of the outer (west of 淞虹路) alternation window inside a peak band:
 * the outer end leads (DN) or lags (UP) the core by its ~11 min running time,
 * plus the transition into the pattern. */
export const OUTER_BAND_MARGIN = 1200;
/** whether a time at an outer station falls in a peak's 2'30"/5'00" pattern */
export function inOuterAlternation(periods: Period[], t: number): boolean {
  return periods.some(p => (p.template === 'weekdayAM' || p.template === 'weekdayPM') && t >= p.from + OUTER_BAND_MARGIN && t < p.to - OUTER_BAND_MARGIN);
}

// ---------------------------------------------------------------- overlays (加开)

export interface OverlayPreset { id: string; label: string; from: number; to: number; a: number; b: number; headway: number; desc: string }

export const OVERLAY_PRESETS: OverlayPreset[] = [
  { id: 'ciie', label: '进博会保障加开', from: H(9, 30), to: H(17, 30), a: 1, b: 22, headway: 900, desc: '国家会展中心 ↔ 广兰路 区间加开，平峰每15分钟一列（各方向）' },
  { id: 'hongqiao', label: '虹桥枢纽大客流加开', from: H(20), to: H(22, 30), a: 2, b: 22, headway: 720, desc: '虹桥火车站 ↔ 广兰路 区间加开，夜间每12分钟一列（虹桥火车站无折返条件，加开车延至国家会展中心折返）' },
];

// ---------------------------------------------------------------- helpers

/** fixedRuns: the fixed-time special trains of the day (default: the regular ones) */
export interface PlanContext { topo: Topology; rt: RunTimes; dayType: DayType; fixedRuns?: FixedRun[] }

const TERMINAL_DEPOT: Record<number, string> = { 0: 'BZL', 30: 'CSD', 4: 'BZL', 22: 'LYD', 1: 'BZL', 2: 'BZL', 19: 'LYD', 28: 'CSD' };
/** trains a terminal can hold at once: two tail tracks or paired stubs + the
 * departure platform; 广兰路 turns on its single middle-track platform */
const TERMINAL_CAP: Record<number, number> = { 0: 3, 30: 3, 4: 3, 22: 1, 1: 3, 2: 2 };
/**
 * trains the circulation lets lay over at a terminal at once. At the line ends
 * this is the full terminal: the peak cycle there leaves a turn just short of
 * the 240 s minimum, so each train waits for the next slot but one, and with
 * only two places that third train would be sent to the depot and replaced by
 * a fresh one every cycle, breaking the west-end 2'30"/5'00" pattern. An
 * insertion into a full terminal is caught by the validator (D7).
 */
const MAX_PRESENT: Record<number, number> = { 0: 3, 30: 3, 4: 2, 22: 1, 1: 3, 2: 2 };
/** longest a train may wait at a terminal between trips (s) */
const MAX_LAYOVER = 1500;
/**
 * Hot standby (热备车, D70): off-peak each line end keeps one train of its
 * turning cycle aside, crewed, in one of its two turnback tracks; the other
 * trains turn through the other track. From `from` the first train the line
 * end has to spare (a third one laying over there) stays; with none to spare
 * by an hour later the next arrival stays anyway and a train comes out of the
 * yard for the departure it would have taken. From `need` it takes the first
 * departure the line end has no train for (the peak build-up: both tracks
 * turn again); at `to` it rejoins the cycle, or goes back to the yard.
 */
interface StandbyWindow { from: number; need: number; to: number }
function standbyWindows(dayType: DayType): StandbyWindow[] {
  return dayType === 'weekday'
    ? [{ from: H(9, 30), need: H(15), to: H(19, 30) }, { from: H(20, 55), need: H(21, 40), to: H(21, 40) }]
    : [{ from: H(9), need: H(21), to: H(21) }];
}
/** longest an added train running on in its own direction may stand at an
 *  intermediate station's through platform before its next trip (s): any
 *  longer and the following train queues behind it */
const THROUGH_WAIT = 60;
/** spacing of a depot move from the neighbouring departures where it joins / leaves the line (s) */
const SLOT_GAP = 120;

export function depotIndex(topo: Topology, key: string): number {
  return topo.depots.findIndex((d) => d.key === key);
}

/** first station of a move out of `depot` heading `dir` (its first trip starts
 * there); the move may reach it against the direction and change ends there */
export function exitStation(topo: Topology, depot: number, dir: TrackDir): number {
  return topo.depots[depot].portals.exit[dir].station;
}
/** last station before `depot` for a train running `dir` */
export function entryStation(topo: Topology, depot: number, dir: TrackDir): number {
  return topo.depots[depot].portals.entry[dir].station;
}
/** extra time a depot move spends changing ends at its junction station (s) */
const PORTAL_REVERSE = 90;

export function minTurn(st: number): number {
  const id = STATIONS[st].id;
  return OPERATIONS.minTurnback[id] ?? 330;
}

export function dwellOf(st: number, factor: number): number {
  return Math.min(30, Math.max(20, STATIONS[st].dwell * Math.min(1, factor)));
}

/** stations visited from a to b inclusive */
function seq(a: number, b: number): number[] {
  const out: number[] = [];
  if (a <= b) for (let i = a; i <= b; i++) out.push(i);
  else for (let i = a; i >= b; i--) out.push(i);
  return out;
}

/** dwellFactor: a constant, or the factor in force at a time (dwell follows the period at each stop, so successive trains never close up across a period change) */
export function buildStops(ctx: PlanContext, dir: TrackDir, from: number, to: number, originDep: number, revenue: boolean, _dwellFactor: number | ((t: number) => number), stopsAt?: (st: number) => boolean): PlanStop[] {
  const sts = seq(from, to);
  const stops: PlanStop[] = [];
  let t = originDep;
  // pass times already include the platform pass limit (any train, 跨站 or empty)
  const pass = dir === 'DN' ? ctx.rt.passDn : ctx.rt.passUp;
  for (let k = 0; k < sts.length; k++) {
    const st = sts[k];
    if (k === 0) { stops.push({ st, arr: t, dep: t, stop: true }); continue; }
    const prev = sts[k - 1];
    const idx = Math.min(prev, st);
    const prevStops = stops[k - 1].stop;
    const isLast = k === sts.length - 1;
    const stopHere = isLast || (stopsAt ? stopsAt(st) : revenue);
    let run: number;
    if (prevStops && stopHere) run = dir === 'DN' ? ctx.rt.dn[idx] : ctx.rt.up[idx];
    else run = pass[idx] + (prevStops ? 10 : 0) + (stopHere ? 12 : 0);
    const arr = t + run;
    const dw = stopHere && !isLast ? plannedDwell(ctx.dayType, st, dir, arr) : 0;
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

/** Added service may keep a train of the base plan in service instead of
 * bringing another out of the depot (延长运用, D47). `canExtend` says whether
 * the train of a block is still able to take more trips after `last`. */
export interface OverlayReuse {
  blocks: Block[];
  canExtend: (block: number, last: number) => boolean;
  now: number;
  /** filled in: blocks of the base plan that now continue into added trips */
  extended: { block: number; last: number; trips: number[]; tail: number[]; end: Block['end'] }[];
  /** filled in: base duties taken over by an added train (`into`, the added
   * block): `trips` moved over, `lead` its cancelled yard exit */
  absorbed?: { block: number; into: number; trips: number[]; lead: number[]; end: Block['end'] }[];
}

/** trains each yard must hold at the start of the day: its largest deficit of exits over returns */
export function yardNeed(topo: Topology, plan: Plan): number[] {
  const ev: { t: number; d: number; v: number }[] = [];
  for (const b of plan.blocks) {
    if (!b.trips.some((id) => !plan.trips[id].cancelled)) continue;
    if (b.start.kind === 'depot') ev.push({ t: b.start.time, d: b.start.depot, v: -1 });
    if (b.end.kind === 'depot') {
      const last = plan.trips[b.trips[b.trips.length - 1]];
      ev.push({ t: last.stops[last.stops.length - 1].arr + 300, d: b.end.depot, v: 1 });
    }
  }
  ev.sort((a, b) => a.t - b.t);
  const bal = topo.depots.map(() => 0), need = topo.depots.map(() => 0);
  for (const e of ev) { bal[e.d] += e.v; need[e.d] = Math.max(need[e.d], -bal[e.d]); }
  return need;
}

/** `shift`: per yard, how many of its earliest morning exits another yard
 *  takes (a second pass when the first one needed more than a yard holds) */
export function generatePlan(ctx: PlanContext, shift?: number[], stock?: number[]): Plan {
  const { topo } = ctx;
  const periods = dayPeriods(ctx.dayType);
  const trips: GenTrip[] = [];
  const nS = topo.stations.length;
  const W = 0;
  const E = nS - 1;
  const SHR = 4;
  const GLL = 22;
  let upPhase = 10; // UP peak phase, aligned to the first airport train below.
  /** the published first trains from their origins: they open each station */
  const firstService: GenTrip[] = [];

  const addTrip = (dir: TrackDir, kind: TripKind, from: number, to: number, stops: PlanStop[], revenue: boolean, overlay?: string): GenTrip => {
    const tr: GenTrip = { id: trips.length, no: '', dir, kind, from, to, stops, revenue, block: -1, overlay };
    trips.push(tr);
    return tr;
  };

  const factorAt = (t: number) => TEMPLATES[periodAt(periods, t).template].dwellFactor;
  // A peak is a whole-core promise, not an origin departure change. Allow
  // the complete core traversal plus one headway for its leading wave.
  const peaks = periods.filter(p => p.template === 'weekdayAM' || p.template === 'weekdayPM');
  const peakHw = (p: Period) => TEMPLATES[p.template].headway;
  const coreLead = new Map(peaks.map(p => {
    const hw = peakHw(p);
    const lead = Math.max(...(['DN', 'UP'] as const).map(dir => {
      const from = dir === 'DN' ? SHR : GLL, to = dir === 'DN' ? GLL : SHR;
      const stops = buildStops(ctx, dir, from, to, p.from, true, factorAt);
      return stops.at(-1)!.arr - p.from + hw + 30;
    }));
    return [p, Math.ceil(lead / hw) * hw] as const;
  }));
  if (peaks.length) {
    const first = buildStops(ctx, 'UP', E, W, OPERATIONS.firstEastTerminusDep, true, factorAt).find(s => s.st === GLL)!.dep;
    const anchor = peaks[0].from - coreLead.get(peaks[0])!;
    const hw = peakHw(peaks[0]);
    // Keep the official 06:00 origin on the AM core grid, instead of adding
    // an off-grid first train which disrupts the western 1:2 alternation.
    upPhase = ((first - anchor) % hw + hw) % hw;
  }
  /** the steady peak stream from its leading wave, after a 20 min run-in from the headway before */
  const streamAt = (t: number): Period & { steady?: boolean } => {
    for (const peak of peaks) {
      const hw = peakHw(peak);
      const start = peak.from - coreLead.get(peak)!, transition = start - 1200;
      if (t >= start && t < peak.to) return { ...peak, from: start, headway: hw, steady: true };
      if (t >= transition && t < start) {
        const before = periodAt(periods, transition);
        const prev = Math.max(hw, before.headway ?? TEMPLATES[before.template].headway);
        return { ...peak, from: transition, to: start, headway: hw + (prev - hw) * (start - t) / 1200, label: `${peak.label}渐进预置` };
      }
    }
    return periodAt(periods, t);
  };
  const headwayAt = (t: number) => {
    const p = streamAt(t);
    const start = p.headway ?? TEMPLATES[p.template].headway;
    return p.headwayTo === undefined ? start : start + (p.headwayTo - start) * Math.max(0, Math.min(1, (t - p.from) / (p.to - p.from)));
  };

  // Solve the origin departure so every big/small train uses the same core
  // slot, with the demand at its actual stop times. Intermediate holds are
  // never used to achieve phasing.
  const atReference = (dir: TrackDir, from: number, to: number, ref: number, departure: number) => {
    let origin = departure;
    let stops = buildStops(ctx, dir, from, to, origin, true, factorAt);
    for (let i = 0; i < 8; i++) {
      const error = stops.find(x => x.st === ref)!.dep - departure;
      if (Math.abs(error) < .001) break;
      origin -= error;
      stops = buildStops(ctx, dir, from, to, origin, true, factorAt);
    }
    return stops;
  };
  const firstReference = (dir: TrackDir, from: number, to: number, ref: number, first: number) =>
    buildStops(ctx, dir, from, to, first, true, factorAt).find(x => x.st === ref)!.dep;
  const nextSlot = (t: number, dir: TrackDir) => {
    const p = streamAt(t);
    const candidate = t + headwayAt(p.steady ? t : t + headwayAt(t) / 2);
    // Join the leading peak wave without a short insertion or a long gap.
    const join = peaks.map(p => ({ b: p.from - coreLead.get(p)! + (dir === 'UP' ? (p.template === 'weekdayPM' ? 0 : upPhase) : 0), hw: peakHw(p) })).find(x => x.b > t && x.b <= candidate);
    if (join) return join.b - t >= 90 ? join.b : join.b + join.hw;
    return candidate;
  };

  // ---- DN stream (reference: 淞虹路 departure)
  {
    let idx = 0;
    let lastPeriod = '';
    let t = firstReference('DN', W, E, SHR, OPERATIONS.firstWestTerminusDep);
    for (let guard = 0; guard < 2000; guard++) {
      const p = streamAt(t);
      const tpl = TEMPLATES[p.template];
      if (p.label !== lastPeriod) { if (p.template !== 'weekdayPMTail') idx = p.template === 'weekdayAM' ? 2 : 0; lastPeriod = p.label; }
      if (p.steady) idx = Math.round((t - p.from) / peakHw(p)) + (p.template === 'weekdayAM' ? 2 : 0);
      let kind = tpl.pattern[idx % tpl.pattern.length] as 'big' | 'small' | 'late';
      if (kind === 'big' || kind === 'late') {
        const originDep = atReference('DN', W, E, SHR, t)[0].dep;
        if (originDep > OPERATIONS.lastBigEastboundDep) kind = 'late';
        if (originDep > OPERATIONS.lastLateEastboundDep + 1) break;
        const to = kind === 'big' ? E : GLL;
        const stops = atReference('DN', W, to, SHR, t);
        addTrip('DN', kind, W, to, stops, true);
      } else {
        const stops = buildStops(ctx, 'DN', SHR, GLL, t, true, factorAt);
        // End the eastbound short route at its far end, rather than letting
        // another whole-core journey start at 20:55 (D72).
        if (ctx.dayType === 'weekday' && stops.at(-1)!.arr >= H(20, 55)) {
          // The train of the former short-route slot continues east from
          // SHR to the airport; adding a new PXL origin would require an
          // unrelated extra train at the west end during the withdrawal.
          addTrip('DN', 'big', SHR, E, buildStops(ctx, 'DN', SHR, E, t, true, factorAt), true);
        } else addTrip('DN', 'small', SHR, GLL, stops, true);
      }
      idx++;
      t = nextSlot(t, 'DN');
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
    const firstThrough = firstReference('UP', E, W, GLL, OPERATIONS.firstEastTerminusDep);
    // Explicit origin first trains below supply the early western section;
    // the airport stream starts with the published 06:00 departure.
    firstService.push(addTrip('UP', 'big', E, W, buildStops(ctx, 'UP', E, W, OPERATIONS.firstEastTerminusDep, true, factorAt), true));
    let t = (peaks.length ? Math.min(firstThrough, peaks[0].from - coreLead.get(peaks[0])! - 1200) : firstThrough) + (ctx.dayType === 'weekday' ? upPhase : 0);
    for (let guard = 0; guard < 2000; guard++) {
      const p = streamAt(t);
      const tpl = TEMPLATES[p.template];
      if (p.label !== lastPeriod) { if (p.template !== 'weekdayPMTail') idx = 0; lastPeriod = p.label; }
      if (p.steady) idx = Math.round((t - p.from - (p.template === 'weekdayAM' ? upPhase : 0)) / peakHw(p));
      let kind = tpl.pattern[idx % tpl.pattern.length] as 'big' | 'small' | 'late';
      if (kind === 'big' && atReference('UP', E, W, GLL, t)[0].dep < OPERATIONS.firstEastTerminusDep - .01) kind = 'small';
      // The explicit 06:00 airport train occupies its full path. During
      // morning build-up do not insert another departure within 90 seconds.
      if (Math.abs(t - firstThrough) < 120) { idx++; t = nextSlot(t, 'UP'); continue; }
      if (kind === 'big') {
        const originDep = atReference('UP', E, W, GLL, t)[0].dep;
        if (originDep > lastBigWestDep) kind = 'late';
        else addTrip('UP', 'big', E, W, atReference('UP', E, W, GLL, t), true);
      }
      if (kind === 'late') {
        if (t > OPERATIONS.lastLateWestboundDep + 1) break;
        addTrip('UP', 'late', GLL, W, buildStops(ctx, 'UP', GLL, W, t, true, factorAt), true);
      }
      if (kind === 'small') {
        // Before the airport's first through train reaches GLL, western
        // first-service trains run to PXL. This supplies west-end turns
        // without queueing dozens of early depot feeders at PXL.
        const opening = t < firstThrough;
        addTrip('UP', opening ? 'ins' : 'small', GLL, opening ? W : SHR, buildStops(ctx, 'UP', GLL, opening ? W : SHR, t, true, factorAt), true);
      }
      idx++;
      t = nextSlot(t, 'UP');
    }
  }

  // Official origin first trains, shared by both day types. Intermediate
  // station timing is calibrated separately; no run or dwell time is changed.
  // (淞虹路 05:58 westbound and 远东大道 06:24 eastbound are not origins: they
  // are the 龙阳路 and 广兰路 first trains passing.)
  const firstLYL = Math.max(H(5, 20), H(5, 24) - buildStops(ctx, 'UP', 19, W, H(5, 20), true, factorAt).find(s => s.st === 17)!.dep + H(5, 20));
  for (const [dir, from, to, dep] of [
    ['UP', 19, W, firstLYL], ['UP', GLL, W, H(5, 28)],
    ['DN', GLL, E, H(6)],
  ] as const) firstService.push(addTrip(dir, 'ins', from, to, buildStops(ctx, dir, from, to, dep, true, factorAt), true));

  if (ctx.dayType === 'weekday') {
    // The last two short-route duties finish carrying passengers: the final
    // westbound one goes to 蟠祥路 and the eastbound one to 龙阳路 depot.
    const closingSlot = trips.filter(t => t.dir === 'UP' && (t.stops.find(s => s.st === GLL)?.dep ?? -Infinity) >= H(20, 52)
      && t.stops.find(s => s.st === GLL)!.dep < H(20, 55)).at(-1);
    if (closingSlot) {
      const dep = closingSlot.stops.find(s => s.st === GLL)!.dep;
      closingSlot.kind = 'wd'; closingSlot.from = GLL; closingSlot.to = W;
      closingSlot.stops = buildStops(ctx, 'UP', GLL, W, dep, true, factorAt);
    }
    // The preceding short-route trains finish their trips and return at SHR;
    // classify these as withdrawals once they overlap the closing window.
    for (const t of trips) if (t.dir === 'UP' && t.kind === 'small' && t.stops.at(-1)!.arr > H(20, 55)) t.kind = 'wd';
    const dn = trips.filter(t => t.dir === 'DN' && t.from === SHR && t.kind === 'big'
      && t.stops.find(s => s.st === 19)!.arr >= H(20, 50)
      && t.stops.find(s => s.st === 19)!.arr <= H(21)).at(0);
    if (dn) { dn.kind = 'wd'; dn.from = SHR; dn.to = 19; dn.stops = buildStops(ctx, 'DN', SHR, 19, dn.stops.find(s => s.st === SHR)!.dep, true, factorAt); }
  }

  // 广兰路 turns trains on its one middle-track platform (配线图 PDF). A DN
  // arrival that would turn into an UP departure a slot or two later, but
  // whose platform the following arrival needs first, runs on to the eastern
  // terminal instead (延伸运行), where the tails have room.
  {
    const mt = minTurn(GLL);
    // the departing train is out of the west throat and the next arrival's
    // route into the middle track set within this time
    const GLL_CLEAR = 60;
    const arrAt = (t: GenTrip) => t.stops[t.stops.length - 1].arr;
    const arrivals = trips.filter((t) => t.dir === 'DN' && t.to === GLL && t.kind === 'small').sort((a, b) => arrAt(a) - arrAt(b));
    const deps = trips.filter((t) => t.dir === 'UP' && t.from === GLL).map((t) => t.stops[0].dep).sort((a, b) => a - b);
    for (let i = 0; i + 1 < arrivals.length; i++) {
      const A = arrivals[i];
      const d = deps.find((x) => x >= arrAt(A) + mt - 1e-6);
      // (no departure within a slot or two: the train is withdrawn to the depot as before)
      if (d !== undefined && d - arrAt(A) <= mt + 450 && d + GLL_CLEAR <= arrAt(arrivals[i + 1])) continue;
      // During morning opening, a short-route train with no middle-track
      // turn runs to CSD's entry at YDD rather than filling the airport tails.
      // This is a passenger-carrying withdrawal, not an extra airport origin.
      A.to = arrAt(A) < H(9, 30) ? 28 : E;
      if (A.to === 28) A.kind = 'wd';
      A.stops = buildStops(ctx, 'DN', A.from, A.to, A.stops[0].dep, true, factorAt);
    }
  }

  const blocks = circulate(ctx, trips, [W, E, SHR, GLL, 19, 28], periods, undefined, undefined, 0, undefined, undefined, shift, stock);
  addFixedRuns(ctx, trips, blocks, ctx.fixedRuns ?? FIXED_LATE_TRAINS);
  stableGuanglan(ctx, trips, blocks);
  // Trains before a station opens cannot board there (positioning and depot
  // trips). A station opens when the first of the published first trains
  // passes it in the plan, not at the published clock time: those times are
  // whole minutes, and while run times are short of the real ones the first
  // train itself reaches the middle of the line early (D72). The clock time
  // is only the fallback where no first train passes.
  const firstDN = trips.filter(t => t.dir === 'DN' && t.from === W && t.revenue && !t.cancelled)
    .sort((a, b) => a.stops[0].dep - b.stops[0].dep)[0];
  const openers = [...firstService, ...(firstDN ? [firstDN] : [])].filter(t => !t.cancelled);
  const opening = (st: number, dir: TrackDir): number => {
    const own = openers.filter(t => t.dir === dir).flatMap(t => t.stops.filter(s => s.st === st && s.stop && s.st !== t.to).map(s => s.dep));
    if (own.length) return Math.min(...own);
    const row = FIRST_LAST.find(r => r.station === STATIONS[st].name);
    const clock = row && (dir === 'DN' ? row.firstE : row.firstW);
    if (!clock) return -Infinity;
    const [h, m] = clock.split(':').map(Number);
    return H(h, m);
  };
  for (const trip of trips) if (trip.revenue && !trip.cancelled) {
    for (const stop of trip.stops) if (stop.dep < opening(stop.st, trip.dir) - .001) stop.noBoard = true;
    if (!trip.stops.some(s => s.st !== trip.to && s.stop && !s.noBoard)) trip.revenue = false;
  }
  const plan: Plan = {
    dayType: ctx.dayType, trips, blocks,
    periods: periods.map((p) => ({ from: p.from, to: p.to, template: p.template, label: p.label })),
    overlays: [], fleetPeak: 0,
  };
  numberPlan(plan);
  plan.fleetPeak = fleetPeak(plan);
  if (!shift) {
    const need = yardNeed(topo, plan);
    const over = need.map((n, d) => Math.max(0, n - topo.depots[d].capacity));
    if (over.some((n) => n > 0)) return generatePlan(ctx, over, need);
  }
  return plan;
}

/** D72: after ALL services and depot moves have been fitted, the last two
 * empty west-end returns run to GLL instead of BZL. Place the middle-track
 * train first, then the DN-platform train; neither blocks an eastbound move.
 * 【假设】 evening allocation is not public. No infrastructure is extended. */
function stableGuanglan(ctx: PlanContext, trips: GenTrip[], blocks: Block[]) {
  const { topo } = ctx;
  const GLL = 22;
  const candidates = blocks.filter(b => {
    const last = trips[b.trips.at(-1)!];
    return b.end.kind === 'depot' && last.from === 0 && last.dir === 'DN' && !last.revenue && !last.cancelled;
  }).sort((a, b) => trips[b.trips.at(-1)!].stops[0].dep - trips[a.trips.at(-1)!].stops[0].dep).slice(0, OPERATIONS.lineStabling.GLL);
  // Short of candidates (another day plan or scenario): fewer trains stay at
  // 广兰路 overnight; validatePlan reports the imbalance.
  const middle = topo.stations[GLL].turnbackBerths[0];
  for (const [rank, block] of candidates.entries()) {
    const last = trips[block.trips.at(-1)!];
    const others = trips.filter(t => !t.cancelled && t !== last);
    // Stay behind every eastbound movement at EVERY common station, including
    // empty sends to CSD/PDA and fixed trains with different stopping patterns.
    const probe = buildStops(ctx, 'DN', 0, GLL, 0, false, 1);
    let departure = last.stops[0].dep;
    for (const other of others) if (other.dir === 'DN') for (const stop of other.stops) {
      const own = probe.find(s => s.st === stop.st);
      if (own) departure = Math.max(departure, stop.dep - own.dep + 120);
    }
    // The middle berth must also be free of the last small/late turn.
    const lastUp = Math.max(...others.filter(t => t.dir === 'UP' && t.from === GLL).map(t => t.stops[0].dep));
    departure = Math.max(departure, lastUp + 120 - probe.at(-1)!.arr);
    const index = new DepIndex(others);
    let stops = buildStops(ctx, 'DN', 0, GLL, departure, false, 1);
    for (let k = 0; k < 240 && !index.clear(stops, 'DN'); k++) stops = buildStops(ctx, 'DN', 0, GLL, departure += 10, false, 1);
    // no path that night: it goes back to its yard as planned
    if (!index.clear(stops, 'DN') || stops.at(-1)!.arr >= H(28)) continue;
    Object.assign(last, { kind: 'empty', to: GLL, stops });
    block.end = { kind: 'stable', station: GLL, berth: rank === 0 ? middle : platformBerth(topo, GLL, 'DN') };
  }
}

/**
 * Fixed-time special trains (定点班车, FixedRun): by default the regular
 * 虹桥火车站 → 龙阳路 trains after the last train; a scenario can give its own.
 *
 * The train is one already going empty past the origin in the run's
 * direction shortly before the departure (the 蟠祥路 → 北翟路 returns): it
 * stops there and waits in the platform, or one that has just arrived at a
 * terminal origin and would otherwise go empty into the depot (浦东机场 →
 * 川沙). It runs the service — boarding at the first stations, set-down only
 * at the listed ones, passing the rest at the platform pass limit — and goes
 * on empty into `depotTo`. Without such a train one comes out of
 * `depotFrom` and turns at the origin.
 */
function addFixedRuns(ctx: PlanContext, trips: GenTrip[], blocks: Block[], runs: FixedRun[]) {
  const { topo } = ctx;
  const idx = (id: string) => STATIONS.findIndex((x) => x.id === id);
  for (const F of runs) {
    const from = idx(F.from), to = idx(F.to);
    const dir: TrackDir = from < to ? 'DN' : 'UP';
    const back: TrackDir = dir === 'DN' ? 'UP' : 'DN';
    const fwd = (a: number, b: number) => (dir === 'DN' ? a < b : a > b);
    const board = new Set(F.board.map(idx)), alight = new Set(F.alight.map(idx));
    const depot = depotIndex(topo, F.depotFrom), home = depotIndex(topo, F.depotTo);
    const entry = entryStation(topo, home, dir);
    for (const dep of F.departures) {
      const run = buildStops(ctx, dir, from, to, dep, true, 1, (st) => board.has(st) || alight.has(st));
      for (const st of run) if (alight.has(st.st)) st.noBoard = true;
      const r0 = { dir, revenue: true, cancelled: false } as GenTrip;
      const others = (ex: GenTrip[]) => new DepIndex(trips.filter((t) => !t.cancelled && !ex.includes(t)));
      type Pick = { b: Block; last: GenTrip; stops?: PlanStop[]; arr: number; moved: { t: GenTrip; stops: PlanStop[] }[] };
      let best: Pick | undefined;
      for (const b of blocks) {
        const last = trips[b.trips.at(-1)!];
        if (b.end.kind !== 'depot' || last.revenue || last.cancelled || last.dir !== dir) continue;
        if (last.from === from) {
          // just arrived at the terminal origin: turns there into the run
          const prev = b.trips.length > 1 ? trips[b.trips.at(-2)!] : undefined;
          const arr = prev ? prev.stops.at(-1)!.arr : -Infinity;
          if (!prev || prev.to !== from || arr > dep - minTurn(from) || arr < dep - MAX_LAYOVER) continue;
          if (!best || arr > best.arr) best = { b, last, arr, moved: [] };
          continue;
        }
        if (!fwd(last.from, from) || !fwd(from, last.to)) continue;
        // going empty past the origin: ends there and waits in the platform.
        // One due just too late leaves its terminal a little earlier when its
        // turnaround has the slack; one following too close behind the
        // waiting train (a single platform track) is put back a little.
        let stops = buildStops(ctx, dir, last.from, from, last.stops[0].dep, false, 1);
        const late = stops.at(-1)!.arr - (dep - 45);
        if (late > 0) {
          const prev = b.trips.length > 1 ? trips[b.trips.at(-2)!] : undefined;
          const start = last.stops[0].dep - late;
          if (late > 120 || !prev || start < prev.stops.at(-1)!.arr + minTurn(last.from)) continue;
          stops = buildStops(ctx, dir, last.from, from, start, false, 1);
          if (!others([last]).clear(stops, dir)) continue;
        }
        const arr = stops.at(-1)!.arr;
        if (arr < dep - 600 || (best && arr <= best.arr)) continue;
        const moved: { t: GenTrip; stops: PlanStop[] }[] = [];
        let ok = true;
        for (const t of trips) {
          if (t === last || t.cancelled || t.dir !== dir) continue;
          const at = t.stops.find((p) => p.st === from);
          if (!at || at.dep < arr - MIN_HEADWAY || at.dep > dep + 3 * MIN_HEADWAY) continue;
          const tb = blocks[t.block];
          if (t.revenue || !tb || tb.trips.at(-1) !== t.id) { ok = false; break; }
          const index = others([last, t, ...moved.map((m) => m.t)]);
          index.add({ ...last, stops } as Trip);
          index.add({ ...r0, stops: run } as Trip);
          for (const m of moved) index.add({ ...m.t, stops: m.stops } as Trip);
          let fit: PlanStop[] | null = null;
          for (let k = 1; k <= 60 && !fit; k++) {
            const st = buildStops(ctx, dir, t.from, t.to, t.stops[0].dep + k * 10, false, 1);
            if (st.find((p) => p.st === from)!.dep > dep && index.clear(st, dir)) fit = st;
          }
          if (!fit) { ok = false; break; }
          moved.push({ t, stops: fit });
        }
        if (ok) best = { b, last, stops, arr, moved };
      }
      let blk: Block;
      let r: GenTrip;
      if (best?.stops) {
        best.last.to = from;
        best.last.stops = best.stops;
        for (const m of best.moved) m.t.stops = m.stops;
        r = addTo(trips, dir, 'extra', from, to, run, true);
        best.b.trips.push(r.id);
        blk = best.b;
      } else if (best) {
        // the empty move into the depot becomes the run
        r = best.last;
        Object.assign(r, { kind: 'extra', to, stops: run, revenue: true });
        blk = best.b;
      } else {
        // out of the depot empty to the origin and turn there
        r = addTo(trips, dir, 'extra', from, to, run, true);
        const ex = exitStation(topo, depot, back);
        const index = new DepIndex(trips.filter((t) => !t.cancelled && t !== r));
        const latest = dep - minTurn(from) - 60 - buildStops(ctx, back, ex, from, 0, false, 1).at(-1)!.arr;
        let move: PlanStop[] | null = null;
        for (let k = 0; k <= 90 && !move; k++) {
          const st = buildStops(ctx, back, ex, from, latest - k * 10, false, 1);
          if (index.clear(st, back)) move = st;
        }
        const m = addTo(trips, back, 'ins', ex, from, move ?? buildStops(ctx, back, ex, from, latest, false, 1), false);
        blk = { id: blocks.length, svc: '', start: { kind: 'depot', depot, time: 0 }, end: { kind: 'depot', depot: home }, trips: [m.id, r.id] };
        m.block = blk.id;
        blk.start = { kind: 'depot', depot, time: depotStartTime(ctx, depot, m) };
        blocks.push(blk);
      }
      r.block = blk.id;
      blk.end = { kind: 'depot', depot: home };
      // running faster than a stopping train ahead: it keeps behind it, standing
      // longer at its last stop before (or running slower out of the origin)
      {
        const index = new DepIndex(trips.filter((t) => !t.cancelled && t !== r && !blk.trips.includes(t.id)));
        // A hold at an earlier stop also shifts sections already checked.
        // Re-check the entire path after each hold, including empty feeders.
        for (let n = 0; n < 360; n++) {
          const k = run.findIndex((stop, i) => i > 0 && !index.clear([stop], dir));
          if (k < 0) break;
          let s = k - 1;
          while (s > 0 && !run[s].stop) s--;
          if (s === 0) for (let j = 1; j < run.length; j++) { run[j].arr += 10; run[j].dep += 10; }
          else { run[s].dep += 10; for (let j = s + 1; j < run.length; j++) { run[j].arr += 10; run[j].dep += 10; } }
        }
      }
      // terminating short of the depot: on empty to its entry
      if (fwd(to, entry)) {
        const index = new DepIndex(trips.filter((t) => !t.cancelled && t !== r));
        const t0 = run.at(-1)!.arr + 60;
        let st = buildStops(ctx, dir, to, entry, t0, false, 1);
        for (let k = 1; k <= 60 && !index.clear(st, dir); k++) st = buildStops(ctx, dir, to, entry, t0 + k * 10, false, 1);
        const w = addTo(trips, dir, 'wd', to, entry, st, false);
        w.block = blk.id;
        blk.trips.push(w.id);
      }
    }
  }
}

/**
 * Link trips into blocks at the given terminals, adding depot insertions,
 * withdrawals and terminal stabling. Mutates `trips` (adds new trips) and
 * returns the new blocks.
 */
function circulate(ctx: PlanContext, trips: GenTrip[], terminals: number[], periods: Period[], overlay?: string, baseTrips?: Trip[], blockBase = 0, baseOcc?: Map<number, { from: number; to: number; block?: number }[]>, reuse?: OverlayReuse, shift?: number[], stock?: number[]): Block[] {
  const { topo } = ctx;
  const pool = trips.filter((t) => t.overlay === overlay && !t.cancelled);
  const allForGaps = () => [...(baseTrips ?? []), ...trips];
  const stablingNight: Record<number, number> = overlay ? {} : { 0: OPERATIONS.terminalStabling.PXL, [topo.stations.length - 1]: OPERATIONS.terminalStabling.PDA };
  // In the morning the trains in the turnback tracks take the first
  // departures (the tracks are needed for turning soon after); those in a
  // storage tail are placed later (relieveTerminals).
  const stabling: Record<number, number> = Object.fromEntries(Object.entries(stablingNight)
    .map(([st, n]) => [st, Math.min(n, topo.stations[+st].turnbackBerths.length)]));
  const W = 0;
  const sources: GenTrip[] = [];
  const sinks: GenTrip[] = [];
  /** a hot standby that goes back to the yard: when it leaves the line end */
  const standbyUntil = new Map<number, number>();

  /**
   * An added-service trip into a terminal the base plan already fills does not run: the
   * train goes back to the depot after the trip before (or the trip is simply not run).
   */
  const dropArrival = (X: GenTrip) => {
    cancelTrip(X, `加开：${STATIONS[X.to].name}终点站能力已满`);
    if (X.next !== undefined) { trips[X.next].prev = undefined; X.next = undefined; }
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
    // An added departure placed in the turnback window of an added arrival
    // (applyOverlay) comes linked to it: that train takes it.
    const unlink = (a: GenTrip) => { if (a.next !== undefined) { trips[a.next].prev = undefined; a.next = undefined; } };
    // the hot standby held aside at this line end, and its window
    const windows = !overlay && (T === W || T === topo.stations.length - 1) && topo.stations[T].turnbackBerths.length >= 2 ? standbyWindows(ctx.dayType) : [];
    let sb: { trip: GenTrip; ready: number; w: StandbyWindow } | null = null;
    const held = new Set<StandbyWindow>();
    /** the line end turns every departure up to `until` with the trains in
     *  `stand` and those arriving, one place fewer than it has */
    const spare = (from: number, stand: { ready: number }[], until: number) => {
      const q = stand.map((p) => p.ready);
      for (let k = from; k < evs.length && evs[k].time < until; k++) {
        const e = evs[k];
        if (e.trip.cancelled) continue;
        for (let i = q.length - 1; i >= 0; i--) if (e.time - q[i] > MAX_LAYOVER) q.splice(i, 1);
        if (e.kind === 0) { q.push(e.time + mt); if (q.length > cap - 1) q.shift(); continue; }
        const i = q.findIndex((r) => r <= e.time);
        if (i < 0) return false;
        q.splice(i, 1);
      }
      return true;
    };
    for (let ei = 0; ei < evs.length; ei++) {
      const ev = evs[ei];
      // end of the window: back into the cycle, first in line (or to the yard
      // if the line end is full)
      if (sb && ev.time >= sb.w.to) { present.unshift({ trip: sb.trip, ready: ev.time }); standbyUntil.set(sb.trip.id, ev.time); sb = null; }
      // trains idle longer than the maximum layover go back to the depot
      for (let i = present.length - 1; i >= 0; i--) {
        if (ev.time - present[i].ready > (T > 0 && T < topo.stations.length - 1 ? 450 : MAX_LAYOVER)) { unlink(present[i].trip); out.push(present.splice(i, 1)[0].trip); }
      }
      if (ev.trip.cancelled) { if (ev.kind === 0) unlink(ev.trip); else if (ev.trip.prev !== undefined) unlink(trips[ev.trip.prev]); continue; }
      if (ev.kind === 0) {
        // trains of the base plan turning back here (when adding an overlay) take places too
        const base = (baseOcc?.get(T) ?? []).filter((o) => o.from <= ev.time + mt && o.to > ev.time).length;
        if (overlay && base >= cap) { dropArrival(ev.trip); continue; }
        present.push({ trip: ev.trip, ready: ev.time + mt });
        const w = windows.find((x) => !held.has(x) && ev.time >= x.from && ev.time < Math.min(x.need, x.to - 240));
        if (w && !sb && ((present.length > 1 && spare(ei + 1, present.slice(0, -1), w.need)) || ev.time >= w.from + 3600)) {
          sb = { trip: present.pop()!.trip, ready: ev.time + mt, w };
          held.add(w);
          sb.trip.standby = true;
        }
        if (present.length + base > cap - (sb ? 1 : 0)) { const x = present.shift()!.trip; unlink(x); out.push(x); }
      } else {
        const linked = ev.trip.prev;
        let i = linked === undefined ? -1 : present.findIndex(p => p.trip.id === linked && p.ready <= ev.time);
        if (i < 0 && linked !== undefined) unlink(trips[linked]);
        if (i < 0) i = present.findIndex((p) => p.trip.next === undefined && p.ready <= ev.time && frontTurnClear(ctx, allForGaps(),
          p.trip, ev.time, new Set([p.trip.id, ev.trip.id])));
        if (i >= 0) pairs.push({ a: present.splice(i, 1)[0].trip, d: ev.trip });
        // short of a train in the build-up: the standby goes back into service
        else if (sb && ev.time >= sb.w.need && sb.ready <= ev.time) { pairs.push({ a: sb.trip, d: ev.trip }); sb = null; }
        else src.push(ev.trip);
      }
    }
    if (sb) { standbyUntil.set(sb.trip.id, sb.w.to); out.push(sb.trip); }
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
    stops.every(p => depsAt(p.st, dir).every(x => Math.abs(x - p.dep) >= MIN_HEADWAY));
  /** stops of a move starting at or before `latest` that fit between the other trains along the whole path */
  const fitBefore = (dir: TrackDir, latest: number, build: (t0: number) => PlanStop[], continuation?: GenTrip, accept: (st: PlanStop[]) => boolean = () => true): PlanStop[] | null => {
    const protection = continuation ? new DepIndex(allForGaps().filter(t => t !== continuation)) : null;
    for (let k = 0; k <= 240; k++) {
      const st = build(latest - k * 10);
      if (accept(st) && (protection ? protection.clear(st,dir) : pathClear(st, dir))) return st;
    }
    return null;
  };
  /** stops of a move starting at or after `earliest` that fit between the other trains along the whole path */
  const fitAfter = (dir: TrackDir, earliest: number, build: (t0: number) => PlanStop[], accept: (st: PlanStop[]) => boolean = () => true): PlanStop[] | null => {
    let at = earliest;
    for (let k = 0; k <= 480 && at <= earliest + 2400; k++) {
      const st = build(at);
      if (accept(st) && pathClear(st, dir)) return st;
      // Jump to the end of an actual conflict. A ten-second grid can miss
      // the narrow safe gap between two trains during a peak transition.
      let push = 0;
      for (const stop of st) for (const other of depsAt(stop.st, dir))
        if (Math.abs(other - stop.dep) < MIN_HEADWAY) push = Math.max(push, other + MIN_HEADWAY - stop.dep);
      at += push > 0 ? push + .000001 : 10;
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
    // Round up: a slot may not start before `earliest` (the turnback minimum).
    if (!deps.length || earliest < deps[0] - SLOT_GAP) return Math.ceil(earliest - 1e-9);
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
    return Math.ceil(best - 1e-9);
  };

  // West of 淞虹路 the peak runs big-route trains only, alternating 2'30" and
  // 5'00". A depot move there would split a 5'00" gap, so none is planned in
  // the outer alternation window (D30).
  const outerQuiet = (stops: PlanStop[]) => !stops.some(p => p.st < 4 && inOuterAlternation(periods, p.dep));
  const lastDepFrom = (T: number) => Math.max(...pool.filter((t) => t.from === T).map((t) => t.stops[0].dep), -Infinity);
  const firstDepFrom = (T: number) => Math.min(...pool.filter((t) => t.from === T).map((t) => t.stops[0].dep), Infinity);
  const startOf: Map<number, Block['start']> = new Map();
  const endOf: Map<number, Block['end']> = new Map();

  /**
   * Before an added-service train is brought out of the depot, a train of the
   * base plan that is about to go back to the same depot keeps running and
   * takes the added trip (延长运用, D47): its withdrawal is replaced by a move
   * to the origin, or by the added trip itself when it is already there. This
   * avoids a yard exit against the return wave on BZL/CSD's shared conversion
   * track, and serves 广兰路 while the core still runs at peak headway.
   */
  const reused = new Set<number>();
  /** Added moves through BZL/CSD's shared conversion track are planned
   * clear of the other trains' exits and returns (DEPOT_CONFLICT, D47). */
  const exitsPlanned: { depot: number; at: number }[] = [];
  const shared = (depot: number) => sharedLead(topo, depot);
  const baseLive = (b: Block) => !reused.has(b.id) && b.trips.some(id => !trips[id].cancelled);
  const exitClear = (depot: number, start: number) => !reuse || !shared(depot)
    || reuse.blocks.every(b => !baseLive(b) || b.end.kind !== 'depot' || b.end.depot !== depot || (() => {
      const [approach, clear] = inboundWindow(topo, depot, b.trips.map(id => trips[id]).filter(t => !t.cancelled).at(-1)!);
      return !(start < clear && start + topo.depots[depot].exitTime > approach);
    })());
  const entryClear = (depot: number, last: Trip) => {
    if (!reuse || !shared(depot)) return true;
    const [approach, clear] = inboundWindow(topo, depot, last);
    const exits = [...exitsPlanned.filter(x => x.depot === depot).map(x => x.at),
      ...reuse.blocks.filter(b => baseLive(b) && b.start.kind === 'depot' && b.start.depot === depot).map(b => (b.start as { time: number }).time)];
    return exits.every(start => !(start < clear && start + topo.depots[depot].exitTime > approach));
  };
  /** turnbacks added by extensions, on top of the base plan's (baseOcc) */
  const extOcc: { st: number; from: number; to: number; block: number }[] = [];
  /** the station still has a place for a train standing there over [from, to) */
  const placeFree = (st: number, from: number, to: number, own: number) => {
    const list = [...(baseOcc?.get(st) ?? []), ...extOcc.filter(o => o.st === st)].filter(o => o.block !== own && o.from < to && o.to > from);
    const at = [from, ...list.map(o => o.from).filter(x => x > from)];
    const cap = TERMINAL_CAP[st] ?? (topo.stations[st].turnbackBerths.length || 1);
    return at.every(t => list.filter(o => o.from <= t && o.to > t).length < cap);
  };
  const intermediate = (st: number) => st > 0 && st < topo.stations.length - 1;
  const orderOk = (st: number, from: number, to: number, own?: number) =>
    tailOrderClear(topo, st, [...(baseOcc?.get(st) ?? []), ...extOcc.filter(o => o.st === st)], from, to, own);
  const extendBase = (D: GenTrip, depot: number): boolean => {
    const T = D.from;
    const dep = D.stops[0].dep;
    const options: { block: Block; L: Trip; tail: Trip[]; tA: number }[] = [];
    for (const block of reuse!.blocks) {
      if (block.end.kind !== 'depot' || block.end.depot !== depot || reused.has(block.id)) continue;
      const live = block.trips.map(id => trips[id]).filter(t => !t.cancelled);
      let at = live.length - 1;
      while (at >= 0 && (live[at].kind === 'wd' || live[at].kind === 'empty')) at--;
      if (at < 0) continue;
      const L = live[at];
      const tail = live.slice(at + 1);
      const tA = L.stops.at(-1)!.arr;
      // still to come, close enough not to stand at the origin for long
      if (tA > dep || dep - tA > MAX_LAYOVER || tA < reuse!.now + 120 || L.overlay) continue;
      if (tail.some(t => t.stops[0].dep < reuse!.now + 120)) continue;
      if (!reuse!.canExtend(block.id, L.id)) continue;
      options.push({ block, L, tail, tA });
    }
    options.sort((a, b) => b.tA - a.tA);
    for (const { block, L, tail, tA } of options) {
      const P = L.to;
      // it stands at P no longer than the base plan already had it there
      const leave = (tail[0]?.stops[0].dep ?? tA + minTurn(P)) + 600;
      for (const t of tail) t.cancelled = true;
      let move: GenTrip | undefined;
      let ok: boolean;
      // It stands at P until it leaves: P must still have the place, and an
      // intermediate turnback holds it no longer than its turnback limit.
      const stand = (until: number, turning: boolean) => placeFree(P, tA, until, block.id)
        && (!turning || (!intermediate(P) || until <= tA + minTurn(P) + 450) && orderOk(P, tA, until, block.id));
      if (P === T) {
        ok = L.dir !== D.dir && tA + minTurn(T) <= dep && dep <= leave && stand(dep, true)
          && frontTurnClear(ctx, allForGaps(), L, dep, new Set([L.id, D.id]));
      } else {
        const dir: TrackDir = topo.stations[T].chain < topo.stations[P].chain ? 'UP' : 'DN';
        const mt = dir === D.dir ? 0 : minTurn(T);
        const turnAtP = dir === L.dir ? 30 : minTurn(P);
        const probe = buildStops(ctx, dir, P, T, 0, true, 1);
        const latest = dep - mt - probe.at(-1)!.arr;
        const st = latest < tA + turnAtP ? null : fitBefore(dir, latest, t0 => buildStops(ctx, dir, P, T, t0, true, 1), dir === D.dir ? D : undefined,
          stops => stops[0].dep >= tA + turnAtP && stops[0].dep <= leave && stops.at(-1)!.arr <= dep - mt + 1e-6 && outerQuiet(stops)
            && (dir !== D.dir || !intermediate(T) || stops.at(-1)!.arr >= dep - THROUGH_WAIT)
            && (dir !== L.dir || !intermediate(P) || stops[0].dep <= tA + THROUGH_WAIT)
            && stand(stops[0].dep, dir !== L.dir)
            && (dir === L.dir || frontTurnClear(ctx, allForGaps(), L, stops[0].dep, new Set([L.id])))
            && (dir === D.dir || frontTurnClear(ctx, allForGaps(), { dir, to: T, stops }, dep, new Set([D.id]))));
        ok = !!st;
        if (st) move = addTo(trips, dir, 'extra', P, T, st, true, overlay);
      }
      if (!ok) { for (const t of tail) t.cancelled = false; continue; }
      for (const t of tail) cancelTrip(t, `加开：车底延长运用，改担任${STATIONS[T].name}始发加开车次`);
      extOcc.push({ st: P, from: tA, to: (move ?? D).stops[0].dep, block: block.id });
      if (move) { move.prev = L.id; move.next = D.id; D.prev = move.id; }
      else D.prev = L.id;
      reused.add(block.id);
      reuse!.extended.push({ block: block.id, last: L.id, trips: [(move ?? D).id], tail: tail.map(t => t.id), end: block.end });
      return true;
    }
    return false;
  };

  // ---- sources
  const queue = sources.sort((a, b) => a.stops[0].dep - b.stops[0].dep);
  /**
   * An added-service train that cannot be brought out of the depot between the other
   * trains (peak headway) does not run its first trip; the train is brought out for the
   * next trip of its chain instead.
   */
  const dropSource = (D: GenTrip, reason = '加开：高峰间隔内无出段时隙') => {
    cancelTrip(D, reason);
    if (D.next !== undefined) {
      const N = trips[D.next];
      N.prev = undefined;
      D.next = undefined;
      const i = queue.findIndex((x) => x.stops[0].dep > N.stops[0].dep);
      queue.splice(i < 0 ? queue.length : i, 0, N);
    } else if (sinks.includes(D)) sinks.splice(sinks.indexOf(D), 1);
  };
  /** single platform turnback (广兰路): no other train turning there while one
   *  stands over [arr, dep] — a turn arriving in the 300 s before may still stand */
  const singlePlace = (T: number) => TERMINAL_CAP[T] === 1;
  const platformFree = (T: number, arr: number, dep: number) => !singlePlace(T)
    || !allForGaps().some((t) => !t.cancelled && t.to === T
      && t.stops[t.stops.length - 1].arr > arr - 300 && t.stops[t.stops.length - 1].arr < dep + MIN_HEADWAY);
  /** a positioning move from `depot` can turn at T before `dep` without crowding its platform */
  const turnPlaceFits = (T: number, towardDir: TrackDir, depot: number, dep: number) => {
    if (!singlePlace(T)) return true;
    const ex = exitStation(topo, depot, towardDir);
    const run = buildStops(ctx, towardDir, ex, T, 0, false, 1).at(-1)!.arr;
    const latest = dep - minTurn(T) - 60 - run;
    return fitBefore(towardDir, placeBefore(ex, towardDir, latest), (t0) => buildStops(ctx, towardDir, ex, T, t0, false, 1), undefined,
      (stops) => stops.at(-1)!.arr >= latest - 300 && platformFree(T, stops.at(-1)!.arr, dep)) !== null;
  };
  /** a move from `depot` running straight into D's departure fits between the other trains */
  const farFits = (T: number, D: GenTrip, depot: number) => {
    const ex = exitStation(topo, depot, D.dir);
    const dep = D.stops[0].dep;
    const run = buildStops(ctx, D.dir, ex, T, 0, true, 1).at(-1)!.arr;
    return fitBefore(D.dir, dep - run, (t0) => buildStops(ctx, D.dir, ex, T, t0, true, 1), D,
      (stops) => stops.at(-1)!.arr <= dep + 1e-6 && stops.at(-1)!.arr >= dep - THROUGH_WAIT) !== null;
  };
  /** nearest depot whose trains reach T already travelling `dir` */
  const farDepot = (T: number, dir: TrackDir): number | undefined => {
    const c = topo.stations[T].chain;
    return topo.depots.map((_, i) => i)
      .filter((i) => (dir === 'UP' ? topo.depots[i].junctionChain > c : topo.depots[i].junctionChain < c))
      .sort((i, j) => Math.abs(topo.depots[i].junctionChain - c) - Math.abs(topo.depots[j].junctionChain - c))[0];
  };
  // Added service ordered during the day: a train can leave the yard from now on.
  // A trip it cannot reach in time is dropped; the train comes out for the next.
  const now = reuse?.now ?? -Infinity;
  /** departures of trains brought into place by a positioning move, per station */
  const positioned = new Map<number, number[]>();
  // A yard can send out no more trains before the morning returns than it
  // holds. Its earliest exits past that (while the line still has room for a
  // longer move) come from the next nearest yard with room instead.
  const redirect = new Map<number, number>();
  if (!overlay && shift) {
    const left = { ...stabling };
    const byDepot = topo.depots.map(() => [] as GenTrip[]);
    for (const D of queue) {
      const T = D.from, dep = D.stops[0].dep;
      if (dep >= H(10)) break;
      if ((dep <= firstDepFrom(T) + 1500 || D.kind === 'small') && (left[T] ?? 0) > 0) { left[T]--; continue; }
      byDepot[depotIndex(topo, TERMINAL_DEPOT[T])].push(D);
    }
    const spare = topo.depots.map((dp, i) => dp.capacity - (stock?.[i] ?? byDepot[i].length));
    shift.forEach((n, d) => {
      // Redirect after opening: sending a BZL/LYD train to the airport before
      // 06:00 would cross GLL's occupied DN platform. Actual yardNeed, rather
      // than the raw source count, includes returns and far-side suppliers.
      for (const D of byDepot[d].filter(D => D.stops[0].dep >= H(7)).slice(0, n)) {
        const c = topo.stations[D.from].chain;
        const alt = topo.depots.map((_, i) => i).filter((i) => i !== d && shift[i] === 0 && spare[i] > 0)
          .sort((i, j) => Math.abs(topo.depots[i].junctionChain - c) - Math.abs(topo.depots[j].junctionChain - c))[0];
        if (alt === undefined) break;
        redirect.set(D.id, alt);
        spare[alt]--;
      }
    });
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const D = queue[qi];
    const T = D.from;
    const dep = D.stops[0].dep;
    let depot = depotIndex(topo, TERMINAL_DEPOT[T]);
    let early = !overlay && (dep <= firstDepFrom(T) + 1500 || D.kind === 'small');
    if (!overlay && T === 22 && ((D.dir === 'UP' && dep === H(5, 28)) || (D.dir === 'DN' && dep === H(6)))) {
      const berth = D.dir === 'DN' ? platformBerth(topo, T, 'DN')
        : departureBerthAfterReverse(topo, topo.stations[T].turnbackBerths[0], platformBerth(topo, T, 'UP'));
      startOf.set(D.id, { kind: 'stable', station: T, berth });
      continue;
    }
    if (early && (stabling[T] ?? 0) > 0) {
      stabling[T]--;
      startOf.set(D.id, { kind: 'stable', station: T });
      continue;
    }
    if (overlay && reuse && extendBase(D, depot)) continue;
    const alt = redirect.get(D.id);
    if (alt !== undefined) { depot = alt; early = true; }
    let towardDir: TrackDir = topo.stations[T].chain < topo.depots[depot].junctionChain ? 'UP' : 'DN';
    let farMove = false;
    if (!overlay && towardDir !== D.dir && !turnPlaceFits(T, towardDir, depot, dep)) {
      // a single platform turnback with no room for a positioning move to turn
      // in: come from the depot on the other side, arriving already facing D.dir
      const far = farDepot(T, D.dir);
      // (in service, stopping like the trains around it, straight into D)
      if (far !== undefined && farFits(T, D, far)) { depot = far; towardDir = D.dir; early = false; farMove = true; }
    }
    const ex = exitStation(topo, depot, towardDir);
    if (ex === T) {
      if (overlay && depotStartTime(ctx, depot, D) < now) { dropSource(D, '加开：出段时刻已过'); continue; }
      startOf.set(D.id, { kind: 'depot', depot, time: 0 });
      continue;
    }
    const mt = towardDir === D.dir ? 0 : minTurn(T);
    if (early) {
      // non-revenue positioning move before service
      const probe = buildStops(ctx, towardDir, ex, T, 0, false, 1);
      const run = probe[probe.length - 1].arr;
      // a single turnback place (广兰路): not in before the previous positioned train has left it
      const single = (TERMINAL_CAP[T] ?? topo.stations[T].turnbackBerths.length) === 1;
      const before = single ? Math.max(-Infinity, ...(positioned.get(T) ?? []).filter((x) => x <= dep)) : -Infinity;
      const st = fitBefore(towardDir, placeBefore(ex, towardDir, dep - mt - (towardDir === D.dir ? 0 : 60) - run), (t0) => buildStops(ctx, towardDir, ex, T, t0, false, 1), towardDir === D.dir ? D : undefined,
        (stops) => stops.at(-1)!.arr >= before)
        ?? fitBefore(towardDir, placeBefore(ex, towardDir, dep - mt - (towardDir === D.dir ? 0 : 60) - run), (t0) => buildStops(ctx, towardDir, ex, T, t0, false, 1), towardDir === D.dir ? D : undefined)
        ?? buildStops(ctx, towardDir, ex, T, dep - mt - (towardDir === D.dir ? 0 : 60) - run, false, 1);
      positioned.set(T, [...(positioned.get(T) ?? []), dep]);
      st[0].stop = false;
      if (towardDir === D.dir) st[st.length-1].stop = false;
      const e = addTo(trips, towardDir, 'empty', ex, T, st, false, overlay);
      e.next = D.id;
      D.prev = e.id;
      startOf.set(e.id, { kind: 'depot', depot, time: 0 });
    } else {
      const f = 1;
      const probe = buildStops(ctx, towardDir, ex, T, 0, true, f);
      const run = probe[probe.length - 1].arr;
      const latest = dep - mt - run;
      // Dwells depend on the time of day, so the run measured from 0 is only
      // an estimate: the arrival itself must leave the declared turnback.
      const turnOk = (stops: PlanStop[]) => stops.at(-1)!.arr <= dep - mt + 1e-6;
      const exitAt = (stops: PlanStop[]) => depotStartTime(ctx, depot, { stops } as Trip);
      // (an added train searches from the latest arrival: arriving earlier
      // only lengthens a front turn across the opposite platform)
      let st = fitBefore(towardDir, overlay || farMove ? latest : Math.min(latest, placeBefore(ex, towardDir, latest)), (t0) => buildStops(ctx, towardDir, ex, T, t0, true, f), farMove ? D : undefined,
        stops => turnOk(stops) && outerQuiet(stops) && frontTurnClear(ctx, allForGaps(), { dir: towardDir, to: T, stops }, dep, new Set([D.id]))
          && (!overlay || exitClear(depot, exitAt(stops))) && exitAt(stops) >= now
          // (straight through into D: no standing on the through platform)
          && (!farMove || stops.at(-1)!.arr >= dep - THROUGH_WAIT));
      if (st && overlay) exitsPlanned.push({ depot, at: exitAt(st) });
      if (!st && overlay) {
        dropSource(D, exitAt(buildStops(ctx, towardDir, ex, T, latest, true, f)) < now ? '加开：出段时刻已过' : undefined);
        continue;
      }
      if (!st) {
        let t0 = placeBefore(ex, towardDir, latest);
        st = buildStops(ctx, towardDir, ex, T, t0, true, f);
        while (!turnOk(st)) { t0 -= Math.ceil(st.at(-1)!.arr - (dep - mt)); st = buildStops(ctx, towardDir, ex, T, t0, true, f); }
      }
      const ins = addTo(trips, towardDir, overlay ? 'extra' : 'ins', ex, T, st, true, overlay);
      ins.next = D.id;
      D.prev = ins.id;
      startOf.set(ins.id, { kind: 'depot', depot, time: 0 });
    }
  }
  // Positioning moves are fitted one departure at a time and can reach an end
  // terminal out of order. Every train there leaves by the one departure
  // platform, in the order it arrived (a train standing on it for a later
  // departure blocks the earlier one), so pair turns first in, first out.
  for (const T of [0, topo.stations.length - 1]) {
    // (the hot standby stands aside in its own track)
    const turns = trips.filter((a) => a.overlay === overlay && !a.cancelled && !a.standby && a.to === T && a.next !== undefined && trips[a.next].from === T && trips[a.next].dir !== a.dir);
    if (turns.length < 2) continue;
    const deps = turns.map((a) => trips[a.next!]).sort((x, y) => x.stops[0].dep - y.stops[0].dep);
    turns.sort((x, y) => x.stops[x.stops.length - 1].arr - y.stops[y.stops.length - 1].arr)
      .forEach((a, i) => { a.next = deps[i].id; deps[i].prev = a.id; });
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
  /**
   * An added train that cannot get back to the depot between the trains of
   * the peak build-up takes over a base duty whose train has not yet left
   * the depot (加开车底转入基本图运用, D47): it turns back at, or runs on
   * to, that duty's first origin. The base train stays in the depot; its
   * yard exit is cancelled. The duty's own trips keep their times.
   */
  const takenFrom = new Map<number, { block: Block; from: number }>();
  const takeOver = (A: GenTrip): boolean => {
    if (!reuse) return false;
    const T = A.to;
    const arr = lastArr(A);
    const options: { B: Block; lead: GenTrip[]; D: GenTrip; k: number }[] = [];
    for (const B of reuse.blocks) {
      if (B.start.kind !== 'depot' || B.train !== undefined || B.relieved || reused.has(B.id)) continue;
      if (B.start.time < reuse.now + 120) continue;
      const k = B.trips.findIndex(id => !trips[id].cancelled && trips[id].kind !== 'ins' && trips[id].kind !== 'empty');
      if (k < 0) continue;
      const D = trips[B.trips[k]];
      const dep = D.stops[0].dep;
      if (!D.revenue || D.overlay || dep < arr + 30 || dep > arr + MAX_LAYOVER) continue;
      // within a few stations: the run on is short and stays clear of the core
      if (Math.abs(D.from - T) > 3) continue;
      options.push({ B, lead: B.trips.slice(0, k).map(id => trips[id]).filter(t => !t.cancelled), D, k });
    }
    options.sort((x, y) => x.D.stops[0].dep - y.D.stops[0].dep);
    for (const { B, lead, D, k } of options) {
      const P = D.from;
      const dep = D.stops[0].dep;
      const own = new Set([A.id, D.id, ...lead.map(t => t.id)]);
      const others = () => allForGaps().filter(t => !lead.includes(t as GenTrip));
      for (const t of lead) t.cancelled = true;
      let move: GenTrip | undefined;
      let ok: boolean;
      if (P === T) {
        ok = A.dir !== D.dir && arr + minTurn(T) <= dep && placeFree(T, arr, dep, B.id) && orderOk(T, arr, dep, B.id)
          && (!intermediate(T) || dep <= arr + minTurn(T) + 450)
          && frontTurnClear(ctx, others(), A, dep, own);
      } else {
        const dir: TrackDir = topo.stations[P].chain < topo.stations[T].chain ? 'UP' : 'DN';
        const mt = dir === D.dir ? 0 : minTurn(P);
        const turnAtT = dir === A.dir ? 30 : minTurn(T);
        const probe = buildStops(ctx, dir, T, P, 0, true, 1);
        const latest = dep - mt - probe.at(-1)!.arr;
        const st = latest < arr + turnAtT ? null : fitBefore(dir, latest, t0 => buildStops(ctx, dir, T, P, t0, true, 1), dir === D.dir ? D : undefined,
          stops => stops[0].dep >= arr + turnAtT && stops.at(-1)!.arr <= dep - mt + 1e-6 && outerQuiet(stops)
            && (dir !== D.dir || !intermediate(P) || stops.at(-1)!.arr >= dep - THROUGH_WAIT)
            && (dir !== A.dir || !intermediate(T) || stops[0].dep <= arr + THROUGH_WAIT)
            && placeFree(T, arr, stops[0].dep, B.id) && placeFree(P, stops.at(-1)!.arr, dep, B.id)
            && (dir === A.dir || (!intermediate(T) || stops[0].dep <= arr + minTurn(T) + 450) && orderOk(T, arr, stops[0].dep, B.id) && frontTurnClear(ctx, others(), A, stops[0].dep, own))
            && (dir === D.dir || orderOk(P, stops.at(-1)!.arr, dep, B.id) && frontTurnClear(ctx, others(), { dir, to: P, stops }, dep, own)));
        ok = !!st;
        if (st) move = addTo(trips, dir, 'extra', T, P, st, true, overlay);
      }
      if (!ok) { for (const t of lead) t.cancelled = false; continue; }
      for (const t of lead) cancelTrip(t, `加开：加开车底接续担任${STATIONS[P].name}始发车次，免出段`);
      if (move) { A.next = move.id; move.prev = A.id; }
      const last = move ?? A;
      extOcc.push({ st: T, from: arr, to: (move ?? D).stops[0].dep, block: B.id });
      reused.add(B.id);
      takenFrom.set(last.id, { block: B, from: k });
      endOf.set(last.id, B.end);
      return true;
    }
    return false;
  };
  const sinkQueue = sinks.sort((a, b) => lastArr(a) - lastArr(b));
  for (let qi = 0; qi < sinkQueue.length; qi++) {
    const A = sinkQueue[qi];
    if (endOf.has(A.id) || A.cancelled || A.next !== undefined) continue; // (queued twice: already sent on)
    // A surplus opening train from GLL can finish at SHR and enter BZL
    // directly. Going all the way to PXL and returning would insert a depot
    // withdrawal into the AM core slots and the outer alternation.
    if (!overlay && A.dir === 'UP' && A.from === 22 && A.to === W && A.kind === 'ins' && A.stops[0].dep > H(5, 28)) {
      A.to = 4; A.kind = 'wd'; A.stops = A.stops.filter(s => s.st >= 4);
      A.stops.at(-1)!.dep = A.stops.at(-1)!.arr;
      const index = new DepIndex(allForGaps().filter(t => t.id !== A.id && t.id !== A.prev));
      for (let k = 0; k < 60 && !index.clear(A.stops, 'UP'); k++) for (const stop of A.stops) { stop.arr++; stop.dep++; }
    }
    const T = A.to;
    const arr = Math.max(lastArr(A), standbyUntil.get(A.id) ?? -Infinity);
    if (!overlay && !A.standby && (T === W || T === topo.stations.length - 1)) {
      // An end-terminal return can replace an already-positioned depot
      // feeder for the next duty. It arrives no earlier than that feeder,
      // so this reduces depot moves without adding terminal occupation.
      const next = pool.filter(D => D.from === T && D.dir !== A.dir && D.prev !== undefined
        && D.stops[0].dep >= arr + minTurn(T) && D.stops[0].dep <= arr + MAX_LAYOVER)
        .sort((a, b) => a.stops[0].dep - b.stops[0].dep).find(D => {
          const feeder = trips[D.prev!];
          return startOf.get(feeder.id)?.kind === 'depot' && (feeder.kind === 'ins' || feeder.kind === 'empty')
            && feeder.to === T && feeder.stops.at(-1)!.arr <= arr;
        });
      if (next) {
        const feeder = trips[next.prev!];
        feeder.cancelled = true; feeder.next = undefined; startOf.delete(feeder.id);
        A.next = next.id; next.prev = A.id;
        continue;
      }
    }
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
      const earliest = placeAfter(T, awayDir, arr + mt);
      let withdrawalRevenue = true;
      let st = fitAfter(awayDir, overlay ? Math.max(arr+mt,earliest) : arr+mt, (t0) => buildStops(ctx, awayDir, T, en, t0, true, 1),
        stops => outerQuiet(stops) && frontTurnClear(ctx, allForGaps(), A, stops[0].dep, new Set([A.id]))
          && (!overlay || entryClear(depot, { to: en, stops } as unknown as Trip))
          // an intermediate turnback holds an added train no longer than its turnback limit
          && (!overlay || A.dir === awayDir || T === 0 || T === topo.stations.length - 1 || stops[0].dep <= arr + mt + 450)
          && (!overlay || A.dir === awayDir || orderOk(T, arr, stops[0].dep)));
      if (!st && !overlay) {
        // Passengers have already alighted at this terminal. If a stopping
        // withdrawal cannot fit, return empty using the existing pass times
        // instead of forcing another passenger trip into the core slots.
        st = fitAfter(awayDir, arr + mt, t0 => buildStops(ctx, awayDir, T, en, t0, false, 1),
          stops => outerQuiet(stops) && frontTurnClear(ctx, allForGaps(), A, stops[0].dep, new Set([A.id])));
        if (st) withdrawalRevenue = false;
      }
      if (!st && overlay && takeOver(A)) continue;
      if (!st && overlay) {
        // a train that cannot turn back between the other trains (the single
        // tail track of an intermediate turnback in use) runs on in its own
        // direction, in service, to the next depot beyond the end of the added section
        const c = topo.stations[T].chain;
        const on = topo.depots.map((_, i) => i)
          .filter(i => i !== depot && (A.dir === 'DN' ? topo.depots[i].junctionChain > c : topo.depots[i].junctionChain < c))
          .sort((i, j) => Math.abs(topo.depots[i].junctionChain - c) - Math.abs(topo.depots[j].junctionChain - c))[0];
        const to = on === undefined ? T : entryStation(topo, on, A.dir);
        const others = new DepIndex(allForGaps().filter(t => t !== A));
        let s2: PlanStop[] | null = null;
        for (let w = STATIONS[T].dwell; to !== T && !s2 && w <= 60; w += 10) {
          const x = buildStops(ctx, A.dir, T, to, arr + w, true, 1);
          if (outerQuiet(x) && entryClear(on!, { to, stops: x } as unknown as Trip) && others.clear(x, A.dir)) s2 = x;
        }
        if (s2) {
          const wd = addTo(trips, A.dir, 'extra', T, to, s2, true, overlay);
          A.next = wd.id;
          wd.prev = A.id;
          endOf.set(wd.id, { kind: 'depot', depot: on! });
          continue;
        }
      }
      if (!st && overlay && A.prev !== undefined) {
        // an added-service train that cannot get back to the depot between the other trains
        // (peak headway) does not run its last trip: it goes back after the trip before
        const P = trips[A.prev];
        cancelTrip(A, '加开：高峰间隔内无回段时隙');
        A.prev = undefined;
        P.next = undefined;
        const i = sinkQueue.findIndex((x, k) => k > qi && lastArr(x) > lastArr(P));
        sinkQueue.splice(i < 0 ? sinkQueue.length : i, 0, P);
        continue;
      }
      if (!st && overlay) { dropArrival(A); continue; }
      st ??= buildStops(ctx, awayDir, T, en, placeAfter(T, awayDir, arr + mt), true, 1);
      if (overlay && A.dir !== awayDir) extOcc.push({ st: T, from: arr, to: st[0].dep, block: -1 });
      const wd = addTo(trips, awayDir, overlay ? 'extra' : 'wd', T, en, st, withdrawalRevenue, overlay);
      A.next = wd.id;
      wd.prev = A.id;
      endOf.set(wd.id, { kind: 'depot', depot });
    }
  }

  // ---- blocks
  /** the added train runs on into the base duty it took over */
  const takeRest = (cur: GenTrip, b: Block) => {
    const x = takenFrom.get(cur.id);
    if (!x) return false;
    const rest = x.block.trips.slice(x.from);
    reuse!.absorbed ??= [];
    reuse!.absorbed.push({ block: x.block.id, into: b.id, trips: rest, lead: x.block.trips.slice(0, x.from).filter(id => trips[id].cancelReason?.includes('免出段')), end: x.block.end });
    for (const id of rest) { trips[id].block = b.id; b.trips.push(id); }
    x.block.trips = x.block.trips.slice(0, x.from);
    b.end = x.block.end;
    return true;
  };
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
      if (takeRest(cur, b)) break;
      if (cur.next === undefined) { b.end = endOf.get(cur.id) ?? { kind: 'none' }; break; }
      cur = trips[cur.next];
    }
    if (b.start.kind === 'depot') b.start.time = depotStartTime(ctx, b.start.depot, trips[b.trips[0]]);
    blocks.push(b);
  }
  for (const x of reuse?.extended ?? []) {
    const block = reuse!.blocks[x.block];
    let cur: GenTrip | undefined = trips[x.trips[0]];
    x.trips = [];
    while (cur) {
      cur.block = block.id;
      x.trips.push(cur.id);
      block.trips.push(cur.id);
      if (takeRest(cur, block)) break;
      if (cur.next === undefined) { block.end = endOf.get(cur.id) ?? { kind: 'none' }; break; }
      cur = trips[cur.next];
    }
  }
  spacePortalExits(ctx, blocks, trips, new Set(pool.map(t => t.id)));
  if (!overlay) relieveTerminals(ctx, blocks, trips, new Set(pool.map(t => t.id)));
  void periods;
  return blocks;
}

/** how far a trip can move later / earlier and still keep `keep` s to every
 *  other train in its direction at each of its stops */
function headwayRoom(trips: Trip[], t: Trip, keep: number, skip: Set<number> = new Set()): { later: number; earlier: number } {
  let later = Infinity, earlier = Infinity;
  for (const u of trips) {
    if (u.dir !== t.dir || u.cancelled || u.id === t.id || skip.has(u.id)) continue;
    for (const s of t.stops) {
      const us = u.stops.find((x) => x.st === s.st);
      if (!us) continue;
      if (us.dep >= s.dep) later = Math.min(later, us.dep - s.dep - keep);
      else earlier = Math.min(earlier, s.dep - us.dep - keep);
    }
  }
  return { later: Math.max(0, later), earlier: Math.max(0, earlier) };
}

/** `t` moved by `shift` keeps `keep` s to every other train in its direction at each of its stops */
function headwayClear(trips: Trip[], t: Trip, shift: number, keep: number, skip: Set<number> = new Set()): boolean {
  return trips.every((u) => {
    if (u.dir !== t.dir || u.cancelled || u.id === t.id || skip.has(u.id)) return true;
    return t.stops.every((s) => {
      const us = u.stops.find((x) => x.st === s.st);
      return !us || Math.abs(us.dep - (s.dep + shift)) >= keep;
    });
  });
}

/**
 * A train brought out of the depot to start at a terminal that would make
 * more trains stand there at once than it holds comes later instead: within
 * its own turn there, clear of every other train on its way (it may drop in
 * behind one), and its exit spacing kept (later exits through the same
 * change-of-ends portal move up with it where they can).
 */
function relieveTerminals(ctx: PlanContext, blocks: Block[], trips: GenTrip[], fixedDepartures: Set<number> = new Set()) {
  const { topo } = ctx;
  const plan = { blocks, trips } as unknown as Plan;
  const clearAt = (t: Trip, delta: number, skip: Set<number>) => trips.every((u) => {
    if (u.dir !== t.dir || u.cancelled || u.id === t.id || skip.has(u.id)) return true;
    return t.stops.every((s) => {
      const us = u.stops.find((x) => x.st === s.st);
      return !us || Math.abs(us.dep - (s.dep + delta)) >= MIN_HEADWAY;
    });
  });
  /** exits after `b` through the same reversing portal, in order */
  const portalFollowers = (b: Block): Block[] => {
    const a = trips[b.trips[0]];
    if (b.start.kind !== 'depot') return [];
    const depot = b.start.depot;
    const p = topo.depots[depot].portals.exit[a.dir];
    if (!p.reverse || a.stops[0].st !== p.station) return [];
    return blocks.filter((x) => x !== b && x.start.kind === 'depot' && x.start.depot === depot && !trips[x.trips[0]].cancelled
      && trips[x.trips[0]].dir === a.dir && trips[x.trips[0]].stops[0].st === p.station && trips[x.trips[0]].stops[0].dep >= a.stops[0].dep)
      .sort((x, y) => trips[x.trips[0]].stops[0].dep - trips[y.trips[0]].stops[0].dep);
  };
  const turnSlack = (b: Block) => {
    const a = trips[b.trips[0]], d = trips[b.trips[1]];
    return d && !d.cancelled && a.to === d.from ? d.stops[0].dep - a.stops[a.stops.length - 1].arr - minTurn(a.to) : 0;
  };
  /** move `b`'s first trip `delta` later, pushing the portal exits behind it; false (nothing moved) if it cannot */
  const plan2 = (b: Block, delta: number): Map<Block, number> | null => {
    const moves = new Map<Block, number>();
    let prevDep = trips[b.trips[0]].stops[0].dep + delta;
    moves.set(b, delta);
    for (const f of portalFollowers(b)) {
      const dep = trips[f.trips[0]].stops[0].dep;
      const push = prevDep + PORTAL_CYCLE - dep;
      if (push <= 0) break;
      moves.set(f, push);
      prevDep = dep + push;
    }
    const skip = new Set([...moves.keys()].map((x) => x.trips[0]));
    for (const [x, d] of moves) if (d > turnSlack(x) || !clearAt(trips[x.trips[0]], d, skip)) return null;
    return moves;
  };
  /**
   * Where no later exit fits (the morning build-up at 蟠祥路, fed through the
   * change of ends at 淞虹路), a train that would come out of the depot empty
   * to start there (an 出段 insertion trip in service, or empty) stands
   * overnight in the station's storage tail instead.
   */
  const placesLeft = (st: number) => topo.stations[st].turnbackBerths.length + topo.stations[st].storageBerths.length
    - blocks.filter((x) => x.start.kind === 'stable' && x.start.station === st && x.trips.some((id) => !trips[id].cancelled)).length;
  /** a morning yard exit whose first move only brings the train to `st`, where it can stand overnight instead */
  const stableable = (b: Block, st: number) => {
    const a = trips[b.trips[0]], d = trips[b.trips[1]];
    return b.start.kind === 'depot' && !!d && (a.kind === 'ins' || a.kind === 'empty') && a.to === st && d.from === st && d.stops[0].dep <= 10 * 3600;
  };
  const toStable = (b: Block, st: number) => {
    const a = trips[b.trips[0]], d = trips[b.trips[1]];
    a.cancelled = true;
    a.block = -1;
    a.next = undefined;
    d.prev = undefined;
    b.trips.shift();
    b.start = { kind: 'stable', station: st };
  };
  const stableInstead = (st: number, present: { from: number; block: number }[]): boolean => {
    if (placesLeft(st) <= 0) return false;
    for (const o of present.slice().sort((x, y) => y.from - x.from)) {
      const b = blocks.find((x) => x.id === o.block)!;
      if (!stableable(b, st) || trips[b.trips[0]].stops.at(-1)!.arr !== o.from) continue;
      toStable(b, st);
      return true;
    }
    return false;
  };
  for (let iter = 0; iter < 30; iter++) {
    let moved = false;
    for (const [st, list] of terminalOccupancy(plan)) {
      const ov = terminalOverflows(topo, st, list)[0];
      const over = ov && list.find((o) => o.from === ov.t);
      if (!over) continue;
      const present = list.filter((x) => x.from <= over.from && x.to > over.from);
      let relieved = false;
      // the latest arrivals first: they are the ones to hold back
      for (const o of present.sort((x, y) => y.from - x.from)) {
        const b = blocks.find((x) => x.id === o.block)!;
        const a = trips[b.trips[0]];
        if (b.start.kind !== 'depot' || fixedDepartures.has(a.id) || b.trips.length < 2 || a.to !== st || a.stops[a.stops.length - 1].arr !== o.from) continue;
        const need = Math.min(...present.filter((x) => x !== o).map((x) => x.to)) - o.from + 5;
        let moves: Map<Block, number> | null = null;
        for (let delta = Math.max(need, 1); delta <= turnSlack(b) && !moves; delta += 10) moves = plan2(b, delta);
        if (!moves) continue;
        for (const [x, d] of moves) {
          const t = trips[x.trips[0]];
          for (const p of t.stops) { p.arr += d; p.dep += d; }
          if (x.start.kind === 'depot') x.start.time = depotStartTime(ctx, x.start.depot, t);
        }
        moved = relieved = true;
        break;
      }
      if (!relieved && stableInstead(st, present)) moved = true;
    }
    if (!moved) break;
  }
  // places left in a storage tail take the earliest such exits: they stood
  // there overnight (the trains that ended the day there)
  for (const st of [0, topo.stations.length - 1]) {
    if (!topo.stations[st].storageBerths.length) continue;
    const list = blocks.filter((b) => stableable(b, st)).sort((x, y) => trips[x.trips[1]].stops[0].dep - trips[y.trips[1]].stops[0].dep);
    for (const b of list) { if (placesLeft(st) <= 0) break; toStable(b, st); }
  }
}

/** platform time a depot exit takes when it changes ends on the junction
 *  platform: in against the normal direction, change ends, board, away */
const PORTAL_CYCLE = 150;
/** spacing kept to the other trains when such an exit is moved (MIN_HEADWAY + margin) */
const HEADWAY_KEEP = 120;

/**
 * Exits that change ends on the junction platform (北翟路 trains for the UP
 * at 淞虹路, 川沙 trains for the DN at 远东大道) use that platform one after
 * another, PORTAL_CYCLE apart at least. A burst planned closer is spread:
 * later where the train's turn at the far end has the slack (it then stands
 * there for less), earlier only for what that slack cannot take.
 */
function spacePortalExits(ctx: PlanContext, blocks: Block[], trips: GenTrip[], fixedDepartures: Set<number> = new Set()) {
  const { topo } = ctx;
  topo.depots.forEach((dp, d) => {
    for (const dir of ['DN', 'UP'] as const) {
      const p = dp.portals.exit[dir];
      if (!p.reverse) continue;
      const group = blocks.filter((b) => b.start.kind === 'depot' && b.start.depot === d && trips[b.trips[0]]?.dir === dir
        && trips[b.trips[0]].stops[0].st === p.station && !trips[b.trips[0]].cancelled)
        .sort((a, b) => trips[a.trips[0]].stops[0].dep - trips[b.trips[0]].stops[0].dep);
      if (group.length < 2) continue;
      const first = group.map((b) => trips[b.trips[0]]);
      const dep0 = first.map((t) => t.stops[0].dep);
      const later = group.map((b, k) => {
        const t = first[k];
        const n = b.trips[1] !== undefined ? trips[b.trips[1]] : undefined;
        if (!n || n.cancelled) return 0;
        return Math.max(0, n.stops[0].dep - t.stops[t.stops.length - 1].arr - minTurn(t.to));
      });
      // as late as each train's turn at the far end allows (no longer layover
      // there than needed), working back from the last, PORTAL_CYCLE apart,
      // and clear of every other train on the way by HEADWAY_KEEP (it may drop
      // in behind one rather than stay ahead of it)
      const moving = new Set(first.map((t) => t.id));
      const dep = dep0.slice();
      for (let k = dep.length - 1; k >= 0; k--) {
        // A source may be a scheduled short-route or official first train,
        // already departing its depot junction. Moving that service here
        // breaks the core stream; only positioning moves have timing slack.
        if (fixedDepartures.has(first[k].id)) continue;
        let hi = dep0[k] + later[k];
        if (k < dep.length - 1) hi = Math.min(hi, dep[k + 1] - PORTAL_CYCLE);
        let at = NaN;
        for (let x = hi; x >= Math.min(dep0[k], hi) - 600; x -= 10) {
          if (headwayClear(trips, first[k], x - dep0[k], HEADWAY_KEEP, moving)) { at = x; break; }
          // where it was planned is good enough when nothing later is
          if (x - 10 < dep0[k] && dep0[k] <= hi) { at = dep0[k]; break; }
        }
        if (Number.isNaN(at)) {
          const room = headwayRoom(trips, first[k], HEADWAY_KEEP, moving);
          at = Math.min(dep0[k] + Math.min(later[k], room.later), hi);
        }
        dep[k] = at;
      }
      group.forEach((b, k) => {
        const shift = dep[k] - dep0[k];
        if (Math.abs(shift) < 0.5) return;
        for (const st of first[k].stops) { st.arr += shift; st.dep += shift; }
        if (b.start.kind === 'depot') b.start.time = depotStartTime(ctx, d, first[k]);
      });
    }
  });
}

function addTo(trips: GenTrip[], dir: TrackDir, kind: TripKind, from: number, to: number, stops: PlanStop[], revenue: boolean, overlay?: string): GenTrip {
  const t: GenTrip = { id: trips.length, no: '', dir, kind, from, to, stops, revenue, block: -1, overlay };
  trips.push(t);
  return t;
}

/** BZL/CSD share their conversion track: a returning train holds it from
 * 1500 m before the junction until it is clear inside the yard. */
/** some lead of the depot takes both trains going in and trains coming out
 *  (北翟路: each 出入段线 for its direction; 川沙: the 出入段线), so an added
 *  return can meet a planned exit on it */
export function sharedLead(topo: Topology, depot: number): boolean {
  const p = topo.depots[depot].portals;
  const ins = new Set([p.entry.DN.path, p.entry.UP.path]);
  return ins.has(p.exit.DN.path) || ins.has(p.exit.UP.path);
}

export function inboundWindow(topo: Topology, depot: number, last: Trip): [number, number] {
  const d = topo.depots[depot];
  const distance = Math.abs(topo.stations[last.to].chain - d.junctionChain);
  const arr = last.stops.at(-1)!.arr;
  const transfer = d.transferPaths[0].links.reduce((sum, id) => sum + topo.links[id].len, 0);
  return [arr + 15 + Math.max(0, distance - 1500) / 20, arr + 15 + distance / 20 + (transfer + LINE_INFO.trainLength) / (25 / 3.6) + 25];
}

/** time a train must leave the depot gate to make its first departure */
export function depotStartTime(ctx: PlanContext, depot: number, first: Trip): number {
  const { topo } = ctx;
  const J = topo.depots[depot].junctionChain;
  const st0 = first.stops[0].st;
  const dist = Math.abs(topo.stations[st0].chain - J);
  // Both the time and the distance must refer to the first station, even
  // when an empty feeder passes it without stopping.
  const refTime = first.stops[0].dep;
  // transfer track (~470 m at 25 km/h) + junction + run on the main line
  // (+ the change of ends where the lead reaches the line against `dir`)
  // (callers may pass bare stops: then the direction follows from their order)
  const dir: TrackDir = first.dir ?? (first.stops.length > 1 && first.stops[1].st < st0 ? 'UP' : 'DN');
  const travel = 95 + dist / 13 + 25 + (topo.depots[depot].portals.exit[dir].reverse ? PORTAL_REVERSE : 0);
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
    const live = b.trips.map(id => plan.trips[id]).filter(t => !t.cancelled);
    if (!live.length) continue;
    const first = live[0];
    const last = live[live.length - 1];
    const s = b.start.kind === 'depot' ? b.start.time : first.stops[0].dep - 600;
    const e = last.stops[last.stops.length - 1].arr + (b.end.kind === 'depot' ? 300 : 0);
    if (b.start.kind === 'stable' || b.end.kind === 'stable') continue;
    ev.push([s, 1], [e, -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of ev) { cur += d; max = Math.max(max, cur); }
  const stabled = plan.blocks.filter((b) => b.trips.some(id => !plan.trips[id].cancelled) && (b.start.kind === 'stable' || b.end.kind === 'stable')).length;
  return max + stabled;
}

// ---------------------------------------------------------------- overlays

export function applyOverlay(ctx: PlanContext, plan: Plan, preset: { id: string; label: string; a: number; b: number; from: number; to: number; headway: number },
  live?: Pick<OverlayReuse, 'canExtend' | 'now'>): { trips: number; blocks: number; skipped: number; extended: OverlayReuse['extended'] } {
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
  // Added trains arriving at an end of the added section, waiting to turn
  // back. A departure is placed, where its slot allows, inside the turnback
  // window of such a train, so that the added trips form circulations rather
  // than each arrival waiting out the intermediate station's turnback limit
  // and going back to the depot while a fresh train comes out for the
  // departure (D47).
  const waiting = new Map<number, GenTrip[]>([[a, []], [b, []]]);
  const waitAt = (X: number) => { if (!waiting.has(X)) waiting.set(X, []); return waiting.get(X)!; };
  const occ0 = terminalOccupancy(plan);
  const paired: { st: number; from: number; to: number }[] = [];
  const turnWait = (X: number) => X > 0 && X < ctx.topo.stations.length - 1 ? 450 : MAX_LAYOVER;
  let pairedWith: GenTrip | undefined;
  const fit = (dir: TrackDir, from: number, to: number, t: number, turn: boolean): PlanStop[] | null => {
    pairedWith = undefined;
    for (let k = 0; k * 10 <= preset.headway / 2; k++) {
      for (const t0 of k ? [t + k * 10, t - k * 10] : [t]) {
        let pair = -1;
        if (turn) {
          pair = waitAt(from).findIndex(A => t0 >= A.stops.at(-1)!.arr + minTurn(from) && t0 <= A.stops.at(-1)!.arr + minTurn(from) + turnWait(from)
            && tailOrderClear(ctx.topo, from, [...(occ0.get(from) ?? []), ...paired.filter(o => o.st === from)], A.stops.at(-1)!.arr, t0)
            && frontTurnClear(ctx, trips, A, t0, new Set([A.id])));
          if (pair < 0) continue;
        }
        const st = buildStops(ctx, dir, from, to, t0, true, 1);
        if (!idx.clear(st, dir)) continue;
        // Fit front-turn slots while placing the revenue streams, rather
        // than discovering after FIFO matching that every arrival occupies
        // a platform needed by the opposite stream.
        if (!frontTurnClear(ctx, trips, {dir,to,stops:st}, st.at(-1)!.arr+minTurn(to), new Set())) continue;
        const incoming = dir === 'DN' ? 'UP' : 'DN';
        // a train brought in to front-turn for it arrives between the
        // trains of its own direction, up to 2 min before its turnback
        // time, and holds the departure platform until it leaves
        const front = turnbackAt(ctx.topo, from, incoming)?.kind === 'front';
        const arrives = (w: number) => {
          const arrival = { ...st[0], arr: t0 - minTurn(from) - w, dep: t0 - minTurn(from) - w };
          return frontTurnClear(ctx, trips, { dir: incoming, to: from, stops: [arrival] }, t0, new Set())
            && (!front || idx.clear([arrival], incoming));
        };
        if (!turn && ![0, 10, 20, 30, 40, 50, 60, 80, 100, 120].some(arrives)) continue;
        if (turn) {
          pairedWith = waitAt(from).splice(pair, 1)[0];
          paired.push({ st: from, from: pairedWith.stops.at(-1)!.arr, to: t0 });
        }
        return st;
      }
    }
    return null;
  };
  // A grid trip the base plan alone leaves no room for — no time within
  // half the overlay headway at which its whole path keeps the minimum
  // headway and its front turns at both ends stay clear of the base trains
  // (the peak and its build-up; 虹桥火车站's front turnback while the base
  // runs closer than ~5 min) — cannot be added without retiming the base
  // plan. It is not requested; it is reported as such, not counted as a
  // shortfall of the added-service planning (D47).
  const baseTrips = existing.filter(t => !t.overlay && !t.cancelled);
  const base = new DepIndex(baseTrips);
  const baseRoom = (dir: TrackDir, from: number, to: number, t: number) => {
    for (let k = -preset.headway / 2; k <= preset.headway / 2; k += 10) {
      const st = buildStops(ctx, dir, from, to, t + k, true, 1);
      if (!base.clear(st, dir) || !frontTurnClear(ctx, baseTrips, { dir, to, stops: st }, st.at(-1)!.arr + minTurn(to), new Set())) continue;
      const arrival = { ...st[0], arr: st[0].dep - minTurn(from), dep: st[0].dep - minTurn(from) };
      if (frontTurnClear(ctx, baseTrips, { dir: dir === 'DN' ? 'UP' : 'DN', to: from, stops: [arrival] }, st[0].dep, new Set())) return true;
    }
    return false;
  };
  // An end of the added section that is a front turnback (虹桥火车站) turns
  // a train on a through platform: the platform must stay free of the base
  // trains of both directions from ~90 s before the arrival to ~90 s after
  // the departure, ≥300 s, and the arrival must keep the headway of its own
  // direction. With the base running every 4.5–7 min both ways there is no
  // such time (D47). The added trains run on to the nearest station beyond
  // it with a rear turnback (国家会展中心) and turn there, still serving the
  // whole requested section.
  // An end with no turnback at all (虹桥火车站 since the PDF layout) is served the same way.
  const outward = (X: number, arrDir: TrackDir): number | undefined => {
    if (turnbackAt(ctx.topo, X, arrDir)?.kind === 'rear') return undefined;
    const step = arrDir === 'DN' ? 1 : -1;
    for (let Y = X + step; Y >= 0 && Y < ctx.topo.stations.length; Y += step)
      if (turnbackAt(ctx.topo, Y, arrDir)?.kind === 'rear') return Y;
    return undefined;
  };
  const terminals = new Set([a, b]);
  let skipped = 0;
  let requested = 0;
  let peak = 0;
  for (let t = preset.from; t <= preset.to; t += preset.headway) {
    for (const [dir, from, to, t0] of [[dirAB, a, b, t], [dirBA, b, a, t + preset.headway / 2]] as [TrackDir, number, number, number][]) {
      const back: TrackDir = dir === 'DN' ? 'UP' : 'DN';
      const ends: [number, number][] = [[outward(from, back) ?? from, outward(to, dir) ?? to]];
      // the departure time is the one at the requested origin
      const at = (o: number) => o === from ? t0 : t0 - (buildStops(ctx, dir, o, to, t0, true, 1).find(p => p.st === from)!.dep - t0);
      const room = ends.filter(([o, d]) => baseRoom(dir, o, d, at(o)));
      if (!room.length) { peak++; continue; }
      requested++;
      let st: PlanStop[] | null = null, end = room[0];
      for (const [o, d] of room) {
        st = fit(dir, o, d, at(o), true) ?? fit(dir, o, d, at(o), false);
        if (st) { end = [o, d]; break; }
      }
      if (!st) { skipped++; continue; }
      const trip = addTo(trips, dir, 'extra', end[0], end[1], st, true, tag);
      if (pairedWith) { pairedWith.next = trip.id; trip.prev = pairedWith.id; }
      idx.add(trip);
      waitAt(end[1]).push(trip);
      terminals.add(end[0]); terminals.add(end[1]);
    }
  }
  const reuse: OverlayReuse | undefined = live && { ...live, blocks: plan.blocks, extended: [] };
  const blocks = circulate(ctx, trips, [...terminals], [], tag, existing, plan.blocks.length, terminalOccupancy(plan), reuse);
  plan.blocks.push(...blocks);
  plan.overlays.push({ id: tag, label: preset.label, from: preset.from, to: preset.to, requested, peak });
  const maxSvc = Math.max(0, ...plan.blocks.filter((x) => x.svc).map((x) => parseInt(x.svc, 10)));
  numberPlan(plan, maxSvc + 1);
  plan.fleetPeak = fleetPeak(plan);
  // Fault cancellations change the available gaps and terminal occupancy.
  // Check complete added circulations after matching, including every point
  // inside a layover, rather than only the occupancy at its arrival event.
  const extended = reuse?.extended ?? [];
  const absorbed = reuse?.absorbed ?? [];
  /** a base duty taken over by the train of `block` goes back to its own train */
  const giveBack = (block: Block) => {
    for (const x of absorbed.filter(x => x.into === block.id)) {
      const own = plan.blocks[x.block];
      block.trips = block.trips.filter(id => !x.trips.includes(id));
      own.trips.push(...x.trips);
      for (const id of x.trips) trips[id].block = own.id;
      for (const id of x.lead) { trips[id].cancelled = false; delete trips[id].cancelReason; }
      own.end = x.end;
      absorbed.splice(absorbed.indexOf(x), 1);
    }
  };
  const added = (id: number) => blocks.some(b => b.id === id && b.trips.some(t => !trips[t].cancelled))
    || extended.some(x => x.block === id);
  for (let attempt = 0; attempt < blocks.length + extended.length; attempt++) {
    const issue = validatePlan(ctx, plan).find(i => i.blocks?.some(added));
    if (!issue) break;
    const reason = `加开能力不足：${issue.text}`;
    const x = extended.filter(e => issue.blocks!.includes(e.block)).at(-1);
    if (x) {
      // give the base train back its own withdrawal
      const block = plan.blocks[x.block];
      giveBack(block);
      for (const id of x.trips) cancelTrip(trips[id], reason);
      block.trips = block.trips.filter(id => !x.trips.includes(id));
      for (const id of x.tail) { trips[id].cancelled = false; delete trips[id].cancelReason; }
      block.end = x.end;
      extended.splice(extended.indexOf(x), 1);
    } else {
      const block = blocks.filter(b => issue.blocks!.includes(b.id) && b.trips.some(t => !trips[t].cancelled)).at(-1)!;
      giveBack(block);
      for (const id of block.trips) cancelTrip(trips[id], reason);
    }
    plan.fleetPeak = fleetPeak(plan);
  }
  // a move linked behind a cancelled arrival but never put in a block (its
  // withdrawal, after the trip it followed was dropped) does not run either
  for (const t of trips.slice(n0) as GenTrip[]) {
    const P = t.prev === undefined ? undefined : trips[t.prev];
    if (!t.cancelled && t.block < 0 && P?.cancelled) cancelTrip(t, P.cancelReason ?? '加开：前序车次取消');
  }
  const kept = trips.slice(n0).filter((t) => !t.cancelled);
  return { trips: kept.length, blocks: blocks.length, extended, skipped: skipped + trips.slice(n0).filter((t) => t.cancelled && t.revenue).length };
}

/** A standby train (备车) that can take over a duty: see `standbyCandidate`. */
export interface StandbyPlan { depot: number; k: number; start: number; dir: TrackDir; from: number; to: number; stops: PlanStop[] | null }

/**
 * Standby takeover (备车顶替, D45): the earliest trip of `tail` (trip ids of
 * one duty, in order, from index `minK`) that a spare vehicle leaving
 * `depot` no earlier than `notBefore` can start on time. The empty move
 * from the yard keeps the minimum headway to every other trip along its
 * whole path and leaves the declared turnback time at the origin.
 * Pure: the plan is not changed.
 */
export function standbyCandidate(ctx: PlanContext, plan: Plan, tail: number[], depot: number, notBefore: number, minK = 0, maxK = tail.length - 1): StandbyPlan | null {
  const { topo } = ctx;
  const own = new Set(tail);
  const index = new DepIndex(plan.trips.filter(t => !own.has(t.id)));
  for (let k = minK; k <= maxK && k < tail.length; k++) {
    const D = plan.trips[tail[k]];
    if (!D.revenue || D.completed) continue;
    const T = D.from;
    const dep = D.stops[0].dep;
    const dir: TrackDir = topo.stations[T].chain < topo.depots[depot].junctionChain ? 'UP' : 'DN';
    const ex = exitStation(topo, depot, dir);
    if (ex === T) {
      const start = depotStartTime(ctx, depot, D);
      if (start >= notBefore) return { depot, k, start, dir, from: ex, to: T, stops: null };
      continue;
    }
    // An origin passed in the same direction is joined on the move; an
    // opposite one is reached on the arrival platform and turned back.
    const same = dir === D.dir;
    const mt = same ? 0 : minTurn(T);
    const run = buildStops(ctx, dir, ex, T, dep, false, 1).at(-1)!.arr - dep;
    const latest = dep - mt - (same ? 0 : 60) - run;
    for (let step = 0; step <= 90; step++) {
      const stops = buildStops(ctx, dir, ex, T, latest - step * 10, false, 1);
      stops[0].stop = false;
      if (same) stops[stops.length - 1].stop = false;
      const start = depotStartTime(ctx, depot, { stops } as Trip);
      if (start < notBefore) break;
      if (stops.at(-1)!.arr > dep - mt + 1e-6 || !index.clear(stops, dir)) continue;
      if (!same && !frontTurnClear(ctx, plan.trips, { dir, to: T, stops }, dep, new Set([D.id]))) continue;
      return { depot, k, start, dir, from: ex, to: T, stops };
    }
  }
  return null;
}

/** Apply a standby takeover: trips `tail[k..]` move from duty `from` to a
 * new duty run by the standby, and are reinstated if their cancellation was
 * caused by losing the original train. Returns the new block. */
export function applyStandby(plan: Plan, from: number, tail: number[], c: StandbyPlan): Block {
  const trips = plan.trips as GenTrip[];
  const taken = tail.slice(c.k);
  const id = plan.blocks.length;
  const ids: number[] = [];
  if (c.stops) {
    const move = addTo(trips, c.dir, 'empty', c.from, c.to, c.stops.map(p => ({ ...p })), false);
    move.block = id;
    ids.push(move.id);
  }
  for (const t of taken) {
    const trip = trips[t];
    trip.block = id;
    trip.cancelled = false;
    delete trip.cancelReason;
    ids.push(t);
  }
  const old = plan.blocks[from];
  old.trips = old.trips.filter(t => !taken.includes(t));
  old.relieved = true;
  const block: Block = { id, svc: '', start: { kind: 'depot', depot: c.depot, time: c.start }, end: old.end, trips: ids };
  plan.blocks.push(block);
  const maxSvc = Math.max(0, ...plan.blocks.filter((x) => x.svc).map((x) => parseInt(x.svc, 10)));
  numberPlan(plan, maxSvc + 1);
  plan.fleetPeak = fleetPeak(plan);
  return block;
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
    if (!index.clear(out,dir)) continue;
    // Opposing streams need not have a usable slot exactly 240 seconds after
    // arrival. Search the permitted terminal layover; never hold ordinary stops.
    for(let wait=0;wait<=Math.max(0,(to===0||to===topo.stations.length-1?1500:450)-minTurn(to));wait+=10){
      const into = buildStops(ctx, back, to, en, out[out.length - 1].arr + minTurn(to)+wait, true, 1);
      if(index.clear(into,back)){s1=out;s2=into;break;}
    }
    if(s1.length)break;
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
  // a berth serves arrivals that keep their heading into it (eastbound berths for DN)
  const rear = s.turnbackBerths.filter((bid) => {
    const b = topo.berths[bid];
    const l = topo.links[b.link];
    const east = (l.chainB - l.chainA) * b.dir > 0;
    return arrDir === 'DN' ? east : !east;
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
    const fromDepot = k === 0 && block.start.kind === 'depot' && fromTrip === 0;
    if (fromDepot && block.start.kind === 'depot') portalExitTasks(topo, block.start.depot, trip, tasks);
    const first = tasks.length;
    tripTasks(topo, trip, tasks, fromDepot);
    // An explicit overnight berth fixes the departure platform as well as
    // the train's initial position (GLL middle track versus DN main).
    if (k === 0 && fromTrip === 0 && block.start.kind === 'stable' && block.start.berth !== undefined) {
      const departure = tasks.slice(first).find((t): t is StopTask => t.k === 'stop');
      if (departure) departure.berth = block.start.berth;
    }
    // after a hot standby: its departure stop (D70)
    const before = block.trips.slice(0, fromTrip + k).map((i) => plan.trips[i]).filter((t) => !t.cancelled).at(-1);
    const dep = tasks.slice(first).find((t): t is StopTask => t.k === 'stop');
    if (before?.standby && dep) dep.standby = true;
    const next = ids.slice(k + 1).map((i) => plan.trips[i]).find((t) => !t.cancelled);
    if (next) {
      if (next.dir !== trip.dir) addTurnback(topo, trip, tasks);
    }
    else if (block.end.kind === 'depot') depotTasks(topo, block.end.depot, trip.dir, tasks);
    else if (block.end.kind === 'stable') {
      if (block.end.berth !== undefined) {
        retargetArrival(tasks, trip.to, block.end.berth);
        tasks.push({ k: 'stable', berth: block.end.berth, reason: '存车', station: trip.to });
        continue;
      }
      const tb = turnbackAt(topo, trip.to, trip.dir);
      if (tb && tb.kind === 'rear' && !tailTasks(topo, plan, block, trip, tasks)) tasks.push({ k: 'stable', berth: -1, reason: '存车', station: trip.to });
    }
  }
  return tasks;
}

/**
 * The first trains stabled overnight at a terminal with a storage tail
 * (蟠祥路下行尾轨) go on into it, the first deepest: it is entered only from
 * the departure platform, so the train turns through a turnback track, changes
 * ends again on the departure platform and sets back into the tail. The last
 * ones stay in the turnback tracks, which they would otherwise block.
 * false: this train stays in a turnback track.
 */
function tailTasks(topo: Topology, plan: Plan, block: Block, trip: Trip, tasks: Task[]): boolean {
  const st = topo.stations[trip.to];
  const tb = turnbackAt(topo, trip.to, trip.dir);
  if (!st.storageBerths.length || tb?.kind !== 'rear') return false;
  const lastArr = (b: Block) => plan.trips[b.trips.filter((id) => !plan.trips[id].cancelled).at(-1)!].stops.at(-1)!.arr;
  const ending = plan.blocks.filter((b) => b.end.kind === 'stable' && b.end.station === trip.to && b.trips.some((id) => !plan.trips[id].cancelled))
    .sort((a, b) => lastArr(a) - lastArr(b));
  const rank = ending.indexOf(block);
  if (rank < 0 || rank >= Math.min(st.storageBerths.length, ending.length - st.turnbackBerths.length)) return false;
  const plat = platformBerth(topo, trip.to, trip.dir === 'DN' ? 'UP' : 'DN');
  tasks.push({ k: 'reverse', berths: tb.berths, chosen: tb.berths[0], station: trip.to, minTime: 40 });
  tasks.push({ k: 'stop', berth: plat, station: trip.to, trip: -1, arr: null, dep: null, doors: false, revenue: false, note: '入尾轨换端' });
  tasks.push({ k: 'reverse', berths: [plat], chosen: plat, station: trip.to, minTime: 40 });
  tasks.push({ k: 'stable', berth: st.storageBerths[st.storageBerths.length - 1 - rank], reason: '存车' });
  return true;
}

/** A move out of the depot reaching its first platform against the trip's
 * direction stops there and changes ends before the trip starts. */
function portalExitTasks(topo: Topology, depot: number, trip: Trip, tasks: Task[]) {
  const p = topo.depots[depot].portals.exit[trip.dir];
  if (!p.reverse) return;
  const plat = topo.stations[p.station].platforms[trip.dir];
  const travel = trip.dir === 'DN' ? 1 : -1;
  const berth = topo.berths.find((b) => b.platform === plat && b.dir !== travel)!.id;
  tasks.push({ k: 'stop', berth, station: p.station, trip: trip.id, arr: null, dep: null, doors: false, revenue: false, note: '出段换端' });
  tasks.push({ k: 'reverse', berths: [berth], chosen: berth, station: p.station, minTime: 40 });
  // then stand at the platform in the trip's direction (as after a station-front
  // turnback) unless the trip itself stops there first
  const first = trip.stops[0];
  if (!(first.st === p.station && first.stop)) {
    const dep = trip.stops.find((x) => x.st === p.station)?.dep ?? first.dep;
    tasks.push({ k: 'stop', berth: platformBerth(topo, p.station, trip.dir), station: p.station, trip: trip.id, arr: null, dep, doors: false, revenue: false, note: '出段换端' });
  }
}

/** Into `depot` after running `dir`: where the leads are entered against that
 * direction the train first changes ends on the junction station's platform. */
export function depotTasks(topo: Topology, depot: number, dir: TrackDir, tasks: Task[]) {
  const p = topo.depots[depot].portals.entry[dir];
  if (p.reverse) {
    const berth = platformBerth(topo, p.station, dir);
    const last = tasks[tasks.length - 1];
    if (!(last?.k === 'stop' && last.station === p.station && last.berth === berth)) {
      tasks.push({ k: 'stop', berth, station: p.station, trip: -1, arr: null, dep: null, doors: false, revenue: false, note: '回段换端' });
    }
    tasks.push({ k: 'reverse', berths: [berth], chosen: berth, station: p.station, minTime: 40 });
  }
  tasks.push({ k: 'depot', depot, berth: topo.depots[depot].entryBerths[p.path] });
}

export function tripTasks(topo: Topology, trip: Trip, tasks: Task[], fromDepot: boolean) {
  for (let i = 0; i < trip.stops.length; i++) {
    const s = trip.stops[i];
    if (!s.stop) continue;
    const isFirst = i === 0;
    tasks.push({
      k: 'stop', berth: platformBerth(topo, s.st, trip.dir), station: s.st, trip: trip.id,
      arr: isFirst && !fromDepot ? null : s.arr, dep: i === trip.stops.length - 1 ? null : s.dep,
      doors: trip.revenue, revenue: trip.revenue, ...(s.noBoard ? { noBoard: true } : {}),
    });
  }
}

export function addTurnback(topo: Topology, trip: Trip, tasks: Task[]) {
  const tb = turnbackAt(topo, trip.to, trip.dir);
  if (!tb) return;
  if (tb.kind === 'rear') {
    // a platform turnback track (广兰路 middle track): set down there, not on the main
    if (topo.berths[tb.berths[0]].kind === 'platform') retargetArrival(tasks, trip.to, tb.berths[0]);
    tasks.push({ k: 'reverse', berths: tb.berths, chosen: tb.berths[0], station: trip.to, minTime: 40 });
  } else {
    // station-front: retarget the arrival stop to the opposite platform
    retargetArrival(tasks, trip.to, tb.arrBerth);
    tasks.push({ k: 'reverse', berths: [tb.arrBerth], chosen: tb.arrBerth, station: trip.to, minTime: 40 });
  }
}

function retargetArrival(tasks: Task[], station: number, berth: number) {
  for (let i = tasks.length - 1; i >= 0; i--) {
    const t = tasks[i];
    if (t.k === 'stop' && t.station === station) { t.berth = berth; break; }
  }
}

/** A train that reversed at a platform berth departs from that platform: the
 * berth facing its new direction on the same platform, if it differs from the
 * planned one (广兰路 middle track instead of the UP main). */
export function departureBerthAfterReverse(topo: Topology, reversedAt: number, planned: number): number {
  const b = topo.berths[reversedAt];
  if (b.kind !== 'platform' || topo.berths[planned].platform === b.platform) return planned;
  return topo.berths.find((x) => x.platform === b.platform && x.dir !== b.dir)?.id ?? planned;
}

// ---------------------------------------------------------------- validation

export interface PlanIssue {
  /** Circulations contributing to this conflict; used by pure overlay fitting. */
  blocks?: number[];
  severity: 'error' | 'warn';
  code: 'TURN_SHORT' | 'BLOCK_BREAK' | 'TERMINAL_FULL' | 'TAIL_ORDER' | 'FRONT_CONFLICT' | 'LAYOVER_LONG' | 'DEPOT_CONFLICT' | 'HEADWAY' | 'FLEET' | 'TIME_ORDER' | 'UNASSIGNED' | 'STABLE_CONFLICT';
  t: number;
  text: string;
}

/** shortest turnback the line can do (s): P1 table 1, CBTC 115–120 s */
/** shortest station headway (s), a hard planning limit: P1 table 1, CBTC
 *  design headway ≤ 90 s. The headways the templates aim for (D50) are wider. */
const MIN_HEADWAY = 90;

/** A front turn occupies the opposite platform from arrival to departure.
 * Its timetable slot must protect normal-direction arrivals through that
 * platform as well as the incoming train's own departure stream. */
function frontTurnClear(ctx: PlanContext, trips: Trip[], arrival: Pick<Trip, 'dir' | 'to' | 'stops'>, departure: number, excluded: Set<number>): boolean {
  if (turnbackAt(ctx.topo, arrival.to, arrival.dir)?.kind !== 'front') return true;
  const arr = arrival.stops.at(-1)!.arr;
  return !trips.some(trip => !trip.cancelled && !excluded.has(trip.id) && trip.dir !== arrival.dir
    && trip.stops.some(stop => stop.st === arrival.to && stop.dep > arr - MIN_HEADWAY && stop.arr < departure + MIN_HEADWAY));
}

/** A single rear turnback dispatches its trains in arrival order (TAIL_ORDER):
 * may a train stand in it over [from, to) among the others in `occ`? */
function tailOrderClear(topo: Topology, st: number, occ: { from: number; to: number; block?: number }[], from: number, to: number, own?: number): boolean {
  if (topo.stations[st].turnbackBerths.length !== 1) return true;
  return occ.every(o => o.block === own || !(o.from < from && o.to > to + .01) && !(o.from > from && o.to < to - .01));
}

/** time a train held on a line end's arrival platform needs to move on
 *  into the turnback track once a place there is free */
const HOLD_CLEAR = 120;

/**
 * Moments a terminal holds more trains than it can. TERMINAL_CAP keeps the
 * arrival platform free; at a line end (every train arriving there
 * terminates) one more may stand on it, provided the next arrival comes
 * HOLD_CLEAR after a place has freed up for it.
 */
export function terminalOverflows(topo: Topology, st: number, list: { from: number; to: number }[]): { t: number; cur: number; cap: number }[] {
  const cap = TERMINAL_CAP[st] ?? (topo.stations[st].turnbackBerths.length || 1);
  const lineEnd = st === 0 || st === topo.stations.length - 1;
  const evs = list.flatMap((o) => [[o.from, 1], [o.to, -1]] as [number, number][]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: { t: number; cur: number; cap: number }[] = [];
  let cur = 0;
  let held = -Infinity; // when the train held on the arrival platform can move on
  for (const [t, dlt] of evs) {
    if (dlt > 0 && lineEnd && (cur > cap || (cur === cap && t < held))) out.push({ t, cur: cur + 1, cap });
    cur += dlt;
    if (!lineEnd && cur > cap) out.push({ t, cur, cap });
    if (lineEnd && dlt < 0 && cur === cap) held = t + HOLD_CLEAR;
  }
  return out;
}

/** time intervals trains spend turning back / laying over at each station (between two trips in opposite directions) */
export function terminalOccupancy(plan: Plan): Map<number, { from: number; to: number; block: number }[]> {
  const occ = new Map<number, { from: number; to: number; block: number }[]>();
  for (const b of plan.blocks) {
    const ts = b.trips.map((i) => plan.trips[i]).filter((t) => !t.cancelled);
    for (let i = 0; i + 1 < ts.length; i++) {
      const a = ts[i];
      const d = ts[i + 1];
      if (a.to !== d.from || a.dir === d.dir) continue;
      if (!occ.has(a.to)) occ.set(a.to, []);
      occ.get(a.to)!.push({ from: a.stops[a.stops.length - 1].arr, to: d.stops[0].dep, block: b.id });
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
  // Line stabling (正线存车) must hold as many trains at night as leave it in
  // the morning, or the next day starts a train short.
  for (const [id, n] of Object.entries(OPERATIONS.lineStabling)) {
    const st = STATIONS.findIndex(x => x.id === id);
    const night = plan.blocks.filter(b => b.end.kind === 'stable' && b.end.station === st).length;
    const morning = plan.blocks.filter(b => b.start.kind === 'stable' && b.start.station === st).length;
    if (night !== n || morning !== n)
      out.push({ severity: 'warn', code: 'FLEET', t: H(4), blocks: [], text: `${name(st)} 正线存车 ${n} 列：夜间入位 ${night} 列，早晨出车 ${morning} 列` });
  }
  // Explicit overnight stabling on a main platform reserves that track from
  // the evening arrival through the following day's departure. Check both
  // today's early movements and tomorrow's via a 24-hour shift, empty or not.
  for (const block of plan.blocks) {
    if (block.end.kind !== 'stable' || block.end.berth === undefined) continue;
    const berth = topo.berths[block.end.berth];
    if (berth.platform !== topo.stations[block.end.station].platforms.DN) continue;
    const station = block.end.station;
    const stableBerth = block.end.berth;
    const last = block.trips.map(id => plan.trips[id]).filter(t => !t.cancelled).at(-1)!;
    if (!last) continue;
    const arrived = last.stops.at(-1)!.arr;
    const morning = plan.blocks.find(b => b.start.kind === 'stable' && b.start.station === station && b.start.berth === stableBerth);
    const first = morning?.trips.map(id => plan.trips[id]).find(t => !t.cancelled);
    const departure = first?.stops[0].dep ?? H(6);
    for (const trip of live) {
      if (trip.dir !== 'DN' || trip === last || trip === first) continue;
      const stop = trip.stops.find(s => s.st === station);
      // A DN positioning trip ending on the middle track uses the west
      // throat and never passes/occupies the DN main platform.
      const duty = plan.blocks[trip.block];
      const next = duty && plan.trips[duty.trips[duty.trips.indexOf(trip.id) + 1]];
      if (trip.to === station && next?.dir === 'UP' && turnbackAt(topo, station, 'DN')?.kind === 'rear') continue;
      if (stop && (stop.dep >= arrived - MIN_HEADWAY || stop.arr < departure + MIN_HEADWAY))
        out.push({ severity: 'error', code: 'STABLE_CONFLICT', t: stop.arr, blocks: [block.id, trip.block], text: `${name(station)} 下行正线存车与 ${trip.no}（${trip.revenue ? '载客' : '空驶'}）冲突` });
    }
  }
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
      if (a.dir !== d.dir && dep - arr < minTurn(a.to) - 1e-6) out.push({ severity: 'error', code: 'TURN_SHORT', t: arr, text: `车底 ${b.svc} 在 ${name(a.to)} 折返仅 ${(dep - arr).toFixed(1)} s（${a.no}→${d.no}，最小 ${minTurn(a.to)} s）` });
      if (a.dir !== d.dir && !frontTurnClear(ctx, live, a, dep, new Set(ts.map(trip => trip.id))))
        out.push({severity:'error',code:'FRONT_CONFLICT',t:arr,blocks:[b.id],text:`${name(a.to)} 站前折返占用时段与正常方向列车冲突`});
      if (a.overlay && a.dir !== d.dir && a.to > 0 && a.to < topo.stations.length - 1 && dep-arr > minTurn(a.to)+450+.01)
        out.push({severity:'error',code:'LAYOVER_LONG',t:arr,blocks:[b.id],text:`${name(a.to)} 加开接续等待超过中间折返站能力`});
    }
  }
  for (const [st, list] of occ) {
    // A single rear turnback cannot dispatch its second arrival before its
    // first: the first would have to hold either the tail or the exit platform.
    if (topo.stations[st].turnbackBerths.length === 1) {
      const ordered = list.slice().sort((a,b) => a.from-b.from);
      for (let i=1;i<ordered.length;i++) if (ordered[i-1].to > ordered[i].to + .01)
        out.push({severity:'error',code:'TAIL_ORDER',t:ordered[i].from,blocks:[ordered[i-1].block,ordered[i].block],text:`${name(st)} 单一折返线到达次序与发车次序相反`});
    }
    let reported = -Infinity;
    for (const { t, cur, cap } of terminalOverflows(topo, st, list)) {
      if (t - reported <= 1800) continue;
      reported = t;
      const blocks = plan.blocks.filter(block => {
        const ts = block.trips.map(id => plan.trips[id]).filter(trip => !trip.cancelled);
        return ts.some((a,i) => { const d = ts[i+1]; return d && a.to === st && d.from === st && a.dir !== d.dir
          && a.stops.at(-1)!.arr <= t && d.stops[0].dep > t; });
      }).map(block => block.id);
      out.push({ severity: 'error', code: 'TERMINAL_FULL', t, blocks, text: `${name(st)} 同时折返/待发 ${cur} 列，超过能力 ${cap} 列` });
    }
  }
  // BZL/CSD share their conversion track. A returning added train receives
  // physical priority inside 1500 m; reserve that approach and its low-speed
  // entry against planned yard exits, rather than delaying a peak origin.
  // LYD's independent inbound/outbound tracks have no such conflict.
  for (const depot of topo.depots) {
    if (!sharedLead(topo, depot.id)) continue;
    const exits = plan.blocks.filter(b => b.start.kind==='depot' && b.start.depot===depot.id
      && b.trips.some(id => !plan.trips[id].cancelled));
    for (const inbound of plan.blocks) {
      if (inbound.end.kind!=='depot' || inbound.end.depot!==depot.id) continue;
      const trips = inbound.trips.map(id => plan.trips[id]).filter(trip => !trip.cancelled);
      const last = trips.at(-1);if (!last) continue;
      const [approach, clear] = inboundWindow(topo, depot.id, last);
      for (const outbound of exits) {
        if (outbound===inbound || outbound.start.kind!=='depot') continue;
        // the exit or the return itself is an added move (a base circulation
        // extended into added trips still left the yard as planned)
        const added = last.overlay || plan.trips[outbound.trips.find(id => !plan.trips[id].cancelled)!].overlay;
        if (added && outbound.start.time < clear && outbound.start.time+depot.exitTime > approach)
          out.push({severity:'error',code:'DEPOT_CONFLICT',t:Math.max(approach,outbound.start.time),blocks:[inbound.id,outbound.id],
            text:`${depot.name} 加开回段接近与图定出段共用转换轨时隙冲突`});
      }
    }
  }
  // station headways per direction (passing / departing)
  for (const dir of ['DN', 'UP'] as TrackDir[]) {
    const byStation = new Map<number, { t: number; no: string; block: number }[]>();
    for (const t of live) {
      if (t.dir !== dir) continue;
      for (const s of t.stops) {
        const block = plan.blocks[t.block];
        const next = block && plan.trips[block.trips[block.trips.indexOf(t.id) + 1]];
        if (s === t.stops.at(-1) && next?.dir === t.dir && next.from === s.st) continue;
        if (!byStation.has(s.st)) byStation.set(s.st, []);
        byStation.get(s.st)!.push({ t: s.dep, no: t.no, block: t.block });
      }
    }
    for (const [st, list] of byStation) {
      list.sort((a, b) => a.t - b.t);
      let reported = -Infinity;
      for (let i = 1; i < list.length; i++) {
        const h = list[i].t - list[i - 1].t;
        if (h < MIN_HEADWAY && list[i].t - reported > 1800) {
          reported = list[i].t;
          // the design headway is the hard limit: a plan below it cannot run
          // to time (the operating headways the templates keep are far wider)
          out.push({ severity: 'error', code: 'HEADWAY', t: list[i].t, blocks: [list[i-1].block,list[i].block], text: `${name(st)} ${dir === 'DN' ? '下行' : '上行'} ${list[i - 1].no}/${list[i].no} 间隔 ${Math.round(h)} s（最小 ${MIN_HEADWAY} s）` });
        }
      }
    }
  }
  if (plan.fleetPeak > LINE_INFO.fleet) out.push({ severity: 'error', code: 'FLEET', t: 0, text: `用车 ${plan.fleetPeak} 列，超过配属 ${LINE_INFO.fleet} 列` });
  return out.sort((a, b) => a.t - b.t);
}
