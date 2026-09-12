/**
 * Web MIDI output to the Nano Cortex, the preset-switching path used by
 * choldy/nano-cortex-web-editor (`connectMIDI` / `selectPreset`, MIT).
 *
 * Works with the pedal connected over USB: macOS exposes a MIDI port named
 * "Nano Cortex" and a Program Change on it switches presets (confirmed on
 * hardware 2026-09-12, matching the rixrix USB findings). The pedal does not
 * advertise the standard Bluetooth-MIDI service, so there is no OS-level
 * Bluetooth MIDI pairing to use. Not available in Bluefy / iPad.
 *
 * Program Changes written to the proprietary c302/c303 characteristics (raw
 * or BLE-MIDI framed) do not switch presets, so this is the only verified path.
 */
import { looksLikeNano } from '../protocol/uuids';

export interface MidiOut {
  readonly id: string;
  /** Human name of the selected output, once opened. */
  readonly portName: string | null;
  isSupported(): boolean;
  /** Request access and pick the Nano Cortex output. Throws with a helpful message if none. */
  open(): Promise<void>;
  send(bytes: Uint8Array): Promise<void>;
}

export class WebMidiOut implements MidiOut {
  readonly id = 'web-midi';
  private access: MIDIAccess | null = null;
  private output: MIDIOutput | null = null;

  get portName(): string | null {
    return this.output?.name ?? null;
  }

  isSupported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  }

  async open(): Promise<void> {
    if (!this.isSupported()) throw new Error('Web MIDI is not available in this browser');
    if (!this.access) this.access = await navigator.requestMIDIAccess({ sysex: false });
    const outputs = Array.from(this.access.outputs.values());
    const nano = outputs.find((o) => looksLikeNano(o.name)) ?? null;
    if (!nano) {
      const names = outputs.map((o) => o.name ?? '?').join(', ') || 'none';
      throw new Error(`No Nano Cortex MIDI output (outputs: ${names}). Connect the pedal over USB for preset switching.`);
    }
    if (nano.connection !== 'open') await nano.open();
    this.output = nano;
  }

  async send(bytes: Uint8Array): Promise<void> {
    if (!this.output) await this.open();
    this.output!.send(Array.from(bytes));
  }
}
