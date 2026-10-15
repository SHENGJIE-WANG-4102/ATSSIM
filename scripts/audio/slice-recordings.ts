/** Reproducible mono MP3 slices; ffmpeg/ffprobe on PATH, no runtime dependency.
 * npx --no-install vite-node scripts/audio/slice-recordings.ts work/recordings
 * The source directory can change; edit SOUND_BANK to change cut boundaries.
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SOUND_BANK, SOUNDBANK_DIRECTORY, SOURCE_GAIN_REFERENCES } from '../../src/data/soundbank';
import { VOICE_PARTS, VOICE_CROSSFADE_S, VOICE_SOURCES } from '../../src/data/onboardbank';
import { RECORDING_SOURCES } from '../../src/data/ridelog';

const sourceRoot = resolve(process.argv[2] ?? 'work/recordings');
const out = resolve('public', SOUNDBANK_DIRECTORY);
mkdirSync(out, { recursive: true });
execFileSync('git', ['check-ignore', out], { stdio: 'pipe' });
// Validate all sources before writing any clips.
for (const source of [...RECORDING_SOURCES, ...VOICE_SOURCES]) {
  const path = join(sourceRoot, source.filename);
  if (!existsSync(path)) throw new Error(`Missing source: ${path}`);
}
const analysis = resolve('work/recordings/analysis');
mkdirSync(analysis, { recursive: true });
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt < 0 ? undefined : process.argv[onlyAt + 1].split(',');
const manifest = join(analysis, 'render-manifest.json');
writeFileSync(manifest, JSON.stringify({ sourceRoot, out, only, clips: SOUND_BANK, parts: VOICE_PARTS, gainReferences: SOURCE_GAIN_REFERENCES, sources: [...RECORDING_SOURCES, ...VOICE_SOURCES], crossfadeS: VOICE_CROSSFADE_S }));
execFileSync(process.env.AUDIO_PYTHON ?? 'python', ['scripts/audio/render-soundbank.py', manifest], { stdio: 'inherit' });
console.log(`Rendered and verified ${only?.length ?? SOUND_BANK.length} local mono MP3 clips in ${out}`);
