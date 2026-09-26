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
| `?midi=<id>` | Pin the preset-switch delivery: `c304-select` (Bluetooth, default winner), `web-midi` (USB), `c303-ble-midi`, `c302-ble-midi`, `c303-raw`, `c303-sequential`, `c302-raw`. |

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

Two channels, two GitHub Pages sites:

| Channel    | URL                                              | Built from                      | Updated on             | Workflow                         |
| ---------- | ------------------------------------------------ | ------------------------------- | ---------------------- | -------------------------------- |
| production | https://johnnyborjomi.github.io/NanoGig/         | the release tag `vX.Y.Z`        | a release (tag push)   | `.github/workflows/pages.yml`    |
| staging    | https://johnnyborjomi.github.io/NanoGig-staging/ | the head of `main`              | every push to `main`   | `.github/workflows/staging.yml`  |

Production deploys from the tag itself, so installed apps see "A NanoGig update is ready" only
when a version is released. The same deploy also unpacks every release's web zip (attached by
`release.yml`) at `https://johnnyborjomi.github.io/NanoGig/vX.Y.Z/`, so any older version can be
opened by path, e.g. `/NanoGig/v1.0.3/`, to check whether a problem is new. Those copies are
exactly what shipped; each has its own service worker scope, and only the root is the PWA.
Staging does the same under `/NanoGig-staging/vX.Y.Z/`, so the layout can be checked there first. Run the workflow by hand to redeploy the highest final release tag
(pre-release tags such as `v1.2.0-rc1` are skipped).

Usage stats (`src/analytics.ts`, Umami Cloud, website id in `src/main.ts`) are only active in
production-channel builds off localhost, and in the native app. Staging and `npm run dev` never
load the tracker. Events: `launch`, `connect`, `sync`, `feature`, `session-end`, `pwa-installed`, `support-seen`,
`support-click` (PRIVACY.md; types in `src/analytics.ts`).

Staging is built with `NANOGIG_CHANNEL=staging` (`vite.config.ts`): its manifest is named
"NanoGig β" so it installs next to the production app, the connect screen shows a _beta_ tag,
the page title says "staging", and Menu → info shows `· staging`. It lives in its own
repository, [NanoGig-staging](https://github.com/johnnyborjomi/NanoGig-staging), because
Chrome treats every URL inside an installed app's scope as that app: a `/NanoGig/staging/`
sub-path could not be installed next to the released `/NanoGig/` app. The staging workflow
pushes `dist/` to that repo's `gh-pages` branch with a write deploy key whose private half is
the `STAGING_DEPLOY_KEY` secret of this repo. To rotate it:

```bash
ssh-keygen -t ed25519 -N "" -C nanogig-staging-deploy -f staging_key
gh repo deploy-key add staging_key.pub --repo johnnyborjomi/NanoGig-staging --title "NanoGig main → staging" --allow-write
gh secret set STAGING_DEPLOY_KEY --repo johnnyborjomi/NanoGig < staging_key
rm staging_key staging_key.pub
```

Both sites share the `johnnyborjomi.github.io` origin, so settings, the preset-name cache and
the remembered pedal are shared between them.

The site is a PWA (manifest + service worker) and installs to the Android home screen as a
fullscreen landscape app. The build uses relative asset paths (`base: './'`), so `dist/`
also works from any static host or a local folder.

**Install and updates** (`src/pwa.ts`): the connect screen shows an "Install app" block while
the browser holds a deferred `beforeinstallprompt` and the app is not running standalone. The
build stamps `sw.js` with `<version>-<git sha>` (`vite.config.ts`), so every deploy changes
the worker file; when a new worker has installed and is waiting, the store's `updateReady`
flips and the UI shows "A NanoGig update is ready" with Reload / Later. Reload posts
`SKIP_WAITING` to the waiting worker and reloads on `controllerchange`. The app checks for
updates when it returns to the foreground and hourly while open. Menu → info shows the running
version and build.

## Releases

Tag-driven (`.github/workflows/release.yml`): pushing a tag `vX.Y.Z` runs the tests, builds,
zips `dist/` as `nanogig-vX.Y.Z-web.zip` and publishes a GitHub Release with auto-generated
notes. The zip is a self-hostable copy of the web app. The same tag push also deploys the
production site, which is when installed apps see "A NanoGig update is ready". Between
releases, `main` is only visible on the staging site.

```bash
npm version minor          # bumps package.json, commits, creates the tag vX.Y.Z
git push --follow-tags     # the tag triggers the release workflow
```

A release can also be started by hand from Actions → Release → Run workflow, giving a tag
that already exists, or by creating the release in the GitHub UI. Both workflows set the
package version from the tag before building, so the app reports the tag's version even when
`package.json` in the repo was not bumped. Bumping it anyway (`npm version`) keeps dev and
staging builds honest about what they are ahead of.

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
Silicon Mac whose shell runs under Rosetta, prefix with `arch -arm64`). Preset switching in the iOS app
uses the Bluetooth c304 select (there is no MIDI fallback on iOS).

## Hardware checklist

- [x] Connect from Chrome (a002 c300–c307 found, c305/c306 subscribed).
- [x] Preset name follows footswitch presses.
- [x] Tile states match the pedal's LEDs (gate, pre/post blocks).
- [x] Power-cycle the pedal: the app reconnects without a reload (~13 s while the pedal boots).
- [x] Reload the page: reconnects to the last pedal without the chooser (needs `getDevices()`, i.e. the
      `enable-web-bluetooth-new-permissions-backend` flag; stock Chrome, and every PWA launch on Android,
      goes through the chooser).
- [x] Control: FX and gate tile taps.
- [x] Control: preset buttons over Bluetooth (c304 select, 2026-09-19); Web MIDI over USB as fallback.
- [x] Control: capture and cab bypass / re-enable from the labels.
- [x] Capture / cab names follow the footswitch encoders.
- [x] Android Chrome PWA, iPad Capacitor app, iPad Bluefy.

If a step fails, open the Log, reproduce, "copy", and attach the hex to an issue.
