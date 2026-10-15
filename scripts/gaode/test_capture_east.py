"""导航回归：不能把视口底部看不到到站行的标题误判为折叠。"""
import unittest
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory
from datetime import datetime
import xml.etree.ElementTree as ET

import capture_east
import scrape


def screen(*lines):
    root = ET.Element('node', scrollable='true', bounds='[0,0][600,1600]')
    for i, text in enumerate(lines):
        parent = root
        if scrape.ARRIVAL.fullmatch(text):
            parent = ET.SubElement(root,'node',clickable='true',
                                   **{'class':'android.view.ViewGroup','bounds':f'[0,{i*100}][600,{i*100+90}]'})
        ET.SubElement(parent, 'node', text=text, bounds=f'[0,{i*100}][300,{i*100+70}]')
        if parent is not root:
            ET.SubElement(parent,'node',text='开往蟠祥路·国家会计学院',bounds=f'[300,{i*100}][600,{i*100+70}]')
    return root


class CaptureEastTest(unittest.TestCase):
    def test_failed_read_is_discarded_before_two_fresh_complete_reads(self):
        root = screen('上车站：广兰路')
        class Device:
            last_root = root
            def dump(self):
                return root
        good = (['06:00','23:00'],{'06:00-07:00','23:00-24:00'},{'开往浦东1号2号航站楼'},[])
        with TemporaryDirectory() as folder, \
             patch.object(scrape,'WORK',Path(folder)), \
             patch.object(scrape,'local_now',return_value=datetime(2026,10,15,12)), \
             patch.object(scrape,'check_identity'), \
             patch.object(scrape,'validate',return_value=([],[])), \
             patch.object(capture_east,'expand') as expand, \
             patch.object(scrape,'read_expanded',side_effect=[RuntimeError('翻页缺少重叠行'),good,good]) as read, \
             patch.object(capture_east,'publish',return_value=Path(folder)/'table.txt') as publish:
            capture_east.capture(Device(),'广兰路','DN','weekday',expanded=True)
        self.assertEqual(expand.call_count,2)
        self.assertEqual(read.call_count,3)
        self.assertEqual(publish.call_args.args[0]['values'],good[0])

    def test_scroll_uses_rows_and_compensates_measured_inertia(self):
        def rows(offset):
            root = ET.Element('node', bounds='[0,0][600,1600]')
            for i in range(16):
                y = i*100+offset
                row = ET.SubElement(root, 'node', bounds=f'[0,{y}][600,{y+100}]')
                ET.SubElement(row, 'node', text=f'06:{i:02}:00到站'.replace(':00到站','到站'),
                              bounds=f'[0,{y}][300,{y+70}]')
            return root
        device = capture_east.EastDevice.__new__(capture_east.EastDevice)
        device.scroll_gain = 1.0
        calls = []
        device.run = lambda *args: calls.append(args)
        with patch('capture_east.time.sleep'):
            device.swipe(rows(0))
            first = int(calls[-1][4])-int(calls[-1][6])
            # 16行视口保留至少3行；不是固定1/3屏。
            self.assertGreater(first, 1000)
            self.assertLessEqual(first, 1300)
            self.assertGreaterEqual(int(calls[-1][-1]), first/.68-2)
            device.swipe(rows(1500))
            second = int(calls[-1][4])-int(calls[-1][6])
            self.assertLess(second, first)

    def test_horizontal_navigation_follows_actual_station_order(self):
        device = capture_east.EastDevice.__new__(capture_east.EastDevice)
        root = ET.Element('node')
        carousel = ET.SubElement(root,'node',**{'class':'SpringHorizontalScrollView'})
        ET.SubElement(carousel,'node',text='远东大道',bounds='[0,100][100,200]')
        ET.SubElement(carousel,'node',text='川沙',bounds='[200,100][300,200]')
        device.last_root = root
        calls = []
        device.run = lambda *args:calls.append(args)
        with patch('capture_east.time.sleep'):
            device.swipe(screen(),horizontal=True)
        self.assertLess(int(calls[-1][3]),int(calls[-1][5]))

    def test_endpoint_observation_cannot_hide_missing_data_or_large_drift(self):
        self.assertTrue(capture_east.endpoint_only(['末班 22:38 / 官方 22:40，相差 -2 min']))
        for errors in [[],['末班 22:37 / 官方 22:40，相差 -3 min'],
                       ['时刻没有严格递增或有重复'],['末班 22:38 / 官方 22:40，相差 -2 min','没有到站记录']]:
            self.assertFalse(capture_east.endpoint_only(errors))

    def test_full_reverse_read_checks_overlap_and_does_not_rewind(self):
        pages = [screen('07:00-08:00','07:00到站','07:05到站'),
                 screen('06:00-07:00','06:55到站','07:00-08:00','07:00到站'),
                 screen('06:00-07:00','06:50到站','06:55到站')]
        class Device:
            i = 0
            moves = []
            def dump(self):
                return pages[self.i]
            def swipe(self, node, reverse=False):
                self.moves.append(reverse)
                self.i = min(self.i+1,len(pages)-1)
        device = Device()
        values,groups,_,_ = scrape.read_expanded(device,'金科路','UP',20,reverse=True,rewind_first=False)
        self.assertEqual(values,['06:50','06:55','07:00','07:05'])
        self.assertEqual(groups,{'06:00-07:00','07:00-08:00'})
        self.assertTrue(all(device.moves))

    def test_guanglan_east_boarding_excludes_last_terminating_arrival(self):
        errors, warnings = scrape.validate('广兰路', 'DN', ['06:00','23:00'])
        self.assertEqual((errors, warnings), ([], []))
        errors, _ = scrape.validate('广兰路', 'DN', ['06:00','23:44'])
        self.assertTrue(errors)

    def test_west_of_guanglan_still_includes_last_short_service(self):
        self.assertEqual(scrape.validate('张江高科', 'DN', ['06:22','23:39']), ([], []))
        errors, _ = scrape.validate('张江高科', 'DN', ['06:22','22:54'])
        self.assertTrue(errors)

    def test_last_header_is_ambiguous_when_first_row_is_below_viewport(self):
        self.assertEqual(capture_east.collapsed_headers(screen('19:58到站','20:00-21:00')), [])

    def test_only_header_followed_by_another_header_is_collapsed(self):
        nodes = capture_east.collapsed_headers(screen('19:00-20:00','20:00-21:00','20:02到站','21:00-22:00'))
        self.assertEqual([n.get('text') for n in nodes], ['19:00-20:00'])

    def test_expanded_header_must_not_be_toggled_closed(self):
        self.assertEqual(capture_east.collapsed_headers(screen('20:00-21:00','20:02到站')), [])


if __name__=='__main__':
    unittest.main()
