/**
 * Platform passenger information display (PIS), laid out like the Line 2
 * platform screens: a media area on the left with the scrolling notice bar
 * beneath it, and three boxes on the right — the first train's countdown
 * (always shown), the second and third trains in turn every 20 s, and the
 * clock/date and the station name in turn every 3 s.
 *
 * The board is updated in place: rebuilding it on every snapshot restarted
 * the notice ticker, which then only ever showed its first half glyph. A box
 * whose content turns to another train (the first one left, the 2nd / 3rd
 * rotation) or to the other info page pushes the old content out to the left
 * while the new one comes in from the right.
 */
import { h, clear } from './dom';
import type { PisData, PisRow, TrackDir } from '../sim/model';
import { STATIONS, STATION_EN, DIRECTIONS } from '../data/line2';
import metroLogo from './assets/metro-logo.png';
import lineBadge from './assets/line2-badge.png';

const ORD = ['1st', '2nd', '3rd'];
const ORD_CN = ['第一班列车', '第二班列车', '第三班列车'];
const pad = (n: number) => String(n).padStart(2, '0');

/** countdown as mm:ss (00:00 once the train is in the platform) */
function countdown(r: PisRow | undefined): string {
  if (!r) return '--:--';
  if (r.status !== 'eta') return '00:00';
  const s = Math.max(0, Math.round(r.eta));
  return s >= 6000 ? '--:--' : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function loadText(f: number): string {
  if (f >= .9) return '拥挤';
  if (f > 0.75) return '较拥挤';
  return '舒适';
}

/** calendar date of sim time t (t may run past midnight) from the day label */
function dateOf(label: string, t: number): string {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(label);
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + Math.floor(t / 86400)));
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

interface Box { el: HTMLElement; title: HTMLElement; digits: HTMLElement; dest: HTMLElement; to: HTMLElement; toEn: HTMLElement; key: string }
interface Board {
  station: number; track: TrackDir; root: HTMLElement;
  load: HTMLElement; ticker: HTMLElement; tickerText: string;
  b1: Box; b2: Box; b3: HTMLElement;
  rows: PisRow[]; t: number; dateLabel: string;
  /** passed by every train; next planned departure; a departure already went */
  skip: boolean; next?: number; done: boolean; ahead: number;
}

function mkBox(): Box {
  const title = h('div', { class: 'pb-title' });
  const digits = h('div', { class: 'pb-digits' });
  const to = h('div', { class: 'pb-to' });
  const toEn = h('div', { class: 'pb-to-en' });
  const dest = h('div', { class: 'pb-dest' }, to, toEn);
  return { el: h('div', { class: 'pb' }, title, digits, dest), title, digits, dest, to, toEn, key: '' };
}

const SLIDE: KeyframeAnimationOptions = { duration: 520, easing: 'cubic-bezier(.45,0,.25,1)' };

/**
 * Change the content of `els` (children of one box) with `fill`: a copy of
 * the old content leaves to the left over the new content entering from the
 * right. `fill` returns the new elements when it replaces `els` instead of
 * updating them in place.
 */
function slide(els: HTMLElement[], fill: () => HTMLElement[] | void) {
  const ghosts = els.filter((e) => typeof e.animate === 'function' && e.offsetWidth > 0).map((e) => {
    const g = e.cloneNode(true) as HTMLElement;
    g.classList.add('pis-ghost');
    Object.assign(g.style, {
      position: 'absolute', left: `${e.offsetLeft}px`, top: `${e.offsetTop}px`, width: `${e.offsetWidth}px`, height: `${e.offsetHeight}px`,
      margin: '0', pointerEvents: 'none',
    });
    e.parentElement!.append(g);
    // measured now: `fill` may take `e` out of the page. Clear of the box: its own right edge past the box's left edge
    return { g, out: e.offsetLeft + e.offsetWidth + 4 };
  });
  const fresh = fill() ?? els;
  for (const { g, out } of ghosts) {
    // held off-box at the end and removed then: on the animation's own clock, so it never vanishes mid-slide
    const a = g.animate([{ transform: 'none' }, { transform: `translateX(${-out}px)` }], { ...SLIDE, fill: 'forwards' });
    a.onfinish = a.oncancel = () => g.remove();
  }
  if (!ghosts.length) return;
  for (const e of fresh) {
    if (typeof e.animate !== 'function') continue;
    // in from just past the box's right edge (offsets are within the positioned box)
    const from = (e.offsetParent as HTMLElement | null)?.clientWidth ?? e.offsetWidth;
    e.animate([{ transform: `translateX(${from - e.offsetLeft + 4}px)` }, { transform: 'none' }], SLIDE);
  }
}

const hhmm = (t: number) => { const d = ((t % 86400) + 86400) % 86400; return `${pad(Math.floor(d / 3600))}:${pad(Math.floor(d % 3600 / 60))}`; };

/** what box `k` of an empty board says, from the plan: passed by every train,
 *  the next (or first) planned departure, or the last one gone */
function emptyText(bd: Board, k: number): [string, string] {
  if (bd.skip) return ['本站列车通过不停车', 'Trains will not stop at this station'];
  if (k > 0) return bd.ahead <= k ? ['今日无后续列车', 'No further trains today'] : ['暂无列车信息', ''];
  if (bd.next !== undefined) return bd.done ? [`下一班列车 ${hhmm(bd.next)}`, `Next train ${hhmm(bd.next)}`] : [`首班车 ${hhmm(bd.next)}`, `First train ${hhmm(bd.next)}`];
  return bd.done ? ['今日末班车已开出', 'The last train has left'] : ['暂无列车信息', ''];
}

function fillBox(b: Box, k: number, r: PisRow | undefined, empty: [string, string]) {
  const key = `${k}|${r?.trip ?? ''}|${r?.dest ?? ''}|${r ? '' : empty[0]}`;
  if (b.key && key !== b.key) {
    const els = [...(b.key.startsWith(`${k}|`) ? [] : [b.title]), b.digits, b.dest];
    b.key = key;
    slide(els, () => fillBox(b, k, r, empty));
    return;
  }
  b.key = key;
  b.title.textContent = `${ORD_CN[k]}(${ORD[k]})`;
  b.digits.textContent = countdown(r);
  b.el.classList.toggle('arr', !!r && r.status !== 'eta');
  if (!r) { [b.to.textContent, b.toEn.textContent] = empty; return; }
  if (r.dest === '本站终到') { b.to.textContent = '终到列车 请勿上车'; b.toEn.textContent = 'Terminating train, please do not board'; return; }
  if (r.noBoard) { b.to.textContent = `本次列车只下不上（往${r.dest}）`; b.toEn.textContent = 'Alighting only, please do not board'; return; }
  b.to.innerHTML = '';
  b.to.append(h('span', {}, '开往'), h('span', {}, r.dest));
  b.toEn.textContent = r.destSt >= 0 ? `To  ${STATION_EN[STATIONS[r.destSt].id] ?? ''}` : '';
}

function update(bd: Board) {
  const now = performance.now();
  const { rows } = bd;
  fillBox(bd.b1, 0, rows[0], emptyText(bd, 0));
  const k = Math.floor(now / 20000) % 2 === 0 || rows.length < 3 ? 1 : 2;
  fillBox(bd.b2, k, rows[k], emptyText(bd, k));
  // clock / station name, 3 s each
  const showClock = Math.floor(now / 3000) % 2 === 0;
  const want = showClock ? `clock` : `name`;
  if (bd.b3.dataset.mode !== want) {
    const old = infoContent(bd);
    bd.b3.dataset.mode = want;
    if (old.length) { slide(old, () => { for (const e of old) e.remove(); fillInfo(bd, showClock); return infoContent(bd); }); return void fillLoad(bd); }
  }
  fillInfo(bd, showClock);
  fillLoad(bd);
}

/** what the info box shows, without the copies still sliding out */
function infoContent(bd: Board): HTMLElement[] {
  return (Array.from(bd.b3.children) as HTMLElement[]).filter((e) => !e.classList.contains('pis-ghost'));
}

/** the clock / station-name box */
function fillInfo(bd: Board, showClock: boolean) {
  const { t } = bd;
  const st = STATIONS[bd.station];
  if (showClock) {
    const tod = t % 86400;
    const txt = `${pad(Math.floor(tod / 3600))}:${pad(Math.floor(tod % 3600 / 60))}`;
    // clock and date share a baseline; the row itself is centred in the box
    if (!infoContent(bd).length) bd.b3.append(h('div', { class: 'pb-clockrow' }, h('span', { class: 'pb-clock' }), h('span', { class: 'pb-date' })));
    const row = infoContent(bd)[0];
    (row.children[0] as HTMLElement).textContent = txt;
    (row.children[1] as HTMLElement).textContent = dateOf(bd.dateLabel, t);
  } else if (!infoContent(bd).length) {
    bd.b3.append(h('div', { class: 'pb-st' }, st.name), h('div', { class: 'pb-st-en' }, STATION_EN[st.id] ?? ''));
  }
}

function fillLoad(bd: Board) {
  const r = bd.rows[0];
  bd.load.textContent = r && r.dest !== '本站终到' ? `下一班列车 车厢${loadText(r.load)}` : '';
}

function build(station: number, track: TrackDir): Board {
  const s = STATIONS[station];
  const towards = DIRECTIONS[track].towards;
  // the stations still ahead in this direction
  const step = track === 'DN' ? 1 : -1;
  const ahead: number[] = [];
  for (let i = station; i >= 0 && i < STATIONS.length && ahead.length < 7; i += step) ahead.push(i);
  const strip = h('div', { class: 'pm-strip' }, ...ahead.map((i, n) => h('div', { class: `pm-stop${n === 0 ? ' here' : ''}` },
    h('i'), h('span', {}, STATIONS[i].name))));
  const load = h('div', { class: 'pm-load' });
  const media = h('div', { class: 'pis-media' },
    h('div', { class: 'pm-head' }, h('img', { src: metroLogo, alt: '' }), h('img', { src: lineBadge, alt: '2号线' }), h('span', {}, `${track === 'DN' ? '下行' : '上行'}站台`)),
    h('div', { class: 'pm-name' }, s.name), h('div', { class: 'pm-towards' }, towards), strip, load);
  const ticker = h('div', { class: 'pis-ticker' });
  const bar = h('div', { class: 'pis-bar' }, h('img', { src: lineBadge, alt: '' }), ticker);
  const b1 = mkBox(), b2 = mkBox();
  const b3 = h('div', { class: 'pb pb-info' });
  const root = h('div', { class: 'pis2' }, media, bar, h('div', { class: 'pis-side' }, b1.el, b2.el, b3));
  return { station, track, root, load, ticker, tickerText: '', b1, b2, b3, rows: [], t: 0, dateLabel: '', skip: false, done: false, ahead: 0 };
}

const boards = new WeakMap<HTMLElement, { key: string; list: Board[]; timer: number }>();

/**
 * Render (or update) the PIS boards for a station — both platforms, or only
 * `track` — into `el`.
 */
export function renderPis(el: HTMLElement, pis: PisData | null, t: number, dateLabel = '', track?: TrackDir) {
  if (!pis) { boards.delete(el); clear(el); el.append(h('div', { class: 'hint' }, '等待数据…')); return; }
  const key = `${pis.station}:${track ?? '*'}`;
  let cur = boards.get(el);
  if (!cur || cur.key !== key) {
    if (cur) clearInterval(cur.timer);
    clear(el);
    const list = (track ? [track] : ['DN', 'UP'] as TrackDir[]).map((k) => build(pis.station, k));
    for (const b of list) el.append(b.root);
    const timer = window.setInterval(() => {
      if (!el.isConnected) { clearInterval(timer); boards.delete(el); return; }
      for (const b of list) update(b);
    }, 250);
    cur = { key, list, timer };
    boards.set(el, cur);
  }
  for (const b of cur.list) {
    b.rows = pis[b.track]; b.t = t; b.dateLabel = dateLabel;
    b.skip = !!pis.skip?.[b.track]; b.next = pis.next?.[b.track]; b.done = !!pis.done?.[b.track]; b.ahead = pis.ahead?.[b.track] ?? 0;
    if (b.tickerText !== pis.notice) {
      b.tickerText = pis.notice;
      clear(b.ticker);
      b.ticker.append(h('span', {}, pis.notice));
    }
    update(b);
  }
}
