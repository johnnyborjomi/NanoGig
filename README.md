# Nano Cortex Gig View

A browser-based, stage-friendly **gig view** for the Neural DSP Nano Cortex. It reads
live state from the pedal over Bluetooth LE and shows, in very large type:

- the active **preset name** (bank/slot label alongside),
- the **FX block states** — gate, pre 1, pre 2, post 1, post 2, post 3, cab/IR — as big
  on/off tiles,
- the active **capture** and **cab/IR** names.

No backend, no account, nothing is sent anywhere. Read-only by default.

> **Everything on screen is provisional.** The protocol is reverse-engineered, verified
> against NanOS 2.2.x, and may change silently with a firmware update. The app fails soft:
> unknown payloads are logged in hex and ignored.

## Requirements

- **Desktop Chrome or Edge** (Web Bluetooth). Firefox and Safari are not supported.
- **iPad:** use the [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055)
  browser — iPad Safari has no Web Bluetooth.
- The Nano Cortex accepts one BLE client. Quit / disconnect Cortex Cloud first.

## Run

```bash
npm install
npm run dev          # http://localhost:5173  (LAN: use --host, already on)
npm test             # Vitest unit tests
npm run build        # type-check + production bundle in dist/
```

URL flags:

| Flag        | Effect                                                                 |
| ----------- | ---------------------------------------------------------------------- |
| `?mock=1`   | Demo mode: a fake device replays captured packets, no hardware needed. |
| `?writes=1` | Enables tile taps (FX / gate toggle) and ◀ ▶ preset buttons. Off by default. |
| `?debug=1`  | Opens the hex log console on load.                                     |
| `?midi=<id>`| Pin the MIDI delivery for preset switching: `web-midi`, `c303-ble-midi`, `c302-ble-midi`, `c303-raw`, `c303-sequential`, `c302-raw`. Default: probe in that order. |

The "Log" button shows every TX/RX frame in hex; "copy" puts the log on the clipboard for
protocol debugging. Tap "Fullscreen" on stage; the Screen Wake Lock keeps the display on
while connected.

## How it works

```
src/
  transport/ble.ts        Web Bluetooth: connect, characteristic map, subscribe c305+c306
                          (deduped), 3 s write timeouts, unsubscribe-before-disconnect,
                          auto-reconnect with backoff
  transport/mock.ts       Fake device replaying captured / synthesised packets
  protocol/frames.ts      Byte-exact c304 request frames and MIDI PC (from the references)
  protocol/reassembly.ts  Packet classification + multi-packet stream reassembly + debounce
  protocol/proto.ts       Hand-rolled protobuf wire walker (no protobufjs)
  protocol/decode.ts      Metadata / current-state / live-event decoders
  sync/engine.ts          connect → metadata dump → state dump; events → re-sync; writes
  state/store.ts          Observable store; every device field carries provisional: true
  ui/gigview.ts           The screen
```

Protocol summary (provisional; verified on NanOS 2.2.1 hardware on 2026-09-12 unless noted):

- GATT: service `a002`; characteristics `c302` (MIDI write), `c304` (command write),
  `c305` (notify — replies and live events), `c306` (indicate — duplicate of c305).
- **Framing.** Every c305 packet starts with a little-endian u16: bits 0-13 = body length
  (packet length − 2), bit 14 = START of message, bit 15 = END of message. `FE 41` is a
  510-byte first packet, `FE 01` a continuation, `0A 81` / `EE 80` last packets, `FD C1` a
  single-packet message. Bodies end with a 4-byte trailer `<type> 00 00 00`.
  (The reference projects' "FE/FD/CE/D0 stream start" bytes are just length bytes of
  MTU-sized packets.) Messages complete on END; no debounce is needed.
- Metadata dump request `06 C0 08 03 01 00 00 00` → one ~17 KB message streamed over ~6 s:
  the full state message plus field 17 captures, field 18 = 64 preset records
  `{1:name, 7:captureName, 9:irShort, 10:irFull}`, field 19 IRs.
- Current-state request `0C C0 08 03 18 01 20 01 28 01 01 00 00 00` → state message (type 2):
  **field 13 = active preset index**, field 31 = 5-byte bypass array (0 = on), field 54 =
  gate (inverted, absent = on), field 12 present = cab on, fields 32/33 = capture / IR.
- **Preset switching (writes mode).** MIDI Program Changes written to the proprietary
  characteristics do NOT switch presets on NanOS 2.2.1 (2026-09-12): `c302` rejects every write
  ("GATT operation failed"), `c303` accepts raw and MIDI-over-BLE framed writes but the pedal
  ignores them and emits no preset-changed event. The pedal also advertises only its own
  `a002` service, not the standard Bluetooth-MIDI service, so macOS never lists it in MIDI
  Studio. **The verified path is Web MIDI over USB:** plug the pedal into the computer and
  macOS exposes a MIDI port named "Nano Cortex"; a Program Change on it switches presets
  (confirmed 2026-09-12). The Bluetooth connection keeps serving the display. The app tries
  Web MIDI first, then the BLE variants from the rixrix probe, confirms each against the
  pedal's own preset report (event `0x1D` / dump field 13), and remembers what worked. Pin
  one with `?midi=<id>`. Bluefy on iPad has no Web MIDI, so preset switching there is not
  possible with any documented frame.
- Live events (single-packet messages, by trailer type): `0x1D` preset changed
  (`10 C0 08 01 20 <preset> 28 <IA> 30 <IB> 38 <IIA> 40 <IIB> 1D 00 00 00`), `0x1F` bypass
  changed, `0x1A` knob, `0x1C` encoder/bank, `0x40` expression, `0x73` unknown. The app
  updates the preset immediately on `0x1D` and re-reads state after `0x1D`, `0x1F` and any
  unknown type; knob / encoder / expression telemetry is ignored. A 2-byte `[Cn, program]`
  event (reference decoders) is also accepted but has not been observed.

Hardware packets from the 2026-09-12 session live in `src/fixtures/hardware-2026-09-12.ts`
and are asserted byte-for-byte in the tests.

### Active preset

The state dump's field 13 carries the active preset index (observed: 14 before a footswitch
press, 3 after, both matching the capture names and the `0x1D` event). If a firmware ever omits
it, the app falls back to a unique capture + IR name match against the preset list, tagged
**inferred**. A live event is tagged **live** until the confirming dump arrives; an
app-initiated change is tagged **sending**.

## Hardware checklist (acceptance)

- [x] Connect from Chrome (2026-09-12: a002 c300–c307 found, c305/c306 subscribed).
- [x] Preset name follows footswitch presses (2026-09-12).
- [ ] Tile states match the pedal's LEDs (gate, pre/post blocks, cab).
- [ ] Footswitch preset change updates the screen without touching the browser.
- [x] Power-cycle the pedal: the app reconnects without a page reload (2026-09-12, first attempt, ~13 s).
- [x] (writes) Tapping a tile toggles the block on the pedal and the tile settles to the
      state reported by the next dump (2026-09-12).
- [x] (writes) Prev/Next switches presets via Web MIDI over USB (2026-09-12).

If a step fails, open the Log, reproduce, "copy", and file the hex.

## Attribution

- Transport / frames / decoders are adapted from
  [choldy/nano-cortex-web-editor](https://github.com/choldy/nano-cortex-web-editor) (MIT).
- The protocol specification followed here is
  [rixrix/deskop-nano-cortex](https://github.com/rixrix/deskop-nano-cortex)
  `docs/specs/110-backend-midi-ble/spec.md` (Apache-2.0); the real firmware-2.2.1 state
  dump and live-event fixtures come from that project's tests.

See [NOTICE](./NOTICE). Not affiliated with or endorsed by Neural DSP.
