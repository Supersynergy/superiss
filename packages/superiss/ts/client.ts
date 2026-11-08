import { randomUUID } from 'node:crypto';
import { Agent, request, type ClientRequest } from 'node:http';
import type { Obj, Value } from './util.ts';

export interface CallOptions { actor?: string; idem?: string; run_id?: string; request_id?: string; signal?: AbortSignal; timeoutMs?: number }
export class ApiError extends Error { constructor(readonly code: string, message: string, readonly status = 0) { super(message); } }
const record = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const bounded = (n: number, low: number, high: number): number => {
  if (!Number.isSafeInteger(n) || n < low || n > high) throw new ApiError('bad_args', `value must be an integer within ${low}..${high}`);
  return n;
};

/** Trusted-local API only. A transport failure never triggers a retry or replay. */
export class SuperissClient {
  private readonly origin: string;
  private readonly agent: Agent;
  private readonly timeoutMs: number;
  private closed = false;
  private pending = 0;
  private readonly requests = new Set<ClientRequest>();
  constructor(url: string, options: { maxConnections?: number; timeoutMs?: number } = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new ApiError('bad_args', 'an uncredentialed loopback HTTP origin is required');
    this.origin = parsed.origin;
    this.timeoutMs = bounded(options.timeoutMs ?? 15000, 1, 310000);
    this.agent = new Agent({ keepAlive: true, maxSockets: bounded(options.maxConnections ?? 4, 1, 16), maxFreeSockets: 2 });
  }
  close(): void { this.closed = true; for (const req of this.requests) req.destroy(new ApiError('client_closed', 'client is closed')); this.agent.destroy(); }
  private async send(path: string, input: Obj | undefined, options: CallOptions, correlation?: string): Promise<Value> {
    if (this.closed) throw new ApiError('client_closed', 'client is closed');
    if (this.pending >= 64) throw new ApiError('busy', 'client pending request bound reached');
    const timeout = bounded(options.timeoutMs ?? this.timeoutMs, 1, 310000), body = input === undefined ? undefined : JSON.stringify(input);
    if (body && Buffer.byteLength(body) > 1024 * 1024) throw new ApiError('frame_too_large', 'request exceeds 1 MiB');
    let timer: ReturnType<typeof setTimeout> | undefined, active: ClientRequest | undefined;
    this.pending++;
    try {
      return await new Promise<Value>((resolve, reject) => {
        const req = request(this.origin + path, { method: body === undefined ? 'GET' : 'POST', agent: this.agent, signal: options.signal, headers: body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
          const chunks: Buffer[] = []; let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 8 * 1024 * 1024) { req.destroy(new ApiError('frame_too_large', 'response exceeds 8 MiB')); return; }
            chunks.push(chunk);
          });
          res.once('error', reject);
          res.once('aborted', () => reject(new ApiError('connection_lost', 'response interrupted; reconcile before retrying')));
          res.once('end', () => {
            try {
              const status = res.statusCode ?? 0;
              if (status >= 300 && status < 400) throw new ApiError('http_error', 'redirects are not followed', status);
              let reply: Obj;
              try { reply = record(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
              catch { throw new ApiError('bad_response', 'invalid JSON response', status); }
              if (reply.ok === false) { const error = record(reply.error); throw new ApiError(typeof error.code === 'string' ? error.code : 'http_error', typeof error.msg === 'string' ? error.msg : 'operation rejected', status); }
              if (status !== 200 || reply.ok !== true || !Object.hasOwn(reply, 'data')) throw new ApiError('bad_response', 'invalid API envelope', status);
              if (correlation !== undefined && reply.request_id !== correlation) throw new ApiError('correlation_mismatch', 'response request_id differs', status);
              resolve(reply.data ?? null);
            } catch (error) { reject(error); }
          });
        });
        active = req; this.requests.add(req);
        req.once('error', reject);
        timer = setTimeout(() => req.destroy(new ApiError('timeout', 'request deadline exceeded; reconcile before retrying')), timeout);
        req.end(body);
      });
    } finally { if (timer) clearTimeout(timer); if (active) this.requests.delete(active); this.pending--; }
  }
  rpc(cmd: string, args: Obj = {}, options: CallOptions = {}): Promise<Value> {
    const request_id = options.request_id ?? randomUUID();
    return this.send('/api/v1/rpc', { cmd, args, request_id, actor: options.actor, idem: options.idem, run_id: options.run_id }, options, request_id);
  }
  async batch(ops: { cmd: string; args?: Obj }[], options: CallOptions = {}): Promise<Value[]> {
    const results = record(await this.rpc('batch', { ops }, options)).results;
    if (!Array.isArray(results)) throw new ApiError('bad_response', 'batch results must be an array');
    return results;
  }
  private async get(path: string, query: Record<string, string | number>, options: CallOptions): Promise<Obj> {
    const suffix = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])).toString();
    const data = await this.send(path + (suffix ? '?' + suffix : ''), undefined, options);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new ApiError('bad_response', 'object data expected');
    return data;
  }
  tracker(query: { owner?: string; lane?: string; status?: string; view?: string; limit?: number; offset?: number } = {}, options: CallOptions = {}): Promise<Obj> { return this.get('/api/v1/tracker', query, options); }
  loop(id: string, options: CallOptions = {}): Promise<Obj> { return this.get('/api/v1/loops/' + encodeURIComponent(id), {}, options); }
  capsule(id: string, query: { max_tokens?: number; encoding?: string } = {}, options: CallOptions = {}): Promise<Obj> { return this.get('/api/v1/capsules/' + encodeURIComponent(id), query, options); }
  events(query: { after?: number; limit?: number; wait?: number } = {}, options: CallOptions = {}): Promise<Obj> { return this.get('/api/v1/events', query, options); }
}
