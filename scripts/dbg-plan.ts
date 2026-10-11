/** debug: terminal events of the plan. npx vite-node scripts/dbg-plan.ts <station> <fromHour> <untilHour> [dayType] */
import { Sim } from '../src/sim/engine';
const st = Number(process.argv[2]);
const from = Number(process.argv[3]) * 3600;
const until = Number(process.argv[4]) * 3600;
const sim = new Sim({ dayType: (process.argv[5] ?? 'weekday') as 'weekday', dateLabel: 'probe', startTime: 4 * 3600, seed: 3 });
const fmt = (s: number) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const rows: [number, string][] = [];
for (const t of sim.plan.trips) {
  if (t.cancelled) continue;
  const svc = sim.plan.blocks[t.block].svc;
  const s = t.stops.find((x) => x.st === st);
  if (!s) continue;
  if (t.to === st && s.arr >= from && s.arr <= until) rows.push([s.arr, `ARR ${fmt(s.arr)} ${svc}-${t.no} ${t.dir} ${t.kind} from ${t.from}`]);
  if (t.from === st && s.dep >= from && s.dep <= until) rows.push([s.dep, `DEP ${fmt(s.dep)} ${svc}-${t.no} ${t.dir} ${t.kind} to ${t.to}`]);
  if (t.from !== st && t.to !== st && s.arr >= from && s.arr <= until) rows.push([s.arr, `PASS ${fmt(s.arr)}-${fmt(s.dep)} ${svc}-${t.no} ${t.dir} ${t.kind}`]);
}
rows.sort((a, b) => a[0] - b[0]);
for (const r of rows) console.log(r[1]);
