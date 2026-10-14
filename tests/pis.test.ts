import { describe, expect, it } from 'vitest';
import { formatPisCountdown, selectPisFirstLast } from '../src/sim/pis';
import { STATIONS, STATION_EN } from '../src/data/line2';
import type { PisRow, TrackDir } from '../src/sim/model';

const train = (destination: string, eta = 36, status: PisRow['status'] = 'eta'): PisRow => ({
  destSt: STATIONS.findIndex((s) => s.id === destination),
  dest: STATIONS.find((s) => s.id === destination)?.name ?? '未知终点',
  eta, status, trip: 'test-1', load: .5,
});

describe('PIS countdown', () => {
  it('keeps an absent train distinct from a distant train', () => {
    expect(formatPisCountdown(undefined)).toBe('--:--');
    expect(formatPisCountdown(train('PDA', 4392))).toBe('预计大于1小时');
    expect(formatPisCountdown(train('PDA', 6000))).toBe('预计大于1小时');
  });

  it.each([
    [-10, '00:00'], [0, '00:00'], [36, '00:36'], [59.6, '01:00'],
    [3599, '59:59'], [3600, '60:00'], [3600.1, '预计大于1小时'],
  ])('formats the one-hour boundary and rounding (%s s)', (eta, expected) => {
    expect(formatPisCountdown(train('PDA', eta))).toBe(expected);
  });

  it.each(['at', 'arriving', 'departing'] as const)('shows zero for %s even with a stale ETA', (status) => {
    expect(formatPisCountdown(train('PDA', 7000, status))).toBe('00:00');
  });
});

describe('PIS published first / last times', () => {
  it('matches both eastbound rows photographed at Jiangsu Road', () => {
    expect(selectPisFirstLast('江苏路', 'DN', train('PDA'))).toEqual([
      { destination: '浦东1号2号航站楼', first: '05:52', last: '22:24' },
      { destination: '广兰路', first: '05:52', last: '23:09' },
    ]);
  });

  it('puts the first train to Guanglan Road first and uses lastG', () => {
    expect(selectPisFirstLast('江苏路', 'DN', train('GLL'))).toEqual([
      { destination: '广兰路', first: '05:52', last: '23:09' },
      { destination: '浦东1号2号航站楼', first: '05:52', last: '22:24' },
    ]);
  });

  it('uses the westbound column for Panxiang Road', () => {
    expect(selectPisFirstLast('金科路', 'UP', train('PXL'))).toEqual([
      { destination: '蟠祥路·国家会计学院', first: '05:31', last: '23:05' },
    ]);
  });

  it.each([
    ['世纪大道', 'DN', 'LYL', '06:11', '22:43', '浦东1号2号航站楼'],
    ['江苏路', 'UP', 'SHR', '05:44', '23:38', '蟠祥路·国家会计学院'],
  ] as const)('uses the directional full-route column for %s depot-bound service', (station, track, dest, first, last, destination) => {
    expect(selectPisFirstLast(station, track as TrackDir, train(dest))[0]).toEqual({ destination, first, last });
  });

  it('formats times past midnight as clock times', () => {
    expect(selectPisFirstLast('蟠祥路·国家会计学院', 'UP', train('PXL'))[0].last).toBe('00:05');
    expect(selectPisFirstLast('虹桥火车站', 'UP', train('PXL'))[0].last).toBe('00:00');
  });

  it('omits Guanglan Road where the official table has no such service', () => {
    expect(selectPisFirstLast('唐镇', 'DN', train('PDA'))).toEqual([
      { destination: '浦东1号2号航站楼', first: '06:04', last: '23:04' },
    ]);
  });

  it('uses the platform direction with no train, unknown destination or a terminating arrival', () => {
    const expected = selectPisFirstLast('江苏路', 'UP', train('PXL'));
    expect(selectPisFirstLast('江苏路', 'UP')).toEqual(expected);
    expect(selectPisFirstLast('江苏路', 'UP', train('unknown'))).toEqual(expected);
    expect(selectPisFirstLast('江苏路', 'UP', { ...train('GLL'), dest: '本站终到' })).toEqual(expected);
  });

  it('returns no invented schedule for an unknown station', () => {
    expect(selectPisFirstLast('未知车站', 'DN', train('PDA'))).toEqual([]);
  });

  it('uses the platform abbreviation for Panxiang Road English', () => {
    expect(STATION_EN.PXL).toBe('Panxiang Rd. • SNAI');
  });
});
