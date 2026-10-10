import { Sim } from '../src/sim/engine';
const until = Number(process.argv[2]) * 3600;
const ch = Number(process.argv[3]); const track = process.argv[4];
const sim = new Sim({ dayType: 'weekday', dateLabel: 'test', startTime: 5 * 3600, seed: 1 });
const { topo } = sim;
const fmt = (s: number) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const sw = topo.switches.find(s => s.nodes.some(n => Math.abs(topo.nodes[n].chain - ch) < 2 && topo.nodes[n].links.some(l => topo.links[l].track === track)))!;
console.log('switch', sw.name, sw.id);
let last = sim.sw[sw.id].target;
let lastLock = sim.sw[sw.id].lockCount;
while (sim.t < until) {
  sim.step();
  const st = sim.sw[sw.id];
  if (st.target !== last || st.lockCount !== lastLock) {
    const users = [...sim.routes.keys()].filter(r => topo.routes[r].switches.some(x => x.sw === sw.id)).map(r => topo.routes[r].name + (sim.routes.get(r)!.fleeting ? '[F]' : '') + '@' + fmt(sim.routes.get(r)!.setAt));
    if (sim.t > until - 1200) console.log(fmt(sim.t), 'target', st.target, 'lock', st.lockCount, 'routes', users.join(' | '));
    last = st.target; lastLock = st.lockCount;
  }
}
