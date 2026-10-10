/**
 * Fault injection (教员台) and maintenance completion.
 */
import type { Sim } from './engine';
import type { Fault, FaultKind } from './model';
import { STATIONS } from '../data/line2';
import { cancelRoute } from './interlocking';
import { failTrain, recoverTrain, trainLabel } from './ats';

export const FAULT_LABELS: Record<FaultKind, string> = {
  trainComm: '列车车地通信中断',
  zcFail: '区域控制器(ZC)故障',
  axle: '计轴区段故障占用',
  switch: '道岔失表',
  signal: '信号机故障',
  psd: '站台门故障',
  trainFail: '列车故障',
  surge: '车站大客流',
};

export function injectFault(sim: Sim, kind: FaultKind, target: number, duration: number, param?: number, recoverable?: boolean): { ok: boolean; msg: string } {
  const { topo } = sim;
  const repairAt = duration > 0 ? sim.t + duration : Infinity;
  const f: Fault = { id: sim.nextFaultId++, kind, target, since: sim.t, repairAt, repaired: false, text: '', param, recoverable };
  switch (kind) {
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
      f.text = `道岔 ${topo.switches[target].name} 失去表示`;
      sim.log('A', '信号', `${f.text}（${STATIONS[topo.switches[target].station].name}）`, { key: `sw-${target}` });
      break;
    }
    case 'signal': {
      const s = sim.sig[target];
      s.failed = true;
      if (s.route >= 0) cancelRoute(sim, target, { force: true });
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
      } else if (!tr.failRecoverable && sim.t - f.since > 240 && !sim.alarms.has(`tfr-${tr.id}`)) {
        sim.log('A', '列车', `列车 ${trainLabel(tr)} 故障无法排除，请求救援（选择故障列车→“组织救援”）`, { key: `tfr-${tr.id}` });
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
        p.psdFault = false;
        if (p.psd === 'fault') p.psd = 'closed';
        sim.clearAlarm(`psd-${f.target}`);
        sim.log('C', '车站', `${f.text} 已修复${p.psdBypass ? '，请取消互锁解除' : ''}`);
        break;
      }
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
