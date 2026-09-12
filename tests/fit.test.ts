import { describe, expect, it } from 'vitest';
import { REFERENCE_PX, ROW_LAYOUT, fitPresetRowFont } from '../src/ui/fit';

describe('fitPresetRowFont', () => {
  it('returns the largest size at which label + gaps + name fit the width', () => {
    // At 100 px: label 150 px, name 900 px (×0.8 = 720), gaps 60, slack 15 → 945 px per 100 px of font.
    const px = fitPresetRowFont({ availableWidth: 945, labelWidthRef: 150, nameWidthRef: 900, maxPx: 400 });
    expect(px).toBe(100);
    expect(fitPresetRowFont({ availableWidth: 1890, labelWidthRef: 150, nameWidthRef: 900, maxPx: 400 })).toBe(200);
  });
  it('is capped by the height bound and floored by the minimum', () => {
    expect(fitPresetRowFont({ availableWidth: 10000, labelWidthRef: 150, nameWidthRef: 900, maxPx: 120 })).toBe(120);
    expect(fitPresetRowFont({ availableWidth: 50, labelWidthRef: 150, nameWidthRef: 900, maxPx: 120 })).toBe(24);
    expect(fitPresetRowFont({ availableWidth: 50, labelWidthRef: 150, nameWidthRef: 900, maxPx: 120, minPx: 10 })).toBe(10);
  });
  it('falls back to the max when nothing measurable is provided', () => {
    expect(fitPresetRowFont({ availableWidth: 0, labelWidthRef: 0, nameWidthRef: 0, maxPx: 96 })).toBe(96);
  });
  it('uses the multipliers mirrored from the stylesheet', () => {
    expect(REFERENCE_PX).toBe(100);
    expect(ROW_LAYOUT.nameScale).toBe(0.8);
  });
});
