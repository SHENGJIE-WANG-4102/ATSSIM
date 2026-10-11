import { describe, it, expect } from 'vitest';
import { Sim } from '../src/sim/engine';
import { capture, restore, fingerprint } from '../src/sim/state';
import { exportDiagnostics, stringifyDiagnostics, parseDiagnostics, replayDiagnostics, compactCheckpoints } from '../src/sim/diagnostics';
import { checkSafety } from '../src/sim/invariants';
import { MACHINES, MODE, EB, allowed } from '../src/sim/fsm';
import type { Command } from '../src/sim/model';
import { openCall, answerCall, unsafeAhead } from '../src/sim/radio';
import { trySetRoute, cancelRoute, committedTrain, bindRouteApproach, updateInterlocking, releaseRoute } from '../src/sim/interlocking';
import { setMode, grantRM } from '../src/sim/onboard';
import { computeBody, indexBodies } from '../src/sim/movement';
import { distanceToBerth, updateTrainTasks } from '../src/sim/ats';
import { platformBerth } from '../src/sim/timetable';

const make = () => new Sim({ dayType: 'weekday', dateLabel: 'core', startTime: 14400, seed: 7, noPossessions: true });
const advance = (sim: Sim, seconds: number) => { const end = sim.t + seconds; while (sim.t < end - 1e-6) sim.step(); };

describe('dispatcher boundary', () => {
  it('rejects invalid objects and non-finite values without partial writes', () => {
    const sim = make();
    const before = sim.zoneState.slice();
    expect(sim.command({ c: 'zoneLevel', zones: [0, 999], level: 'TBTC' }).ok).toBe(false);
    expect(sim.zoneState).toEqual(before);
    expect(sim.command({ c: 'setTsr', sections: [0, 9999], kmh: 25 }).ok).toBe(false);
    expect(sim.sec[0].tsr).toBe(0);
    expect(sim.command({ c: 'setTsr', sections: [0], kmh: NaN }).ok).toBe(false);
    expect(sim.command({ c: 'fault', kind: 'signal', target: -1, duration: 30 }).ok).toBe(false);
    expect(sim.faults).toHaveLength(0);
    expect(() => sim.command({ c: 'setRoute' } as Command)).not.toThrow();
    expect(sim.command({ c: 'sectionBlock', on: false } as Command).ok).toBe(false);
  });
  it('validates a complete zone restoration before changing any zone', () => {
    const sim = make();
    sim.command({ c: 'zoneLevel', zones: [0], level: 'TBTC' });
    sim.command({ c: 'fault', kind: 'zcFail', target: 1, duration: 60 });
    expect(sim.command({ c: 'zoneLevel', zones: [0, 1], level: 'CBTC' }).ok).toBe(false);
    expect(sim.zoneState[0]).toBe('TBTC');
  });
});

describe('movement and radio regressions', () => {
  it('brakes within the issued MA when an ESP creates an unreachable shorter target', () => {
    const sim = make();
    let tr: Sim['trainList'][number] | undefined;
    while (!tr && sim.t < 14700) {
      sim.step();
      tr = sim.trainList.find(t => t.v > 5 && t.body.some(b => sim.topo.links[b.link].platform >= 0));
    }
    expect(tr).toBeDefined();
    const train = tr!;
    const p = sim.topo.links[train.body.find(b => sim.topo.links[b.link].platform >= 0)!.link].platform;
    sim.command({ c: 'platformEsp', platform: p, on: true });
    sim.step();
    expect(train.eb).toBe(true);
    expect(train.maCut).toBe(true);
    expect(train.lastMa).toBeGreaterThan(train.lastDs);
    advance(sim, 15);
    expect(train.v).toBe(0);
    expect(train.maCut).toBe(false);
    expect(sim.integrity.violations.filter(v => v.kind === 'BEYOND_MA')).toHaveLength(0);
  });
  it('never exempts an issued-MA overrun merely because EB and withdrawal are active', () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    tr.phase = 'run'; tr.eb = true; tr.maCut = true; tr.lastMa = 10; tr.lastDs = 11;
    checkSafety(sim);
    expect(sim.integrity.violations.some(v => v.kind === 'BEYOND_MA')).toBe(true);
  });
  it('preserves an issued authority when occupancy prevents cancellation of a failed signal route', () => {
    const sim = make();
    let tr: Sim['trainList'][number] | undefined;
    let signal = -1;
    while (!tr && sim.t < 14430) {
      sim.step();
      for (const candidate of sim.trainList) for (const sig of candidate.maSigs) {
        const route = sim.sig[sig].route;
        if (candidate.v > 5 && route >= 0 && committedTrain(sim, sig) === candidate.id) { tr = candidate; signal = sig; break; }
      }
    }
    expect(tr).toBeDefined();
    const route = sim.sig[signal].route;
    // Isolate the occupied-route branch of the CI interface. Its occupancy
    // input may include a train further inside the same protected section.
    sim.sec[sim.topo.routes[route].sections[0]].trainOcc = true;
    expect(sim.command({ c: 'fault', kind: 'signal', target: signal, duration: 30 }).ok).toBe(true);
    expect(sim.routes.get(route)?.committed).toBe(tr!.id);
    advance(sim, 5);
    expect(tr!.passedRed).toBe(0);
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it('revalidates a stopped train authority on departure between ZC refreshes', () => {
    const sim = make(); advance(sim, 2);
    const tr = sim.trainList.find(t => t.tasks[0]?.k === 'stop')!;
    expect(tr).toBeDefined();
    tr.phase = 'dwell'; tr.v = 0; tr.doorsOpen = false; tr.dwellUntil = sim.t - 1;
    tr.maDist = tr.maFar = 99000;
    sim.step();
    expect(tr.phase).toBe('run');
    expect(tr.maDist).toBeLessThanOrEqual(25000);
    expect(sim.integrity.violations.filter(v => v.kind === 'MA_NO_ROUTE')).toHaveLength(0);
  });
  it('restores a repaired point in place while its route remains locked and occupied', () => {
    const sim = make(); advance(sim, 2);
    const sw = sim.sw.findIndex(s => s.lockCount > 0 && s.pos === s.target);
    expect(sw).toBeGreaterThanOrEqual(0);
    const section = sim.topo.switches[sw].sections[0];
    sim.sec[section].trainOcc = true;
    const pos = sim.sw[sw].pos;
    expect(sim.command({ c: 'fault', kind: 'switch', target: sw, duration: 1 }).ok).toBe(true);
    expect(sim.command({ c: 'switchMove', sw, pos }).ok).toBe(false);
    advance(sim, 2);
    sim.autoDispatch = true; advance(sim, 5);
    expect(sim.sw[sw].failed).toBe(false);
    expect(sim.sw[sw].pos).toBe(pos);
    expect(sim.sw[sw].target).toBe(pos);
    expect(sim.sw[sw].lockCount).toBeGreaterThan(0);
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it('never lets auto-answer grant RM or consume a refused call', () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    const call = openCall(sim, { kind: 'stuck', from: 'driver', train: tr.id, text: 'test',
      options: [{ key: 'rm', label: 'RM' }, { key: 'wait', label: 'wait' }], auto: 'wait', timeout: 120 })!;
    expect(answerCall(sim, call.id, 'rm', true).ok).toBe(false);
    expect(call.state).toBe('ringing');
    expect(tr.mode).not.toBe('RM');
    expect(answerCall(sim, call.id, 'rm').ok).toBe(false);
    expect(call.state).toBe('ringing');
  });
  it('refuses authority towards a preceding train even under a signal failure', () => {
    const sim = make(); advance(sim, 2); const [tr, ahead] = sim.trainList;
    sim.linkBodies.set(tr.link, [{ train: ahead.id, from: tr.off + 1, to: tr.off + 20 }]);
    expect(unsafeAhead(sim, tr)).toContain('列车');
    tr.v = 0; tr.maCode = 'SIGNAL_FAULT';
    expect(sim.command({ c: 'authRM', train: tr.id }).ok).toBe(false);
  });
  it.each([false, true])('an already-RM train reports and sweeps a preset block (coupled=%s)', coupled => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const sig = sim.topo.signals.find(s => s.name === 'S0802')!;
    const link = sim.topo.links.find(l => l.a === sig.node && l.track === 'UP')!;
    const previous = sim.topo.links.find(l => l.a === link.b && l.track === 'UP')!;
    tr.link = link.id; tr.off = 6.4; tr.dir = -1;
    tr.hist = [{ link: previous.id, dir: -1 }, { link: link.id, dir: -1 }];
    tr.phase = 'run'; tr.v = 0; tr.block = -1; tr.tripId = -1; tr.inService = false;
    tr.len = coupled ? 373 : 186; tr.coupledLen = coupled ? 186 : 0;
    tr.tasks = [{ k: 'depot', depot: 0 }]; tr.eb = false;
    computeBody(sim, tr); indexBodies(sim);
    expect(grantRM(sim, tr, 0, -1, 'test rescue/guide continuation')).toBe(true);
    const rid = sim.sig[sig.id].route;
    expect(rid).toBeGreaterThanOrEqual(0);
    const section = sim.topo.routes[rid].sections.at(-1)!;
    expect(sim.command({ c: 'fault', kind: 'axle', target: section, duration: 1 }).ok).toBe(true);
    advance(sim, 2);
    expect(sim.command({ c: 'axleReset', section }).ok).toBe(true);
    sim.autoDispatch = true;
    const chain = sim.trainChain(tr);
    advance(sim, 400);
    const call = sim.calls.find(c => c.train === tr.id && c.kind === 'rmPreset');
    expect(call?.answer).toBe('approve');
    expect(Math.abs(sim.trainChain(tr) - chain)).toBeGreaterThan(500);
    expect(sim.sec[section].preset).toBe(false);
    expect(tr.passedRed).toBe(0);
    expect(sim.integrity.violations).toHaveLength(0);
  });
});

describe('paper-based turnback and depot procedures', () => {
  it('returns a rescue coupled at the western terminal to depot without fouling its tail crossover', () => {
    const sim = make(); advance(sim, 2); const [tr, failed] = sim.trainList;
    for (const other of [...sim.trainList]) if (other !== tr && other !== failed) sim.removeTrain(other);
    for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const berth = sim.topo.berths[platformBerth(sim.topo, 0, 'UP')];
    const link = sim.topo.links[berth.link];
    const previous = sim.topo.links.find(l => l.a === link.b && l.track === 'UP')!;
    failed.link = link.id; failed.off = berth.offset; failed.dir = -1;
    failed.hist = [{ link: link.id, dir: -1 }]; failed.v = 0; failed.failed = true;
    failed.block = -1; failed.tripId = -1; computeBody(sim, failed);
    tr.link = previous.id; tr.off = 5; tr.dir = -1; tr.hist = [{ link: previous.id, dir: -1 }];
    tr.tasks = [{ k: 'rescue', target: failed.id }]; tr.rescuing = failed.id;
    tr.phase = 'coupling'; tr.dwellUntil = sim.t; tr.v = 0; tr.eb = false;
    tr.block = -1; tr.tripId = -1; tr.inService = false; tr.load = 10;
    computeBody(sim, tr); indexBodies(sim); updateTrainTasks(sim, tr);
    expect(tr.len).toBe(373);
    expect(tr.tasks.some(t => t.k === 'reverse')).toBe(true);
    expect(tr.tasks.at(-1)?.k).toBe('depot');
    const vehicles = [tr.vehicle, tr.coupledVehicle];
    advance(sim, 2400);
    expect(sim.trains.has(tr.id)).toBe(false);
    for (const vehicle of vehicles) expect(sim.yards.some(y => y.tracks.some(track => track.includes(vehicle!)))).toBe(true);
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it('holds a CBTC train inside the tail until a complete pull-out path is locked', () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    const berth = sim.topo.berths[sim.topo.stations[0].turnbackBerths[0]];
    const platform = sim.topo.berths.find(b => b.station === 0 && b.kind === 'platform' && b.dir === 1)!;
    tr.link = berth.link; tr.off = berth.offset; tr.dir = berth.dir; tr.hist = [{ link: berth.link, dir: berth.dir }];
    tr.v = 0; tr.phase = 'reversing'; tr.dwellUntil = sim.t; tr.tbStage = 'arrive'; tr.block = -1; tr.tripId = -1;
    tr.tasks = [{ k: 'reverse', berths: [berth.id], chosen: berth.id, station: 0, minTime: 0 },
      { k: 'stop', berth: platform.id, station: 0, trip: -1, arr: null, dep: sim.t + 300, doors: false, revenue: false }];
    computeBody(sim, tr); indexBodies(sim); checkSafety(sim); tr.tbStage = 'reverse'; checkSafety(sim);
    for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
    for (const signal of sim.sig) signal.ars = false;
    sim.step(); const point = { link: tr.link, off: tr.off }; advance(sim, 20);
    expect(tr.tbStage).toBe('depart'); expect(tr.v).toBe(0);
    expect({ link: tr.link, off: tr.off }).toEqual(point);
    expect(tr.maDist).toBe(0); expect(tr.eb).toBe(false);
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it('protects the reverse-platform arrival before the cab-change task starts and refuses TBTC', () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    const r = sim.topo.routes.find(r => r.wrongDir && r.berths.some(b => sim.topo.berths[b].kind === 'platform' && sim.topo.berths[b].reverse))!;
    const berth = r.berths.find(b => sim.topo.berths[b].kind === 'platform' && sim.topo.berths[b].reverse)!;
    tr.tasks = [{ k: 'stop', berth, station: sim.topo.berths[berth].station, trip: -1, arr: null, dep: null, doors: false, revenue: false }];
    for (const id of [...sim.routes.keys()]) releaseRoute(sim, id);
    tr.level = 'TBTC';
    expect(trySetRoute(sim, r.id, { train: tr.id }).ok).toBe(false);
    expect(sim.routes.has(r.id)).toBe(false);
    tr.level = 'CBTC';
    expect(trySetRoute(sim, r.id, { train: tr.id }).ok).toBe(true);
    expect(sim.routes.get(r.id)?.directionReverse).toBe(true);
    expect(r.sections.every(s => sim.sec[s].directionEsp && sim.sec[s].td === 0)).toBe(true);
  });
  it('uses the full physical depot insertion path rather than half the terminal route cost', () => {
    const sim = make(); const depot = sim.topo.depots.find(d => d.key === 'CSD')!;
    const goal = sim.topo.berths.find(b => b.station === 29 && b.kind === 'platform' && b.dir === 1)!;
    const distance = distanceToBerth(sim, depot.exitSignal, goal.id);
    expect(distance).toBeGreaterThan(5000);
    expect(distance).toBeLessThan(5300);
    expect(distance).toBeGreaterThan(sim.routeTable.dist.get(goal.id)![depot.exitSignal] * 1.7);
  });
  it('does not apply reverse-interval TD protection to an ordinary terminal tail move', () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    const r = sim.topo.routes.find(r => r.wrongDir && r.berths.some(b => sim.topo.berths[b].kind === 'tail'))!;
    const tail = r.berths.find(b => sim.topo.berths[b].kind === 'tail')!;
    tr.tasks = [{ k: 'reverse', berths: [tail], chosen: tail, station: 0, minTime: 40 }];
    for (const id of [...sim.routes.keys()]) releaseRoute(sim, id);
    expect(trySetRoute(sim, r.id, { train: tr.id }).ok).toBe(true);
    expect(sim.routes.get(r.id)?.directionReverse).toBe(false);
    expect(r.sections.some(s => sim.sec[s].directionEsp)).toBe(false);
  });
  it('rebinds an already locked pull-out route and clears protection only after cab change and platform clearance', () => {
    const sim = make(); advance(sim, 2); const [tr, other] = sim.trainList;
    const goal = sim.topo.berths.find(b => b.kind === 'platform' && b.station === 0 && b.dir === 1)!;
    const r = sim.topo.routes.find(r => r.berths.includes(goal.id))!;
    for (const id of [...sim.routes.keys()]) releaseRoute(sim, id);
    expect(trySetRoute(sim, r.id).ok).toBe(true);
    const ar = sim.routes.get(r.id)!; ar.state = 'locked';
    const protectedSection = r.sections[0];
    Object.assign(sim.sec[protectedSection], { td: -1, tdRoute: r.id, tdTrain: tr.id, directionEsp: true });
    tr.phase = 'reversing'; tr.tbStage = 'reverse'; tr.v = 0;
    tr.tasks = [{ k: 'reverse', berths: [], chosen: -1, station: 0, minTime: 40 },
      { k: 'stop', berth: goal.id, station: 0, trip: -1, arr: null, dep: sim.t + 60, doors: false, revenue: false }];
    bindRouteApproach(sim, r.id, tr.id); updateInterlocking(sim);
    expect(sim.sec[protectedSection].directionEsp).toBe(true);
    tr.tasks.shift(); tr.phase = 'run'; tr.tbStage = 'depart';
    sim.linkBodies.set(goal.link, [{ train: other.id, from: 0, to: 100 }]);
    bindRouteApproach(sim, r.id, tr.id); updateInterlocking(sim);
    expect(sim.sec[protectedSection].directionEsp).toBe(true);
    sim.linkBodies.set(goal.link, []); updateInterlocking(sim);
    expect(sim.sec[protectedSection].directionEsp).toBe(false);
    expect(ar.directionTrain).toBe(tr.id);
  });
  it('locks independent LYD entry and exit routes without sharing conversion sections', () => {
    const sim = make(); const depot = sim.topo.depots.find(d => d.key === 'LYD')!;
    expect(depot.outGateLink).not.toBe(depot.gateLink);
    const incoming = sim.topo.routes.find(r => r.endNode === depot.gateNode)!;
    const outgoing = sim.topo.routes.find(r => r.start === depot.exitSignal && !r.sections.some(s => incoming.sections.includes(s)))!;
    expect(outgoing).toBeDefined();
    for (const ar of [...sim.routes.values()]) cancelRoute(sim, sim.topo.routes[ar.route].start);
    expect(trySetRoute(sim, incoming.id).ok).toBe(true);
    expect(trySetRoute(sim, outgoing.id).ok).toBe(true);
    expect(sim.topo.routes.some(r => r.endNode === depot.outGateNode)).toBe(false);
  });
  it('keeps a TBTC forward turnback stopped until a driver instruction and signal passage', () => {
    const sim = make(); advance(sim, 2); sim.autoRadio = false;
    const tr = sim.trainList[0]; const station = sim.topo.stations[0];
    const berth = sim.topo.berths[station.turnbackBerths[0]];
    const platform = sim.topo.berths.find(b => b.station === 0 && b.kind === 'platform' && b.dir === 1)!;
    tr.link = berth.link; tr.off = berth.offset; tr.dir = berth.dir; tr.hist = [{ link: berth.link, dir: berth.dir }];
    tr.v = 0; tr.phase = 'reversing'; tr.dwellUntil = sim.t; tr.tbStage = 'arrive';
    tr.forceLevel = 'TBTC'; tr.block = -1; tr.tripId = -1;
    tr.tasks = [{ k: 'reverse', berths: [berth.id], chosen: berth.id, station: 0, minTime: 0 },
      { k: 'stop', berth: platform.id, station: 0, trip: -1, arr: null, dep: sim.t + 300, doors: false, revenue: false }];
    computeBody(sim, tr); indexBodies(sim); setMode(sim, tr, 'AM', 'TBTC', 'test'); checkSafety(sim);
    tr.tbStage = 'reverse'; advance(sim, 20);
    expect(tr.tbStage).toBe('manual'); expect(tr.v).toBe(0);
    const call = sim.calls.find(c => c.kind === 'turnback' && c.train === tr.id && c.state === 'ringing')!;
    expect(call).toBeDefined(); expect(answerCall(sim, call.id, 'rm', true).ok).toBe(false);
    expect(sim.command({ c: 'radio', call: call.id, option: 'rm' }).ok).toBe(true);
    const until = sim.t + 100;
    while (tr.mode === 'RM' && sim.t < until) sim.step();
    expect(tr.tbStage).toBe('depart'); expect(tr.mode).toBe('AM'); expect(tr.level).toBe('TBTC');
    expect(sim.integrity.violations).toHaveLength(0);
  });
});

describe('diagnostics and replay', () => {
  it('keeps checkpoint alarm history immutable across acknowledgment and clearance', () => {
    const sim = make(); sim.command({ c: 'fault', kind: 'signal', target: 0, duration: 30 });
    const cp = capture(sim); const alarm = sim.alarms.get('sig-0')!;
    expect(alarm).toBeDefined();
    sim.command({ c: 'ack', ids: [alarm.id] }); sim.clearAlarm('sig-0');
    const recovery = sim.events.find(e => e.text === `【恢复】${alarm.text}`);
    expect(recovery).toBeDefined();
    expect(sim.newEvents.find(e => e.id === recovery!.id)).toEqual(recovery);
    expect(cp.events.find(e => e.id === alarm.id)?.ack).toBe(false);
    expect(cp.events.find(e => e.id === alarm.id)?.cleared).toBeUndefined();
    expect(sim.events.find(e => e.id === alarm.id)?.ack).toBe(true);
    expect(sim.events.find(e => e.id === alarm.id)?.cleared).toBe(sim.t);
  });
  it('round-trips sets, maps and infinity and reproduces commands at identical timestamps', () => {
    const sim = make();
    sim.command({ c: 'fault', kind: 'signal', target: 0, duration: 0 });
    sim.command({ c: 'zoneLevel', zones: [1], level: 'TBTC' });
    advance(sim, 60);
    sim.command({ c: 'platformHold', platform: 0, on: true });
    const bundle = parseDiagnostics(stringifyDiagnostics(exportDiagnostics(sim)));
    expect(bundle.state.data.routes).toBeInstanceOf(Map);
    expect((bundle.state.data.faults as Sim['faults'])[0].repairAt).toBe(Infinity);
    const replayed = replayDiagnostics(bundle);
    expect(fingerprint(replayed)).toBe(fingerprint(sim));
    expect(capture(replayed).data).toEqual(capture(sim).data);
    expect(replayed.events).toEqual(sim.events);
    expect(replayed.plan).toEqual(sim.plan);
  });
  it('restores added timetable data and integrity history into a fresh simulator', () => {
    const sim = make();
    advance(sim, 10);
    const cp = capture(sim);
    sim.command({ c: 'platformHold', platform: 0, on: true });
    restore(sim, cp);
    const fresh = make();
    restore(fresh, cp);
    advance(sim, 20); advance(fresh, 20);
    expect(capture(fresh).data).toEqual(capture(sim).data);
  });
  it('keeps service-day start and coarse early checkpoints beyond two hours', () => {
    const cp = capture(make());
    const checkpoints = Array.from({ length: 600 }, (_, i) => ({ ...cp, t: 14400 + i * 60 }));
    const kept = compactCheckpoints(checkpoints, 14400 + 599 * 60);
    expect(kept[0].t).toBe(14400);
    expect(kept.filter(x => x.t >= 14400 + 479 * 60)).toHaveLength(121);
    expect(kept.filter(x => x.t < 14400 + 479 * 60).length).toBeLessThanOrEqual(49);
  });
});

describe('state-machine contracts', () => {
  for (const machine of MACHINES) it(`${machine.name} has declared states and reachable transitions`, () => {
    const states: readonly string[] = machine.states;
    for (const entry of machine.table) {
      expect(states).toContain(entry.from);
      expect(states).toContain(entry.to);
      expect(entry.on.length).toBeGreaterThan(0);
    }
    const reached = new Set<string>(machine.initial);
    for (let i = 0; i < states.length; i++) for (const edge of machine.table) if (reached.has(edge.from)) reached.add(edge.to);
    expect([...reached].sort()).toEqual([...states].sort());
  });
  it('refuses moving degradation and unauthorised EB release', () => {
    const sim = make();
    advance(sim, 2);
    const tr = sim.trainList[0];
    expect(tr).toBeDefined();
    tr.v = 10;
    expect(allowed(sim, MODE, 'DTO-C', 'AM-T', tr).ok).toBe(false);
    tr.v = 0; tr.ebAuth = false;
    expect(allowed(sim, EB, 'standstill', 'off', tr).ok).toBe(false);
    tr.ebAuth = true;
    expect(allowed(sim, EB, 'standstill', 'off', tr).ok).toBe(true);
  });
  it('raises an A-level alarm with a snapshot for an illegal transition', () => {
    const sim = make(); advance(sim, 2);
    const tr = sim.trainList[0];
    checkSafety(sim);
    tr.mode = 'AM'; tr.level = 'CBTC';
    checkSafety(sim);
    expect(sim.integrity.violations.some(v => v.kind === 'FSM' && v.snapshot.trains[0].id === tr.id)).toBe(true);
    expect(sim.alarms.get('integrity-FSM')?.level).toBe('A');
  });
});
