import { Sim } from '../src/sim/engine';
import { trySetRoute } from '../src/sim/interlocking';
const sim = new Sim({ dayType: 'weekday', dateLabel: 'test', startTime: 5 * 3600, seed: 1 });
const fmt = (s: number) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const until = Number(process.argv[2] ?? 5.5) * 3600;
while (sim.t < until) sim.step();
const { topo } = sim;
for (const e of sim.events.filter(e => e.level === 'C')) console.log(fmt(e.t), e.text);
for (const tr of sim.trainList) {
  console.log(tr.svc, tr.tripNo, tr.vehicle, tr.phase, 'v', tr.v.toFixed(1), 'ma', tr.maReason, tr.maDist.toFixed(0), 'sig', tr.nextSignal >= 0 ? topo.signals[tr.nextSignal].name : '-', 'ch', sim.trainChain(tr).toFixed(0), 'task', tr.tasks[0] ? JSON.stringify(tr.tasks[0]).slice(0, 90) : '-');
}
// inspect depot exit signal routes
for (const d of topo.depots) {
  const s = topo.signals[d.exitSignal];
  console.log(d.name, s.name, 'routes', s.routes.map(r => topo.routes[r].name + (topo.routes[r].wrongDir ? '[W]' : '')).join(', '));
  for (const r of s.routes) {
    const res = trySetRoute(sim, r, {});
    console.log('  try', topo.routes[r].name, res.ok, res.msg);
    if (res.ok) { const { releaseRoute } = await import('../src/sim/interlocking'); releaseRoute(sim, r); }
  }
}
