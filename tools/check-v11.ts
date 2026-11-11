import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolveTypeScript } from '../packages/superiss/compiler.ts';
import { VERSION } from '../packages/superiss/runtime.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url))), checks: string[] = [];
const env = {...process.env};
for (const name of ['SIS_DB','SIS_SOCK','SIS_HTTP','SIS_DIRECT','SIS_IMPL','SIS_CWD_DB','SISF_RUNTIME','SISF_BACKEND','SISF_ACTORS','SISF_GITEA_URL','SISF_GITEA_TOKEN','SISF_GH','SISF_WT']) delete env[name];
function run(name: string, executable: string, args: string[]) {
  const result = spawnSync(executable,args,{cwd:root,env,stdio:'inherit',timeout:180000});
  assert.equal(result.status,0,`${name}: exit=${result.status}, signal=${result.signal}, error=${result.error}`);checks.push(name);
}
const compiler = resolveTypeScript(env,root);
const typeRoots = env.SIS_TYPE_ROOTS ?? dirname(dirname(createRequire(import.meta.url).resolve('@types/node/package.json')));
run('current-core-types',compiler.command,['--project','packages/superiss/tsconfig.json','--typeRoots',typeRoots]);
run('forge-and-release-types',compiler.command,['--strict','--skipLibCheck','--noEmit','--allowImportingTsExtensions','--module','ESNext','--moduleResolution','Bundler','--target','ES2023','--types','node,bun','--typeRoots',typeRoots,...readdirSync(join(root,'sisf')).filter(name=>name.endsWith('.ts')).map(name=>'sisf/'+name),'tools/package-v1.ts','tools/check-v1-publication.ts','tools/v1-lifecycle.ts']);
run('current-core-regressions',process.execPath,['test','packages/superiss/ts/store.test.ts','packages/superiss/ts/session.test.ts','packages/superiss/ts/socket-client.test.ts','packages/superiss/search.test.ts','--bail']);
run('current-api-capsules-outcome-sync',process.execPath,['test','packages/superiss/api.test.ts','packages/superiss/local-zero.test.ts','packages/superiss/customer-outcome.test.ts','packages/superiss/woop.test.ts','tests/sis-sync.test.ts','--timeout','20000','--bail']);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
run('complete-wire-contract','python3',['packages/superiss/tests/contract_suite.py','--require-complete','--serve-cmd',quote(process.execPath) + ' ' + quote(join(root,'packages/superiss/cli.ts')) + ' serve']);
run('forge-contract-workflow-connectors-package',process.execPath,['test','sisf','--bail']);
run('forge-process-oracles','bash',['tools/verify-forge.sh']);
run('publication-docs-versions','python3',['tools/check-publication.py','--local']);
run('mcp-js-syntax','node',['--check','mcp/sis-mcp.js']);
run('launcher-shell-syntax','bash',['-n','bin/sis','bin/sis-v1','bin/sisf','bin/sis-reference']);
assert.equal(JSON.parse(readFileSync(join(root,'packages/superiss/package.json'),'utf8')).version,VERSION);
console.log(JSON.stringify({passed:true,version:VERSION,compiler:compiler.version,checks,analytics:'Run packages/superiss/check.ts and tools/check-v1-publication.ts with DuckDB 2 and run-guard for the additional full hybrid gate'}));
