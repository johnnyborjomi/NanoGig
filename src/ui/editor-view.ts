/**
 * Edit sheets over the gig view (the top bar's Edit button: control mode plus these). Ported from the NanoGig Screen
 * firmware's pages, laid out for a bigger screen: one scrolling sheet per thing instead of paged screens.
 *
 *   FX sheet        hold an FX tile: model (every model the slot takes) and parameters
 *   Amp & cab sheet tap the capture / IR name: capture slot, on / off, volume; IR slot, on / off, level,
 *                   high / low pass, phase, microphone and position; both with the pedal's library
 *   Gate sheet      hold the gate: on / off and threshold
 *   Preset sheet    hold the preset name (or a preset in the list): rename, name an empty slot, footswitch, delete
 *   Presets list    Menu → Presets: all 64, tap to switch (control mode), ⋯ to manage
 *
 * Sliders write live while they move (the controller coalesces); a value the user is dragging is never
 * overwritten by a render.
 */
import {
  CAB_POSITIONS,
  CAB_OWN_SLOT,
  CAPTURE_BANKS,
  CAPTURE_OWN_SLOT,
  CAPTURE_SELECT_SLOTS,
  CAPTURE_VOLUME_DEFAULT_RAW,
  FOOTSWITCHES,
  PRESET_NAME_WRITE_MAX,
  cabValueText,
  captureVolumeText,
  fxDef,
  fxParamText,
  fxParamsInOrder,
  fxSlotModels,
  fxEnumValue,
  type CabParam,
  type Footswitch,
  type LibraryItem,
  type LibraryKind,
  type LibraryList,
} from "../protocol/edit";
import { CAB_SLOT_COUNT, labelHasBanks, PRESET_COUNT, presetLabel, type FxSlot } from "../protocol/frames";
import { lookupFxModel } from "../protocol/models";
import type { GigState, Store } from "../state/store";
import type { EditController } from "../sync/editor";
import { FOLDER_NAME_MAX, LibraryFolders, type LibraryFolder } from "./library-folders";
import { onHold } from "./hold";
import { presetLabelEls, renderPresetLabel, type PresetLabelEls } from "./preset-label";
import {
  ArrowDownAZ,
  ArrowDownZA,
  ArrowLeftRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CornerLeftUp,
  Ellipsis,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Library,
  Pencil,
  Plus,
  Power,
  Save,
  Search,
  Square,
  SquareCheck,
  Trash2,
  Undo2,
  Volume2,
  X,
  createElement as lucideElement,
} from "lucide";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

type LibrarySort = "off" | "az" | "za";
const LIBRARY_SORT_KEY = "nanogig.librarySort";

function readLibrarySort(): LibrarySort {
  try {
    const v = localStorage.getItem(LIBRARY_SORT_KEY);
    return v === "az" || v === "za" ? v : "off";
  } catch {
    return "off";
  }
}

function writeLibrarySort(v: LibrarySort) {
  try {
    localStorage.setItem(LIBRARY_SORT_KEY, v);
  } catch {
    /* private window: the order is just not remembered */
  }
}

/** The letter a name is grouped under in a sorted list: its first letter (accents dropped), else "#". */
function sortLetter(name: string): string {
  const c = name.trim().charAt(0).normalize("NFD").charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : "#";
}

function icon(i: Parameters<typeof lucideElement>[0], label?: string): SVGElement {
  const svg = lucideElement(i, { "stroke-width": 2.25, "aria-hidden": "true" }) as SVGElement;
  if (label) svg.setAttribute("aria-label", label);
  return svg;
}

/** A sheet's Discard (left of its close button): shown while its block differs from the preset as saved. */
function discardButton(onClick: () => void): HTMLButtonElement {
  const b = el("button", "ghost ed-discard");
  b.type = "button";
  b.dataset.shown = "false";
  b.append(icon(Undo2), el("span", "", "Discard"));
  b.addEventListener("click", onClick);
  return b;
}

function iconButton(i: Parameters<typeof lucideElement>[0], label: string, className = "ghost icon-btn"): HTMLButtonElement {
  const b = el("button", className);
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.append(icon(i));
  return b;
}

const SLOT_LABELS: Record<FxSlot, string> = { pre1: "PRE 1", pre2: "PRE 2", post1: "POST 1", post2: "POST 2", post3: "POST 3" };
const CAB_LABELS: Record<CabParam, string> = { level: "Level", highPass: "High pass", lowPass: "Low pass" };
/** Drag data type for a library item dragged onto a folder (desktop). */
const DRAG_TYPE = "application/x-nanogig-library-item";
/** A mouse or trackpad: items can be dragged as well as held. */
const HAS_HOVER = typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;
const slug = (category: string) => category.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** A message line that is always in the layout (never hidden): only its text and tone change. */
function setMsg(node: HTMLElement, text: string, tone: "muted" | "warn" | "ok" = "muted") {
  node.textContent = text;
  node.title = text;
  node.dataset.tone = tone;
  // Something under way ("Reading…", "Waiting for the pedal…"): a small spinner in front of the text.
  node.dataset.busy = String(text.endsWith("…"));
}

/** Where a library item sits ("Bank 2 · Slot 3"): the numbers stand out, the words are greyed. */
function slotTag(label: string): HTMLElement {
  const tag = el("span", "ed-item-slot");
  for (const part of label.split(/(\d+)/)) {
    if (part) tag.append(/^\d+$/.test(part) ? el("b", "", part) : part);
  }
  return tag;
}

/** Two quick taps (not drags) on `node`: pointer events, as a phone gives no dblclick on a plain element. */
function onDoubleTap(node: HTMLElement, fn: () => void) {
  const TAP_MS = 300;
  const GAP_MS = 350;
  const SLOP_PX = 10;
  let down: { x: number; y: number; t: number } | null = null;
  let lastTap = 0;
  node.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY, t: e.timeStamp }));
  node.addEventListener("pointercancel", () => (down = null));
  node.addEventListener("pointerup", (e) => {
    const d = down;
    down = null;
    if (!d || e.timeStamp - d.t > TAP_MS || Math.hypot(e.clientX - d.x, e.clientY - d.y) > SLOP_PX) {
      lastTap = 0; // a drag or a hold: no double tap with it
      return;
    }
    if (lastTap && e.timeStamp - lastTap <= GAP_MS) {
      lastTap = 0;
      fn();
    } else lastTap = e.timeStamp;
  });
}

/** A 0..max slider whose value is not overwritten while the user drags it. */
class Slider {
  readonly root = el("div", "ed-slider");
  readonly input = el("input");
  private readonly value = el("span", "ed-value");
  private dragging = false;

  private readonly minus = el("button", "ed-fine", "−");
  private readonly plus = el("button", "ed-fine", "+");

  constructor(
    label: string,
    private readonly max: number,
    private readonly onInput: (v: number) => void,
    private readonly format: (v: number) => string,
    onReset?: () => void,
    /** −/+ fine steps, in slider units (the screen firmware's fine steps). */
    fineStep = 1,
    /** Fine steps go on until the readout changes (capture volume: the pedal's next 0.1 dB, not the next raw). */
    stepToNextReadout = false,
  ) {
    const head = el("div", "ed-slider-head");
    head.append(el("span", "ed-label", label), this.value);
    const step = (d: number) => {
      const clampV = (x: number) => Math.min(this.max, Math.max(0, x));
      let v = clampV(Number(this.input.value) + d * fineStep);
      if (stepToNextReadout) {
        const text = this.format(Number(this.input.value));
        while (this.format(v) === text && v > 0 && v < this.max) v = clampV(v + d * fineStep);
      }
      this.input.value = String(v);
      this.value.textContent = this.format(v);
      this.paint();
      this.onInput(v);
    };
    this.minus.type = this.plus.type = "button";
    this.minus.setAttribute("aria-label", `${label} down`);
    this.plus.setAttribute("aria-label", `${label} up`);
    this.minus.addEventListener("click", () => step(-1));
    this.plus.addEventListener("click", () => step(1));
    this.input.type = "range";
    this.input.min = "0";
    this.input.max = String(max);
    this.input.step = "1";
    this.input.setAttribute("aria-label", label);
    this.input.addEventListener("pointerdown", () => (this.dragging = true));
    for (const ev of ["pointerup", "pointercancel", "blur"] as const) this.input.addEventListener(ev, () => (this.dragging = false));
    this.input.addEventListener("input", () => {
      const v = Number(this.input.value);
      this.value.textContent = this.format(v);
      this.paint();
      this.onInput(v);
    });
    if (onReset) {
      this.value.title = "Double-tap to reset";
      this.value.classList.add("resettable");
      // The readout and the slider itself: dblclick does not come on a phone (a double tap there zooms).
      onDoubleTap(this.value, onReset);
      onDoubleTap(this.input, onReset);
    }
    const track = el("div", "ed-track");
    track.append(this.minus, this.input, this.plus);
    this.root.append(head, track);
  }

  set(v: number | null, enabled = true) {
    this.input.disabled = this.minus.disabled = this.plus.disabled = !enabled || v === null;
    if (v === null) {
      this.value.textContent = "—";
      return;
    }
    if (!this.dragging || document.activeElement !== this.input) {
      this.input.value = String(v);
      this.value.textContent = this.format(v);
      this.paint();
    }
  }

  /** The track's fill up to the thumb (the slider is drawn in CSS, which has no fill of its own in WebKit). */
  private paint() {
    this.input.style.setProperty("--pct", `${(Number(this.input.value) / this.max) * 100}%`);
  }
}

/** A slot the library is opened for (a slot row's swap button): what it loads goes there. */
type SlotTarget = { bank: number; position: number } | "own";

/**
 * The pedal's slots (the capture banks, the IR slots): a header « ‹ what plays › » whose arrows step through every
 * slot (over the banks too; « » a bank at a time, captures only) and whose middle shows / hides the list of the bank
 * playing (remembered in this browser). A tap in the list plays a slot; its swap button opens the library for that
 * slot. The preset's own comes first (when the preset plays its own).
 */
class SlotPicker {
  readonly root = el("div", "ed-slots");
  private readonly toggle = el("button", "ghost ed-slots-toggle");
  private readonly label = el("span", "ed-slots-label");
  private readonly prev: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly bankPrev: HTMLButtonElement | null = null;
  private readonly bankNext: HTMLButtonElement | null = null;
  private readonly btns: HTMLButtonElement[] = [];
  private readonly swaps: HTMLButtonElement[] = [];
  private readonly own = el("button", "ed-chip ed-cap-slot");
  private readonly ownRow = el("div", "ed-cap-row");
  private readonly list = el("div", "ed-slots-list");
  private bank = 1;
  open: boolean;

  constructor(
    private readonly opts: {
      per: number;
      /** localStorage key for open / closed. */
      key: string;
      ownTitle: string;
      /** ‹ › : the previous / next slot played, over the banks. */
      onStep: (delta: number) => void;
      /** « » : the same slot a bank before / after (captures). */
      onBank?: (delta: number) => void;
      onPick: (bank: number, position: number) => void;
      onOwn: () => void;
      /** A row's swap button: the library, bound to that slot. */
      onSwap: (target: SlotTarget) => void;
      /** Open / closed changed: the owner renders again. */
      onChange: () => void;
    },
  ) {
    let open = false;
    try {
      open = localStorage.getItem(opts.key) === "1";
    } catch {
      /* storage unavailable: closed */
    }
    this.open = open;
    this.prev = iconButton(ChevronLeft, "Previous slot", "ed-step-btn");
    this.next = iconButton(ChevronRight, "Next slot", "ed-step-btn");
    this.prev.addEventListener("click", () => opts.onStep(-1));
    this.next.addEventListener("click", () => opts.onStep(1));
    this.toggle.append(this.label, icon(ChevronDown));
    this.toggle.addEventListener("click", () => {
      this.open = !this.open;
      try {
        localStorage.setItem(opts.key, this.open ? "1" : "0");
      } catch {
        /* kept for this session */
      }
      opts.onChange();
    });
    const head = el("div", "ed-row ed-step ed-slots-head");
    if (opts.onBank) {
      const onBank = opts.onBank;
      this.bankPrev = iconButton(ChevronsLeft, "Previous bank", "ed-step-btn ed-bank-btn");
      this.bankNext = iconButton(ChevronsRight, "Next bank", "ed-step-btn ed-bank-btn");
      this.bankPrev.addEventListener("click", () => onBank(-1));
      this.bankNext.addEventListener("click", () => onBank(1));
      head.classList.add("ed-slots-banks");
      head.append(this.bankPrev, this.prev, this.toggle, this.next, this.bankNext);
    } else head.append(this.prev, this.toggle, this.next);
    const swap = (target: () => SlotTarget) => {
      const b = iconButton(ArrowLeftRight, "Replace from the library", "ed-chip ed-cap-swap");
      b.addEventListener("click", () => opts.onSwap(target()));
      this.swaps.push(b);
      return b;
    };
    const slots = el("div", "ed-cap-slots");
    for (let i = 0; i < opts.per; i++) {
      const b = el("button", "ed-chip ed-cap-slot");
      b.append(el("span", "ed-cap-pos", String(i + 1)), el("span", "ed-cap-name", ""));
      b.addEventListener("click", () => opts.onPick(this.bank, i + 1));
      this.btns.push(b);
      const row = el("div", "ed-cap-row");
      row.append(b, swap(() => ({ bank: this.bank, position: i + 1 })));
      slots.append(row);
    }
    this.own.append(el("span", "ed-cap-pos", "★"), el("span", "ed-cap-name", ""));
    this.own.title = opts.ownTitle;
    this.own.addEventListener("click", () => opts.onOwn());
    this.ownRow.append(this.own, swap(() => "own"));
    this.list.append(this.ownRow, slots); // the preset's own first
    this.root.append(head, this.list);
  }

  /**
   * `names`: every slot over the banks; `bank` / `position`: what plays (position 1..per, `own` for the preset's own,
   * null when off); `current`: the header's text for it. The list shows the bank playing.
   */
  render(p: { names: readonly string[]; bank: number; position: number | null; own: boolean; ownShown: boolean; on: boolean | null; ownName: string; current: string; canSwap: boolean }) {
    this.bank = p.bank;
    this.label.textContent = p.current;
    this.root.dataset.open = String(this.open);
    this.toggle.setAttribute("aria-expanded", String(this.open));
    this.list.hidden = !this.open;
    this.prev.disabled = this.next.disabled = p.on === null;
    if (this.bankPrev && this.bankNext) this.bankPrev.disabled = this.bankNext.disabled = p.on === null;
    for (const b of this.swaps) b.disabled = !p.canSwap;
    this.btns.forEach((b, i) => {
      const name = p.names[(p.bank - 1) * this.opts.per + i] ?? "";
      (b.lastChild as HTMLElement).textContent = name || `Slot ${i + 1}`;
      b.title = name;
      b.dataset.active = String(p.on === true && !p.own && p.position === i + 1);
      b.disabled = p.on === null;
    });
    (this.own.lastChild as HTMLElement).textContent = p.ownName ? `Preset's own · ${p.ownName}` : "Preset's own";
    this.own.dataset.active = String(p.on === true && p.own);
    // Only for a preset that plays its own: one saved on a slot has the same capture there.
    this.ownRow.dataset.shown = String(p.ownShown);
    this.own.disabled = p.on === null || !p.ownShown;
    this.root.dataset.off = String(p.on === false);
  }
}

/** A sheet: overlay + card with a title row and a close button. */
class Sheet {
  readonly overlay = el("div", "overlay edit-sheet");
  readonly card = el("div", "card sheet");
  readonly head = el("div", "sheet-head");
  readonly title = el("h1", "sheet-title");
  readonly sub = el("div", "sheet-sub");
  readonly body = el("div", "sheet-body");
  /** Buttons left of the close button (the FX sheet's Discard). */
  readonly actions = el("div", "sheet-actions");
  onClose: () => void = () => {};
  /** Close (X); over another sheet, Back (‹ Back): it closes alike, onto the one under it. */
  private readonly closeBtn = el("button", "ghost icon-btn sheet-close");

  constructor(className: string) {
    this.card.classList.add(className);
    const close = this.closeBtn;
    close.type = "button";
    this.setBack(false);
    close.addEventListener("click", () => this.close());
    const titles = el("div", "sheet-titles");
    titles.append(this.sub, this.title);
    this.head.append(titles, this.actions, close);
    this.card.append(this.head, this.body);
    this.overlay.append(this.card);
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });
  }

  get isOpen() {
    return this.overlay.classList.contains("open");
  }

  /** Open order: the sheet opened last is on top (the presets list opens the preset sheet over itself). */
  private static opened = 0;
  order = 0;

  private setBack(back: boolean) {
    const label = back ? "Back" : "Close";
    this.closeBtn.title = label;
    this.closeBtn.setAttribute("aria-label", label);
    this.closeBtn.dataset.back = String(back);
    this.closeBtn.replaceChildren(...(back ? [icon(ChevronLeft), el("span", "", "Back")] : [icon(X)]));
  }

  open() {
    // Over another sheet (the library over amp & cab, the slot chooser over the library): Back, not close.
    const others = this.overlay.parentElement?.querySelectorAll(":scope > .edit-sheet.open") ?? [];
    if (!this.isOpen) this.setBack(Array.from(others).some((o) => o !== this.overlay));
    this.order = ++Sheet.opened;
    // Same z-index for every sheet (under the update bar): the last in the page is on top, so it goes last.
    const parent = this.overlay.parentElement;
    if (parent && parent.lastElementChild !== this.overlay) parent.append(this.overlay);
    this.overlay.classList.add("open");
  }

  close() {
    if (!this.isOpen) return;
    this.overlay.classList.remove("open");
    this.onClose();
  }
}

export interface EditorViewActions {
  edit(): EditController | null;
  toggleFx(slot: FxSlot): Promise<void>;
  toggleGate(): Promise<void>;
  selectPreset(index: number): Promise<void>;
  toast(err: unknown): void;
}

export class EditorView {
  readonly overlays: HTMLElement[];
  private readonly fxSheet = new Sheet("fx-sheet");
  private readonly srcSheet = new Sheet("src-sheet");
  private readonly gateSheet = new Sheet("gate-sheet");
  private readonly presetSheet = new Sheet("preset-sheet");
  private readonly libSheet = new Sheet("lib-sheet");
  private readonly listSheet = new Sheet("list-sheet");
  /** Over the library: where a library item goes (its "Bank / Slot" button). */
  private readonly slotSheet = new Sheet("slot-sheet");
  private s: GigState;

  constructor(
    private readonly store: Store,
    private readonly actions: EditorViewActions,
    private readonly folders = new LibraryFolders(),
  ) {
    this.s = store.get();
    this.overlays = [this.fxSheet, this.srcSheet, this.gateSheet, this.presetSheet, this.libSheet, this.listSheet, this.slotSheet].map((x) => x.overlay);
    this.buildFx();
    this.buildSource();
    this.buildGate();
    this.buildPreset();
    this.buildLibrary();
    this.buildList();
    this.buildSlotChooser();
    this.folders.onChange(() => this.renderLibrary());
    store.subscribe((s) => this.render(s));
  }

  /** Editing is possible: connected, control mode and Edit on. */
  get canEdit(): boolean {
    const s = this.store.get();
    return s.connection === "connected" && s.writesEnabled && s.editing && this.actions.edit() !== null;
  }

  /** The sheets close with Escape; true when one was open. */
  closeTop(): boolean {
    // The one on top: opened last.
    const top = [this.slotSheet, this.libSheet, this.presetSheet, this.fxSheet, this.srcSheet, this.gateSheet, this.listSheet]
      .filter((sh) => sh.isOpen)
      .sort((a, b) => b.order - a.order)[0];
    top?.close();
    return !!top;
  }

  private run(p: Promise<unknown> | (() => unknown)) {
    try {
      const r = typeof p === "function" ? p() : p;
      if (r instanceof Promise) void r.catch((e) => this.actions.toast(e));
    } catch (e) {
      this.actions.toast(e);
    }
  }

  private edit(): EditController {
    const e = this.actions.edit();
    if (!e) throw new Error("Not connected");
    return e;
  }

  // -------------------------------------------------------------------------
  // FX sheet
  // -------------------------------------------------------------------------

  private fxSlot: FxSlot | null = null;
  private readonly fxPower = el("button", "ed-power");
  private readonly fxStatus = el("p", "ed-msg");
  private readonly fxRetry = el("button", "ed-retry", "Read again");
  private readonly fxModelBtn = el("button", "ed-model-btn");
  /** Shown when the block differs from the preset as saved (model or parameters): puts it back as saved. */
  private readonly fxDiscard = discardButton(() => {
    if (this.fxSlot) this.run(this.edit().discardFx(this.fxSlot));
  });
  private readonly fxModels = el("div", "ed-models");
  private readonly fxParams = el("div", "ed-params");
  private fxParamsKey = "";
  private fxSliders: { index: number; set: (n: number | null, enabled: boolean) => void }[] = [];

  openFx(slot: FxSlot) {
    if (!this.canEdit) return;
    this.fxSlot = slot;
    this.fxModels.hidden = true;
    this.fxModelBtn.dataset.open = "false";
    this.fxParamsKey = "";
    this.run(() => this.edit().openFx(slot));
    this.fxSheet.open();
    this.renderFx();
  }

  private buildFx() {
    const sh = this.fxSheet;
    sh.onClose = () => {
      this.fxSlot = null;
      this.actions.edit()?.closeFx();
    };
    this.fxPower.append(icon(Power), el("span", "", ""));
    this.fxPower.addEventListener("click", () => {
      if (this.fxSlot) this.run(this.actions.toggleFx(this.fxSlot));
    });
    this.fxModelBtn.addEventListener("click", () => {
      this.fxModels.hidden = !this.fxModels.hidden;
      this.fxModelBtn.dataset.open = String(!this.fxModels.hidden);
      this.fxModelsKey = "";
      this.renderFxModels();
    });
    this.fxRetry.addEventListener("click", () => this.run(() => this.edit().retryFx()));
    sh.actions.append(this.fxDiscard);
    // The model and on / off in the sheet's head (it stays at the top while the parameters scroll, held upright);
    // the model list opens right under them, then the line for the read, then the parameters.
    const top = el("div", "ed-row ed-head-row");
    top.append(this.fxModelBtn, this.fxPower);
    sh.head.append(top);
    const status = el("div", "ed-msg-row ed-msg-row-slim");
    status.append(this.fxStatus, this.fxRetry);
    sh.body.append(this.fxModels, status, this.fxParams);
  }

  private fxModelsKey = "";

  private renderFxModels() {
    const slot = this.fxSlot;
    if (!slot || this.fxModels.hidden) return;
    const current = this.s.fxModels.value[slot]?.id;
    const saved = this.savedModel(slot);
    const mark = (b: HTMLElement) => {
      b.dataset.active = String(b.dataset.id === String(current));
      // The model the preset has saved, outlined while another is tried.
      b.dataset.saved = String(b.dataset.id === saved);
    };
    // Rebuilt only for another slot (a chip replaced mid-tap loses the tap); a new model only moves the marks.
    const key = slot;
    if (key === this.fxModelsKey && this.fxModels.childElementCount) {
      for (const b of Array.from(this.fxModels.querySelectorAll<HTMLElement>(".ed-chip"))) mark(b);
      return;
    }
    this.fxModelsKey = key;
    const groups = new Map<string, ReturnType<typeof fxSlotModels>>();
    for (const m of fxSlotModels(slot)) groups.set(m.category, [...(groups.get(m.category) ?? []), m]);
    this.fxModels.replaceChildren();
    for (const [category, models] of groups) {
      const g = el("div", "ed-model-group");
      g.append(el("div", "ed-group-title", category));
      const row = el("div", "ed-chips");
      for (const m of models) {
        const b = el("button", "ed-chip", m.name);
        b.dataset.cat = slug(m.category);
        b.dataset.id = String(m.id);
        mark(b);
        // The list stays open: models can be tried one after another.
        b.addEventListener("click", () => {
          this.run(this.edit().setFxModel(slot, m.type));
        });
        row.append(b);
      }
      g.append(row);
      this.fxModels.append(g);
    }
  }

  /** The model the preset has saved in a slot when the slot now holds another, else null. */
  private savedModel(slot: FxSlot): string | null {
    return this.actions.edit()?.savedModelChanged(slot) ?? null;
  }

  private renderFx() {
    const slot = this.fxSlot;
    if (!slot || !this.fxSheet.isOpen) return;
    const s = this.s;
    const model = s.fxModels.value[slot];
    const on = s.fxOn.value[slot];
    const fx = s.edit.fx;
    this.fxSheet.sub.textContent = SLOT_LABELS[slot];
    this.fxSheet.title.textContent = model ? model.name : "Empty";
    this.fxSheet.card.dataset.cat = model?.known ? slug(model.category) : "none";
    this.fxModelBtn.replaceChildren(el("span", "ed-label", "Model"), el("span", "", model?.name ?? "Empty"), icon(ChevronRight));
    this.fxPower.dataset.on = String(on === true);
    (this.fxPower.lastChild as HTMLElement).textContent = on ? "On" : on === false ? "Off" : "—";
    this.fxPower.disabled = on === null || !model;
    // Room kept while hidden (no shift of the title). Only this block goes back; the others keep their edits.
    const saved = this.savedModel(slot);
    const changed = this.actions.edit()?.fxChanged(slot) ?? false;
    this.fxDiscard.dataset.shown = String(changed);
    this.fxDiscard.title = !changed
      ? ""
      : saved
        ? `Back to ${lookupFxModel(saved)?.name ?? "the saved model"} as this preset has it saved; other blocks keep their changes`
        : "Back to this block's saved values; other blocks keep their changes";
    const status = fx?.status ?? "loading";
    // One line that is always there: its text changes, the layout does not.
    const msg: Record<string, string> = {
      loading: "Reading the parameters…",
      ready: "",
      empty: "No model in this slot",
      unknown: "No parameter table for this model",
      error: "No answer from the pedal",
    };
    setMsg(this.fxStatus, msg[status] ?? "", status === "error" ? "warn" : "muted");
    this.fxRetry.dataset.shown = String(status === "error");
    // Parameter rows are rebuilt only when the model changes; values follow on every render.
    const def = fxDef(fx?.type ?? 0);
    const key = `${slot}:${fx?.type ?? 0}`;
    if (key !== this.fxParamsKey) {
      this.fxParamsKey = key;
      this.fxParams.replaceChildren();
      this.fxSliders = [];
      if (def) {
        for (const { index, param } of fxParamsInOrder(def)) {
          if (param.kind === "enum") {
            const row = el("div", "ed-enum");
            row.append(el("span", "ed-label", param.name));
            const chips = el("div", "ed-chips");
            const btns = param.options.map((opt, i) => {
              const b = el("button", "ed-chip", opt);
              b.addEventListener("click", () => this.run(() => this.edit().setFxParam(slot, index, fxEnumValue(param, i))));
              chips.append(b);
              return b;
            });
            row.append(chips);
            this.fxParams.append(row);
            this.fxSliders.push({
              index,
              set: (n, enabled) => {
                const sel = n === null ? -1 : Math.round(n * (param.options.length - 1));
                btns.forEach((b, i) => {
                  b.dataset.active = String(i === sel);
                  b.disabled = !enabled;
                });
              },
            });
          } else {
            const fine = Math.max(1, Math.round((param.step / (param.max - param.min || 1)) * 1000));
            const slider = new Slider(param.name, 1000, (v) => this.run(() => this.edit().setFxParam(slot, index, v / 1000)), (v) => fxParamText(param, v / 1000), undefined, fine);
            this.fxParams.append(slider.root);
            this.fxSliders.push({ index, set: (n, enabled) => slider.set(n === null ? null : Math.round(n * 1000), enabled) });
          }
        }
      }
    }
    // Off or on alike, as in Cortex Cloud: a bypassed block keeps its edits for when it is turned on.
    const ready = status === "ready";
    for (const r of this.fxSliders) r.set(fx?.values?.[r.index] ?? null, ready);
    this.fxParams.dataset.dim = String(!ready);
    // Off: still editable (heard once it is on), but drawn like the off tile: grey, so it reads as off.
    this.fxParams.dataset.off = String(on === false);
    if (!this.fxModels.hidden) this.renderFxModels();
  }

  // -------------------------------------------------------------------------
  // Amp & cab sheet: capture and IR
  // -------------------------------------------------------------------------

  private srcTab: "capture" | "ir" = "capture";
  private readonly tabs = el("div", "ed-tabs");
  private readonly capTab = el("button", "ed-tab", "Capture");
  private readonly irTab = el("button", "ed-tab", "IR");
  private readonly capPane = el("div", "ed-pane");
  private readonly irPane = el("div", "ed-pane");
  private readonly capName = el("div", "ed-big");
  /** The name rows (name, on / off): in the sheet's head, the tab's shown. */
  private readonly capHead = el("div", "ed-row ed-name-row");
  private readonly irHead = el("div", "ed-row ed-name-row");
  /** The capture banks as the pedal has them: 5 banks of 5 slots; ‹ › step through all 25, the list a tap away. */
  private readonly capPicker = new SlotPicker({
    per: CAPTURE_SELECT_SLOTS,
    key: "nanogig.captureSlotsOpen",
    ownTitle: "The capture saved in this preset itself",
    onStep: (d) => this.run(this.edit().stepCapture(d)),
    onBank: (d) => this.run(this.edit().stepCaptureBank(d)),
    onPick: (bank, position) => this.run(this.edit().selectCapture(bank, position)),
    onOwn: () => this.run(this.edit().selectCaptureSlot(CAPTURE_OWN_SLOT)),
    onSwap: (target) => this.openLibrary("captures", target),
    onChange: () => this.renderSource(),
  });
  /** The pedal's IR slots (one bank of 5), like the captures'. */
  private readonly irPicker = new SlotPicker({
    per: CAB_SLOT_COUNT,
    key: "nanogig.irSlotsOpen",
    ownTitle: "The IR saved in this preset itself",
    onStep: (d) => this.run(this.edit().stepIr(d)),
    onPick: (_bank, position) => this.run(this.edit().selectIrSlot(position)),
    onOwn: () => this.run(this.edit().selectIrSlot(CAB_OWN_SLOT)),
    onSwap: (target) => this.openLibrary("irs", target),
    onChange: () => this.renderSource(),
  });
  private readonly capLib = el("button", "ed-lib-btn");
  private readonly irLib = el("button", "ed-lib-btn");
  private readonly capHint = el("p", "hint", "");
  private readonly capPower = el("button", "ed-power");
  private readonly capVolume = new Slider(
    "Volume",
    255,
    (v) => this.run(() => this.edit().setCaptureVolume(v)),
    (v) => captureVolumeText(v),
    () => this.run(() => this.edit().setCaptureVolume(CAPTURE_VOLUME_DEFAULT_RAW)),
    1,
    true,
  );
  private readonly irName = el("div", "ed-big");
  private readonly irPower = el("button", "ed-power");
  private readonly irStatus = el("p", "ed-msg");
  private readonly irRetry = el("button", "ed-retry", "Read again");
  private readonly irSliders = new Map<CabParam, Slider>();
  private readonly irPhase = el("button", "ed-chip", "Ø Phase inverted");
  private readonly irMicBox = el("div", "ed-mic");
  private readonly irParamsBox = el("div", "ed-params");
  private readonly irPhaseRow = el("div", "ed-row");
  /** Capture tab: its slot and volume back as saved; IR tab: the IR and its settings. */
  private readonly srcDiscard = discardButton(() => this.run(this.srcTab === "capture" ? this.edit().discardCapture() : this.edit().discardIr()));
  private readonly irMics = el("div", "ed-chips");
  private readonly irPositions = el("div", "ed-chips");
  private irMicKey = "";

  openSource(tab: "capture" | "ir") {
    if (!this.canEdit) return;
    this.srcTab = tab;
    this.srcSheet.open();
    if (tab === "ir") this.run(() => this.edit().openIr());
    this.renderSource();
  }

  /** The capture's / IR's name with its on / off at the end of the row. */
  private nameRow(row: HTMLElement, nameEl: HTMLElement, power: HTMLButtonElement, onPower: () => void): HTMLElement {
    power.append(icon(Power), el("span", "", ""));
    power.addEventListener("click", onPower);
    row.append(nameEl, power);
    return row;
  }


  private buildSource() {
    const sh = this.srcSheet;
    sh.title.textContent = "Amp & cab";
    sh.onClose = () => this.actions.edit()?.closeIr();
    sh.actions.append(this.srcDiscard);
    this.capTab.addEventListener("click", () => {
      this.srcTab = "capture";
      this.actions.edit()?.closeIr();
      this.renderSource();
    });
    this.irTab.addEventListener("click", () => {
      this.srcTab = "ir";
      this.run(() => this.edit().openIr());
      this.renderSource();
    });
    this.tabs.append(this.capTab, this.irTab);
    // The tabs and the name with its on / off stay at the top while the sheet scrolls (in its sticky head).
    sh.head.append(this.tabs);

    const capLib = this.capLib;
    capLib.append(icon(Library), el("span", "", "Capture library"));
    capLib.addEventListener("click", () => this.openLibrary("captures"));
    const capHint = this.capHint; // one line under the library button: its text follows on / off (no layout shift)
    sh.head.append(this.nameRow(this.capHead, this.capName, this.capPower, () => this.run(this.edit().setCaptureOn(!this.s.captureOn.value))));
    this.capPane.append(this.capPicker.root, capLib, capHint, this.capVolume.root); // as the IR tab: the library, its line, then the controls

    const irLib = this.irLib;
    irLib.append(icon(Library), el("span", "", "IR library"));
    irLib.addEventListener("click", () => this.openLibrary("irs"));
    this.irRetry.addEventListener("click", () => this.run(() => this.edit().retryIr()));
    this.irPhase.addEventListener("click", () => {
      const inv = this.s.edit.ir?.settings?.phaseInverted ?? false;
      this.run(this.edit().setIrPhase(!inv));
    });
    const status = el("div", "ed-msg-row");
    status.append(this.irStatus, this.irRetry);
    const sliders = this.irParamsBox;
    for (const p of ["level", "highPass", "lowPass"] as CabParam[]) {
      const s = new Slider(CAB_LABELS[p], 1000, (v) => this.run(() => this.edit().setIrParam(p, v / 1000)), (v) => cabValueText(p, v / 1000));
      this.irSliders.set(p, s);
      sliders.append(s.root);
    }
    const phaseRow = this.irPhaseRow;
    phaseRow.append(this.irPhase);
    this.irMicBox.append(el("span", "ed-label", "Microphone"), this.irMics, el("span", "ed-label", "Position (centre → edge)"), this.irPositions);
    for (let i = 0; i < CAB_POSITIONS; i++) {
      const b = el("button", "ed-chip ed-pos", String(i + 1));
      b.addEventListener("click", () => {
        const cs = this.s.edit.ir?.settings;
        if (cs) this.run(this.edit().setIrMic(i, cs.mic));
      });
      this.irPositions.append(b);
    }
    sh.head.append(this.nameRow(this.irHead, this.irName, this.irPower, () => this.run(this.edit().setIrOn(!this.s.cabOn.value))));
    this.irPane.append(
      this.irPicker.root,
      irLib,
      status,
      sliders,
      phaseRow,
      // Last: only a factory IR has it, known once the settings are read.
      this.irMicBox,
    );
    sh.body.append(this.capPane, this.irPane);
  }

  /** What the shown preset has saved (as read at its load or last save), else null. */
  private savedSource() {
    const saved = this.s.edit.savedSource;
    return saved && saved.preset === this.s.activePreset.value ? saved : null;
  }

  private showSrcDiscard(changed: boolean, title: string) {
    this.srcDiscard.dataset.shown = String(changed);
    this.srcDiscard.title = changed ? title : "";
  }

  private renderSource() {
    if (!this.srcSheet.isOpen) return;
    const s = this.s;
    const capture = this.srcTab === "capture";
    this.capTab.dataset.active = String(capture);
    this.srcSheet.card.dataset.tab = capture ? "capture" : "ir"; // the IR tab in the IR colour
    this.irTab.dataset.active = String(!capture);
    this.capPane.hidden = this.capHead.hidden = !capture;
    this.irPane.hidden = this.irHead.hidden = capture;
    this.srcSheet.sub.textContent = presetLabel(s.activePreset.value ?? -1, { presetsPerBank: s.presetsPerBank, style: s.labelStyle }) + " · " + (s.presetNames.value[s.activePreset.value ?? -1] || "");
    if (capture) {
      const on = s.captureOn.value;
      const slot = s.captureSlot.value ?? 0;
      this.capName.textContent = s.captureName.value || "—";
      this.capName.dataset.off = String(on === false);
      const bank = s.captureBank.value ?? 1;
      // A library capture playing (listened to, or loaded into the preset's own) sits in the preset's own place.
      const preview = this.actions.edit()?.capturePreview() ?? null;
      const own = slot === CAPTURE_OWN_SLOT || !!preview;
      const current = !on ? "Off" : own ? "Preset's own slot" : slot ? `Bank ${bank} · Slot ${slot}` : "—";
      this.capPower.dataset.on = String(on === true);
      (this.capPower.lastChild as HTMLElement).textContent = on ? "On" : "Off";
      this.capPicker.render({
        names: s.captureSlots,
        bank,
        position: !preview && slot >= 1 && slot <= CAPTURE_SELECT_SLOTS ? slot : null,
        own,
        ownShown: own || this.savedSource()?.captureSlot === CAPTURE_OWN_SLOT,
        on,
        ownName: preview?.name ?? this.actions.edit()?.ownCaptureName() ?? "",
        current,
        canSwap: on === true, // as the library button
      });
      this.capVolume.set(s.captureVolume.value, on !== null);
      // Off: the volume still works (heard once it is on), drawn grey like an off block.
      this.capVolume.root.dataset.off = String(on === false);
      // The library needs the capture on (a preview onto an off capture hung the pedal; Cortex Cloud hides it too).
      this.capLib.disabled = on !== true;
      this.capHint.textContent = on === false ? "Turn the capture on to open the library." : "Double-tap the volume to reset it to 0 dB.";
      this.showSrcDiscard(
        this.actions.edit()?.captureChanged() ?? false,
        this.actions.edit()?.capturePreview() ? "Undo the load into the preset's own: the capture it has saved plays again" : "Back to the capture and volume this preset has saved (on / off stays)",
      );
      return;
    }
    const on = s.cabOn.value;
    const ir = s.edit.ir;
    const cs = ir?.status === "ready" ? ir.settings : (ir?.settings ?? null);
    this.irName.textContent = s.irName.value || "—";
    this.irName.dataset.off = String(on === false);
    const slot = s.cabSlot.value;
    // A library IR playing (Cortex Cloud's preview) sits in the preset's own place, as a capture's does.
    const irPreview = this.actions.edit()?.irPreview() ?? null;
    const irOwn = slot === CAB_OWN_SLOT || !!irPreview;
    this.irPower.dataset.on = String(on === true);
    (this.irPower.lastChild as HTMLElement).textContent = on ? "On" : "Off";
    this.irPicker.render({
      names: s.irSlots,
      bank: 1,
      position: !irPreview && slot !== null && slot >= 1 && slot <= CAB_SLOT_COUNT ? slot : null,
      own: irOwn,
      ownShown: irOwn || this.savedSource()?.cabSlot === CAB_OWN_SLOT,
      on,
      ownName: irPreview?.name ?? (slot === CAB_OWN_SLOT ? s.irName.value ?? "" : this.actions.edit()?.ownIrName() ?? ""),
      current: !on ? "Off" : irOwn ? "Preset's own slot" : slot ? `Slot ${slot}` : "—",
      canSwap: on === true, // as the library button
    });
    const status = ir?.status ?? "loading";
    setMsg(
      this.irStatus,
      status === "loading"
        ? "Reading the IR settings…"
        : status === "error"
          ? "No answer from the pedal"
          : status === "off"
            ? "Off: turn it on to read its settings and open the library"
            : on === false
              ? "Off: turn it on to hear it or open the library"
              : "",
      status === "error" ? "warn" : "muted",
    );
    this.irRetry.dataset.shown = String(status === "error");
    // As the capture's: the library needs the IR on.
    this.irLib.disabled = on !== true;
    // Off or on alike, as an FX block: an IR that is off keeps its edits for when it is on, drawn grey.
    const ready = status === "ready" && !!cs;
    for (const box of [this.irParamsBox, this.irPhaseRow, this.irMicBox]) box.dataset.off = String(on === false);
    this.showSrcDiscard(this.actions.edit()?.irChanged() ?? false, "Back to the IR and settings this preset has saved (on / off stays)");
    for (const [p, slider] of this.irSliders) slider.set(cs ? Math.round(cs[p] * 1000) : null, ready);
    this.irPhase.dataset.active = String(cs?.phaseInverted === true);
    this.irPhase.disabled = !ready;
    this.irMicBox.hidden = !cs?.factory;
    if (cs?.factory) {
      const key = cs.mics.join("|");
      if (key !== this.irMicKey) {
        this.irMicKey = key;
        this.irMics.replaceChildren(
          ...cs.mics.map((m) => {
            const b = el("button", "ed-chip", m);
            b.addEventListener("click", () => {
              const cur = this.s.edit.ir?.settings;
              if (cur) this.run(this.edit().setIrMic(cur.position, m));
            });
            return b;
          }),
        );
      }
      for (const b of Array.from(this.irMics.children) as HTMLButtonElement[]) {
        b.dataset.active = String(b.textContent === cs.mic);
        b.disabled = !ready;
      }
      (Array.from(this.irPositions.children) as HTMLButtonElement[]).forEach((b, i) => {
        b.dataset.active = String(i === cs.position);
        b.disabled = !ready;
      });
    }
  }

  // -------------------------------------------------------------------------
  // Gate sheet
  // -------------------------------------------------------------------------

  private readonly gatePower = el("button", "ed-power");
  private readonly gateDiscard = discardButton(() => this.run(() => this.edit().discardGate()));
  private readonly gateThreshold = new Slider("Threshold", 255, (v) => this.run(() => this.edit().setGateThreshold(v)), (v) => `${Math.round((v / 255) * 100)} %`);

  openGate() {
    if (!this.canEdit) return;
    this.gateSheet.open();
    this.renderGate();
  }

  private buildGate() {
    const sh = this.gateSheet;
    sh.sub.textContent = "Noise gate";
    sh.title.textContent = "Gate";
    this.gatePower.append(icon(Power), el("span", "", ""));
    this.gatePower.addEventListener("click", () => this.run(this.actions.toggleGate()));
    // On / off in the sheet's head, as the FX sheet's.
    const row = el("div", "ed-row ed-head-row");
    row.append(this.gatePower);
    sh.actions.append(this.gateDiscard);
    sh.head.append(row);
    sh.body.append(this.gateThreshold.root);
  }

  private renderGate() {
    if (!this.gateSheet.isOpen) return;
    const on = this.s.gateOn.value;
    this.gatePower.dataset.on = String(on === true);
    (this.gatePower.lastChild as HTMLElement).textContent = on ? "On" : "Off";
    this.gateThreshold.set(this.s.gateThreshold.value, true);
    // Off: the threshold still works, drawn grey like an off block.
    this.gateThreshold.root.dataset.off = String(on === false);
    const changed = this.actions.edit()?.gateChanged() ?? false;
    this.gateDiscard.dataset.shown = String(changed);
    this.gateDiscard.title = changed ? "Back to the threshold this preset has saved (on / off stays)" : "";
  }

  // -------------------------------------------------------------------------
  // Preset sheet
  // -------------------------------------------------------------------------

  private presetIndex: number | null = null;
  private readonly nameInput = el("input", "ed-input");
  private readonly nameBtn = el("button", "primary");
  /** The name's problem, the pedal's answer or the rule: one line that is always there. */
  private readonly presetMsg = el("p", "ed-msg");
  private readonly fsRow = el("div", "ed-chips");
  private readonly deleteBtn = el("button", "warn ed-delete");
  /** Save with the save light off too (what plays now stored on the preset): for trying out what the pedal keeps. */
  private readonly forceSaveBtn = el("button", "ed-force-save");
  private readonly forceSaveHint = el("p", "hint", "");
  private deleteArmed = false;
  private nameTypedAt = 0;
  private readonly presetIntro = el("p", "hint ed-intro");

  openPreset(index: number) {
    if (!this.canEdit || index < 0 || index >= PRESET_COUNT) return;
    this.presetIndex = index;
    this.deleteArmed = false;
    this.nameInput.value = this.s.presetNames.value[index] ?? "";
    this.presetSheet.open();
    this.renderPreset();
    setTimeout(() => this.nameInput.focus(), 50);
  }

  /** Empty slot: a create (the shown preset stored there under the name); named: a rename. */
  private presetMode(index: number): "rename" | "create" {
    return (this.s.presetNames.value[index] ?? "").trim() ? "rename" : "create";
  }

  private buildPreset() {
    const sh = this.presetSheet;
    sh.onClose = () => {
      if (this.presetIndex !== null && this.s.edit.preset.nameNew === this.presetIndex) this.actions.edit()?.dismissNameNew();
      this.presetIndex = null;
    };
    this.nameInput.type = "text";
    this.nameInput.maxLength = PRESET_NAME_WRITE_MAX;
    this.nameInput.autocomplete = "off";
    this.nameInput.spellcheck = false;
    this.nameInput.setAttribute("aria-label", "Preset name");
    this.nameInput.addEventListener("input", () => {
      this.nameTypedAt = Date.now(); // the last answer is old news
      this.renderPreset();
    });
    this.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.nameBtn.click();
    });
    this.nameBtn.addEventListener("click", () => {
      const i = this.presetIndex;
      if (i === null) return;
      const name = this.nameInput.value;
      this.run(this.presetMode(i) === "create" ? this.edit().createPreset(i, name) : this.edit().renamePreset(i, name));
    });
    for (const fs of FOOTSWITCHES) {
      const b = el("button", "ed-chip ed-fs", fs.toUpperCase());
      b.dataset.fs = fs;
      b.addEventListener("click", () => {
        if (this.presetIndex !== null) this.run(this.edit().assignFootswitch(this.presetIndex, fs as Footswitch));
      });
      this.fsRow.append(b);
    }
    this.deleteBtn.append(icon(Trash2), el("span", "", "Delete preset"));
    this.deleteBtn.addEventListener("click", () => {
      const i = this.presetIndex;
      if (i === null) return;
      if (!this.deleteArmed) {
        this.deleteArmed = true;
        this.renderPreset();
        return;
      }
      this.deleteArmed = false;
      this.run(this.edit().deletePreset(i));
    });
    this.forceSaveBtn.append(icon(Save), el("span", "", "Save now"));
    this.forceSaveBtn.addEventListener("click", () => this.run(this.edit().savePreset()));
    const nameRow = el("div", "ed-row");
    nameRow.append(this.nameInput, this.nameBtn);
    sh.body.append(
      this.presetIntro,
      nameRow,
      this.presetMsg,
      el("h2", "", "Pedal footswitch"),
      el("p", "hint", "Put this preset on one of the Nano's footswitches (IA, IB, IIA, IIB)."),
      this.fsRow,
      el("h2", "", "Save"),
      this.forceSaveHint,
      this.forceSaveBtn,
      el("h2", "", "Delete"),
      this.deleteBtn,
    );
  }

  private renderPreset() {
    const i = this.presetIndex;
    if (i === null || !this.presetSheet.isOpen) return;
    const s = this.s;
    const name = s.presetNames.value[i] ?? "";
    const mode = this.presetMode(i);
    const active = s.activePreset.value === i;
    this.presetSheet.sub.textContent = labelHasBanks(s.labelStyle) ? `${presetLabel(i, { presetsPerBank: s.presetsPerBank, style: s.labelStyle })} · preset ${i + 1}` : `Preset ${i + 1}`;
    this.presetSheet.title.textContent = name || "Empty";
    this.presetIntro.textContent =
      mode === "create"
        ? s.edit.preset.nameNew === i
          ? "The pedal saved this preset without a name: name it so it shows in the lists."
          : `An empty slot: naming it stores ${active ? "this preset's sound" : `the sound playing now (preset ${(s.activePreset.value ?? 0) + 1})`} here.`
        : "A rename is stored on the pedal at once.";
    this.nameBtn.textContent = mode === "create" ? "Save here" : "Rename";
    const busy = s.edit.preset.busy;
    const problem = this.actions.edit()?.nameProblem(i, this.nameInput.value) ?? null;
    const unchanged = this.nameInput.value === name;
    this.nameBtn.disabled = !!busy || !!problem || unchanged;
    const res = s.edit.preset.result;
    const answer = res && res.index === i && Date.now() - res.at < 8000 ? res : null;
    if (busy) setMsg(this.presetMsg, "Waiting for the pedal…");
    else if (!unchanged && problem) setMsg(this.presetMsg, problem, "warn");
    else if (answer && answer.at >= this.nameTypedAt) setMsg(this.presetMsg, answer.ok ? `${answer.kind === "delete" ? "Deleted" : "Saved"}.` : answer.message, answer.ok ? "ok" : "warn");
    else setMsg(this.presetMsg, "4–31 characters, a name no other preset has");
    const fs = s.footswitches.value;
    for (const b of Array.from(this.fsRow.children) as HTMLButtonElement[]) {
      const key = b.dataset.fs as Footswitch;
      const on = fs ? fs[key] : null;
      b.dataset.active = String(on === i);
      b.disabled = !!busy || mode === "create";
      // Which preset each footswitch holds now, as the screen's footswitch chooser shows it.
      const holds = on === null ? "" : on === i ? "this preset" : s.presetNames.value[on] || `preset ${on + 1}`;
      b.replaceChildren(el("strong", "", key.toUpperCase()), el("span", "ed-fs-now", holds));
      b.title = on === null ? "" : `${key.toUpperCase()} plays ${holds} now`;
    }
    this.forceSaveBtn.disabled = !!busy || mode === "create" || !active;
    this.forceSaveHint.textContent = active
      ? "Stores what plays now on this preset, also with the save light off (a preview included)."
      : "Only for the preset playing.";
    this.deleteBtn.disabled = !!busy || mode === "create";
    (this.deleteBtn.lastChild as HTMLElement).textContent = this.deleteArmed ? "Tap again to delete" : "Delete preset";
    this.deleteBtn.dataset.armed = String(this.deleteArmed);
  }

  // -------------------------------------------------------------------------
  // Library sheet (captures / IRs), in folders of our own (the screen firmware's capture / IR list)
  // -------------------------------------------------------------------------
  //
  // The top of a list shows its folders, then the items in none; a folder shows its items. Tap an item for its
  // actions (load, move); hold it (or drag it onto a folder) to move it. The bar under the tabs is always there:
  // New folder at the top of a list; back, rename and delete in a folder; Cancel while moving; the name while naming.

  private libKind: LibraryKind = "captures";
  private libList: LibraryList = "user";
  /** The open folder; null = the top of the list. */
  private libFolder: number | null = null;
  /** pick: in a folder, ticking items of the list to add them to it at once (the bar's +). */
  private libMode: "browse" | "move" | "pick" | "new" | "rename" = "browse";
  /** The items ticked in pick mode, by name (in the list shown). */
  private libPicked = new Set<string>();
  /** The item being moved (hold / Move / drag). */
  private libMoving: { list: LibraryList; name: string } | null = null;
  /** Opened on the current item's list and folder once the library is there. */
  private libLanded = false;
  private libSelected: string | null = null;
  /** The library closes because of a load (not to be undone as a listen). */
  private libLoaded = false;
  private libDeleteArmed: ReturnType<typeof setTimeout> | null = null;
  private libHeld = false;
  private readonly libSearch = el("input", "ed-input");
  private readonly libLists = el("div", "ed-tabs");
  private readonly libUser = el("button", "ed-tab", "User");
  private readonly libFactory = el("button", "ed-tab", "Factory");
  private readonly libBar = el("div", "ed-libbar");
  private readonly barMain = el("button", "ed-bar-main");
  private readonly barTitle = el("span", "ed-bar-title");
  /** Alphabetical order, both ways (off = the pedal's order); kept in this browser for both libraries. */
  private readonly barSort = el("button", "ed-bar-sort");
  private libSort: LibrarySort = readLibrarySort();
  /** In a folder: + (pick items to add); picking: Add n. */
  private readonly barAdd = el("button", "ed-bar-add");
  private readonly barRename = iconButton(Pencil, "Rename folder", "icon-btn");
  private readonly barDelete = el("button", "warn ed-bar-delete");
  private readonly folderInput = el("input", "ed-input");
  private readonly folderSave = el("button", "primary", "Save");
  private readonly folderCancel = el("button", "ghost", "Cancel");
  private readonly libStatus = el("p", "ed-msg");
  private readonly libItems = el("div", "ed-list");

  /** The slot the library was opened for (a slot row's swap button), else null: the slot playing. */
  private libTarget: SlotTarget | null = null;

  openLibrary(kind: LibraryKind, target: SlotTarget | null = null) {
    if (!this.canEdit) return;
    this.libKind = kind;
    this.libTarget = target;
    this.libSelected = null;
    this.libFolder = null;
    this.libMode = "browse";
    this.libMoving = null;
    this.libPicked.clear();
    this.libLanded = false;
    this.disarmFolderDelete();
    this.libSearch.value = "";
    this.libSheet.open();
    this.run(this.edit().loadLibrary(kind));
    this.renderLibrary();
  }

  private libItemsOf(): LibraryItem[] {
    const lib = this.s.edit.library;
    return (this.libKind === "irs" ? lib.irs : lib.captures) ?? [];
  }

  private folderOf(it: { list: LibraryList; name: string }): number | null {
    return this.folders.folderOf(this.libKind, it.list, it.name);
  }

  private libGo(patch: { list?: LibraryList; folder?: number | null }) {
    if (patch.list !== undefined) this.libList = patch.list;
    if (patch.folder !== undefined) this.libFolder = patch.folder;
    this.libMode = "browse";
    this.libMoving = null;
    this.libSelected = null;
    this.libPicked.clear();
    this.disarmFolderDelete();
    this.renderLibrary();
  }

  /** In a folder: tick items of the list (in no folder or another) to add them all at once. */
  private startPick() {
    if (this.libFolder === null) return;
    this.libMode = "pick";
    this.libPicked.clear();
    this.libSelected = null;
    this.disarmFolderDelete();
    this.renderLibrary();
  }

  /** The ticked items into the folder shown (out of any other they were in). */
  private addPicked() {
    const folder = this.libFolder;
    const picked = [...this.libPicked];
    this.libMode = "browse";
    this.libPicked.clear();
    if (folder !== null) for (const name of picked) this.folders.file(this.libKind, this.libList, name, folder);
    this.renderLibrary();
  }

  private startMove(it: { list: LibraryList; name: string }, held = false) {
    // The rows are rebuilt under the finger: the click that ends the hold must not tap a folder.
    this.libHeld = held;
    this.libMoving = { list: it.list, name: it.name };
    this.libMode = "move";
    this.libSelected = null;
    this.renderLibrary();
  }

  /** File the moving (or dragged) item; null = the top of the list. */
  private fileInto(it: { list: LibraryList; name: string }, folder: number | null) {
    this.folders.file(this.libKind, it.list, it.name, folder);
    this.libMode = "browse";
    this.libMoving = null;
    this.renderLibrary();
  }

  private startNaming(mode: "new" | "rename") {
    this.libMode = mode;
    this.folderInput.value = mode === "rename" ? (this.folders.find(this.libFolder)?.name ?? "") : "";
    this.renderLibrary();
    this.folderInput.focus();
    this.folderInput.select();
  }

  private folderNameProblem(): string | null {
    return this.folders.nameProblem(this.libKind, this.libList, this.folderInput.value, this.libMode === "rename" ? this.libFolder : null);
  }

  private saveFolderName() {
    if (this.folderNameProblem()) return;
    if (this.libMode === "rename" && this.libFolder !== null) {
      this.folders.rename(this.libFolder, this.folderInput.value);
      this.libMode = "browse";
    } else if (this.libMode === "new") {
      const f = this.folders.create(this.libKind, this.libList, this.folderInput.value);
      const moving = this.libMoving;
      this.libMode = "browse";
      this.libMoving = null;
      // Made while moving an item: it goes in; else the new folder opens.
      if (moving) this.folders.file(this.libKind, moving.list, moving.name, f.id);
      else this.libFolder = f.id;
    }
    this.renderLibrary();
  }

  private disarmFolderDelete() {
    if (this.libDeleteArmed) clearTimeout(this.libDeleteArmed);
    this.libDeleteArmed = null;
  }

  /** Drop target for a dragged item (desktop): `folder` null = the top of the list. */
  private dropTarget(node: HTMLElement, folder: () => number | null) {
    node.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      node.dataset.drop = "true";
    });
    node.addEventListener("dragleave", () => delete node.dataset.drop);
    node.addEventListener("drop", (e) => {
      delete node.dataset.drop;
      const raw = e.dataTransfer?.getData(DRAG_TYPE);
      if (!raw) return;
      e.preventDefault();
      const it = JSON.parse(raw) as { list: LibraryList; name: string };
      if (it.list === this.libList) this.fileInto(it, folder());
    });
  }

  // -------------------------------------------------------------------------
  // Slot chooser: where a library item goes (« ‹ bank · slot › », the bank's slots, Load)
  // -------------------------------------------------------------------------

  private slotFor: { item: LibraryItem; kind: LibraryKind } | null = null;
  private slotChosen = { bank: 1, position: 1 };
  private readonly slotFor_ = el("p", "ed-slot-for");
  private readonly slotLabel = el("span", "ed-slots-label");
  private readonly slotBankBtns: HTMLButtonElement[] = [];
  private readonly slotBtns: HTMLButtonElement[] = [];
  private readonly slotLoad = el("button", "primary ed-slot-load");
  private readonly slotHint = el("p", "hint", "Saved presets on that slot keep theirs; this preset plays it at once (Save keeps it).");

  private openSlotChooser(item: LibraryItem, from: { bank: number; position: number }) {
    this.slotFor = { item, kind: this.libKind };
    this.slotChosen = { ...from };
    this.slotSheet.open();
    this.renderSlotChooser();
  }

  /** The chosen slot stepped by one (over the banks, wrapping) or by a bank (`bank`). */
  private stepSlot(delta: number, bank = false) {
    const irs = this.slotFor?.kind === "irs";
    const per = irs ? CAB_SLOT_COUNT : CAPTURE_SELECT_SLOTS;
    const banks = irs ? 1 : CAPTURE_BANKS;
    const total = per * banks;
    const at = (this.slotChosen.bank - 1) * per + this.slotChosen.position - 1;
    const next = (((at + (bank ? per : 1) * (delta > 0 ? 1 : -1)) % total) + total) % total;
    this.slotChosen = { bank: Math.floor(next / per) + 1, position: (next % per) + 1 };
    this.renderSlotChooser();
  }

  private buildSlotChooser() {
    const sh = this.slotSheet;
    sh.title.textContent = "Bank / Slot";
    const bankPrev = iconButton(ChevronsLeft, "Previous bank", "ed-step-btn ed-bank-btn");
    const prev = iconButton(ChevronLeft, "Previous slot", "ed-step-btn");
    const next = iconButton(ChevronRight, "Next slot", "ed-step-btn");
    const bankNext = iconButton(ChevronsRight, "Next bank", "ed-step-btn ed-bank-btn");
    bankPrev.addEventListener("click", () => this.stepSlot(-1, true));
    bankNext.addEventListener("click", () => this.stepSlot(1, true));
    prev.addEventListener("click", () => this.stepSlot(-1));
    next.addEventListener("click", () => this.stepSlot(1));
    this.slotBankBtns.push(bankPrev, bankNext);
    const middle = el("div", "ed-slots-toggle ed-slot-choice");
    middle.append(this.slotLabel);
    const head = el("div", "ed-row ed-step ed-slots-head ed-slots-banks");
    head.append(bankPrev, prev, middle, next, bankNext);
    const list = el("div", "ed-cap-slots");
    for (let i = 0; i < Math.max(CAPTURE_SELECT_SLOTS, CAB_SLOT_COUNT); i++) {
      const b = el("button", "ed-chip ed-cap-slot");
      b.append(el("span", "ed-cap-pos", String(i + 1)), el("span", "ed-cap-name", ""));
      b.addEventListener("click", () => {
        this.slotChosen = { ...this.slotChosen, position: i + 1 };
        this.renderSlotChooser();
      });
      this.slotBtns.push(b);
      list.append(b);
    }
    this.slotLoad.addEventListener("click", () => {
      const f = this.slotFor;
      if (!f) return;
      const to = { ...this.slotChosen };
      this.run(() => this.edit().pickFromLibrary(f.item, f.kind, to));
      this.libLoaded = true; // the library's close below is the load's: what it plays stays
      this.slotSheet.close();
      this.libSheet.close();
    });
    const picker = el("div", "ed-slots");
    picker.dataset.open = "true";
    picker.append(head, list);
    sh.body.append(this.slotFor_, picker, this.slotLoad, this.slotHint);
  }

  private renderSlotChooser() {
    const f = this.slotFor;
    if (!this.slotSheet.isOpen || !f) return;
    const irs = f.kind === "irs";
    const s = this.s;
    const { bank, position } = this.slotChosen;
    const where = irs ? `Slot ${position}` : `Bank ${bank} · Slot ${position}`;
    this.slotSheet.card.dataset.kind = f.kind; // captures red, IRs violet
    this.slotSheet.title.textContent = irs ? "Slot" : "Bank / Slot";
    this.slotSheet.sub.textContent = irs ? "IR library" : "Capture library";
    this.slotFor_.replaceChildren(el("span", "", `Select ${irs ? "the slot" : "bank and slot"} to load this ${irs ? "IR" : "capture"} to:`), el("strong", "", f.item.name));
    this.slotLabel.textContent = where;
    for (const b of this.slotBankBtns) b.dataset.shown = String(!irs);
    const per = irs ? CAB_SLOT_COUNT : CAPTURE_SELECT_SLOTS;
    const names = irs ? s.irSlots : s.captureSlots;
    const playingBank = s.captureBank.value ?? 1;
    this.slotBtns.forEach((b, i) => {
      b.hidden = i >= per;
      const name = names[(bank - 1) * per + i] ?? "";
      (b.lastChild as HTMLElement).textContent = name || `Slot ${i + 1}`;
      b.title = name;
      b.dataset.active = String(position === i + 1);
      // The one playing now: underlined (Load writes over what plays).
      b.dataset.playing = String(
        irs ? s.cabOn.value === true && s.cabSlot.value === i + 1 : s.captureOn.value === true && playingBank === bank && s.captureSlot.value === i + 1,
      );
    });
    this.slotLoad.textContent = `Load to ${where}`;
  }

  private buildLibrary() {
    const sh = this.libSheet;
    sh.onClose = () => {
      this.slotSheet.close(); // over it: goes with it
      this.libMode = "browse";
      this.libMoving = null;
      this.disarmFolderDelete();
      // A capture only listened to stops (one loaded stays).
      const edit = this.actions.edit();
      if (edit && !this.libLoaded) this.run(() => edit.endAudition());
      this.libLoaded = false;
    };
    const searchRow = el("label", "ed-search");
    searchRow.append(icon(Search), this.libSearch);
    this.libSearch.type = "search";
    this.libSearch.placeholder = "Search";
    this.libSearch.setAttribute("aria-label", "Search the library");
    this.libSearch.addEventListener("input", () => this.renderLibrary());
    this.libUser.addEventListener("click", () => this.libGo({ list: "user", folder: null }));
    this.libFactory.addEventListener("click", () => this.libGo({ list: "factory", folder: null }));
    this.libLists.append(this.libUser, this.libFactory);

    // The bar: [main] title [rename] [delete], or [name input] [Save] [Cancel].
    this.barMain.append(icon(FolderPlus), el("span", "", ""));
    this.barMain.addEventListener("click", () => {
      if (this.libMode === "move" || this.libMode === "pick") this.libGo({});
      else if (this.libFolder !== null) this.libGo({ folder: null });
      else this.startNaming("new");
    });
    this.dropTarget(this.barMain, () => null);
    this.barSort.addEventListener("click", () => {
      this.libSort = this.libSort === "off" ? "az" : this.libSort === "az" ? "za" : "off";
      writeLibrarySort(this.libSort);
      this.renderLibrary();
    });
    this.barAdd.addEventListener("click", () => (this.libMode === "pick" ? this.addPicked() : this.startPick()));
    this.barRename.addEventListener("click", () => this.startNaming("rename"));
    this.barDelete.append(icon(Trash2), el("span", "", ""));
    this.barDelete.addEventListener("click", () => {
      if (this.libFolder === null) return;
      if (!this.libDeleteArmed) {
        this.libDeleteArmed = setTimeout(() => {
          this.libDeleteArmed = null;
          this.renderLibrary();
        }, 3000);
        this.renderLibrary();
        return;
      }
      this.disarmFolderDelete();
      const id = this.libFolder;
      this.libFolder = null;
      this.folders.remove(id); // re-renders
    });
    this.folderInput.type = "text";
    this.folderInput.placeholder = "Folder name";
    this.folderInput.maxLength = FOLDER_NAME_MAX;
    this.folderInput.autocomplete = "off";
    this.folderInput.setAttribute("aria-label", "Folder name");
    this.folderInput.addEventListener("input", () => this.renderLibrary());
    this.folderInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.saveFolderName();
      if (e.key === "Escape") {
        e.stopPropagation();
        this.libGo({});
      }
    });
    this.folderSave.addEventListener("click", () => this.saveFolderName());
    this.folderCancel.addEventListener("click", () => this.libGo({}));
    this.libItems.addEventListener("pointerdown", () => (this.libHeld = false), true);
    this.libItems.addEventListener(
      "click",
      (e) => {
        if (!this.libHeld) return;
        this.libHeld = false;
        e.stopPropagation();
        e.preventDefault();
      },
      true,
    );
    this.libBar.append(this.barMain, this.barSort, this.barTitle, this.barAdd, this.barRename, this.barDelete, this.folderInput, this.folderSave, this.folderCancel);
    // The search and User / Factory stay at the top while the list scrolls (in the sheet's sticky head).
    sh.head.append(searchRow, this.libLists);
    sh.body.append(this.libBar, this.libStatus, this.libItems);
  }

  private renderLibrary() {
    if (!this.libSheet.isOpen) return;
    const s = this.s;
    const irs = this.libKind === "irs";
    const noun = irs ? "IR" : "capture";
    const lib = s.edit.library;
    const items = this.libItemsOf();
    const norm = (x: string | null | undefined) => (x ?? "").trim().toLowerCase();
    const current = norm(irs ? s.irName.value : s.captureName.value);
    const savedNames = this.actions.edit()?.savedNames();
    const saved = norm(irs ? savedNames?.ir : savedNames?.capture);

    // Opens where the current item is: its list and folder (User when it is in neither list).
    if (!this.libLanded && items.length) {
      this.libLanded = true;
      const cur = items.find((it) => norm(it.name) === current);
      this.libList = cur?.list ?? "user";
      this.libFolder = cur ? this.folderOf(cur) : null;
    }
    if (this.libFolder !== null && !this.folders.find(this.libFolder)) this.libFolder = null; // deleted

    const target = this.libTarget;
    const targetLabel = !target ? "" : target === "own" ? "Preset's own slot" : irs ? `Slot ${target.position}` : `Bank ${target.bank} · Slot ${target.position}`;
    this.libSheet.sub.textContent = target ? `For ${targetLabel}` : "On the pedal";
    this.libSheet.card.dataset.kind = this.libKind; // captures red, IRs violet
    this.libSheet.title.textContent = irs ? "IR library" : "Capture library";
    this.libUser.dataset.active = String(this.libList === "user");
    this.libFactory.dataset.active = String(this.libList === "factory");

    const q = norm(this.libSearch.value);
    const mode = this.libMode;
    const naming = mode === "new" || mode === "rename";
    const folder = this.folders.find(this.libFolder);
    const folders = this.folders.folders(this.libKind, this.libList);
    const inList = items.filter((it) => it.list === this.libList);

    // ---- the bar
    const cancel = mode === "move" || mode === "pick";
    const mainLabel = cancel ? "Cancel" : folder ? "All" : "New folder";
    this.barMain.replaceChildren(icon(cancel ? X : folder ? ChevronLeft : FolderPlus), el("span", "", mainLabel));
    this.barMain.disabled = !naming && mode === "browse" && !folder && !items.length;
    this.barMain.hidden = naming;
    this.barTitle.hidden = naming;
    this.barSort.hidden = naming || cancel;
    const sortNext = { off: "Sort A to Z", az: "Sort Z to A", za: "The pedal's order" }[this.libSort];
    this.barSort.replaceChildren(icon(this.libSort === "za" ? ArrowDownZA : ArrowDownAZ), el("span", "", this.libSort === "za" ? "Z–A" : "A–Z"));
    this.barSort.dataset.active = String(this.libSort !== "off");
    this.barSort.title = this.barSort.ariaLabel = sortNext;
    this.barTitle.dataset.kind = cancel ? "move" : folder ? "folder" : "hint";
    this.barTitle.replaceChildren();
    if (mode === "move" && this.libMoving) this.barTitle.append(el("span", "", "Move "), el("strong", "", this.libMoving.name), el("span", "", " to:"));
    else if (mode === "pick" && folder) this.barTitle.append(el("span", "", "Add to "), el("strong", "", folder.name));
    else if (folder) this.barTitle.append(icon(FolderOpen), el("strong", "", folder.name));
    // Short: beside New folder and the sort, a phone leaves the hint a narrow column (two lines at most).
    else this.barTitle.textContent = items.length ? `Hold one to move it${HAS_HOVER ? " (or drag)" : ""}` : "";
    this.barTitle.title = this.barTitle.textContent ?? "";
    this.barRename.hidden = this.barDelete.hidden = naming || cancel || !folder;
    // + in a folder; picking: Add n (nothing ticked: off).
    const picking = mode === "pick";
    this.barAdd.hidden = naming || mode === "move" || !folder;
    this.barAdd.className = picking ? "primary ed-bar-add" : "icon-btn ed-bar-add";
    this.barAdd.replaceChildren(icon(picking ? Check : Plus), ...(picking ? [el("span", "", `Add ${this.libPicked.size}`)] : []));
    this.barAdd.disabled = picking && this.libPicked.size === 0;
    this.barAdd.title = this.barAdd.ariaLabel = picking ? `Add the ticked ${noun}s to the folder` : `Add ${noun}s to this folder`;
    (this.barDelete.lastChild as HTMLElement).textContent = this.libDeleteArmed ? "Sure?" : "";
    this.barDelete.dataset.armed = String(!!this.libDeleteArmed);
    this.barDelete.title = this.barDelete.ariaLabel = this.libDeleteArmed ? "Tap again to delete the folder" : "Delete folder";
    this.folderInput.hidden = this.folderSave.hidden = this.folderCancel.hidden = !naming;
    const problem = naming ? this.folderNameProblem() : null;
    this.folderSave.disabled = !!problem;

    // ---- rows
    const rows: HTMLElement[] = [];
    const folderRow = (f: LibraryFolder | null, onTap: () => void) => {
      const row = el("div", "ed-item ed-folder-row");
      const b = el("button", "ed-item-name");
      if (f) {
        const inside = inList.filter((it) => this.folderOf(it) === f.id);
        b.append(icon(Folder), el("span", "ed-folder-name", f.name), el("span", "ed-count", String(inside.length)));
        // The folder holding the preset's saved item: the way back to it after trying others.
        if (saved && inside.some((it) => norm(it.name) === saved)) b.append(el("span", "ed-item-saved", "saved"));
        row.dataset.current = String(mode === "move" && !!this.libMoving && this.folderOf(this.libMoving) === f.id);
        this.dropTarget(b, () => f.id);
      } else {
        b.append(icon(CornerLeftUp), el("span", "ed-folder-name", "Top of the list"));
        row.dataset.top = "true";
      }
      b.addEventListener("click", onTap);
      row.append(b);
      rows.push(row);
    };

    if (mode === "move" && this.libMoving) {
      const moving = this.libMoving;
      if (this.folderOf(moving) !== null) folderRow(null, () => this.fileInto(moving, null));
      for (const f of folders) folderRow(f, () => this.fileInto(moving, f.id));
      const add = el("div", "ed-item ed-folder-row");
      const b = el("button", "ed-item-name ed-new-folder");
      b.append(icon(FolderPlus), el("span", "ed-folder-name", "New folder…"));
      b.addEventListener("click", () => this.startNaming("new"));
      add.append(b);
      rows.push(add);
    } else if (mode === "pick" && folder) {
      // Every item of the list not in this folder (in none or another), searchable; a tap ticks it.
      const shown = inList.filter((it) => this.folderOf(it) !== folder.id && (!q || norm(it.name).includes(q)));
      if (this.libSort !== "off") shown.sort((a, b) => (this.libSort === "az" ? 1 : -1) * a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
      let letter: string | null = null;
      for (const it of shown) {
        if (this.libSort !== "off") {
          const l = sortLetter(it.name);
          if (l !== letter) rows.push(el("div", "ed-letter", l));
          letter = l;
        }
        const picked = this.libPicked.has(it.name);
        const row = el("div", "ed-item ed-pick-row");
        row.dataset.picked = String(picked);
        const b = el("button", "ed-item-name");
        b.setAttribute("aria-pressed", String(picked));
        const box = icon(picked ? SquareCheck : Square);
        box.classList.add("ed-pick-box");
        const main = el("span", "ed-item-main");
        main.append(el("span", "ed-item-label", it.name || "(no name)"));
        b.append(box, el("span", "ed-item-index", String(it.index + 1)), main);
        const fid = this.folderOf(it);
        if (fid !== null) {
          const tags = el("span", "ed-item-tags");
          tags.append(el("span", "ed-item-folder", this.folders.find(fid)?.name ?? ""));
          main.append(tags);
        }
        b.addEventListener("click", () => {
          if (this.libPicked.has(it.name)) this.libPicked.delete(it.name);
          else this.libPicked.add(it.name);
          this.renderLibrary();
        });
        row.append(b);
        rows.push(row);
      }
    } else {
      // Searching looks through the whole list, folders included; else the folders, then the items in none.
      if (!q && !folder) for (const f of folders) folderRow(f, () => this.libGo({ folder: f.id }));
      const shown = inList.filter((it) => (q ? norm(it.name).includes(q) : this.folderOf(it) === (folder?.id ?? null)));
      if (this.libSort !== "off") shown.sort((a, b) => (this.libSort === "az" ? 1 : -1) * a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
      const slot = this.actions.edit()?.captureSlotForEdit() ?? 1;
      const preview = this.actions.edit()?.capturePreview() ?? null;
      const irPreview = this.actions.edit()?.irPreview() ?? null;
      // Where each one sits on the pedal: capture banks / slots, IR slots (by name, as the pedal lists them).
      const slotNames = irs ? s.irSlots : s.captureSlots;
      const slotLabel = (i: number) => (irs ? `Slot ${i + 1}` : `Bank ${Math.floor(i / CAPTURE_SELECT_SLOTS) + 1} · Slot ${(i % CAPTURE_SELECT_SLOTS) + 1}`);
      let letter: string | null = null;
      for (const it of shown) {
        // Sorted: a letter between the groups.
        if (this.libSort !== "off") {
          const l = sortLetter(it.name);
          if (l !== letter) rows.push(el("div", "ed-letter", l));
          letter = l;
        }
        const key = `${it.list}:${it.index}`;
        const row = el("div", "ed-item");
        row.dataset.current = String(norm(it.name) === current);
        row.dataset.saved = String(!!saved && norm(it.name) === saved);
        row.dataset.selected = String(this.libSelected === key);
        const name = el("button", "ed-item-name");
        // The name and its tags share a wrapping line: tags that do not fit go under the name.
        const main = el("span", "ed-item-main");
        main.append(el("span", "ed-item-label", it.name || "(no name)"));
        name.append(el("span", "ed-item-index", String(it.index + 1)), main);
        const tags = el("span", "ed-item-tags");
        const inSlots = slotNames.flatMap((n, i) => (n && norm(n) === norm(it.name) ? [i] : []));
        const at = inSlots.map(slotLabel);
        for (const label of at.slice(0, 2)) tags.append(slotTag(label));
        if (at.length > 2) tags.append(el("span", "ed-item-slot", `+${at.length - 2}`));
        const fid = this.folderOf(it);
        if (q && fid !== null) tags.append(el("span", "ed-item-folder", this.folders.find(fid)?.name ?? ""));
        if (row.dataset.saved === "true") tags.append(el("span", "ed-item-saved", "saved"));
        if (tags.childElementCount) main.append(tags);
        // A tap opens the row; a capture plays at once (Cortex Cloud's preview, in the preset's own place) for
        // listening, until another is tapped, it is loaded, or the library closes.
        const playing = irs ? irPreview?.name === it.name : preview?.name === it.name;
        if (playing) {
          const speaker = icon(Volume2, "Playing");
          speaker.classList.add("ed-item-playing");
          name.querySelector(".ed-item-label")!.after(speaker); // right of the name
        }
        name.addEventListener("click", () => {
          const open = this.libSelected !== key;
          this.libSelected = open ? key : null;
          this.renderLibrary();
          const edit = this.edit();
          const now = irs ? edit.irPreview()?.name : edit.capturePreview()?.name;
          if (open && now !== it.name) this.run(irs ? edit.previewIr(it) : edit.previewCapture(it));
          else if (!open) this.run(() => edit.endAudition());
        });
        onHold(name, () => this.startMove(it, true), () => mode === "browse" && !naming);
        name.draggable = true;
        name.addEventListener("dragstart", (e) => {
          e.dataTransfer?.setData(DRAG_TYPE, JSON.stringify({ list: it.list, name: it.name }));
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        });
        row.append(name);
        if (this.libSelected === key) {
          // Load to: the slot playing (Cortex Cloud's "Use": an edit, the save light comes on; saved presets on that
          // slot keep theirs), or, for a capture, the preset's own (the preview kept: a Save stores it as the preset's
          // own, board 2026-10-13; the pedal leaves its light off, the app shows Save). Either closes the library.
          const load = (text: string, cls: string, go: () => Promise<void> | void) => {
            const b = el("button", cls, text);
            b.addEventListener("click", () => {
              this.run(async () => go());
              this.libLoaded = true; // the close below is the load's: what it plays stays
              this.libSheet.close();
            });
            return b;
          };
          const irSlot = irs ? this.actions.edit()?.irLoadSlot() ?? 1 : 0;
          const bank = this.s.captureBank.value ?? 1;
          // "Load to:" above the buttons; Move to folder on the same row, at its end.
          const loads = el("div", "ed-item-actions ed-load-to");
          const loadOwn = () =>
            irs
              ? load("Preset's own slot", "primary ed-load-own", () => this.edit().loadIrIntoOwn(it))
              : load("Preset's own slot", "primary ed-load-own", async () => {
                  const edit = this.edit();
                  if (edit.capturePreview()?.name !== it.name) await edit.previewCapture(it);
                  edit.keepCapturePreview();
                });
          // Opened for a slot (its swap button): that slot only. Already there: Use plays it; else it is replaced.
          const targetAbs = target && target !== "own" ? (irs ? target.position - 1 : (target.bank - 1) * CAPTURE_SELECT_SLOTS + target.position - 1) : null;
          const there = targetAbs !== null && inSlots.includes(targetAbs);
          // Already in a slot of the pedal's: Use plays it from there, nothing is written over.
          const use = target ? there : inSlots.length > 0;
          loads.append(el("span", "ed-label", use ? "Use:" : target && target !== "own" ? "Replace:" : "Load to:"));
          if (target === "own") loads.append(loadOwn());
          else if (target) {
            const { bank: b, position: n } = target;
            const playing = irs
              ? this.s.cabOn.value === true && this.s.cabSlot.value === n
              : !preview && this.s.captureOn.value === true && bank === b && this.s.captureSlot.value === n;
            const btn = there
              ? load(targetLabel, "primary", () => (irs ? this.edit().selectIrSlot(n) : this.edit().selectCapture(b, n)))
              : load(targetLabel, "primary", () => this.edit().pickFromLibrary(it, this.libKind, { bank: b, position: n }));
            btn.disabled = there && playing; // playing already
            loads.append(btn);
          } else if (use)
            for (const i of inSlots.slice(0, 3)) {
              const b = Math.floor(i / CAPTURE_SELECT_SLOTS) + 1;
              const n = (i % CAPTURE_SELECT_SLOTS) + 1;
              const now = irs
                ? this.s.cabOn.value === true && this.s.cabSlot.value === i + 1
                : !preview && this.s.captureOn.value === true && bank === b && this.s.captureSlot.value === n;
              const btn = load(slotLabel(i), "primary", () => (irs ? this.edit().selectIrSlot(i + 1) : this.edit().selectCapture(b, n)));
              btn.disabled = now; // playing already
              loads.append(btn);
            }
          else {
            // Free (the library button): where it goes is chosen over the library, the slot playing first.
            const choose = el("button", "primary ed-load-choose", irs ? "Slot…" : "Bank / Slot…");
            choose.addEventListener("click", () => this.openSlotChooser(it, irs ? { bank: 1, position: irSlot } : { bank, position: slot }));
            loads.append(choose, loadOwn());
          }
          const move = el("button", "ed-move");
          move.append(icon(FolderInput), el("span", "", "Move to folder"));
          move.addEventListener("click", () => this.startMove(it));
          loads.append(move);
          row.append(loads);
          const hint = target === "own"
            ? irs
              ? `Preset's own slot: this preset alone.`
              : `Preset's own slot: this preset alone, Save keeps it.`
            : target
            ? there
              ? `In ${targetLabel} already: Use plays it, nothing is written over.`
              : `Replaces what ${targetLabel} holds: saved presets on it keep theirs.`
            : use
            ? `On the pedal already: Use plays it from its slot, nothing is written over.`
            : irs
            ? `Slot…: pick the slot (saved presets on it keep theirs). Preset's own slot: this preset alone.`
            : `Bank / Slot…: pick the slot (saved presets on it keep theirs). Preset's own slot: this preset alone, Save keeps it.`;
          row.append(el("p", "hint", hint));
        }
        rows.push(row);
      }
    }
    this.libItems.replaceChildren(...rows);

    // ---- the status line (always there: it changes text, never the layout)
    const files = rows.filter((r) => r.classList.contains("ed-item") && !r.classList.contains("ed-folder-row")).length;
    const loading = lib.loading !== null;
    const count = (n: number) => `${n} ${noun}${n === 1 ? "" : "s"}`;
    let msg: string;
    let tone: "muted" | "warn" | "ok" = "muted";
    if (naming) {
      msg = (this.folderInput.value && problem) || (mode === "new" && this.libMoving ? `${this.libMoving.name} goes into the new folder` : "Folders are kept in this browser");
      tone = this.folderInput.value && problem ? "warn" : "muted";
    } else if (lib.error) {
      msg = lib.error;
      tone = "warn";
    } else if (loading && !items.length) msg = `Reading the pedal's ${noun}s…`;
    else if (mode === "move") msg = folders.length ? "Tap a folder" : "No folders yet: make one";
    else if (mode === "pick")
      msg = !files
        ? q
          ? "No match"
          : `Every ${noun} is in this folder already`
        : this.libPicked.size
          ? `${count(this.libPicked.size)} ticked: Add puts them in (out of any other folder)`
          : `Tap the ${noun}s to add`;
    else if (q) msg = files ? `${count(files)} found` : "No match";
    else if (folder) msg = files ? count(files) : `Empty: hold a ${noun} to move it here`;
    else if (!inList.length) msg = `No ${this.libList} ${noun}s`;
    else msg = loading ? "Updating…" : `${count(inList.length)}${folders.length ? ` · ${folders.length} folder${folders.length === 1 ? "" : "s"}` : ""}`;
    setMsg(this.libStatus, msg, tone);
  }

  // -------------------------------------------------------------------------
  // Presets list
  // -------------------------------------------------------------------------

  private readonly listBody = el("div", "ed-list ed-presets");
  private listRows: { root: HTMLElement; label: Required<PresetLabelEls>; name: HTMLElement; more: HTMLButtonElement }[] = [];

  openPresetList() {
    this.listSheet.open();
    this.renderList();
    // The card scrolls (not the page): the active preset in its middle.
    const row = this.listRows[this.s.activePreset.value ?? -1]?.root;
    const card = this.listSheet.card;
    if (row) card.scrollTop = Math.max(0, row.offsetTop - card.clientHeight / 2 + row.offsetHeight / 2);
  }

  private buildList() {
    const sh = this.listSheet;
    sh.sub.textContent = "On the pedal";
    sh.title.textContent = "Presets";
    for (let i = 0; i < PRESET_COUNT; i++) {
      const root = el("div", "ed-item ed-preset-row");
      const pick = el("button", "ed-item-name");
      // The label as on the strip: slot letter in its colour, the footswitch badge in its own.
      const label = presetLabelEls();
      const index = el("span", "ed-item-index");
      index.append(label.bank, label.slot, label.num);
      const name = el("span", "ed-preset-name");
      pick.append(index, name, label.fs);
      pick.addEventListener("click", () => {
        const s = this.store.get();
        // An empty slot, as Cortex Cloud's "Empty" tile: create it (in Edit mode).
        if (!(s.presetNames.value[i] ?? "").trim() && this.canEdit) {
          this.openPreset(i);
          return;
        }
        if (!s.writesEnabled || s.connection !== "connected") {
          this.actions.toast(new Error("Turn on Control to switch presets"));
          return;
        }
        this.run(this.actions.selectPreset(i));
      });
      const more = iconButton(Ellipsis, "Manage preset", "ghost icon-btn ed-more");
      more.addEventListener("click", () => this.openPreset(i));
      root.append(pick, more);
      this.listRows.push({ root, label, name, more });
      this.listBody.append(root);
    }
    sh.body.append(this.listBody);
  }

  private renderList() {
    if (!this.listSheet.isOpen) return;
    const s = this.s;
    const banked = labelHasBanks(s.labelStyle);
    this.listRows.forEach((r, i) => {
      renderPresetLabel(r.label, i, s, { footswitch: true });
      const name = s.presetNames.value[i] ?? "";
      r.name.textContent = name || "Empty";
      r.root.dataset.empty = String(!name);
      r.root.dataset.active = String(s.activePreset.value === i);
      r.root.dataset.bankStart = String(banked && i > 0 && i % s.presetsPerBank === 0);
      r.more.hidden = !this.canEdit;
    });
  }

  // -------------------------------------------------------------------------

  private render(s: GigState) {
    const prev = this.s;
    this.s = s;
    // Lost the link, control mode or the setting: the edit sheets close (the list stays; it only reads).
    if (!(s.connection === "connected" && s.writesEnabled && s.editing)) {
      for (const sh of [this.slotSheet, this.fxSheet, this.srcSheet, this.gateSheet, this.presetSheet, this.libSheet]) sh.close();
    }
    // The pedal saved an unnamed preset: ask for a name, as Cortex Cloud does.
    if (s.edit.preset.nameNew !== null && prev.edit.preset.nameNew !== s.edit.preset.nameNew && !this.presetSheet.isOpen) this.openPreset(s.edit.preset.nameNew);
    // A finished delete or rename leaves the sheet open with the answer; a delete leaves nothing to rename.
    this.renderFx();
    this.renderSource();
    this.renderGate();
    this.renderPreset();
    this.renderSlotChooser();
    if (
      prev.edit.library !== s.edit.library ||
      prev.edit.capturePreview !== s.edit.capturePreview ||
      prev.edit.irPreview !== s.edit.irPreview ||
      prev.cabSlot.value !== s.cabSlot.value ||
      prev.cabOn.value !== s.cabOn.value ||
      prev.captureName.value !== s.captureName.value ||
      prev.irName.value !== s.irName.value ||
      prev.activePreset.value !== s.activePreset.value ||
      prev.captureBank.value !== s.captureBank.value ||
      prev.captureSlot.value !== s.captureSlot.value ||
      prev.captureOn.value !== s.captureOn.value
    ) {
      this.renderLibrary(); // the rows' buttons and hints name the preview, the slot and on / off
    }
    this.renderList();
  }
}

