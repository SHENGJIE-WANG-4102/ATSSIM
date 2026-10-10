import { makeSim, runFor, pickTrain, dirOf } from '../tests/helpers';
const sim = makeSim('weekday', 8 * 3600);
const rm = sim.topo.stations.find((s) => s.name === '人民广场')!;
const tr = pickTrain(sim, (t, ch) => dirOf(sim, t) === 'DN' && ch < rm.chain - 1500 && ch > rm.chain - 5000);
sim.command({ c: 'turnback', train: tr.id, station: rm.index });
let last = '';
while (sim.t < 29420) {
  sim.step();
  const t0 = tr.tasks[0] as any;
  const line = `${tr.phase} link ${tr.link} off ${tr.off.toFixed(1)} dir ${tr.dir} v ${tr.v.toFixed(2)} task ${t0?.k}:${t0?.berth ?? t0?.chosen} stopDist ${tr.stopDist.toFixed(1)} ma ${tr.maReason}`;
  if (line.replace(/off [0-9.]+|v [0-9.]+|stopDist [0-9.]+/g, '') !== last && sim.t > 29300) { console.log(sim.t.toFixed(1), line); last = line.replace(/off [0-9.]+|v [0-9.]+|stopDist [0-9.]+/g, ''); }
}
const b = sim.topo.berths;
console.log('berth50', JSON.stringify(b[50]), 'berth51', JSON.stringify(b[51]));
