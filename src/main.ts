import './ui/styles.css';
import { BleTransport, canResumePermittedDevices, isWebBluetoothAvailable } from './transport/ble';
import { MockTransport } from './transport/mock';
import type { Transport } from './transport/types';
import { Store } from './state/store';
import type { PresetLabelStyle } from './protocol/frames';
import { WebMidiOut } from './transport/webmidi';
import { SyncEngine } from './sync/engine';
import { GigView } from './ui/gigview';

const params = new URLSearchParams(location.search);
const flag = (name: string) => params.get(name) === '1' || params.get(name) === 'true';

const forceMock = flag('mock');
let writesEnabled = flag('writes');
const debug = flag('debug');
const midiStrategy = params.get('midi'); // pin a MIDI delivery strategy, e.g. ?midi=c303-ble-midi

const SETTINGS_KEY = 'nanogig.settings';
type Settings = { presetsPerBank: number; labelStyle: PresetLabelStyle; showPresetNumber: boolean };
function loadSettings(): Partial<Settings> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const out: Partial<Settings> = {};
    if (typeof parsed.presetsPerBank === 'number' && parsed.presetsPerBank >= 1 && parsed.presetsPerBank <= 64) out.presetsPerBank = parsed.presetsPerBank;
    if (parsed.labelStyle === 'number-letter' || parsed.labelStyle === 'letter-number') out.labelStyle = parsed.labelStyle;
    if (typeof parsed.showPresetNumber === 'boolean') out.showPresetNumber = parsed.showPresetNumber;
    return out;
  } catch {
    return {};
  }
}
function saveSettings() {
  const { presetsPerBank, labelStyle, showPresetNumber } = store.get();
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ presetsPerBank, labelStyle, showPresetNumber }));
  } catch {
    /* storage unavailable */
  }
}

const store = new Store(loadSettings());
let transport: Transport | null = null;
let engine: SyncEngine | null = null;

function attach(t: Transport) {
  engine?.dispose();
  transport = t;
  engine = new SyncEngine(t, store, {
    writesEnabled,
    midiStrategy,
    midiOut: t instanceof BleTransport ? new WebMidiOut() : null,
  });
}

async function startMock(): Promise<void> {
  const mock = new MockTransport({ autoEventIntervalMs: 6000 });
  attach(mock);
  await mock.connect();
}

function requireEngine(): SyncEngine {
  if (!engine) throw new Error('Not connected');
  return engine;
}

const view = new GigView(
  document.getElementById('app')!,
  store,
  {
    async connect(acceptAll) {
      if (forceMock) return this.connectMock();
      if (!(transport instanceof BleTransport)) attach(new BleTransport());
      await transport!.connect({ acceptAll: !!acceptAll });
    },
    connectMock: startMock,
    async disconnect() {
      await transport?.disconnect();
    },
    refresh: () => requireEngine().requestState(),
    refreshNames: () => requireEngine().requestMetadata(),
    toggleFx: (slot) => requireEngine().toggleFx(slot),
    toggleGate: () => requireEngine().toggleGate(),
    nextPreset: () => requireEngine().nextPreset(),
    prevPreset: () => requireEngine().prevPreset(),
    simulateDrop: () => {
      if (transport instanceof MockTransport) transport.simulateDrop();
    },
    setWritesEnabled: (enabled) => {
      writesEnabled = enabled;
      engine?.setWritesEnabled(enabled);
      store.appendLog({ at: Date.now(), dir: 'warn', text: enabled ? 'Control mode ON: tile taps and ◀ ▶ now change the pedal' : 'Control mode off' });
    },
    reconnectNow: () => transport?.reconnectNow?.(),
    setSettings: (patch) => {
      store.patch(patch);
      saveSettings();
    },
  },
  {
    bluetoothAvailable: isWebBluetoothAvailable() && !forceMock,
    showMockButton: true,
    openConsole: debug,
  },
);

window.addEventListener('beforeunload', () => {
  void transport?.disconnect();
});

// Expose for debugging in the devtools console.
Object.assign(window as unknown as Record<string, unknown>, {
  gig: {
    store,
    get engine() {
      return engine;
    },
    get transport() {
      return transport;
    },
    view,
  },
});

// ?mock=1 starts demo mode immediately (the overlay's demo button remains as a fallback).
if (forceMock) {
  void startMock();
} else if (canResumePermittedDevices()) {
  // After a reload (or a Vite full reload) reconnect to the remembered pedal without the chooser.
  const ble = new BleTransport();
  attach(ble);
  void ble.resume().then((ok) => {
    if (!ok) store.appendLog({ at: Date.now(), dir: 'info', text: 'Nothing to resume; use Connect' });
  });
}

// PWA: offline shell for the installed app (production builds only; dev keeps HMR simple).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((err) => console.warn('SW registration failed', err));
  });
}
