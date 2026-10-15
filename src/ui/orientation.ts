/**
 * Screen orientation for the installed app (PWA). The manifest starts it in landscape; the
 * rotate button locks the other way and the choice is remembered for the next launch.
 * Works where the browser lets an installed app lock the screen (Chrome on Android);
 * elsewhere `canLockOrientation()` is false and the button stays hidden.
 */
export type AppOrientation = "landscape" | "portrait";

const KEY = "nanogig.orientation";

type Lockable = ScreenOrientation & { lock?: (o: AppOrientation) => Promise<void> };

export function savedOrientation(): AppOrientation {
  try {
    return localStorage.getItem(KEY) === "portrait" ? "portrait" : "landscape";
  } catch {
    return "landscape";
  }
}

export function saveOrientation(o: AppOrientation): void {
  try {
    localStorage.setItem(KEY, o);
  } catch {
    /* storage unavailable */
  }
}

export function canLockOrientation(): boolean {
  return typeof (globalThis.screen?.orientation as Lockable | undefined)?.lock === "function";
}

export function lockOrientation(o: AppOrientation): Promise<void> {
  const orientation = screen.orientation as Lockable;
  return orientation.lock!(o);
}
