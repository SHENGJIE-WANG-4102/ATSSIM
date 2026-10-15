"""离线配对回归：相位、禁止重复配对、最优解歧义、守恒边界。"""
import unittest

from match_trains import clean_five, conservation, dense_runs, estimate_lag, match_trains, official_lag_anchor


class MatchingTests(unittest.TestCase):
    def test_no_reuse_and_order(self):
        result = match_trains([600, 605], [607, 609, 612], 7)
        self.assertEqual(result.upstream_to_downstream, {600: 607, 605: 612})
        self.assertEqual(result.only_downstream, [609])

    def test_maximum_count_precedes_error(self):
        # 最近邻先抢607会丢一班；两个各偏1分钟的配对应优先。
        result = match_trains([600, 601], [606, 607], 7)
        self.assertEqual(len(result.upstream_to_downstream), 2)
        self.assertEqual(result.only_downstream, [])

    def test_equal_optima_are_explicit(self):
        result = match_trains([600], [606, 608], 7)
        self.assertEqual(len(result.upstream_to_downstream), 1)
        self.assertEqual(result.alternatives, {606: [600], 608: [600]})
        self.assertEqual(len(result.only_downstream), 1)

    def test_exact_match_precedes_near_match(self):
        result = match_trains([600], [606, 607], 7)
        self.assertEqual(result.upstream_to_downstream, {600: 607})
        self.assertEqual(result.alternatives[606], [])

    def test_five_minute_mode_uses_clean_samples(self):
        a = [600, 605, 610, 615, 620, 625, 630]
        b = [607, 612, 617, 622, 627, 632, 637]
        # 另一段密集车不能拉偏干净5分钟段的众数。
        b += [700, 702, 704, 706, 708, 710]
        result = estimate_lag(a, b, 8)
        self.assertEqual(result["minutes"], 7)
        self.assertEqual(result["histogram"], {7: 7})

    def test_no_fallback_when_no_clean_evidence(self):
        with self.assertRaisesRegex(ValueError, "没有共同"):
            estimate_lag([600, 602, 604], [607, 609, 611], 7)

    def test_clean_run_requires_four_intervals(self):
        clean, runs = clean_five([600, 605, 610, 615, 620, 622, 627, 632])
        self.assertEqual(clean, [600, 605, 610, 615, 620])
        self.assertEqual(runs, [(600, 620, 5)])

    def test_anchor_does_not_subtract_first_trains_from_different_origins(self):
        self.assertEqual(official_lag_anchor("唐镇", "广兰路", "UP"), 4)
        self.assertEqual(official_lag_anchor("淞虹路", "虹桥2号航站楼", "UP"), 7)

    def test_conservation_cross_hour_and_midnight(self):
        rows = conservation([659, 660, 1445], [660])
        self.assertEqual(rows[10 - 4]["cumulative"], 1)
        self.assertEqual(rows[11 - 4]["net"], 0)
        self.assertEqual(rows[24 - 4]["cumulative"], 2)

    def test_dense_segments_do_not_assert_hour_alignment(self):
        self.assertEqual(dense_runs([659, 661, 663, 665, 670])[0]["start"], "10:59")


if __name__ == "__main__":
    unittest.main()
