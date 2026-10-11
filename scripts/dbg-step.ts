/** debug: per-step trace of one train around a time. npx vite-node scripts/dbg-step.ts <svc> <fromSec> <untilSec> [dayType] [seed] [faultLevel] */
import { Sim } from '../src/sim/engine';
const svc = process.argv[2];
const from = Number(process.argv[3]);
const until = Number(process.argv[4]);
const lv = Number(process.argv[7] ?? 0);
const sim = new Sim({ dayType: (process.argv[5] ?? 'weekday') as 'weekday', dateLabel: 'probe', startTime: 5 * 3600, seed: Number(process.argv[6] ?? 1), autoDispatch: lv > 0 });
if (lv) sim.command({ c: 'randomFaults', level: lv as 1 });
sim.checkIntegrity = false;
let nf = 0;
while (sim.t < until) {
  sim.step();
  while (nf < sim.faults.length) { const f = sim.faults[nf++]; if (sim.t > from - 600) console.log('FAULT', sim.t.toFixed(1), f.kind, f.target, f.text); }
  if (sim.t < from) continue;
  for (const tr of sim.trainList) {
    if (tr.svc !== svc) continue;
    console.log(sim.t.toFixed(1), tr.phase, tr.level, tr.mode, 'comm', tr.comm, 'eb', tr.eb, 'v', tr.v.toFixed(2), 'ds', tr.lastDs.toFixed(2), 'lastMa', tr.lastMa.toFixed(2), 'ma', tr.maDist.toFixed(1), tr.maReason, 'far', tr.maFar.toFixed(1), 'zone', sim.zoneState[sim.topo.links[tr.link].zone], 'rmAuth', tr.rmAuth.toFixed(0));
  }
}
