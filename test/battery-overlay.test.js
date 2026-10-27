'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { batteryText, overlayScript } = require('../battery-overlay');

// Minimal DOM stand-in shaped like the vendor title bar: a box holding the 24 px
// battery image and the coloured fill bar. Counts every text write.
function fakePage(fillColor = 'rgb(25, 249, 226)', { topnav = true } = {}) {
  const created = [];
  let writes = 0;
  const makeEl = (tag) => {
    let text = '';
    const el = {
      tag, id: '', title: '', style: {}, attrs: {}, children: [], parentElement: null,
      appendChild(c) { c.parentElement = el; el.children.push(c); return c; },
      setAttribute(k, v) { el.attrs[k] = v; },
      remove() {
        if (el.parentElement) el.parentElement.children = el.parentElement.children.filter((c) => c !== el);
        el.parentElement = null;
      },
      get textContent() { return text; },
      set textContent(v) { writes++; text = v; },
    };
    created.push(el);
    return el;
  };
  const box = makeEl('div');
  box.querySelector = () => ({}); // the box holds an <img>
  const fill = makeEl('div');
  fill.style.backgroundColor = fillColor;
  fill.style.width = '13px';
  box.appendChild(fill);
  let observerCb = () => {};
  let hasTopnav = topnav;
  const body = makeEl('body');
  body.parentElement = {}; // attached to the document
  const document = {
    querySelectorAll: () => (fillColor ? [fill] : []),
    querySelector: (sel) => (/topnav_logo/.test(sel) && hasTopnav ? {} : null),
    getElementById: (id) => created.find((e) => e.id === id && e.parentElement) || null,
    createElement: makeEl,
    createElementNS: (ns, tag) => makeEl(tag),
    body,
  };
  const window = {};
  new Function('window', 'document', 'MutationObserver', overlayScript())(
    window, document, function (cb) { observerCb = cb; this.observe = () => {}; },
  );
  const label = () => document.getElementById('mw-battery');
  const text = () => (label() ? label().children.map((c) => c.textContent).join('') : '');
  const bolt = () => label() && label().children.find((c) => c.tag === 'svg');
  const standalone = () => document.getElementById('mw-battery-box');
  return { set: (s) => window.__monkeyWrenchBattery(s), label, text, bolt, standalone, showTopnav: () => { hasTopnav = true; }, mutate: () => observerCb([]), writes: () => writes };
}

test('the text is always just the percentage, never a word (the bolt alone marks charging)', () => {
  assert.equal(batteryText({ battery: 30, charging: false }), '30%');
  assert.equal(batteryText({ battery: 120 }), '100%');
  assert.equal(batteryText({ battery: 100, charging: true }), '100%');
  assert.equal(batteryText({ battery: null, charging: true, wired: true }), '');
  assert.equal(batteryText(null), '');
});

test('the injected script is self-contained and installs a window hook', () => {
  const src = overlayScript();
  assert.match(src, /window\.__monkeyWrenchBattery\s*=/);
  assert.doesNotThrow(() => new Function(src));
});

test('the page script finds the vendor icon when the browser reports its fill as rgb() or rgba()', () => {
  for (const color of ['rgb(25, 249, 226)', 'rgba(25, 249, 226, 0.5)', 'rgb(255, 204, 0)']) {
    const page = fakePage(color);
    page.set({ battery: 30, charging: false, online: true });
    assert.ok(page.label(), color);
    assert.equal(page.text(), '30%', color);
  }
});

test('the label is the bar\'s cyan at every level, and the bolt is drawn in that cyan, not an emoji', () => {
  const page = fakePage();
  page.set({ battery: 15, charging: false, online: true });
  assert.match(page.label().style.cssText, /color:\s*rgb\(25, 249, 226\)/);
  assert.equal(page.text(), '15%');
  page.set({ battery: 15, charging: true, online: true });
  assert.equal(page.text(), '15%', 'no word, only the bolt changes');
  assert.ok(!/charging/i.test(page.text()));
  assert.ok(!page.text().includes('⚡'), 'no emoji glyph');
  const bolt = page.bolt();
  assert.ok(bolt, 'bolt drawn while charging');
  assert.notEqual(bolt.style.display, 'none');
  assert.equal(bolt.children[0].attrs.fill, 'currentColor');
  page.set({ battery: 15, charging: false, online: true });
  assert.equal(page.bolt().style.display, 'none', 'bolt hidden on battery');
});

test('re-rendering with an unchanged state does not touch the label (no observer feedback loop)', () => {
  const page = fakePage();
  page.set({ battery: 30, charging: false, online: true });
  const w = page.writes();
  page.mutate();
  page.mutate(); // the label's own insertion triggers the observer
  assert.equal(page.writes(), w, 'unchanged text is not rewritten');
  page.set({ battery: 31, charging: false, online: true });
  assert.equal(page.writes(), w + 1);
});

test('with no vendor battery icon (cabled keyboard) the label brings its own icon, only on the main view', () => {
  const page = fakePage(null, { topnav: false });
  page.set({ battery: 100, charging: true, online: true, wired: true });
  assert.equal(page.label(), null, 'nothing on the welcome page');
  page.showTopnav();
  page.set({ battery: 100, charging: true, online: true, wired: true });
  const box = page.standalone();
  assert.ok(box, 'own icon box drawn');
  assert.match(box.style.cssText, /left:\s*923px/);
  assert.match(box.style.cssText, /top:\s*22px/);
  assert.ok(box.children.some((c) => c.tag === 'svg'), 'battery outline drawn');
  assert.equal(page.text(), '100%');
  assert.notEqual(page.bolt().style.display, 'none', 'bolt while charging');
});
