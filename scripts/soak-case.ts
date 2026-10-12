import { mkdirSync, writeFileSync, writeSync, renameSync } from 'node:fs';
import { Sim } from '../src/sim/engine';
import { exportDiagnostics, stringifyDiagnostics } from '../src/sim/diagnostics';
import { OVERLAY_PRESETS } from '../src/sim/timetable';
const options = JSON.parse(process.argv[2]) as { dayType: 'weekday' | 'weekend'; template: string; seed: number; level: 0 | 1 | 2 | 3 };
const sim = new Sim({ dayType: options.dayType, dateLabel: 'soak', startTime: 4 * 3600, seed: options.seed, autoDispatch: options.level > 0 });
const output = process.env.SOAK_OUT ?? 'tests/out/soak';
mkdirSync(output, { recursive: true });
const stem = `${output}/${options.dayType}-${options.template}-${options.level}-${options.seed}`;
const saveDiagnostics = (suffix: string) => {
  const path = `${stem}-${suffix}.json`;
  writeFileSync(`${path}.tmp`, stringifyDiagnostics(exportDiagnostics(sim)));
  renameSync(`${path}.tmp`, path);
};
if (options.level) sim.command({ c: 'randomFaults', level: options.level });
// Retain a replayable state even if the worker is killed or times out.
saveDiagnostics('checkpoint');
let applied = options.template === 'base';
let failure = '';
let clearedAt = 0;
let recoveredAt = 0;
let faultPending = false;
const wall = Date.now();
const delivered = new Set<number>();
const lateTrips: { id: number; no: string; t: number; delay: number; departures: { st: number; delay: number }[] }[] = [];
let completed = 0;
let nextProgress = 8 * 3600;
try { while (sim.t < 27.5 * 3600) {
  if (!applied) {
    const preset = OVERLAY_PRESETS.find(p => p.id === options.template)!;
    const at = preset.from;
    if (sim.t >= at - 1e-6) {
      const result = sim.command({ c: 'overlay', id: preset.id, from: sim.t, to: preset.to, headway: preset.headway });
      if (!result.ok) { failure = `Template rejected: ${result.msg}`; break; }
      applied = true;
    }
  }
  if (options.level && sim.randomLevel && sim.t >= 21 * 3600) sim.command({ c: 'randomFaults', level: 0 });
  sim.step();
  if (sim.tripsDone !== completed) {
    completed = sim.tripsDone;
    for (const train of sim.trainList) {
      const task = train.tasks[0];
      if (train.arrivedAt !== sim.t || task?.k !== 'stop' || task.trip < 0 || task.dep !== null || !sim.plan.trips[task.trip].revenue) continue;
      delivered.add(task.trip);
      const delay = task.arr === null ? 0 : sim.t - task.arr;
      if (Math.abs(delay) > 120) lateTrips.push({ id: task.trip, no: sim.plan.trips[task.trip].no, t: sim.t, delay,
        departures: sim.depLog.filter(d => d.trip === task.trip).map(d => ({ st: d.st, delay: d.delay })) });
    }
  }
  if (sim.t >= nextProgress) {
    writeSync(2, `${options.dayType}-${options.template}-${options.level}-${options.seed}: ${Math.floor(sim.t / 3600)}h, ${sim.tripsDone} trips\n`);
    saveDiagnostics('checkpoint');
    nextProgress += 4 * 3600;
  }
  const violation = sim.integrity.violations[0];
  if (violation) { failure = `${violation.kind}: ${violation.detail}`; break; }
  if (sim.secAcc !== 0) continue;
  const active = sim.faults.some(f => f.stage !== 'closed');
  if (active) { faultPending = true; clearedAt = 0; recoveredAt = 0; }
  // The KPI begins after the LAST fault is cleared, once injection has ended.
  // An intermediate fault-free gap does not establish the final recovery time.
  else if (faultPending && sim.randomLevel === 0) {
    if (!clearedAt) clearedAt = sim.t;
    if (!recoveredAt && sim.trainList.every(t => !t.inService || t.delay <= 120)) recoveredAt = sim.t;
    if (!recoveredAt && sim.t - clearedAt > 3600) { failure = 'Service did not recover within 60 minutes after clearance'; break; }
  }
} } catch (error) {
  failure = `Simulation exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
}
const delays = sim.metrics.tripDelays;
const within2 = delays.length ? delays.filter(d => Math.abs(d) <= 120).length / delays.length : 0;
const maxLate = Math.max(0, ...delays);
const planned = sim.plan.trips.filter(t => t.revenue && !t.cancelled).length;
if (!failure && sim.tripsDone !== planned) failure = `Undelivered trips: ${sim.tripsDone}/${planned}`;
if (!failure && !options.level && (within2 < 0.98 || maxLate > 300)) failure = `Punctuality: ${within2}; max delay ${maxLate}`;
if (!failure && !options.level) {
  const target = options.dayType === 'weekday' ? 1_090_000 : 763_000;
  if (sim.passengersServed < target*.9 || sim.passengersServed > target*1.1)
    failure = `Ridership: ${sim.passengersServed}, target ${target} ±10%`;
  if (options.dayType === 'weekday' && (sim.ridership.peakSectionLoad/2480 < .9 || sim.ridership.peakSectionLoad/2480 > 1.3))
    failure = `Peak section load: ${sim.ridership.peakSectionLoad}/2480, expected 90–130%`;
}
if (!failure && options.level && (sim.faults.some(f => f.stage !== 'closed') || sim.trainList.some(t => t.forceLevel === 'AUTO' && !t.manual && (t.level !== 'CBTC' || t.mode !== 'DTO')))) failure = 'Unrecovered fault or degraded state';
const result = { ...options, ok: !failure, failure, until: sim.t, integrity: sim.integrity.counts, completed: sim.tripsDone, planned,
  within2, maxLate, departurePunctuality: sim.depTotal ? sim.depOnTime / sim.depTotal : 1,
  recoverySeconds: clearedAt && recoveredAt ? recoveredAt - clearedAt : null, wallSeconds: (Date.now() - wall) / 1000,
  ridership: { boardings: sim.passengersServed, generated: sim.ridership.generated, peakLoad: sim.ridership.peakSectionLoad, maxLoad: sim.ridership.maxLoad },
  model: process.env.SOAK_MODEL_HASH, lateTrips,
  cancelledTrips: sim.plan.trips.filter(t => t.revenue && t.cancelled).map(t => ({id:t.id,no:t.no,reason:t.cancelReason ?? '救援/调度/计划容量'})),
  undelivered: sim.plan.trips.filter(t => t.revenue && !t.cancelled && !delivered.has(t.id)).map(t => ({ id: t.id, no: t.no })) };
writeFileSync(`${stem}.json`, JSON.stringify(result, null, 2));
if (failure) saveDiagnostics('diagnostics');
writeSync(1, JSON.stringify({ ...result, lateTrips: lateTrips.length, cancelledTrips: result.cancelledTrips.length, undelivered: result.undelivered.length }) + '\n');
if (failure) process.exitCode = 1;
