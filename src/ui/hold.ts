/** The edit gestures' long press, shared by the gig view and the edit sheets. */
export const HOLD_MS = 500;

/**
 * Hold gesture on `node`: `onHold` after HOLD_MS without moving away; the click that ends the press is swallowed
 * so the tap action (a toggle) does not also run. Taps are left alone.
 */
export function onHold(node: HTMLElement, onHoldFn: () => void, enabled: () => boolean): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let held = false;
  let start: { x: number; y: number } | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  node.addEventListener("pointerdown", (e) => {
    held = false;
    if (!enabled()) return;
    start = { x: e.clientX, y: e.clientY };
    cancel();
    timer = setTimeout(() => {
      timer = null;
      held = true;
      onHoldFn();
    }, HOLD_MS);
  });
  node.addEventListener("pointermove", (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 12) cancel();
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"] as const) node.addEventListener(ev, cancel);
  node.addEventListener("contextmenu", (e) => {
    if (enabled()) e.preventDefault(); // long-press menu on touch screens
  });
  node.addEventListener(
    "click",
    (e) => {
      if (!held) return;
      held = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    },
    true,
  );
}
