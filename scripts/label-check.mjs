// Label overlap / minimum size check of the running app (needs `npm run dev`).
//   node scripts/label-check.mjs [url] [chromium-path]
// For several window sizes and UI scales it checks the overview at the
// initial zoom and two zoom-ins, and one station view: overlaps between the
// placed label rectangles and between the rendered bounds of every visible
// label, plus the smallest font in logical (3840×2160) pixels. Exits 1 on
// any overlap or a font below 20 logical px.
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://localhost:5173/';
const exe = process.argv[3] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CASES = [
  { w: 3840, h: 2160, scale: '1' },
  { w: 2560, h: 1440, scale: '1.1' },
  { w: 1920, h: 1080, scale: '1.5' },
  { w: 1366, h: 768, scale: '1.5' },
];

const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let failed = false;
for (const c of CASES) {
  const p = await browser.newPage({ viewport: { width: c.w, height: c.h } });
  await p.addInitScript((s) => { localStorage.setItem('ats2.helpSeen', 'true'); localStorage.setItem('ats2.uiScale', s); }, c.scale);
  await p.goto(`${url}?t=08:30`);
  await p.waitForFunction(() => window.__ats?.store?.snap, null, { timeout: 180000 });
  await p.waitForTimeout(2500);
  // camera changes reset the view's update key; wait for the next frame's
  // re-layout instead of a fixed delay (software GL at 4K is several s/frame)
  const settled = () => p.waitForFunction(() => window.__ats.app.activeView().lastKey !== '', null, { timeout: 120000 });
  const check = async (tag) => {
    await settled();
    const r = await p.evaluate(() => {
      const a = window.__ats.app;
      const v = a.activeView();
      const ov = (A, B, t = 0) => A.x < B.x + B.w - t && A.x + A.w - t > B.x && A.y < B.y + B.h - t && A.y + A.h - t > B.y;
      const idx = v.labelRects();
      let idxBad = 0;
      for (let i = 0; i < idx.length; i++) for (let j = i + 1; j < idx.length; j++) if (ov(idx[i].r, idx[j].r)) idxBad++;
      const items = [];
      let minFont = Infinity;
      for (const ch of v.labelLayer.children) {
        // leader lines are one Graphics spanning the whole view; they touch labels by design
        if (ch === v.leaderG || !ch.visible || ch.alpha === 0) continue;
        if (ch.style?.fontSize) minFont = Math.min(minFont, ch.style.fontSize);
        const b = ch.getBounds();
        if (b.width < 1 || b.height < 1) continue;
        items.push({ x: b.x, y: b.y, w: b.width, h: b.height, n: ch.text ?? ch.label ?? ch.constructor.name });
      }
      const bad = [];
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (ov(items[i], items[j], 1.5)) bad.push(`${items[i].n} × ${items[j].n}`);
      return { z: +v.z.toFixed(3), labels: items.length, idxBad, bad, minFont };
    });
    const ok = r.idxBad === 0 && r.bad.length === 0 && r.minFont >= 20;
    if (!ok) failed = true;
    console.log(`${c.w}×${c.h} @${c.scale} ${tag.padEnd(9)} z=${r.z} labels=${r.labels} overlaps=${r.idxBad}/${r.bad.length} minFont=${r.minFont}${ok ? '' : `  FAIL ${r.bad.slice(0, 5).join('; ')}`}`);
  };
  await check('overview');
  for (const f of [1.8, 2]) {
    await p.evaluate((f) => { const v = window.__ats.app.activeView(); v.zoomAt(f, v.vw / 2, v.vh / 2); }, f);
    await p.waitForTimeout(800);
    await check(`zoom×${f}`);
  }
  await p.evaluate(() => window.__ats.app.openStation(8));
  await p.waitForTimeout(1200);
  await check('station');
  await p.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
