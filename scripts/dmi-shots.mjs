// Screenshots of the cab DMI in the states the simulator supports.
// Usage (dev server running on :5173): node scripts/dmi-shots.mjs <outPrefix>
import { chromium } from 'playwright-core';
const out = process.argv[2] ?? 'dmi';
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 3840, height: 2160 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push('pageerror ' + e.message));
await page.goto('http://localhost:5173/?t=08:00');
await page.waitForFunction(() => window.__ats?.store?.snap, null, { timeout: 120000 });
await page.waitForTimeout(2000);
// close the first-visit help
await page.evaluate(() => document.querySelectorAll('.modal-back').forEach((e) => e.remove()));

const pred = {
  traction: 't.inService && t.phase === "run" && t.mode === "AM" && t.a > 0.3 && t.v > 3',
  coasting: 't.inService && t.phase === "run" && t.mode === "AM" && Math.abs(t.a) < 0.05 && t.v > 15',
  braking: 't.inService && t.phase === "run" && t.mode === "AM" && t.a < -0.3 && t.v > 10',
  approach: 't.inService && t.phase === "run" && t.mode === "AM" && t.stopDist > 60 && t.stopDist < 260 && t.v > 6 && t.tgtReason === "停车点"',
  dwell: 't.inService && t.phase === "dwell" && t.doors && t.dwellLeft > 15',
};

async function shoot(name, cond, settle = 1500) {
  const id = await page.waitForFunction((c) => {
    const s = window.__ats.store;
    const f = new Function('t', `return ${c}`);
    const t = s.snap.trains.find((x) => f(x));
    if (!t) return null;
    s.select({ kind: 'train', id: t.id });
    return t.id;
  }, cond, { timeout: 180000, polling: 200 }).then((h) => h.jsonValue());
  await page.waitForTimeout(settle);
  await page.locator('canvas.dmi').screenshot({ path: `${out}-${name}.png` });
  return id;
}

await page.evaluate(() => window.__ats.store.send({ type: 'speed', speed: 2 }));
for (const [k, c] of Object.entries(pred)) await shoot(k, c, k === 'approach' ? 600 : 1200);
// aligned after doors closed: departure countdown near its end
await shoot('departure', 't.inService && t.phase === "dwell" && !t.doors && t.dwellLeft > 1', 300);
// CM: take over a dwelling train
let id = await page.evaluate(() => window.__ats.store.selection.id);
await page.evaluate(async () => {
  const s = window.__ats.store;
  const t = s.snap.trains.find((x) => x.inService && x.phase === 'dwell' && x.dwellLeft > 10);
  s.select({ kind: 'train', id: t.id });
  await s.command({ c: 'manual', train: t.id, mode: 'CM' });
});
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}-panel-cm.png`, clip: { x: 2840, y: 120, width: 1000, height: 2040 } });
await page.locator('canvas.dmi').screenshot({ path: `${out}-cm.png` });
// RM
id = await page.evaluate(() => window.__ats.store.selection.id);
await page.evaluate(async (id) => { await window.__ats.store.command({ c: 'manual', train: id, mode: 'AM' }); }, id);
await page.waitForTimeout(500);
await page.evaluate(async (id) => { await window.__ats.store.command({ c: 'manual', train: id, mode: 'RM' }); }, id);
await page.waitForTimeout(3000);
await page.locator('canvas.dmi').screenshot({ path: `${out}-rm.png` });
await page.evaluate(async (id) => { await window.__ats.store.command({ c: 'manual', train: id, mode: 'AM' }); }, id);
// communication loss with emergency brake
const lost = await page.evaluate(async () => {
  const s = window.__ats.store;
  const t = s.snap.trains.find((x) => x.inService && x.phase === 'run' && x.v > 12 && x.mode === 'AM');
  s.select({ kind: 'train', id: t.id });
  await s.command({ c: 'fault', kind: 'trainComm', target: t.id, duration: 900 });
  return t.id;
});
await page.waitForFunction((id) => window.__ats.store.snap.trains.find((x) => x.id === id)?.eb, lost, { timeout: 30000 });
await page.waitForTimeout(800);
await page.locator('canvas.dmi').screenshot({ path: `${out}-commloss-eb.png` });
await page.waitForFunction((id) => window.__ats.store.snap.trains.find((x) => x.id === id)?.v < 0.1, lost, { timeout: 60000 });
await page.waitForTimeout(1500);
await page.locator('canvas.dmi').screenshot({ path: `${out}-commloss-stopped.png` });
console.log(logs.join('\n') || 'no errors');
await browser.close();
