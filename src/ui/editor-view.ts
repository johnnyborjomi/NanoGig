/**
 * Edit sheets over the gig view (Settings → Editing, on top of control mode). Ported from the NanoGig Screen
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
  CAPTURE_OWN_SLOT,
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
import { PRESET_COUNT, presetLabel, type FxSlot } from "../protocol/frames";
import type { GigState, Store } from "../state/store";
import type { EditController } from "../sync/editor";
import { IrFolders } from "./ir-folders";
import {
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderPlus,
  Library,
  Power,
  Search,
  Trash2,
  X,
  createElement as lucideElement,
} from "lucide";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(i: Parameters<typeof lucideElement>[0], label?: string): SVGElement {
  const svg = lucideElement(i, { "stroke-width": 2.25, "aria-hidden": "true" }) as SVGElement;
  if (label) svg.setAttribute("aria-label", label);
  return svg;
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
const slug = (category: string) => category.toLowerCase().replace(/[^a-z0-9]+/g, "-");

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
      this.onInput(v);
    });
    if (onReset) {
      this.value.title = "Double-tap to reset";
      this.value.classList.add("resettable");
      this.value.addEventListener("dblclick", onReset);
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
    }
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
  onClose: () => void = () => {};

  constructor(className: string) {
    this.card.classList.add(className);
    const close = iconButton(X, "Close");
    close.addEventListener("click", () => this.close());
    const titles = el("div", "sheet-titles");
    titles.append(this.sub, this.title);
    this.head.append(titles, close);
    this.card.append(this.head, this.body);
    this.overlay.append(this.card);
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });
  }

  get isOpen() {
    return this.overlay.classList.contains("open");
  }

  open() {
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
  private s: GigState;

  constructor(
    private readonly store: Store,
    private readonly actions: EditorViewActions,
    private readonly folders = new IrFolders(),
  ) {
    this.s = store.get();
    this.overlays = [this.fxSheet, this.srcSheet, this.gateSheet, this.presetSheet, this.libSheet, this.listSheet].map((x) => x.overlay);
    this.buildFx();
    this.buildSource();
    this.buildGate();
    this.buildPreset();
    this.buildLibrary();
    this.buildList();
    this.folders.onChange(() => this.renderLibrary());
    store.subscribe((s) => this.render(s));
  }

  /** Editing is possible: connected, control mode and the Editing setting on. */
  get canEdit(): boolean {
    const s = this.store.get();
    return s.connection === "connected" && s.writesEnabled && s.editing && this.actions.edit() !== null;
  }

  /** The sheets close with Escape; true when one was open. */
  closeTop(): boolean {
    for (const sh of [this.libSheet, this.presetSheet, this.fxSheet, this.srcSheet, this.gateSheet, this.listSheet]) {
      if (sh.isOpen) {
        sh.close();
        return true;
      }
    }
    return false;
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
  private readonly fxStatus = el("p", "ed-status");
  private readonly fxRetry = el("button", "", "Read again");
  private readonly fxModelBtn = el("button", "ed-model-btn");
  private readonly fxModels = el("div", "ed-models");
  private readonly fxParams = el("div", "ed-params");
  private fxParamsKey = "";
  private fxSliders: { index: number; set: (n: number | null, enabled: boolean) => void }[] = [];

  openFx(slot: FxSlot) {
    if (!this.canEdit) return;
    this.fxSlot = slot;
    this.fxModels.hidden = true;
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
      this.fxModelsKey = "";
      this.renderFxModels();
    });
    this.fxRetry.addEventListener("click", () => this.run(() => this.edit().retryFx()));
    const top = el("div", "ed-row");
    top.append(this.fxModelBtn, this.fxPower);
    const status = el("div", "ed-status-row");
    status.append(this.fxStatus, this.fxRetry);
    sh.body.append(top, this.fxModels, status, this.fxParams);
  }

  private fxModelsKey = "";

  private renderFxModels() {
    const slot = this.fxSlot;
    if (!slot || this.fxModels.hidden) return;
    const current = this.s.fxModels.value[slot]?.id;
    // Rebuilt only when it shows something else: a chip replaced mid-tap loses the tap.
    const key = `${slot}:${current}`;
    if (key === this.fxModelsKey && this.fxModels.childElementCount) return;
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
        b.dataset.active = String(m.id === current);
        b.addEventListener("click", () => {
          this.fxModels.hidden = true;
          this.run(this.edit().setFxModel(slot, m.type));
        });
        row.append(b);
      }
      g.append(row);
      this.fxModels.append(g);
    }
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
    const status = fx?.status ?? "loading";
    const msg: Record<string, string> = {
      loading: "Reading the parameters…",
      ready: "",
      off: "The block is off. Turn it on to see and change its parameters (the pedal is never asked about a bypassed block).",
      empty: "No model in this slot.",
      unknown: "No parameter table for this model.",
      error: "The pedal did not answer.",
    };
    this.fxStatus.textContent = msg[status] ?? "";
    this.fxStatus.hidden = !this.fxStatus.textContent;
    this.fxRetry.hidden = status !== "error";
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
    const ready = status === "ready" && on === true;
    for (const r of this.fxSliders) r.set(fx?.values?.[r.index] ?? null, ready);
    this.fxParams.dataset.dim = String(!ready);
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
  private readonly capSlot = el("span", "ed-slot");
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
  private readonly irSlot = el("span", "ed-slot");
  private readonly irPower = el("button", "ed-power");
  private readonly irStatus = el("p", "ed-status");
  private readonly irRetry = el("button", "", "Read again");
  private readonly irSliders = new Map<CabParam, Slider>();
  private readonly irPhase = el("button", "ed-chip", "Ø Phase inverted");
  private readonly irMicBox = el("div", "ed-mic");
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

  private stepRow(slotEl: HTMLElement, onStep: (d: number) => void, power: HTMLButtonElement, onPower: () => void): HTMLElement {
    const row = el("div", "ed-row ed-step");
    const prev = iconButton(ChevronLeft, "Previous slot", "ed-step-btn");
    const next = iconButton(ChevronRight, "Next slot", "ed-step-btn");
    prev.addEventListener("click", () => onStep(-1));
    next.addEventListener("click", () => onStep(1));
    power.append(icon(Power), el("span", "", ""));
    power.addEventListener("click", onPower);
    row.append(prev, slotEl, next, power);
    return row;
  }

  private buildSource() {
    const sh = this.srcSheet;
    sh.title.textContent = "Amp & cab";
    sh.onClose = () => this.actions.edit()?.closeIr();
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
    sh.head.after(this.tabs);

    const capLib = el("button", "ed-lib-btn");
    capLib.append(icon(Library), el("span", "", "Capture library"));
    capLib.addEventListener("click", () => this.openLibrary("captures"));
    const capHint = el(
      "p",
      "hint",
      "◀ ▶ step through the pedal's capture slots 1–5; a library capture goes into the slot this preset plays, and every preset on that slot hears it. Save on the pedal to keep it. Double-tap the volume to reset it to 0 dB.",
    );
    this.capPane.append(
      this.capName,
      this.stepRow(this.capSlot, (d) => this.run(this.edit().stepCapture(d)), this.capPower, () => this.run(this.edit().setCaptureOn(!this.s.captureOn.value))),
      this.capVolume.root,
      capLib,
      capHint,
    );

    const irLib = el("button", "ed-lib-btn");
    irLib.append(icon(Library), el("span", "", "IR library"));
    irLib.addEventListener("click", () => this.openLibrary("irs"));
    this.irRetry.addEventListener("click", () => this.run(() => this.edit().retryIr()));
    this.irPhase.addEventListener("click", () => {
      const inv = this.s.edit.ir?.settings?.phaseInverted ?? false;
      this.run(this.edit().setIrPhase(!inv));
    });
    const status = el("div", "ed-status-row");
    status.append(this.irStatus, this.irRetry);
    const sliders = el("div", "ed-params");
    for (const p of ["level", "highPass", "lowPass"] as CabParam[]) {
      const s = new Slider(CAB_LABELS[p], 1000, (v) => this.run(() => this.edit().setIrParam(p, v / 1000)), (v) => cabValueText(p, v / 1000));
      this.irSliders.set(p, s);
      sliders.append(s.root);
    }
    const phaseRow = el("div", "ed-row");
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
    this.irPane.append(
      this.irName,
      this.stepRow(this.irSlot, (d) => this.run(this.edit().stepIr(d)), this.irPower, () => this.run(this.edit().setIrOn(!this.s.cabOn.value))),
      status,
      sliders,
      phaseRow,
      this.irMicBox,
      irLib,
    );
    sh.body.append(this.capPane, this.irPane);
  }

  private renderSource() {
    if (!this.srcSheet.isOpen) return;
    const s = this.s;
    const capture = this.srcTab === "capture";
    this.capTab.dataset.active = String(capture);
    this.irTab.dataset.active = String(!capture);
    this.capPane.hidden = !capture;
    this.irPane.hidden = capture;
    this.srcSheet.sub.textContent = presetLabel(s.activePreset.value ?? -1, { presetsPerBank: s.presetsPerBank, style: s.labelStyle }) + " · " + (s.presetNames.value[s.activePreset.value ?? -1] || "");
    if (capture) {
      const on = s.captureOn.value;
      const slot = s.captureSlot.value ?? 0;
      this.capName.textContent = s.captureName.value || "—";
      this.capName.dataset.off = String(on === false);
      this.capSlot.textContent = !on ? "Off" : slot === CAPTURE_OWN_SLOT ? "Preset's own" : slot ? `Slot ${slot}` : "—";
      this.capPower.dataset.on = String(on === true);
      (this.capPower.lastChild as HTMLElement).textContent = on ? "On" : "Off";
      this.capVolume.set(s.captureVolume.value, on !== null);
      return;
    }
    const on = s.cabOn.value;
    const ir = s.edit.ir;
    const cs = ir?.status === "ready" ? ir.settings : (ir?.settings ?? null);
    this.irName.textContent = s.irName.value || "—";
    this.irName.dataset.off = String(on === false);
    const slot = s.cabSlot.value;
    this.irSlot.textContent = !on ? "Off" : slot === 6 ? "Preset's own" : slot ? `Slot ${slot}` : "—";
    this.irPower.dataset.on = String(on === true);
    (this.irPower.lastChild as HTMLElement).textContent = on ? "On" : "Off";
    const status = ir?.status ?? "loading";
    this.irStatus.textContent =
      status === "loading" ? "Reading the IR settings…" : status === "off" ? "The IR is off: turn it on to see its settings." : status === "error" ? "The pedal did not answer." : "";
    this.irStatus.hidden = !this.irStatus.textContent;
    this.irRetry.hidden = status !== "error";
    const ready = status === "ready" && !!cs && on === true;
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
    const row = el("div", "ed-row");
    row.append(this.gatePower);
    sh.body.append(row, this.gateThreshold.root, el("p", "hint", "A live edit, like Cortex Cloud's slider: save on the pedal to keep it."));
  }

  private renderGate() {
    if (!this.gateSheet.isOpen) return;
    const on = this.s.gateOn.value;
    this.gatePower.dataset.on = String(on === true);
    (this.gatePower.lastChild as HTMLElement).textContent = on ? "On" : "Off";
    this.gateThreshold.set(this.s.gateThreshold.value, true);
  }

  // -------------------------------------------------------------------------
  // Preset sheet
  // -------------------------------------------------------------------------

  private presetIndex: number | null = null;
  private readonly nameInput = el("input", "ed-input");
  private readonly nameProblem = el("p", "ed-problem");
  private readonly nameBtn = el("button", "primary");
  private readonly presetResult = el("p", "ed-status");
  private readonly fsRow = el("div", "ed-chips");
  private readonly deleteBtn = el("button", "warn ed-delete");
  private deleteArmed = false;
  private readonly presetIntro = el("p", "hint");

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
    this.nameInput.addEventListener("input", () => this.renderPreset());
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
    const nameRow = el("div", "ed-row");
    nameRow.append(this.nameInput, this.nameBtn);
    sh.body.append(
      this.presetIntro,
      nameRow,
      this.nameProblem,
      this.presetResult,
      el("h2", "", "Pedal footswitch"),
      el("p", "hint", "Put this preset on one of the Nano's footswitches (IA, IB, IIA, IIB)."),
      this.fsRow,
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
    this.presetSheet.sub.textContent = `${presetLabel(i, { presetsPerBank: s.presetsPerBank, style: s.labelStyle })} · preset ${i + 1}`;
    this.presetSheet.title.textContent = name || "Empty";
    this.presetIntro.textContent =
      mode === "create"
        ? s.edit.preset.nameNew === i
          ? "The pedal saved this preset without a name. Name it so it shows in the lists."
          : `An empty slot. Naming it stores ${active ? "this preset's sound" : `the sound playing now (preset ${(s.activePreset.value ?? 0) + 1})`} here, like Cortex Cloud's “create preset”.`
        : "Renames are stored on the pedal at once (4–31 characters, no two presets with the same name).";
    this.nameBtn.textContent = mode === "create" ? "Save here" : "Rename";
    const busy = s.edit.preset.busy;
    const problem = this.actions.edit()?.nameProblem(i, this.nameInput.value) ?? null;
    const unchanged = this.nameInput.value === name;
    this.nameProblem.textContent = unchanged ? "" : (problem ?? "");
    this.nameBtn.disabled = !!busy || !!problem || unchanged;
    const res = s.edit.preset.result;
    this.presetResult.textContent = busy ? "Waiting for the pedal…" : res && res.index === i && Date.now() - res.at < 8000 ? (res.ok ? `${res.kind === "delete" ? "Deleted" : "Saved"}.` : res.message) : "";
    this.presetResult.dataset.ok = String(!busy && !!res?.ok);
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
    this.deleteBtn.disabled = !!busy || mode === "create";
    (this.deleteBtn.lastChild as HTMLElement).textContent = this.deleteArmed ? "Tap again to delete" : "Delete preset";
    this.deleteBtn.dataset.armed = String(this.deleteArmed);
  }

  // -------------------------------------------------------------------------
  // Library sheet (captures / IRs), with the IR folders
  // -------------------------------------------------------------------------

  private libKind: LibraryKind = "captures";
  private libList: LibraryList = "factory";
  private libFolder: number | "all" = "all";
  private libSelected: string | null = null;
  private libFiling: string | null = null;
  private readonly libSearch = el("input", "ed-input");
  private readonly libLists = el("div", "ed-tabs");
  private readonly libFactory = el("button", "ed-tab", "Factory");
  private readonly libUser = el("button", "ed-tab", "User");
  private readonly libFolders = el("div", "ed-chips ed-folders");
  private readonly libFolderEdit = el("div", "ed-row ed-folder-edit");
  private readonly folderInput = el("input", "ed-input");
  private readonly libStatus = el("p", "ed-status");
  private readonly libItems = el("div", "ed-list");
  private folderEditing: number | "new" | null = null;

  openLibrary(kind: LibraryKind) {
    if (!this.canEdit) return;
    this.libKind = kind;
    this.libSelected = null;
    this.libFiling = null;
    this.libFolder = "all";
    this.folderEditing = null;
    this.libSearch.value = "";
    this.libSheet.open();
    this.run(this.edit().loadLibrary(kind));
    this.renderLibrary();
  }

  private buildLibrary() {
    const sh = this.libSheet;
    const searchRow = el("label", "ed-search");
    searchRow.append(icon(Search), this.libSearch);
    this.libSearch.type = "search";
    this.libSearch.placeholder = "Search";
    this.libSearch.addEventListener("input", () => this.renderLibrary());
    this.libFactory.addEventListener("click", () => {
      this.libList = "factory";
      this.libFolder = "all";
      this.renderLibrary();
    });
    this.libUser.addEventListener("click", () => {
      this.libList = "user";
      this.libFolder = "all";
      this.renderLibrary();
    });
    this.libLists.append(this.libFactory, this.libUser);
    this.folderInput.type = "text";
    this.folderInput.placeholder = "Folder name";
    this.folderInput.maxLength = 24;
    const save = el("button", "primary", "Save");
    const del = iconButton(Trash2, "Delete folder", "warn icon-btn");
    const cancel = el("button", "ghost", "Cancel");
    save.addEventListener("click", () => {
      try {
        if (this.folderEditing === "new") this.libFolder = this.folders.create(this.libList, this.folderInput.value).id;
        else if (typeof this.folderEditing === "number") this.folders.rename(this.folderEditing, this.folderInput.value);
        this.folderEditing = null;
        this.renderLibrary();
      } catch (e) {
        this.actions.toast(e);
      }
    });
    this.folderInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save.click();
    });
    del.addEventListener("click", () => {
      if (typeof this.folderEditing === "number") this.folders.remove(this.folderEditing);
      this.folderEditing = null;
      this.libFolder = "all";
      this.renderLibrary();
    });
    cancel.addEventListener("click", () => {
      this.folderEditing = null;
      this.renderLibrary();
    });
    this.libFolderEdit.append(this.folderInput, save, del, cancel);
    sh.body.append(searchRow, this.libLists, this.libFolders, this.libFolderEdit, this.libStatus, this.libItems);
  }

  private renderLibrary() {
    if (!this.libSheet.isOpen) return;
    const s = this.s;
    const irs = this.libKind === "irs";
    const lib = s.edit.library;
    const items = (irs ? lib.irs : lib.captures) ?? [];
    this.libSheet.sub.textContent = "On the pedal";
    this.libSheet.title.textContent = irs ? "IR library" : "Capture library";
    this.libFactory.dataset.active = String(this.libList === "factory");
    this.libUser.dataset.active = String(this.libList === "user");
    const loading = lib.loading !== null;
    this.libStatus.textContent = lib.error ? lib.error : loading && !items.length ? "Reading the library from the pedal…" : loading ? "Updating…" : !items.length ? "Nothing here." : "";
    this.libStatus.hidden = !this.libStatus.textContent;

    // Folders (IRs only).
    this.libFolders.hidden = !irs;
    this.libFolderEdit.hidden = !irs || this.folderEditing === null;
    (this.libFolderEdit.children[2] as HTMLElement).hidden = this.folderEditing === "new";
    if (irs) {
      const chips: HTMLElement[] = [];
      const chip = (label: string, id: number | "all") => {
        const b = el("button", "ed-chip");
        if (id !== "all") b.append(icon(Folder));
        b.append(el("span", "", label));
        b.dataset.active = String(this.libFolder === id);
        b.addEventListener("click", () => {
          if (this.libFolder === id && id !== "all") {
            // A second tap on the open folder edits it.
            this.folderEditing = id;
            this.folderInput.value = label;
          } else {
            this.libFolder = id;
            this.folderEditing = null;
          }
          this.renderLibrary();
        });
        chips.push(b);
      };
      chip("All", "all");
      for (const f of this.folders.folders(this.libList)) chip(f.name, f.id);
      const add = iconButton(FolderPlus, "New folder", "ed-chip");
      add.addEventListener("click", () => {
        this.folderEditing = "new";
        this.folderInput.value = "";
        this.renderLibrary();
        this.folderInput.focus();
      });
      chips.push(add);
      this.libFolders.replaceChildren(...chips);
    }

    const q = this.libSearch.value.trim().toLowerCase();
    const current = (irs ? s.irName.value : s.captureName.value)?.trim().toLowerCase() ?? "";
    const savedNames = this.actions.edit()?.savedNames();
    const saved = (irs ? savedNames?.ir : savedNames?.capture)?.trim().toLowerCase() ?? "";
    const shown = items.filter(
      (it) =>
        it.list === this.libList &&
        (!q || it.name.toLowerCase().includes(q)) &&
        (!irs || this.libFolder === "all" || this.folders.folderOf(it.list, it.name) === this.libFolder),
    );
    const slot = this.actions.edit()?.captureSlotForEdit() ?? 1;
    this.libItems.replaceChildren(
      ...shown.map((it) => {
        const key = `${it.list}:${it.index}`;
        const row = el("div", "ed-item");
        row.dataset.current = String(it.name.trim().toLowerCase() === current);
        row.dataset.saved = String(!!saved && it.name.trim().toLowerCase() === saved);
        row.dataset.selected = String(this.libSelected === key);
        const name = el("button", "ed-item-name");
        name.append(el("span", "ed-item-index", String(it.index + 1)), el("span", "", it.name || "(no name)"));
        if (irs) {
          const fid = this.folders.folderOf(it.list, it.name);
          const f = fid !== null ? this.folders.folders(it.list).find((x) => x.id === fid) : null;
          if (f && this.libFolder === "all") name.append(el("span", "ed-item-folder", f.name));
        }
        if (row.dataset.saved === "true") name.append(el("span", "ed-item-saved", "saved"));
        name.addEventListener("click", () => {
          this.libSelected = this.libSelected === key ? null : key;
          this.libFiling = null;
          this.renderLibrary();
        });
        row.append(name);
        if (this.libSelected === key) {
          const actions = el("div", "ed-item-actions");
          const load = el("button", "primary", irs ? "Load into this preset" : `Load into slot ${slot}`);
          load.addEventListener("click", () => {
            this.libSelected = null;
            this.run(this.edit().pickFromLibrary(it as LibraryItem, this.libKind));
            this.renderLibrary();
          });
          actions.append(load);
          if (irs) {
            const file = el("button", "", "Folder…");
            file.addEventListener("click", () => {
              this.libFiling = this.libFiling === key ? null : key;
              this.renderLibrary();
            });
            actions.append(file);
          }
          row.append(actions);
          if (irs && this.libFiling === key) {
            const pick = el("div", "ed-chips");
            const cur = this.folders.folderOf(it.list, it.name);
            const opt = (label: string, id: number | null) => {
              const b = el("button", "ed-chip", label);
              b.dataset.active = String(cur === id);
              b.addEventListener("click", () => {
                this.folders.file(it.list, it.name, id);
                this.libFiling = null;
              });
              pick.append(b);
            };
            opt("No folder", null);
            for (const f of this.folders.folders(it.list)) opt(f.name, f.id);
            if (!this.folders.folders(it.list).length) pick.append(el("span", "hint", "Make a folder with the + above first."));
            row.append(pick);
          }
          if (!irs) row.append(el("p", "hint", `Every preset that plays capture slot ${slot} hears it. Save on the pedal to keep it in this preset.`));
        }
        return row;
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Presets list
  // -------------------------------------------------------------------------

  private readonly listBody = el("div", "ed-list ed-presets");
  private listRows: { root: HTMLElement; label: HTMLElement; name: HTMLElement; fs: HTMLElement; more: HTMLButtonElement }[] = [];

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
      const label = el("span", "ed-item-index");
      const name = el("span", "ed-preset-name");
      const fs = el("span", "fs-badge");
      pick.append(label, name, fs);
      pick.addEventListener("click", () => {
        const s = this.store.get();
        // An empty slot, as Cortex Cloud's "Empty" tile: create it (with Editing on).
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
      this.listRows.push({ root, label, name, fs, more });
      this.listBody.append(root);
    }
    sh.body.append(this.listBody);
  }

  private renderList() {
    if (!this.listSheet.isOpen) return;
    const s = this.s;
    const fs = s.footswitches.value;
    this.listRows.forEach((r, i) => {
      r.label.textContent = presetLabel(i, { presetsPerBank: s.presetsPerBank, style: s.labelStyle });
      const name = s.presetNames.value[i] ?? "";
      r.name.textContent = name || "Empty";
      r.root.dataset.empty = String(!name);
      r.root.dataset.active = String(s.activePreset.value === i);
      const badge = fs ? (fs.ia === i ? "IA" : fs.ib === i ? "IB" : fs.iia === i ? "IIA" : fs.iib === i ? "IIB" : "") : "";
      r.fs.textContent = badge;
      r.fs.hidden = !badge;
      r.more.hidden = !this.canEdit;
    });
  }

  // -------------------------------------------------------------------------

  private render(s: GigState) {
    const prev = this.s;
    this.s = s;
    // Lost the link, control mode or the setting: the edit sheets close (the list stays; it only reads).
    if (!(s.connection === "connected" && s.writesEnabled && s.editing)) {
      for (const sh of [this.fxSheet, this.srcSheet, this.gateSheet, this.presetSheet, this.libSheet]) sh.close();
    }
    // The pedal saved an unnamed preset: ask for a name, as Cortex Cloud does.
    if (s.edit.preset.nameNew !== null && prev.edit.preset.nameNew !== s.edit.preset.nameNew && !this.presetSheet.isOpen) this.openPreset(s.edit.preset.nameNew);
    // A finished delete or rename leaves the sheet open with the answer; a delete leaves nothing to rename.
    this.renderFx();
    this.renderSource();
    this.renderGate();
    this.renderPreset();
    if (prev.edit.library !== s.edit.library || prev.captureName.value !== s.captureName.value || prev.irName.value !== s.irName.value || prev.activePreset.value !== s.activePreset.value) this.renderLibrary();
    this.renderList();
  }
}

