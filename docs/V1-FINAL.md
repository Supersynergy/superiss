# Superiss 1.0: final runtime acceptance

The published, licensed 1.0.0 bundle is installed on macOS and Netcup. The GitHub Verify workflows for the release and its license correction passed. Those results are not a 24-hour endurance test.

## Acceptance

`tools/v1-soak.ts run PINNED_BUNDLE NEW_STATE` exercises the installed bundle against a new private database. It accepts no duration override. Production acceptance requires:

- At least 86,400 seconds on both wall and monotonic clocks, with samples every minute and no observation gap above 180 seconds.
- 1,441 native create/claim/heartbeat/checkpoint/verify/close/readback cycles. Every stored proof must match its source, actor, epoch and closed task.
- Three SIGKILL/restart cycles at hours 6, 12 and 18. Only the runner's own daemon is signalled; its pending claim must survive each restart.
- Hourly bounded DuckDB 2.0 snapshot analytics, an unchanged licensed release manifest and Bun executable, SQLite integrity and no nonzero cost entries.
- An intact, fsynced hash-chain journal. An interrupted or failed run does not resume or overwrite its evidence; it requires a new state directory and a fresh 24 hours.

`probe` runs four real lifecycle cycles and three owned crash recoveries. It always reports `passed:false, probePassed:true` when successful. `verify` refuses probe evidence. Unit-test timelines are synthetic and are not production receipts.

## Netcup run

- Pinned bundle: `/opt/superiss/releases/1.0.0-8913e919e4e2`.
- Runner: `/opt/superiss/evidence/v1-final-20261103/v1-soak.ts`.
- State: `/opt/superiss/evidence/v1-final-20261103/run`.
- Owned unit: `superiss-v1-final-20261103.service`.
- Final receipt: `run/result.json`. Its absence or `passed:false` is not acceptance.
- Started: 3 November 2026, 12:15:59 CET. Earliest completion: 4 November 2026, 12:15:59 CET.
- Preflight: all 9 tests passed on both macOS and Linux; strict TypeScript 7.1 passed. The same systemd sandbox passed four real native lifecycle cycles and three owned crash recoveries. The production verifier correctly rejected the incomplete run.

Read the journal and unit status before interpreting a result. Independent review and the project task's source-bound `sis verify`/fenced close remain required after the real run completes.

```sh
ssh root@app.supersynergy.de systemctl status superiss-v1-final-20261103.service --no-pager
ssh root@app.supersynergy.de /usr/local/bin/bun /opt/superiss/evidence/v1-final-20261103/v1-soak.ts verify /opt/superiss/evidence/v1-final-20261103/run
```

## Boundaries and rollback

This is a runtime endurance test, not an upgrade of the separately pinned SynergyCoder Night supervisor or the Office Python daemon. Existing jobs, project databases, services and claims remain unchanged. This run provides no consumer acceptance for those integrations and does not complete a fleet-wide cutover.

The test uses a bounded, network-isolated systemd unit with resource limits and only its private evidence directory writable. It installs no dependency and calls no model provider. Stop only `superiss-v1-final-20261103.service` to cancel this test. Keep its evidence; stopping it does not roll back or alter the installed release. The previous 0.9 installation and the existing local release rollback script are retained.
