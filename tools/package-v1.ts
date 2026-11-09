import { VERSION } from '../packages/superiss/runtime.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(repository, 'packages', 'superiss');
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export interface ReleaseManifest {
  version: typeof VERSION;
  sourceHash: string;
  bun: string;
  files: Record<string, string>;
  adapters: string[];
}
const adapterFiles = ['tools/v1-integrations.ts', 'tools/sis_runner.py', 'tools/sis_workflow.py', 'tools/service.ts', 'tools/service-lock.py', 'tools/service-soak.ts', 'sisf/sisf.ts'];
const launcher = `#!/usr/bin/env bash
set -euo pipefail
SELF="\${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do
  LINK="$(readlink "$SELF")"
  if [[ "$LINK" = /* ]]; then SELF="$LINK"; else SELF="$(dirname "$SELF")/$LINK"; fi
done
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
if [ "\${SIS_IMPL:-ts}" != ts ]; then
  printf '%s\\n' 'This 1.2 bundle contains the TypeScript runtime. Use the retained 0.9 installation for explicit Rust/Python reference commands.' >&2
  exit 2
fi
case "\${1:-}" in
  forge) shift; exec "\${SIS_BUN:-bun}" "$ROOT/packages/superiss/dist/sisf.js" "$@" ;;
  run|runner|service)
    if [ ! -f "$ROOT/tools/v1-integrations.ts" ]; then printf '%s\\n' 'Optional adapters unavailable; package with --with-adapters.' >&2; exit 2; fi
    exec "\${SIS_BUN:-bun}" "$ROOT/tools/v1-integrations.ts" "$ROOT/bin/sis" "$@" ;;
  up|down|status) exec "\${SIS_BUN:-bun}" "$ROOT/packages/superiss/dist/v1-lifecycle.js" "$ROOT/bin/sis" "$@" ;;
esac
exec "\${SIS_BUN:-bun}" "$ROOT/packages/superiss/dist/cli.js" "$@"
`;

/** New directory only. Never installs dependencies, modifies a database or switches current. */
export function packageRelease(destination: string, options: { adapters?: boolean } = {}): ReleaseManifest {
  const out = resolve(destination);
  assert.ok(!existsSync(out), 'Release destination already exists; refusing overwrite');
  let inputHashes: Record<string, string> = {};
  function sources(directory: string, prefix = ''): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['dist', '__pycache__', 'node_modules'].includes(entry.name)) continue;
      const relative = prefix + entry.name, path = join(directory, entry.name);
      if (entry.isDirectory()) sources(path, relative + '/');
      else if (entry.isFile()) inputHashes[relative] = sha(readFileSync(path));
      else throw Error('Release source must not contain symlinks or special files: ' + relative);
    }
  }
  function inputs(): string {
    inputHashes = {}; sources(source);
    for (const name of ['package-v1.ts', 'v1-lifecycle.ts']) inputHashes['../../tools/' + name] = sha(readFileSync(join(repository, 'tools', name)));
    sources(join(repository, 'sisf'), '../../sisf/');
    inputHashes['../../mcp/sis-mcp.js'] = sha(readFileSync(join(repository, 'mcp/sis-mcp.js')));
    inputHashes['../../LICENSE'] = sha(readFileSync(join(repository, 'LICENSE')));
    if (options.adapters) for (const name of adapterFiles) inputHashes['../../' + name] = sha(readFileSync(join(repository, name)));
    return JSON.stringify({ adapters: options.adapters === true, files: inputHashes });
  }
  const frozenInputs = inputs();
  mkdirSync(out, { mode: 0o700 });
  const runtime = join(out, 'packages', 'superiss');
  mkdirSync(join(runtime, 'dist'), { recursive: true });
  for (const entries of [[join(source, 'cli.ts'), join(source, 'analytics-worker.ts')], [join(repository, 'tools', 'v1-lifecycle.ts')], [join(repository, 'sisf', 'sisf.ts')]]) {
    const build = spawnSync(process.execPath, ['build', ...entries, '--target=bun', '--outdir=' + join(runtime, 'dist')], { cwd: repository, encoding: 'utf8', timeout: 30000 });
    assert.equal(build.status, 0, build.stderr || String(build.error));
  }
  for (const file of ['ops.json', 'package.json', 'README.md', 'ts/data/o200k_base.tiktoken', 'ts/data/cl100k_base.tiktoken', 'web/board.html']) {
    mkdirSync(dirname(join(runtime, file)), { recursive: true });
    copyFileSync(join(source, file), join(runtime, file));
  }
  copyFileSync(join(repository, 'LICENSE'), join(out, 'LICENSE'));
  if (options.adapters) for (const name of adapterFiles) {
    mkdirSync(dirname(join(out, name)), { recursive: true });
    copyFileSync(join(repository, name), join(out, name));
  }
  mkdirSync(join(out, 'mcp'));
  copyFileSync(join(repository, 'mcp/sis-mcp.js'), join(out, 'mcp/sis-mcp.js'));
  assert.equal(inputs(), frozenInputs, 'Source changed during build/copy; release refused');
  mkdirSync(join(out, 'bin'));
  writeFileSync(join(out, 'bin', 'sis'), launcher, { mode: 0o755 });
  chmodSync(join(out, 'bin', 'sis'), 0o755);
  writeFileSync(join(out, 'bin', 'sisf'), launcher.slice(0,launcher.indexOf('if [ "')) + 'exec "${SIS_BUN:-bun}" "$ROOT/packages/superiss/dist/sisf.js" "$@"\n', {mode:0o755});
  const files: Record<string, string> = {};
  for (const entry of readdirSync(out, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    files[full.slice(out.length + 1)] = sha(readFileSync(full));
  }
  const manifest: ReleaseManifest = { version: VERSION, adapters: options.adapters ? ['workflow', 'service', 'forge'] : [], sourceHash: sha(frozenInputs), bun: process.versions.bun ?? '', files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length === 3 || process.argv.length === 4 && process.argv[3] === '--with-adapters', 'Usage: bun tools/package-v1.ts NEW_DESTINATION [--with-adapters]');
  console.log(JSON.stringify(packageRelease(process.argv[2], { adapters: process.argv[3] === '--with-adapters' })));
}
