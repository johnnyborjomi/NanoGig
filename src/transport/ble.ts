/**
 * Web Bluetooth transport for the Nano Cortex.
 *
 * Connect flow adapted from choldy/nano-cortex-web-editor (`connectNano`, MIT)
 * with the robustness rules from rixrix/deskop-nano-cortex spec FR-2..FR-6,
 * FR-17: retain the whole characteristic map, subscribe c305 AND c306 with
 * payload dedupe, 3 s write timeouts, unsubscribe before disconnect,
 * auto-reconnect on `gattserverdisconnected`.
 */
import { toHex } from '../protocol/hex';
import { PacketDeduper } from './dedupe';
import {
  ALL_SERVICE_UUIDS,
  SERVICE_A002,
  looksLikeNano,
  charKeyOf,
  type CharKey,
} from '../protocol/uuids';
import {
  Emitter,
  sleep,
  withTimeout,
  type ConnectOptions,
  type LogLine,
  type NotifyPacket,
  type Transport,
  type TransportStatus,
} from './types';

const WRITE_TIMEOUT_MS = 3000;
const CONNECT_TIMEOUT_MS = 25000; // a power-cycled pedal took ~13 s to accept the connection (2026-09-12)
const DISCOVER_TIMEOUT_MS = 8000;
const UNSUBSCRIBE_TIMEOUT_MS = 1000;
const DEDUPE_WINDOW_MS = 500;
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const RECONNECT_MAX_ATTEMPTS = 40; // ~20 minutes at the 30 s cap
const LAST_DEVICE_KEY = 'nanogig.lastDeviceId';

function rememberDevice(id: string) {
  try {
    localStorage.setItem(LAST_DEVICE_KEY, id);
  } catch {
    /* storage unavailable */
  }
}

function rememberedDeviceId(): string | null {
  try {
    return localStorage.getItem(LAST_DEVICE_KEY);
  } catch {
    return null;
  }
}

/** True when Chrome can hand back previously permitted devices without the chooser. */
export function canResumePermittedDevices(): boolean {
  return isWebBluetoothAvailable() && typeof navigator.bluetooth.getDevices === 'function';
}

/** Web Bluetooth wants an ArrayBuffer-backed view; copy so subarray views / shared buffers are safe. */
function copyForWrite(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

export class BleTransport implements Transport {
  readonly name = 'ble';
  private device: BluetoothDevice | null = null;
  private chars = new Map<CharKey, BluetoothRemoteGATTCharacteristic>();
  private subscribed: BluetoothRemoteGATTCharacteristic[] = [];
  private _status: TransportStatus = 'disconnected';
  private intentionalDisconnect = false;
  private reconnecting = false;
  /** Resolves the current reconnect back-off early (advertisement seen or user tapped "Reconnect"). */
  private wakeReconnect: (() => void) | null = null;
  private advertisementAbort: AbortController | null = null;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private readonly deduper = new PacketDeduper(DEDUPE_WINDOW_MS);
  private readonly packets = new Emitter<NotifyPacket>();
  private readonly statuses = new Emitter<TransportStatus>();
  private readonly logs = new Emitter<LogLine>();
  private readonly onDisconnectedBound = () => this.handleDisconnected();

  get status(): TransportStatus {
    return this._status;
  }

  get deviceName(): string | null {
    return this.device?.name ?? null;
  }

  onPacket(cb: (pkt: NotifyPacket) => void) {
    return this.packets.on(cb);
  }
  onStatus(cb: (s: TransportStatus) => void) {
    return this.statuses.on(cb);
  }
  onLog(cb: (line: LogLine) => void) {
    return this.logs.on(cb);
  }

  private log(dir: LogLine['dir'], text: string, hex?: string) {
    const line: LogLine = { at: Date.now(), dir, text, ...(hex ? { hex } : {}) };
    this.logs.emit(line);
  }

  private setStatus(s: TransportStatus) {
    if (this._status === s) return;
    this._status = s;
    this.statuses.emit(s);
  }

  async connect(opts: ConnectOptions = {}): Promise<void> {
    if (!isWebBluetoothAvailable()) {
      throw new Error('Web Bluetooth is not available in this browser. Use Chrome/Edge on desktop, or Bluefy on iPad.');
    }
    this.intentionalDisconnect = false;
    this.setStatus('connecting');
    try {
      const request: RequestDeviceOptions = opts.acceptAll
        ? { acceptAllDevices: true, optionalServices: [...ALL_SERVICE_UUIDS] }
        : {
            filters: [
              { namePrefix: 'Nano' },
              { namePrefix: 'nano' },
              { namePrefix: 'NANO' },
              { namePrefix: 'Neural' },
              { namePrefix: 'Cortex' },
              { services: [SERVICE_A002] },
            ],
            optionalServices: [...ALL_SERVICE_UUIDS],
          };
      this.log('info', 'Requesting device…');
      const device = await navigator.bluetooth.requestDevice(request);
      this.attachDevice(device);
      rememberDevice(device.id);
      await this.openGatt();
      this.setStatus('connected');
    } catch (err) {
      this.setStatus('disconnected');
      throw err;
    }
  }

  private attachDevice(device: BluetoothDevice) {
    if (this.device && this.device !== device) {
      this.device.removeEventListener('gattserverdisconnected', this.onDisconnectedBound);
    }
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.onDisconnectedBound);
    this.log('info', `Selected device: ${device.name ?? '(unnamed)'} [${device.id}]`);
  }

  /** Connect GATT, discover services/characteristics, subscribe. */
  private async openGatt(): Promise<void> {
    const device = this.device;
    if (!device?.gatt) throw new Error('Device has no GATT server');
    this.log('info', 'Connecting GATT…');
    const server = await withTimeout(device.gatt.connect(), CONNECT_TIMEOUT_MS, 'GATT connect');
    this.chars.clear();
    this.subscribed = [];
    this.deduper.reset();

    const services = await withTimeout(server.getPrimaryServices(), DISCOVER_TIMEOUT_MS, 'service discovery');
    const report: string[] = [];
    for (const service of services) {
      let characteristics: BluetoothRemoteGATTCharacteristic[] = [];
      try {
        characteristics = await service.getCharacteristics();
      } catch (err) {
        this.log('warn', `getCharacteristics failed for ${service.uuid}: ${(err as Error).message}`);
        continue;
      }
      for (const ch of characteristics) {
        const p = ch.properties;
        const props = [
          p.read && 'read',
          p.write && 'write',
          p.writeWithoutResponse && 'write-no-rsp',
          p.notify && 'notify',
          p.indicate && 'indicate',
        ]
          .filter(Boolean)
          .join('/');
        report.push(`${service.uuid.slice(4, 8)}/${ch.uuid.slice(4, 8)} [${props}]`);
        const key = charKeyOf(ch.uuid);
        if (key && !this.chars.has(key)) this.chars.set(key, ch);
      }
    }
    this.log('info', `Inspection: ${report.join(', ') || '(no characteristics)'}`);

    if (!this.chars.has('c304') || !this.chars.has('c305')) {
      const missing = (['c304', 'c305'] as CharKey[]).filter((k) => !this.chars.has(k));
      throw new Error(`Required characteristic(s) not found: ${missing.join(', ')} (services seen: ${services.map((s) => s.uuid.slice(4, 8)).join(', ')})`);
    }
    if (!this.chars.has('c302')) this.log('warn', 'c302 (MIDI write) not found — preset switching via MIDI will be unavailable');

    for (const key of ['c305', 'c306'] as CharKey[]) {
      const ch = this.chars.get(key);
      if (!ch) continue;
      try {
        await withTimeout(ch.startNotifications(), DISCOVER_TIMEOUT_MS, `subscribe ${key}`);
        ch.addEventListener('characteristicvaluechanged', this.handleValueChanged);
        this.subscribed.push(ch);
        this.log('info', `Subscribed ${key} (${ch.properties.indicate ? 'indicate' : 'notify'})`);
      } catch (err) {
        this.log('warn', `subscribe ${key} failed: ${(err as Error).message}`);
      }
    }
    if (this.subscribed.length === 0) throw new Error('Could not subscribe to c305/c306');
  }

  private readonly handleValueChanged = (event: Event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const view = target.value;
    if (!view) return;
    const data = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    const char = charKeyOf(target.uuid) ?? target.uuid;
    const at = Date.now();
    // c306 mirrors c305 — drop a payload identical to the last one from the other char within the window.
    if (!this.deduper.accept(char, data, at)) return;
    this.log('rx', `RX ${char} (${data.length} B)`, toHex(data));
    this.packets.emit({ char, data, at });
  };

  private handleDisconnected() {
    this.log('warn', 'GATT server disconnected');
    this.chars.clear();
    this.subscribed = [];
    this.writeQueue = Promise.resolve();
    if (this.intentionalDisconnect) {
      this.setStatus('disconnected');
      return;
    }
    void this.reconnectLoop();
  }

  /** Wait `ms`, or less if something wakes the loop (advertisement / manual reconnect). */
  private waitOrWake(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.wakeReconnect = null;
        resolve();
      }, ms);
      this.wakeReconnect = () => {
        clearTimeout(t);
        this.wakeReconnect = null;
        resolve();
      };
    });
  }

  /**
   * Chrome only reconnects reliably once the device is advertising again. Where
   * `watchAdvertisements` is available, use it to retry the moment the pedal is
   * back instead of waiting out the back-off.
   */
  private startAdvertisementWatch(): void {
    const device = this.device;
    if (!device || typeof device.watchAdvertisements !== 'function') return;
    this.stopAdvertisementWatch();
    const abort = new AbortController();
    this.advertisementAbort = abort;
    device.addEventListener(
      'advertisementreceived',
      () => {
        this.log('info', 'Advertisement received from the device; retrying now');
        this.wakeReconnect?.();
      },
      { signal: abort.signal },
    );
    device.watchAdvertisements({ signal: abort.signal }).then(
      () => this.log('info', 'Watching advertisements for the device'),
      (err) => this.log('info', `watchAdvertisements unavailable: ${(err as Error).message}`),
    );
  }

  private stopAdvertisementWatch(): void {
    this.advertisementAbort?.abort();
    this.advertisementAbort = null;
  }

  /** Skip the current back-off and try to reconnect immediately (user action). */
  reconnectNow(): void {
    if (this._status === 'connected' || !this.device) return;
    this.intentionalDisconnect = false;
    if (this.reconnecting) {
      this.log('info', 'Manual reconnect requested');
      this.wakeReconnect?.();
      return;
    }
    void this.reconnectLoop();
  }

  private async reconnectLoop(immediateFirst = false): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.setStatus('reconnecting');
    this.startAdvertisementWatch();
    try {
      for (let attempt = 0; attempt < RECONNECT_MAX_ATTEMPTS; attempt++) {
        if (this.intentionalDisconnect || !this.device) break;
        const delay = immediateFirst && attempt === 0 ? 0 : RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)]!;
        if (delay > 0) {
          this.log('info', `Reconnect attempt ${attempt + 1} in ${delay / 1000} s`);
          await this.waitOrWake(delay);
        }
        if (this.intentionalDisconnect) break;
        try {
          this.log('info', `Reconnect attempt ${attempt + 1}: connecting…`);
          await this.openGatt();
          this.log('info', 'Reconnected');
          this.setStatus('connected');
          return;
        } catch (err) {
          this.log('warn', `Reconnect attempt ${attempt + 1} failed: ${(err as Error).name}: ${(err as Error).message}`);
          try {
            this.device?.gatt?.disconnect();
          } catch {
            /* ignore */
          }
        }
      }
      this.log('error', 'Gave up reconnecting; use Connect to start again');
      this.setStatus('disconnected');
    } finally {
      this.stopAdvertisementWatch();
      this.reconnecting = false;
    }
  }

  /**
   * After a page reload the GATT link is gone, but Chrome remembers the
   * permission. Reconnect to the remembered pedal without showing the chooser.
   * Resolves true once connected, false if there is nothing to resume or the
   * retry loop gave up. Requires `navigator.bluetooth.getDevices()`.
   */
  async resume(): Promise<boolean> {
    if (!canResumePermittedDevices()) return false;
    if (this._status === 'connected' || this.reconnecting) return this._status === 'connected';
    let devices: BluetoothDevice[] = [];
    try {
      devices = await navigator.bluetooth.getDevices();
    } catch (err) {
      this.log('info', `getDevices failed: ${(err as Error).message}`);
      return false;
    }
    const remembered = rememberedDeviceId();
    const device =
      devices.find((d) => d.id === remembered) ?? devices.find((d) => looksLikeNano(d.name)) ?? devices[0] ?? null;
    if (!device) {
      this.log('info', 'No previously permitted device to resume');
      return false;
    }
    this.intentionalDisconnect = false;
    this.attachDevice(device);
    this.log('info', `Resuming ${device.name ?? '(unnamed)'} without the chooser…`);
    await this.reconnectLoop(true);
    return this.status === 'connected';
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.wakeReconnect?.();
    this.stopAdvertisementWatch();
    const device = this.device;
    for (const ch of this.subscribed) {
      try {
        ch.removeEventListener('characteristicvaluechanged', this.handleValueChanged);
        await withTimeout(ch.stopNotifications(), UNSUBSCRIBE_TIMEOUT_MS, 'unsubscribe');
      } catch (err) {
        this.log('warn', `unsubscribe failed: ${(err as Error).message}`);
      }
    }
    this.subscribed = [];
    this.chars.clear();
    if (device?.gatt?.connected) {
      device.gatt.disconnect();
      this.log('info', 'Disconnected');
    }
    this.setStatus('disconnected');
  }

  private enqueueWrite(label: string, run: () => Promise<void>): Promise<void> {
    const task = this.writeQueue.then(run, run);
    this.writeQueue = task.catch((err) => this.log('error', `${label} failed: ${(err as Error).message}`));
    return task;
  }

  writeCommand(bytes: Uint8Array): Promise<void> {
    return this.enqueueWrite('c304 write', async () => {
      const ch = this.chars.get('c304');
      if (!ch) throw new Error('not connected (c304 unavailable)');
      this.log('tx', `TX c304`, toHex(bytes));
      await withTimeout(ch.writeValueWithResponse(copyForWrite(bytes)), WRITE_TIMEOUT_MS, 'c304 write');
    });
  }

  writeMidi(bytes: Uint8Array): Promise<void> {
    return this.enqueueWrite('c302 write', async () => {
      const ch = this.chars.get('c302');
      if (!ch) throw new Error('not connected (c302 unavailable)');
      this.log('tx', `TX c302`, toHex(bytes));
      const payload = copyForWrite(bytes);
      const write = ch.properties.writeWithoutResponse
        ? ch.writeValueWithoutResponse(payload)
        : ch.writeValueWithResponse(payload);
      await withTimeout(write, WRITE_TIMEOUT_MS, 'c302 write');
    });
  }

  /** For diagnostics: which characteristics were found. */
  get characteristicKeys(): CharKey[] {
    return Array.from(this.chars.keys());
  }
}

