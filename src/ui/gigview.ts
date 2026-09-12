/**
 * The gig view screen. Vanilla DOM, built once, updated from store changes.
 * Designed for a pedalboard-mounted tablet read from standing height:
 * contrast and size over density.
 */
import { FX_SLOTS, presetLabel, type FxSlot } from "../protocol/frames";
import type { GigState } from "../state/store";
import type { Store } from "../state/store";
import type { LogLine } from "../transport/types";
import { Maximize, Menu, Minimize, Power, createElement as lucideElement } from "lucide";

export interface GigViewActions {
  connect(acceptAll?: boolean): Promise<void>;
  connectMock(): Promise<void>;
  disconnect(): Promise<void>;
  refresh(): Promise<void>;
  refreshNames(): Promise<void>;
  toggleFx(slot: FxSlot): Promise<void>;
  toggleGate(): Promise<void>;
  toggleCab?(): Promise<void>;
  nextPreset(): Promise<void>;
  prevPreset(): Promise<void>;
  simulateDrop?(): void;
  setWritesEnabled(enabled: boolean): void;
  reconnectNow(): void;
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
  private readonly writesBadge = el("span", "badge warn", "control on");
  private readonly slotEl = el("div", "preset-slot");
  private readonly slotLabel = el("span", "slot-label", "—");
  private readonly sourceTag = el("span", "src");
  private readonly nameEl = el("div", "preset-name empty", "—");
  private readonly subEl = el("div", "preset-sub");
  private readonly captureEl = el("span", "capture");
  private readonly irEl = el("span", "ir");
  private readonly tiles = new Map<
    FxSlot | "gate" | "cab",
    { root: HTMLButtonElement; name: HTMLElement; category: HTMLElement }
  >();
  private readonly footerInfo = el("span", "footer-info");
  private readonly nav = el("div", "nav");
  private readonly consoleEl = el("div", "console");
  private readonly consoleBody = el("div", "c-body");
  private readonly overlay = el("div", "overlay open");
  private readonly overlayErr = el("div", "err");
  private readonly connectBtn = el("button", "primary", "Connect Nano Cortex");
  private readonly connectAllBtn = el("button", "", "Show all devices");
  private readonly mockBtn = el("button", "", "Demo mode (no device)");
  private readonly disconnectBtn = el("button", "ghost", "Disconnect");
  private readonly fullscreenBtn = el("button", "ghost icon-btn", "");
  private readonly consoleBtn = el("button", "ghost", "Log");
  private readonly refreshBtn = el("button", "ghost", "Refresh");
  private readonly writesBtn = el("button", "ghost", "Control: off");
  private readonly menuBtn = el("button", "ghost icon-btn", "");
  private readonly menu = el("div", "menu");
  private readonly menuInfo = el("div", "menu-info");
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
    this.writesBadge.hidden = true;
    this.writesBadge.title =
      "Tap tiles to toggle blocks; ◀ ▶ switch presets. Writes go to real hardware.";
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
    for (const b of [this.refreshBtn, this.consoleBtn, this.disconnectBtn]) {
      b.className = "menu-item";
      b.addEventListener("click", () => this.menu.classList.remove("open"));
    }
    this.menuInfo.hidden = true;
    this.menu.append(this.menuInfo, this.refreshBtn, this.consoleBtn, this.disconnectBtn);
    document.addEventListener("click", (e) => {
      if (!this.menu.contains(e.target as Node)) this.menu.classList.remove("open");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.menu.classList.remove("open");
    });
    const menuWrap = el("div", "menu-wrap");
    menuWrap.append(this.menuBtn, this.menu);

    actions.append(this.reconnectBtn, this.writesBtn, this.fullscreenBtn, menuWrap);
    top.append(status, this.writesBadge, actions);

    // Preset area ------------------------------------------------------
    const preset = el("div", "preset");
    this.slotEl.append(this.slotLabel, this.sourceTag);
    const capLbl = el("span", "lbl", "capture");
    const irLbl = el("span", "lbl", "cab / ir");
    const capWrap = el("span");
    capWrap.append(capLbl, this.captureEl);
    const irWrap = el("span");
    irWrap.append(irLbl, this.irEl);
    this.subEl.append(capWrap, el("span", "sep", "•"), irWrap);
    preset.append(this.slotEl, this.nameEl, this.subEl);

    // Tiles -----------------------------------------------------------
    const tiles = el("div", "tiles");
    for (const key of TILE_ORDER) {
      const tile = el("button", "tile");
      tile.dataset.on = "unknown";
      tile.setAttribute("aria-label", TILE_LABELS[key]);
      tile.dataset.key = key;
      const wrap = el("div", "tile-wrap");
      const slot = el("div", "t-slot", TILE_LABELS[key]);
      const name = el("div", "t-name", key === "gate" ? "" : TILE_LABELS[key]);
      const category = el("div", "t-cat", "");
      tile.dataset.cat = key === "gate" || key === "cab" ? key : "none";
      if (key === "gate") {
        // Narrow tile: a power icon carries the state, the slot label above says "GATE".
        const icon = lucideElement(Power, { "stroke-width": 2.5, "aria-hidden": "true" });
        icon.classList.add("t-icon");
        tile.append(icon);
      } else {
        // Category is the primary line (large), the model name the secondary one (small).
        tile.append(category, name);
      }
      tile.addEventListener("click", () => this.onTileTap(key));
      wrap.append(slot, tile);
      tiles.append(wrap);
      this.tiles.set(key, { root: tile, name, category });
    }

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

    // Connect overlay -----------------------------------------------
    const card = el("div", "card");
    card.append(el("h1", "", "Nano Cortex Gig View"));
    card.append(
      el(
        "p",
        "",
        "Live preset name and block states read from the Nano Cortex over Bluetooth LE. Read-only by default. The app replaces Cortex Cloud while connected — disconnect it first.",
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
        "Everything shown is provisional: decoded from a reverse-engineered protocol verified on NanOS 2.2.x. After a reload the app reconnects to the last pedal by itself when Chrome remembers the permission. Add ?mock=1 for demo mode, ?writes=1 to enable tile taps / preset buttons, ?debug=1 to open the hex log.",
      ),
    );
    this.overlay.append(card);

    root.append(top, preset, tiles, footer, this.consoleEl, this.overlay);
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
    this.writesBadge.hidden = !s.writesEnabled;
    this.writesBtn.textContent = s.writesEnabled ? "Control: ON" : "Control: off";
    this.writesBtn.classList.toggle("warn", s.writesEnabled);
    this.writesBtn.hidden = s.connection === "disconnected";
    this.reconnectBtn.hidden = s.connection !== "reconnecting";
    this.nav.classList.toggle(
      "visible",
      s.writesEnabled && s.connection === "connected",
    );
    if (s.connection === "connected" && !this.wakeLock)
      void this.requestWakeLock();

    // Preset --------------------------------------------------------
    const idx = s.activePreset.value;
    this.slotLabel.textContent =
      idx === null ? "— —" : `${presetLabel(idx)}  ·  ${idx + 1}`;
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
    this.captureEl.textContent = s.captureName.value || "—";
    const cabOff = s.cabOn.value === false;
    this.irEl.textContent =
      (s.irName.value || "—") + (cabOff && s.irName.value ? " (off)" : "");

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
        (key !== "cab" || !!this.actions.toggleCab);
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
