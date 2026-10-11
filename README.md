# NanoGig

**The screen your Nano Cortex doesn't have.**

[![Open the app](https://img.shields.io/badge/Open%20the%20app-johnnyborjomi.github.io%2FNanoGig-1f9d55?style=for-the-badge)](https://johnnyborjomi.github.io/NanoGig/)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Deploy](https://github.com/johnnyborjomi/NanoGig/actions/workflows/pages.yml/badge.svg)](https://github.com/johnnyborjomi/NanoGig/actions/workflows/pages.yml)
[![Latest release](https://img.shields.io/github/v/release/johnnyborjomi/NanoGig?include_prereleases)](https://github.com/johnnyborjomi/NanoGig/releases)
[![Buy Me a Coffee](https://img.shields.io/badge/Sponsor-Buy%20me%20a%20coffee-ffdd00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/johnnyborjomi)

The Neural DSP Nano Cortex sounds huge and shows you almost nothing: a few status LEDs. NanoGig puts a phone, tablet or laptop next to the pedal and turns it
into the stage display it never had. Connect once over Bluetooth and the screen follows every
footswitch press:

- **Preset name in huge type**, readable from standing height, with the bank/slot label your
  MIDI controller uses (1A, 1B … or A1, A2 …), colour-coded per slot.
- **FX blocks at a glance**: gate, pre 1, pre 2, post 1-3, each tile showing the loaded effect
  and lit in its category colour when it is on, like the pedal's LEDs but with names.
- **Capture and cab / IR names**, updating as you scroll the pedal's encoders, and the
  **tempo** in the top bar, following tap tempo live.
- **Optional control mode**: tap a tile to toggle a block, tap capture or cab to bypass them,
  and pick presets from a bank strip. Off by default; the pedal stays read-only until you
  turn it on.
- **Edit mode**: the **Edit** button in the top bar (it turns Control on too) — hold an FX tile to
  change its model and parameters, tap the capture or IR name for capture volume, IR level /
  filters / phase / microphone and the pedal's whole capture and IR library (in folders of your
  own), hold Gate for its threshold, and hold the preset name to rename it, name an empty
  slot, put it on a footswitch or delete it. Menu → Presets (or a hold on the strip's ‹ ›) lists all 64.

Nothing is installed on the pedal and nothing leaves your device: no account, no server, no
analytics. It is a web page.

> **Unofficial.** NanoGig is an independent community project, not affiliated with, endorsed
> by or supported by Neural DSP. "Nano Cortex", "Cortex Cloud" and "Neural DSP" are trademarks
> of Neural DSP Technologies, used here only to describe compatibility. The Bluetooth protocol
> is reverse-engineered and every value on screen is provisional. Use at your own risk.

## Screenshots

GIG VIEW:

<img width="527" alt="Screenshot 2026-09-14 at 18 36 41" src="https://github.com/user-attachments/assets/5f4c0dac-20b8-49b8-b581-138515d70e3c" />

<img width="524" alt="Screenshot 2026-09-14 at 18 36 58" src="https://github.com/user-attachments/assets/5502b3bb-52a2-45cb-bd90-4c15e55247fd" />

CONTROL VIEW:

<img width="528" alt="Screenshot 2026-09-14 at 18 37 30" src="https://github.com/user-attachments/assets/7453e97b-1bcb-4415-a7ff-b56fd4450650" />

SETTINGS FOR MIDI CONTROLLER:

<img width="526" alt="Screenshot 2026-09-14 at 18 38 04" src="https://github.com/user-attachments/assets/683d9247-9a43-42ed-842f-f6438a874a71" />

## Get started

1. Disconnect the pedal from Cortex Cloud (the Nano accepts one Bluetooth client at a time).
2. Open **[johnnyborjomi.github.io/NanoGig](https://johnnyborjomi.github.io/NanoGig/)** in a
   browser from the table below.
3. Tap **Connect Nano Cortex**, pick the pedal in the chooser, done. That chooser is Chrome's
   consent step and appears once per pedal: later taps on Connect reach the pedal the page
   already knows (and, where Chrome remembers it across launches, the remembered one) without
   it. **Show all BT devices** opens the chooser on purpose. While the app looks for
   the pedal it shows the pairing gesture (hold EXIT + CAPTURE) and a Cancel button; the
   connect page with the Connect button comes back only after you cancel or disconnect on
   purpose. The app reconnects on its own after a pedal power cycle, and on launch where
   Chrome remembers the pedal (see the note under the table). Preset names are remembered on the
   device, so from the second connect on the screen is live as soon as the link is up. The
   name list is re-read once the pedal has been idle for a minute (or at once when a preset's
   capture or cab no longer matches what was remembered), which picks up renames made in
   Cortex Cloud; Menu → Refresh does it on demand.
4. Tap the fullscreen button and put the device where you can see it.

No pedal at hand? **Demo mode** on the connect screen runs the whole UI against a fake pedal.

The link above is the released app; it only updates when a version is tagged. The bleeding
edge from every push lives at
[johnnyborjomi.github.io/NanoGig-staging](https://johnnyborjomi.github.io/NanoGig-staging/)
and installs as a separate "NanoGig β" app.

| Device                 | How                                                                                                                        | Live display | Control mode | Preset switching  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------ | ----------------- |
| Laptop / desktop       | Chrome or Edge                                                                                                             | yes          | yes          | yes               |
| Android phone / tablet | Chrome. Menu → _Add to Home screen_ installs it as a fullscreen landscape app                                              | yes          | yes          | yes               |
| iPad / iPhone          | [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) browser (Safari has no Web Bluetooth)             | yes          | yes          | yes               |
| iPad, native app       | Build it yourself with a free Apple ID: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#ipad--iphone-app-capacitor-free-signing) | yes          | yes          | yes               |

Everything, preset switching included, works over Bluetooth alone: the app sends the same
preset-select command Cortex Cloud does. If a pedal on other firmware ignores it, the app falls
back to a MIDI Program Change over USB (Web MIDI), which was the only path before v1.1. Firefox
and Safari have no Web Bluetooth and are not supported.

**Picking the pedal on every launch?** Stock Chrome keeps Bluetooth permissions in memory
only, so an installed app that was closed (or killed in the background, which Android does
freely) asks for the pedal again. Chrome's persistent-permissions backend fixes that but is
still behind a flag: open `chrome://flags/#enable-web-bluetooth-new-permissions-backend` in the
Chrome browser, set it to Enabled, tap Relaunch and pick the pedal once more. From then on
the app reconnects on launch, and again whenever it returns to the foreground while
disconnected. The connect screen shows these steps only on a Chrome without the flag.

## What's on the screen

- **Top bar**: connection state, **Control** (turns control mode on and off), fullscreen, and a
  menu with Settings, Refresh (re-reads the preset names and the state), the hex Log, Disconnect, and the pedal's firmware version.
- **Preset row**: bank/slot label and preset name, sized to always fit on one line. A small
  tag shows _live_ right after a footswitch press until the pedal confirms, or _sending_ while
  the app is changing the preset.
- **Capture / cab line**: names plus an on/off indicator in each label. A lock instead of the
  indicator means that capture or cab is a factory one the app could not switch back on, so it
  leaves it alone.
- **Gate and FX tiles**: effect category, model name, colour when on.
- **Preset strip**: seven presets around the active one, the active one framed. In control
  mode the arrows page through all 64 and a tap selects.

**Settings** (menu): presets per bank (2-8, match your MIDI controller; 4 suits an Mvave
Chocolate), label style _1B_ or _A2_, whether to show the pedal's own preset number (1-64)
next to the label, whether to show the Nano's own footswitch assignments as IA / IB /
IIA / IIB badges, for playing without a MIDI controller, and whether to show the preset list
under the FX tiles at all. Under **Pedal**, **Re-read preset names when idle** (on by default)
can be switched off for a gig: the pedal takes about 6 s to send the list and holds footswitch
presses back meanwhile, so the app only does it after a quiet minute, and the status dot in the top bar pulses
while it runs. A **Mute outputs 1/2** switch sends the same
command Cortex Cloud's global setting does, handy when you monitor through a DAW over USB. It
works without control mode, shows the pedal's own report of the switch, and while muted a
small _1/2_ badge sits next to the tempo in the top bar.

## Tuner

Menu → Tuner opens the pedal's tuner over Bluetooth: the note in large type, the offset in
cents on a needle bar, the reference pitch (± 1 Hz) and the tuner's own "mute outputs while
tuning" switch, all as Cortex Cloud sends them (the switch follows the pedal's own mute toggle
too). Done (or Escape, or losing the link) turns the
tuner off again, unless the live tuner setting is on (see below). It works whenever connected: it changes no preset, so control mode is not
needed. A tuner started on the pedal (hold Footswitch II) opens the same screen by itself while
the live tuner setting is off; the pedal ending its tuner closes it either way, as on the pedal's
own display.

**Live tuner** (experimental, on by default, Settings → Pedal): only while the pedal itself is
in tuner mode, entered by holding Footswitch II on the pedal or from Menu → Tuner, the top bar shows the note with a flat dot
on the left and a sharp dot on the right. Green all round when in tune; the dot on the side
you are off, and the note, go yellow within 10 cents and red beyond. It is passive: it never
switches the pedal's tuner on. While it is checked, closing the big tuner leaves the pedal in
tuner mode (tap Footswitch II on the pedal to exit); unchecked, Done turns the tuner off. Tap
the widget for the big tuner.

## Tempo

Menu → Tempo (or a tap on the BPM in the top bar) opens the tempo view: the tempo in large
type, − / + and Done. Tap tempo on the pedal opens it by itself with the value following every
tap, and the pedal leaving that mode closes it. The view mirrors the pedal's own tempo screen:
opening it puts the pedal in tap tempo mode, − / + write the value (hold to walk it), Done leaves
the mode with the final tempo and the state re-read confirms it. Like the tuner it needs no
control mode.

## Expression pedal

A thin bar at the right edge follows the expression pedal, and every FX block the pedal is
assigned to in the current preset carries a track at its bottom: a band for the range set in
Cortex Cloud and a fill for the value the pedal produces (a bypass assignment fills the whole
track when engaged). Assignments are read from the pedal as soon as a preset switch is through,
retried a few times if the pedal does not answer. The indicators never fade: Settings → Pedal →
"Show expression pedal values" shows them always or never.

## Control mode

Off by default. When on, taps write to the pedal: FX and gate tiles toggle their block, the
capture and cab labels bypass or re-enable, and the preset strip switches presets. The only
write that does not need control mode is the outputs 1/2 mute switch in
Settings, which touches no preset; the tuner and the tempo view are pedal screens rather than
preset edits and work without it too. Every change is confirmed against the pedal's own report a moment later,
so the screen shows what the pedal did, not what the app asked for. Fast taps are safe: one
preset select is on the wire at a time and the newest target goes out on its ack (the pedal
never loads the presets skipped past), and a report that predates a tile tap cannot undo it.

### Edit mode

The **Edit** button in the top bar, left of Control: it turns control mode on too (Control alone
only switches presets and blocks; Control off ends Edit). Both are remembered across reloads. Ported from the
[NanoGig Screen](https://github.com/johnnyborjomi/NanoGigScreen) firmware, whose frames are
Cortex Cloud's own; the app shows every change at once and confirms it against the pedal.

| Where | Gesture | What |
| --- | --- | --- |
| FX tile | hold | Model (every model the slot takes, by category) and its parameters, live as the sliders move. A block that is off can be edited too, as in Cortex Cloud: its values are heard once it is on, and saved with the preset. While another model is tried, the preset's saved one is outlined. Once the block differs from the preset as saved (model or values), the sheet's Discard puts that block back; other blocks keep their changes. |
| Gate | hold | On / off and threshold; Discard puts the saved threshold back. |
| Capture / IR name | tap | Capture: ‹ › through the slots of the bank playing, on / off, and a list to open with every bank (‹ › browse, a tap plays a slot; the preset's own capture last), volume in dB. IR: ‹ › through the IR slots, on / off, the slot list to open like the captures', level, high and low pass, phase, microphone and position (factory IRs). Each tab's Discard puts back what the preset has saved (the capture slot and volume; the IR and its settings), on / off aside. Like FX blocks, a capture, IR or gate that is off is still editable, drawn grey (an IR once it has been read on: the pedal does not answer for one that is off). Both open the pedal's library. Load is an edit the preset keeps with Save: an IR into the preset, a capture into the slot it plays (every preset on that slot hears it). An IR can also go into one of the pedal's IR slots. A capture can go into the preset's own instead (this preset alone; the pedal shows no save light for it, the app's Save keeps it), or be previewed: heard until Stop preview or Discard brings the saved capture back. A capture or IR that is off is turned on first. Library folders of your own, for captures and IRs alike: New folder at the top of a list, hold an item (or drag it, with a mouse) to move it into one; rename or delete a folder from inside it. Folders are kept in this browser. |
| Preset name, a preset button, Menu → Presets → ⋯ | hold / tap | Rename, name an empty slot (stores the sound playing now there), put the preset on IA / IB / IIA / IIB, delete (tap twice). |

Changes are live, like turning a knob on the pedal. When the pedal's save light comes on, **Save** and
**Discard** take the Edit button's place in the top bar: Save stores the preset under its name (as the pedal's save
button; a preset with no name is asked for one), Discard loads it again as saved (as the pedal's EXIT). Saving on
the pedal works as before. Renames, creates and deletes are stored at once.

> **Back up your presets in Cortex Cloud before turning control mode on**, and try it on a
> preset you don't mind losing first. The protocol is reverse-engineered; a firmware update can
> change what these commands do.

## Caveats

| Area               | Detail                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Firmware           | Verified on NanOS 2.2.1. Other versions may decode wrongly or not at all. If something looks off, Menu → Log → copy and open an issue with the hex. |
| Factory cabs       | Can be bypassed but not re-enabled from the app, so their toggle is locked. User IR slots and captures work both ways.                              |
| One client         | The pedal drops NanoGig when Cortex Cloud connects, and vice versa.                                                                                 |
| Free Apple signing | The self-built iPad app expires after 7 days; Bluefy needs no build.                                                                                |

## Acknowledgements

NanoGig stands on two projects without which it would not exist:

- **[choldy / nano-cortex-web-editor](https://github.com/choldy/nano-cortex-web-editor)** (MIT)
  reverse-engineered the pedal's private Bluetooth protocol: command frames, protobuf field
  maps, packet reassembly and the FX model catalogue all originate there.
- **[rixrix / deskop-nano-cortex](https://github.com/rixrix/deskop-nano-cortex)** (Apache-2.0)
  turned that into a proper specification, built the probe tooling, captured the live events
  and firmware-2.2.1 state dump this project tests against, and set the "everything is
  provisional" standard NanoGig follows.

Thank you both. What NanoGig added on top (the packet framing, the active-preset field, the
preset-changed event, capture/cab state and toggles) is written up in
[docs/PROTOCOL.md](docs/PROTOCOL.md). Attributions are in [NOTICE](NOTICE).

## For developers

Vite + TypeScript, no framework, no backend. `npm install && npm run dev`, then `?mock=1`
for the fake pedal. Building, URL flags, the code layout, the iPad build and how releases are
cut: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). The bytes: [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Sponsor this project

NanoGig is free, open source and built in spare time with a pedal on the desk. If it saves you
a squint on stage, you can keep the coffee (and the test presets) coming:

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-johnnyborjomi-ffdd00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/johnnyborjomi)

## Privacy, support, license

- No backend, no account. The released app sends anonymous, cookieless usage counts (opens,
  connects, installs, support taps) to Umami, nothing about your pedal: [PRIVACY.md](PRIVACY.md).
- Best-effort support through [GitHub issues](https://github.com/johnnyborjomi/NanoGig/issues):
  [SUPPORT.md](SUPPORT.md). For pedal problems, use Neural DSP's own support.
- MIT license: [LICENSE](LICENSE). Not an official Neural DSP product; no Neural DSP code,
  firmware, artwork or captures are included; the protocol was learned by observing traffic
  from users' own pedals, not by decompiling Neural DSP software. Provided as is, without
  warranty. You are responsible for what you send to your hardware.
