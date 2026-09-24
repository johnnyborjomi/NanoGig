// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Analytics } from '../src/analytics';

const config = { websiteId: 'site-1', scriptUrl: 'https://cloud.umami.is/script.js', active: true };
const scripts = () => Array.from(document.head.querySelectorAll('script'));

afterEach(() => {
  document.head.replaceChildren();
  delete window.umami;
});

describe('Analytics', () => {
  it('injects the Umami tag, queues events until it loads, then sends them', () => {
    const a = new Analytics(config);
    expect(scripts()).toHaveLength(1);
    expect(scripts()[0]!.src).toBe(config.scriptUrl);
    expect(scripts()[0]!.dataset.websiteId).toBe('site-1');
    expect(scripts()[0]!.defer).toBe(true);
    a.track({ name: 'launch', data: { standalone: 'no', platform: 'web' } });
    a.track({ name: 'connect', data: { transport: 'ble' } });
    const track = vi.fn();
    window.umami = { track };
    scripts()[0]!.dispatchEvent(new Event('load'));
    expect(track.mock.calls).toEqual([
      ['launch', { standalone: 'no', platform: 'web' }],
      ['connect', { transport: 'ble' }],
    ]);
    a.track({ name: 'support-click', data: { source: 'menu' } });
    expect(track).toHaveBeenLastCalledWith('support-click', { source: 'menu' });
    a.track({ name: 'pwa-installed' });
    expect(track).toHaveBeenLastCalledWith('pwa-installed', undefined);
  });

  it('inactive (dev / staging): never injects or sends', () => {
    const a = new Analytics({ ...config, active: false });
    expect(scripts()).toHaveLength(0);
    const track = vi.fn();
    window.umami = { track };
    a.track({ name: 'connect', data: { transport: 'ble' } });
    expect(track).not.toHaveBeenCalled();
  });

  it('a throwing tracker never breaks the caller', () => {
    const a = new Analytics(config);
    window.umami = { track: () => { throw new Error('boom'); } };
    expect(() => a.track({ name: 'connect', data: { transport: 'ble' } })).not.toThrow();
  });
});
