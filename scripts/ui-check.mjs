import { chromium } from 'playwright-core';
const out = process.argv[2];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 3840, height: 2160 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push('pageerror ' + e.message));
await page.goto('http://localhost:5173/?t=08:00');
await page.waitForFunction(() => window.__ats?.store?.snap, null, { timeout: 120000 });
await page.waitForTimeout(3000);
// select a train
const id = await page.evaluate(() => { const s = window.__ats.store; const t = s.snap.trains.find((x) => x.inService && x.v > 5); s.select({ kind: 'train', id: t.id }); return t.id; });
await page.waitForTimeout(1500);
await page.screenshot({ path: out + '-train.png' });
// open the hold command → confirmation modal
await page.locator('.cmd .btn', { hasText: '扣车' }).first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: out + '-modal.png', clip: { x: 1200, y: 600, width: 1500, height: 900 } });
await page.locator('.modal .btn', { hasText: '执行' }).click();
await page.waitForTimeout(1500);
// select a section and open TSR (critical, two steps)
await page.evaluate(() => window.__ats.store.select({ kind: 'section', id: 120 }));
await page.waitForTimeout(800);
await page.locator('.cmd .btn', { hasText: '设置限速' }).click();
await page.locator('.modal .btn', { hasText: '下一步' }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: out + '-modal2.png', clip: { x: 1200, y: 600, width: 1500, height: 900 } });
await page.locator('.modal .btn', { hasText: '确认执行' }).click();
await page.waitForTimeout(2000);
await page.evaluate(() => window.__ats.store.select(null));
// events tab
await page.locator('.tab', { hasText: '事件' }).click();
await page.waitForTimeout(1000);
await page.screenshot({ path: out + '-full.png' });
console.log(logs.join('\n') || 'no errors');
await browser.close();
