#!/usr/bin/env python3
"""Exercise the full local workflow, including deliberately killed workers."""
import argparse
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
BIN = str(ROOT / 'bin/sis')
IMPL = 'rs'


class Controller(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sis-controller-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.work = self.base / 'job'
        self.work.mkdir()
        (self.work / 'input.txt').write_text('accepted\n')
        self.db = self.base / 'state.db'
        self.env = dict(os.environ, SIS_IMPL=IMPL)
        for key in ['SIS_DB', 'SIS_SOCK', 'SIS_HTTP', 'SIS_ADMIN_TOKEN']:
            self.env.pop(key, None)

    def call(self, cmd, **args):
        p = subprocess.run([BIN, cmd, json.dumps(args), '--db', str(self.db)],
                           cwd=self.work, env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    def create(self, **extra):
        args = dict(id='task', title='Local workflow fixture', owner='worker', budget_eur=0,
                    oracle_cmd='test "$(cat result.txt)" = accepted',
                    allowed_paths=[str(self.work / 'input.txt')],
                    meta={'local_zero': True, 'budget_gate': True,
                          'execution': {'cmd': 'printf accepted > result.txt',
                                        'cwd': str(self.work), 'replay_safe': True}})
        args.update(extra)
        return self.call('create', **args)

    def command(self, *extra):
        return [BIN, 'run', '--db', str(self.db), '--issue', 'task', '--actor', 'worker',
                '--timeout', '5', *extra]

    def run_task(self, *extra):
        return subprocess.run(self.command(*extra), cwd=self.base, env=self.env,
                              capture_output=True, text=True, timeout=20)

    def start_worker(self):
        p = subprocess.Popen(self.command(), cwd=self.base, env=self.env,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.stop, p)
        return p

    @staticmethod
    def stop(p):
        if p.poll() is None:
            p.kill()
            p.wait(timeout=5)
        if p.stdout:
            p.stdout.close()
        if p.stderr:
            p.stderr.close()

    def event(self, process, expected):
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        self.addCleanup(selector.close)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if selector.select(.1):
                line = process.stdout.readline()
                if not line:
                    break
                event = json.loads(line)
                if event.get('event') == expected:
                    return event
        self.fail(f'{expected} not observed; rc={process.poll()}')

    def test_complete_task_has_run_proof_and_closed_readback(self):
        self.create()
        p = self.run_task()
        self.assertEqual(p.returncode, 0, p.stderr)
        shown = self.call('show', id='task')
        self.assertEqual(shown['issue']['status'], 'closed')
        self.assertTrue(any(a['kind'] == 'run' and a['passed'] for a in shown['attests']))
        self.assertTrue(any(e['op'] == 'verify' and e['data']['passed'] for e in shown['events_tail']))
        self.assertEqual((self.work / 'result.txt').read_text(), 'accepted')

    def test_failed_run_never_verifies_or_closes(self):
        self.create(meta={'local_zero': True, 'execution': {
            'cmd': 'exit 7', 'cwd': str(self.work), 'replay_safe': True}})
        self.assertNotEqual(self.run_task().returncode, 0)
        shown = self.call('show', id='task')
        self.assertNotEqual(shown['issue']['status'], 'closed')
        self.assertFalse(any(e['op'] == 'verify' for e in shown['events_tail']))

    def test_failed_oracle_never_closes(self):
        self.create(oracle_cmd='exit 9')
        self.assertNotEqual(self.run_task().returncode, 0)
        self.assertNotEqual(self.call('show', id='task')['issue']['status'], 'closed')

    def test_unknown_cost_or_foreign_owner_rejected_before_claim(self):
        self.create(budget_eur=None)
        self.assertNotEqual(self.run_task().returncode, 0)
        self.assertEqual(self.call('show', id='task')['issue']['lease_epoch'], 0)
        self.db = self.base / 'other.db'
        self.create(owner='someone-else')
        self.assertNotEqual(self.run_task().returncode, 0)
        self.assertEqual(self.call('show', id='task')['issue']['lease_epoch'], 0)

    def test_duplicate_controller_cannot_execute_same_job(self):
        self.create(meta={'local_zero': True, 'execution': {
            'cmd': 'printf x >> effects.txt; sleep 1; printf accepted > result.txt',
            'cwd': str(self.work), 'replay_safe': False}})
        first = self.start_worker()
        self.event(first, 'worker_started')
        second = self.run_task('--resume')
        self.assertNotEqual(second.returncode, 0, second.stdout)
        first.wait(timeout=10)
        self.assertEqual(first.returncode, 0)
        self.assertEqual((self.work / 'effects.txt').read_text(), 'x')

    def kill_execution(self, replay_safe):
        self.create(meta={'local_zero': True, 'execution': {
            'cmd': 'if ! test -f result.txt; then printf x >> effects.txt; printf accepted > result.txt; fi; sleep 1',
            'cwd': str(self.work), 'replay_safe': replay_safe}})
        controller = self.start_worker()
        event = self.event(controller, 'worker_started')
        deadline = time.monotonic() + 5
        while not (self.work / 'result.txt').exists() and time.monotonic() < deadline:
            time.sleep(.025)
        self.assertTrue((self.work / 'result.txt').exists())
        os.kill(event['pid'], signal.SIGKILL)
        controller.wait(timeout=10)
        self.assertNotEqual(controller.returncode, 0)
        time.sleep(1.1)

    def test_killed_worker_resumes_replay_safe_task(self):
        self.kill_execution(True)
        p = self.run_task('--resume')
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.call('show', id='task')['issue']['status'], 'closed')
        self.assertEqual((self.work / 'effects.txt').read_text(), 'x')

    def test_killed_worker_blocks_uncertain_nonreplayable_task(self):
        self.kill_execution(False)
        p = self.run_task('--resume')
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('recovery_required', p.stderr)
        self.assertEqual((self.work / 'effects.txt').read_text(), 'x')
        self.assertNotEqual(self.call('show', id='task')['issue']['status'], 'closed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--bin', default=BIN)
    parser.add_argument('--impl', choices=['rs', 'py'], default='rs')
    parser.add_argument('--case')
    args = parser.parse_args()
    BIN, IMPL = args.bin, args.impl
    tests = unittest.defaultTestLoader.loadTestsFromTestCase(Controller)
    if args.case:
        tests = unittest.TestSuite(t for t in tests if args.case in t.id())
    result = unittest.TextTestRunner(verbosity=2).run(tests)
    raise SystemExit(not result.wasSuccessful())
