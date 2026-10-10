/// <reference lib="webworker" />
/**
 * Simulation worker: owns the Sim, advances it with a fixed time step
 * decoupled from rendering, supports time acceleration, and streams
 * snapshots / events to the UI thread.
 */
import { Sim, FIXED_DT } from './engine';
import type { FromWorker, ToWorker, SimConfig } from './model';
import { dayTypeOf, dateLabel, parseIso, isoDate } from './calendar';

declare const self: DedicatedWorkerGlobalScope;

let sim: Sim | null = null;
let speed = 1;
let paused = false;
let acc = 0;
let lastWall = performance.now();
let lastSnap = 0;
let stepsWindow = 0;
let windowStart = performance.now();
let jumping = false;

const SNAP_INTERVAL = 50; // ms (20 Hz)
const STEP_BUDGET = 9; // ms of simulation work per tick

function post(msg: FromWorker, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

function start(config: SimConfig) {
  sim = new Sim(config);
  speed = 1;
  paused = false;
  acc = 0;
  // warm up from the start of the service day to the requested start time
  if (config.startTime > sim.t) runUntil(config.startTime, true);
  post({ type: 'ready', plan: sim.plan });
  flushEvents(true);
  sendSnapshot();
}

function runUntil(target: number, initial = false) {
  if (!sim) return;
  jumping = true;
  let lastProgress = performance.now();
  while (sim.t < target) {
    sim.step(FIXED_DT);
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
  post({ type: 'snap', snap }, [snap.sections.buffer, snap.sectionTsr.buffer, snap.switches.buffer, snap.signals.buffer, snap.platforms.buffer, snap.platformWaiting.buffer]);
}

function tick() {
  if (!sim || jumping) return;
  const now = performance.now();
  const dtWall = Math.min(0.25, (now - lastWall) / 1000);
  lastWall = now;
  if (!paused) {
    acc += dtWall * speed;
    const t0 = performance.now();
    let steps = 0;
    while (acc >= FIXED_DT) {
      sim.step(FIXED_DT);
      acc -= FIXED_DT;
      steps++;
      if ((steps & 15) === 0 && performance.now() - t0 > STEP_BUDGET) {
        // cannot keep up with the requested acceleration: drop the backlog
        if (acc > 2 * FIXED_DT * 50) acc = 0;
        break;
      }
    }
    stepsWindow += steps;
  }
  if (now - windowStart > 1000) {
    sim.stepsPerSec = Math.round(stepsWindow * 1000 / (now - windowStart));
    stepsWindow = 0;
    windowStart = now;
  }
  // operating-day rollover after the night shutdown (03:45)
  if (sim.t >= 27.75 * 3600 && sim.config.date) {
    const d = parseIso(sim.config.date);
    d.setDate(d.getDate() + 1);
    const keepSpeed = speed;
    start({ dayType: dayTypeOf(d, false), dateLabel: dateLabel(d, false), date: isoDate(d), startTime: 4 * 3600, seed: sim.config.seed + 1 });
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
      const r = sim.command(m.cmd);
      post({ type: 'cmdResult', id: m.id, ok: r.ok, msg: r.msg });
      flushEvents();
      sendSnapshot();
      break;
    }
  }
};

setInterval(tick, 8);
