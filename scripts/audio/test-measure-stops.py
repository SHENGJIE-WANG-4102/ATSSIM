#!/usr/bin/env python3
"""Short synthetic regressions: python scripts/audio/test-measure-stops.py."""
import importlib.util
import json
from pathlib import Path
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location('measure_stops', Path(__file__).with_name('measure-stops.py'))
stops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stops)
tone_spec = importlib.util.spec_from_file_location('door_tones', Path(__file__).with_name('measure-door-tones.py'))
tones = importlib.util.module_from_spec(tone_spec)
tone_spec.loader.exec_module(tones)


class StopContextTests(unittest.TestCase):
    def measure_ridge(self, endpoint, window_start=0):
        frequencies = np.arange(0, 1202, 2.)
        times = np.arange(.256, 30, .064)
        prominence = np.full((len(frequencies), len(times)), -3.)
        # Known falling ridge followed by a quieter low band. At 4 s only
        # half the 8 s template exists; high contrast cannot restore that data.
        for i, at in enumerate(times):
            if endpoint - 8 <= at < endpoint:
                hz = min(960, 650 + 60 * (endpoint - at))
                prominence[abs(frequencies - hz) < 14, i] = 15
        power = np.full_like(prominence, 1e-7)
        power[(frequencies < 400)[:, None] & (times < endpoint)[None, :]] = 1e-5
        return stops.measure(frequencies, times, power, prominence,
                             np.zeros(len(times), dtype=bool),
                             dict(recording='synthetic', station='test', direction='DN',
                                  analysisWindowS=[window_start, 22]), 30)

    def test_truncated_ridge_cannot_be_accepted_into_means(self):
        result = self.measure_ridge(4)
        self.assertLessEqual(abs(result['stop'] - 4), 3)
        self.assertEqual(result['confidence'], 'low')
        self.assertTrue(result['edgeLimited'])
        json.dumps(result, allow_nan=False)  # CLI results must remain serializable.

    def test_full_ridge_retains_usable_confidence(self):
        result = self.measure_ridge(12)
        self.assertLessEqual(abs(result['stop'] - 12), 3)
        self.assertIn(result['confidence'], ('high', 'medium'))
        self.assertFalse(result['edgeLimited'])

    def test_review_window_does_not_discard_available_audio_context(self):
        result = self.measure_ridge(12, window_start=6)
        self.assertIn(result['confidence'], ('high', 'medium'))
        self.assertFalse(result['edgeLimited'])


class DoorToneTests(unittest.TestCase):
    def test_other_recording_can_supply_its_own_peaks_without_changing_defaults(self):
        t = np.arange(8 * 8000) / 8000
        pulse = (t > 1) & (t < 6) & ((t % .8) < .35)
        audio = .15 * pulse * np.sin(2 * np.pi * 2932 * t)
        self.assertEqual(tones.detect_tones(audio), [])
        results = tones.detect_tones(audio, radius_hz=20, centres_hz=[2932, 2975, 3060], background_hz=[2780, 3230])
        self.assertEqual(len(results), 1)

    def test_shifted_warning_is_detected_without_relabelling_it_as_door_motion(self):
        t = np.arange(8 * 8000) / 8000
        pulse = (t > 1) & (t < 6) & ((t % .8) < .35)
        for hz in [2736, 2867]:
            with self.subTest(hz=hz):
                audio = .15 * pulse * np.sin(2 * np.pi * hz * t)
                self.assertEqual(tones.detect_tones(audio, radius_hz=9), [])
                results = tones.detect_tones(audio)
                self.assertEqual(len(results), 1)
                self.assertEqual(results[0]['kind'], 'closing-warning-candidate')
                self.assertLess(abs(results[0]['start'] - 1), .3)
                self.assertFalse(results[0]['leftCensored'])

    def test_broadband_noise_is_not_a_warning(self):
        audio = np.random.default_rng(16).normal(0, .05, 8 * 8000)
        self.assertEqual(tones.detect_tones(audio), [])

    def test_clipped_warning_is_marked_at_the_file_boundary(self):
        t = np.arange(3 * 8000) / 8000
        results = tones.detect_tones(.15 * np.sin(2 * np.pi * 2736 * t))
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0]['leftCensored'])
        self.assertTrue(results[0]['rightCensored'])


if __name__ == '__main__':
    unittest.main()
