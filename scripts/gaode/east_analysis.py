#!/usr/bin/env python3
"""东段逐车候选、小时分类、折返/出入段诊断。Python 3.10+，仅标准库。

复用 match_trains.py 的保序一对一动态规划。只读时刻文本，不操作手机。
python scripts/gaode/east_analysis.py --output work/gaode-east-analysis
输出的是分钟级候选，未匹配记录不能直接当成真实始终发。
"""
from __future__ import annotations

import argparse
from bisect import bisect_right
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path

import scrape
from match_trains import clock, match_trains, estimate_lag, read_times as validated_read_times, write_csv
from capture_east import OBSERVATION, endpoint_only

STATIONS = ['张江高科', '金科路', '广兰路', '唐镇', '创新中路', '川沙', '远东大道', '海天三路']
KINDS = ['through', 'east_candidate', 'core_candidate', 'depot_candidate', 'unresolved']
PATH_FIELDS = ['id','direction','kind','start','first','end','last','depot_basis']+STATIONS


def read_times(path):
    try:
        return validated_read_times(path)
    except ValueError:
        station,direction,_,values = scrape.read_table(path)
        errors,warnings = scrape.validate(station,direction,values)
        if OBSERVATION not in path.read_text(encoding='utf-8') or not endpoint_only(errors):
            raise
        return list(map(scrape.minutes,values)), warnings+['首末班未通过，保留观测：'+e for e in errors]


def estimate(a, b, upstream, downstream, direction):
    # 【假设】同终点末班的站间时差±2 min限制搜索窗，减少相邻班次相位混淆。
    # 密集段仍可能多解，直方图、并列众数和偏移敏感性均保留。
    # 首班可能来自不同始发站，广兰路东行还有晚间终到车，不能用首班/lastG作锚。
    col = 3 if direction == 'UP' else 2
    rows = scrape.official_rows()
    anchor = scrape.minutes(rows[downstream][col]) - scrape.minutes(rows[upstream][col])
    low, high = max(1, anchor - 2), anchor + 2
    counts = Counter(y - x for x in a for y in b if low <= y - x <= high)
    if not counts:
        raise ValueError(f'{upstream}→{downstream}: 无可用时差')
    modes = sorted(t for t, n in counts.items() if n == max(counts.values()))
    # 并列众数必须在报告暴露，择离锚最近者仅为生成一个可复算的候选解。
    lag = min(modes, key=lambda t: (abs(t - anchor), t))
    try:
        clean_reference = estimate_lag(a,b,anchor)
    except ValueError as error:
        clean_reference = {'error':str(error)}
    return {'minutes': lag, 'modes': modes, 'anchor': anchor, 'range': [low, high],
            'histogram': dict(sorted(counts.items())), 'sample': '全表搜索窗内所有正向时差',
            'clean_five_reference':clean_reference}


def depot_basis(nodes):
    if nodes[0][0]=='远东大道' or nodes[-1][0]=='远东大道':
        return 'portal_observed'
    if len(nodes)>1:
        up = STATIONS.index(nodes[0][0])>STATIONS.index(nodes[-1][0])
        if (up and nodes[0][0]=='川沙') or (not up and nodes[-1][0]=='川沙'):
            return 'portal_not_listed_or_lingkong_turn_or_missing_rows'
    return ''


def classify(nodes):
    if len(nodes) == len(STATIONS):
        return 'through'
    if len(nodes) < 2:
        return 'unresolved'
    # 远东大道是接轨站；这里的出现/消失先独列，不与区间车或折返配对混合。
    if nodes[0][0] == '远东大道' or nodes[-1][0] == '远东大道':
        return 'depot_candidate'
    # 川沙—远东大道之间还隔着有渡线的凌空路。若门户始终发未刊载，
    # 这里的断点也可能是出入段；先列未定，不与东段区间候选混在一起。
    if depot_basis(nodes):
        return 'unresolved'
    indices = [STATIONS.index(s) for s, _ in nodes]
    if min(indices) >= STATIONS.index('广兰路'):
        return 'east_candidate'
    if max(indices) <= STATIONS.index('广兰路'):
        return 'core_candidate'
    return 'unresolved'


def inferred_turn_candidate(path):
    # 【假设】广兰路—创新中路的始终发都不刊载时，中间只剩唐镇一个采样点。
    # 单点仍归未定，只在显式“端点未刊载”的替代检验中使用；川沙单点含门户歧义。
    return path['kind']=='east_candidate' or (len(path['nodes'])==1 and path['nodes'][0][0]=='唐镇')


def traces(tables, edges, direction):
    order = STATIONS[::-1] if direction == 'UP' else STATIONS
    following, previous = {}, {}
    for a, b, match in edges:
        for t, u in match.upstream_to_downstream.items():
            following[a, t] = (b, u)
            previous[b, u] = (a, t)
    result = []
    for station in order:
        for value in tables[station, direction]:
            if (station, value) in previous:
                continue
            path = [(station, value)]
            while path[-1] in following:
                path.append(following[path[-1]])
            result.append({'id': f'{direction}-{len(result)+1:04}', 'direction': direction,
                           'kind': classify(path), 'nodes': path})
    # 每条观测只能归属一个路径；分类的每站小时和必须等于输入表。
    seen = [(s, t) for r in result for s, t in r['nodes']]
    expected = {(s, t) for s in order for t in tables[s, direction]}
    if len(seen) != len(set(seen)) or set(seen) != expected:
        raise AssertionError('路径丢失或复用了到站记录')
    return result


def turn_pairs(arrivals, departures, minimum=2, maximum=12):
    """最大配对数，其次最短总等待；时间次序不交叉、不复用车次。

    【假设】到站时刻作换端起点，最短2 min，上限12 min；另跑2/4/6 min敏感性。
    分钟精度不支持把100秒模型值当作实际折返标准，也不能据此识别同一车底。
    """
    a, b = sorted(arrivals), sorted(departures)
    dp = [[(0, 0)] * (len(b)+1) for _ in range(len(a)+1)]
    for i in range(1, len(a)+1):
        for j in range(1, len(b)+1):
            best = max(dp[i-1][j], dp[i][j-1])
            wait = b[j-1] - a[i-1]
            if minimum <= wait <= maximum:
                p = dp[i-1][j-1]
                best = max(best, (p[0]+1, p[1]-wait))
            dp[i][j] = best
    pairs = []
    i, j = len(a), len(b)
    while i and j:
        wait, p = b[j-1]-a[i-1], dp[i-1][j-1]
        if minimum <= wait <= maximum and dp[i][j] == (p[0]+1, p[1]-wait):
            pairs.append((a[i-1], b[j-1]))
            i, j = i-1, j-1
        elif dp[i-1][j] == dp[i][j]:
            i -= 1
        else:
            j -= 1
    return sorted(pairs)


def single_berth_turn_pairs(arrivals, departures, minimum=2, maximum=12, clear=0):
    """单折返站台假设：到达至再次开出期间不能容纳另一列折返车。

    只检验候选中间线方案，不代表实站所有替代进路；clear=0/1 min均报告。
    用区间调度动态规划，先最多配对，再最短等待，防止时间可配却占用重叠。
    """
    jobs = sorted((b,a) for a in arrivals for b in departures if minimum<=b-a<=maximum)
    ends = [b for b,a in jobs]
    dp, decisions = [(0,0)], []
    for i,(b,a) in enumerate(jobs):
        previous = bisect_right(ends,a-clear,0,i)
        take = (dp[previous][0]+1,dp[previous][1]-(b-a))
        chosen = take>dp[-1]
        dp.append(take if chosen else dp[-1])
        decisions.append((chosen,previous))
    result, i = [], len(jobs)
    while i:
        chosen, previous = decisions[i-1]
        if chosen:
            b,a = jobs[i-1]
            result.append((a,b))
            i = previous
        else:
            i -= 1
    return sorted(result)


def turn_diagnostics(arrivals, departures):
    berth = {str(c):single_berth_turn_pairs(arrivals,departures,clear=c) for c in [0,1]}
    return {'sensitivity_maximum':{str(m):len(turn_pairs(arrivals,departures,2,m)) for m in [8,12,20]},
            'single_berth_paired':{c:len(v) for c,v in berth.items()},
            'single_berth_pairs':{c:[[clock(a),clock(b)] for a,b in v] for c,v in berth.items()}}


def short_shuttle_diagnostics(paths, lags):
    """显式检验GLL—CXZ两端都未刊载、只在唐镇看见的短交路假设。

    两端采用同一组唐镇观测、单折返线留1 min，串联往返；不补入正式分类。
    断链数受12 min等待上限影响，不等于实际车队规模。
    """
    points = {d:sorted(r['nodes'][0][1] for r in paths if r['direction']==d
                      and len(r['nodes'])==1 and r['nodes'][0][0]=='唐镇') for d in ['UP','DN']}
    result = {'basis':'仅唐镇单点；两端始终发均未刊载的假设，非实测交路',
              'source_limit':'广兰路首班始发时刻可见，候选始发未刊载是替代假设，不是已确认的统一显示规则。',
              'topology_limit':'创新中路中间线无站台，载客到发需额外调车；时间配对只是必要条件。广兰路未计核心段折返占用。',
              'counts':{d:len(v) for d,v in points.items()},'cases':[]}
    for minimum in [2,4,6]:
        following, previous, turns = {}, {}, []
        for station,ad,dd in [('广兰路','UP','DN'),('创新中路','DN','UP')]:
            arrive_lag = lags[ad,'唐镇',station]
            depart_lag = lags[dd,station,'唐镇']
            ins = [t+arrive_lag for t in points[ad]]
            outs = [t-depart_lag for t in points[dd]]
            pairs = single_berth_turn_pairs(ins,outs,minimum,12,clear=1)
            for a,b in pairs:
                src,dst = (ad,a-arrive_lag),(dd,b+depart_lag)
                following[src],previous[dst] = dst,src
                turns.append({'station':station,'arrival':clock(a),'departure':clock(b),
                              'from_direction':ad,'from_tangzhen':clock(src[1]),
                              'to_direction':dd,'to_tangzhen':clock(dst[1]),'wait':b-a})
        nodes = {(d,t) for d,v in points.items() for t in v}
        chains = []
        for node in sorted(nodes-set(previous),key=lambda n:n[1]):
            chain = [node]
            while chain[-1] in following:
                chain.append(following[chain[-1]])
            chains.append(chain)
        if sum(map(len,chains))!=len(nodes):
            raise AssertionError('短交路假设复用或遗漏唐镇观测')
        result['cases'].append({'minimum':minimum,'maximum':12,'clear':1,
                                'paired_by_station':dict(Counter(r['station'] for r in turns)),
                                'linked_at_both_ends':len(set(previous)&set(following)),
                                'chain_count':len(chains),'longest':max(map(len,chains),default=0),
                                'chains':[[[d,clock(t)] for d,t in c] for c in chains], 'turns':turns})
    return result


def analyze(data_dir, output, day='weekday'):
    tables, inputs = {}, []
    for station in STATIONS:
        for direction in ['UP', 'DN']:
            p = data_dir / f'{station}-{direction}-{day}.txt'
            raw = p.read_bytes()
            tables[station, direction], warnings = read_times(p)
            if raw != p.read_bytes():
                raise ValueError(f'{p.name} 在读取时被更新，须使用一致快照重跑')
            inputs.append({'file': p.name, 'sha256': hashlib.sha256(raw).hexdigest(),
                           'count': len(tables[station, direction]), 'warnings': warnings})
    output.mkdir(parents=True, exist_ok=True)
    report = {'day': day, 'stations': STATIONS, 'inputs': inputs, 'edges': [], 'turns': []}
    all_traces, edge_csv, aligned_csv = [], [], []
    for direction in ['UP', 'DN']:
        order = STATIONS[::-1] if direction == 'UP' else STATIONS
        edges = []
        for a, b in zip(order, order[1:]):
            aa, bb = tables[a, direction], tables[b, direction]
            est = estimate(aa, bb, a, b, direction)
            lag = est['minutes']
            match = match_trains(aa, bb, lag, tolerance=1)
            edges.append((a, b, match))
            r = {'direction': direction, 'from': a, 'to': b, 'estimate': est,
                 'matched': len(match.upstream_to_downstream), 'from_count': len(aa), 'to_count': len(bb),
                 'unmatched_from': list(map(clock, match.only_upstream)),
                 'unmatched_to': list(map(clock, match.only_downstream)),
                 'ambiguous_to': {clock(t): list(map(clock, v)) for t, v in match.alternatives.items() if len(v)>1},
                 'sensitivity': {str(d): len(match_trains(aa, bb, d).upstream_to_downstream)
                                 for d in range(max(1, lag-1), lag+2)}}
            report['edges'].append(r)
            # 用同一上游发车窗比较下游平移后的窗，消除机械地比较整点造成的假差。
            for hour in range(4, 24):
                begin, end = hour*60, (hour+1)*60
                na = sum(begin<=t<end for t in aa)
                nb = sum(begin+lag<=t<end+lag for t in bb)
                paired = sum(begin<=t<end for t in match.upstream_to_downstream)
                aligned_csv.append({'direction':direction, 'from_station':a, 'to_station':b,
                                    'from_window':f'{clock(begin)}–{clock(end)}',
                                    'to_window':f'{clock(begin+lag)}–{clock(end+lag)}',
                                    'from_count':na, 'to_count':nb, 'difference':nb-na,
                                    'matched_from_window':paired})
            for t, u in sorted(match.upstream_to_downstream.items()):
                edge_csv.append({'direction': direction, 'from_station': a, 'from_time': clock(t),
                                 'to_station': b, 'to_time': clock(u), 'lag': lag, 'error': u-t-lag,
                                 'alternatives': ' '.join(map(clock, match.alternatives[u]))})
            print(f'{direction} {a}→{b}: mode={lag} {est["histogram"]} '
                  f'match={r["matched"]}/{len(aa)}/{len(bb)}', flush=True)
        all_traces.extend(traces(tables, edges, direction))
    counts = Counter((r['direction'], s, t//60, r['kind']) for r in all_traces for s, t in r['nodes'])
    hourly = []
    for direction in ['UP', 'DN']:
        for station in STATIONS:
            for hour in range(4, 25):
                r = {'direction': direction, 'station': station, 'hour': hour,
                     **{k: counts[direction, station, hour, k] for k in KINDS}}
                r['total'] = sum(r[k] for k in KINDS)
                if r['total'] != sum(t//60 == hour for t in tables[station, direction]):
                    raise AssertionError('小时分类不守恒')
                hourly.append(r)
    paths = []
    endpoints = defaultdict(list)
    for r in all_traces:
        path = r['nodes']
        row = {k: r[k] for k in ['id', 'direction', 'kind']}
        row['depot_basis'] = depot_basis(path)
        row.update({'start': path[0][0], 'first': clock(path[0][1]), 'end': path[-1][0], 'last': clock(path[-1][1])})
        row.update({s: clock(t) for s, t in path})
        paths.append(row)
        endpoints[r['direction'], r['kind'], path[0][0], path[-1][0]].append(clock(path[0][1]))
    report['endpoints'] = [{'direction': d, 'kind': k, 'start': s, 'end': e, 'count': len(ts), 'first_times': ts}
                           for (d, k, s, e), ts in sorted(endpoints.items())]
    # 折返只考察采样范围内部、确有配线的候选站。最东端海天三路没有机场表，
    # 不能把观测边界当终到；川沙接轨站实际在远东大道，须独立列出。
    turn_csv = []
    lags = {(r['direction'],r['from'],r['to']): r['estimate']['minutes'] for r in report['edges']}
    for station in ['广兰路', '创新中路']:
        for arriving, departing in [('UP', 'DN'), ('DN', 'UP')]:
            # 在同站消失/出现，且至少与一个相邻采样站连得上；单点不算可检验交路。
            ins = [r['nodes'][-1][1] for r in all_traces if r['direction']==arriving
                   and r['kind']=='east_candidate' and r['nodes'][-1][0]==station]
            outs = [r['nodes'][0][1] for r in all_traces if r['direction']==departing
                    and r['kind']=='east_candidate' and r['nodes'][0][0]==station]
            pairs = turn_pairs(ins, outs)
            report['turns'].append({'station': station, 'case': 'observed', 'arrival_direction': arriving, 'departure_direction': departing,
                                    'arrivals': len(ins), 'departures': len(outs), 'paired': len(pairs),
                                    'minimum': 2, 'maximum': 12,
                                    **turn_diagnostics(ins,outs),
                                    'sensitivity_minimum': {str(m): len(turn_pairs(ins, outs, m, 12)) for m in [2,4,6]},
                                    'unpaired_arrivals': list(map(clock, sorted(set(ins)-{a for a,b in pairs}))),
                                    'unpaired_departures': list(map(clock, sorted(set(outs)-{b for a,b in pairs})))})
            turn_csv.extend({'station': station, 'case': 'observed', 'arrival_direction': arriving, 'arrival': clock(a),
                             'departure_direction': departing, 'departure': clock(b), 'wait_min': b-a} for a,b in pairs)
            # 【假设】上车表可能不刊载终到后已不能继续上车的到达。因此另检验
            # “前一采样站最后出现→按众数驶到候选折返站”，不把它写成实测到达。
            i = STATIONS.index(station)
            previous_station = STATIONS[i+1] if arriving=='UP' else STATIONS[i-1]
            lag = lags[arriving,previous_station,station]
            inferred = [r['nodes'][-1][1]+lag for r in all_traces if r['direction']==arriving
                        and inferred_turn_candidate(r) and r['nodes'][-1][0]==previous_station]
            singleton_ins = sum(r['direction']==arriving and len(r['nodes'])==1
                                and r['nodes'][-1][0]==previous_station
                                and inferred_turn_candidate(r) for r in all_traces)
            nearby = {t: [u for u in tables[station,arriving] if abs(t-u)<=1] for t in inferred}
            inferred_pairs = turn_pairs(inferred, outs)
            report['turns'].append({'station':station, 'case':'terminal_not_listed_hypothesis',
                                    'arrival_direction':arriving, 'departure_direction':departing,
                                    'last_observed_station':previous_station, 'lag_to_terminal':lag,
                                    'arrivals':len(inferred), 'departures':len(outs), 'paired':len(inferred_pairs),
                                    'singleton_arrivals':singleton_ins,
                                    'minimum':2, 'maximum':12,
                                    **turn_diagnostics(inferred,outs),
                                    'arrivals_without_nearby_record':sum(not v for v in nearby.values()),
                                    'sensitivity_minimum':{str(m):len(turn_pairs(inferred,outs,m,12)) for m in [2,4,6]}})
            turn_csv.extend({'station':station, 'case':'terminal_not_listed_hypothesis',
                             'arrival_direction':arriving, 'arrival':clock(a),
                             'departure_direction':departing, 'departure':clock(b), 'wait_min':b-a}
                            for a,b in inferred_pairs)
            # 再检验始发和终到都不刊载的较强假设，两端均由相邻采样站回推。
            # 三种口径是替代检验，不能相加，也不能把推算时刻冒充到站实测。
            next_station = STATIONS[i+1] if departing=='DN' else STATIONS[i-1]
            out_lag = lags[departing,station,next_station]
            inferred_outs = [r['nodes'][0][1]-out_lag for r in all_traces if r['direction']==departing
                             and inferred_turn_candidate(r) and r['nodes'][0][0]==next_station]
            singleton_outs = sum(r['direction']==departing and len(r['nodes'])==1
                                 and r['nodes'][0][0]==next_station
                                 and inferred_turn_candidate(r) for r in all_traces)
            both_pairs = turn_pairs(inferred, inferred_outs)
            report['turns'].append({'station':station, 'case':'both_endpoint_records_omitted_hypothesis',
                                    'arrival_direction':arriving, 'departure_direction':departing,
                                    'arrivals':len(inferred), 'departures':len(inferred_outs), 'paired':len(both_pairs),
                                    'singleton_arrivals':singleton_ins,'singleton_departures':singleton_outs,
                                    'minimum':2, 'maximum':12,
                                    **turn_diagnostics(inferred,inferred_outs),
                                    'sensitivity_minimum':{str(m):len(turn_pairs(inferred,inferred_outs,m,12)) for m in [2,4,6]}})
            turn_csv.extend({'station':station, 'case':'both_endpoint_records_omitted_hypothesis',
                             'arrival_direction':arriving, 'arrival':clock(a),
                             'departure_direction':departing, 'departure':clock(b), 'wait_min':b-a}
                            for a,b in both_pairs)
    report['classification_totals'] = dict(Counter(r['kind'] for r in all_traces))
    report['short_shuttle_hypothesis'] = short_shuttle_diagnostics(all_traces,lags)
    # 路径端点可能只反映缺行；特别标出没有已知折返/车辆段配线的采样边界。
    # “图未画”仍不能作为现实中绝无配线的证明。
    report['endpoints_without_drawn_turnback'] = [r for r in paths if len([s for s in STATIONS if s in r])>1
        and (r['start'] in ['金科路','唐镇','川沙'] or r['end'] in ['金科路','唐镇','川沙'])]
    report['hourly'] = hourly
    write_csv(output/'edges.csv', edge_csv, list(edge_csv[0]))
    write_csv(output/'aligned-hourly.csv', aligned_csv, list(aligned_csv[0]))
    write_csv(output/'paths.csv', paths, PATH_FIELDS)
    write_csv(output/'hourly.csv', hourly, list(hourly[0]))
    write_csv(output/'turns.csv', turn_csv, ['station','case','arrival_direction','arrival','departure_direction','departure','wait_min'])
    write_csv(output/'depot-candidates.csv', [r for r in paths if r['depot_basis']], PATH_FIELDS)
    (output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print('路径类别', report['classification_totals'])
    print('折返候选', json.dumps(report['turns'],ensure_ascii=False))
    return report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data-dir', type=Path, default=scrape.OUT)
    p.add_argument('--output', type=Path, default=scrape.ROOT/'work/gaode-east-analysis')
    p.add_argument('--day', choices=['weekday','weekend'], default='weekday')
    a = p.parse_args()
    analyze(a.data_dir, a.output, a.day)


if __name__ == '__main__':
    main()
