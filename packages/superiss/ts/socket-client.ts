import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { VERSION } from '../runtime.ts';
import { canonical, object, SisError, type Obj } from './util.ts';

interface Pending {
  sent: boolean;
  finish: (error?: Error, value?: Obj) => void;
}
export interface SocketCallOptions { timeoutMs?: number; signal?: AbortSignal }
export class SuperissSocketClient {
  private socket?: Socket;
  private connecting?: Promise<Socket>;
  private ready = false;
  private closed = false;
  private boundProject?: string;
  private readonly db: string;
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly path: string, db: string, options: { timeoutMs?: number; maxPending?: number } = {}) {
    this.db = existsSync(db) ? realpathSync(db) : resolve(db);
    this.timeoutMs = this.number(options.timeoutMs ?? 15000, 310000);
    this.maxPending = this.number(options.maxPending ?? 64, 128);
  }
  private number(value: number, max: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new SisError('bad_args', `Expected integer within 1..${max}`);
    return value;
  }
  private disconnect(error: Error): void {
    const socket = this.socket;
    this.socket = undefined; this.ready = false;
    socket?.destroy();
    for (const job of [...this.pending.values()]) job.finish(job.sent
      ? new SisError('transport_uncertain', `Acknowledgement unavailable; reconcile before retrying: ${error.message}`)
      : error);
  }
  private connect(): Promise<Socket> {
    if (this.closed) return Promise.reject(new SisError('client_closed', 'Socket client is closed'));
    if (this.ready && this.socket) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    const opening = new Promise<Socket>((resolve, reject) => {
      let entry;
      try {
        entry = lstatSync(this.path);
        if (!entry.isSocket() || entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0) throw new SisError('project_binding_mismatch', 'Expected an owned private Unix socket');
      } catch (error) { reject(error); return; }
      const socket = createConnection(this.path);
      this.socket = socket;
      let buffer = Buffer.alloc(0), handshaking = true, settled = false;
      const timer = setTimeout(() => failed(new SisError('timeout', 'Socket identity handshake timed out')), 5000);
      const failed = (error: Error) => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(error); }
        if (this.socket === socket) this.disconnect(error);
      };
      socket.on('error', failed);
      socket.on('close', () => failed(new SisError('connection_lost', 'Socket closed')));
      socket.on('connect', () => socket.write(canonical({ cmd: 'context', args: {} }) + '\n'));
      socket.on('data', (chunk: Buffer) => {
        if (this.socket !== socket) return;
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
          const end = buffer.indexOf(10);
          if (end < 0) { if (buffer.length > 8 * 1024 * 1024) failed(new SisError('frame_too_large', 'Response exceeds 8 MiB')); return; }
          if (end > 8 * 1024 * 1024) { failed(new SisError('frame_too_large', 'Response exceeds 8 MiB')); return; }
          let reply: Obj;
          try { reply = object(JSON.parse(buffer.subarray(0, end).toString('utf8'))); }
          catch { failed(new SisError('bad_response', 'Invalid socket JSON')); return; }
          buffer = buffer.subarray(end + 1);
          if (handshaking) {
            try {
              const info = object(reply.data), caps = object(info.capabilities);
              if (reply.ok !== true || typeof info.db_path !== 'string' || realpathSync(info.db_path) !== this.db
                || typeof info.project_id !== 'string' || !info.project_id || caps.protocol !== 2 || caps.proof_receipts !== true || buffer.length) {
                throw new SisError('project_binding_mismatch', 'Socket database, project or protocol identity differs');
              }
              if (caps.version !== VERSION) throw new SisError('runtime_version_mismatch', `Expected Superiss ${VERSION}, found ${String(caps.version ?? 'unknown')}`);
              if (this.boundProject && this.boundProject !== info.project_id) throw new SisError('project_binding_mismatch', 'Project identity changed; explicit new client required');
              this.boundProject = info.project_id;
              handshaking = false; this.ready = true; settled = true; clearTimeout(timer); resolve(socket);
            } catch (error) { failed(error instanceof Error ? error : Error(String(error))); }
            return;
          }
          const id = reply.request_id;
          if (typeof id !== 'string' || !this.pending.has(id) || typeof reply.ok !== 'boolean' || reply.more === true) {
            failed(new SisError('correlation_mismatch', 'Unexpected socket response')); return;
          }
          this.pending.get(id)!.finish(undefined, reply);
        }
      });
    });
    this.connecting = opening;
    void opening.then(() => { if (this.connecting === opening) this.connecting = undefined; }, () => { if (this.connecting === opening) this.connecting = undefined; });
    return opening;
  }
  request(input: Obj, options: SocketCallOptions = {}): Promise<Obj> {
    if (this.closed) return Promise.reject(new SisError('client_closed', 'Socket client is closed'));
    if (options.signal?.aborted) return Promise.reject(new SisError('aborted', 'Request aborted before dispatch'));
    if (this.pending.size >= this.maxPending) return Promise.reject(new SisError('busy', 'Socket pending limit reached'));
    if (typeof input.cmd !== 'string' || !input.cmd || input.cmd === 'watch') return Promise.reject(new SisError('bad_args', 'Command required; watch needs a dedicated socket'));
    const id = input.request_id ?? randomUUID();
    if (typeof id !== 'string' || !id || id.length > 128 || this.pending.has(id)) return Promise.reject(new SisError('bad_request_id', 'Unique text request_id required'));
    let timeout: number, frame: string;
    try {
      timeout = this.number(options.timeoutMs ?? this.timeoutMs, 310000);
      frame = canonical({ ...input, request_id: id }) + '\n';
      if (Buffer.byteLength(frame) > 1048576) throw new SisError('frame_too_large', 'Request exceeds 1 MiB');
    } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const abort = () => this.disconnect(new SisError('aborted', 'Client channel aborted; dispatched work is not cancelled'));
      const timer = setTimeout(() => this.disconnect(new SisError('timeout', 'Socket request deadline exceeded')), timeout);
      const job: Pending = { sent: false, finish: (error, value) => {
        clearTimeout(timer); options.signal?.removeEventListener('abort', abort); this.pending.delete(id);
        if (error) reject(error); else resolve(value ?? {});
      } };
      this.pending.set(id, job);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      void this.connect().then(socket => {
        if (this.pending.get(id) !== job) return;
        job.sent = true; socket.write(frame);
      }).catch(error => {
        if (this.pending.get(id) !== job) return;
        const cause = error instanceof Error ? error : Error(String(error));
        if (job.sent) this.disconnect(cause); else job.finish(cause);
      });
    });
  }
  close(): void {
    this.closed = true;
    this.disconnect(new SisError('client_closed', 'Socket client closed; dispatched work may have completed'));
  }
}
