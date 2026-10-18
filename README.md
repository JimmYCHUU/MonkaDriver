# Monka Driver for Linux (Fedora KDE)

A Linux port of the Windows "Monka Driver" keyboard configurator (Monka A75 and the
other keyboards the vendor driver supports). The vendor's original user interface is
reused unmodified, so the app looks and behaves exactly like the Windows version; the
Windows-only helper that talked to the keyboard is replaced by a small Node.js bridge
that uses Linux `hidraw` through node-hid.

```
Electron main (main.js)
  └─ utilityProcess: bridge/main.js   gRPC-web server on 127.0.0.1:3814
        ├─ hid/manager.js             device discovery (sysfs), feature reports, dongle status
        ├─ kvstore.js                 settings store (replaces the helper's sled database)
        └─ service.js                 the DriverGrpc methods the vendor UI calls
  └─ BrowserWindow: dist/index.html   the vendor renderer, verbatim
```

## Install (RPM)

```sh
npm install
npm run dist            # electron-builder "dir" target + rpmbuild inside a fedora:44 container
sudo dnf install ./release/monka-driver-*.rpm
```

This installs `/opt/monka-driver`, the `/usr/bin/monka-driver` launcher, a launcher
entry ("Monka Driver") and icons. Uninstall with `sudo dnf remove monka-driver`.

No udev rule is needed on this machine: the keyboard's `hidraw` nodes are already
tagged `uaccess` for the logged-in user. On another machine add
`/etc/udev/rules.d/70-monka.rules` with
`SUBSYSTEM=="hidraw", ATTRS{idVendor}=="3151", MODE="0660", TAG+="uaccess"`.

## Development

```sh
npm test                # unit + integration tests (fake HID layer)
npm start               # run from source, READ-ONLY: SET commands are refused and logged
npm run start:fake      # as above but with a simulated dongle (no hardware needed)
npm run start:rw        # run from source with writes enabled
```

`npm start` never changes the keyboard: the bridge rejects every feature report whose
command byte is a SET command and logs it. The installed app allows writes (you are the
one changing settings in the UI). Override at any time with the environment variable
`MONKA_READ_ONLY=1|0`. Bridge logs: `~/.config/Monka Driver/logs/bridge.log`
(or `~/.cache/monka-driver/bridge.log` when the bridge runs standalone with
`node bridge/main.js`).

## Notes

* Only the bundled renderer (a `file://` page) may talk to the bridge: requests from
  web origins are refused and every call carries a per-launch token injected by the
  Electron main process.
* The vendor UI's cloud features (account login, sharing, update checks, weather for
  keyboards with screens) are not available offline and self-update is impossible in
  `/opt`; everything else works locally.
* `docs/protocol-re.md` documents the HID protocol as recovered from the vendor helper.
