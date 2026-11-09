# Superiss

**Task coordination for AI coding agents. Require a passing check before “done”.**

Give work an owner, keep the context needed to resume, and check the result before closing the task. Superiss runs locally and connects to your agents through CLI or MCP.

[Download 1.3](https://github.com/Supersynergy/superiss/releases/latest) · [Get started](docs/GETTING-STARTED.md) · [Deutsch](README.de.md)

## What it helps you do

- Coordinate parallel agents. Claims identify the current worker; expiring leases and epochs reject stale worker writes.
- Make completion checkable. Each task carries an executable check and a source scope. Closing requires a passing proof for the current contract and files.
- Resume interrupted work. Checkpoints retain progress and the next safe step. Resume reads the state; acquiring a claim remains explicit. [Resume safely](docs/GETTING-STARTED.md#resume-an-interrupted-task).
- Carry a goal through delivery. WOOP plans implementation → delivery → outcome as separate tasks, each with its own check. Planning starts no agents and confirms no customer outcome.

```text
Task → Claim → Work → Verify → Close with proof
                 ↳ Checkpoint → Resume
```

## Try the complete loop

Requires **Bun 1.4.4+** and Git. The demo also uses Python 3.

```sh
git clone https://github.com/Supersynergy/superiss.git
cd superiss
python3 examples/quickstart.py
```

The demo uses a temporary database. It claims a task, demonstrates a rejected close without proof, executes the check, then closes and reads back the result. It leaves your project stores alone.

## Use it with your agent

Bind the agent to an existing project database. Start its MCP server with:

```sh
bin/sis mcp --db /absolute/project/.sis/tasks.db
```

The CLI uses the same contracts and proofs. [Setup and upgrades](docs/GETTING-STARTED.md) cover creating a store, client configuration and keeping running jobs on their current runtime.

For coding workflows, the optional Forge layer connects task claims to worktrees and GitHub/Gitea/Forgejo PRs. [Forge guide](docs/SISF.md).

## Where it fits

Useful when several agents share work, tasks need to survive interruptions, or “done” must be backed by a repeatable check. A simple to-do list remains a reasonable choice for reminders without an execution or handoff workflow.

SQLite stores the task state. The tracker needs no model API key. A proof establishes only what its check covers; actor names are not authentication. [Support and limits](docs/FEATURES.md).

[WOOP example](docs/WOOP.md) · [Agent integrations](docs/V1-INTEGRATIONS.md) · [Validation](docs/VALIDATION.md) · [Operation catalog](docs/OPERATIONS.md) · [MIT license](LICENSE)
