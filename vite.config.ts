import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

/** Short git sha, or a timestamp when git is not available (e.g. a zip build). */
function buildId(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return Date.now().toString(36);
  }
}
const BUILD_ID = buildId();

/**
 * Release channel: `production` (default; the site root, built from the latest release tag)
 * or `staging` (every push to main, served under /staging/). Set by the Pages workflow via
 * NANOGIG_CHANNEL. Staging gets its own app name so both PWAs can be installed side by side.
 */
const CHANNEL = process.env.NANOGIG_CHANNEL === 'staging' ? 'staging' : 'production';

/**
 * Stamp the service worker with the build id so every deploy ships a byte-different sw.js.
 * Browsers only install a new worker when the file changes; that is what triggers the
 * "Update ready" bar in the running app. Staging builds also get their own manifest name
 * and page title.
 */
function stampBuild(): Plugin {
  let outDir = 'dist';
  return {
    name: 'nanogig-stamp-build',
    apply: 'build',
    configResolved(cfg) {
      outDir = cfg.build.outDir;
    },
    closeBundle() {
      const file = resolve(outDir, 'sw.js');
      const src = readFileSync(file, 'utf8');
      if (!src.includes('__BUILD__')) throw new Error('sw.js has no __BUILD__ placeholder');
      writeFileSync(file, src.replace(/__BUILD__/g, `${pkg.version}-${BUILD_ID}-${CHANNEL}`));
      if (CHANNEL === 'staging') {
        const manifestFile = resolve(outDir, 'manifest.webmanifest');
        const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
        manifest.name = 'NanoGig staging (unofficial gig view for Nano Cortex)';
        manifest.short_name = 'NanoGig β';
        writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
        const htmlFile = resolve(outDir, 'index.html');
        writeFileSync(htmlFile, readFileSync(htmlFile, 'utf8').replace('<title>NanoGig</title>', '<title>NanoGig staging</title>'));
      }
    },
  };
}

export default defineConfig({
  base: './',
  server: { host: true },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_ID__: JSON.stringify(BUILD_ID),
    __CHANNEL__: JSON.stringify(CHANNEL),
  },
  plugins: [stampBuild()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
