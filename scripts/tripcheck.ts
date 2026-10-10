import { Sim } from '../src/sim/engine';
import { STATIONS } from '../src/data/line2';
const tripNo = process.argv[2];
const until = Number(process.argv[3] ?? 7.5) * 3600;
const sim = new Sim({ dayType: 'weekday', dateLabel: 'test', startTime: 5 * 3600, seed: 1 });
const trip = sim.plan.trips.find(t => t.no === tripNo)!;
const arrs = new Map<number, number>();
const deps = new Map<number, number>();
const loads = new Map<number, number>();
let prevPhase = new Map<number, string>();
while (sim.t < until) {
  sim.step();
  for (const tr of sim.trainList) {
    if (tr.tripId !== trip.id) continue;
    const p = prevPhase.get(tr.id);
    if (p !== tr.phase) {
      if (tr.phase === 'dwell') { arrs.set(tr.lastStation, sim.t); loads.set(tr.lastStation, tr.load); }
      if (p === 'dwell' && tr.phase === 'run') deps.set(tr.lastStation, sim.t);
      prevPhase.set(tr.id, tr.phase);
    }
  }
}
let prevDep = 0, prevPDep = 0;
for (const s of trip.stops) {
  const a = arrs.get(s.st), d = deps.get(s.st);
  const runAct = a && prevDep ? (a - prevDep).toFixed(0) : '-';
  const runPlan = prevPDep ? (s.arr - prevPDep).toFixed(0) : '-';
  console.log(STATIONS[s.st].name.padEnd(10), 'plan run', runPlan, 'act run', runAct, '| plan dwell', (s.dep - s.arr).toFixed(0), 'act dwell', a && d ? (d - a).toFixed(0) : '-', 'load', loads.get(s.st) ?? '-', 'delay', d ? (d - s.dep).toFixed(0) : '-');
  if (d) prevDep = d;
  prevPDep = s.dep;
}
