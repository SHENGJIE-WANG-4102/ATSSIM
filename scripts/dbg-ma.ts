import { Sim } from '../src/sim/engine';
import { scanAhead, goalBerth } from '../src/sim/movement';
import { nextLink } from '../src/sim/topology';
import { swPos } from '../src/sim/interlocking';
const sim = new Sim({ dayType: 'weekday', dateLabel: 'probe', startTime: 5 * 3600, seed: 1 });
let done = false;
while (sim.t < 6 * 3600 && !done) {
  sim.step();
  const v = sim.integrity.violations.find((x) => x.kind === 'MA_NO_ROUTE');
  if (!v) continue;
  done = true;
  const tr = sim.trains.get(v.trains[0])!;
  console.log(v.detail, 'maDist', tr.maDist, tr.maReason, 'maFar', tr.maFar, tr.maFarReason, 'lastMa', tr.lastMa, 'maSigs', tr.maSigs.map((s) => sim.topo.signals[s].name));
  const s = scanAhead(sim, tr, goalBerth(tr));
  console.log('fresh scan', s.maDist, s.maReason, 'sigs', s.maSignals.map((x) => sim.topo.signals[x].name), 'stopDist', s.stopDist, 'goal', goalBerth(tr), JSON.stringify(tr.tasks[0]));
  let link = tr.link, dir = tr.dir;
  let d = dir === 1 ? sim.topo.links[link].len - tr.off : tr.off;
  for (let i = 0; i < 40 && d < tr.maDist + 200; i++) {
    const nx = nextLink(sim.topo, link, dir, (sw) => swPos(sim, sw));
    if (!nx) { console.log('end at', d.toFixed(0)); break; }
    const sid = sim.topo.signalByEntry.get(nx.node * 65536 + nx.link);
    const l = sim.topo.links[nx.link];
    console.log(d.toFixed(0), 'link', nx.link, sim.topo.sections[l.section].name, 'ch', l.chainA, l.chainB, sid !== undefined ? `SIG ${sim.topo.signals[sid].name} route=${sim.sig[sid].route} ${sim.sig[sid].route >= 0 ? sim.topo.routes[sim.sig[sid].route].name + ' ' + JSON.stringify(sim.routes.get(sim.sig[sid].route)) : ''}` : '');
    d += l.len; link = nx.link; dir = nx.dir;
  }
}
