/**
 * Simulation engine: owns all dynamic state and advances it with a fixed
 * time step. Runs inside a Web Worker (src/sim/worker.ts) or headless in
 * tests.
 */
import { buildTopology, linkChain, type Topology } from './topology';
import { computeRunTimes, type RunTimes } from './dynamics';
import {
  generatePlan, applyOverlay, addExtraTrain, OVERLAY_PRESETS, type PlanContext,
} from './timetable';
import type {
  ActiveRoute, AlarmLevel, Command, DayType, Fault, Plan, PlatformState, SectionState, SignalState, SimConfig,
  SimEvent, Snapshot, SwitchState, Train, TrainSnap, ZoneState, StopTask,
} from './model';
import { SEC, SW, SIGF, PLT, SIG_ASPECT } from './model';
import {
  computeOccupancy, updateInterlocking, trySetRoute, cancelRoute, moveSwitch, sectionUnlock, signalPassed, type CmdResult,
} from './interlocking';
import { updateTrainMotion, indexBodies } from './movement';
import {
  buildRouteTable, type RouteTable, spawnDue, updateTrainTasks, runARS, updateLevels, driverRM, recordTrace,
  cmdTrainHold, cmdSkip, cmdTurnback, cmdWithdraw, cmdAuthRM, cmdRescue, resetVehicles, trainLabel,
} from './ats';
import { passengersTick } from './passengers';
import { injectFault, repairFault, faultsTick, FAULT_LABELS } from './faults';
import { LINE_INFO, STATIONS } from '../data/line2';

export const FIXED_DT = 0.1;

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let sharedTopo: Topology | null = null;
let sharedRt: RunTimes | null = null;
let sharedTable: RouteTable | null = null;

export class Sim {
  topo: Topology;
  rt: RunTimes;
  planCtx: PlanContext;
  plan: Plan;
  routeTable: RouteTable;
  config: SimConfig;

  t = 0;
  dayStart = 4 * 3600;
  speed = 1;
  paused = false;

  sw: SwitchState[];
  sec: SectionState[];
  sig: SignalState[];
  plat: PlatformState[];
  zoneState: ZoneState[];
  routes = new Map<number, ActiveRoute>();
  routeUnlockedSw = new Map<number, Set<number>>();

  trains = new Map<number, Train>();
  trainList: Train[] = [];
  nextTrainId = 1;
  linkBodies = new Map<number, { train: number; from: number; to: number }[]>();
  berthRes = new Map<number, number>();
  depotStock: number[];
  depotShortLogged = new Set<number>();
  blockDone = new Set<number>();

  faults: Fault[] = [];
  nextFaultId = 1;
  events: SimEvent[] = [];
  newEvents: SimEvent[] = [];
  alarms = new Map<string, SimEvent>();
  alarmsDirty = true;
  nextEventId = 1;
  noRouteLogged = new Set<number>();
  truncatedTrips = new Map<number, number>();
  planDirty = false;
  removedTraces: { train: number; pts: number[] }[] = [];

  passengersServed = 0;
  passengersCleared = 0;
  passengersStranded = 0;
  depTotal = 0;
  depOnTime = 0;
  tripsDone = 0;
  rng: () => number;
  private secAcc = 0;
  stepsThisSecond = 0;
  stepsPerSec = 0;

  constructor(config: SimConfig) {
    this.config = config;
    if (!sharedTopo) {
      sharedTopo = buildTopology();
      sharedRt = computeRunTimes(sharedTopo, LINE_INFO.trainLength);
      sharedTable = buildRouteTable(sharedTopo);
    }
    this.topo = sharedTopo;
    this.rt = sharedRt!;
    this.routeTable = sharedTable!;
    this.rng = mulberry32(config.seed);
    this.planCtx = { topo: this.topo, rt: this.rt, dayType: config.dayType };
    this.plan = generatePlan(this.planCtx);
    const { topo } = this;
    this.sw = topo.switches.map(() => ({ pos: 'N', target: 'N', moveUntil: 0, failed: false, fieldLock: false, singleLock: false, lockCount: 0 }));
    this.sec = topo.sections.map(() => ({ occ: false, trainOcc: false, commOnly: false, disturbed: false, preset: false, presetSeen: false, lockRoute: -1, tsr: 0 }));
    this.sig = topo.signals.map(() => ({ aspect: 'R', route: -1, failed: false, ars: true, autoPass: true }));
    this.plat = topo.platforms.map(() => ({ hold: false, skip: false, esp: false, psd: 'closed', psdFault: false, psdBypass: false, waiting: 0, surge: 1, stranded: 0, lastDep: 0, lastArr: 0 }));
    this.zoneState = topo.zones.map(() => 'CBTC');
    this.depotStock = this.initialDepotStock();
    resetVehicles();
    this.t = this.dayStart;
    // set the automatic (fleeting) routes
    for (const r of topo.routes) if (r.fleeting && this.sig[r.start].route < 0) trySetRoute(this, r.id, { fleeting: true });
    for (const s of this.sw) s.moveUntil = 0;
    this.log('I', '系统', `ATS 启动：${config.dateLabel}（${config.dayType === 'weekday' ? '工作日' : '双休日/节假日'}运行图，计划车次 ${this.plan.trips.length}，最大上线 ${this.plan.fleetPeak} 列）`);
    spawnDue(this);
  }

  private initialDepotStock(): number[] {
    const { plan, topo } = this;
    const stock = topo.depots.map(() => 0);
    const ev: { t: number; d: number; v: number }[] = [];
    for (const b of plan.blocks) {
      if (b.start.kind === 'depot') ev.push({ t: b.start.time, d: b.start.depot, v: -1 });
      if (b.end.kind === 'depot') {
        const last = plan.trips[b.trips[b.trips.length - 1]];
        ev.push({ t: last.stops[last.stops.length - 1].arr + 300, d: b.end.depot, v: 1 });
      }
    }
    ev.sort((a, b) => a.t - b.t);
    const bal = topo.depots.map(() => 0);
    for (const e of ev) {
      bal[e.d] += e.v;
      stock[e.d] = Math.max(stock[e.d], -bal[e.d]);
    }
    const stabled = plan.blocks.filter((b) => b.start.kind === 'stable').length;
    let total = stock.reduce((a, b) => a + b, 0) + stabled;
    // distribute the remaining fleet as spares
    let i = 0;
    while (total < LINE_INFO.fleet) { stock[i % stock.length]++; total++; i++; }
    return stock;
  }

  // ------------------------------------------------------------ bookkeeping

  addTrain(tr: Train) {
    this.trains.set(tr.id, tr);
    this.trainList.push(tr);
    indexBodies(this);
  }

  removeTrain(tr: Train) {
    if (tr.trace.length) this.removedTraces.push({ train: tr.id, pts: tr.trace.splice(0) });
    this.trains.delete(tr.id);
    this.trainList = this.trainList.filter((x) => x.id !== tr.id);
    for (const [b, t] of this.berthRes) if (t === tr.id) this.berthRes.delete(b);
    for (const k of ['eb', 'comm', 'tf', 'tfr', 'spad']) this.clearAlarm(`${k}-${tr.id}`);
  }

  log(level: AlarmLevel, cat: string, text: string, opts: { key?: string; manual?: boolean } = {}) {
    if (opts.key && this.alarms.has(opts.key)) return;
    const ev: SimEvent = { id: this.nextEventId++, t: this.t, level, cat, text, manual: opts.manual };
    if (opts.key && level !== 'I') {
      ev.alarm = true;
      ev.key = opts.key;
      ev.ack = false;
      this.alarms.set(opts.key, ev);
      this.alarmsDirty = true;
    }
    this.events.push(ev);
    if (this.events.length > 20000) this.events.splice(0, 5000);
    this.newEvents.push(ev);
  }

  clearAlarm(key: string) {
    const a = this.alarms.get(key);
    if (!a) return;
    a.cleared = this.t;
    this.alarms.delete(key);
    this.alarmsDirty = true;
    this.newEvents.push({ id: this.nextEventId++, t: this.t, level: 'I', cat: a.cat, text: `【恢复】${a.text}` });
  }

  trainChain(tr: Train): number {
    return linkChain(this.topo, tr.link, tr.off);
  }

  /** goal berth used while a rescue train heads for a failed train */
  rescueGoal(_tr: Train): number {
    return -1;
  }

  onSignalPassed(tr: Train, sig: number) {
    signalPassed(this, tr.id, sig);
  }

  // ------------------------------------------------------------ stepping

  step(dt = FIXED_DT) {
    this.t += dt;
    indexBodies(this);
    for (const tr of this.trainList) updateTrainMotion(this, tr, dt);
    indexBodies(this);
    computeOccupancy(this);
    updateInterlocking(this);
    for (const tr of this.trainList.slice()) updateTrainTasks(this, tr);
    this.stepsThisSecond++;
    this.secAcc += dt;
    if (this.secAcc >= 1 - 1e-9) {
      const acc = this.secAcc;
      this.secAcc = 0;
      this.secondTick(acc);
    }
  }

  private secondTick(dt: number) {
    spawnDue(this);
    updateLevels(this);
    driverRM(this);
    runARS(this);
    passengersTick(this, dt);
    faultsTick(this);
    for (const tr of this.trainList) {
      recordTrace(this, tr);
      this.trackDelay(tr);
    }
    // axle alarms clear after successful reset & sweep
    for (const [key] of this.alarms) {
      if (key.startsWith('axle-')) {
        const s = Number(key.slice(5));
        if (!this.sec[s].disturbed && !this.sec[s].preset) this.clearAlarm(key);
      }
    }
  }

  private trackDelay(tr: Train) {
    const t = tr.tasks[0];
    if (!t || t.k !== 'stop' || tr.phase !== 'run' || !tr.inService) return;
    if (t.arr !== null && this.t > t.arr + 0) tr.delay = Math.max(tr.delay, this.t - t.arr);
    const key = `late-${tr.id}`;
    if (tr.delay > 300 && !this.alarms.has(key)) this.log('C', '运营', `列车 ${trainLabel(tr)} 晚点 ${Math.round(tr.delay / 60)} 分钟`, { key });
    else if (tr.delay < 120 && this.alarms.has(key)) this.clearAlarm(key);
  }

  /** called on each departure for punctuality statistics */
  depLog: { t: number; st: number; trip: number; delay: number }[] = [];
  noteDeparture(task: StopTask) {
    if (task.dep === null || task.trip < 0) return;
    this.depTotal++;
    if (this.t - task.dep <= 120) this.depOnTime++;
    if (this.depLog.length < 50000) this.depLog.push({ t: this.t, st: task.station, trip: task.trip, delay: this.t - task.dep });
  }

  // ------------------------------------------------------------ commands

  command(cmd: Command): CmdResult {
    const r = this.execCommand(cmd);
    const text = describeCommand(this, cmd);
    this.log(r.ok ? 'I' : 'C', '调度', `${text}：${r.msg}`, { manual: true });
    return r;
  }

  private execCommand(cmd: Command): CmdResult {
    const { topo } = this;
    switch (cmd.c) {
      case 'setRoute': {
        const res = trySetRoute(this, cmd.route, { manual: true });
        return res;
      }
      case 'cancelRoute': {
        const sg = this.sig[cmd.signal];
        if (sg.route >= 0) this.routes.get(sg.route)!.fleeting = false;
        return cancelRoute(this, cmd.signal, { manual: true });
      }
      case 'guideRoute':
        return trySetRoute(this, cmd.route, { manual: true, guide: true });
      case 'autoPass': {
        const sg = this.sig[cmd.signal];
        sg.autoPass = cmd.on;
        if (!cmd.on && sg.route >= 0) {
          const ar = this.routes.get(sg.route)!;
          if (ar.fleeting) { ar.fleeting = false; cancelRoute(this, cmd.signal); }
        }
        return { ok: true, msg: `${topo.signals[cmd.signal].name} 自动通过${cmd.on ? '开启' : '关闭'}` };
      }
      case 'ars':
        this.sig[cmd.signal].ars = cmd.on;
        return { ok: true, msg: `${topo.signals[cmd.signal].name} ${cmd.on ? '恢复自动排列进路' : '改为人工排列进路'}` };
      case 'switchMove':
        return moveSwitch(this, cmd.sw, cmd.pos);
      case 'switchLock':
        this.sw[cmd.sw].singleLock = cmd.on;
        return { ok: true, msg: `道岔 ${topo.switches[cmd.sw].name} ${cmd.on ? '单锁' : '单解'}` };
      case 'switchFieldLock': {
        const s = this.sw[cmd.sw];
        if (cmd.on && !s.failed) return { ok: false, msg: '道岔表示正常，无需钩锁' };
        s.fieldLock = cmd.on;
        return { ok: true, msg: `道岔 ${topo.switches[cmd.sw].name} ${cmd.on ? `现场钩锁于${s.pos === 'N' ? '定位' : '反位'}（可办理引导进路通过）` : '取消钩锁'}` };
      }
      case 'axleReset': {
        const s = this.sec[cmd.section];
        if (!s.disturbed) return { ok: false, msg: '区段未处于故障占用状态' };
        const f = this.faults.find((x) => x.kind === 'axle' && x.target === cmd.section && !x.repaired);
        if (f && this.t < f.repairAt) return { ok: false, msg: '计轴复位失败（设备故障未排除）' };
        if (s.trainOcc) return { ok: false, msg: '区段内有列车，不能复位' };
        s.disturbed = false;
        s.preset = true;
        s.presetSeen = false;
        return { ok: true, msg: `区段 ${topo.sections[cmd.section].name} 预复位成功，首列车以RM模式压道后出清` };
      }
      case 'sectionUnlock':
        return sectionUnlock(this, cmd.section);
      case 'setTsr': {
        if (cmd.kmh < 5 || cmd.kmh > 75) return { ok: false, msg: '限速值须在 5–75 km/h' };
        for (const s of cmd.sections) this.sec[s].tsr = cmd.kmh;
        this.log('B', '调度', `设置临时限速 ${cmd.kmh}km/h：${cmd.sections.map((s) => topo.sections[s].name).join('、')}`, { key: `tsr-${cmd.sections[0]}` });
        return { ok: true, msg: `临时限速 ${cmd.kmh}km/h 已生效（${cmd.sections.length} 个区段）` };
      }
      case 'cancelTsr': {
        for (const s of cmd.sections) {
          this.sec[s].tsr = 0;
          this.clearAlarm(`tsr-${s}`);
        }
        return { ok: true, msg: '临时限速已取消' };
      }
      case 'platformHold':
        this.plat[cmd.platform].hold = cmd.on;
        return { ok: true, msg: `${topo.platforms[cmd.platform].name} ${cmd.on ? '扣车' : '取消扣车'}` };
      case 'platformSkip':
        this.plat[cmd.platform].skip = cmd.on;
        return { ok: true, msg: `${topo.platforms[cmd.platform].name} ${cmd.on ? '跳停' : '取消跳停'}` };
      case 'platformEsp': {
        this.plat[cmd.platform].esp = cmd.on;
        if (cmd.on) this.log('A', '车站', `${topo.platforms[cmd.platform].name} 紧急关闭`, { key: `esp-${cmd.platform}` });
        else this.clearAlarm(`esp-${cmd.platform}`);
        return { ok: true, msg: `${topo.platforms[cmd.platform].name} ${cmd.on ? '紧急关闭' : '取消紧急关闭'}` };
      }
      case 'psdBypass': {
        const p = this.plat[cmd.platform];
        p.psdBypass = cmd.on;
        if (cmd.on) this.clearAlarm(`psd-${cmd.platform}`);
        return { ok: true, msg: `${topo.platforms[cmd.platform].name} 站台门互锁${cmd.on ? '解除' : '恢复'}` };
      }
      case 'trainHold': return this.withTrain(cmd.train, (tr) => cmdTrainHold(this, tr, cmd.on));
      case 'trainSkip': return this.withTrain(cmd.train, (tr) => cmdSkip(this, tr, cmd.station, cmd.on));
      case 'turnback': return this.withTrain(cmd.train, (tr) => cmdTurnback(this, tr, cmd.station));
      case 'withdraw': return this.withTrain(cmd.train, (tr) => cmdWithdraw(this, tr));
      case 'authRM': return this.withTrain(cmd.train, (tr) => cmdAuthRM(this, tr));
      case 'rescue': {
        const f = this.trains.get(cmd.failed);
        const r = this.trains.get(cmd.rescuer);
        if (!f || !r) return { ok: false, msg: '列车不存在' };
        return cmdRescue(this, f, r);
      }
      case 'addTrain': {
        if (cmd.time < this.t + 120) return { ok: false, msg: '出段时刻须晚于当前时刻2分钟以上' };
        const b = addExtraTrain(this.planCtx, this.plan, cmd.depot, cmd.dir, cmd.to, cmd.time);
        if (typeof b === 'string') return { ok: false, msg: b };
        this.depotStock[cmd.depot] = Math.max(this.depotStock[cmd.depot], 1);
        this.planDirty = true;
        return { ok: true, msg: `加开列车 表号${b.svc}：${topo.depots[cmd.depot].name} 出段 → ${STATIONS[cmd.to].name} 折返 → 回段` };
      }
      case 'overlay': {
        const p = OVERLAY_PRESETS.find((x) => x.id === cmd.id);
        if (!p) return { ok: false, msg: '无此加开模板' };
        if (cmd.from < this.t + 600) return { ok: false, msg: '加开开始时刻须晚于当前时刻10分钟以上' };
        const r = applyOverlay(this.planCtx, this.plan, { ...p, from: cmd.from, to: cmd.to, headway: cmd.headway });
        for (let i = 0; i < this.depotStock.length; i++) this.depotStock[i] += 0;
        this.planDirty = true;
        return { ok: true, msg: `${p.label}：新增 ${r.trips} 个车次、${r.blocks} 列车底` };
      }
      case 'zoneLevel': {
        const names: string[] = [];
        for (const z of cmd.zones) {
          const cur = this.zoneState[z];
          if (cmd.level === 'TBTC') {
            this.zoneState[z] = 'TBTC';
            names.push(topo.zones[z].key);
          } else {
            const f = this.faults.find((x) => x.kind === 'zcFail' && (x.target === z || x.target < 0) && !x.repaired);
            if (f) return { ok: false, msg: `${topo.zones[z].name} ZC 故障未修复，不能恢复CBTC` };
            if (cur !== 'CBTC') { this.zoneState[z] = 'CBTC'; names.push(topo.zones[z].key); }
          }
        }
        if (cmd.level === 'TBTC') {
          // trains inside switch level after the driver confirms
          for (const tr of this.trainList) {
            if (cmd.zones.includes(topo.links[tr.link].zone) && tr.level === 'CBTC') {
              tr.pendingLevel = 'TBTC';
              tr.pendingMode = tr.comm ? 'AM' : 'CM';
              tr.pendingModeAt = this.t + (tr.v < 0.1 ? 20 : 0);
              tr.eb = false;
            }
          }
        }
        return { ok: true, msg: `${names.join('、') || '所选区域'} 切换至 ${cmd.level}` };
      }
      case 'ack': {
        for (const a of this.alarms.values()) if (cmd.ids.includes(a.id)) a.ack = true;
        this.alarmsDirty = true;
        return { ok: true, msg: `确认报警 ${cmd.ids.length} 条` };
      }
      case 'fault': return injectFault(this, cmd.kind, cmd.target, cmd.duration, cmd.param, cmd.recoverable);
      case 'repair': return repairFault(this, cmd.fault);
    }
  }

  private withTrain(id: number, fn: (tr: Train) => CmdResult): CmdResult {
    const tr = this.trains.get(id);
    if (!tr) return { ok: false, msg: '列车不存在' };
    return fn(tr);
  }

  // ------------------------------------------------------------ snapshot

  snapshot(): Snapshot {
    const { topo } = this;
    const sections = new Uint8Array(this.sec.length);
    const sectionTsr = new Uint8Array(this.sec.length);
    this.sec.forEach((s, i) => {
      let f = 0;
      if (s.occ) f |= SEC.OCC;
      if (s.commOnly) f |= SEC.COMM;
      if (s.lockRoute >= 0) {
        f |= SEC.LOCK;
        if (this.routes.get(s.lockRoute)?.fleeting) f |= SEC.ROUTEFLEET;
      }
      if (s.disturbed) f |= SEC.DIST;
      if (s.preset) f |= SEC.PRESET;
      if (s.tsr > 0) f |= SEC.TSR;
      if (s.trainOcc) f |= SEC.TRAIN;
      sections[i] = f;
      sectionTsr[i] = s.tsr;
    });
    const switches = new Uint8Array(this.sw.length);
    this.sw.forEach((s, i) => {
      let f = 0;
      if (s.pos === 'R') f |= SW.R;
      if (s.pos !== s.target || this.t < s.moveUntil) f |= SW.MOVING;
      if (s.failed) f |= SW.FAILED;
      if (s.lockCount > 0) f |= SW.LOCKED;
      if (s.singleLock) f |= SW.SINGLE;
      if (s.fieldLock) f |= SW.FIELD;
      if (s.target === 'R') f |= SW.TARGET_R;
      switches[i] = f;
    });
    const signals = new Uint8Array(this.sig.length);
    this.sig.forEach((s, i) => {
      let f = SIG_ASPECT.indexOf(s.aspect);
      if (s.route >= 0) {
        f |= SIGF.ROUTE;
        if (this.routes.get(s.route)?.manual) f |= SIGF.MANUAL;
      }
      if (!s.ars) f |= SIGF.ARSOFF;
      if (s.autoPass) f |= SIGF.AUTOPASS;
      if (s.failed) f |= SIGF.FAILED;
      signals[i] = f;
    });
    const platforms = new Uint8Array(this.plat.length);
    const platformWaiting = new Uint16Array(this.plat.length);
    this.plat.forEach((p, i) => {
      let f = 0;
      if (p.hold) f |= PLT.HOLD;
      if (p.skip) f |= PLT.SKIP;
      if (p.esp) f |= PLT.ESP;
      if (p.psd === 'open') f |= PLT.PSDOPEN;
      if (p.psdFault) f |= PLT.PSDFAULT;
      if (p.psdBypass) f |= PLT.BYPASS;
      if (p.surge > 1) f |= PLT.SURGE;
      platforms[i] = f;
      platformWaiting[i] = Math.min(65535, Math.round(p.waiting));
    });
    for (const tr of this.trainList) {
      const sp = topo.links[tr.link].platform;
      if (sp >= 0 && tr.phase === 'dwell') platforms[sp] |= PLT.TRAIN;
    }
    const trains: TrainSnap[] = this.trainList.map((tr) => {
      const body: number[] = [];
      for (const b of tr.body) body.push(b.link, b.from, b.to);
      const t0 = tr.tasks[0];
      return {
        id: tr.id, vehicle: tr.vehicle, svc: tr.svc, trip: tr.tripNo, dest: tr.destText, link: tr.link, off: tr.off, dir: tr.dir,
        body, v: tr.v, level: tr.level, comm: tr.comm, mode: tr.mode, eb: tr.eb, phase: tr.phase, delay: tr.delay,
        load: tr.load, hold: tr.hold, failed: tr.failed, doors: tr.doorsOpen, inService: tr.inService, chain: this.trainChain(tr),
        maReason: tr.maReason, maDist: tr.maDist, vPermit: tr.vPermit, nextSig: tr.nextSignal,
        task: t0 ? describeTask(this, t0) : '—', kind: tr.tripId >= 0 ? this.plan.trips[tr.tripId].kind : '',
        rm: tr.mode === 'RM',
      };
    });
    const traces: { train: number; pts: number[] }[] = this.removedTraces.splice(0);
    for (const tr of this.trainList) if (tr.trace.length) traces.push({ train: tr.id, pts: tr.trace.splice(0) });
    const late = this.trainList.filter((t) => t.inService && t.delay > 120).length;
    const maxDelay = this.trainList.reduce((m, t) => (t.inService ? Math.max(m, t.delay) : m), 0);
    const tripsPlanned = this.plan.trips.filter((t) => t.revenue && !t.cancelled).length;
    return {
      t: this.t, speed: this.speed, paused: this.paused, dayType: this.plan.dayType, dateLabel: this.config.dateLabel,
      sections, sectionTsr, switches, signals, platforms, platformWaiting, zones: this.zoneState.slice(), trains,
      depotCounts: this.depotStock.slice(), traces,
      stats: {
        online: this.trainList.length, inService: this.trainList.filter((t) => t.inService).length, late, maxDelay,
        punctuality: this.depTotal ? this.depOnTime / this.depTotal : 1, tripsDone: this.tripsDone, tripsPlanned,
        passengers: this.passengersServed, stepsPerSec: this.stepsPerSec,
      },
      activeRoutes: Array.from(this.routes.keys()),
      faults: this.faults.filter((f) => !f.repaired || this.t - f.repairAt < 600),
    };
  }
}

export function describeTask(sim: Sim, t: import('./model').Task): string {
  switch (t.k) {
    case 'stop': return `${t.note ?? (t.doors ? '停站' : '停车')} ${STATIONS[t.station].name}`;
    case 'reverse': return `折返 ${sim.topo.berths[t.chosen].name}`;
    case 'depot': return `回 ${sim.topo.depots[t.depot].name}`;
    case 'stable': return `存车 ${t.berth >= 0 ? sim.topo.berths[t.berth].name : ''}`;
    case 'rescue': return '救援连挂';
  }
}

export function describeCommand(sim: Sim, cmd: Command): string {
  const { topo } = sim;
  const tn = (id: number) => { const t = sim.trains.get(id); return t ? `列车 ${t.svc}-${t.tripNo}` : `列车#${id}`; };
  switch (cmd.c) {
    case 'setRoute': return `办理进路 ${topo.routes[cmd.route].name}`;
    case 'cancelRoute': return `取消进路 ${topo.signals[cmd.signal].name}`;
    case 'guideRoute': return `引导进路 ${topo.routes[cmd.route].name}`;
    case 'autoPass': return `自动通过 ${topo.signals[cmd.signal].name}`;
    case 'ars': return `自动排列 ${topo.signals[cmd.signal].name}`;
    case 'switchMove': return `道岔单操 ${topo.switches[cmd.sw].name}→${cmd.pos === 'N' ? '定位' : '反位'}`;
    case 'switchLock': return `道岔${cmd.on ? '单锁' : '单解'} ${topo.switches[cmd.sw].name}`;
    case 'switchFieldLock': return `道岔${cmd.on ? '钩锁确认' : '取消钩锁'} ${topo.switches[cmd.sw].name}`;
    case 'axleReset': return `计轴预复位 ${topo.sections[cmd.section].name}`;
    case 'sectionUnlock': return `区段故障解锁 ${topo.sections[cmd.section].name}`;
    case 'setTsr': return `设置临时限速 ${cmd.kmh}km/h`;
    case 'cancelTsr': return '取消临时限速';
    case 'platformHold': return `${cmd.on ? '扣车' : '取消扣车'} ${topo.platforms[cmd.platform].name}`;
    case 'platformSkip': return `${cmd.on ? '跳停' : '取消跳停'} ${topo.platforms[cmd.platform].name}`;
    case 'platformEsp': return `${cmd.on ? '紧急关闭' : '取消紧急关闭'} ${topo.platforms[cmd.platform].name}`;
    case 'psdBypass': return `站台门互锁${cmd.on ? '解除' : '恢复'} ${topo.platforms[cmd.platform].name}`;
    case 'trainHold': return `${cmd.on ? '扣车' : '放行'} ${tn(cmd.train)}`;
    case 'trainSkip': return `跳停 ${tn(cmd.train)} ${STATIONS[cmd.station].name}`;
    case 'turnback': return `人工折返 ${tn(cmd.train)} @${STATIONS[cmd.station].name}`;
    case 'withdraw': return `退出服务 ${tn(cmd.train)}`;
    case 'authRM': return `授权RM ${tn(cmd.train)}`;
    case 'rescue': return `组织救援 ${tn(cmd.rescuer)}→${tn(cmd.failed)}`;
    case 'addTrain': return `加开列车 ${topo.depots[cmd.depot].short}`;
    case 'overlay': return '加开运行图';
    case 'zoneLevel': return `系统切换 ${cmd.zones.map((z) => topo.zones[z].key).join('/')} → ${cmd.level}`;
    case 'ack': return '报警确认';
    case 'fault': return `【教员】注入故障 ${FAULT_LABELS[cmd.kind]}`;
    case 'repair': return '【教员】故障修复';
  }
}

export type { DayType };
