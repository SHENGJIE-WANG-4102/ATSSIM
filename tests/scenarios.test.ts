/**
 * Fault injection and dispatcher command scenarios: each checks the
 * consequence and the recovery procedure end to end in the simulation.
 */
import { describe, expect, it } from 'vitest';
import type { Sim } from '../src/sim/engine';
import { makeSim, runFor, assertNoCollision, pickTrain, dirOf } from './helpers';
import { trainAheadOf } from '../src/sim/ats';

const st = (sim: Sim, name: string) => sim.topo.stations.find((s) => s.name === name)!;
const H = 8 * 3600;

function stepCheck(sim: Sim) { assertNoCollision(sim); }

describe('faults', () => {
  it('train communication loss → TBTC/CM with occupancy protection → upgrade after recovery', () => {
    const sim = makeSim('weekday', H);
    const tr = pickTrain(sim, (t, ch) => dirOf(sim, t) === 'DN' && ch > 15000 && ch < 22000 && t.v > 5);
    const r = sim.command({ c: 'fault', kind: 'trainComm', target: tr.id, duration: 900 });
    expect(r.ok).toBe(true);
    runFor(sim, 5, stepCheck);
    // its occupancy is no longer explained by a communicating train
    expect(sim.sec[sim.topo.links[tr.link].section].commOnly).toBe(false);
    expect(tr.eb || tr.v < 5).toBe(true);
    runFor(sim, 90, stepCheck);
    expect(tr.level).toBe('TBTC');
    expect(tr.mode).toBe('CM');
    const ch0 = sim.trainChain(tr);
    runFor(sim, 300, stepCheck);
    expect(sim.trainChain(tr)).toBeGreaterThan(ch0 + 500);
    runFor(sim, 700, stepCheck);
    expect(tr.comm).toBe(true);
    expect(tr.level).toBe('CBTC');
    expect(tr.mode).toBe('AM');
  });

  it('ZC failure → trains stop → switchover to TBTC → restore CBTC', () => {
    const sim = makeSim('weekday', H);
    const zone = 1;
    expect(sim.command({ c: 'fault', kind: 'zcFail', target: zone, duration: 600 }).ok).toBe(true);
    runFor(sim, 40, stepCheck);
    const inZone = sim.trainList.filter((t) => sim.topo.links[t.link].zone === zone && t.phase === 'run');
    expect(inZone.length).toBeGreaterThan(3);
    expect(inZone.every((t) => t.v < 0.5)).toBe(true);
    expect(sim.command({ c: 'zoneLevel', zones: [zone], level: 'CBTC' }).ok).toBe(false);
    expect(sim.command({ c: 'zoneLevel', zones: [zone], level: 'TBTC' }).ok).toBe(true);
    const pos = new Map(inZone.map((t) => [t.id, sim.trainChain(t)]));
    runFor(sim, 240, stepCheck);
    const moved = inZone.filter((t) => sim.trains.has(t.id) && Math.abs(sim.trainChain(t) - pos.get(t.id)!) > 200);
    expect(moved.length).toBeGreaterThan(inZone.length / 2);
    expect(sim.trainList.filter((t) => sim.topo.links[t.link].zone === zone).every((t) => t.level === 'TBTC')).toBe(true);
    runFor(sim, 400, stepCheck);
    expect(sim.command({ c: 'zoneLevel', zones: [zone], level: 'CBTC' }).ok).toBe(true);
    runFor(sim, 30, stepCheck);
    expect(sim.trainList.filter((t) => sim.topo.links[t.link].zone === zone && t.comm).every((t) => t.level === 'CBTC')).toBe(true);
  });

  it('axle counter failure → trains stop → reset fails before repair → preset + RM sweep clears', () => {
    const sim = makeSim('weekday', H);
    const a = st(sim, '北新泾').chain;
    const b = st(sim, '威宁路').chain;
    const sec = sim.topo.sections.find((s) => s.track === 'DN' && s.kind === 'plain' && s.chainFrom > a + 300 && s.chainTo < b - 300)!;
    expect(sim.command({ c: 'fault', kind: 'axle', target: sec.id, duration: 300 }).ok).toBe(true);
    runFor(sim, 240, stepCheck);
    expect(sim.trainList.some((t) => t.maReason === '计轴故障占用' && t.v < 0.1)).toBe(true);
    expect(sim.command({ c: 'axleReset', section: sec.id }).ok).toBe(false);
    runFor(sim, 70, stepCheck);
    expect(sim.command({ c: 'axleReset', section: sec.id }).ok).toBe(true);
    expect(sim.sec[sec.id].preset).toBe(true);
    runFor(sim, 360, stepCheck);
    expect(sim.sec[sec.id].preset).toBe(false);
    expect(sim.sec[sec.id].disturbed).toBe(false);
    expect(sim.events.some((e) => e.text.includes('预复位区段压道'))).toBe(true);
    expect(sim.alarms.has(`axle-${sec.id}`)).toBe(false);
  });

  it('switch loss of detection → field lock + guide route → RM passage → restore', () => {
    const sim = makeSim('weekday', H);
    const c = st(sim, '人民广场').chain;
    // DN turnout of the crossover west of 人民广场 (passed by every DN train)
    const sw = sim.topo.switches.find((s) => s.kind === 'crossover' && s.nodes.some((n) => sim.topo.nodes[n].chain < c && sim.topo.nodes[n].chain > c - 400))!;
    expect(sim.command({ c: 'fault', kind: 'switch', target: sw.id, duration: 900 }).ok).toBe(true);
    runFor(sim, 240, stepCheck);
    // the first DN train held in front of the failed switch
    const waiting = sim.trainList
      .filter((t) => dirOf(sim, t) === 'DN' && t.v < 0.1 && t.phase === 'run' && sim.trainChain(t) < c - 240 && sim.trainChain(t) > c - 1500)
      .sort((p, q) => sim.trainChain(q) - sim.trainChain(p))[0];
    expect(waiting).toBeTruthy();
    expect(sim.command({ c: 'switchMove', sw: sw.id, pos: 'N' }).ok).toBe(false);
    expect(sim.command({ c: 'switchFieldLock', sw: sw.id, on: true }).ok).toBe(true);
    const sig = waiting!.nextSignal;
    expect(sig).toBeGreaterThanOrEqual(0);
    const route = sim.topo.signals[sig].routes.find((r) => sim.topo.routes[r].switches.some((x) => x.sw === sw.id && x.pos === 'N') && !sim.topo.routes[r].wrongDir)!;
    expect(route).toBeDefined();
    if (sim.sig[sig].route >= 0) sim.command({ c: 'cancelRoute', signal: sig });
    runFor(sim, 31);
    expect(sim.command({ c: 'guideRoute', route }).ok).toBe(true);
    const ch0 = sim.trainChain(waiting!);
    runFor(sim, 150, stepCheck);
    expect(sim.trainChain(waiting!)).toBeGreaterThan(ch0 + 200);
    expect(sim.events.some((e) => e.text.includes('引导信号') && e.text.includes('RM'))).toBe(true);
    runFor(sim, 600, stepCheck);
    expect(sim.command({ c: 'switchFieldLock', sw: sw.id, on: false }).ok).toBe(true);
    expect(sim.command({ c: 'switchMove', sw: sw.id, pos: 'N' }).ok).toBe(true);
    expect(sim.sw[sw.id].failed).toBe(false);
  });

  it('signal failure → train held → guide route → passes in RM → repair', () => {
    const sim = makeSim('weekday', H);
    const s5 = st(sim, '北新泾');
    const sig = sim.topo.signals.find((s) => s.role === 'start' && s.station === s5.index && s.dir === 1 && sim.topo.links[s.link].track === 'DN')!;
    expect(sim.command({ c: 'fault', kind: 'signal', target: sig.id, duration: 900 }).ok).toBe(true);
    runFor(sim, 300, stepCheck);
    const held = sim.trainList.find((t) => t.nextSignal === sig.id && t.nextSignalDist < 30);
    expect(held).toBeTruthy();
    expect(held!.maReason).toBe('信号机故障');
    const route = sig.routes.find((r) => sim.topo.routes[r].fleeting)!;
    expect(sim.command({ c: 'setRoute', route }).ok).toBe(false);
    expect(sim.command({ c: 'guideRoute', route }).ok).toBe(true);
    runFor(sim, 120, stepCheck);
    expect(sim.trainChain(held!)).toBeGreaterThan(sig.chain + 50);
    runFor(sim, 600, stepCheck);
    expect(sim.sig[sig.id].failed).toBe(false);
    runFor(sim, 30);
    expect(sim.sig[sig.id].route).toBeGreaterThanOrEqual(0);
  });

  it('platform screen door failure → departure blocked → interlock bypass → departs', () => {
    const sim = makeSim('weekday', H);
    const p = st(sim, '威宁路').platforms.DN;
    expect(sim.command({ c: 'fault', kind: 'psd', target: p, duration: 1200 }).ok).toBe(true);
    let stuck = false;
    runFor(sim, 400, (s) => { stepCheck(s); if (s.alarms.has(`psd-${p}`)) stuck = true; });
    expect(stuck).toBe(true);
    const tr = sim.trainList.find((t) => t.phase === 'dwell' && sim.topo.links[t.link].platform === p)!;
    expect(tr).toBeTruthy();
    runFor(sim, 60);
    expect(tr.phase).toBe('dwell');
    expect(sim.command({ c: 'psdBypass', platform: p, on: true }).ok).toBe(true);
    runFor(sim, 60, stepCheck);
    expect(tr.phase).toBe('run');
    expect(sim.trainChain(tr)).toBeGreaterThan(sim.topo.stations[6].chain + 50);
  });

  it('failed train → rescue by the following train → coupled → withdrawn; service continues', () => {
    const sim = makeSim('weekday', H);
    const failed = pickTrain(sim, (t, ch) => dirOf(sim, t) === 'DN' && ch > 16500 && ch < 21000 && t.v > 8);
    expect(sim.command({ c: 'fault', kind: 'trainFail', target: failed.id, duration: 0, recoverable: false }).ok).toBe(true);
    runFor(sim, 260, stepCheck);
    expect(failed.failed).toBe(true);
    expect(sim.alarms.has(`tfr-${failed.id}`)).toBe(true);
    const rescuer = sim.trainList.find((t) => t.id !== failed.id && trainAheadOf(sim, t, 8000) === failed.id)!;
    expect(rescuer).toBeTruthy();
    expect(sim.command({ c: 'rescue', failed: failed.id, rescuer: rescuer.id }).ok).toBe(true);
    let coupled = false;
    runFor(sim, 1500, (s) => { stepCheck(s); if (!s.trains.has(failed.id)) coupled = true; });
    expect(coupled).toBe(true);
    runFor(sim, 2400, stepCheck);
    expect(sim.trains.has(rescuer.id) && sim.trains.get(rescuer.id)!.phase !== 'stabled').toBe(false);
    // the rest of the line keeps running
    expect(sim.trainList.filter((t) => t.inService && t.v > 1).length).toBeGreaterThan(10);
  });

  it('passenger surge → crowding alarm and longer dwell', () => {
    const sim = makeSim('weekday', H);
    const s = st(sim, '人民广场');
    expect(sim.command({ c: 'fault', kind: 'surge', target: s.index, duration: 1200, param: 6 }).ok).toBe(true);
    let maxWait = 0;
    runFor(sim, 900, (x) => { maxWait = Math.max(maxWait, x.plat[s.platforms.DN].waiting, x.plat[s.platforms.UP].waiting); });
    expect(maxWait).toBeGreaterThan(800);
    expect(sim.events.some((e) => e.text.includes('人民广场 大客流'))).toBe(true);
  });
});

describe('dispatcher commands', () => {
  it('hold / release, skip-stop, emergency close', () => {
    const sim = makeSim('weekday', H);
    runFor(sim, 30);
    const tr = sim.trainList.find((t) => t.phase === 'dwell' && t.inService)!;
    expect(sim.command({ c: 'trainHold', train: tr.id, on: true }).ok).toBe(true);
    runFor(sim, 150);
    expect(tr.phase).toBe('dwell');
    sim.command({ c: 'trainHold', train: tr.id, on: false });
    runFor(sim, 80);
    expect(tr.phase).not.toBe('dwell');

    const js = st(sim, '江苏路');
    sim.command({ c: 'platformSkip', platform: js.platforms.DN, on: true });
    let skipped = false;
    runFor(sim, 600, (x) => { if (x.events.some((e) => e.text.includes('跳停 江苏路'))) skipped = true; });
    expect(skipped).toBe(true);
    sim.command({ c: 'platformSkip', platform: js.platforms.DN, on: false });

    const p = js.platforms.UP;
    sim.command({ c: 'platformEsp', platform: p, on: true });
    let blocked = false;
    runFor(sim, 400, (x) => { stepCheck(x); if (x.trainList.some((t) => t.maReason === '站台紧急关闭' && t.v < 0.1)) blocked = true; });
    expect(blocked).toBe(true);
    sim.command({ c: 'platformEsp', platform: p, on: false });
    runFor(sim, 120, stepCheck);
    expect(sim.trainList.some((t) => t.maReason === '站台紧急关闭')).toBe(false);
  });

  it('temporary speed restriction is respected', () => {
    const sim = makeSim('weekday', H);
    const a = st(sim, '中山公园').chain;
    const b = st(sim, '江苏路').chain;
    const secs = sim.topo.sections.filter((s) => s.track === 'DN' && s.chainFrom >= a + 105 && s.chainTo <= b - 105).map((s) => s.id);
    expect(sim.command({ c: 'setTsr', sections: secs, kmh: 25 }).ok).toBe(true);
    runFor(sim, 60);
    let maxV = 0;
    runFor(sim, 500, (x) => {
      for (const t of x.trainList) if (t.body.every((bb) => secs.includes(x.topo.links[bb.link].section))) maxV = Math.max(maxV, t.v);
    });
    expect(maxV).toBeGreaterThan(3);
    expect(maxV).toBeLessThanOrEqual(25 / 3.6 + 1.0);
    expect(sim.command({ c: 'cancelTsr', sections: secs }).ok).toBe(true);
  });

  it('manual turnback, withdraw, add train and added-service template', () => {
    const sim = makeSim('weekday', H);
    const rm = st(sim, '人民广场');
    const tr = pickTrain(sim, (t, ch) => dirOf(sim, t) === 'DN' && ch < rm.chain - 1500 && ch > rm.chain - 5000);
    const r1 = sim.command({ c: 'turnback', train: tr.id, station: rm.index });
    expect(r1.ok).toBe(true);
    let turned = false;
    runFor(sim, 1200, (x) => { stepCheck(x); if (x.trains.has(tr.id) && dirOf(x, tr) === 'UP' && x.trainChain(tr) < rm.chain - 300) turned = true; });
    expect(turned).toBe(true);

    const w = pickTrain(sim, (t) => dirOf(sim, t) === 'UP' && t.id !== tr.id);
    expect(sim.command({ c: 'withdraw', train: w.id }).ok).toBe(true);
    runFor(sim, 3600, stepCheck);
    expect(sim.trains.has(w.id)).toBe(false);

    const lyd = sim.topo.depots.findIndex((d) => d.key === 'LYD');
    const add = sim.command({ c: 'addTrain', depot: lyd, dir: 'DN', to: st(sim, '广兰路').index, time: sim.t + 600 });
    expect(add.ok).toBe(true);
    const blk = sim.plan.blocks[sim.plan.blocks.length - 1];
    const ov = sim.command({ c: 'overlay', id: 'ciie', from: sim.t + 1200, to: sim.t + 4800, headway: 900 });
    expect(ov.ok).toBe(true);
    const extra = sim.plan.trips.filter((t) => t.overlay?.startsWith('ciie')).length;
    expect(extra).toBeGreaterThan(4);
    runFor(sim, 6000, stepCheck);
    expect(sim.blockDone.has(blk.id)).toBe(true);
    const done = sim.depLog.filter((d) => sim.plan.trips[d.trip].overlay?.startsWith('ciie')).length;
    expect(done).toBeGreaterThan(20);
  });

  it('manual route cancel / set at a signal', () => {
    const sim = makeSim('weekday', H);
    const s = sim.topo.signals.find((x) => x.role === 'start' && x.station === 10 && sim.topo.links[x.link].track === 'DN')!;
    expect(sim.sig[s.id].route).toBeGreaterThanOrEqual(0);
    sim.command({ c: 'ars', signal: s.id, on: false });
    // a route with a train in it cannot be cancelled; retry until it is clear
    let c = sim.command({ c: 'cancelRoute', signal: s.id });
    for (let i = 0; i < 300 && !c.ok; i++) { runFor(sim, 1); c = sim.command({ c: 'cancelRoute', signal: s.id }); }
    expect(c.ok).toBe(true);
    runFor(sim, 40);
    expect(sim.sig[s.id].route).toBe(-1);
    const r = s.routes.find((x) => sim.topo.routes[x].fleeting)!;
    expect(sim.command({ c: 'setRoute', route: r }).ok).toBe(true);
    runFor(sim, 10);
    expect(sim.sig[s.id].route).toBe(r);
    sim.command({ c: 'ars', signal: s.id, on: true });
  });
});
