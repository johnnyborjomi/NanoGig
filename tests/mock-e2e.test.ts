// @vitest-environment jsdom
/**
 * End-to-end in jsdom with REAL timers: mock transport → sync engine → store →
 * gig view DOM. This is the "mock mode renders the full gig view from
 * replayed captures with no device" acceptance check.
 */
import { describe, expect, it } from 'vitest';
import { MockTransport } from '../src/transport/mock';
import { Store } from '../src/state/store';
import { SyncEngine } from '../src/sync/engine';
import { GigView } from '../src/ui/gigview';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('mock mode end-to-end', () => {
  it('renders names, tiles and capture/IR from replayed captures, then follows a footswitch press', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const store = new Store();
    const mock = new MockTransport({ latencyMs: 5, packetGapMs: 1 });
    const engine = new SyncEngine(mock, store, {
      writesEnabled: true,
      inactivityMs: 150,
      confirmDelayMs: 30,
    });
    const actions = {
      connect: () => mock.connect(),
      connectMock: () => mock.connect(),
      disconnect: () => mock.disconnect(),
      refresh: () => engine.requestState(),
      refreshNames: () => engine.requestMetadata(),
      toggleFx: (slot: 'pre1' | 'pre2' | 'post1' | 'post2' | 'post3') => engine.toggleFx(slot),
      toggleGate: () => engine.toggleGate(),
      toggleCab: () => engine.toggleCab(),
      toggleCapture: () => engine.toggleCapture(),
      selectPreset: (i: number) => engine.selectPreset(i),
      setWritesEnabled: (v: boolean) => engine.setWritesEnabled(v),
      reconnectNow: () => {},
      setSettings: (patch: Partial<{ presetsPerBank: number; labelStyle: 'number-letter' | 'letter-number'; showPresetNumber: boolean }>) => store.patch(patch),
    };
    new GigView(root, store, actions, { bluetoothAvailable: false, showMockButton: true });

    await mock.connect();
    await wait(500); // metadata stream + state dump (both complete on END flags)

    const text = (sel: string) => root.querySelector(sel)?.textContent ?? '';
    const tile = (k: string) => root.querySelector<HTMLElement>(`.tile[data-key="${k}"]`)!.dataset.on;

    expect(root.querySelector('.overlay.connect')?.classList.contains('open')).toBe(false);
    expect(text('.preset-name')).toBe('Clean Chief'); // field 13 = 7 in the real dump
    expect(text('.slot-label')).toContain('2D'); // index 7 in the default 4-per-bank Mvave layout
    expect(root.querySelector<HTMLElement>('.src')!.hidden).toBe(true); // dump source: no tag
    expect(text('.capture')).toBe('NoMatch Chief 1');
    expect(text('.ir')).toContain('110 US PRN C10R');
    expect([tile('gate'), tile('pre1'), tile('pre2'), tile('post1'), tile('post2'), tile('post3')]).toEqual([
      'true', 'false', 'false', 'true', 'true', 'true',
    ]);
    expect(root.querySelectorAll('.tile').length).toBe(6);
    expect(text('.status-text')).toBe('Connected · demo'); // mock transport
    expect(text('.menu-info')).toContain('NanOS 2.2.1');
    expect(text('.tile[data-key="pre1"] .t-name')).toBe('Transpose');
    expect(text('.tile[data-key="post3"] .t-cat')).toBe('Reverb');

    // Footswitch → preset 4 ("Rectified") : name updates immediately, dump confirms capture.
    mock.pressFootswitch(4);
    await wait(10);
    expect(text('.preset-name')).toBe('Rectified');
    expect(text('.slot-label')).toContain('2A'); // index 4 in the default 4-per-bank Mvave layout
    expect(text('.src')).toBe('live');
    await wait(400);
    expect(text('.capture')).toBe('Cali Recto Modern');

    // Tap the PRE 1 tile (writes on) → optimistic ON, confirmed ON by the next dump.
    root.querySelector<HTMLButtonElement>('.tile[data-key="pre1"]')!.click();
    await wait(10);
    expect(tile('pre1')).toBe('true');
    await wait(400);
    expect(tile('pre1')).toBe('true');
    expect(store.get().fxOn.source).toBe('dump');

    // Preset strip: active preset sits in the middle (4th of 7); the 5th button is the next preset → MIDI PC path.
    const strip = root.querySelectorAll<HTMLButtonElement>('.preset-strip .pbtn');
    expect(strip[3]!.dataset.active).toBe('true');
    strip[4]!.click();
    await wait(500);
    expect(text('.preset-name')).toBe('Ambient Swell');
    expect(text('.capture')).toBe('Jazz 120 Clean');

    // Drop + recover.
    mock.simulateDrop(50);
    await wait(10);
    expect(text('.status-text')).toBe('Reconnecting… · demo');
    await wait(500);
    expect(store.get().connection).toBe('connected');
    expect(store.get().syncPhase).toBe('ready');

    engine.dispose();
    await mock.disconnect();
  }, 15000);
});
