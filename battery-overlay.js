'use strict';
// Battery percentage and charging state shown next to Monka's own battery icon.
// The vendor interface draws only a 24 px icon (no number) and, over the 2.4 GHz
// dongle, is never told the keyboard is charging. Its bundle stays untouched: the
// Electron main process injects this small script into the page instead.

// Self-contained (it is also serialised into the page), so no outer references.
function batteryText(state) {
  if (!state || typeof state.battery !== 'number') return '';
  var pct = Math.max(0, Math.min(100, Math.round(state.battery)));
  return pct + '%';
}

// Runs inside the page. Finds the vendor's battery icon (the 24 px image whose
// sibling is the coloured fill bar) and keeps a label beside it: a drawn bolt
// while charging (an emoji would ignore the colour) and the percentage, both in
// the bar's cyan. Re-attaches whenever React re-renders the title bar.
function pageScript(batteryText) {
  if (window.__monkeyWrenchBattery) return;
  var state = null;
  var CYAN = 'rgb(25, 249, 226)'; // the colour of Monka's battery fill bar
  var SVG = 'http://www.w3.org/2000/svg';
  var FILL = /^rgba?\((25, ?249, ?226|255, ?204, ?0)/;
  function findIcon() {
    var divs = document.querySelectorAll('div[style*="background-color"]');
    for (var i = 0; i < divs.length; i++) {
      var d = divs[i];
      if (!FILL.test(d.style.backgroundColor || '')) continue;
      var box = d.parentElement;
      if (box && box.querySelector('img') && d.style.width && parseFloat(d.style.width) <= 14) return { box: box, fill: d };
    }
    return null;
  }
  function build(box) {
    var el = document.createElement('span');
    el.id = 'mw-battery';
    el.style.cssText = 'position:absolute;left:30px;top:50%;transform:translateY(-50%);display:flex;align-items:center;' +
      'gap:3px;white-space:nowrap;font-size:12px;line-height:12px;pointer-events:none;font-family:inherit;color:' + CYAN + ';';
    var bolt = document.createElementNS(SVG, 'svg');
    bolt.setAttribute('viewBox', '0 0 10 14');
    bolt.setAttribute('width', '8');
    bolt.setAttribute('height', '11');
    bolt.setAttribute('aria-hidden', 'true');
    bolt.style.display = 'none';
    var path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', 'M6.5 0 1 8h3.5L3.5 14 9 6H5.5z');
    path.setAttribute('fill', 'currentColor');
    bolt.appendChild(path);
    var text = document.createElement('span');
    el.appendChild(bolt);
    el.appendChild(text);
    el.__bolt = bolt;
    el.__text = text;
    box.appendChild(el);
    return el;
  }
  function render() {
    var found = findIcon();
    var el = document.getElementById('mw-battery');
    if (!found || !state) { if (el) el.remove(); return; }
    if (!el || el.parentElement !== found.box) {
      if (el) el.remove();
      el = build(found.box);
    }
    // only write what changed: every text write is a DOM mutation that re-triggers the observer
    var text = batteryText(state);
    if (el.__text.textContent !== text) el.__text.textContent = text;
    var display = state.charging ? 'block' : 'none';
    if (el.__bolt.style.display !== display) el.__bolt.style.display = display;
    var title = state.charging ? 'Charging' : (state.online ? 'On battery' : 'Keyboard asleep');
    if (el.title !== title) el.title = title;
  }
  new MutationObserver(function () { render(); }).observe(document.body, { childList: true, subtree: true });
  window.__monkeyWrenchBattery = function (s) { state = s; render(); };
}

function overlayScript() {
  return `(${pageScript.toString()})(${batteryText.toString()});`;
}

module.exports = { batteryText, overlayScript };
