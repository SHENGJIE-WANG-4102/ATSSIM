/**
 * Platform screen doors (站台门) and their linkage with the train doors
 * (P4: 站台门与信号联动, DTO). The only writer of PlatformState.psd; every
 * change is a transition of the PSD table in fsm.ts.
 *
 *   normal (DTO):  train stops in the window → signalling opens train doors and
 *                  PSD together → dwell → both close → "closed and locked" →
 *                  departure authority.
 *   linkage fault: the doors no longer follow the signalling; station staff
 *                  work them from the PSL (P4 改造前 C/D 段 practice). The train
 *                  stays in DTO; each open / close costs PSL_EXTRA s 【假设】.
 *   PSD fault:     the doors cannot be closed and locked → no departure
 *                  authority (MA blocked) until station staff confirm the
 *                  doors closed and the dispatcher approves the interlock
 *                  bypass (互锁解除); repair, then cancel the bypass.
 */
import type { Sim } from './engine';
import type { Train } from './model';
import { PSD, inTable, type PsdState } from './fsm';
import { trainLabel } from './ats';
import { callPsd } from './radio';

/** PSL operation by station staff per open / close (s) 【假设】 */
export const PSL_EXTRA = 15;
/** manual confirmation of the doors before a departure under bypass (s) */
export const BYPASS_EXTRA = 25;

function go(sim: Sim, p: number, to: PsdState) {
  const ps = sim.plat[p];
  if (ps.psd === to) return;
  if (!inTable(PSD, ps.psd, to)) throw new Error(`PSD ${sim.topo.platforms[p].name}: ${ps.psd}→${to} not in table`);
  ps.psd = to;
}

/** the doors are open for passengers (or failed open) */
export function psdOpen(ps: { psd: PsdState }): boolean {
  return ps.psd === 'open' || ps.psd === 'pslOpen' || ps.psd === 'closeFail';
}

/** the platform gives departure / entry authority: doors closed and locked, or interlock bypassed */
export function psdSafe(ps: { psd: PsdState }): boolean {
  return ps.psd === 'closed' || ps.psd === 'bypass';
}

/** train stopped in the window: open train doors and PSD. Returns extra dwell (s). */
export function openDoors(sim: Sim, tr: Train, p: number): number {
  const ps = sim.plat[p];
  ps.psdTrain = tr.id;
  tr.doorsOpen = true;
  if (ps.psd === 'bypass') return ps.psdLinkFault ? PSL_EXTRA : 0;
  if (ps.psdLinkFault) { go(sim, p, 'pslOpen'); return PSL_EXTRA; }
  go(sim, p, 'open');
  return 0;
}

/**
 * Dwell over: close train doors and PSD. Returns the extra time before the
 * departure (s), or -1 when the PSD cannot be closed and locked (train stays).
 */
export function closeDoors(sim: Sim, tr: Train, p: number): number {
  const ps = sim.plat[p];
  const { topo } = sim;
  if (ps.psd === 'closeFail') return -1;
  if (ps.psdFault && ps.psd !== 'bypass') {
    go(sim, p, 'closeFail');
    sim.log('A', '车站', `${topo.platforms[p].name} 站台门无法关闭锁紧，列车 ${trainLabel(tr)} 无法发车`, { key: `psd-${p}`, code: 'PSD_FAULT', train: tr.id });
    callPsd(sim, p);
    return -1;
  }
  tr.doorsOpen = false;
  ps.psdTrain = -1;
  let extra = 0;
  if (ps.psd === 'bypass') {
    extra = BYPASS_EXTRA;
    sim.log('I', '车站', `${topo.platforms[p].name} 站台门互锁解除，人工确认后发车`);
  } else {
    if (ps.psd === 'pslOpen') extra = PSL_EXTRA;
    go(sim, p, 'closed');
  }
  return extra;
}

/** dispatcher approves / cancels the interlock bypass (互锁解除) */
export function setBypass(sim: Sim, p: number, on: boolean): { ok: boolean; msg: string } {
  const ps = sim.plat[p];
  const name = sim.topo.platforms[p].name;
  if (on) {
    if (ps.psd === 'bypass') return { ok: true, msg: `${name} 站台门互锁已解除` };
    if (ps.psd === 'closed' && !ps.psdFault) return { ok: false, msg: `${name} 站台门关闭锁紧正常，无需互锁解除` };
    if (ps.psd === 'closed') {
      // pre-emptive bypass for a known fault: the next train will need it
      ps.psdBypass = true;
      return { ok: true, msg: `${name} 站台门互锁解除（预置）` };
    }
    go(sim, p, 'bypass');
    ps.psdBypass = true;
    sim.clearAlarm(`psd-${p}`);
    return { ok: true, msg: `${name} 站台门互锁解除` };
  }
  ps.psdBypass = false;
  if (ps.psd === 'bypass') {
    if (ps.psdFault && ps.psdTrain >= 0) return { ok: false, msg: `${name} 站台门故障未修复且有车停站，不能取消互锁解除` };
    go(sim, p, ps.psdTrain >= 0 ? 'open' : 'closed');
  }
  return { ok: true, msg: `${name} 站台门互锁恢复` };
}

/** a pre-set bypass takes effect when the doors fail to close */
export function psdTick(sim: Sim) {
  for (let p = 0; p < sim.plat.length; p++) {
    const ps = sim.plat[p];
    if (ps.psd === 'closeFail' && ps.psdBypass) { go(sim, p, 'bypass'); sim.clearAlarm(`psd-${p}`); }
    // stale link to a train that left / was removed
    if (ps.psdTrain >= 0 && !sim.trains.has(ps.psdTrain)) ps.psdTrain = -1;
  }
}

/** PSD fault repaired */
export function psdRepaired(sim: Sim, p: number) {
  const ps = sim.plat[p];
  ps.psdFault = false;
  if (ps.psd === 'closeFail') {
    // staff close the repaired doors: the waiting train gets its departure authority
    const tr = sim.trains.get(ps.psdTrain);
    if (tr) tr.doorsOpen = false;
    ps.psdTrain = -1;
    go(sim, p, 'closed');
  }
  sim.clearAlarm(`psd-${p}`);
}
