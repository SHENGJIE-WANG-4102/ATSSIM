/**
 * Command panel: shows the selected object and the dispatcher commands
 * available for it (select → command → confirm).
 */
import { h, clear } from './dom';
import type { Store } from './store';
import { confirmAndSend } from './confirm';
import { STATIONS } from '../data/line2';
import { SEC, SW, SIGF, PLT, SIG_ASPECT, type TrackDir, type TrainSnap } from '../sim/model';
import { turnbackAt, exitStation, OVERLAY_PRESETS } from '../sim/timetable';
import { fmtTime, fmtDelay } from './theme';
import type { Schematic } from './schematic';

const ROLE: Record<string, string> = { start: '出站信号机', home: '进站/防护信号机', rev: '反向信号机', exit: '折返/存车线出口信号机', depot: '出段信号机' };
const ASPECT: Record<string, string> = { R: '红灯（禁止）', G: '绿灯（正线通过）', Y: '黄灯（侧向）', GUIDE: '红+白（引导）', DARK: '灭灯（CBTC 列车接近）', FAIL: '故障' };

export class CommandPanel {
  el = h('div', { class: 'cmd' });
  private store: Store;
  private schematic: Schematic;
  private key = '';
  private live: (() => void) | null = null;

  constructor(store: Store, schematic: Schematic) {
    this.store = store;
    this.schematic = schematic;
    store.on('selection', () => this.render(true));
    store.on('snap', () => this.render(false));
  }

  private render(force: boolean) {
    const sel = this.store.selection;
    const sys = !sel || sel.kind === 'zone' || sel.kind === 'depot';
    // the system view has no live part: re-render it when the ZC area states change
    const key = (sel ? `${sel.kind}:${sel.id}` : 'none') + (sys && this.store.snap ? `|${this.store.snap.zones.join(',')}` : '');
    if (!force && key === this.key) { this.live?.(); return; }
    this.key = key;
    this.live = null;
    this.schematic.previewRoute(null);
    clear(this.el);
    if (!this.store.snap) return;
    if (!sel) return this.renderSystem();
    switch (sel.kind) {
      case 'signal': return this.renderSignal(sel.id);
      case 'switch': return this.renderSwitch(sel.id);
      case 'section': return this.renderSection(sel.id);
      case 'platform': return this.renderPlatform(sel.id);
      case 'train': return this.renderTrain(sel.id);
      case 'zone': return this.renderSystem(sel.id);
      case 'depot': return this.renderSystem(undefined, sel.id);
    }
  }

  private head(kind: string, name: string, cn = false) {
    return h('div', { class: 'objhead' }, h('span', { class: 'kind' }, kind), h('span', { class: `name ${cn ? 'cn' : ''}` }, name));
  }
  private kv(pairs: [string, string | Node][]) {
    const g = h('div', { class: 'kv' });
    for (const [k, v] of pairs) g.append(h('div', { class: 'k' }, k), typeof v === 'string' ? h('div', { class: 'v' }, v) : v);
    return g;
  }
  private liveKv(fn: () => [string, string][]) {
    const box = h('div');
    const draw = () => { clear(box); box.append(this.kv(fn())); };
    draw();
    this.live = draw;
    return box;
  }
  private btn(label: string, spec: Parameters<typeof confirmAndSend>[1] | (() => void), cls = '') {
    return h('button', {
      class: `btn ${cls || (typeof spec !== 'function' && spec.critical ? 'danger' : '')}`,
      onclick: () => { if (typeof spec === 'function') spec(); else void confirmAndSend(this.store, spec); },
    }, label);
  }

  // ---------------------------------------------------------------- signal
  private renderSignal(id: number) {
    const { topo } = this.store;
    const s = topo.signals[id];
    this.el.append(this.head(ROLE[s.role] ?? '信号机', s.name));
    this.el.append(this.liveKv(() => {
      const f = this.store.snap!.signals[id];
      const aspect = SIG_ASPECT[f & 7];
      const route = this.store.snap!.activeRoutes.find((r) => topo.routes[r].start === id);
      return [
        ['所属车站', STATIONS[s.station].name], ['显示', ASPECT[aspect]],
        ['当前进路', route !== undefined ? topo.routes[route].name : '无'], ['进路类型', f & SIGF.MANUAL ? '人工' : route !== undefined ? '自动' : '—'],
        ['自动排列(ARS)', f & SIGF.ARSOFF ? '关（人工控制）' : '开'], ['自动通过', f & SIGF.AUTOPASS ? '开' : '关'],
        ['状态', f & SIGF.FAILED ? '故障' : '正常'], ['可选进路', String(s.routes.length)],
      ];
    }));
    const f = this.store.snap!.signals[id];
    this.el.append(h('div', { class: 'sect-title' }, '信号机命令'));
    this.el.append(h('div', { class: 'cmdgrid' },
      this.btn('取消进路', { title: `取消进路 ${s.name}`, cmd: { c: 'cancelRoute', signal: id }, detail: '有车接近时进路将延时30秒解锁。' }),
      this.btn(f & SIGF.AUTOPASS ? '关闭自动通过' : '开启自动通过', { title: `${f & SIGF.AUTOPASS ? '关闭' : '开启'}自动通过 ${s.name}`, cmd: { c: 'autoPass', signal: id, on: !(f & SIGF.AUTOPASS) } }),
      this.btn(f & SIGF.ARSOFF ? '恢复自动排列' : '改为人工排列', { title: `${f & SIGF.ARSOFF ? '恢复' : '关闭'}自动排列进路 ${s.name}`, cmd: { c: 'ars', signal: id, on: !!(f & SIGF.ARSOFF) } }),
    ));
    this.el.append(h('div', { class: 'sect-title' }, '办理进路（悬停预览，引导进路需二次确认）'));
    const list = h('div', { style: 'display:flex;flex-direction:column;gap:6px;max-height:330px;overflow:auto' });
    for (const rid of s.routes) {
      const r = topo.routes[rid];
      const row = h('div', { style: 'display:flex;align-items:center;gap:10px;font-size:19px', onmouseenter: () => this.schematic.previewRoute(rid), onmouseleave: () => this.schematic.previewRoute(null) },
        h('span', { style: 'flex:1;font-family:var(--font-mono);color:#fff' }, r.name),
        h('span', { class: `chip ${r.wrongDir ? 'warn' : r.diverging ? 'info' : 'ok'}` }, r.wrongDir ? '反向' : r.diverging ? '侧向' : '直向'),
        h('span', { style: 'color:var(--text-dim);width:80px' }, `${Math.round(r.length)}m`),
        this.btn('办理', { title: `办理进路 ${r.name}`, cmd: { c: 'setRoute', route: rid } }, 'small primary'),
        this.btn('引导', { title: `引导进路 ${r.name}`, cmd: { c: 'guideRoute', route: rid }, critical: true, detail: '引导进路不检查区段空闲，列车以RM模式（≤25km/h）目视通过；道岔失表时须先确认现场钩锁。' }, 'small danger'),
      );
      list.append(row);
    }
    this.el.append(list);
  }

  // ---------------------------------------------------------------- switch
  private renderSwitch(id: number) {
    const { topo } = this.store;
    const sw = topo.switches[id];
    this.el.append(this.head(sw.nodes.length === 2 ? '双动道岔' : '道岔', sw.name));
    this.el.append(this.liveKv(() => {
      const f = this.store.snap!.switches[id];
      const pos = f & SW.FAILED ? (f & SW.FIELD ? `失表（现场钩锁于${f & SW.R ? '反位' : '定位'}）` : '失表（无表示）') : f & SW.MOVING ? `转换中→${f & SW.TARGET_R ? '反位' : '定位'}` : f & SW.R ? '反位' : '定位';
      return [
        ['所属车站', STATIONS[sw.station].name], ['位置', pos],
        ['进路锁闭', f & SW.LOCKED ? '是' : '否'], ['单锁', f & SW.SINGLE ? '是' : '否'],
        ['类型', { crossover: '渡线', siding: '折返/存车线', depot: '出入段线', single: '单开' }[sw.kind]], ['区段', sw.sections.map((s) => topo.sections[s].name).join(' ')],
      ];
    }));
    this.el.append(h('div', { class: 'sect-title' }, '道岔命令'));
    this.el.append(h('div', { class: 'cmdgrid' },
      this.btn('单操定位', { title: `道岔 ${sw.name} 单操至定位`, cmd: { c: 'switchMove', sw: id, pos: 'N' } }),
      this.btn('单操反位', { title: `道岔 ${sw.name} 单操至反位`, cmd: { c: 'switchMove', sw: id, pos: 'R' } }),
      this.btn('单锁', { title: `道岔 ${sw.name} 单锁`, cmd: { c: 'switchLock', sw: id, on: true } }),
      this.btn('单解', { title: `道岔 ${sw.name} 单解`, cmd: { c: 'switchLock', sw: id, on: false } }),
      this.btn('钩锁确认', { title: `道岔 ${sw.name} 现场钩锁确认`, cmd: { c: 'switchFieldLock', sw: id, on: true }, critical: true, detail: '仅在现场人员确认道岔已密贴并加钩锁器后执行；之后可经引导进路以RM模式通过。' }),
      this.btn('取消钩锁', { title: `道岔 ${sw.name} 取消钩锁`, cmd: { c: 'switchFieldLock', sw: id, on: false } }),
    ));
    this.el.append(h('div', { class: 'hint' }, '失表处置：①单操道岔试排（维修完成前无效）②通知维修 ③现场钩锁确认后办理引导进路 ④修复后单操恢复表示、取消钩锁。'));
  }

  // ---------------------------------------------------------------- section
  private intervalSections(id: number): number[] {
    const { topo } = this.store;
    const s = topo.sections[id];
    if (s.track !== 'DN' && s.track !== 'UP') return [id];
    const mid = (s.chainFrom + s.chainTo) / 2;
    const st = topo.stations;
    let a = st[0].chain;
    let b = st[st.length - 1].chain;
    for (let i = 0; i + 1 < st.length; i++) if (mid >= st[i].chain && mid < st[i + 1].chain) { a = st[i].chain; b = st[i + 1].chain; }
    return topo.sections.filter((x) => x.track === s.track && x.chainFrom >= a - 1 && x.chainTo <= b + 1).map((x) => x.id);
  }

  private renderSection(id: number) {
    const { topo } = this.store;
    const s = topo.sections[id];
    this.el.append(this.head('计轴区段', s.name));
    this.el.append(this.liveKv(() => {
      const f = this.store.snap!.sections[id];
      const state = f & SEC.DIST ? '故障占用' : f & SEC.PRESET ? '预复位（待压道）' : f & SEC.OCC ? (f & SEC.COMM ? '通信列车占用' : '计轴占用') : '空闲';
      return [
        ['车站/区间', STATIONS[s.station].name], ['股道', { DN: '下行正线', UP: '上行正线', X: '渡线', SID: '折返/存车线', CON: '折返线连接', DEP: '出入段线' }[s.track]],
        ['长度', `${Math.round(s.len)} m`], ['状态', state],
        ['进路锁闭', f & SEC.LOCK ? (f & SEC.ROUTEFLEET ? '自动通过进路' : '进路锁闭') : '无'], ['临时限速', f & SEC.TSR ? `${this.store.snap!.sectionTsr[id]} km/h` : '无'],
        ['ZC区域', topo.zones[s.zone].key], ['里程', `K${(s.chainFrom / 1000).toFixed(3)}–K${(s.chainTo / 1000).toFixed(3)}`],
      ];
    }));
    this.el.append(h('div', { class: 'sect-title' }, '区段命令'));
    this.el.append(h('div', { class: 'cmdgrid' },
      this.btn('计轴预复位', { title: `计轴预复位 ${s.name}`, cmd: { c: 'axleReset', section: id }, critical: true, detail: '预复位后区段显示黄色，首列车以RM模式压道出清后恢复空闲。设备故障未修复时复位将失败。' }),
      this.btn('区段故障解锁', { title: `区段故障解锁 ${s.name}`, cmd: { c: 'sectionUnlock', section: id }, critical: true, detail: '强制解除该区段的进路锁闭，须确认区段内无列车运行。' }),
    ));
    const ivs = this.intervalSections(id);
    const speed = h('select', {}, ...[15, 25, 35, 45, 60].map((v) => h('option', { value: v }, `${v} km/h`))) as HTMLSelectElement;
    speed.value = '25';
    const extent = h('select', {}, h('option', { value: 'one' }, '本区段'), h('option', { value: 'iv' }, `整个站间区间（${ivs.length} 个区段）`)) as HTMLSelectElement;
    const pick = () => (extent.value === 'iv' ? ivs : [id]);
    this.el.append(h('div', { class: 'sect-title' }, '临时限速 TSR'));
    this.el.append(h('div', { class: 'form' },
      h('label', {}, '限速值'), speed, h('label', {}, '范围'), extent,
      this.btn('设置限速', () => void confirmAndSend(this.store, { title: `设置临时限速 ${speed.value}km/h：${pick().map((x) => topo.sections[x].name).join('、')}`, cmd: { c: 'setTsr', sections: pick(), kmh: Number(speed.value) }, critical: true }), 'danger'),
      this.btn('取消限速', () => void confirmAndSend(this.store, { title: `取消临时限速：${pick().map((x) => topo.sections[x].name).join('、')}`, cmd: { c: 'cancelTsr', sections: pick() }, critical: true }), 'danger'),
    ));
  }

  // ---------------------------------------------------------------- platform
  private renderPlatform(id: number) {
    const { topo } = this.store;
    const p = topo.platforms[id];
    this.el.append(this.head('站台', p.name, true));
    this.el.append(this.liveKv(() => {
      const f = this.store.snap!.platforms[id];
      return [
        ['候车人数', String(this.store.snap!.platformWaiting[id])], ['站台门', f & PLT.PSDFAULT ? (f & PLT.BYPASS ? '故障（互锁解除）' : '故障') : f & PLT.PSDOPEN ? '打开' : '关闭锁紧'],
        ['扣车', f & PLT.HOLD ? '是' : '否'], ['跳停', f & PLT.SKIP ? '是' : '否'],
        ['紧急关闭', f & PLT.ESP ? '是' : '否'], ['大客流', f & PLT.SURGE ? '是' : '否'],
      ];
    }));
    const f = this.store.snap!.platforms[id];
    this.el.append(h('div', { class: 'sect-title' }, '站台命令'));
    this.el.append(h('div', { class: 'cmdgrid' },
      this.btn(f & PLT.HOLD ? '取消扣车' : '站台扣车', { title: `${f & PLT.HOLD ? '取消扣车' : '扣车'} ${p.name}`, cmd: { c: 'platformHold', platform: id, on: !(f & PLT.HOLD) } }),
      this.btn(f & PLT.SKIP ? '取消跳停' : '站台跳停', { title: `${f & PLT.SKIP ? '取消跳停' : '跳停'} ${p.name}`, cmd: { c: 'platformSkip', platform: id, on: !(f & PLT.SKIP) } }),
      this.btn(f & PLT.ESP ? '取消紧急关闭' : '紧急关闭', { title: `${f & PLT.ESP ? '取消紧急关闭' : '紧急关闭'} ${p.name}`, cmd: { c: 'platformEsp', platform: id, on: !(f & PLT.ESP) }, critical: true, detail: '紧急关闭后列车不得进出该站台，接近列车将紧急制动。' }),
      this.btn(f & PLT.BYPASS ? '取消互锁解除' : '站台门互锁解除', { title: `站台门互锁${f & PLT.BYPASS ? '恢复' : '解除'} ${p.name}`, cmd: { c: 'psdBypass', platform: id, on: !(f & PLT.BYPASS) }, critical: !(f & PLT.BYPASS), detail: '确认站台门已人工关闭或已派人看守后执行，列车可凭人工确认发车。' }),
    ));
  }

  // ---------------------------------------------------------------- train
  private trainDir(t: TrainSnap): TrackDir {
    const l = this.store.topo.links[t.link];
    const east = t.dir === 1 ? l.chainB >= l.chainA : l.chainA > l.chainB;
    return east ? 'DN' : 'UP';
  }

  private renderTrain(id: number) {
    const { topo } = this.store;
    const t0 = this.store.snap!.trains.find((x) => x.id === id);
    if (!t0) { this.el.append(h('div', { class: 'empty' }, '列车已不在线')); return; }
    this.el.append(this.head('列车', `${t0.svc}-${t0.trip}  车组${t0.vehicle}`));
    this.el.append(this.liveKv(() => {
      const t = this.store.snap!.trains.find((x) => x.id === id);
      if (!t) return [['状态', '已下线']];
      const dir = this.trainDir(t);
      return [
        ['表号/车次', `${t.svc} / ${t.trip}`], ['目的地', t.dest || '—'],
        ['方向', dir === 'DN' ? '下行（往浦东机场）' : '上行（往蟠祥路）'], ['当前任务', t.task],
        ['速度', `${(t.v * 3.6).toFixed(1)} km/h`], ['允许速度', `${(t.vPermit * 3.6).toFixed(0)} km/h`],
        ['驾驶模式', t.mode], ['信号级别', `${t.level}${t.comm ? '' : '（通信中断）'}`],
        ['晚点', t.inService ? fmtDelay(t.delay) : '非载客'], ['满载率', `${Math.round((t.load / 2480) * 100)}%`],
        ['MA限制', t.maReason ? `${t.maReason} ${Math.round(t.maDist)}m` : '无'], ['里程', `K${(t.chain / 1000).toFixed(3)}`],
      ];
    }));
    const dir = this.trainDir(t0);
    const ahead = topo.stations.filter((s) => (dir === 'DN' ? s.chain > t0.chain + 20 : s.chain < t0.chain - 20)).sort((a, b) => (dir === 'DN' ? a.chain - b.chain : b.chain - a.chain));
    const tbOpts = ahead.filter((s) => turnbackAt(topo, s.index, dir));
    this.el.append(h('div', { class: 'sect-title' }, '列车命令'));
    this.el.append(h('div', { class: 'cmdgrid' },
      this.btn(t0.hold ? '放行' : '扣车', { title: `${t0.hold ? '放行' : '扣车'} 列车 ${t0.svc}-${t0.trip}`, cmd: { c: 'trainHold', train: id, on: !t0.hold } }),
      this.btn('退出服务(清客回段)', { title: `列车 ${t0.svc}-${t0.trip} 退出服务，清客回段`, cmd: { c: 'withdraw', train: id }, detail: '列车在前方站清客后回最近车辆段/停车场，剩余计划车次取消。' }),
      this.btn('授权RM运行', { title: `授权列车 ${t0.svc}-${t0.trip} 以RM模式运行`, cmd: { c: 'authRM', train: id }, critical: true, detail: '司机以≤25km/h目视行车600m，可越过故障占用区段或关闭的信号（须确认进路正确）。' }),
    ));
    const skipSel = h('select', {}, ...ahead.slice(0, 8).map((s) => h('option', { value: s.index }, s.name))) as HTMLSelectElement;
    const tbSel = h('select', {}, ...tbOpts.map((s) => {
      const tb = turnbackAt(topo, s.index, dir)!;
      return h('option', { value: s.index }, `${s.name}（${tb.kind === 'rear' ? '站后折返' : '站前折返'}）`);
    })) as HTMLSelectElement;
    this.el.append(h('div', { class: 'form' },
      h('label', {}, '跳停'), skipSel,
      this.btn('设置跳停', () => void confirmAndSend(this.store, { title: `列车 ${t0.svc}-${t0.trip} 跳停 ${STATIONS[Number(skipSel.value)].name}`, cmd: { c: 'trainSkip', train: id, station: Number(skipSel.value), on: true } })),
    ));
    this.el.append(h('div', { class: 'form' },
      h('label', {}, '人工折返'), tbSel,
      this.btn('折返', () => tbSel.value && void confirmAndSend(this.store, { title: `列车 ${t0.svc}-${t0.trip} 人工折返于 ${STATIONS[Number(tbSel.value)].name}`, cmd: { c: 'turnback', train: id, station: Number(tbSel.value) }, detail: '列车在折返站清客折返，按调整车次接续反方向运营。' }), 'primary'),
    ));
    if (t0.failed) {
      const behind = this.store.snap!.trains.filter((x) => x.id !== id && this.trainDir(x) === dir && (dir === 'DN' ? x.chain < t0.chain : x.chain > t0.chain))
        .sort((a, b) => Math.abs(a.chain - t0.chain) - Math.abs(b.chain - t0.chain)).slice(0, 4);
      const rs = h('select', {}, ...behind.map((x) => h('option', { value: x.id }, `${x.svc}-${x.trip}（后方 ${Math.round(Math.abs(x.chain - t0.chain))}m）`))) as HTMLSelectElement;
      this.el.append(h('div', { class: 'sect-title' }, '故障救援'));
      this.el.append(h('div', { class: 'form' }, h('label', {}, '救援列车'), rs,
        this.btn('组织救援', () => rs.value && void confirmAndSend(this.store, { title: `组织列车 ${rs.selectedOptions[0]?.textContent} 救援故障列车 ${t0.svc}-${t0.trip}`, cmd: { c: 'rescue', failed: id, rescuer: Number(rs.value) }, critical: true, detail: '救援列车清客后以RM模式接近连挂（≤3km/h），推送故障车至前方站清客后回段。' }), 'danger')));
    }
  }

  // ---------------------------------------------------------------- system / zones / depot / add trains
  private renderSystem(zone?: number, depot?: number) {
    const { topo } = this.store;
    const snap = this.store.snap!;
    this.el.append(this.head('系统', '信号系统 / 运营调整', true));
    const zbox = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
    topo.zones.forEach((z, i) => {
      const st = snap.zones[i];
      zbox.append(h('div', { style: `display:flex;align-items:center;gap:12px;font-size:19px;${zone === i ? 'outline:2px solid var(--accent);' : ''}padding:4px` },
        h('span', { style: 'flex:1' }, z.name),
        h('span', { class: `chip ${st === 'CBTC' ? 'ok' : st === 'TBTC' ? 'warn' : 'bad'}` }, st === 'ZCFAIL' ? 'ZC故障' : st),
        this.btn('切换TBTC', { title: `${z.name} 切换至 TBTC 后备系统`, cmd: { c: 'zoneLevel', zones: [i], level: 'TBTC' }, critical: true, detail: '区域内列车停稳后经司机确认转为TBTC级别运行（固定闭塞，区段占用防护）。' }, 'small danger'),
        this.btn('恢复CBTC', { title: `${z.name} 恢复 CBTC`, cmd: { c: 'zoneLevel', zones: [i], level: 'CBTC' }, critical: true }, 'small danger'),
      ));
    });
    this.el.append(h('div', { class: 'sect-title' }, 'CBTC / TBTC 系统切换'), zbox);
    this.el.append(h('div', { class: 'cmdgrid' },
      this.btn('全线切换TBTC', { title: '全线切换至 TBTC 后备系统', cmd: { c: 'zoneLevel', zones: topo.zones.map((z) => z.id), level: 'TBTC' }, critical: true }),
      this.btn('全线恢复CBTC', { title: '全线恢复 CBTC', cmd: { c: 'zoneLevel', zones: topo.zones.map((z) => z.id), level: 'CBTC' }, critical: true }),
    ));

    // add train
    const depSel = h('select', {}, ...topo.depots.map((d) => h('option', { value: d.id }, d.name))) as HTMLSelectElement;
    if (depot !== undefined) depSel.value = String(depot);
    const dirSel = h('select', {}, h('option', { value: 'DN' }, '下行（往浦东机场）'), h('option', { value: 'UP' }, '上行（往蟠祥路）')) as HTMLSelectElement;
    const toSel = h('select', {}) as HTMLSelectElement;
    const fill = () => {
      clear(toSel);
      const d = Number(depSel.value);
      const dir = dirSel.value as TrackDir;
      const ex = exitStation(topo, d, dir);
      for (const s of topo.stations) {
        if ((dir === 'DN' && s.index <= ex) || (dir === 'UP' && s.index >= ex)) continue;
        if (!turnbackAt(topo, s.index, dir)) continue;
        toSel.append(h('option', { value: s.index }, s.name));
      }
    };
    depSel.onchange = fill;
    dirSel.onchange = fill;
    fill();
    const tIn = h('input', { type: 'text', pattern: '[0-2][0-9]:[0-5][0-9]', maxlength: 5, style: 'width:100px', value: fmtTime(snap.t + 900, false) }) as HTMLInputElement;
    const toSec = (v: string) => { const [a, b] = v.split(':').map(Number); let s = a * 3600 + b * 60; if (s < 4 * 3600) s += 86400; return s; };
    this.el.append(h('div', { class: 'sect-title' }, '加开列车（出段→折返站→回段）'));
    this.el.append(h('div', { class: 'form' }, depSel, dirSel, h('label', {}, '折返站'), toSel, h('label', {}, '出段站发车'), tIn,
      this.btn('加开', () => void confirmAndSend(this.store, {
        title: `加开列车：${topo.depots[Number(depSel.value)].name} 出段 → ${STATIONS[Number(toSel.value)]?.name ?? '?'} 折返 → 回段，${tIn.value} 发车`,
        cmd: { c: 'addTrain', depot: Number(depSel.value), dir: dirSel.value as TrackDir, to: Number(toSel.value), time: toSec(tIn.value) },
      }), 'primary')));

    // overlays
    this.el.append(h('div', { class: 'sect-title' }, '加开运行图模板'));
    for (const p of OVERLAY_PRESETS) {
      const a = h('input', { type: 'text', pattern: '[0-2][0-9]:[0-5][0-9]', maxlength: 5, style: 'width:100px', value: fmtTime(Math.max(p.from, snap.t + 1200), false) }) as HTMLInputElement;
      const b = h('input', { type: 'text', pattern: '[0-2][0-9]:[0-5][0-9]', maxlength: 5, style: 'width:100px', value: fmtTime(Math.max(p.to, snap.t + 3600 * 2), false) }) as HTMLInputElement;
      const hw = h('select', {}, ...[600, 720, 900, 1200].map((v) => h('option', { value: v }, `${v / 60}分`))) as HTMLSelectElement;
      hw.value = String(p.headway);
      this.el.append(h('div', { class: 'form' }, h('span', { style: 'color:#fff;width:230px' }, p.label), a, h('span', {}, '至'), b, h('label', {}, '间隔'), hw,
        this.btn('套用', () => void confirmAndSend(this.store, {
          title: `${p.label} ${a.value}—${b.value}，间隔 ${Number(hw.value) / 60} 分钟`,
          cmd: { c: 'overlay', id: p.id, from: toSec(a.value), to: toSec(b.value), headway: Number(hw.value) },
          detail: p.desc,
        }), 'primary')));
    }
  }
}
