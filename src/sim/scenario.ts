/**
 * Instructor / scenario mode: preset training scenarios, random fault
 * injection by difficulty, run metrics and the scored end-of-run report.
 */
import type { Sim } from './engine';
import type { DayType, Metrics, ScenarioReport, Train, FaultKind } from './model';
import { STATIONS, LINE_INFO } from '../data/line2';
import { injectFault } from './faults';
import { setWeather } from './env';
import { callPecu, callTrackPerson } from './radio';

export interface ScenarioDef {
  id: string;
  name: string;
  desc: string;
  objectives: string[];
  dayType: DayType;
  /** start time (s since midnight) */
  start: number;
  duration: number;
  events: { at: number; label: string; run: (sim: Sim) => string | void }[];
}

const H = (h: number, m = 0) => h * 3600 + m * 60;

function stationIdx(id: string) {
  return STATIONS.findIndex((s) => s.id === id);
}

/** a switch at a station by kind/position predicate */
function findSwitch(sim: Sim, station: number, pred: (sw: number) => boolean): number {
  const list = sim.topo.switches.filter((s) => s.station === station).map((s) => s.id);
  return list.find(pred) ?? list[0];
}

/** in-service train running in a chainage window in a direction */
function trainIn(sim: Sim, from: number, to: number, east: boolean): Train | undefined {
  const cand = sim.trainList.filter((tr) => {
    if (!tr.inService || tr.failed || tr.phase === 'stabled') return false;
    const l = sim.topo.links[tr.link];
    const e = tr.dir === 1 ? l.chainB >= l.chainA : l.chainA > l.chainB;
    const ch = sim.trainChain(tr);
    return e === east && ch >= from && ch <= to;
  });
  return cand.sort((a, b) => (east ? sim.trainChain(b) - sim.trainChain(a) : sim.trainChain(a) - sim.trainChain(b)))[0];
}

export const SCENARIOS: ScenarioDef[] = [
  {
    id: 'lyl-insert',
    name: '龙阳路早高峰加车',
    desc: '07:00 早高峰上线阶段，龙阳路车辆段出段咽喉道岔失去表示，同时世纪大道、龙阳路进站客流激增。需保证高峰加车按时上线、控制站台滞留。',
    objectives: [
      '处置龙阳路车辆段出段道岔失表（单操试排→钩锁确认→引导进路；修复后单操恢复表示）',
      '必要时从北翟路车辆段加开列车补位（命令页 → 加开列车）',
      '世纪大道、龙阳路站台滞留尽快消除（扣车均衡 / 限流）',
    ],
    dayType: 'weekday', start: H(6, 52), duration: 45 * 60,
    events: [
      {
        at: 60, label: '龙阳路车辆段出段道岔失表',
        run: (sim) => {
          const dp = sim.topo.depots.find((d) => d.key === 'LYD')!;
          const sw = findSwitch(sim, dp.station, (id) => sim.topo.switches[id].kind === 'depot' && sim.topo.switches[id].nodes.some((n) => Math.abs(sim.topo.nodes[n].chain - dp.junctionChain) < 1));
          injectFault(sim, 'switch', sw, 18 * 60);
        },
      },
      { at: 8 * 60, label: '世纪大道大客流', run: (sim) => { injectFault(sim, 'surge', stationIdx('SJD'), 30 * 60, 3); } },
      { at: 10 * 60, label: '龙阳路大客流', run: (sim) => { injectFault(sim, 'surge', stationIdx('LYL'), 25 * 60, 2.5); } },
    ],
  },
  {
    id: 'shr-switch',
    name: '淞虹路道岔故障',
    desc: '早高峰大小交路运营中，淞虹路折返线道岔失去表示，小交路列车无法在淞虹路站后折返。需调整交路（提前/延后折返）或组织钩锁+引导进路维持折返。',
    objectives: [
      '确认故障道岔并通知维修；必要时现场钩锁后办理引导进路折返',
      '小交路列车改在其他折返站人工折返（如中山公园），或延伸为大交路',
      '控制西段间隔，修复后恢复正常折返',
    ],
    dayType: 'weekday', start: H(7, 40), duration: 40 * 60,
    events: [
      {
        at: 90, label: '淞虹路折返线道岔失表',
        run: (sim) => {
          const st = stationIdx('SHR');
          const sw = findSwitch(sim, st, (id) => sim.topo.switches[id].kind === 'siding');
          injectFault(sim, 'switch', sw, 25 * 60);
        },
      },
    ],
  },
  {
    id: 'rmg-surge',
    name: '人民广场大客流',
    desc: '晚高峰人民广场站进站客流达平时5倍，站台严重拥挤，停站时间延长并波及全线。需综合运用扣车均衡间隔、限流、加开等手段。',
    objectives: [
      '应答车站客流电话，视情实施限流',
      '在人民广场前后站扣车均衡间隔，避免列车串挤',
      '考虑加开运行图（命令页 → 加开运行图模板）',
    ],
    dayType: 'weekday', start: H(17, 25), duration: 40 * 60,
    events: [
      { at: 120, label: '人民广场大客流（×5）', run: (sim) => { injectFault(sim, 'surge', stationIdx('RMG'), 35 * 60, 5); } },
      {
        at: 12 * 60, label: '列车乘客紧急报警',
        run: (sim) => {
          const c = sim.topo.stations[stationIdx('RMG')].chain;
          const tr = trainIn(sim, c - 3000, c - 300, true) ?? trainIn(sim, c - 6000, c, true);
          if (tr) callPecu(sim, tr);
        },
      },
    ],
  },
  {
    id: 'cbtc-tbtc',
    name: 'CBTC→TBTC 降级切换',
    desc: 'ZC2（中山公园—浦东南路）区域控制器故障，区域内CBTC列车失去移动授权紧急制动。需按程序切换至TBTC后备系统，固定闭塞下维持运营，修复后恢复CBTC。',
    objectives: [
      '确认区域内列车停稳 → 切换ZC2至TBTC（二次确认）',
      'TBTC运营期间注意追踪间隔，必要时扣车调整',
      'ZC修复后恢复CBTC',
    ],
    dayType: 'weekday', start: H(9, 55), duration: 45 * 60,
    events: [{ at: 120, label: 'ZC2 故障', run: (sim) => { injectFault(sim, 'zcFail', 1, 25 * 60); } }],
  },
  {
    id: 'rescue',
    name: '故障列车救援',
    desc: '一列下行载客列车在静安寺—南京西路区间发生牵引故障，司机处置无效。需组织后车清客救援、调整后续列车运行，并尽快恢复线路。',
    objectives: [
      '应答司机电话，确认无法恢复后组织救援（选中故障列车 → 组织救援，或电话中“组织后车救援”）',
      '救援期间对后续列车扣车/折返，避免区间积压',
      '救援完成后恢复正常间隔',
    ],
    dayType: 'weekday', start: H(9, 5), duration: 45 * 60,
    events: [
      {
        at: 90, label: '静安寺—南京西路列车故障',
        run: (sim) => {
          const a = sim.topo.stations[stationIdx('JAS')].chain;
          const b = sim.topo.stations[stationIdx('NJX')].chain;
          const tr = trainIn(sim, a + 150, b - 150, true) ?? trainIn(sim, a - 2500, b - 150, true);
          if (!tr) return '未找到合适列车';
          injectFault(sim, 'trainFail', tr.id, 0, undefined, false);
        },
      },
    ],
  },
  {
    id: 'storm',
    name: '东段雷暴大风',
    desc: '强对流天气影响东延伸高架段：大风黄色预警限速45km/h，随后暴雨，阵风一度达10级需高架段停运。需在广兰路/唐镇组织折返，天气好转后恢复。',
    objectives: [
      '关注环境限速对运行的影响，调整间隔',
      '高架段停运期间，在广兰路或唐镇对东行列车人工折返（选中列车 → 人工折返）',
      '恢复后组织列车重新进入东段，回归运行图',
    ],
    dayType: 'weekday', start: H(16, 30), duration: 50 * 60,
    events: [
      { at: 120, label: '大风黄色预警', run: (sim) => { setWeather(sim, { wind: 2, duration: 40 * 60 }); } },
      { at: 8 * 60, label: '暴雨', run: (sim) => { setWeather(sim, { rain: true, duration: 30 * 60 }); } },
      { at: 15 * 60, label: '阵风≥10级，高架段停运', run: (sim) => { setWeather(sim, { wind: 4, duration: 12 * 60 }); } },
      { at: 27 * 60, label: '风力减弱（黄色）', run: (sim) => { setWeather(sim, { wind: 2, duration: 15 * 60 }); } },
    ],
  },
];

// ---------------------------------------------------------------- metrics

export function newMetrics(t: number): Metrics {
  return {
    since: t, tripDelays: [], tripsCompleted: 0, departures: 0, departuresLate: 0, boardedDelayed: 0, stranded: 0, cleared: 0, limited: 0,
    safety: { spad: 0, overspeed: 0, rmNearMiss: 0, unsafeAuth: 0, espIgnored: 0, overrun: 0 },
    callsAnswered: 0, callsExpired: 0, faults: 0,
  };
}

export function startScenario(sim: Sim, id: string) {
  const def = SCENARIOS.find((s) => s.id === id);
  if (!def) return;
  sim.scenario = { id, name: def.name, start: sim.t, end: sim.t + def.duration, objectives: def.objectives, ended: false };
  sim.metrics = newMetrics(sim.t);
  sim.scenarioFired = 0;
  sim.log('B', '教员', `场景开始：${def.name}（时长 ${Math.round(def.duration / 60)} 分钟）`);
  sim.bookmark(`场景开始：${def.name}`, true);
}

export function scenarioTick(sim: Sim) {
  const sc = sim.scenario;
  if (!sc || sc.ended) return;
  const def = SCENARIOS.find((s) => s.id === sc.id);
  if (def) {
    while (sim.scenarioFired < def.events.length && sim.t - sc.start >= def.events[sim.scenarioFired].at) {
      const ev = def.events[sim.scenarioFired++];
      const r = ev.run(sim);
      sim.log('B', '教员', `场景事件：${ev.label}${r ? `（${r}）` : ''}`);
      sim.bookmark(ev.label, true);
    }
  }
  if (sim.t >= sc.end) endScenario(sim);
}

export function endScenario(sim: Sim): ScenarioReport {
  const sc = sim.scenario;
  const report = buildReport(sim, sc ? sc.name : '自由运营评估', sc ? sc.start : sim.metrics.since);
  if (sc) { sc.ended = true; sc.report = report; }
  sim.reportReady = report;
  sim.log('B', '教员', `${report.title}结束：得分 ${report.score}（${report.grade}）`);
  return report;
}

export function buildReport(sim: Sim, title: string, from: number): ScenarioReport {
  const m = sim.metrics;
  const now = sim.t;
  // train delay minutes: completed trips + trains still running late
  let delaySec = m.tripDelays.reduce((a, d) => a + Math.max(0, d), 0);
  for (const tr of sim.trainList) if (tr.inService && tr.delay > 60) delaySec += tr.delay;
  // planned trips that should have started in the window
  const planned = sim.plan.trips.filter((t) => t.revenue && t.stops[0].dep >= from && t.stops[0].dep <= now - 60);
  const plannedIds = new Set(planned.map((t) => t.id));
  const departed = new Set(sim.depLog.filter((d) => plannedIds.has(d.trip)).map((d) => d.trip));
  const delivered = planned.filter((t) => departed.has(t.id) && !t.cancelled).length;
  const delivery = planned.length ? delivered / planned.length : 1;
  const punctuality = m.departures ? 1 - m.departuresLate / m.departures : 1;
  const affected = Math.round(m.stranded + m.boardedDelayed + m.cleared + m.limited);
  const s = m.safety;
  const safetyTotal = s.spad + s.overspeed + s.rmNearMiss + s.unsafeAuth + s.espIgnored + s.overrun;
  const stops = sim.drivingStops.filter((x) => x.t >= from);
  const driving = stops.length ? {
    stops: stops.length,
    avgErr: stops.reduce((a, x) => a + Math.abs(x.err), 0) / stops.length,
    avgScore: stops.reduce((a, x) => a + x.score, 0) / stops.length,
  } : null;
  const delayMinutes = delaySec / 60;
  const pen = {
    delay: Math.min(30, delayMinutes * 0.25),
    affected: Math.min(20, affected / 400),
    delivery: Math.min(25, (1 - delivery) * 150),
    safety: Math.min(45, safetyTotal * 12),
    calls: Math.min(10, m.callsExpired * 2),
  };
  let score = 100 - pen.delay - pen.affected - pen.delivery - pen.safety - pen.calls;
  if (driving) score = score * 0.85 + driving.avgScore * 0.15;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = safetyTotal > 0 && score >= 70 ? 'C（存在安全违章）' : score >= 90 ? 'A 优秀' : score >= 80 ? 'B 良好' : score >= 65 ? 'C 合格' : 'D 不合格';
  const notes: string[] = [];
  if (safetyTotal) notes.push(`安全违章 ${safetyTotal} 起：${[s.spad && `冒进信号 ${s.spad}`, s.overspeed && `超速触发紧急制动 ${s.overspeed}`, s.rmNearMiss && `目视行车未能停车 ${s.rmNearMiss}`, s.unsafeAuth && `不安全授权 ${s.unsafeAuth}`, s.espIgnored && `未及时紧急关闭站台 ${s.espIgnored}`, s.overrun && `对标越站 ${s.overrun}`].filter(Boolean).join('、')}`);
  if (m.callsExpired) notes.push(`有 ${m.callsExpired} 次呼叫未在时限内应答`);
  if (delivery < 0.98) notes.push(`运行图兑现率 ${(delivery * 100).toFixed(1)}%，有车次未开行或被取消`);
  if (m.stranded > 500) notes.push(`站台滞留乘客较多（约 ${Math.round(m.stranded)} 人次），可考虑限流、加开或均衡间隔`);
  if (!notes.length) notes.push('处置得当，运营秩序良好');
  return {
    title, from, to: now, delayMinutes, affected, delivery, plannedTrips: planned.length, deliveredTrips: delivered, punctuality,
    safety: { ...s }, safetyTotal, callsAnswered: m.callsAnswered, callsExpired: m.callsExpired, driving, score, grade, notes,
  };
}

// ---------------------------------------------------------------- random faults

const LEVELS = [
  null,
  { label: '初级', mean: 25 * 60, kinds: [['trainFailR', 3], ['trainComm', 3], ['psd', 2], ['surge', 2], ['pecu', 2]] as [string, number][] },
  { label: '中级', mean: 14 * 60, kinds: [['trainFailR', 3], ['trainComm', 3], ['psd', 2], ['surge', 2], ['pecu', 2], ['switch', 2], ['axle', 2], ['signal', 2], ['wind', 1]] as [string, number][] },
  { label: '高级', mean: 8 * 60, kinds: [['trainFailR', 2], ['trainFail', 2], ['trainComm', 3], ['psd', 2], ['surge', 2], ['pecu', 2], ['switch', 3], ['axle', 2], ['signal', 2], ['zcFail', 1], ['wind', 1], ['rain', 1], ['trackPerson', 2]] as [string, number][] },
];

export const RANDOM_LEVELS = ['关闭', '初级', '中级', '高级'];

export function setRandomFaults(sim: Sim, level: number) {
  sim.randomLevel = Math.max(0, Math.min(3, level));
  sim.nextRandomAt = sim.randomLevel ? sim.t + 120 + sim.rng() * 300 : Infinity;
  return { ok: true, msg: `随机故障：${RANDOM_LEVELS[sim.randomLevel]}` };
}

export function randomTick(sim: Sim) {
  // nothing is injected during the warm-up before the session starts
  if (!sim.randomLevel || sim.t < sim.nextRandomAt || sim.t < sim.config.startTime) return;
  const lv = LEVELS[sim.randomLevel]!;
  // exponential inter-arrival
  sim.nextRandomAt = sim.t + Math.max(180, -Math.log(1 - sim.rng()) * lv.mean);
  const total = lv.kinds.reduce((a, k) => a + k[1], 0);
  let r = sim.rng() * total;
  let kind = lv.kinds[0][0];
  for (const [k, w] of lv.kinds) { r -= w; if (r <= 0) { kind = k; break; } }
  const msg = injectRandom(sim, kind);
  if (msg) {
    sim.log('B', '教员', `随机故障（${lv.label}）：${msg}`);
    sim.bookmark(`随机故障：${msg}`, true);
  }
}

function pick<T>(sim: Sim, arr: T[]): T | undefined {
  return arr.length ? arr[Math.floor(sim.rng() * arr.length)] : undefined;
}

function injectRandom(sim: Sim, kind: string): string {
  const { topo } = sim;
  const level = sim.randomLevel;
  const dur = (base: number) => Math.round(base * (0.7 + sim.rng() * 0.6) * (level === 3 ? 1.4 : 1));
  const running = sim.trainList.filter((t) => t.inService && t.phase === 'run' && !t.failed && !t.manual && topo.links[t.link].track !== 'DEP');
  const busy = topo.stations.filter((s) => STATIONS[s.index].demand >= 1.2).map((s) => s.index);
  const result = (r: { ok: boolean; msg: string }) => (r.ok ? r.msg.replace('已注入故障：', '') : '');
  switch (kind) {
    case 'trainFailR': {
      const tr = pick(sim, running);
      return tr ? result(injectFault(sim, 'trainFail', tr.id, dur(200), undefined, true)) : '';
    }
    case 'trainFail': {
      const tr = pick(sim, running);
      return tr ? result(injectFault(sim, 'trainFail', tr.id, 0, undefined, false)) : '';
    }
    case 'trainComm': {
      const tr = pick(sim, running.filter((t) => t.level === 'CBTC' && t.comm));
      return tr ? result(injectFault(sim, 'trainComm', tr.id, dur(420))) : '';
    }
    case 'psd': {
      const p = pick(sim, topo.platforms.filter((pp) => pp.station > 0 && pp.station < topo.stations.length - 1).map((pp) => pp.id));
      return p !== undefined ? result(injectFault(sim, 'psd', p, dur(600))) : '';
    }
    case 'surge': {
      const st = pick(sim, busy);
      return st !== undefined ? result(injectFault(sim, 'surge', st, dur(1500), 2 + Math.round(sim.rng() * 3))) : '';
    }
    case 'pecu': {
      const tr = pick(sim, running);
      if (!tr) return '';
      callPecu(sim, tr);
      return `列车 ${tr.svc}-${tr.tripNo} 乘客紧急报警`;
    }
    case 'trackPerson': {
      const p = pick(sim, topo.platforms.filter((pp) => STATIONS[pp.station].demand >= 1).map((pp) => pp.id));
      if (p === undefined) return '';
      callTrackPerson(sim, p);
      return `${topo.platforms[p].name} 人员侵入轨道`;
    }
    case 'switch': {
      const sw = pick(sim, topo.switches.filter((s) => s.kind === 'crossover' || s.kind === 'siding').map((s) => s.id));
      return sw !== undefined ? result(injectFault(sim, 'switch', sw, dur(900))) : '';
    }
    case 'axle': {
      const s = pick(sim, topo.sections.filter((x) => x.kind === 'plain' && (x.track === 'DN' || x.track === 'UP') && !sim.sec[x.id].trainOcc).map((x) => x.id));
      return s !== undefined ? result(injectFault(sim, 'axle', s, dur(480))) : '';
    }
    case 'signal': {
      const s = pick(sim, topo.signals.filter((x) => x.role === 'home' || x.role === 'start').map((x) => x.id));
      return s !== undefined ? result(injectFault(sim, 'signal', s, dur(600))) : '';
    }
    case 'zcFail': {
      const z = Math.floor(sim.rng() * topo.zones.length);
      return result(injectFault(sim, 'zcFail', z, dur(1200)));
    }
    case 'wind':
      return setWeather(sim, { wind: 1 + Math.floor(sim.rng() * 2), duration: dur(1500) }).msg;
    case 'rain':
      return setWeather(sim, { rain: true, duration: dur(1500) }).msg;
  }
  return '';
}

export function isFaultKind(k: string): k is FaultKind {
  return ['trainComm', 'zcFail', 'axle', 'switch', 'signal', 'psd', 'trainFail', 'surge', 'pecu', 'trackPerson'].includes(k);
}

export { LINE_INFO };
