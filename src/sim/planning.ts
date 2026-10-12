import type { Sim } from './engine';
import { cancelTrip, type Command, type Plan } from './model';
import { addExtraTrain, applyOverlay, OVERLAY_PRESETS, validatePlan, fleetPeak, type PlanIssue } from './timetable';
import { validateCommand } from './commands';

export type PlanCommand = Extract<Command, { c: 'overlay' | 'addTrain' }>;
export interface PlanPreview {
  ok: boolean;
  msg: string;
  plan: Plan;
  issues: PlanIssue[];
  added: number;
  skipped: number;
  /** running circulations that continue into added trips (延长运用, D47):
   * their trains get the new trips after `last` when the plan is committed */
  extended?: { block: number; last: number }[];
}

/** The same pure preparation and validation is used by preview and commit. */
export function preparePlan(sim: Sim, cmd: PlanCommand): PlanPreview {
  const plan = structuredClone(sim.plan);
  const reject = (msg: string, issues: PlanIssue[] = []): PlanPreview => ({ ok: false, msg, plan, issues, added: 0, skipped: 0 });
  const invalid = validateCommand(sim, cmd);
  if (invalid) return reject(invalid);
  const firstBlock = plan.blocks.length;
  const firstTrip = plan.trips.length;
  let skipped = 0;
  let label: string;
  let extended: PlanPreview['extended'];
  if (cmd.c === 'addTrain') {
    if (cmd.time < sim.t + 120) return reject('加开时刻须晚于当前时刻2分钟以上');
    const b = addExtraTrain(sim.planCtx, plan, cmd.depot, cmd.dir, cmd.to, cmd.time);
    if (typeof b === 'string') return reject(b);
    if (b.start.kind === 'depot' && b.start.time < sim.t) return reject('当前时刻已来不及出段，请选择更晚的加开时刻');
    label = `加开列车 表号${b.svc}`;
  } else {
    const preset = OVERLAY_PRESETS.find(p => p.id === cmd.id);
    if (!preset) return reject('无此加开模板');
    if (cmd.from < sim.t - 1e-6) return reject('加开开始时刻不能早于当前时刻');
    const result = applyOverlay(sim.planCtx, plan, { ...preset, from: cmd.from, to: cmd.to, headway: cmd.headway },
      { now: sim.t, canExtend: (block, last) => canExtend(sim, block, last) });
    skipped = result.skipped;
    extended = result.extended.map(x => ({ block: x.block, last: x.last }));
    label = preset.label;
    // Mid-day application cannot send a vehicle out in the past. Omit the whole
    // circulation, including its return, and report the shortage once.
    for (const b of plan.blocks.slice(firstBlock)) if (b.start.kind === 'depot' && b.start.time < sim.t) {
      for (const id of b.trips) { const trip = plan.trips[id]; if (!trip.cancelled && trip.revenue) skipped++; cancelTrip(trip, '加开：出段时刻已过'); }
    }
    plan.blocks = plan.blocks.filter(b => b.id < firstBlock || b.trips.some(id => !plan.trips[id].cancelled));
    plan.blocks.forEach((b, id) => { b.id = id; for (const trip of b.trips) plan.trips[trip].block = id; });
  }
  plan.fleetPeak = fleetPeak(plan);
  const issues = validatePlan(sim.planCtx, plan).filter(issue => issue.t >= sim.t - 1e-6);
  const shortfall = yardShortfall(sim, plan);
  if (shortfall) issues.push(shortfall);
  const errors = issues.filter(issue => issue.severity === 'error');
  if (errors.length) return reject(`运行图不可行：${errors[0].text}`, issues);
  const added = plan.trips.slice(firstTrip).filter(trip => !trip.cancelled && trip.revenue).length;
  return { ok: true, msg: `${label}：新增 ${added} 个车次${skipped ? `；${skipped} 个车次因能力或库存不足未安排` : ''}`, plan, issues, added, skipped, extended };
}

/** The train of a circulation can still be kept in service after trip `last`:
 * either it has not left the depot yet, or it runs normally and has not yet
 * finished `last`. */
function canExtend(sim: Sim, block: number, last: number): boolean {
  if (sim.blockDone.has(block)) return false;
  const id = sim.plan.blocks[block]?.train;
  if (id === undefined) return true;
  const tr = sim.trains.get(id);
  return !!tr && !tr.failed && !tr.manual && !tr.relievedBy && !tr.withdrawn && tr.coupledLen === 0 && tr.rescuing < 0 && tr.rescueBy < 0
    && tr.tbStage !== 'manual' && tr.tasks.some(t => t.k === 'stop' && t.trip === last && t.dep === null);
}

/** Current yard stock must cover every planned departure from the yard.
 * Existing stock is reserved first, with planned returns credited only
 * after their entry movement. */
export function yardShortfall(sim: Sim, plan: Plan): PlanIssue | undefined {
  const balance = sim.depotStock.slice();
  const moves: { at: number; depot: number; delta: number }[] = [];
  for (const block of plan.blocks) {
    if (block.start.kind === 'depot' && block.train === undefined && !sim.blockDone.has(block.id)
      && block.trips.some(id => !plan.trips[id].cancelled)) moves.push({ at: Math.max(sim.t, block.start.time), depot: block.start.depot, delta: -1 });
    if (block.end.kind === 'depot' && !sim.blockDone.has(block.id)) {
      const trips = block.trips.map(id => plan.trips[id]).filter(trip => !trip.cancelled);
      const last = trips[trips.length - 1];
      if (last) moves.push({ at: last.stops[last.stops.length - 1].arr + 300, depot: block.end.depot, delta: 1 });
    }
  }
  moves.sort((a, b) => a.at - b.at || a.delta - b.delta);
  for (const move of moves) {
    balance[move.depot] += move.delta;
    if (balance[move.depot] < 0) return { severity: 'error', code: 'FLEET', t: move.at, text: `${sim.topo.depots[move.depot].name} 预计库存不足` };
  }
  return undefined;
}
