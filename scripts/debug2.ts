import { Sim } from '../src/sim/engine';
import { trySetRoute, releaseRoute } from '../src/sim/interlocking';
import { trainDesire } from '../src/sim/ats';
const until = Number(process.argv[2]) * 3600;
const vehicle = process.argv[3];
const sim = new Sim({ dayType: 'weekday', dateLabel: 'test', startTime: 5 * 3600, seed: 1 });
while (sim.t < until) sim.step();
const { topo } = sim;
const tr = sim.trainList.find(t => t.vehicle === vehicle)!;
console.log('train', tr.svc, tr.tripNo, tr.phase, 'ma', tr.maReason, 'nextSig', topo.signals[tr.nextSignal]?.name, 'task', JSON.stringify(tr.tasks[0]));
const d = trainDesire(sim, tr);
console.log('desire', d && { sig: topo.signals[d.signal].name, route: topo.routes[d.route].name, prio: d.prio, eta: d.eta, ready: d.ready });
if (d) {
  const r = topo.routes[d.route];
  console.log('route sections', r.sections.map(s => `${topo.sections[s].name}${sim.sec[s].lockRoute >= 0 ? '[L:' + topo.routes[sim.sec[s].lockRoute].name + (sim.routes.get(sim.sec[s].lockRoute)?.fleeting ? ' F' : '') + ']' : ''}${sim.sec[s].occ ? '[OCC]' : ''}`).join(' '));
  console.log('switches', r.switches.map(s => `${topo.switches[s.sw].name}:${s.pos} cur ${sim.sw[s.sw].pos} lock ${sim.sw[s.sw].lockCount}`).join(' '));
  const sg = sim.sig[d.signal];
  console.log('signal route', sg.route >= 0 ? topo.routes[sg.route].name : '-', 'ars', sg.ars);
  const res = trySetRoute(sim, d.route, {});
  console.log('try', res);
}
{
  const sg = sim.sig[tr.nextSignal];
  if (sg.route >= 0) {
    const ar = sim.routes.get(sg.route)!;
    const r = topo.routes[sg.route];
    console.log('active at next signal', r.name, JSON.stringify({ ...ar, occSeen: undefined, released: ar.released.join('') }), 'aspect', sg.aspect);
    console.log('switches', r.switches.map(s => `${topo.switches[s.sw].name}:${s.pos} cur ${sim.sw[s.sw].pos}/${sim.sw[s.sw].target} mu ${sim.sw[s.sw].moveUntil.toFixed(0)} failed ${sim.sw[s.sw].failed}`).join(' '));
    const owner = sim.trains.get(ar.owner);
    console.log('owner', owner?.vehicle, owner?.tripNo);
  }
}
