/**
 * Simulation checkpoints for rewind / replay (回放).
 *
 * A checkpoint is a deep copy of all dynamic state except the trains' task
 * lists, which are shared structurally: task objects are treated as
 * immutable (see cowTask in ats.ts), so only the arrays are copied. The plan
 * is captured as its mutable parts (trip count, cancellations, blocks).
 */
import type { Sim } from './engine';
import type { Train, Block } from './model';
import { indexBodies } from './movement';

export interface Checkpoint {
  t: number;
  secAcc: number;
  rngState: number;
  nextEventId: number;
  depLogLen: number;
  drivingStopsLen: number;
  data: Record<string, unknown>;
  trains: Train[];
  plan: { tripsLen: number; cancelled: Uint8Array; blocks: Block[]; periodsLen: number; overlaysLen: number; fleetPeak: number };
}

const CLONED = [
  'sw', 'sec', 'sig', 'plat', 'zoneState', 'routes', 'routeUnlockedSw', 'berthRes', 'depotStock', 'depotShortLogged', 'blockDone',
  'faults', 'alarms', 'noRouteLogged', 'truncatedTrips', 'yards', 'stabledPool', 'calls', 'pendingCalls', 'env', 'possessions',
  'metrics', 'scenario',
] as const;

const SCALARS = [
  'nextTrainId', 'nextFaultId', 'passengersServed', 'passengersCleared', 'passengersStranded', 'depTotal', 'depOnTime', 'tripsDone',
  'nextCallId', 'autoRadio', 'scenarioFired', 'randomLevel', 'nextRandomAt',
] as const;

function cloneTrain(tr: Train): Train {
  return {
    ...tr,
    hist: tr.hist.slice(),
    body: tr.body.map((b) => ({ ...b })),
    tasks: tr.tasks.slice(),
    skipStations: new Set(tr.skipStations),
    trace: [],
    drv: { ...tr.drv, stops: tr.drv.stops.slice() },
    dmiLog: tr.dmiLog.slice(),
    dmiPrev: tr.dmiPrev && { ...tr.dmiPrev },
    halt: { ...tr.halt },
    arsWait: tr.arsWait && { ...tr.arsWait },
  };
}

export function capture(sim: Sim): Checkpoint {
  const rec = sim as unknown as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const k of CLONED) data[k] = structuredClone(rec[k]);
  for (const k of SCALARS) data[k] = rec[k];
  const plan = sim.plan;
  const cancelled = new Uint8Array(plan.trips.length);
  plan.trips.forEach((t, i) => { cancelled[i] = t.cancelled ? 1 : 0; });
  return {
    t: sim.t,
    secAcc: sim.secAcc,
    rngState: sim.rngState,
    nextEventId: sim.nextEventId,
    depLogLen: sim.depLog.length,
    drivingStopsLen: sim.drivingStops.length,
    data,
    trains: sim.trainList.map(cloneTrain),
    plan: {
      tripsLen: plan.trips.length, cancelled, blocks: plan.blocks.map((b) => ({ ...b, trips: b.trips.slice() })),
      periodsLen: plan.periods.length, overlaysLen: plan.overlays.length, fleetPeak: plan.fleetPeak,
    },
  };
}

export function restore(sim: Sim, cp: Checkpoint) {
  const rec = sim as unknown as Record<string, unknown>;
  for (const k of CLONED) rec[k] = structuredClone(cp.data[k]);
  for (const k of SCALARS) rec[k] = cp.data[k];
  sim.t = cp.t;
  sim.secAcc = cp.secAcc;
  sim.rngState = cp.rngState;
  // trains
  sim.trains.clear();
  sim.trainList = cp.trains.map(cloneTrain);
  for (const tr of sim.trainList) sim.trains.set(tr.id, tr);
  indexBodies(sim);
  // plan
  const plan = sim.plan;
  plan.trips.length = cp.plan.tripsLen;
  plan.trips.forEach((t, i) => { if (cp.plan.cancelled[i]) t.cancelled = true; else delete t.cancelled; });
  plan.blocks = cp.plan.blocks.map((b) => ({ ...b, trips: b.trips.slice() }));
  plan.periods.length = cp.plan.periodsLen;
  plan.overlays.length = cp.plan.overlaysLen;
  plan.fleetPeak = cp.plan.fleetPeak;
  sim.planDirty = true;
  // logs
  sim.events = sim.events.filter((e) => e.id < cp.nextEventId);
  sim.nextEventId = cp.nextEventId;
  sim.newEvents = [];
  sim.alarmsDirty = true;
  sim.depLog.length = Math.min(sim.depLog.length, cp.depLogLen);
  sim.drivingStops.length = Math.min(sim.drivingStops.length, cp.drivingStopsLen);
  sim.removedTraces = [];
  sim.reportReady = null;
  sim.bookmarks = sim.bookmarks.filter((b) => !b.auto || b.t <= cp.t);
}

/** compact fingerprint of the dynamic state (tests: replay determinism) */
export function fingerprint(sim: Sim): string {
  return sim.trainList.map((tr) => `${tr.id}:${tr.link}:${tr.off.toFixed(3)}:${tr.v.toFixed(4)}:${tr.phase}:${tr.tasks.length}`).join('|')
    + `#${sim.t.toFixed(1)}#${sim.rngState}#${sim.tripsDone}`;
}
