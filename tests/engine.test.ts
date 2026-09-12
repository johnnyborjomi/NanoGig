import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockTransport } from '../src/transport/mock';
import { Store } from '../src/state/store';
import { SyncEngine } from '../src/sync/engine';
import { REAL_EVENTS } from '../src/fixtures/captures';
import { HW_BYPASS_CHANGED, HW_PRESET_CHANGED, HW_STATE_SEGMENTED, HW_STATE_SINGLE, HW_UNKNOWN_73 } from '../src/fixtures/hardware-2026-09-12';
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
    expect(s.irName.value).toBe('110 US PRN C10R');
    expect(s.firmware.value).toBe('2.2.1');
    expect(s.fxOn.provisional).toBe(true);
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

  it('knob telemetry does not trigger a state re-request', async () => {
    const { mock, store, engine } = setup();
    await connect(mock);
    await flush(3500);
    const txBefore = store.get().log.filter((l) => l.dir === 'tx').length;
    mock.inject(REAL_EVENTS.gainKnob);
    mock.inject(REAL_EVENTS.expressionToe);
    await flush(1000);
    expect(store.get().log.filter((l) => l.dir === 'tx').length).toBe(txBefore);
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

  it('replays the hardware session: single dump, footswitch event, bypass event, two-packet dump', async () => {
    const { mock, store, engine } = setup();
    await connect(mock);
    await flush(3500);
    mock.inject(HW_STATE_SINGLE);
    await flush(0);
    expect(store.get().activePreset.value).toBe(14);
    expect(store.get().captureName.value).toBe("CA John's Ch1 1");
    mock.inject(HW_PRESET_CHANGED);
    mock.inject(HW_BYPASS_CHANGED);
    mock.inject(HW_UNKNOWN_73);
    await flush(0);
    expect(store.get().activePreset.value).toBe(3);
    expect(store.get().activePreset.source).toBe('event');
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

  it('selectPreset sends MIDI PC on c302, the ack on c304, then re-reads state', async () => {
    const { mock, store, engine } = setup({ writes: true });
    await connect(mock);
    await flush(3500);
    const p = engine.selectPreset(3);
    await flush(100);
    await p;
    const tx = store.get().log.filter((l) => l.dir === 'tx');
    expect(tx.some((l) => l.text.includes('c302') && l.hex === 'C0 03')).toBe(true);
    expect(tx.some((l) => l.hex === '06 C0 20 01 1E 00 00 00')).toBe(true);
    await flush(1000);
    expect(store.get().activePreset.value).toBe(3);
    expect(store.get().captureName.value).toBe('Brit 1959 Crunch');
    engine.dispose();
  });
});
