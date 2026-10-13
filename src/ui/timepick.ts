/**
 * Time and date pickers made of drop-downs instead of typed text: hour and
 * minute for a time of the operating day (04:00 to 03:59 the next morning),
 * year, month and day for a date. Kept narrow so a form row stays on one line.
 */
import { h } from './dom';

const pad = (n: number) => String(n).padStart(2, '0');

export interface TimePick {
  el: HTMLElement;
  /** seconds of the operating day (times before 04:00 belong to the next morning) */
  sec(): number;
  /** HH:MM */
  text(): string;
  set(sec: number): void;
}

/** hour and minute drop-downs; minutes in `step`-minute steps, a value set between them rounds up */
export function timePick(sec: number, step = 5, onchange?: () => void): TimePick {
  const hours = [...Array(24).keys()].map((i) => (i + 4) % 24);
  const hh = h('select', { class: 'tp', title: '时' }, ...hours.map((x) => h('option', { value: x }, pad(x)))) as HTMLSelectElement;
  const mm = h('select', { class: 'tp', title: '分' }, ...[...Array(60 / step).keys()].map((i) => h('option', { value: i * step }, pad(i * step)))) as HTMLSelectElement;
  const set = (s: number) => {
    let m = Math.ceil(Math.round(s / 60) / step) * step;
    m = ((m % 1440) + 1440) % 1440;
    hh.value = String(Math.floor(m / 60));
    mm.value = String(m % 60);
  };
  set(sec);
  if (onchange) { hh.onchange = onchange; mm.onchange = onchange; }
  const el = h('span', { class: 'tpick' }, hh, h('span', { class: 'tp-sep' }, ':'), mm);
  const value = () => {
    const x = Number(hh.value) * 3600 + Number(mm.value) * 60;
    return x < 4 * 3600 ? x + 86400 : x;
  };
  return { el, sec: value, text: () => `${pad(Number(hh.value))}:${mm.value.padStart(2, '0')}`, set };
}

export interface DatePick {
  el: HTMLElement;
  /** YYYY-MM-DD */
  iso(): string;
}

/** year, month and day drop-downs around `d` */
export function datePick(d: Date, onchange?: () => void): DatePick {
  const y0 = d.getFullYear();
  const yy = h('select', { class: 'tp', title: '年' }, ...[y0 - 1, y0, y0 + 1].map((y) => h('option', { value: y }, `${y}年`))) as HTMLSelectElement;
  const mo = h('select', { class: 'tp', title: '月' }, ...[...Array(12).keys()].map((i) => h('option', { value: i + 1 }, `${i + 1}月`))) as HTMLSelectElement;
  const dd = h('select', { class: 'tp', title: '日' }) as HTMLSelectElement;
  const fillDays = () => {
    const n = new Date(Number(yy.value), Number(mo.value), 0).getDate();
    const keep = Math.min(Number(dd.value) || d.getDate(), n);
    dd.replaceChildren(...[...Array(n).keys()].map((i) => h('option', { value: i + 1 }, `${i + 1}日`)));
    dd.value = String(keep);
  };
  yy.value = String(y0);
  mo.value = String(d.getMonth() + 1);
  fillDays();
  dd.value = String(d.getDate());
  yy.onchange = mo.onchange = () => { fillDays(); onchange?.(); };
  dd.onchange = () => onchange?.();
  const el = h('span', { class: 'tpick' }, yy, mo, dd);
  return { el, iso: () => `${yy.value}-${pad(Number(mo.value))}-${pad(Number(dd.value))}` };
}
