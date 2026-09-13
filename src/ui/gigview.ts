/**
 * The gig view screen. Vanilla DOM, built once, updated from store changes.
 * Designed for a pedalboard-mounted tablet read from standing height:
 * contrast and size over density.
 */
import { FX_SLOTS, PRESETS_PER_BANK_CHOICES, presetLabel, presetLabelParts, type FxSlot, type PresetLabelStyle } from "../protocol/frames";
import type { GigState } from "../state/store";
import type { Store } from "../state/store";
import type { LogLine } from "../transport/types";
import { LogOut, Maximize, Menu, Minimize, Power, RefreshCw, ScrollText, Settings, createElement as lucideElement } from "lucide";
import { REFERENCE_PX, fitPresetRowFont } from "./fit";
import { PRESET_COUNT } from "../protocol/frames";

export interface GigViewActions {
  connect(acceptAll?: boolean): Promise<void>;
  connectMock(): Promise<void>;
  disconnect(): Promise<void>;
  refresh(): Promise<void>;
  refreshNames(): Promise<void>;
  toggleFx(slot: FxSlot): Promise<void>;
  toggleGate(): Promise<void>;
  toggleCab(): Promise<void>;
  toggleCapture(): Promise<void>;
  nextPreset(): Promise<void>;
  prevPreset(): Promise<void>;
  simulateDrop?(): void;
  setWritesEnabled(enabled: boolean): void;
  reconnectNow(): void;
  setSettings(patch: { presetsPerBank?: number; labelStyle?: PresetLabelStyle; showPresetNumber?: boolean }): void;
}

export interface GigViewOptions {
  bluetoothAvailable: boolean;
  showMockButton: boolean;
  openConsole?: boolean;
}

const TILE_LABELS: Record<FxSlot | "gate" | "cab", string> = {
  gate: "GATE",
  pre1: "PRE 1",
  pre2: "PRE 2",
  post1: "POST 1",
  post2: "POST 2",
  post3: "POST 3",
  cab: "CAB",
};

/** Cab/IR is shown on the capture/IR line instead of as a tile, to leave room for the FX blocks. */
const TILE_ORDER: (FxSlot | "gate" | "cab")[] = ["gate", "pre1", "pre2", "post1", "post2", "post3"];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** What the big name line says while there is no preset to show. */
export function placeholderFor(s: GigState): string {
  switch (s.connection) {
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "disconnected":
      return "—";
  }
  switch (s.syncPhase) {
    case "metadata":
      return "Loading presets…";
    case "state":
      return "Reading pedal…";
    case "error":
      return "Sync failed";
    default:
      return "Tap a footswitch to sync";
  }
}

/** "Wah/Filter" → "wah-filter", used as the data-cat attribute matched by CSS. */
export function categorySlug(category: string): string {
  return category.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export class GigView {
  private readonly root: HTMLElement;
  private readonly dot = el("span", "dot");
  private readonly statusText = el("span", "status-text", "Disconnected");
  private readonly slotEl = el("div", "preset-row");
  private readonly slotLabel = el("span", "slot-label");
  private readonly slotBank = el("span", "slot-bank", "—");
  private readonly slotSlot = el("span", "slot-slot", "");
  private readonly slotNum = el("span", "slot-num", "");
  private readonly sourceTag = el("span", "src");
  private readonly nameEl = el("div", "preset-name empty", "—");
  private readonly numberCheck = el("input", "menu-check");
  private presetEl: HTMLElement | null = null;
  private fitKey = "";
  private readonly rowResize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this.fitPresetRow()) : null;
  private readonly subEl = el("div", "preset-sub");
  private readonly captureEl = el("span", "capture sub-name");
  private readonly irEl = el("span", "ir sub-name");
  private subLabels: HTMLElement[] = [];
  private readonly captureState = el("span", "sub-state");
  private readonly irState = el("span", "sub-state");
  private readonly tiles = new Map<
    FxSlot | "gate" | "cab",
    { root: HTMLButtonElement; name: HTMLElement; category: HTMLElement }
  >();
  private readonly footerInfo = el("span", "footer-info");
  private readonly nav = el("div", "nav");
  private readonly consoleEl = el("div", "console");
  private readonly consoleBody = el("div", "c-body");
  private readonly overlay = el("div", "overlay connect open");
  private readonly overlayErr = el("div", "err");
  private readonly connectBtn = el("button", "primary", "Connect Nano Cortex");
  private readonly connectAllBtn = el("button", "", "Show all devices");
  private readonly mockBtn = el("button", "", "Demo mode (no device)");
  private readonly disconnectBtn = el("button", "ghost", "Disconnect");
  private readonly fullscreenBtn = el("button", "ghost icon-btn", "");
  private readonly consoleBtn = el("button", "ghost", "Log");
  private readonly refreshBtn = el("button", "ghost", "Refresh");
  private readonly writesBtn = el("button", "ghost", "");
  private readonly writesState = el("span", "btn-state");
  private readonly exitDemoBtn = el("button", "ghost", "");
  private readonly menuBtn = el("button", "ghost icon-btn", "");
  private readonly menu = el("div", "menu");
  private readonly menuInfo = el("div", "menu-info");
  private readonly bankSelect = el("select", "menu-select");
  private readonly styleSelect = el("select", "menu-select");
  private readonly settingsBtn = el("button", "menu-item", "Settings");
  private readonly settingsOverlay = el("div", "overlay settings");
  private readonly settingsPreview = el("p", "hint");
  private readonly reconnectBtn = el("button", "primary", "Reconnect now");
  private renderedLogCount = 0;
  private wakeLock: WakeLockSentinel | null = null;
  private lastState: GigState | null = null;

  constructor(
    root: HTMLElement,
    private readonly store: Store,
    private readonly actions: GigViewActions,
    private readonly opts: GigViewOptions,
  ) {
    this.root = root;
    this.build();
    store.subscribe((s) => this.render(s));
    if (opts.openConsole) this.consoleEl.classList.add("open");
  }

  private build() {
    const root = this.root;
    root.replaceChildren();

    // Top bar -----------------------------------------------------------
    const top = el("div", "topbar");
    const status = el("div", "status");
    status.append(this.dot, this.statusText);
    const actions = el("div", "actions");
    this.refreshBtn.addEventListener(
      "click",
      () => void this.actions.refresh().catch((e) => this.toast(e)),
    );
    this.fullscreenBtn.addEventListener("click", () => this.toggleFullscreen());
    this.consoleBtn.addEventListener("click", () =>
      this.consoleEl.classList.toggle("open"),
    );
    this.disconnectBtn.addEventListener(
      "click",
      () => void this.actions.disconnect(),
    );
    this.writesBtn.title =
      "Control mode: tap tiles to toggle blocks, ◀ ▶ to switch presets. Changes go to the real pedal.";
    this.writesState.append(lucideElement(Power, { "stroke-width": 2.5, "aria-hidden": "true" }));
    this.writesState.dataset.on = "false";
    this.writesBtn.append(el("span", "", "Control"), this.writesState);
    this.writesBtn.addEventListener("click", () =>
      this.actions.setWritesEnabled(!this.store.get().writesEnabled),
    );
    this.reconnectBtn.hidden = true;
    this.reconnectBtn.addEventListener("click", () =>
      this.actions.reconnectNow(),
    );

    // Fullscreen: icon only.
    this.fullscreenBtn.title = "Fullscreen";
    this.fullscreenBtn.setAttribute("aria-label", "Fullscreen");
    this.fullscreenBtn.append(lucideElement(Maximize, { "aria-hidden": "true" }));
    document.addEventListener("fullscreenchange", () => {
      this.fullscreenBtn.replaceChildren(
        lucideElement(document.fullscreenElement ? Minimize : Maximize, { "aria-hidden": "true" }),
      );
    });

    // Burger menu: refresh / log / disconnect.
    this.menuBtn.title = "Menu";
    this.menuBtn.setAttribute("aria-label", "Menu");
    this.menuBtn.setAttribute("aria-haspopup", "true");
    this.menuBtn.append(lucideElement(Menu, { "aria-hidden": "true" }));
    this.menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.menu.classList.toggle("open");
    });
    // Items: icon on the left, label, separators between; device info at the bottom.
    const items: [HTMLButtonElement, typeof Settings, string][] = [
      [this.settingsBtn, Settings, "Settings"],
      [this.refreshBtn, RefreshCw, "Refresh"],
      [this.consoleBtn, ScrollText, "Log"],
      [this.disconnectBtn, LogOut, "Disconnect"],
    ];
    items.forEach(([b, icon, label], i) => {
      b.className = "menu-item";
      b.replaceChildren(lucideElement(icon, { "aria-hidden": "true" }), el("span", "", label));
      b.addEventListener("click", () => this.menu.classList.remove("open"));
      if (i > 0) this.menu.append(el("div", "menu-sep"));
      this.menu.append(b);
    });
    this.disconnectBtn.classList.add("danger");
    this.settingsBtn.addEventListener("click", () => this.settingsOverlay.classList.add("open"));
    this.menuInfo.hidden = true;
    this.menu.append(el("div", "menu-sep strong"), this.menuInfo);
    document.addEventListener("click", (e) => {
      if (!this.menu.contains(e.target as Node)) this.menu.classList.remove("open");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.menu.classList.remove("open");
    });
    const menuWrap = el("div", "menu-wrap");
    menuWrap.append(this.menuBtn, this.menu);

    // Demo mode only: a clear way back to the connect screen (Disconnect alone reads as an error).
    this.exitDemoBtn.hidden = true;
    this.exitDemoBtn.title = "Leave demo mode and return to the connect screen";
    this.exitDemoBtn.append(lucideElement(LogOut, { "aria-hidden": "true" }), el("span", "", "Exit demo"));
    this.exitDemoBtn.addEventListener("click", () => void this.actions.disconnect());
    actions.append(this.reconnectBtn, this.exitDemoBtn, this.writesBtn, this.fullscreenBtn, menuWrap);
    top.append(status, actions);

    // Preset area ------------------------------------------------------
    const preset = el("div", "preset");
    this.slotLabel.append(this.slotBank, this.slotSlot, this.slotNum);
    this.slotEl.append(this.slotLabel, this.nameEl, this.sourceTag);
    const capLbl = el("span", "lbl", "capture");
    const irLbl = el("span", "lbl", "cab / ir");
    for (const st of [this.captureState, this.irState]) {
      st.append(lucideElement(Power, { "stroke-width": 2.5, "aria-hidden": "true" }));
      st.dataset.on = "unknown";
    }
    // The indicator lives inside the bordered label, after its text. In control mode the label is a toggle.
    capLbl.append(this.captureState);
    irLbl.append(this.irState);
    capLbl.addEventListener("click", () => this.onLabelTap("capture"));
    irLbl.addEventListener("click", () => this.onLabelTap("cab"));
    this.subLabels = [capLbl, irLbl];
    const capWrap = el("span", "sub-item");
    capWrap.append(capLbl, this.captureEl);
    const irWrap = el("span", "sub-item");
    irWrap.append(irLbl, this.irEl);
    this.subEl.append(capWrap, el("span", "sep", "•"), irWrap);
    preset.append(this.slotEl, this.subEl);
    this.presetEl = preset;
    this.rowResize?.observe(preset);
    window.addEventListener("resize", () => this.fitPresetRow());

    // Blocks: gate line, separator, then the five FX tiles (pre | post) -----
    const blocks = el("div", "blocks");
    const tiles = el("div", "tiles");
    for (const key of TILE_ORDER) {
      const tile = el("button", "tile");
      tile.dataset.on = "unknown";
      tile.setAttribute("aria-label", TILE_LABELS[key]);
      tile.dataset.key = key;
      const name = el("div", "t-name", key === "gate" ? "" : TILE_LABELS[key]);
      const category = el("div", "t-cat", "");
      tile.dataset.cat = key === "gate" || key === "cab" ? key : "none";
      tile.addEventListener("click", () => this.onTileTap(key));
      this.tiles.set(key, { root: tile, name, category });

      if (key === "gate") {
        // Own line: "GATE" text followed by a small power button.
        tile.classList.add("gate-btn");
        const icon = lucideElement(Power, { "stroke-width": 2.5, "aria-hidden": "true" });
        icon.classList.add("t-icon");
        tile.append(icon);
        const gateRow = el("div", "gate-row");
        gateRow.append(el("div", "t-slot", TILE_LABELS[key]), tile);
        blocks.append(gateRow, el("div", "hsep"));
        continue;
      }

      // Category is the primary line (large), the model name the secondary one (small).
      tile.append(category, name);
      const wrap = el("div", "tile-wrap");
      wrap.append(el("div", "t-slot", TILE_LABELS[key]), tile);
      if (key === "post1") tiles.append(el("div", "vsep")); // pre | post divider
      tiles.append(wrap);
    }
    blocks.append(tiles);

    // Footer ----------------------------------------------------------
    const footer = el("div", "footer");
    const prev = el("button", "", "◀ Prev");
    const next = el("button", "", "Next ▶");
    prev.addEventListener(
      "click",
      () => void this.actions.prevPreset().catch((e) => this.toast(e)),
    );
    next.addEventListener(
      "click",
      () => void this.actions.nextPreset().catch((e) => this.toast(e)),
    );
    this.nav.append(prev, next);
    footer.append(this.nav, el("span", "spacer"), this.footerInfo);

    // Console --------------------------------------------------------
    const head = el("div", "c-head");
    const title = el("span", "", "hex log (c304 tx / c305 rx)");
    const clear = el("button", "", "clear");
    clear.addEventListener("click", () => {
      this.store.patch({ log: [] });
      this.consoleBody.replaceChildren();
      this.renderedLogCount = 0;
    });
    const copy = el("button", "", "copy");
    copy.addEventListener("click", () => {
      const text = this.store
        .get()
        .log.map(
          (l) =>
            `${fmtTime(l.at)} ${l.dir.toUpperCase()} ${l.text}${l.hex ? " " + l.hex : ""}`,
        )
        .join("\n");
      void navigator.clipboard?.writeText(text);
    });
    const names = el("button", "", "reload names");
    names.addEventListener(
      "click",
      () => void this.actions.refreshNames().catch((e) => this.toast(e)),
    );
    const close = el("button", "", "close");
    close.addEventListener("click", () =>
      this.consoleEl.classList.remove("open"),
    );
    head.append(title, el("span", "spacer"), names, copy, clear, close);
    if (this.actions.simulateDrop) {
      const drop = el("button", "", "simulate drop");
      drop.addEventListener("click", () => this.actions.simulateDrop?.());
      head.insertBefore(drop, names);
    }
    this.consoleEl.append(head, this.consoleBody);

    // Settings overlay --------------------------------------------------
    {
      const card = el("div", "card");
      card.append(el("h1", "", "Settings"));
      card.append(
        el(
          "p",
          "",
          "The pedal has no banks. These only change the bank/slot label so it matches your MIDI controller.",
        ),
      );
      const bankRow = el("label", "setting-row");
      bankRow.append(el("span", "", "Presets per bank"));
      for (const n of PRESETS_PER_BANK_CHOICES) {
        const opt = document.createElement("option");
        opt.value = String(n);
        opt.textContent = String(n);
        this.bankSelect.append(opt);
      }
      this.bankSelect.addEventListener("change", () =>
        this.actions.setSettings({ presetsPerBank: Number(this.bankSelect.value) }),
      );
      bankRow.append(this.bankSelect);

      const styleRow = el("label", "setting-row");
      styleRow.append(el("span", "", "Label style"));
      for (const [value, text] of [
        ["number-letter", "1B — bank number, preset letter (Mvave Chocolate)"],
        ["letter-number", "A2 — bank letter, preset number (Nano Cortex)"],
      ] as const) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = text;
        this.styleSelect.append(opt);
      }
      this.styleSelect.addEventListener("change", () =>
        this.actions.setSettings({ labelStyle: this.styleSelect.value as PresetLabelStyle }),
      );
      styleRow.append(this.styleSelect);

      const numberRow = el("label", "setting-row");
      numberRow.append(el("span", "", "Show pedal preset number (1–64)"));
      this.numberCheck.type = "checkbox";
      this.numberCheck.addEventListener("change", () =>
        this.actions.setSettings({ showPresetNumber: this.numberCheck.checked }),
      );
      numberRow.append(this.numberCheck);

      const close = el("button", "primary", "Done");
      close.addEventListener("click", () => this.settingsOverlay.classList.remove("open"));
      card.append(bankRow, styleRow, numberRow, this.settingsPreview, close);
      this.settingsOverlay.append(card);
      this.settingsOverlay.addEventListener("click", (e) => {
        if (e.target === this.settingsOverlay) this.settingsOverlay.classList.remove("open");
      });
    }

    // Connect overlay -----------------------------------------------
    const card = el("div", "card");
    card.append(el("h1", "", "NanoGig"));
    card.append(
      el(
        "p",
        "",
        "Unofficial gig view for the Neural DSP Nano Cortex: live preset name and block states over Bluetooth LE. Read-only by default. The app replaces Cortex Cloud while connected — disconnect it first.",
      ),
    );
    const row = el("div", "row");
    this.connectBtn.disabled = !this.opts.bluetoothAvailable;
    this.connectAllBtn.disabled = !this.opts.bluetoothAvailable;
    this.connectBtn.addEventListener("click", () => this.doConnect(false));
    this.connectAllBtn.addEventListener("click", () => this.doConnect(true));
    this.mockBtn.addEventListener("click", () => {
      this.overlayErr.textContent = "";
      void this.actions
        .connectMock()
        .catch(
          (e) =>
            (this.overlayErr.textContent = String((e as Error).message ?? e)),
        );
    });
    row.append(this.connectBtn, this.connectAllBtn);
    if (this.opts.showMockButton) row.append(this.mockBtn);
    card.append(row);
    if (!this.opts.bluetoothAvailable) {
      card.append(
        el(
          "p",
          "err",
          "Web Bluetooth is not available here. Use Chrome or Edge on desktop, or the Bluefy browser on iPad (Safari has no Web Bluetooth).",
        ),
      );
    }
    card.append(this.overlayErr);
    card.append(
      el(
        "p",
        "hint",
        "Not affiliated with or endorsed by Neural DSP; \"Nano Cortex\" is their trademark. Everything shown is decoded from a reverse-engineered protocol verified on NanOS 2.2.x and may be wrong. Control mode writes to your pedal: back up your presets first. After a reload the app reconnects to the last pedal by itself.",
      ),
    );
    this.overlay.append(card);

    root.append(top, preset, blocks, footer, this.consoleEl, this.settingsOverlay, this.overlay);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.requestWakeLock();
    });
  }

  private doConnect(acceptAll: boolean) {
    this.overlayErr.textContent = "";
    this.connectBtn.disabled = true;
    this.connectAllBtn.disabled = true;
    void this.actions
      .connect(acceptAll)
      .catch((e) => {
        this.overlayErr.textContent = String((e as Error).message ?? e);
      })
      .finally(() => {
        this.connectBtn.disabled = false;
        this.connectAllBtn.disabled = false;
      });
  }

  private onTileTap(key: FxSlot | "gate" | "cab") {
    const s = this.store.get();
    if (!s.writesEnabled) {
      this.store.appendLog({
        at: Date.now(),
        dir: "warn",
        text: "Tile tap ignored: control mode is off (use the Control button or ?writes=1)",
      });
      return;
    }
    const run =
      key === "gate"
        ? this.actions.toggleGate()
        : key === "cab"
          ? (this.actions.toggleCab?.() ?? Promise.resolve())
          : this.actions.toggleFx(key);
    void run.catch((e) => this.toast(e));
  }

  private onLabelTap(which: "capture" | "cab") {
    const s = this.store.get();
    if (!s.writesEnabled || s.connection !== "connected") return;
    const run = which === "capture" ? this.actions.toggleCapture() : this.actions.toggleCab();
    void run.catch((e) => this.toast(e));
  }

  private toast(err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    this.store.appendLog({ at: Date.now(), dir: "error", text: msg });
    this.footerInfo.textContent = msg;
  }

  private async toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (err) {
      this.toast(err);
    }
  }

  async requestWakeLock(): Promise<void> {
    if (!("wakeLock" in navigator)) return;
    if (this.store.get().connection !== "connected") return;
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
      this.wakeLock.addEventListener("release", () => (this.wakeLock = null));
    } catch {
      /* denied or unsupported: ignore */
    }
  }

  /**
   * Size the preset row for the worst case (widest label under the current
   * settings + widest preset name on the pedal) so every preset fits on one
   * line at a stable size. Re-measures only when width, names or settings change.
   */
  private fitPresetRow(state: GigState | null = this.lastState) {
    const s = state;
    const container = this.presetEl;
    if (!s || !container || !container.isConnected) return;
    const cs = getComputedStyle(container);
    const available = container.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0");
    if (!(available > 0)) return;
    const maxPx = Math.max(24, Math.round(window.innerHeight * 0.12));
    const names = s.presetNames.value.filter(Boolean);
    const key = `${Math.round(available)}|${maxPx}|${s.presetsPerBank}|${s.labelStyle}|${s.showPresetNumber ? 1 : 0}|${names.join("\u0000")}`;
    if (key === this.fitKey) return;
    this.fitKey = key;

    // Measure at the reference size with the row's real fonts, in one layout pass.
    const probe = el("div", "fit-probe");
    const rowCs = getComputedStyle(this.slotEl);
    const mk = (text: string, cls: string) => {
      const span = el("span", cls, text);
      span.style.fontFamily = rowCs.fontFamily;
      return span;
    };
    const labelSpans: HTMLElement[] = [];
    for (let i = 0; i < PRESET_COUNT; i++) {
      const parts = presetLabelParts(i, { presetsPerBank: s.presetsPerBank, style: s.labelStyle });
      if (!parts) continue;
      const span = mk(`${parts.bank}${parts.slot}${s.showPresetNumber ? `·${i + 1}` : ""}`, "slot-label");
      if (s.showPresetNumber) {
        // The number is 0.4em: approximate by wrapping it in its own span with the real class.
        span.replaceChildren(el("span", "", `${parts.bank}${parts.slot}`), el("span", "slot-num", `·${i + 1}`));
      }
      labelSpans.push(span);
    }
    const nameCandidates = names.length ? names : [this.nameEl.textContent ?? ""];
    const nameSpans = nameCandidates.map((n) => mk(n, "preset-name"));
    probe.append(...labelSpans, ...nameSpans);
    container.append(probe);
    const labelWidthRef = Math.max(0, ...labelSpans.map((e) => e.getBoundingClientRect().width));
    // preset-name is 0.8em inside the probe (probe is REFERENCE_PX): normalise back to 1em.
    const nameWidthRef = Math.max(0, ...nameSpans.map((e) => e.getBoundingClientRect().width)) / 0.8;
    probe.remove();
    if (!(labelWidthRef > 0)) return; // no layout engine (tests): keep the CSS size

    const px = fitPresetRowFont({ availableWidth: available, labelWidthRef, nameWidthRef, maxPx });
    this.slotEl.style.fontSize = `${px}px`;
  }

  private render(s: GigState) {
    this.lastState = s;
    // Connection ----------------------------------------------------
    this.dot.dataset.state = s.connection;
    this.statusText.textContent =
      s.connection === "connected"
        ? "Connected"
        : s.connection === "connecting"
          ? "Connecting…"
          : s.connection === "reconnecting"
            ? "Reconnecting…"
            : "Disconnected";
    this.menuInfo.textContent = [s.deviceName, s.firmware.value ? `NanOS ${s.firmware.value}` : null]
      .filter(Boolean)
      .join(" · ");
    this.menuInfo.hidden = this.menuInfo.textContent === "";
    this.overlay.classList.toggle("open", s.connection === "disconnected");
    this.disconnectBtn.hidden = s.connection === "disconnected";
    this.refreshBtn.hidden = s.connection !== "connected";
    this.menuBtn.hidden = s.connection === "disconnected";
    this.writesState.dataset.on = s.writesEnabled ? "true" : "false";
    this.writesBtn.classList.toggle("warn", s.writesEnabled);
    this.writesBtn.setAttribute("aria-pressed", s.writesEnabled ? "true" : "false");
    this.writesBtn.hidden = s.connection === "disconnected";
    const demo = s.transportName === "mock" && s.connection !== "disconnected";
    this.exitDemoBtn.hidden = !demo;
    this.statusText.textContent = demo ? `${this.statusText.textContent} · demo` : this.statusText.textContent;
    this.reconnectBtn.hidden = s.connection !== "reconnecting";
    this.nav.classList.toggle(
      "visible",
      s.writesEnabled && s.connection === "connected",
    );
    if (s.connection === "connected" && !this.wakeLock)
      void this.requestWakeLock();

    // Preset --------------------------------------------------------
    const idx = s.activePreset.value;
    const label = idx === null ? null : presetLabelParts(idx, { presetsPerBank: s.presetsPerBank, style: s.labelStyle });
    this.slotBank.textContent = label ? label.bank : "—";
    this.slotSlot.textContent = label ? label.slot : "";
    this.slotSlot.dataset.slot = label ? String(label.slotIndex) : "";
    this.slotNum.textContent = label && s.showPresetNumber && idx !== null ? `·${idx + 1}` : "";
    this.slotNum.hidden = this.slotNum.textContent === "";
    if (this.numberCheck.checked !== s.showPresetNumber) this.numberCheck.checked = s.showPresetNumber;
    if (this.bankSelect.value !== String(s.presetsPerBank)) this.bankSelect.value = String(s.presetsPerBank);
    if (this.styleSelect.value !== s.labelStyle) this.styleSelect.value = s.labelStyle;
    {
      const opts = { presetsPerBank: s.presetsPerBank, style: s.labelStyle };
      this.settingsPreview.textContent = `Preview: preset 1 → ${presetLabel(0, opts)}, preset ${s.presetsPerBank + 2} → ${presetLabel(s.presetsPerBank + 1, opts)}, preset 64 → ${presetLabel(63, opts)}`;
    }
    this.sourceTag.textContent =
      s.activePreset.source === "inferred"
        ? "inferred"
        : s.activePreset.source === "optimistic"
          ? "sending"
          : s.activePreset.source === "event"
            ? "live"
            : "";
    this.sourceTag.dataset.source = s.activePreset.source;
    this.sourceTag.hidden = this.sourceTag.textContent === "";
    const name = idx === null ? "" : (s.presetNames.value[idx] ?? "");
    const shown = idx === null ? placeholderFor(s) : name || `Preset ${idx + 1}`;
    this.nameEl.classList.toggle("empty", idx === null || !name);
    if (this.nameEl.textContent !== shown) this.nameEl.textContent = shown;
    this.fitPresetRow(s);
    this.captureEl.textContent = s.captureName.value || "—";
    this.irEl.textContent = s.irName.value || "—";
    const onAttr = (v: boolean | null) => (v === null ? "unknown" : v ? "true" : "false");
    for (const lbl of this.subLabels) lbl.classList.toggle("writable", s.writesEnabled && s.connection === "connected");
    this.captureState.dataset.on = onAttr(s.captureOn.value);
    this.irState.dataset.on = onAttr(s.cabOn.value);

    // Tiles --------------------------------------------------------
    for (const key of TILE_ORDER) {
      const t = this.tiles.get(key)!;
      const on: boolean | null =
        key === "gate"
          ? s.gateOn.value
          : key === "cab"
            ? s.cabOn.value
            : s.fxOn.value[key];
      t.root.dataset.on = on === null ? "unknown" : on ? "true" : "false";
      if (key !== "gate" && key !== "cab") {
        const model = s.fxModels.value[key];
        t.name.textContent = model ? model.name : on === null ? TILE_LABELS[key] : "Empty";
        t.category.textContent = model?.known ? model.category : "";
        t.root.classList.toggle("empty", !model && on !== null);
        // Category drives the tile colour (see --fx-* in styles.css).
        t.root.dataset.cat = model?.known ? categorySlug(model.category) : model ? "unknown" : "none";
      }
      const writable =
        s.writesEnabled &&
        s.connection === "connected" &&
        on !== null &&
        true;
      t.root.classList.toggle("writable", writable);
      t.root.setAttribute("aria-disabled", writable ? "false" : "true");
      t.root.style.pointerEvents = writable ? "auto" : "none";
    }

    // Footer -------------------------------------------------------
    const parts: string[] = [];
    if (s.lastStateSyncAt) parts.push(`state ${fmtTime(s.lastStateSyncAt)}`);
    if (s.lastEventAt) parts.push(`event ${fmtTime(s.lastEventAt)}`);
    if (s.lastError) parts.push(s.lastError);
    this.footerInfo.textContent = parts.join("  ·  ");

    // Console ------------------------------------------------------
    this.renderLog(s.log);
  }

  private renderLog(log: LogLine[]) {
    if (log.length < this.renderedLogCount) {
      this.consoleBody.replaceChildren();
      this.renderedLogCount = 0;
    }
    const frag = document.createDocumentFragment();
    for (let i = this.renderedLogCount; i < log.length; i++) {
      const l = log[i]!;
      const line = el("div", "line");
      line.dataset.dir = l.dir;
      const ts = el("span", "ts", fmtTime(l.at));
      line.append(
        ts,
        `${l.dir.toUpperCase().padEnd(5)} ${l.text}${l.hex ? "  " + l.hex : ""}`,
      );
      frag.append(line);
    }
    if (frag.childNodes.length) {
      this.consoleBody.append(frag);
      while (this.consoleBody.childNodes.length > 400)
        this.consoleBody.removeChild(this.consoleBody.firstChild!);
      this.consoleBody.scrollTop = this.consoleBody.scrollHeight;
    }
    this.renderedLogCount = log.length;
  }

  /** Test hook. */
  get state(): GigState | null {
    return this.lastState;
  }
}
