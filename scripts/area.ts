import { Sim } from '../src/sim/engine';
import { trainDesire } from '../src/sim/ats';
const until = Number(process.argv[2]) * 3600;
const lo = Number(process.argv[3]), hi = Number(process.argv[4]);
const sim = new Sim({ dayType: (process.argv[5] ?? 'weekday') as any, dateLabel: 'test', startTime: 5 * 3600, seed: 1 });
while (sim.t < until) sim.step();
const { topo } = sim;
const fmt = (s: number) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
console.log('t', fmt(sim.t));
for (const tr of sim.trainList) {
  const ch = sim.trainChain(tr);
  if (ch < lo || ch > hi) continue;
  const d = trainDesire(sim, tr);
  console.log(tr.vehicle, tr.svc, tr.tripNo, tr.phase, 'link', tr.link, topo.links[tr.link].track, 'dir', tr.dir, 'ch', ch.toFixed(0), 'v', tr.v.toFixed(1), 'ma', tr.maReason, tr.maDist.toFixed(0), 'sig', topo.signals[tr.nextSignal]?.name ?? '-', 'task', tr.tasks[0] ? (tr.tasks[0].k + ':' + ((tr.tasks[0] as any).berth ?? (tr.tasks[0] as any).chosen) + ':' + (topo.berths[(tr.tasks[0] as any).berth ?? (tr.tasks[0] as any).chosen]?.name ?? '')) : '-', 'next', tr.tasks[1] ? tr.tasks[1].k + ':' + (topo.berths[(tr.tasks[1] as any).berth ?? (tr.tasks[1] as any).chosen]?.name ?? '') : '-',
    'dwellUntil', tr.phase !== 'run' ? fmt(tr.dwellUntil) : '', 'desire', d ? `${topo.routes[d.route].name} ready=${d.ready} eta=${d.eta.toFixed(0)} prio=${fmt(d.prio)}` : '-');
}
for (const [rid, ar] of sim.routes) {
  const r = topo.routes[rid];
  const c = (topo.signals[r.start].chain);
  if (c < lo || c > hi || ar.fleeting) continue;
  console.log('route', r.name, ar.state, 'entered', ar.entered, 'owner', sim.trains.get(ar.owner)?.vehicle, 'released', ar.released.map(x => x ? 1 : 0).join(''), 'cancelAt', ar.cancelAt);
}
