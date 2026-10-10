/**
 * Library folders: the user's own folders for the pedal's captures and IRs, kept in this browser (the pedal and
 * Cortex Cloud have none). Ported from the NanoGig Screen firmware's nano_ir_folders.c: a folder belongs to one list
 * (factory or user, of captures or of IRs), names are unique per list (letter case ignored), and an item sits in at
 * most one folder, remembered by its list and name (the pedal's index shifts when items are added in Cortex Cloud,
 * the name does not).
 */
import type { LibraryKind, LibraryList } from '../protocol/edit';

export interface LibraryFolder {
  id: number;
  kind: LibraryKind;
  list: LibraryList;
  name: string;
}

export interface LibraryFoldersData {
  folders: LibraryFolder[];
  /** `${kind}:${list}:${item name}` → folder id. */
  filed: Record<string, number>;
}

export const FOLDER_NAME_MAX = 24;
const KEY = 'nanogig.libraryFolders';
/** Before captures had folders: IR folders only, filed by `${list}:${IR name}`. */
const OLD_IR_KEY = 'nanogig.irFolders';

export function itemKey(kind: LibraryKind, list: LibraryList, name: string): string {
  return `${kind}:${list}:${name}`;
}

const isKind = (k: unknown): k is LibraryKind => k === 'captures' || k === 'irs';
const isList = (l: unknown): l is LibraryList => l === 'factory' || l === 'user';

export class LibraryFolders {
  private data: LibraryFoldersData;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null) {
    this.data = this.load();
  }

  private read(key: string): Partial<LibraryFoldersData> | null {
    try {
      const raw = this.storage?.getItem(key);
      return raw ? (JSON.parse(raw) as Partial<LibraryFoldersData>) : null;
    } catch {
      return null;
    }
  }

  private load(): LibraryFoldersData {
    let d = this.read(KEY);
    if (!d) {
      // IR folders from before: same folders, keys gain the kind.
      const old = this.read(OLD_IR_KEY);
      if (old) {
        d = {
          folders: (old.folders ?? []).map((f) => ({ ...f, kind: 'irs' as const })),
          filed: Object.fromEntries(Object.entries(old.filed ?? {}).map(([k, v]) => [`irs:${k}`, v])),
        };
      }
    }
    if (!d) return { folders: [], filed: {} };
    const folders = Array.isArray(d.folders)
      ? d.folders.filter((f) => typeof f?.id === 'number' && isKind(f.kind) && isList(f.list) && typeof f.name === 'string')
      : [];
    const ids = new Set(folders.map((f) => f.id));
    const filed: Record<string, number> = {};
    for (const [k, v] of Object.entries(d.filed ?? {})) if (ids.has(v)) filed[k] = v;
    return { folders, filed };
  }

  private save(): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable: kept for this session */
    }
    for (const fn of Array.from(this.listeners)) fn();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** A list's folders, by name. */
  folders(kind: LibraryKind, list: LibraryList): LibraryFolder[] {
    return this.data.folders.filter((f) => f.kind === kind && f.list === list).sort((a, b) => a.name.localeCompare(b.name));
  }

  find(id: number | null): LibraryFolder | null {
    return id === null ? null : (this.data.folders.find((f) => f.id === id) ?? null);
  }

  folderOf(kind: LibraryKind, list: LibraryList, name: string): number | null {
    return this.data.filed[itemKey(kind, list, name)] ?? null;
  }

  /** How many items are filed in a folder (those the pedal no longer has included). */
  size(id: number): number {
    let n = 0;
    for (const v of Object.values(this.data.filed)) n += v === id ? 1 : 0;
    return n;
  }

  /** Why a folder name cannot be used in a list, or null. */
  nameProblem(kind: LibraryKind, list: LibraryList, name: string, except: number | null = null): string | null {
    const n = name.trim();
    if (!n) return 'Give the folder a name';
    if (n.length > FOLDER_NAME_MAX) return `At most ${FOLDER_NAME_MAX} characters`;
    if (this.data.folders.some((f) => f.kind === kind && f.list === list && f.id !== except && f.name.toLowerCase() === n.toLowerCase())) return 'A folder has this name already';
    return null;
  }

  create(kind: LibraryKind, list: LibraryList, name: string): LibraryFolder {
    const problem = this.nameProblem(kind, list, name);
    if (problem) throw new Error(problem);
    const id = this.data.folders.reduce((m, f) => Math.max(m, f.id), 0) + 1;
    const folder = { id, kind, list, name: name.trim() };
    this.data.folders.push(folder);
    this.save();
    return folder;
  }

  rename(id: number, name: string): void {
    const f = this.find(id);
    if (!f) return;
    const problem = this.nameProblem(f.kind, f.list, name, id);
    if (problem) throw new Error(problem);
    f.name = name.trim();
    this.save();
  }

  /** The folder goes; its items go back to the top of the list. */
  remove(id: number): void {
    this.data.folders = this.data.folders.filter((f) => f.id !== id);
    for (const [k, v] of Object.entries(this.data.filed)) if (v === id) delete this.data.filed[k];
    this.save();
  }

  /** File an item into a folder of its own list (null = the top of the list). */
  file(kind: LibraryKind, list: LibraryList, name: string, folder: number | null): void {
    const key = itemKey(kind, list, name);
    if (folder === null) delete this.data.filed[key];
    else if (this.data.folders.some((f) => f.id === folder && f.kind === kind && f.list === list)) this.data.filed[key] = folder;
    else return;
    this.save();
  }
}
