import { describe, expect, it } from 'vitest';
import { fxDef } from '../src/protocol/edit';
import { FX_DEFAULTS, fxDefaults, learnFxDefaults } from '../src/protocol/fx-defaults';
import { FX_SLOT_MODELS } from '../src/protocol/fx-params';

describe('FX defaults (read on the pedal, 2026-10-17)', () => {
  it('every model has its defaults, one per parameter, 0..1', () => {
    for (const type of new Set(FX_SLOT_MODELS.flat())) {
      const def = fxDef(type)!;
      expect(FX_DEFAULTS[type], def.name).toHaveLength(def.params.length);
      for (const v of FX_DEFAULTS[type]!) expect(v >= 0 && v <= 1, def.name).toBe(true);
      expect(fxDefaults(type)).toBe(FX_DEFAULTS[type]);
    }
  });

  it('as the pedal shows them: Chief BD2 at 5.0, Doubler at 6 ms / 0 dB', () => {
    expect(FX_DEFAULTS[18]).toEqual([0.5, 0.5, 0.5]);
    const doubler = fxDef(16011)!;
    const [spread, dry] = FX_DEFAULTS[16011]!;
    const at = (i: number, n: number) => {
      const p = doubler.params[i]!;
      return p.kind === 'range' ? p.min + n * (p.max - p.min) : NaN;
    };
    expect(at(0, spread!)).toBeCloseTo(6, 1);
    expect(at(1, dry!)).toBeCloseTo(0, 1);
  });

  it('learned values are cut to the table, and too few are refused', () => {
    expect(learnFxDefaults(16011, [0.1, 0.2])).toBe(false);
    expect(learnFxDefaults(16011, [0.1, 0.2, 0.3, 0])).toBe(true);
    expect(fxDefaults(16011)).toBe(FX_DEFAULTS[16011]); // the built-in table comes first
  });
});
