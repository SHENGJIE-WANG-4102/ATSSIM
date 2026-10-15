#!/usr/bin/env python3
"""高德逐车配对及守恒检查。依赖 Python 3.10+ 标准库；不连接手机。

python scripts/gaode/match_trains.py --output work/gaode-matching
可用 --stations 按往西顺序指定其他采样站；缺站明确打印，不虚构时刻。
"""
from __future__ import annotations

import argparse
from bisect import bisect_left, bisect_right
from collections import Counter
import csv
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path

import scrape

DEFAULT_STATIONS = ["北新泾", "淞虹路", "虹桥2号航站楼", "蟠祥路·国家会计学院"]
HUB = "虹桥2号航站楼"


def clock(value):
    return f"{value // 60:02}:{value % 60:02}"


def read_times(path):
    station, direction, day, values = scrape.read_table(path)
    nums = [scrape.minutes(v) for v in values]
    if not nums or any(b <= a for a, b in zip(nums, nums[1:])):
        raise ValueError(f"{path.name}: 空表、重复或非递增时刻")
    errors, warnings = scrape.validate(station, direction, values)
    if errors:
        raise ValueError(f"{path.name}: {'; '.join(errors)}")
    return nums, warnings


def clean_five(values, minimum=5):
    """只取连续至少五班、四个间隔恰为5分钟的段，排除密集段。"""
    clean, runs = [], []
    start = 0
    for end in range(1, len(values) + 1):
        if end == len(values) or values[end] - values[end - 1] != 5:
            if end - start >= minimum:
                clean.extend(values[start:end])
                runs.append((values[start], values[end - 1], end - start))
            start = end
    return clean, runs


def official_lag_anchor(upstream, downstream, direction):
    rows = scrape.official_rows()
    # 同一终点的末班能连续传播；首班可能从不同中途站始发，不能相减估时。
    column = 3 if direction == "UP" else 2
    lag = scrape.minutes(rows[downstream][column]) - scrape.minutes(rows[upstream][column])
    if lag <= 0:
        raise ValueError("同方向官方末班差非正，不能自动确定时差搜索范围")
    return lag


def estimate_lag(a, b, anchor):
    """干净5分钟段的正时差众数。末班差只限制相位歧义，不用作估计值。

    【假设】可用时差位于同终点官方末班差±2分钟。恰好五个候选整分钟，
    避免把下一班（+5分钟）当同一列车；无干净样本则报错，不回退造数。
    """
    ca, ra = clean_five(a)
    cb, rb = clean_five(b)
    low, high = max(1, anchor - 2), anchor + 2
    counts = Counter()
    for t in ca:
        for u in cb[bisect_left(cb, t + low):bisect_right(cb, t + high)]:
            counts[u - t] += 1
    if not counts:
        raise ValueError(f"没有共同干净5分钟段，候选运行时分 {low}..{high}")
    modes = sorted(k for k, v in counts.items() if v == max(counts.values()))
    if len(modes) != 1:
        raise ValueError(f"运行时分众数并列 {modes}，须检查相位：{dict(counts)}")
    return {"minutes": modes[0], "histogram": dict(sorted(counts.items())),
            "anchor": anchor, "range": [low, high],
            "upstream_clean_runs": ra, "downstream_clean_runs": rb}


@dataclass
class Match:
    upstream_to_downstream: dict[int, int]
    downstream_to_upstream: dict[int, int]
    only_upstream: list[int]
    only_downstream: list[int]
    # 在全局最大配对数且总误差最小的所有解中，可行的同车候选。
    alternatives: dict[int, list[int]]


def match_trains(a, b, lag, tolerance=1):
    """保序、一对一；先最大配对数，再最小化总绝对误差。禁止复用列车。

    前后缀动态规划还给出所有同分最优解的候选，防止把任意择一说成车号证据。
    """
    n, m = len(a), len(b)
    pref = [[(0, 0)] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            best = max(pref[i - 1][j], pref[i][j - 1])
            error = abs(b[j - 1] - a[i - 1] - lag)
            if error <= tolerance:
                p = pref[i - 1][j - 1]
                best = max(best, (p[0] + 1, p[1] - error))
            pref[i][j] = best
    pairs = {}
    i, j = n, m
    while i and j:
        error = abs(b[j - 1] - a[i - 1] - lag)
        p = pref[i - 1][j - 1]
        if error <= tolerance and pref[i][j] == (p[0] + 1, p[1] - error):
            pairs[a[i - 1]] = b[j - 1]
            i, j = i - 1, j - 1
        elif pref[i - 1][j] == pref[i][j]:
            i -= 1
        else:
            j -= 1
    suff = [[(0, 0)] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            best = max(suff[i + 1][j], suff[i][j + 1])
            error = abs(b[j] - a[i] - lag)
            if error <= tolerance:
                p = suff[i + 1][j + 1]
                best = max(best, (p[0] + 1, p[1] - error))
            suff[i][j] = best
    alternatives = {t: [] for t in b}
    for i, t in enumerate(a):
        for j in range(bisect_left(b, t + lag - tolerance), bisect_right(b, t + lag + tolerance)):
            error = abs(b[j] - t - lag)
            p, q = pref[i][j], suff[i + 1][j + 1]
            if (p[0] + q[0] + 1, p[1] + q[1] - error) == pref[n][m]:
                alternatives[b[j]].append(t)
    reverse = {v: k for k, v in pairs.items()}
    return Match(pairs, reverse, [t for t in a if t not in pairs],
                 [t for t in b if t not in reverse], alternatives)


def conservation(up, dn, hours=range(4, 28)):
    cu, cd = Counter(t // 60 for t in up), Counter(t // 60 for t in dn)
    cumulative = 0
    result = []
    for hour in hours:
        net = cu[hour] - cd[hour]
        cumulative += net
        result.append({"hour": hour, "west": cu[hour], "east": cd[hour],
                       "net": net, "cumulative": cumulative})
    return result


def dense_runs(values, maximum_gap=3, minimum=4):
    result = []
    start = 0
    for end in range(1, len(values) + 1):
        if end == len(values) or values[end] - values[end - 1] > maximum_gap:
            if end - start >= minimum:
                run = values[start:end]
                result.append({"start": clock(run[0]), "end": clock(run[-1]),
                               "count": len(run), "gaps": [b - a for a, b in zip(run, run[1:])]})
            start = end
    return result


def write_csv(path, rows, fields):
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def analyze(stations, data_dir, output, day="weekday", start=660, end=1020, compare_windows=()):
    output.mkdir(parents=True, exist_ok=True)
    tables, missing, warnings, sources = {}, [], [], []
    for station in stations:
        for direction in ("UP", "DN"):
            path = data_dir / f"{station}-{direction}-{day}.txt"
            if not path.exists():
                missing.append(path.name)
                continue
            raw = path.read_bytes()
            tables[station, direction], ws = read_times(path)
            if raw != path.read_bytes():
                raise ValueError(f"{path.name} 在读取时被更新，请重跑以使用一致快照")
            snapshot = output / "inputs" / path.name
            snapshot.parent.mkdir(exist_ok=True)
            snapshot.write_bytes(raw)
            sources.append({"file": path.name, "sha256": hashlib.sha256(raw).hexdigest(),
                            "headers": [s for s in raw.decode("utf-8-sig").splitlines() if s.startswith("#")],
                            "count": len(tables[station, direction])})
            warnings.extend(f"{path.name}: {w}" for w in ws)
    print("缺表：" + ("、".join(missing) if missing else "无"))
    report = {"missing": missing, "warnings": warnings, "sources": sources, "pairs": [], "conservation": {},
              "dense_runs": {}, "window": [clock(start), clock(end)]}
    all_matches, estimates = {}, {}
    for direction in ("UP", "DN"):
        ordered = stations if direction == "UP" else stations[::-1]
        for upstream, downstream in zip(ordered, ordered[1:]):
            if (upstream, direction) not in tables or (downstream, direction) not in tables:
                continue
            a, b = tables[upstream, direction], tables[downstream, direction]
            estimate = estimate_lag(a, b, official_lag_anchor(upstream, downstream, direction))
            lag = estimate["minutes"]
            match = match_trains(a, b, lag)
            all_matches[upstream, downstream, direction] = match
            estimates[upstream, downstream, direction] = lag
            sensitivity = {str(d): len(match_trains(a, b, d).upstream_to_downstream)
                           for d in range(max(1, lag - 1), lag + 2)}
            range_sensitivity = {}
            for candidate in range(estimate["range"][0], estimate["range"][1] + 1):
                alternative = match_trains(a, b, candidate)
                range_sensitivity[str(candidate)] = {
                    "matched": len(alternative.upstream_to_downstream),
                    "window_only_downstream": sum(start <= t < end for t in alternative.only_downstream)}
            record = {"upstream": upstream, "downstream": downstream, "direction": direction,
                      "estimate": estimate, "matched": len(match.upstream_to_downstream),
                      "only_upstream": list(map(clock, match.only_upstream)),
                      "only_downstream": list(map(clock, match.only_downstream)),
                      "lag_sensitivity_matched": sensitivity}
            record["candidate_range_sensitivity"] = range_sensitivity
            record["mode_at_search_boundary"] = lag in estimate["range"]
            record["hourly"] = [{"hour": h,
                                  "matched": sum(t // 60 == h for t in match.downstream_to_upstream),
                                  "only_downstream": sum(t // 60 == h for t in match.only_downstream),
                                  "only_upstream": sum(t // 60 == h for t in match.only_upstream)}
                                 for h in range(4, 28)]
            report["pairs"].append(record)
            print(f"{direction} {upstream}→{downstream}: 众数{lag}min {estimate['histogram']}；"
                  f"匹配{record['matched']}，只在上游{len(match.only_upstream)}，只在本站{len(match.only_downstream)}")
            rows = [{"上游时刻": clock(t), "本站时刻": clock(u), "状态": "匹配",
                     "误差min": u - t - lag,
                     "最优解上游候选": " ".join(map(clock, match.alternatives[u]))} for t, u in sorted(match.upstream_to_downstream.items())]
            rows += [{"上游时刻": "", "本站时刻": clock(u), "状态": "只在本站出现", "误差min": "",
                      "最优解上游候选": " ".join(map(clock, match.alternatives[u]))} for u in match.only_downstream]
            rows += [{"上游时刻": clock(t), "本站时刻": "", "状态": "只在上游出现", "误差min": "",
                      "最优解上游候选": ""} for t in match.only_upstream]
            rows.sort(key=lambda r: r["本站时刻"] or clock(scrape.minutes(r["上游时刻"]) + lag))
            write_csv(output / f"{upstream}--{downstream}-{direction}.csv", rows,
                      ["上游时刻", "本站时刻", "状态", "误差min", "最优解上游候选"])

    # 固定每个边界两端各自的计数，不把两站相加冒充一个断面。
    # 【假设】到站钟面时刻是通过断面的分钟级代理；差中还含在途/停站车，
    # 空驶和未刊载车均不可见，因而不把净差直接宣布为真实库存或车队数。
    for station in stations:
        if all((station, d) in tables for d in ("UP", "DN")):
            rows = conservation(tables[station, "UP"], tables[station, "DN"])
            report["conservation"][station] = rows
            write_csv(output / f"{station}-conservation.csv", rows, ["hour", "west", "east", "net", "cumulative"])
    print("守恒：每格为本小时往西-往东 / 截至本小时末累计；04:00从0起算")
    print("小时 " + " | ".join(report["conservation"]))
    for h in range(4, 28):
        print(f"{h:02} " + " | ".join(f"{rows[h-4]['net']:+}/{rows[h-4]['cumulative']:+}"
                                      for rows in report["conservation"].values()))
    report["cuts"] = {}
    for east, west in zip(stations, stations[1:]):
        if east not in report["conservation"] or west not in report["conservation"]:
            continue
        cut_rows = [{"hour": a["hour"], "east_net": a["net"], "west_net": b["net"],
                     "east_cumulative": a["cumulative"], "west_cumulative": b["cumulative"],
                     "segment_net_inflow": a["cumulative"] - b["cumulative"]}
                    for a, b in zip(report["conservation"][east], report["conservation"][west])]
        report["cuts"][f"{east}|{west}"] = cut_rows
        print(f"断面 {east}|{west}：小时 东侧累计/西侧累计/两端差")
        print(" ".join(f"{r['hour']:02} {r['east_cumulative']:+}/{r['west_cumulative']:+}/{r['segment_net_inflow']:+}"
                       for r in cut_rows))
        write_csv(output / f"{east}--{west}-cut.csv", cut_rows, list(cut_rows[0]))

    anomaly_rows = []
    up_match = all_matches.get(("淞虹路", HUB, "UP"))
    down_match = all_matches.get((HUB, "蟠祥路·国家会计学院", "UP"))
    bx_match = all_matches.get(("北新泾", "淞虹路", "UP"))
    if up_match:
        hub_lag = estimates["淞虹路", HUB, "UP"]
        terminal_lag = estimates.get((HUB, "蟠祥路·国家会计学院", "UP"))
        shr_times = tables["淞虹路", "UP"]
        terminal_times = tables.get(("蟠祥路·国家会计学院", "UP"), [])
        for t in up_match.only_downstream:
            if not start <= t < end:
                continue
            terminal = down_match.upstream_to_downstream.get(t) if down_match else None
            alternatives = up_match.alternatives[t]
            shr_candidates = shr_times[bisect_left(shr_times, t - hub_lag - 1):bisect_right(shr_times, t - hub_lag + 1)]
            terminal_candidates = (terminal_times[bisect_left(terminal_times, t + terminal_lag - 1):
                                                  bisect_right(terminal_times, t + terminal_lag + 1)]
                                   if terminal_lag is not None else [])
            terminal_optima = ([u for u, candidates in down_match.alternatives.items() if t in candidates]
                               if down_match else [])
            anomaly_rows.append({"虹桥时刻": clock(t), "淞虹路": "只在本站出现",
                                 "淞虹路预期": clock(t - hub_lag),
                                 "淞虹路窗口候选": " ".join(map(clock, shr_candidates)),
                                 "淞虹路最优解候选": " ".join(map(clock, alternatives)),
                                 "蟠祥路": clock(terminal) if terminal is not None else ("未匹配" if down_match else "缺表"),
                                 "蟠祥路窗口候选": " ".join(map(clock, terminal_candidates)),
                                 "蟠祥路最优解候选": " ".join(map(clock, terminal_optima)),
                                 "状态": "择一解未配，存在同分候选" if alternatives else "所有最优解均未配"})
        write_csv(output / "虹桥午间未匹配.csv", anomaly_rows,
                  ["虹桥时刻", "淞虹路", "淞虹路预期", "淞虹路窗口候选", "淞虹路最优解候选", "蟠祥路",
                   "蟠祥路窗口候选", "蟠祥路最优解候选", "状态"])
        print(f"虹桥往西 {clock(start)}–{clock(end)}（不含结束时刻）未匹配：")
        for hour in range(start // 60, (end - 1) // 60 + 1):
            rows = [r for r in anomaly_rows if scrape.minutes(r["虹桥时刻"]) // 60 == hour]
            print(f"{hour:02}点 {len(rows)}班：" + "；".join(
                f"{r['虹桥时刻']}→蟠祥路{r['蟠祥路']}" + ("（配对歧义）" if r["淞虹路最优解候选"] else "") for r in rows))
        if bx_match:
            print(f"北新泾→淞虹路匹配{len(bx_match.upstream_to_downstream)}班，"
                  "详情CSV；不把淞虹路新增或终到车自动当作虹桥异常。")
    else:
        print("虹桥午间逐车结果待淞虹路表，禁止以跨缺站估计替代。")
    report["hub_anomalies"] = anomaly_rows
    report["hub_analysis_ready"] = up_match is not None and down_match is not None
    report["other_line_comparisons"] = []
    for comparison_index, path in enumerate(compare_windows, 1):
        raw = path.read_bytes()
        foreign = [scrape.minutes(s.strip()) for s in raw.decode("utf-8-sig").splitlines()
                   if s.strip() and not s.startswith("#")]
        if any(b <= a for a, b in zip(foreign, foreign[1:])):
            raise ValueError(f"{path}: 对照窗口时刻非严格递增")
        foreign = [t for t in foreign if start <= t < end]
        if not foreign:
            raise ValueError(f"{path}: 对照窗口为空")
        hub_times = [t for t in tables.get((HUB, "UP"), []) if start <= t < end]
        if not hub_times:
            raise ValueError("缺虹桥2号线往西窗口，不能比较其他线路")
        (output / "inputs" / f"comparison-{comparison_index}-{path.name}").write_bytes(raw)
        anomalies = [scrape.minutes(r["虹桥时刻"]) for r in anomaly_rows]
        exact = match_trains(foreign, anomalies, 0, 0)
        near = match_trains(foreign, anomalies, 0, 1)
        controls = {str(shift): len(match_trains([t + shift for t in foreign], anomalies, 0, 0).upstream_to_downstream)
                    for shift in range(-4, 5)}
        comparison = {"path": str(path), "sha256": hashlib.sha256(raw).hexdigest(), "count": len(foreign),
                      "hourly": dict(Counter(t // 60 for t in foreign)),
                      "exact_hits_all_hub": len(set(foreign) & set(hub_times)),
                      "exact_hits_anomalies": len(exact.upstream_to_downstream),
                      "tolerance1_hits_anomalies": len(near.upstream_to_downstream),
                      "minute_shift_control_exact_hits": controls}
        report["other_line_comparisons"].append(comparison)
        rows = [{"虹桥2号线时刻": clock(t), "淞虹路未配候选": t in anomalies,
                 "对照线路同一分钟": clock(t) if t in foreign else "无",
                 "对照线路前后1分钟": " ".join(clock(u) for u in foreign if abs(u-t) <= 1)} for t in hub_times]
        write_csv(output / f"comparison-{comparison_index}-{path.stem}.csv", rows, list(rows[0]))
        print(f"其他线路对照 {path.name}: {len(foreign)}班，"
              f"与虹桥全部时刻同分钟{comparison['exact_hits_all_hub']}，"
              f"与午间未配候选同分钟{comparison['exact_hits_anomalies']} / ±1min {comparison['tolerance1_hits_anomalies']}；"
              f"平移对照{controls}（重合不等于混线证据）")
    for station in stations:
        for direction in ("UP", "DN"):
            if (station, direction) in tables:
                runs = dense_runs(tables[station, direction])
                report["dense_runs"][f"{station}-{direction}"] = runs
                if station == HUB and direction == "UP":
                    print("虹桥午间≤3分钟连续密集段（至少4班）：" + json.dumps(
                        [r for r in runs if scrape.minutes(r["start"]) < end
                         and scrape.minutes(r["end"]) >= start], ensure_ascii=False))
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output / "statistics.md").write_text(render_markdown(report), encoding="utf-8")
    return report


def render_markdown(report):
    lines = ["逐车配对统计（分钟级候选配对，没有车次号）：", ""]
    if report["missing"]:
        lines += ["**缺表，以下不能作为完整断面结论**：" + "、".join(report["missing"]), ""]
    lines += ["| 方向及采样区间 | 时差众数 | 干净样本时差:票数 | 全天匹配 | 只在上游 | 只在本站 |",
              "|---|---:|---|---:|---:|---:|"]
    for pair in report["pairs"]:
        lines.append(f"| {pair['direction']} {pair['upstream']}→{pair['downstream']} | "
                     f"{pair['estimate']['minutes']} min | {pair['estimate']['histogram']} | {pair['matched']} | "
                     f"{len(pair['only_upstream'])} | {len(pair['only_downstream'])} |")
    lines += ["", "虹桥午间未配对清单（按淞虹路→虹桥配对；箭头右侧为继续到蟠祥路的配对）：", "",
              "| 小时 | 未配班数 | 虹桥时刻→蟠祥路时刻 |", "|---|---:|---|"]
    start, end = map(scrape.minutes, report["window"])
    for hour in range(start // 60, (end - 1) // 60 + 1):
        rows = [r for r in report["hub_anomalies"] if scrape.minutes(r["虹桥时刻"]) // 60 == hour]
        detail = "；".join(r["虹桥时刻"] + "→" + r["蟠祥路"]
                          + ("（有同分配对歧义）" if r["淞虹路最优解候选"] else "")
                          + ("（蟠祥路近邻 " + r["蟠祥路窗口候选"] + " 被竞争配对）"
                             if r["蟠祥路"] == "未匹配" and r["蟠祥路窗口候选"] else "") for r in rows)
        lines.append(f"| {hour:02} | {len(rows) if report['hub_analysis_ready'] else '待完整表'} | {detail} |")
    stations = list(report["conservation"])
    lines += ["", "守恒：每格为该小时 `往西−往东 / 截至小时末累计`，04:00 从零起算。", "",
              "| 小时 | " + " | ".join(stations) + " |", "|---|" + "---:|" * len(stations)]
    for hour in range(5, 25):
        cells = [f"{report['conservation'][s][hour-4]['net']:+}/{report['conservation'][s][hour-4]['cumulative']:+}" for s in stations]
        lines.append(f"| {hour:02} | " + " | ".join(cells) + " |")
    lines += ["", "断面两端分别列数，不将相邻站相加；区间累计净流入等于东侧累计减西侧累计。",
              "详细每班配对、所有最优解候选、各断面累计差和时差±1分钟敏感性见同次输出的 CSV / report.json。", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=scrape.OUT)
    parser.add_argument("--output", type=Path, default=scrape.ROOT / "work/gaode-matching")
    parser.add_argument("--stations", nargs="+", default=DEFAULT_STATIONS, help="按往西顺序排列，允许跨站采样")
    parser.add_argument("--day", choices=["weekday", "weekend"], default="weekday")
    parser.add_argument("--start", default="11:00")
    parser.add_argument("--end", default="17:00")
    parser.add_argument("--compare-west-window", type=Path, action="append", default=[],
                        help="其他线路同站往西11–17点文本，可重复指定；保留原始线路证据")
    args = parser.parse_args()
    if len(set(args.stations)) != len(args.stations) or len(args.stations) < 2:
        parser.error("至少两个不同采样站，按往西顺序列出")
    for station in args.stations:
        if station not in scrape.official_rows():
            parser.error(f"未知站名 {station}")
    indices = [list(scrape.official_rows()).index(s) for s in args.stations]
    if indices != sorted(indices, reverse=True):
        parser.error("采样站必须按往西顺序排列")
    start, end = scrape.minutes(args.start), scrape.minutes(args.end)
    if not 240 <= start < end <= 1680:
        parser.error("时间窗须在04:00..28:00内，且开始早于结束")
    report = analyze(args.stations, args.data_dir, args.output, args.day, start, end, args.compare_west_window)
    if report["missing"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
