/**
 * Standby trains (备车, D45). A spare vehicle in a yard takes over planned
 * service instead of the service being lost:
 *
 *  R3 takeover: a duty loses its train (withdrawal, rescue duty, failed train
 *     taken home). The trips that loss cancelled are handed to a standby from
 *     the earliest one it can start on time; earlier ones stay cancelled.
 *  R1 relief: a train will start its next own trip more than RELIEF_DELAY
 *     late. A standby takes over from that departure, on time; the late train
 *     finishes the trips it keeps and returns to the yard.
 *
 * A takeover is a plan change like an added train: the standby's empty move
 * from the yard keeps the minimum headway and the declared turnback time
 * (`standbyCandidate`), and the changed plan must add no validator error and
 * keep every yard's stock non-negative before it is applied.
 */
import type { Sim } from './engine';
import type { Block, Train } from './model';
import { applyStandby, standbyCandidate, minTurn, validatePlan, type StandbyPlan, type PlanIssue } from './timetable';
import { yardShortfall } from './planning';

/** Notice a standby needs before leaving the yard (s). */
export const STANDBY_NOTICE = 300;
/** Predicted lateness of a train's next own departure that calls a standby (s). */
export const RELIEF_DELAY = 300;

const issueKey = (i: PlanIssue) => `${i.code}|${i.text}`;

/** The standby that takes over `tail` (live trip ids of duty `from`, in
 * order), validated on a copy of the plan; null when none can. */
export function findStandby(sim: Sim, from: number, tail: number[], minK = 0, maxK = tail.length - 1): StandbyPlan | null {
  if (!tail.length || minK > maxK) return null;
  // The standby inherits the duty's end (its return to the yard or stabling),
  // so it takes over only a tail that runs to the end of the duty. A relieved
  // train's kept trips end in a withdrawal instead.
  const block = sim.plan.blocks[from];
  if (block.relieved || tail[tail.length - 1] !== block.trips.at(-1)) return null;
  const { topo } = sim;
  const origin = topo.stations[sim.plan.trips[tail[minK]].from].chain;
  const depots = topo.depots.map((d, i) => ({ i, dist: Math.abs(d.junctionChain - origin) }))
    .filter(d => sim.depotStock[d.i] > 0).sort((a, b) => a.dist - b.dist).map(d => d.i);
  if (!depots.length) return null;
  const notBefore = sim.t + STANDBY_NOTICE;
  const live = (issues: PlanIssue[]) => issues.filter(i => i.severity === 'error' && i.t >= sim.t - 1e-6);
  let before: Set<string> | undefined;
  const next = new Map(depots.map(d => [d, minK]));
  for (let guard = 0; guard < depots.length * tail.length; guard++) {
    let best: StandbyPlan | null = null;
    for (const d of depots) {
      const k0 = next.get(d)!;
      if (k0 > maxK) continue;
      const c = standbyCandidate(sim.planCtx, sim.plan, tail, d, notBefore, k0, maxK);
      if (!c) { next.set(d, maxK + 1); continue; }
      // earliest takeover first; between yards, the nearest
      if (!best || c.k < best.k) best = c;
    }
    if (!best) return null;
    before ??= new Set([...live(validatePlan(sim.planCtx, sim.plan)), ...[yardShortfall(sim, sim.plan)].filter(i => i !== undefined)].map(issueKey));
    const plan = structuredClone(sim.plan);
    applyStandby(plan, from, tail, best);
    const after = [...live(validatePlan(sim.planCtx, plan)), ...[yardShortfall(sim, plan)].filter(i => i !== undefined)];
    if (after.every(i => before!.has(issueKey(i)))) return best;
    next.set(best.depot, best.k + 1);
  }
  return null;
}

function apply(sim: Sim, from: number, tail: number[], c: StandbyPlan, why: string): Block {
  const block = applyStandby(sim.plan, from, tail, c);
  sim.planRev++;
  sim.planDirty = true;
  const first = sim.plan.trips[tail[c.k]];
  const skipped = c.k ? `；此前${c.k}趟来不及接替，仍取消` : '';
  sim.log('C', '运营', `备车顶替：${sim.topo.depots[c.depot].name}备车表号${block.svc}接替${first.no}起${tail.length - c.k}趟车次（${why}）${skipped}`,
    { key: `standby-${block.id}` });
  return block;
}

/** R3: hand the trips a lost train's cancellation dropped to a standby.
 * `tail` lists the trips of duty `from` that this loss cancelled. Applied only
 * by the automatic dispatcher; a trainee dispatcher adds trains by hand. */
export function standbyTakeover(sim: Sim, from: number, tail: number[], why: string): Block | null {
  if (!sim.autoDispatch || !tail.length) return null;
  const c = findStandby(sim, from, tail);
  return c ? apply(sim, from, tail, c, why) : null;
}

/** Trips of the train's duty after its current one that are still to run. */
function dutyTail(sim: Sim, tr: Train): number[] {
  if (tr.block < 0) return [];
  const trips = sim.plan.blocks[tr.block].trips;
  const idx = trips.indexOf(tr.tripId);
  return trips.slice(idx + 1).filter(id => !sim.plan.trips[id].cancelled && !sim.plan.trips[id].completed);
}

/** Predicted lateness (s) of the train's next own departure: the end of its
 * current trip at its present delay, plus the minimum turnback. */
export function predictedLateness(sim: Sim, tr: Train): number {
  const end = tr.tasks.findIndex(t => t.k === 'stop' && t.trip === tr.tripId && t.dep === null);
  const next = tr.tasks.find((t, i) => i > end && t.k === 'stop' && t.trip >= 0 && t.trip !== tr.tripId && t.dep !== null);
  if (next?.k !== 'stop' || next.dep === null) return 0;
  const last = end >= 0 ? tr.tasks[end] : undefined;
  if (last?.k !== 'stop' || last.arr === null) return 0;
  const ready = Math.max(sim.t, last.arr + Math.max(0, tr.delay)) + minTurn(last.station);
  return ready - next.dep;
}

/** R1 relief: a standby takes over from the late train's next departure it
 * can make on time; the late train keeps the trips before it, then is
 * withdrawn at the end of the last one (`standbyTick`). */
export function cmdStandbyRelief(sim: Sim, tr: Train) {
  if (tr.failed || tr.manual || tr.coupledLen > 0 || !tr.inService || tr.block < 0)
    return { ok: false, msg: '仅对正常载客运行的计划列车办理备车接替' };
  if (tr.relievedBy) return { ok: false, msg: `已由备车表号${tr.relievedBy}接替` };
  const tail = dutyTail(sim, tr);
  if (!tail.length) return { ok: false, msg: '本车底无后续车次' };
  const keeps = (id: number) => tr.tasks.findIndex(t => t.k === 'stop' && t.trip === id && t.dep === null);
  // The late train must still be able to stop at the end of what it keeps.
  const minK = keeps(tr.tripId) >= 0 ? 0 : 1;
  const c = findStandby(sim, tr.block, tail, minK);
  if (!c) return { ok: false, msg: '无可正点接替的备车' };
  const lastKept = c.k ? tail[c.k - 1] : tr.tripId;
  const cut = keeps(lastKept);
  if (cut < 0) return { ok: false, msg: '列车已驶离保留车次终点' };
  const late = Math.round(predictedLateness(sim, tr) / 60);
  const block = apply(sim, tr.block, tail, c, `列车${tr.svc}预计晚点${late}分钟`);
  tr.tasks = tr.tasks.slice(0, cut + 1);
  const keep = new Set(tr.tasks.flatMap(t => t.k === 'stop' ? [t.berth] : []));
  for (const [berth, train] of sim.berthRes) if (train === tr.id && !keep.has(berth)) sim.berthRes.delete(berth);
  tr.relievedBy = block.svc;
  return { ok: true, msg: `备车表号${block.svc}接替${sim.plan.trips[tail[c.k]].no}起车次；本车运行至${sim.plan.trips[lastKept].no}终点后回段` };
}

/** A relieved train that has finished its last kept trip returns to the yard. */
export function standbyTick(sim: Sim) {
  for (const tr of sim.trainList) {
    const stop = tr.tasks[0];
    if (!tr.relievedBy || tr.withdrawn || tr.phase !== 'dwell' || tr.tasks.length !== 1 || stop?.k !== 'stop' || stop.dep !== null) continue;
    // 5 s after arrival, then once a minute while the withdrawal is refused
    if (Math.floor(sim.t - tr.phaseSince) % 60 !== 5) continue;
    sim.command({ c: 'withdraw', train: tr.id, reason: `后续车次已由备车表号${tr.relievedBy}接替` }, '系统');
  }
}
