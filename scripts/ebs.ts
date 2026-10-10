import { Sim } from '../src/sim/engine';
const sim = new Sim({ dayType: (process.argv[2] ?? 'weekday') as any, dateLabel: 'test', startTime: 4 * 3600, seed: 3 });
const fmt = (s: number) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
let n = 0;
while (sim.t < 27.5 * 3600) {
  sim.step();
  for (const e of sim.newEvents) if (e.text.includes('紧急制动') && n < 12) {
    n++;
    console.log(fmt(e.t), e.text);
    const tr = sim.trainList.find(t => e.text.includes(t.vehicle))!;
    console.log('   ch', sim.trainChain(tr).toFixed(0), 'link', tr.link, sim.topo.links[tr.link].track, 'task', JSON.stringify(tr.tasks[0]).slice(0, 100), 'mode', tr.mode, 'ma', tr.maDist.toFixed(1), tr.maReason, 'v', tr.v.toFixed(2), 'vP', tr.vPermit.toFixed(2));
  }
  sim.newEvents.length = 0;
}
console.log('total EB', sim.events.filter(e => e.text.includes('紧急制动')).length);
