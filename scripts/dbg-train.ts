/** debug: follow one train. npx vite-node scripts/dbg-train.ts <id> <fromHour> <untilHour> [dayType] [seed] [faultLevel] */
import { Sim } from '../src/sim/engine';
const id = Number(process.argv[2] ?? 3);
const from = Number(process.argv[3] ?? 5) * 3600;
const until = Number(process.argv[4] ?? 5.42) * 3600;
const sim = new Sim({ dayType: (process.argv[5] ?? 'weekday') as 'weekday', dateLabel: 'probe', startTime: 5 * 3600, seed: Number(process.argv[6] ?? 1) });
const lv = Number(process.argv[7] ?? 0);
if (lv) sim.command({ c: 'randomFaults', level: lv as 1 });
sim.checkIntegrity = false;
let k = 0;
let lastFaults = 0;
while (sim.t < until) {
  sim.step();
  while (lastFaults < sim.faults.length) { const f = sim.faults[lastFaults++]; console.log('FAULT', sim.t.toFixed(0), f.kind, f.target, f.text, 'repairAt', f.repairAt.toFixed(0)); }
  if (sim.t < from) continue;
  if (++k % 300 === 0) {
    const tr = sim.trains.get(id);
    if (!tr) continue;
    const sg = tr.nextSignal >= 0 ? sim.sig[tr.nextSignal] : null;
    console.log(sim.t.toFixed(0), tr.svc, tr.tripNo, tr.phase, 'v', tr.v.toFixed(1), 'ma', tr.maDist.toFixed(0), tr.maReason, 'next', tr.nextSignal >= 0 ? sim.topo.signals[tr.nextSignal].name : '-', tr.nextSignalDist.toFixed(0), sg ? JSON.stringify({ route: sg.route, failed: sg.failed, ars: sg.ars, aspect: sg.aspect }) : '', 'ars', JSON.stringify(tr.arsWait), 'task0', JSON.stringify(tr.tasks[0]).slice(0, 200), 'halt', tr.halt.code, tr.halt.detail, 'blk', tr.halt.train);
    const o = tr.halt.train >= 0 ? sim.trains.get(tr.halt.train) : undefined;
    if (o) console.log('   BLOCKER', o.id, o.svc, o.tripNo, o.phase, 'link', o.link, sim.topo.links[o.link].track, 'v', o.v.toFixed(1), 'halt', o.halt.code, o.halt.detail, 'task0', JSON.stringify(o.tasks[0]).slice(0, 200), 'ma', o.maDist.toFixed(0), o.maReason);
  }
}
