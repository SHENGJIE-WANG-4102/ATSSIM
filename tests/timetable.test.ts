/**
 * Timetable validator (§7): the generated plans of every template, and the plans with
 * each added-service overlay applied, are feasible — turnbacks, terminal capacity,
 * headways (P1), block continuity and fleet size.
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { validatePlan, applyOverlay, OVERLAY_PRESETS, terminalOccupancy, TEMPLATES, dayPeriods, yardNeed, platformBerth, blockTasks } from '../src/sim/timetable';
import type { DayType } from '../src/sim/model';
import { SCENARIOS } from '../src/sim/scenario';
import { STATIONS, OPERATIONS } from '../src/data/line2';
import { FIRST_LAST } from '../src/data/firstlast';

const fmtIssues = (xs: { code: string; text: string }[]) => xs.map((i) => `${i.code} ${i.text}`).join('\n');

describe('D73 calibrated service anchors', () => {
  const H = (h: number, m = 0) => h * 3600 + m * 60;
  const clock = (s: string) => { const [h, m] = s.split(':').map(Number); return H(h, m); };
  const sim = new Sim({ dayType: 'weekday', dateLabel: 'calibration anchors', startTime: H(4), seed: 1 });
  const live = sim.plan.trips.filter(t => t.revenue && !t.cancelled);
  it('fixes all three last origins and matches official end-to-end arrivals within a minute', () => {
    for (const [dir, from, to, departure, arrival] of [
      ['DN', 0, 30, H(21, 57), H(23, 31)],
      ['UP', 30, 0, H(22, 30), H(24, 5)],
      ['DN', 0, 22, H(22, 42), H(23, 44)],
    ] as const) {
      const trip = live.filter(t => t.dir === dir && t.from === from && t.to === to)
        .sort((a, b) => a.stops[0].dep - b.stops[0].dep).at(-1)!;
      expect(trip.stops[0].dep).toBe(departure);
      expect(Math.abs(trip.stops.at(-1)!.arr - arrival)).toBeLessThanOrEqual(60);
    }
    expect(OPERATIONS.lastBigWestboundDep).toBe(H(22, 30));
  });
  it('has no westbound GLL passenger origins after the published last train', () => {
    expect(live.filter(t => t.dir === 'UP' && t.from === 22 && t.stops[0].dep > H(23, 2))).toHaveLength(0);
  });
  it('stables the last revenue arrivals at all three overnight stations', () => {
    for (const [st, count] of [[0, 4], [30, 2], [22, 2]]) {
      const expected = live.filter(t => t.to === st).sort((a, b) => b.stops.at(-1)!.arr - a.stops.at(-1)!.arr)
        .slice(0, count).map(t => t.id).sort((a, b) => a - b);
      const actual = sim.plan.blocks.filter(b => b.end.kind === 'stable' && b.end.station === st)
        .map(b => b.trips.at(-1)!).sort((a, b) => a - b);
      expect(actual, STATIONS[st].name).toEqual(expected);
    }
    const gll = sim.plan.blocks.filter(b => b.end.kind === 'stable' && b.end.station === 22)
      .sort((a, b) => sim.plan.trips[a.trips.at(-1)!].stops.at(-1)!.arr - sim.plan.trips[b.trips.at(-1)!].stops.at(-1)!.arr);
    expect(gll[0].end).toMatchObject({ berth: sim.topo.stations[22].turnbackBerths[0] });
    expect(gll[1].end).toMatchObject({ berth: platformBerth(sim.topo, 22, 'DN') });
  });
  it('matches every published first/last minute within two minutes, including terminal arrivals', () => {
    for (const [st, row] of FIRST_LAST.entries()) {
      for (const [key, dir, terminal, last] of [
        ['firstE', 'DN', 30, false], ['firstW', 'UP', 0, false],
        ['lastE', 'DN', 30, true], ['lastW', 'UP', 0, true], ['lastG', 'DN', 22, true],
      ] as const) {
        if (!row[key] || (row.station === '唐镇' && key === 'firstW')) continue;
        const times = live.filter(t => t.dir === dir && (key === 'lastG' ? t.stops.some(s => s.st === 22) : t.to === terminal))
          .flatMap(t => t.stops.filter(s => s.st === st && s.stop && (t.to === st ? st === terminal : !s.noBoard))
            .map(s => t.to === st ? s.arr : s.dep));
        expect(times.length, `${row.station} ${key}`).toBeGreaterThan(0);
        const ours = last ? Math.max(...times) : Math.min(...times);
        expect(Math.abs(ours - clock(row[key])), `${row.station} ${key}`).toBeLessThanOrEqual(120);
      }
    }
  });
  it('counts passenger-carrying trainsets against the paper, with enough AM fleet capacity', () => {
    const count = (time: number) => new Set(live.filter(t => t.stops[0].dep <= time && t.stops.at(-1)!.arr > time).map(t => t.block)).size;
    for (const [at, expected] of [[H(8), 67], [H(17, 30), 56], [H(12), 42]]) expect(Math.abs(count(at) - expected)).toBeLessThanOrEqual(3);
    for (let at = H(6, 50); at < H(9, 30); at += 60) expect(count(at)).toBeLessThanOrEqual(76);
  });
  it('keeps each outer section on a five-minute opening grid until AM pre-positioning', () => {
    for (const [origin, until] of [[30, H(6, 18)], [0, H(6, 32)]]) {
      const times = live.filter(t => t.from === origin && t.stops[0].dep >= H(6) && t.stops[0].dep < until)
        .map(t => t.stops[0].dep).sort((a, b) => a - b);
      expect(times.length).toBeGreaterThanOrEqual(4);
      for (let i = 1; i < times.length; i++) expect(Math.abs(times[i] - times[i - 1] - 300)).toBeLessThanOrEqual(10);
    }
  });
});

describe('D72 timetable structure', () => {
  const H = (h: number, m = 0) => h * 3600 + m * 60;
  const make = (dayType: DayType) => new Sim({ dayType, dateLabel: 'structure', startTime: H(4), seed: 1 });
  it('uses a 150-second weekday AM core headway', () => {
    expect(TEMPLATES.weekdayAM.headway).toBe(150);
    const sim = make('weekday');
    for (const dir of ['DN', 'UP'] as const) {
      const times = sim.plan.trips.filter(t => !t.cancelled && t.dir === dir && t.revenue && t.to !== (dir === 'DN' ? 4 : 22))
        .flatMap(t => t.stops.filter(s => s.st === (dir === 'DN' ? 4 : 22) && s.dep >= H(7, 30) && s.dep < H(8, 30)).map(s => s.dep)).sort((a, b) => a - b);
      expect(times.length).toBeGreaterThan(20);
      for (let i = 1; i < times.length; i++) expect(Math.abs(times[i] - times[i - 1] - 150)).toBeLessThan(1);
    }
  });
  it('keeps short routes at 20:30, then closes them with passenger-carrying withdrawals', () => {
    const sim = make('weekday');
    const live = sim.plan.trips.filter(t => t.revenue && !t.cancelled);
    expect(live.some(t => t.kind === 'small' && t.stops[0].dep <= H(20, 30) && t.stops.at(-1)!.arr > H(20, 30))).toBe(true);
    expect(live.filter(t => t.kind === 'small' && t.stops.at(-1)!.arr > H(21, 10))).toHaveLength(0);
    expect(live.some(t => t.kind === 'wd' && t.dir === 'DN' && t.to === 19 && Math.abs(t.stops.at(-1)!.arr - H(20, 55)) <= 300)).toBe(true);
    expect(live.some(t => t.kind === 'wd' && t.dir === 'UP' && t.from === 22 && t.to === 0 && Math.abs(t.stops[0].dep - H(20, 55)) <= 180)).toBe(true);
    expect(dayPeriods('weekday').some(p => p.template === 'weekdayEvening')).toBe(false);
    expect(dayPeriods('weekend').find(p => p.from === H(21))?.template).toBe('weekdayEvening');
  });
  for (const dayType of ['weekday', 'weekend'] as const) {
    it(`${dayType}: official first trains and eight overnight trains fit the yards`, () => {
      const sim = make(dayType), { plan, topo } = sim;
      for (const [id, dir] of [['LYL', 'UP'], ['KJG', 'UP'], ['GLL', 'UP'], ['PXL', 'DN'], ['GLL', 'DN'], ['PDA', 'UP']] as const) {
        const st = STATIONS.findIndex(s => s.id === id);
        const row = FIRST_LAST.find(r => r.station === STATIONS[st].name)!;
        const [h, m] = (dir === 'DN' ? row.firstE : row.firstW).split(':').map(Number);
        const departures = plan.trips.filter(t => !t.cancelled && t.revenue && t.dir === dir && t.to !== st)
          .flatMap(t => t.stops.filter(s => s.st === st && s.stop && !s.noBoard).map(s => s.dep));
        const first = Math.min(...departures);
        expect(first, `${id} ${dir}`).toBeGreaterThanOrEqual(H(h, m) - .001);
        expect(first, `${id} ${dir}`).toBeLessThanOrEqual(H(h, m) + 60);
      }
      // the first trains open the line: they board all the way, wherever run
      // times put them against the published minutes
      const opener = (dir: 'UP' | 'DN', from: string, dep: number) => plan.trips.find(t => !t.cancelled && t.dir === dir
        && STATIONS[t.stops[0].st].id === from && Math.abs(t.stops[0].dep - dep) < 60);
      for (const [dir, from, dep] of [['DN', 'PXL', H(5, 25)], ['UP', 'LYL', H(5, 20)], ['UP', 'GLL', H(5, 28)], ['DN', 'GLL', H(6)], ['UP', 'PDA', H(6)]] as const) {
        const t = opener(dir, from, dep);
        expect(t, `${from} ${dir}`).toBeDefined();
        expect(t!.revenue).toBe(true);
        expect(t!.stops.filter(s => s.stop && s.noBoard && s.st !== t!.to).map(s => STATIONS[s.st].id), `${from} ${dir}`).toEqual([]);
      }
      expect(plan.blocks.filter(b => b.start.kind === 'stable')).toHaveLength(8);
      expect(plan.blocks.filter(b => b.start.kind === 'stable' && b.start.station === 17)).toHaveLength(0);
      const gll = plan.blocks.filter(b => b.start.kind === 'stable' && b.start.station === 22);
      expect(gll).toHaveLength(2);
      for (const b of gll) {
        const first = plan.trips[b.trips[0]];
        expect(first.stops[0].dep).toBe(first.dir === 'UP' ? H(5, 28) : H(6));
        if (b.start.kind !== 'stable') throw new Error('stable');
        const berth = topo.berths[b.start.berth!];
        expect(berth.platform === topo.stations[22].platforms.DN).toBe(first.dir === 'DN');
        expect(blockTasks(topo, plan, b).find(t => t.k === 'stop')).toMatchObject({ berth: b.start.berth });
        expect(sim.trainList.find(t => t.block === b.id)?.dir).toBe(first.dir === 'DN' ? 1 : -1);
      }
      sim.step(); sim.step();
      for (const b of gll) expect(sim.trainList.find(t => t.block === b.id)?.doorsOpen).toBe(false);
      expect(sim.integrity.violations).toHaveLength(0);
      expect(plan.blocks.filter(b => b.end.kind === 'stable' && b.end.station === 22)).toHaveLength(2);
      expect(yardNeed(topo, plan).every((n, d) => n <= topo.depots[d].capacity)).toBe(true);
      expect(sim.depotStock.every((n, d) => n <= topo.depots[d].capacity)).toBe(true);
      expect(fmtIssues(validatePlan(sim.planCtx, plan))).toBe('');
    });
    it(`${dayType}: protects GLL's DN overnight platform through midnight and the next opening`, () => {
      const sim = make(dayType), { plan, topo } = sim;
      const berth = platformBerth(topo, 22, 'DN');
      const night = plan.blocks.find(b => b.end.kind === 'stable' && b.end.berth === berth)!;
      const last = plan.trips[night.trips.at(-1)!];
      const morning = plan.blocks.find(b => b.start.kind === 'stable' && b.start.berth === berth)!;
      const first = plan.trips[morning.trips[0]];
      for (const t of plan.trips) {
        if (t.cancelled || t.dir !== 'DN' || t.id === last.id || t.id === first.id) continue;
        const tasks = blockTasks(topo, plan, plan.blocks[t.block]);
        const at = t.stops.find(s => s.st === 22);
        if (!at || !tasks.some(task => task.k === 'stop' && task.trip === t.id && task.berth === berth) && t.to === 22) continue;
        expect(at.dep).toBeLessThan(last.stops.at(-1)!.arr);
        expect(at.arr).toBeGreaterThanOrEqual(first.stops[0].dep);
      }
      // A returning empty train must be rejected too, even if it is a fixed
      // special or a next-day depot positioning trip rather than revenue.
      const conflicting = plan.trips.find(t => t.dir === 'DN' && t.to > 22 && !t.cancelled)!;
      conflicting.revenue = false;
      conflicting.stops.find(s => s.st === 22)!.arr = H(5, 50);
      conflicting.stops.find(s => s.st === 22)!.dep = H(5, 50);
      expect(validatePlan(sim.planCtx, plan).some(i => i.code === 'STABLE_CONFLICT' && i.blocks?.includes(conflicting.block))).toBe(true);
    });
  }
});

describe('timetable validator', () => {
  for (const dayType of ['weekday', 'weekend'] as DayType[]) {
    it(`${dayType} plan has no issues`, () => {
      const sim = new Sim({ dayType, dateLabel: 'test', startTime: 4 * 3600, seed: 1 });
      const issues = validatePlan(sim.planCtx, sim.plan);
      expect(fmtIssues(issues)).toBe('');
      expect(sim.plan.trips.some((t) => t.revenue)).toBe(true);
    });
    for (const p of OVERLAY_PRESETS) {
      it(`${dayType} + overlay ${p.id} has no errors`, () => {
        const sim = new Sim({ dayType, dateLabel: 'test', startTime: 4 * 3600, seed: 1 });
        // as ordered from the dispatcher before service: base blocks may be extended (D47)
        applyOverlay(sim.planCtx, sim.plan, p, { now: sim.t, canExtend: () => true });
        const issues = validatePlan(sim.planCtx, sim.plan).filter((i) => i.severity === 'error');
        expect(fmtIssues(issues)).toBe('');
        // a front-turn end may be served by turning at the next rear turnback beyond it (D47)
        const serves = (t: typeof sim.plan.trips[number], x: number, y: number) => {
          const i = t.stops.findIndex(s => s.st === x), j = t.stops.findIndex(s => s.st === y);
          return i >= 0 && j > i;
        };
        expect(sim.plan.trips.some(t => !t.cancelled && t.overlay && t.revenue && serves(t, p.a, p.b))).toBe(true);
        expect(sim.plan.trips.some(t => !t.cancelled && t.overlay && t.revenue && serves(t, p.b, p.a))).toBe(true);
      });
    }
  }
  it('keeps one hot standby at each line end off-peak, in one turnback track (D70)', () => {
    for (const dayType of ['weekday', 'weekend'] as DayType[]) {
      const sim = new Sim({ dayType, dateLabel: 'test', startTime: 4 * 3600, seed: 1 });
      const { plan, topo } = sim;
      const E = topo.stations.length - 1;
      const at = (st: number, t: number) => plan.blocks.filter(b => {
        const ts = b.trips.map(id => plan.trips[id]).filter(x => !x.cancelled);
        return ts.some((x, i) => x.standby && x.to === st && ts[i + 1] && x.stops.at(-1)!.arr <= t && ts[i + 1].stops[0].dep > t);
      });
      for (const st of [0, E]) {
        // midday: exactly one, and the other trains turn within the remaining places
        expect(at(st, 12 * 3600).length, `${dayType} ${STATIONS[st].name}`).toBe(1);
        const occ = terminalOccupancy(plan).get(st)!;
        const busy = (t: number) => occ.filter(o => o.from <= t && o.to > t).length;
        for (let t = 11 * 3600; t < 14 * 3600; t += 60) expect(busy(t)).toBeLessThanOrEqual(3);
      }
      // not in the peaks: both tracks turn trains then
      if (dayType === 'weekday') for (const st of [0, E]) {
        expect(at(st, 8 * 3600).length + at(st, 17.5 * 3600).length).toBe(0);
        expect(at(st, 20.5 * 3600)).toHaveLength(0);
        expect(at(st, 21.5 * 3600)).toHaveLength(1);
      }
      expect(fmtIssues(validatePlan(sim.planCtx, plan))).toBe('');
    }
  });

  it('fits complete overlay circulations after fault cancellations open larger gaps', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'recovery', startTime: 14400, seed: 1 });
    for (const block of sim.plan.blocks) if (block.id % 3 === 0)
      for (const id of block.trips) sim.plan.trips[id].cancelled = true;
    const original = sim.plan.trips.map(trip => ({ cancelled: trip.cancelled, stops: structuredClone(trip.stops) }));
    const firstAdded = sim.plan.trips.length;
    const result = applyOverlay(sim.planCtx, sim.plan, OVERLAY_PRESETS[0]);
    expect(result.trips).toBeGreaterThan(0);
    expect(fmtIssues(validatePlan(sim.planCtx, sim.plan))).toBe('');
    expect(sim.plan.trips.slice(0, firstAdded).map(trip => ({ cancelled: trip.cancelled, stops: trip.stops }))).toEqual(original);
    const omitted = sim.plan.trips.slice(firstAdded).filter(trip => trip.cancelReason?.startsWith('加开能力不足'));
    expect(omitted.length).toBeGreaterThan(0);
    for (const trip of omitted) expect(sim.plan.blocks[trip.block].trips.every(id => sim.plan.trips[id].cancelled)).toBe(true);
  });
  it('flags a turnback shorter than the minimum', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'test', startTime: 4 * 3600, seed: 1 });
    const plan = sim.plan;
    const b = plan.blocks.find((x) => x.trips.length >= 2 && plan.trips[x.trips[0]].revenue && plan.trips[x.trips[1]].revenue)!;
    const a = plan.trips[b.trips[0]], d = plan.trips[b.trips[1]];
    const shift = d.stops[0].dep - a.stops[a.stops.length - 1].arr - 30;
    for (const s of d.stops) { s.arr -= shift; s.dep -= shift; }
    expect(validatePlan(sim.planCtx, plan).some((i) => i.code === 'TURN_SHORT')).toBe(true);
  });
  it('rejects a front turn that occupies the normal departure platform during a through train', () => {
    const sim = new Sim({dayType:'weekday',dateLabel:'front slot',startTime:14400,seed:1});
    const plan = sim.plan;
    // shorten one 蟠祥路 turn of a base block to a front turn at 威宁路
    const block = plan.blocks.find(b => b.trips.some((id,i) => {
      const a = plan.trips[id], d = plan.trips[b.trips[i+1]];
      return d && a.revenue && d.revenue && a.dir==='UP' && a.to===0 && d.from===0 && a.stops[0].arr > 10*3600;
    }))!;
    const index = block.trips.findIndex((id,i) => plan.trips[id].to===0 && plan.trips[block.trips[i+1]]?.from===0 && plan.trips[id].stops[0].arr > 10*3600);
    const arrival = plan.trips[block.trips[index]], departure = plan.trips[block.trips[index+1]];
    arrival.stops = arrival.stops.filter(s => s.st >= 6); arrival.to = 6;
    departure.stops = departure.stops.filter(s => s.st >= 6); departure.from = 6;
    const occupied = terminalOccupancy(plan).get(6)!.find(o => o.block===block.id)!;
    expect(occupied).toBeDefined();
    const trip = plan.trips.find(t => !t.cancelled && t.block!==block.id && t.dir==='DN' && t.stops.some(s => s.st===6))!;
    const stop = trip.stops.find(s => s.st===6)!;
    const shift = occupied.from+30-stop.dep;
    for (const s of trip.stops) {s.arr+=shift;s.dep+=shift;}
    expect(validatePlan(sim.planCtx,plan).some(issue => issue.code==='FRONT_CONFLICT' && issue.blocks?.includes(block.id))).toBe(true);
  });
  it('rejects an added circulation that uses an intermediate terminal as long-term storage', () => {
    const sim = new Sim({dayType:'weekday',dateLabel:'layover',startTime:14400,seed:1});
    applyOverlay(sim.planCtx,sim.plan,OVERLAY_PRESETS[0]);
    const occupied = terminalOccupancy(sim.plan).get(1)!.find(o => sim.plan.trips[sim.plan.blocks[o.block].trips[0]].overlay)!;
    const block = sim.plan.blocks[occupied.block];
    const index = block.trips.findIndex((id,i) => sim.plan.trips[id].to===1 && sim.plan.trips[block.trips[i+1]]?.from===1);
    const arrival = sim.plan.trips[block.trips[index]], departure = sim.plan.trips[block.trips[index+1]];
    const shift = arrival.stops.at(-1)!.arr+1200-departure.stops[0].dep;
    for (const stop of departure.stops) {stop.arr+=shift;stop.dep+=shift;}
    expect(validatePlan(sim.planCtx,sim.plan).some(issue => issue.code==='LAYOVER_LONG' && issue.blocks?.includes(block.id))).toBe(true);
  });
  it('protects planned depot exits from an added return on the shared conversion track', () => {
    const sim = new Sim({dayType:'weekday',dateLabel:'depot slot',startTime:14400,seed:1});
    const original = structuredClone(sim.plan.trips);
    applyOverlay(sim.planCtx,sim.plan,OVERLAY_PRESETS[0]);
    expect(sim.plan.trips.slice(0,original.length)).toEqual(original);
    const omitted = sim.plan.trips.find(trip => trip.cancelReason?.includes('转换轨时隙冲突'))!;
    expect(omitted).toBeDefined();
    const block = sim.plan.blocks[omitted.block];
    expect(block.trips.every(id => sim.plan.trips[id].cancelled)).toBe(true);
    for (const id of block.trips) sim.plan.trips[id].cancelled=false;
    expect(validatePlan(sim.planCtx,sim.plan).some(issue => issue.code==='DEPOT_CONFLICT' && issue.blocks?.includes(block.id))).toBe(true);
  });
  it('keeps a throat clearance between turns on the GLL middle-track platform', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'throat', startTime: 14400, seed: 1 });
    const plan = sim.plan;
    const turns = terminalOccupancy(plan).get(22)!.sort((a,b) => a.from-b.from);
    const clear = OPERATIONS.platformTurnClear.GLL;
    for (let i = 1; i < turns.length; i++) expect(turns[i].from - turns[i-1].to).toBeGreaterThanOrEqual(clear);
    // the D72 opening built up 40 s gaps here: arrive 20 s after the previous turn leaves
    const i = turns.findIndex((x, k) => k > 0 && x.from > 6 * 3600 && x.from - turns[k-1].to > 40);
    const first = turns[i-1], second = turns[i];
    const arriving = plan.blocks[second.block].trips.map(id => plan.trips[id]).find(t => !t.cancelled && t.to === 22 && t.stops.at(-1)!.arr === second.from)!;
    const shift = second.from - (first.to + 20);
    for (const stop of arriving.stops) { stop.arr -= shift; stop.dep -= shift; }
    expect(validatePlan(sim.planCtx, plan).some(issue => issue.code === 'TURN_HEADWAY'
      && issue.blocks?.includes(second.block) && issue.blocks.includes(first.block))).toBe(true);
  });
  it('rejects an early feeder that traps an earlier departure on the single GLL turnback platform', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'order', startTime: 14400, seed: 1 });
    const occupancy = terminalOccupancy(sim.plan).get(22)!.sort((a,b) => a.from-b.from);
    // (one train turns there at a time: move a feeder ahead of the train before it)
    const index = occupancy.findIndex((item,i) => i > 0
      && !sim.plan.trips[sim.plan.blocks[item.block].trips[0]].revenue
      && sim.plan.trips[sim.plan.blocks[item.block].trips[0]].to === 22);
    expect(index).toBeGreaterThan(0);
    const first = occupancy[index-1], second = occupancy[index];
    const feeder = sim.plan.trips[sim.plan.blocks[second.block].trips[0]];
    const shift = second.from-first.from+10;
    for (const stop of feeder.stops) { stop.arr -= shift; stop.dep -= shift; }
    expect(validatePlan(sim.planCtx, sim.plan).some(issue => issue.code === 'TAIL_ORDER'
      && issue.blocks?.includes(second.block) && issue.blocks.includes(first.block))).toBe(true);
  });
});

describe('fixed-time special trains (定点班车)', () => {
  const idx = (id: string) => STATIONS.findIndex((s) => s.id === id);
  for (const dayType of ['weekday', 'weekend'] as DayType[]) {
    it(`${dayType}: 虹桥火车站 23:04 / 23:30 to 龙阳路, set-down only, passing the rest`, () => {
      const sim = new Sim({ dayType, dateLabel: 'test', startTime: 4 * 3600, seed: 1 });
      const runs = sim.plan.trips.filter((t) => t.kind === 'extra' && !t.cancelled);
      expect(runs.map((t) => t.stops[0].dep).sort((a, b) => a - b)).toEqual([23 * 3600 + 4 * 60, 23 * 3600 + 30 * 60]);
      for (const t of runs) {
        expect([t.from, t.to]).toEqual([idx('HQZ'), idx('LYL')]);
        const stopping = t.stops.filter((s) => s.stop).map((s) => STATIONS[s.st].id);
        expect(stopping).toEqual(['HQZ', 'HQ2', 'SHR', 'WNL', 'ZSG', 'JAS', 'RMG', 'SJD', 'LYL']);
        expect(t.stops.filter((s) => s.noBoard).map((s) => STATIONS[s.st].id)).toEqual(['SHR', 'WNL', 'ZSG', 'JAS', 'RMG', 'SJD']);
        // a train already on the line carries it, into 龙阳路 depot
        const b = sim.plan.blocks[t.block];
        expect(b.end).toMatchObject({ kind: 'depot', depot: sim.topo.depots.findIndex((d) => d.key === 'LYD') });
      }
    });
  }
  it('holiday-return scenario: its own runs both ways, plan feasible', () => {
    const def = SCENARIOS.find((s) => s.id === 'holiday-return')!;
    const sim = new Sim({ dayType: def.dayType, dateLabel: 'test', startTime: 4 * 3600, seed: 1, scenario: def.id });
    expect(fmtIssues(validatePlan(sim.planCtx, sim.plan))).toBe('');
    const runs = sim.plan.trips.filter((t) => t.kind === 'extra' && !t.cancelled);
    expect(runs.filter((t) => t.dir === 'DN').length).toBe(4);
    const air = runs.filter((t) => t.dir === 'UP');
    expect(air.map((t) => t.stops[0].dep).sort((a, b) => a - b)).toEqual([22 * 3600 + 50 * 60, 23 * 3600 + 10 * 60, 23 * 3600 + 30 * 60]);
    for (const t of air) {
      expect([t.from, t.to]).toEqual([idx('PDA'), idx('ZSG')]);
      // terminating at 中山公园, the train goes on empty into 北翟路
      const b = sim.plan.blocks[t.block];
      const next = sim.plan.trips[b.trips[b.trips.indexOf(t.id) + 1]];
      expect(next.revenue).toBe(false);
      expect(next.from).toBe(idx('ZSG'));
    }
  });
});
