# Declared customer outcome in native task contracts

Office already records a desired outcome, its meaning, the chosen priority, a bottleneck, customer acceptance and requirement references in the Willenskarte. Its SIS handoff may attach a bounded projection under `meta.customer_outcome`. This is declared intent. It does not prove delivered value, payment, willingness to pay or customer confirmation.

## Existing contract path

`contract`, `brief`, `acquire` and `resume` carry this optional metadata. It participates in the existing contract revision. Changing it makes a prior proof stale. A compact brief may omit a long description but must retain this metadata; insufficient mandatory-token budgets fail without claiming a task. Tasks without the key retain the previous contract shape and revision hash. The 1.2 projection introduced no migration, operation or additional supervisor.

The Office projection is versioned data with `v: 1`, `source: office_willenskarte`, at most 400 characters each for `desired_outcome`, `meaning`, `chosen_priority`, `bottleneck`, `customer_acceptance`, and at most 20 declared `evidence_refs`. References must be resolved through the existing evidence policy before work. Their presence is not customer acceptance. Existing role, tenant, privacy, budget, fencing and verification rules still apply.

SynergyCoder reads the projection from its existing resume response. For older SIS runtimes it can derive a bounded view from the original JSON description, which remains bound to the legacy contract revision. This requires no extra tracker reads. Shared context remains untrusted data and does not authorize commands, reprioritization or external actions. Forge consumers use the same native contract and proof path.

## Choosing the next slice

1. Identify whose progress is blocked and the specific observable result they seek. Protect constraints such as discretion, autonomy, reliability and cost transparency.
2. Identify the limiting transition in the actual flow: need, trust, decision, delivery, use or retention. Record uncertainty and the available evidence.
3. Choose a complete, reversible slice with a fixed oracle and a before/after measure. Existing authorization, safety and dependency gates precede any value comparison.
4. Compare additional benefit, total effort, risk, constrained capacity and alternatives. When economics matters, use additional contribution after total incremental cost and contribution per actual bottleneck hour, with consistent units and period. Keep unknown inputs unknown. A high ratio alone is insufficient if absolute contribution or delivery feasibility is inadequate.
5. Claim explicitly; implement; execute the oracle; review; verify; close with proof and readback. Then measure real use and outcome separately. Record only verified learning and source pointers.

Use the existing economic calculator and approved data adapters instead of copying financial formulae into the tracker. No universal sweetspot, trained model, numeric ranking or business forecast is introduced here. Model and effort selection must be calibrated on the task class and checked on independent tasks before promotion. Technical green status and synthetic tests remain distinct from customer evidence.

## Verification and rollout

Run `bun test packages/superiss/customer-outcome.test.ts packages/superiss/api.test.ts --bail` from the repository root, plus the existing strict typecheck. Regression coverage includes mandatory context, atomic rejection of insufficient budgets, acquire/resume, legacy revisions, ownership and stale proofs after an intent change.

This is an additive source change. It does not replace installed services or their running daemons. A controller must bind a candidate build and arrange an owned cutover before claiming the new metadata semantics on an installed runtime. Preserve active foreign claims and processes. Existing description-based contracts remain usable during preparation; do not mix changed source runtimes against a live database as an implicit upgrade.

## WOOP in 1.3

The additive [WOOP compiler](WOOP.md) uses this same revision-bound path with `source: sis_woop` and a nested `woop.v: 1` contract. Its declared stages and intent are not evidence. Existing Office projections and contracts without this key retain their previous shape.
