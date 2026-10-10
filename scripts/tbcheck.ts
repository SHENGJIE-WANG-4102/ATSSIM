import { makeSim, runFor, pickTrain, dirOf } from '../tests/helpers';
const sim = makeSim('weekday', 8 * 3600);
const rm = sim.topo.stations.find((s) => s.name === '人民广场')!;
const tr = pickTrain(sim, (t, ch) => dirOf(sim, t) === 'DN' && ch < rm.chain - 1500 && ch > rm.chain - 5000);
console.log(sim.command({ c: 'turnback', train: tr.id, station: rm.index }));
console.log(tr.tasks.slice(0, 6).map(t => JSON.stringify(t).slice(0, 120)).join('\n'));
for (let i = 0; i < 20; i++) {
  runFor(sim, 60);
  console.log(Math.round(sim.t), tr.phase, dirOf(sim, tr), sim.trainChain(tr).toFixed(0), tr.maReason, tr.maDist.toFixed(0), tr.tasks[0]?.k, (tr.tasks[0] as any)?.berth ?? (tr.tasks[0] as any)?.chosen, sim.topo.signals[tr.nextSignal]?.name);
}
import { trainDesire } from '../src/sim/ats';
import { trySetRoute } from '../src/sim/interlocking';
const d = trainDesire(sim, tr);
console.log('desire', d && { route: sim.topo.routes[d.route].name, ready: d.ready, prio: d.prio, eta: d.eta });
if (d) {
  const r = sim.topo.routes[d.route];
  console.log(r.sections.map(s => `${sim.topo.sections[s].name}${sim.sec[s].lockRoute >= 0 ? '[L ' + sim.topo.routes[sim.sec[s].lockRoute].name + (sim.routes.get(sim.sec[s].lockRoute)?.fleeting ? ' F' : '') + (sim.routes.get(sim.sec[s].lockRoute)?.defleeted ? ' D' : '') + ']' : ''}${sim.sec[s].trainOcc ? '[OCC]' : ''}`).join(' '));
  console.log(r.switches.map(x => `${sim.topo.switches[x.sw].name}:${x.pos} cur ${sim.sw[x.sw].pos} lock ${sim.sw[x.sw].lockCount}`).join(' '));
  console.log(trySetRoute(sim, d.route, {}));
}
