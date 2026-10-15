#!/usr/bin/env python3
"""东段补抓入口。Python >=3.10 标准库、adb；依赖同目录 scrape.py。

python scripts/gaode/capture_east.py --resume
回卷和采集均慢滑，复用逐屏重叠、小时完整性和首末班校验。
同一展开表反向、正向各独立完整读一遍，一致才发布；不是两次重新进入。
原始 XML / 诊断只写 work/，不生成截图。
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
import re
from statistics import median
import time

import scrape

PRIORITY = ['广兰路', '金科路', '远东大道', '创新中路', '川沙', '海天三路']
METHOD = '同页展开后两遍独立完整读取一致；逐屏有重叠'
OBSERVATION = '# 首末班状态：未通过，仅保留双遍一致的 UI 实读观测。'


def endpoint_only(errors):
    """研究观测例外限首末差2 min；重复、空表、缺小时等不能以此放过。"""
    deltas = [re.search(r'^(?:首|末)班 .* / 官方 .*，相差 ([+-]\d+) min$', e) for e in errors]
    return bool(deltas) and all(m and abs(int(m[1]))<=2 for m in deltas)


def publish(data, keep_endpoint_observation=False):
    errors = data['errors']
    if errors and not (keep_endpoint_observation and endpoint_only(errors)):
        raise RuntimeError('; '.join(errors))
    if errors:
        data['warnings'] = list(dict.fromkeys(data['warnings']+['首末班未通过：'+e for e in errors]))
    path = scrape.publish_capture(data)
    source = path.read_text(encoding='utf-8')
    source = source.replace('# 运营日：', '# 完整性：'+METHOD+'。\n# 运营日：', 1)
    if errors:
        source = source.replace('# 运营日：', OBSERVATION+'\n# 运营日：', 1)
    path.write_text(source, encoding='utf-8')
    scrape.update_summary()
    return path


class EastDevice(scrape.Device):
    def dump(self):
        self.last_root = super().dump()
        return self.last_root

    def tap(self, node):
        self.scroll_sample = None
        super().tap(node)

    def swipe(self, node, horizontal=False, reverse=False, fraction=None):
        x1, y1, x2, y2 = scrape.bounds(node)
        if horizontal:
            duration = 1000
            # 线路列表有的版本随行车方向反排；按实际站名的左右次序判断。
            root = getattr(self, 'last_root', None)
            if root is not None:
                carousels = [n for n in root.iter('node') if 'Horizontal' in n.get('class','')]
                order = list(scrape.official_rows())
                visible = sorted((scrape.bounds(n)[0],order.index(n.get('text')))
                                 for n in carousels[-1].iter('node') if n.get('text') in order) if carousels else []
                if len(visible)>1 and visible[0][1]>visible[-1][1]:
                    reverse = not reverse
            y = int(y1+(y2-y1)*.85)
            a, b = (int(x1+(x2-x1)*.75),y), (int(x1+(x2-x1)*.25),y)
        else:
            rows, row_height = row_geometry(node)
            gain = getattr(self, 'scroll_gain', 1.35)
            previous = getattr(self, 'scroll_sample', None)
            if previous and previous[2] == reverse:
                old_rows, finger, _ = previous
                shifts = [abs(rows[t]-old_rows[t]) for t in rows.keys() & old_rows.keys()]
                if len(shifts) >= 3 and median(shifts) > row_height:
                    # 用重叠行的实际位移修正下一滑，包含松手后的惯性。
                    gain = max(1.0, min(2.5, median(shifts)/finger*1.15))
            self.scroll_gain = gain
            height = y2-y1
            target = min(height*.78, max(row_height, height-3*row_height))
            distance = min(height*.78, target/gain) if fraction is None else height*fraction
            # 速度过高会触发甩动；距离较长时等比例延长拖动，而非缩成固定小步。
            duration = max(900, round(distance/.68))
            self.scroll_sample = (rows, max(1, distance), reverse)
            a = ((x1+x2)//2, int(y1+height*.9))
            b = (a[0], int(a[1]-distance))
        if reverse:
            a, b = b, a
        self.run('shell','input','swipe',*map(str,(*a,*b)),str(duration))
        time.sleep(.3)


def row_geometry(scroll):
    """从完整列车行估行高，兼容换手机后的分辨率、字体和视口变化。"""
    parents = {child: node for node in scroll.iter('node') for child in node}
    top, bottom = scrape.bounds(scroll)[1::2]
    rows, heights = {}, []
    for node in scroll.iter('node'):
        if scrape.ARRIVAL.fullmatch(node.get('text', '')):
            row = parents.get(node, node)
            _, y1, _, y2 = scrape.bounds(row)
            rows[node.get('text')] = (y1+y2)/2
            if top <= y1 < y2 <= bottom:
                heights.append(y2-y1)
    return rows, median(heights) if heights else (bottom-top)/12


def signature(scroll):
    return [(n.get('text'), n.get('bounds')) for n in scroll.iter('node') if n.get('text')]


def rewind(device, reverse=True):
    previous = None
    for _ in range(120):
        root = device.dump()
        scroll = scrape.table_scroll(root)
        current = signature(scroll)
        if current == previous:
            return root
        previous = current
        device.swipe(scroll, reverse=reverse)
    raise RuntimeError('慢速回卷未到表头，不采集')


def collapsed_headers(scroll):
    """两个小时标题之间没有到站行才认定折叠；视口底部的单个标题不足以判断。"""
    lines = scrape.texts(scroll)
    result = []
    for node in scroll.iter('node'):
        title = node.get('text', '')
        if not scrape.HOUR.fullmatch(title):
            continue
        i = lines.index(title)
        if (i+1 < len(lines) and scrape.HOUR.fullmatch(lines[i+1])
                and scrape.bounds(node)[3]-scrape.bounds(node)[1] >= 35):
            result.append(node)
    return result


def expand(device):
    rewind(device)
    previous = None
    for _ in range(150):
        root = device.dump()
        scroll = scrape.table_scroll(root)
        lines = scrape.texts(scroll)
        headers = [n for n in scroll.iter('node') if scrape.HOUR.fullmatch(n.get('text', ''))]
        more = [n for n in scroll.iter('node') if any(
            s in n.get('text', '') for s in ['展开更多', '查看更多'])]
        if more:
            device.tap(more[-1])
            continue
        pending = collapsed_headers(scroll)
        if pending:
            # 从下往上点，避免展开下方分组改变上方标题坐标。
            for node in reversed(pending):
                device.tap(node)
            time.sleep(.5)
            previous = None
            continue
        current = signature(scroll)
        if current == previous:
            # 到底后最后一个标题若无任何对应到站行，才可确认它仍是折叠。
            if headers and not any(t.startswith(headers[-1].get('text')[:2]+':')
                                   and scrape.ARRIVAL.fullmatch(t) for t in lines):
                device.tap(headers[-1])
                previous = None
                continue
            return
        previous = current
        # 此处也慢滑，不能快速甩过未展开的中间小时；后续完整读取还会再验证。
        device.swipe(scroll)
    raise RuntimeError('展开超过上限，不发布')


def select_station(device, station):
    for _ in range(3):
        root = device.dump()
        if any(t.startswith('上车站：') or scrape.HOUR.fullmatch(t) for t in scrape.texts(root)):
            device.back()
            root = device.dump()
        root = device.expand_panel(root)
        carousels = [n for n in root.iter('node') if n.get('scrollable')=='true'
                     and 'Horizontal' in n.get('class', '')]
        if carousels:
            nodes = [n for n in carousels[-1].iter('node') if n.get('text')==station]
            if nodes:
                # 必须点线路列表里的站名；“开往广兰路”不能证明当前已选广兰路。
                device.tap(nodes[-1])
                time.sleep(.7)
        try:
            scrape.select_station(device, station)
            return
        except RuntimeError as error:
            if '其他站' not in str(error):
                raise
    raise RuntimeError('连续三次未切到目标站，不采集')


def capture(device, station, direction, day, keep_endpoint_observation=False, expanded=False):
    now = scrape.local_now()
    if (day=='weekend') != (now.weekday()>=5):
        raise RuntimeError('页面没有日期选择，不能把今天标为另一日类型')
    audit = scrape.WORK/'runs'/f'east-{station}-{direction}-{now:%Y%m%d-%H%M%S-%f}'
    audit.mkdir(parents=True)
    device.audit_dir, device.audit_page = audit, 0
    if not expanded:
        select_station(device, station)
        scrape.select_direction(device, direction)
    root = device.dump() if expanded else rewind(device)
    if not expanded and f'上车站：{station}' not in scrape.texts(root):
        raise RuntimeError('站名不符，不采集')
    print(station, direction, '展开并独立复读', flush=True)
    scrape.check_identity(root, station, direction)
    for attempt in range(3):
        # 保留已展开分组；完整读取失败时补扫后从空集合重新读，不拼接失败遍。
        expand(device)
        try:
            # 展开后在表底，两遍各自从空集合开始，不混入展开阶段的记录。
            first = scrape.read_expanded(device, station, direction, 250, reverse=True, rewind_first=False)
            if f'上车站：{station}' not in scrape.texts(device.last_root):
                raise RuntimeError('完整回读到表头后站名不符，不发布')
            second = scrape.read_expanded(device, station, direction, 250, rewind_first=False)
            if first[:3] != second[:3]:
                raise RuntimeError('两遍完整读取不一致，保留 XML，不发布')
            break
        except RuntimeError as error:
            recoverable = any(s in str(error) for s in ['翻页缺少重叠行','没有到站行，不能视为已展开'])
            if not recoverable or attempt==2:
                raise
            device.scroll_gain = min(2.5,max(1.5,getattr(device,'scroll_gain',1.35)*1.2))
            device.scroll_sample = None
            print(f'{station} {direction}: 本遍作废，补展开后完整重读（{attempt+1}/2）：{error}',flush=True)
    values, groups, labels, pages = second
    errors, warnings = scrape.validate(station, direction, values)
    data = dict(station=station, direction=direction, day=day, captured_at=now.isoformat(),
                independent_runs=1, values=values, groups=sorted(groups), labels=sorted(labels),
                errors=errors, warnings=warnings, hour_counts=dict(Counter(t[:2] for t in values)),
                pages=pages, method=METHOD, read_directions=['reverse','forward'],
                read_passes=[{'direction':'reverse','pages':first[3]},
                             {'direction':'forward','pages':second[3]}])
    (audit/'result.json').write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    if errors and not (keep_endpoint_observation and endpoint_only(errors)):
        raise RuntimeError('; '.join(errors))
    (scrape.WORK/f'{station}-{direction}-{day}.json').write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    path = publish(data, keep_endpoint_observation)
    device.audit_dir = None
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--station', nargs='+', choices=list(scrape.official_rows()), default=PRIORITY)
    parser.add_argument('--direction', nargs='+', choices=list(scrape.ENDS), default=list(scrape.ENDS))
    parser.add_argument('--day', choices=['weekday','weekend'], default='weekday')
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--keep-endpoint-observation', action='store_true',
                        help='首末偏差仅2min且双遍一致时保留带异常标记的观测；不改变严格校验')
    parser.add_argument('--adb')
    parser.add_argument('--serial')
    parser.add_argument('--expanded', action='store_true', help='原表已展开时恢复；只允许指定一个站和方向')
    args = parser.parse_args()
    if args.expanded and (len(args.station)!=1 or len(args.direction)!=1):
        parser.error('--expanded 须指定一个站和方向')
    device = EastDevice(args.adb, args.serial)
    device.connected()
    for station in args.station:
        for direction in args.direction:
            path = scrape.OUT/f'{station}-{direction}-{args.day}.txt'
            if args.resume and path.exists():
                content = path.read_text(encoding='utf-8')
                errors = scrape.validate(station, direction, scrape.read_table(path)[3])[0]
                retained = args.keep_endpoint_observation and OBSERVATION in content and endpoint_only(errors)
                if (METHOD in content and f'# 抓取日期：{scrape.local_now():%Y-%m-%d}' in content
                        and (not errors or retained)):
                    print('跳过同页双遍一致的'+('首末偏差观测' if errors else '表'), path.name, flush=True)
                    continue
            capture(device, station, direction, args.day, args.keep_endpoint_observation, args.expanded)


if __name__=='__main__':
    main()
