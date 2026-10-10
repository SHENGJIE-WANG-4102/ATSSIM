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
