import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.ts';
import { array, object } from './ts/util.ts';

test('FTS remains authoritative when the optional vector extension and model are absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-search-default-'));
  const old = { model: process.env.SIS_VEC_MODEL, extension: process.env.SIS_VEC_EXTENSION };
  delete process.env.SIS_VEC_MODEL;
  delete process.env.SIS_VEC_EXTENSION;
  const engine = new Engine(join(root, 'issues.db'));
  try {
    await engine.dispatch('create', { id: 'exact', title: 'sqlite busy timeout', desc: 'Prevent lock starvation' });
    assert.equal(object(array(await engine.dispatch('search', { q: 'sqlite' }))[0]).id, 'exact');
    assert.equal(object(array(await engine.dispatch('search', { q: 'sqlite', mode: 'hybrid' }))[0]).id, 'exact');
    assert.equal(object(await engine.dispatch('search_index', {})).reason, 'disabled');
    assert.equal(object(object(await engine.dispatch('capabilities', {})).search_projection).default, 'fts5');
    process.env.SIS_VEC_MODEL = 'fixture-embeddings';
    process.env.SIS_VEC_EXTENSION = join(root, 'missing-vec0.dylib');
    assert.equal(object(await engine.dispatch('search_index', {})).reason, 'disabled');
    assert.equal(object(array(await engine.dispatch('search', { q: 'sqlite', mode: 'hybrid' }))[0]).id, 'exact');
    assert.equal(engine.db.get('PRAGMA user_version')?.user_version, 7);
  } finally {
    await engine.shutdown(); engine.db.close();
    for (const [name, value] of Object.entries(old)) {
      const key = name === 'model' ? 'SIS_VEC_MODEL' : 'SIS_VEC_EXTENSION';
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('local optional vector projection is rebuildable; changes fall back to FTS until rebuilt', async t => {
  const extension = process.env.SIS_TEST_VEC_EXTENSION;
  if (!extension) return t.skip('Set SIS_TEST_VEC_EXTENSION to a locally installed sqlite-vec library');
  const root = mkdtempSync(join(tmpdir(), 'sis-search-vec-'));
  const previous = { model: process.env.SIS_VEC_MODEL, extension: process.env.SIS_VEC_EXTENSION, port: process.env.SIS_VEC_PORT, admin: process.env.SIS_ADMIN_TOKEN };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const values = JSON.parse(body) as { input: string[] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ embeddings: values.input.map(text => text.includes('oauth') || text.includes('signin') ? [1, 0] : [0, 1]) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  process.env.SIS_VEC_MODEL = 'fixture-embeddings';
  process.env.SIS_VEC_EXTENSION = extension;
  process.env.SIS_VEC_PORT = String(address.port);
  const engine = new Engine(join(root, 'issues.db'));
  try {
    assert.equal(object(await engine.dispatch('search_index', { action: 'build' })).indexed, 0);
    await engine.dispatch('create', { id: 'auth', title: 'oauth token expired' });
    await engine.dispatch('create', { id: 'db', title: 'database lock timeout' });
    assert.equal(object(await engine.dispatch('search_index', {})).reason, 'stale');
    assert.deepEqual(array(await engine.dispatch('search', { q: 'signin', mode: 'hybrid' })), []);
    const built = object(await engine.dispatch('search_index', { action: 'build' }));
    assert.equal(built.indexed, 2);
    assert.equal(object(array(await engine.dispatch('search', { q: 'signin', mode: 'hybrid' }))[0]).id, 'auth');
    await engine.dispatch('update', { id: 'auth', title: 'removed authentication issue' });
    assert.equal(object(await engine.dispatch('search_index', {})).reason, 'stale');
    assert.deepEqual(array(await engine.dispatch('search', { q: 'signin', mode: 'hybrid' })), []);
    await engine.dispatch('search_index', { action: 'build' });
    assert.equal(object(await engine.dispatch('search_index', {})).ready, true);
    process.env.SIS_ADMIN_TOKEN = 'fixture-token';
    await engine.dispatch('delete', { id: 'auth', admin_token: 'fixture-token' });
    assert.equal(object(await engine.dispatch('search_index', {})).reason, 'stale');
    await engine.dispatch('search_index', { action: 'build' });
    assert.ok(!array(await engine.dispatch('search', { q: 'signin', mode: 'hybrid' })).some(item => object(item).id === 'auth'));
    engine.db.run('DELETE FROM issues WHERE id=?', 'db');
    assert.equal(object(await engine.dispatch('search_index', {})).reason, 'stale');
    await engine.dispatch('search_index', { action: 'build' });
    const oldIndex = engine.searchProjection.path;
    process.env.SIS_VEC_MODEL = 'fixture-embeddings-v2';
    assert.equal(object(await engine.dispatch('search_index', {})).reason, 'model_changed');
    await assert.rejects(engine.dispatch('search_index', { action: 'build' }), /Restart/);
    const restarted = new Engine(join(root, 'issues.db'));
    try {
      assert.notEqual(restarted.searchProjection.path, oldIndex);
      assert.equal(object(await restarted.dispatch('search_index', { action: 'build' })).ready, true);
    } finally { await restarted.shutdown(); restarted.db.close(); }
  } finally {
    await engine.shutdown(); engine.db.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [name, value] of Object.entries(previous)) {
      const key = name === 'model' ? 'SIS_VEC_MODEL' : name === 'extension' ? 'SIS_VEC_EXTENSION' : name === 'port' ? 'SIS_VEC_PORT' : 'SIS_ADMIN_TOKEN';
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
