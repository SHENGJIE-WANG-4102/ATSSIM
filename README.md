# 上海轨道交通2号线 · ATS 中央监视模拟器

A browser-based simulator of the OCC (控制中心) ATS overview wall for Shanghai Metro
Line 2 as operated from 2025-11-01: 31 stations from **蟠祥路·国家会计学院** to
**浦东1号2号航站楼**, CBTC primary with TBTC backup, interlocking, a full weekday or
weekend service generated from parametric timetable templates, dispatcher commands
and fault injection. The UI is in Simplified Chinese and laid out for a 3840×2160 wall.

## Run

```bash
npm install
npm run dev          # http://localhost:5173  (opens at 07:40 on a weekday)
npm run build        # type-check + production build into dist/
npm run preview      # serve the production build
npm test             # headless simulation tests (full days + fault/command scenarios, ~10 min)
```

URL options: `?t=17:30` sets the start time (the day is simulated from 04:00 at full
speed up to that time first), `?holiday=1` uses the weekend/holiday timetable.
Use browser full-screen (F11) on a 4K display; the layout scales uniformly to any
smaller window.

Keyboard: `Space` pause/resume, `+`/`-` simulation speed.

## What you see

* **Header**: clock, operating day and current timetable period, simulation speed
  (1×–120×, pause, fast-forward to a time, restart with another date), the level of each
  ZC area (CBTC / TBTC / ZC故障), KPIs (trains on line, in service, late, punctuality,
  completed trips, boardings) and A/B/C alarm counters.
* **Line overview** (two rows: 蟠祥路·国家会计学院→陆家嘴, 浦东南路→浦东1号2号航站楼):
  every axle-counter section coloured by state (free, automatic route, locked route,
  CBTC occupancy, non-communicating occupancy, fault, preset), switches with their
  position/loss of detection, signals with aspects (red/green/yellow/guide/CBTC dark/
  failed), platforms with screen-door state, hold/skip/ESP badges and waiting passengers,
  the three depots with trains in depot, ZC area boundaries (TBTC areas tinted), TSRs,
  and every train as a body on the track plus a train-number window (表号-车次) whose
  border shows punctuality and flags (H hold, C/R mode, T backup level, × no
  communication, E emergency brake, ! failed).
* **Train graph**: planned lines (big route, small route, depot runs, added trains,
  adjusted trips) and actual lines, scrolling with the clock; 1 h / 3 h / 6 h / whole-day
  windows.
* **Right panels**: live alarm list (click to acknowledge), and tabs for 命令 (commands for
  the selected object), 事件 (event log with filters), 列车 (train list), 教员台 (fault
  injection) and 计划 (timetable templates and day plan).

## Dispatcher commands (select → command → confirm)

Click an object on the overview, choose a command in **命令**, confirm in the dialog.
Safety-critical commands need a second, timed confirmation with swapped buttons.

| Object | Commands |
|---|---|
| Signal | 办理进路 (route list with preview), 取消进路 (30 s delayed release when approach-locked), 引导进路 ★, 自动通过 on/off, 自动排列(ARS) on/off |
| Switch | 单操定位/反位, 单锁/单解, 钩锁确认 ★, 取消钩锁 |
| Section | 计轴预复位 ★, 区段故障解锁 ★, 设置/取消临时限速 ★ (one section or the whole station interval) |
| Platform | 扣车/取消扣车, 跳停/取消跳停, 紧急关闭/取消 ★, 站台门互锁解除 ★ |
| Train | 扣车/放行, 跳停 (chosen station), 人工折返 (stations ahead with front/rear turnback), 退出服务 (clear passengers, return to depot), 授权RM ★, 组织救援 ★ (failed train only) |
| System (nothing selected) | 切换TBTC / 恢复CBTC per ZC area or whole line ★, 加开列车 (depot → turnback station → depot at a given time), 加开运行图 templates (进博会保障, 虹桥枢纽大客流) |

★ = two-step confirmation.

## Faults (教员台) and recovery

| Fault | Consequence in the simulation | Recovery |
|---|---|---|
| 列车车地通信中断 | ZC loses the train; its sections become non-communicating occupancy, followers stop at the section boundary; the train's MA expires → EB | Driver switches to TBTC/CM after 30 s and runs under section-occupancy protection; upgrades to CBTC/AM when communication returns |
| ZC 故障 (one area or whole line) | CBTC trains in the area lose MA and stop; trains outside cannot enter | 切换TBTC (★) → trains run under TBTC fixed block; after repair 恢复CBTC (★); restoring before repair is refused |
| 计轴区段故障占用 | Section shows fault occupancy; CBTC trains stop before it | Reset is refused until maintenance is done; then 计轴预复位 (★); the first train sweeps it in RM and the section clears. Before that, 授权RM / 引导进路 can pass trains |
| 道岔失表 | Routes over the switch cannot be set; trains stop at the protecting signal | 单操 attempts fail until repaired; 钩锁确认 (★) then 引导进路 (★) → RM ≤25 km/h; after repair 单操 restores detection, 取消钩锁 |
| 信号机故障 | Signal cannot clear, its route is cancelled; trains stop at it | 引导进路 (★) per train, RM passage; repair restores automatic routes |
| 站台门故障 | At the next door close the PSD cannot lock: the train cannot leave and the next train cannot enter | 站台门互锁解除 (★); every train then loses ~25 s for manual confirmation until repaired |
| 列车故障 | Train stops (EB); followers queue behind it. "Recoverable" clears after driver troubleshooting | Non-recoverable: 组织救援 (★) with the following train → it clears passengers, approaches in RM, couples (≤3 km/h, 60 s), pushes to the next station, clears passengers, returns to depot; remaining trips of both trains are cancelled on the graph |
| 车站大客流 | Arrival rate ×N at a station: crowding alarm, longer dwells, full trains, delays | Holding, skip-stop, added trains / added-service templates |

Every automatic and manual event goes to the event log; alarms stay active until the
condition clears and can be acknowledged.

## Engineering

* **Stack**: Vite + TypeScript, PixiJS 8 (WebGL) for the overview and the train graph,
  DOM for panels. Static geometry is built once; per frame only tints, visibility and
  the train layer change. Graph lines are cached in hourly chunks and actual lines are
  appended incrementally.
* **Simulation** runs in a Web Worker (`src/sim/worker.ts`) with a fixed 0.1 s step,
  decoupled from rendering, with time acceleration; snapshots stream to the UI at 20 Hz
  as packed typed arrays.
* `src/data/line2.ts` holds all line data (stations, distances, sources, layout
  approximations, depots, speed limits, operating anchors); `src/sim/topology.ts` turns
  it into a node/link track graph with 483 axle-counter sections, 59 switches,
  300 signals and 389 interlocking routes generated automatically.
* `interlocking.ts` (routes, switch locking, sectional release, approach locking,
  guide routes, aspects), `movement.ts` (MA scan: CBTC moving block behind the
  preceding train's tail, fixed-block TBTC by section occupancy, RM on sight; ATP/ATO
  control), `ats.ts` (task execution, ARS with plan-order arbitration, regulation,
  commands), `timetable.ts` (templates, circulation, insertion/withdrawal), `faults.ts`,
  `passengers.ts`.
* **Tests** (`tests/`): a full weekday and weekend (every planned revenue trip runs,
  no collision, no emergency brakes, ≥98 % on time, everything returns to depot or
  overnight stabling), plus one scenario per fault type and dispatcher command.

## Timetable

Generated from parametric templates (no real timetable is copied):

| Template | Parameters |
|---|---|
| 工作日早高峰 / 晚高峰 | pattern big–big–small, 2'30" through 淞虹路–广兰路 → outer sections alternate 2'30"/5'00" (avg 3'45"), dwell ×1.15/×1.1 |
| 工作日平峰 | big route only, 5'30" (plus 5'00" pre-peak transition and 7'00" evening) |
| 双休日/节假日 | big route only all day, 4'30" daytime |
| 首末班及收车 | first train 05:25 from 蟠祥路·国家会计学院; last 蟠祥路→浦东1号2号航站楼 21:57, then 蟠祥路↔广兰路 until 22:42 (eastbound) / ~23:20 (westbound); last westbound from the airport timed to reach 蟠祥路 at ~00:05; trains then run empty to depots or stable in terminal tails |
| 加开 | 进博会保障 (国家会展中心↔广兰路), 虹桥枢纽大客流 (虹桥火车站↔广兰路, station-front turnback at 虹桥火车站), or a single extra train from any depot |

Departure streams are laid out at a reference station per direction (淞虹路 eastbound,
广兰路 westbound) so the core section has uniform headways. Trips are linked into train
blocks by FIFO matching at each terminal (minimum turnback 5 min, layover ≤ 25 min,
terminal capacity respected). Missing trains are supplied by revenue insertion trips
from the nearest depot placed into gaps of the stream (e.g. peak insertion from
龙阳路车辆段 for small-route trains at 广兰路), surplus trains withdraw the same way.
Weekday peak uses 65 trains, within the 76-train fleet.

## Data sources

| Data | Source |
|---|---|
| Station order, inter-station distances (站间距), chainage, 62.2 km length | [上海轨道交通2号线 — 维基百科](https://zh.wikipedia.org/zh-hans/%E4%B8%8A%E6%B5%B7%E8%BD%A8%E9%81%93%E4%BA%A4%E9%80%9A2%E5%8F%B7%E7%BA%BF) station table |
| West extension opening 2025-11-01, first/last trains, big/small route pattern | [上海市交通委 2025-10-27](https://jtw.sh.gov.cn/xwfb2/20251027/14557ac7aeaa4e95a61cce023ce01a55.html), [澎湃新闻 2025-11-01](https://www.thepaper.cn/newsDetail_forward_31871679) |
| Renaming 徐泾东→国家会展中心, 东昌路→浦东南路, 浦东国际机场→浦东1号2号航站楼 | [澎湃新闻 2024-09-21](https://www.thepaper.cn/newsDetail_forward_28825374) |
| CBTC primary + TBTC backup with switchover | [上海市政府 2024-02-27](https://www.shanghai.gov.cn/nw4411/20240227/180dcb4ed7aa4c48b38cf0761062580c.html), [上海市交通委 2024-01-29](https://jtw.sh.gov.cn/xydt/20240129/723ad1281785433db88e237f2c0748a0.html) |
| Depot junction stations (北翟路→淞虹路, 龙阳路→龙阳路, 川沙→远东大道) | [上海轨道交通车辆基地 — 维基百科](https://zh.wikipedia.org/zh-hans/%E4%B8%8A%E6%B5%B7%E8%BD%A8%E9%81%93%E4%BA%A4%E9%80%9A%E8%BD%A6%E8%BE%86%E5%9F%BA%E5%9C%B0) |
| 8-car trains, 80 km/h operating speed | [02A05 车型资料](https://www.china-emu.cn/Trains/Cityrails/Model/M-203-T.html) |

The 蟠祥路·国家会计学院 → 国家会展中心 distance (1640 m) is derived from the constant
1640 m offset between the table's chainage (zero at 蟠祥路) and the pre-extension
chainage (zero at 徐泾东); the official extension length is "约1.67 km". Summing the
table's inter-station distances gives 61 941 m to the eastern terminus versus 61 940 m in
the table (1 m rounding). The source list is also kept in `src/data/line2.ts`.

## Approximations

Everything below is plausible but **not** taken from a public source.

**Track layout**
* Positions of all switches, crossovers, turnback tracks, sidings and tail tracks:
  scissors crossovers and 300 m tails at both termini; middle turnback/storage sidings at
  国家会展中心, 淞虹路 (small-route turnback), 中山公园, 龙阳路, 广兰路 (small-route turnback)
  and 川沙; single crossovers at 虹桥火车站, 中山公园, 人民广场, 世纪大道, 龙阳路, 广兰路, 唐镇,
  川沙, 远东大道 (enables station-front turnbacks there).
* Depot junction geometry: each depot has a grade-separated double connection (exit and
  entry turnouts on each main, the DN legs on a flyover) at 1300 m west of 淞虹路
  (北翟路), 700 m east of 龙阳路 (龙阳路) and 900 m east of 远东大道 (川沙). Only the junction
  station is sourced. Depot capacity, stabling tracks and the 4-minute exit preparation
  are approximations; depot-internal movements are not simulated.
* Axle-counter sections: one per platform, one per turnout, plain line split into ≤450 m
  sections.
* Signal placement and naming (X/S + station number + sequence, odd for eastbound),
  switch numbering (P + station number), section names (G + station number), and the
  convention 下行 = towards 浦东1号2号航站楼, 上行 = towards 蟠祥路·国家会计学院.
* Four ZC areas: 蟠祥路—娄山关路, 中山公园—浦东南路, 世纪大道—广兰路, 唐镇—浦东1号2号航站楼.
* Platform length 190 m, train length 186 m, island platforms drawn for every station.

**Signalling behaviour**
* CBTC: MA ends 20 m behind the preceding communicating train's tail, at sections occupied
  without a communicating train, at signals without a locked route, at closed platforms
  and at unlocked switches. ZC cycle and radio latency are not modelled.
* TBTC backup is modelled as fixed block by axle-counter section with ATO still
  available (the real line ran ATO under its former TBTC); the actual TBTC block layout is
  not public.
* Plain-line routes are permanent automatic (自动通过) routes; signals show the
  fixed-block aspect and go dark (灭灯) when the route is occupied only by communicating
  trains.
* Guide routes stay open 60 s; approach-locked route cancellation is delayed 30 s;
  switches throw in 5 s.
* Driving modes: AM normal; CM after a per-train communication loss (TBTC level); RM
  (≤25 km/h, on sight) for guide signals, preset sweeps, dispatcher authorisation and
  rescue coupling. Train-level downgrade takes 30 s of driver action. No unattended
  operation.

**Speeds and performance**
* Permanent speed restrictions other than the 80 km/h line speed (terminal areas 55,
  curves 60–70, river crossing 65–70), turnout speeds (crossover 35, siding 30, depot 25,
  tails 40 km/h).
* Train performance: 1.0 m/s² up to 40 km/h then constant power, 0.75 m/s² planning
  brake, 1.25 m/s² emergency brake. Planned run times are computed with the same model
  plus 8 % margin.

**Operations**
* Headways other than the 2'30" peak core / 3'45" outer reference values: off-peak 5'30",
  pre-peak 5'00", evening 7'00", first/last-train periods 7'00"/8'00", weekend 4'30".
  Peak periods 06:50–09:30 and 16:50–19:30.
* First westbound train from 浦东1号2号航站楼 at 05:30; last westbound 广兰路 departure 23:20.
* Base dwell times per station (30–60 s), minimum turnback 5 min, 40 s change of ends with
  a driver pre-positioned at the other cab.
* Overnight stabling: two trains each in the tails of both termini; all others in depots.
* Passenger model: time-of-day demand profiles, per-station demand weights, alighting
  proportional to the remaining demand along the line, 40 doors × 0.9 pax/s exchange
  rate, capacity 2480 (rated) / 3200 (crush).
* Trip numbering (1xxx big, 2xxx small, 3xxx late, 4xxx insertion/withdrawal, 5xxx
  added, 0xxx empty, 6xxx adjusted; odd eastbound) and train set numbers 0201–0276.
* Added-service presets (routes, periods and headways) for CIIE and the Hongqiao hub.

## Performance

The renderer keeps static geometry in GPU buffers and only updates tints, visibility and
about 70 train objects per frame. The train graph caches planned lines in hourly chunks
and appends actual lines at 2.5 Hz. The simulation runs off the main thread. Use a
hardware-accelerated browser; the frame rate and simulation rate are shown at the top
right of the graph panel.
