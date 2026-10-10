import { Sim } from '../src/sim/engine';
import * as IL from '../src/sim/interlocking';
import { trainDesire } from '../src/sim/ats';
const from = Number(process.argv[2]) * 3600, to = Number(process.argv[3]) * 3600;
const vehicle = process.argv[4];
const sim = new Sim({ dayType: 'weekday', dateLabel: 'test', startTime: 5 * 3600, seed: 1 });
const { topo } = sim;
const fmt = (s: number) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
while (sim.t < from) sim.step();
let last = '';
while (sim.t < to) {
  sim.step();
  const tr = sim.trainList.find(t => t.vehicle === vehicle);
  if (!tr) continue;
  const d = trainDesire(sim, tr);
  let line = `${tr.phase} v${tr.v.toFixed(1)} [${tr.maReason}] nextSig ${topo.signals[tr.nextSignal]?.name}`;
  if (d) {
    const sg = sim.sig[d.signal];
    const cur = sg.route >= 0 ? topo.routes[sg.route].name + (sim.routes.get(sg.route)!.cancelAt ? '(c)' : '') : '-';
    line += ` desire ${topo.routes[d.route].name} ready=${d.ready} prio=${fmt(d.prio)} eta=${d.eta.toFixed(0)} | sig has ${cur} | approachLocked=${IL.approachLocked(sim, d.signal)}`;
    const lockers = sim.trainList.filter(t => t.nextSignal === d.signal && t.nextSignalDist < 600 && t.v > 0.5).map(t => t.vehicle);
    if (lockers.length) line += ` lockers ${lockers}`;
  }
  const key = line.replace(/v[0-9.]+ /, "").replace(/eta=[0-9]+/, "");
  if (key !== last) { console.log(fmt(sim.t), line); last = key; }
}
