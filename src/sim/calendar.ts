/** Operating-day calendar helpers shared by the UI and the worker. */
import type { DayType } from './model';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

export function dayTypeOf(d: Date, holiday: boolean): DayType {
  const wd = d.getDay();
  return holiday || wd === 0 || wd === 6 ? 'weekend' : 'weekday';
}

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dateLabel(d: Date, holiday: boolean): string {
  const s = `${isoDate(d)} 星期${WEEK[d.getDay()]}`;
  return holiday ? `${s}（节假日）` : s;
}

export function parseIso(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** "HH:MM" (00–27 h) in seconds of the operating day, NaN if it is not a time */
export function parseTime(v: string): number {
  const m = /^\s*(\d{1,2})(?::(\d{1,2}))?\s*$/.exec(v);
  if (!m) return NaN;
  const hh = Number(m[1]), mm = Number(m[2] ?? 0);
  if (hh > 27 || mm > 59) return NaN;
  // before 04:00 belongs to the night after the operating day
  const t = hh * 3600 + mm * 60;
  return t < 4 * 3600 ? t + 86400 : t;
}
