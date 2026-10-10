import { Sim } from '../src/sim/engine';
const from = Number(process.argv[2]) * 3600, to = Number(process.argv[3]) * 3600;
const lo = Number(process.argv[4]), hi = Number(process.argv[5]);
const step = Number(process.argv[6] ?? 15);
const sim = new Sim({ dayType: 'weekday', dateLabel: 'test', startTime: 5 * 3600, seed: 1 });
const { topo } = sim;
const fmt = (s: number) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
while (sim.t < from) sim.step();
let next = sim.t;
while (sim.t < to) {
  sim.step();
  if (sim.t < next) continue;
  next += step;
  const rows: string[] = [];
  for (const tr of sim.trainList) {
    const ch = sim.trainChain(tr);
    if (ch < lo || ch > hi) continue;
    const t0 = tr.tasks[0] as any;
    const tk = t0 ? (t0.k === 'stop' ? `stop@${topo.berths[t0.berth].name.replace('浦东1号2号航站楼', 'PDA').replace('蟠祥路·国家会计学院', 'PXL')}${t0.dep ? ' dep ' + fmt(t0.dep) : ''}` : t0.k === 'reverse' ? `rev->${topo.berths[t0.chosen].name.slice(-4)}` : t0.k) : '-';
    rows.push(`${tr.tripNo}/${tr.vehicle} ${tr.phase} ch${ch.toFixed(0)} v${tr.v.toFixed(0)} [${tr.maReason}] ${tk}${tr.phase !== 'run' ? ' until ' + fmt(tr.dwellUntil) : ''}`);
  }
  const routes = [...sim.routes.entries()].filter(([rid, ar]) => !ar.fleeting && topo.signals[topo.routes[rid].start].chain > lo && topo.signals[topo.routes[rid].start].chain < hi).map(([rid, ar]) => `${topo.routes[rid].name}${ar.entered ? '*' : ''}${ar.cancelAt ? '(c)' : ''}`);
  console.log(fmt(sim.t), '| routes:', routes.join(', '));
  for (const r of rows) console.log('   ', r);
}
