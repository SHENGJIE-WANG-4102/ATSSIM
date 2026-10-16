#!/usr/bin/env python3
"""Find closing-warning candidates, never door-leaf motion or speech events.

Input: 8 kHz mono float32 from inspect-recording.py. Output stays in work/.
Dependencies: numpy, scipy. No recording is uploaded.
【假设】2750/2843 Hz centres, +/-30 Hz tolerance, >5 dB contrast, -48 dB
floor, >=8 frames and <=1 s pulse gaps. Tolerance was widened from 9 Hz
after the 2026-10-16 cabin video showed 2736 and 2867 Hz peaks. Absolute level must
be reviewed per microphone; no fixed warning-to-door delay is inferred.
--centres-hz and --background-hz can supply reviewed source-specific bands
without changing the default or the 10-14 measurements.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from scipy import signal


def detect_tones(audio, radius_hz=30, centres_hz=(2750, 2843), background_hz=(2600, 3000)):
    frequencies, times, power = signal.spectrogram(
        audio, fs=8000, nperseg=2048, noverlap=1536, scaling='spectrum')
    line = np.zeros(len(frequencies), dtype=bool)
    for centre in centres_hz:
        line |= abs(frequencies - centre) < radius_hz
    background = (frequencies >= background_hz[0]) & (frequencies <= background_hz[1]) & ~line
    if not line.any() or not background.any():
        raise ValueError('Tone and background bands must both contain frequency bins')
    tone_power = power[line].sum(axis=0)
    contrast = 10 * np.log10(np.maximum(tone_power, 1e-12) /
                             np.maximum(power[background].sum(axis=0), 1e-12))
    level = 10 * np.log10(np.maximum(tone_power, 1e-12))
    spans = []
    for index in np.flatnonzero((contrast > 5) & (level > -48)):
        if not spans or times[index] - times[spans[-1][-1]] > 1:
            spans.append([int(index)])
        else:
            spans[-1].append(int(index))
    # The spans join warning pulses. End is the last detected STFT centre,
    # not the exact physical end of the tone or the time the doors latch.
    # Boundary flags only describe threshold-active STFT frames touching an
    # edge. False cannot prove the full warning was captured (weak pulses
    # may precede the first threshold crossing).
    return [dict(start=round(float(times[s[0]]), 3),
                 end=round(float(times[s[-1]]), 3), frames=len(s),
                 kind='closing-warning-candidate',
                 leftCensored=s[0] == 0, rightCensored=s[-1] == len(times) - 1,
                 medianContrastDb=round(float(np.median(contrast[s])), 2))
            for s in spans if len(s) >= 8]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path, help='8 kHz mono .f32')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--radius-hz', type=float, default=30)
    parser.add_argument('--centres-hz', type=float, nargs='+', default=[2750, 2843],
                        help='Source-specific peaks; defaults preserve the cabin calibration')
    parser.add_argument('--background-hz', type=float, nargs=2, default=[2600, 3000])
    args = parser.parse_args()
    if not args.out.resolve().is_relative_to(Path(__file__).resolve().parents[2] / 'work'):
        parser.error('Output must be inside this workspace\'s ignored work/ directory')
    if not 0 < args.radius_hz <= 100:
        parser.error('Frequency tolerance must be >0 and <=100 Hz')
    if any(not 0 < hz < 4000 for hz in args.centres_hz):
        parser.error('Tone centres must be between 0 and 4000 Hz')
    if not 0 <= args.background_hz[0] < args.background_hz[1] <= 4000:
        parser.error('Background must be an ascending band within 0..4000 Hz')
    audio = np.fromfile(args.input, dtype='<f4')
    if len(audio) < 2048:
        parser.error('At least 256 ms of audio is required')
    try:
        results = detect_tones(audio, args.radius_hz, args.centres_hz, args.background_hz)
    except ValueError as error:
        parser.error(str(error))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(results, ensure_ascii=False))


if __name__ == '__main__':
    main()
