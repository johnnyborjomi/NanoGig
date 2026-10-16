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
  c305; not subscribed any more, see "Tuner"), `c307` (read). Service `a003` with `c400`/`c401` (read).
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
| Preset-change ack   | `06 C0 20 01 1E 00 00 00`                    | sent after a MIDI Program Change (USB path only)   |
| Device settings     | `06 C0 08 03 41 00 00 00`                    | 60 B single packet, type `0x42` (new, 2026-09-15) |

NanoGig streams the metadata dump only on the first ever connect. Afterwards the names come
from a localStorage cache at connect and the small state dump makes the screen live. The
pedal sends notifications in order, so while it streams the ~17 KB dump every footswitch
event queues behind it (~6 s with nothing on screen reacting); the dump is therefore re-read
only when the state dump contradicts the cache (the active preset's capture / IR differ from
its cached record), once per connect after the pedal has been idle for a minute (setting, on
by default), or on Menu → Refresh. The state embedded in a metadata reply is as old as
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
| 13    | **Active preset index 0-63 (new)**; absent on preset 1 (zero-valued fields are omitted)      |
| 14/15/38/39 | Footswitch assignments (IA, IB, IIA, IIB)                                                |
| 24    | Firmware version string                                                                       |
| 31    | 5-byte bypass array `[pre1, pre2, post1, post2, post3]`, `0` = on                             |
| 32    | Capture sub-message `{1:flag, 2:name, 3:id}`. **Flag 1 is not the bypass state** (seen 1 after a bypass and 0 with position 4) |
| 33    | IR sub-message `{1:flag, 2:shortName, 3:fullName}`                                           |
| 46    | Tuner reference (fixed32 float, 440.0)                                                        |
| 48-52 | FX model IDs (raw bytes or varints) for pre1 … post3, mapped through the model catalogue      |
| 54    | Gate: present = gate off (inverted)                                                           |
| 56    | **Tempo in BPM, fixed32 float (new; confirmed 2026-09-14, follows tap tempo live)**           |
| 60    | **Present (= 1) while the pedal is in its tap tempo mode** (screen firmware 2026-09-26)       |

**Zero-valued varints are omitted** (proto3 default semantics; confirmed 2026-09-26 with a dump
on preset 1 that has no field 13 at all, and the same for footswitch fields 14/15/38/39 and the
`0x1D` event's field 4). NanoGig therefore reads an absent field 13 as preset 1. Until v1.0.5
it read it as "unknown" and fell back to a capture + IR name match, which failed whenever two
presets shared a capture, leaving "Tap a footswitch to sync" on screen and, for an app-driven
switch to preset 1, an unconfirmed Bluetooth select followed by every MIDI fallback. The name
match remains only as a last resort for a dump without a state at all.

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
that was done by ear. NanoGig re-reads the message after every mute ack to confirm the switch
against the pedal's report.

More fields (2026-10-13; protocol names in brackets, not yet used here):

| Field | Meaning |
| --- | --- |
| 8 | MIDI channel 1..16 (omitted = 1) |
| 15 | Guitar input muted, Cortex Cloud's "Mute Guitar Input" (`muteIn1`; omitted = not muted) |
| 16 | Guitar output muted, "Mute Guitar Output" (`muteProcessingChain`): no guitar at the output jacks, the USB sound stays. The "outputs 1/2" switch above |
| 17 | USB playback volume in dB, f32 (`usbReturnGain`; how loud the computer's sound is mixed in; omitted = 0 dB). Read only so far: no write seen |

Writes are type `0x43` (UpdateSettings), one setting per frame, a 0 written out; the reply field is the write
field + 3. Field 12 = mute input, field 13 = mute output: the short form `06 C0 60 <1 / 0> 43 00 00 00` and
`06 C0 68 <1 / 0> 43 00 00 00` works; Cortex Cloud adds `08 01` (ours, above). The `0x44` reply's field 3 = 1 confirms.

## Live events (single-packet messages, by trailer type)

| Type   | Meaning                                                                                              | NanoGig reaction                       |
| ------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `0x1D` | Preset changed: `10 C0 08 01 20 <preset> 28 <IA> 30 <IB> 38 <IIA> 40 <IIB> 1D 00 00 00` (new)         | update preset immediately, re-read state |
| `0x1F` | Bypass changed (names no block)                                                                      | re-read state at once, no debounce     |
| `0x1C` | Footswitch encoder turned (capture / cab scrolling), same `18 <sel> 20 <val>` shape as slot writes: sel 4 = capture slot (0-based), 3 = IR slot (1-based, 0 = cab off), 1 with 0 = capture off | name shown from the cached lists at once, debounced re-read (~400 ms) confirms |
| `0x1A` | Knob (also tap tempo)                                                                                | debounced re-read (~400 ms)            |
| `0x40` | Expression pedal position: `0B C0 08 01 18 02 20 <0–254> 40 00 00 00`, field 4 absent at heel; ~20/s while moving | side bar                    |
| `0xAA` | Values the expression produced for its assigned slots (see "Expression pedal")                        | EXP badge fill on the tile             |
| `0x3D` | Reply to our expression-assignments request (see "Expression pedal")                                 | EXP badges                             |
| `0x73` | The shown preset's unsaved changes (the save light): field 3 = 1 on, absent off. Off after a footswitch press, on as the ack to capture / cab slot writes (`DIRTY_CHANGED`) | Save / Discard in Edit mode; debounced re-read |
| `0x42` | Device-settings reply (see above)                                                                    | log the fields                         |
| `0x44` | Ack to the outputs-mute write: `08 C0 08 01 18 01 44 00 00 00`, within ~100 ms                       | confirm the switch, re-read settings   |
| `0x1E` | Ack to the c304 preset select: `08 C0 08 01 20 01 1E 00 00 00`, after a `0x1F` notice               | send the newest pending select, else re-read state (field 13 confirms) |
| `0x80` | Tuner pitch reading, ~30/s while the tuner is on and a note sounds (see "Tuner")                     | tuner overlay (note, cents, in tune)   |
| `0x91` | Tap tempo: one per tap with the running BPM, one more on leaving the mode (see "Tap tempo")          | tempo badge live, re-read on exit      |

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
| Preset select              | `36 C0 18 00 20 <preset> 28 <-1> 30 <-1> 38 <-1> 40 <-1> 48 04 1D 00 00 00`, `<-1>` = `FF FF FF FF FF FF FF FF FF 01` | 2026-09-19 (captured from Cortex Cloud, verified on the pedal) |
| Tuner on                   | `0F C0 20 01 2D <f32 reference Hz> 30 01 38 <0 / 1 mute> 7F 00 00 00` | 2026-09-19 (captured from Cortex Cloud), verified on the pedal 2026-09-20 |
| Tuner off                  | `06 C0 20 00 7F 00 00 00`                        | 2026-09-19 (captured) |
| Tempo set (enters tap tempo mode) | `0D C0 08 01 18 01 2D <f32 BPM> 91 00 00 00` | 2026-09-26 (found by trial with the NanoGig Screen firmware) |
| Leave tap tempo mode       | `0B C0 08 01 2D <f32 BPM> 91 00 00 00`           | 2026-09-26 (same) |

Re-enabling a capture or cab needs its slot index, which NanoGig can only get by matching the
current name against the metadata slot lists. When there is no match (factory cab, library
capture, or an empty preset) the label shows a lock and the toggle is refused both ways, so the
app never bypasses something it could not bring back.

## Preset switching

**Over Bluetooth (Cortex Cloud's path, captured 2026-09-19 from an Android HCI snoop log of
Cortex Cloud clicking presets 1–10):** a type-`0x1D` message — the same type as the pedal's
preset-changed event, in the other direction — written to `c304` with response:

```
36 C0 18 00 20 <preset> 28 <-1> 30 <-1> 38 <-1> 40 <-1> 48 04 1D 00 00 00
```

Field 3 = 0, field 4 = preset index 0–63, fields 5–8 = footswitch IA/IB/IIA/IIB assignments
as `-1` (the 10-byte varint `FF FF FF FF FF FF FF FF FF 01`, i.e. leave unchanged), field 9 = 4.
Cortex Cloud sent 4 in eight of ten writes and 0 / 1 once each; it matches neither the index nor
dump field 9, so it is treated as a client-side value and always sent as 4. Within ~100 ms of
the write response the pedal sends `06 C0 08 01 1F 00 00 00` (bypass-changed notice) and
`08 C0 08 01 20 01 1E 00 00 00` (ack); Cortex Cloud then requests the state, whose field 13
carries the new index. No `0x1D` event is sent for app-initiated switches. NanoGig sends no ack
frame on this path.

**Fallbacks:** MIDI Program Changes written to `c302` / `c303` (raw or Bluetooth-MIDI framed)
do **not** switch presets on NanOS 2.2.1. **Web MIDI over USB** does: the pedal exposes a MIDI
port named "Nano Cortex"; a Program Change there switches presets (verified 2026-09-12). The
app tries the `c304` select first, then Web MIDI, then the BLE-MIDI variants from the rixrix
probe, confirms each against the pedal's own report (event `0x1D` or dump field 13) and
remembers what worked for the session. `?midi=<id>` pins one strategy: `c304-select`,
`web-midi`, `c303-ble-midi`, `c302-ble-midi`, `c303-raw`, `c303-sequential`, `c302-raw`.

## Tuner

Captured 2026-09-19 from an Android HCI snoop log of Cortex Cloud's tuner page (all six
strings plucked, the tuner's mute switch toggled, the reference slider dragged 440 → 462 → 440).

**Tuner on** (type `0x7F`), written to `c304` when the page opens and again on every slider
step and every mute toggle:

```
0F C0 20 01 2D <f32 reference Hz> 30 01 38 <mute> 7F 00 00 00
```

Field 4 = 1 (on), field 5 = reference pitch as a little-endian float (`00 00 DC 43` = 440.0;
the slider went up to `00 00 E7 43` = 462.0), field 6 = 1 (constant, meaning unknown), field 7
= the tuner's own mute switch. The first write of the session carried 0 and the user's toggles
alternated 1 / 0 from there, so 1 = outputs muted while tuning is the working assumption.
**Field 6** (`30 01`) is a constant 1 in every capture. Tried with 0 on the pedal (2026-09-24):
acked and streamed exactly the same, and the pedal still showed its tuner screen. There is no
known way to get pitch readings without the pedal being in tuner mode, which is why the app's
live tuner is passive (see README).

**Tuner off**: `06 C0 20 00 7F 00 00 00` (field 4 = 0), written when the page closes.
The pedal replies to tuner-on with the same type back, `0D C0 08 01 20 01 2D <f32 Hz> 7F 00 00
00` (field 4 = 1, field 5 = the reference it took), about 1.6 s later on 2.2.1; nothing else
changes. The pedal sends the same report when its tuner ends on the pedal itself (a footswitch
tap, captured 2026-09-24): `0B C0 08 01 2D <f32 Hz> 7F 00 00 00`, field 4 absent = off. NanoGig
mirrors these reports into its tuner state (on/off, reference) and also treats any incoming
pitch reading as proof that the tuner is running (ignoring readings still in flight for 500 ms
after its own tuner-off write). A tuner already running on the pedal streams to a fresh
subscriber, so reconnecting shows it. A tuner started on the pedal mid-link (footswitch) is
announced to the connected client as well (screen firmware 2026-09-26: the screen follows it).

**Subscribe to `c305` only.** Cortex Cloud never enables `c306`, the *indicate* mirror. With both
subscribed the pitch stream lagged 3–5 s behind the pedal: every indication is acknowledged one
per connection interval (48.75 ms on the user's Pixel), which throttles a 30/s stream. NanoGig
now uses `c306` only when `c305` cannot be subscribed.

**Pitch events** (type `0x80`) stream at roughly 30 per second while a note is detected and
stop in silence:

```
10 C0 08 01 22 01 <note> 2D <f32 cents> 30 01 80 00 00 00           not in tune
12 C0 08 01 22 01 <note> 2D <f32 cents> 30 01 38 01 80 00 00 00     in tune
```

Field 4 = the note name as ASCII (`A` `B` `D` `E` `G` seen; sharps not yet observed, so
whether they arrive as `A#` or `Bb` is unknown), field 5 = deviation in cents (float, negative
= flat; +14.3 on a fresh pluck decaying towards 0), field 6 = 1, field 7 = 1 only when the
pedal judges the note in tune, which in the capture meant |cents| below about 2.

Also seen at connect: Cortex Cloud sends `06 C0 08 03 36 00 00 00` and the pedal answers
`08 C0 08 03 18 01 37 00 00 00` (field 3 = 1). Purpose unknown.

## Tap tempo

Found 2026-09-26 with the NanoGig Screen firmware (same pedal, NanOS 2.2.1), which logs every
event it does not understand. Hold the left footswitch to enter the pedal's tap tempo mode, tap,
hold again to leave.

**Events** (type `0x91`): every tap sends the running tempo with field 3 = 1; leaving the mode
sends the final tempo without field 3:

```
0D C0 08 01 18 01 2D <f32 BPM> 91 00 00 00     tap: field 3 = 1 (mode on), field 5 = BPM
0B C0 08 01 2D <f32 BPM> 91 00 00 00           exit: field 3 absent, final BPM
```

Seen 60–186 BPM. The exit is only sometimes followed by a `0x73` notice, so the tempo is taken
from the message itself and the state is re-read after the exit. Before this, NanoGig relied on
a knob event (`0x1A`) plus a re-read and missed the change whenever the notice did not come.

**Writes**: the per-tap shape written to `c304` sets the tempo *and* puts the pedal into its tap
tempo mode (its screen switches; no ack; the next dump's field 56 confirms). The exit shape
leaves the mode, keeping the tempo given. `SyncEngine.setTempo()` sends both so the pedal ends
up in normal mode with the new tempo. The exit shape on its own does not change the tempo.

**State**: field 60 = 1 while the pedal is in the mode (a connect during it carries the field),
absent otherwise.

**Advertising**: after a disconnect the pedal advertises only for a limited window, and while
it sits in tap tempo mode past that window it does not advertise at all: a client cannot
reconnect until the mode is left on the pedal.

## Expression pedal

Captured 2026-09-19 from an Android HCI snoop log of Cortex Cloud's Expression Pedal page; the
pedal was rocked through an Mvave Chocolate over MIDI, which changes nothing on the Bluetooth side.

**Position** (type `0x40`), about 20 per second while the pedal moves: `0B C0 08 01 18 02 20
<pos> 40 00 00 00`, field 3 = 2 (controller), field 4 = 0–254, omitted at heel (`08 C0 08 01 18
02 40 00 00 00`).

**Values** (type `0xAA`), sent with every position: one varint field per assigned target — the
parameter value after the range is applied (0–255) for ranges, 0/1 for bypasses. Field numbers:
gain 4, bass 5, mid 6, treble 7, pre 1 … post 3 = 9–13, level and input gate amount 8 and 14 (which
is which: see the table below); bypass capture 15, IR 16, pre 1 … post 3 = 17–21, input gate 22. With post 3
assigned 17–130 the values ran 17…129. An empty `06 C0 08 01 AA 00 00 00` follows a preset load
with nothing assigned.

**Assignments are per preset.** Read: `08 C0 08 03 18 <preset> 3C 00 00 00`; reply (type
`0x3D`) `08 01` then one sub-message per assigned target; the pedal acks writes with
`08 C0 08 01 18 01 3F 00 00 00`. Cortex Cloud writes the whole list with type `0x3E` after
`18 <preset>` (an unassigned target is left out). The field numbers below
(2026-10-13) come from an editor that reads, writes and reads back assignments; the reply's field
is the write field − 1 (applied to every target; we saw it with post 3).

| Write field | Target                | Values field |
| ----------- | --------------------- | ------------ |
| 4 5 6 7     | gain bass mid treble  | 4 5 6 7      |
| 8 … 12      | pre 1 pre 2 post 1 post 2 post 3 amount | 9 … 13 |
| 13          | level (capture volume) | 8 or 14 (to test) |
| 21          | input gate amount     | 14 or 8 (to test) |
| 14 15       | capture / IR bypass   | 15 16        |
| 16 … 20     | pre 1 … post 3 bypass | 17 … 21      |
| 22          | input gate bypass     | 22           |

**Not yet tested by us.** Our own reading of the 2026-09-19 "assign everything" capture (preset 6, targets added
in Cortex Cloud's list order) had 13 and 21 swapped (21 = level, 13 = unnamed), and the decoder
(`src/protocol/decode.ts`) still uses that until assignment writes are tried on the pedal.

A range record is `{1: inverted, 2: min, 3: max}`, min / max 0–255 shown as 0–100 % (`08 00 10 00 18 FF 01` =
0–100 %, not inverted). A bypass record holds one of three modes:

| Key | Mode | Inside |
| --- | --- | --- |
| 1 | Heel-Toe | `{1: inverted, 2: switch delay ms}` |
| 2 | Switch | `{1: inverted, 2: latch emulation}` |
| 3 | Stop | `{1: switch delay ms}` |

Zero values are left out of every record. Our 2026-09-19 notes differ here too, untested: `{2: {1:0, 2:0}}`
flipped its values flag at mid-travel (we called it heel-toe), and `{1: {1:0, 2:600}}` and `{3: {1:600}}`
never fired without a toe switch.

NanoGig requests the assignments after every state dump whose preset differs from the last
request, remembers which preset it asked for (the reply carries none), and shows a bar at the
right edge for the position plus an `EXP min–max %` badge with a value fill on each assigned tile.

## Editing (the Edit button: control mode plus the edit sheets)

Ported from the NanoGig Screen firmware (`components/nano_protocol/nano_build.c`, 2026-10-10), where each frame
is byte-exact against a Cortex Cloud Android HCI snoop (2026-10-07 … 10-10) or another open-source controller
and was tried on the user's pedal from the screen. **Not yet tried from this app on a pedal.** Builders:
`src/protocol/edit.ts`, with the firmware's test vectors in `tests/edit.test.ts`. All are live edits (audible, the
preset is only saved by the pedal's save button) except rename / create / delete, which the pedal stores at once.

| Action | Frame | Reply |
| --- | --- | --- |
| FX model | `<len> C0 18 <slot 0..4> 20 <type varint> 88 00 00 00` (type = the varint the dump's model ID spells: `FA2E` = 6010) | state dump confirms |
| FX parameters read | `08 C0 08 03 18 <slot> 89 00 00 00`, on or off alike: Cortex Cloud reads and edits a bypassed block, and rixrix/deskop-nano-cortex reads every slot on each preset load (a crash on a bypassed one was once reported) | `0x8A`: field 4 = every parameter's 0..1 as packed f32, in the model's order (`src/protocol/fx-params.ts`) |
| FX parameter | `0F C0 08 01 18 <slot> 20 <param> 2D <f32 0..1> 63 00 00 00` | — |
| Capture volume | `0A C0 18 0A 20 <raw 0..255> 28 00 1A 00 00 00` (`0B C0` from raw 128) | state field 44 |
| Amp knobs (gain / bass / mid / treble) | `<len> C0 18 <0 gain / 2 bass / 3 mid / 4 treble> 20 <raw 0..255> 28 00 1A 00 00 00`: the capture volume's frame. Shown 0.0..10.0. Tried on the pedal 2026-10-16 | state fields 3, 5, 6, 7 |
| Outputs 1/2 volume (the pedal's LEVEL knob) | the same frame with selector 1. **Global, not part of a preset**: the same on every preset, saved or not, and not heard in the headphones, only at outputs 1/2 (on the pedal, 2026-10-16). Sent whenever connected, as the outputs mute | state field 4 |
| Gate threshold | `<len> C0 18 0B 20 <raw 0..255> 28 00 1A 00 00 00` | state field 53 = f32 raw / 255 |
| Capture slot | `08 C0 18 01 20 <slot 1..5, 6 = the preset's own, 0 = off> 1C 00 00 00`: a position in the bank playing (field 9) | field 11 |
| Capture in another bank | `08 C0 18 04 20 <slot 0..24 over the 5 banks> 1C 00 00 00` ("bank and capture", as Cortex Cloud selects) | field 9 = bank 1..5, field 11 = position |
| IR slot | `08 C0 18 03 20 <slot 1..5, 0 = off> 1C 00 00 00` | field 12 |
| IR settings read | `08 C0 18 <preset 0..63> 20 <field 12 − 1> 5F 00 00 00` (field 3 = the preset: Cortex Cloud's `18 31 20 02` on preset 50, HCI snoop 2026-10-16; the earlier snoops were all on preset 1, so it read as a constant 0, and with 0 the pedal answers about preset 1's IR, whose name the mic write then sent); **not for an IR that is off**: the pedal leaves it unanswered (2026-10-11), so the panel shows what was last read of it | `0x60`: `5 {1 kind, 2 name, 3 position, 4 mic}` factory / `6 {1 kind, 2 name}` user, `7` mics (repeated), `8 {1 level, 2 high pass, 3 low pass (f32), 4 phase}` |
| IR level / high pass / low pass | `09 C0 <2D / 35 / 3D> <f32 0..1> 5E 00 00 00` | — |
| IR phase | `06 C0 40 <1 inverted / 0> 5E 00 00 00` | — |
| IR microphone / position (factory IR) | `<len> C0 1A <n> {08 <kind> 12 <IR name> 18 <position 0..5> 22 <mic>} 5E 00 00 00`, position written even when 0. Byte-exact with Cortex Cloud stepping through all six positions and the mics (HCI snoop 2026-10-16: kind 6, the name and mic as the read gave them); the save light goes on, and off again when the saved mic and position come back. Needs the read of the preset shown (above) | read again |
| Library | `0C C0 18 01 20 01 28 01 30 01 4C 00 00 00` (fields 3..6: factory captures, factory IRs, user captures, user IRs) | `0x4D`, multi-packet: `3` / `5` = capture `{1 hash, 2 name}`, `4` / `6` = IR name; an item's index is its place in its list |
| Load a library IR | `<len> C0 <1A factory / 22 user> <n> {08 <index> 12 <name>} 5E 00 00 00` | state dump |
| Preview a library capture | `<len> C0 <1A factory / 22 user> <n> {08 <index> 12 <name>} 40 01 96 00 00 00`: Cortex Cloud's play button on a library capture. Heard at once over the preset's own, no slot of the pedal's touched, **not an edit** to the pedal: the save light stays off (board, 2026-10-11). **But a Save while it plays keeps it as the preset's own capture** (slot 6; board 2026-10-13, on saved presets and on a new one): this is the load into the preset itself, which the app shows as "Load into preset's own" with its own Save / Discard. After that Save the pedal stays in its preview (later previews went unheard, sound dropping for a moment) until the stop below; the stop alone puts back the slot it was playing before (a bank capture, the save light on, board 2026-10-13), so the app sends the stop and then loads the preset again, which plays what it has saved (its own) with the light off. Cortex Cloud also stops each preview before the next (snoop 2026-10-11), and so does the app. **Never while the capture is off: that hung the pedal (2026-10-11)**; the app turns it on (slot 6) and waits for a state read showing it on | `0x97` `08 06 18 01 22 {12 <name> 1A <hash>}` |
| Stop the preview | `0D C0 10 <ms since 1970, varint> 18 00 94 00 00 00`: Cortex Cloud's stop button (HCI snoop 2026-10-11, byte-exact). The saved capture plays again. A "Use" ends a preview without it. Neither a reselect of the preset's own capture nor a load of the shown preset ends one (board, 2026-10-11) | `0x95` `08 01 10 <the same ms> 18 01` |
| Load a library IR into an IR slot | `<len> C0 18 <slot 0..4, or 5 = the preset's own IR slot> <22 factory / 2A user> <n> {08 <index> 12 <name>} 4E 00 00 00`, then (after the `0x4F`) the IR slot select (6 for the own: Cortex Cloud, HCI snoop 2026-10-11 10:54, `24 C0 18 05 2A 1C {08 25 12 "YA VX30 212 BLU Mix BMAY"} 4E` then `08 C0 18 03 20 06 1C`). Into the own slot: this preset alone, no slot of the pedal's written | `0x4F` |
| Preview a library IR | `<len> C0 <1A factory / 22 user> <n> {08 <index> 12 <name>} 40 01 9E 00 00 00` (the capture preview's shape, type `0x9E`; same snoop, user list seen) | `0x9F` `08 06 18 01 22 {12 <name>}`, then `0x73` off |
| Stop an IR preview | `0D C0 10 <ms since 1970> 20 00 94 00 00 00`: the capture stop with field 4 = 0 for field 3 (same snoop). Cortex Cloud sent it before its load into the own IR slot | `0x95` `08 01 10 <the same ms> 18 01`, then `0x73` on |
| Load a library capture ("Use"; the app's and the firmware's library load) | `<len> C0 18 <slot 0..24> <22 factory / 2A user> <n> {08 <index> 12 <name>} 50 00 00 00`, then the capture slot select above, which marks the preset edited (the save light on: Save / Discard). Any bank's slot works, not only the active bank's: a load into bank 4 while bank 2 played, then its select, saved and came back right after a preset change (board, 2026-10-14) | `0x51` `08 06 18 01`; field 3 ≠ 1: refused, field 4 = the pedal's reason as text (the IR load's `0x4F` alike) |
| Rename | `<len> C0 08 01 18 <preset> 22 <n> <name> 6F 00 00 00` | `0x70` `08 06 18 <preset> 20 <1 ok>` |
| Create (the shown preset stored under a name) | `<len> C0 08 01 18 <preset> 2A <n> <name> 03 00 00 00`. On a preset that is not empty it replaces it: "Copy to another slot" (what is heard now, unsaved edits and expression assignments included) | `0x04`, same shape |
| Delete | `08 C0 08 02 18 <preset> 32 00 00 00` | `0x33`, same shape |
| Footswitch | the preset select with field 4 = −1, field 5..8 (IA, IB, IIA, IIB) = the preset on the chosen one, the others −1, field 9 = 2 | as a select (`0x1F`, `0x1E`) |
| Saved on the pedal | — | `0x1B` with field 3 = 2 (the pedal's save button) |
| Save (the top bar's Save) | the create frame for the shown preset under its own name: SavePreset (type 3, field 5 = name) | `0x04`; the save light goes out (`0x73` off, state field 41 absent) |
| Discard (the top bar's Discard) | the preset select for the shown preset: a load drops unsaved edits, as the pedal's EXIT (rixrix/deskop-nano-cortex does the same) | as a select |

**A slot load leaves saved presets alone.** A saved preset keeps its capture / IR itself, not a pointer to the slot:
loading another capture into slot n changes only presets with unsaved changes on it; a saved preset that used slot
n keeps the old capture, which then shows as its own (Cortex Cloud test, 2026-10-12; also reported tested on hardware).
So load, save, then load the slot's old capture back should leave the new capture as the preset's own and the slot as
it was (not tried yet).

State field 41 (`currentPresetDirty`) is the save light in the dump: 1 while the shown preset has unsaved
changes.

Scales (fitted to Cortex Cloud's readouts): capture volume raw = 255 · ((dB + 24) / 36)^1.708 (0 dB = raw 128);
IR level = −96 + 108 · n^(1/3.5) dB, high pass = 20 + 780 · n^(5/3) Hz, low pass = 1000 + 19000 · n^(5/3) Hz.

The pedal itself checks no preset name (it took "", 3 characters, duplicates and 32 characters); the app keeps
these rules: 4 to 31 characters, unique, no spaces at the ends. A preset saved on the pedal while it has no name
stays unnamed and refuses renames: as Cortex Cloud does, the app then asks for a name and writes a create.

**Message names** (2026-10-13): 29 / 30 `SetPresetSlots` (the c304 preset select and
footswitches; field 9 `PresetSlotType` 0 IA, 1 IB, 2 IIA, 3 IIB, 4 none), 60 / 61 `RetrieveExpAssignments`,
62 `SaveExpAssignments`, 65 / 66 `RetrieveSettings`, 67 / 68 `UpdateSettings`, 76 / 77 `RetrieveLibraryContent`,
78 / 79 `SetCabinetSlotContent`, 80 / 81 `SetCaptureSlotContent`, 96 `RetrievePresetCabinetSettingsLiteResponse`,
111 / 112 `RenamePreset`, 115 `PresetDirtyStateChanged`, 127 `TunerMode`, 128 `TunerMetering`.

**Frames by hand.** The Log sheet has a hex field (Edit mode): a frame's body (`... <type> 00 00 00`) or a whole
line copied from the log (`<len> C0 ...`: the header is stripped and made again, so a copied line can be edited).
The pedal's answer shows in the log.

## Known, not used here yet (survey 2026-10-16)

From other open-source Nano Cortex projects. None of it tried from this app yet.

| Feature | Frame / field | Tested |
| --- | --- | --- |
| Knob event payload | incoming `0x1A` carries field 3 = id, field 4 = value | shipped elsewhere |
| USB playback volume | `0x43` `75 <f32 dB>` (settings field 14, −40..0 dB), read back as field 17 | shipped elsewhere |
| EXP / MIDI jack mode | `0x43` `38 <0 MIDI / 1 expression>` (field 7); settings field 10 absent = TRS MIDI, 1 = expression; field 18 = MIDI clock source (2 = TRS MIDI), reset when the jack leaves MIDI | reported confirmed on a pedal |
| Expression calibration | reset `04 C0 45 00 00 00`; save `0x47` `18 <min> 20 <max>` (min / max taken from the `0x40` positions between) | shipped elsewhere |
| Expression assignment write | `0x3E` with every record (zeros included), read back to check; level = write 13, gate = write 21 | shipped elsewhere, with read-back |
| `0x40` sub-type | field 3: 0 capture input gain, 1 capture output level, 2 expression (never seen 0 / 1 on the wire) | no |
| Ack after a pedal-side preset change | `06 C0 20 01 1E 00 00 00` after every `0x1D` event: "without it the Nano waits in a pending preset change" | stated, no test note |
| Preset select field 9 | 0..3 = the footswitch (IA, IB, IIA, IIB) the preset sits on, 4 = none: likely Cortex Cloud's 0 / 1 | no |
| State field 37 | 4-Preset Mode (off: footswitch slots IB / IIB unreachable); read only | read only elsewhere |
| State field 63 | tuner muted; the pedal's `0x7F` report carries field 7 = muted | read elsewhere |
| Tuner fields | TunerMode field 6 = `liveTuner` (app opened it); TunerMetering 6 = `isDeviationValid`, 7 = `centered`; cents may come as a double (wire type 1) | names only; the double untested |
| Library capture records | `0x4D` capture: 4 author `{2 name}`, 5 description, 6 type (`amp_head`, `amp_combo`, `amp_and_cab`, `cab`, `pedal`, `overdrive`, `fuzz`, `compressor`), 7 tags, 10 instrument, 13 corrupted (skip) | read elsewhere |
| FX on / off under heel-toe expression | state field 31 shows the expression's state, not the Bluetooth toggle: keep the switched value until field 31 moves | found on hardware elsewhere |
| Rename reply | `0x70` field 5 = error text when field 4 ≠ 1 | no |

Neither has preset reorder, backup / restore over Bluetooth, capture or IR upload, or settings writes beyond
these. One controller's link: 15 ms connection interval, MTU 517, bonding on an authentication error, a re-request (up
to 3) of a dump that does not parse to its end.

## Fixtures

Real packets from the hardware sessions live in `src/fixtures/hardware-2026-09-12.ts`,
`hardware-2026-09-15.ts`, `hardware-2026-09-19.ts` and `captures.ts` and are asserted
byte-for-byte in `tests/`.
