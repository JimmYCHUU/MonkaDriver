'use strict';
// Dongle ("dangle common") status polling. The frame sequence comes from the
// reverse-engineered helper (docs/protocol-re.md); until it is documented the
// poller reports "unknown" so the UI shows the device without battery data.

async function pollStatus(/* dev, info, { log, rules } */) {
  return null;
}

// Used by the fake HID module (MONKA_FAKE_HID=1): answer dongle queries.
function fakeResponder(/* frame */) {
  return undefined;
}

module.exports = { pollStatus, fakeResponder };
