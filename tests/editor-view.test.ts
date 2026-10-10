// @vitest-environment jsdom
/**
 * Edit gestures end to end in jsdom with real timers: mock pedal → sync engine → gig view + edit sheets.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HOLD_MS, GigView } from '../src/ui/gigview';
import { Store } from '../src/state/store';
import { SyncEngine } from '../src/sync/engine';
import { MockTransport } from '../src/transport/mock';
import { LibraryFolders } from '../src/ui/library-folders';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(5);
  }
}

const press = (node: Element, type: string, x = 10, y = 10) => node.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));

/** A tap as a finger makes it: pointerdown, pointerup, click. */
function tap(node: Element) {
  press(node, 'pointerdown');
  press(node, 'pointerup');
  (node as HTMLElement).click();
}

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

  it('the model list stays open after a pick; the mark moves to the new model', async () => {
    const { root, store } = await setup(true);
    await hold(root.querySelector('.tile[data-key="post2"]')!);
    tap(root.querySelector('.fx-sheet .ed-model-btn')!);
    const list = root.querySelector<HTMLElement>('.fx-sheet .ed-models')!;
    expect(list.hidden).toBe(false);
    const tape = Array.from(list.querySelectorAll<HTMLElement>('.ed-chip')).find((b) => b.textContent === 'Tape Delay')!;
    tap(tape);
    await until(() => store.get().fxModels.value.post2?.name === 'Tape Delay');
    expect(list.hidden).toBe(false);
    expect(tape.isConnected).toBe(true);
    expect(Array.from(list.querySelectorAll<HTMLElement>('.ed-chip[data-active="true"]')).map((b) => b.textContent)).toEqual(['Tape Delay']);
    // The preset's saved model is outlined, and Discard puts it back.
    expect(Array.from(list.querySelectorAll<HTMLElement>('.ed-chip[data-saved="true"]')).map((b) => b.textContent)).toEqual(['Analog Delay']);
    const discard = root.querySelector<HTMLElement>('.fx-sheet .ed-discard')!;
    expect(discard.dataset.shown).toBe('true');
    tap(discard);
    await until(() => store.get().fxModels.value.post2?.name === 'Analog Delay' && store.get().fxModels.source === 'dump');
    expect(discard.dataset.shown).toBe('false');
    expect(list.querySelectorAll('.ed-chip[data-saved="true"]')).toHaveLength(0);
  });

  it('Save and Discard stand in for Edit while the save light is on', async () => {
    const { root, store, engine } = await setup(true);
    const btn = (cls: string) => root.querySelector<HTMLButtonElement>(`.topbar .${cls}`)!;
    expect(btn('edit-btn').hidden).toBe(false);
    expect(btn('save-btn').hidden).toBe(true);
    await engine.edit.setFxModel('post2', 6004);
    await until(() => store.get().presetDirty.value === true);
    expect(btn('edit-btn').hidden).toBe(true);
    expect(btn('save-btn').hidden).toBe(false);
    expect(btn('discard-btn').hidden).toBe(false);
    tap(btn('save-btn'));
    await until(() => store.get().presetDirty.value === false);
    expect(btn('edit-btn').hidden).toBe(false);
    expect(btn('save-btn').hidden).toBe(true);
    expect(btn('discard-btn').hidden).toBe(true);
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

describe('library folders', () => {
  const memStorage = () => {
    const mem = new Map<string, string>();
    return { mem, storage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) } };
  };

  it('keeps unique names per list, files items and forgets a deleted folder', () => {
    const { storage } = memStorage();
    const f = new LibraryFolders(storage);
    const a = f.create('irs', 'factory', 'Marshall');
    expect(() => f.create('irs', 'factory', 'marshall')).toThrow(/already/);
    expect(f.create('irs', 'user', 'Marshall').list).toBe('user');
    expect(f.create('captures', 'factory', 'Marshall').kind).toBe('captures');
    f.file('irs', 'factory', '412 UK GRN V30', a.id);
    f.file('irs', 'user', 'YA', a.id); // the folder is the factory list's: refused
    f.file('captures', 'factory', 'Comet 60 6', a.id); // an IR folder: refused
    expect(f.folderOf('irs', 'factory', '412 UK GRN V30')).toBe(a.id);
    expect(f.folderOf('irs', 'user', 'YA')).toBeNull();
    expect(f.folderOf('captures', 'factory', 'Comet 60 6')).toBeNull();
    expect(f.size(a.id)).toBe(1);
    const again = new LibraryFolders(storage);
    expect(again.folders('irs', 'factory').map((x) => x.name)).toEqual(['Marshall']);
    expect(again.folders('captures', 'factory')).toHaveLength(1);
    again.remove(a.id);
    expect(again.folderOf('irs', 'factory', '412 UK GRN V30')).toBeNull();
  });

  it('takes over the IR folders kept before captures had folders', () => {
    const { mem, storage } = memStorage();
    mem.set('nanogig.irFolders', JSON.stringify({ folders: [{ id: 3, list: 'user', name: 'Mine' }], filed: { 'user:YA': 3 } }));
    const f = new LibraryFolders(storage);
    expect(f.folders('irs', 'user').map((x) => x.name)).toEqual(['Mine']);
    expect(f.folderOf('irs', 'user', 'YA')).toBe(3);
  });
});

describe('library sheet', () => {
  it('captures have folders: make one, hold a capture to move it in, open the folder, delete it', async () => {
    localStorage.clear();
    const { root, store } = await setup(true);
    (root.querySelector('.capture.sub-name') as HTMLElement).click();
    (root.querySelector('.src-sheet .ed-lib-btn') as HTMLElement).click();
    await until(() => (store.get().edit.library.captures?.length ?? 0) > 0 && root.querySelectorAll('.lib-sheet .ed-item').length > 0);
    const sheet = root.querySelector('.lib-sheet')!;
    const msg = sheet.querySelector('.ed-msg')!;
    const bar = sheet.querySelector('.ed-libbar')!;
    // The bar and the message line are always there.
    expect(msg.hasAttribute('hidden')).toBe(false);
    expect(bar.hasAttribute('hidden')).toBe(false);
    // Opens on the current capture's list.
    const current = sheet.querySelector('.ed-item[data-current="true"]');
    expect(current).toBeTruthy();

    // New folder.
    (sheet.querySelector('.ed-bar-main') as HTMLElement).click();
    const input = sheet.querySelector<HTMLInputElement>('.ed-libbar .ed-input')!;
    input.value = 'Fenders';
    input.dispatchEvent(new Event('input'));
    (sheet.querySelector('.ed-libbar .primary') as HTMLElement).click();
    // A new folder opens, empty.
    expect(sheet.querySelector('.ed-bar-title')!.textContent).toBe('Fenders');
    expect(msg.textContent).toMatch(/Empty/);
    (sheet.querySelector('.ed-bar-main') as HTMLElement).click(); // back to the top

    // Hold the current capture: the rows become the folders to put it in.
    const name = current!.querySelector('.ed-item-label')!.textContent!;
    await hold(current!.querySelector('.ed-item-name')!);
    expect(sheet.querySelector('.ed-bar-title')!.textContent).toContain(name);
    const target = Array.from(sheet.querySelectorAll('.ed-folder-row')).find((r) => r.textContent?.includes('Fenders'))!;
    tap(target.querySelector('button')!);
    // Back at the top: the folder holds it, the capture is no longer among the items in none.
    const folderRow = Array.from(sheet.querySelectorAll('.ed-folder-row')).find((r) => r.textContent?.includes('Fenders'))!;
    expect(folderRow.querySelector('.ed-count')!.textContent).toBe('1');
    expect(Array.from(sheet.querySelectorAll('.ed-item-label')).map((n) => n.textContent)).not.toContain(name);
    tap(folderRow.querySelector('button')!);
    expect(Array.from(sheet.querySelectorAll('.ed-item-label')).map((n) => n.textContent)).toEqual([name]);

    // Delete takes two taps; the capture goes back to the top.
    const del = sheet.querySelector('.ed-bar-delete') as HTMLElement;
    del.click();
    expect(del.dataset.armed).toBe('true');
    del.click();
    expect(sheet.querySelectorAll('.ed-folder-row')).toHaveLength(0);
    expect(Array.from(sheet.querySelectorAll('.ed-item-label')).map((n) => n.textContent)).toContain(name);
  });
});

describe('sheet stacking', () => {
  it('a preset opened from the presets list shows over the list; Escape closes it first', async () => {
    const { root, open } = await setup(true);
    // Menu → Presets, then ⋯ on a row.
    const editor = (root.querySelector('.list-sheet') as HTMLElement).closest('.overlay')!;
    root.querySelector<HTMLButtonElement>('button[aria-label="Menu"]')!.click();
    Array.from(root.querySelectorAll<HTMLButtonElement>('.menu button')).find((b) => b.textContent === 'Presets')!.click();
    expect(open('list-sheet')).toBe(true);
    root.querySelectorAll<HTMLButtonElement>('.list-sheet .ed-more')[2]!.click();
    expect(open('preset-sheet')).toBe(true);
    const preset = root.querySelector('.preset-sheet')!.closest('.overlay')!;
    // Same z-index: the later in the page is on top.
    expect(preset.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(open('preset-sheet')).toBe(false);
    expect(open('list-sheet')).toBe(true);
  });
});
