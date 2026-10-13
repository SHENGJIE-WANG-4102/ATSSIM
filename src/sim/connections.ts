/**
 * Last-train connections at the interchanges (末班车换乘衔接), D63.
 *
 * Two kinds, both from the other lines' published last trains
 * (src/data/lasttrains.ts):
 *  - feed (他线 → 2号线): a Line 2 train is the last one a transferring
 *    passenger from another line's last train can still take. When that
 *    train is late (its delay is drawn at the start of the day), the station
 *    asks whether to hold the Line 2 train (扣车等候); holding delays it
 *    further down the line.
 *  - onward (2号线 → 他线): a Line 2 train is the last one from which the
 *    other line's last train can be caught. When the Line 2 train runs late,
 *    the dispatcher may ask the other line (via the network control centre)
 *    to wait; it agrees to short waits only.
 * A connection missed strands its transferring passengers (counted as
 * stranded). Delays, passenger numbers, the 5-minute hold the auto-answer
 * accepts and the other line's 4-minute wait limit are approximations.
 */
import type { Sim } from './engine';
import type { Connection, StopTask, TrackDir, Train } from './model';
export type { Connection };
import { STATIONS } from '../data/line2';
import { OTHER_LAST_TRAINS } from '../data/lasttrains';
import { parseIso } from './calendar';
import { openCall } from './radio';
import { trainLabel } from './ats';

/** the longest hold the auto-answer accepts for a late feeder (s) */
export const FEED_HOLD_MAX = 300;
/** the longest the other line waits for a late Line 2 train (s) */
const ONWARD_WAIT_MAX = 240;
/** a feeder is asked about this long before the Line 2 train is due out (s) */
const ASK_AHEAD = 180;

const DIR_NAME: Record<TrackDir, string> = { DN: '下行', UP: '上行' };

export function hhmm(t: number): string {
  return `${String(Math.floor(t / 3600) % 24).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;
}

/** the day's connections, from the plan; delays and passenger numbers on their own random stream */
export function initConnections(sim: Sim) {
  sim.connections = [];
  const date = sim.config.date ? parseIso(sim.config.date) : null;
  const friSat = !!date && (date.getDay() === 5 || date.getDay() === 6);
  let seed = (sim.config.seed ^ 0x1a57c0de) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const trips = sim.plan.trips.filter((t) => t.revenue);
  for (const e of OTHER_LAST_TRAINS) {
    const st = STATIONS.findIndex((s) => s.id === e.station);
    if (st < 0) continue;
    const time = friSat && e.friSat ? e.friSat : e.dep;
    const r = rnd();
    const delay = r < 0.7 ? rnd() * 40 : r < 0.92 ? 60 + rnd() * 180 : 240 + rnd() * 360;
    const busy = STATIONS[st].demand ?? 1;
    for (const dir of ['DN', 'UP'] as TrackDir[]) {
      const calls = trips.filter((t) => t.dir === dir).map((t) => {
        const i = t.stops.findIndex((x) => x.st === st && x.stop);
        return { t, s: t.stops[i], first: i === 0, final: i === t.stops.length - 1 };
      }).filter((x) => !!x.s);
      // feed: the first Line 2 departure the transfer reaches, if it is the last one boarding here
      const boarding = calls.filter((x) => !x.s.noBoard && !x.final).sort((a, b) => a.s.dep - b.s.dep);
      const ready = time - 30 + e.walk;
      const last = boarding[boarding.length - 1];
      if (last && ready <= last.s.dep + FEED_HOLD_MAX && (boarding.find((x) => x.s.dep >= ready) ?? last) === last) {
        sim.connections.push({ id: sim.connections.length, kind: 'feed', st, line: e.line, toward: e.toward, planned: time - 30, actual: time - 30 + delay,
          walk: e.walk, dir, trip: last.t.id, l2: last.s.dep, pax: Math.round((10 + rnd() * 30) * busy), state: 'pending' });
      }
      // onward: the last Line 2 arrival from which the other line's last train is caught
      const arriving = calls.filter((x) => !x.first && x.s.arr + e.walk <= time).sort((a, b) => a.s.arr - b.s.arr);
      const lastIn = arriving[arriving.length - 1];
      if (lastIn && time - lastIn.s.arr < 3600) {
        sim.connections.push({ id: sim.connections.length, kind: 'onward', st, line: e.line, toward: e.toward, planned: time, actual: time + delay,
          walk: e.walk, dir, trip: lastIn.t.id, l2: lastIn.s.arr, pax: Math.round((8 + rnd() * 25) * busy), state: 'pending' });
      }
    }
  }
}

const lineName = (c: Connection) => (/^\d+$/.test(c.line) ? `${c.line}号线` : c.line);
const subject = (c: Connection) => `${lineName(c)}往${c.toward}末班`;
const stName = (c: Connection) => STATIONS[c.st].name;

function trainOn(sim: Sim, c: Connection): Train | undefined {
  return sim.trainList.find((tr) => tr.tasks.some((k) => k.k === 'stop' && k.trip === c.trip && k.station === c.st));
}

function platformOf(sim: Sim, c: Connection) {
  return sim.topo.stations[c.st].platforms[c.dir];
}

function miss(sim: Sim, c: Connection, why: string) {
  c.state = 'missed';
  sim.metrics.stranded += c.pax;
  sim.passengersStranded += c.pax;
  sim.log('C', '客流', `${stName(c)} 末班换乘未衔接：${why}，约 ${c.pax} 名换乘乘客滞留`, { key: `conn-${c.id}` });
}

/** once a second: ask about late connections, lift holds */
export function connectionsTick(sim: Sim) {
  for (const c of sim.connections) {
    if (c.state === 'made' || c.state === 'missed' || c.state === 'void') continue;
    const trip = sim.plan.trips[c.trip];
    if (!trip || trip.cancelled) { c.state = 'void'; continue; }
    if (c.kind === 'feed') feedTick(sim, c);
    else onwardTick(sim, c);
  }
}

function feedTick(sim: Sim, c: Connection) {
  if (c.state === 'held') {
    if (sim.t >= (c.holdUntil ?? 0)) {
      const p = platformOf(sim, c);
      if (sim.plat[p].hold) sim.command({ c: 'platformHold', platform: p, on: false }, '末班接续');
      for (const o of siblings(sim, c, 'held')) { o.state = 'waiting'; o.holdUntil = undefined; }
    }
    return;
  }
  if (c.state !== 'pending' || sim.t < c.l2 - ASK_AHEAD) return;
  const tr = trainOn(sim, c);
  if (!tr) return;
  // the feeders whose passengers would miss the train at its current delay, asked about in one call
  const due = c.l2 + Math.max(0, tr.delay);
  const late = siblings(sim, c, 'pending').filter((o) => o.actual + o.walk > due + 5);
  if (!late.length) return;
  const ready = Math.max(...late.map((o) => o.actual + o.walk));
  const wait = ready - due;
  const pax = late.reduce((n, o) => n + o.pax, 0);
  for (const o of late) o.state = 'asked';
  openCall(sim, {
    kind: 'connFeed', from: `${stName(c)}站`, train: tr.id, station: c.st, target: late[0].id,
    text: `${late.map((o) => `${subject(o)}预计 ${hhmm(o.actual)} 到站`).join('，')}，换乘乘客约 ${pax} 人；2号线${DIR_NAME[c.dir]}末班 ${trainLabel(tr)} 是否扣车等候（约 ${Math.ceil(wait / 60)} 分钟）？`,
    options: [{ key: 'hold', label: `扣车等候换乘（至 ${hhmm(ready)}）` }, { key: 'go', label: '不等候，按图发车' }],
    auto: wait <= FEED_HOLD_MAX ? 'hold' : 'go', timeout: 90,
  });
}

/** connections of the same kind, Line 2 trip and station in the given state */
function siblings(sim: Sim, c: Connection, state: Connection['state']): Connection[] {
  return sim.connections.filter((o) => o.kind === c.kind && o.trip === c.trip && o.st === c.st && o.state === state);
}

/** a Line 2 delay this small is not worth a call to the other line (s) */
const ONWARD_MIN_DELAY = 60;

function onwardTick(sim: Sim, c: Connection) {
  if (c.state !== 'pending' || sim.t < c.planned - 20 * 60) return;
  const tr = trainOn(sim, c);
  if (!tr || tr.delay < ONWARD_MIN_DELAY) return;
  const eta = c.l2 + tr.delay;
  const late = siblings(sim, c, 'pending').filter((o) => eta + o.walk > o.actual);
  if (!late.length) return;
  const pax = late.reduce((n, o) => n + o.pax, 0);
  for (const o of late) o.state = 'asked';
  openCall(sim, {
    kind: 'connOnward', from: '线网指挥中心', train: tr.id, station: c.st, target: late[0].id,
    text: `2号线${DIR_NAME[c.dir]} ${trainLabel(tr)} 晚点约 ${Math.round(tr.delay / 60)} 分钟，预计 ${hhmm(eta)} 到${stName(c)}，将赶不上${late.map((o) => `${subject(o)}（${hhmm(o.actual)}）`).join('、')}，换乘乘客约 ${pax} 人。是否请求他线末班等候？`,
    options: [{ key: 'ask', label: '请求他线末班等候' }, { key: 'none', label: '不请求' }],
    auto: 'ask', timeout: 120,
  });
}

/** the dispatcher's answer to a connection call (radio.ts) */
export function answerConnection(sim: Sim, kind: string, id: number, option: string): { ok: boolean; msg: string } {
  const c = sim.connections[id];
  if (!c || c.state !== 'asked') return { ok: false, msg: '接续情况已变化' };
  const group = siblings(sim, c, 'asked');
  if (kind === 'connFeed') {
    if (option !== 'hold') { for (const o of group) o.state = 'waiting'; return { ok: true, msg: '2号线末班按图发车' }; }
    const p = platformOf(sim, c);
    sim.command({ c: 'platformHold', platform: p, on: true }, '末班接续');
    const until = Math.max(...group.map((o) => o.actual + o.walk));
    for (const o of group) { o.state = 'held'; o.holdUntil = until; }
    return { ok: true, msg: `${sim.topo.platforms[p].name} 扣车至 ${hhmm(until)} 等候换乘` };
  }
  if (option !== 'ask') { for (const o of group) o.state = 'waiting'; return { ok: true, msg: '不请求他线等候' }; }
  const tr = trainOn(sim, c);
  const eta = tr ? c.l2 + Math.max(0, tr.delay) : sim.t;
  const msgs: string[] = [];
  for (const o of group) {
    const need = eta + o.walk + 30 - o.actual;
    o.state = 'waiting';
    if (need <= ONWARD_WAIT_MAX) {
      o.actual += Math.max(0, need);
      sim.log('I', '客流', `${subject(o)}同意在${stName(o)}等候至 ${hhmm(o.actual)}`);
      msgs.push(`${lineName(o)}往${o.toward}同意等候`);
    } else msgs.push(`${lineName(o)}往${o.toward}不同意（需等 ${Math.ceil(need / 60)} 分钟）`);
  }
  return { ok: true, msg: msgs.join('；') };
}

/** an unanswered connection call: the train runs to time / nobody asks the other line */
export function expireConnection(sim: Sim, id: number) {
  const c = sim.connections[id];
  if (c) for (const o of siblings(sim, c, 'asked')) o.state = 'waiting';
}

/** a Line 2 train left a stop: settle the connections of that trip there */
export function connectionDeparture(sim: Sim, tr: Train, task: StopTask) {
  if (task.trip < 0) return;
  for (const c of sim.connections) {
    if (c.trip !== task.trip || c.st !== task.station || c.state === 'made' || c.state === 'missed' || c.state === 'void') continue;
    if (c.kind === 'feed') {
      // passengers of the other line's last train reach the platform at actual + walk
      if (sim.t + 1 >= c.actual + c.walk) {
        c.state = 'made';
        if (c.actual - c.planned > 60) sim.log('I', '客流', `${stName(c)} ${trainLabel(tr)} 接上${subject(c)}的换乘乘客`);
      } else miss(sim, c, `2号线${DIR_NAME[c.dir]}末班 ${trainLabel(tr)} ${hhmm(sim.t)} 发车，${subject(c)}的换乘乘客 ${hhmm(c.actual + c.walk)} 才到站台`);
      if (c.holdUntil !== undefined) {
        const p = platformOf(sim, c);
        if (sim.plat[p].hold) sim.command({ c: 'platformHold', platform: p, on: false }, '末班接续');
        c.holdUntil = undefined;
      }
    } else {
      // the transfer walks from the arrival
      if (tr.arrivedAt + c.walk <= c.actual) c.state = 'made';
      else miss(sim, c, `${trainLabel(tr)} ${hhmm(tr.arrivedAt)} 到站，${subject(c)}已于 ${hhmm(c.actual)} 开出`);
    }
  }
}
