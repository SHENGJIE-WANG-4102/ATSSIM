/**
 * Depot yards (车场): stabling tracks holding real vehicle numbers. A
 * train leaving a depot takes the front vehicle of the best track; an
 * arriving train is stabled at the back of the emptiest track.
 */
import type { Sim } from './engine';
import type { YardState } from './model';
import { LINE_INFO } from '../data/line2';

export function vehicleName(i: number): string {
  return `02${String(i).padStart(2, '0')}`;
}

/** distribute the initial depot stock (vehicle numbers in order) over the stabling tracks */
export function initYards(sim: Sim, stock: number[], firstVehicle: number): YardState[] {
  let v = firstVehicle;
  return sim.topo.depots.map((d, i) => {
    const perTrack = Math.max(1, Math.ceil(d.capacity / d.stablingTracks));
    const tracks: string[][] = Array.from({ length: d.stablingTracks }, () => []);
    // fill tracks round-robin so every track has its first slot used before doubling up
    for (let k = 0; k < stock[i]; k++) {
      const t = tracks.reduce((best, tr, idx) => (tr.length < tracks[best].length ? idx : best), 0);
      tracks[t].push(vehicleName(v));
      v = (v % LINE_INFO.fleet) + 1;
    }
    return { tracks, perTrack };
  });
}

export function yardCount(y: YardState): number {
  let n = 0;
  for (const t of y.tracks) n += t.length;
  return n;
}

/** take the vehicle at the front of the fullest track (the one prepared longest); null if empty */
export function takeVehicle(sim: Sim, depot: number): string | null {
  const y = sim.yards[depot];
  let best = -1;
  for (let i = 0; i < y.tracks.length; i++) {
    if (!y.tracks[i].length) continue;
    if (best < 0 || y.tracks[i].length > y.tracks[best].length) best = i;
  }
  if (best < 0) return null;
  const v = y.tracks[best].shift()!;
  sim.depotStock[depot] = yardCount(y);
  return v;
}

/** stable a vehicle at the back of the emptiest track */
export function putVehicle(sim: Sim, depot: number, vehicle: string) {
  const y = sim.yards[depot];
  let best = 0;
  for (let i = 1; i < y.tracks.length; i++) if (y.tracks[i].length < y.tracks[best].length) best = i;
  y.tracks[best].push(vehicle);
  sim.depotStock[depot] = yardCount(y);
}
