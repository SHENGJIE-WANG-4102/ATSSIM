import { Sim } from '../src/sim/engine';
import { swPos } from '../src/sim/interlocking';
const sim = new Sim({ dayType: 'weekday', dateLabel: 'probe', startTime: 5 * 3600, seed: 1 });
const rid = Number(process.argv[2] ?? 242);
const r = sim.topo.routes[rid];
console.log(r.name, 'switches', JSON.stringify(r.switches), 'sections', r.sections.map((s) => sim.topo.sections[s].name).join(','));
let last = '';
while (sim.t < 5.45 * 3600) {
  sim.step();
  const ar = sim.routes.get(rid);
  const st = ar ? `${ar.state} setAt=${ar.setAt.toFixed(0)}` : 'none';
  const sw = r.switches.map(({ sw }) => { const s = sim.sw[sw]; return `${sim.topo.switches[sw].name}:${s.pos}->${s.target} until=${s.moveUntil.toFixed(0)} lc=${s.lockCount} f=${s.failed} swPos=${swPos(sim, sw)}`; }).join(' | ');
  const line = `${st} ${ar ? '' : ''}${sw}`;
  if (line.replace(/setAt=\d+|until=\d+/g, '') !== last.replace(/setAt=\d+|until=\d+/g, '')) { console.log(sim.t.toFixed(1), line); last = line; }
}
