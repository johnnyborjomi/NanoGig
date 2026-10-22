# Privacy

NanoGig runs entirely in your browser. There is no backend and no account. The only thing it
reports anywhere is a small set of anonymous usage counts, described below.

## Network access

- The page and its assets are served from GitHub Pages (or your own `npm run dev`). After the
  first load the service worker caches them so the app also opens offline.
- **Anonymous usage stats** go to [Umami](https://umami.is) (cloud.umami.is), a cookieless
  analytics service, from the released app only (never from a dev server or the staging site).
  What is sent: a page view when the app opens, and a few named events: `launch` (whether it
  runs installed or in a browser tab, and web / iOS / Android), `connect` (a pedal link was
  established, and over which transport), `sync` (the first full read of the pedal succeeded,
  with its firmware version), `feature` (first use per session of the tuner, control mode,
  preset switching or the expression pedal), `session-end` (how many preset changes happened
  before the app went to the background), `pwa-installed`, `support-seen` and `support-click`
  (a "Support project" button came on screen / was tapped, and which one). No cookies, no user id, no fingerprint: Umami counts unique
  visitors from a hash of IP address and browser that changes every day and is never stored
  raw. Nothing about your pedal, presets, settings or Bluetooth traffic is included. Content
  blockers that block analytics stop it entirely; the app works the same without it.
- Nothing else is requested.

## Your data

- **Pedal traffic (Bluetooth / MIDI)** is processed in the page and shown on screen and in the
  hex log. It never leaves your device unless you copy the log and share it yourself.
- **Settings** (presets per bank, label style, control mode, last device) are
  stored in your browser's local storage.
- **Bluetooth permission** is granted by you in the browser's chooser and can be revoked in the
  browser's site settings at any time.

Questions: open an issue at <https://github.com/johnnyborjomi/NanoGig/issues>.
