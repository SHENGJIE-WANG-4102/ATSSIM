import { Sim } from '../src/sim/engine';
const until = Number(process.argv[2] ?? 9) * 3600;
const dayType = (process.argv[3] ?? 'weekday') as 'weekday' | 'weekend';
const sim = new Sim({ dayType, dateLabel: 'test', startTime: 5 * 3600, seed: 1 });
const fmt = (s: number) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const t0 = Date.now();
const stuck = new Map<number, number>();
let lastReport = sim.t;
while (sim.t < until) {
  sim.step();
  if (sim.t - lastReport >= 1800) {
    lastReport = sim.t;
    const s = sim.snapshot().stats;
    console.log(fmt(sim.t), 'online', s.online, 'inService', s.inService, 'late', s.late, 'maxDelay', Math.round(s.maxDelay), 'punct', s.punctuality.toFixed(3), 'trips', s.tripsDone, '/', s.tripsPlanned, 'wall', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  }
  if (Math.round(sim.t * 10) % 100 === 0) {
    for (const tr of sim.trainList) {
      const t0k = tr.tasks[0] as any;
      const layover = t0k && t0k.k === 'stop' && t0k.arr === null && t0k.dep !== null && t0k.dep > sim.t - 60;
      if (tr.phase === 'run' && tr.v < 0.05 && !layover) {
        const s0 = stuck.get(tr.id) ?? sim.t;
        stuck.set(tr.id, s0);
        if (sim.t - s0 > 300 && sim.t - s0 < 310) console.log('STUCK', fmt(sim.t), tr.svc, tr.tripNo, tr.vehicle, 'ma', tr.maReason, tr.maDist.toFixed(1), 'task', JSON.stringify(tr.tasks[0]), 'nextSig', tr.nextSignal >= 0 ? sim.topo.signals[tr.nextSignal].name : '-', tr.nextSignalDist.toFixed(0), 'link', tr.link, sim.topo.links[tr.link].track, 'ch', sim.trainChain(tr).toFixed(0));
      } else stuck.delete(tr.id);
    }
  }
}
const lv: Record<string, number> = {};
for (const e of sim.events) lv[e.level] = (lv[e.level] ?? 0) + 1;
console.log('events', JSON.stringify(lv));
for (const e of sim.events.filter((e) => e.level !== 'I').slice(0, 40)) console.log(fmt(e.t), e.level, e.cat, e.text);
console.log('active alarms', sim.alarms.size);
