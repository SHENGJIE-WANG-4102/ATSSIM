/** Top status bar: clock, simulation speed, system level per ZC zone, KPIs, alarm counters, UI scale, sound, help. */
import { h, clear } from './dom';
import type { Store } from './store';
import { fmtTime } from './theme';
import { UI_SCALES } from './layout';
import metroLogo from './assets/metro-logo.png';
import lineBadge from './assets/line2-badge.png';

export const SPEEDS = [1, 2, 5, 10, 30, 60, 120];
export { dayTypeOf, dateLabel } from '../sim/calendar';

export interface HeaderHooks {
  restart(): void;
  scale(): number;
  setScale(v: number): void;
  muted(): boolean;
  setMuted(m: boolean): void;
  help(): void;
}

export class Header {
  el: HTMLElement;
  private clock = h('div', { class: 'clock' }, '--:--:--');
  private date = h('div', {});
  private period = h('div', { class: 'period' });
  private speedBtns: HTMLButtonElement[] = [];
  private pauseBtn: HTMLButtonElement;
  private zones = h('div', { style: 'display:flex;gap:8px' });
  private kpis = h('div', { style: 'display:flex;gap:22px;align-items:center' });
  private alarmCnt = h('div', { class: 'alarm-counter' });
  private scaleV = h('span', { class: 'v' });
  private muteBtn: HTMLButtonElement;
  private store: Store;
  private hooks: HeaderHooks;
  speed = 1;
  paused = false;

  constructor(store: Store, hooks: HeaderHooks) {
    this.store = store;
    this.hooks = hooks;
    this.pauseBtn = h('button', { class: 'btn icon', title: '暂停/继续（空格）', onclick: () => this.setPaused(!this.paused) }, '❚❚');
    for (const s of SPEEDS) {
      const b = h('button', { class: `btn ${s === 1 ? 'on' : ''}`, title: `仿真速率 ${s}×`, onclick: () => this.setSpeed(s) }, `${s}×`);
      this.speedBtns.push(b);
    }
    const jumpInput = h('input', { type: 'text', maxlength: 5, value: '17:30', style: 'width:118px', title: '目标时刻 HH:MM' }) as HTMLInputElement;
    const jumpBtn = h('button', {
      class: 'btn', title: '以最高速度推演到指定时刻',
      onclick: () => {
        const [hh, mm] = jumpInput.value.split(':').map(Number);
        let target = (hh || 0) * 3600 + (mm || 0) * 60;
        const now = this.store.snap?.t ?? 0;
        if (target < 4 * 3600) target += 86400;
        while (target < now) target += 86400;
        if (target > 27.7 * 3600) return;
        this.store.send({ type: 'jump', to: target });
      },
    }, '快进至');
    this.muteBtn = h('button', { class: 'btn icon', title: '声音（M）', onclick: () => this.hooks.setMuted(!this.hooks.muted()) }, '🔊');
    this.el = h('div', { class: 'hdr' },
      h('div', { class: 'hdr-brand' },
        h('img', { class: 'metro-logo', src: metroLogo, alt: '上海地铁' }),
        h('img', { class: 'line-badge', src: lineBadge, alt: '2号线 Line 2' }),
        h('div', {}, h('div', { class: 'hdr-title' }, 'ATS 中央监视'), h('div', { class: 'hdr-sub' }, 'OCC 行车调度 · CBTC 主用 / TBTC 后备')),
      ),
      h('div', {}, this.clock, h('div', { class: 'clock-meta' }, this.date, this.period)),
      h('div', {}, h('span', { class: 'lbl' }, '速率'), this.pauseBtn, ...this.speedBtns, jumpInput, jumpBtn,
        h('button', { class: 'btn', title: '重新开始/选择日期', onclick: () => this.hooks.restart() }, '运营日…')),
      h('div', { class: 'hdr-status' }, this.zones, this.kpis, this.alarmCnt),
      h('div', { class: 'scale-ctl' },
        h('span', { class: 'lbl' }, '界面'),
        h('button', { class: 'btn icon', title: '缩小界面（Ctrl −）', onclick: () => this.stepScale(-1) }, 'A−'),
        this.scaleV,
        h('button', { class: 'btn icon', title: '放大界面（Ctrl +）', onclick: () => this.stepScale(1) }, 'A+'),
        this.muteBtn,
        h('button', { class: 'btn', title: '导出种子、运行图、命令及状态供回放', onclick: () => store.send({ type: 'diagnostics' }) }, '诊断导出'),
        h('button', { class: 'btn icon', title: '帮助（F1）', onclick: () => this.hooks.help() }, '?'),
      ),
    );
    store.on('snap', () => this.update());
    store.on('alarms', () => this.updateAlarms());
    this.refreshScale();
  }

  stepScale(d: number) {
    const cur = this.hooks.scale();
    let i = UI_SCALES.findIndex((s) => Math.abs(s - cur) < 1e-3);
    if (i < 0) i = UI_SCALES.indexOf(1);
    i = Math.max(0, Math.min(UI_SCALES.length - 1, i + d));
    this.hooks.setScale(UI_SCALES[i]);
    this.refreshScale();
  }

  refreshScale() {
    this.scaleV.textContent = `${Math.round(this.hooks.scale() * 100)}%`;
    this.muteBtn.textContent = this.hooks.muted() ? '🔇' : '🔊';
    this.muteBtn.classList.toggle('on', !this.hooks.muted());
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
  private lastKpi = '';
  update() {
    const s = this.store.snap;
    if (!s) return;
    this.clock.textContent = fmtTime(s.t);
    const dt = s.dayType === 'weekday' ? '工作日图' : '双休日/节假日图';
    this.date.textContent = `${s.dateLabel} · ${dt}`;
    const plan = this.store.plan;
    if (plan) {
      const p = plan.periods.find((x) => s.t >= x.from && s.t < x.to);
      const ov = plan.overlays.filter((o) => s.t >= o.from && s.t <= o.to).map((o) => o.label);
      const txt = `${p?.label ?? '—'}${ov.length ? ' + ' + ov.join('、') : ''}${s.scenario && !s.scenario.ended ? ` · 场景：${s.scenario.name}` : ''}`;
      if (this.period.textContent !== txt) this.period.textContent = txt;
    }
    const zk = s.zones.join(',');
    if (zk !== this.lastZones) {
      this.lastZones = zk;
      clear(this.zones);
      s.zones.forEach((z, i) => {
        const name = this.store.topo.zones[i].key;
        this.zones.append(h('div', { class: `zone-chip ${z}`, title: this.store.topo.zones[i].name, onclick: () => this.store.select({ kind: 'zone', id: i }) },
          h('span', { class: 'z' }, name), h('span', { class: 'lv' }, z === 'ZCFAIL' ? '故障' : z)));
      });
    }
    const st = s.stats;
    const key = `${st.online}|${st.inService}|${st.late}|${st.punctuality.toFixed(3)}|${st.tripsDone}|${st.tripsPlanned}`;
    if (key === this.lastKpi) return;
    this.lastKpi = key;
    clear(this.kpis);
    const kpi = (v: string, k: string, cls = '') => h('div', { class: `kpi ${cls}` }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));
    this.kpis.append(
      kpi(`${st.inService}/${st.online}`, '载客/在线'),
      kpi(String(st.late), '晚点>2分', st.late > 0 ? 'late' : ''),
      kpi(`${(st.punctuality * 100).toFixed(1)}%`, '正点率', st.punctuality < 0.98 ? 'warn' : ''),
      kpi(`${st.tripsDone}/${st.tripsPlanned}`, '完成车次'),
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
      this.alarmCnt.append(h('span', { class: `${l} ${cnt[l] ? 'has' : ''} ${unack[l] && l === 'A' ? 'active' : ''}`, title: `${l}级报警` }, String(cnt[l])));
    }
  }
}
