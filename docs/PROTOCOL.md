# Nano Cortex Bluetooth protocol, as NanoGig uses it

Everything here is **provisional**: reverse-engineered, verified on NanOS 2.2.1 hardware
(September 2026) unless noted, and liable to change silently with a firmware update. NanoGig
fails soft: unknown payloads are logged in hex and ignored.

The ground work comes from [choldy/nano-cortex-web-editor](https://github.com/choldy/nano-cortex-web-editor)
and the specification in [rixrix/deskop-nano-cortex](https://github.com/rixrix/deskop-nano-cortex)
(`docs/specs/110-backend-midi-ble/spec.md`). What NanoGig added is marked **new**.

## GATT

- Device name `Neural DSP Nano Cortex`. Service `a002`; characteristics `c302` (MIDI write,
  rejects everything on 2.2.1), `c303` (write-no-response, accepted but ignored), `c304`
  (command write), `c305` (notify: replies and live events), `c306` (indicate: duplicate of
  c305, deduplicated by the app), `c307` (read). Service `a003` with `c400`/`c401` (read).
- The pedal accepts one BLE client. Cortex Cloud must be disconnected first.
- The pedal does **not** advertise the standard Bluetooth-MIDI service, so no OS-level
  Bluetooth MIDI pairing exists.
- Bluefy on iPadOS enumerates characteristics with empty `uuid` strings; NanoGig falls back
  to `getPrimaryService(a002)` + `getCharacteristic(uuid)` lookups (2026-09-13).

## Framing (new)

Every c305 packet starts with a little-endian u16 header: bits 0-13 = body length
(packet length − 2), bit 14 = START of message, bit 15 = END of message.

| Header  | Meaning                         |
| ------- | ------------------------------- |
| `FE 41` | 510-byte body, START            |
| `FE 01` | 510-byte body, continuation     |
| `0A 81` | 10-byte body, END               |
| `FD C1` | 509-byte body, START+END (single) |

Bodies end with a 4-byte trailer `<msgType> 00 00 00`. Messages complete on END; a 2.5 s
inactivity timer is the fallback. The reference projects' "FE/FD/CE/D0 stream start bytes"
are simply the length bytes of MTU-sized packets.

## Requests (c304)

| Purpose             | Frame                                        | Reply                                              |
| ------------------- | -------------------------------------------- | -------------------------------------------------- |
| Metadata dump       | `06 C0 08 03 01 00 00 00`                    | ~17 KB message over ~6 s, type `0x02`             |
| Current state       | `0C C0 08 03 18 01 20 01 28 01 01 00 00 00`  | ~300-500 B message, type `0x02`                   |
| Preset-change ack   | `06 C0 20 01 1E 00 00 00`                    | sent after a MIDI Program Change                   |
| Device settings     | `06 C0 08 03 41 00 00 00`                    | 60 B single packet, type `0x42` (new, 2026-09-15) |

NanoGig streams the metadata dump only on the first ever connect. Afterwards the names come
from a localStorage cache at connect and the small state dump makes the screen live. The
pedal sends notifications in order, so while it streams the ~17 KB dump every footswitch
event queues behind it (~6 s with nothing on screen reacting); the dump is therefore re-read
only when the state dump contradicts the cache (the active preset's capture / IR differ from
its cached record), once per connect after the pedal has been idle for a minute (setting, on
by default), or on Menu → Refresh names. The state embedded in a metadata reply is as old as
the request and is ignored on a live link; a fresh state dump follows.

## Metadata message

The full state message plus: field 17 = captures (25), field 18 = 64 preset records
`{1:name, 7:captureName, 8:captureId, 9:irShort, 10:irFull}`, field 19 = user IR slots (5)
`{1:short, 3:full}`. Preset names are at most 20 characters (Cortex Cloud limit).

Factory cabs (e.g. `110 US PRN C10R`) are **not** IR slots; a preset's IR full name carries the
mic and position as a path (`110 US PRN C10R/Ribbon 160/3`).

## Current-state message (type `0x02`)

| Field | Meaning                                                                                       |
| ----- | --------------------------------------------------------------------------------------------- |
| 3-7   | Amp gain / level / bass / mid / treble (raw 0-255)                                            |
| 11    | **Capture position within the bank: 0 or absent = capture bypassed** (web-editor rule)        |
| 12    | Present = cab on                                                                              |
| 13    | **Active preset index 0-63 (new)**                                                            |
| 14/15/38/39 | Footswitch assignments (IA, IB, IIA, IIB)                                                |
| 24    | Firmware version string                                                                       |
| 31    | 5-byte bypass array `[pre1, pre2, post1, post2, post3]`, `0` = on                             |
| 32    | Capture sub-message `{1:flag, 2:name, 3:id}`. **Flag 1 is not the bypass state** (seen 1 after a bypass and 0 with position 4) |
| 33    | IR sub-message `{1:flag, 2:shortName, 3:fullName}`                                           |
| 46    | Tuner reference (fixed32 float, 440.0)                                                        |
| 48-52 | FX model IDs (raw bytes or varints) for pre1 … post3, mapped through the model catalogue      |
| 54    | Gate: present = gate off (inverted)                                                           |
| 56    | **Tempo in BPM, fixed32 float (new; confirmed 2026-09-14, follows tap tempo live)**           |

If field 13 were ever missing, the app falls back to a unique capture + IR name match against
the preset list, tagged **inferred** on screen.

## Device settings message (type `0x42`, new)

Captured 2026-09-15 from an Android HCI snoop log of Cortex Cloud, which sends the request at
connect and whenever its device-settings page opens. NanoGig requests it once per link after
the first state dump and prints every field to the log.

Seen on 2.2.1: `3A C0 08 01 18 01 2A 16 "Neural DSP Nano Cortex" 30 38 38 01 40 01 58 00 60 01
68 6B 70 01 80 01 01 8D 01 <f32 -6.0> 90 01 01 42 00 00 00` → fields 1=1, 3=1, 5=name, 6=56,
7=1, 8=1, 11=0, 12=1, 13=107, 14=1, 16=1, 17=-6.0 (fixed32 float), 18=1.

**Field 16 = outputs 1/2 muted**: `1` while muted, absent (57-byte reply) while the outputs
are on. The field mirrors the last `68 <v>` write exactly (before/after pair in NanoGig's own
log, 2026-09-15), so it confirms the write landed but cannot settle the polarity by itself;
that was done by ear. The other fields are still unmapped. NanoGig re-reads the message after
every mute ack to confirm the switch against the pedal's report.

## Live events (single-packet messages, by trailer type)

| Type   | Meaning                                                                                              | NanoGig reaction                       |
| ------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `0x1D` | Preset changed: `10 C0 08 01 20 <preset> 28 <IA> 30 <IB> 38 <IIA> 40 <IIB> 1D 00 00 00` (new)         | update preset immediately, re-read state |
| `0x1F` | Bypass changed                                                                                       | re-read state                          |
| `0x1C` | Footswitch encoder turned (capture / cab scrolling), same `18 <sel> 20 <val>` shape as slot writes   | debounced re-read (~400 ms)            |
| `0x1A` | Knob (also tap tempo)                                                                                | debounced re-read (~400 ms)            |
| `0x40` | Expression pedal (quantised heel / centre / toe)                                                     | ignored                                |
| `0x73` | Generic "something changed" notice; also the ack to capture / cab slot writes                         | debounced re-read                      |
| `0x42` | Device-settings reply (see above)                                                                    | log the fields                         |
| `0x44` | Ack to the outputs-mute write: `08 C0 08 01 18 01 44 00 00 00`, within ~100 ms                       | confirm the switch, re-read settings   |

## Writes (control mode, c304)

| Action                     | Frame                                            | Verified   |
| -------------------------- | ------------------------------------------------ | ---------- |
| FX block on/off            | `0A C0 08 01 18 <slot 4..8> 20 <0 on / 1 off> 1F 00 00 00` | 2026-09-12 |
| Gate on/off                | `0A C0 08 01 18 09 20 <0 on / 1 off> 1F 00 00 00` | 2026-09-12 |
| Capture bypass             | `08 C0 18 01 20 00 1C 00 00 00`                  | 2026-09-13 |
| Capture select (re-enable) | `08 C0 18 04 20 <slot-1> 1C 00 00 00` (slot 1-25) | 2026-09-13 |
| Cab bypass                 | `08 C0 18 03 20 00 1C 00 00 00`                  | 2026-09-13 |
| Cab / IR slot select       | `08 C0 18 03 20 <slot 1..5> 1C 00 00 00`         | 2026-09-13 |
| Mute outputs 1/2 (global)  | `08 C0 08 01 68 <1 mute / 0 outputs on> 43 00 00 00` | 2026-09-15 (captured from Cortex Cloud, polarity by ear) |

Re-enabling a capture or cab needs its slot index, which NanoGig can only get by matching the
current name against the metadata slot lists. When there is no match (factory cab, library
capture, or an empty preset) the label shows a lock and the toggle is refused both ways, so the
app never bypasses something it could not bring back.

## Preset switching

MIDI Program Changes written to `c302` / `c303` (raw or Bluetooth-MIDI framed) do **not**
switch presets on NanOS 2.2.1. The verified path is **Web MIDI over USB**: the pedal exposes a
MIDI port named "Nano Cortex"; a Program Change there switches presets while Bluetooth keeps
serving the display. The app tries Web MIDI first, then the BLE variants from the rixrix probe,
confirms each against the pedal's own report (event `0x1D` or dump field 13) and remembers
what worked for the session. `?midi=<id>` pins one strategy: `web-midi`, `c303-ble-midi`,
`c302-ble-midi`, `c303-raw`, `c303-sequential`, `c302-raw`.

## Fixtures

Real packets from the hardware sessions live in `src/fixtures/hardware-2026-09-12.ts` and
`src/fixtures/captures.ts` and are asserted byte-for-byte in `tests/`.
