/**
 * Editing against the mock pedal with real (short) timers: mock transport → sync engine → edit controller → store.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDIT_MSG, fxModelType } from '../src/protocol/edit';
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

  it('never reads a bypassed block', async () => {
    const { store, mock, edit } = await setup();
    // pre1 is off in the demo.
    edit.openFx('pre1');
    expect(store.get().edit.fx?.status).toBe('off');
    await wait(50);
    expect(sent(mock, EDIT_MSG.FX_PARAMS_REQUEST)).toHaveLength(0);
    expect(() => edit.setFxParam('pre1', 0, 0.5)).toThrow(/on/);
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
    await edit.setIrOn(false);
    await until(() => store.get().edit.ir?.status === 'off');
  });

  it('library: an IR loads into the preset, a capture into its slot which is then selected', async () => {
    const { store, mock, edit } = await setup();
    await edit.loadLibrary('irs');
    await until(() => store.get().edit.library.irs !== null && store.get().edit.library.loading === null);
    const irs = store.get().edit.library.irs!;
    expect(irs.filter((i) => i.list === 'user').map((i) => i.index)).toEqual([0, 1]);
    await edit.pickFromLibrary(irs.find((i) => i.name === 'YA')!, 'irs');
    expect(store.get().irName.value).toBe('YA');
    await until(() => store.get().irName.source === 'dump');
    expect(store.get().irName.value).toBe('YA');

    await edit.loadLibrary('captures');
    await until(() => store.get().edit.library.captures !== null && store.get().edit.library.loading === null);
    const comet = store.get().edit.library.captures!.find((c) => c.name === 'Comet 60 6')!;
    await edit.pickFromLibrary(comet, 'captures');
    await until(() => sent(mock, EDIT_MSG.ENCODER).length > 0 && store.get().captureName.source === 'dump');
    expect(store.get().captureName.value).toBe('Comet 60 6');
    expect(mock.slotCaptures[store.get().captureSlot.value! - 1]).toBe('Comet 60 6');
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
});
