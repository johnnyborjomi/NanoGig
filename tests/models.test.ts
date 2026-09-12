import { describe, expect, it } from 'vitest';
import { FX_MODELS, lookupFxModel } from '../src/protocol/models';
import { decodeCurrentState } from '../src/protocol/decode';
import { REAL_STATE_DUMP_PACKET } from '../src/fixtures/captures';
import { HW_STATE_SEGMENTED, HW_STATE_SINGLE } from '../src/fixtures/hardware-2026-09-12';
import { splitTrailer } from '../src/protocol/reassembly';
import { concatBytes } from '../src/protocol/hex';

describe('FX model catalogue', () => {
  it('has the web editor catalogue and resolves every hardware-observed ID', () => {
    // 56 catalogue rows; the three EQ models appear under both Utility and Utility/EQ → 53 unique IDs.
    expect(FX_MODELS.size).toBe(53);
    const names = (ids: (string | null)[]) => ids.map((id) => lookupFxModel(id)?.name ?? null);
    const ref = decodeCurrentState(REAL_STATE_DUMP_PACKET.subarray(2))!;
    expect(names(Object.values(ref.fxModelIds))).toEqual(['Transpose', 'Green 808', 'Chief DC2W (ST)', 'Analog Delay', 'Mind Hall']);
    const single = decodeCurrentState(splitTrailer(HW_STATE_SINGLE.subarray(2)).payload)!;
    expect(names(Object.values(single.fxModelIds))).toEqual(['Exotic Z Boost', 'Legendary 87 (M)', 'Doubler', 'Analog Delay', 'Mind Hall']);
    const body = concatBytes([HW_STATE_SEGMENTED[0]!.subarray(2), HW_STATE_SEGMENTED[1]!.subarray(2)]);
    const seg = decodeCurrentState(splitTrailer(body).payload)!;
    expect(names(Object.values(seg.fxModelIds))).toEqual(['Transpose', 'Green 808', 'Doubler', 'Analog Delay', 'Ambience']);
  });
  it('carries categories and marks unknown IDs without throwing', () => {
    expect(lookupFxModel('CB3E')).toEqual({ id: 'CB3E', known: true, name: 'Mind Hall', category: 'Reverb' });
    expect(lookupFxModel('cb3e')?.name).toBe('Mind Hall');
    expect(lookupFxModel('ZZ99')).toMatchObject({ known: false, name: 'ID ZZ99' });
    expect(lookupFxModel(null)).toBeNull();
    expect(lookupFxModel('')).toBeNull();
  });
});
