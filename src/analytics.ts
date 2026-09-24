/**
 * Anonymous usage stats via Umami Cloud (cookieless: no consent banner, no identifiers stored).
 *
 * Only ever sends: page views, and the handful of named events below with a few short
 * string properties. Nothing about the pedal, presets or settings (see PRIVACY.md).
 *
 * The script is only injected when `active` (production channel, a real hostname, or the
 * native app): dev servers and the staging site never report.
 */

export type AnalyticsEvent =
  /** App started: how it runs (standalone = launched from the home screen / native shell). */
  | { name: 'launch'; data: { standalone: 'yes' | 'no'; platform: 'web' | 'ios' | 'android' } }
  /** A real pedal link reached "connected" (mock excluded). */
  | { name: 'connect'; data: { transport: string } }
  /** The browser fired `appinstalled` (Android / desktop Chrome; iOS never does). */
  | { name: 'pwa-installed'; data?: undefined }
  /** A "Support project" button was tapped. */
  | { name: 'support-click'; data: { source: 'card' | 'menu' } }
  /** A "Support project" button came on screen (connect card shown / menu opened), once per session per source. */
  | { name: 'support-seen'; data: { source: 'card' | 'menu' } }
  /** A link completed its first full state sync (the pedal actually worked), with the firmware when known. */
  | { name: 'sync'; data: { firmware: string } }
  /** First use of a feature in this session. */
  | { name: 'feature'; data: { name: 'tuner' | 'control' | 'preset-switch' | 'expression' } }
  /** The app went to the background / closed: preset changes seen since the last such event. */
  | { name: 'session-end'; data: { presetChanges: number } };

interface Umami {
  track(name: string, data?: Record<string, string | number>): unknown;
}
declare global {
  interface Window {
    umami?: Umami;
  }
}

export interface AnalyticsConfig {
  websiteId: string;
  scriptUrl: string;
  /** False on dev / staging / unknown hosts: nothing is ever injected or sent. */
  active: boolean;
}

export class Analytics {
  private queue: AnalyticsEvent[] = [];

  constructor(private readonly config: AnalyticsConfig) {
    if (config.active) this.inject();
  }

  /** Send a named event; queued until the tracker script has loaded, dropped when inactive. */
  track(ev: AnalyticsEvent): void {
    if (!this.config.active) return;
    if (window.umami) {
      this.send(ev);
      return;
    }
    if (this.queue.length < 20) this.queue.push(ev);
  }

  private inject(): void {
    const s = document.createElement('script');
    s.defer = true;
    s.src = this.config.scriptUrl;
    s.dataset.websiteId = this.config.websiteId;
    s.addEventListener('load', () => this.flush());
    document.head.append(s);
  }

  private flush(): void {
    if (!window.umami) return;
    const pending = this.queue;
    this.queue = [];
    for (const ev of pending) this.send(ev);
  }

  private send(ev: AnalyticsEvent): void {
    try {
      window.umami?.track(ev.name, ev.data);
    } catch {
      /* never let stats break the app */
    }
  }
}
