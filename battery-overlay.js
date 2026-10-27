'use strict';
// Battery percentage and charging state shown next to Monka's own battery icon.
// The vendor interface draws only a 24 px icon (no number) and, over the 2.4 GHz
// dongle, is never told the keyboard is charging. Its bundle stays untouched: the
// Electron main process injects this small script into the page instead.

// Self-contained (it is also serialised into the page), so no outer references.
// Just the number the keyboard reports; the bolt alone marks charging. (On cable
// power the keyboard reports 100% whatever its real charge.)
function batteryText(state) {
  if (!state || typeof state.battery !== 'number') return '';
  var pct = Math.max(0, Math.min(100, Math.round(state.battery)));
  return pct + '%';
}

// Runs inside the page. Finds the vendor's battery icon (the 24 px image whose
// sibling is the coloured fill bar) and keeps a label beside it: a drawn bolt
// while charging (an emoji would ignore the colour) and the percentage, both in
// the bar's cyan. A keyboard on its cable has no vendor icon (Monka draws it only
// for wireless devices), so on the main view the label then brings its own icon
// at the same spot. Re-attaches whenever React re-renders the title bar.
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
  // our own icon, used when the vendor's is not drawn: Monka's 24 px battery box
  // at the position Monka uses (923, 22 in the 1200x788 page), drawn in cyan
  function ownIcon() {
    var box = document.getElementById('mw-battery-box');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'mw-battery-box';
    box.style.cssText = 'position:fixed;left:923px;top:22px;width:24px;height:12px;pointer-events:none;z-index:10;';
    var icon = document.createElementNS(SVG, 'svg');
    icon.setAttribute('viewBox', '0 0 24 12');
    icon.setAttribute('width', '24');
    icon.setAttribute('height', '12');
    icon.setAttribute('aria-hidden', 'true');
    var outline = document.createElementNS(SVG, 'rect');
    outline.setAttribute('x', '0.75'); outline.setAttribute('y', '0.75');
    outline.setAttribute('width', '19.5'); outline.setAttribute('height', '10.5'); outline.setAttribute('rx', '2');
    outline.setAttribute('fill', 'none'); outline.setAttribute('stroke', CYAN); outline.setAttribute('stroke-width', '1.5');
    var nub = document.createElementNS(SVG, 'rect');
    nub.setAttribute('x', '20.5'); nub.setAttribute('y', '3.5'); nub.setAttribute('width', '2.5'); nub.setAttribute('height', '5');
    nub.setAttribute('rx', '0.5'); nub.setAttribute('fill', CYAN);
    var level = document.createElementNS(SVG, 'rect');
    level.setAttribute('x', '3'); level.setAttribute('y', '3'); level.setAttribute('width', '14'); level.setAttribute('height', '6');
    level.setAttribute('fill', CYAN); level.setAttribute('fill-opacity', '0.5'); // Monka dims the fill while charging
    box.__level = level;
    icon.appendChild(outline);
    icon.appendChild(nub);
    icon.appendChild(level);
    box.appendChild(icon);
    document.body.appendChild(box);
    return box;
  }
  function render() {
    var found = findIcon();
    var el = document.getElementById('mw-battery');
    var own = document.getElementById('mw-battery-box');
    var host = null;
    if (state && found) host = found.box;
    else if (state && state.charging && document.querySelector('img[src*="topnav_logo"]')) host = ownIcon();
    if (found && own) { own.remove(); own = null; }
    if (!host) { if (el) el.remove(); if (own) own.remove(); return; }
    if (!el || el.parentElement !== host) {
      if (el) el.remove();
      el = build(host);
    }
    // only write what changed: every text write is a DOM mutation that re-triggers the observer
    var text = batteryText(state);
    if (el.__text.textContent !== text) el.__text.textContent = text;
    var display = state.charging ? 'block' : 'none';
    if (el.__bolt.style.display !== display) el.__bolt.style.display = display;
    var title = state.charging ? 'Charging' : (state.online ? 'On battery' : 'Keyboard asleep');
    if (el.title !== title) el.title = title;
    if (host.__level && typeof state.battery === 'number') {
      // like Monka's fill: up to 14 px wide, dimmed while charging
      var w = String(Math.max(1, Math.ceil(Math.min(100, state.battery) / 100 * 14)));
      if (host.__level.getAttribute && host.__level.getAttribute('width') !== w) host.__level.setAttribute('width', w);
      var op = state.charging ? '0.5' : '1';
      if (host.__level.getAttribute && host.__level.getAttribute('fill-opacity') !== op) host.__level.setAttribute('fill-opacity', op);
    }
  }
  new MutationObserver(function () { render(); }).observe(document.body, { childList: true, subtree: true });
  window.__monkeyWrenchBattery = function (s) { state = s; render(); };
}

function overlayScript() {
  return `(${pageScript.toString()})(${batteryText.toString()});`;
}

module.exports = { batteryText, overlayScript };
