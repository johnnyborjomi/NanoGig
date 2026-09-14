/**
 * PWA plumbing: the deferred install prompt and the service-worker update flow.
 * Pure browser glue; the UI only sees `installable` / `updateReady` on the store.
 */
import type { Store } from './state/store';

/** True when running as an installed app (home-screen launch), where "Install" makes no sense. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: fullscreen)').matches ||
    nav.standalone === true
  );
}

export class InstallPrompt {
  private deferred: BeforeInstallPromptEvent | null = null;

  constructor(private readonly store: Store) {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferred = e as BeforeInstallPromptEvent;
      if (!isStandalone()) this.store.patch({ installable: true });
      this.store.appendLog({ at: Date.now(), dir: 'info', text: 'Browser offered the install prompt' });
    });
    // Say why the Install block is absent, so "I can't see it" has an answer in the log.
    window.setTimeout(() => {
      if (this.deferred) return;
      const why = isStandalone()
        ? 'running as the installed app'
        : !window.isSecureContext
          ? 'not https (install needs the deployed site or localhost)'
          : !('serviceWorker' in navigator)
            ? 'no service worker support'
            : 'already installed on this device, or this browser does not offer PWA install (Safari, Bluefy, Firefox)';
      this.store.appendLog({ at: Date.now(), dir: 'info', text: `Install prompt not offered: ${why}` });
    }, 4000);
    window.addEventListener('appinstalled', () => {
      this.deferred = null;
      this.store.patch({ installable: false });
      this.store.appendLog({ at: Date.now(), dir: 'info', text: 'NanoGig installed; launch it from the home screen for the fullscreen shell' });
    });
  }

  /** Show the browser's install dialog. Resolves once the user has chosen. */
  async install(): Promise<void> {
    const ev = this.deferred;
    if (!ev) throw new Error('Install prompt not available in this browser');
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    this.store.appendLog({ at: Date.now(), dir: 'info', text: `Install prompt: ${outcome}` });
    if (outcome === 'accepted') {
      this.deferred = null;
      this.store.patch({ installable: false });
    }
  }
}

const UPDATE_CHECK_MS = 60 * 60 * 1000;

/**
 * Registers the service worker and watches for a newer one. When a new worker has installed
 * and is waiting, `updateReady` flips on and the UI offers a reload; `apply()` tells the
 * waiting worker to take over and reloads once it controls the page.
 */
export class AppUpdater {
  private registration: ServiceWorkerRegistration | null = null;
  private reloading = false;

  constructor(
    private readonly store: Store,
    private readonly swUrl: string,
  ) {}

  async register(): Promise<void> {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register(this.swUrl);
      this.registration = reg;
      if (reg.waiting && navigator.serviceWorker.controller) this.store.patch({ updateReady: true });
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          // "installed" with an existing controller = a newer build is waiting behind the running one.
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            this.store.patch({ updateReady: true });
            this.store.appendLog({ at: Date.now(), dir: 'info', text: 'A newer NanoGig build is ready; reload when convenient' });
          }
        });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (this.reloading) return;
        this.reloading = true;
        location.reload();
      });
      // Look for updates when the app comes back to the foreground, and hourly while it stays open.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void reg.update().catch(() => undefined);
      });
      setInterval(() => void reg.update().catch(() => undefined), UPDATE_CHECK_MS);
    } catch (err) {
      console.warn('SW registration failed', err);
    }
  }

  /** Activate the waiting worker; the controllerchange handler reloads the page. */
  apply(): void {
    const waiting = this.registration?.waiting;
    if (!waiting) {
      location.reload();
      return;
    }
    waiting.postMessage({ type: 'SKIP_WAITING' });
  }
}
