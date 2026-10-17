import { describe, it, expect } from 'vitest';
import { serviceEnd } from '../src/sim/timetable';
import type { Plan } from '../src/sim/model';

type T = Plan['trips'][number];
const trip = (id: number, dir: 'DN' | 'UP', from: number, to: number, endStops: boolean, extra: Partial<T> = {}) =>
  ({ id, block: 0, dir, from, to, revenue: true, stops: [{ st: from, stop: true }, { st: to, stop: endStops }], ...extra }) as unknown as T;

describe('service destination', () => {
  it('follows a feeder that runs through its last station into the next same-direction trip', () => {
    const trips = [trip(0, 'UP', 24, 22, false), trip(1, 'UP', 22, 1, true), trip(2, 'DN', 1, 22, true)];
    const plan = { trips, blocks: [{ trips: [0, 1, 2] }] } as unknown as Plan;
    expect(serviceEnd(plan, trips[0])).toBe(1);
    expect(serviceEnd(plan, trips[1])).toBe(1);
  });
  it('keeps the trip end when the train stops there or turns back', () => {
    const stops = [trip(0, 'UP', 24, 22, true), trip(1, 'UP', 22, 1, true)];
    expect(serviceEnd({ trips: stops, blocks: [{ trips: [0, 1] }] } as unknown as Plan, stops[0])).toBe(22);
    const turn = [trip(0, 'UP', 24, 22, false), trip(1, 'DN', 22, 30, true)];
    expect(serviceEnd({ trips: turn, blocks: [{ trips: [0, 1] }] } as unknown as Plan, turn[0])).toBe(22);
  });
});
