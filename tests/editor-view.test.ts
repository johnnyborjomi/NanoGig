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
import { EDIT_MSG } from '../src/protocol/edit';

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

  it('a block that is off is editable but drawn grey', async () => {
    const { root, store } = await setup(true);
    await hold(root.querySelector('.tile[data-key="pre1"]')!); // off in the demo
    await until(() => store.get().edit.fx?.status === 'ready');
    const params = root.querySelector<HTMLElement>('.fx-sheet .ed-params')!;
    expect(params.dataset.off).toBe('true');
    expect(root.querySelector<HTMLInputElement>('.fx-sheet .ed-slider input')!.disabled).toBe(false);
    await hold(root.querySelector('.tile[data-key="post2"]')!); // on
    await until(() => store.get().edit.fx?.slot === 'post2' && store.get().edit.fx?.status === 'ready');
    expect(params.dataset.off).toBe('false');
  });

  it("a moved slider shows the sheet's Discard, which puts the block's saved value back", async () => {
    const { root, store, mock } = await setup(true);
    await hold(root.querySelector('.tile[data-key="post3"]')!);
    await until(() => store.get().edit.fx?.status === 'ready');
    const saved = store.get().edit.fx!.values![0]!;
    const discard = root.querySelector<HTMLElement>('.fx-sheet .ed-discard')!;
    expect(discard.dataset.shown).toBe('false');
    const input = root.querySelector<HTMLInputElement>('.fx-sheet .ed-slider input')!;
    input.value = String(Math.round(saved * 1000) === 750 ? 250 : 750);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(discard.dataset.shown).toBe('true');
    tap(discard);
    await until(() => store.get().edit.fx?.status === 'ready' && discard.dataset.shown === 'false');
    expect(mock.fxParams.post3[0]).toBeCloseTo(saved, 6);
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
    const { root, store, mock, toggles, open } = await setup(true);
    (root.querySelector('.capture.sub-name') as HTMLElement).click();
    expect(open('src-sheet')).toBe(true);
    expect(root.querySelector('.src-sheet .ed-big')!.textContent).toBe(store.get().captureName.value);
    // On / off sits at the end of the name's row, not with the slot arrows.
    expect(root.querySelectorAll('.src-sheet .ed-name-row > .ed-big + .ed-power')).toHaveLength(2);
    expect(root.querySelector('.src-sheet .ed-step .ed-power')).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await hold(root.querySelector('.tile[data-key="gate"]')!);
    expect(open('gate-sheet')).toBe(true);
    expect(toggles).toEqual([]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await hold(root.querySelector('.preset-name')!);
    expect(open('preset-sheet')).toBe(true);
    const input = root.querySelector<HTMLInputElement>('.preset-sheet .ed-input')!;
    expect(input.value).toBe(store.get().presetNames.value[store.get().activePreset.value!]);
    // Save now: the preset playing stored with the save light off too (the create frame under its own name).
    const force = root.querySelector<HTMLButtonElement>('.preset-sheet .ed-force-save')!;
    expect(force.disabled).toBe(false);
    const sent = mock.edits.length;
    tap(force);
    await until(() => mock.edits.length > sent);
    expect(mock.edits.at(-1)!.type).toBe(EDIT_MSG.PRESET_CREATE);
    await until(() => store.get().edit.preset.busy === null);
  });

  it('capture tab: ‹ what plays › steps through every slot over the banks; the middle opens the bank playing; a tap plays a slot', async () => {
    const { root, store } = await setup(true);
    (root.querySelector('.capture.sub-name') as HTMLElement).click();
    await until(() => store.get().captureSlots.length === 25);
    const picker = root.querySelector<HTMLElement>('.src-sheet .ed-pane:not([hidden]) .ed-slots')!;
    const toggle = picker.querySelector<HTMLElement>('.ed-slots-toggle')!;
    const [prev, next] = Array.from(picker.querySelectorAll<HTMLElement>('.ed-slots-head .ed-step-btn'));
    // One row only: no stepper of its own above the list.
    expect(root.querySelectorAll('.src-sheet .ed-pane:not([hidden]) .ed-step')).toHaveLength(1);
    if (picker.dataset.open === 'true') tap(toggle);
    expect(picker.querySelector<HTMLElement>('.ed-slots-list')!.hidden).toBe(true);
    const label = picker.querySelector<HTMLElement>('.ed-slots-label')!;
    // The demo plays bank 2 (as the real dump it starts from).
    const playing = () => `Bank ${store.get().captureBank.value} · Slot ${store.get().captureSlot.value}`;
    expect(store.get().captureBank.value).toBe(2);
    expect(label.textContent).toBe(playing());
    tap(toggle);
    expect(picker.dataset.open).toBe('true');
    const slots = () => Array.from(picker.querySelectorAll<HTMLElement>('.ed-cap-slots .ed-cap-slot'));
    const names = () => slots().map((b) => b.querySelector('.ed-cap-name')!.textContent);
    expect(names()).toEqual(store.get().captureSlots.slice(5, 10));
    expect(slots().filter((b) => b.dataset.active === 'true')).toHaveLength(1);
    // A preset saved on a slot: no "Preset's own" (it would play the same capture).
    const own = picker.querySelector<HTMLElement>('.ed-slots-list > .ed-cap-slot')!;
    expect(own.dataset.shown).toBe('false');
    expect((own as HTMLButtonElement).disabled).toBe(true);
    // Bank 2 slot 5, then › goes on to bank 3 slot 1 (the list follows), ‹ back.
    tap(slots()[4]!);
    await until(() => store.get().captureSlot.source === 'dump' && store.get().captureSlot.value === 5);
    tap(next!);
    await until(() => store.get().captureBank.source === 'dump' && store.get().captureBank.value === 3 && store.get().captureSlot.value === 1);
    expect(label.textContent).toBe('Bank 3 · Slot 1');
    expect(names()).toEqual(store.get().captureSlots.slice(10, 15));
    expect(slots().map((b) => b.dataset.active)).toEqual(['true', 'false', 'false', 'false', 'false']);
    tap(prev!);
    await until(() => store.get().captureBank.source === 'dump' && store.get().captureBank.value === 2 && store.get().captureSlot.value === 5);
    expect(label.textContent).toBe('Bank 2 · Slot 5');
    tap(toggle); // closed again for the next test
  });

  it('library rows: a tap plays the capture; Load to: bank · slot or the preset\'s own (Save keeps it), which closes the library', async () => {
    const { root, store, open } = await setup(true);
    (root.querySelector('.capture.sub-name') as HTMLElement).click();
    const libBtn = () => root.querySelector<HTMLElement>('.src-sheet .ed-pane:not([hidden]) .ed-lib-btn')!;
    tap(libBtn());
    await until(() => store.get().edit.library.captures !== null && store.get().edit.library.loading === null);
    const sheet = root.querySelector('.lib-sheet')!;
    // The first item in no slot of the pedal's (one in a slot offers Use instead of a load).
    const items = () => Array.from(sheet.querySelectorAll<HTMLElement>('.ed-item:not(.ed-folder-row) .ed-item-name'));
    const firstItem = () => items().find((n) => !n.querySelector('.ed-item-slot'))!;
    const firstName = firstItem().querySelector('.ed-item-label')!.textContent!;
    const buttons = () => Array.from(sheet.querySelectorAll<HTMLElement>('.ed-item-actions button')).map((b) => b.textContent);
    const saveBtn = root.querySelector<HTMLButtonElement>('.topbar .save-btn')!;
    // A tap: it plays (listened to), a speaker right of its name; nothing to save yet.
    tap(firstItem());
    await until(() => store.get().edit.capturePreview?.name === firstName);
    expect(store.get().edit.capturePreview!.kept).toBe(false);
    expect(firstItem().querySelector('.ed-item-label + .ed-item-playing')).not.toBeNull();
    expect(sheet.querySelector('.ed-load-to .ed-label')!.textContent).toBe('Load to:');
    expect(buttons()).toEqual([`Bank ${store.get().captureBank.value} · Slot ${store.get().captureSlot.value}`, "Preset's own slot", 'Move to folder']);
    expect(saveBtn.hidden).toBe(store.get().presetDirty.value !== true); // a listen is no change (the demo may have one)
    // Closed without a load: the preset's capture plays again.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(open('lib-sheet')).toBe(false);
    await until(() => store.get().edit.capturePreview === null);
    // Into the preset's own: the library closes, Save shows, the capture tab shows it in the preset's own place.
    tap(libBtn());
    tap(firstItem());
    await until(() => store.get().edit.capturePreview?.name === firstName);
    tap(Array.from(sheet.querySelectorAll<HTMLElement>('.ed-item-actions button'))[1]!);
    expect(open('lib-sheet')).toBe(false);
    await until(() => store.get().edit.capturePreview?.kept === true);
    expect(saveBtn.hidden).toBe(false);
    const pane = root.querySelector<HTMLElement>('.src-sheet .ed-pane:not([hidden])')!;
    expect(pane.querySelector('.ed-slots-label')!.textContent).toBe("Preset's own slot");
    const own = pane.querySelector<HTMLElement>('.ed-slots-list > .ed-cap-slot')!;
    expect(own.dataset.active).toBe('true');
    expect(own.dataset.shown).toBe('true');
    expect(own.textContent).toContain(firstName);
    expect(root.querySelector<HTMLElement>('.src-sheet .ed-discard')!.dataset.shown).toBe('true');
    tap(root.querySelector<HTMLElement>('.src-sheet .ed-discard')!);
    await until(() => store.get().edit.capturePreview === null);
    tap(root.querySelectorAll<HTMLElement>('.src-sheet .ed-tab')[1]!);
    expect(root.querySelector('.src-sheet .ed-pane:not([hidden]) .ed-slots .ed-slots-label')!.textContent).toBe('Off'); // the IR's picker says what plays
    // The IR is off in the demo: as the capture's, its library waits for it to be on.
    const irLib = root.querySelector<HTMLButtonElement>('.src-sheet .ed-pane:not([hidden]) .ed-lib-btn')!;
    expect(irLib.disabled).toBe(true);
    tap(root.querySelector<HTMLElement>('.src-sheet .ed-pane:not([hidden]) .ed-power')!);
    await until(() => store.get().cabOn.value === true && !irLib.disabled);
    tap(irLib);
    await until(() => store.get().edit.library.irs !== null && store.get().edit.library.loading === null);
    // An IR plays on a tap too (Cortex Cloud's IR preview); Load to: the IR slot playing or the preset's own slot.
    expect(root.querySelector<HTMLElement>('.lib-sheet')!.dataset.kind).toBe('irs'); // the IR colour
    const irName = firstItem().querySelector('.ed-item-label')!.textContent!;
    tap(firstItem());
    await until(() => store.get().edit.irPreview?.name === irName);
    expect(firstItem().querySelector('.ed-item-label + .ed-item-playing')).not.toBeNull();
    expect(buttons()).toEqual([expect.stringMatching(/^Slot \d$/), "Preset's own slot", 'Move to folder']);
    tap(Array.from(sheet.querySelectorAll<HTMLElement>('.ed-item-actions button'))[1]!);
    expect(open('lib-sheet')).toBe(false);
    // Straight into the preset's own IR slot (index 5, then slot 6 selected): the preview stopped first.
    await until(() => store.get().cabSlot.source === 'dump' && store.get().cabSlot.value === 6 && store.get().irName.value === irName);
    expect(store.get().edit.irPreview).toBeNull();
    expect(root.querySelector('.src-sheet .ed-pane:not([hidden]) .ed-slots-label')!.textContent).toBe("Preset's own slot");
  });

  it('library: A–Z / Z–A with a letter between the groups; where an item sits on the pedal, and Use for it', async () => {
    const { root, store, mock } = await setup(true);
    try {
      localStorage.removeItem('nanogig.librarySort');
    } catch {
      /* none */
    }
    (root.querySelector('.capture.sub-name') as HTMLElement).click();
    tap(root.querySelector<HTMLElement>('.src-sheet .ed-pane:not([hidden]) .ed-lib-btn')!);
    await until(() => store.get().edit.library.captures !== null && store.get().edit.library.loading === null);
    const sheet = root.querySelector('.lib-sheet')!;
    const sort = sheet.querySelector<HTMLElement>('.ed-bar-sort')!;
    const names = () => Array.from(sheet.querySelectorAll('.ed-item:not(.ed-folder-row) .ed-item-label')).map((n) => n.textContent!);
    const letters = () => Array.from(sheet.querySelectorAll('.ed-letter')).map((n) => n.textContent);
    const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    expect(sort.dataset.active).toBe('false');
    expect(letters()).toEqual([]);
    const before = names();
    tap(sort);
    expect(sort.dataset.active).toBe('true');
    expect(names()).toEqual(before.slice().sort(cmp));
    expect(letters().length).toBeGreaterThan(0);
    expect(new Set(letters()).size).toBe(letters().length); // one divider per letter
    tap(sort);
    expect(names()).toEqual(before.slice().sort((a, b) => cmp(b, a)));
    tap(sort);
    expect(names()).toEqual(before);
    expect(letters()).toEqual([]);
    // A capture that is in a slot carries "Bank b · Slot n".
    const slots = store.get().captureSlots;
    const row = Array.from(sheet.querySelectorAll<HTMLElement>('.ed-item:not(.ed-folder-row)')).find((r) =>
      slots.some((n) => n && n.toLowerCase() === r.querySelector('.ed-item-label')!.textContent!.toLowerCase()),
    )!;
    const i = slots.findIndex((n) => n.toLowerCase() === row.querySelector('.ed-item-label')!.textContent!.toLowerCase());
    expect(row.querySelector('.ed-item-slot')!.textContent).toBe(`Bank ${Math.floor(i / 5) + 1} · Slot ${(i % 5) + 1}`);
    // Already in a slot: Use (plays it from there, nothing written over), no load.
    tap(row.querySelector<HTMLElement>('.ed-item-name')!);
    expect(row.isConnected ? row : null).toBeNull(); // re-rendered
    const open = sheet.querySelector<HTMLElement>('.ed-item[data-selected="true"]')!;
    expect(open.querySelector('.ed-load-to .ed-label')!.textContent).toBe('Use:');
    const labels = Array.from(open.querySelectorAll<HTMLButtonElement>('.ed-load-to button')).map((b) => b.textContent);
    expect(labels[0]).toBe(`Bank ${Math.floor(i / 5) + 1} · Slot ${(i % 5) + 1}`);
    expect(labels.at(-1)).toBe('Move to folder');
    expect(labels).not.toContain("Preset's own slot");
    const loads = (await import('../src/protocol/edit')).EDIT_MSG.CAPTURE_SLOT_LOAD;
    const useBtn = open.querySelector<HTMLButtonElement>('.ed-load-to button')!;
    if (!useBtn.disabled) {
      tap(useBtn);
      await until(() => store.get().captureSlot.source === 'dump' && store.get().captureBank.value === Math.floor(i / 5) + 1 && store.get().captureSlot.value === (i % 5) + 1);
    }
    expect(mock.edits.some((e) => e.type === loads)).toBe(false); // nothing written into a slot
  });

  it('amp & cab and gate: Discard once a value moves; an IR that is off is grey but editable', async () => {
    const { root, store } = await setup(true);
    (root.querySelector('.capture.sub-name') as HTMLElement).click();
    const discard = root.querySelector<HTMLElement>('.src-sheet .ed-discard')!;
    await until(() => store.get().edit.savedSource !== null);
    expect(discard.dataset.shown).toBe('false');
    const volume = root.querySelector<HTMLInputElement>('.src-sheet .ed-slider input')!;
    volume.value = String((store.get().captureVolume.value ?? 0) + 40);
    volume.dispatchEvent(new Event('input', { bubbles: true }));
    expect(discard.dataset.shown).toBe('true');
    tap(discard);
    await until(() => store.get().captureVolume.source === 'dump' && discard.dataset.shown === 'false');
    // The IR is off in the demo and never read yet: the pedal does not answer for it, so it is not asked.
    expect(store.get().cabOn.value).toBe(false);
    tap(root.querySelectorAll<HTMLElement>('.src-sheet .ed-tab')[1]!);
    expect(store.get().edit.ir?.status).toBe('off');
    const irParams = root.querySelector<HTMLElement>('.src-sheet .ed-pane:not([hidden]) .ed-params')!;
    expect(irParams.querySelector<HTMLInputElement>('input')!.disabled).toBe(true);
    // On: read. Off again: its settings stay, grey and editable.
    tap(root.querySelector<HTMLElement>('.src-sheet .ed-pane:not([hidden]) .ed-power')!);
    await until(() => store.get().cabOn.value === true && store.get().edit.ir?.status === 'ready');
    tap(root.querySelector<HTMLElement>('.src-sheet .ed-pane:not([hidden]) .ed-power')!);
    await until(() => store.get().cabOn.value === false && store.get().cabOn.source === 'dump');
    expect(store.get().edit.ir?.status).toBe('ready');
    expect(irParams.dataset.off).toBe('true');
    expect(irParams.querySelector<HTMLInputElement>('input')!.disabled).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    // Gate.
    await hold(root.querySelector('.tile[data-key="gate"]')!);
    const gateDiscard = root.querySelector<HTMLElement>('.gate-sheet .ed-discard')!;
    expect(gateDiscard.dataset.shown).toBe('false');
    const threshold = root.querySelector<HTMLInputElement>('.gate-sheet .ed-slider input')!;
    threshold.value = '20';
    threshold.dispatchEvent(new Event('input', { bubbles: true }));
    expect(gateDiscard.dataset.shown).toBe('true');
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

describe('presets list', () => {
  it("opens on a hold of the strip's arrows (a tap pages); labels as on the strip", async () => {
    const { root, store, open } = await setup(false);
    const next = root.querySelectorAll<HTMLElement>('.pbtn-nav')[1]!;
    const first = () => root.querySelector('.pbtn .p-name')!.textContent;
    const before = first();
    tap(next);
    expect(first()).not.toBe(before); // paged
    expect(open('list-sheet')).toBe(false);
    const paged = first();
    await hold(next);
    expect(open('list-sheet')).toBe(true);
    expect(first()).toBe(paged); // the hold did not page too
    // Slot letters and footswitch badges carry what the styles colour, as on the strip.
    const fs = store.get().footswitches.value!;
    const row = root.querySelectorAll<HTMLElement>('.ed-preset-row')[fs.ia]!;
    expect(row.querySelector<HTMLElement>('.slot-slot')!.dataset.slot).not.toBe('');
    expect(row.querySelector<HTMLElement>('.fs-badge')!.dataset.fs).toBe('ia');
    const strip = root.querySelector<HTMLElement>('.pbtn .slot-slot')!;
    expect(strip.dataset.slot).not.toBe('');
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
