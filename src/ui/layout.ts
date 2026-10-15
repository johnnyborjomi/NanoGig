/**
 * Gig view layout by the window's shape, not by the device or its orientation alone.
 *
 * "row": the five FX tiles side by side (landscape, and any window wide enough for five tiles, such as an
 * iPad held either way). "stack": the tiles one under the other, for a window both narrow and taller than
 * wide — a phone held upright, or an iPad's narrow split-view / Slide Over window. A tablet turned upright
 * keeps the row layout: at 600 px and up five tiles still read well.
 */
export type GigLayout = "row" | "stack";

export const STACK_QUERY = "(orientation: portrait) and (max-width: 599px)";

/** Presets in the strip under the tiles: fewer in the stack layout, where the buttons share a phone's width. */
export const STRIP_COUNT: Record<GigLayout, number> = { row: 7, stack: 5 };

/** Follows the window: calls `onChange` with the layout now and on every change (rotation, split view). */
export function watchLayout(onChange: (layout: GigLayout) => void): void {
  const mq = typeof matchMedia === "function" ? matchMedia(STACK_QUERY) : null;
  const report = () => onChange(mq?.matches ? "stack" : "row");
  report();
  mq?.addEventListener?.("change", report);
}
