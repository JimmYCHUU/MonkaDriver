# iot_driver_mac protocol reverse engineering

Binary: `iot_driver_mac` (Mach-O x86_64, PIE base 0x100000000, full Rust symbols). Read-only static analysis with objdump; nothing was executed.
Everything below was read from the disassembly unless marked **INFERRED**. Addresses are the first (canonical) copy of each function; several async closures exist in 2–4 identical copies.

## Summary

* **Transport (this macOS build)**: keyboards/dongles are driven with **libusb control transfers**, not hidapi. `HidLibusb::send_feature` = `SET_REPORT(bmRequestType 0x21, bRequest 0x09, wValue 0x0300, wIndex = interface, wLength 64, timeout 2000 ms)` sending exactly `buf[0..64]`; `get_feature` = `GET_REPORT(0xa1, 0x01, 0x0300, interface, 64 bytes)` returning the 64 bytes untouched. **No report-id byte on either direction.** hidapi is only used by the BLE path. (The "[0x00]+data / 65 bytes" behaviour from earlier RE belongs to hidapi builds.)
* **Framing / checksum (Q1)** — done in `DJDevice::send_feature::{{closure}}` (0x1000474b0): `buf = msg; buf.resize(66, 0)`; then, for a USB device (support-table row without `ble =`, i.e. `DJDeviceInfo.ble == None`):
  * `BIT7 (0)`: `buf[7] = ~(buf[0]+buf[1]+…+buf[6]) & 0xFF` (7 bytes, indices 0..6, command byte included)
  * `BIT8 (1)`: `buf[8] = ~(buf[0]+…+buf[7]) & 0xFF` (8 bytes, indices 0..7)
  * `NONE (2)`: untouched.
  * For `ble = true` rows (`ble == Some(_)`), the same sums are shifted by one byte: `buf[8] = ~Σbuf[1..8]` / `buf[9] = ~Σbuf[1..9]` (the BLE buffer carries a leading report-id byte).
  * Wire frame = `buf[0..64]`; bytes beyond the message are 0x00. Nothing else is modified. `sendRawFeature` applies the **same** checksum (it only skips the 2.4G/busy bookkeeping).
  * **Read**: `readMsg`/`readRawFeature` return the raw 64-byte GET_REPORT buffer: byte 0 = command echo, nothing stripped, no checksum validation.
* **Dongle protocol (Q2)** — all dongle housekeeping frames are sent with `check_sum_type = NONE` and 1–2 payload bytes padded to 64:
  * `F6 sel` = `[0xF6, (0x000D050A >> (sel*8)) & 0xFF]` → `sel 0 (keyboard) → 0xF6 0x0A`, `sel 1 (mouse) → 0xF6 0x05`, `sel 2 → 0xF6 0x0D`. `sel = is_mouse as u8 = (dangle_dev_type == MOUSE)`. The last selection is cached (`self+0xf9`) and F6 is skipped if unchanged; after sending it sleeps 10 ms.
  * `F7` = `[0xF7]`, then 1 ms sleep, then GET_REPORT. Reply (64 bytes): `r[0]`(==1 flag), **`r[1] = battery`**, `r[2]` (u8, captured only when `r[6]==2`), **`r[3]==0 ⇒ keyboard online`**, **`r[4]==0 ⇒ mouse online`**, `r[5]==1` ("ready" flag used by the send loop, INFERRED name), `r[6]` = which status word is populated (`1` or `3` → keyboard word, `2` → mouse word, anything else → both "Empty"). An all-zero reply ⇒ "no status". (Battery/online assignment INFERRED by analogy with the FB layout proven in `handle_24_status`.)
  * `FB` = `[0xFB]` (keyboard 2.4G status): reply `r[1] = battery`, `r[2]==0 ⇒ online`, `r[0]==1`, `r[3]==1` extra flags (battery/online proven by `handle_24_status` comparing `+0x28` u32 and `+0x2d` byte).
  * `FD` = `[0xFD]` (is-2.4G probe, only for plain USB keyboards): reply `r[1] == 0x55 ⇒ is24 = true`; result cached per device.
  * `FE len` = `[0xFE, len]` "set next pack length" (10 ms sleep after). `dangle_common_get_dev_id` sends `FE 0x40`, then `0x8F` (GET_INFOR) through the dongle with `BIT7`, and derives `id = u32::from_le_bytes([r[1], r[2], r[3], r[4] | 0x80])` — i.e. model id little-endian in `r[1..3]` with bit 31 forced set (A75: `0x80000790`). Keyboard id uses `sel 0`, mouse id uses `sel 1`.
  * `FC` = `[0xFC]` is sent (NONE) right before every 2.4G/dongle GET_REPORT read (`read_msg`, `read_dangle_common_msg`).
  * **Sending a user msg to a dongle device** (`send_dangle_common_msg`): `pasue24loop` → loop ≤ 15×: `F7`, require (keyboard or mouse) `online`; if a "ready" bit is set → 1 ms sleep and go on, else 100 ms sleep and retry (errors "dev is not online" / "f7 wait write 超时") → `F6 sel` → `send_feature(msg, check_sum_type)`. **Reading** (`read_dangle_common_msg`): `pasue24loop` → same F7 online loop → `FC` → 10 ms → 10 ms → GET_REPORT.
  * **Polling loop**: one tokio task per dongle (`handle_dangle_common_24_status`, spawned from `refresh_dev_list`): every iteration `sleep(2 s)`; if `get_wireless_lock_status()` → just sleep 2 s again (the **lock from `changeWirelessLoopStatus` pauses the whole F7/ids/light poll**); if a user msg is in flight (`check_is_msg_sending_or_reading`) → sleep 2 s; else `get_dangle_common_status` (F7; when a device newly appears online, `FE 40` + `8F` to fetch its id, keyboard first then mouse) → `get_light_type` → `get_status` → `get_light(sel 0)`, `get_light(sel 1)` → compare with previous status and broadcast a DeviceList CHANGE. Same lock check exists in `handle_24_status` (non-dongle 2.4G keyboards) and `check_ble_status`.
* **Raw vs non-raw (Q3)**: `sendRawFeature` → `Base::pure_send_feature` → `send_feature` directly (checksum still applied); `sendMsg` → `DJDevApi::send_msg` adds `set_is_reading_or_sending` + 2 s auto-unset task, `fd_24_check_is24`, and for 2.4G keyboards `pasue24loop` + `wait_fb_write_finish` before and after. For dongles non-raw goes through the F7/F6 dance above; raw skips it. `readRawFeature` → `pure_get_feature` (plain GET_REPORT); `readMsg` → `read_msg`/`read_dangle_common_msg` (FB/F7 waits + `FC` prelude).
* **watchVender (Q4)**: gRPC stream subscribes to a tokio broadcast channel (`get_vender_watcher`) and forwards `VenderMsg{msg}` items as-is. On this macOS build the only producer is the BLE vendor path (`BleVendor::set_sender`); there is **no libusb interrupt/bulk read anywhere in the binary**, so USB "vender" interfaces (TOML `vender` table: usage 1 / usage_page 0xffff / interface 1) are enumerated (devtype YZWVENDER) but never read.
* **Non-dongle 2.4G (Q5)**: `DJDevApi::get_24_status` = `fd_24_check_is24` (FD, cached) then, if 2.4G, `fb_24_check_status` (FB) → `{battery = r[1], is_online = (r[2]==0)}`; `handle_24_status` polls it (2 s cadence, honours the wireless lock) and broadcasts a DeviceList CHANGE when battery/online differ from the cached values.
* Device table and command ids are embedded TOML/text (see appendix): A75 dongle row `{ vid = 0x3151, pid = 0x4011, usage = 0x2, usage_page = 0xffff, interface_number = 2, dongle_common = true }` (no `ble` ⇒ unshifted checksum). Command list: `GET_REV 0x80, GET_INFOR 0x8F, GET_BATTERY 0x83, GET_KEYMATRIX 0x89, SET_KEYMATRIX 0x09, …`.

---

## Q1. Checksum / framing (sendMsg / readMsg) — evidence

### Transport
* `HidLibusb::send_feature` 0x100116a70:
  ```
  100116ace  cmp r13,0x3f ; jbe slice_end_index_len_fail(0x40)   ; needs len >= 64 → &buf[..64]
  100116ae8  movzx r8d,WORD PTR [r14+0x38]  ; wIndex = interface number
  100116aed  mov DWORD PTR [rsp+0x8],0x7d0  ; timeout 2000 ms
  100116af5  mov DWORD PTR [rsp],0x40       ; wLength = 64
  100116afc  mov esi,0x21 ; mov edx,0x9 ; mov ecx,0x300 ; mov r9,r12 (buf)
  100116b0e  call libusb_control_transfer
  ```
* `HidLibusb::get_feature` 0x100116c90: `BytesMut::resize(0x40)` (0x100116d13), `libusb_control_transfer(h, 0xa1, 0x01, 0x300, interface, buf, 64, 2000)` (0x100116d49..0x100116d58), then `Bytes::from(buf)` — whole 64 bytes returned.
* hidapi (`HidDevice::write`) is only called from `HidBLE::send_feature` (0x1000d4a30, which does `put_slice(1 byte) + put_slice(data)` — the report-id prefix for the BLE path). No `send_feature_report`/`read` calls exist in `iot_driver` code.

### `DJDevice::send_feature::{{closure}}` 0x1000474b0 (dups 0x1000c2fb0, 0x1000d6680, 0x100117bb0)
State: data ptr/len `[state+0x10/0x18]`, `check_sum_type` byte `[state+0xba]→[+0xb8]`, `self` (DJDevice) `[state+0xb0]`.
```
1000475ba  [rbx+0x28]=0xa ; sleep::{{closure}}      ; while [self+0x81] (busy) != 0: sleep 10 ms
100047646  BytesMut::new
100047666  put_slice(data,len)
10004767a  mov esi,0x42 ; call BytesMut::resize    ; pad with 0 to 66 bytes
100047686  movzx eax,[rbx+0xb8]  ; check_sum_type
10004768d  cmp eax,2 ; je 100047785                 ; NONE → send
100047696  cmp eax,1 ; jne 1000476be                ; 1 = BIT8, else BIT7
10004769b  rax=[rbx+0x20] (self) ; al=[rax+0x3c]    ; DJDeviceInfo.ble (Option<bool>: 0/1 = Some, 2 = None)
BIT8, ble==None : 1000476ab cmp rsi,7;jbe fail ; rdi=buf ; sum rdi[0..8] (1000476f3..100047708) ; not dl ; buf[8]=dl (100047782)
BIT8, ble==Some : 1000476e1 cmp rsi,9;jb fail ; rdi=buf+1 ; sum buf[1..9] ; not dl ; buf[9]=dl (100047773)
BIT7, ble==None : 1000476ce cmp rsi,6;jbe fail ; rdi=buf ; sum rdi[0..7] (10004773f..100047751) ; not dl ; buf[7]=dl (100047764)
BIT7, ble==Some : 10004772d cmp rsi,8;jb fail ; rdi=buf+1 ; sum buf[1..8] ; not dl ; buf[8]=dl (100047782)
100047785  rax=[self+0x40] (Box<dyn HidSender>) ; call [vtable+0x18] = HidSender::send_feature(buf, 66)
1000477b7  on Err: DJDeviceManger::clean_dev ; clean_all_vendor
```
The sum is 8-bit wrapping (`add dl, BYTE PTR [...]`) followed by `not dl`.

`DJDeviceInfo` layout (from `<DJDeviceInfo as Debug>::fmt` 0x10004c820 + names array 0x100638000): `path:String @0`, `hid_raw_path:CString @0x18`, `interface_number:i32 @0x28`, `vid:u16 @0x2c`, `pid @0x2e`, `usage @0x30`, `usage_page @0x32`, `request_type @0x34`, `value_type @0x36`, `libusb_index:u16 @0x38`, `dev_type:DJDevType @0x3a` (0=Vender, 1=Normal, 2=YZWBoot; names at 0x100516b60), `dangle_common:Option<bool> @0x3b`, `ble:Option<bool> @0x3c` (2 = None). `DJDeviceInfo::from_libusb_info` 0x1001175e0 fills `dangle_common = row[0x12]`, `ble = row[0x13]` from the deserialized `SupportDev` row (`support = [...]` TOML, `SUPPORTDEVLIST` lazy static at 0x100684a30); rows without `ble =` deserialize to `None`. `DJDevice` embeds the info at offset 0 (`DJDevice::new` 0x1000d54b0 copies it; `+0x40/+0x48` = `Box<dyn HidSender>`).

### Call chain for gRPC `SendMsg`
* `DriverGrpc::send_msg` closure 0x100096350: copies request, `WORD [state+0x138] = 0` (raw = false) → `send_msg_by_dev_path`. `send_raw_feature` 0x1000969b0: identical but `WORD [state+0x138] = 1`.
* `GrpcServer::send_msg_by_dev_path::{{closure}}` 0x100093a80: `get_dev_from_path` (0x100093bd4) → jump table 0x1000949a0 on device kind:
  * raw (`[rbp-0x68] != 0`): `call [vtable+0x30]` = `Base::pure_send_feature(dev, ptr, len, check_sum_type)` at 0x10009419d / 0x100094311.
  * Device, non-raw (0x1000944a6..): `get_time_stamp`, `set_is_reading_or_sending(dev, msg.to_vec(), ts)`, `tokio::task::spawn` of closure 0x10004c2e0 (`tokio::time::sleep(2 s)` → `unset_is_reading_or_sending`), then `call [vtable+0x50]` = `DJDevApi::send_msg(dev, ptr, len, ecx = check_sum_type)` at 0x1000945ef.
  * DangleCommon, non-raw (0x100094332..): same, then `call [vtable+0x50]` = `DJDangleCommon::send_dangle_common_msg(dev, ptr, len, cl = (DWORD [rbx+0x74] == 2) /* dangle_dev_type == MOUSE */, r8d = check_sum_type)` at 0x100094478..0x100094485.
  * Vender device: error "cant sent msg to vender" (0x1000941dc).
* vtables (found by scanning `__DATA,__const`): DJDevApi for `YZWKeyboard` @0x100637248 — `+0x18 get_dev, +0x20 set_lock, +0x28 get_is_lock, +0x30 pure_send_feature, +0x38 pure_get_feature, +0x48 get_cmd_list, +0x50 send_msg, +0x58 read_msg, +0x60 send_read_msg, +0x68 get_24_status, +0x70 get_id, +0x78 get_light, +0x80 set_screen, +0x88 set_music, +0x90 check_light_type`. `YZWDangleCommon` @0x100636e40 — `+0x30 pure_send_feature, +0x38 pure_get_feature, +0x40 get_cmd_list, +0x48 get_status, +0x50 send_dangle_common_msg, +0x58 read_dangle_common_msg, +0x60 get_dangle_common_status, +0x68 get_light, +0x70 set_screen, +0x78 set_music, +0x80 check_light_type, +0x88 set_light_type, +0x90 get_light_type`.
* `DJDevApi::send_msg` 0x10011d910 stores `(ptr,len,self,cs)` and returns the future 0x10011d990 → `DJDevice::send_msg::{{closure}}` 0x1001198f0:
  `fd_24_check_is24` (0x100119950) → if true: `pasue24loop` (0x1001199f9) + `wait_fb_write_finish` (0x100119a18; error string "fb wait write 超时" at 0x100119be7) → `send_feature(ptr,len,cs)` (0x100119b1d; cs byte passed via `[state+0x102]`) → `fd_24_check_is24` again (0x100119b88) → if true `wait_fb_write_finish` (0x100119c6b). No byte manipulation of the message.
* `Base::pure_send_feature::{{closure}}` 0x1000c92e0: straight to `send_feature` (0x1000c9347) with the same `cs` byte (`[state+0xd9]→[+0xba]`). So **raw still gets the checksum**.

### Read side
* `DriverGrpc::read_msg` 0x100096620: `WORD [state+0x140] = 0`; `read_raw_feature` 0x100096c80: `= 1`; both → `read_msg_by_dev_path::{{closure}}` 0x100092d90: raw → `call [vtable+0x38]` (`pure_get_feature`, 0x100093420/0x10009364b/0x10009367f); non-raw → `call [vtable+0x58]` (`DJDevApi::read_msg` / `read_dangle_common_msg`, 0x10009369b/0x1000936b7); Vender → "cant read msg from vender".
* `DJDevice::get_feature::{{closure}}` 0x100047930: waits while `[self+0x81]` busy (10 ms sleeps), `call [HidSender vtable+0x20]` (0x100047abd) and returns the `Bytes` unchanged (64 bytes, byte 0 = command echo). No stripping, no checksum check.
* `DJDevice::read_msg::{{closure}}` 0x100119ea0: `fd_24_check_is24` (0x100119ef9); not 2.4G → jump straight to `get_feature` (0x10011a521/0x10011a53e). 2.4G: `pasue24loop` (0x100119ff7) → loop `fb_24_check_status` (0x10011a211) with 10 ms sleeps until ready (errors "read fb 超时", "dev is not online") → `send_feature([0xFC], NONE)` (0x10011a3ff..0x10011a430; byte at 0x10051de9f = 0xFC; `WORD [rbx+0xe1]=0x200` → cs = 2) → sleep 10 ms (0x10011a47e) → sleep 10 ms (0x10011a4cf) → `get_feature`.
* `ResRead.msg` = the 64 bytes as returned.

## Q2. Dongle (DangleCommon) protocol — evidence

Common helper `DJDevice::comman_feature::{{closure}}` 0x100047bf0: `set_is_reading_or_sending` (0x100047d0d) → `send_feature(frame, cs)` (0x100047d46) → `sleep(1 ms)` (`[rbx+0x60]=1`, 0x100047e18) → `get_feature` (0x100047e5c) → `unset_is_reading_or_sending`.

* **F6 `dangle_common_f6_set_device::{{closure}}` 0x1000c3840**:
  ```
  1000c38e4  dl=[rbx+0x10] (sel) ; cmp dl,[self+0xf9] ; je skip  ; cached last selection
  1000c3945  cl=sel ; shl cl,3 ; eax=0x000d050a ; shr eax,cl    ; byte = {0:0x0a,1:0x05,2:0x0d}[sel]
  1000c395a  [rbx+0x18]=0xf6 ; [rbx+0x19]=al ; len=2 ; WORD [rbx+0xd9]=0x200 (cs=NONE)
  1000c3988  send_feature ; then [rbx+0x18]=0xa → sleep 10 ms ; [self+0xf9]=sel ; [self+0xf8]=1
  ```
  `sel` comes from `send_dangle_common_msg(…, is_mouse, cs)`: `DJDangleCommon::send_dangle_common_msg` stores `is_mouse` byte → `DJDevice::send_dangle_common_msg` `[r14+0x32]→[+0x38]`, and `get_dangle_common_status` uses `WORD [rbx+0x50] = 0x0000` (sel 0, cs 0) for the keyboard id and `0x0100` (sel 1) for the mouse id (0x1000c6964 / 0x1000c6c42); `handle_dangle_common_24_status` calls `get_light` with `WORD [rax+0x199] = 0` then `0x100` (0x100043f13 / 0x10004409f). sel 2 (0x0D) is not used by any code path examined (`get_light` passes sel through; INFERRED "both").
* **F7 `dangle_common_f7_check_24_status::{{closure}}` 0x1000de140**: frame = 1 byte at 0x10051ba7b = `F7`, `WORD [rbx+0x60]=0x200` (NONE), via `comman_feature` (0x1000de1a3). Parse (r12 = reply, r15 = len):
  ```
  1000de2a0  loop: if all bytes 0 → 1000de343 (re-issue once via boxed future, then "no status")
  1000de2b4  cmp r15,6 ; jbe panic            ; needs ≥7 bytes
  1000de2be  esi=r[6] ; eax=r[0] ; edx=r[3] ; ecx=r[5]
  1000de2d5  r[6]==3 or ==1 → 1000de2ec : wordA = {b0:(r[0]==1), b1:(r[3]==0), b2:(r[5]==1)} ; wordB = {b2:2 (None)}
  1000de468  r[6]==2           : wordB = {b0:(r[0]==1), b1:(r[4]==0), b2:(r[5]==1)} ; wordA = {b2:2, b4:r[2]}
  1000de4ac  else              : wordA = wordB = {b2:2}
  1000de4bc  eax = r[1] → DWORD [result+4]  ; result = {err u32 @0, r[1] @4, wordA @8, wordB @0x10}
  ```
  Each 8-byte status word is `{b0: bool, b1: online: bool, b2: Option<bool> (2=None), b4: u8}`. `DJDangleCommon::get_status` 0x1000c6060 returns the cached `DangleCommonStatus` = `{keyboard_id u32 @self+0xbc, mouse_id u32 @+0xc4, wordA @+0xcc, wordB @+0xd4}`; `get_dangle_common_status` 0x1000c6590 writes `[r12+0xcc]=wordA, [r12+0xd4]=wordB` (0x1000c68b2/0x1000c68d6) and the ids after `dangle_common_get_dev_id`. The keyboard-word/mouse-word assignment (wordA ↔ sel 0) and `r[1]` = battery are **INFERRED** from the FB layout proven below and from the id-fetch order.
* **FB `fb_24_check_status::{{closure}}` 0x1000480d0**: frame byte at 0x1005169d2 = `FB`, NONE, via `comman_feature`. Parse (0x1000481f3..0x10004824d): needs ≥4 bytes; packed u64 = `r[1]` (low byte) | `(r[0]==1)<<32` | `(r[2]==0)<<40` | `(r[3]==1)<<48`. `handle_24_status` 0x100044ed0 compares `DWORD [dev+0x28]` (new) vs `[dev+0x18]` (old battery) and `BYTE [dev+0x2d]` vs `[dev+0x1d]` (old online) (0x100044fa5..0x100044fbc), then updates `Device{battery, isonline}` → **battery = r[1], is_online = (r[2]==0)**.
* **FD `fd_24_check_is24::{{closure}}` 0x100048350**: only when `ble == None && dangle_common == None && dev_type == Normal` (`cmp BYTE [r12+0x3c],2 / [r12+0x3b],2 / [r12+0x3a],1` at 0x100048430..0x10004844e); frame byte 0x1005169d3 = `FD`, NONE; reply `cmp BYTE [r13+0x1],0x55` (0x100048762) ⇒ is24; cached in `Mutex<Option<bool>>` at `self+0x88` (`[+0x90]` Some flag, `[+0x91]` value).
* **FE `fe_24_set_next_pack_length::{{closure}}` 0x1000c36b0**: `[rbx+0x10]=0xfe ; [rbx+0x11]=len ; len 2 ; WORD [rbx+0xd1]=0x200 (NONE)` (0x1000c36e5..0x1000c36ff) → `send_feature` (0x1000c3713) → sleep 10 ms (0x1000c375e).
* **`dangle_common_get_dev_id::{{closure}}` 0x1000c5370**: `fe_24_set_next_pack_length(0x40)` (`WORD [rbx+0x28]=0x40`, 0x1000c53c4) → `dangle_common_send_read_msg([0x8F] (byte at 0x10051aecb), sel=[rbx+0x11], cs=0 BIT7)` (0x1000c547b) → reply `r`: `cmp rsi,4; jbe fail` (needs ≥5), `BytesMut::from(&r[1..5])` (0x1000c54ec..0x1000c54fb), `or BYTE PTR [rax+0x3],0x80` (0x1000c5512), `r15d = DWORD [rax]` (LE u32, 0x1000c5528) → `id = (r[1] | r[2]<<8 | r[3]<<16 | (r[4]|0x80)<<24)`.
* **`DJDevice::send_dangle_common_msg::{{closure}}` 0x1000c3c10**: `pasue24loop` (0x1000c3c73); counter `[r14+0x50]` ≤ 15 (`cmp eax,0xf` 0x1000c3d7c) with `sleep(100 ms)` (0x1000c3d8b) per retry; each try polls F7 (boxed future vtable 0x10063f6f0, 0x1000c3e29) and evaluates `online = (wordA.b2!=None && wordA.b1) || (wordB.b2!=None && wordB.b1)` (0x1000c3e8d..0x1000c3edb; else "dev is not online" 0x1000c3f5f) and `ready = wordA.b2&1 | wordB.b2&1` (0x1000c3edd..0x1000c3ef4): ready → `sleep(1 ms)` (0x1000c3fbe) → `dangle_common_f6_set_device(sel)` (0x1000c406e) → `send_feature(msg, cs=[r14+0x30])` (0x1000c411c); not ready → sleep 100 ms and retry; timeout string "f7 wait write 超时" (0x1000c419a).
* **`DJDevice::dangle_common_send_read_msg::{{closure}}` 0x1000c4d70**: `set_is_reading_or_sending` → `send_dangle_common_msg` (0x1000c4f59) → `sleep(10 ms)` (0x1000c5008) → `read_dangle_common_msg` (0x1000c5055) → `unset_is_reading_or_sending`.
* **`DJDevice::read_dangle_common_msg::{{closure}}` 0x1000c4400**: `pasue24loop` → same F7 online/ready loop (100 ms retries, "dev is not online") → `send_feature([0xFC] (byte 0x10051aeca), NONE)` (0x1000c48b9) → sleep 10 ms (0x1000c490c) → sleep 10 ms (0x1000c4960) → `get_feature`.
* **`pasue24loop`** 0x1000d8230: aborts the running 2.4G poll task (`RawTask::remote_abort` 0x1000d82a2), sets `[dev+0x19]=1` and spawns closure 0x1000490b0 which `tokio::time::sleep(5 s)` (0x1000490ef `esi=5`) then clears the pause (`[r12+0x19]=0`, `[r12+0x18]=1`).
* **`wait_fb_write_finish::{{closure}}`** 0x100048d00: loop `fb_24_check_status` with `sleep(100 ms)` (0x100048d67/0x100048e55) until ready, error "dev is not online" / timeout; then sleep 1 ms.
* **Polling task `handle_dangle_common_24_status::{{closure}}`** 0x1000439f0 (spawned per dongle from `refresh_dev_list` at 0x10003e7dd): top of loop `tokio::time::sleep(2 s)` (0x100043bc5 `esi=2`); `get_wireless_lock_status()` (0x100044d38) → if locked `sleep(2 s)` and loop again (0x100044d4f..); `check_is_msg_sending_or_reading` (0x100043c4f) → busy ⇒ sleep 2 s; else `get_dangle_common_status` (boxed future vtable 0x10063de98, 0x100043d20) → `get_light_type` (0x100043ddf) → `get_status` (0x100043e46) → `get_light(sel 0)` / `get_light(sel 1)` (0x100043f3c / 0x1000440c8) → `set_light_type` (0x1000441fa) → `handle_light` (0x1000442e7) → compare old/new (0x100044317..0x1000443e6) → `broadcast::Sender::send` (0x100044770).
* **Lock**: `LOCK_WIRELESS_LOOP` (0x10067e7d8, `once_cell` `Mutex<bool>`; flag byte at 0x10067e7f0). `change_wireless_loop_status` closure 0x10009c020 sets it from `WirelessLoopStatus.lock`; `get_wireless_lock_status` 0x10008e680 reads it. Readers: `handle_dangle_common_24_status` (0x100044d38), `handle_24_status` (0x100045520), `check_ble_status` (0x100042529) — each just sleeps 2 s and skips the poll while locked. `DJDeviceManger::set_lock_all_dev` 0x100090680 / `DJDevice::set_lock` (sets `[dev+0x80]=1`) are separate (per-device busy lock used by `send_feature`/`get_feature` waits via `[dev+0x81]`).

## Q3. sendRawFeature vs sendMsg, readRawFeature vs readMsg

| | sendMsg | sendRawFeature |
|---|---|---|
| gRPC closure | 0x100096350, `WORD [state+0x138]=0` | 0x1000969b0, `WORD [state+0x138]=1` |
| dispatch | `[vtable+0x50]` `DJDevApi::send_msg` / `DJDangleCommon::send_dangle_common_msg` | `[vtable+0x30]` `Base::pure_send_feature` |
| extras | `set_is_reading_or_sending` + 2 s auto-unset task; keyboard: FD check, 2.4G ⇒ `pasue24loop` + `wait_fb_write_finish` before/after; dongle: F7 online/ready loop + `F6 sel` | none |
| checksum | per `check_sum_type` in `send_feature` | **same** (`pure_send_feature` → `send_feature` with the cs byte) |
| wire | `buf[0..64]` SET_REPORT | identical |

| | readMsg | readRawFeature |
|---|---|---|
| gRPC closure | 0x100096620, `WORD [state+0x140]=0` | 0x100096c80, `=1` |
| dispatch | `[vtable+0x58]` `DJDevApi::read_msg` / `read_dangle_common_msg` | `[vtable+0x38]` `Base::pure_get_feature` → `get_feature` |
| extras | keyboard 2.4G: `pasue24loop`, FB wait, `FC`, 2×10 ms; dongle: F7 loop, `FC`, 2×10 ms | none (only the `[dev+0x81]` busy wait) |
| result | 64 raw bytes | 64 raw bytes |

`dangle_dev_type` is only consulted for dongle devices (`is_mouse = type == 2`); NONE and KEYBOARD both select the keyboard (`F6 0x0A`).

## Q4. watchVender

* `DriverGrpc::watch_vender` closure 0x100095d10 creates an mpsc channel + semaphore and spawns `GrpcServer::start_watch_vender::{{closure}}` 0x100049f50, which calls `DJDeviceManger::get_vender_watcher` 0x10008ffd0 (`broadcast::Sender::subscribe`, 0x100090116) and loops on `broadcast::Receiver::recv` (0x10004a31e), forwarding each received `VenderMsg` to the gRPC stream unchanged (no slicing, no report-id handling in this closure).
* Producers of that broadcast on this build: only the BLE vendor object (`<BleVendor as Vender>::set_sender` 0x1000d48d0 / `get_dev_info`). The TOML `vender` table (`{ usage = 0x1, usage_page = 0xffff, interface_number = 1 }`, `{ vid = 0x3151, pid = 0x4017, usage = 0x1, usage_page = 0xfffe, interface_number = 1 }`) makes those interfaces enumerate as `DJDevType::Vender` (devtype YZWVENDER in the proto), but the binary contains **no `libusb_interrupt_transfer`/`libusb_bulk_transfer` call and no hidapi `read`** in `iot_driver` code (grep over the full `iot_driver` disassembly, 86k lines), and `send_msg_by_dev_path`/`read_msg_by_dev_path` refuse Vender devices ("cant sent/read msg to/from vender"). So on macOS no USB vendor report is ever read or forwarded; `handle_vender::{{closure}}::{{closure}}` 0x100046fc0 only sleeps 5 s (`esi=5`, 0x100046fff) and prunes the vender queue (`Vec::retain` 0x1000471a0). `VenderType` names: `Music1, Music2, Screen, Other`.
* **INFERRED**: on hidapi builds the vender interface would be read with `read_timeout` and the whole report forwarded; not verifiable here.

## Q5. Non-dongle `get_24_status` / `handle_24_status`

* `DJDevApi::get_24_status::{{closure}}` 0x1000dd800: `fd_24_check_is24` (0x1000dd885; FD only for `ble == None && dangle_common == None && dev_type == Normal`, result cached) → if 2.4G: `fb_24_check_status` (0x1000dda19) → result `{is24, packed}` where packed = `battery (r[1]) | (r[0]==1)<<32 | (r[2]==0)<<40 | (r[3]==1)<<48` (0x1000ddbef..0x1000ddbf3).
* `handle_24_status::{{closure}}` 0x100044ed0 (one task per 2.4G keyboard): each loop checks `get_wireless_lock_status` (0x100045520; locked ⇒ `sleep(2 s)` and retry), polls `get_24_status` (`[vtable+0x68]`, 0x100044f41), compares `battery` (`DWORD +0x28` vs `+0x18`) and `is_online` (`BYTE +0x2d` vs `+0x1d`) (0x100044fa5..0x100044fbc), stores the new values (0x10004500d..0x10004501d) and on change broadcasts a DeviceList CHANGE (`broadcast::Sender::send` 0x100045233); loop period 2 s (`tokio::time::sleep` with `esi=2`, mirrors the dongle task; the `0x3b9aca00` constant is 1 s in ns used by `Duration` math).

## Appendix — embedded config (verbatim excerpts, `__TEXT,__const`)

Support table (TOML, 235 rows at 0x10051dff9…; `SupportDev{vid,pid,usage,usage_page,interface_number,report_id?,dongle_common?,ble?,libusb_index?}`), Monka/RY vid 0x3151 rows of interest:
```
{ vid = 0x3151, pid = 0x4010, usage = 0x2, usage_page = 0xffff, interface_number = 2 },
{ vid = 0x3151, pid = 0x4011, usage = 0x2, usage_page = 0xffff, interface_number = 2, dongle_common = true },   # A75 2.4G dongle
{ vid = 0x3151, pid = 0x4012, usage = 0x202, usage_page = 0xff66, interface_number = -1, ble = true },
{ vid = 0x3151, pid = 0x4013, usage = 0x202, usage_page = 0xff55, interface_number = -1, ble = true },
{ vid = 0x3151, pid = 0x4014, usage = 0x2, usage_page = 0xffff, interface_number = 2, dongle_common = true },
{ vid = 0x3151, pid = 0x4015, usage = 0x2, usage_page = 0xffff, interface_number = 2 },
{ vid = 0x3151, pid = 0x4017, usage = 0x2, usage_page = 0xffff, interface_number = 2, dongle_common = true },
...
{ vid = 0x3151, pid = 0x503A, usage = 0x2, usage_page = 0xffff, interface_number = 2, libusb_index = 2 },
```
`boot = [ { vid = 0x0461, pid = 0x4001, usage = 0x1, usage_page = 0xff01, interface_number = -1 }, … ]` (dev_type YZWBoot, `ble`/`dangle_common` forced to None).
`vender = [ { usage = 0x1, usage_page = 0xffff, interface_number = 1 }, { vid = 0x3151, pid = 0x4017, usage = 0x1, usage_page = 0xfffe, interface_number = 1 } ]`.

Command list (`YZW_CMD_LIST`, text at 0x10051db3c):
```
FEA_CMD_SET_REV = 0x00      FEA_CMD_GET_REV = 0x80
FEA_CMD_GET_INFOR = 0x8F    FEA_CMD_SET_RESERT = 0x02
FEA_CMD_GET_BATTERY = 0x83  FEA_CMD_SET_REPORT = 0x04     FEA_CMD_GET_REPORT = 0x84
FEA_CMD_SET_PROFILE = 0x05  FEA_CMD_GET_PROFILE = 0x85
FEA_CMD_SET_KBOPTION = 0x06 FEA_CMD_GET_KBOPTION = 0x86
FEA_CMD_SET_LEDPARAM = 0x07 FEA_CMD_GET_LEDPARAM = 0x87
FEA_CMD_SET_SLEDPARAM = 0x08 FEA_CMD_GET_SLEDPARAM = 0x88
FEA_CMD_SET_KEYMATRIX = 0x09 FEA_CMD_GET_KEYMATRIX = 0x89
FEA_CMD_SET_KEYENABLE = 0x0A FEA_CMD_GET_KEYENABLE = 0x8A
FEA_CMD_SET_MACRO = 0x0B    FEA_CMD_GET_MACRO = 0x8B
FEA_CMD_SET_USERPIC = 0x0C  FEA_CMD_GET_USERPIC = 0x8C
FEA_CMD_SET_AUDIO = 0x0D    FEA_CMD_SET_WINDOS = 0x0E
```
Dongle/2.4G housekeeping bytes (not in the list, hard-coded): `F6 sel`, `F7`, `FB`, `FC`, `FD`, `FE len`.

## Worked example (Monka A75 over its 2.4G dongle, vid 0x3151 pid 0x4011)

`SendMsg{msg=[0x83,0,…(64)], check_sum_type=BIT7, dangle_dev_type=KEYBOARD}`:
1. F7 poll until keyboard online+ready (≤15×100 ms), `F6 0A` if the dongle's cached selection differs, 10 ms.
2. Frame = msg padded to 66, `buf[7] = ~(0x83+0+0+0+0+0+0) = 0x7C`; SET_REPORT of `buf[0..64]` = `83 00 00 00 00 00 00 7C 00 …` on interface 2.
3. `ReadMsg` → F7 loop, `FC`, 20 ms, GET_REPORT 64 bytes → `ResRead.msg = [0x83, …]` (byte 0 is the command echo as returned by the keyboard).
