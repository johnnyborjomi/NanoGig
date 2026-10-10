// @vitest-environment jsdom
/**
 * Edit gestures end to end in jsdom with real timers: mock pedal → sync engine → gig view + edit sheets.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HOLD_MS, GigView } from '../src/ui/gigview';
import { Store } from '../src/state/store';
import { SyncEngine } from '../src/sync/engine';
import { MockTransport } from '../src/transport/mock';
import { IrFolders } from '../src/ui/ir-folders';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(5);
  }
}

const press = (node: Element, type: string, x = 10, y = 10) => node.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));

async function hold(node: Element) {
  press(node, 'pointerdown');
  await wait(HOLD_MS + 60);
  press(node, 'pointerup');
  (node as HTMLElement).click(); // the click that ends a press
}

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
  document.body.replaceChildren();
});

async function setup(editing: boolean) {
  const root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  const store = new Store({ editing });
  const mock = new MockTransport({ latencyMs: 3, packetGapMs: 1 });
  const engine = new SyncEngine(mock, store, { writesEnabled: true, inactivityMs: 150, confirmDelayMs: 20 });
  cleanup.push(() => engine.dispose());
  const p = () => Promise.resolve();
  const toggles: string[] = [];
  new GigView(
    root,
    store,
    {
      connect: p,
      connectMock: p,
      disconnect: p,
      refresh: p,
      toggleFx: async (slot) => {
        toggles.push(slot);
      },
      toggleGate: async () => {
        toggles.push('gate');
      },
      toggleCab: p,
      toggleCapture: p,
      selectPreset: (i) => engine.selectPreset(i),
      setOutputsMuted: p,
      startTuner: p,
      stopTuner: p,
      setTunerReference: p,
      setTunerMute: p,
      openTempo: p,
      closeTempo: p,
      stepTempo: () => {},
      setWritesEnabled: () => {},
      setSettings: (patch) => store.patch(patch),
      edit: () => engine.edit,
    },
    { bluetoothAvailable: false, showMockButton: true },
  );
  await mock.connect();
  await until(() => store.get().syncPhase === 'ready' && store.get().presetNames.source === 'metadata');
  const open = (cls: string) => root.querySelector(`.${cls}`)!.closest('.overlay')!.classList.contains('open');
  return { root, store, mock, engine, toggles, open };
}

describe('edit gestures', () => {
  it('with Editing off, a hold is just a tap', async () => {
    const { root, toggles, open } = await setup(false);
    await hold(root.querySelector('.tile[data-key="post2"]')!);
    expect(open('fx-sheet')).toBe(false);
    expect(toggles).toEqual(['post2']);
  });

  it('hold an FX tile: the editor opens, the block is not toggled, the parameters load', async () => {
    const { root, store, toggles, open } = await setup(true);
    expect(root.dataset.editing).toBe('true');
    await hold(root.querySelector('.tile[data-key="post2"]')!);
    expect(open('fx-sheet')).toBe(true);
    expect(toggles).toEqual([]);
    await until(() => store.get().edit.fx?.status === 'ready');
    expect(root.querySelectorAll('.fx-sheet .ed-slider').length).toBeGreaterThan(5);
    // A plain tap still toggles.
    (root.querySelector('.tile[data-key="post1"]') as HTMLElement).click();
    expect(toggles).toEqual(['post1']);
    // Escape closes the sheet and the editor forgets the block.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(open('fx-sheet')).toBe(false);
    expect(store.get().edit.fx).toBeNull();
  });

  it('a slider writes to the pedal', async () => {
    const { root, store, mock } = await setup(true);
    await hold(root.querySelector('.tile[data-key="post3"]')!);
    await until(() => store.get().edit.fx?.status === 'ready');
    const input = root.querySelector<HTMLInputElement>('.fx-sheet .ed-slider input')!;
    input.value = '750';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => Math.abs((mock.fxParams.post3[0] ?? 0) - 0.75) < 1e-6);
  });

  it('the capture name opens amp & cab; hold the gate for its threshold; hold the name to rename', async () => {
    const { root, store, toggles, open } = await setup(true);
    (root.querySelector('.capture.sub-name') as HTMLElement).click();
    expect(open('src-sheet')).toBe(true);
    expect(root.querySelector('.src-sheet .ed-big')!.textContent).toBe(store.get().captureName.value);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await hold(root.querySelector('.tile[data-key="gate"]')!);
    expect(open('gate-sheet')).toBe(true);
    expect(toggles).toEqual([]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await hold(root.querySelector('.preset-name')!);
    expect(open('preset-sheet')).toBe(true);
    const input = root.querySelector<HTMLInputElement>('.preset-sheet .ed-input')!;
    expect(input.value).toBe(store.get().presetNames.value[store.get().activePreset.value!]);
  });

  it('swiping the preset strip pages it without selecting', async () => {
    const { root, store } = await setup(true);
    const grid = root.querySelector('.preset-grid')!;
    const before = Array.from(root.querySelectorAll('.pbtn .p-name')).map((n) => n.textContent);
    const btn = root.querySelectorAll('.pbtn')[3]!;
    press(btn, 'pointerdown', 300, 10);
    press(btn, 'pointerup', 150, 14);
    (btn as HTMLElement).click();
    const after = Array.from(root.querySelectorAll('.pbtn .p-name')).map((n) => n.textContent);
    expect(after).not.toEqual(before);
    expect(grid).toBeTruthy();
    expect(store.get().activePreset.source).not.toBe('optimistic');
  });
});

describe('IR folders', () => {
  it('keeps unique names per list, files IRs and forgets a deleted folder', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const f = new IrFolders(storage);
    const a = f.create('factory', 'Marshall');
    expect(() => f.create('factory', 'marshall')).toThrow(/already/);
    expect(f.create('user', 'Marshall').list).toBe('user');
    f.file('factory', '412 UK GRN V30', a.id);
    f.file('user', 'YA', a.id); // the folder is the factory list's: refused
    expect(f.folderOf('factory', '412 UK GRN V30')).toBe(a.id);
    expect(f.folderOf('user', 'YA')).toBeNull();
    const again = new IrFolders(storage);
    expect(again.folders('factory').map((x) => x.name)).toEqual(['Marshall']);
    again.remove(a.id);
    expect(again.folderOf('factory', '412 UK GRN V30')).toBeNull();
  });
});
