/**
 * ATS: train spawning from the plan, task execution (dwell, turnback, depot),
 * automatic route setting (ARS) with plan-order arbitration, dwell
 * regulation and dispatcher train commands.
 */
import type { Sim } from './engine';
import type { Block, StopTask, Task, Train, Trip, TrackDir } from './model';
import type { Dir, Topology } from './topology';
import { nextLink } from './topology';
import { cancelRoute, swPos, trySetRoute, releaseRoute, approachLocked } from './interlocking';
import { computeBody, reverseTrain, goalBerth, triggerEB } from './movement';
import { blockTasks, tripTasks, addTurnback, turnbackAt, buildStops, platformBerth, entryStation } from './timetable';
import { STATIONS, LINE_INFO } from '../data/line2';
import { boardAndAlight } from './passengers';

// ---------------------------------------------------------------- route table

export interface RouteTable {
  /** per berth: best next route id for each signal (-1 = unreachable) */
  next: Map<number, Int32Array>;
  dist: Map<number, Float64Array>;
}

export function buildRouteTable(topo: Topology): RouteTable {
  const next = new Map<number, Int32Array>();
  const dist = new Map<number, Float64Array>();
  const nS = topo.signals.length;
  const cost = (rid: number) => {
    const r = topo.routes[rid];
    return r.length + (r.wrongDir ? 6000 : 0) + (r.diverging ? 250 : 0);
  };
  for (const b of topo.berths) {
    const d = new Float64Array(nS).fill(Infinity);
    const nx = new Int32Array(nS).fill(-1);
    for (const r of topo.routes) {
      if (r.berths.includes(b.id)) {
        const c = cost(r.id) * 0.5;
        if (c < d[r.start]) { d[r.start] = c; nx[r.start] = r.id; }
      }
    }
    // Bellman-Ford style relaxation (graph is small)
    for (let iter = 0; iter < 60; iter++) {
      let changed = false;
      for (const r of topo.routes) {
        if (r.end < 0 || d[r.end] === Infinity) continue;
        const c = cost(r.id) + d[r.end];
        if (c < d[r.start] - 1e-6) { d[r.start] = c; nx[r.start] = r.id; changed = true; }
      }
      if (!changed) break;
    }
    next.set(b.id, nx);
    dist.set(b.id, d);
  }
  return { next, dist };
}

/** does the route set at its start signal lead (reasonably) towards the goal berth? */
export function routeLeadsTo(sim: Sim, rid: number, goal: number): boolean {
  const r = sim.topo.routes[rid];
  if (r.berths.includes(goal)) return true;
  const dist = sim.routeTable.dist.get(goal);
  if (!dist) return true;
  const best = dist[r.start];
  if (best === Infinity) return true; // unknown: do not block
  if (r.end < 0) return false;
  const via = r.length + (r.wrongDir ? 6000 : 0) + (r.diverging ? 250 : 0) + dist[r.end];
  return via <= best * 1.25 + 300;
}

// ---------------------------------------------------------------- helpers

export function trainLabel(tr: Train) {
  return `${tr.svc}-${tr.tripNo}`;
}

function curStop(tr: Train): StopTask | null {
  const t = tr.tasks[0];
  return t && t.k === 'stop' ? t : null;
}

/** first signal ahead of an arbitrary point (following switch positions) */
export function signalAheadFrom(sim: Sim, link: number, off: number, dir: Dir, maxDist = 600): { sig: number; dist: number } | null {
  const { topo } = sim;
  let l = link;
  let d0 = dir;
  let dist = d0 === 1 ? topo.links[l].len - off : off;
  for (let i = 0; i < 30 && dist < maxDist; i++) {
    const nx = nextLink(topo, l, d0, (sw) => swPos(sim, sw));
    if (!nx) return null;
    const sid = topo.signalByEntry.get(nx.node * 65536 + nx.link);
    if (sid !== undefined) return { sig: sid, dist };
    l = nx.link;
    d0 = nx.dir;
    dist += topo.links[l].len;
  }
  return null;
}

/** berth occupied or reserved by another train? */
function berthBusy(sim: Sim, berth: number, self: number): boolean {
  const res = sim.berthRes.get(berth);
  if (res !== undefined && res !== self && sim.trains.has(res)) return true;
  const b = sim.topo.berths[berth];
  const sec = sim.topo.links[b.link].section;
  for (const lid of sim.topo.sections[sec].links) {
    const segs = sim.linkBodies.get(lid);
    if (segs && segs.some((s) => s.train !== self)) return true;
  }
  return false;
}

function resolveChoice(sim: Sim, tr: Train, task: Task) {
  if (task.k === 'reverse') {
    const cur = sim.berthRes.get(task.chosen);
    if (cur === tr.id) return;
    const free = task.berths.filter((b) => !berthBusy(sim, b, tr.id));
    const pick = free[0] ?? task.berths[0];
    task.chosen = pick;
    if (!berthBusy(sim, pick, tr.id)) sim.berthRes.set(pick, tr.id);
  } else if (task.k === 'stable' && task.berth < 0) {
    const st = sim.topo.stations[tr.lastStation >= 0 ? tr.lastStation : 0];
    const opts = st.turnbackBerths.filter((b) => !berthBusy(sim, b, tr.id));
    if (opts.length) { task.berth = opts[0]; sim.berthRes.set(opts[0], tr.id); }
  }
}

function taskGoal(sim: Sim, task: Task | undefined): number {
  if (!task) return -1;
  if (task.k === 'stop') return task.berth;
  if (task.k === 'reverse') return task.chosen;
  if (task.k === 'stable') return task.berth;
  if (task.k === 'depot') return sim.topo.depots[task.depot].berth;
  if (task.k === 'rescue') {
    const f = sim.trains.get(task.target);
    if (!f) return -1;
    return -2;
  }
  return -1;
}

function plannedTime(task: Task | undefined, now: number): number {
  if (!task) return now + 3600;
  if (task.k === 'stop') return task.arr ?? task.dep ?? now;
  return now + 60;
}

// ---------------------------------------------------------------- spawning

let vehicleSeq = 0;
export function nextVehicle(): string {
  vehicleSeq = (vehicleSeq % LINE_INFO.fleet) + 1;
  return `02${String(vehicleSeq).padStart(2, '0')}`;
}
export function resetVehicles() { vehicleSeq = 0; }

export function newTrain(sim: Sim, block: Block | null, link: number, off: number, dir: Dir, hist: { link: number; dir: Dir }[]): Train {
  const tr: Train = {
    id: sim.nextTrainId++, vehicle: nextVehicle(), svc: block?.svc ?? '---', tripNo: '----', tripId: -1, block: block?.id ?? -1,
    destText: '', destStation: -1,
    link, off, dir, hist, body: [], len: LINE_INFO.trainLength, v: 0, a: 0,
    level: 'CBTC', comm: true, mode: 'AM', eb: false, ebReason: '', ebSince: 0,
    maDist: 0, maReason: '', vTarget: 0, vPermit: 0, stopDist: Infinity, rmAuth: 0, rmReason: '',
    pendingModeAt: 0, pendingMode: null, pendingLevel: null,
    tasks: [], phase: 'run', phaseSince: sim.t, dwellUntil: 0, doorsOpen: false, arrivedAt: 0, depReadyAt: 0,
    load: 0, delay: 0, hold: false, skipStations: new Set(), failed: false, failRecoverAt: 0, failRecoverable: true,
    rescueBy: -1, rescuing: -1, coupledLen: 0, inService: true, nextSignal: -1, nextSignalDist: Infinity,
    lastStation: -1, trace: [], lastTraceT: -1e9, lastTraceCh: NaN, stopsMade: 0, overspeedEvents: 0, passedRed: 0,
    withdrawn: false, extraDwell: 0,
  };
  computeBody(sim, tr);
  sim.addTrain(tr);
  return tr;
}

/** spawn trains whose block starts now */
export function spawnDue(sim: Sim) {
  const { topo } = sim;
  for (const b of sim.plan.blocks) {
    if (b.train !== undefined || sim.blockDone.has(b.id)) continue;
    if (b.start.kind === 'stable') {
      if (sim.t < sim.dayStart + 1) spawnStabled(sim, b);
      continue;
    }
    if (sim.t < b.start.time) continue;
    const dp = topo.depots[b.start.depot];
    // transfer track must be free
    const t1 = topo.links[dp.gateLink];
    const exitL = topo.nodes[t1.a].links.find((l) => l !== dp.gateLink)!;
    const busy = [dp.gateLink, exitL].some((l) => (sim.linkBodies.get(l)?.length ?? 0) > 0 || sim.sec[topo.links[l].section].occ);
    if (busy) continue;
    if (sim.depotStock[b.start.depot] <= 0) {
      if (!sim.depotShortLogged.has(b.id)) {
        sim.depotShortLogged.add(b.id);
        sim.log('B', '车辆', `${dp.name} 无可用车辆，表号 ${b.svc} 出段延误`, { key: `short-${b.id}` });
      }
      continue;
    }
    sim.clearAlarm(`short-${b.id}`);
    sim.depotStock[b.start.depot]--;
    // head on the transfer link next to the exit signal, heading towards the main line
    const exitLink = topo.links[topo.nodes[t1.a].links.find((l) => l !== dp.gateLink)!];
    // exitLink runs j1 → j2 (a = j1). Train heads -1 on it.
    const tr = newTrain(sim, b, exitLink.id, 15, -1, [{ link: dp.gateLink, dir: -1 }, { link: exitLink.id, dir: -1 }]);
    tr.tasks = blockTasks(topo, sim.plan, b);
    b.train = tr.id;
    tr.phase = 'run';
    sim.log('I', '车辆', `表号 ${b.svc}（${tr.vehicle}）由${dp.name}出段`);
    setTripFromTasks(sim, tr);
  }
}

function spawnStabled(sim: Sim, b: Block) {
  const { topo } = sim;
  if (b.start.kind !== 'stable') return;
  const st = topo.stations[b.start.station];
  const tb = st.turnbackBerths.filter((x) => !berthBusy(sim, x, -1));
  const bid = tb[0];
  if (bid === undefined) return;
  const berth = topo.berths[bid];
  const l = topo.links[berth.link];
  // place body ending at the berth, then reverse so the head faces the platform
  const headOff = berth.offset;
  const tr = newTrain(sim, b, berth.link, headOff, berth.dir, [{ link: berth.link, dir: berth.dir }]);
  void l;
  reverseTrain(sim, tr);
  tr.tasks = blockTasks(topo, sim.plan, b);
  tr.lastStation = st.index;
  b.train = tr.id;
  setTripFromTasks(sim, tr);
}

export function setTripFromTasks(sim: Sim, tr: Train) {
  const t = tr.tasks.find((x) => x.k === 'stop') as StopTask | undefined;
  if (!t || t.trip < 0) {
    if (tr.tasks[0]?.k === 'depot') { tr.tripNo = '回段'; tr.destText = sim.topo.depots[(tr.tasks[0] as { depot: number }).depot].short; }
    return;
  }
  const trip = sim.plan.trips[t.trip];
  if (tr.tripId !== trip.id) {
    tr.tripId = trip.id;
    tr.tripNo = trip.no;
    tr.destStation = trip.to;
    tr.destText = STATIONS[trip.to].name;
    tr.inService = trip.revenue;
  }
}

// ---------------------------------------------------------------- per-step task logic

export function updateTrainTasks(sim: Sim, tr: Train) {
  const { topo } = sim;
  const task = tr.tasks[0];
  if (tr.failed) return;

  if (tr.phase === 'run') {
    if (!task) {
      // nothing left: stop where we are
      return;
    }
    if (task.k === 'stop') {
      // skip-stop handling (not for terminal / non-revenue)
      const p = topo.berths[task.berth].platform;
      const isTripEnd = task.dep === null;
      if (task.revenue && !isTripEnd && tr.v > 0.1 && (sim.plat[p].skip || tr.skipStations.has(task.station)) && tr.stopDist < 400) {
        tr.skipStations.delete(task.station);
        sim.log('I', '调度', `列车 ${trainLabel(tr)} 跳停 ${STATIONS[task.station].name}`);
        tr.tasks.shift();
        return;
      }
    }
    if (task.k === 'reverse' || (task.k === 'stable' && task.berth < 0)) resolveChoice(sim, tr, task);
    const goal = taskGoal(sim, task);
    if (goal >= 0 && tr.v < 0.05 && tr.stopDist < 0.8) {
      arriveAtBerth(sim, tr, task);
    }
    if (task.k === 'depot') {
      const b = topo.berths[topo.depots[task.depot].berth];
      if (tr.link === b.link && Math.abs(tr.off - b.offset) < 1.5 && tr.v < 0.05) enterDepot(sim, tr, task.depot);
    }
    if (task.k === 'rescue') rescueStep(sim, tr, task.target);
    return;
  }

  if (tr.phase === 'dwell') {
    const st = task as StopTask;
    const p = topo.berths[st.berth].platform;
    const ps = sim.plat[p];
    if (ps.esp) { tr.dwellUntil = Math.max(tr.dwellUntil, sim.t + 1); return; }
    const held = tr.hold || ps.hold;
    if (sim.t < tr.dwellUntil || held) return;
    // doors closing
    if (tr.doorsOpen) {
      if (ps.psdFault && !ps.psdBypass) {
        if (ps.psd !== 'fault') {
          ps.psd = 'fault';
          sim.log('A', '车站', `${topo.platforms[p].name} 站台门无法关闭锁紧，列车 ${trainLabel(tr)} 无法发车`, { key: `psd-${p}` });
        }
        return;
      }
      tr.doorsOpen = false;
      ps.psd = ps.psdFault ? 'fault' : 'closed';
      tr.dwellUntil = sim.t + 4 + (ps.psdFault && ps.psdBypass ? 25 : 0);
      if (ps.psdFault && ps.psdBypass) sim.log('I', '车站', `${topo.platforms[p].name} 站台门互锁解除，人工确认后发车`);
      return;
    }
    // depart
    tr.tasks.shift();
    ps.lastDep = sim.t;
    tr.phase = 'run';
    tr.phaseSince = sim.t;
    if (st.dep !== null) tr.delay = sim.t - st.dep;
    sim.noteDeparture(st);
    recordTrace(sim, tr, true);
    if (sim.berthRes.get(st.berth) === tr.id) sim.berthRes.delete(st.berth);
    setTripFromTasks(sim, tr);
    if (tr.tasks[0] && (tr.tasks[0].k === 'reverse' || tr.tasks[0].k === 'stable')) resolveChoice(sim, tr, tr.tasks[0]);
    return;
  }

  if (tr.phase === 'reversing') {
    if (sim.t < tr.dwellUntil) return;
    const t = tr.tasks.shift();
    if (t && t.k === 'reverse' && sim.berthRes.get(t.chosen) === tr.id) sim.berthRes.delete(t.chosen);
    reverseTrain(sim, tr);
    tr.phase = 'run';
    tr.phaseSince = sim.t;
    setTripFromTasks(sim, tr);
    return;
  }

  if (tr.phase === 'coupling') {
    if (sim.t >= tr.dwellUntil) completeCoupling(sim, tr);
  }
}

function arriveAtBerth(sim: Sim, tr: Train, task: Task) {
  const { topo } = sim;
  tr.v = 0;
  if (task.k === 'stop') {
    const p = topo.berths[task.berth].platform;
    const ps = sim.plat[p];
    tr.phase = 'dwell';
    tr.phaseSince = sim.t;
    tr.arrivedAt = sim.t;
    tr.lastStation = task.station;
    tr.stopsMade++;
    ps.lastArr = sim.t;
    if (task.arr !== null) tr.delay = sim.t - task.arr;
    if (task.dep === null && task.trip >= 0 && sim.plan.trips[task.trip].revenue) sim.tripsDone++;
    recordTrace(sim, tr, true);
    let dwell = 10;
    if (task.doors) {
      tr.doorsOpen = true;
      ps.psd = ps.psdFault ? 'fault' : 'open';
      const paxDwell = boardAndAlight(sim, tr, p, task);
      dwell = Math.max(task.minDwell ?? 18, paxDwell);
    } else if (!task.revenue && tr.load > 0) {
      // clear-out (清客)
      tr.doorsOpen = true;
      ps.psd = ps.psdFault ? 'fault' : 'open';
      sim.passengersCleared += tr.load;
      tr.load = 0;
      dwell = Math.max(task.minDwell ?? 60, 60);
    }
    if (task.minDwell) dwell = Math.max(dwell, task.minDwell);
    // regulation: hold early trains to the timetable, shorten dwell for late ones
    let ready = sim.t + dwell;
    if (task.dep !== null) ready = Math.max(ready, task.dep);
    if (task.dep !== null && task.arr === null) ready = Math.max(ready, sim.t + 20);
    tr.dwellUntil = ready;
    tr.depReadyAt = ready;
    if (task.dep === null && tr.tasks[1]?.k !== 'reverse' && tr.tasks.length > 1 && tr.tasks[1]?.k !== 'stop') {
      // end of a trip (e.g. before depot): short dwell
    }
    return;
  }
  if (task.k === 'reverse') {
    tr.phase = 'reversing';
    tr.phaseSince = sim.t;
    tr.dwellUntil = sim.t + task.minTime;
    tr.lastStation = task.station;
    return;
  }
  if (task.k === 'stable') {
    tr.phase = 'stabled';
    tr.phaseSince = sim.t;
    tr.inService = false;
    tr.tripNo = '存车';
    tr.destText = '';
    tr.tasks.shift();
    sim.log('I', '车辆', `列车 ${tr.svc}（${tr.vehicle}）${task.reason}于 ${sim.topo.berths[task.berth].name}`);
    finishBlock(sim, tr);
  }
}

function enterDepot(sim: Sim, tr: Train, depot: number) {
  const dp = sim.topo.depots[depot];
  sim.depotStock[depot] += tr.coupledLen > 0 ? 2 : 1;
  sim.log('I', '车辆', `列车 ${tr.svc}（${tr.vehicle}）入${dp.name}`);
  finishBlock(sim, tr);
  sim.removeTrain(tr);
}

function finishBlock(sim: Sim, tr: Train) {
  if (tr.block >= 0) {
    sim.blockDone.add(tr.block);
    const b = sim.plan.blocks[tr.block];
    if (b) b.train = undefined;
  }
}

// ---------------------------------------------------------------- traces (actual train graph)

export function recordTrace(sim: Sim, tr: Train, force = false) {
  const ch = sim.trainChain(tr);
  if (!Number.isFinite(ch)) return;
  if (!force && sim.t - tr.lastTraceT < 20) return;
  if (!force && Math.abs(ch - tr.lastTraceCh) < 1 && sim.t - tr.lastTraceT < 120) return;
  // break the line when the train is out of revenue/position jumps
  tr.trace.push(sim.t, ch, tr.inService ? 1 : 0);
  tr.lastTraceT = sim.t;
  tr.lastTraceCh = ch;
}

// ---------------------------------------------------------------- ARS

interface Desire { train: Train; signal: number; route: number; prio: number; eta: number; ready: boolean; berthWait?: boolean; chainSecs?: number[] }

export function runARS(sim: Sim) {
  const { topo } = sim;
  const desires: Desire[] = [];
  for (const tr of sim.trainList) {
    if (tr.failed || tr.phase === 'stabled' || tr.phase === 'coupling') continue;
    const d = trainDesire(sim, tr);
    if (d) desires.push(d);
  }
  desires.sort((a, b) => a.prio - b.prio || a.eta - b.eta);
  const reserved = new Map<number, Desire>();
  const desiredSigs = new Set<number>();
  const desiredSecs = new Set<number>();
  const desiredSw = new Map<number, 'N' | 'R'>();
  for (const d of desires) {
    const r = topo.routes[d.route];
    desiredSigs.add(d.signal);
    for (const s of d.chainSecs ?? r.sections) desiredSecs.add(s);
    for (const x of r.switches) desiredSw.set(x.sw, x.pos);
  }
  for (const d of desires) {
    const r = topo.routes[d.route];
    const secs = d.chainSecs ?? r.sections;
    // a reservation never blocks a train that is standing inside the reserved path (it has to clear it)
    const own = new Set(d.train.body.map((b) => topo.links[b.link].section));
    const blocked = secs.some((s) => {
      const o = reserved.get(s);
      if (!o || o === d) return false;
      return !(o.chainSecs ?? topo.routes[o.route].sections).some((x) => own.has(x));
    });
    if ((d.ready || d.berthWait) && d.eta < 100 && !blocked) for (const s of secs) if (!reserved.has(s)) reserved.set(s, d);
    if (blocked) continue;
    if (!d.ready) {
      // waiting for an occupied berth on a wrong-direction move: stop the
      // conflicting automatic routes re-arming so the berth can be reached
      if (d.berthWait) {
        for (const s of secs) {
          const ar = sim.sec[s].lockRoute >= 0 ? sim.routes.get(sim.sec[s].lockRoute) : undefined;
          if (ar && ar.fleeting && !ar.manual && sim.sig[topo.routes[ar.route].start].ars) { ar.fleeting = false; ar.defleeted = true; }
        }
      }
      continue;
    }
    const sg = sim.sig[d.signal];
    if (!sg.ars) continue;
    if (sg.route >= 0 && sg.route !== d.route) {
      const ar = sim.routes.get(sg.route)!;
      if (ar.manual) continue;
      const res = cancelRoute(sim, d.signal);
      if (!res.ok || sg.route >= 0) continue;
    }
    if (sg.route === d.route) continue;
    let res = trySetRoute(sim, d.route, { fleeting: false });
    if (!res.ok) {
      // try to clear conflicting idle automatic routes (sections or switches held by them)
      const conflicts = new Set<number>();
      for (const s of r.sections) {
        const lr = sim.sec[s].lockRoute;
        if (lr >= 0 && lr !== d.route) conflicts.add(lr);
      }
      for (const { sw, pos } of r.switches) {
        if (sim.sw[sw].lockCount === 0 || sim.sw[sw].pos === pos) continue;
        for (const [rid2] of sim.routes) {
          if (rid2 !== d.route && topo.routes[rid2].switches.some((x) => x.sw === sw)) conflicts.add(rid2);
        }
      }
      let cleared = false;
      for (const lr of conflicts) {
        const ar = sim.routes.get(lr);
        if (!ar || !ar.fleeting || ar.manual) continue;
        const other = topo.routes[lr];
        if (!sim.sig[other.start].ars) continue;
        if (approachLocked(sim, other.start) || other.sections.some((x) => sim.sec[x].trainOcc)) {
          // let the train already committed to it through, but stop the
          // automatic route re-arming for the following ones
          ar.fleeting = false;
          ar.defleeted = true;
          continue;
        }
        const c = cancelRoute(sim, other.start);
        if (c.ok) cleared = true;
      }
      if (cleared) res = trySetRoute(sim, d.route, { fleeting: false });
    }
  }
  // restore automatic (fleeting) routes on idle signals
  for (let i = 0; i < sim.sig.length; i++) {
    const sg = sim.sig[i];
    if (sg.route >= 0 || !sg.ars || !sg.autoPass || desiredSigs.has(i)) continue;
    const fr = topo.signals[i].routes.find((rid) => topo.routes[rid].fleeting);
    if (fr === undefined) continue;
    if (topo.routes[fr].sections.some((s) => desiredSecs.has(s))) continue;
    if (topo.routes[fr].switches.some((x) => desiredSw.has(x.sw) && desiredSw.get(x.sw) !== x.pos)) continue;
    trySetRoute(sim, fr, { fleeting: true });
  }
}

export function trainDesire(sim: Sim, tr: Train): Desire | null {
  const { topo } = sim;
  let goalTask: Task | undefined = tr.tasks[0];
  let startSig = tr.nextSignal;
  let dist = tr.nextSignalDist;
  let ready = true;
  let eta = dist / Math.max(tr.v, 6);

  if (tr.phase === 'dwell') {
    goalTask = tr.tasks[1];
    const remain = Math.max(0, tr.dwellUntil - sim.t);
    if (tr.hold || sim.plat[topo.berths[(tr.tasks[0] as StopTask).berth].platform].hold) return null;
    eta = remain + dist / 6;
    ready = remain <= 25;
  } else if (tr.phase === 'reversing') {
    goalTask = tr.tasks[1];
    const tail = tailPoint(sim, tr);
    const ahead = signalAheadFrom(sim, tail.link, tail.off, tail.dir, 400);
    if (!ahead) return null;
    startSig = ahead.sig;
    dist = ahead.dist;
    const remain = Math.max(0, tr.dwellUntil - sim.t);
    eta = remain + dist / 6;
    ready = remain <= 30;
  } else if (tr.phase !== 'run') return null;
  else if (goalTask && tr.stopDist < tr.nextSignalDist && goalTask.k !== 'depot') {
    // will stop before the next signal: nothing to do yet
    return null;
  }
  if (!goalTask) return null;
  if (goalTask.k === 'reverse' || (goalTask.k === 'stable' && goalTask.berth < 0)) resolveChoice(sim, tr, goalTask);
  let goal = taskGoal(sim, goalTask);
  if (goal === -2 && goalTask.k === 'rescue') {
    // rescue: head for the failed train — route towards its next berth in our direction
    const f = sim.trains.get(goalTask.target);
    if (!f) return null;
    goal = nearestBerthAhead(sim, f);
    if (goal < 0) return null;
  }
  if (goal < 0 || startSig < 0) return null;
  const table = sim.routeTable.next.get(goal)!;
  let sig = startSig;
  for (let level = 0; level < 4; level++) {
    const rid = table[sig];
    if (rid < 0) {
      if (!sim.noRouteLogged.has(tr.id * 1000 + sig)) {
        sim.noRouteLogged.add(tr.id * 1000 + sig);
        sim.log('C', 'ATS', `列车 ${trainLabel(tr)} 在 ${topo.signals[sig].name} 无可用进路至 ${topo.berths[goal].name}`);
      }
      return null;
    }
    const sg = sim.sig[sig];
    if (sg.route === rid) {
      const ar = sim.routes.get(rid)!;
      // consumed by another train: wait for its release
      if (ar.entered && !ar.fleeting && ar.owner !== tr.id) return null;
      const r = topo.routes[rid];
      if (r.berths.includes(goal) || r.end < 0) return null;
      dist += r.length;
      eta += r.length / Math.max(tr.v, 8);
      sig = r.end;
      if (dist > 2500) return null;
      continue;
    }
    // route needed here
    const prio = plannedTime(goalTask, sim.t);
    const r = topo.routes[rid];
    let ok = ready && (level === 0 || dist < 1500);
    // do not route into a berth occupied by another train
    let berthWait = false;
    if (r.berths.includes(goal) && berthBusy(sim, goal, tr.id)) { berthWait = ok; ok = false; }
    // do not occupy an origin platform long before departure: at terminals only
    // the next train in departure order may move up; on through platforms
    // (depot insertions) arrive just before the slot
    if (goalTask.k === 'stop' && goalTask.dep !== null && (goalTask.arr === null || goalTask.arr === goalTask.dep)) {
      // time to reach the platform along the planned routes (~12 m/s average incl. junction speeds)
      const tableDist = sim.routeTable.dist.get(goal)?.[sig] ?? 0;
      const etaGoal = (tr.phase === 'dwell' || tr.phase === 'reversing' ? eta : 0) + (dist + (Number.isFinite(tableDist) ? tableDist : 0)) / 15 + 30;
      const terminal = topo.stations[goalTask.station].turnbackBerths.length > 0 && (goalTask.station === 0 || goalTask.station === topo.stations.length - 1 || isTurnbackOrigin(sim, goalTask));
      if (terminal) {
        if (goalTask.dep - sim.t - eta > 240 && !isNextDeparture(sim, tr, goal, goalTask.dep) && !tailsBlocked(sim, tr, goalTask.station)) ok = false;
      }
      else if (goalTask.dep - sim.t - etaGoal > 40) ok = false;
    }
    // wrong-direction moves (station-front turnback, single-line working) are
    // only started when the whole path to the berth can be secured at once
    const chain = routeChain(sim, sig, goal);
    if (chain.some((c) => topo.routes[c].wrongDir)) {
      const chainSecs = Array.from(new Set(chain.flatMap((c) => topo.routes[c].sections)));
      const free = chain.every((c) => chainRouteFree(sim, c, chain, tr.id)) && !berthBusy(sim, goal, tr.id);
      if (!free) { berthWait = ok; ok = false; }
      return { train: tr, signal: sig, route: rid, prio, eta, ready: ok, berthWait, chainSecs };
    }
    return { train: tr, signal: sig, route: rid, prio, eta, ready: ok, berthWait: berthWait && r.wrongDir };
  }
  return null;
}

/** no other train (terminating-and-turning or passing through) is due to leave this platform before us */
/** routes from `sig` to the goal berth following the route table */
function routeChain(sim: Sim, sig: number, goal: number): number[] {
  const table = sim.routeTable.next.get(goal)!;
  const out: number[] = [];
  let s = sig;
  for (let i = 0; i < 8 && s >= 0; i++) {
    const r = table[s];
    if (r < 0) break;
    out.push(r);
    const rr = sim.topo.routes[r];
    if (rr.berths.includes(goal)) break;
    s = rr.end;
  }
  return out;
}

/** can this route of a chain be set now (ignoring idle automatic routes and the chain itself)? */
function chainRouteFree(sim: Sim, rid: number, chain: number[], self: number): boolean {
  const { topo } = sim;
  const r = topo.routes[rid];
  if (sim.sig[r.start].route === rid) return true;
  for (const s of r.sections) {
    const lr = sim.sec[s].lockRoute;
    if (lr >= 0 && !chain.includes(lr)) {
      const ar = sim.routes.get(lr);
      if (!ar || !(ar.fleeting || ar.defleeted) || ar.manual) return false;
    }
    if (sim.sec[s].disturbed) return false;
    for (const lid of topo.sections[s].links) {
      if (sim.linkBodies.get(lid)?.some((b) => b.train !== self)) return false;
    }
  }
  for (const { sw, pos } of r.switches) {
    const st = sim.sw[sw];
    if (st.failed && !st.fieldLock) return false;
    if (st.pos !== pos && st.lockCount > 0) {
      // held by another route in a different position
      const holders = Array.from(sim.routes.keys()).filter((x) => topo.routes[x].switches.some((y) => y.sw === sw));
      if (holders.some((x) => !chain.includes(x) && !(sim.routes.get(x)!.fleeting || sim.routes.get(x)!.defleeted))) return false;
    }
  }
  return true;
}

function isNextDeparture(sim: Sim, self: Train, berth: number, dep: number): boolean {
  const platform = sim.topo.berths[berth].platform;
  for (const tr of sim.trainList) {
    if (tr.id === self.id) continue;
    for (let i = 0; i < Math.min(6, tr.tasks.length); i++) {
      const t = tr.tasks[i];
      if (t.k !== 'stop' || t.dep === null || t.dep >= dep) continue;
      if (sim.topo.berths[t.berth].platform === platform) return false;
    }
  }
  return true;
}

/** all turnback berths at the station are occupied and another train is queued to turn back */
function tailsBlocked(sim: Sim, self: Train, station: number): boolean {
  const berths = sim.topo.stations[station].turnbackBerths;
  if (!berths.length || !berths.every((b) => berthBusy(sim, b, -1))) return false;
  return sim.trainList.some((t) => t.id !== self.id && t.tasks.slice(0, 2).some((k) => k.k === 'reverse' && k.station === station) && t.phase !== 'reversing');
}

/** origin stop reached by a turnback at this station (train is turning, not inserted) */
function isTurnbackOrigin(sim: Sim, task: StopTask): boolean {
  void sim;
  return task.trip >= 0 && ['big', 'small', 'late', 'extra', 'adj'].includes(sim.plan.trips[task.trip].kind);
}

function tailPoint(_sim: Sim, tr: Train): { link: number; off: number; dir: Dir } {
  const segs = tr.body;
  const hist = tr.hist.slice(tr.hist.length - segs.length);
  const tailSeg = segs[segs.length - 1];
  const tailDir = hist[0].dir;
  return { link: tailSeg.link, off: tailDir === 1 ? tailSeg.from : tailSeg.to, dir: (tailDir === 1 ? -1 : 1) as Dir };
}

/** a berth just beyond the failed train in its travel direction (rescue routing) */
function nearestBerthAhead(sim: Sim, f: Train): number {
  const { topo } = sim;
  let l = f.link;
  let d = f.dir;
  for (let i = 0; i < 40; i++) {
    for (const b of topo.berths) if (b.link === l && b.dir === d && b.kind === 'platform') return b.id;
    const nx = nextLink(topo, l, d, (sw) => swPos(sim, sw));
    if (!nx) return -1;
    l = nx.link;
    d = nx.dir;
  }
  return -1;
}

// ---------------------------------------------------------------- level / mode management (per second)

export function updateLevels(sim: Sim) {
  const { topo } = sim;
  for (const tr of sim.trainList) {
    const zone = sim.zoneState[topo.links[tr.link].zone];
    // pending driver actions
    if (tr.pendingMode && sim.t >= tr.pendingModeAt) {
      if (tr.pendingLevel) tr.level = tr.pendingLevel;
      tr.mode = tr.pendingMode;
      sim.log('I', '列车', `列车 ${trainLabel(tr)} 转换为 ${tr.level === 'TBTC' ? 'TBTC后备' : 'CBTC'} ${tr.mode} 模式`);
      tr.pendingMode = null;
      tr.pendingLevel = null;
    }
    if (tr.pendingMode) continue;
    // RM authorisation finished → back to supervised modes
    if (tr.mode === 'RM' && tr.rmAuth <= 0 && tr.coupledLen === 0 && tr.tasks[0]?.k !== 'rescue') {
      tr.mode = tr.level === 'CBTC' || (zone === 'TBTC') ? 'AM' : 'CM';
      if (!tr.comm) tr.mode = 'CM';
      sim.log('I', '列车', `列车 ${trainLabel(tr)} 结束RM，恢复 ${tr.mode} 模式`);
    }
    if (tr.comm) {
      if (zone === 'CBTC' && tr.level === 'TBTC') {
        tr.level = 'CBTC';
        if (tr.mode === 'CM') tr.mode = 'AM';
        sim.log('I', '列车', `列车 ${trainLabel(tr)} 升级至 CBTC ${tr.mode}`);
      } else if (zone === 'TBTC' && tr.level === 'CBTC') {
        tr.level = 'TBTC';
        sim.log('I', '列车', `列车 ${trainLabel(tr)} 进入TBTC区域，转TBTC后备运行`);
      } else if (zone === 'ZCFAIL' && tr.level === 'CBTC' && tr.v < 0.05 && tr.mode !== 'RM') {
        // stuck until the area is switched to TBTC (or RM authorised)
      }
    } else if (tr.level === 'CBTC' && tr.v < 0.05 && tr.mode !== 'RM') {
      tr.pendingMode = 'CM';
      tr.pendingLevel = 'TBTC';
      tr.pendingModeAt = sim.t + 30;
      sim.log('C', '列车', `列车 ${trainLabel(tr)} 司机申请降级：30秒后以 TBTC 后备 CM 模式运行（区段占用防护）`);
    }
  }
}

/** driver reaction to guide signals / preset sections: switch to RM */
export function driverRM(sim: Sim) {
  const { topo } = sim;
  for (const tr of sim.trainList) {
    if (tr.phase !== 'run' || tr.v > 0.05 || tr.mode === 'RM' || tr.failed || tr.pendingMode) continue;
    if (tr.maDist > 35) continue;
    if (tr.nextSignal >= 0 && tr.nextSignalDist < 40 && sim.sig[tr.nextSignal].aspect === 'GUIDE') {
      const rid = sim.sig[tr.nextSignal].route;
      const len = rid >= 0 ? topo.routes[rid].length : 300;
      grantRM(sim, tr, len + tr.len + 30, `引导信号 ${topo.signals[tr.nextSignal].name}`);
      continue;
    }
    if (tr.maReason === '计轴预复位区段') {
      grantRM(sim, tr, 450 + tr.len, '预复位区段压道');
    }
  }
}

export function grantRM(sim: Sim, tr: Train, metres: number, reason: string) {
  tr.mode = 'RM';
  tr.rmAuth = metres;
  tr.rmReason = reason;
  tr.eb = false;
  sim.log('C', '列车', `列车 ${trainLabel(tr)} 以RM模式（≤25km/h）运行：${reason}`);
}

// ---------------------------------------------------------------- dispatcher train commands

export function cmdTrainHold(_sim: Sim, tr: Train, on: boolean) {
  tr.hold = on;
  return { ok: true, msg: `列车 ${trainLabel(tr)} ${on ? '扣车' : '放行'}` };
}

export function cmdSkip(_sim: Sim, tr: Train, station: number, on: boolean) {
  if (on) tr.skipStations.add(station); else tr.skipStations.delete(station);
  return { ok: true, msg: `列车 ${trainLabel(tr)} ${on ? '设置' : '取消'}跳停 ${STATIONS[station].name}` };
}

function dirOf(tr: Train, topo: Topology): TrackDir {
  // direction of travel by chainage
  const l = topo.links[tr.link];
  const east = tr.dir === 1 ? l.chainB >= l.chainA : l.chainA > l.chainB;
  return east ? 'DN' : 'UP';
}

/** stations ahead of the train in its travel direction */
export function stationsAhead(sim: Sim, tr: Train): number[] {
  const ch = sim.trainChain(tr);
  const d = dirOf(tr, sim.topo);
  return sim.topo.stations.filter((s) => (d === 'DN' ? s.chain > ch + 20 : s.chain < ch - 20)).map((s) => s.index).sort((a, b) => (d === 'DN' ? a - b : b - a));
}

export function turnbackOptions(sim: Sim, tr: Train): number[] {
  const d = dirOf(tr, sim.topo);
  return stationsAhead(sim, tr).filter((s) => turnbackAt(sim.topo, s, d) !== null);
}

/** 人工折返 */
export function cmdTurnback(sim: Sim, tr: Train, station: number) {
  const { topo, plan } = sim;
  const d = dirOf(tr, topo);
  const tb = turnbackAt(topo, station, d);
  if (!tb) return { ok: false, msg: `${STATIONS[station].name} 无该方向折返条件` };
  if (!stationsAhead(sim, tr).includes(station)) return { ok: false, msg: '折返站须在列车运行前方' };
  // keep stops up to the turnback station
  const keep: Task[] = [];
  for (const t of tr.tasks) {
    if (t.k === 'stop' && ((d === 'DN' && t.station >= station) || (d === 'UP' && t.station <= station))) break;
    if (t.k !== 'stop') break;
    keep.push(t);
  }
  const est = sim.t + estimateRun(sim, tr, station);
  const arrStop: StopTask = { k: 'stop', berth: platformBerth(topo, station, d), station, trip: tr.tripId, arr: est, dep: null, doors: tr.inService, revenue: tr.inService, note: '人工折返' };
  const tasks: Task[] = [...keep, arrStop];
  // cancel rest of current trip and find the trip to resume
  const block = tr.block >= 0 ? plan.blocks[tr.block] : null;
  const curTrip = tr.tripId >= 0 ? plan.trips[tr.tripId] : null;
  let resumeIdx = -1;
  const back: TrackDir = d === 'DN' ? 'UP' : 'DN';
  let adj: Trip | null = null;
  if (block && curTrip) {
    const idx = block.trips.indexOf(curTrip.id);
    const nextTrip = block.trips.slice(idx + 1).map((i) => plan.trips[i]).find((t) => !t.cancelled);
    if (nextTrip && nextTrip.dir === back) {
      // adjusted trip: from turnback station to the next trip's destination
      // depart as soon as the turnback allows (a station-front turnback occupies the opposite platform)
      const depAt = est + 240;
      const stops = buildStops(sim.planCtx, back, station, nextTrip.to, depAt, true, 1);
      adj = { id: plan.trips.length, no: `6${nextTrip.no.slice(1)}`, dir: back, kind: 'adj', from: station, to: nextTrip.to, stops, revenue: true, block: block.id };
      plan.trips.push(adj);
      nextTrip.cancelled = true;
      block.trips.splice(block.trips.indexOf(nextTrip.id), 0, adj.id);
      resumeIdx = block.trips.indexOf(nextTrip.id) + 1;
    }
    curTrip.cancelled = curTrip.cancelled || false;
    sim.truncatedTrips.set(curTrip.id, station);
  }
  const fake: Trip = { id: -1, no: '', dir: d, kind: 'adj', from: station, to: station, stops: [], revenue: true, block: -1 };
  addTurnback(topo, fake, tasks);
  if (adj && block) {
    tripTasks(topo, adj, tasks, false);
    const rest = blockTasks(topo, plan, block, resumeIdx);
    if (rest.length && rest[0].k === 'stop') {
      addTurnback(topo, adj, tasks);
      tasks.push(...rest);
    } else {
      // last trip before depot
      const en = block.end.kind === 'depot' ? block.end.depot : -1;
      if (en >= 0) tasks.push({ k: 'depot', depot: en });
    }
  } else {
    // no follow-on service: withdraw to depot after turning back
    const dp = nearestDepot(sim, station, back);
    tasks.push({ k: 'depot', depot: dp });
  }
  tr.tasks = tasks;
  sim.planDirty = true;
  return { ok: true, msg: `列车 ${trainLabel(tr)} 人工折返于 ${STATIONS[station].name}${adj ? `，折返后担当 ${adj.no}` : '，折返后回段'}` };
}

function estimateRun(sim: Sim, tr: Train, station: number): number {
  const ch = sim.trainChain(tr);
  return Math.abs(sim.topo.stations[station].chain - ch) / 11 + 30;
}

export function nearestDepot(sim: Sim, station: number, dir: TrackDir): number {
  const { topo } = sim;
  const ch = topo.stations[station].chain;
  let best = 0;
  let bd = Infinity;
  topo.depots.forEach((d, i) => {
    const ahead = dir === 'DN' ? d.junctionChain > ch : d.junctionChain < ch;
    const dist = Math.abs(d.junctionChain - ch) + (ahead ? 0 : 1e6);
    if (dist < bd) { bd = dist; best = i; }
  });
  return best;
}

/** 退出服务（清客回段） */
export function cmdWithdraw(sim: Sim, tr: Train, reason = '调度命令') {
  const { topo, plan } = sim;
  const d = dirOf(tr, topo);
  const ahead = stationsAhead(sim, tr);
  const depot = nearestDepot(sim, tr.lastStation >= 0 ? tr.lastStation : (ahead[0] ?? 0), d);
  const dpChain = topo.depots[depot].junctionChain;
  const reachable = d === 'DN' ? dpChain > sim.trainChain(tr) : dpChain < sim.trainChain(tr);
  const tasks: Task[] = [];
  const next = ahead[0];
  if (tr.phase === 'dwell') {
    const cur = curStop(tr)!;
    cur.revenue = false;
    cur.doors = true;
    cur.dep = null;
    cur.minDwell = 60;
    if (tr.load > 0) { sim.passengersCleared += tr.load; tr.load = 0; }
    tasks.push(cur);
  } else if (next !== undefined && tr.inService) {
    tasks.push({ k: 'stop', berth: platformBerth(topo, next, d), station: next, trip: -1, arr: null, dep: null, doors: false, revenue: false, minDwell: 60, note: '清客' });
  }
  if (reachable) tasks.push({ k: 'depot', depot });
  else {
    const tbSt = turnbackOptions(sim, tr)[0];
    if (tbSt === undefined) return { ok: false, msg: '前方无折返/回段条件' };
    if (!tasks.some((t) => t.k === 'stop' && t.station === tbSt)) tasks.push({ k: 'stop', berth: platformBerth(topo, tbSt, d), station: tbSt, trip: -1, arr: null, dep: null, doors: false, revenue: false, minDwell: 20 });
    const fake: Trip = { id: -1, no: '', dir: d, kind: 'adj', from: tbSt, to: tbSt, stops: [], revenue: false, block: -1 };
    addTurnback(topo, fake, tasks);
    tasks.push({ k: 'depot', depot: nearestDepot(sim, tbSt, d === 'DN' ? 'UP' : 'DN') });
  }
  // cancel remaining trips of the block
  if (tr.block >= 0) {
    const b = plan.blocks[tr.block];
    const idx = b.trips.indexOf(tr.tripId);
    for (const tid of b.trips.slice(idx + 1)) plan.trips[tid].cancelled = true;
    if (tr.tripId >= 0) sim.truncatedTrips.set(tr.tripId, next ?? tr.lastStation);
    sim.planDirty = true;
  }
  tr.tasks = tasks;
  tr.inService = false;
  tr.tripNo = '回段';
  tr.destText = topo.depots[tasks[tasks.length - 1].k === 'depot' ? (tasks[tasks.length - 1] as { depot: number }).depot : depot].short;
  tr.withdrawn = true;
  return { ok: true, msg: `列车 ${tr.svc}（${tr.vehicle}）退出服务（${reason}），清客后回${topo.depots[depot].name}` };
}

export function cmdAuthRM(sim: Sim, tr: Train) {
  if (tr.failed) return { ok: false, msg: '列车故障中' };
  grantRM(sim, tr, 600, '调度授权RM运行');
  return { ok: true, msg: `授权列车 ${trainLabel(tr)} 以RM模式运行600m（≤25km/h，目视行车）` };
}

// ---------------------------------------------------------------- rescue

export function cmdRescue(sim: Sim, failed: Train, rescuer: Train) {
  if (!failed.failed) return { ok: false, msg: '被救援列车未处于故障状态' };
  if (rescuer.failed) return { ok: false, msg: '救援列车本身故障' };
  // rescuer must be behind the failed train on the same running line
  const seen = trainAheadOf(sim, rescuer, 8000);
  if (seen !== failed.id) return { ok: false, msg: '救援列车须为故障列车后方同向列车（中间无其他列车）' };
  const { topo } = sim;
  const d = dirOf(rescuer, topo);
  const tasks: Task[] = [];
  // clear-out at the next station before the failed train, if any
  const failedCh = sim.trainChain(failed);
  const nextSt = stationsAhead(sim, rescuer).find((s) => (d === 'DN' ? topo.stations[s].chain < failedCh - failed.len : topo.stations[s].chain > failedCh + failed.len));
  if (rescuer.inService && rescuer.phase !== 'dwell' && nextSt !== undefined) {
    tasks.push({ k: 'stop', berth: platformBerth(topo, nextSt, d), station: nextSt, trip: -1, arr: null, dep: null, doors: false, revenue: false, minDwell: 90, note: '救援清客' });
  } else if (rescuer.phase === 'dwell') {
    const cur = curStop(rescuer)!;
    cur.revenue = false; cur.dep = null; cur.minDwell = 90;
    tasks.push(cur);
  }
  tasks.push({ k: 'rescue', target: failed.id });
  if (rescuer.block >= 0) {
    const b = sim.plan.blocks[rescuer.block];
    const idx = b.trips.indexOf(rescuer.tripId);
    for (const tid of b.trips.slice(idx + 1)) sim.plan.trips[tid].cancelled = true;
    if (rescuer.tripId >= 0) sim.truncatedTrips.set(rescuer.tripId, nextSt ?? rescuer.lastStation);
  }
  rescuer.tasks = tasks;
  rescuer.inService = false;
  rescuer.tripNo = '救援';
  rescuer.rescuing = failed.id;
  failed.rescueBy = rescuer.id;
  sim.planDirty = true;
  return { ok: true, msg: `组织列车 ${rescuer.svc}（${rescuer.vehicle}）救援故障列车 ${failed.svc}（${failed.vehicle}）` };
}

/** id of the first train ahead of `tr` (same direction path), or -1 */
export function trainAheadOf(sim: Sim, tr: Train, maxDist: number): number {
  const { topo } = sim;
  let l = tr.link;
  let d = tr.dir;
  let dist = 0;
  // same link ahead
  const own = sim.linkBodies.get(l)?.filter((s) => s.train !== tr.id && (d === 1 ? s.from >= tr.off - 0.5 : s.to <= tr.off + 0.5)) ?? [];
  if (own.length) return own.sort((a, b) => (d === 1 ? a.from - b.from : b.to - a.to))[0].train;
  dist = d === 1 ? topo.links[l].len - tr.off : tr.off;
  for (let i = 0; i < 200 && dist < maxDist; i++) {
    const nx = nextLink(topo, l, d, (sw) => swPos(sim, sw) ?? sim.sw[sw].pos);
    if (!nx) return -1;
    l = nx.link;
    d = nx.dir;
    const segs = sim.linkBodies.get(l);
    if (segs && segs.length) {
      const sorted = segs.slice().sort((a, b) => (d === 1 ? a.from - b.from : b.to - a.to));
      return sorted[0].train;
    }
    dist += topo.links[l].len;
  }
  return -1;
}

function rescueStep(sim: Sim, tr: Train, target: number) {
  const f = sim.trains.get(target);
  if (!f) { tr.tasks.shift(); return; }
  // approach in RM when close
  const gapToFailed = tr.maReason === '救援连挂' ? tr.maDist : Infinity;
  if (tr.mode !== 'RM' && tr.v < 0.05 && tr.maDist < 60 && (tr.maReason === '救援连挂' || tr.maReason.startsWith('前方') || tr.maReason === '前车' || tr.maReason === '非通信车占用')) {
    grantRM(sim, tr, 400, '救援连挂（≤3km/h 接近）');
  }
  if (gapToFailed < 0.6 && tr.v < 0.05) {
    tr.phase = 'coupling';
    tr.phaseSince = sim.t;
    tr.dwellUntil = sim.t + 60;
    sim.log('C', '列车', `救援列车 ${tr.svc}（${tr.vehicle}）与故障列车 ${f.svc}（${f.vehicle}）连挂作业`);
  }
}

function completeCoupling(sim: Sim, tr: Train) {
  const { topo } = sim;
  const task = tr.tasks[0];
  const f = task && task.k === 'rescue' ? sim.trains.get(task.target) : undefined;
  tr.tasks.shift();
  if (!f) { tr.phase = 'run'; return; }
  // merge consists: head moves to the failed train's head
  const rh = tr.hist.slice(tr.hist.length - tr.body.length);
  const fh = f.hist.slice(f.hist.length - f.body.length);
  const merged = [...rh];
  for (const h of fh) if (merged[merged.length - 1]?.link !== h.link) merged.push(h);
  tr.link = f.link;
  tr.off = f.off;
  tr.dir = f.dir;
  tr.hist = merged;
  tr.len = tr.len + f.len + 1;
  tr.coupledLen = f.len;
  tr.load += f.load;
  computeBody(sim, tr);
  sim.passengersStranded += 0;
  const fBlock = f.block;
  if (fBlock >= 0) {
    sim.blockDone.add(fBlock);
    const b = sim.plan.blocks[fBlock];
    const idx = b.trips.indexOf(f.tripId);
    for (const tid of b.trips.slice(idx + 1)) sim.plan.trips[tid].cancelled = true;
    if (f.tripId >= 0) sim.truncatedTrips.set(f.tripId, f.lastStation);
  }
  const fault = sim.faults.find((x) => x.kind === 'trainFail' && x.target === f.id && !x.repaired);
  if (fault) { fault.repaired = true; }
  sim.clearAlarm(`tf-${f.id}`);
  sim.removeTrain(f);
  tr.mode = 'RM';
  tr.rmAuth = 0;
  tr.tripNo = '救援';
  tr.phase = 'run';
  // continue to the next station, detrain, then to the nearest depot / siding
  const d = dirOf(tr, topo);
  const next = stationsAhead(sim, tr)[0];
  const tasks: Task[] = [];
  if (next !== undefined) tasks.push({ k: 'stop', berth: platformBerth(topo, next, d), station: next, trip: -1, arr: null, dep: null, doors: false, revenue: false, minDwell: 120, note: '故障车清客' });
  const depot = nearestDepot(sim, next ?? 0, d);
  const dpChain = topo.depots[depot].junctionChain;
  const reachable = d === 'DN' ? dpChain > sim.trainChain(tr) : dpChain < sim.trainChain(tr);
  if (reachable) tasks.push({ k: 'depot', depot });
  else {
    const tbs = turnbackOptions(sim, tr);
    const siding = tbs.find((s) => { const tb = turnbackAt(topo, s, d); return tb?.kind === 'rear'; });
    if (siding !== undefined) {
      const tb = turnbackAt(topo, siding, d)!;
      if (!tasks.some((t) => t.k === 'stop' && t.station === siding)) tasks.push({ k: 'stop', berth: platformBerth(topo, siding, d), station: siding, trip: -1, arr: null, dep: null, doors: false, revenue: false, minDwell: 10 });
      tasks.push({ k: 'stable', berth: tb.kind === 'rear' ? tb.berths[0] : -1, reason: '救援列车存放' });
    }
  }
  tr.tasks = tasks;
  sim.log('B', '列车', `救援连挂完成，救援列车推送故障车以RM模式运行至 ${next !== undefined ? STATIONS[next].name : '前方站'} 清客后回段`);
  void entryStation;
}

export function failTrain(sim: Sim, tr: Train, recoverable: boolean, recoverAfter: number) {
  tr.failed = true;
  tr.failRecoverable = recoverable;
  tr.failRecoverAt = sim.t + recoverAfter;
  tr.phase = tr.phase === 'dwell' ? 'dwell' : 'failed';
  if (tr.v > 0.1) triggerEB(sim, tr, '列车牵引/制动故障');
  tr.v = 0;
}

export function recoverTrain(sim: Sim, tr: Train) {
  tr.failed = false;
  if (tr.phase === 'failed') tr.phase = 'run';
  sim.log('C', '列车', `列车 ${trainLabel(tr)} 故障排除，恢复运行`);
}

export { goalBerth, releaseRoute };
