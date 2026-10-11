/**
 * Automatic dispatcher (自动调度员): a scripted stand-in for the human
 * dispatcher, used by headless soak runs and the probe scripts (off by default
 * in the app, where the trainee is the dispatcher).
 *
 * It is NOT the radio auto-answer: the auto-answer only ever gives the safe
 * default (wait / degrade / no RM). The automatic dispatcher works the
 * recovery procedures of the operating rules through ordinary dispatcher
 * commands — the same commands, checks and log entries as a person at the
 * desk — and only after a human-like reaction delay:
 *
 *  - axle counter fault: RM past the failed section after the train has waited
 *    (equipment fault, one signal per authorisation); after maintenance
 *    预复位 and RM sweep by the first train (rmPreset call)
 *  - switch without detection: field lock (钩锁) where the switch already lies
 *    as the route needs it, then a guide route (引导进路); after maintenance a
 *    throw (单操) restores detection
 *  - signal that cannot clear: RM past it (stuck call, equipment fault)
 *  - ZC failure: zone switched to TBTC; back to CBTC once repaired
 *  - PSD that cannot close: interlock bypass (互锁解除) on the station's
 *    request; bypass cancelled after repair
 *  - train failure that cannot be cleared: rescue by the train behind
 *
 * Every RM authorisation first runs the same safety check the desk shows
 * (unsafeAhead) and is never given to a train held by another train.
 */
import type { Sim } from './engine';
import type { Command, Train } from './model';
import { unsafeAhead, rescuerFor } from './radio';
import { goalBerth } from './movement';
import { routeLeadsTo } from './ats';

/** reaction time before answering a call / starting a procedure (s) */
const REACT = 10;
/** wait at a failed switch before setting up a guide route (s) */
const GUIDE_AFTER = 60;

export interface DispatcherState {
  /** next time each proactive procedure may act again, by key */
  next: Map<string, number>;
}

export function newDispatcher(): DispatcherState {
  return { next: new Map() };
}

function cmd(sim: Sim, c: Command) {
  return sim.command(c, '自动调度');
}

function due(sim: Sim, key: string, every: number): boolean {
  const st = sim.dispatcher;
  const n = st.next.get(key) ?? 0;
  if (sim.t < n) return false;
  st.next.set(key, sim.t + every);
  return true;
}

/** per second, before the radio auto-answer */
export function dispatcherTick(sim: Sim) {
  if (!sim.autoDispatch || sim.t < sim.config.startTime) return;
  answerCalls(sim);
  if (Math.floor(sim.t) % 5 !== 0) return;
  axleProcedures(sim);
  switchProcedures(sim);
  zoneProcedures(sim);
  psdProcedures(sim);
}

function answerCalls(sim: Sim) {
  for (const c of sim.calls) {
    if (c.state !== 'ringing' || sim.t - c.t < REACT) continue;
    const tr = c.train !== undefined ? sim.trains.get(c.train) : undefined;
    switch (c.kind) {
      case 'turnback':
        if (tr && !unsafeAhead(sim, tr)) cmd(sim, { c: 'radio', call: c.id, option: 'rm' });
        break;
      case 'ebRelease':
        // Following a SPAD, a human-equivalent investigation and an explicit
        // bounded instruction are required. Radio auto-answer still waits.
        if (tr?.ebCause === 'spad' && !unsafeAhead(sim, tr) && due(sim, `spad-${tr.id}`, 60))
          cmd(sim, { c: 'radio', call: c.id, option: 'rm' });
        break;
      case 'rmPreset':
        if (tr && !unsafeAhead(sim, tr)) cmd(sim, { c: 'radio', call: c.id, option: 'approve' });
        break;
      case 'stuck':
        // RM is offered only for equipment faults; never to a train held by another train
        if (tr && c.options.some((o) => o.key === 'rm') && tr.halt.train < 0 && !unsafeAhead(sim, tr)) cmd(sim, { c: 'radio', call: c.id, option: 'rm' });
        break;
      case 'rescue':
        if (tr && tr.failed && rescuerFor(sim, tr)) cmd(sim, { c: 'radio', call: c.id, option: 'organize' });
        break;
      case 'psd':
        cmd(sim, { c: 'radio', call: c.id, option: 'bypass' });
        break;
    }
  }
}

const faultActive = (sim: Sim, kind: string, target: number) =>
  sim.faults.some((f) => f.kind === kind && f.target === target && !f.repaired && sim.t < f.repairAt);

function axleProcedures(sim: Sim) {
  for (let s = 0; s < sim.sec.length; s++) {
    const st = sim.sec[s];
    if (!st.disturbed || st.trainOcc || faultActive(sim, 'axle', s)) continue;
    if (due(sim, `axle-${s}`, 60)) cmd(sim, { c: 'axleReset', section: s });
  }
}

function switchProcedures(sim: Sim) {
  const { topo } = sim;
  for (let i = 0; i < sim.sw.length; i++) {
    const st = sim.sw[i];
    if (!st.failed) continue;
    if (!faultActive(sim, 'switch', i)) {
      // maintenance done: cancel routes still locked over it (none entered), release the
      // field lock and throw the switch to restore detection
      if (!due(sim, `swr-${i}`, 30)) continue;
      // Re-prove the existing physical position after maintenance. This does
      // not move a point and remains safe while its route/section is occupied.
      // Waiting to cancel that route first traps the train in front of the point.
      if (st.target === st.pos && cmd(sim, { c: 'switchMove', sw: i, pos: st.pos }).ok) continue;
      if (st.lockCount > 0) {
        for (const [rid, ar] of sim.routes) {
          if (ar.entered || ar.state !== 'locked' || !topo.routes[rid].switches.some((x) => x.sw === i)) continue;
          if (ar.cancelAt === 0) cmd(sim, { c: 'cancelRoute', signal: topo.routes[rid].start });
        }
        continue;
      }
      if (st.fieldLock) cmd(sim, { c: 'switchFieldLock', sw: i, on: false });
      cmd(sim, { c: 'switchMove', sw: i, pos: st.pos });
    }
  }
  // trains waiting at a route over a failed switch: guide route where the switch lies right
  for (const tr of sim.trainList) {
    if (tr.halt.code !== 'SWITCH_FAULT' || tr.v > 0.05 || sim.t - tr.halt.since < GUIDE_AFTER) continue;
    const sig = tr.nextSignal;
    if (sig < 0 || tr.nextSignalDist > 60 || sim.sig[sig].failed) continue;
    const rid = guideCandidate(sim, tr, sig);
    if (rid < 0 || !due(sim, `guide-${tr.id}`, 60)) continue;
    const sg = sim.sig[sig];
    if (sg.route >= 0 && sg.route !== rid) continue;
    for (const { sw } of topo.routes[rid].switches) if (sim.sw[sw].failed && !sim.sw[sw].fieldLock) cmd(sim, { c: 'switchFieldLock', sw, on: true });
    if (sg.route === rid) cmd(sim, { c: 'cancelRoute', signal: sig });
    cmd(sim, { c: 'guideRoute', route: rid });
  }
}

/** a route from the signal towards the train's goal whose failed switches already lie as needed */
function guideCandidate(sim: Sim, tr: Train, sig: number): number {
  const goal = goalBerth(tr);
  for (const rid of sim.topo.signals[sig].routes) {
    const r = sim.topo.routes[rid];
    if (goal >= 0 && !routeLeadsTo(sim, rid, goal)) continue;
    if (!r.switches.some((x) => sim.sw[x.sw].failed)) continue;
    if (r.switches.every((x) => !sim.sw[x.sw].failed || sim.sw[x.sw].pos === x.pos)) return rid;
  }
  return -1;
}

function zoneProcedures(sim: Sim) {
  for (let z = 0; z < sim.zoneState.length; z++) {
    const s = sim.zoneState[z];
    if (s === 'ZCFAIL' && due(sim, `zc-${z}`, 120)) {
      const f = sim.faults.find((x) => x.kind === 'zcFail' && (x.target === z || x.target < 0) && !x.repaired);
      if (f && sim.t - f.since >= 30) cmd(sim, { c: 'zoneLevel', zones: [z], level: 'TBTC' });
    } else if (s === 'TBTC' && !faultActive(sim, 'zcFail', z) && !faultActive(sim, 'zcFail', -1) && due(sim, `zcr-${z}`, 120)) {
      cmd(sim, { c: 'zoneLevel', zones: [z], level: 'CBTC' });
    }
  }
}

function psdProcedures(sim: Sim) {
  for (let p = 0; p < sim.plat.length; p++) {
    const ps = sim.plat[p];
    if (ps.psdBypass && !ps.psdFault && due(sim, `psd-${p}`, 60)) cmd(sim, { c: 'psdBypass', platform: p, on: false });
  }
}
