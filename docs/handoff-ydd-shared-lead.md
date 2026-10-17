# 任务：共用出入段线上的折返待发，要和经这条线的出入段一起排

## 现象

用户压测诊断 `D:\Windows_Users\Downloads\line2-diagnostics-39885.json`（工作日；重放命令 `npx tsx work/probe/replay-delay.ts <文件>`，脚本在 Claude 的 worktree 里，可以照抄一份到自己的 `work/`）。远东大道下行 09:43–10:15 累计晚点约 5954 s，25 列，最大晚点 539 s。

**基本图本身就有冲突，不是加开造成的**：
- 车底 56：4091（淞虹路→远东大道，09:33:46 到）在远东大道出入段线 YDD1 折返，待发到 09:47:22，接着跑 4148。
- 车底 31：4089（蟠祥路→远东大道，09:43:17 到）要经 YDD1 回川沙。YDD1 是下行唯一能进川沙的线。
- 结果是 4089 在凌空路站外等了 5 分钟，后面的下行车跟着全部晚点。

`validatePlan` 的 `DEPOT_CONFLICT` 只检查共用线上「出段」和「回段」的时隙，不检查「在共用线上折返待发」占着这条线。排图时车底接续（把 4091 接上 4148，中间不回段）也没检查这一点。

## 要做的

1. 车站的折返泊位如果是车辆段共用线的 stub（`transferPaths[i].stub`，`flow === 'shared'`），在这里折返待发的占用时段，和经同一条线的出入段窗口（`inboundWindow` / `outboundWindow`），算同一个资源。
   - 用现成的 `terminalOccupancy` / `depotMoves`，扩展它们，不要另写一份。
   - 淞虹路有两条共用线，要按实际选的那条算：用 `dutyTurnBerths` 选的泊位，和入段任务里的 `entryBerths`。
2. 排图（车底接续、折返泊位选择）遇到这种重叠，按 AGENTS.md 的硬规矩处理：
   - 先换另一条可用的折返位或线路；
   - 还不行，就在 `MAX_DIAGRAM_SHIFT_S` 以内平移；
   - 再不行，就报错，并列出冲突的车次。
   - 不许悄悄取消车次，不许悄悄改起终点。
3. `validatePlan` 加上这种重叠的报错，两种日型都要覆盖。
4. 顺手修一处：`timetable.ts` 里 D79 那段检查写死了 `key !== 'BZL'` 和 `to !== 4`，违反硬规矩第 1 条（运营特例只能写成数据）。改成用上面的通用规则覆盖，或者改成从数据表读。

## 完成标准

- `npx tsx scripts/validate-plan.ts weekday` 和 `weekend` 都是 0 error。改之前，新加的检查应该在工作日报出 4091/4089 这一对，汇报里写明改前报了几条。
- `firstlast` 和 `gaode-compare` 不比改前差。
- 重放上面那份诊断：会因为运行图变化而偏离原录像，这是正常的，只看指标。
  - 远东大道下行累计晚点明显下降（目标是 < 600 s）；
  - 完整性违例 0；
  - 淞虹路一段保持 < 200 s（D98 已经修过）。
- 相关测试通过：`tests/timetable.test.ts`、`tests/round3.test.ts`；`tests/features.test.ts -t "wind restricts"`；`tests/core.test.ts -t "relieves a late train"`。

## 不要做

- 不要动 `ats.ts` 里 D82/D98 的让行规则，运行时规则已经是对的。
- 不要靠加长折返时间、或者删掉 4091/4148 接续来凑。

## 汇报重点

- 120× 下看工作日 09:30–10:15 远东大道下行回段车（原来的 4089）和折返车（4091→4148）；
- 再看 08:40–09:00 淞虹路上行回段。
