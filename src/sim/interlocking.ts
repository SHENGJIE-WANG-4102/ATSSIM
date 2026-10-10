/**
 * Computer interlocking (计算机联锁): switches, routes, signals, axle counters.
 */
import type { Sim } from './engine';
import type { ActiveRoute } from './model';

export const SWITCH_TIME = 5; // s, point machine throw time (approx)
export const APPROACH_RELEASE = 30; // s, delayed release when approach-locked
export const GUIDE_TIME = 60; // s, guide aspect timeout

export function swPos(sim: Sim, sw: number): 'N' | 'R' | null {
  const s = sim.sw[sw];
  if (s.failed) return s.fieldLock ? s.pos : null;
  if (s.pos !== s.target || sim.t < s.moveUntil) return null;
  return s.pos;
}

export interface CmdResult { ok: boolean; msg: string }

export function trySetRoute(sim: Sim, rid: number, opts: { manual?: boolean; fleeting?: boolean; guide?: boolean } = {}): CmdResult {
  const topo = sim.topo;
  const r = topo.routes[rid];
  const sg = sim.sig[r.start];
  const sname = topo.signals[r.start].name;
  if (sg.route >= 0) {
    if (sg.route === rid) {
      const ar = sim.routes.get(rid)!;
      if (opts.fleeting) ar.fleeting = true;
      if (opts.guide && !ar.guide) {
        ar.guide = true;
        ar.guideUntil = sim.t + GUIDE_TIME;
        return { ok: true, msg: `${sname} 引导信号开放` };
      }
      return { ok: true, msg: '进路已建立' };
    }
    return { ok: false, msg: `${sname} 已有其他进路` };
  }
  if (sg.failed && !opts.guide) return { ok: false, msg: `${sname} 信号机故障，无法开放（可办理引导进路）` };
  for (const s of r.sections) {
    const st = sim.sec[s];
    if (st.lockRoute >= 0) return { ok: false, msg: `区段 ${topo.sections[s].name} 已被进路锁闭（敌对进路）` };
    if (!opts.guide && (st.disturbed || st.preset)) return { ok: false, msg: `区段 ${topo.sections[s].name} 故障占用` };
  }
  for (const { sw, pos } of r.switches) {
    const st = sim.sw[sw];
    const name = topo.switches[sw].name;
    if (st.failed) {
      if (!(opts.guide && st.fieldLock && st.pos === pos)) return { ok: false, msg: `道岔 ${name} 失表${opts.guide ? '（需现场钩锁到所需位置）' : ''}` };
      continue;
    }
    if (st.pos !== pos || st.target !== pos) {
      if (st.lockCount > 0) return { ok: false, msg: `道岔 ${name} 被进路锁闭` };
      if (st.singleLock) return { ok: false, msg: `道岔 ${name} 单锁` };
      if (st.fieldLock) return { ok: false, msg: `道岔 ${name} 已钩锁` };
      for (const s of topo.switches[sw].sections) if (sim.sec[s].occ) return { ok: false, msg: `道岔 ${name} 区段占用，不能转换` };
    }
  }
  // accept
  const ar: ActiveRoute = {
    route: rid, state: 'setting', fleeting: !!opts.fleeting, manual: !!opts.manual, guide: !!opts.guide,
    guideUntil: opts.guide ? sim.t + GUIDE_TIME : 0, occSeen: r.sections.map(() => false), released: r.sections.map(() => false),
    entered: false, owner: -1, cancelAt: 0, setAt: sim.t,
  };
  for (const s of r.sections) sim.sec[s].lockRoute = rid;
  for (const { sw, pos } of r.switches) {
    const st = sim.sw[sw];
    st.lockCount++;
    if (!st.failed && (st.pos !== pos || st.target !== pos)) {
      st.target = pos;
      st.moveUntil = sim.t + SWITCH_TIME;
    }
  }
  sim.routes.set(rid, ar);
  sg.route = rid;
  sim.routeUnlockedSw.set(rid, new Set());
  return { ok: true, msg: `进路 ${r.name} 办理成功` };
}

function releaseSection(sim: Sim, ar: ActiveRoute, i: number) {
  const topo = sim.topo;
  const r = topo.routes[ar.route];
  const s = r.sections[i];
  ar.released[i] = true;
  if (sim.sec[s].lockRoute === ar.route) sim.sec[s].lockRoute = -1;
  const done = sim.routeUnlockedSw.get(ar.route)!;
  for (const { sw } of r.switches) {
    if (done.has(sw)) continue;
    const secs = topo.switches[sw].sections.filter((x) => r.sections.includes(x));
    if (secs.every((x) => ar.released[r.sections.indexOf(x)])) {
      done.add(sw);
      sim.sw[sw].lockCount = Math.max(0, sim.sw[sw].lockCount - 1);
    }
  }
}

export function releaseRoute(sim: Sim, rid: number) {
  const ar = sim.routes.get(rid);
  if (!ar) return;
  const r = sim.topo.routes[rid];
  for (let i = 0; i < r.sections.length; i++) if (!ar.released[i]) releaseSection(sim, ar, i);
  const done = sim.routeUnlockedSw.get(rid)!;
  for (const { sw } of r.switches) if (!done.has(sw)) { sim.sw[sw].lockCount = Math.max(0, sim.sw[sw].lockCount - 1); done.add(sw); }
  sim.routes.delete(rid);
  sim.routeUnlockedSw.delete(rid);
  if (sim.sig[r.start].route === rid) sim.sig[r.start].route = -1;
}

/** Is a train approaching this signal (approach locking)? */
/** a train's head passed a signal: the route (if any) is now owned/consumed */
export function signalPassed(sim: Sim, train: number, sig: number) {
  const sg = sim.sig[sig];
  if (sg.route < 0) return;
  const ar = sim.routes.get(sg.route)!;
  if (ar.fleeting || ar.entered) return;
  ar.entered = true;
  ar.owner = train;
}

export function approachLocked(sim: Sim, sig: number): boolean {
  for (const tr of sim.trainList) {
    if (tr.nextSignal === sig && tr.nextSignalDist < 600 && tr.v > 0.5) return true;
  }
  return false;
}

export function cancelRoute(sim: Sim, sig: number, opts: { force?: boolean; manual?: boolean } = {}): CmdResult {
  const sg = sim.sig[sig];
  const name = sim.topo.signals[sig].name;
  if (sg.route < 0) return { ok: false, msg: `${name} 无已建立进路` };
  const ar = sim.routes.get(sg.route)!;
  const r = sim.topo.routes[sg.route];
  if (ar.cancelAt > 0) return { ok: true, msg: `${name} 进路正在延时解锁` };
  if (!opts.force) {
    const occ = r.sections.some((s, i) => !ar.released[i] && sim.sec[s].trainOcc);
    if (occ) return { ok: false, msg: `进路 ${r.name} 内有车占用，不能取消` };
  }
  if (approachLocked(sim, sig) && !opts.force) {
    ar.cancelAt = sim.t + APPROACH_RELEASE;
    ar.fleeting = false;
    return { ok: true, msg: `${name} 接近锁闭，进路延时${APPROACH_RELEASE}秒解锁` };
  }
  releaseRoute(sim, sg.route);
  return { ok: true, msg: `${name} 进路取消` };
}

/** 区段故障解锁: force-release a section's route lock */
export function sectionUnlock(sim: Sim, sec: number): CmdResult {
  const rid = sim.sec[sec].lockRoute;
  const name = sim.topo.sections[sec].name;
  if (rid < 0) return { ok: false, msg: `区段 ${name} 未锁闭` };
  const ar = sim.routes.get(rid);
  if (!ar) { sim.sec[sec].lockRoute = -1; return { ok: true, msg: `区段 ${name} 已解锁` }; }
  const r = sim.topo.routes[rid];
  const i = r.sections.indexOf(sec);
  if (ar.fleeting) { releaseRoute(sim, rid); return { ok: true, msg: `区段 ${name} 故障解锁，自动通过进路已取消` }; }
  releaseSection(sim, ar, i);
  if (ar.released.every((x) => x)) releaseRoute(sim, rid);
  return { ok: true, msg: `区段 ${name} 故障解锁` };
}

export function moveSwitch(sim: Sim, sw: number, pos: 'N' | 'R'): CmdResult {
  const st = sim.sw[sw];
  const name = sim.topo.switches[sw].name;
  if (st.failed && pos === st.pos) {
    // operating a repaired switch to the position it already holds restores detection without movement
    const f = sim.faults.find((x) => x.kind === 'switch' && x.target === sw && !x.repaired);
    if (!f || sim.t >= f.repairAt) {
      st.failed = false;
      st.fieldLock = false;
      if (f) f.repaired = true;
      sim.clearAlarm(`sw-${sw}`);
      return { ok: true, msg: `道岔 ${name} ${pos === 'N' ? '定位' : '反位'}表示恢复` };
    }
  }
  if (st.lockCount > 0) return { ok: false, msg: `道岔 ${name} 被进路锁闭` };
  if (st.singleLock) return { ok: false, msg: `道岔 ${name} 单锁，不能转换` };
  if (st.fieldLock) return { ok: false, msg: `道岔 ${name} 已现场钩锁` };
  for (const s of sim.topo.switches[sw].sections) if (sim.sec[s].occ && !sim.sec[s].disturbed) return { ok: false, msg: `道岔 ${name} 区段占用` };
  st.target = pos;
  st.moveUntil = sim.t + SWITCH_TIME;
  if (st.failed) {
    // a throw attempt on a failed switch: succeeds only after maintenance
    const f = sim.faults.find((x) => x.kind === 'switch' && x.target === sw && !x.repaired);
    if (!f || sim.t >= f.repairAt) {
      st.failed = false;
      if (f) { f.repaired = true; sim.clearAlarm(`sw-${sw}`); }
      st.pos = st.pos === pos ? pos : st.pos;
      return { ok: true, msg: `道岔 ${name} 转换至${pos === 'N' ? '定位' : '反位'}，表示恢复` };
    }
    return { ok: false, msg: `道岔 ${name} 转换后仍无表示（失表）` };
  }
  return { ok: true, msg: `道岔 ${name} 转换至${pos === 'N' ? '定位' : '反位'}` };
}

export function computeOccupancy(sim: Sim) {
  const { sec, topo } = sim;
  for (const s of sec) { s.trainOcc = false; s.commOnly = true; }
  for (const tr of sim.trainList) {
    const commTrain = tr.comm && tr.level === 'CBTC' && sim.zoneState[topo.links[tr.link].zone] === 'CBTC';
    for (const b of tr.body) {
      const s = sec[topo.links[b.link].section];
      s.trainOcc = true;
      if (!commTrain) s.commOnly = false;
    }
  }
  for (const s of sec) {
    if (s.preset) {
      if (s.trainOcc) s.presetSeen = true;
      else if (s.presetSeen) { s.preset = false; s.presetSeen = false; }
    }
    s.occ = s.trainOcc || s.disturbed;
    if (s.disturbed) s.commOnly = false;
    if (!s.trainOcc && !s.disturbed) s.commOnly = false;
  }
}

export function updateInterlocking(sim: Sim) {
  const { topo } = sim;
  // switches
  for (const s of sim.sw) {
    if (!s.failed && s.pos !== s.target && sim.t >= s.moveUntil) s.pos = s.target;
  }
  // routes
  for (const ar of Array.from(sim.routes.values())) {
    const r = topo.routes[ar.route];
    if (ar.state === 'setting') {
      if (r.switches.every(({ sw, pos }) => swPos(sim, sw) === pos)) ar.state = 'locked';
      else if (sim.t - ar.setAt > 30) {
        // switch failed to reach position
        sim.log('B', '联锁', `进路 ${r.name} 办理超时（道岔未到位），进路取消`);
        releaseRoute(sim, ar.route);
        continue;
      }
    }
    if (ar.cancelAt > 0 && sim.t >= ar.cancelAt) {
      // a train that entered during the delay keeps the route (normal sectional release)
      if (ar.entered) ar.cancelAt = 0;
      else { releaseRoute(sim, ar.route); continue; }
    }
    if (ar.guide && !ar.entered && sim.t > ar.guideUntil) {
      sim.log('C', '联锁', `${topo.signals[r.start].name} 引导信号超时关闭`);
      releaseRoute(sim, ar.route);
      continue;
    }
    if (ar.fleeting) continue;
    if (!ar.entered) {
      // former automatic route: once the trains inside have left and nobody approaches, release it
      if (ar.defleeted && !r.sections.some((s) => sim.sec[s].trainOcc) && !approachLocked(sim, r.start)) { releaseRoute(sim, ar.route); }
      continue;
    }
    // sectional release behind the owning train
    const owner = sim.trains.get(ar.owner);
    if (!owner) { releaseRoute(sim, ar.route); continue; }
    const ownSecs = new Set<number>();
    for (const b of owner.body) ownSecs.add(topo.links[b.link].section);
    for (let i = 0; i < r.sections.length; i++) if (ownSecs.has(r.sections[i])) ar.occSeen[i] = true;
    // owner came to rest with its head in the last section: the route is complete
    const lastSec = r.sections[r.sections.length - 1];
    if (owner.v < 0.05 && topo.links[owner.link].section === lastSec && owner.phase !== 'run') {
      releaseRoute(sim, ar.route);
      continue;
    }
    for (let i = 0; i < r.sections.length; i++) {
      if (ar.released[i]) continue;
      if (ar.occSeen[i] && !ownSecs.has(r.sections[i]) && (i === 0 || ar.released[i - 1])) releaseSection(sim, ar, i);
      else break;
    }
    if (ar.released.every((x) => x)) releaseRoute(sim, ar.route);
  }
  // aspects
  for (let i = 0; i < sim.sig.length; i++) {
    const sg = sim.sig[i];
    sg.aspect = computeAspect(sim, i);
  }
}

function computeAspect(sim: Sim, i: number) {
  const sg = sim.sig[i];
  const { topo } = sim;
  const rid = sg.route;
  if (rid < 0) return sg.failed ? 'FAIL' : 'R';
  const ar = sim.routes.get(rid)!;
  if (ar.guide) return !ar.entered && sim.t <= ar.guideUntil ? 'GUIDE' : 'R';
  if (sg.failed) return 'FAIL';
  if (ar.state !== 'locked' || ar.cancelAt > 0) return 'R';
  if (ar.entered && !ar.fleeting) return 'R';
  const r = topo.routes[rid];
  for (const { sw, pos } of r.switches) if (swPos(sim, sw) !== pos) return 'R';
  let comm = false;
  for (const s of r.sections) {
    const st = sim.sec[s];
    if (st.disturbed || st.preset) return 'R';
    if (st.occ) {
      if (st.commOnly && sim.zoneState[topo.sections[s].zone] === 'CBTC') comm = true;
      else return 'R';
    }
  }
  if (comm) return 'DARK';
  return r.diverging ? 'Y' : 'G';
}
