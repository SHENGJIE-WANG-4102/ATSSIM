/**
 * A full service day — first trains, peaks, template transitions, last
 * trains and return to depot — must run without deadlock or collision.
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { assertNoCollision, assertIntegrity } from './helpers';
import type { DayType } from '../src/sim/model';

async function runDay(dayType: DayType) {
  const sim = new Sim({ dayType, dateLabel: 'test', startTime: 4 * 3600, seed: 3 });
  let maxOnline = 0;
  let k = 0;
  const stuck = new Map<number, number>();
  let worstStuck = 0;
  while (sim.t < 27.5 * 3600) {
    sim.step();
    if (++k % 20000 === 0) await new Promise((r) => setTimeout(r, 0));
    if (k % 50 !== 0) continue;
    assertNoCollision(sim);
    assertIntegrity(sim);
    maxOnline = Math.max(maxOnline, sim.trainList.length);
    for (const tr of sim.trainList) {
      const t0 = tr.tasks[0];
      const waitingByPlan = t0 && t0.k === 'stop' && t0.dep !== null && (t0.arr === null || t0.arr === t0.dep) && t0.dep > sim.t - 120;
      const idle = tr.phase === 'run' && tr.v < 0.05 && !waitingByPlan;
      if (idle) {
        const s = stuck.get(tr.id) ?? sim.t;
        stuck.set(tr.id, s);
        if (tr.inService) worstStuck = Math.max(worstStuck, sim.t - s);
      } else stuck.delete(tr.id);
    }
  }
  return { sim, maxOnline, worstStuck };
}

describe('full service day', () => {
  for (const dayType of ['weekday', 'weekend'] as DayType[]) {
    it(`${dayType}: every planned revenue trip runs, all trains return`, async () => {
      const { sim, maxOnline, worstStuck } = await runDay(dayType);
      console.log(dayType, { trips: sim.tripsDone, punct: sim.depOnTime / sim.depTotal, maxOnline, worstStuck, remaining: sim.trainList.map((t) => t.phase) });
      const planned = sim.plan.trips.filter((t) => t.revenue && !t.cancelled).length;
      expect(sim.tripsDone).toBe(planned);
      // after the night: only overnight-stabled trains remain on the line
      expect(sim.trainList.every((t) => t.phase === 'stabled')).toBe(true);
      expect(maxOnline).toBeLessThanOrEqual(76);
      // Final revenue arrivals, including passenger dwell propagation.
      const arrivals = sim.metrics.tripDelays;
      expect(arrivals.filter(d=>Math.abs(d)<=120).length/arrivals.length).toBeGreaterThanOrEqual(.98);
      expect(Math.max(0,...arrivals)).toBeLessThanOrEqual(300);
      const target = dayType==='weekday'?1_090_000:763_000;
      expect(sim.passengersServed).toBeGreaterThanOrEqual(target*.9);
      expect(sim.passengersServed).toBeLessThanOrEqual(target*1.1);
      if(dayType==='weekday'){
        expect(sim.ridership.peakSectionLoad/2480).toBeGreaterThanOrEqual(.9);
        expect(sim.ridership.peakSectionLoad/2480).toBeLessThanOrEqual(1.3);
        // Actual 北新泾 departures at the leading and trailing peak edges.
        for(const dir of ['DN','UP'] as const)for(const edge of [24600,34200,60600,70200]){
          const times=sim.depLog.filter(d=>d.st===5&&sim.plan.trips[d.trip].dir===dir
            &&d.t>=edge-300&&d.t<=edge+300).map(d=>d.t).sort((a,b)=>a-b);
          expect(times.length).toBeGreaterThanOrEqual(3);
          for(let i=1;i<times.length;i++){
            expect(times[i]-times[i-1]).toBeGreaterThanOrEqual(90);
            expect(times[i]-times[i-1]).toBeLessThanOrEqual(210);
          }
        }
      }
      // no in-service train held at a red signal / behind a blockage for long
      expect(worstStuck).toBeLessThan(420);
      // no emergency brakes in normal operation
      expect(sim.events.filter((e) => e.text.includes('紧急制动')).length).toBe(0);
      if (dayType === 'weekday') {
        expect(sim.plan.trips.some((t) => t.kind === 'small')).toBe(true);
      } else {
        expect(sim.plan.trips.some((t) => t.kind === 'small')).toBe(false);
      }
    });
  }
});
