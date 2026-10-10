/**
 * Train movement: movement-authority scan (ZC / TBTC / on-sight), ATP & ATO
 * control, kinematics and footprint (occupancy) maintenance.
 */
import type { Sim } from './engine';
import type { Train, BodySeg } from './model';
import { nextLink, type Dir } from './topology';
import { swPos } from './interlocking';
import { PERF, brakingSpeed, controlAccel } from './dynamics';
import { routeLeadsTo } from './ats';

const LOOKAHEAD = 1400;
const CBTC_SAFETY = 20; // m behind a preceding communicating train's tail
const SIGHT_MARGIN = 10; // m, RM on-sight stopping margin
const SIGNAL_MARGIN = 6; // m before a signal at danger

export interface ScanResult {
  maDist: number;
  maReason: string;
  stopDist: number;
  constraints: number[]; // flat [d, v, ...]
  vBody: number;
  nextSignal: number;
  nextSignalDist: number;
}

/** link speed limit incl. TSR (m/s) */
export function linkLimit(sim: Sim, link: number): number {
  const l = sim.topo.links[link];
  const tsr = sim.sec[l.section].tsr;
  return (tsr > 0 ? Math.min(l.limit, tsr) : l.limit) / 3.6;
}

/** berth the train is currently heading for, or -1 */
export function goalBerth(tr: Train): number {
  const t = tr.tasks[0];
  if (!t) return -1;
  if (t.k === 'stop') return t.berth;
  if (t.k === 'reverse') return t.chosen;
  if (t.k === 'stable') return t.berth;
  return -1;
}

export function scanAhead(sim: Sim, tr: Train, goal: number): ScanResult {
  const { topo } = sim;
  const res: ScanResult = { maDist: LOOKAHEAD, maReason: '', stopDist: Infinity, constraints: [], vBody: Infinity, nextSignal: -1, nextSignalDist: Infinity };
  const atp = tr.mode !== 'RM';
  const cbtc = tr.level === 'CBTC' && tr.comm;
  const rescueTarget = tr.tasks[0]?.k === 'rescue' ? (tr.tasks[0] as { target: number }).target : -1;
  const depotGoal = tr.tasks[0]?.k === 'depot' ? topo.depots[(tr.tasks[0] as { depot: number }).depot].berth : -1;
  const gb = goal >= 0 ? goal : depotGoal;
  const berth = gb >= 0 ? topo.berths[gb] : null;

  // body limits & ESP on body
  for (const b of tr.body) {
    res.vBody = Math.min(res.vBody, linkLimit(sim, b.link));
    const p = topo.links[b.link].platform;
    if (p >= 0 && sim.plat[p].esp && tr.phase === 'run') { res.maDist = 0; res.maReason = '站台紧急关闭'; }
  }
  if (tr.mode === 'RM') res.vBody = Math.min(res.vBody, PERF.vRM);

  const obstacle = (d: number, reason: string) => {
    if (d < res.maDist) { res.maDist = Math.max(0, d); res.maReason = reason; }
  };

  let link = tr.link;
  let dir = tr.dir;
  const l0 = topo.links[link];
  let d = dir === 1 ? l0.len - tr.off : tr.off;

  // goal on current link
  if (berth && berth.link === link && berth.dir === dir) {
    const dist = dir === 1 ? berth.offset - tr.off : tr.off - berth.offset;
    if (dist > -3) res.stopDist = Math.max(0, dist);
  }
  // other trains on current link ahead
  checkTrainsOnLink(sim, tr, link, dir, -(dir === 1 ? tr.off : l0.len - tr.off), rescueTarget, cbtc, atp, obstacle, res);

  // zone check for current position
  const z0 = sim.zoneState[l0.zone];
  if (atp && tr.level === 'CBTC' && z0 === 'ZCFAIL' && tr.rmAuth <= 0) obstacle(0, '区域控制器故障');
  if (atp && tr.level === 'CBTC' && !tr.comm) obstacle(0, '车地通信中断');

  let lastSec = l0.section;
  let guard = 0;
  // past the stopping point we only keep looking for the next signal (for ARS)
  let signalOnly = res.stopDist !== Infinity || res.maDist <= 0;
  while (d < LOOKAHEAD && guard++ < 60) {
    if (!signalOnly && (d >= res.maDist || res.stopDist !== Infinity)) signalOnly = true;
    if (signalOnly && (res.nextSignal >= 0 || d > 500)) break;
    const nx = nextLink(topo, link, dir, (sw) => swPos(sim, sw));
    const lk = topo.links[link];
    const node = dir === 1 ? lk.b : lk.a;
    if (signalOnly) {
      if (!nx) break;
      const sid = topo.signalByEntry.get(node * 65536 + nx.link);
      if (sid !== undefined) { res.nextSignal = sid; res.nextSignalDist = d; break; }
      d += topo.links[nx.link].len;
      link = nx.link;
      dir = nx.dir;
      continue;
    }
    if (!nx) {
      const n = topo.nodes[node];
      obstacle(d - (n.kind === 'end' ? 3 : SIGNAL_MARGIN), n.kind === 'end' ? (n.endKind === 'depot' ? '段界' : '车挡') : '道岔无表示');
      break;
    }
    const nl = topo.links[nx.link];
    // signal at entry
    const sigId = topo.signalByEntry.get(node * 65536 + nx.link);
    if (sigId !== undefined) {
      if (res.nextSignal < 0) { res.nextSignal = sigId; res.nextSignalDist = d; }
      const sg = sim.sig[sigId];
      let ok = false;
      if (sg.route >= 0) {
        const ar = sim.routes.get(sg.route)!;
        const consumed = ar.entered && !ar.fleeting && !ar.guide;
        if (atp) ok = ar.state === 'locked' && ar.cancelAt === 0 && !ar.guide && !consumed && !sg.failed;
        else ok = (ar.state === 'locked' || ar.guide) && ar.cancelAt === 0 && !consumed && (sg.aspect !== 'R' && sg.aspect !== 'FAIL' || tr.rmAuth > d);
      } else if (!atp && tr.rmAuth > d && !topo.signals[sigId].routes.some((r) => topo.routes[r].switches.length > 0)) {
        ok = true; // authorised to pass a signal at danger on plain line
      }
      if (!ok) { obstacle(d - SIGNAL_MARGIN, sg.failed ? '信号机故障' : '信号/进路未开放'); break; }
      // ATS departure / route check: the set route must lead towards the train's goal
      const routeGoal = gb >= 0 ? gb : sim.rescueGoal(tr);
      if (routeGoal >= 0 && sg.route >= 0 && !routeLeadsTo(sim, sg.route, routeGoal)) { obstacle(d - SIGNAL_MARGIN, '进路与计划不符'); break; }
    }
    // section checks
    if (nl.section !== lastSec) {
      const st = sim.sec[nl.section];
      const zs = sim.zoneState[nl.zone];
      lastSec = nl.section;
      if (atp && tr.rmAuth <= d) {
        if (tr.level === 'CBTC' && zs === 'ZCFAIL') { obstacle(d - 5, 'ZC故障区域'); break; }
        if (st.disturbed || st.preset) { obstacle(d - 5, st.preset ? '计轴预复位区段' : '计轴故障占用'); break; }
        if (st.occ) {
          const passable = cbtc && zs === 'CBTC' && st.commOnly;
          if (!passable) { obstacle(d - 5, cbtc ? '非通信车占用' : '前方区段占用'); break; }
        }
      }
    }
    // platform protections
    if (nl.platform >= 0) {
      const ps = sim.plat[nl.platform];
      if (ps.esp) { obstacle(d - 3, '站台紧急关闭'); break; }
      if (ps.psd === 'fault' && !ps.psdBypass && atp) { obstacle(d - 3, '站台门未关闭锁紧'); break; }
    }
    // other trains on this link
    checkTrainsOnLink(sim, tr, nx.link, nx.dir, d, rescueTarget, cbtc, atp, obstacle, res);
    // speed limits
    const lim = linkLimit(sim, nx.link);
    if (lim < res.vBody + 0.01 || lim < 25) res.constraints.push(d, tr.mode === 'RM' ? Math.min(lim, PERF.vRM) : lim);
    // goal
    if (berth && berth.link === nx.link && berth.dir === nx.dir) {
      res.stopDist = d + (nx.dir === 1 ? berth.offset : nl.len - berth.offset);
    }
    d += nl.len;
    link = nx.link;
    dir = nx.dir;
  }
  if (res.nextSignal < 0) { res.nextSignalDist = Infinity; }
  return res;
}

function checkTrainsOnLink(
  sim: Sim, tr: Train, link: number, dir: Dir, dEntry: number, rescueTarget: number, cbtc: boolean, atp: boolean,
  obstacle: (d: number, r: string) => void, res: ScanResult,
) {
  const segs = sim.linkBodies.get(link);
  if (!segs) return;
  const len = sim.topo.links[link].len;
  for (const s of segs) {
    if (s.train === tr.id) continue;
    const near = dir === 1 ? s.from : len - s.to;
    const dist = dEntry + near;
    if (dist < -0.5) continue; // behind us on the same link
    if (s.train === rescueTarget) {
      obstacle(dist - 0.3, '救援连挂');
      res.constraints.push(Math.max(0, dist - 25), PERF.vCouple);
      continue;
    }
    const other = sim.trains.get(s.train)!;
    const otherComm = other.comm && other.level === 'CBTC';
    let margin = SIGHT_MARGIN;
    if (atp) margin = cbtc && otherComm ? CBTC_SAFETY : 25;
    obstacle(dist - margin, otherComm ? '前车' : '前方列车(非通信)');
  }
}

/** Recompute body footprint from head + history. */
export function computeBody(sim: Sim, tr: Train) {
  const { topo } = sim;
  const body: BodySeg[] = [];
  let remaining = tr.len;
  const l = topo.links[tr.link];
  if (tr.dir === 1) {
    const from = Math.max(0, tr.off - remaining);
    body.push({ link: tr.link, from, to: tr.off });
    remaining -= tr.off - from;
  } else {
    const to = Math.min(l.len, tr.off + remaining);
    body.push({ link: tr.link, from: tr.off, to });
    remaining -= to - tr.off;
  }
  let used = 1;
  for (let i = tr.hist.length - 2; i >= 0 && remaining > 0.01; i--) {
    const h = tr.hist[i];
    const hl = topo.links[h.link];
    if (h.dir === 1) {
      const from = Math.max(0, hl.len - remaining);
      body.push({ link: h.link, from, to: hl.len });
      remaining -= hl.len - from;
    } else {
      const to = Math.min(hl.len, remaining);
      body.push({ link: h.link, from: 0, to });
      remaining -= to;
    }
    used++;
  }
  if (tr.hist.length > used + 1) tr.hist.splice(0, tr.hist.length - used - 1);
  tr.body = body;
}

/** Tail point of the train (position, direction of travel at the tail). */
export function tailOf(_sim: Sim, tr: Train): { link: number; off: number; dir: Dir } {
  const last = tr.body[tr.body.length - 1];
  const histEntry = tr.hist[tr.hist.length - tr.body.length] ?? tr.hist[0];
  const dir = histEntry.link === last.link ? histEntry.dir : tr.dir;
  return { link: last.link, off: dir === 1 ? last.from : last.to, dir };
}

/** Change ends: head becomes the old tail. */
export function reverseTrain(sim: Sim, tr: Train) {
  const segs = tr.body.slice();
  const hist = tr.hist.slice(tr.hist.length - segs.length);
  // hist[i] corresponds to segs[segs.length-1-i]
  const tailSeg = segs[segs.length - 1];
  const tailDir = hist[0].dir;
  const newHead = tailDir === 1 ? tailSeg.from : tailSeg.to;
  const newHist: { link: number; dir: Dir }[] = [];
  for (let i = hist.length - 1; i >= 0; i--) newHist.push({ link: hist[i].link, dir: (hist[i].dir === 1 ? -1 : 1) as Dir });
  tr.link = tailSeg.link;
  tr.off = newHead;
  tr.dir = (tailDir === 1 ? -1 : 1) as Dir;
  tr.hist = newHist;
  computeBody(sim, tr);
}

/** Advance the head by ds metres along the current switch positions. Returns false if blocked. */
function advance(sim: Sim, tr: Train, ds: number): boolean {
  const { topo } = sim;
  let rem = ds;
  let guard = 0;
  while (rem > 0 && guard++ < 20) {
    const l = topo.links[tr.link];
    const room = tr.dir === 1 ? l.len - tr.off : tr.off;
    if (rem <= room) {
      tr.off += tr.dir * rem;
      return true;
    }
    rem -= room;
    const nx = nextLink(topo, tr.link, tr.dir, (sw) => swPos(sim, sw));
    if (!nx) {
      tr.off = tr.dir === 1 ? l.len : 0;
      return false;
    }
    // passing a signal at danger?
    const sigId = topo.signalByEntry.get(nx.node * 65536 + nx.link);
    if (sigId !== undefined) {
      const sg = sim.sig[sigId];
      if ((sg.aspect === 'R' || sg.aspect === 'FAIL') && tr.mode === 'RM' && tr.rmAuth <= 0) {
        tr.passedRed++;
        sim.log('B', '信号', `列车 ${tr.svc}${tr.tripNo} 冒进信号 ${topo.signals[sigId].name}`, { key: `spad-${tr.id}` });
      }
      sim.onSignalPassed(tr, sigId);
    }
    tr.link = nx.link;
    tr.dir = nx.dir;
    tr.off = nx.dir === 1 ? 0 : topo.links[nx.link].len;
    tr.hist.push({ link: nx.link, dir: nx.dir });
  }
  return true;
}

export function updateTrainMotion(sim: Sim, tr: Train, dt: number) {
  const goal = goalBerth(tr);
  const scan = scanAhead(sim, tr, goal);
  tr.maDist = scan.maDist;
  tr.maReason = scan.maReason;
  tr.nextSignal = scan.nextSignal;
  tr.nextSignalDist = scan.nextSignalDist;
  tr.stopDist = scan.stopDist;

  const moving = tr.phase === 'run' && !tr.failed;
  if (!moving) {
    tr.v = 0;
    tr.a = 0;
    tr.vTarget = 0;
    return;
  }
  // pending driver mode change while stopped
  if (tr.pendingMode && tr.v < 0.05) {
    if (sim.t < tr.pendingModeAt) { tr.v = 0; return; }
  }

  // permitted & target speeds
  const stopAt = Math.min(scan.stopDist, scan.maDist);
  let vT = scan.vBody - (tr.mode === 'RM' ? 0.3 : PERF.atoMargin);
  let vP = scan.vBody + PERF.atpTolerance;
  for (let i = 0; i < scan.constraints.length; i += 2) {
    const d = scan.constraints[i];
    const v = scan.constraints[i + 1];
    vT = Math.min(vT, brakingSpeed(d - 3, v - (tr.mode === 'RM' ? 0.2 : PERF.atoMargin), PERF.bPlan));
    vP = Math.min(vP, brakingSpeed(d, v, PERF.bEbGuaranteed) + PERF.atpTolerance);
  }
  vT = Math.min(vT, brakingSpeed(scan.maDist - 1, 0, PERF.bPlan));
  if (scan.stopDist !== Infinity) vT = Math.min(vT, brakingSpeed(scan.stopDist - 0.2, 0, PERF.bPlan));
  vP = Math.min(vP, brakingSpeed(scan.maDist + 2, 0, PERF.bEbGuaranteed) + 0.6);
  if (tr.mode === 'CM') vT *= 0.96;
  if (tr.hold && tr.v < 0.1) vT = 0;
  vT = Math.max(0, vT);
  tr.vTarget = vT;
  tr.vPermit = vP;

  // ATP supervision
  if (!tr.eb) {
    const atp = tr.mode !== 'RM';
    if ((atp && tr.v > vP + 0.15) || (!atp && tr.v > PERF.vRM + PERF.atpTolerance)) {
      triggerEB(sim, tr, atp ? (scan.maDist < 30 ? `MA终点防护(${scan.maReason})` : '超速防护') : 'RM超速');
    }
    if (atp && tr.level === 'CBTC' && !tr.comm && tr.v > 0.1) triggerEB(sim, tr, '车地通信中断，MA失效');
    if (atp && tr.level === 'CBTC' && sim.zoneState[sim.topo.links[tr.link].zone] === 'ZCFAIL' && tr.rmAuth <= 0 && tr.v > 0.1) triggerEB(sim, tr, 'ZC故障，MA失效');
  }

  let a: number;
  if (tr.eb) {
    a = -PERF.bEb;
    if (tr.v <= 0.01) {
      tr.v = 0;
      if (sim.t - tr.ebSince > 6) {
        tr.eb = false;
        sim.clearAlarm(`eb-${tr.id}`);
      }
    }
  } else {
    a = controlAccel(tr.v, vT, stopAt);
  }
  tr.a = a;
  const v0 = tr.v;
  tr.v = Math.max(0, tr.v + a * dt);
  let ds = ((v0 + tr.v) / 2) * dt;
  // never pass the stopping point / MA end
  const hard = tr.eb ? Infinity : Math.max(0, stopAt + 0.3);
  if (ds > hard) { ds = hard; tr.v = Math.min(tr.v, 0.3); }
  if (stopAt < 0.4 && tr.v < 0.35 && !tr.eb) tr.v = 0;
  if (ds > 0) {
    const ok = advance(sim, tr, ds);
    if (tr.rmAuth > 0) tr.rmAuth = Math.max(0, tr.rmAuth - ds);
    if (!ok) { tr.v = 0; }
  }
  computeBody(sim, tr);
}

export function triggerEB(sim: Sim, tr: Train, reason: string) {
  tr.eb = true;
  tr.ebSince = sim.t;
  tr.ebReason = reason;
  sim.log('B', '列车', `列车 ${tr.svc}${tr.tripNo}（${tr.vehicle}）紧急制动：${reason}`, { key: `eb-${tr.id}` });
}

/** Rebuild link → body segment index for scans. */
export function indexBodies(sim: Sim) {
  sim.linkBodies.clear();
  for (const tr of sim.trainList) {
    for (const b of tr.body) {
      let arr = sim.linkBodies.get(b.link);
      if (!arr) { arr = []; sim.linkBodies.set(b.link, arr); }
      arr.push({ train: tr.id, from: b.from, to: b.to });
    }
  }
}
