/**
 * 上海轨道交通2号线 线路基础数据
 *
 * All real-world facts (station order, names, inter-station distances, depot
 * junction stations, terminus first/last trains) are taken from the public
 * sources listed in SOURCES. Everything flagged `approx: true` (or living in
 * the LAYOUT / OPERATIONS blocks) is a plausible approximation because the
 * real values are not public — see README "近似处理" for the full list.
 *
 * Nothing in this file is used directly for drawing; the topology builder
 * (src/sim/topology.ts) turns it into a track graph that both the simulation
 * worker and the renderer consume.
 */

export interface SourceRef {
  id: string;
  title: string;
  url: string;
  used: string;
}

export const SOURCES: SourceRef[] = [
  {
    id: 'wiki-zh',
    title: '上海轨道交通2号线 — 维基百科（车站列表：站间距、里程）',
    url: 'https://zh.wikipedia.org/zh-hans/%E4%B8%8A%E6%B5%B7%E8%BD%A8%E9%81%93%E4%BA%A4%E9%80%9A2%E5%8F%B7%E7%BA%BF',
    used: '31座车站顺序、各站站间距（米）、以蟠祥路·国家会计学院为0点的里程、全长62.2 km',
  },
  {
    id: 'jtw-20251027',
    title: '上海市交通委：定了！2号线蟠祥路·国家会计学院站11月1日首班车起开通初期运营',
    url: 'https://jtw.sh.gov.cn/xwfb2/20251027/14557ac7aeaa4e95a61cce023ce01a55.html',
    used: '西端新终点站开通日期；首班05:25、往浦东1号2号航站楼末班21:57、往广兰路末班22:42；浦东1号2号航站楼始发末班到达蟠祥路00:05；大小交路方式',
  },
  {
    id: 'thepaper-20251101',
    title: '澎湃新闻：上海地铁2号线“上新”，蟠祥路·国家会计学院站正式开通',
    url: 'https://www.thepaper.cn/newsDetail_forward_31871679',
    used: '西延伸长约1.67 km、地下二层岛式站台；工作日高峰大小交路（小交路淞虹路—广兰路），平峰及双休日大交路',
  },
  {
    id: 'thepaper-20240921',
    title: '澎湃新闻：上海9座地铁站改名（2024-09-21）',
    url: 'https://www.thepaper.cn/newsDetail_forward_28825374',
    used: '徐泾东→国家会展中心、东昌路→浦东南路、浦东国际机场→浦东1号2号航站楼',
  },
  {
    id: 'shgov-20240227',
    title: '上海市政府：2号线“双套信号系统”就像手机的“双卡双待”',
    url: 'https://www.shanghai.gov.cn/nw4411/20240227/180dcb4ed7aa4c48b38cf0761062580c.html',
    used: 'CBTC 主用 + TBTC 备用的双系统、可一键切换',
  },
  {
    id: 'jtw-20240129',
    title: '上海市交通委：轨道交通2号线信号系统完成阶段性改造平稳投运',
    url: 'https://jtw.sh.gov.cn/xydt/20240129/723ad1281785433db88e237f2c0748a0.html',
    used: 'CBTC 于2024-01-27投入运行；TBTC 作为降级/备用系统',
  },
  {
    id: 'wiki-depots',
    title: '上海轨道交通车辆基地 — 维基百科',
    url: 'https://zh.wikipedia.org/zh-hans/%E4%B8%8A%E6%B5%B7%E8%BD%A8%E9%81%93%E4%BA%A4%E9%80%9A%E8%BD%A6%E8%BE%86%E5%9F%BA%E5%9C%B0',
    used: '北翟路基地接轨淞虹路（淞虹路西北）、龙阳路车辆段接轨龙阳路（龙阳路东北）、川沙停车场接轨远东大道（远东大道东）',
  },
  {
    id: 'china-emu-02a05',
    title: '02A05 型列车资料（6M2T，8辆编组，最高运营速度80 km/h）',
    url: 'https://www.china-emu.cn/Trains/Cityrails/Model/M-203-T.html',
    used: '8辆A型车编组、最高运营速度 80 km/h；02A05 编号 02086—02116（31列）',
  },
  {
    id: 'wiki-02a01',
    title: '上海地铁02A01型电动列车 — 维基百科',
    url: 'https://zh.wikipedia.org/zh-hans/%E4%B8%8A%E6%B5%B7%E5%9C%B0%E9%93%8102A01%E5%9E%8B%E7%94%B5%E5%8A%A8%E5%88%97%E8%BD%A6',
    used: '02A01（原AC02）16列，编号 0201—0216',
  },
  {
    id: 'wiki-02a02',
    title: '上海地铁02A02型电动列车 — 维基百科',
    url: 'https://zh.wikipedia.org/zh-hans/%E4%B8%8A%E6%B5%B7%E5%9C%B0%E9%93%8102A02%E5%9E%8B%E7%94%B5%E5%8A%A8%E5%88%97%E8%BD%A6',
    used: '02A02（原AC08）21列，编号 0233—0253',
  },
  {
    id: 'wiki-02a03-04',
    title: '上海地铁02A03型、02A04型电动列车 — 维基百科',
    url: 'https://zh.wikipedia.org/wiki/%E4%B8%8A%E6%B5%B7%E5%9C%B0%E9%93%8102A03%E5%9E%8B%E3%80%8102A04%E5%9E%8B%E7%94%B5%E5%8A%A8%E5%88%97%E8%BD%A6',
    used: '02A03（原AC17a）16列，编号 0254—0269；02A04（原AC17b，已扩编为8辆）16列，编号 0270—0285',
  },
  {
    id: 'whb-100th',
    title: '文汇报：地铁2号线喜提第100列列车（2020-06-02）',
    url: 'https://wenhui.whb.cn/third/zaker/202006/02/352215.html',
    used: '2号线配属列车总数 100 列（末列增购车 02116）',
  },
];

export interface StationData {
  /** short stable id used in code */
  id: string;
  /** current official Chinese name */
  name: string;
  /** former name(s), for the info panel */
  formerName?: string;
  /** distance from the previous station in metres (source: wiki-zh), null for the first */
  interM: number | null;
  /** interchange lines (display only) */
  transfers: string[];
  /** planned base dwell in seconds (approximation) */
  dwell: number;
  /** relative passenger demand weight (approximation, 1 = average) */
  demand: number;
}

/**
 * Stations, west → east. `interM` values are the 站间距 column of the
 * Chinese Wikipedia station table. The 蟠祥路·国家会计学院—国家会展中心 value
 * (1640 m) is derived from the difference between the table's chainage
 * (zero at 蟠祥路·国家会计学院) and the pre-extension chainage (zero at
 * 徐泾东), which differ by a constant 1640 m; the official extension length
 * is quoted as "约1.67 km". Summing the table gives 61 941 m to the eastern
 * terminus versus 61 940 m in the table (1 m rounding).
 */
export const STATIONS: StationData[] = [
  { id: 'PXL', name: '蟠祥路·国家会计学院', interM: null, transfers: [], dwell: 60, demand: 0.35 },
  { id: 'GJH', name: '国家会展中心', formerName: '徐泾东', interM: 1640, transfers: ['17'], dwell: 35, demand: 0.7 },
  { id: 'HQZ', name: '虹桥火车站', interM: 1842, transfers: ['10', '17', '机场联络线', '国铁'], dwell: 45, demand: 1.6 },
  { id: 'HQ2', name: '虹桥2号航站楼', interM: 690, transfers: ['10', '机场联络线'], dwell: 40, demand: 1.0 },
  { id: 'SHR', name: '淞虹路', interM: 5921, transfers: [], dwell: 30, demand: 0.8 },
  { id: 'BXJ', name: '北新泾', interM: 1367, transfers: [], dwell: 30, demand: 0.9 },
  { id: 'WNL', name: '威宁路', interM: 1260, transfers: [], dwell: 30, demand: 0.9 },
  { id: 'LSG', name: '娄山关路', interM: 1661, transfers: ['15'], dwell: 35, demand: 1.1 },
  { id: 'ZSG', name: '中山公园', interM: 1618, transfers: ['3', '4'], dwell: 45, demand: 1.5 },
  { id: 'JSL', name: '江苏路', interM: 1466, transfers: ['11'], dwell: 40, demand: 1.2 },
  { id: 'JAS', name: '静安寺', interM: 1425, transfers: ['7', '14'], dwell: 45, demand: 1.5 },
  { id: 'NJX', name: '南京西路', interM: 1490, transfers: ['12', '13'], dwell: 45, demand: 1.5 },
  { id: 'RMG', name: '人民广场', interM: 1330, transfers: ['1', '8'], dwell: 50, demand: 2.0 },
  { id: 'NJD', name: '南京东路', interM: 1125, transfers: ['10'], dwell: 45, demand: 1.6 },
  { id: 'LJZ', name: '陆家嘴', interM: 1834, transfers: ['14'], dwell: 45, demand: 1.6 },
  { id: 'PDN', name: '浦东南路', formerName: '东昌路', interM: 1367, transfers: ['14'], dwell: 35, demand: 1.0 },
  { id: 'SJD', name: '世纪大道', interM: 1245, transfers: ['4', '6', '9'], dwell: 50, demand: 2.0 },
  { id: 'KJG', name: '上海科技馆', interM: 1810, transfers: [], dwell: 30, demand: 0.8 },
  { id: 'SJG', name: '世纪公园', interM: 1454, transfers: [], dwell: 30, demand: 0.8 },
  { id: 'LYL', name: '龙阳路', interM: 1100, transfers: ['7', '16', '18', '磁浮'], dwell: 45, demand: 1.4 },
  { id: 'ZJG', name: '张江高科', interM: 2940, transfers: [], dwell: 35, demand: 1.2 },
  { id: 'JKL', name: '金科路', interM: 1393, transfers: [], dwell: 30, demand: 0.9 },
  { id: 'GLL', name: '广兰路', interM: 2055, transfers: [], dwell: 35, demand: 1.0 },
  { id: 'TZ', name: '唐镇', interM: 3393, transfers: [], dwell: 30, demand: 0.9 },
  { id: 'CXZ', name: '创新中路', interM: 1788, transfers: [], dwell: 30, demand: 0.5 },
  { id: 'HXD', name: '华夏东路', interM: 2100, transfers: [], dwell: 30, demand: 0.6 },
  { id: 'CS', name: '川沙', interM: 2756, transfers: [], dwell: 30, demand: 0.8 },
  { id: 'LKL', name: '凌空路', interM: 2595, transfers: [], dwell: 30, demand: 0.4 },
  { id: 'YDD', name: '远东大道', interM: 3070, transfers: [], dwell: 30, demand: 0.3 },
  { id: 'HTS', name: '海天三路', interM: 5918, transfers: [], dwell: 30, demand: 0.3 },
  { id: 'PDA', name: '浦东1号2号航站楼', formerName: '浦东国际机场', interM: 2287, transfers: ['磁浮', '机场联络线'], dwell: 60, demand: 0.9 },
];

/** Station chainage (platform centre) in metres from 蟠祥路·国家会计学院. */
export function stationChainages(): number[] {
  const out: number[] = [];
  let c = 0;
  for (const s of STATIONS) {
    if (s.interM !== null) c += s.interM;
    out.push(c);
  }
  return out;
}

export const LINE_INFO = {
  name: '上海轨道交通2号线',
  shortName: '2号线',
  color: 0x8cc220,
  colorCss: '#8cc220',
  /** 8-car A-type train length (m) — 02A05 etc. ~185 m over couplers (approx). */
  trainLength: 186,
  /** platform length used for drawing/berths (approx) */
  platformLength: 190,
  maxSpeedKmh: 80,
  /** rated / crush capacity of an 8-car A-type train (approx, 6 / 9 p/m²) */
  capacity: 2480,
  crushCapacity: 3200,
  /** total fleet size: 100 trains, see FLEET */
  fleet: 100,
};

/**
 * Line 2 fleet by type with the real train numbers (sources: wiki-02a01,
 * wiki-02a02, wiki-02a03-04, china-emu-02a05, whb-100th). The older types
 * are numbered in the 4-digit form (0201), 02A05 in the 5-digit form (02086).
 * All types are 8-car A-type trains with an 80 km/h maximum operating speed
 * (the sim uses one performance model for all of them).
 */
export const FLEET_TYPES: { type: string; from: number; to: number; digits: 4 | 5; source: string }[] = [
  { type: '02A01', from: 1, to: 16, digits: 4, source: 'wiki-02a01' },
  { type: '02A02', from: 33, to: 53, digits: 4, source: 'wiki-02a02' },
  { type: '02A03', from: 54, to: 69, digits: 4, source: 'wiki-02a03-04' },
  { type: '02A04', from: 70, to: 85, digits: 4, source: 'wiki-02a03-04' },
  { type: '02A05', from: 86, to: 116, digits: 5, source: 'china-emu-02a05' },
];

/** every train of the fleet in number order: { no: '0201' | '02086', type } */
export const FLEET: { no: string; type: string; n: number }[] = FLEET_TYPES.flatMap((ft) =>
  Array.from({ length: ft.to - ft.from + 1 }, (_, i) => {
    const n = ft.from + i;
    return { no: ft.digits === 5 ? `02${String(n).padStart(3, '0')}` : `02${String(n).padStart(2, '0')}`, type: ft.type, n };
  }));

/** fleet entry for a train number, or undefined */
export function fleetEntry(no: string): { no: string; type: string; n: number } | undefined {
  return FLEET.find((f) => f.no === no);
}

/**
 * 上行 / 下行 convention used throughout the UI. The real Shanghai Metro
 * labelling for Line 2 is not stated in the sources; here 下行 = eastbound
 * (towards 浦东1号2号航站楼), 上行 = westbound (approximation).
 */
export const DIRECTIONS = {
  DN: { label: '下行', towards: '往浦东1号2号航站楼', prefix: 'X' },
  UP: { label: '上行', towards: '往蟠祥路·国家会计学院', prefix: 'S' },
} as const;

// ---------------------------------------------------------------------------
// Track layout (APPROXIMATIONS — real positions of switches, crossovers,
// turnback tracks and sidings are not public)
// ---------------------------------------------------------------------------

export type CrossoverKind = '/' | '\\';

export interface CrossoverDef {
  /** station index the crossover belongs to (for naming) */
  station: number;
  /** offset of crossover centre from the station centre (m, + = east) */
  offset: number;
  kind: CrossoverKind;
}

export interface SidingDef {
  id: string;
  name: string;
  station: number;
  /** which side of the station the siding lies on */
  side: 'west' | 'east';
  /** distance from station centre to the siding's attached (station-side) end */
  attachOffset: number;
  length: number;
}

export interface TailDef {
  station: number;
  side: 'west' | 'east';
  /** usable tail length beyond the scissors crossover */
  length: number;
}

export interface DepotDef {
  id: string;
  name: string;
  short: string;
  /** station whose interval hosts the junction */
  station: number;
  /** offset of the junction centre from that station centre (m, + = east) */
  junctionOffset: number;
  stablingTracks: number;
  capacity: number;
  /** seconds from leaving a stabling track to reaching the transfer-track gate */
  exitTime: number;
  source: string;
}

export const LAYOUT = {
  /** terminal tail tracks with scissors crossovers (站后折返) */
  tails: [
    { station: 0, side: 'west', length: 300 },
    { station: 30, side: 'east', length: 300 },
  ] as TailDef[],
  /** middle turnback / storage sidings (尽头折返线) */
  sidings: [
    { id: 'GJH', name: '国家会展中心存车线', station: 1, side: 'west', attachOffset: 170, length: 330 },
    { id: 'SHR', name: '淞虹路折返线', station: 4, side: 'west', attachOffset: 170, length: 330 },
    { id: 'ZSG', name: '中山公园折返线', station: 8, side: 'west', attachOffset: 170, length: 330 },
    { id: 'LYL', name: '龙阳路折返线', station: 19, side: 'west', attachOffset: 170, length: 330 },
    { id: 'GLL', name: '广兰路折返线', station: 22, side: 'east', attachOffset: 170, length: 330 },
    { id: 'CS', name: '川沙存车线', station: 26, side: 'east', attachOffset: 170, length: 330 },
  ] as SidingDef[],
  /** single crossovers for station-front turnback / degraded working (渡线) */
  crossovers: [
    { station: 2, offset: 210, kind: '/' },
    { station: 2, offset: -210, kind: '/' },
    { station: 8, offset: 330 + 220, kind: '/' },
    { station: 12, offset: -215, kind: '/' },
    { station: 12, offset: 215, kind: '/' },
    { station: 16, offset: -215, kind: '/' },
    { station: 16, offset: 215, kind: '/' },
    { station: 19, offset: -560, kind: '/' },
    { station: 22, offset: -215, kind: '/' },
    { station: 23, offset: 215, kind: '/' },
    { station: 23, offset: -215, kind: '/' },
    { station: 26, offset: -215, kind: '/' },
    { station: 28, offset: -215, kind: '/' },
  ] as CrossoverDef[],
  depots: [
    {
      id: 'BZL', name: '北翟路车辆段', short: '北翟路', station: 4, junctionOffset: -1300,
      stablingTracks: 14, capacity: 40, exitTime: 240, source: 'wiki-depots（接轨淞虹路，淞虹路西北）',
    },
    {
      id: 'LYD', name: '龙阳路车辆段', short: '龙阳路', station: 19, junctionOffset: 700,
      stablingTracks: 12, capacity: 30, exitTime: 240, source: 'wiki-depots（接轨龙阳路，龙阳路东北）',
    },
    {
      id: 'CSD', name: '川沙停车场', short: '川沙', station: 28, junctionOffset: 900,
      stablingTracks: 8, capacity: 30, exitTime: 200, source: 'wiki-depots（接轨远东大道，远东大道东）',
    },
  ] as DepotDef[],
  /** ZC (zone controller) / TBTC control areas, by station index boundaries */
  zones: [
    { id: 'ZC1', name: 'ZC1 蟠祥路—娄山关路', fromStation: 0, toStation: 7 },
    { id: 'ZC2', name: 'ZC2 中山公园—浦东南路', fromStation: 8, toStation: 15 },
    { id: 'ZC3', name: 'ZC3 世纪大道—广兰路', fromStation: 16, toStation: 22 },
    { id: 'ZC4', name: 'ZC4 唐镇—浦东1号2号航站楼', fromStation: 23, toStation: 30 },
  ],
  /** maximum plain-line axle-counter section length (m) */
  maxSectionLength: 450,
};

/**
 * Permanent speed restrictions (km/h) by chainage range, both tracks.
 * Line maximum is 80 km/h (source: china-emu-02a05); local restrictions
 * below are approximations for curves / river crossing / terminal approach.
 */
export const SPEED_LIMITS: { from: number; to: number; kmh: number; reason: string }[] = [
  { from: -1000, to: 250, kmh: 55, reason: '终点站区域' },
  { from: 3200, to: 3800, kmh: 60, reason: '虹桥枢纽曲线' },
  { from: 14800, to: 15500, kmh: 65, reason: '中山公园站曲线' },
  { from: 17200, to: 17800, kmh: 65, reason: '静安寺曲线' },
  { from: 22500, to: 23400, kmh: 70, reason: '南京东路—陆家嘴（越江段）' },
  { from: 23400, to: 25600, kmh: 65, reason: '越江隧道及陆家嘴曲线' },
  { from: 30900, to: 31500, kmh: 65, reason: '龙阳路站曲线' },
  { from: 61650, to: 63000, kmh: 55, reason: '终点站区域' },
];

/** diverging speeds (km/h) — approximations for 9号 / 12号 turnouts */
export const TURNOUT_SPEEDS = {
  crossover: 35,
  siding: 30,
  depot: 25,
  tail: 40,
};

// ---------------------------------------------------------------------------
// Operations (published anchors + approximations)
// ---------------------------------------------------------------------------

export const OPERATIONS = {
  /** published: first train from 蟠祥路·国家会计学院 05:25 */
  firstWestTerminusDep: 5 * 3600 + 25 * 60,
  /** approx: first westbound from 浦东1号2号航站楼 */
  firstEastTerminusDep: 5 * 3600 + 30 * 60,
  /** published: last 蟠祥路 → 浦东1号2号航站楼 21:57 */
  lastBigEastboundDep: 21 * 3600 + 57 * 60,
  /** published: last 蟠祥路 → 广兰路 22:42 */
  lastLateEastboundDep: 22 * 3600 + 42 * 60,
  /** published: last westbound from 浦东1号2号航站楼 arrives 蟠祥路 00:05 — the departure is derived from run times */
  lastBigWestboundArrival: 24 * 3600 + 5 * 60,
  /** approx: last westbound from 广兰路 */
  lastLateWestboundDep: 23 * 3600 + 20 * 60,
  /** reference headways (late 2025): core 2'30", outer ≈3'45" average */
  peakCoreHeadway: 150,
  /** minimum turnback (arrival → departure) at each terminal (approx) */
  minTurnback: { PXL: 300, PDA: 300, SHR: 300, GLL: 300 } as Record<string, number>,
  /** overnight stabling at terminal tails (approx) */
  terminalStabling: { PXL: 2, PDA: 2 } as Record<string, number>,
};

// ---------------------------------------------------------------------------
// Environment (APPROXIMATIONS)
// ---------------------------------------------------------------------------

/**
 * Exposed (non-tunnel) parts of the line, by chainage. The east extension
 * leaves the tunnel east of 广兰路 and runs on viaduct through 唐镇 … 海天三路,
 * reaching 浦东1号2号航站楼 at grade. Exact portal positions are not public;
 * the ranges below are approximations (see README).
 */
export const EXPOSED: { from: number; to: number; kind: 'elevated' | 'ground'; name: string }[] = [
  { from: 37400, to: 60900, kind: 'elevated', name: '广兰路以东—海天三路 高架段' },
  { from: 60900, to: 63000, kind: 'ground', name: '浦东1号2号航站楼 地面段' },
];

/**
 * Weather restrictions for exposed sections (approximation of typical
 * operating rules): wind level index 1..4 ≈ 7/8/9/≥10 级 (Beaufort), rain = 暴雨.
 * 0 km/h = service suspended on viaducts.
 */
export const WEATHER_RULES = {
  wind: [
    { level: 1, label: '大风蓝色（7级）', kmh: 60, elevatedOnly: true },
    { level: 2, label: '大风黄色（8级）', kmh: 45, elevatedOnly: true },
    { level: 3, label: '大风橙色（9级）', kmh: 25, elevatedOnly: true },
    { level: 4, label: '大风红色（≥10级）', kmh: 0, elevatedOnly: true },
  ],
  rain: { label: '暴雨', kmh: 60, elevatedOnly: false },
};

/**
 * Night engineering possessions (施工封锁): candidate station intervals
 * (west station index; the interval runs to the next station) and the
 * usual time window. Approximation — real 施工计划 are not public.
 */
export const POSSESSIONS = {
  candidates: [5, 6, 9, 13, 17, 20, 23, 24, 26],
  /** possessions active at the start of the operating day, released before the first trains */
  morningUntil: 4 * 3600 + 20 * 60,
  /** late-night window (must finish before the 03:45 day rollover) */
  nightFrom: 24 * 3600 + 50 * 60,
  nightTo: 27 * 3600 + 30 * 60,
};
