import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockTransport } from '../src/transport/mock';
import { Store } from '../src/state/store';
import { SyncEngine } from '../src/sync/engine';
import { REAL_EVENTS } from '../src/fixtures/captures';
import { HW_BYPASS_CHANGED, HW_PRESET_CHANGED, HW_STATE_EMPTY_CAPTURE_IR, HW_STATE_SEGMENTED, HW_STATE_SINGLE, HW_UNKNOWN_73 } from '../src/fixtures/hardware-2026-09-12';
import { toHex } from '../src/protocol/hex';

async function flush(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

/** mock.connect() awaits a fake-timer delay, so advance the clock while it resolves. */
async function connect(mock: MockTransport) {
  const p = mock.connect();
  await flush(50);
  await p;
}

function setup(opts: { writes?: boolean; shape?: 'single' | 'segmented' | 'alternate' } = {}) {
  const mock = new MockTransport({ latencyMs: 10, packetGapMs: 2, stateReplyShape: opts.shape ?? 'alternate' });
  const store = new Store();
  const engine = new SyncEngine(mock, store, { writesEnabled: opts.writes ?? false, confirmDelayMs: 50 });
  return { mock, store, engine };
}

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

  it('clears device state on disconnect and re-syncs on reconnect without re-requesting metadata', async () => {
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

  it('selectPreset probes MIDI deliveries until the device confirms, then remembers the winner', async () => {
    // Mock pedal: rejects raw c302 like the hardware did, honours c303 BLE-MIDI framing.
    const mock = new MockTransport({ latencyMs: 10, packetGapMs: 2, acceptedMidi: 'c303-ble-midi' });
    const store = new Store();
    const engine = new SyncEngine(mock, store, { writesEnabled: true, confirmDelayMs: 50, presetConfirmTimeoutMs: 300 });
    await connect(mock);
    await flush(3500);

    const p = engine.selectPreset(3);
    await flush(2000);
    await p;
    const tx = store.get().log.filter((l) => l.dir === 'tx');
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
    await flush(3000);
    await p;
    const ids = store
      .get()
      .log.filter((l) => l.dir === 'tx' && /\[(c30[23]-[a-z-]+)\]/.test(l.text))
      .map((l) => /\[(c30[23]-[a-z-]+)\]/.exec(l.text)![1]);
    expect(ids).toEqual(['c303-ble-midi', 'c302-ble-midi', 'c303-raw']);
    expect(engine.activeMidiStrategy?.id).toBe('c303-raw');
    expect(store.get().activePreset.value).toBe(5);
    engine.dispose();
  });

  it('prefers Web MIDI when an output is available and confirms through the device', async () => {
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
    await flush(1000);
    await p;
    expect(sent).toEqual([[0xc0, 6]]);
    expect(engine.activeMidiStrategy?.id).toBe('web-midi');
    expect(store.get().log.filter((l) => l.dir === 'tx' && /\[c30/.test(l.text))).toHaveLength(0); // no BLE attempts
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
    await flush(2000);
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
    expect(store.get().log.some((l) => l.dir === 'error' && /no MIDI delivery/.test(l.text))).toBe(true);
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
    expect(tx).toContain('08 C0 08 01 68 00 43 00 00 00'); // 0 = mute
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
    expect(store.get().log.filter((l) => l.dir === 'tx').map((l) => l.hex)).toContain('08 C0 08 01 68 01 43 00 00 00'); // 1 = outputs on
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
