# iot_driver_mac protocol reverse engineering

Status: in progress. Binary: `iot_driver_mac` (Mach-O x86_64, PIE base 0x100000000, full Rust symbols).
Everything below was read from the disassembly unless marked **INFERRED**.

## Summary

(in progress — see per-question sections; summary written last)

## Q1. Checksum / framing (sendMsg / readMsg)

### Transport on this (macOS) build
* The keyboard/dongle HID path is **libusb**, not hidapi: `HidLibusb::send_feature` (0x100116a70) does
  `libusb_control_transfer(h, bmRequestType=0x21, bRequest=0x09 (SET_REPORT), wValue=0x0300 (Feature, report id 0), wIndex=interface_number (DJDeviceInfo+0x38), data=buf, wLength=0x40, timeout=2000 ms)`
  and requires `buf.len() >= 64` (`cmp r13,0x3f; jbe slice_end_index_len_fail(0x40)`), i.e. it sends **exactly `buf[0..64]`, no report-id byte**.
  `HidLibusb::get_feature` (0x100116c90) does `BytesMut::resize(64)` then `libusb_control_transfer(0xa1, 0x01 (GET_REPORT), 0x0300, interface, buf, 64, 2000ms)` and returns the 64-byte buffer as `Bytes` (no stripping).
* hidapi (`HidDevice::write` / `read_timeout`) is only used by `HidBLE` (BLE path); `send_feature_report` does not exist in this binary. The "[0x00]+data / 65 byte" behaviour from earlier RE applies to the hidapi builds, not to this libusb build.

### Where the checksum is computed: `DJDevice::send_feature::{{closure}}` (0x1000474b0, dup 0x1000c2fb0/0x1000d6680/0x100117bb0)
Inputs in the async state: data ptr/len at `[state+0x10/0x18]`, `check_sum_type` byte at `[state+0xba]` (copied to `+0xb8`), `self` (DJDevice) at `[state+0xb0]`.
```
100047646  BytesMut::new()                      ; [rbp-0x48]
100047666  put_slice(data, len)                 ; buf = msg
10004767a  mov esi,0x42 ; BytesMut::resize(66, 0)   ; buf = msg padded with 0x00 to 66 bytes (then only buf[0..64] goes on the wire)
100047686  movzx eax,[rbx+0xb8]   ; check_sum_type
10004768d  cmp eax,2 ; je send    ; NONE (2): no checksum
100047696  cmp eax,1 ; jne BIT7   ; BIT8 (1) / BIT7 (0)
1000476a3/1000476c6  al = [self+0x3c]  ; DJDeviceInfo.dev_type (DJDevType: 0=Vender, 1=Normal, 2=YZWBoot — names from the Debug fmt table at 0x100516b60)
```
Checksum arithmetic (all cases): 8-bit wrapping sum of the covered bytes, then bitwise NOT (`add dl,...; not dl`), stored as one byte.

| check_sum_type | dev_type Normal(1)/Vender(0) | dev_type YZWBoot(2) |
|---|---|---|
| BIT7 (0) | `buf[8] = ~(buf[1]+buf[2]+...+buf[7])` (7 bytes, idx 1..7) — code at 0x10004772d..0x100047782 | `buf[7] = ~(buf[0]+...+buf[6])` (idx 0..6) — 0x1000476ce..0x100047764 |
| BIT8 (1) | `buf[9] = ~(buf[1]+...+buf[8])` (8 bytes, idx 1..8) — 0x1000476e1..0x100047773 | `buf[8] = ~(buf[0]+...+buf[7])` (idx 0..7) — 0x1000476ab..0x100047782 |
| NONE (2) | nothing | nothing |

Nothing else in the frame is modified. The wire frame is `buf[0..64]` (byte 0 = `msg[0]` = command byte; the padding bytes are 0x00). `send_feature` then calls `HidSender::send_feature` (vtable slot +0x18 of `[self+0x40]`), and on error calls `DJDeviceManger::clean_dev` + `clean_all_vendor`.
Before sending it spins while `[self+0x81]` (a "busy" flag) is set, sleeping 10 ms per iteration (`[rbx+0x28]=0xa; sleep::{{closure}}`).

So for a keyboard (dev_type Normal) and a 64-byte front-end msg `[cmd, p1..]`: BIT7 ⇒ `msg[8] = ~(msg[1]+…+msg[7])`, BIT8 ⇒ `msg[9] = ~(msg[1]+…+msg[8])` — the command byte at index 0 is NOT covered. **INFERRED**: "BIT7/BIT8" names the number of payload bytes after the command byte that are summed.

### Call chain for `SendMsg` (gRPC) → wire
* `DriverGrpc::send_msg` closure (0x100096350) copies the request into the `send_msg_by_dev_path` state and sets `WORD [state+0x138] = 0` (raw=false); `send_raw_feature` (0x1000969b0) is identical except `WORD [state+0x138] = 1` (raw=true).
* `GrpcServer::send_msg_by_dev_path::{{closure}}` (0x100093a80): `get_dev_from_path` → match on device kind (jump table 0x1000949a0):
  * raw: `call [vtable+0x30]` = `Base::pure_send_feature(dev, msg_ptr, msg_len, check_sum_type)` (0x10009419d).
  * Device (keyboard), not raw: `set_is_reading_or_sending(dev, msg.to_vec(), timestamp)`, spawn a 2 s timeout task (closure 0x10004c2e0: `tokio::time::sleep(2 s)` then `unset_is_reading_or_sending`), then `call [vtable+0x50]` = `DJDevApi::send_msg(dev, msg_ptr, msg_len, check_sum_type)` (0x1000945ef).
  * DangleCommon, not raw: same bookkeeping, then `call [vtable+0x50]` = `DJDangleCommon::send_dangle_common_msg(dev, msg_ptr, msg_len, is_mouse = (dangle_dev_type == 2), check_sum_type)` (0x100094478..0x100094485: `cmp DWORD [rbx+0x74],2; sete cl`).
  * Vender devices: error string "cant sent msg to vender".
* vtables: DJDevApi (YZWKeyboard) @0x100637248: +0x18 get_dev, +0x20 set_lock, +0x28 get_is_lock, +0x30 pure_send_feature, +0x38 pure_get_feature, +0x48 get_cmd_list, +0x50 send_msg, +0x58 read_msg, +0x60 send_read_msg, +0x68 get_24_status, +0x70 get_id, +0x78 get_light, +0x80 set_screen, +0x88 set_music, +0x90 check_light_type. DJDangleCommon (YZWDangleCommon) @0x100636e40: +0x30 pure_send_feature, +0x38 pure_get_feature, +0x40 get_cmd_list, +0x48 get_status, +0x50 send_dangle_common_msg, +0x58 read_dangle_common_msg, +0x60 get_dangle_common_status, +0x68 get_light, +0x70 set_screen, +0x78 set_music, +0x80 check_light_type, +0x88 set_light_type, +0x90 get_light_type.
* `DJDevApi::send_msg` (0x10011d910) → `DJDevice::send_msg::{{closure}}` (0x1001198f0): `fd_24_check_is24` → if 2.4G: `pasue24loop` + `wait_fb_write_finish` (error "fb wait write 超时"); then `send_feature(msg, cs)`; then `fd_24_check_is24` again and if 2.4G `wait_fb_write_finish` again. No byte manipulation of msg here.
* `Base::pure_send_feature::{{closure}}` (0x1000c92e0) → `send_feature(msg, cs)` directly (checksum IS still applied per `check_sum_type`; only the 2.4G waits / busy bookkeeping are skipped).

### Read side (`ReadMsg` / `ReadRawFeature`)
* `DriverGrpc::read_msg` (0x100096620) sets `WORD [state+0x140] = 0`, `read_raw_feature` (0x100096c80) sets `= 1`, both call `read_msg_by_dev_path::{{closure}}` (0x100092d90): raw → `[vtable+0x38]` = `pure_get_feature`; non-raw → `[vtable+0x58]` = `DJDevApi::read_msg` / `DJDangleCommon::read_dangle_common_msg`. Vender devices → "cant read msg from vender".
* `DJDevice::get_feature::{{closure}}` (0x100047930): waits while `[self+0x81]` busy (10 ms sleeps), then `HidSender::get_feature` (vtable +0x20) and returns the `Bytes` unchanged → **64 bytes, byte 0 = command echo, nothing stripped, no checksum validation**.
* `DJDevice::read_msg::{{closure}}` (0x100119ea0): `fd_24_check_is24`; non-2.4G → straight to `get_feature`. 2.4G → `pasue24loop`, loop `fb_24_check_status` (10 ms sleeps, error "read fb 超时" / "dev is not online"), then `send_feature([0xFC], NONE)` (1 byte at 0x10051de9f), sleep 10 ms, sleep 10 ms, `get_feature`.
* ResRead.msg = those 64 bytes as-is.

## Q2. Dongle (DangleCommon) protocol

(in progress)

## Q3. sendRawFeature vs sendMsg, readRawFeature vs readMsg

(in progress — see Q1 call chain: raw = `pure_send_feature`/`pure_get_feature`, checksum still applied on send)

## Q4. watchVender

(in progress)

## Q5. Non-dongle get_24_status / handle_24_status

(in progress)
