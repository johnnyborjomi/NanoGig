/** Transport abstraction so the BLE and mock transports are interchangeable. */

export type TransportStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface NotifyPacket {
  /** Short characteristic key the packet arrived on (c305, c306, …). */
  char: string;
  data: Uint8Array;
  at: number;
}

export type LogDirection = 'tx' | 'rx' | 'info' | 'warn' | 'error';

export interface LogLine {
  at: number;
  dir: LogDirection;
  text: string;
  hex?: string;
}

export type Unsubscribe = () => void;

export interface ConnectOptions {
  /** Skip the name/service filters and let the chooser list every device. */
  acceptAll?: boolean;
}

export interface Transport {
  readonly name: string;
  readonly status: TransportStatus;
  readonly deviceName: string | null;
  connect(opts?: ConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  /** Write a command/editor frame to c304. */
  writeCommand(bytes: Uint8Array): Promise<void>;
  /** Write MIDI bytes (PC/CC) to c302. */
  writeMidi(bytes: Uint8Array): Promise<void>;
  onPacket(cb: (pkt: NotifyPacket) => void): Unsubscribe;
  onStatus(cb: (status: TransportStatus) => void): Unsubscribe;
  onLog(cb: (line: LogLine) => void): Unsubscribe;
  /** Retry immediately while reconnecting (optional). */
  reconnectNow?(): void;
}

export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();
  on(cb: (value: T) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(value: T): void {
    for (const cb of Array.from(this.listeners)) {
      try {
        cb(value);
      } catch (err) {
        console.error('listener failed', err);
      }
    }
  }
  clear(): void {
    this.listeners.clear();
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
