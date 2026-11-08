# Superiss: API and optional v1 integrations

This is an opt-in source/bundle integration, not a deployment or a completed 24-hour release test. The retained reference installation and running services are unchanged.

## Local API and tracker

Start the **versioned** daemon with an explicit project database and socket:

```sh
/path/to/bin/sis-v1 serve --db /absolute/project/tasks.db --sock /absolute/project/tasks.sock --http 8765
```

The HTTP listener binds to `127.0.0.1`. It is a trusted-local-user interface, not an authenticated multi-user or Internet-facing API. Do not expose it through a public proxy. Same-origin/Host/Fetch-Site checks reject browser cross-origin requests; these do not authenticate local processes.

- `GET /`: existing read-only tracker board (goals, tasks, owners, claims, lease countdowns, dependencies and history).
- `GET /api/v1/capabilities`, `/api/v1/context`, `/api/v1/openapi.json`: discovery and OpenAPI 3.1.
- `POST /api/v1/rpc`: `{ "cmd": "stats", "args": {}, "request_id": "stats-1" }`.
- `POST /api/v1/ops/<name>`: `{ "args": { ... }, "actor": "worker", "idem": "stable-key" }`. Explicit actor/epoch requirements still apply.
- `GET /api/v1/tracker?owner=worker&status=in_progress&limit=100&offset=0`: consistent tracker snapshot, event `cursor`, total and `next_offset`; optional `lane` and `view=blocked|expired|failed-proof`. Pages allow 1–500 items. Reads never claim, reclaim or execute work.
- `GET /api/v1/loops/<id>`: compact native loop receipt with scope/oracle/revision, current claim validity, persisted checkpoint and drift, last proof, failing oracle and a safe next `resume` operation. Proof currency and unmeasured timings stay unknown; a successful historical proof is not permission to close or replay.
- `GET /api/v1/events?after=0&limit=100&wait=10`: bounded long-poll with a resumable event cursor (`next_after`). Cursor is the last delivered event, not the current database head; a limited page does not skip events.
- `/op` remains compatible for JSON POST and allowlisted read-only GET operations. GET mutations return 405. Batch remains atomic, bounded, non-nested and cannot execute shell commands.

Requests need `Content-Type: application/json`; the body limit is 1 MiB, the header limit 16 KiB. `request_id` correlates replies; it does **not** deduplicate changes. Use a stable `idem` key for retryable mutations. Reconcile uncertain outcomes before retrying execution. Pass `actor`, `idem` and `run_id` in the JSON envelope. Error replies retain stable codes; failing proof results still need `passed:true`, not a successful HTTP status alone.

```sh
curl -H 'Content-Type: application/json' http://127.0.0.1:8765/api/v1/rpc \
  --data '{"cmd":"stats","args":{},"request_id":"stats-1"}'
```

No API credential is printed or accepted in a URL. Administrative-token transport, remote hosting and multi-user authorization are intentionally not added here.

## Workflow, runner, service and Forge

```sh
/path/to/bin/sis-v1 run --db /absolute/project/tasks.db --issue task-id --actor worker --timeout 10 --deadline 120
/path/to/bin/sis-v1 run --db /absolute/project/tasks.db --issue task-id --actor worker --resume
/path/to/bin/sis-v1 runner --db /absolute/project/tasks.db --actor delivery-worker --once
/path/to/bin/sis-v1 service defaults
/path/to/bin/sis-v1 service foreground --config /absolute/project/service.json
/path/to/bin/sis-v1 forge health --db /absolute/project/tasks.db --sock /absolute/project/tasks.sock
```

Adapters reuse the existing Python-standard-library controller/runner and Bun service/Forge, rather than copying their state machines. Python 3 is required only by workflow/runner and the foreground service lock. Runtime overrides through `--sis`/`--complete` are rejected; service configuration must explicitly pin `sis` to the selected versioned launcher. The ordinary retained launcher is not silently switched. Service foreground is explicit; packaging never installs a launchd job. Installation, publication, pushes, external worker calls and deployments still require their normal authorization.

`local_zero` is fail-closed: an explicit zero budget, no recorded positive cost, unchanged security metadata and the configured execution contract are required. macOS Seatbelt denies network/IPC, writes outside the execution directory and private home-directory reads outside that directory; execution receives a minimal environment, not inherited provider credentials. This is not a general confidential-computing boundary: only put intended input files inside the workspace, keep sensitive files out of globally readable directories, and do not grant a workspace ancestor of private data. Unsupported platforms refuse local-zero execution. The controller lock is validated and inherited by child commands so a crashed controller cannot immediately replay a live effect.

Outbox exports can be leased with `actor`/`ttl`; jobs include delivery epoch, lease deadline and a delivery-specific idempotency key. Autorun execution is bound to the issue claim and matching delivery payload/lease. A durable effect marker commits before execution, independently of delivery epochs. After lease expiry, a stored result finalizes the delivery without replay; an interrupted or unknown effect becomes failed with `execution_uncertain` and needs reconciliation, even when replay safety was configured. Only deliveries with no started effect can be retried, at most three times. Finalization by a runner requires its matching live delivery fence. Unleased legacy exports remain available for inspection/integration compatibility.

Forge negotiates the advertised `watch_wait_frames` capability. TypeScript sends one bounded long-poll response; the retained native protocol sends snapshot plus response. A second normal request must not be consumed as a missing watch frame.

## Portable bundle

```sh
bun tools/package-v1.ts /absolute/new/core-release
bun tools/package-v1.ts /absolute/new/integrated-release --with-adapters
```

Destinations must not exist. Both variants retain Bun plus explicit-database requirements. The core variant deliberately omits optional adapters and fails with an actionable message if one is invoked. The integrated variant copies the existing controller, runner, service lock/soak helpers and Forge into the bundle. `manifest.json` lists adapters and file hashes; adapter source inputs are included in `sourceHash` and checked for drift while building. Relocate the entire directory, then use its `bin/sis`; generated service configs must pin that relocated path. No dependency installation or current-version symlink is changed.

## Acceptance and rollback

```sh
bun tools/verify-v1-integrations.ts
```

This runs the unchanged hybrid gate, API/local-zero regressions, real isolated workflow/proof/close and interrupted-controller recovery, a real foreground-service task and drain, Forge/TypeScript socket interoperability, relocated integrated-bundle execution, and existing service/Forge regressions. Fixtures use fresh temporary databases and own processes only. The independent 24-hour soak retains its original release contract.

The source integration remains uncommitted and reversible. Restore only this slice's named source edits and remove only its newly added files; preserve unrelated soak edits. To undo a bundle evaluation, stop only that evaluation's owned processes and keep using the retained installation. Nothing is deployed by the acceptance command.

## Reusable API client and bounded worker capsules (1.1, opt-in)

`packages/superiss/ts/client.ts` provides `SuperissClient` for Bun/Node callers in this source checkout. It shares up to four keepalive sockets (configurable 1–16), caps outstanding requests at 64, bounds request/response sizes and wall-clock deadlines, supports `AbortSignal`, validates RPC correlation and never follows redirects or retries a lost acknowledgement. `close()` cancels active **and queued** requests. `passed:false` remains a failed proof, not a transport exception or success. The source client is not an installed SDK; existing bundles/releases are unchanged.

```ts
import { SuperissClient } from './packages/superiss/ts/client.ts';
const client = new SuperissClient('http://127.0.0.1:8123');
try {
  const tracker = await client.tracker({ view: 'blocked', limit: 20 });
  const capsule = await client.capsule('TASK', { max_tokens: 2000 });
  // Dispatch only after an explicit native claim; usable is advisory, not authority.
  const resume = await client.rpc('resume', { id: 'TASK' });
} finally { client.close(); }
```

`GET /api/v1/capsules/{id}?max_tokens=2000&encoding=o200k_base` binds the current source hash, contract revision, actual claim fence and recovery receipt in one read-only call. Supported encodings: `o200k_base`, `cl100k_base`; budget: 128–8000. The entire `text` field is token-counted, excluding only its JSON transport envelope. Optional changes/description may be omitted and are reported; scope, oracle, acceptance, security metadata, fence and drift are never truncated to fit. Insufficient mandatory budget fails with `budget_exceeded`. Drift invalidates `usable`; historical proofs remain historical. Native claim/lease/source checks still apply to every mutation. This does not prove provider billing or end-to-end coding speed.

## Organizing controllers, workers and reviewers

Use one native project DB and distinct actors, not another task board or model router. The controller owns decomposition, scope, oracle and the caller's stable idempotency keys. A worker explicitly acquires one disjoint slice, consumes its capsule, heartbeats and checkpoints before handoff. A separate reviewer checks the matching revision/source hash; the controller runs native `verify`, checks `passed:true` and then closes with that proof and required review receipt. Cancellation, expired leases or uncertain effects stop execution; reconnect starts with `resume`, never blind replay.

Sweetspot decisions remain workload-specific: record actual stages, failures, source identity, model/effort, tokens and billed cost through existing native `attest`, `cost_add`, `cost_rollup` and `learn` operations over `client.rpc`. Unknown values stay unknown. Compare at least three paired runs at equal acceptance, including review and rework; no automatic paid route or model choice is introduced. Private chat excerpts are research leads only and are not copied into this repository or promoted to benchmark evidence.

## 1.1: tracker/loop API implemented, not a published release

The snapshot and receipt endpoints above are available in the opt-in source integration. A snapshot's cursor is read in the same SQLite transaction as its issues. Subscribe to events after that cursor and refresh the snapshot after changes; paginated snapshot requests are live views, not a frozen multi-page export. Reconnect/restart preserves data because the native store remains authoritative. Loop receipts reuse native `resume` source-drift checks and do not automatically retry effects or run shell commands. Timings are `null` until measured; no latency or cost improvement is claimed.

Remaining work must retain the following acceptance boundaries:

| Priority | Feature and integration point | Acceptance |
| --- | --- | --- |
| Implemented | Tracker snapshot/delta API over the same issue/claim/event store; actionable blocked/expired/failed-proof views, no second tracker database | Paginated events cannot skip changes; filters preserve ownership; view survives reconnect/restart |
| Implemented | Compact loop receipt: verdict, source revision, failing oracle, safe next operation, checkpoint/artifacts and changes | Native drift/fence data survives restart; timings stay unknown without evidence. Green-check reuse still requires matching source and oracle |
| Implemented | Source-bound context capsules using native `resume` and scope hashing | Mandatory scope/oracle/fence data never disappears under a token limit; drift invalidates stale capsules |
| Implemented | Reusable bounded HTTP client, correlated requests, event waits and active/queued cancellation | Same errors, recovery and cancellation as baseline; paired cold/warm acceptance-time measurements before any speed claim |
| P1 | Workload-specific Sweetspot evidence (provider/model/effort/runner/oracle, completion time, failures, actual spend) | Never choose from token count alone; no paid fallback or quota assumption; routing only from matching verified evidence |
| P1 | Reference external loop receipts through the API, not duplicate browser/controller engines | Existing owner, source identity and original oracle are retained; failed/unknown outcomes remain failed/unknown |

Organize work by one native Superiss task per closed, testable slice, dependency edges for real prerequisites, and one owner/lease per write scope. Private ChatGPT archives stay outside this public repository and release bundles. Historical chat recommendations are hypotheses until a matching local oracle/measurement confirms them; this plan does not claim that every private chat has been downloaded or reviewed.
