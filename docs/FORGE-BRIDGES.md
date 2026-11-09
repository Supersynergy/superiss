# Superiss 1.2: cooperating tools and portable forks

The 1.2 source candidate combines the local 1.1 API/client/capsule work with
the integrated Forge adapter. GitHub `main` at `2b200f3` (1.1 source) is merged
as an ancestor, preserving both local and upstream behavior. A candidate bundle is an opt-in executable artifact;
it does not change an installed runtime or running service.

## One project authority, several tools

Use one project SQLite database, one native claim per task, and distinct
actors such as `codex-mac`, `devin-mac`, and `synergycoder-linux`. Keep the
original issue URL as an input reference. Native tasks hold the executable
acceptance, path scope, claim fence, checkpoint and proof. Git holds source;
GitHub or Gitea holds remote review, access control and required CI.

The local claim/capsule/event loop can operate without a GitHub request on
every step. This is an architectural choice, not a measured productivity or
token-saving result. Remote review and publication remain explicit actions.

| Tool interface | Existing bridge | Required behavior |
| --- | --- | --- |
| Shell or coding CLI | Versioned `bin/sis`, `forge wt`, `forge commit` | Explicit DB; retain actor/epoch; heartbeat before expiry |
| MCP client | `mcp/sis-mcp.js`, agent profile | Project handshake; bounded calls; stable native idempotency keys |
| Bun/Node application | `packages/superiss/ts/client.ts` | Bounded keepalive, deadlines, cancellation; no uncertain replay |
| HTTP application | `/api/v1/rpc`, tracker/events/capsules | Loopback trusted user; correlate replies; check `passed:true` |
| Remote review | Existing Gitea/GitHub/mirror connectors | Explicit authorization, remote SHA and CI/review checks |

The reusable client remains a source API. It is not an independently installed
SDK, and the optional bundle does not promise a new external module layout.
Current core and Forge MCP entry points use the version-bound TypeScript
protocol. The Forge adapter selects the old two-frame watch protocol only with
explicit `--runtime reference`; it rejects incompatible current versions.

## A complete task loop

1. The controller defines acceptance, the executable oracle and exact writable
   paths. Reuse an existing task instead of copying a board.
2. A worker acquires the native task. For immediately assigned new work,
   `forge reserve` creates contract and claim atomically before binding Git;
   it avoids exposing ready work between separate create/claim calls.
   Carry the returned actor/epoch and
   heartbeat; fetch a source-bound capsule within a measured token budget.
3. Bind the claim to its locked Forge worktree. Work on disjoint scopes.
   A missing or conflicting binding must be reconciled before writing.
4. Checkpoint references and failing checks. Reconnection begins with `resume`;
   it does not replay commands whose effects are uncertain.
5. Review the final source hash. Run native `verify`, require `passed:true`,
   then fenced `close` with the stored proof and required review receipt.
6. Prepare the exact Git patch/commit for remote review. Publication and merge
   use the selected forge's protected workflow.

Tools unable to preserve a heartbeat and fence should perform bounded
read-only/review work. Do not imitate a healthy lease on their behalf.

## Conflict isolation in 1.2

An old task binding remains attached to its original actor/epoch. A new claim
does not inherit its bytes, branch or lock. Deterministic binding conflicts
are stored in the adapter's existing state and no longer block later tasks.
Socket, Git and SQLite infrastructure failures still retry and affect health.

Inspect without repair:

```sh
bin/sis-v1 forge reconcile --db /absolute/project/tasks.db
# A running adapter also exposes GET /sisf/reconcile.
```

Preserve or commit old work, release claims only under their current authority,
and plan an explicit recovery branch before rebinding. The preview does not
authorize deletion or ownership transfer.

Snapshot sync refuses a pre-existing staged index or unrelated tracked edits.
It commits only the snapshot path. Failed pushes keep the local commit for
reconciliation; do not reset or overwrite another worker's index. A remote
claim snapshot is not permission to reuse its actor or live lease.

The isolated ten-client fixture checks distinct bindings and a single winner
for a contested task. It does not establish sustained ten-tool throughput,
remote forge availability or production load limits.

Local merge exclusion also spans separate stores using the same Git common
directory and base. Read-only reconciliation lists abandoned/conflicting
merge locks; neither process age nor lease expiry triggers reclamation.
Interrupted Git writes retain an explicit uncertain outcome and observed
target ref. A changed branch prevents closure even if its commit matches.

## Keep extensions remigratable

Prefer a small external CLI/MCP/HTTP bridge. Avoid copying an upstream tool's
planner, runtime, UI or task database. Record the upstream revision, transport
version and supported capabilities; negotiate capabilities instead of inferring
them from a product name. Keep secrets out of manifests and Git.

When an upstream change is necessary, keep a separate fork with an upstream
remote and one adapter directory or documented extension hook. Separate commits
for protocol glue, recovery behavior and tool-specific configuration. Retain a
patch series and fixture tests against pinned upstream versions. Update a clean
integration branch, replay the series, and run the same acceptance before
replacing the executable. An unchanged upstream executable plus external bridge
is the rollback path.

Cross-tool handoff carries task/project identity, revision, scope, oracle,
claim fence and evidence references. It need not carry the full chat transcript.
The capsule's exact local token count is not provider billing; measure accepted
completion time, all failed attempts, review/rework, tokens and actual spend
before asserting savings.

## Merge boundary

Upstream adds `forge verify` and a proof/CI/merge-slot-gated local fast-forward
merge with native `close_check` and explicit partial-success reporting. It
checks the current source, live fence, exact local HEAD and target ancestry.
Remote push, PR creation and local merge remain separate explicit actions.
A protected remote PR merge and durable remote-effect reconciliation are not
automatically performed; uncertain acknowledgements require reconciliation.

Configured repositories support explicit task routing through the upstream
Forge integration. Fleet dispatch, durable remote PR-effect reconciliation and
cross-store atomicity remain separate work; a repository map alone does not
transfer native project authority.

## Local source reconciliation

The public local working tree contributes the 1.1 API, client, capsule,
local-zero/outbox protections, integration adapters and their tests. The private
standalone `ts/` port is their earlier core; replacing the public package with
it would remove those protections. The public Forge adapter also retains newer
ownership checks than the private copy.

The private Rust/Python reference deltas include dependency updates, additional
cross-runtime tests and schema tooling. Their three-way comparison contains
Python/Cargo conflicts. They remain preserved as separate reference work; they
are not silently applied to the TypeScript 1.2 runtime or represented as a
completed cross-runtime release. No dependencies are installed. The inherited
1.1 outbox integration adds `sis_ts_delivery_leases` to new stores and, on first
leased export, to existing stores; the SQLite `user_version` remains unchanged.
No live project store is adopted or migrated by packaging or fixture tests.
