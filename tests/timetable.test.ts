/**
 * Timetable validator (§7): the generated plans of every template, and the plans with
 * each added-service overlay applied, are feasible — turnbacks, terminal capacity,
 * headways (P1), block continuity and fleet size.
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { validatePlan, applyOverlay, OVERLAY_PRESETS } from '../src/sim/timetable';
import type { DayType } from '../src/sim/model';

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
        applyOverlay(sim.planCtx, sim.plan, p);
        const issues = validatePlan(sim.planCtx, sim.plan).filter((i) => i.severity === 'error');
        expect(fmtIssues(issues)).toBe('');
      });
    }
  }
  it('flags a turnback shorter than the minimum', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'test', startTime: 4 * 3600, seed: 1 });
    const plan = sim.plan;
    const b = plan.blocks.find((x) => x.trips.length >= 2 && plan.trips[x.trips[0]].revenue && plan.trips[x.trips[1]].revenue)!;
    const a = plan.trips[b.trips[0]], d = plan.trips[b.trips[1]];
    const shift = d.stops[0].dep - a.stops[a.stops.length - 1].arr - 30;
    for (const s of d.stops) { s.arr -= shift; s.dep -= shift; }
    expect(validatePlan(sim.planCtx, plan).some((i) => i.code === 'TURN_SHORT')).toBe(true);
  });
});
