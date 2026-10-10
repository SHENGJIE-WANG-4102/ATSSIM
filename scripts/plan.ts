import { buildTopology } from '../src/sim/topology';
import { computeRunTimes } from '../src/sim/dynamics';
import { generatePlan, applyOverlay, OVERLAY_PRESETS } from '../src/sim/timetable';
const topo = buildTopology();
const rt = computeRunTimes(topo, 186);
for (const dayType of ['weekday', 'weekend'] as const) {
  const t0 = Date.now();
  const plan = generatePlan({ topo, rt, dayType });
  const kinds: Record<string, number> = {};
  for (const t of plan.trips) kinds[t.kind] = (kinds[t.kind] ?? 0) + 1;
  console.log(dayType, 'ms', Date.now() - t0, 'trips', plan.trips.length, JSON.stringify(kinds), 'blocks', plan.blocks.length, 'fleetPeak', plan.fleetPeak);
  const starts: Record<string, number> = {};
  for (const b of plan.blocks) { const k = b.start.kind + (b.start.kind === 'depot' ? topo.depots[b.start.depot].key : (b.start as any).station) + '->' + b.end.kind + (b.end.kind === 'depot' ? topo.depots[(b.end as any).depot].key : (b.end as any).station ?? ''); starts[k] = (starts[k] ?? 0) + 1; }
  console.log(JSON.stringify(starts));
  const fmt = (s: number) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  for (const b of plan.blocks.slice(0, 3).concat(plan.blocks.slice(-2))) {
    console.log('block', b.svc, JSON.stringify(b.start), '->', JSON.stringify(b.end), b.trips.map(id => { const t = plan.trips[id]; return `${t.no}:${t.kind}:${t.from}->${t.to}@${fmt(t.stops[0].dep)}-${fmt(t.stops[t.stops.length-1].arr)}`; }).join(' | '));
  }
  // count active trains over time
  const counts: string[] = [];
  for (let h = 5; h <= 24; h += 1) {
    const t = h * 3600 + 1800;
    let n = 0;
    for (const b of plan.blocks) {
      const f = plan.trips[b.trips[0]]; const l = plan.trips[b.trips[b.trips.length-1]];
      if (f.stops[0].dep - 300 <= t && l.stops[l.stops.length-1].arr >= t) n++;
    }
    counts.push(`${h}:30=${n}`);
  }
  console.log(counts.join(' '));
  if (dayType === 'weekday') {
    const r = applyOverlay({ topo, rt, dayType }, plan, { ...OVERLAY_PRESETS[0] });
    console.log('overlay ciie', JSON.stringify(r), 'fleetPeak', plan.fleetPeak);
    const r2 = applyOverlay({ topo, rt, dayType }, plan, { ...OVERLAY_PRESETS[1] });
    console.log('overlay hq', JSON.stringify(r2), 'fleetPeak', plan.fleetPeak);
  }
}
