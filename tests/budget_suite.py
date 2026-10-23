#!/usr/bin/env python3
"""Budget and opt-in local execution acceptance against either Superiss core."""
import argparse
import errno
import fcntl
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import runpy

ROOT = Path(__file__).resolve().parents[1]
IMPL, SIS_BIN = 'rs', str(ROOT / 'bin/sis')
PYTHON = str(Path(sys.executable).resolve(strict=True))
PYTHON_APP = Path(PYTHON).parent.parent / 'Resources/Python.app/Contents/MacOS/Python'
if PYTHON_APP.is_file():
    PYTHON = str(PYTHON_APP)


class BudgetContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sis-budget-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.work = self.root / 'work'
        self.work.mkdir()
        self.source = self.work / 'input.txt'
        self.source.write_text('accepted\n')
        self.db = self.root / 'state.db'
        self.env = {k: v for k, v in os.environ.items()
                    if k not in ('SIS_DB', 'SIS_SOCK', 'SIS_ADMIN_TOKEN')}
        self.env.update(SIS_IMPL=IMPL, SIS_DIRECT='1')
        self.pass_fds = ()

    def request(self, command, **args):
        result = subprocess.run([SIS_BIN, command, json.dumps(args), '--db', str(self.db)],
                                cwd=self.work, env=self.env, capture_output=True,
                                text=True, timeout=20, pass_fds=self.pass_fds)
        raw = result.stdout.strip() if result.returncode == 0 else result.stderr.strip() or result.stdout.strip()
        try:
            data = json.loads(raw)
        except ValueError:
            self.fail(f'{command}: rc={result.returncode}: {raw[:1000]}')
        if result.returncode == 0 and isinstance(data, dict) and data.get('ok') is True and 'data' in data:
            data = data['data']
        return result.returncode == 0, data

    def call(self, command, **args):
        ok, data = self.request(command, **args)
        self.assertTrue(ok, (command, data))
        return data

    def reject(self, command, code, **args):
        ok, data = self.request(command, **args)
        self.assertFalse(ok, (command, data))
        self.assertEqual(data.get('error', {}).get('code'), code, data)

    def create(self, **extra):
        args = dict(id='task', title='Bounded local task', oracle_cmd='test -s input.txt',
                    allowed_paths=[str(self.source)], acceptance='Input exists')
        args.update(extra)
        self.call('create', **args)
        claim = self.call('claim', id='task', actor='worker', ttl=60)
        return dict(id='task', actor='worker', epoch=claim['epoch'], cwd=str(self.work))

    def execute(self, kind, args, command=None):
        if kind == 'verify':
            return self.request('verify', **args, timeout_secs=3)
        return self.request('attest', **args, kind='run', cmd=command or 'touch ran', timeout_secs=3)

    def test_zero_budget_blocks_close_after_positive_cost(self):
        args = self.create(budget_eur=0, meta={'budget_gate': True})
        proof = self.call('verify', **args)
        self.call('cost_add', issue='task', cents=1)
        self.reject('close', 'budget_exceeded', **args, proof_id=proof['proof_id'])

    def test_local_zero_capability_is_explicit(self):
        self.assertIs(self.call('capabilities')['local_zero_execution'], True)

    def test_unknown_budget_is_not_zero(self):
        args = self.create(meta={'budget_gate': True})
        proof = self.call('verify', **args)
        self.reject('close', 'budget_missing', **args, proof_id=proof['proof_id'])

    def test_zero_budget_allows_close_without_cost(self):
        args = self.create(budget_eur=0, meta={'budget_gate': True})
        proof = self.call('verify', **args)
        self.call('close', **args, proof_id=proof['proof_id'])

    def test_positive_budget_preserves_gate(self):
        args = self.create(budget_eur=1, meta={'budget_gate': True})
        proof = self.call('verify', **args)
        self.call('cost_add', issue='task', cents=100)
        self.call('close', **args, proof_id=proof['proof_id'])

    def test_local_zero_rejects_missing_and_positive_budget_before_execution(self):
        for budget in (None, 1):
            for kind in ('verify', 'attest'):
                with self.subTest(budget=budget, kind=kind):
                    # A separate fixture keeps claims and proof state independent.
                    self.setUp()
                    args = self.create(budget_eur=budget, meta={'local_zero': True}, oracle_cmd='touch ran')
                    ok, data = self.execute(kind, args)
                    self.assertFalse(ok, data)
                    self.assertEqual(data.get('error', {}).get('code'), 'local_zero_budget', data)
                    self.assertFalse((self.work / 'ran').exists())

    def test_local_zero_rejects_existing_subtree_cost_before_execution(self):
        for kind in ('verify', 'attest'):
            with self.subTest(kind=kind):
                self.setUp()
                args = self.create(budget_eur=0, meta={'local_zero': True}, oracle_cmd='touch ran')
                self.call('create', id='task.child', title='Cost child')
                self.call('cost_add', issue='task.child', cents=1)
                ok, data = self.execute(kind, args)
                self.assertFalse(ok, data)
                self.assertEqual(data.get('error', {}).get('code'), 'budget_exceeded', data)
                self.assertFalse((self.work / 'ran').exists())

    def sandbox_case(self, command, expected, started=None, blocked=None):
        for kind in ('verify', 'attest'):
            with self.subTest(kind=kind):
                self.setUp()
                self.env.update(OPENAI_API_KEY='synthetic-local-zero-secret',
                                AWS_SECRET_ACCESS_KEY='synthetic-local-zero-secret')
                args = self.create(budget_eur=0, meta={'local_zero': True}, oracle_cmd=command)
                ok, data = self.execute(kind, args, command)
                if sys.platform != 'darwin' or not Path('/usr/bin/sandbox-exec').is_file():
                    self.assertFalse(ok, data)
                    self.assertEqual(data.get('error', {}).get('code'), 'local_zero_unavailable', data)
                    continue
                self.assertTrue(ok, data)
                self.assertEqual(data['passed'], expected, data)
                evidence = data.get('execution') or data.get('summary', {}).get('execution')
                self.assertEqual(evidence['mode'], 'local_zero', data)
                self.assertEqual(evidence['sandbox'], 'macos-seatbelt', data)
                if started:
                    self.assertTrue((self.work / started).is_file(), 'real interpreter did not run')
                if blocked:
                    self.assertTrue((self.work / blocked).is_file(), 'operation did not raise PermissionError')

    def test_local_zero_runs_with_minimal_credential_free_environment(self):
        self.sandbox_case('test -z "$OPENAI_API_KEY$AWS_SECRET_ACCESS_KEY" && '
                          'test "$HOME" = "$PWD" && test "$TMPDIR" = "$PWD" && '
                          'test "$PATH" = /usr/bin:/bin:/usr/sbin:/sbin && touch local-output', True)

    def test_local_zero_blocks_outside_write(self):
        self.sandbox_case('printf forbidden > ../outside-write', False)
        self.assertFalse((self.root / 'outside-write').exists())

    def test_local_zero_blocks_unix_and_inet_sockets(self):
        for family in ('AF_INET', 'AF_UNIX'):
            with self.subTest(family=family):
                listener = socket.socket(getattr(socket, family), socket.SOCK_STREAM)
                self.addCleanup(listener.close)
                address = ('127.0.0.1', 0) if family == 'AF_INET' else str(self.root / 'provider.sock')
                listener.bind(address)
                listener.listen(1)
                address = listener.getsockname()
                command = shlex.join([PYTHON, '-c',
                                      'from pathlib import Path; import socket; Path("interpreter-started").write_text("started"); '
                                      f's=socket.socket(socket.{family}, socket.SOCK_STREAM); '
                                      f's.settimeout(1); s.connect({address!r})'])
                self.sandbox_case(command, False, started='interpreter-started')

    def test_local_zero_blocks_session_and_group_escape(self):
        for operation in ('os.setsid()', 'os.setpgid(0, 0)',
                          "os.posix_spawn('/bin/sleep', ['sleep', '20'], {}, setpgroup=0)"):
            with self.subTest(operation=operation):
                script = ('import os\nfrom pathlib import Path\n'
                          'assert os.getpgrp() != os.getpid()\n'
                          'Path("interpreter-started").write_text(str(os.getpid()))\n'
                          'try:\n'
                          f'    result = {operation}\n'
                          'except PermissionError:\n'
                          '    Path("escape-blocked").write_text("EPERM")\n'
                          'else:\n'
                          '    if result: os.kill(result, 9)\n'
                          '    raise SystemExit("escape unexpectedly permitted")\n')
                command = shlex.join([PYTHON, '-c', script]) + ' & child=$!; wait "$child"'
                self.sandbox_case(command, True, started='interpreter-started', blocked='escape-blocked')

    def test_local_zero_timeout_kills_descendants_and_bounds_readers(self):
        for kind in ('verify', 'attest'):
            with self.subTest(kind=kind):
                self.setUp()
                script = ('import os,time\nfrom pathlib import Path\n'
                          'child=os.fork()\n'
                          'if child == 0:\n'
                          '    Path("child.pid").write_text(str(os.getpid()))\n'
                          '    time.sleep(20)\n'
                          '    Path("late-effect").write_text("escaped")\n'
                          '    os._exit(0)\n'
                          'time.sleep(20)\n')
                command = shlex.join([PYTHON, '-c', script])
                args = self.create(budget_eur=0, meta={'local_zero': True}, oracle_cmd=command)
                started = time.monotonic()
                params = dict(args, timeout_secs=1)
                if kind == 'attest':
                    params.update(kind='run', cmd=command)
                result = self.call('verify' if kind == 'verify' else 'attest', **params)
                elapsed = time.monotonic() - started
                self.assertFalse(result['passed'], result)
                self.assertTrue(result.get('timed_out', result.get('summary', {}).get('timed_out')), result)
                self.assertLess(elapsed, 4, 'timeout includes bounded pipe drain')
                self.assertTrue((self.work / 'child.pid').is_file(), 'forking real interpreter did not run')
                pid = int((self.work / 'child.pid').read_text())
                deadline = time.monotonic() + 1
                alive = True
                while alive and time.monotonic() < deadline:
                    try:
                        os.kill(pid, 0)
                    except ProcessLookupError:
                        alive = False
                    else:
                        time.sleep(.01)
                if alive:
                    os.kill(pid, 9)
                self.assertFalse(alive, f'owned child {pid} survived timeout')
                self.assertFalse((self.work / 'late-effect').exists())

    def test_python_timeout_does_not_resignal_completed_group(self):
        if IMPL != 'py':
            self.skipTest('Python cleanup regression')
        run_oracle = runpy.run_path(str(ROOT / 'agent.py'))['run_oracle']
        real_killpg, signalled = os.killpg, []

        def signal_group(pgid, sig):
            if pgid in signalled:
                raise PermissionError(errno.EPERM, 'group now contains only zombies')
            real_killpg(pgid, sig)
            signalled.append(pgid)

        script = ('import os,time\nfrom pathlib import Path\n'
                  'Path("started.pid").write_text(str(os.getpid()))\n'
                  'time.sleep(20)\n')
        with patch.object(os, 'killpg', side_effect=signal_group):
            code, timed_out, _ = run_oracle(shlex.join([PYTHON, '-c', script]),
                                          str(self.work), 1, True)
        self.assertTrue(timed_out)
        self.assertNotEqual(code, 0)
        self.assertTrue((self.work / 'started.pid').is_file())
        self.assertEqual(len(signalled), 1)
        with self.assertRaises(ProcessLookupError):
            os.kill(int((self.work / 'started.pid').read_text()), 0)

    def test_security_policy_and_budget_are_revision_bound(self):
        self.create(budget_eur=1)
        self.env['SIS_ADMIN_TOKEN'] = 'synthetic-revision-admin'
        for field, value in [('budget_eur', 0), ('local_zero', True),
                             ('execution', {'cmd': 'true', 'cwd': str(self.work)}),
                             ('budget_gate', True), ('review_required', True),
                             ('attest_required', ['run'])]:
            with self.subTest(field=field):
                before = self.call('contract', id='task')['revision']
                changes = {'budget_eur': value} if field == 'budget_eur' else {'meta': {field: value}}
                self.call('admin_update', id='task', admin_token=self.env['SIS_ADMIN_TOKEN'],
                          reason='Synthetic security revision regression', **changes)
                after = self.call('contract', id='task')['revision']
                self.assertNotEqual(before, after)

    def test_stale_expected_revision_blocks_effects(self):
        args = self.create(oracle_cmd='touch ran')
        revision = self.call('contract', id='task')['revision']
        self.call('update', **args, meta={'budget_gate': True})
        for kind in ('verify', 'attest'):
            with self.subTest(kind=kind):
                ok, data = self.execute(kind, dict(args, expected_revision=revision))
                self.assertFalse(ok, data)
                self.assertEqual(data.get('error', {}).get('code'), 'revision_conflict', data)
                self.assertFalse((self.work / 'ran').exists())

    def test_security_change_invalidates_existing_proof(self):
        args = self.create(budget_eur=1)
        proof = self.call('verify', **args)
        self.call('update', **args, budget_eur=0, meta={'budget_gate': True})
        self.reject('close', 'stale_proof', **args, proof_id=proof['proof_id'])

    def test_controller_lock_descriptor_reaches_sandbox_child(self):
        for kind in ('verify', 'attest'):
            with self.subTest(kind=kind):
                self.setUp()
                fd = os.open(self.root / 'controller.lock', os.O_CREAT | os.O_RDWR, 0o600)
                self.addCleanup(os.close, fd)
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.env['SIS_CONTROLLER_LOCK_FD'] = str(fd)
                self.pass_fds = (fd,)
                command = shlex.join([PYTHON, '-c', f'import os; os.fstat({fd})'])
                args = self.create(budget_eur=0, meta={'local_zero': True}, oracle_cmd=command)
                ok, data = self.execute(kind, args, command)
                self.assertTrue(ok, data)
                self.assertTrue(data['passed'], data)

    def test_local_zero_command_and_cwd_match_execution_policy(self):
        args = self.create(budget_eur=0, meta={'local_zero': True,
                           'execution': {'cmd': 'touch permitted', 'cwd': str(self.work)}})
        self.reject('attest', 'execution_mismatch', **args, kind='run', cmd='touch ran')
        self.assertFalse((self.work / 'ran').exists())
        self.call('update', **args, meta={'local_zero': True,
                  'execution': {'cmd': 'touch ran', 'cwd': str(self.root)}})
        self.reject('attest', 'execution_mismatch', **args, kind='run', cmd='touch ran')
        self.assertFalse((self.work / 'ran').exists())

    def test_positive_cost_after_local_zero_proof_blocks_close(self):
        args = self.create(budget_eur=0, meta={'local_zero': True})
        proof = self.call('verify', **args)
        self.call('cost_add', issue='task', cents=1)
        self.reject('close', 'budget_exceeded', **args, proof_id=proof['proof_id'])

    def test_local_zero_blocks_launch_ipc(self):
        self.sandbox_case('/bin/launchctl list >/dev/null', False)


def main():
    global IMPL, SIS_BIN
    parser = argparse.ArgumentParser()
    parser.add_argument('--impl', choices=['rs', 'py'], default='rs')
    parser.add_argument('--bin', default=str(ROOT / 'bin/sis'))
    parser.add_argument('--case')
    args = parser.parse_args()
    IMPL, SIS_BIN = args.impl, args.bin
    loader = unittest.TestLoader()
    if args.case:
        loader.testNamePatterns = [f'*{args.case}*']
    result = unittest.TextTestRunner(verbosity=2).run(loader.loadTestsFromTestCase(BudgetContract))
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    raise SystemExit(main())
