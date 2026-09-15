/// <reference types="vite/client" />

/** Injected by vite.config.ts `define` (package.json version and short git sha). */
declare const __APP_VERSION__: string;
declare const __BUILD_ID__: string;
/** 'production' (site root, release tags) or 'staging' (/staging/, every push to main). */
declare const __CHANNEL__: string;

/** Chrome / Edge / Android: the deferred "Add to Home screen" prompt. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}
