/** Local placeholders, never overwrite actual recordings without --force.
 * node scripts/mock-soundbank.mjs [--force]
 * Requires ffmpeg and the repository's existing TypeScript dependency.
 * Reads the real bank so filenames, durations and anchors stay identical.
 */
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import Module, { createRequire } from 'node:module';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
// Tool-only loader for the numeric catalogue and its relative TS data imports.
const require = createRequire(import.meta.url), oldLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  if (!filename.startsWith(join(root, 'src', 'data') + '/'.replace('/', process.platform === 'win32' ? '\\' : '/'))) throw new Error('Catalogue imports must remain under src/data');
  module._compile(ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
};
let bank;
try { bank = { ...require(join(root, 'src/data/soundbank.ts')), fixed: require(join(root, 'src/data/onboardbank.ts')).VOICE_PARTS.filter(p => p.file) }; }
finally { if (oldLoader) Module._extensions['.ts'] = oldLoader; else delete Module._extensions['.ts']; }
const { SOUND_BANK, SOUNDBANK_DIRECTORY, clipDuration } = bank;
const out = join(root, 'public', SOUNDBANK_DIRECTORY);
mkdirSync(out, { recursive: true });
execFileSync('git', ['check-ignore', out], { cwd: root, stdio: 'pipe' });
let count = 0;
const clips = [...SOUND_BANK, ...bank.fixed.map(p => ({ ...p, kind: 'interior-suffix' }))];
for (const [index, clip] of clips.entries()) {
  if (!/^[a-z0-9-]+\.mp3$/.test(clip.file)) throw new Error(`Unsafe filename: ${clip.file}`);
  const path = join(out, clip.file);
  if (existsSync(path) && !process.argv.includes('--force')) continue;
  const duration = clipDuration(clip), anchor = clip.stopAt ?? clip.startAt ?? 0;
  const volume = clip.kind === 'ambience' ? '0.01' : `if(between(t,${anchor},${Math.min(duration, anchor + .16)}),0.18,0.01)`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${330 + index * 37}:sample_rate=48000:duration=${duration}`,
    '-af', `volume='${volume}':eval=frame`, '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '112k', path], { stdio: 'pipe' });
  count++;
}
console.log(`Generated ${count} placeholders in ${out}; existing recordings preserved unless --force.`);
