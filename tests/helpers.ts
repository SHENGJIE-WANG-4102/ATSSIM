import { Sim } from '../src/sim/engine';
import type { DayType, Train } from '../src/sim/model';

export function makeSim(dayType: DayType = 'weekday', until = 8 * 3600): Sim {
  const sim = new Sim({ dayType, dateLabel: 'test', startTime: until, seed: 7 });
  runUntil(sim, until);
  return sim;
}

export function runUntil(sim: Sim, t: number, each?: (sim: Sim) => void) {
  let k = 0;
  while (sim.t < t) {
    sim.step();
    if (each && ++k % 10 === 0) each(sim);
  }
}

export function runFor(sim: Sim, seconds: number, each?: (sim: Sim) => void) {
  runUntil(sim, sim.t + seconds, each);
}

/** throws if any two trains share track space (except a rescue pair coupling) */
export function assertNoCollision(sim: Sim) {
  for (const [link, segs] of sim.linkBodies) {
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i];
        const b = segs[j];
        if (a.train === b.train) continue;
        const ta = sim.trains.get(a.train)!;
        const tb = sim.trains.get(b.train)!;
        if (ta.rescuing === tb.id || tb.rescuing === ta.id) continue;
        const overlap = Math.min(a.to, b.to) - Math.max(a.from, b.from);
        if (overlap > 0.5) throw new Error(`collision on link ${link}: ${ta.vehicle} / ${tb.vehicle} at t=${sim.t.toFixed(0)}`);
      }
    }
  }
}

/** an in-service train running on the main line near a chainage window, in a given direction */
export function pickTrain(sim: Sim, pred: (tr: Train, ch: number) => boolean): Train {
  const tr = sim.trainList.find((t) => t.inService && t.phase === 'run' && pred(t, sim.trainChain(t)));
  if (!tr) throw new Error('no suitable train');
  return tr;
}

export function dirOf(sim: Sim, tr: Train): 'DN' | 'UP' {
  const l = sim.topo.links[tr.link];
  const east = tr.dir === 1 ? l.chainB >= l.chainA : l.chainA > l.chainB;
  return east ? 'DN' : 'UP';
}
