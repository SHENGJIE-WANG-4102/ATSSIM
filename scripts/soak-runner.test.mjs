import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { selectCases, runSoak } from './soak-runner.mjs';

test('quick covers both days, all templates, two seeds and levels 0/3; full covers 240', () => {
  const quick = selectCases(2, [0, 3]); assert.equal(quick.length, 24);
  assert.equal(new Set(quick.map(c => JSON.stringify(c))).size, 24);
  assert.equal(selectCases(10, [0, 1, 2, 3]).length, 240);
  assert.throws(() => selectCases(2, [0, 3], '^nothing$'), /No soak cases/);
});

const worker = `
import {writeFileSync,appendFileSync} from 'node:fs';
const c=JSON.parse(process.argv[1]);const mode=process.argv[2];
const stem=process.env.SOAK_OUT+'/'+c.dayType+'-'+c.template+'-'+c.level+'-'+c.seed;
writeFileSync(stem+'-checkpoint.json',JSON.stringify({version:2,until:14400,state:{t:14400}}));
appendFileSync(process.env.SOAK_OUT+'/activity', 'start '+c.seed+'\\n');
setTimeout(()=>{
 if(mode==='hang')return;
 appendFileSync(process.env.SOAK_OUT+'/activity', 'end '+c.seed+'\\n');
 if(mode==='crash')process.exit(7);
 const result={...c,model:process.env.SOAK_MODEL_HASH,ok:mode!=='failure',failure:mode==='failure'?'test violation':'',until:99000,completed:1,planned:1,integrity:{}};
 writeFileSync(stem+'.json',JSON.stringify(result));
 if(mode==='failure')writeFileSync(stem+'-diagnostics.json',JSON.stringify({version:2,until:15000,state:{t:15000}}));
},150);
if(mode==='hang')setInterval(()=>{},1000);
`;
const run = async (modes, options = {}, check = () => {}) => {
  const output = mkdtempSync(join(tmpdir(), 'ats-soak-runner-'));
  const cases = modes.map((_m, i) => ({ dayType:'weekday',template:'base',level:3,seed:i+1 }));
  try {
    const summary = await runSoak({cases,output,model:'fixed',hashCurrent:()=> 'fixed',workers:2,
      timeoutMs:10000,progress:false,log:()=>{},
      command:c=>[process.execPath,['--input-type=module','-e',worker,JSON.stringify(c),modes[c.seed-1]]], ...options});
    await check(summary,output); return summary;
  } finally { rmSync(output,{recursive:true,force:true}); }
};

test('runs cases concurrently and keeps going after invariant and process failures', async () => {
  await run(['failure','crash','ok'],{},(s,out)=>{
    assert.equal(s.completed,3);assert.equal(s.complete,true);assert.equal(s.failed,true);
    assert.equal(s.results.filter(r=>r.ok).length,1);
    const activity=readFileSync(out+'/activity','utf8').trim().split('\n');
    assert(activity[0].startsWith('start '));assert(activity[1].startsWith('start '));
    for(const r of s.results.filter(r=>!r.ok)){
      assert(existsSync(r.diagnostics));assert(existsSync(r.diagnostics.replace('-diagnostics','-failure')));
      assert.equal(JSON.parse(readFileSync(r.diagnostics,'utf8')).version,2);
      const manifest=JSON.parse(readFileSync(r.diagnostics.replace('-diagnostics','-failure'),'utf8'));
      assert(existsSync(manifest.checkpoint));
    }
    assert.equal(JSON.parse(readFileSync(out+'/summary.json','utf8')).completed,3);
    assert.equal(existsSync(out+'/.running'),false);
  });
});
test('times out a hung worker and preserves its replay checkpoint', async () => {
  await run(['hang'],{timeoutMs:1000},(s,out)=>{
    assert.equal(s.failed,true);assert.match(s.results[0].failure,/timeout/);
    assert.equal(JSON.parse(readFileSync(s.results[0].diagnostics,'utf8')).until,14400);
    assert.equal(JSON.parse(readFileSync(out+'/weekday-base-3-1-failure.json','utf8')).timedOut,true);
    assert(existsSync(out+'/weekday-base-3-1-checkpoint.json'));
  });
});
test('source changes invalidate a passed case and save diagnostics', async () => {
  await run(['ok'],{hashCurrent:()=> 'changed'},s=>{
    assert.equal(s.failed,true);assert.match(s.results[0].failure,/Model changed/);assert(existsSync(s.results[0].diagnostics));
  });
});
test('a worker that cannot start still gets a failure bundle', async () => {
  await run(['ok'],{command:()=>['/nonexistent/soak-worker',[]]},s=>{
    assert.equal(s.failed,true);
    assert.equal(JSON.parse(readFileSync(s.results[0].diagnostics,'utf8')).stateUnavailable,true);
  });
});

test('resume reuses only complete passing cases for the current model', async () => {
  const output = mkdtempSync(join(tmpdir(), 'ats-soak-resume-'));
  const cases = [1,2,3].map(seed => ({dayType:'weekday',template:'base',level:3,seed}));
  try {
    for (const c of cases) writeFileSync(`${output}/weekday-base-3-${c.seed}.json`,JSON.stringify({
      ...c,model:'fixed',ok:true,until:c.seed===2?18000:99000,completed:1,planned:1,
      integrity:c.seed===3?{OVERLAP:1}:{},failure:''}));
    const summary=await runSoak({cases,output,model:'fixed',hashCurrent:()=> 'fixed',workers:2,
      timeoutMs:10000,resume:true,progress:false,log:()=>{},
      command:c=>[process.execPath,['--input-type=module','-e',worker,JSON.stringify(c),'ok']]});
    assert.equal(summary.failed,false);assert.equal(summary.completed,3);
    assert.deepEqual(summary.results.filter(r=>r.cached).map(r=>r.seed),[1]);
    const activity=readFileSync(output+'/activity','utf8');
    assert(!activity.includes('start 1'));assert(activity.includes('start 2'));assert(activity.includes('start 3'));
  } finally {rmSync(output,{recursive:true,force:true});}
});

test('SIGTERM stops scheduling and saves a failure bundle for each active worker', async () => {
  const output = mkdtempSync(join(tmpdir(), 'ats-soak-interrupt-'));
  const cases = [1,2,3].map(seed => ({dayType:'weekday',template:'base',level:3,seed}));
  // Signal an actual runner process, not node:test's own harness. The latter
  // installs SIGTERM handlers too and can discard individual test results.
  const program = `import {runSoak} from ${JSON.stringify(new URL('./soak-runner.mjs', import.meta.url).href)};
    import {writeSync} from 'node:fs';
    const summary=await runSoak({cases:${JSON.stringify(cases)},output:${JSON.stringify(output)},
      model:'fixed',hashCurrent:()=> 'fixed',workers:2,timeoutMs:10000,progress:false,log:line=>writeSync(1,line+'\\n'),
      command:c=>[process.execPath,['--input-type=module','-e',${JSON.stringify(worker)},JSON.stringify(c),'hang']]});
    writeSync(1,'RESULT '+JSON.stringify(summary)+'\\n');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program]);
  let stdout = '', stderr = '', interrupt;
  child.stdout.on('data', data => {
    stdout += data;
    if (!interrupt && stdout.includes('Soak:')) interrupt = setTimeout(() => child.kill('SIGTERM'), 500);
  });
  child.stderr.on('data', data => { stderr += data; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
  try {
    const code = await new Promise((resolve,reject) => { child.once('error',reject); child.once('close',resolve); });
    assert.equal(code,0,JSON.stringify({stderr,stdout}));
    const s = JSON.parse(stdout.split('\n').find(line => line.startsWith('RESULT ')).slice(7));
    assert.equal(s.complete,false);assert.equal(s.failed,true);assert.equal(s.completed,2);
    for(const result of s.results){assert.equal(result.ok,false);assert(existsSync(result.diagnostics));}
    assert.equal(existsSync(output+'/.running'),false);
  } finally {clearTimeout(interrupt);clearTimeout(timeout);child.kill('SIGKILL');rmSync(output,{recursive:true,force:true});}
});
