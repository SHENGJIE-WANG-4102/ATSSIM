/**
 * App bootstrap: topology, simulation worker, Pixi renderer (schematic +
 * train graph) and DOM panels laid out on a 3840×2160 design canvas that is
 * uniformly scaled to the window.
 */
import './styles.css';
import { Application, Container, Text } from 'pixi.js';
import { buildTopology } from './sim/topology';
import { Store } from './ui/store';
import { Schematic } from './ui/schematic';
import { TrainGraph } from './ui/graph';
import { Header, dayTypeOf, dateLabel } from './ui/header';
import { SidePanel } from './ui/side';
import { Tooltip } from './ui/tooltip';
import { initConfirm } from './ui/confirm';
import { h } from './ui/dom';
import { isoDate } from './sim/calendar';
import { C, DESIGN_W, DESIGN_H, fmtTime } from './ui/theme';
import type { SimConfig } from './sim/model';

const bootMsg = document.getElementById('boot-msg')!;
const bootBar = document.getElementById('boot-progress')!;

async function main() {
  await document.fonts.load('600 20px "JetBrains Mono"').catch(() => undefined);
  const topo = buildTopology();
  const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
  const store = new Store(topo, worker);

  const app = new Application();
  await app.init({
    background: C.bg,
    resizeTo: window,
    antialias: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    autoDensity: true,
    preference: 'webgl',
  });
  document.getElementById('pixi-host')!.append(app.canvas);
  const world = new Container();
  app.stage.addChild(world);
  app.stage.eventMode = 'static';

  const schematic = new Schematic(topo, store);
  const graph = new TrainGraph(topo, store);
  world.addChild(schematic.root, graph.root);

  // DOM overlay
  const overlay = document.getElementById('overlay')!;
  const header = new Header(store, () => showDayDialog());
  const side = new SidePanel(store, schematic);
  const tooltip = new Tooltip(store);
  overlay.append(header.el, side.el, legend(schematic), graphControls(graph), tooltip.el);
  initConfirm(overlay);

  // ------------------------------------------------------------ scaling
  let scale = 1;
  let ox = 0;
  let oy = 0;
  const texts = (): Text[] => [...schematic.allTexts(), ...graph.allTexts()];
  const applyTextResolution = () => {
    const res = Math.max(1, scale * (window.devicePixelRatio || 1));
    for (const t of texts()) if (t.resolution !== res) t.resolution = res;
  };
  const layout = () => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    scale = Math.min(W / DESIGN_W, H / DESIGN_H);
    ox = (W - DESIGN_W * scale) / 2;
    oy = (H - DESIGN_H * scale) / 2;
    world.scale.set(scale);
    world.position.set(ox, oy);
    overlay.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
    applyTextResolution();
  };
  window.addEventListener('resize', layout);
  store.on('textsChanged', () => applyTextResolution());
  layout();
  window.addEventListener('pointermove', (e) => tooltip.move((e.clientX - ox) / scale, (e.clientY - oy) / scale));

  // ------------------------------------------------------------ frame loop
  let fpsAcc = 0;
  let fpsN = 0;
  const fpsEl = h('div', { style: 'position:absolute;left:1880px;top:1120px;font:15px var(--font-mono);color:#56697c;pointer-events:none' });
  overlay.append(fpsEl);
  let updMs = 0;
  let schMs = 0;
  let grMs = 0;
  let renderMs = 0;
  const origRender = app.render.bind(app);
  app.render = () => {
    const t0 = performance.now();
    origRender();
    renderMs += performance.now() - t0;
  };
  app.ticker.add((tk) => {
    const now = performance.now();
    if (store.snap) {
      schematic.update(store.snap, now);
      const t1 = performance.now();
      schMs += t1 - now;
      graph.update(now);
      grMs += performance.now() - t1;
    }
    updMs += performance.now() - now;
    fpsAcc += tk.deltaMS;
    fpsN++;
    if (fpsAcc > 1000) {
      const s = store.snap;
      const perf = { fps: (fpsN * 1000) / fpsAcc, updateMs: updMs / fpsN, renderMs: renderMs / fpsN, schematicMs: schMs / fpsN, graphMs: grMs / fpsN };
      (window as unknown as { __perf: unknown }).__perf = perf;
      fpsEl.textContent = `${Math.round(perf.fps)} fps · 帧更新 ${perf.updateMs.toFixed(1)}ms · 渲染提交 ${perf.renderMs.toFixed(1)}ms · 仿真 ${s ? (s.stats.stepsPerSec * 0.1).toFixed(0) : 0}×`;
      fpsAcc = 0;
      fpsN = 0;
      updMs = 0;
      renderMs = 0;
      schMs = 0;
      grMs = 0;
    }
  });

  if (import.meta.env.DEV) (window as unknown as { __ats: unknown }).__ats = { store, schematic, graph, header };

  // ------------------------------------------------------------ start
  const veil = h('div', { class: 'progress-veil', style: 'display:none' });
  overlay.append(veil);
  store.on('progress', () => {
    const p = store.progress;
    if (!p) return;
    const msg = `推演中 ${fmtTime(p.t)} → ${fmtTime(p.target)}`;
    bootMsg.textContent = msg;
    bootBar.style.width = `${Math.min(100, Math.max(5, ((p.t - 4 * 3600) / Math.max(1, p.target - 4 * 3600)) * 100))}%`;
    veil.textContent = msg;
    veil.style.display = 'flex';
  });
  store.on('snap', () => { veil.style.display = 'none'; });
  store.on('ready', () => {
    document.getElementById('boot')!.style.display = 'none';
  });

  const today = new Date();
  // default to a weekday so the big/small route peak pattern is visible
  const d = new Date(today);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  const params = new URLSearchParams(location.search);
  const startParam = params.get('t');
  const start = startParam ? parseTime(startParam) : 7 * 3600 + 40 * 60;
  const holiday = params.get('holiday') === '1';
  const cfg: SimConfig = { dayType: dayTypeOf(d, holiday), dateLabel: dateLabel(d, holiday), date: isoDate(d), startTime: start, seed: 20251101 };
  bootMsg.textContent = `生成 ${cfg.dateLabel} 运行图并推演至 ${fmtTime(start)}…`;
  store.start(cfg);

  function showDayDialog() {
    const dateIn = h('input', { type: 'text', value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, style: 'width:200px' }) as HTMLInputElement;
    const hol = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const st = h('select', {}, ...[['04:30', '首班车前 04:30'], ['06:30', '早高峰前 06:30'], ['07:40', '早高峰 07:40'], ['12:00', '平峰 12:00'], ['17:40', '晚高峰 17:40'], ['21:30', '末班前 21:30']].map(([v, t]) => h('option', { value: v }, t))) as HTMLSelectElement;
    st.value = '07:40';
    const back = h('div', { class: 'modal-back' });
    const close = () => back.remove();
    const go = () => {
      const [y, m, dd] = dateIn.value.split('-').map(Number);
      const nd = new Date(y, (m || 1) - 1, dd || 1);
      if (Number.isNaN(nd.getTime())) return;
      const c: SimConfig = { dayType: dayTypeOf(nd, hol.checked), dateLabel: dateLabel(nd, hol.checked), date: isoDate(nd), startTime: parseTime(st.value), seed: 20251101 + nd.getDate() };
      close();
      veil.textContent = '生成运行图…';
      veil.style.display = 'flex';
      store.start(c);
    };
    back.append(h('div', { class: 'modal' },
      h('div', { class: 'modal-h' }, '运营日设置'),
      h('div', { class: 'modal-b' },
        h('div', { class: 'form' }, h('label', {}, '运营日期'), dateIn, h('label', {}, '节假日'), hol),
        h('div', { class: 'form', style: 'margin-top:14px' }, h('label', {}, '开始时刻'), st),
        h('div', { class: 'hint', style: 'margin-top:14px' }, '工作日采用早晚高峰大小交路运行图，双休日/节假日全天单一大交路。开始时刻之前的运营将以最高速度推演。'),
      ),
      h('div', { class: 'modal-f' }, h('button', { class: 'btn', onclick: close }, '取消'), h('button', { class: 'btn primary', onclick: go }, '开始')),
    ));
    overlay.append(back);
  }
}

function parseTime(v: string): number {
  const [hh, mm] = v.split(':').map(Number);
  return (hh || 0) * 3600 + (mm || 0) * 60;
}

function legend(schematic: Schematic) {
  const item = (cls: string, color: string, text: string) => h('span', {}, h(cls === 'b' ? 'b' : 'i', { style: `background:${color}` }), text);
  return h('div', { class: 'legend' },
    item('i', '#4f6a84', '空闲'), item('i', '#2b7a4b', '自动通过进路'), item('i', '#37e86f', '进路锁闭'), item('i', '#c77dff', 'CBTC列车占用'),
    item('i', '#ff3434', '计轴占用(非通信车)'), item('i', '#ff8a1f', '故障占用'), item('i', '#ffd500', '预复位/临时限速'),
    item('b', '#ff2b2b', '禁止'), item('b', '#1fe56a', '直向开放'), item('b', '#ffd400', '侧向开放'), item('b', '#3d4c5c', 'CBTC灭灯'),
    h('span', {}, '车次窗：表号-车次 · 边框 绿正点/黄晚点/红晚点>5分/灰非载客 · 标记 H扣车 C/R模式 T后备 ×通信中断 E紧急制动'),
    (() => {
      let on = false;
      const b = h('button', { class: 'btn small tgl', onclick: () => { on = !on; schematic.setDeviceNames(on); b.classList.toggle('on', on); } }, '信号机编号');
      return b;
    })(),
  );
}

function graphControls(graph: TrainGraph) {
  const spans: [number, string][] = [[3600, '1小时'], [3 * 3600, '3小时'], [6 * 3600, '6小时'], [22 * 3600, '全天']];
  const btns: HTMLButtonElement[] = [];
  const box = h('div', { class: 'graph-ctl' }, h('span', { class: 'ttl' }, '运行图 · 计划/实迹'));
  for (const [s, t] of spans) {
    const b = h('button', { class: `btn small ${s === 3 * 3600 ? 'on' : ''}`, onclick: () => { graph.setWindow(s); btns.forEach((x) => x.classList.toggle('on', x === b)); } }, t);
    btns.push(b);
    box.append(b);
  }
  box.append(h('span', { class: 'lg' },
    h('span', {}, h('i', { style: 'background:#5b8fe0' }), '计划·大交路'), h('span', {}, h('i', { style: 'background:#3fc07e' }), '计划·小交路'),
    h('span', {}, h('i', { style: 'background:#9fb2c4' }), '出入库'), h('span', {}, h('i', { style: 'background:#ffa53d' }), '加开'),
    h('span', {}, h('i', { style: 'background:#ff6fb5' }), '调整'), h('span', {}, h('i', { style: 'background:#ff5050;height:5px' }), '实迹')));
  return box;
}

main().catch((e) => {
  bootMsg.textContent = `启动失败：${e instanceof Error ? e.message : String(e)}`;
  console.error(e);
});
