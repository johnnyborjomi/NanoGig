/**
 * Mock transport: a fake Nano Cortex that answers dump requests with replayed
 * / synthesised c305 packets, so the whole gig view runs with no hardware.
 *
 * Request frames are matched byte-exactly against `protocol/frames.ts`. The
 * current-state reply alternates between the single-packet `C1` form and the
 * segmented `FE` stream form so both reassembly paths get exercised.
 */
import {
  CURRENT_STATE_REQUEST,
  DEVICE_SETTINGS_REQUEST,
  FX_ENABLE_SLOT,
  FX_SLOTS,
  GATE_ENABLE_SLOT,
  METADATA_DUMP_REQUEST,
  PRESET_CHANGE_ACK,
  type FxSlot,
  type MidiStrategy,
} from '../protocol/frames';
import { bytesEqual, toHex } from '../protocol/hex';
import {
  DEMO_PRESETS,
  REAL_EVENTS,
  REAL_STATE_DUMP_PACKET,
  buildCurrentStateBody,
  buildPresetChangedEvent,
  buildTunerPitchEvent,
  buildExpressionPositionEvent,
  buildExpressionValuesEvent,
  buildMetadataBody,
  mockCaptureSlots,
  defaultMockDeviceState,
  segmentStream,
  wrapSinglePacket,
  type MockDeviceState,
  type MockPreset,
} from '../fixtures/captures';
import { HW_DEVICE_SETTINGS_REPLY, HW_DEVICE_SETTINGS_REPLY_UNMUTED, HW_OUTPUTS_MUTE_ACK } from '../fixtures/hardware-2026-09-15';
import { HW_BYPASS_CHANGED } from '../fixtures/hardware-2026-09-12';
import { HW_EXP_ASSIGN_REPLY_58, HW_PRESET_SELECT_ACK } from '../fixtures/hardware-2026-09-19';
import { TUNER_OFF } from '../protocol/frames';
import { EDIT_MSG, FX_SLOT_MODELS, fxDef, fxModelId, type CabSettings } from '../protocol/edit';
import { fromHex } from '../protocol/hex';
import { bytesField, firstBytes, firstVarint, fixed32FloatField, parseFields, stringField, varintField } from '../protocol/proto';
import { frameSingle, parseFrameHeader, splitTrailer } from '../protocol/reassembly';
import { defaultMockModelIds } from '../fixtures/captures';
import {
  Emitter,
  type ConnectOptions,
  type LogLine,
  type NotifyPacket,
  type Transport,
  type TransportStatus,
} from './types';

export interface MockOptions {
  presets?: MockPreset[];
  initialState?: Partial<MockDeviceState>;
  /** Reply latency per packet, ms. */
  latencyMs?: number;
  /** Gap between stream packets, ms. */
  packetGapMs?: number;
  /** Emit a footswitch preset change every N ms (0 = off). */
  autoEventIntervalMs?: number;
  /** Use the real captured dump for the very first state reply. */
  replayRealDumpFirst?: boolean;
  /** Force reply shape instead of alternating. */
  stateReplyShape?: 'single' | 'segmented' | 'alternate';
  /**
   * Which preset-switch delivery the fake pedal honours (default `c304-select`, like
   * NanOS 2.2.1). Others are ignored silently, except raw-on-c302 which fails like the
   * real pedal did on 2026-09-12.
   */
  acceptedMidi?: string;
}

export class MockTransport implements Transport {
  readonly name = 'mock';
  readonly presets: MockPreset[];
  readonly device: MockDeviceState;
  private _status: TransportStatus = 'disconnected';
  private readonly packets = new Emitter<NotifyPacket>();
  private readonly statuses = new Emitter<TransportStatus>();
  private readonly logs = new Emitter<LogLine>();
  private readonly opts: Required<MockOptions>;
  private stateReplies = 0;
  private autoTimer: ReturnType<typeof setInterval> | null = null;
  private tunerTimer: ReturnType<typeof setInterval> | null = null;
  private tunerTick = 0;
  private pending: ReturnType<typeof setTimeout>[] = [];
  private autoEventCounter = 0;

  constructor(opts: MockOptions = {}) {
    this.opts = {
      presets: opts.presets ?? DEMO_PRESETS,
      initialState: opts.initialState ?? {},
      latencyMs: opts.latencyMs ?? 60,
      packetGapMs: opts.packetGapMs ?? 12,
      autoEventIntervalMs: opts.autoEventIntervalMs ?? 0,
      replayRealDumpFirst: opts.replayRealDumpFirst ?? true,
      stateReplyShape: opts.stateReplyShape ?? 'alternate',
      acceptedMidi: opts.acceptedMidi ?? 'c304-select',
    };
    // A copy: renames and deletes change it, and the demo list is shared.
    this.presets = this.opts.presets.map((p) => ({ ...p }));
    this.device = { fxModelIds: defaultMockModelIds(), gateThresholdRaw: 158, cabSlot: 1, ...defaultMockDeviceState(), ...this.opts.initialState };
  }

  get status() {
    return this._status;
  }
  get deviceName() {
    return this._status === 'disconnected' ? null : 'Nano Cortex (mock)';
  }
  onPacket(cb: (p: NotifyPacket) => void) {
    return this.packets.on(cb);
  }
  onStatus(cb: (s: TransportStatus) => void) {
    return this.statuses.on(cb);
  }
  onLog(cb: (l: LogLine) => void) {
    return this.logs.on(cb);
  }

  private log(dir: LogLine['dir'], text: string, hex?: string) {
    this.logs.emit({ at: Date.now(), dir, text, ...(hex ? { hex } : {}) });
  }

  private setStatus(s: TransportStatus) {
    this._status = s;
    this.statuses.emit(s);
  }

  async connect(_opts?: ConnectOptions): Promise<void> {
    this.setStatus('connecting');
    await this.delay(this.opts.latencyMs);
    this.log('info', 'Mock device connected (no hardware)');
    this.setStatus('connected');
    if (this.opts.autoEventIntervalMs > 0) {
      this.autoTimer = setInterval(() => this.emitAutoEvent(), this.opts.autoEventIntervalMs);
    }
  }

  async disconnect(): Promise<void> {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
    this.stopTunerStream();
    for (const t of this.pending) clearTimeout(t);
    this.pending = [];
    this.setStatus('disconnected');
  }

  /** Simulate the device dropping the link (e.g. power cycle) and coming back. */
  simulateDrop(reconnectAfterMs = 1500): void {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
    this.setStatus('reconnecting');
    this.schedule(() => {
      this.log('info', 'Mock device back online');
      this.setStatus('connected');
      if (this.opts.autoEventIntervalMs > 0) {
        this.autoTimer = setInterval(() => this.emitAutoEvent(), this.opts.autoEventIntervalMs);
      }
    }, reconnectAfterMs);
  }

  private delay(ms: number) {
    return new Promise<void>((r) => this.schedule(r, ms));
  }

  private schedule(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.pending = this.pending.filter((x) => x !== t);
      fn();
    }, ms);
    this.pending.push(t);
    return t;
  }

  private emit(data: Uint8Array, char = 'c305') {
    this.packets.emit({ char, data, at: Date.now() });
  }

  private currentPreset(): MockPreset {
    return this.presets[this.device.activePreset] ?? { name: '', captureName: '', irShortName: '' };
  }

  async writeCommand(bytes: Uint8Array): Promise<void> {
    if (this._status !== 'connected') throw new Error('mock: not connected');
    this.log('tx', 'TX c304 (mock)', toHex(bytes));
    if (bytesEqual(bytes, METADATA_DUMP_REQUEST)) {
      const body = buildMetadataBody(this.presets, this.device, this.metadataCaptures());
      this.emitStream(segmentStream(body, 510));
      return;
    }
    if (bytesEqual(bytes, CURRENT_STATE_REQUEST)) {
      this.replyCurrentState();
      return;
    }
    if (bytesEqual(bytes, PRESET_CHANGE_ACK)) {
      return; // the pedal's reply to this MIDI-path ack is not captured
    }
    // Preset select (Cortex Cloud, 2026-09-19): 36 C0 18 00 20 <preset> … 1D 00 00 00
    if (bytes.length === 56 && bytes[0] === 0x36 && bytes[1] === 0xc0 && bytes[2] === 0x18 && bytes[4] === 0x20 && bytes[52] === 0x1d && bytes[51] !== 0x02) {
      // (field 9 = 2 is a footswitch assignment, not a select: handled with the edits)
      if (this.opts.acceptedMidi !== 'c304-select') return; // other firmware: ignored
      if (this.device.previewSavedOwn && this.device.activePreset === bytes[5]) this.device.captureSlot = 6;
      this.device.previewSavedOwn = false;
      this.device.activePreset = bytes[5]!;
      this.presetLoads++;
      this.device.captureNameOverride = this.device.irNameOverride = null; // a preset load drops unsaved edits (a preview too)
      this.device.previewing = false;
      this.loadDropsEdits();
      // The real pedal answers with a bypass-changed notice, then the 0x1E ack; no 0x1D event.
      this.schedule(() => {
        this.emit(HW_BYPASS_CHANGED);
        this.emit(HW_PRESET_SELECT_ACK);
      }, this.opts.latencyMs);
      return;
    }
    // Tuner on (0F C0 20 01 2D <f32> 30 01 38 <mute> 7F …) / off (06 C0 20 00 7F …), 2026-09-19.
    if (bytesEqual(bytes, TUNER_OFF)) {
      this.stopTunerStream();
      return;
    }
    if (bytes.length === 17 && bytes[0] === 0x0f && bytes[1] === 0xc0 && bytes[2] === 0x20 && bytes[3] === 0x01 && bytes[13] === 0x7f) {
      this.startTunerStream();
      return;
    }
    // Tempo set (per-tap shape, enters tap mode) / tap mode exit (2026-09-26): silent on the real pedal.
    if ((bytes.length === 15 && bytes[0] === 0x0d && bytes[4] === 0x18 && bytes[6] === 0x2d && bytes[11] === 0x91) || (bytes.length === 13 && bytes[0] === 0x0b && bytes[4] === 0x2d && bytes[9] === 0x91)) {
      const off = bytes.length === 15 ? 7 : 5;
      this.device.tempoBpm = new DataView(bytes.buffer, bytes.byteOffset + off, 4).getFloat32(0, true);
      this.device.tapTempo = bytes.length === 15;
      return;
    }
    // Expression assignments read: 08 C0 08 03 18 <preset> 3C … → the demo has post 3 (17–130) on even presets.
    if (bytes.length === 10 && bytes[0] === 0x08 && bytes[1] === 0xc0 && bytes[2] === 0x08 && bytes[3] === 0x03 && bytes[4] === 0x18 && bytes[6] === 0x3c) {
      const preset = bytes[5]!;
      this.schedule(() => this.emit(preset % 2 === 0 ? HW_EXP_ASSIGN_REPLY_58 : Uint8Array.from([0x06, 0xc0, 0x08, 0x01, 0x3d, 0x00, 0x00, 0x00])), this.opts.latencyMs);
      return;
    }
    if (bytesEqual(bytes, DEVICE_SETTINGS_REQUEST)) {
      this.schedule(() => this.emit(this.device.outputsMuted ? HW_DEVICE_SETTINGS_REPLY : HW_DEVICE_SETTINGS_REPLY_UNMUTED), this.opts.latencyMs);
      return;
    }
    // Outputs 1/2: 08 C0 08 01 68 <1 mute / 0 on> 43 00 00 00 → ack 08 C0 08 01 18 01 44 00 00 00
    if (bytes.length === 10 && bytes[0] === 0x08 && bytes[1] === 0xc0 && bytes[2] === 0x08 && bytes[4] === 0x68 && bytes[6] === 0x43) {
      this.device.outputsMuted = bytes[5] !== 0;
      this.schedule(() => this.emit(HW_OUTPUTS_MUTE_ACK), this.opts.latencyMs);
      return;
    }
    // Bypass frame: 0A C0 08 01 18 <slot> 20 <0/1> 1F 00 00 00
    if (bytes.length === 12 && bytes[0] === 0x0a && bytes[1] === 0xc0 && bytes[4] === 0x18 && bytes[6] === 0x20 && bytes[8] === 0x1f) {
      const slotByte = bytes[5]!;
      const on = bytes[7] === 0x00;
      if (slotByte === GATE_ENABLE_SLOT) {
        this.device.gateOn = on;
        return;
      }
      const slot = (Object.keys(FX_ENABLE_SLOT) as FxSlot[]).find((k) => FX_ENABLE_SLOT[k] === slotByte);
      if (slot) this.device.fxOn[slot] = on;
      return;
    }
    // Slot-select family: 08 C0 18 <sel> 20 <v> 1C 00 00 00
    if (bytes.length === 10 && bytes[0] === 0x08 && bytes[1] === 0xc0 && bytes[2] === 0x18 && bytes[4] === 0x20 && bytes[6] === 0x1c) {
      // Selector 1 (capture slot / bypass), 3 (IR slot / off) and 4 (bank and capture): the editing handler below.
    }
    if (this.handleEdit(bytes)) return;
    this.log('warn', 'mock: unrecognised command frame ignored', toHex(bytes));
  }

  // -------------------------------------------------------------------------
  // Editing (frames from the NanoGig Screen firmware, replies shaped like the pedal's)
  // -------------------------------------------------------------------------

  /** FX parameter values per slot (0..1, the model's order); a model write resets them. */
  readonly fxParams: Record<FxSlot, number[]> = { pre1: [], pre2: [], post1: [], post2: [], post3: [] };
  readonly ir: CabSettings = {
    level: 0.66212219,
    highPass: 0.1,
    lowPass: 0.8,
    factory: true,
    kind: 3,
    irName: '412 UK GRN V30',
    position: 1,
    mic: 'Dynamic 57',
    mics: ['Dynamic 57', 'Dynamic 421', 'Condenser 414', 'Ribbon 160'],
    phaseInverted: false,
  };
  /** Library: factory and user captures / IRs (each list indexed on its own). */
  readonly library = {
    captures: { factory: ['Brit 1959 Crunch', 'Cali Recto Modern', 'Jazz 120 Clean', 'Tweed 57 Deluxe', 'NoMatch Chief 1', 'Comet 60 6'], user: ['My Plexi', 'Studio Rectifier'] },
    irs: { factory: ['412 UK GRN V30', '212 UK GRN V30', '412 US OS V30', '212 US JAZ', '112 US TWD P12Q', '110 US PRN C10R'], user: ['Tay816 M251 Pz1', 'YA'] },
  };
  /** Frames the mock understood as edits, for tests. */
  readonly edits: { type: number; hex: string }[] = [];

  private paramsFor(slot: FxSlot): number[] {
    const def = fxDef(this.slotType(slot));
    const have = this.fxParams[slot];
    if (def && have.length !== def.params.length) this.fxParams[slot] = def.params.map((_, i) => (i % 3) / 2);
    return this.fxParams[slot];
  }

  private slotType(slot: FxSlot): number {
    const id = (this.device.fxModelIds ?? defaultMockModelIds())[slot];
    let type = 0;
    id.forEach((b, i) => (type += (b & 0x7f) * 2 ** (7 * i)));
    return type;
  }

  private reply(body: number[], type: number) {
    this.schedule(() => this.emit(frameSingle([...body, type, 0, 0, 0])), this.opts.latencyMs);
  }

  private handleEdit(bytes: Uint8Array): boolean {
    const h = parseFrameHeader(bytes);
    if (!h) return false;
    const { payload, msgType } = splitTrailer(bytes.subarray(2));
    if (msgType === null) return false;
    const f = parseFields(payload);
    const v = (n: number) => firstVarint(f, n) ?? 0;
    const sub = (n: number) => {
      const raw = firstBytes(f, n);
      return raw ? parseFields(raw) : null;
    };
    const text = (fields: ReturnType<typeof parseFields> | null, n: number) => {
      const raw = fields ? firstBytes(fields, n) : null;
      return raw ? new TextDecoder().decode(raw) : '';
    };
    const ok = (preset?: number) => [...varintField(1, 6), ...(preset ? varintField(3, preset) : []), ...varintField(4, 1)];
    switch (msgType) {
      case EDIT_MSG.FX_MODEL: {
        const slot = FX_SLOTS[v(3)];
        const type = v(4);
        if (!slot || !FX_SLOT_MODELS[v(3)]!.includes(type)) return true; // the pedal ignores a model the slot does not take
        if (!this.device.dirty) this.savedModelIds = structuredClone(this.device.fxModelIds!); // the saved ones, before the first edit
        this.device.fxModelIds![slot] = Array.from(fromHex(fxModelId(type)));
        this.fxParams[slot] = [];
        this.markDirty();
        break;
      }
      case EDIT_MSG.FX_PARAMS_REQUEST: {
        const slot = FX_SLOTS[v(3)];
        if (!slot) return true; // on or off alike, as Cortex Cloud reads a bypassed block
        const values = this.paramsFor(slot);
        const packed = new Uint8Array(values.length * 4);
        values.forEach((x, i) => new DataView(packed.buffer).setFloat32(i * 4, x, true));
        this.reply([...varintField(1, 6), ...bytesField(4, packed)], EDIT_MSG.FX_PARAMS);
        break;
      }
      case EDIT_MSG.FX_PARAM: {
        const slot = FX_SLOTS[v(3)];
        const raw = f.find((x) => x.field === 5 && x.wire === 5)?.raw;
        if (slot && raw) this.paramsFor(slot)[v(4)] = new DataView(raw.buffer, raw.byteOffset, 4).getFloat32(0, true);
        this.markDirty(false);
        break;
      }
      case EDIT_MSG.KNOB: {
        if (v(3) === 10) this.device.captureVolumeRaw = v(4);
        else if (v(3) === 11) this.device.gateThresholdRaw = v(4);
        else return false;
        this.markDirty(false);
        break;
      }
      case EDIT_MSG.ENCODER: {
        // Selector 1: capture slot 1..6 (0 = off); selector 3: IR slot (0 = off).
        if (v(3) === 1) {
          this.device.captureOn = v(4) > 0;
          if (v(4) > 0) this.device.captureSlot = v(4);
          this.device.previewing = false;
          const bank = (this.device.captureBank ?? 1) - 1;
          if (v(4) > 0 && v(4) <= 5) this.device.captureNameOverride = this.metadataCaptures()[bank * 5 + v(4) - 1] ?? null;
          if (v(4) === 6) this.device.captureNameOverride = null;
        } else if (v(3) === 4) {
          // Bank and capture: slot 0..24 over the five banks (Cortex Cloud, DrD85).
          const abs = v(4);
          this.device.captureBank = Math.floor(abs / 5) + 1;
          this.device.captureSlot = (abs % 5) + 1;
          this.device.captureOn = true;
          this.device.captureNameOverride = this.metadataCaptures()[abs] ?? null;
          this.device.previewing = false;
        } else if (v(3) === 3) {
          this.device.cabOn = v(4) > 0;
          if (v(4) > 0) {
            this.device.cabSlot = v(4);
            this.device.irNameOverride = this.metadataIrs()[v(4) - 1] ?? null;
          }
        } else return false;
        this.markDirty(); // the slot write's ack is this notice (`08 C0 08 01 18 01 73`)
        break;
      }
      case EDIT_MSG.CAB_SETTINGS_REQUEST: {
        if (!this.device.cabOn) return true; // the pedal leaves it unanswered (board, 2026-10-11)
        const ir = this.ir;
        const name = this.device.irNameOverride || this.currentPreset().irShortName || ir.irName;
        const settings = [
          ...(ir.level ? fixed32FloatField(1, ir.level) : []),
          ...(ir.highPass ? fixed32FloatField(2, ir.highPass) : []),
          ...(ir.lowPass ? fixed32FloatField(3, ir.lowPass) : []),
          ...(ir.phaseInverted ? varintField(4, 1) : []),
        ];
        const user = this.library.irs.user.includes(name);
        this.reply(
          [
            ...varintField(1, 6),
            ...bytesField(user ? 6 : 5, [...varintField(1, ir.kind), ...stringField(2, name), ...(user ? [] : [...varintField(3, ir.position), ...stringField(4, ir.mic)])]),
            ...(user ? [] : ir.mics.flatMap((m) => stringField(7, m))),
            ...bytesField(8, settings),
          ],
          EDIT_MSG.CAB_SETTINGS,
        );
        break;
      }
      case EDIT_MSG.CAB_SETTING: {
        for (const x of f) {
          if (x.wire === 5 && x.field >= 5 && x.field <= 7) {
            const n = new DataView(x.raw.buffer, x.raw.byteOffset, 4).getFloat32(0, true);
            if (x.field === 5) this.ir.level = n;
            else if (x.field === 6) this.ir.highPass = n;
            else this.ir.lowPass = n;
          } else if (x.field === 8 && x.wire === 0) {
            this.ir.phaseInverted = x.value !== 0;
          } else if ((x.field === 3 || x.field === 4) && x.wire === 2) {
            const g = parseFields(x.raw);
            const name = text(g, 2);
            if (firstVarint(g, 3) !== null) this.ir.position = firstVarint(g, 3)!;
            if (text(g, 4)) this.ir.mic = text(g, 4);
            if (name) {
              this.device.irNameOverride = name;
              this.device.cabOn = true;
            }
          }
        }
        this.markDirty(false);
        break;
      }
      case EDIT_MSG.LIBRARY_REQUEST: {
        const body: number[] = [...varintField(1, 6)];
        const cap = (name: string, i: number) => [...stringField(1, i.toString(16).padStart(64, '0')), ...stringField(2, name)];
        if (v(3)) this.library.captures.factory.forEach((n, i) => body.push(...bytesField(3, cap(n, i))));
        if (v(4)) this.library.irs.factory.forEach((n) => body.push(...stringField(4, n)));
        if (v(5)) this.library.captures.user.forEach((n, i) => body.push(...bytesField(5, cap(n, 100 + i))));
        if (v(6)) this.library.irs.user.forEach((n) => body.push(...stringField(6, n)));
        body.push(EDIT_MSG.LIBRARY, 0, 0, 0);
        this.emitStream(segmentStream(Uint8Array.from(body), 120));
        break;
      }
      case EDIT_MSG.CAPTURE_SLOT_LOAD: {
        const item = sub(4) ?? sub(5);
        const slot = v(3);
        if (item) this.slotCaptures[slot] = text(item, 2);
        this.reply([...varintField(1, 6), ...varintField(3, 1)], EDIT_MSG.CAPTURE_SLOT_LOADED);
        break;
      }
      case EDIT_MSG.CAB_SLOT_LOAD: {
        // A library IR into IR slot 0..4 (every preset on it hears it).
        const item = sub(4) ?? sub(5);
        if (item) this.slotIrs[v(3)] = text(item, 2);
        this.reply([...varintField(1, 6), ...varintField(3, 1)], EDIT_MSG.CAB_SLOT_LOADED);
        break;
      }
      case EDIT_MSG.CAPTURE_PREVIEW: {
        // The real pedal hung on a preview while its capture was off (board, 2026-10-11): remembered for tests.
        if (!this.device.captureOn) this.previewedWhileOff = true;
        // Heard at once; the preset is NOT marked edited (Cortex Cloud's tap; the board shows no save light).
        const item = sub(3) ?? sub(4);
        if (item) {
          this.device.captureNameOverride = text(item, 2);
          this.device.captureOn = true;
          this.device.previewing = true;
        }
        this.reply([...varintField(1, 6), ...varintField(3, 1)], EDIT_MSG.CAPTURE_PREVIEWED);
        break;
      }
      case EDIT_MSG.CAPTURE_PREVIEW_STOP: {
        // Cortex Cloud's stop (snoop 2026-10-11): the saved capture plays again; the reply echoes the time sent.
        this.device.captureNameOverride = null;
        this.device.previewing = false;
        // After a save with the preview: the slot it had plays again (its bank capture), unlike what is saved (board).
        if (this.device.previewSavedOwn && (this.device.captureSlot ?? 0) >= 1 && (this.device.captureSlot ?? 0) <= 5) {
          this.device.captureNameOverride = this.metadataCaptures()[((this.device.captureBank ?? 1) - 1) * 5 + this.device.captureSlot! - 1] ?? null;
          this.markDirty();
        }
        const ts = f.find((x) => x.field === 2 && x.wire === 0)?.raw ?? [];
        this.reply([...varintField(1, 1), 0x10, ...Array.from(ts), ...varintField(3, 1)], EDIT_MSG.CAPTURE_PREVIEW_STOPPED);
        break;
      }
      case EDIT_MSG.RENAME:
      case EDIT_MSG.PRESET_CREATE: {
        const index = v(3);
        const name = text(f, msgType === EDIT_MSG.RENAME ? 4 : 5);
        while (this.presets.length <= index) this.presets.push({ name: '', captureName: '', irShortName: '' });
        const p = this.presets[index]!;
        if (msgType === EDIT_MSG.PRESET_CREATE) {
          p.captureName = this.device.captureNameOverride || this.currentPreset().captureName || 'Capture 1';
          // Saved with a preview playing: the preset keeps it as its own capture (board, 2026-10-13); what plays
          // stays on the slot it had until the preset loads again.
          if (this.device.previewing && index === this.device.activePreset) this.device.previewSavedOwn = true;
          p.irShortName = this.device.irNameOverride || this.currentPreset().irShortName || 'IR 1';
        }
        p.name = name;
        this.reply(ok(index), msgType === EDIT_MSG.RENAME ? EDIT_MSG.RENAME_REPLY : EDIT_MSG.PRESET_CREATED);
        // SavePreset (DrD85's name for it): on the shown preset, its edits are saved and the light goes out.
        if (msgType === EDIT_MSG.PRESET_CREATE && index === this.device.activePreset) this.saveEdits();
        break;
      }
      case EDIT_MSG.PRESET_DELETE: {
        const index = v(3);
        if (this.presets[index]) this.presets[index] = { name: '', captureName: '', irShortName: '' };
        this.reply(ok(index), EDIT_MSG.PRESET_DELETED);
        break;
      }
      case EDIT_MSG.PRESET_CHANGED: {
        // Footswitch assignment: field 9 = 2, the footswitch's field holds the preset (the others -1).
        if (v(9) !== 2) return false;
        const fields = [5, 6, 7, 8];
        const at = fields.find((n) => (firstVarint(f, n) ?? 0) < 64);
        if (at !== undefined) this.footswitches[at - 5] = v(at);
        this.schedule(() => {
          this.emit(HW_BYPASS_CHANGED);
          this.emit(HW_PRESET_SELECT_ACK);
        }, this.opts.latencyMs);
        break;
      }
      default:
        return false;
    }
    this.edits.push({ type: msgType, hex: toHex(bytes) });
    return true;
  }

  /**
   * An edit: the shown preset has unsaved changes. The pedal says so with 0x73 field 3 = 1 (always, as the ack to
   * a slot write; `always` false: only when the light comes on).
   */
  private markDirty(always = true) {
    const was = this.device.dirty;
    this.device.dirty = true;
    if (always || !was) this.reply([...varintField(1, 1), ...varintField(3, 1)], 0x73);
  }

  /** FX models as saved (the mock's presets share one set): a load puts them back, a save takes the shown ones. */
  private savedModelIds: Record<FxSlot, number[]> | null = null;

  private saveEdits() {
    this.savedModelIds = structuredClone(this.device.fxModelIds ?? defaultMockModelIds());
    this.clearDirty();
  }

  /** A preset load drops unsaved edits (the desktop editor's Discard is a load of the shown preset). */
  private loadDropsEdits() {
    if (this.device.dirty && this.savedModelIds) this.device.fxModelIds = structuredClone(this.savedModelIds);
    this.clearDirty();
  }

  /** A preset load or a save: no unsaved changes (`06 C0 08 01 73`, as after a footswitch press). */
  private clearDirty() {
    if (!this.device.dirty) return;
    this.device.dirty = false;
    this.schedule(() => this.emit(Uint8Array.from([0x06, 0xc0, 0x08, 0x01, 0x73, 0x00, 0x00, 0x00])), this.opts.latencyMs);
  }

  /** The capture slots' names after library loads (slot 0..24). */
  readonly slotCaptures: Record<number, string> = {};
  /** A capture preview arrived while the capture was off (the real pedal hangs). */
  previewedWhileOff = false;
  /** Preset selects received (a load of the shown preset is the way out of a preview). */
  presetLoads = 0;
  /** The IR slots' names after library loads (slot 0..4). */
  readonly slotIrs: Record<number, string> = {};
  /** Preset index on IA, IB, IIA, IIB. */
  readonly footswitches = [3, 7, 10, 16];

  private metadataCaptures(): string[] {
    return mockCaptureSlots(this.presets).map((n, i) => this.slotCaptures[i] ?? n);
  }

  private metadataIrs(): string[] {
    return [...new Set(this.presets.map((p) => p.irShortName).filter(Boolean))].slice(0, 5).map((n, i) => this.slotIrs[i] ?? n);
  }

  /** Test hook: the pedal's own save button (0x1B, field 3 = 2). */
  pressSave() {
    this.saveEdits();
    this.emit(Uint8Array.from([0x08, 0xc0, 0x08, 0x01, 0x18, 0x02, 0x1b, 0x00, 0x00, 0x00]));
  }

  async writeMidi(bytes: Uint8Array, strategy: MidiStrategy): Promise<void> {
    if (this._status !== 'connected') throw new Error('mock: not connected');
    const payload = strategy.framing === 'ble-midi' ? Uint8Array.from([0x80, 0x80, ...bytes]) : bytes; // sequential logged as one line
    this.log('tx', `TX ${strategy.char} [${strategy.id}] (mock)`, toHex(payload));
    if (strategy.id === 'c302-raw') throw new Error('GATT operation failed for unknown reason.');
    if (strategy.id !== this.opts.acceptedMidi) return; // pedal ignores this form
    if (bytes.length === 2 && (bytes[0]! & 0xf0) === 0xc0 && bytes[1]! < 64) {
      this.device.activePreset = bytes[1]!;
      this.loadDropsEdits();
      // The real pedal announces the switch with a preset-changed message.
      this.schedule(() => this.emit(buildPresetChangedEvent(this.device.activePreset)), this.opts.latencyMs);
      return;
    }
    this.log('warn', 'mock: unrecognised MIDI bytes ignored', toHex(bytes));
  }

  /** Rock the fake expression pedal heel → toe → heel over ~1 s, with post 3 mapped into 17–130 like the capture. */
  sweepExpression(steps = 20, stepMs = 50): void {
    for (let i = 0; i <= steps * 2; i++) {
      const pos = Math.round((i <= steps ? i / steps : (2 * steps - i) / steps) * 254);
      const value = Math.round(17 + (pos / 254) * (130 - 17));
      this.schedule(() => {
        this.emit(buildExpressionPositionEvent(pos));
        this.emit(buildExpressionValuesEvent({ post3: value }));
      }, i * stepMs);
    }
  }

  /** Fake pitch stream: a new string every ~2 s, plucked sharp and settling towards in tune, ~30 readings/s. */
  private startTunerStream() {
    if (this.tunerTimer) return;
    this.tunerTick = 0;
    this.tunerTimer = setInterval(() => {
      if (this._status !== 'connected') return;
      const notes = ['E', 'A', 'D', 'G', 'B', 'E'];
      const i = this.tunerTick++;
      const phase = i % 60; // 60 ticks ≈ 2 s per string
      if (phase >= 48) return; // a short silence between strings: the real pedal sends nothing then
      const note = notes[Math.floor(i / 60) % notes.length]!;
      const cents = 14 * Math.exp(-phase / 12) - 0.6 + 0.4 * Math.sin(i);
      this.emit(buildTunerPitchEvent(note, cents));
    }, 33);
  }

  private stopTunerStream() {
    if (this.tunerTimer) clearInterval(this.tunerTimer);
    this.tunerTimer = null;
  }

  private replyCurrentState() {
    const n = this.stateReplies++;
    if (n === 0 && this.opts.replayRealDumpFirst) {
      // The real capture is the demo's preset 0: pre1/pre2 bypassed, gate on, cab off.
      this.schedule(() => this.emit(REAL_STATE_DUMP_PACKET), this.opts.latencyMs);
      return;
    }
    const body = buildCurrentStateBody(this.device, this.currentPreset());
    const shape = this.opts.stateReplyShape === 'alternate' ? (n % 2 === 0 ? 'single' : 'segmented') : this.opts.stateReplyShape;
    if (shape === 'single') {
      this.schedule(() => this.emit(wrapSinglePacket(body)), this.opts.latencyMs);
    } else {
      this.emitStream(segmentStream(body, 120));
    }
  }

  private emitStream(packets: Uint8Array[]) {
    packets.forEach((pkt, i) => {
      // The real device mirrors every packet on c306; the BLE transport dedupes those
      // before they reach the engine, so the mock emits the deduped c305 view only.
      this.schedule(() => this.emit(pkt), this.opts.latencyMs + i * this.opts.packetGapMs);
    });
  }

  /** Cycle through presets like a footswitch would; occasionally twist a knob. */
  private emitAutoEvent() {
    const i = this.autoEventCounter++;
    if (i % 4 === 3) {
      this.emit(REAL_EVENTS.gainKnob);
      return;
    }
    const populated = this.presets.map((p, idx) => (p.name ? idx : -1)).filter((x) => x >= 0);
    const next = populated[(populated.indexOf(this.device.activePreset) + 1) % populated.length] ?? 0;
    this.device.activePreset = next;
    this.device.captureNameOverride = this.device.irNameOverride = null;
    this.device.previewing = false;
    this.loadDropsEdits();
    // Alternate between the hardware-observed message and the 2-byte MIDI shape.
    if (i % 2 === 0) this.emit(buildPresetChangedEvent(next));
    else this.emit(Uint8Array.from([0xc0, next]));
  }

  /** Test hook: emit an arbitrary packet as if the device sent it. */
  inject(data: Uint8Array, char = 'c305') {
    this.emit(data, char);
  }

  /** Test hook: change the preset as a footswitch press would. */
  pressFootswitch(preset: number) {
    this.device.activePreset = preset;
    this.device.captureNameOverride = this.device.irNameOverride = null;
    this.device.previewing = false;
    this.loadDropsEdits();
    this.emit(buildPresetChangedEvent(preset));
    this.emit(Uint8Array.from([0x06, 0xc0, 0x08, 0x01, 0x1f, 0x00, 0x00, 0x00])); // bypass-changed follows on hardware
  }

  static slotIndex(slot: FxSlot): number {
    return FX_SLOTS.indexOf(slot);
  }
}
