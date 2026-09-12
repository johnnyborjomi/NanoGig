import './ui/styles.css';
import { BleTransport, isWebBluetoothAvailable } from './transport/ble';
import { MockTransport } from './transport/mock';
import type { Transport } from './transport/types';
import { Store } from './state/store';
import { SyncEngine } from './sync/engine';
import { GigView } from './ui/gigview';

const params = new URLSearchParams(location.search);
const flag = (name: string) => params.get(name) === '1' || params.get(name) === 'true';

const forceMock = flag('mock');
let writesEnabled = flag('writes');
const debug = flag('debug');

const store = new Store();
let transport: Transport | null = null;
let engine: SyncEngine | null = null;

function attach(t: Transport) {
  engine?.dispose();
  transport = t;
  engine = new SyncEngine(t, store, { writesEnabled });
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
      store.appendLog({ at: Date.now(), dir: 'warn', text: enabled ? 'Writes ENABLED: tile taps and ◀ ▶ now change the pedal' : 'Writes disabled' });
    },
    reconnectNow: () => transport?.reconnectNow?.(),
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
if (forceMock) void startMock();
