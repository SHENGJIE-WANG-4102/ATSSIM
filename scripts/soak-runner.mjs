import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, renameSync, copyFileSync, openSync, closeSync } from 'node:fs';

export function selectCases(seeds, levels, filter) {
  const cases = []; const pattern = filter && new RegExp(filter);
  for (let seed = 1; seed <= seeds; seed++) for (const dayType of ['weekday', 'weekend'])
    for (const template of ['base', 'ciie', 'hongqiao']) for (const level of levels) {
      const c = { dayType, template, level, seed };
      if (!pattern || pattern.test(caseName(c))) cases.push(c);
    }
  if (!cases.length) throw new Error('No soak cases selected');
  return cases;
}
const caseName = c => `${c.dayType}-${c.template}-${c.level}-${c.seed}`;
const atomicJSON = (path, value) => {
  const pending = `${path}.tmp`;
  writeFileSync(pending, JSON.stringify(value, null, 2)); renameSync(pending, path);
};

export async function runSoak({ cases, output, model, hashCurrent, workers, timeoutMs, resume = false,
  failFast = false, progress = true, certify = false,
  command = c => [process.execPath, ['node_modules/vite-node/vite-node.mjs', 'scripts/soak-case.ts', JSON.stringify(c)]],
  log = console.log }) {
  mkdirSync(output, { recursive: true });
  // Avoid two unattended runs overwriting each other's artifacts.
  const lock = `${output}/.running`;
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error(`Invalid soak lock: ${lock}`);
    try { process.kill(pid, 0); throw new Error(`Soak already running (PID ${pid}): ${output}`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; unlinkSync(lock); }
  }
  const fd = openSync(lock, 'wx'); closeSync(fd); writeFileSync(lock, String(process.pid));
  const results = []; const children = new Set(); let failed = false; let cursor = 0; let interrupted = false;
  const stop = () => { interrupted = true; for (const child of children) child.kill('SIGKILL'); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const summary = () => ({ model, workers, certified: certify && results.length === cases.length && !failed,
    complete: results.length === cases.length, requested: cases.length, completed: results.length, failed, results });
  const save = () => atomicJSON(`${output}/summary.json`, summary());
  const record = result => {
    const compact = { ...result, lateTrips: result.lateTrips?.length, cancelledTrips: result.cancelledTrips?.length, undelivered: result.undelivered?.length };
    log(JSON.stringify(compact)); results.push(compact); failed ||= !result.ok; save();
  };
  const run = c => new Promise(resolve => {
    const stem = `${output}/${caseName(c)}`; const resultPath = `${stem}.json`;
    if (resume && existsSync(resultPath)) {
      try {
        const saved = JSON.parse(readFileSync(resultPath, 'utf8'));
        if (saved.ok === true && saved.model === model && hashCurrent() === model
          && Object.keys(c).every(key => saved[key] === c[key]) && saved.until >= 27.5 * 3600 - 1e-6
          && saved.completed === saved.planned && saved.integrity && Object.values(saved.integrity).every(n => n === 0)) {
          record({ ...saved, cached: true }); resolve(); return;
        }
      } catch { /* Partial/different-version result: rerun. */ }
    }
    for (const suffix of ['.json', '-diagnostics.json', '-checkpoint.json', '-failure.json'])
      if (existsSync(`${stem}${suffix}`)) unlinkSync(`${stem}${suffix}`);
    const [exe, args] = command(c);
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SOAK_OUT: output, SOAK_MODEL_HASH: model } });
    children.add(child);
    let out = '', err = '', processError = '', timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => { out = (out + chunk).slice(-2_000_000); });
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-100_000); if (progress) process.stderr.write(chunk); });
    child.on('error', error => { processError = error.message; });
    child.on('close', (code, signal) => {
      children.delete(child);
      clearTimeout(timeout);
      let result;
      try { result = JSON.parse(readFileSync(resultPath, 'utf8')); }
      catch { try { result = JSON.parse(out.trim().split('\n').at(-1)); } catch { /* process failure below */ } }
      if (!result || typeof result.ok !== 'boolean') result = { ...c, model, ok: false,
        failure: processError || (timedOut ? `Worker timeout after ${timeoutMs} ms` : `Worker exited ${code ?? signal}: ${err || out}`) };
      if (code || signal) { result.ok = false; result.failure ||= `Worker exited ${code ?? signal}`; }
      if (hashCurrent() !== model || result.model !== model) {
        result.ok = false; result.failure = 'Model changed during soak; rerun against a single immutable version';
      }
      if (!result.ok) {
        const diagnostics = `${stem}-diagnostics.json`;
        if (!existsSync(diagnostics)) {
          if (existsSync(`${stem}-checkpoint.json`)) copyFileSync(`${stem}-checkpoint.json`, diagnostics);
          else atomicJSON(diagnostics, { kind: 'soak-worker-failure', model, case: c,
            failure: result.failure, stateUnavailable: true, stdout: out, stderr: err, exitCode: code, signal });
        }
        result.diagnostics = diagnostics;
        const checkpoint = existsSync(`${stem}-checkpoint.json`) ? `${stem}-checkpoint.json` : undefined;
        atomicJSON(`${stem}-failure.json`, { model, case: c, failure: result.failure,
          diagnostics, checkpoint, exitCode: code, signal, timedOut, stderr: err });
      }
      atomicJSON(resultPath, result);
      if (result.ok && existsSync(`${stem}-checkpoint.json`)) unlinkSync(`${stem}-checkpoint.json`);
      record(result); resolve();
    });
  });
  try {
    save();
    log(`Soak: ${cases.length} cases, ${workers} workers; ${failFast ? 'fail fast' : 'collect every failure'}; ${output}`);
    await Promise.all(Array.from({ length: Math.min(workers, cases.length) }, async () => {
      while (cursor < cases.length && !interrupted && (!failed || !failFast)) await run(cases[cursor++]);
    }));
    save(); return summary();
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    for (const child of children) child.kill('SIGKILL');
    unlinkSync(lock);
  }
}
