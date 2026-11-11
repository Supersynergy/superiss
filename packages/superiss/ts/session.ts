import { canonical, object, SisError, type Obj } from './util.ts';

export async function writeSessionFrame(value: Obj, headers = false): Promise<void> {
  const body = canonical(value), size = Buffer.byteLength(body);
  if (size > 8 * 1024 * 1024) throw new SisError('frame_too_large', 'Session response exceeds 8 MiB');
  const frame = headers ? `Content-Length: ${size}\r\n\r\n${body}` : body + '\n';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      process.stdout.destroy(); process.stdin.destroy();
      reject(new SisError('output_backpressure', 'Session output is not draining'));
    }, 5000);
    process.stdout.write(frame, error => { clearTimeout(timer); if (error) reject(error); else resolve(); });
  });
}

export async function runSession(handle: (input: Obj) => Promise<Obj>, signal?: AbortSignal): Promise<void> {
  let buffered = Buffer.alloc(0);
  const output = writeSessionFrame;
  const error = (code: string, msg: string): Obj => ({ id: null, ok: false, error: { code, msg } });
  const brokenOutput = (cause: Error) => process.stdin.destroy(cause);
  const stop = () => process.stdin.destroy();
  process.stdout.on('error', brokenOutput);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    for await (const chunk of process.stdin) {
      if (signal?.aborted) return;
      buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      while (true) {
        if (signal?.aborted) return;
        const end = buffered.indexOf(10);
        if (end < 0) break;
        if (end > 1048576) { await output(error('frame_too_large', 'RPC request exceeds 1 MiB')); process.exitCode = 2; return; }
        const line = buffered.subarray(0, end).toString('utf8'); buffered = buffered.subarray(end + 1);
        if (!line.trim()) continue;
        let input: unknown;
        try { input = JSON.parse(line); } catch { await output(error('bad_json', 'Invalid JSON')); continue; }
        if (!input || typeof input !== 'object' || Array.isArray(input) || typeof object(input).cmd !== 'string') {
          await output(error('bad_request', 'RPC requires an object with cmd')); continue;
        }
        const req = object(input);
        if (req.cmd === 'watch' && object(req.args).follow === true) {
          await output({ ...error('bad_args', 'Follow watch requires a dedicated socket'), id: req.id ?? null }); continue;
        }
        await output(await handle(req));
      }
      if (buffered.length > 1048576) { await output(error('frame_too_large', 'RPC request exceeds 1 MiB')); process.exitCode = 2; return; }
    }
    if (buffered.length) { await output(error('bad_frame', 'Incomplete RPC line at EOF; not dispatched')); process.exitCode = 2; }
  } catch (cause) { if (!signal?.aborted || cause instanceof SisError && cause.code === 'output_backpressure') throw cause; }
  finally { signal?.removeEventListener('abort', stop); process.stdout.removeListener('error', brokenOutput); }
}
