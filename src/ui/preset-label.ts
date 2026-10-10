/**
 * A preset's label, the same wherever one is shown (the preset slot, the strip, the presets list): bank, slot in
 * its colour (`.slot-slot[data-slot]`), the pedal's number, and the footswitch it sits on (`.fs-badge[data-fs]`).
 */
import type { FootswitchAssignments } from "../protocol/decode";
import { presetLabelParts, type PresetLabelParts } from "../protocol/frames";
import type { GigState } from "../state/store";

export type FootswitchName = "IA" | "IB" | "IIA" | "IIB";

export function footswitchFor(index: number, fs: FootswitchAssignments | null): FootswitchName | null {
  if (!fs) return null;
  if (fs.ia === index) return "IA";
  if (fs.ib === index) return "IB";
  if (fs.iia === index) return "IIA";
  if (fs.iib === index) return "IIB";
  return null;
}

export interface PresetLabelEls {
  bank: HTMLElement;
  slot: HTMLElement;
  num?: HTMLElement;
  fs?: HTMLElement;
}

type LabelState = Pick<GigState, "presetsPerBank" | "labelStyle" | "showPresetNumber" | "showFootswitches" | "footswitches">;

/** The label's elements, made with the classes the styles colour. */
export function presetLabelEls(bankClass = "p-bank"): Required<PresetLabelEls> {
  const make = (cls: string) => {
    const n = document.createElement("span");
    n.className = cls;
    return n;
  };
  const fs = make("fs-badge");
  fs.hidden = true;
  return { bank: make(bankClass), slot: make("slot-slot"), num: make("p-num"), fs };
}

/**
 * Fill a label for preset `index` (null: none, "—"). The number and the footswitch follow the settings unless
 * `always` shows the footswitch regardless (the presets list, where it is the point).
 */
export function renderPresetLabel(els: PresetLabelEls, index: number | null, s: LabelState, always: { footswitch?: boolean } = {}): PresetLabelParts | null {
  const parts = index === null ? null : presetLabelParts(index, { presetsPerBank: s.presetsPerBank, style: s.labelStyle });
  els.bank.textContent = parts ? parts.bank : "—";
  els.slot.textContent = parts ? parts.slot : "";
  els.slot.dataset.slot = parts ? String(parts.slotIndex) : "";
  if (els.num) {
    els.num.textContent = parts && index !== null && s.showPresetNumber ? `·${index + 1}` : "";
    els.num.hidden = els.num.textContent === "";
  }
  if (els.fs) {
    const fs = index !== null && (always.footswitch || s.showFootswitches) ? footswitchFor(index, s.footswitches.value) : null;
    els.fs.textContent = fs ?? "";
    els.fs.dataset.fs = fs ? fs.toLowerCase() : "";
    els.fs.hidden = !fs;
  }
  return parts;
}
