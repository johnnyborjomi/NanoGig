/**
 * Editing against the mock pedal with real (short) timers: mock transport → sync engine → edit controller → store.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDIT_MSG, fxModelType, fxSlotModels } from '../src/protocol/edit';
import type { CurrentState } from '../src/protocol/decode';
import { writtenSince } from '../src/sync/editor';
import { Store } from '../src/state/store';
import { SyncEngine } from '../src/sync/engine';
import { MockTransport } from '../src/transport/mock';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 1500): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(5);
  }
}

let engines: SyncEngine[] = [];
afterEach(() => {
  for (const e of engines) e.dispose();
  engines = [];
});

async function setup(opts: { editing?: boolean; writes?: boolean; device?: ConstructorParameters<typeof MockTransport>[0] } = {}) {
  const store = new Store({ editing: opts.editing ?? true });
  const mock = new MockTransport({ latencyMs: 3, packetGapMs: 1, replayRealDumpFirst: false, ...opts.device });
  const engine = new SyncEngine(mock, store, { writesEnabled: opts.writes ?? true, inactivityMs: 150, confirmDelayMs: 20 });
  engines.push(engine);
  await mock.connect();
  await until(() => store.get().syncPhase === 'ready' && store.get().presetNames.source === 'metadata');
  return { store, mock, engine, edit: engine.edit };
}

const sent = (mock: MockTransport, type: number) => mock.edits.filter((e) => e.type === type);

describe('edit controller', () => {
  it('refuses to write unless control mode and editing are both on', async () => {
    const off = await setup({ editing: false });
    expect(() => off.edit.setCaptureVolume(100)).toThrow(/Edit mode is off/);
    const ro = await setup({ writes: false });
    expect(() => ro.edit.setCaptureVolume(100)).toThrow(/Control mode/);
  });

  it('reads an FX block, writes a parameter and a model', async () => {
    const { store, mock, edit } = await setup();
    // post2 = Analog Delay, on in the demo.
    edit.openFx('post2');
    await until(() => store.get().edit.fx?.status === 'ready');
    const fx = store.get().edit.fx!;
    expect(fx.type).toBe(6010);
    expect(fx.values!.length).toBe(12);
    edit.setFxParam('post2', 3, 0.25);
    expect(store.get().edit.fx!.values![3]).toBe(0.25);
    await until(() => Math.abs(mock.fxParams.post2[3]! - 0.25) < 1e-6);
    // Model: Tape Delay (6004). Shown at once, the dump confirms, and the editor reads the new model's parameters.
    await edit.setFxModel('post2', 6004);
    expect(store.get().fxModels.value.post2?.name).toBe('Tape Delay');
    await until(() => store.get().fxModels.source === 'dump' && store.get().edit.fx?.type === 6004 && store.get().edit.fx?.status === 'ready');
    expect(store.get().edit.fx!.values!.length).toBe(11);
    expect(fxModelType(store.get().fxModels.value.post2?.id)).toBe(6004);
  });

  it('reads and edits a bypassed block, as Cortex Cloud does; turning it on reads nothing new', async () => {
    const { store, mock, engine, edit } = await setup();
    // pre1 is off in the demo.
    expect(store.get().fxOn.value.pre1).toBe(false);
    edit.openFx('pre1');
    await until(() => store.get().edit.fx?.status === 'ready');
    edit.setFxParam('pre1', 0, 0.5);
    await until(() => Math.abs(mock.fxParams.pre1[0]! - 0.5) < 1e-6);
    const reads = sent(mock, EDIT_MSG.FX_PARAMS_REQUEST).length;
    await engine.toggleFx('pre1');
    await until(() => store.get().fxOn.value.pre1 === true && store.get().fxOn.source === 'dump');
    expect(sent(mock, EDIT_MSG.FX_PARAMS_REQUEST)).toHaveLength(reads);
    expect(store.get().edit.fx!.values![0]).toBeCloseTo(0.5, 6);
  });

  it('coalesces slider writes: the newest value wins', async () => {
    const { store, mock, edit } = await setup();
    for (let raw = 100; raw <= 140; raw += 2) edit.setCaptureVolume(raw);
    expect(store.get().captureVolume.value).toBe(140);
    await until(() => mock.device.captureVolumeRaw === 140);
    expect(sent(mock, EDIT_MSG.KNOB).length).toBeLessThan(5);
    await until(() => store.get().captureVolume.source === 'dump');
    expect(store.get().captureVolume.value).toBe(140);
    edit.setGateThreshold(30);
    await until(() => mock.device.gateThresholdRaw === 30 && store.get().gateThreshold.source === 'dump');
    expect(store.get().gateThreshold.value).toBe(30);
  });

  it('IR: settings, level, phase and microphone; on / off and the slots', async () => {
    const { store, mock, edit } = await setup();
    await edit.setIrOn(true);
    await until(() => store.get().cabOn.value === true && store.get().cabOn.source === 'dump');
    edit.openIr();
    await until(() => store.get().edit.ir?.status === 'ready');
    const cs = store.get().edit.ir!.settings!;
    expect(cs.factory).toBe(true);
    expect(cs.mics).toContain('Ribbon 160');
    edit.setIrParam('level', 0.5);
    await until(() => Math.abs(mock.ir.level - 0.5) < 1e-6);
    await edit.setIrPhase(true);
    await until(() => mock.ir.phaseInverted && store.get().edit.ir?.status === 'ready');
    expect(store.get().edit.ir!.settings!.phaseInverted).toBe(true);
    await edit.setIrMic(4, 'Ribbon 160');
    await until(() => mock.ir.position === 4 && mock.ir.mic === 'Ribbon 160');
    await edit.stepIr(1);
    await until(() => mock.device.cabSlot === 2 && store.get().cabSlot.source === 'dump');
    expect(store.get().cabSlot.value).toBe(2);
    // Off: never asked (the pedal does not answer); shown from what was read, still editable.
    const reads = sent(mock, EDIT_MSG.CAB_SETTINGS_REQUEST).length;
    await edit.setIrOn(false);
    await until(() => store.get().cabOn.value === false && store.get().cabOn.source === 'dump');
    expect(store.get().edit.ir?.status).toBe('ready');
    edit.setIrParam('level', 0.25);
    await until(() => Math.abs(mock.ir.level - 0.25) < 1e-6);
    edit.closeIr();
    edit.openIr();
    expect(store.get().edit.ir?.status).toBe('ready');
    expect(store.get().edit.ir!.settings!.level).toBeCloseTo(0.25, 6);
    expect(sent(mock, EDIT_MSG.CAB_SETTINGS_REQUEST)).toHaveLength(reads);
  });

  it('capture, IR and gate Discard put back what the preset has saved; on / off and other blocks stay', async () => {
    const { store, mock, edit } = await setup({ device: { initialState: { cabOn: true, cabSlot: 6 } } });
    await until(() => store.get().edit.savedSource !== null && store.get().cabSlot.value === 6);
    const saved = store.get().edit.savedSource!;
    // Gate.
    expect(edit.gateChanged()).toBe(false);
    edit.setGateThreshold(30);
    expect(edit.gateChanged()).toBe(true);
    edit.discardGate();
    await until(() => mock.device.gateThresholdRaw === saved.gateThreshold && store.get().gateThreshold.source === 'dump');
    expect(edit.gateChanged()).toBe(false);
    // Capture: volume and slot.
    edit.setCaptureVolume(10);
    await edit.stepCapture(1);
    await until(() => store.get().captureSlot.source === 'dump' && store.get().captureVolume.source === 'dump' && store.get().captureSlot.value !== saved.captureSlot);
    expect(edit.captureChanged()).toBe(true);
    await edit.discardCapture();
    await until(() => store.get().captureSlot.source === 'dump' && store.get().captureSlot.value === saved.captureSlot && store.get().captureVolume.value === saved.captureVolume);
    expect(edit.captureChanged()).toBe(false);
    // IR: settings read on the saved IR, then another IR and a changed level; Discard brings both back.
    edit.openIr();
    await until(() => store.get().edit.ir?.status === 'ready' && store.get().edit.savedSource?.ir != null);
    const ir = store.get().edit.savedSource!.ir!;
    edit.setIrParam('level', 0.1);
    expect(edit.irChanged()).toBe(true);
    await edit.discardIr();
    await until(() => store.get().edit.ir?.status === 'ready' && Math.abs(mock.ir.level - ir.level) < 1e-6);
    expect(edit.irChanged()).toBe(false);
    await edit.stepIr(1);
    await until(() => store.get().cabSlot.source === 'dump' && store.get().cabSlot.value !== 6);
    expect(edit.irChanged()).toBe(true);
    await edit.discardIr();
    await until(() => store.get().cabSlot.source === 'dump' && store.get().cabSlot.value === 6 && store.get().edit.ir?.status === 'ready');
    expect(edit.irChanged()).toBe(false);
    // On / off is not a value: turning the gate off is not discarded.
    expect(store.get().gateOn.value).toBe(true);
  });

  it('library: an IR and a capture load into their slot, which is then selected', async () => {
    const { store, mock, edit } = await setup();
    await edit.loadLibrary('irs');
    await until(() => store.get().edit.library.irs !== null && store.get().edit.library.loading === null);
    const irs = store.get().edit.library.irs!;
    expect(irs.filter((i) => i.list === 'user').map((i) => i.index)).toEqual([0, 1]);
    // The IR is off in the demo: it goes into the slot "on" goes to, which is then selected (turned on).
    expect(store.get().cabOn.value).toBe(false);
    const irSlot = edit.irLoadSlot();
    await edit.pickFromLibrary(irs.find((i) => i.name === 'YA')!, 'irs');
    expect(mock.slotIrs[irSlot - 1]).toBe('YA');
    await until(() => store.get().irName.source === 'dump' && store.get().cabSlot.value === irSlot);
    expect(store.get().irName.value).toBe('YA');
    expect(store.get().cabOn.value).toBe(true);
    expect(mock.edits.map((e) => e.type)).not.toContain(EDIT_MSG.CAB_SETTING); // no load into the preset itself

    await edit.loadLibrary('captures');
    await until(() => store.get().edit.library.captures !== null && store.get().edit.library.loading === null);
    const comet = store.get().edit.library.captures!.find((c) => c.name === 'Comet 60 6')!;
    await edit.pickFromLibrary(comet, 'captures');
    await until(() => sent(mock, EDIT_MSG.ENCODER).length > 0 && store.get().captureName.source === 'dump');
    expect(store.get().captureName.value).toBe('Comet 60 6');
    // Into the playing bank's slot (the demo plays bank 2: pedal slots 5..9).
    expect(mock.slotCaptures[(store.get().captureBank.value! - 1) * 5 + store.get().captureSlot.value! - 1]).toBe('Comet 60 6');
  });

  it('capture banks: a slot in another bank by bank and capture, in the playing bank by position; loads go to the playing bank', async () => {
    const { store, mock, edit } = await setup();
    await until(() => store.get().captureBank.value === 2 && store.get().captureSlots.length === 25); // the demo plays bank 2
    const before = mock.edits.length;
    await edit.selectCapture(3, 2); // bank 3, slot 2 = slot 12 of 25
    expect(mock.edits.slice(before).at(-1)!.hex).toMatch(/^08 C0 18 04 20 0B 1C/);
    await until(() => store.get().captureBank.source === 'dump' && store.get().captureBank.value === 3 && store.get().captureSlot.value === 2);
    expect(store.get().captureName.value).toBe(store.get().captureSlots[11]);
    // In the playing bank: by position (selector 1), as the pedal's own encoder.
    await edit.selectCapture(3, 4);
    expect(mock.edits.at(-1)!.hex).toMatch(/^08 C0 18 01 20 04 1C/);
    await until(() => store.get().captureSlot.source === 'dump' && store.get().captureSlot.value === 4 && store.get().captureBank.value === 3);
    // Discard goes back to the saved bank and slot.
    expect(edit.captureChanged()).toBe(true);
    await edit.discardCapture();
    const saved = store.get().edit.savedSource!;
    await until(() => store.get().captureSlot.source === 'dump' && store.get().captureBank.value === saved.captureBank && store.get().captureSlot.value === saved.captureSlot);
    expect(edit.captureChanged()).toBe(false);
    // A library capture goes into the playing bank's slot (bank 2 slot 1 = pedal slot 5).
    await edit.selectCapture(2, 1);
    await until(() => store.get().captureBank.source === 'dump' && store.get().captureBank.value === 2 && store.get().captureSlot.value === 1);
    await edit.loadLibrary('captures');
    await until(() => store.get().edit.library.captures !== null && store.get().edit.library.loading === null);
    const comet = store.get().edit.library.captures!.find((c) => c.name === 'Comet 60 6')!;
    await edit.pickFromLibrary(comet, 'captures');
    await until(() => mock.slotCaptures[5] === 'Comet 60 6');
    expect(mock.slotCaptures[0]).toBeUndefined();
  });

  it('library: a capture that is off, loaded: the slot write, then its select (on, the save light on: Save / Discard)', async () => {
    const { store, mock, edit } = await setup({ device: { initialState: { captureOn: false } } });
    await until(() => store.get().captureOn.value === false && store.get().captureOn.source === 'dump');
    expect(store.get().presetDirty.value).not.toBe(true);
    await edit.loadLibrary('captures');
    await until(() => store.get().edit.library.captures !== null && store.get().edit.library.loading === null);
    const before = mock.edits.length;
    await edit.pickFromLibrary(store.get().edit.library.captures!.find((c) => c.name === 'My Plexi')!, 'captures');
    await until(() => store.get().presetDirty.value === true && store.get().captureOn.source === 'dump' && store.get().captureOn.value === true);
    const types = mock.edits.slice(before).map((e) => e.type);
    expect(types).toEqual([EDIT_MSG.CAPTURE_SLOT_LOAD, EDIT_MSG.ENCODER]); // the firmware's way: never the preview
    expect(store.get().captureName.value).toBe('My Plexi');
    expect(mock.previewedWhileOff).toBe(false);
  });

  it("library: a capture that is off is turned on (the preset's own) before a preview; never a preview onto it off", async () => {
    const { store, mock, edit } = await setup({ device: { initialState: { captureOn: false } } });
    await until(() => store.get().captureOn.value === false && store.get().captureOn.source === 'dump');
    await edit.loadLibrary('captures');
    await until(() => store.get().edit.library.captures !== null && store.get().edit.library.loading === null);
    await edit.previewCapture(store.get().edit.library.captures!.find((c) => c.name === 'My Plexi')!);
    const types = mock.edits.map((e) => e.type);
    expect(mock.edits.find((e) => e.type === EDIT_MSG.ENCODER)!.hex).toMatch(/^08 C0 18 01 20 06 1C/); // the preset's own
    expect(types.indexOf(EDIT_MSG.ENCODER)).toBeLessThan(types.indexOf(EDIT_MSG.CAPTURE_PREVIEW));
    expect(mock.previewedWhileOff).toBe(false);
    await until(() => store.get().captureName.source === 'dump' && store.get().captureName.value === 'My Plexi' && store.get().captureOn.value === true);
  });

  it("library: a capture preview (Cortex Cloud's tap) changes no slot and marks nothing edited; an IR into the IR slot playing", async () => {
    const { store, mock, edit } = await setup({ device: { initialState: { cabOn: true, cabSlot: 2 } } });
    await edit.loadLibrary('captures');
    await until(() => store.get().edit.library.captures !== null && store.get().edit.library.loading === null);
    const plexi = store.get().edit.library.captures!.find((c) => c.name === 'My Plexi')!;
    const slots = { ...mock.slotCaptures };
    await edit.previewCapture(plexi);
    expect(sent(mock, EDIT_MSG.CAPTURE_PREVIEW)).toHaveLength(1);
    await until(() => store.get().captureName.source === 'dump' && store.get().captureName.value === 'My Plexi');
    expect(mock.slotCaptures).toEqual(slots); // no slot of the pedal's changed
    expect(store.get().presetDirty.value).not.toBe(true); // not an edit: no save light (the board, 2026-10-11)
    // The app keeps the books: a preview is heard until Cortex Cloud's stop frame (0x94), which the pedal answers (0x95).
    expect(edit.capturePreview()).toMatchObject({ name: 'My Plexi' });
    expect(edit.captureChanged()).toBe(true);
    const own = edit.ownCaptureName();
    await edit.discardCapture(); // the capture tab's Discard stops a preview
    expect(mock.edits.at(-1)!.type).toBe(EDIT_MSG.CAPTURE_PREVIEW_STOP);
    expect(mock.edits.at(-1)!.hex).toMatch(/^0D C0 10 .. .. .. .. .. .. 18 00 94 00 00 00$/);
    expect(edit.capturePreview()).toBeNull();
    await until(() => store.get().captureName.source === 'dump' && store.get().captureName.value === own);
    expect(edit.captureChanged()).toBe(false);
    await edit.loadLibrary('irs');
    await until(() => store.get().edit.library.irs !== null && store.get().edit.library.loading === null);
    expect(edit.irLoadSlot()).toBe(2);
    await edit.loadIrIntoSlot(store.get().edit.library.irs!.find((i) => i.name === 'YA')!);
    expect(mock.slotIrs[1]).toBe('YA');
    expect(store.get().irSlots[1]).toBe('YA');
    await until(() => store.get().cabSlot.source === 'dump' && store.get().cabSlot.value === 2 && store.get().irName.value === 'YA');
  });

  it('renames, creates and deletes presets; checks the name first', async () => {
    const { store, mock, edit } = await setup();
    await expect(edit.renamePreset(0, 'abc')).rejects.toThrow(/4/);
    await expect(edit.renamePreset(0, 'Plexi Crunch')).rejects.toThrow(/Preset 3/);
    await edit.renamePreset(0, 'Fuzz Face');
    expect(store.get().edit.preset.busy?.kind).toBe('rename');
    await until(() => store.get().edit.preset.busy === null);
    expect(store.get().edit.preset.result?.ok).toBe(true);
    expect(store.get().presetNames.value[0]).toBe('Fuzz Face');
    expect(mock.presets[0]!.name).toBe('Fuzz Face');

    await edit.createPreset(9, 'New One');
    await until(() => store.get().edit.preset.busy === null);
    expect(store.get().presetNames.value[9]).toBe('New One');

    await edit.deletePreset(9);
    await until(() => store.get().edit.preset.busy === null);
    expect(store.get().presetNames.value[9]).toBe('');
    expect(mock.presets[9]!.name).toBe('');
  });

  it('asks for a name when the pedal saves an unnamed preset', async () => {
    const { store, mock, engine } = await setup();
    await engine.selectPreset(9); // empty in the demo
    await until(() => store.get().activePreset.value === 9 && store.get().activePreset.source === 'dump');
    mock.pressSave();
    await until(() => store.get().edit.preset.nameNew === 9);
  });

  it("knows the preset's saved models: a new pick differs until the pedal saves it, a preset load starts over", async () => {
    const { store, mock, engine, edit } = await setup();
    expect(edit.savedModelChanged('post2')).toBeNull();
    await edit.setFxModel('post2', 6004); // Tape Delay over the saved Analog Delay
    expect(edit.savedModelChanged('post2')).toBe(store.get().edit.savedModels!.ids.post2);
    expect(store.get().edit.savedModels!.ids.post2).not.toBe(store.get().fxModels.value.post2!.id);
    // The pedal has the new model before its save button is pressed.
    await until(() => store.get().fxModels.source === 'dump' && store.get().fxModels.value.post2?.name === 'Tape Delay');
    mock.pressSave();
    await until(() => edit.savedModelChanged('post2') === null);
    expect(store.get().edit.savedModels!.ids.post2).toBe(store.get().fxModels.value.post2!.id);
    await engine.selectPreset(1);
    await until(() => store.get().edit.savedModels?.preset === 1);
    expect(edit.savedModelChanged('post2')).toBeNull();
  });

  it("the save light: an edit turns it on, Save stores the shown preset under its name, a reload discards", async () => {
    const { store, mock, engine, edit } = await setup();
    await until(() => store.get().presetDirty.value === false);
    const index = store.get().activePreset.value!;
    const name = store.get().presetNames.value[index]!;
    await edit.setFxModel('post2', 6004); // Tape Delay over Analog Delay
    await until(() => store.get().presetDirty.value === true);
    await edit.savePreset();
    await until(() => store.get().presetDirty.value === false && store.get().edit.preset.busy === null);
    expect(store.get().edit.preset.result).toMatchObject({ ok: true, index });
    expect(sent(mock, EDIT_MSG.PRESET_CREATE).at(-1)!.hex).toContain(Array.from(new TextEncoder().encode(name), (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' '));
    expect(mock.presets[index]!.name).toBe(name);
    expect(edit.savedModelChanged('post2')).toBeNull();
    // Discard: the shown preset loaded again drops the new edit.
    await edit.setFxModel('post2', 6010);
    await until(() => store.get().presetDirty.value === true);
    await engine.selectPreset(index);
    await until(() => store.get().presetDirty.value === false && store.get().fxModels.source === 'dump' && store.get().fxModels.value.post2?.name === 'Tape Delay');
  });

  it('Save on a preset with no name asks for one', async () => {
    const { store, engine, edit } = await setup();
    await engine.selectPreset(9); // empty in the demo
    await until(() => store.get().activePreset.value === 9 && store.get().activePreset.source === 'dump');
    await edit.savePreset();
    expect(store.get().edit.preset.nameNew).toBe(9);
  });

  it("a block's Discard puts back its saved model and values; another block keeps its edits", async () => {
    const { store, mock, edit } = await setup();
    const ready = () => store.get().edit.fx?.status === 'ready';
    // Delay (post2): a value changed, left as it is.
    edit.openFx('post2');
    await until(ready);
    edit.setFxParam('post2', 0, 0.123);
    await until(() => Math.abs(mock.fxParams.post2[0]! - 0.123) < 1e-6);
    edit.closeFx();
    // Reverb (post3): values changed, then another model.
    edit.openFx('post3');
    await until(ready);
    const saved = store.get().edit.fx!.values!.slice();
    const savedId = store.get().fxModels.value.post3!.id;
    expect(edit.fxChanged('post3')).toBe(false);
    edit.setFxParam('post3', 1, 0.9);
    expect(edit.fxChanged('post3')).toBe(true);
    await until(() => Math.abs(mock.fxParams.post3[1]! - 0.9) < 1e-6);
    await edit.discardFx('post3');
    await until(() => ready() && Math.abs(store.get().edit.fx!.values![1]! - saved[1]!) < 1e-6);
    expect(mock.fxParams.post3[1]).toBeCloseTo(saved[1]!, 6);
    expect(edit.fxChanged('post3')).toBe(false);
    // Model and values together.
    const other = fxSlotModels('post3').find((m) => m.category === 'Reverb' && m.id !== savedId)!;
    await edit.setFxModel('post3', other.type);
    await until(() => ready() && store.get().edit.fx!.type === other.type);
    edit.setFxParam('post3', 0, 0.01);
    expect(edit.fxChanged('post3')).toBe(true);
    await edit.discardFx('post3');
    await until(() => ready() && store.get().fxModels.source === 'dump' && store.get().fxModels.value.post3?.id === savedId);
    await until(() => ready() && store.get().edit.fx!.type === fxModelType(savedId));
    expect(store.get().edit.fx!.values!.map((v) => Math.round(v * 1e5))).toEqual(saved.map((v) => Math.round(v * 1e5)));
    expect(edit.fxChanged('post3')).toBe(false);
    // The delay's edit stays.
    expect(mock.fxParams.post2[0]).toBeCloseTo(0.123, 6);
  });

  it('assigns a footswitch', async () => {
    const { store, mock, edit } = await setup();
    await edit.assignFootswitch(5, 'iia');
    await until(() => mock.footswitches[2] === 5);
    expect(sent(mock, EDIT_MSG.PRESET_CHANGED)).toHaveLength(1);
    expect(store.get().connection).toBe('connected');
  });

  it("IR off then on goes back to the preset's own IR (slot 6)", async () => {
    const { store, mock, edit } = await setup({ device: { initialState: { cabOn: true, cabSlot: 6 } } });
    await until(() => store.get().cabSlot.value === 6);
    await edit.setIrOn(false);
    await until(() => store.get().cabOn.value === false && store.get().cabOn.source === 'dump');
    await edit.setIrOn(true);
    await until(() => mock.device.cabOn && store.get().cabOn.source === 'dump');
    expect(mock.device.cabSlot).toBe(6);
  });

  it('a capture volume of 0 (field 44 left out) still reads as a value', async () => {
    const { store, edit } = await setup();
    edit.setCaptureVolume(0);
    await until(() => store.get().captureVolume.source === 'dump');
    expect(store.get().captureVolume.value).toBe(0);
  });

  it('a delete answered after the timeout still clears the name', async () => {
    const { store, mock, edit } = await setup();
    const realWrite = mock.writeCommand.bind(mock);
    // Hold the pedal's answer back past the 3 s timeout.
    (mock as unknown as { writeCommand: typeof realWrite }).writeCommand = async (bytes) => {
      if (bytes[bytes.length - 4] === EDIT_MSG.PRESET_DELETE) {
        setTimeout(() => void realWrite(bytes), 3300);
        return;
      }
      return realWrite(bytes);
    };
    await edit.deletePreset(10);
    await until(() => store.get().edit.preset.result?.message === 'No answer from the pedal', 3500);
    expect(store.get().presetNames.value[10]).toBe('Djent 8 String');
    await until(() => store.get().presetNames.value[10] === '', 1500);
  }, 8000);

  it('a dump requested in the same millisecond as a write (just before it) does not undo it', async () => {
    const { store, edit } = await setup();
    const t = Date.now() + 1000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(t);
    try {
      edit.setCaptureVolume(0);
      // The pedal before the write, from a dump asked at the same ms.
      const stale = { activePreset: store.get().activePreset.value, captureVolumeRaw: 127, fxModelIds: {} } as unknown as CurrentState;
      expect(edit.filterState(stale, t)).toBe(true);
      expect(stale.captureVolumeRaw).toBe(0);
    } finally {
      now.mockRestore();
    }
    expect(writtenSince(0, 0)).toBe(false); // never written: an unsolicited dump (asked at 0) is not held
    expect(writtenSince(5, 6)).toBe(false);
  });
  it('the Log sheet sends a frame by hand: a body, or a whole log line (its header made again)', async () => {
    const { mock, edit } = await setup();
    const before = mock.edits.length;
    await edit.sendFrameHex('96 00 00 00'); // an empty 0x96 body
    await edit.sendFrameHex('16 C0 1A 0E 08 05 12 0A 43 6F 6D 65 74 20 36 30 20 36 96 00 00 00'); // a log line, `40 01` dropped: the length is fixed
    const hex = mock.edits.slice(before).map((e) => e.hex);
    expect(hex[0]).toBe('04 C0 96 00 00 00');
    expect(hex[1]).toMatch(/^14 C0 1A 0E 08 05/);
    await expect(edit.sendFrameHex('96')).rejects.toThrow(/00 00 00/);
  });
});
