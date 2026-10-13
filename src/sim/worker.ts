/// <reference lib="webworker" />
/**
 * Simulation worker: owns the Sim, advances it with a fixed time step
 * decoupled from rendering, supports time acceleration, and streams
 * snapshots / events to the UI thread. It also keeps rolling checkpoints
 * and a command log for rewind and replay (回放).
 */
import { Sim, FIXED_DT } from './engine';
import type { Command, FromWorker, ToWorker, SimConfig } from './model';
import { dayTypeOf, dateLabel, parseIso, isoDate } from './calendar';
import { capture, restore, type Checkpoint } from './state';
import { compactCheckpoints, exportDiagnostics, stringifyDiagnostics } from './diagnostics';
import { preparePlan } from './planning';

declare const self: DedicatedWorkerGlobalScope;

let sim: Sim | null = null;
let speed = 1;
let paused = false;
let acc = 0;
let lastWall = performance.now();
let lastSnap = 0;
let stepsWindow = 0;
/** simulated seconds asked for / dropped (CPU could not keep up) in the window */
let wantWindow = 0;
let droppedWindow = 0;
let windowStart = performance.now();
let jumping = false;

const SNAP_INTERVAL = 50; // ms (20 Hz)
const STEP_BUDGET = 9; // ms of simulation work per tick
const CP_INTERVAL = 60; // s of sim time between checkpoints

type LogEntry = { t: number; cmd: Command } | { t: number; drive: { train: number; notch: number } };
let checkpoints: Checkpoint[] = [];
let cmdLog: LogEntry[] = [];
let pending: LogEntry[] = [];
let replayUntil = 0;

function post(msg: FromWorker, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

/** UI subscriptions that survive a restart */
let wantPis = -1;
let wantDmi = -1;

function start(config: SimConfig) {
  sim = new Sim(config);
  sim.pisStation = wantPis;
  sim.dmiTrain = wantDmi;
  speed = 1;
  paused = false;
  acc = 0;
  checkpoints = [];
  cmdLog = [];
  pending = [];
  replayUntil = 0;
  checkpoint();
  // warm up from the start of the service day to the requested start time
  if (config.startTime > sim.t) runUntil(config.startTime, true);
  checkpoint();
  post({ type: 'ready', plan: sim.plan });
  flushEvents(true);
  sendSnapshot();
}

function checkpoint() {
  if (!sim) return;
  const cp = capture(sim);
  cp.inputCursor = cmdLog.length - pending.length;
  cp.inputs = cmdLog.slice(0, cp.inputCursor);
  checkpoints.push(cp);
  checkpoints = compactCheckpoints(checkpoints, sim.t);
}

/** one fixed step incl. replayed commands and periodic checkpoints */
function stepOnce(keepCheckpoints = true) {
  if (!sim) return;
  while (pending.length && pending[0].t <= sim.t + 1e-6) {
    const e = pending.shift()!;
    sim.replaying = true;
    if ('cmd' in e) sim.command(e.cmd);
    else applyDrive(e.drive.train, e.drive.notch);
    sim.replaying = false;
    sim.inputLog.push(structuredClone(e));
  }
  sim.step(FIXED_DT);
  const last = checkpoints[checkpoints.length - 1];
  if (keepCheckpoints && (!last || sim.t - last.t >= CP_INTERVAL - 1e-6)) checkpoint();
  if (sim.reportReady) {
    post({ type: 'report', report: sim.reportReady });
    sim.reportReady = null;
  }
}

function runUntil(target: number, initial = false) {
  if (!sim) return;
  jumping = true;
  let lastProgress = performance.now();
  while (sim.t < target) {
    stepOnce();
    if (performance.now() - lastProgress > 200) {
      lastProgress = performance.now();
      post({ type: 'progress', t: sim.t, target });
    }
  }
  jumping = false;
  if (!initial) {
    flushEvents(true);
    sendSnapshot();
  }
}

function flushEvents(force = false) {
  if (!sim) return;
  if (sim.newEvents.length) {
    post({ type: 'events', events: sim.newEvents.splice(0) });
  }
  if (sim.alarmsDirty || force) {
    sim.alarmsDirty = false;
    post({ type: 'alarms', alarms: Array.from(sim.alarms.values()) });
  }
  if (sim.planDirty) {
    sim.planDirty = false;
    post({ type: 'plan', plan: sim.plan });
  }
}

function sendSnapshot() {
  if (!sim) return;
  sim.speed = speed;
  sim.paused = paused;
  const snap = sim.snapshot();
  snap.replay = {
    from: checkpoints[0]?.t ?? sim.t, to: Math.max(sim.t, replayUntil), replaying: sim.t < replayUntil, pending: pending.length,
  };
  post({ type: 'snap', snap }, [snap.sections.buffer, snap.sectionTsr.buffer, snap.switches.buffer, snap.signals.buffer, snap.platforms.buffer, snap.platformWaiting.buffer]);
}

function applyDrive(train: number, notch: number) {
  return sim?.drive(train, notch) ?? false;
}

/** the dispatcher acts during a replay: the recorded future is discarded */
function takeOver() {
  if (!sim || !pending.length) return;
  cmdLog = cmdLog.slice(0, cmdLog.length - pending.length);
  pending = [];
  replayUntil = 0;
}

function rewind(to: number, replay: boolean) {
  if (!sim || !checkpoints.length) return;
  let idx = -1;
  for (let i = checkpoints.length - 1; i >= 0; i--) if (checkpoints[i].t <= to + 1e-6) { idx = i; break; }
  if (idx < 0) idx = 0;
  const cp = checkpoints[idx];
  const now = sim.t;
  restore(sim, cp);
  checkpoints = checkpoints.slice(0, idx + 1);
  if (replay) {
    pending = cmdLog.slice(cp.inputCursor);
    replayUntil = now;
  } else {
    pending = [];
    replayUntil = 0;
    cmdLog = cmdLog.slice(0, cp.inputCursor);
  }
  acc = 0;
  if (replay && to > sim.t) runUntil(Math.min(to, now));
  post({ type: 'rewound', t: sim.t, nextEventId: sim.nextEventId });
  flushEvents(true);
  sendSnapshot();
}

function tick() {
  if (!sim || jumping) return;
  const now = performance.now();
  const dtWall = Math.min(0.25, (now - lastWall) / 1000);
  lastWall = now;
  if (!paused) {
    acc += dtWall * speed;
    wantWindow += dtWall * speed;
    const t0 = performance.now();
    let steps = 0;
    while (acc >= FIXED_DT) {
      stepOnce();
      acc -= FIXED_DT;
      steps++;
      if ((steps & 15) === 0 && performance.now() - t0 > STEP_BUDGET) {
        // cannot keep up with the requested acceleration: drop the backlog
        if (acc > 2 * FIXED_DT * 50) { droppedWindow += acc; acc = 0; }
        break;
      }
    }
    stepsWindow += steps;
  }
  if (now - windowStart > 1000) {
    sim.stepsPerSec = Math.round(stepsWindow * 1000 / (now - windowStart));
    sim.speedWanted = paused ? 0 : wantWindow * 1000 / (now - windowStart);
    sim.droppedPerSec = droppedWindow * 1000 / (now - windowStart);
    stepsWindow = 0;
    wantWindow = 0;
    droppedWindow = 0;
    windowStart = now;
  }
  // operating-day rollover after the night shutdown (03:45)
  if (sim.t >= 27.75 * 3600 && sim.config.date) {
    const d = parseIso(sim.config.date);
    d.setDate(d.getDate() + 1);
    const keepSpeed = speed;
    const keepAuto = sim.autoRadio;
    start({ dayType: dayTypeOf(d, false), dateLabel: dateLabel(d, false), date: isoDate(d), startTime: 4 * 3600, seed: sim.config.seed + 1, autoRadio: keepAuto, randomFaults: sim.randomLevel });
    speed = keepSpeed;
    return;
  }
  if (now - lastSnap >= SNAP_INTERVAL) {
    lastSnap = now;
    flushEvents();
    sendSnapshot();
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
    case 'restart':
      start(m.config);
      break;
    case 'speed':
      speed = m.speed;
      break;
    case 'pause':
      paused = m.paused;
      break;
    case 'jump':
      if (sim && m.to > sim.t) runUntil(m.to);
      break;
    case 'cmd': {
      if (!sim) return;
      takeOver();
      const r = sim.command(m.cmd);
      cmdLog.push({ t: sim.t, cmd: m.cmd });
      post({ type: 'cmdResult', id: m.id, ok: r.ok, msg: r.msg });
      flushEvents();
      sendSnapshot();
      break;
    }
    case 'drive':
      if (!sim) return;
      if (!sim.trains.get(m.train)?.manual || !Number.isFinite(m.notch)) return;
      takeOver();
      if (applyDrive(m.train, m.notch)) cmdLog.push(structuredClone(sim.inputLog.at(-1)!));
      break;
    case 'pis':
      wantPis = m.station;
      if (sim) sim.pisStation = m.station;
      break;
    case 'dmi':
      wantDmi = m.train;
      if (sim) sim.dmiTrain = m.train;
      sendSnapshot();
      break;
    case 'rewind':
      rewind(m.to, m.replay);
      break;
    case 'takeover':
      takeOver();
      sendSnapshot();
      break;
    case 'diagnostics':
      if (sim) post({ type: 'diagnostics', json: stringifyDiagnostics(exportDiagnostics(sim, cmdLog.slice(0, cmdLog.length - pending.length))) });
      break;
    case 'planPreview':
      if (sim) post({ type: 'planPreview', id: m.id, preview: preparePlan(sim, m.cmd) });
      break;
  }
};

setInterval(tick, 8);
