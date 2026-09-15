import { describe, expect, it } from 'vitest';
import { decodeMetadata } from '../src/protocol/decode';
import { buildMetadataBody, DEMO_PRESETS } from '../src/fixtures/captures';
import { METADATA_CACHE_VERSION, StorageMetadataCache, metadataFingerprint, metadataFromEnvelope, metadataToEnvelope } from '../src/sync/metadata-cache';

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
}

const body = buildMetadataBody(DEMO_PRESETS);
const md = decodeMetadata(body.subarray(0, body.length - 4));

describe('metadata cache', () => {
  it('round-trips names, captures and IRs through the envelope', () => {
    const back = metadataFromEnvelope(JSON.parse(JSON.stringify(metadataToEnvelope(md))))!;
    expect(back.presets.map((p) => p.name)).toEqual(md.presets.map((p) => p.name));
    expect(back.captures).toEqual(md.captures);
    expect(back.irs).toEqual(md.irs);
    expect(back.presetRecordCount).toBe(md.presetRecordCount);
    expect(metadataFingerprint(back)).toBe(metadataFingerprint(md));
  });

  it('rejects other versions, wrong shapes and garbage', () => {
    expect(metadataFromEnvelope(null)).toBeNull();
    expect(metadataFromEnvelope('x')).toBeNull();
    expect(metadataFromEnvelope({ ...metadataToEnvelope(md), v: METADATA_CACHE_VERSION + 1 })).toBeNull();
    expect(metadataFromEnvelope({ ...metadataToEnvelope(md), presets: md.presets.slice(0, 10) })).toBeNull();
    expect(metadataFromEnvelope({ ...metadataToEnvelope(md), captures: 'nope' })).toBeNull();
  });

  it('StorageMetadataCache saves, loads, and drops an unreadable entry', () => {
    const storage = memStorage();
    const cache = new StorageMetadataCache(storage, 'k');
    expect(cache.load()).toBeNull();
    cache.save(md);
    expect(storage.map.has('k')).toBe(true);
    expect(cache.load()?.presets[7]?.name).toBe('Clean Chief');
    storage.setItem('k', '{not json');
    expect(cache.load()).toBeNull();
    storage.setItem('k', JSON.stringify({ v: 99 }));
    expect(cache.load()).toBeNull();
    expect(storage.map.has('k')).toBe(false); // stale version removed
  });
});
