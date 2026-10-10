/**
 * Train performance model (8-car A-type, approximations) and the planning
 * run-time calculator. The same controller drives simulated trains and the
 * run-time pre-computation, so planned times are achievable in the sim.
 */
import type { Topology } from './topology';

export const PERF = {
  /** max traction acceleration at low speed (m/s²) */
  aMax: 1.0,
  /** speed at which constant-power region starts (m/s) */
  vBase: 11,
  /** max service brake (m/s²) */
  bService: 1.0,
  /** braking rate used by ATO planning (comfort) */
  bPlan: 0.75,
  /** guaranteed emergency brake used by ATP curves */
  bEbGuaranteed: 0.95,
  /** actual emergency brake */
  bEb: 1.25,
  /** RM speed ceiling (25 km/h) */
  vRM: 25 / 3.6,
  /** coupling approach speed */
  vCouple: 3 / 3.6,
  /** ATO margin below permitted speed (m/s) */
  atoMargin: 3 / 3.6,
  /** ATP overspeed tolerance before EB (m/s) */
  atpTolerance: 5 / 3.6,
  /** running resistance when coasting */
  resist: 0.03,
};

export function tractionAccel(v: number): number {
  return v < PERF.vBase ? PERF.aMax : (PERF.aMax * PERF.vBase) / v;
}

/** Speed allowed at the current point given a constraint `d` metres ahead with end speed vEnd. */
export function brakingSpeed(d: number, vEnd: number, b: number): number {
  if (d <= 0) return vEnd;
  return Math.sqrt(vEnd * vEnd + 2 * b * d);
}

/** ATO / driver controller: returns commanded acceleration. */
export function controlAccel(v: number, vTarget: number, stopDist: number): number {
  // precision stop: follow the braking parabola to the stopping point
  if (stopDist < 60 && stopDist >= 0) {
    const need = (v * v) / (2 * Math.max(0.05, stopDist));
    if (need > PERF.bPlan * 0.92) return -Math.min(PERF.bService, need);
  }
  const err = vTarget - v;
  if (err > 0.25) return Math.min(tractionAccel(v), err * 1.2 + 0.15);
  if (err < -0.05) return -Math.min(PERF.bService, Math.max(0.15, -err * 1.6));
  return v > 0.1 ? -PERF.resist : 0;
}

// ---------------------------------------------------------------- planning run times

export interface RunTimes {
  /** stop-to-stop run time from station i to i+1 eastbound (DN) */
  dn: number[];
  /** stop-to-stop run time from station i+1 to i westbound (UP) */
  up: number[];
  /** pass-through times between station centres (non-stopping runs) */
  passDn: number[];
  passUp: number[];
}

interface LimitSeg { from: number; to: number; v: number }

function trackProfile(topo: Topology, track: 'DN' | 'UP'): LimitSeg[] {
  return topo.links
    .filter((l) => l.track === track)
    .map((l) => ({ from: Math.min(l.chainA, l.chainB), to: Math.max(l.chainA, l.chainB), v: l.limit / 3.6 }))
    .sort((a, b) => a.from - b.from);
}

/** limit (m/s) at chainage */
function limitAt(prof: LimitSeg[], ch: number): number {
  let lo = 0;
  let hi = prof.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (prof[m].from <= ch) lo = m; else hi = m - 1;
  }
  return prof[lo].v;
}

/**
 * Simulate a run along a main track in direction sgn from chainage `start`
 * (standstill) to `end` (standstill if stopAtEnd). Returns elapsed seconds.
 * `marks` are chainages where the pass time is recorded.
 */
function simulateRun(prof: LimitSeg[], sgn: 1 | -1, start: number, end: number, trainLen: number, stopAtEnd: boolean, marks: number[] = []): { t: number; markTimes: number[] } {
  const dt = 0.1;
  let x = start;
  let v = 0;
  let t = 0;
  const markTimes: number[] = marks.map(() => NaN);
  const totalDist = Math.abs(end - start);
  let travelled = 0;
  while (travelled < totalDist - 0.05 || (stopAtEnd && v > 0.01)) {
    // current limit: min over body
    let vLim = Infinity;
    for (let k = 0; k <= trainLen; k += 25) vLim = Math.min(vLim, limitAt(prof, x - sgn * k));
    vLim = Math.min(vLim, limitAt(prof, x - sgn * trainLen));
    // look ahead up to 600 m for lower limits
    let vT = vLim - PERF.atoMargin;
    for (let d = 10; d <= 600; d += 10) {
      const lim = limitAt(prof, x + sgn * d) - PERF.atoMargin;
      vT = Math.min(vT, brakingSpeed(d - 5, lim, PERF.bPlan));
    }
    const remaining = totalDist - travelled;
    let stopDist = Infinity;
    if (stopAtEnd) {
      stopDist = remaining;
      vT = Math.min(vT, brakingSpeed(remaining - 0.3, 0, PERF.bPlan));
    }
    const a = controlAccel(v, Math.max(0, vT), stopDist);
    v = Math.max(0, v + a * dt);
    const ds = v * dt;
    travelled += ds;
    x += sgn * ds;
    t += dt;
    for (let i = 0; i < marks.length; i++) {
      if (Number.isNaN(markTimes[i]) && (sgn > 0 ? x >= marks[i] : x <= marks[i])) markTimes[i] = t;
    }
    if (stopAtEnd && remaining < 0.5 && v < 0.5) break;
    if (t > 3600) break;
  }
  return { t, markTimes };
}

export function computeRunTimes(topo: Topology, trainLen: number): RunTimes {
  const ch = topo.stations.map((s) => s.chain);
  const n = ch.length;
  const half = trainLen / 2;
  const profDn = trackProfile(topo, 'DN');
  const profUp = trackProfile(topo, 'UP');
  const dn: number[] = [];
  const up: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    dn.push(simulateRun(profDn, 1, ch[i] + half, ch[i + 1] + half, trainLen, true).t);
    up.push(simulateRun(profUp, -1, ch[i + 1] - half, ch[i] - half, trainLen, true).t);
  }
  const passD = simulateRun(profDn, 1, ch[0], ch[n - 1], trainLen, false, ch).markTimes;
  const passU = simulateRun(profUp, -1, ch[n - 1], ch[0], trainLen, false, [...ch].reverse()).markTimes.reverse();
  const passDn: number[] = [];
  const passUp: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    passDn.push(Math.max(20, (passD[i + 1] || 0) - (passD[i] || 0)));
    passUp.push(Math.max(20, (passU[i] || 0) - (passU[i + 1] || 0)));
  }
  // planning margin (运行图冗余) ≈ 8 % + 3 s
  const pad = (a: number[]) => a.map((t) => Math.round(t * 1.08 + 3));
  return { dn: pad(dn), up: pad(up), passDn: pad(passDn), passUp: pad(passUp) };
}
