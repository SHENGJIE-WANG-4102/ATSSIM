// Usage: node scripts/shot.mjs <url> <out.png> [waitMs] [width] [height]
import { chromium } from 'playwright-core';
const [url, out, wait = '15000', w = '3840', hgt = '2160'] = process.argv.slice(2);

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(hgt) }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForTimeout(Number(wait));
await page.screenshot({ path: out });
console.log(logs.slice(-30).join('\n'));
await browser.close();
