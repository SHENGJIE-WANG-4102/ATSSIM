/**
 * Fault injection (教员台) and maintenance completion.
 */
import type { Sim } from './engine';
import type { Fault, FaultKind, Command } from './model';
import { STATIONS } from '../data/line2';
import { cancelRoute, committedTrain } from './interlocking';
import { withdrawAuthority } from './movement';
import { failTrain, recoverTrain, trainLabel } from './ats';
import { callRescue, callPecu, callTrackPerson } from './radio';
import { psdRepaired } from './psd';
import { allowed, FAULT } from './fsm';

function stage(sim: Sim, fault: Fault, next: Fault['stage']) {
  if (!allowed(sim, FAULT, fault.stage, next).ok) return;
  fault.stage = next;
  fault.stageAt = sim.t;
}

/** Dispatcher procedures change only the faults they address. */
export function faultProcedure(sim: Sim, cmd: Command) {
  for (const f of sim.faults) {
    if (f.repaired || f.stage !== 'effect') continue;
    const train = sim.trains.get(f.target);
    const addressed = (cmd.c === 'zoneLevel' && f.kind === 'zcFail' && (f.target < 0 || cmd.zones.includes(f.target)))
      || (cmd.c === 'switchFieldLock' && f.kind === 'switch' && cmd.sw === f.target)
      || (cmd.c === 'psdBypass' && f.kind === 'psd' && cmd.platform === f.target)
      || (cmd.c === 'rescue' && f.kind === 'trainFail' && cmd.failed === f.target)
      || (cmd.c === 'axleReset' && f.kind === 'axle' && cmd.section === f.target)
      || (cmd.c === 'authRM' && (f.kind === 'signal' && cmd.signal === f.target || train?.id === cmd.train && f.kind === 'trainComm'))
      || (cmd.c === 'radio' && sim.calls.some(c => c.id === cmd.call && c.train === train?.id && ['degrade', 'ebRelease', 'rescue'].includes(c.kind)));
    if (addressed) stage(sim, f, 'procedure');
  }
}

function recovered(sim: Sim, f: Fault): boolean {
  if (!f.repaired) return false;
  if (f.kind === 'axle') return !sim.sec[f.target].disturbed && !sim.sec[f.target].preset;
  if (f.kind === 'switch') return !sim.sw[f.target].failed;
  if (f.kind === 'zcFail') {
    const zones = f.target < 0 ? sim.zoneState.map((_, z) => z) : [f.target];
    return zones.every(z => sim.zoneState[z] === 'CBTC' && sim.trainList.every(tr => sim.topo.links[tr.link].zone !== z || tr.forceLevel === 'TBTC' || tr.manual || tr.phase === 'stabled' || tr.level === 'CBTC' && !tr.eb));
  }
  if (f.kind === 'trainComm') { const tr = sim.trains.get(f.target); return !tr || tr.comm && !tr.eb && (tr.level === 'CBTC' || tr.forceLevel === 'TBTC' || tr.manual); }
  return true;
}

/** Called after the equipment tick; repaired and recovered are distinct states. */
export function updateFaultLifecycle(sim: Sim) {
  for (const f of sim.faults) {
    if (f.repaired && (f.stage === 'effect' || f.stage === 'procedure')) stage(sim, f, 'recovery');
    if (f.stage === 'recovery' && recovered(sim, f)) stage(sim, f, 'closed');
  }
}

export const FAULT_LABELS: Record<FaultKind, string> = {
  trainComm: '列车车地通信中断',
  zcFail: '区域控制器(ZC)故障',
  axle: '计轴区段故障占用',
  switch: '道岔失表',
  signal: '信号机故障',
  psd: '站台门故障',
  psdLink: '站台门与信号联动故障',
  trainFail: '列车故障',
  surge: '车站大客流',
  pecu: '车厢乘客紧急报警',
  trackPerson: '人员侵入轨道',
};

export function injectFault(sim: Sim, kind: FaultKind, target: number, duration: number, param?: number, recoverable?: boolean): { ok: boolean; msg: string } {
  const { topo } = sim;
  const repairAt = duration > 0 ? sim.t + duration : Infinity;
  const f: Fault = { id: sim.nextFaultId++, kind, target, since: sim.t, repairAt, repaired: false, text: '', param, recoverable, stage: 'effect', stageAt: sim.t };
  sim.metrics.faults++;
  switch (kind) {
    case 'pecu': {
      const tr = sim.trains.get(target);
      if (!tr) return { ok: false, msg: '列车不存在' };
      callPecu(sim, tr);
      return { ok: true, msg: `已触发：列车 ${trainLabel(tr)} 乘客紧急报警（司机将呼叫调度）` };
    }
    case 'trackPerson': {
      if (!topo.platforms[target]) return { ok: false, msg: '站台不存在' };
      callTrackPerson(sim, target);
      return { ok: true, msg: `已触发：${topo.platforms[target].name} 人员侵入轨道（车站将呼叫调度）` };
    }
    case 'trainComm': {
      const tr = sim.trains.get(target);
      if (!tr) return { ok: false, msg: '列车不存在' };
      tr.comm = false;
      f.text = `列车 ${trainLabel(tr)}（${tr.vehicle}）车地通信中断`;
      sim.log('A', '信号', `${f.text}，ZC失去列车位置，以区段占用防护`, { key: `comm-${tr.id}` });
      break;
    }
    case 'zcFail': {
      const zones = target < 0 ? topo.zones.map((z) => z.id) : [target];
      for (const z of zones) sim.zoneState[z] = 'ZCFAIL';
      f.text = target < 0 ? 'DCS/ZC 全线故障' : `${topo.zones[target].name} 区域控制器故障`;
      sim.log('A', '信号', `${f.text}：区域内CBTC列车失去移动授权，需切换至TBTC后备系统`, { key: `zc-${target}` });
      break;
    }
    case 'axle': {
      const s = sim.sec[target];
      s.disturbed = true;
      s.preset = false;
      f.text = `计轴区段 ${topo.sections[target].name} 故障占用`;
      sim.log('B', '信号', `${f.text}（${STATIONS[topo.sections[target].station].name}）`, { key: `axle-${target}` });
      break;
    }
    case 'switch': {
      const s = sim.sw[target];
      s.failed = true;
      s.fieldLock = false;
      // the interlocking reports the lost detection: the ZC pulls every MA back before the switch
      for (const tr of sim.trainList) withdrawAuthority(sim, tr);
      f.text = `道岔 ${topo.switches[target].name} 失去表示`;
      sim.log('A', '信号', `${f.text}（${STATIONS[topo.switches[target].station].name}）`, { key: `sw-${target}` });
      break;
    }
    case 'signal': {
      const s = sim.sig[target];
      const committed = committedTrain(sim, target);
      s.failed = true;
      // the signal drops to danger; its route is cancelled as by the desk (approach locking
      // holds it for a train that can no longer stop, an occupied route stays until cleared)
      if (s.route >= 0) {
        // Occupancy may prohibit cancellation before cancelRoute reaches its
        // approach-locking branch. Keep the already issued MA in that case too.
        if (committed >= 0) sim.routes.get(s.route)!.committed = committed;
        cancelRoute(sim, target);
      }
      // the ZC takes the failure into the next MA at once (not a ZC cycle later)
      for (const tr of sim.trainList) withdrawAuthority(sim, tr);
      f.text = `信号机 ${topo.signals[target].name} 故障（无法开放）`;
      sim.log('B', '信号', `${f.text}（${STATIONS[topo.signals[target].station].name}）`, { key: `sig-${target}` });
      break;
    }
    case 'psd': {
      const p = sim.plat[target];
      p.psdFault = true;
      f.text = `${topo.platforms[target].name} 站台门故障`;
      sim.log('C', '车站', `${f.text}（下一次关门时无法关闭锁紧）`);
      break;
    }
    case 'psdLink': {
      const p = sim.plat[target];
      p.psdLinkFault = true;
      f.text = `${topo.platforms[target].name} 站台门与信号联动故障`;
      sim.log('B', '车站', `${f.text}：车门与站台门不能联动，由车站人员在PSL操作站台门`, { key: `psdl-${target}` });
      break;
    }
    case 'trainFail': {
      const tr = sim.trains.get(target);
      if (!tr) return { ok: false, msg: '列车不存在' };
      const rec = recoverable ?? false;
      failTrain(sim, tr, rec, rec ? Math.min(duration || 240, 600) : Infinity);
      f.repairAt = rec ? tr.failRecoverAt : Infinity;
      f.text = `列车 ${trainLabel(tr)}（${tr.vehicle}）故障停车`;
      sim.log('A', '列车', `${f.text}，司机处置中${rec ? '' : '（无法自行恢复，需组织救援）'}`, { key: `tf-${tr.id}` });
      break;
    }
    case 'surge': {
      const st = topo.stations[target];
      const m = param ?? 4;
      sim.plat[st.platforms.DN].surge = m;
      sim.plat[st.platforms.UP].surge = m;
      f.text = `${st.name} 大客流（进站客流 ×${m}）`;
      sim.log('B', '客流', f.text, { key: `surge-${target}` });
      break;
    }
  }
  sim.faults.push(f);
  return { ok: true, msg: `已注入故障：${f.text}` };
}

export function repairFault(sim: Sim, id: number): { ok: boolean; msg: string } {
  const f = sim.faults.find((x) => x.id === id);
  if (!f) return { ok: false, msg: '故障不存在' };
  if (f.repaired) return { ok: false, msg: '故障已修复' };
  f.repairAt = sim.t;
  faultsTick(sim);
  return { ok: true, msg: `现场处置完成：${f.text}` };
}

export function faultsTick(sim: Sim) {
  const { topo } = sim;
  for (const f of sim.faults) {
    if (f.repaired) continue;
    if (f.kind === 'trainFail') {
      const tr = sim.trains.get(f.target);
      if (!tr) { f.repaired = true; continue; }
      if (tr.failRecoverable && sim.t >= tr.failRecoverAt) {
        recoverTrain(sim, tr);
        f.repaired = true;
        sim.clearAlarm(`tf-${tr.id}`);
      } else if (!tr.failRecoverable && sim.t - f.since > 240 && !sim.alarms.has(`tfr-${tr.id}`) && tr.rescueBy < 0) {
        sim.log('A', '列车', `列车 ${trainLabel(tr)} 故障无法排除，请求救援（选择故障列车→“组织救援”）`, { key: `tfr-${tr.id}` });
        callRescue(sim, tr);
      }
      if (sim.t >= f.repairAt && f.repairAt !== Infinity && tr.failed) {
        recoverTrain(sim, tr);
        f.repaired = true;
        sim.clearAlarm(`tf-${tr.id}`);
        sim.clearAlarm(`tfr-${tr.id}`);
      }
      continue;
    }
    if (sim.t < f.repairAt) continue;
    f.repaired = true;
    switch (f.kind) {
      case 'trainComm': {
        const tr = sim.trains.get(f.target);
        if (tr) {
          tr.comm = true;
          sim.log('C', '信号', `列车 ${trainLabel(tr)} 车地通信恢复，将升级至CBTC`);
        }
        sim.clearAlarm(`comm-${f.target}`);
        break;
      }
      case 'zcFail': {
        const zones = f.target < 0 ? topo.zones.map((z) => z.id) : [f.target];
        for (const z of zones) if (sim.zoneState[z] === 'ZCFAIL') sim.zoneState[z] = 'CBTC';
        sim.clearAlarm(`zc-${f.target}`);
        sim.log('C', '信号', `${f.text} 已修复${zones.some((z) => sim.zoneState[z] === 'TBTC') ? '，TBTC区域可由调度命令恢复CBTC' : '，ZC重启完成'}`);
        break;
      }
      case 'axle':
        sim.log('C', '信号', `${f.text}：现场设备已修复，可执行“计轴预复位”`);
        break;
      case 'switch':
        sim.log('C', '信号', `${f.text}：现场维修完毕，请单操道岔恢复表示`);
        break;
      case 'signal':
        sim.sig[f.target].failed = false;
        sim.clearAlarm(`sig-${f.target}`);
        sim.log('C', '信号', `${f.text} 已修复`);
        break;
      case 'psd': {
        const p = sim.plat[f.target];
        psdRepaired(sim, f.target);
        sim.log('C', '车站', `${f.text} 已修复${p.psdBypass ? '，请取消互锁解除' : ''}`);
        break;
      }
      case 'psdLink':
        sim.plat[f.target].psdLinkFault = false;
        sim.clearAlarm(`psdl-${f.target}`);
        sim.log('C', '车站', `${f.text} 已修复，站台门恢复联动`);
        break;
      case 'surge': {
        const st = topo.stations[f.target];
        sim.plat[st.platforms.DN].surge = 1;
        sim.plat[st.platforms.UP].surge = 1;
        sim.clearAlarm(`surge-${f.target}`);
        sim.log('C', '客流', `${st.name} 大客流结束`);
        break;
      }
    }
  }
}
