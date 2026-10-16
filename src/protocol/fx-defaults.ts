/**
 * Each FX model's default parameters: what the pedal loads with the model (0..1 per parameter, the model's order in
 * `fx-params.ts`), for the editor's double tap. No reference project has them; they are read from the pedal: a
 * model written into a slot comes with its defaults, and a read right after gives them.
 *
 * `FX_DEFAULTS` is the table read on the user's pedal (Log → "Read every effect's defaults"); models missing from
 * it are learned on each device as models are changed in the app, kept in localStorage.
 */

import { fxDef } from './edit';

export const FX_DEFAULTS: Readonly<Record<number, readonly number[]>> = {};

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

/** Keep what the pedal loaded with a model; false when the values do not fit the model's table. */
export function learnFxDefaults(type: number, values: readonly number[]): boolean {
  const def = fxDef(type);
  if (!def || values.length !== def.params.length || values.some((v) => !Number.isFinite(v))) return false;
  const all = stored();
  all[type] = values.map((v) => Math.round(v * 1e5) / 1e5);
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Private mode and the like: kept for this session only.
  }
  return true;
}
