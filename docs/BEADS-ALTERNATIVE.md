# Superiss as a Beads alternative

Beads established a useful pattern: durable, dependency-aware work that an agent can query after the conversation ends. Superiss shares that goal and adds an explicit acceptance path: **claim → execute oracle → save source-bound proof → close**.

Choose Superiss when completion needs to be tied to the declared source files and an executed check, when stale workers must be fenced with epochs and leases, or when a local command needs checkpointed recovery. Choose the surrounding ecosystem based on the workflow you need; [the comparison](COMPARISON.md) includes strengths of five alternatives.

## Translate the workflow

| Familiar action | Superiss |
| --- | --- |
| Capture work | `sis create` or `sis q` with an oracle and acceptance |
| Find unblocked work | `sis ready` / `sis next` |
| Claim a selected task | `sis claim` with an actor |
| Select and claim atomically | `sis acquire`, which also returns the mandatory contract |
| Inspect dependencies and context | `sis show` / `sis contract` / `sis brief` |
| Keep project knowledge | `sis remember` / `sis recall` |
| Complete a task | `sis verify`, then `sis close` with the returned `proof_id` |
| Move task data | Explicit Beads-format export/import or `tools/bd2sis.py` |

This is a different command and acceptance contract, not a drop-in `bd` replacement. Superiss uses SQLite, not Dolt. It does not reproduce Beads' SQL branching/merge system or its entire integration ecosystem.

## Migrate an export deliberately

Back up the original store and export it using its own supported tooling. Inspect a selected JSON/JSONL file before importing:

```bash
python3 tools/bd2sis.py /absolute/path/issues.jsonl --dry-run
```

The migration helper does not run Beads or start a background sync. Apply to an explicitly selected Superiss database only after checking IDs, statuses and dependency types. Admin authorization is required; keep the token in the environment, not shell history.

Historical in-progress tasks become deferred without a live lease. Imported closed work is marked as historical acceptance that Superiss has not verified. Imported history creates no fresh oracle execution or proof. Preserve those boundaries when reporting migration success. File/frame limits and conflict rules are described in the [protocol specification](../SPEC.md) and migration helper.
