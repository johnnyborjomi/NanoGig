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
  buildMetadataBody,
  defaultMockDeviceState,
  segmentStream,
  wrapSinglePacket,
  type MockDeviceState,
  type MockPreset,
} from '../fixtures/captures';
import { HW_DEVICE_SETTINGS_REPLY, HW_DEVICE_SETTINGS_REPLY_UNMUTED, HW_OUTPUTS_MUTE_ACK } from '../fixtures/hardware-2026-09-15';
import { HW_BYPASS_CHANGED } from '../fixtures/hardware-2026-09-12';
import { HW_PRESET_SELECT_ACK } from '../fixtures/hardware-2026-09-19';
import { TUNER_OFF } from '../protocol/frames';
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
    this.presets = this.opts.presets;
    this.device = { ...defaultMockDeviceState(), ...this.opts.initialState };
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
      const body = buildMetadataBody(this.presets, this.device);
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
    if (bytes.length === 56 && bytes[0] === 0x36 && bytes[1] === 0xc0 && bytes[2] === 0x18 && bytes[4] === 0x20 && bytes[52] === 0x1d) {
      if (this.opts.acceptedMidi !== 'c304-select') return; // other firmware: ignored
      this.device.activePreset = bytes[5]!;
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
      const sel = bytes[3]!;
      const v = bytes[5]!;
      if (sel === 0x01 && v === 0) this.device.captureOn = false; // capture bypass
      else if (sel === 0x04) this.device.captureOn = true; // capture select (enable)
      else if (sel === 0x03) this.device.cabOn = v !== 0; // cab/IR slot, 0 = bypass
      return;
    }
    this.log('warn', 'mock: unrecognised command frame ignored', toHex(bytes));
  }

  async writeMidi(bytes: Uint8Array, strategy: MidiStrategy): Promise<void> {
    if (this._status !== 'connected') throw new Error('mock: not connected');
    const payload = strategy.framing === 'ble-midi' ? Uint8Array.from([0x80, 0x80, ...bytes]) : bytes; // sequential logged as one line
    this.log('tx', `TX ${strategy.char} [${strategy.id}] (mock)`, toHex(payload));
    if (strategy.id === 'c302-raw') throw new Error('GATT operation failed for unknown reason.');
    if (strategy.id !== this.opts.acceptedMidi) return; // pedal ignores this form
    if (bytes.length === 2 && (bytes[0]! & 0xf0) === 0xc0 && bytes[1]! < 64) {
      this.device.activePreset = bytes[1]!;
      // The real pedal announces the switch with a preset-changed message.
      this.schedule(() => this.emit(buildPresetChangedEvent(this.device.activePreset)), this.opts.latencyMs);
      return;
    }
    this.log('warn', 'mock: unrecognised MIDI bytes ignored', toHex(bytes));
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
    this.emit(buildPresetChangedEvent(preset));
    this.emit(Uint8Array.from([0x06, 0xc0, 0x08, 0x01, 0x1f, 0x00, 0x00, 0x00])); // bypass-changed follows on hardware
  }

  static slotIndex(slot: FxSlot): number {
    return FX_SLOTS.indexOf(slot);
  }
}
