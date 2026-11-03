import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoreDatabase } from './ts/store.ts';

const root = mkdtempSync(join(tmpdir(), 'sis-v1-bench-'));
const stores = [0, 64].map(size => new StoreDatabase(join(root, `${size}.db`), { statementCacheSize: size }));
const rows: { round: number; cache: number; ms: number; prepares: number; checksum: number }[] = [];
try {
  for (const db of stores) for (let i = 0; i < 200; i++) db.get('SELECT ? AS n', i);
  for (let round = 0; round < 3; round++) {
    for (const index of round % 2 ? [1, 0] : [0, 1]) {
      const db = stores[index], before = db.statementStats.prepares, start = performance.now(); let checksum = 0;
      for (let i = 0; i < 5000; i++) checksum += Number(db.get('SELECT ? AS n', i % 97)?.n);
      const sample = { round, cache: index === 0 ? 0 : 64, ms: performance.now() - start, prepares: db.statementStats.prepares - before, checksum };
      assert.equal(sample.prepares, index === 0 ? 5000 : 0);
      rows.push(sample);
    }
  }
  assert.equal(new Set(rows.map(row => row.checksum)).size, 1);
  const median = (cache: number) => rows.filter(row => row.cache === cache).map(row => row.ms).sort((a, b) => a - b)[1];
  const uncached = median(0), cached = median(64);
  console.log(JSON.stringify({ passed: true, cost_class: 'CPU/allocation: driver prepare() calls; not total project completion time', sqlite: stores[0].get('SELECT sqlite_version() v')?.v, rounds: 3, reads_per_round: 5000, uncached_median_ms: uncached, cached_median_ms: cached, observed_ratio: uncached / cached, rows }));
} finally { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); }
