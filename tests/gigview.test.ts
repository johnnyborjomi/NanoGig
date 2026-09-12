// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { GigView } from '../src/ui/gigview';
import { Store } from '../src/state/store';

function noopActions() {
  const p = () => Promise.resolve();
  return { connect: p, connectMock: p, disconnect: p, refresh: p, refreshNames: p, toggleFx: p, toggleGate: p, nextPreset: p, prevPreset: p, setWritesEnabled: () => {}, reconnectNow: () => {} };
}

describe('GigView', () => {
  it('renders preset name, slot label and tile states from the store', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const store = new Store();
    new GigView(root, store, noopActions(), { bluetoothAvailable: false, showMockButton: true });

    expect(root.querySelector('.overlay')?.classList.contains('open')).toBe(true);
    expect(root.querySelector('.preset-name')?.textContent).toBe('—');

    store.patch({ connection: 'connected', deviceName: 'Nano Cortex', syncPhase: 'ready' });
    const names = Array.from({ length: 64 }, (_, i) => (i === 9 ? 'Big Lead Tone' : ''));
    store.setField('presetNames', names, 'metadata');
    store.setField('activePreset', 9, 'event');
    store.setField('fxOn', { pre1: true, pre2: false, post1: null, post2: true, post3: false }, 'dump');
    store.setField(
      'fxModels',
      {
        pre1: { id: '1B', known: true, name: 'Green 808', category: 'Overdrive' },
        pre2: null,
        post1: null,
        post2: { id: 'FA2E', known: true, name: 'Analog Delay', category: 'Delay' },
        post3: { id: 'ZZ99', known: false, name: 'ID ZZ99', category: 'Utility' },
      },
      'dump',
    );
    store.setField('gateOn', false, 'dump');
    store.setField('cabOn', true, 'dump');
    store.setField('captureName', 'Brit 1959 Crunch', 'dump');
    store.setField('irName', '412 UK GRN V30', 'dump');

    expect(root.querySelector('.overlay')?.classList.contains('open')).toBe(false);
    expect(root.querySelector('.preset-name')?.textContent).toBe('Big Lead Tone');
    expect(root.querySelector('.slot-label')?.textContent).toContain('B2');
    expect(root.querySelector('.slot-label')?.textContent).toContain('10');
    const tile = (key: string) => root.querySelector<HTMLElement>(`.tile[data-key="${key}"]`)!;
    expect(tile('pre1').dataset.on).toBe('true');
    expect(tile('pre2').dataset.on).toBe('false');
    expect(tile('post1').dataset.on).toBe('unknown');
    expect(tile('gate').dataset.on).toBe('false');
    expect(root.querySelector('.tile[data-key="cab"]')).toBeNull(); // cab is not a tile any more
    expect(tile('pre1').querySelector('.t-name')?.textContent).toBe('Green 808');
    expect(tile('pre1').querySelector('.t-cat')?.textContent).toBe('Overdrive');
    expect(tile('pre2').querySelector('.t-name')?.textContent).toBe('Empty'); // state known, no model
    expect(tile('post1').querySelector('.t-name')?.textContent).toBe('POST 1'); // nothing known yet
    expect(tile('post2').querySelector('.t-name')?.textContent).toBe('Analog Delay');
    expect(tile('post3').querySelector('.t-name')?.textContent).toBe('ID ZZ99');
    expect(tile('post3').querySelector('.t-cat')?.textContent).toBe('');
    expect(tile('gate').querySelector('svg.t-icon')).not.toBeNull(); // power icon, no text
    expect(tile('gate').textContent?.trim()).toBe('');
    expect(root.querySelector('.capture')?.textContent).toBe('Brit 1959 Crunch');
    expect(root.querySelector('.ir')?.textContent).toBe('412 UK GRN V30');
    expect(root.querySelector('.nav')?.classList.contains('visible')).toBe(false);
  });

  it('shows a prompt when connected but the active preset is unknown, and nav when writes are on', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const store = new Store();
    new GigView(root, store, noopActions(), { bluetoothAvailable: true, showMockButton: false });
    store.patch({ connection: 'connected', syncPhase: 'ready', writesEnabled: true });
    expect(root.querySelector('.preset-name')?.textContent).toBe('Tap a footswitch to sync');
    store.patch({ syncPhase: 'metadata' });
    expect(root.querySelector('.preset-name')?.textContent).toBe('Loading presets…');
    store.patch({ syncPhase: 'state' });
    expect(root.querySelector('.preset-name')?.textContent).toBe('Reading pedal…');
    store.patch({ syncPhase: 'ready' });
    expect(root.querySelector('.nav')?.classList.contains('visible')).toBe(true);
    store.setField('activePreset', 3, 'inferred');
    expect(root.querySelector('.preset-name')?.textContent).toBe('Preset 4');
    expect(root.querySelector('.src')?.textContent).toBe('inferred');
  });
});

describe('GigView writes toggle and reconnect button', () => {
  it('shows the Control button when connected, the Reconnect button only while reconnecting', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const store = new Store();
    const calls: string[] = [];
    const actions = { ...noopActions(), setWritesEnabled: (v: boolean) => calls.push(`writes:${v}`), reconnectNow: () => calls.push('reconnect') };
    new GigView(root, store, actions, { bluetoothAvailable: true, showMockButton: false });
    const btn = (label: RegExp) => Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => label.test(b.textContent ?? ''))!;

    store.patch({ connection: 'connected', syncPhase: 'ready' });
    expect(btn(/^Control: off$/).hidden).toBe(false);
    expect(btn(/Reconnect now/).hidden).toBe(true);
    btn(/^Control: off$/).click();
    expect(calls).toEqual(['writes:true']);

    store.patch({ writesEnabled: true });
    expect(btn(/^Control: ON$/)).toBeTruthy();
    expect(root.querySelector('.nav')?.classList.contains('visible')).toBe(true);

    store.patch({ connection: 'reconnecting' });
    expect(btn(/Reconnect now/).hidden).toBe(false);
    btn(/Reconnect now/).click();
    expect(calls).toEqual(['writes:true', 'reconnect']);

    // Burger menu holds refresh / log / disconnect and toggles open.
    const menu = root.querySelector('.menu')!;
    expect(menu.classList.contains('open')).toBe(false);
    root.querySelector<HTMLButtonElement>('button[aria-label="Menu"]')!.click();
    expect(menu.classList.contains('open')).toBe(true);
    expect(Array.from(menu.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Refresh', 'Log', 'Disconnect']);
    expect(root.querySelector('.badge')?.textContent).not.toBe('provisional');
    expect(root.querySelector('button[aria-label="Fullscreen"] svg')).not.toBeNull();
  });
});

describe('GigView tile colour category', () => {
  it('maps the model category to a data-cat attribute and drops the ON/OFF text', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const store = new Store();
    new GigView(root, store, noopActions(), { bluetoothAvailable: true, showMockButton: false });
    const tile = (k: string) => root.querySelector<HTMLElement>(`.tile[data-key="${k}"]`)!;
    expect(tile('gate').dataset.cat).toBe('gate');
    expect(tile('pre1').dataset.cat).toBe('none');
    expect(root.querySelector('.t-state')).toBeNull();
    store.setField('fxOn', { pre1: true, pre2: false, post1: true, post2: true, post3: true }, 'dump');
    store.setField(
      'fxModels',
      {
        pre1: { id: '1B', known: true, name: 'Green 808', category: 'Overdrive' },
        pre2: { id: 'A51F', known: true, name: 'Graphic 9', category: 'Utility/EQ' },
        post1: { id: 'ZZ', known: false, name: 'ID ZZ', category: 'Utility' },
        post2: null,
        post3: { id: 'CB3E', known: true, name: 'Mind Hall', category: 'Reverb' },
      },
      'dump',
    );
    expect(tile('pre1').dataset.cat).toBe('overdrive');
    expect(tile('pre2').dataset.cat).toBe('utility-eq');
    expect(tile('post1').dataset.cat).toBe('unknown');
    expect(tile('post2').dataset.cat).toBe('none');
    expect(tile('post3').dataset.cat).toBe('reverb');
    expect(tile('post3').textContent).not.toMatch(/ON|OFF/);
  });
});
