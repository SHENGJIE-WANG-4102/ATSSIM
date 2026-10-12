import { describe, it, expect } from 'vitest';
import { Sim } from '../src/sim/engine';
import { capture, restore, fingerprint } from '../src/sim/state';
import { exportDiagnostics, stringifyDiagnostics, parseDiagnostics, replayDiagnostics, compactCheckpoints } from '../src/sim/diagnostics';
import { checkSafety } from '../src/sim/invariants';
import { MACHINES, MODE, EB, allowed } from '../src/sim/fsm';
import type { Command, Task, Trip } from '../src/sim/model';
import { openCall, answerCall, unsafeAhead, rescuerFor, callRescue, radioTick } from '../src/sim/radio';
import { trySetRoute, cancelRoute, committedTrain, bindRouteApproach, updateInterlocking, releaseRoute, computeOccupancy } from '../src/sim/interlocking';
import { setMode, grantRM, updateOnboard } from '../src/sim/onboard';
import { computeBody, indexBodies, rescueRouteReady, scanAhead } from '../src/sim/movement';
import { distanceToBerth, updateTrainTasks, rescueApproach, trainDesire, runARS, spawnDue, setTripFromTasks } from '../src/sim/ats';
import { dispatcherTick } from '../src/sim/dispatcher';
import { faultsTick, updateFaultLifecycle } from '../src/sim/faults';
import { updateHalts, rootCause } from '../src/sim/halt';
import { platformBerth, tripTasks, addTurnback, blockTasks, turnbackAt } from '../src/sim/timetable';

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
  it('holds a front turn outside the full path while an already set route contains another train', () => {
    const sim = make(); advance(sim,2); const [tr,other] = sim.trainList;
    for (const train of [...sim.trainList]) if (train !== tr && train !== other) sim.removeTrain(train);
    for (const id of [...sim.routes.keys()]) releaseRoute(sim,id);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    sim.t=20*3600; // revenue boarding window of the Hongqiao overlay
    const tb = turnbackAt(sim.topo,2,'UP')!; expect(tb.kind).toBe('front');
    if (tb.kind !== 'front') throw new Error('expected Hongqiao front turn');
    const signal = sim.topo.signals.find(s => s.name === 'S0406')!;
    const entry = sim.topo.links.find(l => l.a === signal.node && l.track === 'UP')!;
    tr.link=entry.id;tr.off=6.4;tr.dir=-1;tr.hist=[{link:entry.id,dir:-1}];
    tr.phase='run';tr.v=0;tr.eb=false;tr.block=-1;tr.tripId=-1;tr.inService=false;tr.depotStage='none';
    tr.load=1000;
    sim.plat[sim.topo.berths[tb.depBerth].platform].waiting=1000;
    tr.tasks=[{k:'stop',berth:tb.arrBerth,station:2,trip:-1,arr:null,dep:null,doors:true,revenue:true},
      {k:'reverse',berths:[tb.arrBerth],chosen:tb.arrBerth,station:2,minTime:40},
      {k:'stop',berth:tb.depBerth,station:2,trip:-1,arr:null,dep:sim.t+600,doors:true,revenue:true},
      {k:'stop',berth:platformBerth(sim.topo,3,'DN'),station:3,trip:-1,arr:null,dep:null,doors:false,revenue:false}];
    tr.nextSignal=signal.id;tr.nextSignalDist=6.4;tr.stopDist=Infinity;
    tr.maDist=tr.maFar=0;tr.maSigs=[];tr.lastDs=0;tr.lastMa=Infinity;
    const downstream = sim.topo.routes.find(r => r.name === 'S0402→S0318')!;
    expect(trySetRoute(sim,downstream.id,{fleeting:true}).ok).toBe(true);
    const link = sim.topo.links[downstream.steps[0].link];
    other.link=link.id;other.off=60;other.dir=-1;other.hist=[{link:link.id,dir:-1}];
    other.phase='failed';other.failed=true;other.v=0;other.tasks=[];other.block=-1;other.tripId=-1;
    computeBody(sim,tr);computeBody(sim,other);indexBodies(sim);computeOccupancy(sim);
    expect(other.body.every(body => sim.topo.links[body.link].platform !== sim.topo.berths[tb.arrBerth].platform)).toBe(true);
    expect(trainDesire(sim,tr)?.ready).toBe(false);
    runARS(sim);
    const first = sim.routeTable.next.get(tb.arrBerth)![signal.id];
    expect(sim.sig[signal.id].route).not.toBe(first);
    sim.removeTrain(other);indexBodies(sim);computeOccupancy(sim);
    let arrival = 0, departure = 0;
    const end = sim.t+400;
    while (sim.t < end && !departure) {
      sim.step();
      const current = sim.trains.get(tr.id)!;
      if (!arrival && current.phase==='dwell' && current.dir===-1 && current.lastStation===2) {
        arrival=sim.t;
        tr.tasks=tr.tasks.map(task => task.k==='stop' && task.berth===tb.depBerth ? {...task,dep:arrival+120} : task);
      }
      if (arrival && current.dir===1 && tr.v>0.05 && tr.tasks[0]?.k==='stop' && tr.tasks[0].station===3) departure=sim.t;
    }
    expect(arrival).toBeGreaterThan(0);expect(departure-arrival).toBeGreaterThanOrEqual(120-0.2);
    expect(departure-arrival).toBeLessThan(125);
    expect(sim.passengersServed).toBeGreaterThanOrEqual(1000);
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it.each(['CBTC', 'TBTC'] as const)('revalidates the sighting scan immediately when RM ends into %s', level => {
    const sim = make(); advance(sim,2); const tr = sim.trainList[0];
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    for (const id of [...sim.routes.keys()]) releaseRoute(sim,id);
    const signal = sim.topo.signals.find(s => s.name === 'X0501')!;
    const entry = sim.topo.links.find(l => l.b === signal.node && l.track === 'DN')!;
    tr.link = entry.id; tr.off = entry.len-50; tr.dir = 1; tr.hist = [{link:entry.id,dir:1}];
    tr.tasks = [{k:'depot',depot:0}]; tr.phase = 'run'; tr.v = 0; tr.eb = false;
    tr.depotStage = 'none'; tr.manual = false; tr.tbStage = 'none';
    tr.lastDs = 0; tr.lastMa = Infinity; tr.maSigs = []; tr.maDist = tr.maFar = 0;
    computeBody(sim,tr); indexBodies(sim); checkSafety(sim);
    expect(grantRM(sim,tr,0,-1,'test exhausted RM')).toBe(true);
    tr.maDist = tr.maFar = 9000; tr.maReason = tr.maFarReason = '前车';
    tr.v = 1; tr.forceLevel = level; tr.rmAuth = 0;
    updateOnboard(sim);
    expect(tr.mode).toBe(level==='CBTC'?'DTO':'AM'); expect(tr.level).toBe(level);
    expect(tr.maDist).toBeLessThanOrEqual(44); expect(tr.maFar).toBeLessThanOrEqual(44);
    expect(tr.maSigs).toHaveLength(0);
    checkSafety(sim); expect(sim.integrity.violations).toHaveLength(0);
  });
  it('follows occupancy behind a red signal even when the desired route is already set', () => {
    const sim = make(); advance(sim,2); const [tr,other] = sim.trainList;
    for (const id of [...sim.routes.keys()]) releaseRoute(sim,id);
    const signal = sim.topo.signals.find(s => s.name === 'X0501')!;
    const rid = sim.routeTable.next.get(sim.topo.depots[0].berth)![signal.id], route = sim.topo.routes[rid];
    expect(trySetRoute(sim,rid,{train:tr.id}).ok).toBe(true);
    const ar = sim.routes.get(rid)!; ar.state = 'locked';
    const entry = sim.topo.links.find(l => l.b === signal.node && l.track === 'DN')!;
    tr.link = entry.id; tr.off = entry.len-6.1; tr.dir = 1; tr.hist = [{link:entry.id,dir:1}];
    tr.tasks = [{k:'depot',depot:0}]; tr.phase = 'run'; tr.v = 0; tr.eb = false;
    tr.nextSignal = signal.id; tr.nextSignalDist = 6.1; tr.stopDist = Infinity;
    tr.maDist = 0; tr.maCode = 'ROUTE_WAIT'; tr.maTrain = -1; tr.arsWait = null;
    const last = route.steps.at(-1)!; other.link = last.link; other.off = sim.topo.links[last.link].len-6;
    other.dir = last.dir; other.hist = route.steps.map(step => ({...step})); other.failed = true; other.phase = 'failed'; other.v = 0;
    computeBody(sim,tr); computeBody(sim,other); indexBodies(sim); computeOccupancy(sim); sim.sig[signal.id].aspect = 'R';
    runARS(sim); updateHalts(sim);
    expect(tr.arsWait).toMatchObject({code:'TRAIN_AHEAD',train:other.id,t:sim.t});
    expect(rootCause(sim,tr).code).toBe('FAILED');
    expect(sim.sig[signal.id].route).toBe(rid);
  });
  it('retains the live blocker while cancellation of an occupied route is refused', () => {
    const sim = make(); advance(sim,2); const [tr,other] = sim.trainList;
    for (const id of [...sim.routes.keys()]) releaseRoute(sim,id);
    const signal = sim.topo.signals.find(s => s.name === 'X0501')!;
    const wanted = sim.routeTable.next.get(sim.topo.depots[0].berth)![signal.id];
    const actual = signal.routes.find(id => id !== wanted && sim.topo.routes[id].fleeting)!;
    expect(trySetRoute(sim,actual,{train:other.id}).ok).toBe(true);
    const ar = sim.routes.get(actual)!; ar.entered = true; ar.owner = other.id;
    sim.sec[sim.topo.routes[actual].sections[0]].trainOcc = true;
    const link = sim.topo.links.find(l => l.b === signal.node && l.track === 'DN')!;
    tr.link = link.id; tr.off = link.len-6.1; tr.dir = 1; tr.hist = [{link:link.id,dir:1}];
    tr.tasks = [{k:'depot',depot:0}]; tr.phase = 'run'; tr.v = 0; tr.eb = false;
    tr.nextSignal = signal.id; tr.nextSignalDist = 6.1; tr.stopDist = Infinity;
    tr.maDist = 0; tr.maCode = 'ROUTE_WAIT'; tr.maTrain = -1; tr.arsWait = null;
    other.failed = true; other.phase = 'failed'; other.v = 0;
    runARS(sim); updateHalts(sim);
    expect(tr.arsWait).toMatchObject({code:'ROUTE_CONFLICT',train:other.id,t:sim.t});
    expect(rootCause(sim,tr).code).toBe('FAILED');
    expect(sim.sig[signal.id].route).toBe(actual);
  });
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
  it('expires the retained ZC authority at standstill without reusing released routes', () => {
    const sim = make(); sim.autoRadio = false;
    let tr = sim.trainList.find(t => t.v > 5);
    while (!tr && sim.t < 14500) { sim.step(); tr = sim.trainList.find(t => t.v > 5); }
    expect(tr).toBeDefined(); const train = tr!;
    train.manual = true; train.mode = 'CM'; train.notch = 0;
    const protectedSignals = train.maSigs.slice();
    expect(sim.command({ c: 'fault', kind: 'zcFail', target: sim.topo.links[train.link].zone, duration: 120 }).ok).toBe(true);
    advance(sim, 20); expect(train.v).toBe(0); expect(train.eb).toBe(true);
    expect(train.maDist).toBe(0); expect(train.maFar).toBe(0); expect(train.maSigs).toHaveLength(0);
    for (const signal of protectedSignals) cancelRoute(sim, signal);
    advance(sim, 5); expect(sim.integrity.violations).toHaveLength(0);
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
  it('keeps the nearest train route when a farther route is still occupied by a preceding train', () => {
    const sim = make(); advance(sim, 2); const [front, rear, preceding] = sim.trainList;
    for (const other of [...sim.trainList]) if (![front,rear,preceding].includes(other)) sim.removeTrain(other);
    for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const sig = sim.topo.signals.find(s => s.name === 'S0506')!;
    const link = sim.topo.links.find(l => l.a === sig.node && l.track === 'UP')!;
    const previous = sim.topo.links.find(l => l.a === link.b && l.track === 'UP')!;
    for (const [tr,l,off] of [[front,link,6.4],[rear,previous,58]] as const) {
      tr.link=l.id;tr.off=off;tr.dir=-1;tr.hist=[{link:l.id,dir:-1}];tr.v=0;tr.eb=false;tr.phase='run';tr.block=-1;tr.tripId=-1;tr.inService=false;tr.manual=false;tr.depotStage='none';
      tr.maDist=tr.maFar=0;tr.maSigs=[];tr.lastMa=Infinity;tr.lastDs=0;computeBody(sim,tr);
    }
    const goal=platformBerth(sim.topo,3,'UP');
    front.tasks=[{k:'stop',berth:goal,station:3,trip:-1,arr:null,dep:null,doors:false,revenue:false}];
    rear.tasks=[{k:'depot',depot:0}];
    front.nextSignal=rear.nextSignal=sig.id;front.nextSignalDist=6.4;rear.nextSignalDist=previous.len+58;front.stopDist=rear.stopDist=Infinity;
    const berth=sim.topo.berths[goal];preceding.link=berth.link;preceding.off=berth.offset;preceding.dir=berth.dir;preceding.hist=[{link:berth.link,dir:berth.dir}];
    preceding.v=0;preceding.eb=false;preceding.phase='dwell';preceding.dwellUntil=sim.t+9999;preceding.hold=true;preceding.tasks=[{k:'stop',berth:goal,station:3,trip:-1,arr:null,dep:null,doors:false,revenue:false}];preceding.block=-1;preceding.tripId=-1;preceding.inService=false;preceding.depotStage='none';
    preceding.maDist=preceding.maFar=0;preceding.maSigs=[];preceding.lastMa=Infinity;preceding.lastDs=0;computeBody(sim,preceding);indexBodies(sim);
    const table=sim.routeTable.next.get(goal)!;let next=sig.id;let first=-1;
    for(let i=0;i<10;i++){
      const rid=table[next];expect(rid).toBeGreaterThanOrEqual(0);if(i===0)first=rid;
      expect(trySetRoute(sim,rid,{train:front.id}).ok).toBe(true);
      if(sim.topo.routes[rid].berths.includes(goal)){const ar=sim.routes.get(rid)!;ar.entered=true;ar.owner=preceding.id;break;}
      next=sim.topo.routes[rid].end;
    }
    expect(trainDesire(sim,front)?.signal).toBe(sig.id);
    for(let i=0;i<10;i++){sim.t+=1;updateInterlocking(sim);runARS(sim);}
    expect(sim.sig[sig.id].route).toBe(first);expect(sim.routes.get(first)?.cancelAt).toBe(0);
    const position=sim.trainChain(front);advance(sim,60);
    expect(position-sim.trainChain(front)).toBeGreaterThan(50);
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it('gives the physical front train a shared route despite the rear train earlier plan', () => {
    const sim = make(); advance(sim, 2); const [front, rear] = sim.trainList;
    for (const other of [...sim.trainList]) if (other !== front && other !== rear) sim.removeTrain(other);
    for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
    const sig = sim.topo.signals.find(s => s.name === 'S0506')!;
    const link = sim.topo.links.find(l => l.a === sig.node && l.track === 'UP')!;
    const goal = platformBerth(sim.topo, 3, 'UP');
    for (const [tr, off, arr] of [[front,6.1,sim.t+100],[rear,212.1,sim.t-100]] as const) {
      tr.link=link.id;tr.off=off;tr.dir=-1;tr.hist=[{link:link.id,dir:-1}];tr.v=0;tr.eb=false;tr.phase='run';
      tr.tasks=[{k:'stop',berth:goal,station:3,trip:-1,arr,dep:arr+40,doors:false,revenue:false}];
      tr.nextSignal=sig.id;tr.nextSignalDist=off;tr.stopDist=Infinity;computeBody(sim,tr);
    }
    indexBodies(sim);
    const route=sim.routeTable.next.get(goal)![sig.id];
    sim.sw[sim.topo.routes[route].switches[0].sw].failed=true;
    runARS(sim);
    expect(front.arsWait).toMatchObject({code:'SWITCH_FAULT',train:-1});
    expect(rear.arsWait).toMatchObject({code:'ROUTE_WAIT',train:front.id});
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
    sim.autoDispatch = true; sim.t = Math.ceil(sim.t / 5) * 5;
    faultsTick(sim);
    // Keep the occupied CI input in place while the dispatcher acts; a full
    // simulation step would overwrite this isolated field input.
    sim.sec[section].trainOcc = sim.sec[section].occ = true;
    dispatcherTick(sim);
    expect(sim.sec[section].trainOcc).toBe(true);
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
  it('locks a guide path and sweeps a preset that prevented ARS from setting the route', () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const sig = sim.topo.signals.find(s => s.name === 'X2311')!;
    const route = sim.topo.routes[sig.routes.find(id => sim.topo.routes[id].berths.length > 0)!];
    const berth = sim.topo.berths[route.berths[0]];
    const link = sim.topo.links.find(l => l.b === sig.node && l.track === 'DN')!;
    const previous = sim.topo.links.find(l => l.b === link.a && l.track === 'DN')!;
    tr.link = link.id; tr.off = link.len - 6.4; tr.dir = 1;
    tr.hist = [{ link: previous.id, dir: 1 }, { link: link.id, dir: 1 }];
    tr.phase = 'run'; tr.v = 0; tr.eb = false; tr.block = -1; tr.tripId = -1; tr.inService = false;
    tr.tasks = [{ k: 'reverse', berths: [berth.id], chosen: berth.id, station: berth.station, minTime: 40 },
      { k: 'stop', berth: platformBerth(sim.topo, berth.station, 'UP'), station: berth.station, trip: -1, arr: null, dep: null, doors: false, revenue: false, minDwell: 10 }, { k: 'depot', depot: 1 }];
    tr.maDist = tr.maFar = 0; tr.maSigs = []; tr.lastDs = 0; tr.lastMa = Infinity;
    computeBody(sim, tr); indexBodies(sim);
    expect(sim.command({ c: 'fault', kind: 'axle', target: route.sections[0], duration: 1 }).ok).toBe(true);
    advance(sim, 2);
    expect(sim.command({ c: 'axleReset', section: route.sections[0] }).ok).toBe(true);
    expect(sim.sig[sig.id].route).toBe(-1);
    sim.autoDispatch = true; advance(sim, 400);
    expect(sim.sec[route.sections[0]].preset).toBe(false);
    expect(sim.events.some(e => e.text.includes('引导') && e.text.includes(sig.name))).toBe(true);
    expect(tr.passedRed).toBe(0);
    expect(sim.integrity.violations).toHaveLength(0);
  });
});

describe('occupied-route rescue',()=>{
  it.each([
    ['S2404→S2310',false],['S2404→S2310',true],
    ['S0102→尽头(侧向)',false],['S0102→尽头(侧向)',true],
  ] as const)('admits only the assigned rescuer and retains locks through coupling (%s, preset=%s)',(name,preset)=>{
    const sim=make();advance(sim,2);const [rescuer,failed]=sim.trainList;
    for(const other of [...sim.trainList])if(other!==rescuer&&other!==failed)sim.removeTrain(other);
    for(const id of [...sim.routes.keys()])releaseRoute(sim,id);
    for(const block of sim.plan.blocks)sim.blockDone.add(block.id);
    rescuer.tasks=[];failed.tasks=[];rescuer.hold=failed.hold=true;
    const route=sim.topo.routes.find(r=>r.name===name)!;
    const signal=sim.topo.signals[route.start];
    expect(trySetRoute(sim,route.id,{train:failed.id}).ok).toBe(true);advance(sim,5);
    const entry=sim.topo.links.find(l=>l.a===signal.node&&l.track==='UP')!;
    rescuer.link=entry.id;rescuer.off=6.1;rescuer.dir=-1;rescuer.hist=[{link:entry.id,dir:-1}];
    let remaining=250,index=0;
    while(remaining>sim.topo.links[route.steps[index].link].len){remaining-=sim.topo.links[route.steps[index].link].len;index++;}
    const step=route.steps[index];failed.link=step.link;failed.dir=step.dir;
    failed.off=step.dir===1?remaining:sim.topo.links[step.link].len-remaining;
    failed.hist=route.steps.slice(0,index+1).map(s=>({...s}));
    for(const tr of [rescuer,failed]){
      tr.phase='run';tr.v=0;tr.eb=false;tr.manual=false;tr.block=-1;tr.tripId=-1;tr.hold=false;
      tr.tbStage='none';tr.depotStage='none';tr.maDist=tr.maFar=0;tr.lastMa=Infinity;tr.lastDs=0;tr.maSigs=[];
      computeBody(sim,tr);
    }
    const station=name.startsWith('S0102')?0:22;
    failed.tasks=[{k:'stop',berth:platformBerth(sim.topo,station,'UP'),station,trip:-1,arr:null,dep:null,doors:false,revenue:false}];
    rescuer.tasks=[{k:'rescue',target:failed.id}];rescuer.inService=false;
    rescuer.nextSignal=signal.id;rescuer.nextSignalDist=6.1;rescuer.stopDist=Infinity;
    indexBodies(sim);computeOccupancy(sim);const ar=sim.routes.get(route.id)!;
    ar.state='locked';ar.entered=true;ar.owner=failed.id;ar.fleeting=false;sim.sig[signal.id].aspect='R';
    ar.released[0]=true;sim.sec[route.sections[0]].lockRoute=-1;
    if(preset){sim.sec[route.sections[0]].preset=true;sim.sec[route.sections[0]].presetSeen=false;}
    expect(sim.command({c:'fault',kind:'trainFail',target:failed.id,duration:0,recoverable:false}).ok).toBe(true);checkSafety(sim);
    expect(rescueRouteReady(sim,rescuer,signal.id)).toBe(false);
    expect(scanAhead(sim,rescuer,-1).maDist).toBeLessThanOrEqual(6.1);
    rescuer.rescuing=failed.id;failed.rescueBy=rescuer.id;
    expect(rescueRouteReady(sim,rescuer,signal.id)).toBe(true);
    ar.owner=999;expect(rescueRouteReady(sim,rescuer,signal.id)).toBe(false);ar.owner=failed.id;
    updateTrainTasks(sim,rescuer);expect(rescuer.mode).toBe('RM');expect(rescuer.rmSig).toBe(signal.id);
    expect(ar.released[0]).toBe(false);expect(sim.sec[route.sections[0]].lockRoute).toBe(route.id);
    expect(scanAhead(sim,rescuer,-1).maCode).toBe('RESCUE');
    let approachMax=0;
    let coupled=false;
    for(let i=0;i<6000;i++){
      sim.step();if(sim.trains.has(failed.id))approachMax=Math.max(approachMax,rescuer.v);
      else if(!coupled){coupled=true;expect(sim.routes.get(route.id)?.owner).toBe(rescuer.id);}
    }
    expect(approachMax).toBeLessThanOrEqual(3/3.6+.1);expect(sim.trains.has(failed.id)).toBe(false);
    expect(rescuer.coupledLen).toBe(186);expect(rescuer.len).toBe(373);
    if(preset)expect(sim.sec[route.sections[0]].preset).toBe(false);
    expect(sim.integrity.violations.map(v=>({kind:v.kind,detail:v.detail}))).toEqual([]);
  });
});

describe('multiple-failure maintenance escalation', () => {
  function fixture(coupled: boolean) {
    const sim = make(); advance(sim,2); const [rescuer,failed] = sim.trainList;
    for (const other of [...sim.trainList]) if (other !== rescuer && other !== failed) sim.removeTrain(other);
    for (const id of [...sim.routes.keys()]) releaseRoute(sim,id);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const links = sim.topo.links.filter(l => l.track === 'UP' && l.normalDir === -1).sort((a,b) => a.chainA-b.chainA);
    const place = (tr: typeof failed, chain: number) => {
      const index = links.findIndex(l => l.chainA <= chain && l.chainB > chain), link = links[index];
      tr.link = link.id; tr.off = (chain-link.chainA)*link.len/(link.chainB-link.chainA); tr.dir = -1;
      tr.hist = links.slice(index,index+5).reverse().map(l => ({link:l.id,dir:-1 as const}));
      tr.phase = 'run'; tr.v = 0; tr.eb = false; tr.manual = false; tr.block = -1; tr.tripId = -1;
      tr.tbStage = 'none'; tr.depotStage = 'none'; tr.lastMa = Infinity; tr.lastDs = 0; tr.maDist = tr.maFar = 0; tr.maSigs = [];
      computeBody(sim,tr);
    };
    rescuer.len = coupled ? 373 : 186; rescuer.coupledLen = coupled ? 186 : 0;
    place(failed,56000); place(rescuer,56206);
    failed.tasks = [{k:'stop',berth:platformBerth(sim.topo,28,'UP'),station:28,trip:-1,arr:null,dep:null,doors:true,revenue:true}];
    rescuer.tasks = [{k:'depot',depot:2}]; rescuer.inService = false;
    setMode(sim,rescuer,'RM','CBTC','test'); indexBodies(sim);
    sim.command({c:'fault',kind:'trainFail',target:failed.id,duration:0,recoverable:false});
    advance(sim,30);
    return {sim,failed,rescuer,fault:sim.faults[0]};
  }
  it('keeps ordinary failures on the rescue path', () => {
    const {sim,failed,rescuer,fault} = fixture(false);
    expect(rescuerFor(sim,failed)?.id).toBe(rescuer.id);
    expect(sim.command({c:'trainMaintenance',fault:fault.id}).ok).toBe(false);
    expect(fault.maintenanceAt).toBeUndefined(); expect(failed.failed).toBe(true);
  });
  it('waits the full field-work time and withdraws the repaired blocker without moving its footprint', () => {
    const {sim,failed,fault} = fixture(true); const body = structuredClone(failed.body);
    expect(sim.command({c:'trainMaintenance',fault:fault.id}).ok).toBe(true);
    expect(fault.maintenanceAt).toBeCloseTo(sim.t+1200,4); expect(fault.stage).toBe('procedure');
    const cp = capture(sim); advance(sim,1199);
    expect(failed.failed).toBe(true); expect(failed.body).toEqual(body); expect(fault.repaired).toBe(false);
    advance(sim,1.1); expect(failed.failed).toBe(false); expect(failed.inService).toBe(false);
    expect(fault.repaired).toBe(true); expect(sim.trainChain(failed)).toBeGreaterThan(55999);
    const replay = make(); restore(replay,cp); advance(replay,1200.1);
    expect(fingerprint(replay)).toBe(fingerprint(sim));
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it('repairs a failed train straddling the scissors without moving a point beneath it, then restores its original cab',()=>{
    const sim=make();advance(sim,2);const [failed,rescuer]=sim.trainList;
    for(const other of [...sim.trainList])if(other!==failed&&other!==rescuer)sim.removeTrain(other);
    for(const id of [...sim.routes.keys()])releaseRoute(sim,id);
    for(const block of sim.plan.blocks)sim.blockDone.add(block.id);
    failed.tasks=[];rescuer.tasks=[];failed.hold=rescuer.hold=true;
    const pullout=sim.topo.routes.find(r=>r.name==='S3116→S3112(侧向)')!;
    expect(trySetRoute(sim,pullout.id,{manual:true,train:failed.id}).ok).toBe(true);advance(sim,5);
    // Real airport scissors footprint from the failing seed; the point
    // positions were established before this body occupied their sections.
    failed.link=518;failed.off=4.17072387;failed.dir=1;
    failed.hist=[513,514,515,516,517,518].map(link=>({link,dir:1 as const}));
    rescuer.link=252;rescuer.off=203.6220205;rescuer.dir=1;
    rescuer.hist=[251,252].map(link=>({link,dir:1 as const}));
    for(const tr of [failed,rescuer]){
      tr.v=0;tr.eb=false;tr.manual=false;tr.block=-1;tr.tripId=-1;tr.phase='run';tr.hold=false;
      tr.maDist=tr.maFar=0;tr.maSigs=[];tr.lastMa=Infinity;tr.lastDs=0;computeBody(sim,tr);
    }
    failed.tasks=[{k:'stop',berth:platformBerth(sim.topo,30,'UP'),station:30,trip:-1,arr:null,dep:null,doors:false,revenue:false}];
    failed.tbStage='arrive';failed.rescueReverse=true;failed.rescueBy=rescuer.id;
    rescuer.tasks=[{k:'rescue',target:failed.id}];rescuer.rescuing=failed.id;rescuer.nextSignal=168;rescuer.inService=false;
    indexBodies(sim);computeOccupancy(sim);
    expect(sim.command({c:'fault',kind:'trainFail',target:failed.id,duration:0,recoverable:false}).ok).toBe(true);
    checkSafety(sim); // observe fault creation before the next procedure command
    const fault=sim.faults.at(-1)!;const body=structuredClone(failed.body);const positions=sim.sw.map(sw=>sw.pos);
    expect(sim.command({c:'trainMaintenance',fault:fault.id}).ok).toBe(true);
    advance(sim,1199);expect(failed.body).toEqual(body);expect(sim.sw.map(sw=>sw.pos)).toEqual(positions);
    advance(sim,1.1);expect(failed.failed).toBe(false);expect(failed.dir).toBe(-1);
    expect(failed.rescueBy).toBe(-1);expect(rescuer.rescuing).toBe(-1);expect(failed.inService).toBe(false);
    const chain=sim.trainChain(failed);advance(sim,300);
    expect(sim.trainChain(failed)).toBeLessThan(chain-100);
    expect(sim.integrity.violations.map(v=>({kind:v.kind,detail:v.detail}))).toEqual([]);
  });
});

describe('paper-based turnback and depot procedures', () => {
  it.each([0, 30])('keeps a coupled rescue on its physical terminal tail (%s)', station => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const berths = sim.topo.stations[station].turnbackBerths;
    const physical = sim.topo.berths[berths[1]];
    const link = sim.topo.links[physical.link];
    const inner = sim.topo.links.find(l => l.track === link.track && (physical.dir === 1 ? l.b === link.a : l.a === link.b))!;
    tr.link = link.id; tr.off = physical.offset - physical.dir * 40; tr.dir = physical.dir;
    tr.hist = [{ link: inner.id, dir: physical.dir }, { link: link.id, dir: physical.dir }];
    tr.len = 373; tr.coupledLen = 186; tr.v = 0; tr.eb = false; tr.phase = 'run';
    tr.block = -1; tr.tripId = -1; tr.inService = false; tr.tbStage = 'arrive';
    tr.tasks = [{ k: 'reverse', berths: [berths[0]], chosen: berths[0], station, minTime: 40 },
      { k: 'stop', berth: platformBerth(sim.topo, station, station === 0 ? 'DN' : 'UP'), station, trip: -1, arr: null, dep: sim.t + 1800, doors: false, revenue: false }];
    sim.berthRes.set(berths[0], tr.id); computeBody(sim, tr); indexBodies(sim);
    tr.maDist = tr.maFar = 0; tr.maSigs = []; tr.lastMa = Infinity; tr.stopDist = Infinity;
    updateTrainTasks(sim, tr);
    expect(tr.tasks[0]).toMatchObject({ chosen: physical.id });
    expect(sim.berthRes.has(berths[0])).toBe(false);
    advance(sim, 150);
    expect(tr.dir).toBe(-physical.dir);
    expect(tr.tasks[0].k).toBe('stop');
    expect(sim.integrity.violations).toHaveLength(0);
  });
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
  it.each(['manual','none'] as const)('rescues an opposing failed terminal-tail train without selecting its parallel tail neighbour (stage=%s)', stage => {
    const sim = make(); advance(sim, 2); const [tr, failed, parallel] = sim.trainList;
    for (const other of [...sim.trainList]) if (![tr, failed, parallel].includes(other)) sim.removeTrain(other);
    for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const tail = sim.topo.berths[sim.topo.stations[0].turnbackBerths[0]];
    const outer = sim.topo.links[tail.link];
    const inner = sim.topo.links.find(l => l.a === outer.b && l.track === outer.track)!;
    failed.link = inner.id; failed.off = 78; failed.dir = 1;
    failed.hist = [{ link: outer.id, dir: 1 }, { link: inner.id, dir: 1 }];
    failed.v = 0; failed.eb = false; failed.block = -1; failed.tripId = -1; failed.tbStage = stage === 'none' ? 'none' : 'arrive';
    failed.phase = 'run'; computeBody(sim, failed);
    const platform = sim.topo.berths[platformBerth(sim.topo, 0, 'UP')];
    tr.link = platform.link; tr.off = 6; tr.dir = -1; tr.hist = [{ link: platform.link, dir: -1 }];
    tr.v = 0; tr.eb = false; tr.phase = 'run'; tr.block = -1; tr.tripId = -1; tr.inService = false;
    const otherTail = sim.topo.berths[sim.topo.stations[0].turnbackBerths[1]];
    parallel.link = otherTail.link; parallel.off = 201; parallel.dir = 1; parallel.hist = [{ link: otherTail.link, dir: 1 }];
    parallel.v = 0; parallel.phase = 'run'; parallel.block = -1; parallel.tripId = -1;
    parallel.tasks = [{ k: 'stop', berth: platformBerth(sim.topo, 0, 'DN'), station: 0, trip: -1, arr: null, dep: sim.t + 3600, doors: false, revenue: false }];
    computeBody(sim, tr); computeBody(sim, parallel); indexBodies(sim);
    for (const train of [tr, failed, parallel]) { train.maDist = train.maFar = 0; train.maSigs = []; train.lastDs = 0; train.lastMa = Infinity; }
    checkSafety(sim);
    if(stage==='manual'){ failed.tbStage = 'reverse'; checkSafety(sim); failed.tbStage = 'manual'; checkSafety(sim); }
    expect(sim.command({ c: 'fault', kind: 'trainFail', target: failed.id, duration: 0, recoverable: false }).ok).toBe(true);
    expect(rescueApproach(sim, failed, parallel)).toBeNull();
    expect(rescuerFor(sim, failed)?.id).toBe(tr.id);
    const call = callRescue(sim, failed)!;
    checkSafety(sim); // observe creation before the dispatcher answers
    expect(answerCall(sim, call.id, 'wait').ok).toBe(true);
    checkSafety(sim);
    sim.t += 121; radioTick(sim);
    checkSafety(sim);
    expect(sim.calls.some(c => c.kind === 'rescue' && c.train === failed.id && c.state === 'ringing')).toBe(true);
    const footprint = structuredClone(failed.body);
    expect(sim.command({ c: 'rescue', failed: failed.id, rescuer: tr.id }).ok).toBe(true);
    expect(failed.body.slice().sort((a, b) => a.link - b.link)).toEqual(footprint.sort((a, b) => a.link - b.link));
    sim.removeTrain(parallel);
    const vehicles = [tr.vehicle, failed.vehicle];
    advance(sim, 3300);
    expect(sim.trains.has(failed.id)).toBe(false);
    expect(sim.trains.has(tr.id)).toBe(false);
    for (const vehicle of vehicles) expect(sim.yards.some(y => y.tracks.some(track => track.includes(vehicle)))).toBe(true);
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

describe('withdrawal approach continuity', () => {
  it('clears passengers before choosing a forward turnback after leaving 淞虹路', () => {
    const sim = make(); advance(sim,2); const tr = sim.trainList[0];
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    for (const id of [...sim.routes.keys()]) releaseRoute(sim,id);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const berth=sim.topo.berths[platformBerth(sim.topo,4,'UP')];
    tr.link=berth.link; tr.off=berth.offset-6; tr.dir=-1; tr.hist=[{link:tr.link,dir:-1}];
    tr.phase='run'; tr.v=0; tr.eb=false; tr.load=500; tr.lastStation=4;
    tr.block=-1; tr.tripId=-1; tr.inService=true; tr.depotStage='none';
    tr.tasks=[{k:'stop',berth:platformBerth(sim.topo,3,'UP'),station:3,trip:-1,arr:null,dep:sim.t+300,doors:true,revenue:true}];
    tr.maDist=tr.maFar=0; tr.maSigs=[]; tr.lastMa=Infinity; tr.lastDs=0;
    computeBody(sim,tr); indexBodies(sim); checkSafety(sim);
    expect(sim.command({c:'withdraw',train:tr.id}).ok).toBe(true);
    const stops=tr.tasks.filter(t=>t.k==='stop');
    expect(stops.map(t=>t.station)).toEqual([3,1]);
    expect(tr.tasks.find(t=>t.k==='reverse')).toMatchObject({station:1});
    const vehicle=tr.vehicle; const cleared=sim.passengersCleared;
    advance(sim,2500);
    expect(sim.trains.has(tr.id)).toBe(false);
    expect(sim.yards.some(y=>y.tracks.some(track=>track.includes(vehicle)))).toBe(true);
    expect(sim.passengersCleared-cleared).toBe(500);
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it.each(['BZL', 'LYD', 'CSD'])('preserves an entered %s depot path during recovery and repeated withdrawal', key => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    for (const id of [...sim.routes.keys()]) releaseRoute(sim, id);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const depot = sim.topo.depots.find(d => d.key === key)!;
    const berth = sim.topo.berths[depot.berth];
    tr.link = berth.link; tr.off = berth.offset - berth.dir * 10; tr.dir = berth.dir;
    tr.hist = [{link:tr.link,dir:tr.dir}]; tr.v = 0; tr.eb = false; tr.phase = 'run';
    tr.block = -1; tr.tripId = -1; tr.inService = true; tr.delay = 1000; tr.load = 0;
    tr.tasks = [{k:'depot',depot:depot.id}]; tr.depotStage = 'none';
    tr.maDist = tr.maFar = 0; tr.maSigs = []; tr.lastMa = Infinity; tr.lastDs = 0;
    computeBody(sim,tr); indexBodies(sim); checkSafety(sim);
    const tasks = structuredClone(tr.tasks);
    expect(sim.command({c:'recoverService',train:tr.id}).ok).toBe(false);
    expect(tr.tasks).toEqual(tasks);
    setTripFromTasks(sim,tr); expect(tr.inService).toBe(false);
    expect(sim.command({c:'withdraw',train:tr.id}).ok).toBe(true);
    expect(tr.tasks).toEqual(tasks); expect(tr.inService).toBe(false);
    const vehicle = tr.vehicle;
    advance(sim,60);
    expect(sim.trains.has(tr.id)).toBe(false);
    expect(sim.yards[depot.id].tracks.some(track=>track.includes(vehicle))).toBe(true);
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it('goes straight to the tail when an empty terminal train has already departed its clear-out mark', () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    const berth = sim.topo.berths[platformBerth(sim.topo, 0, 'UP')];
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    for (const id of [...sim.routes.keys()]) releaseRoute(sim,id);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    tr.link = berth.link; tr.off = berth.offset-6; tr.dir = -1; tr.hist = [{link:tr.link,dir:-1}];
    tr.phase = 'run'; tr.v = 0; tr.eb = false; tr.load = 0; tr.lastStation = 0;
    tr.block = -1; tr.tripId = -1; tr.inService = true;
    tr.tasks = [{k:'stop',berth:platformBerth(sim.topo,0,'DN'),station:0,trip:-1,arr:null,dep:sim.t-200,doors:true,revenue:true}];
    tr.lastMa = Infinity; tr.maDist = tr.maFar = 0; tr.lastDs = 0; tr.maSigs = [];
    computeBody(sim,tr); indexBodies(sim);
    expect(sim.command({c:'withdraw',train:tr.id}).ok).toBe(true);
    expect(tr.tasks[0]).toMatchObject({k:'reverse',station:0});
    advance(sim,300);
    expect(tr.dir).toBe(1); expect(tr.tasks[0]).toMatchObject({k:'depot',depot:0});
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it('keeps the normal clear-out platform when the depot is behind a moving train', () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    const berth = sim.topo.berths[platformBerth(sim.topo, 2, 'UP')];
    tr.link = berth.link; tr.off = sim.topo.links[berth.link].len - 1; tr.dir = -1;
    tr.hist = [{link:tr.link,dir:-1}]; tr.phase = 'run'; tr.v = 3;
    tr.inService = true; tr.lastStation = 3;
    tr.tasks = [{k:'stop',berth:berth.id,station:2,trip:tr.tripId,arr:sim.t+10,dep:sim.t+40,doors:true,revenue:true}];
    computeBody(sim,tr); indexBodies(sim);
    expect(sim.command({c:'withdraw',train:tr.id}).ok).toBe(true);
    expect(tr.tasks[0]).toMatchObject({k:'stop',station:2,berth:berth.id});
    expect(tr.tasks.find(t=>t.k==='reverse')).toMatchObject({station:1});
    expect(tr.tasks.at(-1)?.k).toBe('depot');
    expect(sim.plan.trips[tr.tripId].cancelled).toBe(true);
    expect(sim.plan.trips[tr.tripId].cancelReason).toBe('调度命令');
  });
});

describe('depot selection after clear-out', () => {
  it('does not choose a depot entrance before the passenger clear-out station', () => {
    const sim = make(); advance(sim,2); const tr = sim.trainList[0];
    const link = sim.topo.links.find(l=>l.track==='UP'&&l.chainA<33510&&l.chainB>33510)!;
    tr.link=link.id;tr.off=33510-link.chainA;tr.dir=-1;tr.hist=[{link:tr.link,dir:-1}];
    tr.phase='run';tr.inService=true;tr.lastStation=20;tr.v=3;computeBody(sim,tr);indexBodies(sim);
    expect(sim.command({c:'withdraw',train:tr.id}).ok).toBe(true);
    expect(tr.tasks[0]).toMatchObject({k:'stop',station:19});
    const depot=tr.tasks.at(-1);expect(depot?.k).toBe('depot');
    if(depot?.k==='depot')expect(sim.topo.depots[depot.depot].key).toBe('BZL');
  });
});

describe('fault recovery service regulation', () => {
  const fixture = () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const makeTrip = (id: number, dir: 'DN' | 'UP', dep: number): Trip => {
      const from = dir === 'DN' ? 0 : 1; const to = dir === 'DN' ? 1 : 0;
      return {id,no:`R${id}`,dir,kind:'big',from,to,block:0,revenue:true,
        stops:[{st:from,arr:dep,dep,stop:true},{st:to,arr:dep+200,dep:dep+200,stop:true}]};
    };
    const trips = [makeTrip(0,'UP',sim.t-1200),makeTrip(1,'DN',sim.t-900),makeTrip(2,'UP',sim.t-500),makeTrip(3,'DN',sim.t+300)];
    trips[0].completed = true;
    sim.plan.trips = trips; sim.plan.blocks = [{id:0,svc:tr.svc,start:{kind:'stable',station:0},end:{kind:'depot',depot:0},trips:[0,1,2,3],train:tr.id}];
    const tasks: Task[] = [];
    tasks.push({k:'stop',berth:platformBerth(sim.topo,0,'UP'),station:0,trip:0,arr:sim.t-1000,dep:null,doors:true,revenue:true});
    for (let id=1;id<trips.length;id++) {addTurnback(sim.topo,trips[id-1],tasks);tripTasks(sim.topo,trips[id],tasks,false);}
    tasks.push({k:'depot',depot:0});
    tr.tasks=tasks;tr.phase='dwell';tr.dwellUntil=sim.t+18;tr.v=0;tr.eb=false;tr.manual=false;
    tr.block=0;tr.tripId=0;tr.tripNo='R0';tr.inService=true;tr.delay=1000;tr.lastStation=0;tr.load=0;tr.doorsOpen=false;tr.depotStage='none';tr.tbStage='none';
    const berth=sim.topo.berths[platformBerth(sim.topo,0,'UP')];tr.link=berth.link;tr.off=berth.offset;tr.dir=-1;tr.hist=[{link:berth.link,dir:-1}];
    tr.maDist=tr.maFar=0;tr.maSigs=[];tr.lastMa=Infinity;tr.lastDs=0;computeBody(sim,tr);indexBodies(sim);
    sim.tripsDone=1;sim.metrics.tripsCompleted=1;sim.metrics.tripDelays=[1000];
    return {sim,tr};
  };
  it('cancels only missed whole cycles and takes a future original slot without erasing lateness', () => {
    const {sim,tr}=fixture();const original=structuredClone(sim.plan.trips.map(t=>t.stops));
    expect(sim.command({c:'recoverService',train:tr.id}).ok).toBe(true);
    expect(sim.plan.trips.map(t=>!!t.cancelled)).toEqual([false,true,true,false]);
    expect(sim.plan.trips[0].completed).toBe(true);expect(sim.metrics.tripDelays).toEqual([1000]);
    expect(sim.plan.trips.map(t=>t.stops)).toEqual(original);
    expect(tr.tasks[1].k).toBe('reverse');expect(tr.tasks[2].k==='stop'&&tr.tasks[2].trip).toBe(3);
    advance(sim,400);
    expect(sim.depLog.some(d=>d.trip===3&&d.st===0&&Math.abs(d.delay)<=120)).toBe(true);
    expect(tr.delay).toBeLessThanOrEqual(120);expect(sim.integrity.violations).toHaveLength(0);
  });
  it('rejects cancellation during an active journey without altering its plan', () => {
    const {sim,tr}=fixture();tr.phase='run';const before=stringifyDiagnostics(exportDiagnostics(sim));
    expect(sim.command({c:'recoverService',train:tr.id}).ok).toBe(false);
    expect(sim.plan.trips.every(t=>!t.cancelled)).toBe(true);
    // Rejected command adds an audit event but preserves tasks, history and trip state.
    expect(sim.metrics.tripDelays).toEqual([1000]);expect(tr.tasks[0].k==='stop'&&tr.tasks[0].trip).toBe(0);expect(before).toContain('R0');
  });
  it('returns the vehicle from the current terminal when no near-term slot remains', () => {
    const {sim,tr}=fixture();sim.plan.trips[3].stops[0].dep=sim.t+3600;
    tr.tasks=tr.tasks.map(t=>t.k==='stop'&&t.trip===3&&t.arr===null?{...t,dep:sim.t+3600}:t);
    expect(sim.command({c:'recoverService',train:tr.id}).ok).toBe(false);
    expect(sim.plan.trips.every(t=>!t.cancelled)).toBe(true);
    expect(sim.command({c:'withdraw',train:tr.id}).ok).toBe(true);
    expect(sim.plan.trips[0].cancelled).toBeUndefined();expect(sim.plan.trips.slice(1).every(t=>t.cancelled)).toBe(true);
    const vehicle=tr.vehicle;advance(sim,2500);
    expect(sim.trains.has(tr.id)).toBe(false);expect(sim.yards.some(y=>y.tracks.some(track=>track.includes(vehicle)))).toBe(true);
    expect(sim.metrics.tripDelays).toEqual([1000]);expect(sim.integrity.violations).toHaveLength(0);
  });
  it.each([false, true])('withdraws only an exhausted block after clearance (future reachable=%s)', reachable => {
    const {sim,tr}=fixture();
    for (const id of [1,2,3]) {
      const dep = reachable && id === 3 ? sim.t + 3600 : sim.t - 300;
      sim.plan.trips[id].stops[0].dep = dep;
      tr.tasks = tr.tasks.map(t=>t.k==='stop'&&t.trip===id&&t.arr===null?{...t,dep}:t);
    }
    expect(sim.command({c:'fault',kind:'signal',target:0,duration:1}).ok).toBe(true);
    sim.t+=2;faultsTick(sim);updateFaultLifecycle(sim);
    expect(sim.faults.every(f=>f.stage==='closed')).toBe(true);
    const result=sim.command({c:'recoverService',train:tr.id});
    expect(result.ok).toBe(!reachable);
    expect(tr.inService).toBe(reachable);
    expect(sim.plan.trips[0].cancelled).toBeUndefined();
    expect(sim.plan.trips.slice(1).every(t=>!!t.cancelled)).toBe(!reachable);
    expect(sim.metrics.tripDelays).toEqual([1000]);
    if(!reachable)expect(sim.plan.trips[1].cancelReason).toContain('不可达');
  });
  it.each([false,true])('handles persistent lateness after clearance while retaining usable original slots (reachable=%s)', reachable => {
    const {sim,tr}=fixture();tr.delay=130;
    for(const id of [1,2,3]) tr.tasks=tr.tasks.map(t=>t.k==='stop'&&t.trip===id&&t.arr===null
      ? {...t,dep:reachable&&id===3?sim.t+3600:sim.t-300}:t);
    expect(sim.command({c:'fault',kind:'signal',target:0,duration:1}).ok).toBe(true);
    sim.t+=2;faultsTick(sim);updateFaultLifecycle(sim);
    sim.dispatcher.next.set('recovery-cleared-at',sim.t-2701);
    tr.load=200;const before=structuredClone(sim.plan.trips.map(t=>t.stops));
    expect(sim.command({c:'recoverService',train:tr.id}).ok).toBe(true);
    expect(tr.inService).toBe(false);expect(tr.load).toBe(0);
    expect(sim.plan.trips[0].completed).toBe(true);expect(sim.plan.trips[0].cancelled).toBeUndefined();
    expect(sim.metrics.tripDelays).toEqual([1000]);expect(sim.plan.trips.map(t=>t.stops)).toEqual(before);
    if(reachable){
      expect(sim.plan.trips[3].cancelled).toBeUndefined();
      expect(sim.plan.trips[1].cancelReason).toContain('定位');
      expect(tr.tasks.filter(t=>t.k==='stop'&&t.revenue).every(t=>t.k==='stop'&&t.trip===3)).toBe(true);
      expect(tr.tasks.some(t=>t.k==='reverse')).toBe(true);
    }else expect(tr.withdrawn).toBe(true);
    const cp=capture(sim);const replay=make();restore(replay,cp);expect(fingerprint(replay)).toBe(fingerprint(sim));
  });
});

describe('shared depot admission',()=>{
  it.each(['BZL','CSD'])('keeps an early departure inside %s until its origin slot is ready',key=>{
    const sim=make();const depot=sim.topo.depots.find(d=>d.key===key)!;
    const block=sim.plan.blocks.find(b=>b.start.kind==='depot'&&b.start.depot===depot.id)!;
    expect(block.start.kind).toBe('depot');if(block.start.kind!=='depot')return;
    sim.plan.blocks=[block];sim.t=block.start.time;
    const first=blockTasks(sim.topo,sim.plan,block)[0];expect(first.k).toBe('stop');if(first.k!=='stop'||first.dep===null)return;
    const distance=distanceToBerth(sim,depot.exitSignal,first.berth);
    const ready=first.dep-((15+distance)/15+30)-40;
    const stock=sim.depotStock[depot.id];
    expect(sim.t).toBeLessThan(ready);spawnDue(sim);
    expect(block.train).toBeUndefined();expect(sim.trainList).toHaveLength(0);expect(sim.depotStock[depot.id]).toBe(stock);
    sim.t=ready+1;spawnDue(sim);
    expect(block.train).toBeDefined();expect(sim.depotStock[depot.id]).toBe(stock-1);
    expect(sim.trainList[0].body.every(body=>sim.topo.links[body.link].track==='DEP')).toBe(true);
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
