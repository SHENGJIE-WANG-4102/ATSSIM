/**
 * Simple passenger model: per-platform waiting queues fed by a time-of-day
 * demand profile, boarding/alighting at stops driving dwell time, crowding
 * and passenger surges (大客流).
 */
import type { Sim } from './engine';
import type { StopTask, Train } from './model';
import { STATIONS, LINE_INFO } from '../data/line2';
import { callCrowd } from './radio';

const WEEKDAY: [number, number][] = [
  [4.5, 0], [5.4, 0.12], [6.2, 0.45], [6.9, 1.1], [7.5, 1.8], [8.1, 2.2], [8.8, 1.9], [9.6, 1.0], [11, 0.75], [13, 0.8],
  [16, 0.9], [17.2, 1.6], [18, 2.1], [18.8, 1.7], [19.8, 1.0], [21, 0.6], [22.5, 0.35], [23.5, 0.15], [24.5, 0],
];
const WEEKEND: [number, number][] = [
  [4.5, 0], [5.4, 0.1], [7, 0.4], [9, 0.9], [10.5, 1.15], [14, 1.2], [17, 1.25], [19, 1.1], [21, 0.7], [22.5, 0.4], [23.5, 0.15], [24.5, 0],
];

/** passengers per second per platform at demand weight 1 and profile 1 */
const BASE_RATE = 0.42;

export function demandProfile(sim: Sim, t: number): number {
  const prof = sim.plan.dayType === 'weekday' ? WEEKDAY : WEEKEND;
  const h = t / 3600;
  for (let i = 0; i + 1 < prof.length; i++) {
    if (h >= prof[i][0] && h < prof[i + 1][0]) {
      const k = (h - prof[i][0]) / (prof[i + 1][0] - prof[i][0]);
      return prof[i][1] + k * (prof[i + 1][1] - prof[i][1]);
    }
  }
  return 0;
}

/** per second update of waiting passengers */
export function passengersTick(sim: Sim, dt: number) {
  const prof = demandProfile(sim, sim.t);
  const { topo } = sim;
  for (const p of topo.platforms) {
    const ps = sim.plat[p.id];
    const st = STATIONS[p.station];
    // no boarding demand towards the line end
    const towardsEnd = (p.track === 'DN' && p.station === STATIONS.length - 1) || (p.track === 'UP' && p.station === 0);
    if (towardsEnd) { ps.waiting = 0; continue; }
    const lambda = BASE_RATE * st.demand * prof * ps.surge;
    const inflow = lambda * dt * (0.85 + 0.3 * sim.rng());
    if (ps.limitUntil > sim.t) {
      // station inflow control (限流): part of the demand is held outside the station
      ps.waiting += inflow * 0.6;
      sim.metrics.limited += inflow * 0.4;
    } else ps.waiting += inflow;
    if (ps.waiting > 1200 && !sim.alarms.has(`crowd-${p.station}`)) {
      sim.log('B', '客流', `${st.name} 站台客流拥挤（候车约 ${Math.round(ps.waiting)} 人）`, { key: `crowd-${p.station}` });
      callCrowd(sim, p.station, ps.waiting);
    } else if (ps.waiting < 600 && sim.alarms.has(`crowd-${p.station}`)) {
      const other = topo.stations[p.station].platforms;
      if (sim.plat[other.DN].waiting < 600 && sim.plat[other.UP].waiting < 600) sim.clearAlarm(`crowd-${p.station}`);
    }
  }
}

/** board/alight at a stop; returns the dwell (s) needed for the exchange */
export function boardAndAlight(sim: Sim, tr: Train, platform: number, task: StopTask): number {
  const { topo } = sim;
  const p = topo.platforms[platform];
  const ps = sim.plat[platform];
  const st = p.station;
  const dirDN = p.track === 'DN';
  // alighting share: this station's weight among this and the remaining stations
  let rem = 0;
  for (let i = st; dirDN ? i < STATIONS.length : i >= 0; i += dirDN ? 1 : -1) rem += STATIONS[i].demand;
  const isEnd = task.dep === null;
  const alightFrac = isEnd ? 1 : Math.min(1, (STATIONS[st].demand / Math.max(0.1, rem)) * 1.4);
  const alight = Math.round(tr.load * alightFrac);
  tr.load -= alight;
  let board = 0;
  if (!isEnd && task.revenue) {
    const room = Math.max(0, LINE_INFO.crushCapacity - tr.load);
    board = Math.min(Math.floor(ps.waiting), room);
    ps.waiting -= board;
    tr.load += board;
    ps.stranded = Math.floor(ps.waiting);
  }
  sim.passengersServed += board;
  const crowded = tr.load > LINE_INFO.capacity * 0.95;
  const rate = 40 * (crowded ? 0.55 : 0.9);
  let dwell = 12 + (alight + board) / rate;
  if (crowded) dwell += 8;
  // a surge (大客流) at the platform: boarding takes longer still
  if (ps.surge > 1) dwell += Math.min(30, (ps.surge - 1) * 6);
  return Math.min(ps.surge > 1 ? 150 : 90, dwell);
}
