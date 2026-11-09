# WOOP and separate evidence stages — 1.3

`sis woop` compiles a declared wish, observable outcome, obstacle and if–then response into the existing atomic native plan. It creates a goal plus three tasks: `implementation`, then `delivery`, then `outcome`. Each next task waits for the previous task's native proof-gated close. Creation does not claim work, run an oracle/model, deploy, merge or confirm a customer outcome.

## Example: SuperSynergy appointment flow

This is a template, not a customer acceptance receipt. Replace the commands with checks of trustworthy evidence. The files below are not created by planning.

```json
{
  "id": "super-synergy-appointment",
  "name": "SuperSynergy: suitable customer appointment",
  "owner": "appointment-controller",
  "wish": "Arrange a suitable private customer appointment",
  "outcome": "Customer confirms the agreed slot",
  "obstacle": "The requested slot is unavailable",
  "if": "If the requested slot is unavailable",
  "then": "Request one alternative before making a booking",
  "stages": {
    "implementation": {
      "oracle_cmd": "python3 -c 'import json; d=json.load(open(\"evidence/implementation.json\")); assert d[\"critical_path_passed\"] is True'",
      "allowed_paths": ["evidence/implementation.json"],
      "acceptance": "The critical booking path passes its declared tests"
    },
    "delivery": {
      "oracle_cmd": "python3 -c 'import json; d=json.load(open(\"evidence/delivery.json\")); assert d[\"deployed_commit\"] and d[\"live_smoke_passed\"] is True'",
      "allowed_paths": ["evidence/delivery.json"],
      "acceptance": "The declared deployed commit passes a live smoke test"
    },
    "outcome": {
      "oracle_cmd": "python3 -c 'import json; d=json.load(open(\"evidence/outcome.json\")); assert d[\"customer_confirmed\"] is True and d[\"source_ref\"]'",
      "allowed_paths": ["evidence/outcome.json"],
      "acceptance": "A referenced customer source confirms the agreed appointment"
    }
  }
}
```

Save as `appointment.json`, then explicitly choose the project database:

```sh
bin/sis woop @appointment.json --db /absolute/project/.sis/tasks.db --actor appointment-controller --idem appointment-plan-v1
bin/sis next goal=super-synergy-appointment --db /absolute/project/.sis/tasks.db
bin/sis contract id=super-synergy-appointment.1 --db /absolute/project/.sis/tasks.db
```

The response contains `goal`, `name`, `children` and `stages` (stage name to native task ID). Native IDs are `<id>.1`, `.2` and `.3`. A colliding goal or any existing descendants, using native ASCII case-insensitive hierarchy matching, reject the whole operation, including orphan descendants. Reusing the same native idempotency key, actor and payload returns the original result; a changed payload rejects it. No automatic retry occurs.

After reading the contract, use the existing explicit claim → verify → close path. Only an executed passing oracle for the current scope/revision and live actor/epoch can close a stage. The root goal uses the outcome stage's oracle, scope and acceptance as its final contract; after all three tasks close it still needs an explicit `finalize=true` claim, verify and close. The tree's completion is not inferred from a merge or task count.

## Input limits and contract semantics

- Required fields are exactly `id`, `name`, `owner`, `wish`, `outcome`, `obstacle`, `if`, `then`, `stages`. Native `actor`, `idem` and `run_id` are optional transport fields. Unknown fields are rejected.
- `id` is 1–120 ASCII letters/digits/hyphens, starting with a letter or digit. `owner` is 1–128 characters. Other text, including each oracle and acceptance, is nonempty and at most 400 Unicode characters.
- `stages` contains exactly the three named objects. Each object requires only `oracle_cmd`, `allowed_paths` and `acceptance`. Scope contains 1–32 nonempty path strings, each at most 400 characters. The native verifier still enforces its realpath, source-size and scope boundaries; an input path is not a sandbox or permission grant.
- Every generated task has the explicit controller/owner and a zero recorded budget. No provider/model invocation is introduced.
- `meta.customer_outcome` carries `v: 1`, `source: sis_woop`, `desired_outcome`, `bottleneck` and nested `woop: {v: 1, wish, outcome, obstacle, if, then, goal_id, stage, stages}`. This is declared contract data, retained by brief/acquire/resume and included in the existing revision hash. No new table or migration is needed; old contracts remain unchanged.
- Changing a generated task invalidates that task's prior proof. Copies in other tasks are not silently rewritten. Review all affected contracts when changing intent. These fields are untrusted data and grant no authority or customer confirmation.

## Board

Open the existing local HTTP board. “Create a WOOP plan” provides a SuperSynergy template, required per-stage contracts and a complete JSON preview before “Create four open tasks”. Editing a preview invalidates its create action. Explicit retry of an unchanged, unconfirmed request retains its idempotency key.

The board loads goals, tasks and proof/revision projections in one SQLite read transaction, so a displayed contract and receipt share the same snapshot. The three stage cards show native task state and stored proof separately: no receipt, failed oracle, changed-contract stale receipt, or stored passing oracle. Source currency remains **unknown** because this read does not execute or fingerprint the oracle's source directory. A passing stored proof does not establish current deployment, customer confirmation or payment. The declared oracle and independently trustworthy evidence determine what it supports. Missing/truncated stages remain unknown. Drafts, filter/focus and expanded intent survive refresh; server errors retain the last loaded view and remain visible.

## Interfaces and upgrade

WOOP uses the existing JSON CLI, Unix socket, controller MCP registry, named `POST /api/v1/ops/woop` and RPC/batch API. GET mutations are rejected. Existing same-origin/loopback restrictions remain; this is not a remotely authenticated service. The small agent MCP profile does not gain planning authority automatically.

Use a source-bound 1.3 artifact and an owned 1.3 daemon for new consumers. A 1.3 client rejects old/unversioned daemons before work and does not fall back to direct writes. Keep existing jobs pinned to their previous artifact and retain that artifact for rollback; a symlink change does not upgrade a running daemon. [Upgrade](GETTING-STARTED.md), [customer intent](CUSTOMER-OUTCOME.md), [validation](VALIDATION.md).
