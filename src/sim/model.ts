/**
 * Dynamic simulation state types (worker side) and the message protocol
 * shared with the UI thread.
 */
import type { Dir } from './topology';

export type DayType = 'weekday' | 'weekend';
export type Level = 'CBTC' | 'TBTC';
export type Mode = 'AM' | 'CM' | 'RM';
export type TrackDir = 'DN' | 'UP';
export type ZoneState = 'CBTC' | 'TBTC' | 'ZCFAIL';
export type Aspect = 'R' | 'G' | 'Y' | 'GUIDE' | 'DARK' | 'FAIL';

// ---------------------------------------------------------------- plan

export interface PlanStop {
  st: number;
  arr: number;
  dep: number;
  /** stops (doors) here; false = passes */
  stop: boolean;
}

export type TripKind = 'big' | 'small' | 'late' | 'extra' | 'ins' | 'wd' | 'empty' | 'adj';

export interface Trip {
  id: number;
  no: string;
  dir: TrackDir;
  kind: TripKind;
  from: number;
  to: number;
  stops: PlanStop[];
  revenue: boolean;
  block: number;
  /** turnback mode at the destination, when the block continues from here */
  cancelled?: boolean;
  /** label of the overlay template that created it */
  overlay?: string;
}

export type BlockEnd =
  | { kind: 'depot'; depot: number }
  | { kind: 'stable'; station: number }
  | { kind: 'none' };

export interface Block {
  id: number;
  svc: string;
  start: { kind: 'depot'; depot: number; time: number } | { kind: 'stable'; station: number };
  end: BlockEnd;
  trips: number[];
  /** train that is running this block (filled at runtime) */
  train?: number;
}

export interface Plan {
  dayType: DayType;
  trips: Trip[];
  blocks: Block[];
  /** service template periods for display */
  periods: { from: number; to: number; template: string; label: string }[];
  overlays: { id: string; label: string; from: number; to: number }[];
  fleetPeak: number;
}

// ---------------------------------------------------------------- tasks

export interface StopTask {
  k: 'stop';
  berth: number;
  station: number;
  trip: number; // trip id, -1 when unplanned
  arr: number | null;
  dep: number | null;
  doors: boolean;
  /** passenger service at this stop (false for empty / clear-out) */
  revenue: boolean;
  /** minimum dwell override */
  minDwell?: number;
  note?: string;
}
export interface ReverseTask { k: 'reverse'; berths: number[]; chosen: number; station: number; minTime: number }
export interface DepotTask { k: 'depot'; depot: number }
export interface StableTask { k: 'stable'; berth: number; reason: string }
export interface RescueTask { k: 'rescue'; target: number }
export type Task = StopTask | ReverseTask | DepotTask | StableTask | RescueTask;

// ---------------------------------------------------------------- trains

export interface BodySeg { link: number; from: number; to: number }

export type TrainPhase =
  | 'run'
  | 'dwell'
  | 'reversing'
  | 'stabled'
  | 'failed'
  | 'coupling'
  | 'depotExit';

export interface Train {
  id: number;
  vehicle: string;
  svc: string;
  tripNo: string;
  tripId: number;
  block: number;
  destText: string;
  destStation: number;
  // kinematics
  link: number;
  off: number;
  dir: Dir;
  hist: { link: number; dir: Dir }[];
  body: BodySeg[];
  len: number;
  v: number;
  a: number;
  // control
  level: Level;
  comm: boolean;
  mode: Mode;
  eb: boolean;
  ebReason: string;
  ebSince: number;
  maDist: number;
  maReason: string;
  vTarget: number;
  vPermit: number;
  stopDist: number;
  /** RM authorisation remaining metres (0 = none), and reason */
  rmAuth: number;
  rmReason: string;
  /** when > now, a mode transition (driver action) is pending */
  pendingModeAt: number;
  pendingMode: Mode | null;
  pendingLevel: Level | null;
  // service
  tasks: Task[];
  phase: TrainPhase;
  phaseSince: number;
  dwellUntil: number;
  doorsOpen: boolean;
  arrivedAt: number;
  depReadyAt: number;
  load: number;
  delay: number;
  hold: boolean;
  skipStations: Set<number>;
  /** train status flags */
  failed: boolean;
  failRecoverAt: number;
  failRecoverable: boolean;
  rescueBy: number;
  rescuing: number;
  coupledLen: number;
  inService: boolean;
  /** next signal ahead (for display / ARS) */
  nextSignal: number;
  nextSignalDist: number;
  lastStation: number;
  /** recorded actual graph points since last snapshot */
  trace: number[];
  lastTraceT: number;
  lastTraceCh: number;
  stopsMade: number;
  overspeedEvents: number;
  passedRed: number;
  withdrawn: boolean;
  /** psd bypass extra dwell */
  extraDwell: number;
}

// ---------------------------------------------------------------- infrastructure state

export interface SwitchState {
  pos: 'N' | 'R';
  target: 'N' | 'R';
  moveUntil: number;
  failed: boolean;
  fieldLock: boolean;
  singleLock: boolean;
  lockCount: number;
}

export interface SectionState {
  occ: boolean; // axle counter occupied (incl. fault)
  trainOcc: boolean; // physically occupied by any train body
  commOnly: boolean; // occupied only by communicating CBTC trains
  disturbed: boolean; // axle counter fault (受扰/故障占用)
  preset: boolean; // 预复位, awaiting sweep
  presetSeen: boolean;
  lockRoute: number; // active route id or -1
  tsr: number; // km/h, 0 = none
}

export interface ActiveRoute {
  route: number;
  state: 'setting' | 'locked';
  fleeting: boolean;
  /** former automatic route switched to one-shot by ARS */
  defleeted?: boolean;
  manual: boolean;
  guide: boolean;
  guideUntil: number;
  occSeen: boolean[];
  released: boolean[];
  entered: boolean;
  /** train that passed the start signal and owns the route (-1 = none) */
  owner: number;
  cancelAt: number; // delayed cancellation time (0 = none)
  setAt: number;
}

export interface SignalState {
  aspect: Aspect;
  route: number; // active route id or -1
  failed: boolean;
  ars: boolean; // automatic route setting allowed at this signal
  autoPass: boolean; // fleeting (自动通过) enabled
}

export interface PlatformState {
  hold: boolean;
  skip: boolean;
  esp: boolean; // emergency close
  psd: 'closed' | 'open' | 'fault';
  psdFault: boolean;
  psdBypass: boolean;
  waiting: number;
  surge: number; // multiplier
  stranded: number;
  lastDep: number;
  lastArr: number;
}

// ---------------------------------------------------------------- events

export type AlarmLevel = 'A' | 'B' | 'C' | 'I';

export interface SimEvent {
  id: number;
  t: number;
  level: AlarmLevel;
  cat: string;
  text: string;
  /** manual (dispatcher) event */
  manual?: boolean;
  /** true while it is an active alarm */
  alarm?: boolean;
  key?: string;
  ack?: boolean;
  cleared?: number;
}

export type FaultKind =
  | 'trainComm'
  | 'zcFail'
  | 'axle'
  | 'switch'
  | 'signal'
  | 'psd'
  | 'trainFail'
  | 'surge';

export interface Fault {
  id: number;
  kind: FaultKind;
  target: number; // index of object (train id, zone, section, switch, signal, platform, station)
  since: number;
  /** maintenance completes at this time (Infinity = until "立即修复") */
  repairAt: number;
  repaired: boolean;
  text: string;
  /** extra parameters */
  param?: number;
  recoverable?: boolean;
}

// ---------------------------------------------------------------- commands (UI → worker)

export type Command =
  | { c: 'setRoute'; route: number }
  | { c: 'cancelRoute'; signal: number }
  | { c: 'guideRoute'; route: number }
  | { c: 'autoPass'; signal: number; on: boolean }
  | { c: 'ars'; signal: number; on: boolean }
  | { c: 'switchMove'; sw: number; pos: 'N' | 'R' }
  | { c: 'switchLock'; sw: number; on: boolean }
  | { c: 'switchFieldLock'; sw: number; on: boolean }
  | { c: 'axleReset'; section: number }
  | { c: 'sectionUnlock'; section: number }
  | { c: 'setTsr'; sections: number[]; kmh: number }
  | { c: 'cancelTsr'; sections: number[] }
  | { c: 'platformHold'; platform: number; on: boolean }
  | { c: 'platformSkip'; platform: number; on: boolean }
  | { c: 'platformEsp'; platform: number; on: boolean }
  | { c: 'psdBypass'; platform: number; on: boolean }
  | { c: 'trainHold'; train: number; on: boolean }
  | { c: 'trainSkip'; train: number; station: number; on: boolean }
  | { c: 'turnback'; train: number; station: number }
  | { c: 'withdraw'; train: number }
  | { c: 'authRM'; train: number }
  | { c: 'rescue'; failed: number; rescuer: number }
  | { c: 'addTrain'; depot: number; dir: TrackDir; to: number; time: number }
  | { c: 'overlay'; id: string; from: number; to: number; headway: number }
  | { c: 'zoneLevel'; zones: number[]; level: 'CBTC' | 'TBTC' }
  | { c: 'ack'; ids: number[] }
  | { c: 'fault'; kind: FaultKind; target: number; duration: number; param?: number; recoverable?: boolean }
  | { c: 'repair'; fault: number };

export interface SimConfig {
  dayType: DayType;
  dateLabel: string;
  startTime: number;
  seed: number;
}

export type ToWorker =
  | { type: 'init'; config: SimConfig }
  | { type: 'speed'; speed: number }
  | { type: 'pause'; paused: boolean }
  | { type: 'jump'; to: number }
  | { type: 'cmd'; id: number; cmd: Command }
  | { type: 'restart'; config: SimConfig };

export interface TrainSnap {
  id: number;
  vehicle: string;
  svc: string;
  trip: string;
  dest: string;
  link: number;
  off: number;
  dir: Dir;
  body: number[]; // flat [link, from, to, ...]
  v: number;
  level: Level;
  comm: boolean;
  mode: Mode;
  eb: boolean;
  phase: TrainPhase;
  delay: number;
  load: number;
  hold: boolean;
  failed: boolean;
  doors: boolean;
  inService: boolean;
  chain: number;
  maReason: string;
  maDist: number;
  vPermit: number;
  nextSig: number;
  task: string;
  kind: string;
  rm: boolean;
}

export interface Snapshot {
  t: number;
  speed: number;
  paused: boolean;
  dayType: DayType;
  dateLabel: string;
  sections: Uint8Array;
  sectionTsr: Uint8Array;
  switches: Uint8Array;
  signals: Uint8Array;
  platforms: Uint8Array;
  platformWaiting: Uint16Array;
  zones: ZoneState[];
  trains: TrainSnap[];
  depotCounts: number[];
  traces: { train: number; pts: number[] }[];
  stats: {
    online: number;
    inService: number;
    late: number;
    maxDelay: number;
    punctuality: number;
    tripsDone: number;
    tripsPlanned: number;
    passengers: number;
    stepsPerSec: number;
  };
  activeRoutes: number[];
  faults: Fault[];
}

export type FromWorker =
  | { type: 'ready'; plan: Plan }
  | { type: 'snap'; snap: Snapshot }
  | { type: 'events'; events: SimEvent[] }
  | { type: 'alarms'; alarms: SimEvent[] }
  | { type: 'plan'; plan: Plan }
  | { type: 'cmdResult'; id: number; ok: boolean; msg: string }
  | { type: 'progress'; t: number; target: number };

// bit flags for packed state arrays
export const SEC = { OCC: 1, COMM: 2, LOCK: 4, DIST: 8, PRESET: 16, TSR: 32, TRAIN: 64, ROUTEFLEET: 128 } as const;
export const SW = { R: 1, MOVING: 2, FAILED: 4, LOCKED: 8, SINGLE: 16, FIELD: 32, TARGET_R: 64 } as const;
export const SIG_ASPECT: Aspect[] = ['R', 'G', 'Y', 'GUIDE', 'DARK', 'FAIL'];
export const SIGF = { ROUTE: 8, ARSOFF: 16, AUTOPASS: 32, FAILED: 64, MANUAL: 128 } as const;
export const PLT = { HOLD: 1, SKIP: 2, ESP: 4, PSDOPEN: 8, PSDFAULT: 16, BYPASS: 32, TRAIN: 64, SURGE: 128 } as const;
