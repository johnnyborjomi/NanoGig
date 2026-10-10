/**
 * IR folders: the user's own folders in the IR library, kept in this browser (the pedal has none). Ported from the
 * NanoGig Screen firmware's nano_ir_folders.c: a folder belongs to one list (factory or user IRs), names are unique
 * per list (case-insensitive, 1..24 characters), and an IR is filed by its list and name.
 */
import type { LibraryList } from '../protocol/edit';

export interface IrFolder {
  id: number;
  list: LibraryList;
  name: string;
}

export interface IrFoldersData {
  folders: IrFolder[];
  /** `${list}:${IR name}` → folder id. */
  filed: Record<string, number>;
}

export const IR_FOLDER_NAME_MAX = 24;
const KEY = 'nanogig.irFolders';

export function irKey(list: LibraryList, name: string): string {
  return `${list}:${name}`;
}

export class IrFolders {
  private data: IrFoldersData;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null) {
    this.data = this.load();
  }

  private load(): IrFoldersData {
    try {
      const raw = this.storage?.getItem(KEY);
      if (!raw) return { folders: [], filed: {} };
      const d = JSON.parse(raw) as IrFoldersData;
      const folders = Array.isArray(d.folders)
        ? d.folders.filter((f) => typeof f.id === 'number' && (f.list === 'factory' || f.list === 'user') && typeof f.name === 'string')
        : [];
      const ids = new Set(folders.map((f) => f.id));
      const filed: Record<string, number> = {};
      for (const [k, v] of Object.entries(d.filed ?? {})) if (ids.has(v)) filed[k] = v;
      return { folders, filed };
    } catch {
      return { folders: [], filed: {} };
    }
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

  folders(list: LibraryList): IrFolder[] {
    return this.data.folders.filter((f) => f.list === list).sort((a, b) => a.name.localeCompare(b.name));
  }

  folderOf(list: LibraryList, irName: string): number | null {
    return this.data.filed[irKey(list, irName)] ?? null;
  }

  /** Why a folder name cannot be used in `list`, or null. */
  nameProblem(list: LibraryList, name: string, except: number | null = null): string | null {
    const n = name.trim();
    if (!n) return 'Give the folder a name';
    if (n.length > IR_FOLDER_NAME_MAX) return `At most ${IR_FOLDER_NAME_MAX} characters`;
    if (this.data.folders.some((f) => f.list === list && f.id !== except && f.name.toLowerCase() === n.toLowerCase())) return 'A folder has this name already';
    return null;
  }

  create(list: LibraryList, name: string): IrFolder {
    const problem = this.nameProblem(list, name);
    if (problem) throw new Error(problem);
    const id = this.data.folders.reduce((m, f) => Math.max(m, f.id), 0) + 1;
    const folder = { id, list, name: name.trim() };
    this.data.folders.push(folder);
    this.save();
    return folder;
  }

  rename(id: number, name: string): void {
    const f = this.data.folders.find((x) => x.id === id);
    if (!f) return;
    const problem = this.nameProblem(f.list, name, id);
    if (problem) throw new Error(problem);
    f.name = name.trim();
    this.save();
  }

  /** The folder goes; its IRs go back to the list. */
  remove(id: number): void {
    this.data.folders = this.data.folders.filter((f) => f.id !== id);
    for (const [k, v] of Object.entries(this.data.filed)) if (v === id) delete this.data.filed[k];
    this.save();
  }

  /** File an IR into a folder (null = out of every folder). */
  file(list: LibraryList, irName: string, folder: number | null): void {
    const key = irKey(list, irName);
    if (folder === null) delete this.data.filed[key];
    else if (this.data.folders.some((f) => f.id === folder && f.list === list)) this.data.filed[key] = folder;
    else return;
    this.save();
  }
}
