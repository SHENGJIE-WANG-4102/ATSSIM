/**
 * Dispatcher command scenarios, end to end in the simulation.
 */
import { describe, expect, it } from 'vitest';
import type { Sim } from '../src/sim/engine';
import { makeSim, runFor, assertNoCollision, assertIntegrity, pickTrain, dirOf } from './helpers';

const st = (sim: Sim, name: string) => sim.topo.stations.find((s) => s.name === name)!;
const H = 8 * 3600;

function stepCheck(sim: Sim) { assertNoCollision(sim); assertIntegrity(sim); }

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

  it('manual turnback, withdraw and add train', () => {
    const sim = makeSim('weekday', H);
    const rm = st(sim, '人民广场');
    // Calibration changes the phase at 08:00. Wait for a real approaching
    // train rather than requiring this incidental snapshot to contain one.
    const suitable = () => sim.trainList.some(t => t.inService && t.phase==='run' && dirOf(sim,t)==='DN'
      && sim.trainChain(t)<rm.chain-1500 && sim.trainChain(t)>rm.chain-5000);
    const until=sim.t+900;while(!suitable()&&sim.t<until)runFor(sim,10,stepCheck);
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
    // The peak bands are at capacity (no slot keeps the minimum headway);
    // an extra train is planned for the first off-peak hour.
    const add = sim.command({c:'addTrain',depot:lyd,dir:'DN',to:st(sim,'广兰路').index,time:Math.max(sim.t+600,10*3600)});
    expect(add.ok,add.msg).toBe(true);
    const blk = sim.plan.blocks[sim.plan.blocks.length - 1];
    // The manual turnback above leaves the line disturbed and no automatic
    // dispatcher regulates it here, so the added train may run late; it must
    // still run both of its trips.
    const end = sim.plan.trips[blk.trips.at(-1)!].stops.at(-1)!.arr;
    const done = () => blk.trips.every(id => sim.plan.trips[id].completed || !sim.plan.trips[id].revenue);
    while (!done() && sim.t < end + 3600) runFor(sim, 60, stepCheck);
    expect(done()).toBe(true);
  });

  it('the CIIE added service in its 09:30 weekday window is planned in full and runs', () => {
    const sim = makeSim('weekday', 9 * 3600);
    const preset = { from: 9.5 * 3600, to: 10 * 3600, headway: 900 };
    const before = sim.plan.trips.length;
    const ov = sim.command({ c: 'overlay', id: 'ciie', ...preset });
    expect(ov.ok, ov.msg).toBe(true);
    const added = sim.plan.trips.slice(before).filter(t => t.revenue && t.overlay?.startsWith('ciie'));
    // 09:30, 09:45 and 10:00 in each direction, none dropped for capacity
    const service = added.filter(t => (t.from === 1 && t.to === 22) || (t.from === 22 && t.to === 1));
    expect(service.length).toBe(6);
    expect(added.every(t => !t.cancelled)).toBe(true);
    const last = Math.max(...added.map(t => t.stops.at(-1)!.arr));
    runFor(sim, last + 600 - sim.t, stepCheck);
    expect(added.filter(t => t.completed).length).toBeGreaterThanOrEqual(Math.ceil(.9 * added.length));
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
