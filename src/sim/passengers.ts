/**
 * Simple passenger model: per-platform waiting queues fed by a time-of-day
 * demand profile, boarding/alighting at stops driving dwell time, crowding
 * and passenger surges (大客流).
 */
import type { Sim } from './engine';
import type { StopTask, Train } from './model';
import { STATIONS, LINE_INFO } from '../data/line2';
import { callCrowd } from './radio';

import { profile, boardingDemand, passengerMinimum, RIDERSHIP_TARGET } from './calibration';

// Assumption: directional boarding demand starts 15 minutes before the first
// usable train. A closed service cannot accumulate hours of rush-hour demand
// before that direction's first train reaches an outer station.
const serviceWindows = new WeakMap<Sim, { rev: number; trips: Sim['plan']['trips']; first: number[]; last: number[] }>();
function boardingWindows(sim: Sim) {
  let windows = serviceWindows.get(sim);
  if (!windows || windows.rev !== sim.planRev || windows.trips !== sim.plan.trips) {
    const first = sim.topo.platforms.map(() => Infinity);
    const last = sim.topo.platforms.map(() => -Infinity);
    for (const trip of sim.plan.trips) if (trip.revenue && !trip.cancelled)
      for (let i = 0; i < trip.stops.length - 1; i++) {
        const stop = trip.stops[i];
        if (!stop.stop) continue;
        const platform = sim.topo.stations[stop.st].platforms[trip.dir];
        first[platform] = Math.min(first[platform], stop.dep - 900);
        last[platform] = Math.max(last[platform], stop.dep);
      }
    windows = { rev: sim.planRev, trips: sim.plan.trips, first, last };
    serviceWindows.set(sim, windows);
  }
  return windows;
}

export function demandProfile(sim: Sim, t: number): number { return profile(sim.plan.dayType, t); }

/** Integrate the base service windows once. Persist the scale in checkpoints:
 * cancelling service during faults must not redistribute that lost demand. */
function scaleFor(sim: Sim): number {
  if (sim.passengerScale > 0) return sim.passengerScale;
  const windows = boardingWindows(sim);
  let total = 0;
  for (const p of sim.topo.platforms) {
    if ((p.track === 'DN' && p.station === STATIONS.length - 1) || (p.track === 'UP' && p.station === 0)) continue;
    for (let t = windows.first[p.id]; t < windows.last[p.id]; t += 60)
      total += boardingDemand(sim.plan.dayType, p.station, p.track as 'DN' | 'UP', t + 30) * Math.min(60, windows.last[p.id] - t);
  }
  sim.passengerScale = RIDERSHIP_TARGET[sim.plan.dayType] / Math.max(1, total);
  return sim.passengerScale;
}

/** per second update of waiting passengers */
export function passengersTick(sim: Sim, dt: number) {
  const scale = scaleFor(sim);
  const { topo } = sim;
  const windows = boardingWindows(sim);
  for (const p of topo.platforms) {
    const ps = sim.plat[p.id];
    const st = STATIONS[p.station];
    // no boarding demand towards the line end
    const towardsEnd = (p.track === 'DN' && p.station === STATIONS.length - 1) || (p.track === 'UP' && p.station === 0);
    if (towardsEnd) { ps.waiting = 0; continue; }
    const lambda = scale * boardingDemand(sim.plan.dayType, p.station, p.track as 'DN' | 'UP', sim.t) * ps.surge;
    const inflow = lambda * dt * (0.85 + 0.3 * sim.rng());
    if (sim.t < windows.first[p.id]) { ps.waiting = 0; continue; }
    if (sim.t > windows.last[p.id]) continue;
    sim.ridership.generated += inflow;
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
  const alightFrac = isEnd ? 1 : Math.min(1, (STATIONS[st].demand / Math.max(0.1, rem)));
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
  const hour = Math.min(27, Math.floor(sim.t / 3600));
  sim.ridership.boardings[st][hour] += board;
  sim.ridership.alightings[st][hour] += alight;
  sim.ridership.maxLoad = Math.max(sim.ridership.maxLoad, tr.load);
  const h = sim.t / 3600;
  if (sim.plan.dayType === 'weekday' && st >= 4 && st <= 22 && ((h >= 6.8333 && h < 9.5) || (h >= 16.8333 && h < 19.5)))
    sim.ridership.peakSectionLoad = Math.max(sim.ridership.peakSectionLoad, tr.load);
  return passengerMinimum(board, alight, tr.load > LINE_INFO.capacity * .95, ps.surge);
}
