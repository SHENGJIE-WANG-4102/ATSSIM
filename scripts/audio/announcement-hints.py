#!/usr/bin/env python3
"""Exhaustively locate onboard next/arrival announcements, local-only.
Dependencies: numpy, scipy, faster-whisper; recognizer must already be local.
Events JSON: ridelog-report.ts --measurement-input. Word timing is a hint,
not proof of identity; uncertain words require confidence labels in metadata.
All recognition output, which can include passengers, stays in ignored work/.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from scipy.signal import butter, sosfilt, resample_poly
from faster_whisper import WhisperModel


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--events', type=Path, required=True)
    parser.add_argument('--analysis', type=Path, default=Path('work/recordings/analysis'))
    parser.add_argument('--recognizer', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    workspace = Path(__file__).resolve().parents[2]
    if not args.out.resolve().is_relative_to(workspace / 'work'):
        parser.error('Recognition output must be under ignored work/')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    events = json.loads(args.events.read_text(encoding='utf-8-sig'))
    engine = WhisperModel(str(args.recognizer), device='cpu', compute_type='int8', cpu_threads=8, local_files_only=True)
    filtered = {}
    for recording, folder in [('ride-east', 'east'), ('ride-west', 'west')]:
        audio = np.fromfile(args.analysis / folder / 'mono.f32', dtype='<f4')
        filtered[recording] = resample_poly(sosfilt(butter(3, [250, 3500], fs=8000, btype='bandpass', output='sos'), audio), 2, 1).astype('float32')
    with args.out.open('w', encoding='utf-8') as stream:
        for recording in filtered:
            rows = [r for r in events if r['recording'] == recording]
            for index, row in enumerate(rows[1:], 1):
                prev = rows[index - 1]
                for kind in ['next', 'arrived']:
                    if kind == 'next':
                        # The western file starts powered; do not invent a start timestamp.
                        start = prev['start'] if prev['start'] is not None else 0
                        lo, hi = start + 3, min(start + 30, len(filtered[recording]) / 16000)
                    elif row['stop'] is not None:
                        lo, hi = max(0, row['stop'] - 80), min(row['stop'] + 2, len(filtered[recording]) / 16000)
                    else:
                        continue
                    # Fixed short windows avoid long-file timing drift. Chinese station
                    # names are contextual spelling hints, never timing or label truth.
                    for offset in np.arange(lo, hi, 24):
                        end = min(hi, offset + 24)
                        chunk = filtered[recording][int(offset * 16000):int(end * 16000)]
                        segments, _ = engine.transcribe(chunk, language='zh', beam_size=5, vad_filter=False,
                                                        condition_on_previous_text=False, word_timestamps=True)
                        result = dict(recording=recording, station=row['station'], direction=row['direction'],
                                      kind=kind, window=[float(offset), float(end)],
                                      segments=[dict(start=float(offset + s.start), end=float(offset + s.end), text=s.text,
                                                     noSpeech=s.no_speech_prob, logprob=s.avg_logprob,
                                                     words=[dict(start=float(offset + w.start), end=float(offset + w.end),
                                                                 text=w.word, probability=w.probability) for w in (s.words or [])]) for s in segments])
                        stream.write(json.dumps(result, ensure_ascii=False) + '\n'); stream.flush()
                    print(f"Located {recording} {row['station']} {kind} {lo:.2f}..{hi:.2f}", flush=True)


if __name__ == '__main__':
    main()
