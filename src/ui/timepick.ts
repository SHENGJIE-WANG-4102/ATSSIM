/**
 * Time and date pickers: a field showing the value that opens a small panel,
 * hour : minute drop-downs for a time of the operating day (04:00 to 03:59
 * the next morning), a month calendar for a date, each with 取消 / 确定.
 * The panel is placed in #overlay (the header and dialogs clip their
 * overflow) at the field's position in overlay coordinates (the overlay is
 * scaled with the UI scale).
 */
import { h } from './dom';
import { dayTypeOf, holidayOf, isoDate } from '../sim/calendar';

const pad = (n: number) => String(n).padStart(2, '0');
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

let openPanel: { el: HTMLElement; close(): void } | null = null;

function closeOpen() {
  openPanel?.close();
}
document.addEventListener('pointerdown', (e) => {
  if (openPanel && !openPanel.el.contains(e.target as Node)) closeOpen();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openPanel) { e.stopPropagation(); closeOpen(); } }, true);

/** open `panel` under (or above) `field`, inside #overlay */
function popup(field: HTMLElement, panel: HTMLElement) {
  closeOpen();
  const root = document.getElementById('overlay') ?? document.body;
  panel.classList.add('tp-panel');
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());
  root.append(panel);
  const or = root.getBoundingClientRect();
  const k = root.offsetWidth ? or.width / root.offsetWidth : 1;
  const fr = field.getBoundingClientRect();
  const W = root.offsetWidth, H = root.offsetHeight;
  const pw = panel.offsetWidth, ph = panel.offsetHeight;
  let x = (fr.left - or.left) / k;
  let y = (fr.bottom - or.top) / k + 6;
  if (y + ph > H - 8) y = (fr.top - or.top) / k - ph - 6;
  x = Math.max(8, Math.min(W - pw - 8, x));
  y = Math.max(8, y);
  panel.style.left = `${x}px`;
  panel.style.top = `${y}px`;
  field.classList.add('on');
  const entry = {
    el: panel,
    close: () => { panel.remove(); field.classList.remove('on'); if (openPanel === entry) openPanel = null; },
  };
  openPanel = entry;
  return entry;
}

function footer(cancel: () => void, ok: () => void) {
  return h('div', { class: 'tp-foot' },
    h('button', { class: 'btn', onclick: cancel }, '取消'),
    h('button', { class: 'btn primary', onclick: ok }, '确定'));
}

export interface TimePick {
  el: HTMLElement;
  /** seconds of the operating day (times before 04:00 belong to the next morning) */
  sec(): number;
  /** HH:MM */
  text(): string;
  set(sec: number): void;
}

/** a time of the operating day; minutes in `step`-minute steps, a value set between them rounds up */
export function timePick(sec: number, step = 5, onchange?: () => void): TimePick {
  let m = 0; // minutes past midnight
  const field = h('button', { class: 'tp-field' }) as HTMLButtonElement;
  const show = () => { field.textContent = `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
  const set = (s: number) => {
    const x = Math.ceil(Math.round(s / 60) / step) * step;
    m = ((x % 1440) + 1440) % 1440;
    show();
  };
  set(sec);
  field.onclick = (e) => {
    e.stopPropagation();
    if (openPanel && field.classList.contains('on')) { closeOpen(); return; }
    // hours in operating-day order: 04 … 23, 00 … 03
    const hh = h('select', { title: '时' }, ...[...Array(24).keys()].map((i) => (i + 4) % 24).map((x) => h('option', { value: x }, pad(x)))) as HTMLSelectElement;
    const mm = h('select', { title: '分' }, ...[...Array(60 / step).keys()].map((i) => h('option', { value: i * step }, pad(i * step)))) as HTMLSelectElement;
    hh.value = String(Math.floor(m / 60));
    mm.value = String(m % 60);
    const p = popup(field, h('div', {},
      h('div', { class: 'tp-time' }, hh, h('span', { class: 'tp-sep' }, ':'), mm),
      footer(() => p.close(), () => {
        m = Number(hh.value) * 60 + Number(mm.value);
        show();
        p.close();
        onchange?.();
      })));
  };
  const value = () => {
    const x = m * 60;
    return x < 4 * 3600 ? x + 86400 : x;
  };
  return { el: field, sec: value, text: () => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`, set };
}

export interface DatePick {
  el: HTMLElement;
  /** YYYY-MM-DD */
  iso(): string;
}

/** a date from a month calendar; weekends and the National Day holiday are marked */
export function datePick(d: Date, onchange?: () => void): DatePick {
  let cur = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const field = h('button', { class: 'tp-field' }) as HTMLButtonElement;
  const show = () => { field.textContent = `${isoDate(cur)} 周${WEEK[cur.getDay()]}`; };
  show();
  field.onclick = (e) => {
    e.stopPropagation();
    if (openPanel && field.classList.contains('on')) { closeOpen(); return; }
    let pick = new Date(cur);
    let month = new Date(cur.getFullYear(), cur.getMonth(), 1);
    const today = isoDate(new Date());
    const title = h('div', { class: 'tp-month' });
    const grid = h('div', { class: 'tp-grid' });
    const draw = () => {
      title.textContent = `${month.getFullYear()}年${month.getMonth() + 1}月`;
      grid.replaceChildren(...WEEK.map((w, i) => h('div', { class: `tp-wd ${i === 0 || i === 6 ? 'we' : ''}` }, w)));
      const first = new Date(month);
      first.setDate(1 - first.getDay());
      for (let i = 0; i < 42; i++) {
        const day = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
        const iso = isoDate(day);
        const cls = ['tp-day'];
        if (day.getMonth() !== month.getMonth()) cls.push('out');
        if (holidayOf(iso) && holidayOf(iso)!.day > 0) cls.push('hol');
        else if (dayTypeOf(day, false) !== 'weekday') cls.push('we');
        if (iso === today) cls.push('today');
        if (iso === isoDate(pick)) cls.push('sel');
        grid.append(h('button', {
          class: cls.join(' '), title: holidayOf(iso) ? (holidayOf(iso)!.day === 0 ? '国庆前夜' : `国庆第${holidayOf(iso)!.day}天`) : '',
          onclick: () => { pick = day; if (day.getMonth() !== month.getMonth()) month = new Date(day.getFullYear(), day.getMonth(), 1); draw(); },
        }, String(day.getDate())));
      }
    };
    const nav = (dm: number) => { month = new Date(month.getFullYear(), month.getMonth() + dm, 1); draw(); };
    draw();
    const p = popup(field, h('div', {},
      h('div', { class: 'tp-head' },
        h('button', { class: 'btn icon', onclick: () => nav(-1) }, '‹'), title,
        h('button', { class: 'btn icon', onclick: () => nav(1) }, '›')),
      grid,
      footer(() => p.close(), () => { cur = pick; show(); p.close(); onchange?.(); })));
  };
  return { el: field, iso: () => isoDate(cur) };
}
