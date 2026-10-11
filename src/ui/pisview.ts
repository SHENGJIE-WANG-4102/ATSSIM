/** Platform passenger information display (PIS) preview for one station. */
import { h, clear } from './dom';
import type { PisData, PisRow } from '../sim/model';
import { STATIONS, DIRECTIONS } from '../data/line2';
import { fmtTime } from './theme';

function etaText(r: PisRow): string {
  if (r.status === 'at') return '列车已到站';
  if (r.status === 'departing') return '列车即将出发';
  if (r.status === 'arriving' || r.eta < 45) return '列车即将进站';
  return `${Math.max(1, Math.round(r.eta / 60))} 分钟`;
}

function loadText(f: number): string {
  if (f >= .9) return '拥挤';
  if (f > 0.75) return '较拥挤';
  return '舒适';
}

export function renderPis(el: HTMLElement, pis: PisData | null, t: number) {
  clear(el);
  if (!pis) { el.append(h('div', { class: 'hint' }, '等待数据…')); return; }
  const st = STATIONS[pis.station];
  const board = h('div', { class: 'pis' },
    h('div', { class: 'top' }, h('span', {}, `${st.name}站`), h('span', { style: 'font-family:var(--font-mono)' }, fmtTime(t, false))));
  for (const k of ['DN', 'UP'] as const) {
    const towards = k === 'DN' ? DIRECTIONS.DN.towards : DIRECTIONS.UP.towards;
    board.append(h('div', { class: 'dir' }, `${k === 'DN' ? '下行' : '上行'}站台 · ${towards}`));
    const rows = pis[k];
    if (!rows.length) {
      board.append(h('div', { class: 'row' }, h('span', {}, '今日运营已结束 / 暂无列车'), h('span', {})));
      continue;
    }
    rows.slice(0, 2).forEach((r, i) => {
      const arr = r.status !== 'eta' || r.eta < 45;
      board.append(h('div', { class: `row ${arr && i === 0 ? 'arr' : ''}` },
        h('span', {}, `${i === 0 ? '本次' : '下次'} ${r.dest === '本站终到' ? '终到列车 请勿上车' : `往 ${r.dest}`}`, h('span', { class: 'sub' }, r.dest === '本站终到' ? '' : loadText(r.load))),
        h('span', { class: 'eta' }, r.dwellRemaining !== undefined ? `${Math.ceil(r.dwellRemaining)} 秒发车` : etaText(r))));
    });
  }
  board.append(h('div', { class: 'notice' }, h('span', {}, pis.notice)));
  el.append(board);
}
