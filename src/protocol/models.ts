/**
 * FX model catalogue: current-state field 48-52 model ID (raw value bytes as
 * uppercase hex, no spaces) → model name and category.
 *
 * Adapted from choldy/nano-cortex-web-editor's `deviceModels` table (MIT),
 * which was verified against BLE captures of the official Cortex Cloud app.
 * Matching rule (`findModelByCurrentStateID`): exact hex of the field's raw
 * bytes. Every ID observed on hardware 2026-09-12 resolves (Transpose, Green
 * 808, Chief DC2W, Analog Delay, Mind Hall, Exotic Z Boost, Legendary 87,
 * Doubler, Ambience). The three EQ models are listed under both Utility and
 * Utility/EQ upstream; the later (Utility/EQ) entry wins here. Provisional like
 * everything else here.
 */
import type { FxSlot } from './frames';

export type FxCategory =
  | 'Compressor'
  | 'Delay'
  | 'Modulation'
  | 'Overdrive'
  | 'Pitch'
  | 'Reverb'
  | 'Utility'
  | 'Utility/EQ'
  | 'Wah/Filter';

export interface FxModel {
  name: string;
  category: FxCategory;
}

export const FX_MODELS: ReadonlyMap<string, FxModel> = new Map<string, FxModel>([
  ['12', { name: "Chief BD2", category: "Overdrive" }],
  ['0D', { name: "Chief OD1", category: "Overdrive" }],
  ['06', { name: "Exotic", category: "Overdrive" }],
  ['BF17', { name: "Exotic Bass Z Boost", category: "Overdrive" }],
  ['17', { name: "Exotic Z Boost", category: "Overdrive" }],
  ['16', { name: "Facial Fuzz", category: "Overdrive" }],
  ['1B', { name: "Green 808", category: "Overdrive" }],
  ['B817', { name: "Microtubes B3K", category: "Overdrive" }],
  ['03', { name: "OD250", category: "Overdrive" }],
  ['02', { name: "Obsessive Drive", category: "Overdrive" }],
  ['04', { name: "Rodent Drive", category: "Overdrive" }],
  ['817D', { name: "Adaptive Gate", category: "Utility" }],
  ['A51F', { name: "Graphic 9", category: "Utility" }],
  ['A31F', { name: "Low-High Cut", category: "Utility" }],
  ['A11F', { name: "Parametric 3", category: "Utility" }],
  ['827D', { name: "Utility Gate", category: "Utility" }],
  ['867D', { name: "Volume", category: "Utility" }],
  ['B446', { name: "Bass Wah", category: "Wah/Filter" }],
  ['B246', { name: "Bubba Wah", category: "Wah/Filter" }],
  ['B646', { name: "Crying Clyde Wah", category: "Wah/Filter" }],
  ['B546', { name: "Crying Wah", category: "Wah/Filter" }],
  ['C6BB01', { name: "Envelope Filter", category: "Wah/Filter" }],
  ['C1BB01', { name: "Love Meat", category: "Wah/Filter" }],
  ['8927', { name: "Legendary 87 (M)", category: "Compressor" }],
  ['8F27', { name: "Opto Comp (M)", category: "Compressor" }],
  ['8C27', { name: "Solid State Comp (M)", category: "Compressor" }],
  ['8D27', { name: "VCA Comp (M)", category: "Compressor" }],
  ['D18C01', { name: "Transpose", category: "Pitch" }],
  ['8B7D', { name: "Doubler", category: "Utility/EQ" }],
  ['A51F', { name: "Graphic 9", category: "Utility/EQ" }],
  ['A31F', { name: "Low-High Cut", category: "Utility/EQ" }],
  ['A11F', { name: "Parametric 3", category: "Utility/EQ" }],
  ['9427', { name: "Legendary 87 (ST)", category: "Utility/EQ" }],
  ['9727', { name: "Opto Comp (ST)", category: "Utility/EQ" }],
  ['9527', { name: "Solid State Comp (ST)", category: "Utility/EQ" }],
  ['9627', { name: "VCA Comp (ST)", category: "Utility/EQ" }],
  ['F036', { name: "Chief CE2W (ST)", category: "Modulation" }],
  ['F336', { name: "Chief DC2W (ST)", category: "Modulation" }],
  ['EF36', { name: "Chorus 229T", category: "Modulation" }],
  ['EE36', { name: "Dream Chorus", category: "Modulation" }],
  ['ED36', { name: "MX Flanger", category: "Modulation" }],
  ['F436', { name: "MX Phase 95", category: "Modulation" }],
  ['F536', { name: "MX Vibe", category: "Modulation" }],
  ['DC36', { name: "Tremolo", category: "Modulation" }],
  ['FA2E', { name: "Analog Delay", category: "Delay" }],
  ['FF2E', { name: "Circular Delay", category: "Delay" }],
  ['FB2E', { name: "Digital Delay (ST)", category: "Delay" }],
  ['FC2E', { name: "Dual Delay", category: "Delay" }],
  ['FE2E', { name: "Dual Reverse Delay", category: "Delay" }],
  ['F42E', { name: "Tape Delay", category: "Delay" }],
  ['C83E', { name: "Ambience", category: "Reverb" }],
  ['C93E', { name: "Cave", category: "Reverb" }],
  ['C33E', { name: "Hall", category: "Reverb" }],
  ['CB3E', { name: "Mind Hall", category: "Reverb" }],
  ['C73E', { name: "Modulated", category: "Reverb" }],
  ['C03E', { name: "Room", category: "Reverb" }],
]);

export interface FxModelInfo extends FxModel {
  /** Raw ID hex from the dump. */
  id: string;
  /** False when the ID is not in the catalogue (name then shows the hex). */
  known: boolean;
}

/** Resolve a dump model ID; null when the slot carries no model. */
export function lookupFxModel(idHex: string | null | undefined): FxModelInfo | null {
  if (!idHex) return null;
  const clean = idHex.toUpperCase();
  const hit = FX_MODELS.get(clean);
  if (hit) return { id: clean, known: true, ...hit };
  return { id: clean, known: false, name: `ID ${clean}`, category: 'Utility' };
}

export type FxModelsBySlot = Record<FxSlot, FxModelInfo | null>;
