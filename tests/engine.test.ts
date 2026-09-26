import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HW_PRESET_SELECT_0, HW_TUNER_OFF_REPORT, HW_TUNER_ON_ACK, HW_TUNER_PITCH_A_PLUS_14 } from '../src/fixtures/hardware-2026-09-19';
import { HW_STATE_PRESET_1 } from '../src/fixtures/hardware-2026-09-26';
import { MockTransport } from '../src/transport/mock';
import { Store } from '../src/state/store';
import { SyncEngine } from '../src/sync/engine';
import { REAL_EVENTS } from '../src/fixtures/captures';
import { HW_BYPASS_CHANGED, HW_PRESET_CHANGED, HW_STATE_EMPTY_CAPTURE_IR, HW_STATE_SEGMENTED, HW_STATE_SINGLE, HW_UNKNOWN_73 } from '../src/fixtures/hardware-2026-09-12';
import { toHex } from '../src/protocol/hex';
import { decodeMetadata } from '../src/protocol/decode';
import { buildMetadataBody, DEMO_PRESETS } from '../src/fixtures/captures';
import type { MetadataCache } from '../src/sync/metadata-cache';

async function flush(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

/** mock.connect() awaits a fake-timer delay, so advance the clock while it resolves. */
async function connect(mock: MockTransport) {
  const p = mock.connect();
  await flush(50);
  await p;
}

function setup(opts: { writes?: boolean; shape?: 'single' | 'segmented' | 'alternate'; cache?: MetadataCache; packetGapMs?: number; idleMs?: number; liveTuner?: boolean } = {}) {
  const mock = new MockTransport({ latencyMs: 10, packetGapMs: opts.packetGapMs ?? 2, stateReplyShape: opts.shape ?? 'alternate' });
  // Live tuner off by default here: the mock's pitch stream counts as pedal activity (idle refresh) and adds noise; its own test covers it.
  const store = new Store({ liveTuner: opts.liveTuner ?? false });
  const engine = new SyncEngine(mock, store, { writesEnabled: opts.writes ?? false, confirmDelayMs: 50, metadataCache: opts.cache ?? null, idleNamesRefreshMs: opts.idleMs ?? 0 });
  return { mock, store, engine };
}

/** In-memory MetadataCache that records every save. */
function memCache(initial: ReturnType<typeof decodeMetadata> | null = null) {
  const saves: ReturnType<typeof decodeMetadata>[] = [];
  let current = initial;
  const cache: MetadataCache & { saves: typeof saves } = {
    saves,
    load: () => current,
    save: (md) => {
      saves.push(md);
      current = md;
    },
  };
  return cache;
}

/** Metadata as the demo pedal reports it, optionally with one preset's fields changed. */
function demoMetadata(change?: { index: number; name?: string; captureName?: string }) {
  const presets = DEMO_PRESETS.map((p) => ({ ...p }));
  if (change) {
    const p = presets[change.index]!;
    presets[change.index] = { ...p, ...(change.name !== undefined ? { name: change.name } : {}), ...(change.captureName !== undefined ? { captureName: change.captureName } : {}) };
  }
  const body = buildMetadataBody(presets);
  return decodeMetadata(body.subarray(0, body.length - 4));
}

const METADATA_REQUEST_HEX = '06 C0 08 03 01 00 00 00';
const metadataRequests = (store: Store) => store.get().log.filter((l) => l.dir === 'tx' && l.hex === METADATA_REQUEST_HEX).length;

describe('SyncEngine with the mock transport', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('connect → metadata → state populates the store with provisional fields', async () => {
    const { mock, store, engine } = setup();
    await connect(mock);
    await flush(2500); // metadata stream + 1500 ms debounce
    const s1 = store.get();
    expect(s1.presetNames.value[7]).toBe('Clean Chief');
    expect(s1.presetNames.value[0]).toBe('Fuzz Face Melter');
    expect(s1.presetNames.source).toBe('metadata');
    await flush(800);
    const s = store.get();
    expect(s.connection).toBe('connected');
    expect(s.syncPhase).toBe('ready');
    expect(s.fxOn.value).toEqual({ pre1: false, pre2: false, post1: true, post2: true, post3: true });
    expect(s.gateOn.value).toBe(true);
    expect(s.cabOn.value).toBe(false);
    expect(s.captureName.value).toBe('NoMatch Chief 1');
    expect(s.captureOn.value).toBe(true);
    expect(s.irName.value).toBe('110 US PRN C10R');
    expect(s.firmware.value).toBe('2.2.1');
    expect(s.fxOn.provisional).toBe(true);
    expect(s.fxModels.value.pre1?.name).toBe('Transpose');
    expect(s.fxModels.value.post3?.category).toBe('Reverb');
    // Active preset comes from dump field 13 (= 7 in the real capture → "Clean Chief").
    expect(s.activePreset.value).toBe(7);
    expect(s.activePreset.source).toBe('dump');
    engine.dispose();
  });

  it('a footswitch preset event updates the active preset and re-requests the state dump', async () => {
    const { mock, store, engine } = setup();
    await connect(mock);
    await flush(3500);
    const txBefore = store.get().log.filter((l) => l.dir === 'tx').length;
    mock.pressFootswitch(2);
    await flush(0);
    expect(store.get().activePreset.value).toBe(2);
    expect(store.get().activePreset.source).toBe('event');
    await flush(1000);
    const txAfter = store.get().log.filter((l) => l.dir === 'tx').length;
    expect(txAfter).toBeGreaterThan(txBefore);
    expect(store.get().captureName.value).toBe('Brit 1959 Crunch'); // preset 2 in the demo table
    expect(store.get().activePreset.value).toBe(2);
    expect(store.get().activePreset.source).toBe('dump'); // confirmed by the follow-up dump
    engine.dispose();
  });

  it('handles the 2-byte MIDI PC event shape too', async () => {
    const { mock, store, engine } = setup();
    await connect(mock);
    await flush(3500);
    mock.inject(Uint8Array.from([0xc0, 5]));
    await flush(0);
    expect(store.get().activePreset.value).toBe(5);
    expect(store.get().activePreset.source).toBe('event');
    engine.dispose();
  });

  it('expression telemetry does not trigger a state re-request; a knob burst triggers one', async () => {
    const { mock, store, engine } = setup();
    await connect(mock);
    await flush(3500);
    const txBefore = store.get().log.filter((l) => l.dir === 'tx').length;
    mock.inject(REAL_EVENTS.expressionToe);
    mock.inject(REAL_EVENTS.expressionHeel);
    await flush(1000);
    expect(store.get().log.filter((l) => l.dir === 'tx').length).toBe(txBefore);
    mock.inject(REAL_EVENTS.gainKnob); // knobs may carry tempo changes → one debounced re-read
    mock.inject(REAL_EVENTS.gainKnob);
    await flush(1000);
    expect(store.get().log.filter((l) => l.dir === 'tx').length).toBe(txBefore + 1);
    engine.dispose();
  });

  it('an unrecognised live event triggers one debounced state re-request', async () => {
    const { mock, store, engine } = setup();
    await connect(mock);
    await flush(3500);
    const count = () => store.get().log.filter((l) => l.dir === 'tx' && l.hex === toHex(Uint8Array.from([0x0c, 0xc0, 0x08, 0x03, 0x18, 0x01, 0x20, 0x01, 0x28, 0x01, 0x01, 0, 0, 0]))).length;
    const before = count();
    mock.inject(HW_UNKNOWN_73);
    mock.inject(HW_UNKNOWN_73);
    mock.inject(HW_UNKNOWN_73);
    await flush(300);
    expect(count()).toBe(before);
    await flush(200);
    expect(count()).toBe(before + 1);
    engine.dispose();
  });

  it('footswitch encoder turns (capture / cab scrolling) trigger one debounced state re-read; knobs do not', async () => {
    const { mock, store, engine } = setup();
    await connect(mock);
    await flush(3500);
    const count = () => store.get().log.filter((l) => l.dir === 'tx' && l.hex === toHex(Uint8Array.from([0x0c, 0xc0, 0x08, 0x03, 0x18, 0x01, 0x20, 0x01, 0x28, 0x01, 0x01, 0, 0, 0]))).length;
    const before = count();
    mock.inject(REAL_EVENTS.expressionToe);
    await flush(600);
    expect(count()).toBe(before); // expression: ignored
    mock.inject(REAL_EVENTS.encoderI);
    mock.inject(REAL_EVENTS.encoderI);
    mock.inject(REAL_EVENTS.encoderI);
    await flush(300);
    expect(count()).toBe(before);
    await flush(200);
    expect(count()).toBe(before + 1); // one re-read after the burst
    engine.dispose();
  });

  it('replays the hardware session: single dump, footswitch event, bypass event, two-packet dump', async () => {
    const { mock, store, engine } = setup();
    await connect(mock);
    await flush(3500);
    mock.inject(HW_STATE_SINGLE);
    await flush(0);
    expect(store.get().activePreset.value).toBe(14);
    expect(store.get().captureName.value).toBe("CA John's Ch1 1");
    expect(store.get().footswitches.value).toEqual({ ia: 3, ib: 5, iia: 20, iib: 14 }); // dump fields 14/15/38/39
    mock.inject(HW_PRESET_CHANGED);
    mock.inject(HW_BYPASS_CHANGED);
    mock.inject(HW_UNKNOWN_73);
    await flush(0);
    expect(store.get().activePreset.value).toBe(3);
    expect(store.get().activePreset.source).toBe('event');
    expect(store.get().footswitches).toMatchObject({ value: { ia: 3, ib: 5, iia: 20, iib: 14 }, source: 'event' });
    mock.inject(HW_STATE_SEGMENTED[0]!);
    mock.inject(HW_STATE_SEGMENTED[1]!);
    await flush(0);
    expect(store.get().activePreset.value).toBe(3);
    expect(store.get().captureName.value).toBe('EVH 5150III Ch3 Gain3');
    expect(store.get().fxOn.value).toEqual({ pre1: false, pre2: true, post1: true, post2: false, post3: false });
    engine.dispose();
  });

  it('decodes a segmented state dump the same as a single packet', async () => {
    const { mock, store, engine } = setup({ shape: 'segmented' });
    await connect(mock);
    await flush(3500);
    mock.pressFootswitch(4);
    await flush(1200);
    expect(store.get().captureName.value).toBe('Cali Recto Modern');
    engine.dispose();
  });

  it('fills every populated preset name slot from the metadata dump', async () => {
    const { mock, store, engine } = setup();
    await connect(mock);
    await flush(3500);
    expect(store.get().presetNames.value[2]).toBe('Plexi Crunch');
    engine.dispose();
  });

  it('clears device state on disconnect and re-syncs on reconnect with a state dump only', async () => {
    const { mock, store, engine } = setup();
    await connect(mock);
    await flush(3500);
    mock.simulateDrop(100);
    await flush(0);
    expect(store.get().connection).toBe('reconnecting');
    expect(store.get().fxOn.value.pre1).toBeNull();
    expect(store.get().presetNames.value[7]).toBe('Clean Chief'); // names kept
    await flush(1000);
    expect(store.get().connection).toBe('connected');
    expect(store.get().syncPhase).toBe('ready');
    expect(store.get().fxOn.value.post1).toBe(true);
    // The reconnect reads state only: names were kept, and re-streaming them would leave the
    // screen deaf to footswitch presses for the duration.
    const metadataRequests = store.get().log.filter((l) => l.dir === 'tx' && l.hex === '06 C0 08 03 01 00 00 00').length;
    expect(metadataRequests).toBe(1);
    engine.dispose();
  });
});

describe('SyncEngine writes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('are refused when the flag is off', async () => {
    const { mock, engine } = setup({ writes: false });
    await connect(mock);
    await flush(3500);
    await expect(engine.toggleFx('pre1')).rejects.toThrow(/disabled/);
    await expect(engine.nextPreset()).rejects.toThrow(/disabled/);
    engine.dispose();
  });

  it('toggleFx sends the byte-exact bypass frame, updates optimistically, then confirms from the dump', async () => {
    const { mock, store, engine } = setup({ writes: true });
    await connect(mock);
    await flush(3500);
    expect(store.get().fxOn.value.pre1).toBe(false);
    await engine.toggleFx('pre1');
    expect(store.get().fxOn.value.pre1).toBe(true);
    expect(store.get().fxOn.source).toBe('optimistic');
    const tx = store.get().log.filter((l) => l.dir === 'tx').map((l) => l.hex);
    expect(tx).toContain('0A C0 08 01 18 04 20 00 1F 00 00 00');
    await flush(1000);
    expect(store.get().fxOn.source).toBe('dump');
    expect(store.get().fxOn.value.pre1).toBe(true);
    expect(mock.device.fxOn.pre1).toBe(true);
    engine.dispose();
  });

  it('selectPreset switches over Bluetooth with the c304 select frame and confirms through the state dump', async () => {
    // Mock pedal behaves like NanOS 2.2.1 (2026-09-19 capture): honours the c304 select, no 0x1D event.
    const mock = new MockTransport({ latencyMs: 10, packetGapMs: 2 });
    const store = new Store();
    const engine = new SyncEngine(mock, store, { writesEnabled: true, confirmDelayMs: 50, presetConfirmTimeoutMs: 300 });
    await connect(mock);
    await flush(3500);

    const p = engine.selectPreset(3);
    await flush(1500);
    await p;
    const tx = store.get().log.filter((l) => l.dir === 'tx');
    const select = tx.find((l) => l.text.includes('[c304-select]'));
    expect(select?.hex).toBe(toHex(HW_PRESET_SELECT_0).replace('20 00 28', '20 03 28'));
    expect(tx.some((l) => l.hex === '06 C0 20 01 1E 00 00 00')).toBe(false); // no MIDI ack frame on this path
    expect(tx.filter((l) => l.text.includes('[')).map((l) => /\[([a-z0-9-]+)\]/.exec(l.text)![1])).toEqual(['c304-select']);
    expect(store.get().log.some((l) => /Preset select acknowledged/.test(l.text))).toBe(true);
    expect(engine.activeMidiStrategy?.id).toBe('c304-select');
    expect(store.get().activePreset.value).toBe(3);
    expect(store.get().activePreset.source).toBe('dump');
    expect(store.get().captureName.value).toBe('Brit 1959 Crunch');

    const before = tx.length;
    const q = engine.selectPreset(4);
    await flush(1500);
    await q;
    const later = store.get().log.filter((l) => l.dir === 'tx').slice(before);
    expect(later.filter((l) => l.text.includes('[')).map((l) => l.text)).toEqual(['TX c304 [c304-select] preset select']);
    expect(store.get().activePreset.value).toBe(4);
    engine.dispose();
  });

  it('selectPreset probes MIDI deliveries until the device confirms, then remembers the winner', async () => {
    // Mock pedal: ignores the c304 select, rejects raw c302 like the hardware did, honours c303 BLE-MIDI framing.
    const mock = new MockTransport({ latencyMs: 10, packetGapMs: 2, acceptedMidi: 'c303-ble-midi' });
    const store = new Store();
    const engine = new SyncEngine(mock, store, { writesEnabled: true, confirmDelayMs: 50, presetConfirmTimeoutMs: 300 });
    await connect(mock);
    await flush(3500);

    const p = engine.selectPreset(3);
    await flush(2500);
    await p;
    const tx = store.get().log.filter((l) => l.dir === 'tx');
    expect(tx.some((l) => l.text.includes('[c304-select]'))).toBe(true); // tried first, ignored by this pedal
    expect(tx.some((l) => l.text.includes('c303-ble-midi') && l.hex === '80 80 C0 03')).toBe(true);
    expect(tx.some((l) => l.hex === '06 C0 20 01 1E 00 00 00')).toBe(true);
    expect(engine.activeMidiStrategy?.id).toBe('c303-ble-midi');
    expect(store.get().activePreset.value).toBe(3);
    expect(store.get().captureName.value).toBe('Brit 1959 Crunch');

    // Second switch goes straight to the remembered strategy: exactly one MIDI write.
    const before = store.get().log.filter((l) => l.dir === 'tx' && l.text.startsWith('TX c30') && l.text.includes('[')).length;
    const q = engine.selectPreset(4);
    await flush(1500);
    await q;
    const after = store.get().log.filter((l) => l.dir === 'tx' && l.text.startsWith('TX c30') && l.text.includes('[')).length;
    expect(after - before).toBe(1);
    expect(store.get().activePreset.value).toBe(4);
    engine.dispose();
  });

  it('selectPreset walks past a rejected and an ignored strategy to reach the working one', async () => {
    const mock = new MockTransport({ latencyMs: 10, packetGapMs: 2, acceptedMidi: 'c303-raw' });
    const store = new Store();
    const engine = new SyncEngine(mock, store, { writesEnabled: true, confirmDelayMs: 50, presetConfirmTimeoutMs: 200 });
    await connect(mock);
    await flush(3500);
    const p = engine.selectPreset(5);
    await flush(3500);
    await p;
    const ids = store
      .get()
      .log.filter((l) => l.dir === 'tx' && /\[(c30[234]-[a-z-]+)\]/.test(l.text))
      .map((l) => /\[(c30[234]-[a-z-]+)\]/.exec(l.text)![1]);
    expect(ids).toEqual(['c304-select', 'c303-ble-midi', 'c302-ble-midi', 'c303-raw']);
    expect(engine.activeMidiStrategy?.id).toBe('c303-raw');
    expect(store.get().activePreset.value).toBe(5);
    engine.dispose();
  });

  it('falls back to Web MIDI when the pedal ignores the Bluetooth select and a USB output is available', async () => {
    const mock = new MockTransport({ latencyMs: 10, packetGapMs: 2, acceptedMidi: 'none' });
    const store = new Store();
    const sent: number[][] = [];
    const midiOut = {
      id: 'web-midi',
      portName: 'Neural DSP Nano Cortex Bluetooth',
      isSupported: () => true,
      open: async () => {},
      send: async (bytes: Uint8Array) => {
        sent.push(Array.from(bytes));
        mock.pressFootswitch(bytes[1]!); // the pedal reports the switch like a footswitch press
      },
    };
    const engine = new SyncEngine(mock, store, { writesEnabled: true, midiOut, confirmDelayMs: 50, presetConfirmTimeoutMs: 300 });
    await connect(mock);
    await flush(3500);
    const p = engine.selectPreset(6);
    await flush(1500);
    await p;
    expect(sent).toEqual([[0xc0, 6]]);
    expect(engine.activeMidiStrategy?.id).toBe('web-midi');
    expect(store.get().log.filter((l) => l.dir === 'tx' && /\[c30[23]/.test(l.text))).toHaveLength(0); // no BLE-MIDI attempts
    expect(store.get().activePreset.value).toBe(6);
    engine.dispose();
  });

  it('falls back to BLE variants when Web MIDI has no Nano output', async () => {
    const mock = new MockTransport({ latencyMs: 10, packetGapMs: 2, acceptedMidi: 'c303-ble-midi' });
    const store = new Store();
    const midiOut = {
      id: 'web-midi',
      portName: null,
      isSupported: () => true,
      open: async () => {
        throw new Error('No Nano Cortex MIDI output (outputs: none). Connect the pedal over USB for preset switching.');
      },
      send: async () => {},
    };
    const engine = new SyncEngine(mock, store, { writesEnabled: true, midiOut, confirmDelayMs: 50, presetConfirmTimeoutMs: 300 });
    await connect(mock);
    await flush(3500);
    const p = engine.selectPreset(2);
    await flush(2500);
    await p;
    expect(store.get().log.some((l) => l.dir === 'warn' && /web-midi rejected: No Nano Cortex MIDI output/.test(l.text))).toBe(true);
    expect(engine.activeMidiStrategy?.id).toBe('c303-ble-midi');
    expect(store.get().activePreset.value).toBe(2);
    engine.dispose();
  });

  it('toggleCab bypasses with slot 0 and re-enables with the IR slot from metadata', async () => {
    const mock = new MockTransport({ latencyMs: 10, packetGapMs: 2, initialState: { cabOn: true } });
    const store = new Store();
    const engine = new SyncEngine(mock, store, { writesEnabled: true, confirmDelayMs: 50 });
    await connect(mock);
    await flush(3500);
    mock.pressFootswitch(4); // "Rectified": IR '412 US OS V30' = 3rd unique IR in the demo list → slot 3
    await flush(1000);
    expect(store.get().cabOn.value).toBe(true);
    await engine.toggleCab();
    expect(store.get().cabOn.value).toBe(false);
    await flush(1000);
    expect(store.get().cabOn.value).toBe(false); // confirmed by the dump
    await engine.toggleCab();
    await flush(1000);
    expect(store.get().cabOn.value).toBe(true);
    const tx = store.get().log.filter((l) => l.dir === 'tx').map((l) => l.hex);
    expect(tx).toContain('08 C0 18 03 20 00 1C 00 00 00');
    expect(tx).toContain('08 C0 18 03 20 03 1C 00 00 00');
    engine.dispose();
  });

  it('toggleCapture bypasses and re-enables by the capture slot from metadata', async () => {
    const mock = new MockTransport({ latencyMs: 10, packetGapMs: 2 });
    const store = new Store();
    const engine = new SyncEngine(mock, store, { writesEnabled: true, confirmDelayMs: 50 });
    await connect(mock);
    await flush(3500);
    mock.pressFootswitch(4); // capture 'Cali Recto Modern' = 3rd unique capture → slot 3 → index 2
    await flush(1000);
    expect(store.get().captureOn.value).toBe(true);
    await engine.toggleCapture();
    await flush(1000);
    expect(store.get().captureOn.value).toBe(false);
    await engine.toggleCapture();
    await flush(1000);
    expect(store.get().captureOn.value).toBe(true);
    const tx = store.get().log.filter((l) => l.dir === 'tx').map((l) => l.hex);
    expect(tx).toContain('08 C0 18 01 20 00 1C 00 00 00');
    expect(tx).toContain('08 C0 18 04 20 02 1C 00 00 00');
    engine.dispose();
  });

  it('locks the cab toggle (both ways) when the IR is not in the slot list, and publishes that', async () => {
    const mock = new MockTransport({ latencyMs: 10, packetGapMs: 2, initialState: { cabOn: false } });
    const store = new Store();
    const engine = new SyncEngine(mock, store, { writesEnabled: true, confirmDelayMs: 50 });
    await connect(mock);
    await flush(3500); // real dump: IR '110 US PRN C10R' is not among the demo metadata's 5 IRs
    expect(store.get().cabOn.value).toBe(false);
    expect(store.get().cabSlotKnown.value).toBe(false);
    expect(store.get().captureSlotKnown.value).toBe(true); // demo capture is in the list
    await expect(engine.toggleCab()).rejects.toThrow(/not among the pedal/);
    // A preset with no capture and no IR at all (hardware 2026-09-13, preset 51): both locked.
    mock.inject(HW_STATE_EMPTY_CAPTURE_IR);
    await flush(0);
    expect(store.get().captureName.value).toBe(null);
    expect(store.get().captureSlotKnown.value).toBe(false);
    expect(store.get().cabSlotKnown.value).toBe(false);
    engine.dispose();
  });

  it('a pinned strategy is used alone and failure is reported', async () => {
    const mock = new MockTransport({ latencyMs: 10, packetGapMs: 2, acceptedMidi: 'c303-ble-midi' });
    const store = new Store();
    const engine = new SyncEngine(mock, store, { writesEnabled: true, midiStrategy: 'c302-raw', presetConfirmTimeoutMs: 200 });
    await connect(mock);
    await flush(3500);
    const p = engine.selectPreset(2);
    await flush(2000);
    await p;
    const midiWrites = store.get().log.filter((l) => l.dir === 'tx' && l.text.includes('['));
    expect(midiWrites).toHaveLength(1);
    expect(store.get().log.some((l) => l.dir === 'error' && /no delivery was confirmed/.test(l.text))).toBe(true);
    expect(store.get().activePreset.value).toBe(7); // resynced from the pedal
    engine.dispose();
  });
});

describe('outputs 1/2 mute', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads the device settings once per link after the first state dump and learns the mute state', async () => {
    const { mock, store, engine } = setup();
    await connect(mock);
    await flush(4000);
    const settingsLines = store.get().log.filter((l) => l.text.startsWith('Device settings:'));
    expect(settingsLines.length).toBe(1);
    expect(settingsLines[0]!.text).toContain('outputs 1/2 on');
    expect(settingsLines[0]!.text).toContain('f5="Neural DSP Nano Cortex"');
    expect(store.get().outputsMuted.value).toBe(false);
    expect(store.get().outputsMuted.source).toBe('dump');
    engine.dispose();
  });

  it('works without control mode: writes the captured frame and waits for the ack', async () => {
    const { mock, store, engine } = setup({ writes: false });
    await connect(mock);
    await flush(4000);
    expect(store.get().outputsMuted.value).toBe(false); // as read from the pedal at connect
    expect(engine.writesEnabled).toBe(false);
    const p = engine.setOutputsMuted(true);
    await flush(0);
    expect(store.get().outputsMuted.value).toBe(true);
    expect(store.get().outputsMuted.source).toBe('optimistic');
    const tx = store.get().log.filter((l) => l.dir === 'tx').map((l) => l.hex);
    expect(tx).toContain('08 C0 08 01 68 01 43 00 00 00'); // 1 = mute
    await flush(100);
    await p;
    expect(store.get().outputsMuted.value).toBe(true);
    expect(['event', 'dump']).toContain(store.get().outputsMuted.source); // ack, then the settings re-read
    expect(store.get().log.some((l) => l.text.includes('Outputs 1/2 muted: acknowledged'))).toBe(true);

    await flush(500); // the ack triggers a settings re-read that confirms the switch
    expect(store.get().log.filter((l) => l.text.startsWith('Device settings:')).length).toBe(2);
    expect(store.get().outputsMuted.value).toBe(true);
    expect(store.get().outputsMuted.source).toBe('dump');

    const p2 = engine.setOutputsMuted(false);
    await flush(100);
    await p2;
    expect(store.get().log.filter((l) => l.dir === 'tx').map((l) => l.hex)).toContain('08 C0 08 01 68 00 43 00 00 00'); // 0 = outputs on
    await flush(500);
    expect(store.get().outputsMuted.value).toBe(false);
    expect(store.get().outputsMuted.source).toBe('dump');
    engine.dispose();
  });

  it('refuses while disconnected and forgets the switch state on disconnect', async () => {
    const { mock, store, engine } = setup({ writes: false });
    await expect(engine.setOutputsMuted(true)).rejects.toThrow(/Not connected/);
    await connect(mock);
    await flush(4000);
    const p = engine.setOutputsMuted(true);
    await flush(100);
    await p;
    expect(store.get().outputsMuted.value).toBe(true);
    await mock.disconnect();
    await flush(10);
    expect(store.get().outputsMuted.value).toBeNull();
    engine.dispose();
  });
});

describe('metadata cache (fast start)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('first connect with an empty cache streams metadata as before and then saves it', async () => {
    const cache = memCache();
    const { mock, store, engine } = setup({ cache });
    const phases: string[] = [];
    store.subscribe((s) => {
      if (phases[phases.length - 1] !== s.syncPhase) phases.push(s.syncPhase);
    });
    await connect(mock);
    await flush(3500);
    expect(phases).toEqual(['idle', 'metadata', 'state', 'ready']);
    expect(store.get().syncPhase).toBe('ready');
    expect(store.get().presetNames.source).toBe('metadata');
    expect(cache.saves.length).toBe(1);
    expect(cache.saves[0]!.presets[7]!.name).toBe('Clean Chief');
    engine.dispose();
  });

  it('with a warm cache the names are on screen at connect and the link is live after one state dump, with no metadata stream', async () => {
    const cache = memCache(demoMetadata({ index: 7, name: 'Old Name' }));
    const { mock, store, engine } = setup({ cache });
    const seen: string[] = [];
    store.subscribe((s) => {
      const key = `${s.syncPhase}|${s.presetNames.source}|${s.presetNames.value[7]}`;
      if (seen[seen.length - 1] !== key) seen.push(key);
    });
    await connect(mock);
    await flush(3500);
    expect(seen).toEqual([
      'idle|none|',
      'idle|cache|Old Name', // names on screen before the pedal has replied to anything
      'state|cache|Old Name', // one small state dump…
      'ready|cache|Old Name', // …and the link is live: no "Loading presets…" phase at all
    ]);
    // A plain rename keeps the same capture / IR, so nothing flags the cache as stale: the pedal
    // is never asked to stream the names (that would leave the screen deaf for ~6 s).
    expect(metadataRequests(store)).toBe(0);
    expect(store.get().presetNames.value[0]).toBe('Fuzz Face Melter');
    expect(store.get().activePreset.value).toBe(7);
    expect(cache.saves.length).toBe(0);
    engine.dispose();
  });

  it('Menu → Refresh re-reads the names without the loading phase, then a fresh state dump', async () => {
    const cache = memCache(demoMetadata({ index: 7, name: 'Old Name' }));
    const { mock, store, engine } = setup({ cache });
    await connect(mock);
    await flush(3500);
    expect(store.get().presetNames.value[7]).toBe('Old Name');
    const phases: string[] = [];
    let sawRefreshing = false;
    store.subscribe((s) => {
      if (phases[phases.length - 1] !== s.syncPhase) phases.push(s.syncPhase);
      if (s.namesRefreshing) sawRefreshing = true;
    });
    const p = engine.refresh();
    await flush(3500);
    await p;
    expect(sawRefreshing).toBe(true); // "updating names…" in the status line meanwhile
    expect(phases).not.toContain('metadata'); // names stayed on screen while the pedal streamed
    expect(metadataRequests(store)).toBe(1);
    expect(store.get().presetNames.value[7]).toBe('Clean Chief');
    expect(store.get().presetNames.source).toBe('metadata');
    expect(store.get().namesRefreshing).toBe(false);
    expect(store.get().syncPhase).toBe('ready');
    engine.dispose();
  });

  it('re-reads the names silently when the state dump contradicts the cached record of the active preset', async () => {
    const cache = memCache(demoMetadata({ index: 7, name: 'Old Name', captureName: 'Some Other Capture' }));
    const { mock, store, engine } = setup({ cache });
    const phases: string[] = [];
    store.subscribe((s) => {
      if (phases[phases.length - 1] !== s.syncPhase) phases.push(s.syncPhase);
    });
    await connect(mock);
    await flush(3500);
    expect(phases).not.toContain('metadata'); // silent: the stale names stayed on screen meanwhile
    expect(metadataRequests(store)).toBe(1);
    expect(store.get().log.some((l) => l.text.includes('Cached names look stale'))).toBe(true);
    expect(store.get().presetNames.value[7]).toBe('Clean Chief');
    expect(store.get().presetNames.source).toBe('metadata');
    expect(cache.saves.length).toBe(1);
    engine.dispose();
  });

  it('a footswitch press during a metadata stream wins over the stale state embedded in the reply', async () => {
    const cache = memCache(demoMetadata({ index: 7, captureName: 'Some Other Capture' }));
    const { mock, store, engine } = setup({ cache, shape: 'single', packetGapMs: 50 });
    await connect(mock); // state dump → ready → silent metadata refresh starts streaming
    expect(store.get().syncPhase).toBe('ready');
    expect(metadataRequests(store)).toBe(1);
    mock.pressFootswitch(2); // while the stream is still in flight
    await flush(0);
    expect(store.get().activePreset.value).toBe(2);
    await flush(2000); // stream completes, its embedded state says preset 7
    expect(store.get().log.some((l) => l.text.includes('Ignoring the state embedded'))).toBe(true);
    expect(store.get().activePreset.value).toBe(2);
    expect(store.get().activePreset.source).toBe('dump'); // confirmed by the follow-up state dump
    expect(store.get().presetNames.value[7]).toBe('Clean Chief');
    engine.dispose();
  });

  it('a reconnect within the session also goes state-only', async () => {
    const { mock, store, engine } = setup();
    await connect(mock);
    await flush(4000);
    expect(store.get().syncPhase).toBe('ready');
    await mock.disconnect();
    await flush(10);
    const phases: string[] = [];
    store.subscribe((s) => {
      if (phases[phases.length - 1] !== s.syncPhase) phases.push(s.syncPhase);
    });
    await connect(mock);
    await flush(300);
    expect(store.get().syncPhase).toBe('ready');
    expect(phases).not.toContain('metadata');
    expect(store.get().presetNames.value[7]).toBe('Clean Chief');
    expect(metadataRequests(store)).toBe(1);
    engine.dispose();
  });
});

describe('idle names refresh', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('re-reads cached names once the pedal has been quiet, silently, and shows the indicator meanwhile', async () => {
    const cache = memCache(demoMetadata({ index: 7, name: 'Old Name' }));
    const { mock, store, engine } = setup({ cache, idleMs: 5000, packetGapMs: 50 });
    const phases: string[] = [];
    store.subscribe((s) => {
      if (phases[phases.length - 1] !== s.syncPhase) phases.push(s.syncPhase);
    });
    await connect(mock);
    await flush(2000);
    expect(store.get().presetNames.value[7]).toBe('Old Name');
    expect(metadataRequests(store)).toBe(0);
    await flush(3100); // just past 5 s since the last pedal activity (the settings reply after connect)
    expect(metadataRequests(store)).toBe(1);
    expect(store.get().namesRefreshing).toBe(true); // stream in flight
    expect(store.get().log.some((l) => l.text.includes('Pedal idle for 5 s'))).toBe(true);
    await flush(2000);
    expect(store.get().namesRefreshing).toBe(false);
    expect(store.get().presetNames.value[7]).toBe('Clean Chief');
    expect(store.get().presetNames.source).toBe('metadata');
    expect(phases).not.toContain('metadata');
    await flush(10000);
    expect(metadataRequests(store)).toBe(1); // once per connect: names are no longer from the cache
    engine.dispose();
  });

  it('applies to a reconnect within the session too: names from the previous link are re-read once idle', async () => {
    const { mock, store, engine } = setup({ idleMs: 5000, packetGapMs: 50 });
    await connect(mock);
    await flush(4000);
    expect(store.get().presetNames.source).toBe('metadata');
    expect(metadataRequests(store)).toBe(1);
    await flush(20000);
    expect(metadataRequests(store)).toBe(1); // fresh from this link: nothing to re-read
    // Renamed in Cortex Cloud while the app was disconnected (same capture / IR, so only a
    // re-read can notice), then the app reconnects on its own.
    await mock.disconnect();
    await flush(10);
    mock.presets[7] = { ...mock.presets[7]!, name: 'Renamed Chief' };
    await connect(mock);
    await flush(2000);
    expect(store.get().syncPhase).toBe('ready');
    expect(store.get().presetNames.source).toBe('cache'); // known, but from the previous link
    expect(store.get().presetNames.value[7]).toBe('Clean Chief');
    expect(metadataRequests(store)).toBe(1);
    await flush(3100);
    expect(metadataRequests(store)).toBe(2);
    await flush(2000);
    expect(store.get().presetNames.value[7]).toBe('Renamed Chief');
    expect(store.get().presetNames.source).toBe('metadata');
    engine.dispose();
  });

  it('keeps postponing while the pedal is active, and never fires when the setting is off', async () => {
    const cache = memCache(demoMetadata());
    const { mock, store, engine } = setup({ cache, idleMs: 5000 });
    await connect(mock);
    await flush(2000);
    for (let i = 0; i < 4; i++) {
      mock.pressFootswitch(i); // every 3 s: never 5 s of quiet
      await flush(3000);
    }
    expect(metadataRequests(store)).toBe(0);
    store.patch({ autoRefreshNames: false });
    await flush(20000);
    expect(metadataRequests(store)).toBe(0);
    engine.dispose();
  });
});

describe('tuner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('start writes tuner-on, readings stream into the store, reference re-sends, stop writes tuner-off', async () => {
    const mock = new MockTransport({ latencyMs: 10, packetGapMs: 2 });
    const store = new Store({ liveTuner: false });
    const engine = new SyncEngine(mock, store, { writesEnabled: false }); // no control mode needed
    await connect(mock);
    await flush(3500);
    expect(store.get().tuner.referenceHz).toBe(440);

    await engine.startTuner();
    expect(store.get().tuner.on).toBe(true);
    const tx = () => store.get().log.filter((l) => l.dir === 'tx').map((l) => l.hex);
    expect(tx()).toContain('0F C0 20 01 2D 00 00 DC 43 30 01 38 00 7F 00 00 00');
    await flush(400);
    const r = store.get().tuner.reading;
    expect(r).not.toBeNull();
    expect(['E', 'A', 'D', 'G', 'B']).toContain(r!.note);
    expect(typeof r!.cents).toBe('number');
    expect(store.get().log.filter((l) => /Undocumented event/.test(l.text))).toHaveLength(0);

    await engine.setTunerReference(442);
    expect(tx()).toContain('0F C0 20 01 2D 00 00 DD 43 30 01 38 00 7F 00 00 00'); // 442.0 = 0x43DD0000
    await engine.setTunerMute(true);
    expect(tx()).toContain('0F C0 20 01 2D 00 00 DD 43 30 01 38 01 7F 00 00 00');

    await engine.stopTuner();
    expect(tx()).toContain('06 C0 20 00 7F 00 00 00');
    expect(store.get().tuner.on).toBe(false);
    expect(store.get().tuner.reading).toBeNull();
    const before = store.get().log.length;
    await flush(500);
    expect(store.get().log.length).toBe(before); // the mock stream stopped
    engine.dispose();
  });
});

describe('live tuner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is passive: sync and the setting never write tuner-on; the big tuner alone drives the pedal, and with the setting on it stays on (unmuted) after close', async () => {
    const mock = new MockTransport({ latencyMs: 10, packetGapMs: 2 });
    const store = new Store(); // liveTuner defaults to on
    const engine = new SyncEngine(mock, store, { writesEnabled: false, confirmDelayMs: 50 });
    await connect(mock);
    await flush(4000);
    const tx = () => store.get().log.filter((l) => l.dir === 'tx').map((l) => l.hex);
    expect(store.get().tuner.on).toBe(false);
    expect(tx().some((h) => h?.startsWith('0F C0 20 01'))).toBe(false);

    store.patch({ liveTuner: false });
    store.patch({ liveTuner: true });
    await flush(200);
    expect(tx().some((h) => h?.startsWith('0F C0 20 01'))).toBe(false);

    // Big tuner with the setting on: mute, close → the pedal stays in tuner mode, unmuted.
    await engine.startTuner();
    expect(store.get().tuner.on).toBe(true);
    await flush(400);
    expect(store.get().tuner.reading).not.toBeNull();
    await engine.setTunerMute(true);
    expect(tx()).toContain('0F C0 20 01 2D 00 00 DC 43 30 01 38 01 7F 00 00 00');
    await engine.stopTuner();
    expect(store.get().tuner.on).toBe(true);
    expect(store.get().tuner.muted).toBe(false);
    expect(tx().at(-1)).toBe('0F C0 20 01 2D 00 00 DC 43 30 01 38 00 7F 00 00 00');
    expect(tx()).not.toContain('06 C0 20 00 7F 00 00 00');

    // Setting off: Done turns the pedal's tuner off.
    store.patch({ liveTuner: false });
    await engine.startTuner();
    await engine.stopTuner();
    expect(store.get().tuner.on).toBe(false);
    expect(store.get().tuner.reading).toBeNull();
    expect(tx()).toContain('06 C0 20 00 7F 00 00 00');
    // A reading still in flight right after tuner-off does not switch it back on.
    mock.inject(HW_TUNER_PITCH_A_PLUS_14);
    await flush(50);
    expect(store.get().tuner.on).toBe(false);
    await flush(600);
    mock.inject(HW_TUNER_PITCH_A_PLUS_14);
    await flush(50);
    expect(store.get().tuner.on).toBe(true);
    mock.inject(HW_TUNER_OFF_REPORT);
    await flush(50);
    expect(store.get().tuner.on).toBe(false);

    // A preset change on the pedal re-arms nothing while the big tuner is closed.
    const before = tx().length;
    mock.pressFootswitch(2);
    await flush(300);
    expect(tx().slice(before).some((h) => h?.startsWith('0F C0 20 01'))).toBe(false);
    engine.dispose();
  });

  it('mirrors a tuner started on the pedal: a pitch reading or an on-report sets on, an off-report clears it', async () => {
    const mock = new MockTransport({ latencyMs: 10, packetGapMs: 2 });
    const store = new Store();
    const engine = new SyncEngine(mock, store, { writesEnabled: false, confirmDelayMs: 50 });
    await connect(mock);
    await flush(4000);
    expect(store.get().tuner.on).toBe(false);

    mock.inject(HW_TUNER_PITCH_A_PLUS_14);
    await flush(50);
    expect(store.get().tuner.on).toBe(true);
    expect(store.get().tuner.reading?.note).toBe('A');
    expect(store.get().log.some((l) => l.text === 'Tuner running on the pedal')).toBe(true);
    expect(store.get().log.filter((l) => l.dir === 'tx').some((h) => h.hex?.startsWith('0F C0 20 01'))).toBe(false);

    // Pedal reports off (type 0x7F, field 4 absent; captured from a footswitch tap 2026-09-24): tuner off, reading cleared.
    mock.inject(HW_TUNER_OFF_REPORT);
    await flush(50);
    expect(store.get().tuner.on).toBe(false);
    expect(store.get().tuner.reading).toBeNull();

    // Pedal reports on at 462 Hz: tuner on, reference taken.
    mock.inject(HW_TUNER_ON_ACK);
    await flush(50);
    expect(store.get().tuner.on).toBe(true);
    expect(store.get().tuner.referenceHz).toBe(440);
    engine.dispose();
  });
});

describe('expression pedal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads the assignments of the active preset after sync and follows position / values events', async () => {
    const { mock, store, engine } = setup();
    await connect(mock);
    await flush(4000);
    // Demo preset 7 is odd → the mock answers "nothing assigned".
    expect(store.get().expression.assignmentsPreset).toBe(7);
    expect(store.get().expression.assignments?.ranges.post3).toBeUndefined();
    expect(store.get().log.some((l) => l.dir === 'tx' && l.hex === '08 C0 08 03 18 07 3C 00 00 00')).toBe(true);

    mock.pressFootswitch(4); // even → post 3, 17–130
    await flush(1500);
    expect(store.get().expression.assignmentsPreset).toBe(4);
    expect(store.get().expression.assignments?.ranges.post3).toEqual({ min: 17, max: 130, flag: 0 });
    expect(store.get().log.filter((l) => l.dir === 'tx' && /3C 00 00 00$/.test(l.hex ?? '') && l.text.startsWith('Expression')).length).toBe(2); // once per preset

    mock.sweepExpression(4, 50);
    await flush(120);
    const x = store.get().expression;
    expect(x.position).toBeGreaterThan(0);
    expect(x.movedAt).not.toBeNull();
    expect(x.values.ranges.post3).toBeGreaterThanOrEqual(17);
    expect(store.get().log.filter((l) => /Undocumented event/.test(l.text))).toHaveLength(0);
    await flush(1000);
    expect(store.get().expression.position).toBe(0); // back at heel
    engine.dispose();
  });
});

describe('preset 1 (index 0): the pedal omits the zero-valued field', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a captured preset-1 dump syncs as preset 1 from the dump, no inference, no "tap a footswitch"', async () => {
    const { mock, store, engine } = setup();
    await connect(mock);
    await flush(3500);
    expect(store.get().activePreset.value).toBe(7);
    for (const pkt of HW_STATE_PRESET_1) mock.inject(pkt);
    await flush(100);
    expect(store.get().activePreset.value).toBe(0);
    expect(store.get().activePreset.source).toBe('dump');
    expect(store.get().log.some((l) => /inferred/.test(l.text))).toBe(false);
    engine.dispose();
  });

  it('selecting preset 1 over Bluetooth is confirmed by the dump; no MIDI fallback barrage', async () => {
    const { mock, store, engine } = setup({ writes: true });
    await connect(mock);
    await flush(3500);
    const p = engine.selectPreset(0);
    await flush(2500);
    await p;
    expect(store.get().activePreset.value).toBe(0);
    expect(store.get().activePreset.source).toBe('dump');
    const warnings = store.get().log.filter((l) => /not confirmed|Preset switch failed/.test(l.text));
    expect(warnings).toEqual([]);
    expect(store.get().log.some((l) => l.dir === 'tx' && /c303|c302/.test(l.text))).toBe(false);
    engine.dispose();
  });

  it('a footswitch press to preset 1 arrives as a program change, not an undocumented event', async () => {
    const { mock, store, engine } = setup();
    await connect(mock);
    await flush(3500);
    mock.pressFootswitch(0);
    await flush(600);
    expect(store.get().activePreset.value).toBe(0);
    expect(store.get().log.some((l) => /Preset changed → 1/.test(l.text))).toBe(true);
    expect(store.get().log.some((l) => /Undocumented event/.test(l.text))).toBe(false);
    engine.dispose();
  });
});
