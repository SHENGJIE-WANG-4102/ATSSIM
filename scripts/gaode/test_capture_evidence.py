"""证据提取离线测试，不连接手机。"""
import unittest
import xml.etree.ElementTree as ET
import json
from pathlib import Path
import tempfile

from capture_evidence import row_evidence, check_window_identity, extract_archive
import scrape


class EvidenceTests(unittest.TestCase):
    def test_civil_midnight_group_at_top_is_not_mistaken_for_scrambled_rows(self):
        self.assertTrue(scrape.ui_times_increasing(["24:00", "24:05", "06:12", "06:17"]))
        self.assertTrue(scrape.ui_times_increasing(["23:58", "24:00", "24:05"]))
        self.assertFalse(scrape.ui_times_increasing(["11:05", "11:02"]))
        self.assertFalse(scrape.ui_times_increasing(["24:05", "24:00", "06:12"]))

    def test_offline_archive_requires_complete_evidence_for_each_time(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            result = {"station": "虹桥2号航站楼", "direction": "UP", "errors": [],
                      "captured_at": "2026-10-16T00:33:16+08:00", "values": ["11:02", "11:04"]}
            (directory / "result.json").write_text(json.dumps(result), encoding="utf-8")
            xml = '''<hierarchy><node text="地铁2号线"/><node scrollable="true">
                <node><node text="11:02到站"/><node text="开往蟠祥路·国家会计学院"/>
                <node content-desc="区间"/></node></node></hierarchy>'''
            (directory / "0001.xml").write_text(xml, encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "缺完整行证据"):
                extract_archive(directory, "虹桥2号航站楼", "UP")
            (directory / "0002.xml").write_text(xml.replace("11:02", "11:04"), encoding="utf-8")
            data = extract_archive(directory, "虹桥2号航站楼", "UP")
            self.assertEqual(data["values"], ["11:02", "11:04"])
            self.assertIn("区间", [n["content-desc"] for p in data["pages"] for r in p["rows"] for n in r["nodes"]])

    def test_station_heading_may_scroll_out_but_other_station_is_rejected(self):
        root = ET.fromstring('''<hierarchy><node text="地铁2号线"/>
          <node scrollable="true"><node text="11:02到站"/>
          <node text="开往蟠祥路·国家会计学院"/></node></hierarchy>''')
        check_window_identity(root, "虹桥2号航站楼", "2", "蟠祥路·国家会计学院")
        ET.SubElement(root, "node", text="上车站：淞虹路")
        with self.assertRaisesRegex(RuntimeError, "站点被切走"):
            check_window_identity(root, "虹桥2号航站楼", "2", "蟠祥路·国家会计学院")

    def test_wrong_line_is_rejected_even_if_destination_matches(self):
        root = ET.fromstring('''<hierarchy><node text="地铁10号线"/>
          <node scrollable="true"><node text="11:02到站"/>
          <node text="开往蟠祥路·国家会计学院"/></node></hierarchy>''')
        with self.assertRaisesRegex(RuntimeError, "线路页标签不符"):
            check_window_identity(root, "虹桥2号航站楼", "2", "蟠祥路·国家会计学院")

    def test_keeps_all_texts_and_descriptions_in_same_row(self):
        root = ET.fromstring('''<hierarchy><node scrollable="true">
          <node text="11:00-12:00" />
          <node bounds="[0,100][100,200]">
            <node text="11:02到站"/><node text="开往蟠祥路"/>
            <node text="2号线" content-desc="线路角标"/><node text="区间车"/>
            <node content-desc="始发"/>
          </node>
          <node><node text="11:04到站"/><node text="开往虹桥火车站"/></node>
        </node></hierarchy>''')
        rows = row_evidence(root)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["time"], "11:02")
        self.assertEqual([n["text"] for n in rows[0]["nodes"] if n["text"]],
                         ["11:02到站", "开往蟠祥路", "2号线", "区间车"])
        self.assertIn("始发", [n["content-desc"] for n in rows[0]["nodes"]])
        self.assertNotIn("11:04到站", [n["text"] for n in rows[0]["nodes"]])

    def test_single_row_does_not_swallow_hour_heading(self):
        root = ET.fromstring('''<hierarchy><node scrollable="true"><node>
          <node text="11:00-12:00"/><node><node text="11:02到站"/>
          <node text="开往蟠祥路"/></node></node></node></hierarchy>''')
        row = row_evidence(root)[0]
        self.assertEqual([n["text"] for n in row["nodes"] if n["text"]],
                         ["11:02到站", "开往蟠祥路"])


if __name__ == "__main__":
    unittest.main()
