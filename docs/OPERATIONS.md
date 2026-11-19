# Core operation catalog — 1.6.1

Generated from [the current registry](../packages/superiss/ops.json). **95 core operations**, protocol 2. The eleven forge tools are listed in [the forge guide](SISF.md). The retained root registry belongs to the 0.9 reference.

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
| `search` | FTS5 search by default; opt-in `mode=hybrid` fuses lexical and local sqlite-vec suggestions, falling back to FTS5 when unavailable. | `q` |
| `search_index` | Inspect or explicitly rebuild the disposable local sqlite-vec projection from an SQLite snapshot. |  |
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
| `woop` | Compile declared WOOP intent into one atomic native goal and three ordered proof-gated tasks. Does not execute, claim or confirm customer outcomes. | `id`, `name`, `owner`, `wish`, `outcome`, `obstacle`, `if`, `then`, `stages` |
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
| `admit` | Read-only admission report: every non-terminal task as admitted or held with machine-readable reasons (`missing_oracle`, `blocked_by`, `deferred`, `deferred_until`, `deferred_unparsable`, `claimed`, `has_children`, `container`, `expired`, `cancel_requested`, `parked`, `local_zero_budget`, `local_zero_unavailable`, `lane`). Alias `why`. |  |
| `recur` | Create, replace, toggle or delete a recurring task template (`every_secs` 60 s to 1 year, `template` with `title` and `oracle_cmd`). Instances are created by `recur_tick` or the daemon scheduler; missed slots collapse into one; by default no new instance while the previous one is open (`overlap:true` allows it). | `name` |
| `recur_tick` | Materialize due recurrences as tasks with deterministic ids `<name>-<slot_start>`; idempotent per slot. The daemon runs it every `SIS_TICK_SECS` (default 30, `0` disables). |  |
| `recur_list` | List recurring task templates with `next_at` and `last_issue`. |  |
| `unpark` | Controller or admin re-admits a task parked after `max_failures` failed proofs (`meta.max_failures`, default `SIS_MAX_FAILURES`, `0` = unlimited). A controller/admin `reopen` also resets the count. `all:true` (admin) sets a store-wide baseline so only later failures count. | `reason` |

## 24/7 operation

- **Admission instead of guessing.** Workers that find no work run `sis admit --db PATH` and act on the summary: an idle queue with 400 `deferred` tasks needs contracts, not more workers.
- **Parking stops retry loops.** With `SIS_MAX_FAILURES=10` (the generated units set it; agents often iterate `verify` inside one claim, so keep it well above normal retries) a task with ten failed proofs since the last unpark or reopen is no longer granted, `verify` refuses with `parked`, and a `parked` event is emitted for notification. A worker cannot raise `meta.max_failures`. On an existing store run `sis unpark all=true reason=... admin_token=...` once before setting `SIS_MAX_FAILURES`, otherwise historical failed proofs park tasks immediately.
- **Recurring work without an LLM poller.** `sis recur name=nightly every_secs=86400 template='{"title":"Nightly gate","oracle_cmd":"just check"}'` plus a running daemon creates one task per day. Use `watch` to wake agents on `recur_tick` events instead of polling `ready`.
- **Oracle-only workers.** `sis work lane=ops --actor host-ops` claims tasks of one lane whose work is the oracle (health checks, recurring gates, audits), closes them with a proof and releases failures; `once=true` runs a single pass. `sis unit mode=work lane=ops actor=host-ops` prints its service. A lane is mandatory so it never takes tasks meant for model agents.
- **Service on any host.** `sis unit kind=systemd user=NAME bin=/opt/superiss/bin/sis --db PATH --sock PATH` prints a hardened systemd unit (`Restart=always`, graceful 330 s drain); `kind=launchd` prints a KeepAlive plist. Installing it stays an explicit admin step. Put the socket next to the database, not under a private `/tmp`.
- **Rolling upgrades.** A newer client accepts a same-major daemon from 1.5.0 on when that daemon advertises the requested operation; otherwise it refuses with `runtime_version_mismatch` before dispatch. Parking and recurrences are enforced by the daemon: check `capabilities.parking` and `capabilities.recurrence` before relying on them during a rolling upgrade. Lifecycle commands (`up`, `status`, `down`) still require the exact version.
- **Linux local-zero.** `meta.local_zero` runs in bubblewrap (`--unshare-all`, read-only root, tmpfs over `/home`, `/root`, `/run`, `/tmp`, `/srv`, `/mnt`, `/media` and the private parts of `/var`; `/etc`, `/opt` and `/usr` stay readable, only the task directory writable). On Ubuntu 24.04 unprivileged user namespaces are restricted by AppArmor; allow them for bwrap only with `/etc/apparmor.d/bwrap` (`profile bwrap /usr/bin/bwrap flags=(unconfined) { userns, }`). Without a working sandbox local-zero fails closed.
