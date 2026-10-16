#!/usr/bin/env python3
"""Portable cue regressions; no local recording or passenger data required."""
import importlib.util
from pathlib import Path
import unittest
import numpy as np

spec=importlib.util.spec_from_file_location('cues',Path(__file__).with_name('measure-motion-cues.py'))
cues=importlib.util.module_from_spec(spec);spec.loader.exec_module(cues)


class MotionCueTests(unittest.TestCase):
    def test_sustained_opening_step_is_localized(self):
        t=np.arange(12*8000)/8000
        noise=np.random.default_rng(8).normal(0,.001,len(t))
        data=cues.features(noise*np.where(t>=5,5,1))
        result=cues.opening_cue(data,[3,8])
        self.assertLess(abs(result['at']-5),.5)
        self.assertGreater(result['gainDb'],10)

    def test_static_background_does_not_create_a_start(self):
        a=np.random.default_rng(9).normal(0,.001,12*8000)
        self.assertIsNone(cues.starting_cue(cues.features(a),[2,9]))

    def test_start_uses_rolling_change_and_is_gain_invariant(self):
        t=np.arange(12*8000)/8000
        noise=np.random.default_rng(10).normal(0,.001,len(t))
        low=np.sin(2*np.pi*63*t)*np.where(t>=5,.02,0)
        switching=.03*np.sin(2*np.pi*1600*t)*((t>=3)&(t<4))
        a=noise+low+switching
        first=cues.starting_cue(cues.features(a),[2,9])
        quiet=cues.starting_cue(cues.features(a*.1),[2,9])
        self.assertIsNotNone(first);self.assertIsNotNone(quiet)
        self.assertTrue(first['rollingConfirmed'])
        self.assertLess(abs(first['at']-5),.5)
        self.assertAlmostEqual(first['at'],quiet['at'],places=2)

    def test_impact_based_closing_estimate_cannot_be_promoted_to_measured_onset(self):
        a=np.random.default_rng(11).normal(0,.001,12*8000)
        a[round(7.1*8000):round(7.12*8000)]+=.2
        result=cues.closing_cue(cues.features(a),7.2)
        self.assertEqual(result['confidence'],'low')
        self.assertLess(abs(result['impactAt']-7.1),.2)

    def test_missing_post_event_context_returns_no_opening_estimate(self):
        data=cues.features(np.zeros(3*8000))
        self.assertIsNone(cues.opening_cue(data,[2.8,3]))


if __name__=='__main__':unittest.main()
