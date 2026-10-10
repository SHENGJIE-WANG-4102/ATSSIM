// Frame-cost probe at 4K: node scripts/perf.mjs [url]
import { chromium } from 'playwright-core';
const url = process.argv[2] ?? 'http://localhost:5173/?t=08:00';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 3840, height: 2160 } });
await page.goto(url);
await page.waitForFunction(() => window.__ats?.store?.snap, null, { timeout: 180000 });
await page.waitForTimeout(4000);
const sample = async (label) => {
  const r = [];
  for (let i = 0; i < 5; i++) { await page.waitForTimeout(1100); r.push(await page.evaluate(() => window.__perf)); }
  const avg = (k) => (r.reduce((a, b) => a + b[k], 0) / r.length).toFixed(2);
  const trains = await page.evaluate(() => window.__ats.store.snap.trains.length);
  console.log(label, 'trains', trains, 'fps', avg('fps'), 'update ms', avg('updateMs'), 'schematic', avg('schematicMs'), 'graph', avg('graphMs'));
};
await sample('1x');
await page.evaluate(() => window.__ats.header.setSpeed(60));
await sample('60x');
await page.locator('.legend .tgl').click();
await sample('60x+names');
await browser.close();
