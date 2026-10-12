/**
 * Timetable validator (§7): the generated plans of every template, and the plans with
 * each added-service overlay applied, are feasible — turnbacks, terminal capacity,
 * headways (P1), block continuity and fleet size.
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { validatePlan, applyOverlay, OVERLAY_PRESETS, terminalOccupancy } from '../src/sim/timetable';
import type { DayType } from '../src/sim/model';
import { SCENARIOS } from '../src/sim/scenario';
import { STATIONS } from '../src/data/line2';

const fmtIssues = (xs: { code: string; text: string }[]) => xs.map((i) => `${i.code} ${i.text}`).join('\n');

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
    // shorten one 蟠祥路 turn of a base block to a front turn at 虹桥火车站
    const block = plan.blocks.find(b => b.trips.some((id,i) => {
      const a = plan.trips[id], d = plan.trips[b.trips[i+1]];
      return d && a.revenue && d.revenue && a.dir==='UP' && a.to===0 && d.from===0 && a.stops[0].arr > 10*3600;
    }))!;
    const index = block.trips.findIndex((id,i) => plan.trips[id].to===0 && plan.trips[block.trips[i+1]]?.from===0 && plan.trips[id].stops[0].arr > 10*3600);
    const arrival = plan.trips[block.trips[index]], departure = plan.trips[block.trips[index+1]];
    arrival.stops = arrival.stops.filter(s => s.st >= 2); arrival.to = 2;
    departure.stops = departure.stops.filter(s => s.st >= 2); departure.from = 2;
    const occupied = terminalOccupancy(plan).get(2)!.find(o => o.block===block.id)!;
    expect(occupied).toBeDefined();
    const trip = plan.trips.find(t => !t.cancelled && t.block!==block.id && t.dir==='DN' && t.stops.some(s => s.st===2))!;
    const stop = trip.stops.find(s => s.st===2)!;
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
  it('rejects an early feeder that traps an earlier departure on the single GLL turnback platform', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'order', startTime: 14400, seed: 1 });
    const occupancy = terminalOccupancy(sim.plan).get(22)!.sort((a,b) => a.from-b.from);
    // (one train turns there at a time: move a feeder ahead of the train before it)
    const index = occupancy.findIndex((item,i) => i > 0
      && sim.plan.trips[sim.plan.blocks[item.block].trips[0]].kind === 'empty');
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
      expect(runs.map((t) => t.stops[0].dep).sort()).toEqual([23 * 3600 + 4 * 60, 23 * 3600 + 30 * 60]);
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
    expect(air.map((t) => t.stops[0].dep)).toEqual([22 * 3600 + 50 * 60, 23 * 3600 + 10 * 60, 23 * 3600 + 30 * 60]);
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
