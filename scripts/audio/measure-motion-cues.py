#!/usr/bin/env python3
"""Local opening, closing-motion and starting cues in explicit review windows.

Dependencies: numpy, scipy. 8 kHz mono float32; no audio is uploaded.
Windows come from station order/announcements/spectral review, never the plan.
【假设】Relative band changes and switching-tone bands are microphone-dependent.
Closing motion inferred from an impact minus calibrated travel time stays low
confidence: a timing estimate is not an independently detected motor onset.
"""
import numpy as np
from scipy import signal, ndimage


def features(audio):
    f, t, p = signal.spectrogram(audio, fs=8000, nperseg=1024, noverlap=896, scaling='spectrum')
    db = 10 * np.log10(np.maximum(p, 1e-12))
    def band(lo, hi, smoothing):
        v = 10 * np.log10(np.maximum(p[(f >= lo) & (f < hi)].sum(axis=0), 1e-12))
        return ndimage.median_filter(v, size=smoothing)
    prominence = db - ndimage.median_filter(db, size=(11, 1))
    switch_band = (f >= 1450) & (f < 1750)
    return dict(f=f, t=t,
                broad=band(400, 2400, 5), impact=band(100, 2400, 1),
                rolling=band(20, 100, 31),
                switching=band(1450, 1750, 5),
                switchProm=ndimage.median_filter(prominence[switch_band].max(axis=0), size=5),
                duration=len(audio) / 8000)


def median(v, t, lo, hi):
    selected = (t >= lo) & (t < hi)
    return float(np.median(v[selected])) if selected.any() else float('nan')


def opening_cue(data, window):
    t, level = data['t'], data['broad']
    lo, hi = max(window[0], 1.1), min(window[1], data['duration'] - .7)
    if hi <= lo:
        return None
    candidates = np.arange(lo, hi, .016)
    gain = np.array([median(level, t, at + .1, at + .6) - median(level, t, at - 1, at - .25)
                     for at in candidates])
    i = int(np.argmax(gain)); at = float(candidates[i])
    competing = abs(candidates - at) > 1
    ambiguous = bool(competing.any() and gain[competing].max() >= gain[i] - 2)
    edge = at - window[0] < .4 or window[1] - at < .4
    confidence = 'medium' if gain[i] >= 6 and not ambiguous and not edge else 'low'
    return dict(at=round(at, 2), confidence=confidence, method='opening-band-step',
                gainDb=round(float(gain[i]), 2), ambiguous=ambiguous, edgeLimited=edge)


def closing_cue(data, warning_end, travel_s=3):
    # The 3 s prior is the measured door travel duration in the calibration
    # video, not a fixed delay after the start of the warning. Keep it low.
    t, level = data['t'], data['impact']
    lo, hi = max(1, warning_end - .9), min(data['duration'] - .3, warning_end + .7)
    mask = (t >= lo) & (t <= hi)
    if not mask.any():
        return None
    local = level - ndimage.median_filter(level, size=51)
    indices = np.flatnonzero(mask)
    i = int(indices[np.argmax(local[mask])]); impact = float(t[i])
    return dict(at=round(max(0, impact - travel_s), 2), confidence='low',
                method='door-impact-duration', impactAt=round(impact, 2),
                travelS=travel_s, impactExcessDb=round(float(local[i]), 2))


def starting_cue(data, window):
    t = data['t']
    lo, hi = max(window[0], 1), min(window[1], data['duration'] - 1)
    if hi <= lo:
        return None
    # In this video's two starts a brief ~1.6 kHz switching tone precedes
    # movement. Requiring a local level rise plus narrow-band prominence
    # avoids choosing the later ~0.9 kHz plateau as the departure onset.
    # 【假设】Only transfer after checking the source has this switching cue.
    selected = (t >= lo) & (t <= hi)
    switching = data['switching']
    switch_floor = float(np.quantile(switching[selected], .2))
    powered = selected & (switching >= switch_floor + 6) & (data['switchProm'] >= 10)
    power_at = None
    for i in np.flatnonzero(powered):
        after = (t >= t[i]) & (t < t[i] + .25)
        if after.sum() >= 12 and np.mean(powered[after]) >= .8:
            power_at = float(t[i]); break
    if power_at is None:
        return None
    roll = data['rolling']
    base = (t >= max(lo, power_at - 1)) & (t < power_at + 1)
    floor = float(np.quantile(roll[base], .2))
    moving = (t >= power_at) & (t <= min(window[1], power_at + 4)) & (roll >= floor + 3)
    confirmed = None
    for i in np.flatnonzero(moving):
        after = (t >= t[i]) & (t < t[i] + .5)
        if after.sum() >= 20 and np.mean(roll[after] >= floor + 3) >= .8:
            confirmed = float(t[i]); break
    at = power_at if confirmed is None else confirmed
    return dict(at=round(at, 2), confidence='medium', method='traction-switch-and-rolling',
                powerAt=round(power_at, 2), rollingConfirmed=confirmed is not None,
                floorDb=round(floor, 2), switchingFloorDb=round(switch_floor, 2))
