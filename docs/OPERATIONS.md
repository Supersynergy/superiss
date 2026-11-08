# Core operation catalog — 1.1.0

Generated from [the current registry](../packages/superiss/ops.json). **88 core operations**, protocol 2. The ten forge tools are listed in [the forge guide](SISF.md). The retained root registry belongs to the 0.9 reference.

| Operation | Contract | Required fields |
| --- | --- | --- |
| `create` | Create a task with executable acceptance and explicit writable paths. | `title` |
| `update` | Edit task content; worker status/lease mutations are prohibited. | `id` |
| `admin_update` | Administrative correction; requires configured server admin token and reason. | `id`, `admin_token`, `reason` |
| `dep` | Add typed dependencies; blocks edges are acyclic and gates await named approval. |  |
| `dep_list` | List typed dependencies for an issue or store. |  |
| `dep_remove` | Remove a specific dependency edge. | `issue`, `depends_on` |
| `ready` | Read ready task data with explicit filters. |  |
| `list` | Read list task data with explicit filters. |  |
| `query` | Read query task data with explicit filters. |  |
| `count` | Read count task data with explicit filters. |  |
| `next` | Read qualified leaf tasks in a goal subtree; does not claim ownership. |  |
| `acquire` | Atomically select qualified work and return claim plus complete bounded contract. | `actor` |
| `claim` | Claim executable work; finalize:true explicitly claims a container after descendant acceptance. meta.autorun enqueues an outbox autorun job for external runners. | `id`, `actor` |
| `claim_next` | Atomically claim the next qualified task within goal/lane. | `actor` |
| `heartbeat` | Refresh a live matching lease and read cancellation intent. | `id`, `actor`, `epoch` |
| `unclaim` | Release only your current fenced live claim. | `id`, `actor`, `epoch` |
| `reclaim` | Recover expired claims; inspect stale facts and ownership before use. |  |
| `verify` | Run declared oracle with bounded resources; persist source-bound verification receipt. | `id`, `actor`, `epoch`, `cwd` |
| `close` | Close only with valid matching source-bound verification receipt; honors meta.review_required, meta.attest_required and meta.budget_gate (cost rollup must fit budget_eur). | `id`, `actor`, `epoch`, `proof_id` |
| `reopen` | Reopen your/controller task with a fresh epoch; admin token for administrative recovery. | `id`, `actor` |
| `delete` | Administrative task deletion with configured admin authority. | `id` |
| `defer` | Defer task until explicit release or due timestamp. | `id` |
| `undefer` | Make a deferred task eligible for qualification. | `id` |
| `show` | Read complete task, dependencies and bounded recent events. | `id` |
| `search` | Search task text with a bounded result limit. | `q` |
| `children` | Read immediate goal/task children. | `id` |
| `label` | Add or remove task labels. | `id` |
| `rename` | Rename task identity and related references administratively. | `from`, `to` |
| `note` | Append an audit note; task status remains unchanged. | `id`, `text` |
| `changes` | Record a compact file-edit summary for a task: path, +adds/-dels and hunk line ranges from the real git worktree (sis changes <id> [--repo P] [--base R] [--patch]). Append-only evidence — no code stored unless --patch snapshots a bounded diff. Identical consecutive diffs dedup unless force:true. sis close records the same automatically. | `id` |
| `comments` | Read task notes. | `id` |
| `history` | Read ordered task events. | `id` |
| `checkpoint` | Persist bounded source-bound progress and next safe step under a valid lease. | `id`, `actor`, `epoch`, `text`, `next_step` |
| `handoff` | Checkpoint bounded progress and release the fenced claim in one step so a successor agent can claim immediately; `to` names the intended successor. | `id`, `actor`, `epoch`, `text`, `next_step` |
| `resume` | Read current contract and last checkpoint with drift/cancellation information. | `id` |
| `who` | Dirty-worktree attribution: maps each dirty/untracked path in a git repo to the recorded changes event (claim/actor) that produced it. Orphaned paths with no matching event surface explicitly — answers 'wem gehoert dieser Stand?'. |  |
| `cancel` | Request cancellation as current worker or declared controller. | `id`, `actor` |
| `cancel_ack` | Acknowledge cancellation, end the live lease and fence old work. | `id`, `actor`, `epoch` |
| `contract` | Read complete stable task contract and its revision. | `id` |
| `brief` | Render token-budgeted task context without dropping mandatory acceptance. | `id` |
| `tokens` | Count selected tiktoken encoding; explicitly separate count from model billing. | `text` |
| `context` | Read stable project identity, database path, capabilities and current stats. |  |
| `capabilities` | Discover operation names and store identity; request schemas only when needed. |  |
| `watch` | Read durable events after cursor or subscribe with bounded wait. |  |
| `lint` | Read lint diagnostics without dispatching work. |  |
| `types` | Read types diagnostics without dispatching work. |  |
| `statuses` | Read statuses diagnostics without dispatching work. |  |
| `prime` | Read prime diagnostics without dispatching work. |  |
| `orphans` | Read orphans diagnostics without dispatching work. |  |
| `stats` | Read stats diagnostics without dispatching work. |  |
| `review` | Read review diagnostics without dispatching work. |  |
| `stale` | Read expired task leases. |  |
| `remember` | Persist a project-scoped learning value. | `key`, `value` |
| `recall` | Read project-scoped learning values. |  |
| `export` | Export project state for audit or backup. |  |
| `import` | Import administrative event state with explicit admin authority. bd format is conflict-aware: live claims and closed issues are reported, never silently overwritten (force:true to reopen). | `admin_token` |
| `batch` | Apply a bounded atomic mutation batch; verifier execution is excluded. | `ops` |
| `budget_claim` | Reserve finite nonnegative task budget atomically. | `issue`, `eur` |
| `outbox_list` | Read unprocessed transactional lessons. |  |
| `outbox_done` | Confirm successful processing of one outbox record. | `id` |
| `outbox_fail` | Record failed outbox processing for bounded recovery. | `id`, `err` |
| `compact` | Archive old events and reap only expired ephemeral task hints. |  |
| `gate` | Read or set a named approval gate; unknown gates are closed. | `name` |
| `gate_list` | Read named approval gates. |  |
| `slot_acquire` | Acquire a fenced expiring merge slot. | `name`, `actor` |
| `slot_release` | Release your matching fenced merge slot. | `name`, `actor`, `epoch` |
| `slot_list` | Read merge-slot holders and epochs. |  |
| `epic` | Read task hierarchy with completion rollup. | `id` |
| `dup_scan` | Find likely duplicate tasks before creating new work. |  |
| `q` | Capture a task using the create contract. | `title` |
| `goal` | Create a named goal container with final acceptance. | `name` |
| `sub` | Create a child task under a goal without a blocking parent edge. | `parent`, `title` |
| `plan` | Create atomic goal tree and validated internal dependencies; save or reuse a named template. | `name` |
| `goal_tree` | Read named goal hierarchy and progress. |  |
| `goal_done` | Check subtree completion; caller still needs verified final goal acceptance. | `id` |
| `snapshot` | Write the git-diffable <db>.issues.jsonl mirror (one upsert line per issue, deps embedded, sorted by id). Runs automatically after every committed write op; SIS_SNAPSHOT=0 disables. |  |
| `attest` | Attach a structured machine-checkable attestation (junit/coverage/smoke/artifact/custom/run) to the active claim, bound to contract revision and source fingerprint. kind:"run" executes cmd store-side — the receipt is not forgeable client-side. Required kinds via meta.attest_required are enforced at close. |  |
| `cost_add` | Append a cost entry (tokens/cents) to an issue's durable ledger; idempotent via idem key. |  |
| `cost_list` | List cost ledger entries, filterable by issue/actor/run_id/wave. |  |
| `cost_rollup` | Roll up costs over the container subtree of id (meta.parent + id-prefix): totals plus per-issue/actor/wave breakdown and budget reference. | `id` |
| `outbox_export` | Render pending outbox rows as durable-runner jobs: formats raw, pgboss-sql, hatchet, temporal; drain:true marks exported rows done atomically. |  |
| `learn` | Honest learning aggregates over the ledger: attest/proof pass rates, cost (cents/tokens) and time-to-accepted grouped by actor\|wave\|kind\|issue — the posterior for bandit/routing decisions, no invented score. |  |
| `sync_export` | Emit a deterministic sis-sync bundle (schema-stamped issues+deps, memories, proof+attest receipts; events with events:true) for multi-machine replication. |  |
| `sync_import` | Admin: merge a sis-sync bundle — issue/deps upsert, memory LWW by updated_at, receipts by primary key; live claims are never overwritten and report as conflicts. | `admin_token` |
| `spans` | Read back OTel-shaped span lines emitted under SIS_EMIT for observability of claim/verify/close and other requests. |  |
| `analytics` | Read a consistent, explicitly watermarked SQLite snapshot using an isolated DuckDB 2 process; never authoritative for claims or proofs. |  |
| `analytics_status` | Observe the bounded analytics worker without starting a report. |  |
| `close_check` | Read-only preflight of the complete close contract: current source, proof, actor, epoch, lease, review, evidence and budget. Does not close or reserve the task. | `id`, `actor`, `epoch`, `proof_id` |
