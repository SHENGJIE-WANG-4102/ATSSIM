#!/usr/bin/env python3
"""逐屏保留原始XML与到站行全部text/content-desc。依赖Python>=3.10及adb。

仅在独占手机时运行：
python scripts/gaode/capture_evidence.py --station 虹桥2号航站楼 --direction UP --window
python scripts/gaode/capture_evidence.py --station 淞虹路 --direction UP
不加--window时复用完整采集校验；所有证据放work/，不截图。
--window只读11:00–17:00，不覆盖正式全天时刻表。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import time
import xml.etree.ElementTree as ET

import scrape
import capture_east


def node_fields(node):
    return {k: node.get(k, "") for k in (
        "text", "content-desc", "resource-id", "class", "bounds", "selected", "checked")}


def row_evidence(root):
    """在表内找包含恰好一条到站记录的完整行容器，保留其全部节点。

    若一屏只剩一行，禁止一路上爬把小时标题或整个滚动区域当该行。
    """
    scroll = scrape.table_scroll(root)
    parents = {child: parent for parent in scroll.iter() for child in parent}
    result = []
    for arrival in scroll.iter("node"):
        match = scrape.ARRIVAL.fullmatch(arrival.get("text", ""))
        if not match:
            continue
        row = arrival
        while row in parents and parents[row] is not scroll:
            parent = parents[row]
            ts = scrape.texts(parent)
            count = sum(bool(scrape.ARRIVAL.fullmatch(t)) for t in ts)
            if count != 1 or any(scrape.HOUR.fullmatch(t) for t in ts):
                break
            row = parent
        result.append({"time": scrape.service_time(match[1]), "row_bounds": row.get("bounds"),
                       "nodes": [node_fields(n) for n in row.iter("node")]})
    return result


def check_window_identity(root, station, line, destination):
    station_labels = {s for s in scrape.texts(root) if s.startswith("上车站：")}
    # 新版页面的上车站标题会随滚动移出XML；出现其它站名才判切站。
    if station_labels and station_labels != {f"上车站：{station}"}:
        raise RuntimeError("采集中站点被切走，停止")
    if f"地铁{line}号线" not in scrape.texts(root):
        raise RuntimeError("线路页标签不符，停止")
    scroll = scrape.table_scroll(root)
    labels = {s for s in scrape.texts(scroll) if s.startswith("开往")}
    if labels and labels != {"开往" + destination}:
        raise RuntimeError(f"方向不符 {labels}")
    return scroll


def extract_archive(directory, station, direction, line="2", start=660, end=1020):
    """复用已完成采集的原始XML，离线保留整行字段，避免重复占用手机。"""
    result = json.loads((directory / "result.json").read_text(encoding="utf-8"))
    if (result["station"], result["direction"]) != (station, direction) or result["errors"]:
        raise ValueError("档案身份不符或尚未通过采集校验")
    expected = {t for t in result["values"] if start <= scrape.minutes(t) < end}
    pages, observed = [], set()
    for path in sorted(directory.glob("*.xml")):
        root = ET.parse(path).getroot()
        try:
            scroll = check_window_identity(root, station, line, scrape.ENDS[direction])
        except RuntimeError:
            # 导航过程可能没有表；若有另一站、另一方向，则不混入目标档案。
            continue
        rows = [r for r in row_evidence(root) if r["time"] in expected]
        observed.update(r["time"] for r in rows
                        if any(n["text"] == "开往" + scrape.ENDS[direction] for n in r["nodes"]))
        context = [node_fields(n) for n in root.iter("node")
                   if n.get("text", "").startswith(("地铁", "上车站：", "共"))
                   or n.get("text") in ("2号线", "10号线", "17号线")
                   or n.get("selected") == "true" or n.get("checked") == "true"]
        pages.append({"xml": path.name, "context": context, "rows": rows})
    if observed != expected:
        raise ValueError(f"缺完整行证据：{sorted(expected-observed)}")
    data = {"station": station, "direction": direction, "line": line,
            "source": str(directory), "captured_at": result["captured_at"],
            "method": result.get("method", ""), "window": [start, end],
            "values": sorted(expected, key=scrape.minutes), "pages": pages}
    target = directory / "window-evidence.json"
    target.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"离线证据 {len(expected)}行 / {len(pages)}屏：{target}", flush=True)
    return data


class EvidenceDevice(capture_east.EastDevice):
    def __init__(self, station, direction, adb=None, serial=None, line="2"):
        super().__init__(adb, serial)
        stamp = scrape.local_now().strftime("%Y%m%d-%H%M%S-%f")
        self.directory = scrape.WORK / f"evidence-line{line}-{station}-{direction}-{stamp}"
        self.directory.mkdir(parents=True)
        self.pages = []
        self.station, self.direction, self.line = station, direction, line
        self.serial = serial

    def dump(self):
        # 长时间离线分析后手机可能自动锁屏；只唤醒，不触碰密码或其他应用。
        self.run("shell", "input", "keyevent", "KEYCODE_WAKEUP")
        self.run("shell", "wm", "dismiss-keyguard")
        root = super().dump()
        name = f"{len(self.pages):04}.xml"
        (self.directory / name).write_bytes((scrape.WORK / "ui.xml").read_bytes())
        try:
            rows = row_evidence(root)
        except RuntimeError:
            rows = []
        # 背后的线路详情与前景方向/选中状态一并留档，解释时不靠selected单一字段。
        context = [node_fields(n) for n in root.iter("node")
                   if n.get("text", "").startswith(("地铁", "上车站：", "共"))
                   or n.get("text") in ("2号线", "10号线", "17号线")
                   or n.get("selected") == "true" or n.get("checked") == "true"]
        self.pages.append({"xml": name, "context": context, "rows": rows})
        self.save()
        return root

    def save(self):
        target = self.directory / "evidence.json"
        target.write_text(json.dumps({"station": self.station, "direction": self.direction, "line": self.line,
                                      "serial": self.serial, "pages": self.pages}, ensure_ascii=False, indent=2), encoding="utf-8")


def capture_window(device, station, direction, start=660, end=1020, destination=None):
    """仅展开目标小时，随后完整正反读取；所有屏XML由Device存档。"""
    root = scrape.rewind(device)
    if scrape.local_now().weekday() >= 5:
        raise RuntimeError("今天不是工作日，不得把当前表标为weekday")
    if f"上车站：{station}" not in scrape.texts(root):
        raise RuntimeError("上车站不符")
    opened, values, independent = set(), set(), []
    for sweep in range(6):
        changed, previous, stationary = False, None, 0
        prior_values, gap = set(), False
        seen = set()
        reverse = sweep % 2 == 1
        for _ in range(180):
            root = device.dump()
            scroll = check_window_identity(root, station, device.line, destination or scrape.ENDS[direction])
            page_values = {v for v in scrape.arrivals(scroll) if start <= scrape.minutes(v) < end}
            if prior_values and page_values and not prior_values & page_values:
                gap = True
            prior_values = page_values
            values |= page_values
            seen |= page_values
            opened |= {scrape.minutes(v) // 60 for v in values}
            pending = [n for n in scroll.iter("node")
                       if (m := scrape.HOUR.fullmatch(n.get("text", "")))
                       and start // 60 <= int(m[1]) <= (end - 1) // 60
                       and int(m[1]) not in opened and scrape.bounds(n)[3] - scrape.bounds(n)[1] >= 35]
            if pending:
                device.tap(pending[-1] if reverse else pending[0])
                time.sleep(.75)
                device.swipe(scroll, fraction=.12)
                previous, stationary, prior_values, changed = None, 0, set(), True
                continue
            signature = ET.tostring(scroll)
            stationary = stationary + 1 if signature == previous else 0
            if stationary >= 2:
                break
            previous = signature
            device.swipe(scroll, reverse=reverse)
        else:
            raise RuntimeError("目标窗口翻页超限")
        print(f"窗口第{sweep+1}遍：{len(values)}行，展开小时{sorted(opened)}", flush=True)
        if not changed and not gap and {scrape.minutes(v) // 60 for v in seen} == set(range(start // 60, (end - 1) // 60 + 1)):
            independent.append(seen)
            if len(independent) >= 2:
                if independent[-1] != independent[-2]:
                    raise RuntimeError("窗口两遍独立读取不一致，保留证据，不发布")
                values = seen
                break
    else:
        raise RuntimeError("六遍内未获得两次一致的完整窗口读取")
    if opened != set(range(start // 60, (end - 1) // 60 + 1)):
        raise RuntimeError("窗口有整小时缺失")
    ordered = sorted(values, key=scrape.minutes)
    (device.directory / "window-times.txt").write_text("\n".join(ordered) + "\n", encoding="utf-8")
    result = {"station": station, "direction": direction, "line": device.line,
              "destination": destination or scrape.ENDS[direction], "serial": device.serial,
              "captured_at": scrape.local_now().isoformat(), "start": start, "end": end,
              "values": ordered, "independent_complete_passes": len(independent),
              "method": "同页窗口两遍各自独立读取一致；逐屏重叠；不混入展开遍"}
    (device.directory / "window-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    existing = scrape.OUT / f"{station}-{direction}-weekday.txt"
    if device.line == "2" and existing.exists():
        old = {t for t in scrape.read_table(existing)[3] if start <= scrape.minutes(t) < end}
        print(f"窗口{len(values)}行；原表无/新有{sorted(values-old)}；原有/新无{sorted(old-values)}", flush=True)
    print(f"证据保存：{device.directory}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--station", required=True, choices=list(scrape.official_rows()))
    parser.add_argument("--direction", required=True, choices=["UP", "DN"])
    parser.add_argument("--adb")
    parser.add_argument("--serial")
    parser.add_argument("--device-workspace", action="store_true", help="两机并行时隔离该serial的会话锁、临时XML和诊断；每进程只管一机")
    parser.add_argument("--window", action="store_true")
    parser.add_argument("--line", choices=["2", "10", "17"], default="2")
    parser.add_argument("--destination", help="其他线路窗口采集的开往标签（不含开往二字）")
    parser.add_argument("--current", action="store_true", help="已人工导航到正确表，不自动切站")
    parser.add_argument("--extract-xml", type=Path, help="从已完成的采集档案离线提取，不连接手机")
    args = parser.parse_args()
    if args.extract_xml:
        extract_archive(args.extract_xml, args.station, args.direction, args.line)
        return
    if args.device_workspace:
        if not args.serial:
            parser.error("--device-workspace 必须显式指定 --serial")
        # 进程内共享模块的WORK一起换到本机命名空间。这样原Device锁仍有效，
        # 两机的ui.xml、原始留档、诊断也不会相互覆盖。每个进程只控制一台。
        name = "device-" + re.sub(r"[^A-Za-z0-9_.-]", "_", args.serial)
        scrape.WORK = scrape.WORK / "devices" / name
    if args.line != "2" and not (args.current and args.window and args.destination):
        parser.error("10/17号线须先导航到正确表，再用--current --window --destination")
    device = EvidenceDevice(args.station, args.direction, args.adb, args.serial, args.line)
    device.connected()
    if not args.current:
        capture_east.select_station(device, args.station)
        scrape.select_direction(device, args.direction)
    if args.window:
        capture_window(device, args.station, args.direction, destination=args.destination)
    else:
        capture_east.capture(device, args.station, args.direction, "weekday", expanded=True)


if __name__ == "__main__":
    main()
