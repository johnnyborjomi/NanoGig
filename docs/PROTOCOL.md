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
that was done by ear. The other fields are still unmapped. NanoGig re-reads the message after
every mute ack to confirm the switch against the pedal's report.

## Live events (single-packet messages, by trailer type)

| Type   | Meaning                                                                                              | NanoGig reaction                       |
| ------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `0x1D` | Preset changed: `10 C0 08 01 20 <preset> 28 <IA> 30 <IB> 38 <IIA> 40 <IIB> 1D 00 00 00` (new)         | update preset immediately, re-read state |
| `0x1F` | Bypass changed                                                                                       | re-read state                          |
| `0x1C` | Footswitch encoder turned (capture / cab scrolling), same `18 <sel> 20 <val>` shape as slot writes   | debounced re-read (~400 ms)            |
| `0x1A` | Knob (also tap tempo)                                                                                | debounced re-read (~400 ms)            |
| `0x40` | Expression pedal position: `0B C0 08 01 18 02 20 <0–254> 40 00 00 00`, field 4 absent at heel; ~20/s while moving | side bar                    |
| `0xAA` | Values the expression produced for its assigned slots (see "Expression pedal")                        | EXP badge fill on the tile             |
| `0x3D` | Reply to our expression-assignments request (see "Expression pedal")                                 | EXP badges                             |
| `0x73` | Generic "something changed" notice; also the ack to capture / cab slot writes                         | debounced re-read                      |
| `0x42` | Device-settings reply (see above)                                                                    | log the fields                         |
| `0x44` | Ack to the outputs-mute write: `08 C0 08 01 18 01 44 00 00 00`, within ~100 ms                       | confirm the switch, re-read settings   |
| `0x1E` | Ack to the c304 preset select: `08 C0 08 01 20 01 1E 00 00 00`, after a `0x1F` notice               | re-read state (field 13 confirms)      |
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
gain 4, bass 5, mid 6, treble 7, level 8, pre 1 … post 3 = 9–13, an unnamed eleventh range 14;
bypass capture 15, IR 16, pre 1 … post 3 = 17–21, an unnamed eighth bypass 22. With post 3
assigned 17–130 the values ran 17…129. An empty `06 C0 08 01 AA 00 00 00` follows a preset load
with nothing assigned.

**Assignments are per preset.** Read: `08 C0 08 03 18 <preset> 3C 00 00 00`; reply (type
`0x3D`) `08 01` then one sub-message per assigned target; the pedal acks writes with
`08 C0 08 01 18 01 3F 00 00 00`. Cortex Cloud writes the whole list with type `0x3E` after
`18 <preset>`; the "assign everything" capture (preset 6, targets added in Cortex Cloud's list
order) gives the write numbering, which NanoGig treats as canonical:

| Write field | Target                | Values field |
| ----------- | --------------------- | ------------ |
| 4 5 6 7     | gain bass mid treble  | 4 5 6 7      |
| 21          | level                 | 8            |
| 8 … 12      | pre 1 pre 2 post 1 post 2 post 3 amount | 9 … 13 |
| 13          | ? (listed after post 3) | 14         |
| 14 15       | capture / IR bypass   | 15 16        |
| 16 … 20     | pre 1 … post 3 bypass | 17 … 21      |
| 22          | ? bypass (listed third, gate?) | 22  |

A range sub-message is `{1: flag, 2: min, 3: max}` (`08 00 10 00 18 FF 01` = 0–100 %). A bypass
sub-message's key is the mode: `{2: {1:0, 2:0}}` is heel-toe (its values flag flips at
mid-travel), `{1: {1:0, 2:600}}` and `{3: {1:600}}` carry a delay in ms and never fired without
a toe switch (switch / stop, order unknown). The reply was only seen with post 3, at field 11 =
write − 1; the decoder applies that rule to every target and logs the result, so the first
read of a fully assigned preset will confirm or correct it.

NanoGig requests the assignments after every state dump whose preset differs from the last
request, remembers which preset it asked for (the reply carries none), and shows a bar at the
right edge for the position plus an `EXP min–max %` badge with a value fill on each assigned tile.

## Fixtures

Real packets from the hardware sessions live in `src/fixtures/hardware-2026-09-12.ts`,
`hardware-2026-09-15.ts`, `hardware-2026-09-19.ts` and `captures.ts` and are asserted
byte-for-byte in `tests/`.
