/**
 * Preset-row font sizing. Instead of shrinking to the current preset (which
 * makes the type jump between presets), size for the worst case on this
 * pedal: the widest bank/slot label the current settings can produce and the
 * widest preset name in the loaded list. The result is one stable font size
 * per screen width that guarantees every preset fits on one line.
 *
 * Widths are measured at a reference font size (100 px); the row's actual
 * font size scales them linearly. Pure function for testability; the DOM
 * measuring lives in the view.
 */

export const REFERENCE_PX = 100;

/** Multipliers mirrored from styles.css (.preset-row / .slot-label / .preset-name). */
export const ROW_LAYOUT = {
  /** Preset name font-size relative to the row's font-size. */
  nameScale: 0.8,
  /** Gaps between label and name, in em of the row font-size (gap + name margin). */
  gapsEm: 0.35 + 0.25,
  /** Extra slack for the source tag / rounding, in em. */
  slackEm: 0.15,
} as const;

export interface FitInput {
  /** Width available for the row, px (container inner width minus padding). */
  availableWidth: number;
  /** Widest label width measured at REFERENCE_PX, px. */
  labelWidthRef: number;
  /** Widest name width measured at REFERENCE_PX (at the name's own scale already applied? no: raw), px. */
  nameWidthRef: number;
  /** Upper bound from height, px (e.g. 12 % of the viewport height). */
  maxPx: number;
  /** Lower bound so the row never becomes unreadable, px. */
  minPx?: number;
}

/** Largest row font-size (px) at which label + gaps + name fit `availableWidth`. */
export function fitPresetRowFont(input: FitInput): number {
  const minPx = input.minPx ?? 24;
  const perPx =
    input.labelWidthRef / REFERENCE_PX +
    (input.nameWidthRef / REFERENCE_PX) * ROW_LAYOUT.nameScale +
    ROW_LAYOUT.gapsEm +
    ROW_LAYOUT.slackEm;
  if (!(perPx > 0) || !(input.availableWidth > 0)) return input.maxPx;
  const fit = input.availableWidth / perPx;
  return Math.max(minPx, Math.min(input.maxPx, Math.floor(fit)));
}
