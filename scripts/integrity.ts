/**
 * Headless integrity probe: run a day (optionally with random faults) and
 * print the invariant violations. Usage:
 *   npx vite-node scripts/integrity.ts [untilHour] [dayType] [seed] [faultLevel]
 */
import { Sim } from '../src/sim/engine';
const until = Number(process.argv[2] ?? 12) * 3600;
const dayType = (process.argv[3] ?? 'weekday') as 'weekday' | 'weekend';
const seed = Number(process.argv[4] ?? 1);
const level = Number(process.argv[5] ?? 0);
// with faults the automatic dispatcher works the recovery procedures (NODISP=1 to switch it off)
const sim = new Sim({ dayType, dateLabel: 'probe', startTime: 5 * 3600, seed, autoDispatch: level > 0 && !process.env.NODISP });
if (level > 0) sim.command({ c: 'randomFaults', level: level as 1 | 2 | 3 });
const fmt = (s: number) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const t0 = Date.now();
let shown = 0;
const perKind: Record<string, number> = {};
// EV=<regex>: print matching event-log lines as they happen
const evRe = process.env.EV ? new RegExp(process.env.EV) : null;
let evShown = 0;
while (sim.t < until) {
  sim.step();
  if (evRe) {
    for (const e of sim.events) if (e.id >= evShown && evRe.test(e.text)) console.log('EV', fmt(e.t), e.text);
    evShown = sim.nextEventId;
  }
  const vs = sim.integrity.violations;
  while (shown < vs.length) {
    const v = vs[shown++];
    perKind[v.kind] = (perKind[v.kind] ?? 0) + 1;
    if (perKind[v.kind] <= 12) console.log(fmt(v.t), v.kind, v.detail);
    if (perKind[v.kind] === 1 && process.env.DUMP) console.log(JSON.stringify(v.snapshot, null, 1));
  }
}
console.log('counts', JSON.stringify(sim.integrity.counts), 'wall', ((Date.now() - t0) / 1000).toFixed(1) + 's', 'punct', sim.snapshot().stats.punctuality.toFixed(4));
