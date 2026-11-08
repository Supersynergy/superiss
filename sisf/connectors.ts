import { command, git } from './process.ts';

export type Connector = 'github' | 'gitea' | 'forgejo';
export interface ForgeConfig { url: string; token?: string }
export interface CIStatus { sha: string; state: 'success' | 'failure' | 'pending' | 'none'; checks: number; via: Connector }
export interface PullRequest { pr_url: string; number: number; head: string; base: string; reused: boolean }

export function parseRemote(remote: string): { owner: string; repo: string } | null {
  const match = remote.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/i)
    ?? remote.match(/^[^@\s]+@[^/\s:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match || [match[1], match[2]].some(value => !/^[A-Za-z0-9_.-]+$/.test(value) || value === '.' || value === '..')) return null;
  return { owner: match[1], repo: match[2] };
}
function remote(repo: string) {
  const parsed = parseRemote(git(repo, 'remote', 'get-url', 'origin') ?? '');
  if (!parsed) throw Error('origin must identify an explicit forge owner/repository');
  return parsed;
}
export function safeURL(value: unknown): string {
  try { const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}
function checkedPR(value: any, head: string, base: string, reused: boolean): PullRequest {
  const url = safeURL(value.html_url ?? value.url);
  if (!url || !Number.isSafeInteger(value.number) || value.number < 1) throw Error('Forge returned an invalid PR receipt; reconcile before retry');
  return { pr_url: url, number: value.number, head, base, reused };
}
function apiPath(repo: string): string { const r = remote(repo); return `repos/${r.owner}/${r.repo}`; }
async function rest(config: ForgeConfig, path: string, body?: unknown): Promise<any> {
  const base = new URL(config.url);
  if (!safeURL(base.href) || base.search || base.hash) throw Error('Invalid forge API base URL');
  const response = await fetch(base.href.replace(/\/$/, '') + '/api/v1/' + path, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(config.token ? { authorization: 'token ' + config.token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // Bound the response before JSON parsing; API errors never include credentials.
  const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  if (reader) for (;;) { const {done,value} = await reader.read(); if (done) break; length += value.length; if (length > 4 * 1024 * 1024) { await reader.cancel(); throw Error('Forge response exceeds 4 MiB'); } chunks.push(value); }
  if (!response.ok) throw Error(`Forge API HTTP ${response.status}; reconcile writes before retry`);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('Forge returned invalid JSON; reconcile writes before retry'); }
}
const ghProgram = () => process.env.SISF_GH || 'gh';
async function gh(repo: string, args: string[]): Promise<any> { return JSON.parse(await command(ghProgram(), args, repo)); }

export async function pullRequest(via: Connector, config: ForgeConfig | null, repo: string, branch: string, base: string, task: string, title: string): Promise<PullRequest> {
  if (via === 'github') {
    const parsed = remote(repo), slug = `${parsed.owner}/${parsed.repo}`;
    const existing = await gh(repo, ['pr', 'list', '--repo', slug, '--head', branch, '--base', base, '--state', 'open', '--json', 'number,url,headRefName,baseRefName']);
    if (!Array.isArray(existing)) throw Error('Invalid GitHub PR list');
    if (existing.length > 1) throw Error('Ambiguous existing PRs for branch/base');
    if (existing.length === 1) return checkedPR(existing[0], branch, base, true);
    const url = await command(ghProgram(), ['pr', 'create', '--repo', slug, '--head', branch, '--base', base, '--title', `[${task}] ${title}`, '--body', `Superiss task: ${task}\n\nAcceptance is tracked by Superiss; forge merge rules remain authoritative.`], repo);
    if (!safeURL(url)) throw Error('GitHub PR outcome uncertain; reconcile before retry');
    return checkedPR(await gh(repo, ['pr', 'view', url, '--repo', slug, '--json', 'number,url']), branch, base, false);
  }
  if (!config) throw Error(`${via} connector is not configured`);
  const path = apiPath(repo), owner = remote(repo).owner;
  const query = new URLSearchParams({ state: 'open', head: `${owner}:${branch}`, base, limit: '100' });
  const existing = await rest(config, `${path}/pulls?${query}`);
  if (!Array.isArray(existing) || existing.length >= 100) throw Error('PR search is invalid or truncated; reconcile explicitly');
  const matches = existing.filter(pr => pr.head?.ref === branch && pr.base?.ref === base);
  if (matches.length > 1) throw Error('Ambiguous existing PRs for branch/base');
  if (matches.length) return checkedPR(matches[0], branch, base, true);
  return checkedPR(await rest(config, `${path}/pulls`, { head: branch, base, title: `[${task}] ${title}` }), branch, base, false);
}

export async function ciStatus(via: Connector, config: ForgeConfig | null, repo: string, sha: string): Promise<CIStatus> {
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw Error('CI requires the exact commit SHA');
  const path = apiPath(repo);
  if (via !== 'github') {
    if (!config) throw Error(`${via} connector is not configured`);
    const value = await rest(config, `${path}/commits/${sha}/status`);
    if (!Array.isArray(value.statuses)) throw Error('Invalid forge status response');
    const state = !value.statuses.length ? 'none' : value.state === 'success' ? 'success' : ['failure','error'].includes(value.state) ? 'failure' : 'pending';
    return { sha, state, checks: value.statuses.length, via };
  }
  const [checks, statuses] = await Promise.all([
    gh(repo, ['api', `${path}/commits/${sha}/check-runs?per_page=100`]),
    gh(repo, ['api', `${path}/commits/${sha}/status?per_page=100`]),
  ]);
  if (!Array.isArray(checks.check_runs) || !Array.isArray(statuses.statuses) || checks.total_count > checks.check_runs.length || statuses.total_count > statuses.statuses.length || statuses.statuses.length >= 100) throw Error('CI result invalid or truncated; cannot establish passing CI');
  const count = checks.check_runs.length + statuses.statuses.length;
  const failed = checks.check_runs.some((r: any) => r.status === 'completed' && !['success','neutral','skipped'].includes(r.conclusion)) || statuses.statuses.some((s: any) => ['failure','error'].includes(s.state));
  const pending = checks.check_runs.some((r: any) => r.status !== 'completed') || statuses.statuses.some((s: any) => s.state !== 'success');
  return { sha, state: !count ? 'none' : failed ? 'failure' : pending ? 'pending' : 'success', checks: count, via };
}
