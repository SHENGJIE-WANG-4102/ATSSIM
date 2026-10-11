/**
 * Cab DMI model: per-train message log (driven by state changes, same wording
 * as the Casco DMI message log) and the data block the DMI view needs beyond
 * the regular train snapshot.
 */
import type { Sim } from './engine';
import type { DmiData, DmiMsg, Level, Mode, Train } from './model';
import { STATIONS, fleetEntry } from '../data/line2';
import { stopError } from './movement';
import { cbtcAvailable } from './onboard';

const LOG_MAX = 40;

/** highest mode the on-board equipment could offer right now (the "AM-C" field) */
export function availableMode(sim: Sim, tr: Train): { mode: Mode; level: Level } {
  // CBTC (DTO) needs the radio link and a ZC in control; the TBTC backup
  // (digital track circuits, continuous) runs in parallel and offers ATO (P2 §2.1.1)
  if (cbtcAvailable(sim, tr)) return { mode: 'DTO', level: 'CBTC' };
  return { mode: 'AM', level: 'TBTC' };
}

/** on-screen wording of the driving mode */
export function modeWord(m: Mode): string {
  return m;
}

export function dmiNote(sim: Sim, tr: Train, m: string, k: DmiMsg['k'] = 'info') {
  tr.dmiLog.push({ t: sim.t, m, k });
  if (tr.dmiLog.length > LOG_MAX) tr.dmiLog.splice(0, tr.dmiLog.length - LOG_MAX);
}

const availMsg = (a: { mode: Mode; level: Level }) =>
  a.mode === 'DTO' ? 'DTO/ATP模式可用' : a.mode === 'AM' ? 'TBTC ATO/ATP模式可用' : a.mode === 'CM' ? 'CM模式可用' : '仅RM模式可用';

/** once a second: turn state changes into DMI messages */
export function dmiTick(sim: Sim) {
  for (const tr of sim.trainList) {
    const av = availableMode(sim, tr);
    const cur = {
      avail: `${av.mode}-${av.level}`, comm: tr.comm, mode: `${tr.mode}-${tr.level}`, eb: tr.eb, hold: tr.hold,
      stop: tr.stopUntil > sim.t, failed: tr.failed, over: tr.v > tr.vPermit + 0.3 && !tr.eb,
    };
    const p = tr.dmiPrev;
    tr.dmiPrev = cur;
    if (!p) {
      dmiNote(sim, tr, 'DMI激活');
      dmiNote(sim, tr, availMsg(av));
      continue;
    }
    if (p.comm && !cur.comm) dmiNote(sim, tr, '连接丢失', 'warn');
    if (!p.comm && cur.comm) dmiNote(sim, tr, '连接恢复');
    if (p.avail !== cur.avail) {
      // supervision regained after a period with only RM available: FAM-photo wording
      const regained = p.avail.startsWith('RM') && av.mode !== 'RM';
      dmiNote(sim, tr, regained ? 'CM/AM模式可用' : availMsg(av), av.mode === 'RM' ? 'warn' : 'info');
    }
    if (p.mode !== cur.mode) dmiNote(sim, tr, `${modeWord(tr.mode)} ${tr.level}模式`, tr.mode === 'RM' ? 'warn' : 'info');
    if (!p.eb && cur.eb) dmiNote(sim, tr, `紧急制动 ${tr.ebReason}`, 'alarm');
    if (p.eb && !cur.eb) dmiNote(sim, tr, '紧急制动缓解');
    if (!p.over && cur.over) dmiNote(sim, tr, '超速报警', 'warn');
    if (!p.hold && cur.hold) dmiNote(sim, tr, '扣车', 'warn');
    if (p.hold && !cur.hold) dmiNote(sim, tr, '扣车取消');
    if (!p.stop && cur.stop) dmiNote(sim, tr, `区间停车 ${tr.stopReason}`, 'warn');
    if (!p.failed && cur.failed) dmiNote(sim, tr, '列车故障', 'alarm');
  }
}

/** "T" + four digits as shown on the DMI: 0213 → T2013, 02086 → T2086 */
export function dmiTrainNo(vehicle: string): string {
  const five = vehicle.length === 4 ? `${vehicle.slice(0, 2)}0${vehicle.slice(2)}` : vehicle;
  return `T${five.slice(-4)}`;
}

export function computeDmi(sim: Sim, id: number): DmiData | null {
  const tr = sim.trains.get(id);
  if (!tr) return null;
  const { topo } = sim;
  let next = -1;
  let dep = -1;
  for (const t of tr.tasks) {
    if (t.k !== 'stop' || !t.doors) continue;
    next = t.station;
    dep = t.dep ?? -1;
    break;
  }
  const dwelling = tr.phase === 'dwell' || tr.phase === 'reversing';
  if (dwelling) dep = tr.dwellUntil;
  // platform screen doors where the head stands
  let psd: DmiData['psd'] = 'none';
  const pi = topo.links[tr.link].platform;
  if (pi >= 0 && (dwelling || tr.v < 0.05)) {
    const ps = sim.plat[pi];
    psd = ps.psd === 'bypass' ? 'bypass' : ps.psd === 'closeFail' || (ps.psdFault && !tr.doorsOpen && dwelling) ? 'fault' : ps.psd === 'closed' ? 'closed' : 'open';
  }
  // stopping window indicator
  const err = stopError(sim, tr);
  let win: DmiData['stopWin'] = 'none';
  if (dwelling) win = 'aligned';
  else if (Number.isFinite(err) && tr.v < 0.05 && Math.abs(err) < 5) win = Math.abs(err) <= 0.5 ? 'aligned' : err > 0 ? 'short' : 'over';
  else if (Number.isFinite(tr.stopDist) && tr.stopDist < 600) win = 'ahead';
  const dest = tr.destStation >= 0 ? STATIONS[tr.destStation].name : tr.destText || '—';
  return {
    train: id,
    trainNo: dmiTrainNo(tr.vehicle),
    vehicleType: fleetEntry(tr.vehicle)?.type ?? '',
    dest,
    next: next >= 0 ? STATIONS[next].name : '—',
    log: tr.dmiLog.slice().reverse(),
    dep,
    dwellTotal: dwelling ? Math.max(1, tr.dwellUntil - tr.phaseSince) : 0,
    avail: availableMode(sim, tr),
    psd,
    stopWin: win,
    vEbi: tr.vEbi,
    maDist: Number.isFinite(tr.maDist) ? tr.maDist : -1,
    date: calendarDate(sim.config.date, sim.t),
  };
}

function calendarDate(iso: string | undefined, t: number): string {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + Math.floor(t / 86400));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
}
