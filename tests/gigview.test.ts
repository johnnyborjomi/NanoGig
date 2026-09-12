// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { GigView } from '../src/ui/gigview';
import { Store } from '../src/state/store';

function noopActions() {
  const p = () => Promise.resolve();
  return { connect: p, connectMock: p, disconnect: p, refresh: p, refreshNames: p, toggleFx: p, toggleGate: p, nextPreset: p, prevPreset: p };
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
    expect(tile('cab').dataset.on).toBe('true');
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
    expect(root.querySelector('.preset-name')?.textContent).toBe('Press a footswitch');
    expect(root.querySelector('.nav')?.classList.contains('visible')).toBe(true);
    store.setField('activePreset', 3, 'inferred');
    expect(root.querySelector('.preset-name')?.textContent).toBe('Preset 4');
    expect(root.querySelector('.src')?.textContent).toBe('inferred');
  });
});
