import './ui/styles.css';
import { Capacitor } from '@capacitor/core';
import { BleTransport, canResumePermittedDevices, isWebBluetoothAvailable } from './transport/ble';
import { CapacitorBleTransport } from './transport/ble-capacitor';
import { MockTransport } from './transport/mock';
import type { Transport } from './transport/types';
import { Store } from './state/store';
import type { PresetLabelStyle } from './protocol/frames';
import { WebMidiOut } from './transport/webmidi';
import { SyncEngine } from './sync/engine';
import { localMetadataCache } from './sync/metadata-cache';
import { GigView } from './ui/gigview';
import { AppUpdater, InstallPrompt } from './pwa';

const params = new URLSearchParams(location.search);
const flag = (name: string) => params.get(name) === '1' || params.get(name) === 'true';

const forceMock = flag('mock');
let writesEnabled = flag('writes');
const debug = flag('debug');
const midiStrategy = params.get('midi'); // pin a MIDI delivery strategy, e.g. ?midi=c303-ble-midi

const SETTINGS_KEY = 'nanogig.settings';
type Settings = { presetsPerBank: number; labelStyle: PresetLabelStyle; showPresetNumber: boolean; showFootswitches: boolean; showPresetStrip: boolean; autoRefreshNames: boolean; liveTuner: boolean };
function loadSettings(): Partial<Settings> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const out: Partial<Settings> = {};
    if (typeof parsed.presetsPerBank === 'number' && parsed.presetsPerBank >= 1 && parsed.presetsPerBank <= 64) out.presetsPerBank = parsed.presetsPerBank;
    if (parsed.labelStyle === 'number-letter' || parsed.labelStyle === 'letter-number') out.labelStyle = parsed.labelStyle;
    if (typeof parsed.showPresetNumber === 'boolean') out.showPresetNumber = parsed.showPresetNumber;
    if (typeof parsed.showFootswitches === 'boolean') out.showFootswitches = parsed.showFootswitches;
    if (typeof parsed.showPresetStrip === 'boolean') out.showPresetStrip = parsed.showPresetStrip;
    if (typeof parsed.autoRefreshNames === 'boolean') out.autoRefreshNames = parsed.autoRefreshNames;
    if (typeof parsed.liveTuner === 'boolean') out.liveTuner = parsed.liveTuner;
    return out;
  } catch {
    return {};
  }
}
function saveSettings() {
  const { presetsPerBank, labelStyle, showPresetNumber, showFootswitches, showPresetStrip, autoRefreshNames, liveTuner } = store.get();
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ presetsPerBank, labelStyle, showPresetNumber, showFootswitches, showPresetStrip, autoRefreshNames, liveTuner }));
  } catch {
    /* storage unavailable */
  }
}

/** Native shell (Capacitor on iOS/Android) uses the plugin transport; browsers use Web Bluetooth. */
const isNative = Capacitor.isNativePlatform();
type BleLike = BleTransport | CapacitorBleTransport;
const createBle = (): BleLike => (isNative ? new CapacitorBleTransport() : new BleTransport());
const isBle = (t: Transport | null): t is BleLike => t instanceof BleTransport || t instanceof CapacitorBleTransport;

const store = new Store(loadSettings());
const installPrompt = new InstallPrompt(store);
const updater = new AppUpdater(store, `${import.meta.env.BASE_URL}sw.js`);
let transport: Transport | null = null;
let engine: SyncEngine | null = null;
/** Set by Menu → Disconnect: no silent reconnect until the user taps Connect again. */
let userDisconnected = false;

function attach(t: Transport) {
  engine?.dispose();
  transport = t;
  engine = new SyncEngine(t, store, {
    writesEnabled,
    midiStrategy,
    midiOut: t instanceof BleTransport ? new WebMidiOut() : null, // no Web MIDI inside native web views
    metadataCache: localMetadataCache(t.name), // names at once on connect; refreshed in the background
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
      userDisconnected = false;
      store.patch({ lastError: null });
      if (forceMock) return this.connectMock();
      if (!isBle(transport)) attach(createBle());
      await transport!.connect({ acceptAll: !!acceptAll });
    },
    connectMock: startMock,
    async disconnect() {
      userDisconnected = true;
      await transport?.disconnect();
    },
    refresh: () => requireEngine().refresh(), // names, then state
    toggleFx: (slot) => requireEngine().toggleFx(slot),
    toggleGate: () => requireEngine().toggleGate(),
    toggleCab: () => requireEngine().toggleCab(),
    toggleCapture: () => requireEngine().toggleCapture(),
    selectPreset: (index) => requireEngine().selectPreset(index),
    setOutputsMuted: (muted) => requireEngine().setOutputsMuted(muted),
    startTuner: () => requireEngine().startTuner(),
    stopTuner: () => requireEngine().stopTuner(),
    setTunerReference: (hz) => requireEngine().setTunerReference(hz),
    setTunerMute: (muted) => requireEngine().setTunerMute(muted),
    simulateDrop: () => {
      if (transport instanceof MockTransport) transport.simulateDrop();
    },
    setWritesEnabled: (enabled) => {
      writesEnabled = enabled;
      engine?.setWritesEnabled(enabled);
      store.appendLog({ at: Date.now(), dir: 'warn', text: enabled ? 'Control mode ON: tile taps and preset buttons now change the pedal' : 'Control mode off' });
    },
    setSettings: (patch) => {
      store.patch(patch);
      saveSettings();
      if (typeof patch.liveTuner === 'boolean') void engine?.setLiveTuner(patch.liveTuner).catch((e) => store.appendLog({ at: Date.now(), dir: 'warn', text: `Live tuner: ${(e as Error).message}` }));
    },
    installApp: () => installPrompt.install(),
    applyUpdate: () => updater.apply(),
  },
  {
    bluetoothAvailable: (isNative || isWebBluetoothAvailable()) && !forceMock,
    resumeAvailable: isNative || canResumePermittedDevices(),
    showMockButton: true,
    openConsole: debug,
  },
);

// On unload nothing async completes, so drop the link synchronously; a half-open link makes
// the next page's service discovery crawl (seen as "service discovery timed out" on macOS).
window.addEventListener('beforeunload', () => {
  if (transport?.disconnectNow) transport.disconnectNow();
  else void transport?.disconnect();
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
} else if (isNative || canResumePermittedDevices()) {
  // After a reload / relaunch reconnect to the remembered pedal without the chooser.
  tryResume();
  // …and again whenever the app comes back to the foreground while disconnected: the pedal may
  // have been off at launch, or a reconnect loop may have given up while the app was in the
  // background. Menu → Disconnect opts out until the next Connect.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || userDisconnected) return;
    if (transport && !isBle(transport)) return;
    if (transport?.status && transport.status !== 'disconnected') return;
    store.appendLog({ at: Date.now(), dir: 'info', text: 'App in the foreground; trying the last pedal again' });
    tryResume();
  });
} else if (isWebBluetoothAvailable()) {
  store.appendLog({
    at: Date.now(),
    dir: 'info',
    text: 'This Chrome cannot hand back the last pedal without the chooser (navigator.bluetooth.getDevices is missing; it comes with chrome://flags/#enable-web-bluetooth-new-permissions-backend)',
  });
}

function tryResume(): void {
  const ble = isBle(transport) ? transport : createBle();
  if (transport !== ble) attach(ble);
  void ble.resume().then((ok) => {
    if (ok) return;
    store.appendLog({ at: Date.now(), dir: 'info', text: 'Nothing to resume; use Connect' });
    if (store.get().deviceName) {
      store.patch({
        lastError:
          'Could not reach the last pedal. Make sure it is on and not connected to Cortex Cloud or another NanoGig, put it in pairing mode, then tap Connect.',
      });
    }
  });
}

// PWA: install prompt + offline shell + update detection (production builds only; dev keeps HMR simple).
if (import.meta.env.PROD && !isNative) {
  window.addEventListener('load', () => void updater.register());
}
