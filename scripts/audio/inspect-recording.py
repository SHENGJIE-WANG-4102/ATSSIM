#!/usr/bin/env python3
"""Prepare local-only acoustic evidence, without interpreting train events.

Dependencies: Python 3, numpy, scipy, Pillow; ffmpeg and ffprobe on PATH.
Example: python scripts/audio/inspect-recording.py INPUT.wav --out work/recordings/analysis/ride
Outputs must stay under work/: images can contain passenger speech patterns,
and recognition output (if produced separately) must never enter the repository.
Band levels and spectrograms identify review windows, not verified stop times.
"""
import argparse
import csv
import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import signal


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--page-seconds", type=int, default=180)
    parser.add_argument("--from-seconds", type=int, default=0)
    parser.add_argument("--to-seconds", type=int)
    parser.add_argument("--max-hz", type=int, default=2000)
    parser.add_argument("--min-db", type=float, default=-85)
    parser.add_argument("--max-db", type=float, default=-20)
    args = parser.parse_args()
    workspace = Path(__file__).resolve().parents[2]
    output = args.out.resolve()
    if not output.is_relative_to(workspace / "work"):
        parser.error("Output must be inside this workspace's ignored work/ directory")
    output.mkdir(parents=True, exist_ok=True)
    metadata = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration:format_tags:stream=codec_name,sample_rate,channels,bits_per_sample",
        "-of", "json", str(args.input),
    ], encoding="utf-8"))
    (output / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    subprocess.run([
        "ffmpeg", "-v", "error", "-y", "-i", str(args.input),
        "-ac", "1", "-ar", "8000", "-f", "f32le", str(output / "mono.f32"),
    ], check=True)
    audio = np.memmap(output / "mono.f32", dtype="<f4", mode="r")
    frequencies, times, spectrum = signal.spectrogram(
        audio, fs=8000, nperseg=2048, noverlap=1536, scaling="spectrum",
    )
    bands = [(20, 100), (100, 300), (300, 1000), (1000, 3000)]
    levels = [10 * np.log10(np.maximum(spectrum[(frequencies >= lo) & (frequencies < hi)].sum(axis=0), 1e-12))
              for lo, hi in bands]
    with (output / "bands.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(["seconds"] + [f"db_{lo}_{hi}" for lo, hi in bands])
        for second in range(int(len(audio) / 8000)):
            mask = (times >= second) & (times < second + 1)
            writer.writerow([second] + [round(float(np.median(level[mask])), 2) for level in levels])
    # Show low-frequency rolling noise and traction harmonics with one fixed scale.
    bins = (frequencies >= 20) & (frequencies <= args.max_hz)
    log_power = 10 * np.log10(np.maximum(spectrum[bins], 1e-12))
    width, height = 1800, 540
    end = args.to_seconds if args.to_seconds is not None else int(len(audio) / 8000) + 1
    for start in range(args.from_seconds, end, args.page_seconds):
        mask = (times >= start) & (times < start + args.page_seconds)
        if not mask.any():
            continue
        pixels = np.uint8(np.clip((log_power[:, mask][::-1] - args.min_db) / (args.max_db - args.min_db), 0, 1) * 255)
        # A partial final page must retain the same seconds-per-pixel scale.
        used_width = min(width, round(width * mask.sum() * (512 / 8000) / args.page_seconds))
        panel = Image.fromarray(pixels).resize((max(1, used_width), height))
        page = Image.new("RGB", (width + 80, height + 100), "white")
        page.paste(panel, (60, 30))
        draw = ImageDraw.Draw(page)
        draw.text((60, 5), f"Recording seconds {start} - {start + args.page_seconds}; 20-{args.max_hz} Hz; fixed {args.min_db}..{args.max_db} dB", fill="black")
        for offset in range(0, args.page_seconds + 1, 10):
            x = 60 + int(width * offset / args.page_seconds)
            draw.line((x, height + 30, x, height + 40), fill="black")
            draw.text((x - 10, height + 44), str(start + offset), fill="black")
        for hz in [100, 300, 500, 1000, 1500, 2000, 3000, 4000]:
            if hz > args.max_hz:
                continue
            y = 30 + height - int((hz - 20) / (args.max_hz - 20) * height)
            draw.text((3, y), str(hz), fill="black")
        page.save(output / f"spectrum-{start:04d}.png")
    print(json.dumps({"input": args.input.name, "duration": metadata["format"]["duration"], "output": str(output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
