import { makeSim, runFor, pickTrain, dirOf } from '../tests/helpers';
import { trainDesire, routeLeadsTo } from '../src/sim/ats';
const sim = makeSim('weekday', 8 * 3600);
const rm = sim.topo.stations.find((s) => s.name === '人民广场')!;
const tr = pickTrain(sim, (t, ch) => dirOf(sim, t) === 'DN' && ch < rm.chain - 1500 && ch > rm.chain - 5000);
sim.command({ c: 'turnback', train: tr.id, station: rm.index });
const goal = 50;
const dist = sim.routeTable.dist.get(goal)!;
for (const s of sim.topo.signals.filter(s => Math.abs(s.chain - rm.chain) < 400)) console.log(s.name, s.role, s.chain.toFixed(0), 'dist', dist[s.id].toFixed(0), 'next', sim.topo.routes[sim.routeTable.next.get(goal)![s.id]]?.name);
let last = '';
while (sim.t < 29300) {
  runFor(sim, 1);
  const d = trainDesire(sim, tr);
  const sg = tr.nextSignal >= 0 ? sim.sig[tr.nextSignal] : null;
  const line = `${sim.topo.signals[tr.nextSignal]?.name} dist ${tr.nextSignalDist.toFixed(0)} ma ${tr.maReason} | sigRoute ${sg && sg.route >= 0 ? sim.topo.routes[sg.route].name + ' leads=' + routeLeadsTo(sim, sg.route, goal) : '-'} | desire ${d ? sim.topo.routes[d.route].name + ' ready=' + d.ready : '-'}`;
  if (line !== last) { console.log(Math.round(sim.t), line); last = line; }
}
