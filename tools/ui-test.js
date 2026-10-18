#!/usr/bin/env node
'use strict';
// UI-driven write test through the vendor interface (authorized by the user on
// 2026-10-18; everything is reverted through the same UI):
//   1. Light tab: move the Brightness slider one step down, wait, move it back.
//   2. Main tab: remap F12 to Media "Play/Pause", Confirm; then select F12 again,
//      Reset (F12 is at its default in the baseline), Confirm if needed.
// The app must be running with writes enabled and --remote-debugging-port=9333.
// Verification is done outside this script (bridge log + tools/snapshot.js diff).
const { chromium } = require('playwright-core');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setRange(page, input, value) {
  await input.evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const page = browser.contexts()[0].pages().find((p) => p.url().startsWith('file://'));
  const step = (m) => console.log(new Date().toISOString().slice(11, 19), m);

  // wait for the keyboard to be shown
  await page.getByText('A75', { exact: true }).first().waitFor({ timeout: 120000 });
  step('keyboard shown in the UI');

  // ---- 1. lighting via the Light tab -------------------------------------
  if (process.env.UI_TEST_SKIP_LIGHT) { step('skipping the lighting part'); } else {
  await page.getByText('Light', { exact: true }).first().click();
  await sleep(1500);
  const sliders = page.locator('input[type="range"]');
  const n = await sliders.count();
  step(`Light tab: ${n} sliders`);
  const brightness = sliders.nth(1);
  const orig = Number(await brightness.inputValue());
  const target = orig > 1 ? orig - 1 : orig + 1;
  step(`brightness ${orig} -> ${target}`);
  await setRange(page, brightness, target);
  await sleep(3000);
  step(`brightness now ${await brightness.inputValue()}; restoring ${orig}`);
  await setRange(page, brightness, orig);
  await sleep(3000);
  step(`brightness restored in UI: ${await brightness.inputValue()}`);
  }

  // ---- 2. key remap via the Main tab --------------------------------------
  await page.getByText('Main', { exact: true }).first().click();
  await sleep(1500);
  // the keyboard is a photo with transparent click targets (24x29 px); in the
  // 1200x788 window the F12 target is the 13th of the top row at (651,158)
  const panelText = () => page.evaluate(() => (document.elementFromPoint(1050, 300) || {}).innerText || '');
  const f12 = { click: async () => { await page.mouse.click(663, 172); } };
  await f12.click();
  await sleep(800);
  step(`selected F12; panel: ${(await panelText()).replace(/\s+/g, ' ').trim()}`);
  const option = page.getByText('Play/Pause', { exact: true }).first();
  await option.click();
  await sleep(500);
  await page.getByText('Confirm', { exact: true }).first().click();
  step('F12 -> Play/Pause confirmed');
  await sleep(6000);
  await f12.click();
  await sleep(800);
  step(`re-selected F12; panel: ${(await panelText()).replace(/\s+/g, ' ').trim()}`);
  await page.getByText('Reset', { exact: true }).first().click();
  step('F12 reset');
  await sleep(1000);
  const confirm = page.getByText('Confirm', { exact: true }).first();
  if (await confirm.isVisible()) { await confirm.click(); step('confirmed reset'); }
  await sleep(6000);
  await browser.close();
  step('done');
}
main().catch((e) => { console.error('ui-test failed:', e.message); process.exit(1); });
