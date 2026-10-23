# Agent coordination beside your forge

Superiss is a stronger fit when the decision is **whether an agent may call a task done**: its native close operation checks the actor, epoch, live lease, current contract, declared sources and saved executable proof. `sisf` connects that workflow to Git worktrees and PR references. A forge supplies repository hosting and collaboration around those changes.

Research date: **23 October 2026**. This is a comparison of documented contracts, not an overall product ranking or competitor benchmark. ✅ = shipped/documented; 🧩 = integration or configurable workflow; ❌ = exact native capability not established in the reviewed sources. A red X does not rule out an extension implementing it.

| Capability | **Superiss + sisf** | **Gitea** | **Forgejo** | **GitHub** |
| --- | --- | --- | --- | --- |
| 🎯 Main role | Agent task acceptance + Git adapter | Self-hosted forge | Self-hosted forge | Hosted development platform |
| 🧾 Task close requires source-bound executable proof | ✅ Native contract | ❌ Exact contract | ❌ Exact contract | 🧩 Custom automation |
| 🔒 Task claim fenced by actor + epoch + expiring lease | ✅ Native contract | ❌ Exact contract | ❌ Exact contract | ❌ Exact contract |
| 🧠 Local SQLite task graph and agent memory | ✅ Core | ❌ Exact local-agent interface | ❌ Exact local-agent interface | ❌ Exact local-agent interface |
| 🌿 Claim creates a task worktree | ✅ sisf, separate Git operation | 🧩 External worker | 🧩 External worker | 🧩 External worker |
| 🔌 PR connection | ✅ Gitea API / GitHub CLI | ✅ Native | ✅ Native | ✅ Native |
| 🖥️ Work overview | ✅ Local task × worktree board | ✅ Issues / projects | ✅ Issues / projects | ✅ Issues / Projects |
| 📦 Shared Git hosting + account permissions | ❌ Use a forge | ✅ | ✅ | ✅ |
| 🛡️ Protected branches and PR review | 🧩 Configure the forge | ✅ | ✅ | ✅ |
| ⚙️ CI execution and package hosting | 🧩 External forge/runner | ✅ Actions + packages | ✅ Actions + packages | ✅ Actions + Packages |
| 🏠 Self-host the forge itself | ❌ Adapter only | ✅ | ✅ | ❌ Standard GitHub.com; Enterprise is separate |

## Where Superiss adds value

A task assignment records responsibility. A live fenced lease rejects a stale worker. A CI badge records a result on a commit. Superiss additionally binds its close proof to the declared source scope and current task contract. These distinctions matter when agents restart, claims expire, files change after a check or several workers coordinate one goal.

This is a specialization claim grounded in the Superiss source and acceptance tests. It does not establish that Superiss has better code review, hosting, uptime or access control than the forges above. An oracle only proves the checks it actually executes.

## Choose the combination

| Need | Practical choice |
| --- | --- |
| Self-host repositories, accounts, PR reviews and CI | Gitea or Forgejo; evaluate their operational requirements. |
| Use GitHub's hosted repository and collaboration workflow | GitHub; keep branch protection and required checks configured there. |
| Coordinate local agents with leases, durable memory and checked task completion | Superiss core. |
| Link that coordination to worktrees and Gitea/GitHub PRs | Add sisf. Gitea HTTP behavior has fixture coverage; a production Gitea installation still needs its own end-to-end validation. |

Forgejo API compatibility with a given Gitea endpoint is not treated as a tested sisf connector. Native core acceptance and forge merge protection remain separate gates.

## Primary sources

- [Gitea documentation](https://docs.gitea.com/), [pull requests](https://docs.gitea.com/usage/pull-request), [protected branches](https://docs.gitea.com/usage/access-control/protected-branches), [API usage](https://docs.gitea.com/development/api-usage).
- [Forgejo user guide](https://forgejo.org/docs/latest/user/): repositories, issues, projects, pull requests, Actions, packages and protected branches.
- [GitHub Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects), [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [Actions](https://docs.github.com/en/actions/about-github-actions/understanding-github-actions), [Packages](https://docs.github.com/en/packages/learn-github-packages/introduction-to-github-packages).
- Superiss: [protocol](../SPEC.md), [operation registry](../ops.json), [sisf implementation](../sisf/sisf.ts) and [executable adapter gate](../tools/verify-forge.sh).

[Compare five task/agent tools](COMPARISON.md) · [Use sisf](SISF.md)
