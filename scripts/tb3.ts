import { makeSim, runFor, pickTrain, dirOf } from '../tests/helpers';
const sim = makeSim('weekday', 8 * 3600);
const rm = sim.topo.stations.find((s) => s.name === '人民广场')!;
const tr = pickTrain(sim, (t, ch) => dirOf(sim, t) === 'DN' && ch < rm.chain - 1500 && ch > rm.chain - 5000);
sim.command({ c: 'turnback', train: tr.id, station: rm.index });
runFor(sim, 400);
const plat = rm.platforms.UP;
for (let i = 0; i < 12; i++) {
  runFor(sim, 20);
  const others = sim.trainList.filter(t => t.id !== tr.id && Math.abs(sim.trainChain(t) - rm.chain) < 800).map(t => `${t.vehicle}:${dirOf(sim, t)}:${t.phase}:${sim.trainChain(t).toFixed(0)}:${t.maReason}`);
  const sg = sim.topo.signals.find(s => s.name === 'S1310')!;
  console.log(Math.round(sim.t), 'S1310 route', sim.sig[sg.id].route >= 0 ? sim.topo.routes[sim.sig[sg.id].route].name : '-', 'platOcc', sim.sec[sim.topo.platforms[plat].section].trainOcc, '|', others.join(' '));
}
