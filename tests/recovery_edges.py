#!/usr/bin/env python3
"""Adversarial restart checks against private stores and real execution children."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
BIN = str(ROOT / 'bin/sis')
IMPL = 'rs'

PROXY = r'''#!/usr/bin/env python3
import json, os
from pathlib import Path
import subprocess, sys, time
base = Path(__file__).resolve().parent
config = json.loads((base / 'proxy.json').read_text())
command, payload = sys.argv[1], json.loads(sys.argv[2])
fd = os.environ.get('SIS_CONTROLLER_LOCK_FD')
child = subprocess.Popen([config['binary'], *sys.argv[1:]],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    pass_fds=(() if fd is None else (int(fd),)))
(base / ('kernel-' + command + '.pid')).write_text(str(child.pid))
out, err = child.communicate(timeout=30)
intercept = command == config['command']
if command == 'checkpoint':
    intercept = intercept and payload.get('next_step') == config.get('phase')
if intercept and child.returncode == 0:
    result = json.loads(out)
    if result.get('ok') is not False:
        (base / 'committed.json').write_text(json.dumps(result))
        while not (base / 'release.proxy').exists():
            time.sleep(.02)
sys.stdout.buffer.write(out)
sys.stderr.buffer.write(err)
raise SystemExit(child.returncode)
'''


class RecoveryEdges(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sis-recovery-edges-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.work = self.base / 'job'
        self.work.mkdir()
        (self.work / 'source.txt').write_text('fixed input\n')
        self.db = self.base / 'state.db'
        self.env = dict(os.environ, SIS_IMPL=IMPL, SIS_DIRECT='1')
        for key in ['SIS_DB', 'SIS_SOCK', 'SIS_HTTP', 'SIS_ADMIN_TOKEN',
                    'SIS_CONTROLLER_LOCK_FD', 'SIS_RUNNER_PYTHON']:
            self.env.pop(key, None)
        self.env['SIS_ADMIN_TOKEN'] = 'private-recovery-edge-fixture'
        self.processes: list[subprocess.Popen] = []
        self.logs: dict[int, tuple[Path, Path]] = {}
        self.owned_pids: set[int] = set()
        self.shell_pids: set[int] = set()
        self.addCleanup(self.cleanup_processes)

    def call(self, command, **args):
        result = subprocess.run([BIN, command, json.dumps(args), '--db', str(self.db)],
                                cwd=self.work, env=self.env, capture_output=True,
                                text=True, timeout=20)
        self.assertEqual(result.returncode, 0, f'{command}: {result.stdout} {result.stderr}')
        data = json.loads(result.stdout)
        return data['data'] if data.get('ok') is True and 'data' in data else data

    def create(self, command='printf r >> runs.txt', oracle='printf v >> verifies.txt', **execution):
        self.execution = {'cmd': command, 'cwd': str(self.work),
                          'replay_safe': False, 'oracle_replay_safe': False, **execution}
        self.meta = {'controller': 'worker', 'local_zero': True,
                     'budget_gate': True, 'execution': self.execution}
        self.call('create', id='task', title='Private recovery edge fixture', owner='worker',
                  budget_eur=0, oracle_cmd=oracle,
                  allowed_paths=[str(self.work / 'source.txt')], meta=self.meta)

    def proxy(self, command, phase=None):
        path = self.base / 'proxy.py'
        path.write_text(PROXY)
        path.chmod(0o700)
        (self.base / 'proxy.json').write_text(json.dumps({
            'binary': str(Path(BIN).resolve()), 'command': command, 'phase': phase}))
        return path

    def start(self, *extra, proxy=None):
        args = [BIN, 'run', '--db', str(self.db), '--issue', 'task', '--actor', 'worker',
                '--timeout', '5', '--deadline', '25', *extra]
        if proxy is not None:
            args += ['--sis', str(proxy)]
        number = len(self.processes)
        out, err = self.base / f'controller-{number}.out', self.base / f'controller-{number}.err'
        with out.open('wb') as stdout, err.open('wb') as stderr:
            process = subprocess.Popen(args, cwd=self.base, env=self.env,
                                       stdout=stdout, stderr=stderr)
        self.processes.append(process)
        self.logs[process.pid] = out, err
        return process

    def output(self, process):
        out, err = self.logs[process.pid]
        return out.read_text(), err.read_text()

    def wait_for(self, predicate, description, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = predicate()
            if result:
                return result
            if self.processes and self.processes[-1].poll() is not None:
                self.fail(f'controller exited before {description}: ' + repr(
                    self.output(self.processes[-1])))
            time.sleep(.025)
        self.fail(f'timed out waiting for {description}; logs=' + repr(
            [self.output(process) for process in self.processes]))

    def event(self, process, stage):
        def observed():
            for line in self.output(process)[0].splitlines():
                event = json.loads(line)
                if event.get('event') == 'worker_started' and event.get('stage') == stage:
                    self.owned_pids.add(event['pid'])
                    return event
            return None
        return self.wait_for(observed, f'{stage} worker event')

    def shell(self):
        path = self.work / 'shell.pid'
        self.wait_for(path.exists, 'execution shell marker')
        pid = int(path.read_text().strip())
        self.assertEqual(os.getpgid(pid), pid, 'execution shell must own its process group')
        self.shell_pids.add(pid)
        return pid

    def kill(self, pid):
        identity = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'stat=', '-o', 'command='],
                                  capture_output=True, text=True, timeout=3).stdout
        if not identity.strip() or identity.lstrip().startswith('Z'):
            return
        self.assertIn(str(self.base), identity, 'refusing to kill a process outside this fixture')
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def cleanup_processes(self):
        # All PIDs come from our Popen, its emitted worker receipt, or its private marker.
        for process in self.processes:
            if process.poll() is None:
                process.kill()
        for path in self.base.glob('kernel-*.pid'):
            self.owned_pids.add(int(path.read_text()))
        for pid in self.owned_pids:
            self.kill(pid)
        for pid in self.shell_pids:
            try:
                if os.getpgid(pid) == pid:
                    os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for process in self.processes:
            process.wait(timeout=5)

    def finished(self, process, success):
        process.wait(timeout=15)
        out, err = self.output(process)
        if success:
            self.assertEqual(process.returncode, 0, out + err)
        else:
            self.assertNotEqual(process.returncode, 0, out + err)
        return out, err

    def marker(self, name):
        path = self.work / name
        return path.read_text() if path.exists() else ''

    def assert_open(self):
        self.assertNotEqual(self.call('show', id='task')['issue']['status'], 'closed')

    def test_controller_sigkill_child_keeps_lock_after_lease_expiry(self):
        self.create(command='echo $$ > shell.pid; printf r >> runs.txt; '
                            'while ! test -f release.run; do sleep .05; done')
        first = self.start()
        self.event(first, 'attest')
        shell_pid = self.shell()
        first.kill()
        first.wait(timeout=5)
        with sqlite3.connect(self.db) as connection:
            connection.execute("UPDATE issues SET lease_until=? WHERE id='task'", (time.time() - 10,))
        _, error = self.finished(self.start('--resume'), False)
        self.assertIn('busy', error)
        self.assertEqual(os.getpgid(shell_pid), shell_pid)
        self.assertEqual(self.marker('runs.txt'), 'r')
        self.assertEqual(self.call('show', id='task')['issue']['lease_epoch'], 1)
        self.assert_open()

    def test_killed_oracle_without_replay_permission_blocks(self):
        self.create(oracle='echo $$ > shell.pid; printf v >> verifies.txt; '
                           'while ! test -f release.oracle; do sleep .05; done',
                    replay_safe=True)
        first = self.start()
        worker = self.event(first, 'verify')['pid']
        shell_pid = self.shell()
        self.kill(worker)
        self.finished(first, False)
        os.killpg(shell_pid, signal.SIGKILL)
        self.shell_pids.discard(shell_pid)
        _, error = self.finished(self.start('--resume'), False)
        self.assertIn('recovery_required', error)
        self.assertEqual(self.marker('runs.txt'), 'r')
        self.assertEqual(self.marker('verifies.txt'), 'v')
        self.assert_open()

    def lost_committed_response(self, command):
        self.create()
        first = self.start(proxy=self.proxy(command))
        worker = self.event(first, command)['pid']
        self.wait_for((self.base / 'committed.json').exists, 'committed native response')
        committed = json.loads((self.base / 'committed.json').read_text())
        self.assertTrue(committed.get('passed') or committed.get('data', {}).get('passed'), committed)
        self.kill(worker)
        self.finished(first, False)
        self.finished(self.start('--resume'), True)
        self.assertEqual(self.marker('runs.txt'), 'r', 'committed work must not execute twice')
        self.assertEqual(self.marker('verifies.txt'), 'v', 'committed oracle must not execute twice')
        self.assertEqual(self.call('show', id='task')['issue']['status'], 'closed')

    def test_committed_run_response_loss_reuses_receipt(self):
        self.lost_committed_response('attest')

    def test_committed_verify_response_loss_reuses_receipt(self):
        self.lost_committed_response('verify')

    def drift_after_run(self, field):
        self.create()
        first = self.start(proxy=self.proxy('checkpoint', 'run_passed'))
        self.wait_for((self.base / 'committed.json').exists, 'run checkpoint barrier')
        shown = self.call('show', id='task')['issue']
        changed = json.loads(json.dumps(self.meta))
        if field == 'command':
            changed['execution']['cmd'] = 'printf BAD >> runs.txt'
        else:
            changed['local_zero'] = False
        self.call('admin_update', id='task', actor='worker', epoch=shown['lease_epoch'],
                  admin_token=self.env['SIS_ADMIN_TOKEN'], meta=changed,
                  reason='Private fixture: inject policy drift between stages')
        (self.base / 'release.proxy').touch()
        _, error = self.finished(first, False)
        self.assertTrue('recovery_required' in error or 'cost_authorization_required' in error, error)
        self.assertEqual(self.marker('runs.txt'), 'r')
        self.assertEqual(self.marker('verifies.txt'), '', 'policy drift must stop before oracle')
        self.assert_open()

    def test_command_drift_between_run_and_verify_blocks(self):
        self.drift_after_run('command')

    def test_policy_drift_between_run_and_verify_blocks(self):
        self.drift_after_run('policy')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin', default=BIN)
    parser.add_argument('--impl', choices=['rs', 'py'], default='rs')
    parser.add_argument('--case')
    options = parser.parse_args()
    BIN, IMPL = str(Path(options.bin).resolve()), options.impl
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(RecoveryEdges)
    if options.case:
        suite = unittest.TestSuite(test for test in suite if options.case in test.id())
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
