import { mkdirSync, writeFileSync } from 'node:fs';
import { Sim } from '../src/sim/engine';
import type { DayType, Train } from '../src/sim/model';
import { capture, restore, type Checkpoint } from '../src/sim/state';

// Scenarios share a seed and initial time. Reuse a verified warm-up snapshot;
// each test still gets its own simulator and mutable state.
const warmups = new Map<string, Checkpoint>();

export function makeSim(dayType: DayType = 'weekday', until = 8 * 3600): Sim {
  const sim = new Sim({ dayType, dateLabel: 'test', startTime: until, seed: 7 });
  const key = `${dayType}:${until}`;
  const cp = warmups.get(key);
  if (cp) restore(sim, cp);
  else { runUntil(sim, until); warmups.set(key, capture(sim)); }
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

/**
 * throws on the first invariant violation found by the simulator's own
 * per-tick checker (src/sim/invariants.ts); the violation with its state
 * snapshot is saved to tests/out/ for diagnosis
 */
export function assertIntegrity(sim: Sim) {
  const v = sim.integrity.violations[0];
  if (!v) return;
  const file = `tests/out/violation-${v.kind}-${Math.round(v.t)}.json`;
  try {
    mkdirSync('tests/out', { recursive: true });
    writeFileSync(file, JSON.stringify(v, null, 1));
  } catch { /* the assertion below is what matters */ }
  throw new Error(`integrity violation ${v.kind} at t=${v.t.toFixed(1)}: ${v.detail} (snapshot ${file})`);
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
