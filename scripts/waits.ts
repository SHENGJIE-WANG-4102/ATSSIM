import { Sim } from '../src/sim/engine';
import { STATIONS } from '../src/data/line2';
const until = Number(process.argv[2] ?? 10) * 3600;
const from = Number(process.argv[3] ?? 6) * 3600;
const sim = new Sim({ dayType: 'weekday', dateLabel: 'test', startTime: 5 * 3600, seed: 1 });
const waits: Record<string, number> = {};
const dwellExtra: Record<string, number> = {};
let k = 0;
while (sim.t < until) {
  sim.step();
  if (++k % 10 !== 0 || sim.t < from) continue;
  for (const tr of sim.trainList) {
    if (!tr.inService) continue;
    const t0 = tr.tasks[0] as any;
    if (tr.phase === 'run' && tr.v < 0.3) {
      const layover = t0 && t0.k === 'stop' && t0.arr === null && t0.dep !== null && t0.dep > sim.t - 60;
      if (layover) continue;
      const st = sim.topo.sections[sim.topo.links[tr.link].section].station;
      const key = `${STATIONS[st].name}|${tr.maReason}|${t0?.k}|${Math.floor(sim.t/3600)}h`;
      waits[key] = (waits[key] ?? 0) + 1;
    }
    if (tr.phase === 'dwell' && t0?.dep !== null && sim.t > t0.dep + 1 && sim.t > tr.dwellUntil) {
      const key = `${STATIONS[t0.station].name}|${tr.doorsOpen ? 'doors' : 'closed'}`;
      dwellExtra[key] = (dwellExtra[key] ?? 0) + 1;
    }
  }
}
console.log('waiting (train-seconds) by place|reason|task:');
for (const [k2, v] of Object.entries(waits).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(String(v).padStart(6), k2);
console.log('late dwell beyond plan (train-seconds):');
for (const [k2, v] of Object.entries(dwellExtra).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(String(v).padStart(6), k2);
