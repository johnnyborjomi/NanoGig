/**
 * Persistent cache of the pedal's metadata (preset / capture / IR names), so a connect can
 * show names at once and only refresh them in the background. The metadata dump streams
 * ~17 KB over ~6 s and its content rarely changes, so waiting for it on every link was the
 * bulk of the startup delay.
 *
 * Storage is localStorage (survives app kills, unlike sessionStorage), one entry per
 * transport so demo-mode names never leak onto the real pedal's screen.
 */
import { PRESET_COUNT } from '../protocol/frames';
import { PROVISIONAL, type Metadata } from '../protocol/decode';

export interface MetadataCache {
  load(): Metadata | null;
  save(md: Metadata): void;
}

export const METADATA_CACHE_VERSION = 1;

interface Envelope {
  v: number;
  savedAt: number;
  presets: Metadata['presets'];
  captures: Metadata['captures'];
  irs: Metadata['irs'];
  presetRecordCount: number;
}

const str = (v: unknown): v is string => typeof v === 'string';

/** Validate a parsed envelope; null for anything not written by this version. */
export function metadataFromEnvelope(raw: unknown): Metadata | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Partial<Envelope>;
  if (e.v !== METADATA_CACHE_VERSION) return null;
  if (!Array.isArray(e.presets) || e.presets.length !== PRESET_COUNT) return null;
  if (!Array.isArray(e.captures) || !Array.isArray(e.irs)) return null;
  const presets = e.presets.map((p) => ({
    name: str(p?.name) ? p.name : '',
    captureName: str(p?.captureName) ? p.captureName : '',
    captureId: str(p?.captureId) ? p.captureId : '',
    irShortName: str(p?.irShortName) ? p.irShortName : '',
    irFullName: str(p?.irFullName) ? p.irFullName : '',
  }));
  const captures = e.captures.filter((c) => c && str(c.id) && str(c.name)).map((c) => ({ id: c.id, name: c.name }));
  const irs = e.irs.filter((r) => r && str(r.shortName) && str(r.fullName)).map((r) => ({ shortName: r.shortName, fullName: r.fullName }));
  const presetRecordCount = typeof e.presetRecordCount === 'number' ? e.presetRecordCount : presets.filter((p) => p.name).length;
  return { presets, captures, irs, presetRecordCount, provisional: PROVISIONAL };
}

export function metadataToEnvelope(md: Metadata, now = Date.now()): Envelope {
  return { v: METADATA_CACHE_VERSION, savedAt: now, presets: md.presets, captures: md.captures, irs: md.irs, presetRecordCount: md.presetRecordCount };
}

/** Content key used to skip rewrites and to notice a changed pedal. */
export function metadataFingerprint(md: Metadata): string {
  return JSON.stringify([md.presets, md.captures, md.irs]);
}

/** A cache backed by any Storage (localStorage in the app, an in-memory stub in tests). */
export class StorageMetadataCache implements MetadataCache {
  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    private readonly key: string,
  ) {}

  load(): Metadata | null {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return null;
      const md = metadataFromEnvelope(JSON.parse(raw));
      if (!md) this.storage.removeItem(this.key);
      return md;
    } catch {
      return null;
    }
  }

  save(md: Metadata): void {
    try {
      this.storage.setItem(this.key, JSON.stringify(metadataToEnvelope(md)));
    } catch {
      /* storage full or unavailable: the next connect just streams the dump again */
    }
  }
}

/** localStorage cache for a transport, or null where storage is unavailable. */
export function localMetadataCache(transportName: string): MetadataCache | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return new StorageMetadataCache(localStorage, `nanogig.metadata.${transportName}`);
  } catch {
    return null;
  }
}
