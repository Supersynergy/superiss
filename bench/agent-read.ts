/** Same read workload for two immutable local binaries; no model calls. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
const [manifestPath, arm, output] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const config = manifest.arms[arm];
const hash = createHash('sha256').update(readFileSync(config.binary)).digest('hex');
if (hash !== config.sha256) throw Error('Binary changed');
const rows: unknown[] = [];
const started = performance.now();
let bytes = 0;
for (let i = 0; i < manifest.rounds; i++) {
  for (const request of manifest.requests) {
    const result = spawnSync(config.binary, [request.cmd, JSON.stringify(request.args), '--db', config.db], {encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024});
    if (result.status !== 0 || result.error) throw Error(result.stderr || String(result.error));
    bytes += Buffer.byteLength(result.stdout);
    let value = JSON.parse(result.stdout);
    if (value.ok === true && 'data' in value) value = value.data;
    if (request.cmd === 'show') value = {id: value.issue.id, title: value.issue.title, status: value.issue.status};
    else if (request.cmd === 'ready') value = value.map((t: any) => t.id);
    else if (request.cmd === 'stats') value = {total: value.total, open: value.open};
    else if (request.cmd === 'recall') value = value.map((r: any) => ({key: r.key, value: r.value}));
    rows.push({cmd: request.cmd, value});
  }
}
writeFileSync(output, JSON.stringify({arm, binarySha256: hash, elapsedMs: performance.now() - started, calls: rows.length, bytes, rows}));
