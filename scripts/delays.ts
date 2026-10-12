import { Sim } from '../src/sim/engine';
import { STATIONS } from '../src/data/line2';
const until = Number(process.argv[2] ?? 10) * 3600;
const sim = new Sim({ dayType: 'weekday', dateLabel: 'test', startTime: 5 * 3600, seed: Number(process.env.SEED ?? 1) });
while (sim.t < until) sim.step();
const fmt = (s: number) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`;
// for each trip, find the first station where delay jumps
const byTrip = new Map<number, { st: number; delay: number; t: number }[]>();
for (const d of sim.depLog) { const a = byTrip.get(d.trip) ?? []; a.push(d); byTrip.set(d.trip, a); }
const jumps: Record<string, number> = {};
const origins: Record<string, number> = {};
for (const [tid, arr] of byTrip) {
  const trip = sim.plan.trips[tid];
  let prev = 0;
  for (let i = 0; i < arr.length; i++) {
    const inc = arr[i].delay - prev;
    if (i === 0 && arr[i].delay > 90) { const k = `${trip.kind}@${STATIONS[arr[i].st].name}`; origins[k] = (origins[k] ?? 0) + 1; }
    if (i > 0 && inc > 40) { const k = STATIONS[arr[i].st].name; jumps[k] = (jumps[k] ?? 0) + inc; }
    prev = arr[i].delay;
  }
}
console.log('late at origin (count):', JSON.stringify(Object.entries(origins).sort((a, b) => b[1] - a[1]).slice(0, 15)));
console.log('delay gained at station (s):', JSON.stringify(Object.entries(jumps).sort((a, b) => b[1] - a[1]).slice(0, 15)));
const late = sim.depLog.filter(d => d.delay > 120);
console.log('late deps', late.length, '/', sim.depLog.length);
const hist: Record<string, number> = {};
for (const d of late) { const k = fmt(Math.floor(d.t / 1800) * 1800); hist[k] = (hist[k] ?? 0) + 1; }
console.log(JSON.stringify(hist));
