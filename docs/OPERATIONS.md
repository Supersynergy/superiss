# Complete operation catalog

Generated from `ops.json` in this source release. **85 operations**, protocol 2, schema 8. Descriptions specify the API contract; host observations are not authenticated third-party evidence.

Use `bin/sis capabilities schemas=true --db /absolute/path/project.db` for the full schemas. CLI lifecycle commands `run`, `service`, `up`, `status`, `down`, `serve` and `mcp` are separate from the registry count.

| Operation | Required inputs | Contract |
| --- | --- | --- |
| `create` | `title` | Create a task with executable acceptance and explicit writable paths. |
| `update` | `id` | Edit task content; worker status/lease mutations are prohibited. |
| `admin_update` | `id`, `admin_token`, `reason` | Administrative correction; requires configured server admin token and reason. |
| `dep` | none | Add typed dependencies; blocks edges are acyclic and gates await named approval. |
| `dep_list` | none | List typed dependencies for an issue or store. |
| `dep_remove` | `issue`, `depends_on` | Remove a specific dependency edge. |
| `ready` | none | Read ready task data with explicit filters. |
| `list` | none | Read list task data with explicit filters. |
| `query` | none | Read query task data with explicit filters. |
| `count` | none | Read count task data with explicit filters. |
| `next` | none | Read qualified leaf tasks in a goal subtree; does not claim ownership. |
| `acquire` | `actor` | Atomically select qualified work and return claim plus complete bounded contract. |
| `claim` | `id`, `actor` | Claim executable work; finalize:true explicitly claims a container after descendant acceptance. meta.autorun enqueues an outbox autorun job for external runners. |
| `claim_next` | `actor` | Atomically claim the next qualified task within goal/lane. |
| `heartbeat` | `id`, `actor`, `epoch` | Refresh a live matching lease and read cancellation intent. |
| `unclaim` | `id`, `actor`, `epoch` | Release only your current fenced live claim. |
| `reclaim` | none | Recover expired claims; inspect stale facts and ownership before use. |
| `verify` | `id`, `actor`, `epoch`, `cwd` | Run declared oracle with bounded resources; persist source-bound verification receipt. |
| `close` | `id`, `actor`, `epoch`, `proof_id` | Close only with valid matching source-bound verification receipt; honors meta.review_required, meta.attest_required and meta.budget_gate (cost rollup must fit budget_eur). |
| `reopen` | `id`, `actor` | Reopen your/controller task with a fresh epoch; admin token for administrative recovery. |
| `delete` | `id` | Administrative task deletion with configured admin authority. |
| `defer` | `id` | Defer task until explicit release or due timestamp. |
| `undefer` | `id` | Make a deferred task eligible for qualification. |
| `show` | `id` | Read complete task, dependencies and bounded recent events. |
| `search` | `q` | Search task text with a bounded result limit. |
| `children` | `id` | Read immediate goal/task children. |
| `label` | `id` | Add or remove task labels. |
| `rename` | `from`, `to` | Rename task identity and related references administratively. |
| `note` | `id`, `text` | Append an audit note; task status remains unchanged. |
| `changes` | `id` | Record a compact file-edit summary for a task: path, +adds/-dels and hunk line ranges from the real git worktree (sis changes <id> [--repo P] [--base R] [--patch]). Append-only evidence — no code stored unless --patch snapshots a bounded diff. Identical consecutive diffs dedup unless force:true. sis close records the same automatically. |
| `comments` | `id` | Read task notes. |
| `history` | `id` | Read ordered task events. |
| `checkpoint` | `id`, `actor`, `epoch`, `text`, `next_step` | Persist bounded source-bound progress and next safe step under a valid lease. |
| `handoff` | `id`, `actor`, `epoch`, `text`, `next_step` | Checkpoint bounded progress and release the fenced claim in one step so a successor agent can claim immediately; `to` names the intended successor. |
| `resume` | `id` | Read current contract and last checkpoint with drift/cancellation information. |
| `who` | none | Dirty-worktree attribution: maps each dirty/untracked path in a git repo to the recorded changes event (claim/actor) that produced it. Orphaned paths with no matching event surface explicitly — answers 'wem gehoert dieser Stand?'. |
| `cancel` | `id`, `actor` | Request cancellation as current worker or declared controller. |
| `cancel_ack` | `id`, `actor`, `epoch` | Acknowledge cancellation, end the live lease and fence old work. |
| `contract` | `id` | Read complete stable task contract and its revision. |
| `brief` | `id` | Render token-budgeted task context without dropping mandatory acceptance. |
| `tokens` | `text` | Count selected tiktoken encoding; explicitly separate count from model billing. |
| `context` | none | Read stable project identity, database path, capabilities and current stats. |
| `capabilities` | none | Discover operation names and store identity; request schemas only when needed. |
| `watch` | none | Read durable events after cursor or subscribe with bounded wait. |
| `lint` | none | Read lint diagnostics without dispatching work. |
| `types` | none | Read types diagnostics without dispatching work. |
| `statuses` | none | Read statuses diagnostics without dispatching work. |
| `prime` | none | Read prime diagnostics without dispatching work. |
| `orphans` | none | Read orphans diagnostics without dispatching work. |
| `stats` | none | Read stats diagnostics without dispatching work. |
| `review` | none | Read review diagnostics without dispatching work. |
| `stale` | none | Read expired task leases. |
| `remember` | `key`, `value` | Persist a project-scoped learning value. |
| `recall` | none | Read project-scoped learning values. |
| `export` | none | Export project state for audit or backup. |
| `import` | `admin_token` | Import administrative event state with explicit admin authority. bd format is conflict-aware: live claims and closed issues are reported, never silently overwritten (force:true to reopen). |
| `batch` | `ops` | Apply a bounded atomic mutation batch; verifier execution is excluded. |
| `budget_claim` | `issue`, `eur` | Reserve finite nonnegative task budget atomically. |
| `outbox_list` | none | Read unprocessed transactional lessons. |
| `outbox_done` | `id` | Confirm successful processing. Leased deliveries require matching actor, delivery epoch and unexpired lease. |
| `outbox_fail` | `id`, `err` | Record failed outbox processing. Leased deliveries require matching actor, delivery epoch and unexpired lease. |
| `compact` | none | Archive old events and reap only expired ephemeral task hints. |
| `gate` | `name` | Read or set a named approval gate; unknown gates are closed. |
| `gate_list` | none | Read named approval gates. |
| `slot_acquire` | `name`, `actor` | Acquire a fenced expiring merge slot. |
| `slot_release` | `name`, `actor`, `epoch` | Release your matching fenced merge slot. |
| `slot_list` | none | Read merge-slot holders and epochs. |
| `epic` | `id` | Read task hierarchy with completion rollup. |
| `dup_scan` | none | Find likely duplicate tasks before creating new work. |
| `q` | `title` | Capture a task using the create contract. |
| `goal` | `name` | Create a named goal container with final acceptance. |
| `sub` | `parent`, `title` | Create a child task under a goal without a blocking parent edge. |
| `plan` | `name` | Create atomic goal tree and validated internal dependencies; save or reuse a named template. |
| `goal_tree` | none | Read named goal hierarchy and progress. |
| `goal_done` | `id` | Check subtree completion; caller still needs verified final goal acceptance. |
| `snapshot` | none | Write the git-diffable <db>.issues.jsonl mirror (one upsert line per issue, deps embedded, sorted by id). Runs automatically after every committed write op; SIS_SNAPSHOT=0 disables. |
| `attest` | none | Attach a structured machine-checkable attestation (junit/coverage/smoke/artifact/custom/run) to the active claim, bound to contract revision and source fingerprint. kind:"run" executes cmd store-side — the receipt is not forgeable client-side. Required kinds via meta.attest_required are enforced at close. |
| `cost_add` | none | Append a cost entry (tokens/cents) to an issue's durable ledger; idempotent via idem key. |
| `cost_list` | none | List cost ledger entries, filterable by issue/actor/run_id/wave. |
| `cost_rollup` | `id` | Roll up costs over the container subtree of id (meta.parent + id-prefix): totals plus per-issue/actor/wave breakdown and budget reference. |
| `outbox_export` | none | Export raw, pgboss-sql, hatchet or temporal jobs. Explicit actor reserves deliveries with ttl 5..3600 seconds, fenced ACK and at most three attempts. Without actor, legacy preview/drain semantics apply. |
| `learn` | none | Honest learning aggregates over the ledger: attest/proof pass rates, cost (cents/tokens) and time-to-accepted grouped by actor / wave / kind / issue — the posterior for bandit/routing decisions, no invented score. |
| `sync_export` | none | Emit a deterministic sis-sync bundle (schema-stamped issues+deps, memories, proof+attest receipts; events with events:true) for multi-machine replication. |
| `sync_import` | `admin_token` | Admin: merge a sis-sync bundle — issue/deps upsert, memory LWW by updated_at, receipts by primary key; live claims are never overwritten and report as conflicts. |
| `spans` | none | Read back OTel-shaped span lines emitted under SIS_EMIT for observability of claim/verify/close and other requests. |
