#!/usr/bin/env node
'use strict';
// Attach to a running Electron instance (started with --remote-debugging-port=9333)
// over the DevTools protocol and dump the visible text of clickable elements, to
// discover selectors for UI-driven tests. Usage: node tools/ui-explore.js [tabText]
const { chromium } = require('playwright-core');

async function main() {
  const tab = process.argv[2];
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().startsWith('file://')) || ctx.pages()[0];
  console.log('page:', page.url());
  if (tab) {
    const el = page.getByText(tab, { exact: true }).first();
    await el.click();
    await page.waitForTimeout(1500);
  }
  const items = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('div,span,button,li,p,input,img')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const t = (el.innerText || el.value || el.alt || '').trim().replace(/\s+/g, ' ');
      if (!t || t.length > 40) continue;
      const cs = getComputedStyle(el);
      const key = `${t}@${Math.round(r.x)},${Math.round(r.y)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (el.children.length > 3) continue;
      out.push({ t, tag: el.tagName.toLowerCase(), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cursor: cs.cursor, cls: (el.className || '').toString().slice(0, 30) });
    }
    return out;
  });
  for (const it of items) console.log(`${it.tag.padEnd(5)} ${String(it.x).padStart(4)},${String(it.y).padStart(4)} ${String(it.w).padStart(4)}x${String(it.h).padStart(3)} ${it.cursor.padEnd(8)} ${it.t}`);
  await browser.close();
}
main().catch((e) => { console.error('ui-explore failed:', e.message); process.exit(1); });
