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
- **Capture and cab / IR names**, updating as you scroll the pedal's encoders.
- **Optional control mode**: tap a tile to toggle a block, tap capture or cab to bypass them,
  and pick presets from a bank strip. Off by default; the pedal stays read-only until you
  turn it on.

Nothing is installed on the pedal and nothing leaves your device: no account, no server, no
analytics. It is a web page.

> **Unofficial.** NanoGig is an independent community project, not affiliated with, endorsed
> by or supported by Neural DSP. "Nano Cortex", "Cortex Cloud" and "Neural DSP" are trademarks
> of Neural DSP Technologies, used here only to describe compatibility. The Bluetooth protocol
> is reverse-engineered and every value on screen is provisional. Use at your own risk.

## Screenshots

<!-- screenshots and recordings go here -->

## Get started

1. Disconnect the pedal from Cortex Cloud (the Nano accepts one Bluetooth client at a time).
2. Open **[johnnyborjomi.github.io/NanoGig](https://johnnyborjomi.github.io/NanoGig/)** in a
   browser from the table below.
3. Tap **Connect Nano Cortex**, pick the pedal in the chooser, done. The app reconnects on
   its own after a page reload or a pedal power cycle.
4. Tap the fullscreen button and put the device where you can see it.

No pedal at hand? **Demo mode** on the connect screen runs the whole UI against a fake pedal.

| Device                 | How                                                                                                                        | Live display | Control mode | Preset switching  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------ | ----------------- |
| Laptop / desktop       | Chrome or Edge                                                                                                             | yes          | yes          | yes, pedal on USB |
| Android phone / tablet | Chrome. Menu → *Add to Home screen* installs it as a fullscreen landscape app                                              | yes          | yes          | yes, pedal on USB |
| iPad / iPhone          | [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) browser (Safari has no Web Bluetooth)             | yes          | yes          | no                |
| iPad, native app       | Build it yourself with a free Apple ID: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#ipad--iphone-app-capacitor-free-signing) | yes          | yes          | no                |

**Why USB for presets?** The pedal ignores MIDI sent over its Bluetooth link, so preset changes
go out as MIDI over the USB cable while Bluetooth keeps feeding the display. Everything else
works over Bluetooth alone. Firefox and Safari have no Web Bluetooth and are not supported.

## What's on the screen

- **Top bar**: connection state, **Control** (turns control mode on and off), fullscreen, and a
  menu with Settings, Refresh, the hex Log, Disconnect, and the pedal's firmware version.
- **Preset row**: bank/slot label and preset name, sized to always fit on one line. A small
  tag shows *live* right after a footswitch press until the pedal confirms, or *sending* while
  the app is changing the preset.
- **Capture / cab line**: names plus an on/off indicator in each label. A lock instead of the
  indicator means that capture or cab is a factory one the app could not switch back on, so it
  leaves it alone.
- **Gate and FX tiles**: effect category, model name, colour when on.
- **Preset strip**: seven presets around the active one, the active one framed. In control
  mode the arrows page through all 64 and a tap selects.

**Settings** (menu): presets per bank (2-8, match your MIDI controller; 4 suits an Mvave
Chocolate), label style *1B* or *A2*, whether to show the pedal's own preset number (1-64)
next to the label, and whether to show the Nano's own footswitch assignments as IA / IB /
IIA / IIB badges, for playing without a MIDI controller.

## Control mode

Off by default. When on, taps write to the pedal: FX and gate tiles toggle their block, the
capture and cab labels bypass or re-enable, and the preset strip switches presets (USB
required for that). Every change is confirmed against the pedal's own report a moment later,
so the screen shows what the pedal did, not what the app asked for.

> **Back up your presets in Cortex Cloud before turning control mode on**, and try it on a
> preset you don't mind losing first. The protocol is reverse-engineered; a firmware update can
> change what these commands do.

## Caveats

| Area               | Detail                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Firmware           | Verified on NanOS 2.2.1. Other versions may decode wrongly or not at all. If something looks off, Menu → Log → copy and open an issue with the hex. |
| Bluetooth only     | Preset switching from the app needs the pedal on USB. Not possible from iPad / iPhone.                                                             |
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

- No backend, no analytics, no telemetry: [PRIVACY.md](PRIVACY.md).
- Best-effort support through [GitHub issues](https://github.com/johnnyborjomi/NanoGig/issues):
  [SUPPORT.md](SUPPORT.md). For pedal problems, use Neural DSP's own support.
- MIT license: [LICENSE](LICENSE). Not an official Neural DSP product; no Neural DSP code,
  firmware, artwork or captures are included; the protocol was learned by observing traffic
  from users' own pedals, not by decompiling Neural DSP software. Provided as is, without
  warranty. You are responsible for what you send to your hardware.
