/** Scored run report (end of a scenario, or on demand from the instructor tab). */
import { h } from './dom';
import type { ScenarioReport } from '../sim/model';
import { fmtTime } from './theme';

const SAFETY: Record<keyof ScenarioReport['safety'], string> = {
  spad: '冒进信号', overspeed: '超速紧急制动', rmNearMiss: 'RM 接近危险', unsafeAuth: '不安全授权', espIgnored: '紧急停车未及时处置', overrun: '对标过标越站',
};

export function openReport(root: HTMLElement, r: ScenarioReport, onAgain?: () => void) {
  const back = h('div', { class: 'modal-back' });
  const close = () => back.remove();
  const card = (v: string, k: string, cls = '') => h('div', { class: `card ${cls}` }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));
  const safetyList = (Object.keys(SAFETY) as (keyof ScenarioReport['safety'])[]).filter((k) => r.safety[k] > 0);
  back.append(h('div', { class: 'modal wide report' },
    h('div', { class: 'modal-h' }, `评分报告 · ${r.title}`, h('span', { class: 'stepchip' }, `${fmtTime(r.from, false)}–${fmtTime(r.to, false)}`)),
    h('div', { class: 'modal-b' },
      h('div', { style: 'display:flex;align-items:baseline;gap:28px' }, h('span', { class: 'score' }, String(Math.round(r.score))), h('span', { class: 'grade' }, `等级 ${r.grade}`)),
      h('div', { class: 'grid4' },
        card(`${r.delayMinutes.toFixed(1)}`, '累计晚点（分钟）'),
        card(`${Math.round(r.affected)}`, '受影响乘客（人次）'),
        card(`${(r.delivery * 100).toFixed(1)}%`, `兑现率（${r.deliveredTrips}/${r.plannedTrips} 车次）`),
        card(`${r.safetyTotal}`, '安全违章', r.safetyTotal ? 'bad' : ''),
        card(`${(r.punctuality * 100).toFixed(1)}%`, '正点发车率（≤2分钟）'),
        card(`${r.callsAnswered} / ${r.callsAnswered + r.callsExpired}`, '来电应答'),
        card(r.driving ? `${r.driving.avgScore.toFixed(0)}` : '—', r.driving ? `人工驾驶对标（${r.driving.stops} 次，平均误差 ${r.driving.avgErr.toFixed(2)} m）` : '人工驾驶（未驾驶）'),
        card(`${r.score >= 90 ? 'A' : r.score >= 80 ? 'B' : r.score >= 65 ? 'C' : 'D'}`, '分级：A ≥ 90 · B ≥ 80 · C ≥ 65（有安全违章最高 C）'),
      ),
      safetyList.length ? h('div', {}, h('div', { class: 'sect-title' }, '安全违章明细'), h('ul', {}, ...safetyList.map((k) => h('li', {}, `${SAFETY[k]} × ${r.safety[k]}`)))) : null,
      r.notes.length ? h('div', {}, h('div', { class: 'sect-title' }, '评语'), h('ul', {}, ...r.notes.map((n) => h('li', {}, n)))) : null,
    ),
    h('div', { class: 'modal-f' },
      onAgain ? h('button', { class: 'btn', onclick: () => { close(); onAgain(); } }, '再练一次') : null,
      h('button', { class: 'btn primary', onclick: close }, '关闭')),
  ));
  root.append(back);
}
