/**
 * Passenger information (PIS) for one station: next trains per platform
 * with destination and estimated arrival, derived from the trains' task
 * lists, their current delay and position.
 */
import type { Sim } from './engine';
import type { PisData, PisRow } from './model';
import { STATIONS, LINE_INFO } from '../data/line2';

export function computePis(sim: Sim, station: number): PisData {
  const { topo } = sim;
  const out: PisData = { station, DN: [], UP: [], notice: '' };
  for (const tr of sim.trainList) {
    if (tr.failed && tr.phase !== 'dwell') continue;
    let prevEta = sim.t;
    const late = Math.max(0, tr.delay);
    for (let i = 0; i < Math.min(tr.tasks.length, 16); i++) {
      const t = tr.tasks[i];
      if (t.k !== 'stop') continue;
      let eta: number;
      if (i === 0 && tr.phase === 'dwell') eta = sim.t;
      else if (i === 0 && Number.isFinite(tr.stopDist)) eta = sim.t + tr.stopDist / Math.max(tr.v, 8) + 8;
      else eta = Math.max(prevEta + 45, (t.arr ?? t.dep ?? sim.t) + late);
      prevEta = eta;
      if (t.station !== station) continue;
      if (!t.revenue || !t.doors) break;
      const p = topo.berths[t.berth].platform;
      const track = topo.platforms[p].track;
      let status: PisRow['status'] = 'eta';
      if (i === 0 && tr.phase === 'dwell') status = tr.doorsOpen ? 'at' : 'departing';
      else if (i === 0 && tr.stopDist < 350) status = 'arriving';
      const trip = t.trip >= 0 ? sim.plan.trips[t.trip] : null;
      const dest = t.dep === null ? '本站终到' : trip ? STATIONS[trip.to].name : tr.destText;
      // a train starting here waits for its planned departure
      if (status === 'eta' && t.dep !== null && t.arr === null) eta = Math.max(eta, t.dep - 60);
      out[track].push({ dest, eta: Math.max(0, eta - sim.t), status, trip: tr.tripNo, load: Math.min(1.3, tr.load / LINE_INFO.capacity) });
      break;
    }
  }
  for (const k of ['DN', 'UP'] as const) out[k] = out[k].sort((a, b) => a.eta - b.eta).slice(0, 3);
  // notices
  const notes: string[] = [];
  const s = topo.stations[station];
  if (sim.plat[s.platforms.DN].esp || sim.plat[s.platforms.UP].esp) notes.push('站台临时停止服务，请听从工作人员指挥');
  if (sim.plat[s.platforms.DN].surge > 1 || sim.plat[s.platforms.UP].surge > 1) notes.push('本站客流较大，请有序候车，注意安全');
  if (sim.plat[s.platforms.DN].limitUntil > sim.t) notes.push('本站实施客流控制，请耐心等候');
  if (sim.env.wind > 0 || sim.env.rain) notes.push('受天气影响，东段高架区段列车限速运行');
  for (const a of sim.alarms.values()) {
    if ((a.level === 'A' || a.level === 'B') && (a.cat === '信号' || a.cat === '列车')) { notes.push('因设备故障，列车运行间隔有所延长，请耐心候车'); break; }
  }
  out.notice = notes[0] ?? `欢迎乘坐上海地铁2号线 · ${STATIONS[station].name}站`;
  return out;
}
