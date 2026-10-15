"""东段分析：路径不能复用观测、候选分类与折返时序。无手机依赖。"""
import unittest
from pathlib import Path
import tempfile

import east_analysis as east
from match_trains import match_trains


class EastAnalysisTest(unittest.TestCase):
    def test_marked_two_minute_endpoint_observation_keeps_actual_time(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'远东大道-UP-weekday.txt'
            path.write_text(east.OBSERVATION+'\n06:10\n22:38\n',encoding='utf-8')
            values,warnings=east.read_times(path)
            self.assertEqual(values[-1],22*60+38)
            self.assertIn('未通过',warnings[0])

    def test_endpoint_exception_requires_marker_and_rejects_other_errors(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'远东大道-UP-weekday.txt'
            for text in ['06:10\n22:38\n',east.OBSERVATION+'\n06:10\n22:37\n',
                         east.OBSERVATION+'\n06:10\n06:10\n22:38\n']:
                path.write_text(text,encoding='utf-8')
                with self.assertRaises(ValueError):east.read_times(path)

    def test_unlisted_depot_portal_boundary_is_kept_undetermined(self):
        nodes = [('川沙',600),('创新中路',607),('唐镇',611)]
        self.assertEqual(east.classify(nodes),'unresolved')
        self.assertIn('lingkong',east.depot_basis(nodes))
        self.assertEqual(east.classify(nodes[::-1]),'unresolved')

    def test_single_berth_rejects_two_simultaneous_turns(self):
        self.assertEqual(len(east.turn_pairs([600,601],[603,604])),2)
        self.assertEqual(len(east.single_berth_turn_pairs([600,601],[603,604])),1)

    def test_single_berth_preserves_sequential_turns_and_clearance(self):
        self.assertEqual(east.single_berth_turn_pairs([600,605],[603,608],clear=1),[(600,603),(605,608)])
        self.assertEqual(len(east.single_berth_turn_pairs([600,605],[603,608],clear=3)),1)

    def test_tied_modes_remain_visible_in_estimate(self):
        result = east.estimate([600,605], [602,603,607,608], '张江高科','金科路','DN')
        self.assertEqual(result['modes'], [2,3])
        self.assertEqual(result['minutes'], 2)

    def test_modal_lag_uses_same_terminal_not_different_first_origin(self):
        # 广兰路东行首班比金科路还早，必须用同终点末班限制相位。
        result = east.estimate([600, 605, 610], [602, 607, 612], '金科路', '广兰路', 'DN')
        self.assertEqual(result['minutes'], 2)
        self.assertEqual(result['anchor'], 4)

    def test_classification_keeps_singletons_and_depot_separate(self):
        self.assertTrue(east.inferred_turn_candidate({'kind':'unresolved','nodes':[('唐镇',600)]}))
        self.assertFalse(east.inferred_turn_candidate({'kind':'unresolved','nodes':[('川沙',600)]}))
        self.assertEqual(east.classify([('唐镇',600)]),'unresolved')
        self.assertEqual(east.classify([('广兰路',600)]), 'unresolved')
        self.assertEqual(east.classify([('唐镇',600),('广兰路',604)]), 'east_candidate')
        self.assertEqual(east.classify([('金科路',600),('张江高科',602)]), 'core_candidate')
        self.assertEqual(east.classify([('远东大道',600),('川沙',608)]), 'depot_candidate')
        self.assertEqual(east.classify([('唐镇',600),('广兰路',604),('金科路',607)]), 'unresolved')

    def test_full_chain_and_broken_chain_cover_every_observation_once(self):
        tables = {(s,'DN'):[600+i*3, 610+i*3] for i,s in enumerate(east.STATIONS)}
        # 第二班只在中部缺一站，禁止把两端残段拼成贯通车。
        tables['广兰路','DN'] = tables['广兰路','DN'][:1]
        edges = [(a,b,match_trains(tables[a,'DN'],tables[b,'DN'],3))
                 for a,b in zip(east.STATIONS,east.STATIONS[1:])]
        paths = east.traces(tables,edges,'DN')
        self.assertEqual(sum(r['kind']=='through' for r in paths),1)
        self.assertEqual(sum(len(r['nodes']) for r in paths),15)
        observations = [node for r in paths for node in r['nodes']]
        self.assertEqual(len(set(observations)),15)

    def test_turn_pairs_enforce_minimum_and_do_not_reuse_departure(self):
        result = east.turn_pairs([600,601,610],[601,603,612],2,12)
        self.assertEqual(len(result),2)
        self.assertTrue(all(2<=b-a<=12 for a,b in result))
        self.assertEqual(len({b for a,b in result}),2)
        self.assertNotIn(601,{b for a,b in result})

    def test_short_shuttle_links_same_observations_at_both_ends(self):
        paths = [{'direction':d,'nodes':[('唐镇',t)]} for d,ts in [('UP',[600,618]),('DN',[610,628])] for t in ts]
        lags = {('UP','唐镇','广兰路'):4,('DN','广兰路','唐镇'):4,
                ('DN','唐镇','创新中路'):3,('UP','创新中路','唐镇'):3}
        result = east.short_shuttle_diagnostics(paths,lags)
        self.assertEqual(result['cases'][0]['paired_by_station'],{'广兰路':2,'创新中路':1})
        self.assertEqual(result['cases'][0]['chain_count'],1)
        self.assertEqual(result['cases'][0]['longest'],4)
        self.assertEqual(result['cases'][1]['chain_count'],4)

    def test_turn_pairs_minimize_wait_after_maximizing_count(self):
        self.assertEqual(east.turn_pairs([600,604],[606],2,12),[(604,606)])
        self.assertEqual(east.turn_pairs([600],[602,604],4,12),[(600,604)])
        self.assertEqual(east.turn_pairs([600],[620],2,12),[])


if __name__=='__main__':
    unittest.main()
