/**
 * Each FX model's default parameters: what the pedal loads with the model (0..1 per parameter, the model's order in
 * `fx-params.ts`), for the editor's double tap. No reference project has them; they are read from the pedal: a
 * model written into a slot comes with its defaults, and a read right after gives them.
 *
 * `FX_DEFAULTS` is the table read on the user's pedal (Log → "Read every effect's defaults"); models missing from
 * it are learned on each device as models are changed in the app, kept in localStorage.
 */

import { fxDef } from './edit';

/** Read on the user's pedal (NanOS 2.2.1, 2026-10-17) with the defaults run; Doubler's from its fourth value on is dropped (one more than its table). */
export const FX_DEFAULTS: Readonly<Record<number, readonly number[]>> = {
  2: [0.5, 0, 0.5, 0.5], // Obsessive Drive
  3: [0.5, 0.5], // OD250
  4: [0.5, 0.5, 0.5], // Rodent Drive
  6: [0.5, 0.5, 0.5, 0.5], // Exotic
  13: [0.5, 0.5], // Chief OD1
  18: [0.5, 0.5, 0.5], // Chief BD2
  22: [1, 1, 1, 1], // Facial Fuzz
  23: [0.5, 0.5, 0.5, 0.5], // Exotic Z Boost
  27: [0.5, 0.5, 0.5], // Green 808
  3000: [0.5, 0, 0, 0.5, 0.5, 0.5], // Microtubes B3K
  3007: [0.5, 0.5, 0.5, 0.5], // Exotic Bass Z Boost
  4001: [0.5, 0.2071, 0.06131, 1, 1, 0.5, 0.40475, 0.06131, 0, 1, 0.5, 0.61629, 0.06131, 0.75, 1, 0.5], // Parametric 3
  4003: [0.25, 0, 0.25, 0.93518, 0.5], // Low-High Cut
  4005: [0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 0.5], // Graphic 9
  5001: [0.6875, 0.5, 1, 0.94138, 0.54167, 1], // Legendary 87 (M)
  5004: [0.16667, 1, 0.33784, 0.5872, 0.64583, 1], // Solid State Comp (M)
  5005: [0.27778, 0.43528, 0.14672, 0.4898, 0.58333, 1], // VCA Comp (M)
  5007: [0.27778, 0.26758, 0.17781, 0.4898, 0.58333, 1], // Opto Comp (M)
  5012: [0.6875, 0.5, 1, 0.94138, 0.54167, 1], // Legendary 87 (ST)
  5013: [0.16667, 1, 0.33784, 0.5872, 0.64583, 1], // Solid State Comp (ST)
  5014: [0.27778, 0.43528, 0.14672, 0.4898, 0.58333, 1], // VCA Comp (ST)
  5015: [0.27778, 0.26758, 0.17781, 0.4898, 0.58333, 1], // Opto Comp (ST)
  6004: [0.5, 0.25, 0.17654, 0.59683, 0, 0.22342, 0.25, 0.25, 0.5, 1, 0.65], // Tape Delay
  6010: [0.35, 0.25, 0.29157, 0.29851, 0, 0.51728, 0.14583, 0.1, 0.6, 0.5, 1, 0.5], // Analog Delay
  6011: [0.5, 0.25, 0.29157, 0.29851, 0, 0.22342, 0.14583, 0.4, 0.6, 0.34128, 0, 0.74545, 0.25051, 0.43488, 0.15789, 0.8, 1, 0.65], // Digital Delay (ST)
  6012: [0.5, 0.22342, 0.25, 0, 0.27406, 0.25, 0.29157, 0.29851, 0.14583, 0.4, 0, 0.34128, 0, 0.74545, 0.25051, 0.43488, 0.15789, 0.8, 1, 0.65, 1, 0.7], // Dual Delay
  6014: [0.5, 0.28107, 0.25, 0, 0, 0.3464, 0.25, 0.2, 0.4, 0.34128, 0, 0.74545, 0.25051, 0.43488, 0.15789, 0.8, 0.2146, 0.86777, 0, 1, 0.75, 0.8], // Dual Reverse Delay
  6015: [0.5, 0.25, 0.43639, 0.31579, 0.42, 0, 1, 0.40475, 0, 0, 1, 0.75], // Circular Delay
  7004: [0.43133, 0.5, 0, 0.5, 0, 0, 1, 0.38055, 0.38055, 0, 0, 0.5625], // Tremolo
  7021: [1, 0.5, 0.5, 0.5, 0.5, 0.5, 0, 0.46154], // MX Flanger
  7022: [1, 0.5, 0.5, 0, 0.5, 0, 0.46154], // Dream Chorus
  7023: [1, 0.4432, 0.3, 0, 0.5, 0, 0.3], // Chorus 229T
  7024: [1, 0.5, 0.5, 0, 0, 0.5, 0, 0.46154], // Chief CE2W (ST)
  7027: [1, 0, 0, 0, 0.5], // Chief DC2W (ST)
  7028: [1, 0.5, 0, 0, 0.5, 0, 0.5625], // MX Phase 95
  7029: [1, 0, 0.5, 0.5, 0.5, 0.5, 0, 0.46154], // MX Vibe
  8000: [0.63869, 0.24983, 0.2146, 0.63106, 0.35], // Room
  8003: [0.51728, 0.37142, 0.2146, 0.63106, 0.35], // Hall
  8007: [0.51728, 0.24431, 0.40805, 0.4, 0.2146, 0.63106, 0.35], // Modulated
  8008: [0.5, 0.16572, 0.2146, 0.63106, 0.35], // Ambience
  8009: [0.38073, 0.57447, 0.5, 0.2146, 0.82263, 0.35], // Cave
  8011: [0.35, 0.7, 0.5445, 0.48038, 0.45316, 0.5], // Mind Hall
  9010: [0.5], // Bubba Wah
  9012: [0.5], // Bass Wah
  9013: [0.5], // Crying Wah
  9014: [0.5], // Crying Clyde Wah
  16001: [0.3], // Adaptive Gate
  16002: [0.26758, 0.01046, 0.03909, 0.05353, 0], // Utility Gate
  16006: [1, 1], // Volume
  16011: [0.05263, 0.76923, 0.76923], // Doubler
  18001: [1, 0.5, 0.5, 0, 1], // Transpose
  24001: [1, 0.16, 0.4, 1, 1, 1, 1, 0.5, 0.66667, 0, 0.5], // Love Meat
  24006: [0.37037, 0.0101, 0.24242, 0.5, 0.6019, 0.17514, 0.675, 0.92738, 1], // Envelope Filter
};

const KEY = 'nanogig.fxDefaults';
let learned: Record<number, number[]> | null = null;

function stored(): Record<number, number[]> {
  if (learned) return learned;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    learned = raw && typeof raw === 'object' ? (raw as Record<number, number[]>) : {};
  } catch {
    learned = {};
  }
  return learned;
}

/** The model's defaults, or null while not known. */
export function fxDefaults(type: number): readonly number[] | null {
  const n = fxDef(type)?.params.length;
  const v = FX_DEFAULTS[type] ?? stored()[type] ?? null;
  return v && v.length === n ? v : null;
}

/**
 * Keep what the pedal loaded with a model; false when the values do not fit the model's table. More values than the
 * table has are cut to it (Doubler answers 4 for its 3).
 */
export function learnFxDefaults(type: number, values: readonly number[]): boolean {
  const def = fxDef(type);
  const n = def?.params.length ?? 0;
  if (!def || values.length < n || values.slice(0, n).some((v) => !Number.isFinite(v))) return false;
  const all = stored();
  all[type] = values.slice(0, n).map((v) => Math.round(v * 1e5) / 1e5);
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Private mode and the like: kept for this session only.
  }
  return true;
}
