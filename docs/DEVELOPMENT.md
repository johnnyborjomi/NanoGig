# Developing NanoGig

Vite + TypeScript, no framework, no backend. Vitest for tests (node + jsdom). Lucide icons.

```bash
npm install
npm run dev          # http://localhost:5173  (also on your LAN: --host is on)
npm test             # unit + jsdom tests, includes byte-exact hardware fixtures
npm run build        # type-check + production bundle in dist/
```

## URL flags

| Flag         | Effect                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| `?mock=1`    | Demo mode: a fake pedal replays captured packets. No hardware needed.                                      |
| `?writes=1`  | Start in control mode (the Control button toggles it too).                                                  |
| `?debug=1`   | Open the hex log on load.                                                                                  |
| `?midi=<id>` | Pin the preset-switch delivery: `web-midi`, `c303-ble-midi`, `c302-ble-midi`, `c303-raw`, `c303-sequential`, `c302-raw`. |

Menu → Log shows every TX/RX frame in hex; "copy" puts it on the clipboard. That log is what
protocol bug reports need, together with the firmware version shown at the bottom of the menu.

## Layout

```
src/
  transport/ble.ts            Web Bluetooth: connect, characteristic map (with UUID-lookup
                              fallback for shims like Bluefy), subscribe c305+c306 (deduped),
                              auto-reconnect with back-off, resume via getDevices()
  transport/ble-capacitor.ts  Same contract on iOS through @capacitor-community/bluetooth-le
  transport/webmidi.ts        Web MIDI output ("Nano Cortex" USB port) for Program Changes
  transport/mock.ts           Fake pedal replaying captured / synthesised packets
  protocol/frames.ts          Byte-exact c304 request / write frames, bank-slot labels
  protocol/reassembly.ts      c305 framing (14-bit length + START/END), message assembler
  protocol/proto.ts           Hand-rolled protobuf wire walker (no protobufjs)
  protocol/decode.ts          Metadata / current-state / live-event decoders
  protocol/models.ts          FX model catalogue (id → name, category)
  sync/engine.ts              connect → metadata → state; events → re-sync; control-mode writes
  state/store.ts              Observable store; every device field carries provisional: true
  ui/gigview.ts + styles.css  The screen (vanilla DOM)
  fixtures/                   Real packets from hardware sessions
tests/                        Vitest
docs/PROTOCOL.md              What the bytes mean
```

## Hosting

Every push to `main` runs the tests, builds and deploys `dist/` to GitHub Pages
(`.github/workflows/pages.yml`). The site is a PWA (manifest + service worker) and installs
to the Android home screen as a fullscreen landscape app. The build uses relative asset paths
(`base: './'`), so `dist/` also works from any static host or a local folder.

## Releases

Tag-driven (`.github/workflows/release.yml`): pushing a tag `vX.Y.Z` runs the tests, builds,
zips `dist/` as `nanogig-vX.Y.Z-web.zip` and publishes a GitHub Release with auto-generated
notes. The zip is a self-hostable copy of the web app; the live site on GitHub Pages is
always the latest `main`.

```bash
npm version minor          # bumps package.json, commits, creates the tag vX.Y.Z
git push --follow-tags     # the tag triggers the release workflow
```

A release can also be started by hand from Actions → Release → Run workflow, giving a tag
that already exists.

## iPad / iPhone app (Capacitor, free signing)

Apple web views have no Web Bluetooth, so the same app is wrapped with
[Capacitor](https://capacitorjs.com) and talks to the pedal through the
`@capacitor-community/bluetooth-le` plugin. Everything else is the identical web code.

```bash
npm run ios:sync      # build the web app and copy it into ios/App
npm run ios:open      # open ios/App/App.xcworkspace in Xcode
```

In Xcode: select the **App** target → Signing & Capabilities → Team = your personal Apple ID
(free); let Xcode fix the bundle identifier if it complains; plug in the iPad, pick it as the
run destination and press Run. On the iPad, allow the app under Settings → General → VPN &
Device Management the first time. With free signing the install expires after 7 days; run
again from Xcode to renew. CocoaPods is required (`brew install cocoapods`; on an Apple
Silicon Mac whose shell runs under Rosetta, prefix with `arch -arm64`). Preset switching is not
available in the iOS app (no MIDI path).

## Hardware checklist

- [x] Connect from Chrome (a002 c300–c307 found, c305/c306 subscribed).
- [x] Preset name follows footswitch presses.
- [x] Tile states match the pedal's LEDs (gate, pre/post blocks).
- [x] Power-cycle the pedal: the app reconnects without a reload (~13 s while the pedal boots).
- [x] Reload the page: reconnects to the last pedal without the chooser.
- [x] Control: FX and gate tile taps.
- [x] Control: preset buttons via Web MIDI over USB.
- [x] Control: capture and cab bypass / re-enable from the labels.
- [x] Capture / cab names follow the footswitch encoders.
- [x] Android Chrome PWA, iPad Capacitor app, iPad Bluefy.

If a step fails, open the Log, reproduce, "copy", and attach the hex to an issue.
