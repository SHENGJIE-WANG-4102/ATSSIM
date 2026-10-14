#!/usr/bin/env python3
"""Generate local speech hints to locate announcements, never event truth.

Dependencies: faster-whisper (and its dependencies), numpy, scipy.
Supply an already downloaded recognizer directory with --recognizer.
Passenger speech may be included: all output is restricted to ignored work/.
No recording is uploaded; inference runs locally on the CPU.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel
from scipy.signal import resample_poly


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="8 kHz mono float32 from inspect-recording.py")
    parser.add_argument("--recognizer", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--from-seconds", type=int, default=0)
    parser.add_argument("--to-seconds", type=int)
    args = parser.parse_args()
    workspace = Path(__file__).resolve().parents[2]
    output = args.out.resolve()
    if not output.is_relative_to(workspace / "work"):
        parser.error("Output must be inside this workspace's ignored work/ directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    engine = WhisperModel(str(args.recognizer), device="cpu", compute_type="int8", cpu_threads=8, local_files_only=True)
    audio = resample_poly(np.fromfile(args.input, dtype="<f4"), 2, 1)
    with output.open("w", encoding="utf-8") as stream:
        end = args.to_seconds if args.to_seconds is not None else int(len(audio) / 16000) + 1
        # Fixed chunks bound timestamp drift; hints still require acoustic review.
        for offset in range(args.from_seconds, end, 30):
            chunk = audio[offset * 16000:min(offset + 30, end) * 16000]
            if not len(chunk):
                continue
            segments, _ = engine.transcribe(chunk, language="zh", beam_size=3, vad_filter=True,
                                            condition_on_previous_text=False, word_timestamps=True)
            for segment in segments:
                row = {"start": offset + segment.start, "end": offset + segment.end, "text": segment.text,
                       "logprob": segment.avg_logprob, "noSpeech": segment.no_speech_prob,
                       "words": [{"start": offset + word.start, "end": offset + word.end, "text": word.word,
                                  "probability": word.probability} for word in (segment.words or [])]}
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
                stream.flush()
            print(f"Reviewed speech window {offset}..{offset + len(chunk) / 16000:.1f}", flush=True)


if __name__ == "__main__":
    main()
