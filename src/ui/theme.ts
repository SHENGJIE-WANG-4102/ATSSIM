/** Colour tokens shared by the Pixi renderer and the DOM panels. */
export const C = {
  bg: 0x04070b,
  panel: 0x0a1018,
  grid: 0x111b26,
  gridStrong: 0x1b2a3a,
  text: 0xc8d4e0,
  textDim: 0x6c7e90,
  textBright: 0xffffff,
  line: 0x8cc220,

  trackFree: 0x4f6a84,
  trackFreeSide: 0x3e5468,
  routeAuto: 0x2b7a4b,
  routeSet: 0x37e86f,
  routeGuide: 0xf0f0f0,
  occAxle: 0xff3434,
  occComm: 0xc77dff,
  disturbed: 0xff8a1f,
  preset: 0xffd500,
  tsr: 0xffd500,
  jointGap: 0x04070b,

  sigRed: 0xff2b2b,
  sigGreen: 0x1fe56a,
  sigYellow: 0xffd400,
  sigWhite: 0xf2f2f2,
  sigDark: 0x3d4c5c,
  sigMast: 0x8b9cad,

  platform: 0x23384c,
  platformEdge: 0x4d7090,
  platformHold: 0xffd400,
  platformSkip: 0x4fc3f7,
  platformEsp: 0xff2b2b,

  trainCbtc: 0xb65cff,
  trainTbtc: 0xff7a1a,
  trainRm: 0xffc400,
  trainFail: 0xff2b2b,
  trainBoxFill: 0x0c1520,
  onTime: 0x2fd06a,
  slightLate: 0xffcc00,
  late: 0xff4040,
  early: 0x4fc3f7,
  nonService: 0x8798aa,
  selection: 0x00e5ff,

  planBig: 0x5b8fe0,
  planSmall: 0x3fc07e,
  planLate: 0x9a8cff,
  planExtra: 0xffa53d,
  planIns: 0x9fb2c4,
  planEmpty: 0x55616e,
  planAdj: 0xff6fb5,
  actual: 0xff5050,
  nowLine: 0xffd400,
};

export const FONT_CN = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", "Hiragino Sans GB", "WenQuanYi Micro Hei", sans-serif';
export const FONT_MONO = '"JetBrains Mono", "Consolas", "Menlo", monospace';

export const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

export const DESIGN_W = 3840;
export const DESIGN_H = 2160;

/** Layout regions in design coordinates */
export const REGION = {
  headerH: 104,
  schematicBottom: 1092,
  graph: { x: 0, y: 1104, w: 2548, h: 1056 },
  side: { x: 2560, y: 1104, w: 1280, h: 1056 },
};

export function fmtTime(t: number, sec = true): string {
  const s = Math.floor(((t % 86400) + 86400) % 86400);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return sec ? `${pad(h)}:${pad(m)}:${pad(ss)}` : `${pad(h)}:${pad(m)}`;
}
export const pad = (n: number) => String(n).padStart(2, '0');

export function fmtDelay(d: number): string {
  const a = Math.abs(Math.round(d));
  const m = Math.floor(a / 60);
  const s = a % 60;
  return `${d < 0 ? '早' : '晚'}${m}'${pad(s)}"`;
}
