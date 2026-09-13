# NanoGig

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Deploy](https://github.com/johnnyborjomi/NanoGig/actions/workflows/pages.yml/badge.svg)](https://github.com/johnnyborjomi/NanoGig/actions/workflows/pages.yml)

## ▶ Open the app: **[johnnyborjomi.github.io/NanoGig](https://johnnyborjomi.github.io/NanoGig/)**

Works in Chrome / Edge on desktop and Android (Web Bluetooth), installable as a PWA. On iPad
use [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) or the native
app below. Preset switching needs the pedal on USB (Web MIDI).

> **Unofficial.** NanoGig is an independent community project, not affiliated with, endorsed
> by, or supported by Neural DSP. "Nano Cortex", "Cortex Cloud" and "Neural DSP" are
> trademarks of Neural DSP Technologies and are used here only to describe compatibility.
> The protocol is reverse-engineered and every value shown is provisional. Use at your own risk.

**NanoGig** is a browser-based, stage-friendly **gig view** for the Neural DSP Nano Cortex. It
reads live state from the pedal over Bluetooth LE and shows, in very large type:

- the active **preset name** (bank/slot label alongside),
- the **FX block states** — gate, pre 1, pre 2, post 1, post 2, post 3, cab/IR — as big
  on/off tiles,
- the active **capture** and **cab/IR** names.

No backend, no account, nothing is sent anywhere. Read-only by default.

> **Everything on screen is provisional.** The protocol is reverse-engineered, verified
> against NanOS 2.2.x, and may change silently with a firmware update. The app fails soft:
> unknown payloads are logged in hex and ignored.
>
> **Control mode writes to your pedal.** It is off by default. Back up your presets in Cortex
> Cloud before turning it on, and try it on a preset you don't mind losing first.

## Acknowledgements

NanoGig stands on two projects without which it would not exist:

- **[choldy / nano-cortex-web-editor](https://github.com/choldy/nano-cortex-web-editor)** (MIT)
  reverse-engineered the Nano Cortex's private Bluetooth protocol in the first place: the
  command frames, the protobuf field maps, the multi-packet reassembly and the FX model
  catalogue all originate there. Thank you.
- **[rixrix / deskop-nano-cortex](https://github.com/rixrix/deskop-nano-cortex)** (Apache-2.0)
  turned that knowledge into a proper specification, built the BLE probe tooling, captured
  the live footswitch / expression events and the real firmware-2.2.1 state dump this project
  tests against, and set the "everything is provisional" standard NanoGig follows. Thank you.

What NanoGig adds on top is documented in [How it works](#how-it-works): the c305 framing
(14-bit length + START/END flags), the active-preset index in the state dump, and the
preset-changed event, all found from hardware logs in September 2026.

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
| `?writes=1` | Starts in control mode: tile taps (FX / gate), capture and cab labels, and the preset buttons write to the pedal. Off by default; the Control button toggles it too. |
| `?debug=1`  | Opens the hex log console on load.                                     |
| `?midi=<id>`| Pin the MIDI delivery for preset switching: `web-midi`, `c303-ble-midi`, `c302-ble-midi`, `c303-raw`, `c303-sequential`, `c302-raw`. Default: probe in that order. |

The "Log" button shows every TX/RX frame in hex; "copy" puts the log on the clipboard for
protocol debugging. Tap "Fullscreen" on stage; the Screen Wake Lock keeps the display on
while connected.

## Hosted build (GitHub Pages / PWA)

Every push to `main` runs the tests, builds, and deploys `dist/` to GitHub Pages via
`.github/workflows/pages.yml`, at `https://johnnyborjomi.github.io/NanoGig/`. The site is a
PWA: on Android Chrome open it, choose "Add to Home screen", and it launches fullscreen in
landscape with an offline shell. Web Bluetooth works there; on iPhone use Bluefy instead
(Safari has no Web Bluetooth, so an installed PWA cannot connect).

## iPad / iPhone app (Capacitor, free signing)

Apple web views have no Web Bluetooth, so the same app is wrapped with
[Capacitor](https://capacitorjs.com) and talks to the pedal through the
`@capacitor-community/bluetooth-le` plugin (`src/transport/ble-capacitor.ts`). Everything
else is the identical web code.

```bash
npm run ios:sync      # build the web app and copy it into ios/App
npm run ios:open      # open ios/App/App.xcworkspace in Xcode
```

In Xcode: select the **App** target → Signing & Capabilities → Team = your personal Apple ID
(free), let Xcode fix the bundle identifier if it complains, plug in the iPad, pick it as the
run destination and press Run. On the iPad, allow the app in Settings → General → VPN & Device
Management the first time. With free signing the install expires after 7 days; run again from
Xcode to renew. Preset switching is not available in the iOS app (no MIDI path there yet).

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
  gate (inverted, absent = on), field 12 present = cab on, fields 32/33 = capture / IR,
  **field 11 = capture position (0 / absent = capture bypassed)**. Field 32.1 is not the bypass
  flag: hardware dumps show it at 1 after a bypass and at 0 with position 4 (2026-09-12/13).
- **Capture / cab toggles (writes mode).** Bypass: capture `08 C0 18 01 20 00 1C 00 00 00`,
  cab `08 C0 18 03 20 00 1C 00 00 00` (both confirmed 2026-09-13; the pedal acks with a
  `… 73 00 00 00` frame). Re-enabling needs the slot index (`18 04 20 <slot-1>` / `18 03 20 <slot>`),
  which the app can only get by matching the current name against the metadata slot lists. When
  there is no match (library capture/IR, or no IR list in metadata) the label shows a lock and the
  toggle is refused both ways, so you cannot bypass something the app could not bring back.
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
- [x] (writes) The preset buttons switch presets via Web MIDI over USB (2026-09-12, as Prev/Next then).
- [x] (writes) Capture and cab bypass from the labels (2026-09-13). Re-enable: pending a preset whose capture/IR is in the slot list.

If a step fails, open the Log, reproduce, "copy", and file the hex.

## Disclaimer & trademarks

- NanoGig is **not** an official Neural DSP product and has no connection to the company.
  Neural DSP has not reviewed or approved it and provides no support for it.
- "Nano Cortex", "Quad Cortex", "Cortex Cloud" and "Neural DSP" are trademarks of Neural DSP
  Technologies. They appear in this project only to identify the hardware it works with.
- The Bluetooth protocol was learned by observing traffic between a user's own pedal and
  the official app (via the referenced open-source projects), not by decompiling any Neural
  DSP software. No Neural DSP code, firmware, artwork, fonts or captures are included.
- The software is provided as is, without warranty of any kind. You are responsible for what
  you send to your hardware, especially in control mode.

## Privacy

No backend, no analytics, no telemetry. See [PRIVACY.md](PRIVACY.md).

## Support

Best-effort, see [SUPPORT.md](SUPPORT.md).

## License

MIT, see [LICENSE](LICENSE). Third-party attributions are in [NOTICE](NOTICE).

## Attribution

- Transport / frames / decoders are adapted from
  [choldy/nano-cortex-web-editor](https://github.com/choldy/nano-cortex-web-editor) (MIT).
- The protocol specification followed here is
  [rixrix/deskop-nano-cortex](https://github.com/rixrix/deskop-nano-cortex)
  `docs/specs/110-backend-midi-ble/spec.md` (Apache-2.0); the real firmware-2.2.1 state
  dump and live-event fixtures come from that project's tests.

See [NOTICE](./NOTICE).
