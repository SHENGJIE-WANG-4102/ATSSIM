#!/usr/bin/env python3
"""Verify D71 source gains, before/after levels and door separation locally.

Before-directory contains copies of the ten prior MP3s and before.json with
their original source ranges. All audio, hashes and numeric output stay in work/.
"""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import sys

import numpy as np

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('audio_render', pathlib.Path(__file__).with_name('render-soundbank.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before', type=pathlib.Path, default=pathlib.Path('work/recordings/analysis/platform-recut'))
    args = parser.parse_args()
    root = pathlib.Path(__file__).resolve().parents[2]
    before = args.before.resolve()
    if not before.is_relative_to(root / 'work'):
        raise ValueError('Evidence must remain under ignored work/')
    manifest = json.loads((root / 'work/recordings/analysis/render-manifest.json').read_text(encoding='utf-8'))
    levels = json.loads((root / 'work/recordings/analysis/render/loudness.json').read_text(encoding='utf-8'))
    old = {c['id']: c for c in json.loads((before / 'before.json').read_text(encoding='utf-8'))}
    sources = {s['id']: pathlib.Path(manifest['sourceRoot']) / s['filename'] for s in manifest['sources']}
    output = pathlib.Path(manifest['out'])

    def decode(path, bounds=None):
        command = ['ffmpeg', '-v', 'error']
        if bounds:
            command += ['-ss', str(bounds[0]), '-t', str(bounds[1] - bounds[0])]
        return np.frombuffer(r.run(command + ['-i', str(path), '-ac', '1', '-ar', str(r.RATE), '-f', 'f32le', '-']).stdout, dtype='<f4')

    platform = []
    for clip in manifest['clips']:
        if clip['id'] not in old:
            continue
        original = decode(before / clip['file'])
        current = decode(output / clip['file'])
        row = {'id': clip['id'], 'source': clip['source'], 'range': clip['range'],
               'beforeLUFS': float(r.measure(original, repeat_short=False)['input_i']),
               'afterLUFS': float(r.measure(current, repeat_short=False)['input_i']),
               'voiceBeforeShortLUFS': None, 'voiceAfterShortLUFS': None}
        if clip.get('voiceRange'):
            def voice(a, start):
                lo, hi = [round((t - start) * r.RATE) for t in clip['voiceRange']]
                return r.short_loudness(a[max(0, lo):hi])
            row['voiceBeforeShortLUFS'] = voice(original, old[clip['id']]['range'][0])
            row['voiceAfterShortLUFS'] = voice(current, clip['range'][0])
        platform.append(row)
    for source in ['platform-01', 'platform-03']:
        voice = [c['voiceAfterShortLUFS'] for c in platform if c['source'] == source and c['voiceAfterShortLUFS'] is not None]
        if max(voice) - min(voice) > 1.5:
            raise ValueError(f'Voice short-term spread >1.5 LU: {source} {voice}')
        gains = [c['sourceGainDB'] for c in levels['measurements'] if c['id'] in {p['id'] for p in platform if p['source'] == source}]
        if len(set(gains)) != 1:
            raise ValueError(f'Per-clip gain changed: {source}')

    doors = []
    for clip in manifest['clips']:
        if not clip['kind'].startswith('door-'):
            continue
        current = decode(output / clip['file'])
        row = {'id': clip['id'], 'range': clip['range'], 'durationS': len(current) / r.RATE,
               'confidence': clip['confidence'], 'loudnessLUFS': float(r.measure(current, repeat_short=False)['input_i'])}
        if clip['kind'] == 'door-motion-close':
            raw = decode(sources[clip['source']], clip['range'])
            def band_energy(a):
                freq = np.fft.rfftfreq(len(a), 1 / r.RATE)
                power = np.abs(np.fft.rfft(a)) ** 2
                return np.sum(power[(freq >= 2600) & (freq <= 3000)]) / len(a) ** 2
            row['warningBandReductionDB'] = float(10 * np.log10(band_energy(raw) / band_energy(current)))
            if row['warningBandReductionDB'] < 15:
                raise ValueError(f'Closing warning still prominent in motion: {row}')
        doors.append(row)
    hashes = json.loads((before / 'untouched-audio.json').read_text(encoding='utf-8'))
    changed = [name for name, digest in hashes.items() if hashlib.sha256((output / name).read_bytes()).hexdigest() != digest]
    if changed:
        raise ValueError(f'Unrelated audio changed: {changed}')
    report = {'platform': platform, 'sourceGains': levels['sourceGains'], 'doors': doors, 'unchangedOtherAudioFiles': len(hashes)}
    (before / 'final-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('| clip | I before / after | voice S before / after |')
    for c in platform:
        print(f'| {c["id"]} | {c["beforeLUFS"]:.2f} / {c["afterLUFS"]:.2f} | {c["voiceBeforeShortLUFS"]} / {c["voiceAfterShortLUFS"]} |')
    print(f'{len(doors)} doors verified; {len(hashes)} other audio files unchanged; source voice spread <=1.5 LU.')
    for c in doors:
        if 'warningBandReductionDB' in c:
            print(f'{c["id"]}: warning band reduced {c["warningBandReductionDB"]:.1f} dB')


if __name__ == '__main__':
    main()
