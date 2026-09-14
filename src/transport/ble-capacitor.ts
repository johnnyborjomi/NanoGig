/**
 * Native BLE transport for the Capacitor shells (iOS / Android) via
 * @capacitor-community/bluetooth-le. Same behaviour as the Web Bluetooth
 * transport: characteristic map, c305 + c306 subscription with mirror dedupe,
 * write timeouts, reconnect with back-off, resume of the remembered device.
 * iOS web views have no Web Bluetooth, so this is the only way onto an iPad.
 */
import { BleClient, type BleDevice, type BleService } from '@capacitor-community/bluetooth-le';
import { toHex } from '../protocol/hex';
import { bleMidiFrame, type MidiStrategy } from '../protocol/frames';
import { ALL_SERVICE_UUIDS, SERVICE_A002, charKeyOf, looksLikeNano, type CharKey } from '../protocol/uuids';
import { PacketDeduper } from './dedupe';
import { Emitter, sleep, withTimeout, type ConnectOptions, type LogLine, type NotifyPacket, type Transport, type TransportStatus } from './types';

const WRITE_TIMEOUT_MS = 3000;
const CONNECT_TIMEOUT_MS = 25000;
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const RECONNECT_MAX_ATTEMPTS = 40;
const RESUME_BUDGET_MS = 20_000;
const LAST_DEVICE_KEY = 'nanogig.lastNativeDeviceId';

interface CharRef {
  service: string;
  uuid: string;
  write: boolean;
  writeWithoutResponse: boolean;
  notify: boolean;
  indicate: boolean;
}

function toBytes(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

function toView(bytes: Uint8Array): DataView {
  const copy = new Uint8Array(bytes);
  return new DataView(copy.buffer);
}

export class CapacitorBleTransport implements Transport {
  readonly name = 'ble-native';
  private device: BleDevice | null = null;
  private chars = new Map<CharKey, CharRef>();
  private subscribed: CharRef[] = [];
  private _status: TransportStatus = 'disconnected';
  private initialized = false;
  private intentionalDisconnect = false;
  private reconnectAbort = false;
  private loopDone: Promise<void> | null = null;
  private reconnecting = false;
  private wakeReconnect: (() => void) | null = null;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private readonly deduper = new PacketDeduper(500);
  private readonly packets = new Emitter<NotifyPacket>();
  private readonly statuses = new Emitter<TransportStatus>();
  private readonly logs = new Emitter<LogLine>();

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
    this.logs.emit({ at: Date.now(), dir, text, ...(hex ? { hex } : {}) });
  }

  private setStatus(s: TransportStatus) {
    if (this._status === s) return;
    this._status = s;
    this.statuses.emit(s);
  }

  private async ensureInitialized() {
    if (this.initialized) return;
    await BleClient.initialize({ androidNeverForLocation: true });
    this.initialized = true;
  }

  async connect(opts: ConnectOptions = {}): Promise<void> {
    await this.cancelReconnect();
    this.intentionalDisconnect = false;
    this.setStatus('connecting');
    try {
      await this.ensureInitialized();
      this.log('info', 'Scanning for the pedal…');
      const device = await BleClient.requestDevice(
        opts.acceptAll
          ? { optionalServices: [...ALL_SERVICE_UUIDS] }
          : { services: [SERVICE_A002], optionalServices: [...ALL_SERVICE_UUIDS] },
      );
      this.device = device;
      this.rememberDevice(device.deviceId);
      this.log('info', `Selected device: ${device.name ?? '(unnamed)'} [${device.deviceId}]`);
      await this.openGatt();
      this.setStatus('connected');
    } catch (err) {
      this.setStatus('disconnected');
      throw err;
    }
  }

  private rememberDevice(id: string) {
    try {
      localStorage.setItem(LAST_DEVICE_KEY, id);
    } catch {
      /* storage unavailable */
    }
  }

  /** Reconnect to the remembered pedal without the picker (app relaunch). */
  async resume(): Promise<boolean> {
    if (this._status === 'connected' || this.reconnecting) return this.status === 'connected';
    let id: string | null = null;
    try {
      id = localStorage.getItem(LAST_DEVICE_KEY);
    } catch {
      id = null;
    }
    if (!id) {
      this.log('info', 'No remembered device to resume');
      return false;
    }
    try {
      await this.ensureInitialized();
      const known = await BleClient.getDevices([id]);
      const device = known.find((d) => d.deviceId === id) ?? known.find((d) => looksLikeNano(d.name)) ?? known[0] ?? null;
      if (!device) {
        this.log('info', 'Remembered device is not known to the system any more');
        return false;
      }
      this.device = device;
      this.intentionalDisconnect = false;
      this.log('info', `Resuming ${device.name ?? '(unnamed)'} without the picker…`);
      await this.reconnectLoop(true, RESUME_BUDGET_MS);
      return this.status === 'connected';
    } catch (err) {
      this.log('info', `Resume failed: ${(err as Error).message}`);
      return false;
    }
  }

  private async openGatt(): Promise<void> {
    const device = this.device;
    if (!device) throw new Error('No device selected');
    this.log('info', 'Connecting…');
    await BleClient.connect(device.deviceId, () => this.handleDisconnected(), { timeout: CONNECT_TIMEOUT_MS });
    this.chars.clear();
    this.subscribed = [];
    this.deduper.reset();

    const services: BleService[] = await BleClient.getServices(device.deviceId);
    const report: string[] = [];
    for (const svc of services) {
      for (const ch of svc.characteristics) {
        const p = ch.properties;
        report.push(
          `${svc.uuid.slice(4, 8)}/${ch.uuid.slice(4, 8)} [${[p.read && 'read', p.write && 'write', p.writeWithoutResponse && 'write-no-rsp', p.notify && 'notify', p.indicate && 'indicate'].filter(Boolean).join('/')}]`,
        );
        const key = charKeyOf(ch.uuid);
        if (key && !this.chars.has(key)) {
          this.chars.set(key, {
            service: svc.uuid,
            uuid: ch.uuid,
            write: !!p.write,
            writeWithoutResponse: !!p.writeWithoutResponse,
            notify: !!p.notify,
            indicate: !!p.indicate,
          });
        }
      }
    }
    this.log('info', `Inspection: ${report.join(', ') || '(no characteristics)'}`);
    if (!this.chars.has('c304') || !this.chars.has('c305')) {
      throw new Error(`Required characteristic(s) not found: ${(['c304', 'c305'] as CharKey[]).filter((k) => !this.chars.has(k)).join(', ')}`);
    }
    for (const key of ['c305', 'c306'] as CharKey[]) {
      const ref = this.chars.get(key);
      if (!ref) continue;
      try {
        await BleClient.startNotifications(device.deviceId, ref.service, ref.uuid, (value) => this.onValue(key, value));
        this.subscribed.push(ref);
        this.log('info', `Subscribed ${key} (${ref.indicate ? 'indicate' : 'notify'})`);
      } catch (err) {
        this.log('warn', `subscribe ${key} failed: ${(err as Error).message}`);
      }
    }
    if (this.subscribed.length === 0) throw new Error('Could not subscribe to c305/c306');
    try {
      const mtu = await BleClient.getMtu(device.deviceId);
      this.log('info', `MTU ${mtu}`);
    } catch {
      /* iOS reports MTU differently; not essential */
    }
  }

  private onValue(char: CharKey, value: DataView) {
    const data = toBytes(value);
    const at = Date.now();
    if (!this.deduper.accept(char, data, at)) return;
    this.log('rx', `RX ${char} (${data.length} B)`, toHex(data));
    this.packets.emit({ char, data, at });
  }

  private handleDisconnected() {
    this.log('warn', 'Disconnected');
    this.chars.clear();
    this.subscribed = [];
    this.writeQueue = Promise.resolve();
    if (this.intentionalDisconnect) {
      this.setStatus('disconnected');
      return;
    }
    void this.reconnectLoop();
  }

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

  reconnectNow(): void {
    if (this._status === 'connected' || !this.device) return;
    this.intentionalDisconnect = false;
    if (this.reconnecting) {
      this.wakeReconnect?.();
      return;
    }
    void this.reconnectLoop();
  }

  private async cancelReconnect(): Promise<void> {
    if (!this.reconnecting) return;
    this.reconnectAbort = true;
    this.wakeReconnect?.();
    try {
      await this.loopDone;
    } finally {
      this.reconnectAbort = false;
    }
  }

  /** Retry with back-off; `budgetMs` bounds the whole loop (resume after a relaunch). */
  private reconnectLoop(immediateFirst = false, budgetMs?: number): Promise<void> {
    if (this.reconnecting) return this.loopDone ?? Promise.resolve();
    this.loopDone = this.runReconnectLoop(immediateFirst, budgetMs);
    return this.loopDone;
  }

  private async runReconnectLoop(immediateFirst: boolean, budgetMs?: number): Promise<void> {
    this.reconnecting = true;
    this.setStatus('reconnecting');
    const deadline = budgetMs ? Date.now() + budgetMs : Infinity;
    try {
      for (let attempt = 0; attempt < RECONNECT_MAX_ATTEMPTS; attempt++) {
        if (this.intentionalDisconnect || this.reconnectAbort || !this.device) break;
        let delay = immediateFirst && attempt === 0 ? 0 : RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)]!;
        if (Date.now() + delay > deadline) {
          if (Date.now() >= deadline) break;
          delay = Math.max(0, deadline - Date.now());
        }
        if (delay > 0) {
          this.log('info', `Reconnect attempt ${attempt + 1} in ${Math.round(delay / 100) / 10} s`);
          await this.waitOrWake(delay);
        }
        if (this.intentionalDisconnect || this.reconnectAbort) break;
        try {
          await this.openGatt();
          this.log('info', 'Reconnected');
          this.setStatus('connected');
          return;
        } catch (err) {
          this.log('warn', `Reconnect attempt ${attempt + 1} failed: ${(err as Error).message}`);
          try {
            await BleClient.disconnect(this.device.deviceId);
          } catch {
            /* ignore */
          }
        }
      }
      if (this.reconnectAbort) return;
      if (Number.isFinite(deadline) && Date.now() >= deadline) {
        this.log('warn', `Could not reach the last pedal within ${Math.round((budgetMs ?? 0) / 1000)} s; use Connect to pick it (pairing mode)`);
      } else {
        this.log('error', 'Gave up reconnecting; use Connect to start again');
      }
      this.setStatus('disconnected');
    } finally {
      this.reconnecting = false;
    }
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.wakeReconnect?.();
    const device = this.device;
    if (device) {
      for (const ref of this.subscribed) {
        try {
          await withTimeout(BleClient.stopNotifications(device.deviceId, ref.service, ref.uuid), 1000, 'unsubscribe');
        } catch {
          /* ignore */
        }
      }
      try {
        await BleClient.disconnect(device.deviceId);
      } catch {
        /* ignore */
      }
    }
    this.subscribed = [];
    this.chars.clear();
    this.setStatus('disconnected');
    await sleep(0);
  }

  private enqueueWrite(label: string, run: () => Promise<void>): Promise<void> {
    const task = this.writeQueue.then(run, run);
    this.writeQueue = task.catch((err) => this.log('error', `${label} failed: ${(err as Error).message}`));
    return task;
  }

  writeCommand(bytes: Uint8Array): Promise<void> {
    return this.enqueueWrite('c304 write', async () => {
      const ref = this.chars.get('c304');
      const device = this.device;
      if (!ref || !device) throw new Error('not connected (c304 unavailable)');
      this.log('tx', 'TX c304', toHex(bytes));
      await BleClient.write(device.deviceId, ref.service, ref.uuid, toView(bytes), { timeout: WRITE_TIMEOUT_MS });
    });
  }

  writeMidi(bytes: Uint8Array, strategy: MidiStrategy): Promise<void> {
    return this.enqueueWrite(`${strategy.char} write`, async () => {
      if (strategy.char === 'web-midi') throw new Error('web-midi is not a BLE characteristic');
      const ref = this.chars.get(strategy.char);
      const device = this.device;
      if (!ref || !device) throw new Error(`not connected (${strategy.char} unavailable)`);
      const chunks: Uint8Array[] =
        strategy.framing === 'sequential' ? Array.from(bytes, (b) => Uint8Array.of(b)) : [strategy.framing === 'ble-midi' ? bleMidiFrame(bytes) : bytes];
      for (const chunk of chunks) {
        this.log('tx', `TX ${strategy.char} [${strategy.id}]`, toHex(chunk));
        if (ref.writeWithoutResponse) {
          await BleClient.writeWithoutResponse(device.deviceId, ref.service, ref.uuid, toView(chunk), { timeout: WRITE_TIMEOUT_MS });
        } else {
          await BleClient.write(device.deviceId, ref.service, ref.uuid, toView(chunk), { timeout: WRITE_TIMEOUT_MS });
        }
      }
    });
  }
}
