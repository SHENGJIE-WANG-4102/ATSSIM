/**
 * Revision-2 simulation features: blocking, manual driving with ATP and
 * stop scoring, radio calls and their consequences, weather restrictions,
 * night possessions, yards, PIS, scenarios and replay determinism.
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { makeSim, runFor, runUntil, assertNoCollision, dirOf } from './helpers';
import { capture, restore, fingerprint } from '../src/sim/state';
import { computePis } from '../src/sim/pis';
import { yardCount } from '../src/sim/yard';
import { LINE_INFO } from '../src/data/line2';
import { PERF } from '../src/sim/dynamics';
import { platformBerth } from '../src/sim/timetable';

const H = 8 * 3600;
const st = (sim: Sim, name: string) => sim.topo.stations.find((s) => s.name === name)!;
const check = (sim: Sim) => assertNoCollision(sim);

describe('blocking (封锁)', () => {
  it('a blocked section refuses routes and stops trains before it; unblocking restores service', () => {
    const sim = makeSim('weekday', H);
    const a = st(sim, '江苏路').chain;
    const b = st(sim, '静安寺').chain;
    const secs = sim.topo.sections.filter((s) => s.track === 'DN' && s.kind === 'plain' && s.chainFrom > a + 200 && s.chainTo < b - 200).map((s) => s.id);
    expect(secs.length).toBeGreaterThan(0);
    // wait until nothing occupies them, then block
    runFor(sim, 1, check);
    expect(sim.command({ c: 'sectionBlock', sections: secs, on: true }).ok).toBe(true);
    runFor(sim, 240, check);
    const before = sim.trainList.filter((t) => t.maReason === '区段封锁');
    expect(before.length).toBeGreaterThan(0);
    // nobody entered a blocked section after blocking (trains already inside may leave)
    const route = sim.topo.routes.find((r) => r.sections.some((s) => secs.includes(s)))!;
    if (sim.sig[route.start].route < 0) expect(sim.command({ c: 'setRoute', route: route.id }).ok).toBe(false);
    expect(sim.command({ c: 'sectionBlock', sections: secs, on: false }).ok).toBe(true);
    runFor(sim, 300, check);
    expect(sim.trainList.filter((t) => t.maReason === '区段封锁').length).toBe(0);
  });

  it('a blocked switch cannot be used by routes but can still be operated singly', () => {
    const sim = makeSim('weekday', H);
    const sw = sim.topo.switches.find((s) => s.kind === 'crossover' && s.station === st(sim, '人民广场').index)!;
    expect(sim.command({ c: 'switchBlock', sw: sw.id, on: true }).ok).toBe(true);
    const r = sim.topo.routes.find((x) => x.switches.some((y) => y.sw === sw.id) && sim.sig[x.start].route < 0)!;
    const res = sim.command({ c: 'setRoute', route: r.id });
    expect(res.ok).toBe(false);
    expect(res.msg).toContain('封锁');
    expect(sim.command({ c: 'switchBlock', sw: sw.id, on: false }).ok).toBe(true);
  });
});

describe('manual driving', () => {
  it('CM driving: traction and brake to the next platform, stop accuracy is scored', () => {
    const sim = makeSim('weekday', H);
    // a DN train dwelling at a station with a plain interval ahead
    let tr = sim.trainList.find((t) => t.phase === 'dwell' && t.inService && dirOf(sim, t) === 'DN' && sim.trainChain(t) > 9000 && sim.trainChain(t) < 20000);
    while (!tr) { runFor(sim, 5); tr = sim.trainList.find((t) => t.phase === 'dwell' && t.inService && dirOf(sim, t) === 'DN' && sim.trainChain(t) > 9000 && sim.trainChain(t) < 20000); }
    expect(sim.command({ c: 'manual', train: tr.id, mode: 'CM' }).ok).toBe(true);
    expect(tr.manual).toBe(true);
    const startStops = tr.stopsMade;
    // a simple driver: traction to ~55 km/h, brake on a 0.7 m/s² curve to the stopping point
    let guard = 0;
    while (tr.stopsMade === startStops && guard++ < 6000) {
      if (tr.phase === 'run') {
        const err = Number.isFinite(tr.stopDist) ? tr.stopDist : Infinity;
        const need = err < Infinity ? (tr.v * tr.v) / (2 * Math.max(0.1, err - 0.1)) : 0;
        const vCap = Math.min(55 / 3.6, tr.vPermit - 2);
        if (need > 0.75 || (err < 1.5 && tr.v > 0.2)) tr.notch = Math.max(-7, -Math.ceil((need / PERF.bService) * 7));
        else if (err < 0.6) tr.notch = -7;
        else if (tr.v < vCap - 1) tr.notch = 4;
        else if (tr.v > vCap) tr.notch = -2;
        else tr.notch = 0;
      }
      sim.step();
      check(sim);
    }
    expect(tr.stopsMade).toBe(startStops + 1);
    expect(tr.drv.stops.length).toBe(1);
    expect(Math.abs(tr.drv.stops[0].err)).toBeLessThanOrEqual(1);
    expect(tr.drv.stops[0].score).toBeGreaterThan(0);
    expect(tr.drv.overspeed).toBe(0);
    expect(sim.command({ c: 'manual', train: tr.id, mode: 'AM' }).ok).toBe(true);
  });

  it('ATP: overspeed in CM triggers an emergency brake and counts as a safety violation', () => {
    const sim = makeSim('weekday', H);
    const find = () => sim.trainList.find((t) => t.inService && t.phase === 'run' && dirOf(sim, t) === 'DN' && sim.trainChain(t) > 5000 && sim.trainChain(t) < 30000 && t.v > 8);
    let tr = find();
    while (!tr) { runFor(sim, 2); tr = find(); }
    expect(sim.command({ c: 'manual', train: tr.id, mode: 'CM' }).ok).toBe(true);
    tr.notch = 4;
    let guard = 0;
    while (!tr.eb && guard++ < 3000) { sim.step(); check(sim); }
    expect(tr.eb).toBe(true);
    expect(tr.drv.overspeed).toBeGreaterThanOrEqual(1);
    expect(sim.metrics.safety.overspeed).toBeGreaterThanOrEqual(1);
  });

  it('RM is capped at 25 km/h and never closes up on the train ahead', () => {
    const sim = makeSim('weekday', H);
    const tr = sim.trainList.find((t) => t.phase === 'dwell' && t.inService && dirOf(sim, t) === 'UP' && sim.trainChain(t) > 9000)!;
    runFor(sim, 1);
    // wait until it is about to leave, then take over in RM
    expect(sim.command({ c: 'manual', train: tr.id, mode: 'RM' }).ok).toBe(true);
    tr.notch = 4;
    let maxV = 0;
    for (let i = 0; i < 3000; i++) {
      sim.step();
      check(sim);
      maxV = Math.max(maxV, tr.v);
    }
    expect(maxV).toBeLessThan(PERF.vRM + PERF.atpTolerance + 0.2);
  });
});

describe('radio calls', () => {
  it('without an answer a comm-loss train waits; approving the degrade lets it run', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 't', startTime: H, seed: 7, autoRadio: false });
    runUntil(sim, H);
    const tr = sim.trainList.find((t) => t.inService && t.phase === 'run' && t.v > 5 && sim.trainChain(t) > 9000 && sim.trainChain(t) < 30000)!;
    sim.command({ c: 'fault', kind: 'trainComm', target: tr.id, duration: 3000 });
    runFor(sim, 60, check);
    const call = sim.calls.find((c) => c.kind === 'degrade' && c.train === tr.id);
    expect(call).toBeDefined();
    expect(tr.level).toBe('CBTC');
    runFor(sim, 140, check);
    expect(sim.metrics.callsExpired).toBeGreaterThanOrEqual(1);
    expect(tr.v).toBeLessThan(0.1);
    // the driver calls again
    runFor(sim, 80, check);
    const again = sim.calls.find((c) => c.kind === 'degrade' && c.train === tr.id && c.state === 'ringing');
    expect(again).toBeDefined();
    expect(sim.command({ c: 'radio', call: again!.id, option: 'approve' }).ok).toBe(true);
    runFor(sim, 30, check);
    expect(tr.level).toBe('TBTC');
    expect(tr.mode).toBe('CM');
  });

  it('an unanswered passenger alarm makes the driver stop in section', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 't', startTime: H, seed: 7, autoRadio: false });
    runUntil(sim, H);
    const tr = sim.trainList.find((t) => t.inService && t.phase === 'run' && t.v > 5)!;
    sim.command({ c: 'fault', kind: 'pecu', target: tr.id, duration: 0 });
    runFor(sim, 50, check);
    expect(tr.stopUntil).toBeGreaterThan(sim.t);
    runFor(sim, 10, check);
    expect(tr.v).toBeLessThan(0.5);
  });
});

describe('environment', () => {
  it('wind restricts the elevated section and trains respect it', () => {
    const sim = makeSim('weekday', H);
    expect(sim.command({ c: 'env', wind: 2, duration: 1800 }).ok).toBe(true);
    const elevated = sim.topo.sections.filter((_, i) => sim.exposure[i] === 1);
    expect(elevated.length).toBeGreaterThan(10);
    expect(elevated.every((s) => sim.sec[s.id].envTsr === 45)).toBe(true);
    runFor(sim, 240, check);
    for (const tr of sim.trainList) {
      if (tr.body.every((b) => sim.exposure[sim.topo.links[b.link].section] === 1)) expect(tr.v).toBeLessThan(45 / 3.6 + PERF.atpTolerance);
    }
    runFor(sim, 1600, check);
    expect(sim.sec[elevated[0].id].envTsr).toBe(0);
  });

  it('morning possessions block their sections until the station asks to release them', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 't', startTime: 4 * 3600, seed: 3, autoRadio: false });
    const active = sim.possessions.filter((p) => p.state === 'active');
    expect(active.length).toBe(2);
    const s0 = active[0].sections[0];
    expect(sim.sec[s0].blocked).toBe(true);
    runUntil(sim, 4 * 3600 + 21 * 60);
    const call = sim.calls.find((c) => c.kind === 'possRel' && c.target === active[0].id && c.state === 'ringing');
    expect(call).toBeDefined();
    expect(sim.command({ c: 'sectionBlock', sections: [s0], on: false }).ok).toBe(false);
    expect(sim.command({ c: 'radio', call: call!.id, option: 'approve' }).ok).toBe(true);
    expect(sim.sec[s0].blocked).toBe(false);
  });
});

describe('yards, PIS', () => {
  it('vehicles are conserved between yards, the line and terminal stabling', () => {
    const sim = makeSim('weekday', H);
    const count = () => sim.yards.reduce((a, y) => a + yardCount(y), 0) + sim.trainList.reduce((a, t) => a + 1 + (t.coupledVehicle ? 1 : 0), 0);
    expect(count()).toBe(LINE_INFO.fleet);
    runFor(sim, 3600, check);
    expect(count()).toBe(LINE_INFO.fleet);
    const ids = new Set<string>();
    for (const y of sim.yards) for (const t of y.tracks) for (const v of t) ids.add(v);
    for (const t of sim.trainList) ids.add(t.vehicle);
    expect(ids.size).toBe(LINE_INFO.fleet);
  });

  it('PIS lists the next trains with destinations at a busy station', () => {
    const sim = makeSim('weekday', H);
    const pis = computePis(sim, st(sim, '人民广场').index);
    expect(pis.DN.length).toBeGreaterThan(0);
    expect(pis.UP.length).toBeGreaterThan(0);
    expect(pis.DN[0].eta).toBeLessThan(600);
    expect(pis.DN.every((r, i) => i === 0 || r.eta >= pis.DN[i - 1].eta)).toBe(true);
  });
});

describe('scenario & replay', () => {
  it('a scenario fires its events and produces a scored report', () => {
    const start = 9 * 3600 + 55 * 60;
    const sim = new Sim({ dayType: 'weekday', dateLabel: 't', startTime: start, seed: 5, scenario: 'cbtc-tbtc', autoRadio: true });
    runUntil(sim, start + 200);
    expect(sim.scenario?.id).toBe('cbtc-tbtc');
    expect(sim.zoneState[1]).toBe('ZCFAIL');
    expect(sim.command({ c: 'zoneLevel', zones: [1], level: 'TBTC' }).ok).toBe(true);
    runFor(sim, 600, check);
    const r = sim.command({ c: 'scenarioEnd' });
    expect(r.ok).toBe(true);
    const rep = sim.scenario!.report!;
    expect(rep.score).toBeGreaterThanOrEqual(0);
    expect(rep.score).toBeLessThanOrEqual(100);
    expect(rep.plannedTrips).toBeGreaterThan(0);
    expect(rep.delivery).toBeGreaterThan(0.5);
  });

  it('restoring a checkpoint and re-running reproduces the same state', () => {
    const sim = makeSim('weekday', H);
    const cp = capture(sim);
    runFor(sim, 400);
    const a = fingerprint(sim);
    restore(sim, cp);
    expect(sim.t).toBe(cp.t);
    runFor(sim, 400);
    expect(fingerprint(sim)).toBe(a);
    // a command after restore branches the future
    restore(sim, cp);
    const tr = sim.trainList.find((t) => t.inService && t.phase === 'run')!;
    sim.command({ c: 'trainHold', train: tr.id, on: true });
    runFor(sim, 400);
    expect(fingerprint(sim)).not.toBe(a);
  });

  it('platform berth of a station is reachable for PIS / stop logic', () => {
    const sim = makeSim('weekday', H);
    expect(platformBerth(sim.topo, 12, 'DN')).toBeGreaterThanOrEqual(0);
  });
});
