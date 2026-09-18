// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { GigView } from '../src/ui/gigview';
import { Store } from '../src/state/store';

function noopActions() {
  const p = () => Promise.resolve();
  return { connect: p, connectMock: p, disconnect: p, refresh: p, toggleFx: p, toggleGate: p, toggleCab: p, toggleCapture: p, selectPreset: p, setOutputsMuted: p, startTuner: p, stopTuner: p, setTunerReference: p, setTunerMute: p, setWritesEnabled: () => {}, setSettings: () => {} };
}

describe('GigView', () => {
  it('renders preset name, slot label and tile states from the store', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const store = new Store();
    new GigView(root, store, noopActions(), { bluetoothAvailable: false, showMockButton: true });

    expect(root.querySelector('.overlay.connect')?.classList.contains('open')).toBe(true);
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

    expect(root.querySelector('.overlay.connect')?.classList.contains('open')).toBe(false);
    expect(root.querySelector('.preset-name')?.textContent).toBe('Big Lead Tone');
    expect(root.querySelector('.slot-label')?.textContent).toBe('3B'); // index 9, default Mvave layout, no number
    expect(root.querySelector<HTMLElement>('.slot-slot')?.dataset.slot).toBe('1');
    store.patch({ showPresetNumber: true });
    expect(root.querySelector('.slot-label')?.textContent).toBe('3B·10');
    store.patch({ presetsPerBank: 8, labelStyle: 'letter-number', showPresetNumber: false });
    expect(root.querySelector('.slot-label')?.textContent).toBe('B2');
    expect(root.querySelector<HTMLSelectElement>('.menu-select')?.value).toBe('8');
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
    expect(tile('gate').closest('.gate-row')?.querySelector('.t-slot')?.textContent).toBe('GATE'); // own line
    expect(root.querySelector('.blocks > .hsep')).not.toBeNull(); // separator under the gate line
    expect(root.querySelector('.tiles > .vsep')?.nextElementSibling?.querySelector('.tile')?.getAttribute('data-key')).toBe('post1'); // pre | post divider
    expect(root.querySelector('.capture')?.textContent).toBe('Brit 1959 Crunch');
    expect(root.querySelector('.ir')?.textContent).toBe('412 UK GRN V30');
    expect(root.querySelector<HTMLElement>('.status .tempo')?.hidden).toBe(true);
    store.setField('tempo', 132, 'dump');
    expect(root.querySelector<HTMLElement>('.status .tempo')?.hidden).toBe(false);
    expect(root.querySelector('.status .tempo-text')?.textContent).toBe('132');
    expect(root.querySelector('.status .tempo-unit')?.textContent).toBe('BPM');
    expect(root.querySelector('.status .tempo svg')).not.toBeNull();
    expect(root.querySelectorAll<HTMLElement>('.lbl .sub-state')[1]?.dataset.on).toBe('true'); // cab label indicator
    store.setField('captureOn', false, 'dump');
    expect(root.querySelectorAll<HTMLElement>('.lbl .sub-state')[0]?.dataset.on).toBe('false'); // capture label indicator
    // Library IR (not in the slot list): lock icon instead of power, label not tappable even in control mode.
    store.patch({ writesEnabled: true });
    store.setField('cabSlotKnown', false, 'dump');
    store.setField('captureSlotKnown', true, 'dump');
    const lbls = root.querySelectorAll<HTMLElement>('.preset-sub .lbl');
    expect(lbls[1]?.classList.contains('locked')).toBe(true);
    expect(lbls[1]?.classList.contains('writable')).toBe(false);
    expect(lbls[1]?.querySelector<HTMLElement>('.sub-state')?.dataset.locked).toBe('true');
    expect(lbls[1]?.querySelector('.sub-state .i-lock')).not.toBeNull();
    expect(lbls[0]?.classList.contains('writable')).toBe(true);
    expect(lbls[0]?.querySelector<HTMLElement>('.sub-state')?.dataset.locked).toBe('false');
    expect(root.querySelector('.preset-strip')?.classList.contains('writable')).toBe(true); // control mode was switched on above
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
    expect(root.querySelector('.preset-strip')?.classList.contains('writable')).toBe(true);
    store.setField('activePreset', 3, 'inferred');
    expect(root.querySelector('.preset-name')?.textContent).toBe('Preset 4');
    expect(root.querySelector('.src')?.textContent).toBe('inferred');
  });
});

describe('GigView PWA install and update', () => {
  it('offers Install only when the browser reported a prompt, and an update bar with Later', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const store = new Store();
    const calls: string[] = [];
    const actions = { ...noopActions(), installApp: () => { calls.push('install'); return Promise.resolve(); }, applyUpdate: () => calls.push('update') };
    new GigView(root, store, actions, { bluetoothAvailable: true, showMockButton: false });
    const block = root.querySelector<HTMLElement>('.install-block')!;
    expect(block.hidden).toBe(true);
    store.patch({ installable: true });
    expect(block.hidden).toBe(false);
    expect(block.textContent).toContain('Install app');
    expect(block.textContent).toContain('home screen');
    block.querySelector('button')!.click();
    expect(calls).toEqual(['install']);
    // The menu carries the same offer under Disconnect, with its own separator, while connected.
    const menuInstall = Array.from(root.querySelectorAll<HTMLButtonElement>('.menu .menu-item')).find((b) => b.textContent === 'Install app')!;
    expect(menuInstall.hidden).toBe(false);
    expect(menuInstall.previousElementSibling?.classList.contains('menu-sep')).toBe(true);
    expect((menuInstall.previousElementSibling as HTMLElement).hidden).toBe(false);
    expect(menuInstall.previousElementSibling?.previousElementSibling?.textContent).toBe('Disconnect');
    menuInstall.click();
    expect(calls).toEqual(['install', 'install']);
    store.patch({ installable: false });
    expect(block.hidden).toBe(true);
    expect(menuInstall.hidden).toBe(true);
    expect((menuInstall.previousElementSibling as HTMLElement).hidden).toBe(true);

    const bar = root.querySelector<HTMLElement>('.update-bar')!;
    expect(bar.hidden).toBe(true);
    store.patch({ updateReady: true });
    expect(bar.hidden).toBe(false);
    const [reload, later] = Array.from(bar.querySelectorAll('button'));
    later!.click();
    expect(bar.hidden).toBe(true);
    store.patch({ connection: 'connected' }); // unrelated re-render keeps it dismissed
    expect(bar.hidden).toBe(true);
    store.patch({ updateReady: false });
    store.patch({ updateReady: true }); // a newer update shows again
    expect(bar.hidden).toBe(false);
    reload!.click();
    expect(calls).toEqual(['install', 'install', 'update']);
    expect(root.querySelector('.menu-info')?.textContent).toMatch(/NanoGig v\d+\.\d+\.\d+/);
  });
});

describe('GigView preset strip', () => {
  it('shows seven preset buttons centred on the active preset in control mode, wrapping around 64', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const store = new Store();
    const picked: number[] = [];
    new GigView(root, store, { ...noopActions(), selectPreset: (i: number) => { picked.push(i); return Promise.resolve(); } }, { bluetoothAvailable: true, showMockButton: false });
    const strip = () => root.querySelector<HTMLElement>('.preset-strip')!;
    const btns = () => Array.from(root.querySelectorAll<HTMLButtonElement>('.preset-strip .pbtn'));

    store.patch({ connection: 'connected', syncPhase: 'ready' });
    store.setField('presetNames', Array.from({ length: 64 }, (_, i) => (i === 9 ? 'Big Lead Tone' : '')), 'metadata');
    store.setField('activePreset', 9, 'event');
    expect(strip().classList.contains('visible')).toBe(true); // shown in viewing mode too
    store.patch({ showPresetStrip: false }); // setting: simpler view without the list
    expect(strip().classList.contains('visible')).toBe(false);
    store.patch({ showPresetStrip: true });
    expect(strip().classList.contains('visible')).toBe(true);
    expect(strip().classList.contains('writable')).toBe(false); // ...but inert
    expect(root.querySelectorAll('.preset-strip .pbtn')[0]!.getAttribute('aria-disabled')).toBe('true');
    expect(root.querySelector('.footer')).toBeNull(); // old prev/next footer is gone
    root.querySelectorAll<HTMLButtonElement>('.preset-strip .pbtn')[6]!.click();
    expect(picked).toEqual([]); // click ignored while control is off

    store.patch({ writesEnabled: true });
    expect(strip().classList.contains('writable')).toBe(true);
    expect(root.querySelectorAll('.preset-strip .pbtn')[0]!.getAttribute('aria-disabled')).toBe('false');
    expect(root.querySelector('.preset-strip > .hsep')).not.toBeNull(); // separator above the strip
    const b = btns();
    expect(b).toHaveLength(7);
    expect(b.map((x) => x.querySelector('.p-label')?.textContent)).toEqual(['2C', '2D', '3A', '3B', '3C', '3D', '4A']); // 4 per bank, 1B style
    // Vertical separators between banks: 2C 2D | 3A 3B 3C 3D | 4A; none with footswitch labels on.
    const kinds = () => Array.from(root.querySelectorAll<HTMLElement>('.preset-grid > *')).map((x) => (x.classList.contains('bank-sep') ? '|' : x.classList.contains('pbtn') ? x.querySelector('.p-label')!.textContent : '<>'));
    expect(kinds()).toEqual(['<>', '2C', '2D', '|', '3A', '3B', '3C', '3D', '|', '4A', '<>']);
    store.patch({ showFootswitches: true });
    expect(root.querySelectorAll('.preset-grid .bank-sep').length).toBe(0);
    store.patch({ showFootswitches: false });
    expect(b[3]!.dataset.active).toBe('true');
    expect(b[3]!.querySelector('.p-name')?.textContent).toBe('Big Lead Tone');
    expect(b[2]!.querySelector('.p-name')?.textContent).toBe('Preset 9'); // unnamed fallback
    expect(b[2]!.querySelector('.p-name')?.classList.contains('empty')).toBe(true);
    expect(b[3]!.querySelector<HTMLElement>('.slot-slot')?.dataset.slot).toBe('1'); // slot colour hook
    expect(b[3]!.querySelector<HTMLElement>('.p-num')?.hidden).toBe(true); // pedal number off by default
    // Nano footswitch badges: off by default, then IA/IB/IIA/IIB on the assigned presets only.
    store.setField('footswitches', { ia: 9, ib: 12, iia: 20, iib: 6 }, 'dump');
    expect(btns()[3]!.querySelector<HTMLElement>('.fs-badge')?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('.slot-label .fs-badge')?.hidden).toBe(true);
    store.patch({ showFootswitches: true });
    expect(root.querySelector<HTMLElement>('.slot-label .fs-badge')?.textContent).toBe('IA'); // active preset 9
    expect(root.querySelector<HTMLElement>('.slot-label .fs-badge')?.dataset.fs).toBe('ia');
    expect(btns().map((x) => x.querySelector<HTMLElement>('.fs-badge')!).map((e) => (e.hidden ? '' : e.textContent))).toEqual(['IIB', '', '', 'IA', '', '', 'IB']);
    store.patch({ showFootswitches: false });
    store.patch({ showPresetNumber: true });
    expect(btns()[3]!.querySelector<HTMLElement>('.p-num')?.textContent).toBe('·10');
    expect(btns()[3]!.querySelector<HTMLElement>('.p-num')?.hidden).toBe(false);
    store.patch({ showPresetNumber: false });

    b[6]!.click();
    expect(picked).toEqual([12]);

    store.setField('activePreset', 0, 'event');
    expect(btns().map((x) => x.querySelector('.p-label')?.textContent)).toEqual(['16B', '16C', '16D', '1A', '1B', '1C', '1D']); // wraps
    expect(btns()[3]!.dataset.active).toBe('true');

    // Arrows page the window by 7 without selecting; a preset change re-centres.
    const prev = root.querySelector<HTMLButtonElement>('.preset-grid .pbtn-nav:first-child')!;
    const next = root.querySelector<HTMLButtonElement>('.preset-grid .pbtn-nav:last-child')!;
    expect(next.hidden).toBe(false);
    next.click();
    expect(btns().map((x) => x.querySelector('.p-label')?.textContent)).toEqual(['2A', '2B', '2C', '2D', '3A', '3B', '3C']);
    expect(btns().some((x) => x.dataset.active === 'true')).toBe(false);
    expect(picked).toEqual([12]); // nothing selected by paging
    prev.click();
    prev.click();
    expect(btns().map((x) => x.querySelector('.p-label')?.textContent)).toEqual(['14C', '14D', '15A', '15B', '15C', '15D', '16A']);
    btns()[0]!.click();
    expect(picked).toEqual([12, 54]);
    store.setField('activePreset', 54, 'event');
    expect(btns()[3]!.dataset.active).toBe('true');
    expect(btns()[3]!.querySelector('.p-label')?.textContent).toBe('14C'); // re-centred
    store.patch({ writesEnabled: false });
    expect(next.hidden).toBe(true); // arrows only in control mode
  });
});

describe('GigView writes toggle and reconnect button', () => {
  it('shows the Control button when connected, the Connect… button only while reconnecting', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const store = new Store();
    const calls: string[] = [];
    const actions = { ...noopActions(), setWritesEnabled: (v: boolean) => calls.push(`writes:${v}`), connect: () => { calls.push('connect'); return Promise.resolve(); } };
    new GigView(root, store, actions, { bluetoothAvailable: true, showMockButton: false });
    const btn = (label: RegExp) => Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => label.test(b.textContent ?? ''))!;

    store.patch({ connection: 'connected', syncPhase: 'ready' });
    const control = btn(/^Control$/);
    expect(control.hidden).toBe(false);
    expect(control.querySelector<HTMLElement>('.btn-state')?.dataset.on).toBe('false');
    expect(btn(/^Connect…$/).hidden).toBe(true);
    control.click();
    expect(calls).toEqual(['writes:true']);

    store.patch({ writesEnabled: true });
    expect(control.querySelector<HTMLElement>('.btn-state')?.dataset.on).toBe('true');
    expect(control.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('.badge')).toBeNull(); // no separate "control on" badge
    expect(root.querySelector('.preset-strip')?.classList.contains('writable')).toBe(true);

    store.patch({ connection: 'reconnecting' });
    expect(btn(/^Connect…$/).hidden).toBe(false);
    btn(/^Connect…$/).click(); // opens the chooser like the main Connect button
    expect(calls).toEqual(['writes:true', 'connect']);

    // Exit-demo button appears only for the mock transport.
    const exitDemo = btn(/^Exit demo$/);
    expect(exitDemo.hidden).toBe(true);
    store.patch({ transportName: 'mock', connection: 'connected' });
    expect(exitDemo.hidden).toBe(false);
    expect(root.querySelector('.status-text')?.textContent).toBe('Connected · demo');
    store.patch({ transportName: 'ble', connection: 'reconnecting' });
    expect(exitDemo.hidden).toBe(true);

    // Burger menu holds refresh / log / disconnect and toggles open.
    const menu = root.querySelector('.menu')!;
    expect(menu.classList.contains('open')).toBe(false);
    root.querySelector<HTMLButtonElement>('button[aria-label="Menu"]')!.click();
    expect(menu.classList.contains('open')).toBe(true);
    const install = menu.querySelector<HTMLButtonElement>('button:last-of-type')!;
    expect(install.textContent).toBe('Install app');
    expect(install.hidden).toBe(true); // only while the browser offers a prompt
    expect(Array.from(menu.querySelectorAll('button')).filter((b) => b !== install).map((b) => b.textContent)).toEqual(['Settings', 'Refresh', 'Tuner', 'Log', 'Disconnect']);
    expect(menu.querySelectorAll('button svg').length).toBe(6); // an icon per item, the install one included
    expect(Array.from(menu.querySelectorAll<HTMLElement>('.menu-sep')).filter((d) => !d.hidden).length).toBe(5); // between items + a stronger one above the info line
    expect(menu.lastElementChild?.classList.contains('menu-info')).toBe(true); // device/firmware info at the bottom
    expect(menu.querySelector('button.danger')?.textContent).toBe('Disconnect');
    // Settings opens its own popup with the two selects and closes the menu.
    Array.from(menu.querySelectorAll('button')).find((b) => b.textContent === 'Settings')!.click();
    expect(menu.classList.contains('open')).toBe(false);
    const settings = root.querySelector('.overlay.settings')!;
    expect(settings.classList.contains('open')).toBe(true);
    expect(settings.querySelectorAll('select').length).toBe(2);
    expect(settings.querySelectorAll('input[type="checkbox"]').length).toBe(6); // preset number, footswitch labels, preset list, auto names, outputs mute, live tuner
    expect(settings.querySelector('.hint')?.textContent).toContain('preset 1 → 1A');
    Array.from(settings.querySelectorAll('button')).find((b) => b.textContent === 'Done')!.click();
    expect(settings.classList.contains('open')).toBe(false);
    expect(root.querySelector('.badge')).toBeNull();
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

describe('GigView outputs 1/2 mute setting', () => {
  it('shows a "1/2" muted badge after the tempo only while the pedal reports outputs muted', () => {
    const root = document.createElement('div');
    const store = new Store();
    new GigView(root, store, noopActions(), { bluetoothAvailable: true, showMockButton: false });
    store.patch({ connection: 'connected' });
    const badge = root.querySelector<HTMLElement>('.status .mute-badge')!;
    expect(badge.hidden).toBe(true);
    expect(badge.previousElementSibling?.classList.contains('tempo')).toBe(true);
    store.setField('outputsMuted', true, 'dump');
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('1/2');
    expect(badge.querySelector('svg')).not.toBeNull();
    store.setField('outputsMuted', false, 'dump');
    expect(badge.hidden).toBe(true);
    store.setField('outputsMuted', true, 'dump');
    store.patch({ connection: 'disconnected' });
    expect(badge.hidden).toBe(true);
  });

  it('is disabled until connected (no control mode needed), sends the switch, and shows the reported state', () => {
    const root = document.createElement('div');
    const store = new Store();
    const sent: boolean[] = [];
    new GigView(root, store, { ...noopActions(), setOutputsMuted: (m: boolean) => { sent.push(m); return Promise.resolve(); } }, { bluetoothAvailable: true, showMockButton: false });
    const settings = root.querySelector('.overlay.settings')!;
    const row = Array.from(settings.querySelectorAll('label.setting-row')).find((l) => l.textContent?.includes('Mute outputs 1/2'))!;
    expect(row).toBeTruthy();
    const box = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    store.patch({ connection: 'connected' });
    expect(box.disabled).toBe(false); // control mode off is fine
    expect(box.checked).toBe(false); // not read yet shows as unmuted
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(sent).toEqual([true]);
    store.setField('outputsMuted', true, 'event');
    expect(box.checked).toBe(true);
    const hint = row.nextElementSibling as HTMLElement;
    expect(hint.textContent).toContain('muted');
    store.patch({ connection: 'disconnected' });
    expect(box.disabled).toBe(true);
  });
});

describe('GigView connect screen: resume tip', () => {
  it('explains the chooser-on-every-launch and where the flag is when Chrome cannot resume', () => {
    const root = document.createElement('div');
    const store = new Store();
    new GigView(root, store, noopActions(), { bluetoothAvailable: true, resumeAvailable: false, showMockButton: false });
    const tip = root.querySelector('.overlay.connect .resume-tip') as HTMLElement;
    expect(tip.hidden).toBe(false);
    expect(tip.querySelector('code')!.textContent).toBe('chrome://flags/#enable-web-bluetooth-new-permissions-backend');
    // Chrome will not open chrome:// from a page, so the address is copyable rather than a link.
    expect(tip.querySelector('a')).toBeNull();
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t: string) => { copied.push(t); return Promise.resolve(); } } });
    (tip.querySelector('button.copy-flag') as HTMLButtonElement).click();
    expect(copied).toEqual(['chrome://flags/#enable-web-bluetooth-new-permissions-backend']);
    expect(root.querySelector('.overlay.connect .card')!.textContent).not.toContain('reconnects to the last pedal by itself');
  });

  it('shows no tip when the pedal can be resumed', () => {
    const root = document.createElement('div');
    const store = new Store();
    new GigView(root, store, noopActions(), { bluetoothAvailable: true, resumeAvailable: true, showMockButton: false });
    const tip = root.querySelector('.overlay.connect .resume-tip') as HTMLElement;
    expect(tip.hidden).toBe(true);
    expect(root.querySelector('.overlay.connect .card')!.textContent).toContain('reconnects to the last pedal by itself on launch');
  });
});

describe('GigView names refresh indicator', () => {
  it('appends "updating names…" to the connection status while a silent names stream is in flight', () => {
    const root = document.createElement('div');
    const store = new Store();
    new GigView(root, store, noopActions(), { bluetoothAvailable: true, showMockButton: false });
    store.patch({ connection: 'connected' });
    const status = root.querySelector('.status')!;
    expect(status.textContent).not.toContain('updating names');
    store.patch({ namesRefreshing: true });
    expect(status.textContent).toContain('updating names…');
    store.patch({ namesRefreshing: false });
    expect(status.textContent).not.toContain('updating names');
  });
});

describe('GigView tuner', () => {
  it('opens from the menu, shows the reading, steps the reference, and sends tuner-off on Done', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const store = new Store();
    const calls: string[] = [];
    const actions = {
      ...noopActions(),
      startTuner: () => { calls.push('start'); store.patch({ tuner: { ...store.get().tuner, on: true } }); return Promise.resolve(); },
      stopTuner: () => { calls.push('stop'); store.patch({ tuner: { ...store.get().tuner, on: false, reading: null, readingAt: null } }); return Promise.resolve(); },
      setTunerReference: (hz: number) => { calls.push(`ref:${hz}`); store.patch({ tuner: { ...store.get().tuner, referenceHz: hz } }); return Promise.resolve(); },
      setTunerMute: (m: boolean) => { calls.push(`mute:${m}`); return Promise.resolve(); },
    };
    const view = new GigView(root, store, actions, { bluetoothAvailable: true, showMockButton: false });
    store.patch({ connection: 'connected', transportName: 'ble' });
    const tunerItem = Array.from(root.querySelectorAll<HTMLButtonElement>('.menu .menu-item')).find((b) => b.textContent === 'Tuner')!;
    expect(tunerItem.hidden).toBe(false);
    const overlay = root.querySelector<HTMLElement>('.overlay.tuner')!;
    expect(overlay.classList.contains('open')).toBe(false);
    tunerItem.click();
    expect(overlay.classList.contains('open')).toBe(true);
    expect(calls).toEqual(['start']);
    expect(root.querySelector('.tuner-note')?.textContent).toBe('—');
    expect(root.querySelector('.tuner-cents')?.textContent).toBe('play a string');

    store.patch({ tuner: { ...store.get().tuner, reading: { note: 'A', cents: 14.27, inTune: false }, readingAt: Date.now() } });
    expect(root.querySelector('.tuner-note')?.textContent).toBe('A');
    expect(root.querySelector('.tuner-cents')?.textContent).toBe('+14 ct · sharp');
    expect(root.querySelector<HTMLElement>('.tuner-card')?.dataset.tune).toBe('sharp');
    expect(root.querySelector<HTMLElement>('.tuner-needle')?.style.left).toBe('64.27%');
    store.patch({ tuner: { ...store.get().tuner, reading: { note: 'D', cents: -0.54, inTune: true }, readingAt: Date.now() } });
    expect(root.querySelector('.tuner-cents')?.textContent).toBe('in tune');
    expect(root.querySelector<HTMLElement>('.tuner-card')?.dataset.tune).toBe('in');

    const [minus, plus] = Array.from(overlay.querySelectorAll<HTMLButtonElement>('.tuner-ref-btn'));
    plus!.click();
    expect(calls).toContain('ref:441');
    expect(root.querySelector('.tuner-ref-value')?.textContent).toBe('441 Hz');
    minus!.click();
    expect(calls).toContain('ref:440');
    const mute = overlay.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    mute.click();
    expect(calls).toContain('mute:true');

    Array.from(overlay.querySelectorAll('button')).find((b) => b.textContent === 'Done')!.click();
    expect(overlay.classList.contains('open')).toBe(false);
    expect(calls[calls.length - 1]).toBe('stop');

    // Losing the link closes the tuner too.
    tunerItem.click();
    expect(overlay.classList.contains('open')).toBe(true);
    store.patch({ connection: 'reconnecting' });
    expect(overlay.classList.contains('open')).toBe(false);
    expect(calls[calls.length - 1]).toBe('stop');
    void view;
  });
});

describe('GigView console log', () => {
  it('builds lines only while open and keeps following the log past the 400-line cap', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const store = new Store();
    new GigView(root, store, noopActions(), { bluetoothAvailable: true, showMockButton: false });
    const body = root.querySelector('.console-body') ?? root.querySelector('.console')!.lastElementChild!;
    for (let i = 0; i < 10; i++) store.appendLog({ at: Date.now(), dir: 'info', text: `line ${i}` });
    expect(body.childNodes.length).toBe(0); // closed: nothing built
    Array.from(root.querySelectorAll<HTMLButtonElement>('.menu .menu-item')).find((b) => b.textContent === 'Log')!.click();
    expect(body.childNodes.length).toBe(10); // opening catches up
    for (let i = 10; i < 450; i++) store.appendLog({ at: Date.now(), dir: 'info', text: `line ${i}` });
    expect(body.childNodes.length).toBe(400);
    expect(body.lastChild?.textContent).toContain('line 449');
  });
});

describe('GigView live tuner', () => {
  it('shows a note ring with flat/sharp dots in the top bar while connected with the tuner on', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const store = new Store();
    const opened: string[] = [];
    new GigView(root, store, { ...noopActions(), startTuner: () => { opened.push('start'); return Promise.resolve(); } }, { bluetoothAvailable: true, showMockButton: false });
    const lt = root.querySelector<HTMLElement>('.status .live-tuner')!;
    expect(lt.hidden).toBe(true);
    store.patch({ connection: 'connected', transportName: 'ble' });
    expect(lt.hidden).toBe(true); // tuner not on yet
    store.patch({ tuner: { ...store.get().tuner, on: true } });
    expect(lt.hidden).toBe(false);
    expect(lt.dataset.tune).toBe('silent');
    expect(lt.querySelector('.lt-note')?.textContent).toBe('_');

    store.patch({ tuner: { ...store.get().tuner, reading: { note: 'E', cents: -14, inTune: false }, readingAt: Date.now() } });
    expect(lt.querySelector('.lt-note')?.textContent).toBe('E');
    expect(lt.dataset.tune).toBe('flat');
    expect(lt.dataset.level).toBe('far');
    store.patch({ tuner: { ...store.get().tuner, reading: { note: 'E', cents: 4, inTune: false }, readingAt: Date.now() } });
    expect(lt.dataset.tune).toBe('sharp');
    expect(lt.dataset.level).toBe('near');
    store.patch({ tuner: { ...store.get().tuner, reading: { note: 'E', cents: 0.3, inTune: true }, readingAt: Date.now() } });
    expect(lt.dataset.tune).toBe('in');
    expect(lt.dataset.level).toBe('');

    lt.click(); // tap → the full tuner
    expect(opened).toEqual(['start']);
    expect(root.querySelector('.overlay.tuner')?.classList.contains('open')).toBe(true);

    store.patch({ liveTuner: false });
    expect(lt.hidden).toBe(true);
    const settings = root.querySelector('.overlay.settings')!;
    const liveRow = Array.from(settings.querySelectorAll('label.setting-row')).find((r) => r.textContent?.includes('Live tuner'))!;
    expect((liveRow.querySelector('input') as HTMLInputElement).checked).toBe(false);
  });
});
