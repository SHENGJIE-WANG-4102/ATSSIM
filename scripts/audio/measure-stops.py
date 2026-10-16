#!/usr/bin/env python3
"""Estimate stops from terminal descending motor ridges and low-band knees.

Dependencies: Python 3, numpy, scipy; ffmpeg on PATH. No runtime dependency.
Input events: JSON exported by ridelog-report.ts --measurement-input PATH.
Speech JSONL is optional local-only masking evidence, never a source of stops.
All outputs (including derived mono audio) are restricted to ignored work/.
Example: python scripts/audio/measure-stops.py INPUT.wav --events EVENTS.json
         --recording ride-east --out work/recordings/analysis/stops
         --speech work/recordings/analysis/east/speech-chunked.jsonl

The frequency grids, confidence cutoffs and 0-3 s endpoint refinement are assumptions,
specific to these recordings. A confidence label is not a statistical error bar.
Missing pre/post context or weak/interfered ridges gives low confidence; keep the
estimate but exclude it from means. No speed or distance calibration is changed.
"""
import argparse
import json
import subprocess
from pathlib import Path

import numpy as np
from scipy import ndimage, signal


def median_level(level, times, start, end):
    mask = (times >= start) & (times < end)
    return float(np.median(level[mask])) if mask.any() else float('nan')


def measure(frequencies, times, power, prominence, speech, row, duration):
    window = row.get('analysisWindowS', row.get('arrivalReviewS'))
    if window is None:
        return None
    low, high = window
    close = row.get('close')
    if close is None:
        close = row.get('candidates', {}).get('close', {}).get('at')
    if close is not None:
        high = max(high, close - 2)
    high = min(high, duration - 2)
    if high <= low + 8:
        return None
    dt, df = times[1] - times[0], frequencies[1] - frequencies[0]
    ends = np.arange(low + 3, high, .25)
    lag, future = np.arange(.4, 8.01, .2), np.arange(.2, 1.41, .2)
    before_i = np.clip(np.rint((ends[:, None] - lag - times[0]) / dt).astype(int), 0, len(times) - 1)
    after_i = np.clip(np.rint((ends[:, None] + future - times[0]) / dt).astype(int), 0, len(times) - 1)
    voiced = speech[before_i].mean(axis=1)
    best = None
    score_by_end = np.full(len(ends), -np.inf)
    # The recurring carrier ridge approaches 0.9 kHz, then falls into 0.55-0.65 kHz.
    # Match its shape rather than identifying a speech-ending broadband drop.
    for plateau in [900, 920, 940, 960]:
        for end_hz in [550, 600, 650]:
            for slope in [45, 60, 75, 90, 105]:
                bins = np.rint(np.minimum(plateau, end_hz + slope * lag) / df).astype(int)
                bins_after = np.rint(np.maximum(100, end_hz - slope * future) / df).astype(int)
                before = prominence[bins[None, :], before_i]
                after = prominence[bins_after[None, :], after_i]
                descending = np.minimum(plateau, end_hz + slope * lag) < plateau - 30
                tail = before[:, descending]
                score = (np.quantile(before, .3, axis=1) + .5 * np.minimum(15, np.median(before, axis=1))
                         - .5 * np.maximum(0, np.median(after, axis=1)) - 5 * voiced)
                score_by_end = np.maximum(score_by_end, score)
                pick = int(score.argmax())
                if best is None or score[pick] > best['score']:
                    best = dict(seed=float(ends[pick]), score=float(score[pick]), plateau=plateau,
                                endHz=end_hz, slopeHzPerS=slope,
                                ridgeBeforeDb=float(np.median(before[pick])),
                                ridgeAfterDb=float(np.median(after[pick])), voicedFraction=float(voiced[pick]),
                                tailContrastDb=float(np.median(tail[pick])))
    bands = [(20, 80), (80, 180), (180, 400), (400, 1100)]
    levels = []
    for lo, hi in bands:
        bins = (frequencies >= lo) & (frequencies < hi)
        for hum in [50, 100, 150, 200, 250, 300]:
            bins &= abs(frequencies - hum) > 3
        levels.append(10 * np.log10(np.maximum(power[bins].sum(axis=0), 1e-12)))
    low_power = sum(10 ** (level / 10) for level in levels[:3])
    low_db = ndimage.median_filter(10 * np.log10(np.maximum(low_power, 1e-12)), size=9)
    seed = best['seed']
    floor_mask = (times >= seed - 2) & (times < min(duration, seed + 6))
    floor_db = float(np.quantile(low_db[floor_mask], .2))
    # Refine only around the ridge endpoint. Speech ending tens of seconds earlier
    # must never win this energy-knee search.
    candidates = np.arange(max(low, seed), min(high, seed + 3) + .01, .064)
    knee_scores = []
    for at in candidates:
        before = median_level(low_db, times, at - 1.3, at - .3)
        after = median_level(low_db, times, at + .2, at + 1.2)
        knee_scores.append(before - after - max(0, after - floor_db) - .35 * abs(at - seed))
    # Prefer the later endpoint of nearly equal knees; the ridge is still fading
    # at an early low-band dip. This avoids claiming a transient dip as a stop.
    knee_scores = np.asarray(knee_scores)
    at = float(candidates[np.flatnonzero(knee_scores >= knee_scores.max() - .4)[-1]])
    evidence = []
    for band, level in zip(bands, levels):
        before = median_level(level, times, at - 4, at - 1)
        after = median_level(level, times, at + .2, at + 1.5)
        evidence.append(dict(bandHz=list(band), beforeDb=round(before, 2), afterDb=round(after, 2),
                             fallDb=round(before - after, 2)))
    low_before = median_level(low_db, times, at - 1.3, at - .3)
    low_after = median_level(low_db, times, at + .2, at + 1.2)
    ridge_drop = best['ridgeBeforeDb'] - best['ridgeAfterDb']
    alternatives = abs(ends - seed) > 6
    alternative_score = float(np.max(score_by_end[alternatives])) if alternatives.any() else float('-inf')
    ambiguous = alternative_score >= best['score'] - .75
    confidence = ('high' if best['score'] >= 7 and ridge_drop >= 6 else
                  'medium' if best['score'] >= 3 and ridge_drop >= 3 else 'low')
    # Poor floor recovery/voice overlap weakens the physical interpretation.
    if low_after > floor_db + 2 or best['voicedFraction'] > .3 or ambiguous:
        confidence = 'low'
    elif low_before - low_after < .15 and confidence == 'high':
        confidence = 'medium'
    # np.clip above keeps indexing safe, but repeating the first STFT column
    # cannot supply missing braking history. Short platform videos exposed
    # accepted candidates with only 3-4 s of an 8 s ridge available.
    # 【假设】Incomplete template context must be excluded from means; this is
    # a confidence guard, not a video-validated correction to the timestamp.
    pre_context_limited = bool(seed - float(lag[-1]) < times[0])
    edge = duration - at < 4 or at - low < 4 or pre_context_limited
    if edge:
        confidence = 'low'
    return dict(station=row['station'], recording=row['recording'], direction=row['direction'],
                stop=round(at), confidence=confidence, method='spectral-knee',
                bandHz=[best['endHz'], best['plateau']],
                ridgeBeforeDb=round(best['ridgeBeforeDb'], 2), ridgeAfterDb=round(best['ridgeAfterDb'], 2),
                ridgeFallDb=round(ridge_drop, 2), lowBandHz=[20, 400],
                lowBeforeDb=round(low_before, 2), lowAfterDb=round(low_after, 2),
                lowFallDb=round(low_before - low_after, 2), floorDb=round(floor_db, 2),
                score=round(best['score'], 2), tailContrastDb=round(best['tailContrastDb'], 2), sweepEndS=round(seed, 2),
                voicedFraction=round(best['voicedFraction'], 2), edgeLimited=edge,
                preContextLimited=pre_context_limited,
                ambiguous=ambiguous, alternativeScore=round(alternative_score, 2), energy=evidence)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--events', type=Path, required=True)
    parser.add_argument('--recording', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--speech', type=Path)
    args = parser.parse_args()
    workspace = Path(__file__).resolve().parents[2]
    output = args.out.resolve()
    if not output.is_relative_to(workspace / 'work'):
        parser.error('Output must be inside this workspace\'s ignored work/ directory')
    output.mkdir(parents=True, exist_ok=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(args.input), '-ac', '1', '-ar', '8000',
                    '-f', 'f32le', str(output / 'mono.f32')], check=True)
    audio = np.memmap(output / 'mono.f32', dtype='<f4', mode='r')
    f, times, power = signal.spectrogram(audio, fs=8000, nperseg=4096, noverlap=3584, scaling='spectrum')
    keep = f <= 1200
    f, power = f[keep], power[keep]
    db = 10 * np.log10(np.maximum(power, 1e-12))
    prominence = db - ndimage.median_filter(db, size=(21, 1))
    speech = np.zeros(len(times), dtype=bool)
    if args.speech:
        for line in args.speech.read_text(encoding='utf-8').splitlines():
            segment = json.loads(line)
            if segment['end'] - segment['start'] < 25:
                speech |= (times >= segment['start']) & (times <= segment['end'])
    rows = json.loads(args.events.read_text(encoding='utf-8'))
    results = []
    for row in rows:
        if row['recording'] != args.recording:
            continue
        result = measure(f, times, power, prominence, speech, row, len(audio) / 8000)
        if result is not None:
            results.append(result)
            print(json.dumps(result, ensure_ascii=False), flush=True)
    (output / 'stops.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
