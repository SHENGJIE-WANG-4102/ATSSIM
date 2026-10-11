/** debug: per-step state of the routes from one signal and one train. npx vite-node scripts/dbg-route.ts <signal> <svc> <fromSec> <untilSec> [dayType] [seed] [faultLevel] */
import { Sim } from '../src/sim/engine';
const [sigName, svc] = [process.argv[2], process.argv[3]];
const from = Number(process.argv[4]);
const until = Number(process.argv[5]);
const lv = Number(process.argv[8] ?? 0);
const sim = new Sim({ dayType: (process.argv[6] ?? 'weekday') as 'weekday', dateLabel: 'probe', startTime: 5 * 3600, seed: Number(process.argv[7] ?? 1), autoDispatch: lv > 0 && !process.env.NODISP });
if (lv) sim.command({ c: 'randomFaults', level: lv as 1 });
sim.checkIntegrity = false;
const sig = sim.topo.signals.findIndex((s) => s.name === sigName);
const log = sim.log.bind(sim);
sim.log = ((lvl: string, cat: string, text: string, extra?: unknown) => { if (sim.t >= from) console.log('LOG', sim.t.toFixed(1), lvl, cat, text); return log(lvl as 'A', cat, text, extra as never); }) as typeof sim.log;
let last = '';
while (sim.t < until) {
  sim.step();
  if (sim.t < from) continue;
  const sg = sim.sig[sig];
  const parts: string[] = [`sig.route=${sg.route >= 0 ? sim.topo.routes[sg.route].name : '-'} aspect=${sg.aspect} failed=${sg.failed}`];
  for (const rid of sim.topo.signals[sig].routes) {
    const ar = sim.routes.get(rid);
    if (ar) parts.push(`${sim.topo.routes[rid].name}:${ar.state} cancelAt=${ar.cancelAt} entered=${ar.entered} guide=${ar.guide} manual=${ar.manual} committed=${ar.committed}`);
  }
  for (const tr of sim.trainList) if (tr.svc === svc) parts.push(`T ${tr.phase} ${tr.mode} v=${tr.v.toFixed(2)} ma=${tr.maDist.toFixed(0)} ${tr.maReason} next=${tr.nextSignal >= 0 ? sim.topo.signals[tr.nextSignal].name : '-'}@${tr.nextSignalDist.toFixed(0)} rmSig=${tr.rmSig} rmAuth=${tr.rmAuth.toFixed(0)} manual=${tr.manual} halt=${tr.halt.code}`);
  const s = parts.join(' | ');
  if (s !== last) console.log(sim.t.toFixed(1), s);
  last = s;
}
