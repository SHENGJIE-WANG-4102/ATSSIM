/** Top status bar: clock, simulation speed, system level per ZC zone, KPIs, alarm counters. */
import { h, clear } from './dom';
import type { Store } from './store';
import { fmtTime } from './theme';

const SPEEDS = [1, 2, 5, 10, 30, 60, 120];
export { dayTypeOf, dateLabel } from '../sim/calendar';

export class Header {
  el: HTMLElement;
  private clock = h('div', { class: 'clock' }, '--:--:--');
  private date = h('div', {});
  private period = h('div', { class: 'period' });
  private speedBtns: HTMLButtonElement[] = [];
  private pauseBtn: HTMLButtonElement;
  private zones = h('div', { style: 'display:flex;gap:6px' });
  private kpis = h('div', { style: 'display:flex;gap:18px;align-items:center' });
  private alarmCnt = h('div', { class: 'alarm-counter' });
  private store: Store;
  private speed = 1;
  private paused = false;

  constructor(store: Store, onRestart: () => void) {
    this.store = store;
    this.pauseBtn = h('button', { class: 'btn', title: '暂停/继续 (空格)', onclick: () => this.setPaused(!this.paused) }, '❚❚');
    for (const s of SPEEDS) {
      const b = h('button', { class: `btn ${s === 1 ? 'on' : ''}`, onclick: () => this.setSpeed(s) }, `${s}×`);
      this.speedBtns.push(b);
    }
    const jumpInput = h('input', { type: 'text', pattern: '[0-2][0-9]:[0-5][0-9]', maxlength: 5, value: '07:30', style: 'width:100px' }) as HTMLInputElement;
    const jumpBtn = h('button', {
      class: 'btn', title: '以最高速度推演到指定时刻',
      onclick: () => {
        const [hh, mm] = jumpInput.value.split(':').map(Number);
        let target = hh * 3600 + mm * 60;
        const now = this.store.snap?.t ?? 0;
        if (target < 4 * 3600) target += 86400;
        while (target < now) target += 86400;
        if (target > 28 * 3600) return;
        this.store.send({ type: 'jump', to: target });
      },
    }, '快进至');
    this.el = h('div', { class: 'hdr' },
      h('div', { class: 'hdr-brand' },
        h('div', { class: 'line-badge' }, '2'),
        h('div', {}, h('div', { class: 'hdr-title' }, '上海轨道交通2号线 · ATS 中央监视'), h('div', { class: 'hdr-sub' }, 'OCC 行车调度 · 蟠祥路·国家会计学院 — 浦东1号2号航站楼 · CBTC 主用 / TBTC 后备')),
      ),
      h('div', { class: 'hdr-clock' }, this.clock, h('div', { class: 'clock-meta' }, this.date, this.period)),
      h('div', { class: 'hdr-speed' }, h('span', { class: 'lbl' }, '仿真速率'), this.pauseBtn, ...this.speedBtns, h('span', { style: 'width:14px' }), jumpInput, jumpBtn,
        h('button', { class: 'btn', title: '重新开始/选择日期', onclick: onRestart }, '运营日…')),
      h('div', { class: 'hdr-status' }, this.zones, this.kpis, this.alarmCnt),
    );
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); this.setPaused(!this.paused); }
      if (e.key === '+' || e.key === '=') this.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(this.speed) + 1)]);
      if (e.key === '-') this.setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(this.speed) - 1)]);
    });
    store.on('snap', () => this.update());
    store.on('alarms', () => this.updateAlarms());
  }

  setSpeed(s: number) {
    this.speed = s;
    this.store.send({ type: 'speed', speed: s });
    this.speedBtns.forEach((b, i) => b.classList.toggle('on', SPEEDS[i] === s));
  }
  setPaused(p: boolean) {
    this.paused = p;
    this.store.send({ type: 'pause', paused: p });
    this.pauseBtn.classList.toggle('on', p);
    this.pauseBtn.textContent = p ? '▶' : '❚❚';
  }

  private lastZones = '';
  update() {
    const s = this.store.snap;
    if (!s) return;
    this.clock.textContent = fmtTime(s.t);
    const dt = s.dayType === 'weekday' ? '工作日运行图' : '双休日/节假日运行图';
    this.date.textContent = `${s.dateLabel} · ${dt}`;
    const plan = this.store.plan;
    if (plan) {
      const p = plan.periods.find((x) => s.t >= x.from && s.t < x.to);
      const ov = plan.overlays.filter((o) => s.t >= o.from && s.t <= o.to).map((o) => o.label);
      this.period.textContent = `当前时段：${p?.label ?? '—'}${ov.length ? ' + ' + ov.join('、') : ''}`;
    }
    const zk = s.zones.join(',');
    if (zk !== this.lastZones) {
      this.lastZones = zk;
      clear(this.zones);
      s.zones.forEach((z, i) => {
        const name = this.store.topo.zones[i].key;
        this.zones.append(h('div', { class: `zone-chip ${z}`, title: this.store.topo.zones[i].name, onclick: () => this.store.select({ kind: 'zone', id: i }), style: 'cursor:pointer' },
          h('span', { class: 'z' }, name), h('span', { class: 'lv' }, z === 'ZCFAIL' ? 'ZC故障' : z)));
      });
    }
    const st = s.stats;
    clear(this.kpis);
    const kpi = (v: string, k: string, cls = '') => h('div', { class: `kpi ${cls}` }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));
    this.kpis.append(
      kpi(String(st.online), '在线列车'),
      kpi(String(st.inService), '载客运营'),
      kpi(String(st.late), '晚点>2分', st.late > 0 ? 'warn' : ''),
      kpi(`${(st.punctuality * 100).toFixed(1)}%`, '正点率', st.punctuality < 0.98 ? 'warn' : ''),
      kpi(`${st.tripsDone}/${st.tripsPlanned}`, '完成车次'),
      kpi(st.passengers.toLocaleString('en-US'), '累计上车客流'),
    );
  }

  updateAlarms() {
    const cnt = { A: 0, B: 0, C: 0 };
    const unack = { A: false, B: false, C: false };
    for (const a of this.store.alarms) {
      if (a.level === 'I') continue;
      cnt[a.level]++;
      if (!a.ack) unack[a.level] = true;
    }
    clear(this.alarmCnt);
    for (const l of ['A', 'B', 'C'] as const) {
      this.alarmCnt.append(h('span', { class: `${l} ${unack[l] && l === 'A' ? 'active' : ''}`, title: `${l}级报警` }, String(cnt[l])));
    }
  }
}
