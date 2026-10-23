#!/usr/bin/env python3
"""Strict worker-contract acceptance. Every case owns its database and sources."""
import argparse
import concurrent.futures
from collections.abc import Callable
import json
import math
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
IMPL = "rs"
SIS_BIN = str(ROOT / "bin/sis")


class AgentContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sis-v06-contract-")
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name).resolve()
        self.source = self.work / "input.txt"
        self.source.write_text("accepted input\n")
        self.db = self.work / "state.db"
        self.env = dict(os.environ, SIS_IMPL=IMPL)
        self.env.pop("SIS_DB", None)
        self.env.pop("SIS_SOCK", None)
        self.env.pop("SIS_ADMIN_TOKEN", None)

    def request(self, command, args=None):
        p = subprocess.run([SIS_BIN, command, json.dumps(args or {}), "--db", str(self.db)],
                           env=self.env, cwd=self.work, capture_output=True,
                           text=True, timeout=20)
        raw = p.stdout.strip() if p.returncode == 0 else p.stderr.strip() or p.stdout.strip()
        try:
            data = json.loads(raw)
        except ValueError as exc:
            self.fail(f"{command}: rc={p.returncode}: {raw[:1000]} ({exc})")
        if p.returncode == 0 and isinstance(data, dict) and data.get("ok") is True and "data" in data:
            data = data["data"]
        return p.returncode == 0, data

    def call(self, command, **args):
        ok, data = self.request(command, args)
        self.assertTrue(ok, f"{command}: {data}")
        return data

    def reject(self, command, code=None, **args):
        ok, data = self.request(command, args)
        self.assertFalse(ok, f"unsafe {command} unexpectedly succeeded: {data}")
        if code:
            self.assertEqual(data.get("error", {}).get("code"), code, data)
        return data

    def create(self, ident="task", **extra):
        args = dict(id=ident, title=f"Task {ident}", oracle_cmd="test -s input.txt",
                    allowed_paths=[str(self.source)], acceptance="Input exists and is nonempty")
        args.update(extra)
        return self.call("create", **args)["id"]

    def claim(self, ident="task", actor="worker", **extra):
        return self.call("claim", id=ident, actor=actor, ttl=60, **extra)

    def verify(self, claim, **extra):
        return self.call("verify", id=claim["id"], actor="worker", epoch=claim["epoch"],
                         cwd=str(self.work), timeout_secs=2, **extra)

    def close(self, claim, receipt):
        return self.call("close", id=claim["id"], actor="worker", epoch=claim["epoch"],
                         proof_id=receipt["proof_id"], reason="Executed source-bound fixture oracle")

    def _attest_barrier(self, command: str, during: Callable[[dict, concurrent.futures.ThreadPoolExecutor], None]) -> tuple[bool, dict]:
        import threading

        self.create()
        claim = self.claim()
        ready = self.work / 'attest-ready'
        release = self.work / 'attest-release'
        os.mkfifo(release)
        args = dict(id=claim['id'], actor='worker', epoch=claim['epoch'],
                    kind='run', cwd=str(self.work), timeout_secs=5,
                    cmd=f'touch attest-ready; read released < attest-release; {command}')
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            pending = pool.submit(self.request, 'attest', args)
            deadline = time.monotonic() + 3
            while not ready.exists() and not pending.done() and time.monotonic() < deadline:
                threading.Event().wait(0.01)
            self.assertTrue(ready.exists(), 'attest command did not start')
            try:
                during(claim, pool)
            finally:
                fd = os.open(release, os.O_WRONLY | os.O_NONBLOCK)
                with os.fdopen(fd, 'w') as stream:
                    stream.write('continue\n')
            return pending.result(timeout=7)

    def test_multiworker_attest_does_not_block_heartbeat(self) -> None:
        def heartbeat(claim: dict, pool: concurrent.futures.ThreadPoolExecutor) -> None:
            pending = pool.submit(self.request, 'heartbeat', dict(
                id=claim['id'], actor='worker', epoch=claim['epoch'], ttl=60))
            ok, result = pending.result(timeout=1.5)
            self.assertTrue(ok, result)

        ok, result = self._attest_barrier('exit 0', heartbeat)
        self.assertTrue(ok, result)
        self.assertTrue(result['passed'])

    def test_multiworker_attest_rejects_source_drift(self) -> None:
        self.create()
        claim = self.claim()
        self.reject('attest', code='stale_proof', id=claim['id'], actor='worker',
                    epoch=claim['epoch'], kind='run', cwd=str(self.work),
                    cmd='printf changed > input.txt')

    def test_multiworker_attest_rechecks_cancellation(self) -> None:
        def cancel(claim: dict, pool: concurrent.futures.ThreadPoolExecutor) -> None:
            ok, result = pool.submit(self.request, 'cancel', dict(
                id=claim['id'], actor='worker', epoch=claim['epoch'])).result(timeout=1.5)
            self.assertTrue(ok, result)

        ok, result = self._attest_barrier('exit 0', cancel)
        self.assertFalse(ok, result)
        self.assertEqual(result['error']['code'], 'cancel_requested')

    def test_multiworker_attest_run_forbidden_in_batch(self) -> None:
        self.create()
        claim = self.claim()
        self.reject('batch', ops=[dict(cmd='attest', args=dict(
            id=claim['id'], actor='worker', epoch=claim['epoch'],
            kind='run', cwd=str(self.work), cmd='exit 0'))])

    def test_multiworker_outbox_delivery_is_exclusive_and_fenced(self) -> None:
        self.create(meta={'autorun': {'cmd': 'exit 0', 'cwd': str(self.work)}})
        self.claim()
        first = self.call('outbox_export', actor='runner-a', kind='autorun', ttl=120)
        self.assertEqual(len(first['jobs']), 1)
        self.assertEqual(self.call('outbox_export', actor='runner-b', kind='autorun', ttl=120)['jobs'], [])
        job = first['jobs'][0]
        self.reject('outbox_done', id=job['outbox_id'])
        self.reject('outbox_done', id=job['outbox_id'], actor='runner-b', epoch=job['delivery_epoch'])
        self.reject('outbox_done', code='bad_args', id=job['outbox_id'], actor='runner-a', epoch=True)
        self.call('outbox_done', id=job['outbox_id'], actor='runner-a', epoch=job['delivery_epoch'])
        self.reject('outbox_fail', code='stale_fence', id=job['outbox_id'], actor='runner-a', epoch=job['delivery_epoch'])
        self.assertEqual(self.call('outbox_list', state='done')[0]['id'], job['outbox_id'])

    def test_multiworker_run_rejects_unrelated_delivery(self) -> None:
        self.create(meta={'autorun': {'cmd': 'exit 0', 'cwd': str(self.work)}})
        claim = self.claim()
        job = self.call('outbox_export', actor='runner', kind='autorun', ttl=120)['jobs'][0]
        self.reject('attest', code='stale_fence', id=claim['id'], actor='worker',
                    epoch=claim['epoch'], kind='run', cwd=str(self.work), cmd='touch forged',
                    outbox_id=job['outbox_id'], delivery_actor='runner', delivery_epoch=job['delivery_epoch'],
                    idem=job['idempotency_key'])
        self.assertFalse((self.work / 'forged').exists())

    def test_multiworker_run_rejects_wrong_delivery_directory(self) -> None:
        self.create(allowed_paths=['input.txt'], meta={'autorun': {'cmd': 'touch forged', 'cwd': str(self.work)}})
        claim = self.claim()
        job = self.call('outbox_export', actor='runner', kind='autorun', ttl=120)['jobs'][0]
        other = self.work / 'other'
        other.mkdir()
        (other / 'input.txt').write_text('before\n')
        self.reject('attest', code='stale_fence', id=claim['id'], actor='worker',
                    epoch=claim['epoch'], kind='run', cwd=str(other), cmd='touch forged',
                    outbox_id=job['outbox_id'], delivery_actor='runner',
                    delivery_epoch=job['delivery_epoch'], idem=job['idempotency_key'])
        self.assertFalse((other / 'forged').exists())

    def test_multiworker_leased_run_replays_without_reexecution(self) -> None:
        command = 'printf run >> runs.txt'
        self.create(meta={'autorun': {'cmd': command, 'cwd': str(self.work)}})
        claim = self.claim()
        job = self.call('outbox_export', actor='runner', kind='autorun', ttl=120)['jobs'][0]
        args = dict(id=claim['id'], actor='worker', epoch=claim['epoch'], kind='run',
                    cwd=str(self.work), cmd=command, outbox_id=job['outbox_id'],
                    delivery_actor='runner', delivery_epoch=job['delivery_epoch'],
                    idem=job['idempotency_key'])
        first = self.call('attest', **args)
        self.assertTrue(first['passed'])
        self.assertEqual(self.call('attest', **args), first)
        self.assertEqual((self.work / 'runs.txt').read_text(), 'run')
        self.reject('attest', code='stale_fence', **dict(args, idem='another-key'))
        self.assertEqual((self.work / 'runs.txt').read_text(), 'run')

    def test_multiworker_learn_respects_proof_time_window(self) -> None:
        self.create()
        claim = self.claim()
        self.verify(claim)
        result = self.call('learn', group_by='issue', since=time.time() + 3600)
        self.assertEqual(result['groups'], [])

    def test_multiworker_outbox_expiry_retry_cap_and_stale_ack(self) -> None:
        self.create(meta={'autorun': {'cmd': 'exit 0', 'cwd': str(self.work)}})
        self.claim()
        last = None
        for attempt in range(1, 4):
            job = self.call('outbox_export', actor=f'runner-{attempt}', kind='autorun', ttl=120)['jobs'][0]
            self.assertEqual(job['delivery_epoch'], attempt)
            if last:
                self.reject('outbox_done', id=last['outbox_id'],
                            actor=last['delivery_actor'], epoch=last['delivery_epoch'])
            with sqlite3.connect(self.db) as connection:
                connection.execute('UPDATE outbox_leases SET lease_until=0 WHERE outbox_id=?', (job['outbox_id'],))
            self.reject('outbox_done', id=job['outbox_id'], actor=job['delivery_actor'], epoch=job['delivery_epoch'])
            last = job
        self.assertEqual(self.call('outbox_export', actor='runner-4', kind='autorun')['jobs'], [])
        failed = self.call('outbox_list', state='failed')
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]['attempts'], 3)

    def test_multiworker_outbox_concurrent_delivery(self) -> None:
        self.create(meta={'autorun': {'cmd': 'exit 0', 'cwd': str(self.work)}})
        self.claim()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            calls = [pool.submit(self.call, 'outbox_export', actor=actor, kind='autorun', ttl=120)
                     for actor in ('runner-a', 'runner-b')]
            self.assertEqual(sum(len(call.result(timeout=5)['jobs']) for call in calls), 1)

    def test_multiworker_schema_seven_migrates_without_data_loss(self) -> None:
        self.create()
        project = self.call('context')['project_id']
        with sqlite3.connect(self.db) as connection:
            connection.execute('DROP TABLE outbox_leases')
            connection.execute('PRAGMA user_version=7')
        context = self.call('context')
        self.assertEqual(context['project_id'], project)
        self.assertEqual(context['capabilities']['schema_version'], 8)
        self.claim()
        self.assertEqual(self.call('outbox_export', actor='runner', kind='autorun')['jobs'], [])

    def test_multiworker_attest_timeout_is_not_pass(self) -> None:
        self.create()
        claim = self.claim()
        result = self.call('attest', id=claim['id'], actor='worker', epoch=claim['epoch'],
                           kind='run', cwd=str(self.work), timeout_secs=1,
                           cmd="python3 -c 'import signal; signal.pause()'")
        self.assertFalse(result['passed'])
        self.assertTrue(result['summary']['timed_out'])

    def test_multiworker_timeout_reaps_before_resignalling(self) -> None:
        import importlib.util
        from unittest.mock import Mock, patch

        spec = importlib.util.spec_from_file_location('sis_worker_agent', ROOT / 'agent.py')
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        process = Mock(pid=424242, returncode=-9)
        process.poll.side_effect = [None, -9]

        def wait(*, timeout):
            if timeout < 1:
                raise subprocess.TimeoutExpired('fixture', timeout)
            return -9

        process.wait.side_effect = wait
        selector = Mock()
        selector.get_map.return_value = {1: object()}
        # SIGKILL delivery and reaping are asynchronous; a second group signal
        # can fail while the first signal is already terminating the child.
        with patch.object(module.subprocess, 'Popen', return_value=process), \
                patch.object(module.selectors, 'DefaultSelector', return_value=selector), \
                patch.object(module.os, 'set_blocking'), \
                patch.object(module.time, 'monotonic', side_effect=[0, 2, 2]), \
                patch.object(module.os, 'killpg', side_effect=[None, PermissionError(1, 'already terminating')]) as kill:
            self.assertEqual(module.run_oracle('fixture', self.work, 1), (-9, True, ''))
        kill.assert_called_once_with(process.pid, module.signal.SIGKILL)
        process.wait.assert_called_once_with(timeout=2)
        selector.close.assert_called_once()
        process.stdout.close.assert_called_once()

    def test_multiworker_attest_junit_rejects_prefix_sibling(self) -> None:
        self.create()
        claim = self.claim()
        with tempfile.TemporaryDirectory(prefix=self.work.name + '-sibling-', dir=self.work.parent) as sibling:
            report = Path(sibling) / 'report.xml'
            report.write_text('<testsuite tests="1" failures="0" errors="0"/>')
            self.reject('attest', id=claim['id'], actor='worker', epoch=claim['epoch'],
                        kind='junit', cwd=str(self.work), path=str(report))

    def test_blocked_direct_claim_rejected(self):
        self.create(); self.create("blocker")
        self.call("dep", issue="task", depends_on="blocker", type="blocks")
        self.reject("claim", id="task", actor="worker")
        self.assertEqual(self.call("show", id="task")["issue"]["status"], "open")

    def test_missing_oracle_not_dispatched(self):
        self.call("create", id="task", title="No executable oracle")
        self.assertIsNone(self.call("claim_next", actor="worker").get("id"))
        self.reject("claim", id="task", actor="worker")

    def test_empty_oracle_not_dispatched(self):
        self.create(oracle_cmd="  \n ")
        self.assertIsNone(self.call("claim_next", actor="worker").get("id"))

    def test_foreign_actor_close_rejected(self):
        self.create(); c = self.claim()
        self.reject("close", id="task", actor="other", epoch=c["epoch"])
        self.assertEqual(self.call("show", id="task")["issue"]["status"], "in_progress")

    def test_close_requires_proof(self):
        self.create(); c = self.claim()
        self.reject("close", "proof_required", id="task", actor="worker", epoch=c["epoch"])

    def test_status_update_cannot_bypass_close(self):
        self.create()
        self.reject("update", id="task", status="closed")
        self.reject("update", id="task", set={"status": "closed"})
        self.assertEqual(self.call("show", id="task")["issue"]["status"], "open")

    def test_foreign_actor_cannot_unclaim(self):
        self.create(); c = self.claim()
        self.reject("unclaim", id="task", actor="other", epoch=c["epoch"])
        self.assertEqual(self.call("show", id="task")["issue"]["claim_actor"], "worker")

    def test_valid_unclaim_fences_old_owner(self):
        self.create(); old = self.claim()
        self.call("unclaim", id="task", actor="worker", epoch=old["epoch"])
        new = self.claim(actor="next")
        self.assertGreater(new["epoch"], old["epoch"])
        self.reject("unclaim", id="task", actor="worker", epoch=old["epoch"])
        self.reject("heartbeat", id="task", actor="worker", epoch=old["epoch"])

    def test_expired_lease_cannot_close_or_renew(self):
        self.create(); c = self.call("claim", id="task", actor="worker", ttl=1)
        time.sleep(1.06)
        self.reject("close", id="task", actor="worker", epoch=c["epoch"])
        self.reject("heartbeat", id="task", actor="worker", epoch=c["epoch"])

    def test_ttl_and_epoch_input_validation(self):
        self.create()
        for ttl in [-1, 0, 0.1, 86401, "not-a-number"]:
            self.reject("claim", id="task", actor="worker", ttl=ttl)
        self.reject("claim", id="task", actor="")
        c = self.claim()
        for epoch in [-1, 1.5, "invalid"]:
            self.reject("heartbeat", id="task", actor="worker", epoch=epoch)

    def test_negative_budget_never_increases_balance(self):
        self.create(budget_eur=0)
        self.reject("budget_claim", issue="task", eur=-1)
        self.assertEqual(self.call("show", id="task")["issue"]["budget_eur"], 0)
        self.reject("update", id="task", budget_eur=-10)
        self.reject("create", id="negative", title="Invalid budget", budget_eur=-1)

    def test_slot_release_requires_current_epoch(self):
        slot = self.call("slot_acquire", name="merge", actor="worker", ttl=60)
        self.reject("slot_release", name="merge", actor="worker")
        self.reject("slot_release", name="merge", actor="other", epoch=slot["epoch"])
        self.reject("slot_release", name="merge", actor="worker", epoch=slot["epoch"] + 1)
        self.call("slot_release", name="merge", actor="worker", epoch=slot["epoch"])

    def test_invalid_plan_dependency_rolls_back(self):
        for deps in [[99], [-1], [0], [0.1], ["other"]]:
            self.reject("plan", name="invalid", subs=[{"title": "Task", "oracle_cmd": "true", "deps": deps}])
            self.assertEqual(self.call("stats")["total"], 0)

    def test_idempotency_replay_and_payload_conflict(self):
        self.create(idem="create-request")
        self.create(idem="create-request")
        self.reject("create", "idem_conflict", id="other", title="Different", idem="create-request")
        self.assertEqual(self.call("stats")["total"], 1)

    def test_revision_rejects_stale_updates(self):
        self.create(); revision = self.call("contract", id="task")["revision"]
        self.call("update", id="task", title="New content", expected_revision=revision)
        self.reject("update", "revision_conflict", id="task", title="Overwrite", expected_revision=revision)
        self.assertEqual(self.call("show", id="task")["issue"]["title"], "New content")

    def test_successful_oracle_receipt_allows_close(self):
        self.create(); c = self.claim(); receipt = self.verify(c)
        self.assertTrue(receipt["passed"]); self.assertEqual(receipt["exit_code"], 0)
        self.close(c, receipt)
        self.assertEqual(self.call("show", id="task")["issue"]["status"], "closed")
        self.assertEqual(len(self.call("outbox_list", state="pending")), 1)

    def test_failed_oracle_never_closes(self):
        self.create(oracle_cmd="false"); c = self.claim(); receipt = self.verify(c)
        self.assertFalse(receipt["passed"])
        self.reject("close", id="task", actor="worker", epoch=c["epoch"], proof_id=receipt["proof_id"])

    def test_source_drift_invalidates_receipt(self):
        self.create(); c = self.claim(); receipt = self.verify(c)
        self.source.write_text("changed after proof\n")
        self.reject("close", "stale_proof", id="task", actor="worker", epoch=c["epoch"], proof_id=receipt["proof_id"])

    def test_contract_drift_invalidates_receipt(self):
        self.create(); c = self.claim(); receipt = self.verify(c)
        self.call("update", id="task", acceptance="Additional acceptance")
        self.reject("close", "stale_proof", id="task", actor="worker", epoch=c["epoch"], proof_id=receipt["proof_id"])

    def test_oracle_timeout_is_bounded(self):
        self.create(oracle_cmd="sleep 3"); c = self.claim()
        start = time.monotonic()
        receipt = self.call("verify", id="task", actor="worker", epoch=c["epoch"], cwd=str(self.work), timeout_secs=1)
        self.assertFalse(receipt["passed"]); self.assertTrue(receipt["timed_out"])
        self.assertLess(time.monotonic() - start, 4)
        self.reject("close", id="task", actor="worker", epoch=c["epoch"], proof_id=receipt["proof_id"])

    def test_verify_rejects_missing_scope(self):
        self.create(allowed_paths=[]); c = self.claim()
        self.reject("verify", "missing_scope", id="task", actor="worker", epoch=c["epoch"], cwd=str(self.work))

    def test_verify_is_rejected_inside_batch(self):
        self.create(oracle_cmd="touch marker"); c = self.claim()
        self.reject("batch", ops=[{"cmd": "verify", "args": {"id": "task", "actor": "worker", "epoch": c["epoch"], "cwd": str(self.work)}}])
        self.assertFalse((self.work / "marker").exists())

    def test_atomic_acquire_returns_complete_contract(self):
        self.create(lane="implementation")
        c = self.call("acquire", actor="worker", lane="implementation")
        self.assertEqual(c["id"], "task")
        for key in ["epoch", "claim_id", "lease_until", "revision", "contract"]:
            self.assertIn(key, c)
        self.assertIn("test -s input.txt", json.dumps(c["contract"]))
        brief = c['contract']
        for key in ['text', 'tokens', 'encoding', 'exact', 'omitted']:
            self.assertIn(key, brief)
        body = json.loads(brief['text'])
        for key in ['oracle_cmd', 'acceptance', 'allowed_paths', 'dependencies', 'revision']:
            self.assertIn(key, body)
        self.assertNotIn('brief', c)
        self.assertIsNone(self.call("acquire", actor="other", lane="implementation").get("id"))

    def test_goal_and_lane_filter_are_atomic(self):
        plan = self.call("plan", name="goal", subs=[{"title": "Inside", "oracle_cmd": "true", "allowed_paths": [str(self.source)], "lane": "inside"}])
        self.create("outside", priority=0, lane="outside")
        self.assertIsNone(self.call("acquire", actor="worker", goal=plan["goal"], lane="outside").get("id"))
        c = self.call("acquire", actor="worker", goal=plan["goal"], lane="inside")
        self.assertEqual(c["id"], plan["children"][0])

    def test_concurrent_acquire_never_duplicates(self):
        self.create()
        def acquire(actor):
            return self.request("acquire", {"actor": actor})
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            responses = list(pool.map(acquire, ["a", "b", "c", "d"]))
        self.assertTrue(all(ok for ok, _ in responses), responses)
        self.assertEqual(sum(data.get("id") == "task" for _, data in responses), 1)

    def test_token_budget_failure_does_not_claim_or_drop_acceptance(self):
        self.create(acceptance="Critical acceptance " * 200)
        self.reject("acquire", "budget_exceeded", actor="worker", max_tokens=1, encoding="o200k_base")
        self.assertEqual(self.call("show", id="task")["issue"]["status"], "open")
        self.reject("brief", "budget_exceeded", id="task", max_tokens=1, encoding="o200k_base")

    def test_tiktoken_is_explicit_about_encoding_and_billing(self):
        for encoding in ["o200k_base", "cl100k_base"]:
            result = self.call("tokens", text="hello world", encoding=encoding)
            self.assertEqual(result["encoding"], encoding)
            self.assertFalse(result["billing"])
            if result["exact"]:
                self.assertEqual(result["tokens"], 2)
            else:
                self.assertEqual(result["algorithm"], "utf8-upper-bound")
                self.assertGreaterEqual(result["tokens"], 2)
        self.reject("tokens", "unknown_tokenizer", text="hello", model="unregistered-provider-model")

    def test_checkpoint_resume_and_cancellation(self):
        self.create(); c = self.claim()
        self.call("checkpoint", id="task", actor="worker", epoch=c["epoch"], text="Prepared input", next_step="Run acceptance")
        resume = self.call("resume", id="task")
        self.assertIn("Prepared input", json.dumps(resume))
        self.reject("cancel", id="task", actor="unrelated")
        self.call("cancel", id="task", actor="worker", epoch=c["epoch"])
        hb = self.call("heartbeat", id="task", actor="worker", epoch=c["epoch"])
        self.assertTrue(hb["cancel_requested"])
        self.call("cancel_ack", id="task", actor="worker", epoch=c["epoch"])
        self.reject("heartbeat", id="task", actor="worker", epoch=c["epoch"])
        self.assertEqual(self.call("show", id="task")["issue"]["status"], "cancelled")

    def test_store_identity_is_stable_and_unique(self):
        first = self.call("context"); second = self.call("context")
        self.assertTrue(first["project_id"])
        self.assertEqual(first["project_id"], second["project_id"])
        self.assertIn(str(self.db), json.dumps(first))
        self.db = self.work / "other.db"
        self.assertNotEqual(first["project_id"], self.call("context")["project_id"])

    def test_context_is_compact_and_full_schemas_are_opt_in(self):
        context = self.call("context")
        self.assertLess(len(json.dumps(context).encode()), 8192)
        self.assertNotIn("ops", context["capabilities"])
        capabilities = self.call("capabilities", schemas=True)
        self.assertEqual(len(capabilities["operations"]), len(capabilities["ops"]))
        self.assertIn("inputSchema", capabilities["ops"][0])

    def test_checkpoint_advertises_and_accepts_worktree_cwd(self):
        capabilities = self.call("capabilities", schemas=True)
        schema = next(op["inputSchema"] for op in capabilities["ops"] if op["name"] == "checkpoint")
        self.assertIn("cwd", schema["properties"])
        tracker = self.work / "tracker"
        tracker.mkdir()
        self.db = tracker / "state.db"
        self.create()
        claim = self.claim()
        rejected = self.reject("checkpoint", id="task", actor="worker", epoch=claim["epoch"],
                               text="Prepared", next_step="Verify")
        self.assertIn(rejected["error"]["code"], ["scope_escape", "invalid_cwd"])
        self.call("checkpoint", id="task", actor="worker", epoch=claim["epoch"],
                  cwd=str(self.work), text="Prepared", next_step="Verify")
        receipt = self.call("resume", id="task")["checkpoint"]
        self.assertEqual(receipt["cwd"], str(self.work))
        self.assertFalse(receipt["stale"])

    def test_resume_clears_error_after_current_success_beyond_event_page(self):
        self.source.write_text("pending\n")
        self.create(oracle_cmd="test \"$(cat input.txt)\" = accepted")
        claim = self.claim()
        self.assertFalse(self.verify(claim)["passed"])
        self.assertIsNotNone(self.call("resume", id="task")["last_error"])
        self.call("batch", ops=[{"cmd": "note", "args": {"id": "task", "text": f"Bounded recovery event {index}"}}
                                for index in range(101)])
        self.source.write_text("accepted\n")
        self.assertTrue(self.verify(claim)["passed"])
        self.assertIsNone(self.call("resume", id="task")["last_error"])

    def test_projection_and_cursor_pagination(self):
        for i in range(3):
            self.create(f"task-{i}")
        projected = self.call("ready", fields=["id", "title"], limit=2)
        self.assertIsInstance(projected, list)
        self.assertTrue(all(set(item) == {"id", "title"} for item in projected))
        page = self.call("ready", fields=["id"], limit=2, cursor="")
        self.assertEqual(len(page["items"]), 2); self.assertTrue(page["next_cursor"])
        second = self.call("ready", fields=["id"], limit=2, cursor=page["next_cursor"])
        self.assertEqual(len(second["items"]), 1)
        self.assertFalse({x["id"] for x in page["items"]} & {x["id"] for x in second["items"]})
        self.reject("ready", cursor="malformed", limit=2)

    def test_admin_mutations_require_explicit_authority(self):
        self.create()
        self.reject("admin_update", id="task", admin_token="guessed", reason="No authority", status="closed")
        self.reject("import", jsonl="", admin_token="guessed")
        self.env["SIS_ADMIN_TOKEN"] = "test-local-admin-authority"
        self.call("admin_update", id="task", admin_token=self.env["SIS_ADMIN_TOKEN"], reason="Fixture administrative correction", status="blocked")
        self.assertEqual(self.call("show", id="task")["issue"]["status"], "blocked")
        self.assertNotIn(self.env["SIS_ADMIN_TOKEN"], json.dumps(self.call("history", id="task")))

    def test_container_requires_explicit_final_acceptance(self):
        self.create("project", type="goal")
        self.create("project.1", meta={"parent": "project"})
        self.reject("claim", id="project", actor="worker", finalize=True)
        child = self.claim("project.1")
        self.close(child, self.verify(child))
        self.assertIsNone(self.call("claim_next", actor="worker").get("id"))
        self.reject("claim", id="project", actor="worker")
        final = self.claim("project", finalize=True)
        self.close(final, self.verify(final))
        self.assertEqual(self.call("show", id="project")["issue"]["status"], "closed")

    def test_current_schema_read_does_not_write_and_future_is_rejected(self):
        import sqlite3
        self.call("context")
        with sqlite3.connect(self.db) as observer:
            version = observer.execute("PRAGMA data_version").fetchone()[0]
            self.call("context")
            self.assertEqual(observer.execute("PRAGMA data_version").fetchone()[0], version)
            observer.execute("PRAGMA user_version=99")
        self.reject("context")
        with sqlite3.connect(self.db) as observer:
            self.assertEqual(observer.execute("PRAGMA user_version").fetchone()[0], 99)

    def test_required_review_is_source_bound_and_not_self_review(self):
        self.create(meta={'review_required': True})
        claim = self.claim()
        proof = self.verify(claim)
        self.reject('close', 'review_required', id='task', actor='worker', epoch=claim['epoch'], proof_id=proof['proof_id'])
        review = dict(reviewer='worker', verdict='pass', revision=proof['revision'],
                      source_hash=proof['source_hash'], artifact='fixture-review.json')
        ok, self_proof = self.request('verify', dict(id='task', actor='worker', epoch=claim['epoch'], cwd=str(self.work), timeout_secs=2, review_receipt=review))
        if ok:
            self.reject('close', 'review_required', id='task', actor='worker', epoch=claim['epoch'], proof_id=self_proof['proof_id'])
        else:
            self.assertEqual(self_proof.get('error', {}).get('code'), 'review_required')
        review['reviewer'] = 'independent-fixture-reviewer'
        passed = self.verify(claim, review_receipt=review)
        self.close(claim, passed)

    def test_shared_database_create_and_search_across_runtimes(self):
        self.create()
        self.env['SIS_IMPL'] = 'py' if IMPL == 'rs' else 'rs'
        self.create('second', title='Crossruntimeuniqueword')
        result = self.call('search', q='Crossruntimeuniqueword')
        self.assertEqual([r['id'] for r in result], ['second'])
        self.env['SIS_IMPL'] = IMPL
        result = self.call('search', q='Crossruntimeuniqueword')
        self.assertEqual([r['id'] for r in result], ['second'])

    def test_plan_templates_keep_validation_and_dependency_edges(self):
        self.call('plan', name='template-original', save_as='fixture-template', subs=[
            {'title':'First','oracle_cmd':'true'}, {'title':'Second','oracle_cmd':'true','deps':[0]}])
        copy = self.call('plan', name='template-copy', template='fixture-template')
        self.assertEqual(len(copy['children']), 2)
        deps = self.call('show', id=copy['children'][1])['deps']
        self.assertIn(copy['children'][0], json.dumps(deps))
        self.reject('plan', name='missing-template', template='absent')

    def test_cursor_can_continue_after_runtime_switch(self):
        for number in range(5):
            self.create(str(number))
        first = self.call('list', limit=2, cursor='', fields=['id'])
        self.env['SIS_IMPL'] = 'py' if IMPL == 'rs' else 'rs'
        second = self.call('list', limit=2, cursor=first['next_cursor'], fields=['id'])
        self.assertEqual([r['id'] for r in second['items']], ['2','3'])

    def test_cursor_roundtrips_adjacent_sqlite_timestamps_across_runtimes(self):
        for number in range(5):
            self.create(str(number))
        timestamp = 1792769876.1234567
        for _ in range(16):
            with sqlite3.connect(self.db) as connection:
                connection.execute('UPDATE issues SET created_at=?', (timestamp,))
            for first_impl, second_impl in [('py', 'rs'), ('rs', 'py')]:
                with self.subTest(timestamp=timestamp, direction=(first_impl, second_impl)):
                    self.env['SIS_IMPL'] = first_impl
                    first = self.call('list', limit=2, cursor='', fields=['id'])
                    self.assertEqual([row['id'] for row in first['items']], ['0', '1'])
                    self.env['SIS_IMPL'] = second_impl
                    second = self.call('list', limit=2, cursor=first['next_cursor'], fields=['id'])
                    self.assertEqual([row['id'] for row in second['items']], ['2', '3'])
            timestamp = math.nextafter(timestamp, math.inf)
        self.env['SIS_IMPL'] = IMPL

    def test_ready_excludes_planning_rows_and_non_goal_containers(self):
        self.call('create', id='planning', title='No oracle')
        self.create('container')
        self.create('container.1', meta={'parent':'container'})
        self.assertEqual([row['id'] for row in self.call('ready')], ['container.1'])

    def test_nested_update_has_the_same_contract_as_flat_update(self):
        self.create()
        self.call('update', id='task', set={'title':'Updated through typed set'})
        self.assertEqual(self.call('show',id='task')['issue']['title'],'Updated through typed set')

    def test_administrative_correction_requires_a_reason(self):
        self.create()
        self.env['SIS_ADMIN_TOKEN']='synthetic-reason-test'
        self.reject('admin_update',id='task',admin_token=self.env['SIS_ADMIN_TOKEN'],status='blocked')

    def test_goal_metadata_survives_runtime_switch(self):
        goal = self.call('plan',name='metadata-goal',objective='Visible objective',subs=[])
        for implementation in ['rs','py']:
            self.env['SIS_IMPL']=implementation
            tree=self.call('goal_tree',id=goal['goal'])
            self.assertEqual(tree['meta']['objective'],'Visible objective')


def main():
    global IMPL, SIS_BIN
    p = argparse.ArgumentParser()
    p.add_argument("--impl", choices=["rs", "py"], default="rs")
    p.add_argument("--case", help="Only tests matching this substring")
    p.add_argument("--bin", default=str(ROOT / "bin/sis"))
    args = p.parse_args()
    IMPL, SIS_BIN = args.impl, args.bin
    loader = unittest.TestLoader()
    if args.case:
        loader.testNamePatterns = [f"*{args.case}*"]
    suite = loader.loadTestsFromTestCase(AgentContract)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
