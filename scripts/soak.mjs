import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { selectCases, runSoak } from './soak-runner.mjs';
const quick = process.argv.includes('--quick');
const positive = (name, fallback) => {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
};
const seeds = quick ? 2 : positive('SOAK_SEEDS', 10);
const workers = positive('SOAK_WORKERS', Math.min(4, Math.max(2, availableParallelism() - 1)));
const output = process.env.SOAK_OUT ?? (quick ? 'tests/out/soak-quick' : 'tests/out/soak');
const filter = process.env.SOAK_FILTER;
function modelHash() {
  const hash = createHash('sha256');
  for (const dir of ['src/sim', 'src/data']) for (const file of readdirSync(dir).filter(f => f.endsWith('.ts')).sort())
    hash.update(`${dir}/${file}\n`).update(readFileSync(`${dir}/${file}`));
  hash.update(readFileSync('scripts/soak-case.ts'));
  return hash.digest('hex');
}
const summary = await runSoak({ cases: selectCases(seeds, quick ? [0, 3] : [0, 1, 2, 3], filter),
  output, model: modelHash(), hashCurrent: modelHash, workers,
  timeoutMs: positive('SOAK_TIMEOUT_MS', 60 * 60 * 1000), resume: process.env.SOAK_RESUME === '1',
  failFast: process.env.SOAK_FAIL_FAST === '1', progress: process.env.SOAK_PROGRESS !== '0',
  certify: !quick && seeds >= 10 && !filter });
console.log(`Soak${quick ? ' quick' : ''}: ${summary.completed}/${summary.requested} cases; ${summary.certified ? 'full matrix passed' : summary.failed ? 'FAILED' : 'subset passed (not full certification)'}`);
if (summary.failed || !summary.complete) process.exitCode = 1;
