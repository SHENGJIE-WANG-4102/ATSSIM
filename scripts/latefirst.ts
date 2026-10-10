import { Sim } from '../src/sim/engine';
import { STATIONS } from '../src/data/line2';
const until = Number(process.argv[2] ?? 8) * 3600;
const sim = new Sim({ dayType: 'weekday', dateLabel: 'test', startTime: 5 * 3600, seed: 1 });
while (sim.t < until) sim.step();
const fmt = (s: number) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const seen = new Set<number>();
for (const d of sim.depLog) {
  if (d.delay <= 120 || seen.has(d.trip)) continue;
  seen.add(d.trip);
  const tr = sim.plan.trips[d.trip];
  const prev = sim.depLog.filter(x => x.trip === d.trip && x.t < d.t).map(x => `${STATIONS[x.st].name.slice(0,4)}:${Math.round(x.delay)}`).slice(-3).join(' ');
  console.log(fmt(d.t), tr.no, tr.kind, tr.dir, `${STATIONS[tr.from].name}->${STATIONS[tr.to].name}`, 'first late at', STATIONS[d.st].name, Math.round(d.delay), '| prev', prev);
}
