"""Complete one explicit local task, preserving uncertainty across restarts."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import threading
import time
from typing import Any


class WorkflowError(RuntimeError):
    pass


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def emit(event: str, **fields: Any) -> None:
    print(json.dumps({'event': event, **fields}, sort_keys=True), flush=True)


class Workflow:
    def __init__(self, options: argparse.Namespace):
        self.options = options
        self.db = options.db.resolve(strict=True)
        self.binary = options.sis.resolve(strict=True)
        if not self.db.is_file() or not options.issue:
            raise WorkflowError('invalid_request: existing DB and explicit --issue required')
        if not 1 <= options.timeout <= 60 or not 5 <= options.deadline <= 300:
            raise WorkflowError('invalid_request: timeout 1..60 and deadline 5..300 required')
        self.deadline = time.monotonic() + options.deadline
        self.stopped = threading.Event()
        self.state: dict[str, Any] = {}
        self.identity: dict[str, Any] = {}
        self.cwd = Path.cwd()
        self.config_hash = ''
        self.revision = ''
        self.project = ''
        folder = self.db.parent / '.sis' / 'workflow-locks'
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        key = hashlib.sha256(f'{self.db}\0{options.issue}'.encode()).hexdigest()
        fd = os.open(folder / key, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        self.lock = os.fdopen(fd, 'r+')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            self.lock.close()
            raise WorkflowError('busy: the previous controller or execution child still owns this task') from error

    def call(self, command: str, args: dict[str, Any], execution: bool = False) -> dict[str, Any]:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise WorkflowError('deadline_exceeded: no further operation started')
        env = dict(os.environ, SIS_DIRECT='1', SIS_CONTROLLER_LOCK_FD=str(self.lock.fileno()))
        env.pop('SIS_SOCK', None)
        process = subprocess.Popen(
            [str(self.binary), command, canonical(args), '--db', str(self.db)],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            pass_fds=(self.lock.fileno(),),
        )
        if execution:
            emit('worker_started', issue=self.options.issue, stage=command, pid=process.pid)
        try:
            stdout, stderr = process.communicate(timeout=min(remaining, self.options.timeout + 10 if execution else 15))
        except subprocess.TimeoutExpired as error:
            process.kill()
            process.communicate(timeout=3)
            raise WorkflowError('execution_uncertain: deadline reached; inspect persisted phase before recovery') from error
        raw = stdout.strip() or stderr.strip()
        if len(raw.encode()) > 1024 * 1024:
            raise WorkflowError('invalid_response: response exceeds 1 MiB')
        try:
            response = json.loads(raw)
        except ValueError as error:
            raise WorkflowError('execution_uncertain: worker exited without a committed response') from error
        if not isinstance(response, dict):
            raise WorkflowError('invalid_response: expected object')
        if process.returncode != 0 or response.get('ok') is False:
            code = response.get('error', {}).get('code', 'transport')
            raise WorkflowError(f'{code}: {command} rejected; no subsequent stage started')
        return response['data'] if response.get('ok') is True and 'data' in response else response

    def configuration(self, task: dict[str, Any]) -> tuple[dict[str, Any], str]:
        meta = task.get('meta') or {}
        execution = meta.get('execution')
        if task.get('owner') != self.options.actor:
            raise WorkflowError('owner_mismatch: selected task must belong to this actor')
        if meta.get('local_zero') is not True or isinstance(task.get('budget_eur'), bool) or task.get('budget_eur') != 0:
            raise WorkflowError('cost_authorization_required: explicit local_zero and known zero budget required')
        if meta.get('autorun'):
            raise WorkflowError('invalid_request: workflow and autorun outbox cannot execute the same task')
        if not isinstance(execution, dict) or not isinstance(execution.get('cmd'), str) or not execution['cmd'].strip():
            raise WorkflowError('invalid_request: meta.execution.cmd required')
        if len(execution['cmd']) > 8192 or not isinstance(execution.get('cwd'), str):
            raise WorkflowError('invalid_request: bounded command and absolute cwd required')
        cwd = Path(execution['cwd'])
        if not cwd.is_absolute() or not cwd.is_dir():
            raise WorkflowError('invalid_request: existing absolute cwd required')
        cwd = cwd.resolve(strict=True)
        if self.db.is_relative_to(cwd):
            raise WorkflowError('unsafe_workspace: writable job directory must not contain the task DB')
        for field in ['replay_safe', 'oracle_replay_safe']:
            if field in execution and not isinstance(execution[field], bool):
                raise WorkflowError(f'invalid_request: {field} must be boolean')
        self.cwd = cwd
        bound = {'db': str(self.db), 'project': self.project, 'issue': task['id'],
                 'owner': task.get('owner'), 'budget_eur': task.get('budget_eur'),
                 'execution': execution, 'meta': meta, 'oracle': task.get('oracle_cmd'),
                 'allowed_paths': task.get('allowed_paths'), 'timeout': self.options.timeout}
        return execution, hashlib.sha256(canonical(bound).encode()).hexdigest()

    def checkpoint(self, phase: str, **values: Any) -> None:
        self.state.update(values, phase=phase, schema='sis-workflow-v1', config=self.config_hash,
                          project=self.project, actor=self.options.actor, epoch=self.identity['epoch'])
        self.call('checkpoint', {**self.identity, 'cwd': str(self.cwd),
                               'expected_revision': self.revision, 'text': canonical(self.state),
                               'next_step': phase, 'artifacts': []})
        emit('checkpoint', issue=self.options.issue, phase=phase)

    def cached(self, command: str, request: dict[str, Any]) -> dict[str, Any] | None:
        # Execution responses and their idempotency keys commit in one native TX.
        # Reading that receipt avoids rerunning a non-replayable effect after a lost reply.
        with sqlite3.connect(self.db.as_uri() + '?mode=ro', uri=True, timeout=5) as connection:
            row = connection.execute('SELECT v FROM kv WHERE k=?', ('idem:' + request['idem'],)).fetchone()
        if row is None:
            return None
        receipt = json.loads(row[0])
        payload = {key: value for key, value in request.items() if key != 'idem'}
        if (receipt.get('cmd') != command or receipt.get('actor') != self.options.actor
                or receipt.get('payload_hash') != hashlib.sha256(canonical(payload).encode()).hexdigest()):
            raise WorkflowError('recovery_required: stored response does not match the persisted request')
        data = receipt.get('data')
        if not isinstance(data, dict):
            raise WorkflowError('recovery_required: invalid execution receipt')
        return data

    def before_stage(self) -> None:
        if self.stopped.is_set():
            raise WorkflowError('stopped: checkpoint retained for explicit resume')
        task = self.call('show', {'id': self.options.issue})['issue']
        _, current = self.configuration(task)
        if current != self.config_hash:
            raise WorkflowError('recovery_required: execution configuration changed')
        heartbeat = self.call('heartbeat', {**self.identity, 'ttl': self.options.timeout * 2 + 30})
        if heartbeat.get('cancel_requested'):
            raise WorkflowError('cancel_requested: no subsequent stage started')

    def execute_stage(self, command: str, phase: str, request: dict[str, Any]) -> dict[str, Any]:
        self.before_stage()
        attempts = self.state.get('attempts', 0) + 1
        if attempts > 6:
            raise WorkflowError('retry_exhausted: recovery limit reached')
        if self.deadline - time.monotonic() < self.options.timeout + 3:
            raise WorkflowError('deadline_exceeded: insufficient time for a bounded execution')
        self.checkpoint(phase, request=request, attempts=attempts)
        return self.call(command, request, execution=True)

    def run(self) -> int:
        context = self.call('context', {})
        if context.get('capabilities', {}).get('local_zero_execution') is not True:
            raise WorkflowError('incompatible_runtime: native local-zero execution support required')
        self.project = context['project_id']
        task = self.call('show', {'id': self.options.issue})['issue']
        if task['status'] == 'closed':
            emit('already_closed', issue=self.options.issue)
            return 0
        execution, self.config_hash = self.configuration(task)
        resumed = self.call('resume', {'id': self.options.issue})
        if resumed.get('cancel_requested'):
            raise WorkflowError('cancel_requested: no execution started')
        cp = resumed.get('checkpoint')
        phase = 'prepared'
        if cp is not None:
            if not self.options.resume:
                raise WorkflowError('recovery_required: use --resume to inspect and continue this task')
            try:
                self.state = json.loads(cp['text'])
            except (TypeError, ValueError) as error:
                raise WorkflowError('recovery_required: invalid checkpoint encoding') from error
            if not isinstance(self.state, dict):
                raise WorkflowError('recovery_required: invalid checkpoint structure')
            if (cp.get('stale') or cp.get('actor') != self.options.actor
                    or self.state.get('schema') != 'sis-workflow-v1'
                    or self.state.get('project') != self.project
                    or self.state.get('config') != self.config_hash
                    or self.state.get('epoch') != cp.get('epoch')):
                raise WorkflowError('recovery_required: stale or foreign checkpoint')
            phase = self.state['phase']
            if phase in ['run_failed', 'verify_failed']:
                raise WorkflowError('task_failed: known failure requires an explicit new decision')
            if phase in ['run_started', 'verify_started']:
                command = 'attest' if phase == 'run_started' else 'verify'
                result = self.cached(command, self.state['request'])
                if result is not None:
                    if result.get('passed') is not True:
                        raise WorkflowError('task_failed: committed failure cannot become a successful retry')
                    phase = 'run_passed' if command == 'attest' else 'proof_passed'
                    self.state.update(proof_id=result.get('proof_id'), attest_id=result.get('attest_id'))
                elif execution.get('replay_safe' if command == 'attest' else 'oracle_replay_safe') is not True:
                    raise WorkflowError('recovery_required: previous execution has uncertain non-replayable effects')
                else:
                    phase = 'prepared' if command == 'attest' else 'run_passed'
        if task.get('claim_actor') not in [None, self.options.actor] and (task.get('lease_until') or 0) > time.time():
            raise WorkflowError('foreign_claim: another worker owns this task')
        if task.get('claim_actor') == self.options.actor and (task.get('lease_until') or 0) > time.time():
            epoch = task['lease_epoch']
        else:
            claimed = self.call('claim', {'id': self.options.issue, 'actor': self.options.actor,
                                          'ttl': self.options.timeout * 2 + 30})
            epoch = claimed['epoch']
        if cp is not None and cp['epoch'] != epoch and phase in ['proof_passed', 'close_started', 'verify_started']:
            if execution.get('oracle_replay_safe') is not True:
                raise WorkflowError('recovery_required: a new lease needs a new proof but oracle replay is not authorized')
            phase = 'run_passed'
        self.identity = {'id': self.options.issue, 'actor': self.options.actor, 'epoch': epoch}
        self.revision = self.call('contract', {'id': self.options.issue})['revision']
        self.checkpoint(phase)
        if phase == 'prepared':
            run_request = {**self.identity, 'kind': 'run', 'cmd': execution['cmd'], 'cwd': str(self.cwd),
                           'timeout_secs': self.options.timeout, 'expected_revision': self.revision,
                           'idem': f'workflow:{self.options.issue}:{epoch}:run'}
            result = self.execute_stage('attest', 'run_started', run_request)
            if result.get('passed') is not True:
                self.checkpoint('run_failed')
                raise WorkflowError('run_failed: oracle and close were not started')
            self.checkpoint('run_passed', attest_id=result['attest_id'])
            phase = 'run_passed'
        if phase == 'run_passed':
            verify_request = {**self.identity, 'cwd': str(self.cwd), 'timeout_secs': self.options.timeout,
                              'expected_revision': self.revision,
                              'idem': f'workflow:{self.options.issue}:{epoch}:verify'}
            proof = self.execute_stage('verify', 'verify_started', verify_request)
            if proof.get('passed') is not True:
                self.checkpoint('verify_failed')
                raise WorkflowError('verify_failed: task was not closed')
            self.checkpoint('proof_passed', proof_id=proof['proof_id'])
            phase = 'proof_passed'
        if phase not in ['proof_passed', 'close_started'] or not self.state.get('proof_id'):
            raise WorkflowError('recovery_required: unsupported workflow phase')
        self.before_stage()
        self.checkpoint('close_started')
        self.call('close', {**self.identity, 'proof_id': self.state['proof_id'],
                           'reason': 'Local zero-cost workflow: run, oracle and readback'})
        shown = self.call('show', {'id': self.options.issue})
        if shown['issue']['status'] != 'closed' or not any(
                event['op'] == 'close' and event.get('data', {}).get('proof_id') == self.state['proof_id']
                for event in shown['events_tail']):
            raise WorkflowError('recovery_required: close readback did not match proof')
        emit('closed', issue=self.options.issue, proof_id=self.state['proof_id'])
        return 0


def run(options: argparse.Namespace) -> int:
    workflow = Workflow(options)
    old = {sig: signal.signal(sig, lambda _sig, _frame: workflow.stopped.set())
           for sig in [signal.SIGINT, signal.SIGTERM]}
    try:
        return workflow.run()
    finally:
        for sig, handler in old.items():
            signal.signal(sig, handler)
        workflow.lock.close()
