import './ui/styles.css';
import { Capacitor } from '@capacitor/core';
import { Analytics } from './analytics';
import { isStandalone } from './pwa';
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
type Settings = { presetsPerBank: number; labelStyle: PresetLabelStyle; showPresetNumber: boolean; showFootswitches: boolean; showPresetStrip: boolean; autoRefreshNames: boolean; liveTuner: boolean; expressionPersist: boolean };
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
    if (typeof parsed.expressionPersist === 'boolean') out.expressionPersist = parsed.expressionPersist;
    return out;
  } catch {
    return {};
  }
}
function saveSettings() {
  const { presetsPerBank, labelStyle, showPresetNumber, showFootswitches, showPresetStrip, autoRefreshNames, liveTuner, expressionPersist } = store.get();
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ presetsPerBank, labelStyle, showPresetNumber, showFootswitches, showPresetStrip, autoRefreshNames, liveTuner, expressionPersist }));
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
// Anonymous usage stats (see PRIVACY.md): production channel only, never dev or staging.
const analytics = new Analytics({
  websiteId: 'f6a39126-15e3-4cb0-97e5-f00bf0b68089',
  scriptUrl: 'https://cloud.umami.is/script.js',
  active: import.meta.env.PROD && __CHANNEL__ === 'production' && (isNative || !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)),
});
analytics.track({
  name: 'launch',
  data: { standalone: isNative || isStandalone() ? 'yes' : 'no', platform: isNative ? (Capacitor.getPlatform() === 'android' ? 'android' : 'ios') : 'web' },
});
window.addEventListener('appinstalled', () => analytics.track({ name: 'pwa-installed' }));
// Funnel events, all from store transitions (mock demo excluded): one `connect` per real link
// reaching "connected", one `sync` per link completing its first state dump, `feature` once per
// session per feature, and `session-end` with the preset changes seen when the app goes away.
const featuresUsed = new Set<string>();
const feature = (name: 'tuner' | 'control' | 'preset-switch' | 'expression') => {
  if (featuresUsed.has(name)) return;
  featuresUsed.add(name);
  analytics.track({ name: 'feature', data: { name } });
};
let presetChanges = 0;
{
  let wasConnected = false;
  let syncedThisLink = false;
  let lastSyncAt: number | null = null;
  let lastPreset: number | null = null;
  let lastMovedAt: number | null = null;
  store.subscribe((s) => {
    const real = s.transportName !== 'mock';
    const connected = s.connection === 'connected';
    if (connected && !wasConnected) {
      syncedThisLink = false;
      if (real) analytics.track({ name: 'connect', data: { transport: s.transportName } });
    }
    wasConnected = connected;
    if (connected && !syncedThisLink && s.lastStateSyncAt !== null && s.lastStateSyncAt !== lastSyncAt) {
      syncedThisLink = true;
      if (real) analytics.track({ name: 'sync', data: { firmware: s.firmware.value ?? 'unknown' } });
    }
    lastSyncAt = s.lastStateSyncAt;
    if (connected && s.activePreset.value !== null && lastPreset !== null && s.activePreset.value !== lastPreset) presetChanges++;
    lastPreset = connected ? s.activePreset.value : null;
    if (real && s.expression.movedAt !== null && s.expression.movedAt !== lastMovedAt) feature('expression');
    lastMovedAt = s.expression.movedAt;
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  analytics.track({ name: 'session-end', data: { presetChanges } });
  presetChanges = 0;
});
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
    selectPreset: (index) => {
      if (store.get().transportName !== 'mock') feature('preset-switch');
      return requireEngine().selectPreset(index);
    },
    setOutputsMuted: (muted) => requireEngine().setOutputsMuted(muted),
    startTuner: () => {
      if (store.get().transportName !== 'mock') feature('tuner');
      return requireEngine().startTuner();
    },
    stopTuner: () => requireEngine().stopTuner(),
    setTunerReference: (hz) => requireEngine().setTunerReference(hz),
    setTunerMute: (muted) => requireEngine().setTunerMute(muted),
    simulateDrop: () => {
      if (transport instanceof MockTransport) transport.simulateDrop();
    },
    setWritesEnabled: (enabled) => {
      writesEnabled = enabled;
      if (enabled && store.get().transportName !== 'mock') feature('control');
      engine?.setWritesEnabled(enabled);
      store.appendLog({ at: Date.now(), dir: 'warn', text: enabled ? 'Control mode ON: tile taps and preset buttons now change the pedal' : 'Control mode off' });
    },
    setSettings: (patch) => {
      store.patch(patch);
      saveSettings();
    },
    installApp: () => installPrompt.install(),
    onSupportClick: (source) => analytics.track({ name: 'support-click', data: { source } }),
    onSupportSeen: (source) => analytics.track({ name: 'support-seen', data: { source } }),
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
    if (transport?.status === 'connected') {
      // Still linked, but another app (Cortex Cloud) may have driven the pedal while we were
      // hidden, and iOS shares one Bluetooth link between apps: re-read rather than trust the cache.
      store.appendLog({ at: Date.now(), dir: 'info', text: 'App in the foreground; re-reading the pedal state' });
      void engine?.requestState().catch((e) => store.appendLog({ at: Date.now(), dir: 'warn', text: `State re-read failed: ${(e as Error).message}` }));
      return;
    }
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
