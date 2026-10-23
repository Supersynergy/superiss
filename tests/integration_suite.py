#!/usr/bin/env python3
"""Exercise installed-style CLI, socket, MCP, HTTP, restart and bounded failures."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
IMPL = "rs"
BIN = str(ROOT / "bin/sis")


class Integration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sis-v06-integration-")
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name).resolve()
        self.db = self.work / "project.db"
        self.sock = "/tmp/sis-test-" + secrets.token_hex(8) + ".sock"
        self.env = dict(os.environ, SIS_IMPL=IMPL, SIS_DB=str(self.db), SIS_SOCK=self.sock)
        self.env['SIS_ADMIN_TOKEN'] = 'synthetic-integration-admin'
        with socket.socket() as port:
            port.bind(("127.0.0.1", 0)); self.port = port.getsockname()[1]
        self.env["SIS_HTTP"] = str(self.port)
        self.log = open(self.work / "serve.log", "wb")
        self.proc = None
        self.addCleanup(self.stop)
        self.start()

    def start(self):
        self.proc = subprocess.Popen([BIN, "serve", "--db", str(self.db)], env=self.env,
            cwd=self.work, stdout=self.log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                self.fail((self.work / "serve.log").read_text())
            try:
                self.rpc("stats"); return
            except (OSError, ValueError):
                time.sleep(0.025)
        self.fail("Owned Superiss daemon did not become ready:\n" +
                  (self.work / "serve.log").read_text())

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(3)
            except subprocess.TimeoutExpired:
                self.proc.kill(); self.proc.wait(3)
        self.log.close()
        for suffix in ["", ".pid", ".lock"]:
            try:
                os.unlink(self.sock + suffix)
            except FileNotFoundError:
                pass

    def rpc(self, cmd, args=None):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(5); client.connect(self.sock)
            client.sendall((json.dumps({"cmd": cmd, "args": args or {}}) + "\n").encode())
            with client.makefile("rb") as reader:
                return json.loads(reader.readline())

    def call(self, cmd, **args):
        r = self.rpc(cmd, args); self.assertTrue(r["ok"], r); return r["data"]

    def mcp(self, bridge=False, method="tools/list", params=None, env=None):
        command = ["node", str(ROOT / "mcp/sis-mcp.js")] if bridge else [BIN, "mcp", "--db", str(self.db)]
        request = {"jsonrpc": "2.0", "id": 1, "method": method}
        if params is not None:
            request["params"] = params
        p = subprocess.run(command, input=json.dumps(request) + "\n", text=True,
            capture_output=True, env=env or self.env, cwd=self.work, timeout=10)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout.strip().splitlines()[-1])

    def test_native_and_bridge_have_same_typed_operations(self):
        wanted = {"sis_" + op["name"]: op for op in json.loads((ROOT / "ops.json").read_text())["ops"]}
        for bridge in [False, True]:
            result = self.mcp(bridge)["result"]["tools"]
            self.assertEqual({tool["name"] for tool in result}, set(wanted))
            for tool in result:
                self.assertEqual(tool["inputSchema"], wanted[tool["name"]]["inputSchema"])
                self.assertTrue(tool["description"])

    def test_mcp_bridge_reaches_same_project(self):
        result = self.mcp(True, "tools/call", {"name": "sis_context", "arguments": {}})["result"]
        self.assertFalse(result.get("isError", False), result)
        context = json.loads(result["content"][0]["text"])
        self.assertTrue(context["ok"])
        self.assertEqual(context["data"]["project_id"], self.call("context")["project_id"])

    def test_mcp_rejects_database_socket_mismatch_before_mutation(self):
        other = self.work / "other.db"
        other.touch()
        env = dict(self.env, SIS_DB=str(other))
        result = self.mcp(True, "tools/call", {"name": "sis_create", "arguments": {"title": "Wrong project"}}, env)["result"]
        self.assertTrue(result["isError"], result)
        self.assertIn("identity mismatch", result["content"][0]["text"])
        self.assertEqual(self.call("stats")["total"], 0)

    def test_agent_profile_reduces_advertised_schema(self):
        env = dict(self.env, SIS_MCP_PROFILE="agent")
        full = self.mcp(True)["result"]["tools"]
        brief = self.mcp(True, env=env)["result"]["tools"]
        self.assertEqual(brief, self.mcp(False, env=env)["result"]["tools"])
        names = {tool["name"] for tool in brief}
        self.assertIn("sis_acquire", names); self.assertIn("sis_verify", names)
        self.assertNotIn("sis_admin_update", names)
        self.assertLess(len(json.dumps(brief)), len(json.dumps(full)))

    def test_multiworker_bundled_native_needs_no_cargo(self) -> None:
        bundled = self.work / 'installed' / 'bin'
        bundled.mkdir(parents=True)
        shutil.copy2(ROOT / 'bin/sis', bundled / 'sis')
        shutil.copy2(ROOT / '.cache/cargo/debug/superiss', bundled / 'superiss-native')
        environment = dict(self.env, SIS_IMPL='rs', PATH='/usr/bin:/bin')
        environment.pop('SIS_SOCK', None)
        environment.pop('SIS_HTTP', None)
        result = subprocess.run(['/bin/bash', str(bundled / 'sis'), 'context', '--db',
                                 str(self.work / 'installed.db')], env=environment,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        context = json.loads(result.stdout)
        self.assertEqual(context['capabilities']['version'], '0.9.0')
        self.assertEqual(context['capabilities']['schema_version'], 8)

    def test_multiworker_cli_refuses_older_daemon_before_mutation(self) -> None:
        legacy = self.sock + '-old'
        identity = self.rpc('context')
        identity['data']['capabilities']['schema_version'] = 7
        received = []
        with socket.socket(socket.AF_UNIX) as listener:
            listener.settimeout(5)
            listener.bind(legacy)
            listener.listen(1)

            def respond() -> None:
                with listener.accept()[0] as connection:
                    connection.settimeout(5)
                    with connection.makefile('rb') as reader:
                        received.append(json.loads(reader.readline()))
                        connection.sendall((json.dumps(identity) + '\n').encode())
                        extra = reader.readline()
                        if extra:
                            received.append(json.loads(extra))

            responder = threading.Thread(target=respond)
            responder.start()
            try:
                result = subprocess.run([BIN, 'create', '{"id":"forbidden","title":"must not run"}',
                                         '--db', str(self.db)], env=dict(self.env, SIS_SOCK=legacy, SIS_IMPL='rs'),
                                        capture_output=True, text=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('daemon schema differs', result.stdout + result.stderr)
            finally:
                responder.join(timeout=5)
                Path(legacy).unlink(missing_ok=True)
        self.assertFalse(responder.is_alive())
        self.assertEqual([request['cmd'] for request in received], ['context'])
        self.assertEqual(self.call('stats')['total'], 0)

    def test_local_zero_cli_refuses_daemon_without_execution_guard(self) -> None:
        legacy = self.sock + '-unguarded'
        identity = self.rpc('context')
        identity['data']['capabilities'].pop('local_zero_execution', None)
        received = []
        with socket.socket(socket.AF_UNIX) as listener:
            listener.settimeout(5)
            listener.bind(legacy)
            listener.listen(1)

            def respond() -> None:
                with listener.accept()[0] as connection:
                    connection.settimeout(5)
                    with connection.makefile('rb') as reader:
                        received.append(json.loads(reader.readline()))
                        connection.sendall((json.dumps(identity) + '\n').encode())
                        extra = reader.readline()
                        if extra:
                            received.append(json.loads(extra))
                            connection.sendall(b'{"ok":true,"data":{}}\n')

            responder = threading.Thread(target=respond)
            responder.start()
            try:
                result = subprocess.run([BIN, 'verify', '{"id":"must-not-execute"}', '--db', str(self.db)],
                    env=dict(self.env, SIS_SOCK=legacy, SIS_IMPL='rs'), capture_output=True, text=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('daemon execution policy differs', result.stdout + result.stderr)
            finally:
                responder.join(timeout=5)
                Path(legacy).unlink(missing_ok=True)
        self.assertFalse(responder.is_alive())
        self.assertEqual([request['cmd'] for request in received], ['context'])

    def test_multiworker_agent_profile_blocks_unadvertised_calls(self) -> None:
        env = dict(self.env, SIS_MCP_PROFILE='agent')
        for bridge in (False, True):
            reply = self.mcp(bridge, 'tools/call', {
                'name': 'sis_create', 'arguments': {'id': 'hidden', 'title': 'must not run'}}, env)
            self.assertEqual(reply['error']['code'], -32602, reply)
        self.assertEqual(self.call('stats')['total'], 0)

    def test_multiworker_runner_rejects_invalid_db_before_launch(self) -> None:
        import shlex

        missing = self.work / 'missing-runner.db'
        marker = self.work / 'runner-sis-invoked'
        fake = self.work / 'unexpected-sis'
        fake.write_text("#!/bin/sh\nprintf called > " + shlex.quote(str(marker)) +
                        "\nprintf '%s\\n' '{\"jobs\":[]}'\n")
        fake.chmod(0o755)
        for invalid in (missing, self.work):
            with self.subTest(db=str(invalid)):
                result = subprocess.run([str(ROOT / 'tools/sis-runner.sh'), '--once',
                                         '--db', str(invalid), '--sis', str(fake)],
                                        env=self.env, cwd=self.work, capture_output=True,
                                        text=True, timeout=10)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertFalse(marker.exists(), 'invalid DB must not launch the CLI')
                self.assertFalse(missing.exists(), 'invalid DB must not create a store')

    def test_multiworker_runner_executes_once_under_competition(self) -> None:
        (self.work / 'input.txt').write_text('unchanged')
        self.call('create', id='autorun', title='runner test', oracle_cmd='test -s input.txt',
                  allowed_paths=['input.txt'], meta={'autorun': {
                      'cmd': 'printf run >> runs.txt', 'cwd': str(self.work)}})
        self.call('claim', id='autorun', actor='builder', ttl=300)
        command = [str(ROOT / 'tools/sis-runner.sh'), '--db', str(self.db), '--once']
        runners = [subprocess.Popen(command + ['--actor', actor], env=self.env, cwd=self.work,
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                   for actor in ('runner-a', 'runner-b')]
        for runner in runners:
            stdout, stderr = runner.communicate(timeout=15)
            self.assertEqual(runner.returncode, 0, stderr + stdout)
        self.assertEqual((self.work / 'runs.txt').read_text(), 'run')
        done = self.call('outbox_list', state='done')
        self.assertEqual(len(done), 1)
        self.assertEqual(done[0]['attempts'], 1)
        self.assertEqual(self.call('stats')['closed'], 0, 'attest must not auto-close an issue')

    def test_multiworker_runner_failure_is_not_successful_delivery(self) -> None:
        (self.work / 'input.txt').write_text('unchanged')
        self.call('create', id='autorun', title='runner failure', oracle_cmd='test -s input.txt',
                  allowed_paths=['input.txt'], meta={'autorun': {
                      'cmd': 'exit 7', 'cwd': str(self.work)}})
        self.call('claim', id='autorun', actor='builder', ttl=300)
        result = subprocess.run([str(ROOT / 'tools/sis-runner.sh'), '--db', str(self.db), '--once'],
                                env=self.env, cwd=self.work, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
        self.assertEqual(len(self.call('outbox_list', state='failed')), 1)
        self.assertEqual(self.call('outbox_list', state='done'), [])

    def test_socket_permissions_and_invalid_frames(self):
        self.assertEqual(stat.S_IMODE(os.stat(self.sock).st_mode), 0o600)
        for payload in [b"null\n", b"{broken\n"]:
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(3); client.connect(self.sock); client.sendall(payload)
                with client.makefile("rb") as reader:
                    reply = json.loads(reader.readline())
                self.assertFalse(reply["ok"])
        self.assertTrue(self.rpc("stats")["ok"])

    def test_utf8_split_frames_and_pipeline(self):
        title = "Überprüfung 日本語 العربية 👩‍💻"
        request = (json.dumps({"cmd": "create", "args": {"id": "unicode", "title": title}}, ensure_ascii=False) + "\n").encode()
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(3); client.connect(self.sock)
            for index in range(0, len(request), 3):
                client.sendall(request[index:index + 3])
            with client.makefile("rb") as reader:
                self.assertTrue(json.loads(reader.readline())["ok"])
                client.sendall(b'{"cmd":"show","args":{"id":"unicode"}}\n{"cmd":"stats","args":{}}\n')
                self.assertEqual(json.loads(reader.readline())["data"]["issue"]["title"], title)
                self.assertEqual(json.loads(reader.readline())["data"]["total"], 1)

    def test_http_health_board_and_context(self):
        base = f"http://127.0.0.1:{self.port}"
        deadline = time.monotonic() + 3
        while True:
            try:
                with urllib.request.urlopen(base + "/health", timeout=2) as response:
                    self.assertEqual(response.status, 200)
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.025)
        for route in ["/", "/board"]:
            with urllib.request.urlopen(base + route, timeout=2) as response:
                self.assertEqual(response.status, 200); self.assertTrue(response.read())
        request = urllib.request.Request(base + "/", data=b'{"cmd":"context","args":{}}', headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=3) as response:
            reply = json.load(response)
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["data"]["project_id"], self.call("context")["project_id"])

    def test_board_agent_attribution(self):
        # Run the shipped board script with a minimal DOM, without extra dependencies.
        script = r'''
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const html = fs.readFileSync(process.argv[1], 'utf8');
const nodes = Object.fromEntries(['stats','goals','q','rows','stamp'].map(k => [k, {innerHTML:'',value:''}]));
const context = vm.createContext({document:{getElementById:k=>nodes[k]}, Date,
  fetch:()=>new Promise(()=>{}), setInterval:()=>{}});
vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
vm.runInContext(`D={issues:[{id:'task',title:'Implement feature',status:'in_progress',priority:1,
  owner:'controller',claim_actor:'worker<&>',lane:'backend',lease_epoch:7,lease_until:Date.now()/1000+60,
  changes:[{path:'src/app.rs',adds:12,dels:3,status:'M',hunks:[[40,58],[80,81]]}]}]};render()`, context);
assert.match(nodes.rows.innerHTML, /Agent: worker&lt;&amp;&gt;/);
assert.match(nodes.rows.innerHTML, /Controller: controller/);
assert.match(nodes.rows.innerHTML, /Lane: backend/);
assert.match(nodes.rows.innerHTML, /Claim #7/);
assert.match(nodes.rows.innerHTML, /active/);
assert.match(nodes.rows.innerHTML, /history/);
assert.match(nodes.rows.innerHTML, /src\/app\.rs/);
assert.match(nodes.rows.innerHTML, /\+12/);
assert.match(nodes.rows.innerHTML, /@40–58,80–81/);
nodes.q.value='app.rs'; vm.runInContext('render()', context); assert.match(nodes.rows.innerHTML, /Implement feature/);
for (const term of ['worker<&>', 'controller', 'backend']) {
  nodes.q.value=term; vm.runInContext('render()', context); assert.match(nodes.rows.innerHTML, /Implement feature/);
}
nodes.q.value='unknown'; vm.runInContext('render()', context); assert.equal(nodes.rows.innerHTML, '');
nodes.q.value='';
vm.runInContext('D.issues[0].lease_until=1;render()', context);
assert.match(nodes.rows.innerHTML, /expired/);
vm.runInContext("D.issues[0].claim_actor=null;D.issues[0].status='closed';D.issues[0].owner=null;D.issues[0].meta={controller:'meta-controller'};render()", context);
assert.match(nodes.rows.innerHTML, /Controller: meta-controller/);
assert.match(nodes.rows.innerHTML, /Agent: unassigned/);
assert.doesNotMatch(nodes.rows.innerHTML, /active|expired/);
'''
        result = subprocess.run(['node', '-e', script, str(ROOT / 'web/board.html')],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        import urllib.parse
        source = self.work / 'input.txt'
        source.write_text('agent fixture')
        self.call('create', id='agent-trace', title='Agent trace', owner='controller',
                  oracle_cmd='test -s input.txt', allowed_paths=[str(source)],
                  acceptance='Fixture exists')
        claim = self.call('claim', id='agent-trace', actor='worker', ttl=60)
        self.call('unclaim', id='agent-trace', actor='worker', epoch=claim['epoch'])
        query = urllib.parse.urlencode({'q': json.dumps({'cmd':'history','args':{'id':'agent-trace'}})})
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/op?{query}', timeout=3) as response:
            history = json.load(response)
        self.assertTrue(history['ok'], history)
        self.assertTrue(any(event['actor'] == 'worker' and event['op'] == 'claim'
                            for event in history['data']), history)

    def test_changes_op_records_compact_git_diff(self):
        # `sis changes` computes a compact per-file summary (path, +/-,
        # hunk ranges) caller-side from the real worktree and stores it as
        # an append-only event; `list` then emits it for the board.
        git = shutil.which("git")
        if not git:
            self.skipTest("git unavailable")
        repo = self.work / "repo"
        repo.mkdir()
        genv = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
                    GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
        subprocess.run([git, "init", "-q"], cwd=repo, check=True)
        source = repo / "a.rs"
        source.write_text("one\ntwo\nthree\n")
        subprocess.run([git, "add", "."], cwd=repo, check=True)
        subprocess.run([git, "commit", "-qm", "base"], cwd=repo, env=genv, check=True)
        source.write_text("one\nTWO\nthree\nfour\n")
        (repo / "new.rs").write_text("x\ny\n")
        # untracked directory (the production `.sis/` DB layout): porcelain
        # reports "?? .sis/" — it must be skipped, not scanned as a file
        (repo / ".sis").mkdir()
        (repo / ".sis" / "t.db").write_bytes(b"sqlite placeholder")

        self.call("create", id="chg-1", title="track edits",
                  oracle_cmd="test -f marker", allowed_paths=[str(repo)],
                  acceptance="summary stored")
        self.call("claim", id="chg-1", actor="worker", ttl=60)
        self.assertEqual(
            self.call("show", id="chg-1")["issue"]["run_state"], "claimed")
        p = subprocess.run(
            [BIN, "--db", str(self.db), "changes", "chg-1", "--repo", str(repo)],
            env=self.env, cwd=repo, capture_output=True, text=True, timeout=15)
        self.assertEqual(p.returncode, 0, p.stderr)
        data = json.loads(p.stdout)
        by_path = {f["path"]: f for f in data["files"]}
        self.assertEqual(by_path["a.rs"]["adds"], 2, data)
        self.assertEqual(by_path["a.rs"]["dels"], 1, data)
        self.assertEqual(by_path["a.rs"]["status"], "M")
        self.assertIn([2, 2], by_path["a.rs"]["hunks"])
        self.assertIn([4, 4], by_path["a.rs"]["hunks"])
        self.assertEqual(by_path["new.rs"]["status"], "A")
        self.assertEqual(by_path["new.rs"]["adds"], 2)
        self.assertNotIn(".sis", by_path, data)

        history = self.call("history", id="chg-1")
        changes = [e for e in history if e["op"] == "changes"]
        self.assertTrue(changes, history)
        self.assertEqual(changes[-1]["data"]["summary"], {"files": 2, "adds": 4, "dels": 1})
        self.assertTrue(changes[-1]["data"]["fingerprint"])
        listed = self.call("list", status="in_progress")
        self.assertIn("a.rs", [f["path"] for f in listed[0]["changes"]])
        shown = self.call("show", id="chg-1")
        self.assertIn("a.rs", [f["path"] for f in shown["issue"]["changes"]])
        self.assertEqual(shown["issue"]["run_state"], "evidence")

        # dedup: identical diff must not append another event
        n_events = len(changes)
        p = subprocess.run(
            [BIN, "--db", str(self.db), "changes", "chg-1", "--repo", str(repo)],
            env=self.env, cwd=repo, capture_output=True, text=True, timeout=15)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(json.loads(p.stdout)["unchanged"])
        history = self.call("history", id="chg-1")
        self.assertEqual(len([e for e in history if e["op"] == "changes"]), n_events)

        # --patch snapshots the bounded unified diff into the event
        p = subprocess.run(
            [BIN, "--db", str(self.db), "changes", "chg-1", "--repo", str(repo),
             "--patch"], env=self.env, cwd=repo,
            capture_output=True, text=True, timeout=15)
        self.assertEqual(p.returncode, 0, p.stderr)
        history = self.call("history", id="chg-1")
        with_patch = [e for e in history
                      if e["op"] == "changes" and e["data"].get("patch")]
        self.assertTrue(with_patch)
        self.assertIn("+TWO", with_patch[-1]["data"]["patch"])

        # deleted + renamed + binary files get honest statuses
        source2 = repo / "gone.rs"
        source2.write_text("x\n")
        (repo / "old.rs").write_text("y\nz\n")
        subprocess.run([git, "add", "."], cwd=repo, check=True)
        subprocess.run([git, "commit", "-qm", "more"], cwd=repo, env=genv, check=True)
        source2.unlink()
        subprocess.run([git, "mv", "old.rs", "newname.rs"], cwd=repo, check=True)
        (repo / "bin.dat").write_bytes(b"\x00\x01\x02")
        subprocess.run([git, "add", "bin.dat"], cwd=repo, check=True)
        p = subprocess.run(
            [BIN, "--db", str(self.db), "changes", "chg-1", "--repo", str(repo)],
            env=self.env, cwd=repo, capture_output=True, text=True, timeout=15)
        self.assertEqual(p.returncode, 0, p.stderr)
        by_path = {f["path"]: f for f in json.loads(p.stdout)["files"]}
        self.assertEqual(by_path["gone.rs"]["status"], "D")
        self.assertEqual(by_path["gone.rs"]["hunks"], [[1, 1]])
        self.assertEqual(by_path["newname.rs"]["status"], "R")
        self.assertEqual(by_path["newname.rs"]["renamed_from"], "old.rs")
        self.assertTrue(by_path["bin.dat"]["binary"])
        last = [e for e in self.call("history", id="chg-1")
                if e["op"] == "changes"][-1]
        self.assertEqual(last["data"]["head_subject"], "more")

        # explicit --files payload works without git (non-repo callers)
        p = subprocess.run(
            [BIN, "--db", str(self.db), "changes", "chg-1",
             "--files", '[{"path":"x.md","adds":5,"dels":2,"hunks":[[3,7]]}]',
             "--force"],
            env=self.env, cwd=self.work, capture_output=True, text=True,
            timeout=15)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(json.loads(p.stdout)["files"][0]["path"], "x.md")

        # `sis close` auto-records the diff even when the close itself is
        # refused (lease/proof fencing) — evidence is never blocked by it.
        p = subprocess.run([BIN, "--db", str(self.db), "close", "chg-1",
                            "--actor", "worker"],
                           env=self.env, cwd=repo, capture_output=True,
                           text=True, timeout=15)
        self.assertNotEqual(p.returncode, 0)
        history = self.call("history", id="chg-1")
        self.assertTrue(any(e["op"] == "changes" and e["actor"] == "worker"
                            for e in history), history)

        # `sis checkpoint` (agent handoff) auto-records the diff the same way,
        # and `resume`/`brief` hand the latest changes to the successor agent.
        # Touch the worktree first so the new diff beats fingerprint dedup.
        (repo / "ck.rs").write_text("z\n")
        shown = self.call("show", id="chg-1")
        epoch = shown["issue"]["lease_epoch"]
        n_changes = len([e for e in self.call("history", id="chg-1")
                         if e["op"] == "changes"])
        p = subprocess.run([BIN, "--db", str(self.db), "checkpoint", "chg-1",
                            "--actor", "worker", "--epoch", str(epoch),
                            "--text", "handoff: metade pronta",
                            "--next-step", "revisar rename"],
                           env=self.env, cwd=repo, capture_output=True,
                           text=True, timeout=15)
        self.assertEqual(p.returncode, 0, p.stderr)
        history = self.call("history", id="chg-1")
        self.assertGreater(
            len([e for e in history if e["op"] == "changes"]), n_changes)
        resumed = self.call("resume", id="chg-1")
        self.assertIn("newname.rs",
                      [f["path"] for f in resumed["changes"]["files"]])
        briefed = self.call("brief", id="chg-1")
        self.assertIn("changes", json.loads(briefed["text"]))

        # run_state reaches "verified" once the oracle proof lands — reuse
        # the live claim's epoch (still leased to "worker")
        epoch = self.call("show", id="chg-1")["issue"]["lease_epoch"]
        (repo / "marker").write_text("x\n")
        v = self.call("verify", id="chg-1", actor="worker",
                      epoch=epoch, cwd=str(repo))
        self.assertTrue(v["passed"], v)
        self.assertEqual(
            self.call("show", id="chg-1")["issue"]["run_state"], "verified")

        # `sis handoff` = checkpoint + lease release + directed marker, so a
        # successor can claim immediately instead of waiting out the TTL.
        p = subprocess.run([BIN, "--db", str(self.db), "handoff", "chg-1",
                            "--actor", "worker", "--epoch", str(epoch),
                            "--text", "bewiesen, bereit zur Abnahme",
                            "--next-step", "review + close",
                            "--to", "reviewer"],
                           env=self.env, cwd=repo, capture_output=True,
                           text=True, timeout=15)
        self.assertEqual(p.returncode, 0, p.stderr)
        shown = self.call("show", id="chg-1")
        self.assertEqual(shown["issue"]["status"], "open")
        self.assertIsNone(shown["issue"]["claim_actor"])
        ops = [e["op"] for e in self.call("history", id="chg-1")]
        self.assertEqual(ops[-3:], ["checkpoint", "unclaim", "handoff"])
        c2 = self.call("claim", id="chg-1", actor="worker-2")
        self.assertGreater(c2["epoch"], epoch)

        # `list` projects the same run_state batched (governor reconcile view)
        self.call("create", id="chg-2", title="untouched",
                  oracle_cmd="true", acceptance="none")
        listed = {r["id"]: r for r in self.call("list", status=None)}
        self.assertEqual(listed["chg-1"]["run_state"], "verified")
        self.assertEqual(listed["chg-2"]["run_state"], "queued")

        # non-repo path fails honestly instead of recording an empty claim
        p = subprocess.run([BIN, "--db", str(self.db), "changes", "chg-1",
                            "--repo", str(self.work)],
                           env=self.env, capture_output=True, text=True, timeout=15)
        self.assertEqual(p.returncode, 2)
        self.assertIn("not_a_git_repo", p.stderr)

        # `sis who` attributes each dirty path to the changes event (and
        # hence claim/actor) that produced it; never-recorded files are
        # explicitly orphaned instead of guessed at.
        (repo / "stray.tmp").write_text("?")
        p = subprocess.run([BIN, "--db", str(self.db), "who", "--repo", str(repo)],
                           env=self.env, cwd=repo, capture_output=True,
                           text=True, timeout=15)
        self.assertEqual(p.returncode, 0, p.stderr)
        who = json.loads(p.stdout)
        by_path = {d["path"]: d for d in who["dirty"]}
        self.assertIn("chg-1",
                      [c["issue"] for c in by_path["ck.rs"]["claims"]])
        self.assertEqual(by_path["ck.rs"]["claims"][0]["actor"], "worker")
        self.assertNotIn("a.rs", by_path, who)  # committed clean — not dirty
        self.assertEqual(by_path["stray.tmp"]["claims"], [])
        self.assertIn("stray.tmp", who["summary"]["orphaned"])
        self.assertEqual(who["summary"]["by_issue"][0]["issue"], "chg-1")
        self.assertEqual(who["summary"]["by_issue"][0]["files"],
                         who["summary"]["matched"])

        # contract-scope fallback: an open issue whose allowed_paths cover
        # a never-recorded file is a weaker (declared) attribution.
        self.call("create", id="chg-3", title="scoped lane",
                  oracle_cmd="true", allowed_paths=["scoped"], acceptance="a")
        (repo / "scoped").mkdir(exist_ok=True)
        (repo / "scoped" / "x.rs").write_text("s\n")
        who = json.loads(subprocess.run(
            [BIN, "--db", str(self.db), "who", "--repo", str(repo)],
            env=self.env, cwd=repo, capture_output=True, text=True,
            timeout=15).stdout)
        by_path = {d["path"]: d for d in who["dirty"]}
        scope_claims = by_path["scoped/x.rs"]["claims"]
        self.assertEqual(scope_claims[0]["issue"], "chg-3")
        self.assertEqual(scope_claims[0]["via"], "scope")

    def test_http_encoded_unicode_read_operation(self):
        import urllib.parse
        self.call('create', id='unicode-日本', title='Encoded read fixture')
        query = urllib.parse.urlencode({'q': json.dumps({'cmd':'show','args':{'id':'unicode-日本'}}, ensure_ascii=False)})
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/op?{query}', timeout=3) as response:
            result = json.load(response)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['data']['issue']['id'], 'unicode-日本')

    def test_lifecycle_owns_only_the_daemon_it_started(self):
        env = dict(self.env)
        env.pop('SIS_SOCK', None); env.pop('SIS_HTTP', None)
        db = self.work / 'managed.db'
        def action(name):
            proc = subprocess.run([BIN,name,'--db',str(db)], env=env, text=True, capture_output=True, timeout=15)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            return json.loads(proc.stdout)
        self.assertFalse(action('status')['up'])
        for _ in range(3):
            try:
                self.assertTrue(action('up')['up'])
                self.assertTrue(action('status')['up'])
                self.assertTrue(action('up')['already'])
            finally:
                self.assertTrue(action('down')['down'])
        self.assertFalse(action('status')['up'])

    def test_explicit_import_is_atomic_and_does_not_restore_live_claims(self):
        import sqlite3
        source = self.work / 'legacy-export.json'
        source.write_text(json.dumps([{'id':'history-done','title':'Done fixture','status':'closed'},
                                     {'id':'history-active','title':'Active fixture','status':'in_progress'}]))
        command = [sys.executable,str(ROOT/'tools/bd2sis.py'),str(source),'--apply','--db',str(self.db),'--sock',self.sock]
        first = subprocess.run(command,env=self.env,text=True,capture_output=True,timeout=10)
        self.assertEqual(first.returncode,0,first.stderr)
        repeat = subprocess.run(command,env=self.env,text=True,capture_output=True,timeout=10)
        self.assertEqual(repeat.returncode,0,repeat.stderr)
        self.assertEqual(self.call('show',id='history-active')['issue']['status'],'deferred')
        source.write_text(json.dumps([{'id':'must-rollback','title':'Rollback fixture'}, {'id':'history-done','title':'Conflict'}]))
        conflict = subprocess.run(command,env=self.env,text=True,capture_output=True,timeout=10)
        self.assertNotEqual(conflict.returncode,0)
        with sqlite3.connect(self.db) as observer:
            self.assertEqual(observer.execute("SELECT COUNT(*) FROM issues WHERE id='must-rollback'").fetchone()[0],0)
            self.assertEqual(observer.execute('SELECT COUNT(*) FROM claims').fetchone()[0],0)
            self.assertEqual(observer.execute('SELECT COUNT(*) FROM proofs').fetchone()[0],0)
            self.assertNotIn(self.env['SIS_ADMIN_TOKEN'],str(observer.execute('SELECT data_json FROM events').fetchall()))

    def test_acquire_with_explicit_id_never_claims_a_different_issue(self):
        # contract parity with the py impl and the sgg tool: `acquire {id}`
        # claims that issue or fails — silently claiming the next eligible
        # task would steal a foreign lease (dogfood finding).
        self.call("create", id="first-eligible", title="queue head",
                  oracle_cmd="true", allowed_paths=["."], acceptance="a")
        self.call("create", id="wanted", title="explicit target",
                  oracle_cmd="true", allowed_paths=["."], acceptance="a")
        got = self.call("acquire", id="wanted", actor="w", ttl=60)
        self.assertEqual(got["id"], "wanted")
        self.assertEqual(got["epoch"], 1)
        self.call("unclaim", id="wanted", actor="w", epoch=got["epoch"])
        # not claimable → refusal, never a claim on the eligible sibling
        self.call("create", id="blocked", title="depends on wanted",
                  oracle_cmd="true", allowed_paths=["."], acceptance="a")
        self.call("dep", issue="blocked", depends_on="wanted")
        with self.assertRaises(AssertionError):
            self.call("acquire", id="blocked", actor="w", ttl=60)
        self.assertEqual(self.call("show", id="first-eligible")["issue"]["claim_actor"],
                         None)

    def test_committed_events_wake_watch_and_preserve_cursor(self):
        self.call("remember", key="initial", value="baseline")
        events = self.call("watch", after=0)["events"]
        cursor = events[-1]["seq"]
        messages = []
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(3); client.connect(self.sock)
            client.sendall((json.dumps({"cmd": "watch", "args": {"after": cursor, "wait": 2}}) + "\n").encode())
            reader = client.makefile("rb")
            def read():
                try:
                    while len(messages) < 2:
                        line = reader.readline()
                        if not line:
                            break
                        messages.append(json.loads(line))
                        if messages[-1].get("data", {}).get("events"):
                            break
                except OSError:
                    pass
            waiter = threading.Thread(target=read); waiter.start()
            time.sleep(0.05)
            self.call("remember", key="wake", value="committed")
            waiter.join(2.5)
            self.assertFalse(waiter.is_alive())
            self.assertTrue(any(m.get("data", {}).get("events") for m in messages), messages)
            self.assertTrue(all(e["seq"] > cursor for m in messages for e in m.get("data", {}).get("events", [])))
            reader.close()

    def test_crash_restart_preserves_committed_state(self):
        identity = self.call("context")["project_id"]
        self.call("remember", key="checkpoint", value={"next_step": "verify"})
        self.proc.kill(); self.proc.wait(3)
        self.start()
        self.assertEqual(self.call("context")["project_id"], identity)
        self.assertIn("verify", json.dumps(self.call("recall", key="checkpoint")))

    def test_default_socket_handles_new_database_under_symlink_parent(self):
        actual = self.work / "actual"; actual.mkdir()
        alias = self.work / "alias"; alias.symlink_to(actual, target_is_directory=True)
        db = alias / "new.db"
        expected = "/tmp/sis-" + hashlib.sha256(str(actual / "new.db").encode()).hexdigest()[:20] + ".sock"
        previous = "/tmp/sis-" + hashlib.sha256(str(db).encode()).hexdigest()[:20] + ".sock"
        env = dict(self.env, SIS_DB=str(db)); env.pop("SIS_SOCK", None); env.pop("SIS_HTTP", None)
        process = subprocess.Popen([BIN, "serve", "--db", str(db)], env=env, cwd=self.work,
            stdout=self.log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 3
            while not os.path.exists(expected) and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.025)
            self.assertTrue(os.path.exists(expected), "default socket used an unresolved parent alias")
            reply = self.mcp(True, "tools/call", {"name": "sis_context", "arguments": {}}, env)["result"]
            self.assertFalse(reply.get("isError", False), reply)
        finally:
            process.terminate()
            try:
                process.wait(3)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(3)
            for socket_path in [expected, previous]:
                for suffix in ["", ".pid", ".lock"]:
                    try:
                        os.unlink(socket_path + suffix)
                    except FileNotFoundError:
                        pass


def main():
    global IMPL, BIN
    parser = argparse.ArgumentParser()
    parser.add_argument("--impl", choices=["rs", "py"], default="rs")
    parser.add_argument("--bin", default=str(ROOT / "bin/sis"))
    parser.add_argument("--case")
    args = parser.parse_args(); IMPL, BIN = args.impl, args.bin
    loader = unittest.TestLoader()
    if args.case:
        loader.testNamePatterns = [f"*{args.case}*"]
    result = unittest.TextTestRunner(verbosity=2).run(loader.loadTestsFromTestCase(Integration))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
