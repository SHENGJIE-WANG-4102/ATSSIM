# 交接说明（稳定化阶段，进行中）

分支：`claude/nifty-faraday-mdr3ug`，最新提交见 `git log`（c69fc09 起）。
需求原文：用户的 "Stabilization pass: Line 2 signalling core"（§0–§11）。优先级：安全不变量 > 论文（reference/*.pdf，P1–P5）> CBTC 通用实践 > 早期需求。**论文与安全不变量冲突时必须停下来问用户，不要自己选。** 每个取舍记入 `docs/design-decisions.md`（目前 D1–D10）。

## 已完成

- 不变量检查（`src/sim/invariants.ts`）：每步 OVERLAP / BEYOND_MA / MA_NO_ROUTE / SWITCH_UNDER_LOAD / EB_ACCEL / OVERSPEED / FSM；每秒 LIVENESS（D5）和等待图 DEADLOCK。违例写快照、A 级报警、测试失败（`assertIntegrity`）。
- 停车原因码（`src/sim/halt.ts`），并在 UI 的 tooltip / 侧表和日志中显示。
- 自动调度（`src/sim/dispatcher.ts`，D4）：headless 测试有故障时开启。
- MA 回撤 `maCut`（D2）；信号机故障不强拆进路，已无法停车的列车按 committed 通过（D3）；信号机故障立即重算 MA（D9）。
- ARS：每架信号机先为最近的接近列车排列进路（D8，`ats.ts` 中的 `firstAt` / `via`），修复进路来回乒乓。
- 停车中有待处理的模式转换时列车不动（D10，`movement.ts`），修复通信中断后 EB 反复触发。
- `removeTrain` 清理 `linkBodies`，修复 `checkTrainsOnLink` 崩溃。
- 运行图（D7，`timetable.ts`）：
  - 终点站能力 `TERMINAL_CAP` / `MAX_PRESENT`；
  - 出入段车、空车插空（`SLOT_GAP` 120 s，全路径 90 s 追踪间隔，见 `fitBefore` / `fitAfter` / `pathClear`）；
  - 加开模板逐车次找可行时刻（`DepIndex`），不可行即不开行，并报告一次不足数量（`engine.ts` overlay 命令）；
  - `validatePlan` + `terminalOccupancy`；
  - `tests/timetable.test.ts` 全部通过（平日 / 周末 0 问题，各加开模板 0 错误）。

## 未完成 / 下一步

1. **重跑测试，修剩余失败**：`npx vitest run tests/scenarios.test.ts tests/features.test.ts tests/timetable.test.ts`。
   - 最近一次完整测试结果在上述修复之前，届时 11 项失败，部分应已修好：
     - 通信中断 ×2：已修；
     - fullday 平日 / 周末 LIVENESS：运行图问题，应已修；
     - 大风 LIVENESS 059-2024 ROUTE_WAIT；
     - 信号机故障 LIVENESS 020-1067，根因 061-1065 ROUTE_WAIT；
     - 道岔失表 LIVENESS 055-1057 "敌对进路（道岔 P1301/03 失表）"；
     - ZC 故障 BEYOND_MA 041-1044 / 017-1115；
     - `scenarios.test.ts:185` hold / release / skip-stop 断言失败（尚未定位是哪个 expect）；
     - 手动折返 / 退出 / 加车 DEADLOCK 046-回段 ↔ 100-5004。
   - 最后一次重跑（test3）在交接时被中断，结果不可信，需要重跑。
2. **故障探针**：
   - `npx vite-node scripts/integrity.ts 25 weekend 3 3`（r3）
   - `npx vite-node scripts/integrity.ts 25 weekday 2 2`（r2）
   - 重跑 fullday（`tests/fullday.test.ts`）。
3. **A2**：调度命令校验；TBTC 下的反向折返；完整性报警检查。RM 只因设备原因申请、每架信号机授权一次；自动应答不授权 RM。
4. **A3**：命令日志、诊断导出与回放、检查点、事件时间线（§8：确定性、种子 RNG）。
5. **A4**：
   - 已完成：校验器、加开可行性、不足只报一次。
   - 待做：预览 / 确认 UI、`addExtraTrain` 可行性检查、界面上不再出现裸数字 "1097"、校验结果在 UI 显示。
6. **B**：按 P3 实现折返分阶段，按 P1/P5 实现出入段分阶段；FSM 转换表单元测试；补全 `docs/signalling-model.md`（每条行为引用论文，或标【假设】）。
7. **C**：场景回归；`npm run soak`（尚未建立：所有模板 × 无故障 + 故障等级 1–3 × ≥10 个种子）及 KPI（0 违例、0 死锁；无故障 ≥99% 车次偏差 ≤2 min 且无 >5 min；有故障时最后一次故障恢复后 60 min 内回到 ±2 min）；结果写入 README；精简 UI（保留 DMI）。

## 调试工具（scripts/）

| 脚本 | 用途 |
|---|---|
| `integrity.ts <hours> <dayType> <seed> <level>` | 全日 / 故障探针，打印违例 |
| `dbg-halts.ts <hour> [dayType] [seed] [level]` | 某时刻所有停车列车的等待状态；`SHOW=id,…` 打印列车详情 |
| `dbg-route.ts <signal> <svc> <from> <until> [dayType] [seed] [level]` | 逐步打印某信号机的进路和某列车的状态 |
| `dbg-plan.ts` | 检查运行图 |
| `validate-plan.ts` | 运行图校验 |
| `dbg-step.ts` / `dbg-ma.ts` / `ars-trace.ts` | 单步、MA、ARS 跟踪 |

## 注意

- 这台机器 4 核，跑一次全日探针约 3–8 min，请放在后台跑。
- 不要用会匹配到自身命令行的 `pkill -f`（会把当前 shell 杀掉，exit 144）；先查 pid，再 `kill <pid>`。
- 仓库已迁移到 `SHENGJIE-WANG-4102/ShmetroLine2ATS`（push 时有重定向提示，目前仍能推上去）。
