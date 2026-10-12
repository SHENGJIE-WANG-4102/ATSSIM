import { buildTopology } from './src/sim/topology';
import { computeRunTimes } from './src/sim/dynamics';
import { LINE_INFO } from './src/data/line2';
const topo = buildTopology();
for (const k of [Infinity, 60, 50, 45]) {
  const rt = computeRunTimes(topo, LINE_INFO.trainLength, k);
  const s = (a: number[]) => a.reduce((x, y) => x + y, 0) / 60;
  console.log(k, 'DN full', s(rt.dn).toFixed(1), 'UP full', s(rt.up).toFixed(1), 'core4-22', (rt.dn.slice(4, 22).reduce((x, y) => x + y, 0) / 60).toFixed(1));
}
