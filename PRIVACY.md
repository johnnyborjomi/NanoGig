# Privacy

NanoGig runs entirely in your browser. There is no backend, no account, no analytics, and no
telemetry.

## Network access

- The page and its assets are served from GitHub Pages (or your own `npm run dev`). After the
  first load the service worker caches them so the app also opens offline.
- Nothing else is requested. No data about you, your pedal, or your presets is sent anywhere.

## Your data

- **Pedal traffic (Bluetooth / MIDI)** is processed in the page and shown on screen and in the
  hex log. It never leaves your device unless you copy the log and share it yourself.
- **Settings** (presets per bank, label style, control mode, last device) are stored in your
  browser's local storage.
- **Bluetooth permission** is granted by you in the browser's chooser and can be revoked in the
  browser's site settings at any time.

Questions: open an issue at <https://github.com/johnnyborjomi/NanoGig/issues>.
