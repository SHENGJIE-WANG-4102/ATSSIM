/** debug: wait-for state of every stopped train at a time. npx vite-node scripts/dbg-halts.ts <hour> [dayType] [seed] [faultLevel] */
import { Sim } from '../src/sim/engine';
const until = Number(process.argv[2] ?? 7) * 3600;
const sim = new Sim({ dayType: (process.argv[3] ?? 'weekday') as 'weekday', dateLabel: 'probe', startTime: Number(process.env.START ?? 5) * 3600, seed: Number(process.argv[4] ?? 1), autoDispatch: Number(process.argv[5] ?? 0) > 0 && !process.env.NODISP });
const lv = Number(process.argv[5] ?? 0);
if (lv) sim.command({ c: 'randomFaults', level: lv as 1 });
sim.checkIntegrity = false;
while (sim.t < until) sim.step();
for (const tr of sim.trainList) {
  if (tr.halt.code === 'NONE' || tr.phase === 'stabled') continue;
  const l = sim.topo.links[tr.link];
  console.log(tr.id, `${tr.svc}-${tr.tripNo}`, tr.phase, 'link', tr.link, l.track, 'sec', sim.topo.sections[l.section].name, 'v', tr.v.toFixed(1), tr.mode, tr.level, 'halt', tr.halt.code, tr.halt.detail, '→', tr.halt.train, 'since', ((sim.t - tr.halt.since) / 60).toFixed(1) + 'min', 'ma', tr.maDist.toFixed(0), tr.maReason, 'next', tr.nextSignal >= 0 ? sim.topo.signals[tr.nextSignal].name : '-', 'ars', tr.arsWait ? `${tr.arsWait.code}:${tr.arsWait.detail}` : '', 'task0', JSON.stringify(tr.tasks[0]).slice(0, 120));
}
for (const [rid, ar] of sim.routes) console.log('ROUTE', sim.topo.routes[rid].name, ar.state, 'owner', ar.owner, 'entered', ar.entered, 'fleet', ar.fleeting);
for (const f of sim.faults) if (!f.repaired || sim.t - f.repairAt < 3600) console.log('FAULT', f.kind, f.text, 'since', (f.since / 3600).toFixed(2), 'repairAt', (f.repairAt / 3600).toFixed(2), f.repaired);
// SHOW=1,2: full state of these trains; switches of routes still being set
for (const id of (process.env.SHOW ?? '').split(',').filter(Boolean).map(Number)) {
  const tr = sim.trains.get(id);
  if (!tr) { console.log('SHOW', id, 'gone'); continue; }
  const l = sim.topo.links[tr.link];
  console.log('SHOW', id, `${tr.svc}-${tr.tripNo}`, tr.phase, 'link', tr.link, l.track, 'sec', sim.topo.sections[l.section].name, 'off', tr.off.toFixed(0), 'v', tr.v.toFixed(1), tr.mode, 'halt', tr.halt.code, tr.halt.detail, 'body', tr.body.map((b) => sim.topo.sections[sim.topo.links[b.link].section].name).join('/'), 'tasks', JSON.stringify(tr.tasks.slice(0, 2)).slice(0, 300));
}
for (const [rid, ar] of sim.routes) {
  if (ar.state !== 'setting') continue;
  for (const x of sim.topo.routes[rid].switches) {
    const s = sim.sw[x.sw];
    console.log('SETTING', sim.topo.routes[rid].name, 'since', (sim.t - ar.setAt).toFixed(0), 'sw', sim.topo.switches[x.sw].name, 'need', x.pos, 'pos', s.pos, 'target', s.target, 'failed', s.failed, 'lock', s.lockCount, 'field', s.fieldLock, 'single', s.singleLock, 'blocked', s.blocked, 'moveUntil', (s.moveUntil - sim.t).toFixed(0));
  }
}
