/** Right-hand panels: alarm list and the tabbed area (命令/事件/列车/教员台/计划). */
import { h, clear } from './dom';
import type { Store } from './store';
import { fmtTime, fmtDelay } from './theme';
import { CommandPanel } from './cmdpanel';
import type { Schematic } from './schematic';
import { confirmAndSend, toast } from './confirm';
import { FAULT_LABELS } from '../sim/faults';
import { TEMPLATES } from '../sim/timetable';
import { STATIONS, LINE_INFO } from '../data/line2';
import type { FaultKind, SimEvent } from '../sim/model';

const CAT_FILTERS = ['全部', '报警', '调度', '信号', '列车', '车站', '客流', '系统'];

const PROCEDURES: Record<FaultKind, string> = {
  trainComm: '后果：ZC 失去列车位置，该车按计轴区段占用防护（后车在区段边界停车）；列车MA失效紧急制动。处置：司机停车后30秒内降级为TBTC后备CM模式运行；通信恢复后自动升级CBTC；长期中断可“退出服务”。',
  zcFail: '后果：区域内CBTC列车失去移动授权紧急制动，区外列车不能进入。处置：确认区域列车停稳→“切换TBTC”（二次确认）→列车以TBTC级别运行（固定闭塞）；ZC修复后“恢复CBTC”。',
  axle: '后果：区段显示故障占用，CBTC列车在区段前停车。处置：现场确认无车、设备修复后执行“计轴预复位”（二次确认）→首列车以RM模式压道出清；修复前可“授权RM”或办理引导进路通过。',
  switch: '后果：道岔失表，经过该道岔的进路无法办理，列车停于防护信号前。处置：单操道岔试排→通知维修→现场钩锁确认（二次确认）后办理引导进路，RM≤25km/h通过→修复后单操恢复表示并取消钩锁。',
  signal: '后果：信号机无法开放，已排进路取消，列车停于信号机前。处置：办理引导进路（二次确认），列车凭引导信号以RM模式通过；修复后恢复正常。',
  psd: '后果：下次关门时站台门无法关闭锁紧，列车不能发车，后续列车不能进站。处置：确认站台门已人工关闭/派人看守→“站台门互锁解除”（二次确认）→列车凭人工确认发车，每列加站约25秒；修复后取消互锁解除。',
  trainFail: '后果：列车牵引/制动故障停车，后续列车在其后方停车。处置：司机处置（可恢复时约4分钟内恢复）；无法恢复时选择故障列车→“组织救援”，后方列车清客后RM接近连挂，推送至前方站清客后回段。',
  surge: '后果：进站客流成倍增加，站台拥挤、停站时间延长、列车满载，引起晚点。处置：加开列车/加开运行图、在客流站前后扣车均衡间隔、必要时跳停或限流。',
};

export class SidePanel {
  el: HTMLElement;
  private store: Store;
  private alarmBody = h('tbody');
  private tabBody = h('div', { class: 'panel-b' });
  private tabs: HTMLElement[] = [];
  private tab = 0;
  private cmd: CommandPanel;
  private evFilter = '全部';
  private evBody = h('tbody');
  private evCount = 0;
  private trainBody = h('tbody');
  private lastTrainDraw = 0;
  private faultList = h('div', { style: 'display:flex;flex-direction:column;gap:6px' });

  constructor(store: Store, schematic: Schematic) {
    this.store = store;
    this.cmd = new CommandPanel(store, schematic);
    const ackAll = h('button', { class: 'btn small', onclick: () => {
      const ids = this.store.alarms.filter((a) => !a.ack).map((a) => a.id);
      if (ids.length) void this.store.command({ c: 'ack', ids });
    } }, '全部确认');
    const alarmPanel = h('div', { class: 'panel', style: 'height:330px' },
      h('div', { class: 'panel-h' }, h('span', { class: 't' }, '实时报警'), h('span', { class: 'sp' }), h('span', { class: 'hint' }, '点击报警行确认'), ackAll),
      h('div', { class: 'panel-b' }, h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', { style: 'width:110px' }, '时间'), h('th', { style: 'width:56px' }, '级'), h('th', { style: 'width:70px' }, '类别'), h('th', {}, '内容'))), this.alarmBody)),
    );
    const names = ['命令', '事件', '列车', '教员台', '计划'];
    const tabBar = h('div', { class: 'tabs' });
    names.forEach((n, i) => {
      const t = h('div', { class: `tab ${i === 0 ? 'on' : ''}`, onclick: () => this.setTab(i) }, n);
      this.tabs.push(t);
      tabBar.append(t);
    });
    const tabPanel = h('div', { class: 'panel', style: 'flex:1' }, tabBar, this.tabBody);
    this.el = h('div', { class: 'side' }, alarmPanel, tabPanel);
    this.setTab(0);
    store.on('alarms', () => this.renderAlarms());
    store.on('events', () => { if (this.tab === 1) this.appendEvents(); });
    store.on('selection', () => { if (this.store.selection && this.tab !== 0) this.setTab(0); });
    store.on('snap', () => {
      const now = performance.now();
      if (this.tab === 2 && now - this.lastTrainDraw > 1000) { this.lastTrainDraw = now; this.renderTrains(); }
      if (this.tab === 3 && now - this.lastTrainDraw > 1000) { this.lastTrainDraw = now; this.renderFaultList(); }
    });
  }

  setTab(i: number) {
    this.tab = i;
    this.tabs.forEach((t, k) => t.classList.toggle('on', k === i));
    clear(this.tabBody);
    if (i === 0) this.tabBody.append(this.cmd.el);
    if (i === 1) this.renderEventsTab();
    if (i === 2) this.renderTrainsTab();
    if (i === 3) this.renderFaultTab();
    if (i === 4) this.renderPlanTab();
  }

  // ---------------------------------------------------------------- alarms
  private renderAlarms() {
    clear(this.alarmBody);
    const order = { A: 0, B: 1, C: 2, I: 3 };
    const list = [...this.store.alarms].sort((a, b) => Number(!!a.ack) - Number(!!b.ack) || order[a.level] - order[b.level] || b.t - a.t);
    for (const a of list) {
      const tr = h('tr', { class: `${a.ack ? '' : 'unack'} ${a.level}`, style: 'cursor:pointer', onclick: () => { if (!a.ack) void this.store.command({ c: 'ack', ids: [a.id] }); } },
        h('td', { class: 'mono' }, fmtTime(a.t)),
        h('td', {}, h('span', { class: `lvl ${a.level}` }, a.level)),
        h('td', {}, a.cat),
        h('td', { class: 'txt' }, a.text),
      );
      this.alarmBody.append(tr);
    }
    if (!list.length) this.alarmBody.append(h('tr', {}, h('td', { colspan: 4, style: 'color:var(--text-dim);text-align:center;padding:30px' }, '无活动报警')));
  }

  // ---------------------------------------------------------------- events
  private renderEventsTab() {
    const bar = h('div', { style: 'display:flex;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border)' });
    for (const f of CAT_FILTERS) {
      bar.append(h('button', { class: `btn small ${f === this.evFilter ? 'on' : ''}`, onclick: () => { this.evFilter = f; this.setTab(1); } }, f));
    }
    this.evBody = h('tbody');
    this.evCount = 0;
    const table = h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', { style: 'width:110px' }, '时间'), h('th', { style: 'width:56px' }, '级'), h('th', { style: 'width:70px' }, '类别'), h('th', {}, '事件'))), this.evBody);
    this.tabBody.append(bar, table);
    this.appendEvents();
  }

  private match(e: SimEvent) {
    switch (this.evFilter) {
      case '全部': return true;
      case '报警': return e.level !== 'I';
      case '调度': return !!e.manual;
      default: return e.cat === this.evFilter;
    }
  }

  private appendEvents() {
    const ev = this.store.events;
    if (this.evCount > ev.length) this.evCount = 0;
    const rows: HTMLElement[] = [];
    for (let i = this.evCount; i < ev.length; i++) {
      const e = ev[i];
      if (!this.match(e)) continue;
      const recovered = e.text.startsWith('【恢复】');
      rows.push(h('tr', { class: `${e.manual ? 'manual' : ''} ${recovered ? 'recovered' : ''}` },
        h('td', { class: 'mono' }, fmtTime(e.t)), h('td', {}, h('span', { class: `lvl ${e.level}` }, e.level)), h('td', {}, e.cat), h('td', { class: 'txt' }, e.text)));
    }
    this.evCount = ev.length;
    for (const r of rows.reverse()) this.evBody.prepend(r);
    while (this.evBody.children.length > 1500) this.evBody.lastElementChild?.remove();
  }

  // ---------------------------------------------------------------- trains
  private renderTrainsTab() {
    this.trainBody = h('tbody');
    this.tabBody.append(h('table', { class: 'grid' }, h('thead', {}, h('tr', {},
      ...['表号', '车次', '车组', '目的地', '位置', '速度', '模式', '级别', '晚点', '满载', '状态'].map((t) => h('th', {}, t)))), this.trainBody));
    this.renderTrains();
  }

  private renderTrains() {
    const snap = this.store.snap;
    if (!snap) return;
    clear(this.trainBody);
    const { topo } = this.store;
    const trains = [...snap.trains].sort((a, b) => a.svc.localeCompare(b.svc));
    for (const t of trains) {
      const near = topo.stations.reduce((best, s) => (Math.abs(s.chain - t.chain) < Math.abs(best.chain - t.chain) ? s : best), topo.stations[0]);
      const sel = this.store.selection?.kind === 'train' && this.store.selection.id === t.id;
      const late = t.inService && t.delay > 120;
      this.trainBody.append(h('tr', { class: sel ? 'sel' : '', style: 'cursor:pointer', onclick: () => this.store.select({ kind: 'train', id: t.id }) },
        h('td', { class: 'mono' }, t.svc), h('td', { class: 'mono' }, t.trip), h('td', { class: 'mono' }, t.vehicle), h('td', {}, t.dest),
        h('td', {}, `${near.name}${Math.abs(near.chain - t.chain) > 150 ? '附近' : ''}`), h('td', { class: 'mono' }, `${Math.round(t.v * 3.6)}`),
        h('td', { class: 'mono', style: t.mode !== 'AM' ? 'color:var(--warn)' : '' }, t.mode), h('td', { class: 'mono', style: t.level !== 'CBTC' || !t.comm ? 'color:var(--warn)' : '' }, t.comm ? t.level : `${t.level}×`),
        h('td', { class: 'mono', style: late ? 'color:var(--bad)' : '' }, t.inService ? fmtDelay(t.delay) : '—'), h('td', { class: 'mono' }, `${Math.round((t.load / LINE_INFO.capacity) * 100)}%`),
        h('td', { style: t.failed || t.eb ? 'color:var(--bad)' : '' }, t.failed ? '故障' : t.eb ? '紧急制动' : t.hold ? '扣车' : t.phase === 'dwell' ? '停站' : t.phase === 'reversing' ? '折返' : t.v > 0.1 ? '运行' : '停车'),
      ));
    }
  }

  // ---------------------------------------------------------------- faults (instructor)
  private renderFaultTab() {
    const { topo } = this.store;
    const snap = this.store.snap!;
    const kind = h('select', {}, ...(Object.keys(FAULT_LABELS) as FaultKind[]).map((k) => h('option', { value: k }, FAULT_LABELS[k]))) as HTMLSelectElement;
    const target = h('select', { style: 'min-width:360px' }) as HTMLSelectElement;
    const dur = h('select', {}, ...[[0, '需人工修复'], [120, '2分钟'], [300, '5分钟'], [600, '10分钟'], [1200, '20分钟'], [1800, '30分钟']].map(([v, t]) => h('option', { value: v }, String(t)))) as HTMLSelectElement;
    dur.value = '600';
    const rec = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const mult = h('select', {}, ...[3, 4, 6, 8].map((v) => h('option', { value: v }, `×${v}`))) as HTMLSelectElement;
    mult.value = '4';
    const proc = h('div', { class: 'hint', style: 'min-height:90px' });
    const extra = h('span', { style: 'display:flex;gap:10px;align-items:center' });
    const fillTargets = () => {
      clear(target);
      clear(extra);
      const k = kind.value as FaultKind;
      const sel = this.store.selection;
      const opt = (v: number, t: string, chosen = false) => { const o = h('option', { value: v }, t); if (chosen) (o as HTMLOptionElement).selected = true; return o; };
      if (k === 'trainComm' || k === 'trainFail') {
        for (const t of [...snap.trains].sort((a, b) => a.svc.localeCompare(b.svc))) if (t.inService || t.phase === 'run') target.append(opt(t.id, `${t.svc}-${t.trip}（${t.vehicle}）`, sel?.kind === 'train' && sel.id === t.id));
        if (k === 'trainFail') extra.append(h('label', {}, '司机可自行恢复'), rec);
      } else if (k === 'zcFail') {
        target.append(opt(-1, 'DCS/全部ZC（全线）'));
        topo.zones.forEach((z) => target.append(opt(z.id, z.name, sel?.kind === 'zone' && sel.id === z.id)));
      } else if (k === 'axle') {
        for (const s of topo.sections) target.append(opt(s.id, `${s.name}（${STATIONS[s.station].name}）`, sel?.kind === 'section' && sel.id === s.id));
      } else if (k === 'switch') {
        topo.switches.forEach((s) => target.append(opt(s.id, `${s.name}（${STATIONS[s.station].name}）`, sel?.kind === 'switch' && sel.id === s.id)));
      } else if (k === 'signal') {
        topo.signals.forEach((s) => target.append(opt(s.id, `${s.name}（${STATIONS[s.station].name}）`, sel?.kind === 'signal' && sel.id === s.id)));
      } else if (k === 'psd') {
        topo.platforms.forEach((p) => target.append(opt(p.id, p.name, sel?.kind === 'platform' && sel.id === p.id)));
      } else if (k === 'surge') {
        topo.stations.forEach((s) => target.append(opt(s.index, s.name, sel?.kind === 'platform' && topo.platforms[sel.id].station === s.index)));
        extra.append(h('label', {}, '客流倍数'), mult);
      }
      proc.textContent = PROCEDURES[k];
    };
    kind.onchange = fillTargets;
    fillTargets();
    const inject = h('button', { class: 'btn danger', onclick: async () => {
      if (!target.value) return;
      const k = kind.value as FaultKind;
      const r = await this.store.command({ c: 'fault', kind: k, target: Number(target.value), duration: Number(dur.value), param: Number(mult.value), recoverable: rec.checked });
      toast(r.msg, r.ok);
      this.renderFaultList();
    } }, '注入故障');
    this.tabBody.append(h('div', { class: 'cmd' },
      h('div', { class: 'sect-title' }, '教员台 · 故障注入（先在图上选中对象可自动带入）'),
      h('div', { class: 'form' }, h('label', {}, '故障类型'), kind),
      h('div', { class: 'form' }, h('label', {}, '对象'), target, extra),
      h('div', { class: 'form' }, h('label', {}, '维修时长'), dur, inject),
      proc,
      h('div', { class: 'sect-title' }, '当前故障'),
      this.faultList,
    ));
    this.renderFaultList();
  }

  private renderFaultList() {
    const snap = this.store.snap;
    if (!snap) return;
    clear(this.faultList);
    const list = snap.faults;
    if (!list.length) { this.faultList.append(h('div', { class: 'hint' }, '无')); return; }
    for (const f of list) {
      this.faultList.append(h('div', { style: 'display:flex;gap:12px;align-items:center;font-size:18px' },
        h('span', { class: `chip ${f.repaired ? 'ok' : 'bad'}` }, f.repaired ? '已修复' : '故障中'),
        h('span', { class: 'mono', style: 'color:var(--text-dim)' }, fmtTime(f.since)),
        h('span', { style: 'flex:1;color:#fff' }, f.text),
        h('span', { class: 'mono', style: 'color:var(--text-dim)' }, f.repaired ? '' : f.repairAt === null || !Number.isFinite(f.repairAt) ? '待人工' : `维修至 ${fmtTime(f.repairAt, false)}`),
        f.repaired ? '' : h('button', { class: 'btn small', onclick: async () => { const r = await this.store.command({ c: 'repair', fault: f.id }); toast(r.msg, r.ok); } }, '现场修复'),
      ));
    }
  }

  // ---------------------------------------------------------------- plan
  private renderPlanTab() {
    const plan = this.store.plan;
    if (!plan) return;
    const box = h('div', { class: 'cmd' });
    const revenue = plan.trips.filter((t) => t.revenue);
    const kinds: Record<string, number> = {};
    for (const t of plan.trips) kinds[t.kind] = (kinds[t.kind] ?? 0) + 1;
    const kindName: Record<string, string> = { big: '大交路', small: '小交路', late: '末班中交路', ins: '出库载客', wd: '回库载客', empty: '空驶', extra: '加开', adj: '调整' };
    box.append(h('div', { class: 'sect-title' }, `运行图：${plan.dayType === 'weekday' ? '工作日' : '双休日/节假日'} · 车次 ${revenue.length}（载客）/ ${plan.trips.length}（含空驶）· 车底运用 ${plan.blocks.length} · 最大上线 ${plan.fleetPeak} 列 / 配属 ${LINE_INFO.fleet} 列`));
    box.append(h('div', { class: 'hint' }, Object.entries(kinds).map(([k, v]) => `${kindName[k] ?? k} ${v}`).join(' · ')));
    const tb = h('tbody');
    for (const p of plan.periods) {
      const tpl = TEMPLATES[p.template];
      tb.append(h('tr', {}, h('td', { class: 'mono' }, `${fmtTime(p.from, false)}–${fmtTime(p.to, false)}`), h('td', {}, p.label), h('td', {}, tpl.name),
        h('td', { class: 'mono' }, tpl.pattern.map((x) => (x === 'big' ? '大' : '小')).join('-')), h('td', { class: 'mono' }, `${Math.floor(((p as { headway?: number }).headway ?? tpl.headway) / 60)}'${String(((p as { headway?: number }).headway ?? tpl.headway) % 60).padStart(2, '0')}"`), h('td', { class: 'mono' }, `×${tpl.dwellFactor}`)));
    }
    box.append(h('div', { class: 'sect-title' }, '时段与参数化模板'));
    box.append(h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ...['时段', '名称', '模板', '交路组合', '核心段间隔', '停站系数'].map((t) => h('th', {}, t)))), tb));
    const tl = h('tbody');
    for (const t of Object.values(TEMPLATES)) tl.append(h('tr', {}, h('td', {}, t.name), h('td', { style: 'white-space:normal' }, t.desc)));
    box.append(h('div', { class: 'sect-title' }, '模板说明'), h('table', { class: 'grid' }, tl));
    if (plan.overlays.length) {
      box.append(h('div', { class: 'sect-title' }, '已套用加开'));
      for (const o of plan.overlays) box.append(h('div', { class: 'hint' }, `${o.label} ${fmtTime(o.from, false)}–${fmtTime(o.to, false)}`));
    }
    box.append(h('div', { class: 'hint' }, '加开列车/加开运行图：清除选择后在“命令”页操作。首末班：蟠祥路·国家会计学院 05:25 首班，往浦东1号2号航站楼末班 21:57，往广兰路末班 22:42；浦东1号2号航站楼末班到达蟠祥路约 00:05。'));
    this.tabBody.append(box);
    void confirmAndSend;
  }
}
