import { makeSim, runFor } from '../tests/helpers';
const sim = makeSim('weekday', 8 * 3600);
const s5 = sim.topo.stations.find(s => s.name === '北新泾')!;
const sig = sim.topo.signals.find((s) => s.role === 'start' && s.station === s5.index && s.dir === 1 && sim.topo.links[s.link].track === 'DN')!;
console.log(sim.command({ c: 'fault', kind: 'signal', target: sig.id, duration: 900 }));
runFor(sim, 300);
const route = sig.routes.find((r) => sim.topo.routes[r].fleeting)!;
console.log(sim.command({ c: 'guideRoute', route }));
runFor(sim, 720);
console.log('failed', sim.sig[sig.id].failed, 'route', sim.sig[sig.id].route, 'ars', sim.sig[sig.id].ars, 'autoPass', sim.sig[sig.id].autoPass);
const r = sim.topo.routes[route];
console.log(r.sections.map(s => `${sim.topo.sections[s].name} lock ${sim.sec[s].lockRoute >= 0 ? sim.topo.routes[sim.sec[s].lockRoute].name : '-'} occ ${sim.sec[s].occ}`).join(' | '));
for (let i = 0; i < 6; i++) { runFor(sim, 10); console.log('route', sim.sig[sig.id].route, sim.trainList.filter(t => t.nextSignal === sig.id).map(t => `${t.vehicle} ${t.maReason} ${t.nextSignalDist.toFixed(0)}`).join(',')); }
