"""Superiss worker contracts, source-bound receipts and bounded local execution."""
import contextlib
import fcntl
from functools import lru_cache
import hashlib
import hmac
import http.server
import json
import math
import os
from pathlib import Path
import secrets
import selectors
import signal
import socketserver
import subprocess
import stat
import sys
import threading
import time
import urllib.parse

try:
    import tiktoken
except ImportError:
    tiktoken = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS outbox_leases(
 outbox_id INTEGER PRIMARY KEY, actor TEXT NOT NULL,
 epoch INTEGER NOT NULL, lease_until REAL NOT NULL);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(state,kind,id);
CREATE INDEX IF NOT EXISTS worker_candidates ON issues(priority,created_at,id) WHERE status IN ('open','deferred','in_progress');
CREATE INDEX IF NOT EXISTS issue_parent ON issues(json_extract(meta_json,'$.parent'));
CREATE INDEX IF NOT EXISTS evidence_window ON events(op,ts);
CREATE TABLE IF NOT EXISTS proofs(
 proof_id TEXT PRIMARY KEY, issue TEXT, actor TEXT, epoch INTEGER,
 revision TEXT, source_hash TEXT, cwd TEXT, oracle TEXT, exitcode INTEGER,
 passed INTEGER, timed_out INTEGER, output TEXT, review_receipt TEXT);
CREATE TABLE IF NOT EXISTS checkpoints(
 seq INTEGER PRIMARY KEY AUTOINCREMENT, issue TEXT, actor TEXT, epoch INTEGER,
 revision TEXT, source_hash TEXT, cwd TEXT, text TEXT, next_step TEXT,
 artifacts TEXT, ts REAL);
CREATE TABLE IF NOT EXISTS cancellations(
 issue TEXT PRIMARY KEY, requested INTEGER DEFAULT 0, actor TEXT, ts REAL);
CREATE TABLE IF NOT EXISTS agent_state(
 issue TEXT PRIMARY KEY, cancel_requested INTEGER DEFAULT 0,
 attempt INTEGER DEFAULT 0, last_error TEXT);
CREATE TABLE IF NOT EXISTS attests(
 attest_id TEXT PRIMARY KEY, issue TEXT, actor TEXT, epoch INTEGER,
 revision TEXT, source_hash TEXT, cwd TEXT, kind TEXT, payload TEXT,
 summary TEXT, passed INTEGER, ts REAL);
CREATE TABLE IF NOT EXISTS costs(
 id INTEGER PRIMARY KEY AUTOINCREMENT, issue TEXT, actor TEXT,
 run_id TEXT, wave TEXT, tokens_in INTEGER DEFAULT 0,
 tokens_out INTEGER DEFAULT 0, cents INTEGER DEFAULT 0,
 currency TEXT DEFAULT 'EUR', note TEXT, ts REAL);
"""

IGNORED = {'.git', '.sis', '.cache', 'target', '.venv', '__pycache__'}
MANDATORY = ('id', 'title', 'oracle_cmd', 'acceptance', 'allowed_paths',
             'owner', 'lane', 'dependencies', 'revision')
CONTRACT_FIELDS = ('id', 'title', 'desc', 'acceptance', 'oracle_cmd',
                   'allowed_paths', 'owner', 'lane', 'dependencies', 'budget_eur')
SECURITY_META = ('local_zero', 'execution', 'budget_gate', 'review_required', 'attest_required')
FRAME_MAX = 1024 * 1024
OUTPUT_MAX = 64 * 1024
EVENT_CONDITION = threading.Condition()
EVENT_GENERATION = 0
INSTANCE_ID = 'instance-' + secrets.token_hex(12)
AGENT_OPS = frozenset(('acquire', 'heartbeat', 'checkpoint', 'resume',
                      'verify', 'close', 'brief', 'context', 'capabilities',
                      'cancel', 'cancel_ack', 'tokens'))


@lru_cache(maxsize=1)
def operation_registry():
    return json.loads((Path(__file__).parent / 'ops.json').read_text())['ops']

BOARD_HTML = (Path(__file__).parent / 'web' / 'board.html').read_bytes()


def http_server(db_path, port, api, clients, stopping):
    """Bound loopback HTTP to the same database dispatcher as the Unix socket."""
    try:
        number = int(port)
        if str(number) != str(port) or not 1 <= number <= 65535:
            raise ValueError('port outside 1..65535')
    except (TypeError, ValueError):
        raise api['GqError']('bad_args', 'HTTP port must be an integer in 1..65535')

    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = 'Superiss/0.6'

        def setup(self):
            self.request.settimeout(5)
            super().setup()

        def log_message(self, *_):
            pass

        def send_json(self, result, status=None):
            body = json.dumps(result, separators=(',', ':'), ensure_ascii=False).encode()
            if len(body) > 4 * FRAME_MAX:
                status = 413
                body = b'{"ok":false,"error":{"code":"output_too_large","msg":"response exceeds 4 MiB; use fields and pagination"}}'
            self.send_response(status or (200 if result.get('ok') else 400))
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(body)

        def reject(self, code, message, status=400):
            self.send_json({'ok': False, 'error': {'code': code, 'msg': message}}, status)

        def parse_request(self):
            if not super().parse_request():
                return False
            if sum(len(k.encode()) + len(v.encode()) + 4 for k, v in self.headers.items()) > 16384:
                self.reject('frame_too_large', 'HTTP headers exceed 16 KiB', 431)
                return False
            host = self.headers.get('Host')
            if host not in (None, f'127.0.0.1:{number}', f'localhost:{number}'):
                self.reject('invalid_host', 'loopback Host required', 403)
                return False
            origin = self.headers.get('Origin')
            if origin is not None and origin not in (f'http://127.0.0.1:{number}', f'http://localhost:{number}'):
                self.reject('invalid_origin', 'same-origin loopback request required', 403)
                return False
            return True

        def operation(self, request):
            if not isinstance(request, dict):
                return {'ok': False, 'error': {'code': 'bad_cmd', 'msg': 'request not an object'}}
            db = api['connect'](db_path)
            try:
                return api['respond'](db, request, db_path)
            finally:
                db.close()

        def do_POST(self):
            if self.headers.get('Transfer-Encoding') is not None:
                self.reject('bad_args', 'chunked requests are unsupported')
                return
            lengths = self.headers.get_all('Content-Length', [])
            if len(lengths) != 1 or len(lengths[0]) > 7 or not lengths[0].isascii() or not lengths[0].isdecimal():
                self.reject('bad_args', 'one valid Content-Length required')
                return
            length = int(lengths[0])
            if length > FRAME_MAX:
                self.reject('frame_too_large', 'request exceeds 1 MiB', 413)
                return
            if self.headers.get_content_type() != 'application/json':
                self.reject('bad_args', 'Content-Type application/json required', 415)
                return
            try:
                body = self.rfile.read(length)
                if len(body) != length:
                    self.reject('bad_args', 'incomplete HTTP request body')
                    return
                request = json.loads(body)
            except (ValueError, UnicodeError):
                self.reject('bad_json', 'invalid JSON request')
                return
            except (TimeoutError, OSError):
                self.reject('timeout', 'HTTP request body timed out', 408)
                return
            self.send_json(self.operation(request))

        def do_GET(self):
            route = urllib.parse.urlsplit(self.path)
            if route.path in ('/', '/board.html'):
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(BOARD_HTML)))
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'")
                self.end_headers()
                self.wfile.write(BOARD_HTML)
                return
            if route.path == '/health':
                self.send_json({'ok': True, 'data': {'ok': True}})
                return
            db = api['connect'](db_path)
            try:
                if route.path == '/board':
                    context = {'db_path': db_path, 'actor': None, 'idem': None, 'run_id': None}
                    stats = api['dispatch_op'](db, 'stats', {}, context)
                    issues = api['dispatch_op'](db, 'list', {'limit': 1000}, context)
                    result = {'ok': True, 'data': {
                        'stats': stats, 'issues': issues,
                        'truncated': stats['total'] > len(issues)}}
                elif route.path == '/op':
                    query = urllib.parse.parse_qs(route.query, keep_blank_values=True)
                    try:
                        request = json.loads(query.get('q', ['{}'])[0])
                    except ValueError:
                        self.reject('bad_json', 'invalid operation JSON')
                        return
                    if not isinstance(request, dict) or request.get('cmd') not in {'goal_tree','context','capabilities','show','list','stats','ready','next','search','history'}:
                        self.reject('read_only', 'GET permits read operations only')
                        return
                    result = api['respond'](db, request, db_path)
                elif route.path == '/events':
                    query = urllib.parse.parse_qs(route.query, keep_blank_values=True)
                    try:
                        after = int(query.get('after', ['0'])[0])
                        wait = float(query.get('wait', ['0'])[0])
                        if after < 0 or not math.isfinite(wait) or not 0 <= wait <= 300:
                            raise ValueError('invalid event cursor/wait')
                    except (ValueError, OverflowError):
                        self.reject('bad_args', 'events require after>=0 and finite wait in 0..300')
                        return
                    deadline = time.monotonic() + wait
                    while True:
                        with EVENT_CONDITION:
                            serial = EVENT_GENERATION
                        result = api['respond'](db, {'cmd': 'watch', 'args': {'after': after, 'limit': 1000}}, db_path)
                        if not result.get('ok') or result['data']['events'] or stopping.is_set() or time.monotonic() >= deadline:
                            break
                        with EVENT_CONDITION:
                            EVENT_CONDITION.wait_for(lambda: EVENT_GENERATION != serial or stopping.is_set(), timeout=min(1, max(0, deadline - time.monotonic())))
                elif route.path == '/op':
                    query = urllib.parse.parse_qs(route.query)
                    try:
                        request = json.loads(query.get('q', ['{}'])[0])
                    except ValueError:
                        self.reject('bad_json', 'invalid operation JSON')
                        return
                    # Mutations require the JSON POST transport and its origin checks.
                    command = request.get('cmd') if isinstance(request, dict) else None
                    if not isinstance(command, str) or command.replace('-', '_') in api['MUT']:
                        self.reject('bad_args', 'mutations require POST')
                        return
                    result = self.operation(request)
                else:
                    self.reject('not_found', 'GET /health /board /events; POST JSON operations', 404)
                    return
                self.send_json(result)
            except api['GqError'] as exc:
                self.reject(exc.code, exc.msg)
            finally:
                db.close()

    class Server(http.server.ThreadingHTTPServer):
        daemon_threads = True
        request_queue_size = 64

        def server_bind(self):
            socketserver.TCPServer.server_bind(self)
            self.server_name = 'localhost'
            self.server_port = self.server_address[1]

        def process_request(self, request, address):
            if not clients.acquire(blocking=False):
                try:
                    request.settimeout(1)
                    body = b'{"ok":false,"error":{"code":"busy","msg":"client limit reached"}}'
                    request.sendall(b'HTTP/1.0 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
                finally:
                    self.shutdown_request(request)
                return
            try:
                super().process_request(request, address)
            except BaseException:
                clients.release()
                raise

        def process_request_thread(self, request, address):
            try:
                super().process_request_thread(request, address)
            finally:
                clients.release()

    return Server(('127.0.0.1', number), Handler)


@lru_cache(maxsize=2)
def cached_encoding(name):
    if tiktoken is None:
        return None
    cache = os.environ.get('TIKTOKEN_CACHE_DIR') or str(Path(__file__).parent / '.cache' / 'tiktoken')
    url = f'https://openaipublic.blob.core.windows.net/encodings/{name}.tiktoken'
    entry = Path(cache) / hashlib.sha1(url.encode()).hexdigest()
    hashes = {'o200k_base': '446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d',
              'cl100k_base': '223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7'}
    try:
        if hashlib.sha256(entry.read_bytes()).hexdigest() != hashes[name]:
            return None
        os.environ['TIKTOKEN_CACHE_DIR'] = cache
        return tiktoken.get_encoding(name)
    except (OSError, ValueError):
        return None


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False, allow_nan=False)


def controller_lock_fds():
    value = os.environ.get('SIS_CONTROLLER_LOCK_FD')
    if value is None:
        return ()
    if not value.isdecimal() or int(value) < 3:
        raise ValueError('SIS_CONTROLLER_LOCK_FD must be an open regular-file descriptor >=3')
    fd = int(value)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        raise ValueError('SIS_CONTROLLER_LOCK_FD must reference a regular lock file')
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return (fd,)


def execution_evidence(local_zero):
    return ({'mode': 'local_zero', 'sandbox': 'macos-seatbelt',
             'network': 'denied', 'ipc': 'denied', 'writes': 'cwd',
             'credential_environment': 'cleared'} if local_zero else None)


def run_oracle(command, cwd, duration, local_zero=False):
    # this-process binding knobs must not leak into oracle children:
    # a nested `sis`/test would otherwise hit the daemon's own socket
    env = {k: v for k, v in os.environ.items() if k not in (
        'SIS_ADMIN_TOKEN', 'SIS_SOCK', 'SIS_DIRECT', 'SIS_DB', 'SIS_CWD_DB')}
    pass_fds = controller_lock_fds()
    if local_zero:
        quoted = json.dumps(str(cwd), ensure_ascii=False)
        profile = ('(version 1) (deny default) '
                   '(allow process-fork process-exec sysctl-read file-read*) '
                   '(deny syscall-unix (syscall-number 147)) '
                   '(deny syscall-unix (syscall-number 82)) '
                   '(deny syscall-unix (syscall-number 244)) '
                   f'(allow file-write* (subpath {quoted})) '
                   '(deny file-read* (require-all '
                   '(require-any (subpath "/Users") (subpath "/private/var/root")) '
                   f'(require-not (subpath {quoted}))))')
        command = ['/usr/bin/sandbox-exec', '-p', profile, '/bin/sh', '-c', command]
        env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(cwd),
               'TMPDIR': str(cwd), 'LANG': 'C', 'LC_ALL': 'C'}
    process = subprocess.Popen(command, cwd=cwd, shell=not local_zero, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, start_new_session=True, env=env,
                               pass_fds=pass_fds)
    output, timed_out = bytearray(), False
    selector = selectors.DefaultSelector()
    os.set_blocking(process.stdout.fileno(), False)
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + duration
    group_stopped = False

    def stop_group():
        nonlocal group_stopped
        if not group_stopped:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            group_stopped = True

    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                stop_group()
                break
            for key, _ in selector.select(min(remaining, .1)):
                block = os.read(key.fileobj.fileno(), 65536)
                if not block:
                    selector.unregister(key.fileobj)
                elif len(output) < OUTPUT_MAX:
                    output.extend(block[:OUTPUT_MAX - len(output)])
        if process.poll() is None and not timed_out:
            remaining = deadline - time.monotonic()
            try:
                process.wait(timeout=max(.001, remaining))
            except subprocess.TimeoutExpired:
                timed_out = True
                stop_group()
        process.wait(timeout=2)
    finally:
        selector.close()
        process.stdout.close()
        if local_zero:
            stop_group()
        if process.poll() is None:
            stop_group()
            process.wait(timeout=2)
    return process.returncode, timed_out, output.decode('utf-8', errors='replace')


def install(s):
    """Bind worker operations to the existing store and retain its legacy API."""
    E, tx, issue, ev = s['GqError'], s['tx'], s['_issue'], s['ev']
    _git = s['_git']
    original = {name: s[name] for name in ('connect', 'op_create', 'op_update',
        'op_import', 'op_budget_claim', 'op_slot_acquire', 'op_show', 'op_goal',
        'op_sub', 'op_ready', 'op_list', 'op_next', 'op_reclaim')}

    def fail(code, msg=''):
        raise E(code, msg)

    def integer(v, name, minimum=0, maximum=None):
        if isinstance(v, str) and v.isdecimal():
            v = int(v)
        if isinstance(v, bool) or not isinstance(v, int) or v < minimum or (
                maximum is not None and v > maximum):
            fail('bad_args', f'{name} must be an integer in {minimum}..{maximum}')
        return v

    def finite(v, name, minimum=0, maximum=None):
        if isinstance(v, bool):
            fail('bad_args', f'{name} must be finite')
        try:
            n = float(v)
        except (TypeError, ValueError, OverflowError):
            fail('bad_args', f'{name} must be finite')
        if not math.isfinite(n) or n < minimum or (maximum is not None and n > maximum):
            fail('bad_args', f'{name} must be finite in {minimum}..{maximum}')
        return n

    def actor(a, c):
        value = a.get('actor', c.get('actor') if c.get('_actor_explicit') else None)
        if not isinstance(value, str) or not value.strip() or len(value) > 128:
            fail('bad_args', 'actor must be nonempty and at most 128 characters')
        return value

    def ttl(a):
        return finite(a.get('ttl', s['LEASE_S']), 'ttl', 1, 86400)

    def epoch(a):
        return integer(a.get('epoch'), 'epoch')

    def meta(row):
        try:
            value = json.loads(row.get('meta_json') or '{}')
        except (TypeError, ValueError):
            fail('bad_args', 'meta must be a JSON object')
        if not isinstance(value, dict):
            fail('bad_args', 'meta must be a JSON object')
        return value

    def paths(row):
        value = row.get('allowed_paths')
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                value = [value]
        if value is None:
            return []
        if not isinstance(value, list) or any(not isinstance(p, str) or not p for p in value):
            fail('bad_args', 'allowed_paths must be a string array')
        return value

    def connect(path):
        db = original['connect'](path)
        db.execute('PRAGMA synchronous=' + ('NORMAL' if os.environ.get('SIS_SYNCHRONOUS') == 'NORMAL' else 'FULL'))
        fts_columns = {r[1] for r in db.execute('PRAGMA table_info(issues_fts)')}
        if 'id' in fts_columns or not fts_columns:
            db.executescript("BEGIN IMMEDIATE; DROP TRIGGER IF EXISTS issues_fts_ai; DROP TRIGGER IF EXISTS issues_fts_ad; DROP TRIGGER IF EXISTS issues_fts_au; DROP TABLE IF EXISTS issues_fts;" + s['FTS_SCHEMA'] + "INSERT INTO issues_fts(issues_fts) VALUES('rebuild'); COMMIT;")
        if db.execute('PRAGMA user_version').fetchone()[0] == 8:
            return db
        columns = {r[1] for r in db.execute('PRAGMA table_info(checkpoints)')}
        if 'id' in columns:
            db.execute('ALTER TABLE checkpoints RENAME COLUMN id TO seq')
        if 'created_at' in columns:
            db.execute('ALTER TABLE checkpoints RENAME COLUMN created_at TO ts')
        db.executescript(SCHEMA)
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='receipts'").fetchone():
            db.execute('INSERT OR IGNORE INTO proofs SELECT proof_id,issue,actor,epoch,revision,source_hash,cwd,oracle,exitcode,passed,timed_out,output,review_receipt FROM receipts')
        db.execute("INSERT OR IGNORE INTO kv(k,v) VALUES('project_id',?)", ('sis-project-' + secrets.token_hex(16),))
        db.execute('PRAGMA user_version=8')
        return db

    def dependencies(db, ident):
        out = []
        for dep, kind in db.execute('SELECT depends_on,COALESCE(type,\'blocks\') FROM deps WHERE issue=? ORDER BY depends_on,type', (ident,)):
            if kind == 'gate':
                r = db.execute('SELECT state FROM gates WHERE name=?', (dep,)).fetchone()
                state = r[0] if r else 'closed'
                blocked = state != 'open'
            elif kind == 'blocks':
                r = db.execute('SELECT status FROM issues WHERE id=?', (dep,)).fetchone()
                state = r[0] if r else 'missing'
                blocked = state != 'closed'
            else:
                state, blocked = None, False
            out.append({'depends_on': dep, 'type': kind, 'state': state, 'blocked': blocked})
        return out

    def contract(db, ident):
        row = issue(db, ident)
        if not row:
            fail('not_found', str(ident))
        task = {key: row.get(key) for key in CONTRACT_FIELDS if key != 'dependencies'}
        task['meta'] = {key: meta(row).get(key) for key in SECURITY_META}
        task['allowed_paths'] = paths(row)
        deps = dependencies(db, ident)
        task['dependencies'] = [{'depends_on': d['depends_on'], 'type': d['type']} for d in deps]
        revision = hashlib.sha256(canonical(task).encode()).hexdigest()
        task['revision'] = revision
        task['dependencies'] = deps
        task['status'] = row['status']
        task['type'] = row['type']
        task['blocked_by'] = [d['depends_on'] for d in deps if d['blocked']]
        return task

    def op_contract(db, a, c):
        task = contract(db, a.get('id'))
        return {'contract_text': canonical(task), 'revision': task['revision'],
                'task': task, 'structured': task, 'anchors': [], 'priors': None}

    def check_revision(db, a):
        if 'expected_revision' in a and a['expected_revision'] != contract(db, a.get('id'))['revision']:
            fail('revision_conflict', 'expected_revision differs from the current contract')

    def admin(a):
        configured = os.environ.get('SIS_ADMIN_TOKEN')
        supplied = a.get('admin_token')
        if not configured or not isinstance(supplied, str) or not hmac.compare_digest(configured.encode(), supplied.encode()):
            fail('unauthorized', 'configured admin_token required')

    def fence(db, a, c, allow_cancel=False):
        who, e = actor(a, c), epoch(a)
        row = issue(db, a.get('id'))
        if not row:
            fail('not_found', str(a.get('id')))
        if row['status'] != 'in_progress' or row['claim_actor'] != who or row['lease_epoch'] != e or (row['lease_until'] or 0) <= time.time():
            fail('stale_fence', 'actor, epoch and active lease must match')
        if cancelled(db, row['id']) and not allow_cancel:
            fail('cancel_requested', 'worker cancellation is pending')
        return row

    def cancelled(db, ident):
        r = db.execute('SELECT requested FROM cancellations WHERE issue=?', (ident,)).fetchone()
        return bool(r and r[0])

    def finish(db, c, cmd, data):
        key = c.get('idem')
        if key is not None:
            payload = {'cmd': cmd, 'actor': c.get('actor'), 'payload_hash': c.get('payload_hash'), 'data': data}
            db.execute('INSERT INTO kv(k,v) VALUES(?,?)', ('idem:' + str(key), canonical(payload)))
        return data

    def emit(db, op, ident, c, data=None):
        ev(db, op, ident, c.get('actor'), c.get('run_id'), c.get('idem'), data)

    def op_create(db, a, c):
        if a.get('budget_eur') is not None:
            finite(a['budget_eur'], 'budget_eur')
        if a.get('meta') is not None and not isinstance(a['meta'], dict):
            fail('bad_args', 'meta must be an object')
        if a.get('allowed_paths') is not None:
            paths(a)
        return original['op_create'](db, a, c)

    def changes(a):
        aliases = {'descr': 'desc', 'prio': 'priority', 'meta': 'meta_json'}
        out = {aliases.get(k, k): v for k, v in a.items() if aliases.get(k, k) in s['SETCOLS']}
        if a.get('field') is not None:
            if aliases.get(a['field'], a['field']) not in s['SETCOLS']:
                fail('forbidden_field', 'field is not a mutable issue field')
            out[aliases.get(a['field'], a['field'])] = a.get('value')
        return out

    def op_update(db, a, c):
        if 'set' in a:
            if not isinstance(a['set'], dict):
                fail('bad_args', 'set must be an object')
            if any(key not in s['SETCOLS'] and key not in ('descr','prio','meta') for key in a['set']):
                fail('forbidden_field', 'set contains a nonmutable field')
            a = dict(a, **a['set'])
        values = changes(a)
        forbidden = {'status', 'lease_until', 'lease_epoch', 'claim_actor', 'claim_id', 'closed_at',
                     'proof', 'proof_id', 'source_hash', 'revision', 'cancel_requested'}
        if forbidden.intersection(values) or forbidden.intersection(a) or a.get('field') in forbidden:
            fail('forbidden_field', 'worker update cannot mutate status, lease, claim or proof fields')
        if isinstance(a.get('set'), dict) and forbidden.intersection(a['set']):
            fail('forbidden_field', 'worker update cannot mutate status, lease, claim or proof fields')
        with tx(db):
            check_revision(db, a)
            if 'budget_eur' in values:
                new = finite(values['budget_eur'], 'budget_eur')
                old = issue(db, a.get('id'))
                if old and old['budget_eur'] is not None and new > old['budget_eur']:
                    fail('over_budget', 'budget cannot increase')
            if 'allowed_paths' in values:
                paths({'allowed_paths': values['allowed_paths']})
            if 'meta_json' in values:
                value = values['meta_json']
                if isinstance(value, str):
                    try:
                        value = json.loads(value)
                    except ValueError:
                        fail('bad_args', 'meta must be an object')
                if not isinstance(value, dict):
                    fail('bad_args', 'meta must be an object')
                old = issue(db, a.get('id'))
                if old and any(value.get(k) != meta(old).get(k) for k in ('controller', 'review_required')):
                    fail('forbidden_field', 'controller and review policy require admin_update')
            return original['op_update'](db, a, c)

    def op_admin_update(db, a, c):
        admin(a)
        if not isinstance(a.get('reason'), str) or not a['reason'].strip():
            fail('bad_args', 'administrative correction requires a reason')
        if 'set' in a:
            if not isinstance(a['set'],dict) or any(key not in s['SETCOLS'] and key not in ('descr','prio','meta') for key in a['set']):
                fail('bad_args','set must contain mutable fields')
            a = dict(a, **a['set'])
        with tx(db):
            check_revision(db, a)
            if 'budget_eur' in changes(a):
                finite(changes(a)['budget_eur'], 'budget_eur')
            clean = {k: v for k, v in a.items() if k != 'admin_token'}
            cc = dict(c, idem=None)
            result = original['op_update'](db, clean, cc)
            return finish(db, c, 'admin_update', result)

    def op_import(db, a, c):
        admin(a)
        return original['op_import'](db, a, c)

    def op_budget_claim(db, a, c):
        finite(a.get('eur'), 'eur')
        return original['op_budget_claim'](db, a, c)

    def in_goal(db, ident, goal):
        if not goal:
            return True
        if not issue(db, goal):
            fail('not_found', str(goal))
        rows = db.execute("WITH RECURSIVE sub(x) AS (SELECT ? UNION SELECT i.id FROM issues i JOIN sub s ON json_extract(i.meta_json,'$.parent')=s.x OR (i.id LIKE s.x||'.%' AND instr(substr(i.id,length(s.x)+2),'.')=0)) SELECT x FROM sub", (goal,))
        return ident in {r[0] for r in rows}

    def eligible(db, row, a, now):
        if row['status'] not in ('open', 'deferred', 'in_progress'):
            return False
        if row['status'] == 'in_progress' and (row['lease_until'] or 0) > now:
            return False
        if row['status'] == 'deferred' and (row['defer_until'] is None or row['defer_until'] > now):
            return False
        if row['defer_until'] is not None and row['defer_until'] > now:
            return False
        if row['expires_at'] is not None and row['expires_at'] <= now:
            return False
        if not isinstance(row['oracle_cmd'], str) or not row['oracle_cmd'].strip():
            return False
        if a.get('lane') is not None and row['lane'] != a['lane']:
            return False
        if not in_goal(db, row['id'], a.get('goal')) or cancelled(db, row['id']):
            return False
        if any(d['blocked'] for d in dependencies(db, row['id'])):
            return False
        # Any explicit or dotted child makes an issue a container.
        kids = db.execute("SELECT 1 FROM issues i WHERE json_extract(i.meta_json,'$.parent')=? OR (i.id>=?||'.' AND i.id<?||'/' AND instr(substr(i.id,length(?)+2),'.')=0) LIMIT 1", (row['id'], row['id'], row['id'], row['id'])).fetchone()
        if kids or row['type'] in ('goal', 'epic'):
            return (a.get('finalize') is True and a.get('id') == row['id'] and
                    s['op_goal_done'](db, {'id': row['id']}, {})['done'] is True)
        return True

    def candidates(db, a, stale=False, first=False):
        now = time.time()
        cursor = db.execute(f"SELECT {s['ISEL']} FROM issues WHERE status IN ('open','deferred','in_progress') AND (status='open' OR (status='deferred' AND defer_until<=?) OR (status='in_progress' AND lease_until<=?)) AND (expires_at IS NULL OR expires_at>?) AND oracle_cmd IS NOT NULL AND trim(oracle_cmd)<>'' ORDER BY priority,created_at,id", (now, now, now))
        found = []
        for raw in cursor:
            row = s['_issue_dict'](raw)
            if (stale or row['status'] != 'in_progress') and eligible(db, row, a, now):
                found.append(row)
                if first:
                    break
        return found

    def token_count(a):
        text = a.get('text')
        if not isinstance(text, str) or len(text.encode()) > FRAME_MAX:
            fail('bad_args', 'text must be a string of at most 1 MiB UTF-8')
        encoding, model = a.get('encoding'), a.get('model')
        if encoding is None:
            if model is None:
                encoding = 'o200k_base'
            else:
                models = {'gpt-4o': 'o200k_base', 'gpt-4o-mini': 'o200k_base',
                          'gpt-4.1': 'o200k_base', 'gpt-4.1-mini': 'o200k_base',
                          'gpt-4.1-nano': 'o200k_base', 'gpt-4': 'cl100k_base',
                          'gpt-3.5-turbo': 'cl100k_base', 'text-embedding-3-small': 'cl100k_base',
                          'text-embedding-3-large': 'cl100k_base', 'o1': 'o200k_base',
                          'o3': 'o200k_base', 'o4-mini': 'o200k_base', 'gpt-5': 'o200k_base'}
                encoding = models.get(model)
                if encoding is None and tiktoken is not None:
                    try:
                        encoding = tiktoken.encoding_name_for_model(model)
                    except (KeyError, ValueError, TypeError):
                        pass
        if encoding not in ('o200k_base', 'cl100k_base'):
            fail('unknown_tokenizer', 'explicit o200k_base or cl100k_base encoding required')
        enc = cached_encoding(encoding)
        if enc is not None:
            return {'tokens': len(enc.encode(text, disallowed_special=())), 'encoding': encoding,
                    'exact': True, 'algorithm': 'tiktoken-bpe', 'billing': False}
        return {'tokens': len(text.encode()), 'encoding': encoding, 'exact': False,
                'algorithm': 'utf8-upper-bound', 'billing': False}

    def checkpoint_latest(db, ident):
        row = db.execute('SELECT seq,actor,epoch,revision,source_hash,cwd,text,next_step,artifacts,ts FROM checkpoints WHERE issue=? ORDER BY seq DESC LIMIT 1', (ident,)).fetchone()
        if not row:
            return None
        result = dict(zip(('seq', 'actor', 'epoch', 'revision', 'source_hash', 'cwd', 'text', 'next_step', 'artifacts', 'ts'), row))
        result['artifacts'] = json.loads(result['artifacts'] or '[]')
        result['stale'] = result['revision'] != contract(db, ident)['revision']
        try:
            result['stale'] |= fingerprint(db, issue(db, ident), result['cwd'])[0] != result['source_hash']
        except (E, OSError):
            result['stale'] = True
        return result

    def op_brief(db, a, c):
        task = contract(db, a.get('id'))
        data = {k: task[k] for k in MANDATORY}
        omitted = []
        options = {}
        if task.get('desc'):
            options['desc'] = task['desc']
        latest = db.execute(
            "SELECT data_json FROM events WHERE issue=? AND op='changes' "
            "ORDER BY seq DESC LIMIT 1", (task['id'],)).fetchone()
        if latest and latest[0]:
            try:
                options['changes'] = json.loads(latest[0])
            except ValueError:
                pass
        events = events_since(db, task['id'], a.get('since'), 50)
        if events:
            options['history'] = events
        maximum = a.get('max_tokens')
        if maximum is not None:
            maximum = integer(maximum, 'max_tokens', 1)
        counts = token_count(dict(a, text=canonical(data)))
        if maximum is not None and counts['tokens'] > maximum:
            fail('budget_exceeded', f'mandatory contract requires {counts["tokens"]} tokens')
        for key, value in options.items():
            candidate = dict(data, **{key: value})
            size = token_count(dict(a, text=canonical(candidate)))
            if maximum is None or size['tokens'] <= maximum:
                data, counts = candidate, size
            else:
                omitted.append(key)
        return {'id': task['id'], 'revision': task['revision'], 'text': canonical(data),
                'tokens': counts['tokens'], 'encoding': counts['encoding'], 'exact': counts['exact'],
                'algorithm': counts['algorithm'], 'billing': False, 'omitted': omitted,
                'checkpoint': checkpoint_latest(db, task['id']),
                'cursor': events[-1]['seq'] if events else integer(a.get('since', 0), 'since')}

    def grant(db, a, c, cmd):
        who, duration = actor(a, c), ttl(a)
        if a.get('finalize') is True and (cmd != 'claim' or not a.get('id')):
            fail('bad_args', 'finalize requires explicit claim id')
        with tx(db):
            if a.get('id') is not None:
                row = issue(db, a['id'])
                if not row:
                    fail('not_found', str(a['id']))
                if not eligible(db, row, a, time.time()):
                    if not row.get('oracle_cmd') or not row['oracle_cmd'].strip():
                        fail('missing_oracle', 'claim requires an executable nonblank oracle')
                    fail('not_ready', 'claim requires an eligible ready leaf with satisfied blockers')
            else:
                rows = candidates(db, a, stale=True, first=True)
                row = rows[0] if rows else None
            if row is None:
                return finish(db, c, cmd, {'id': None})
            if cmd == 'acquire':
                # Token budget validation precedes any claim mutation.
                brief = op_brief(db, dict(a, id=row['id']), c)
            now, ident = time.time(), row['id']
            e, cid, until = row['lease_epoch'] + 1, secrets.token_hex(16), now + duration
            db.execute("UPDATE issues SET status='in_progress',claim_actor=?,lease_until=?,lease_epoch=? WHERE id=?", (who, until, e, ident))
            db.execute('DELETE FROM claims WHERE issue=?', (ident,))
            db.execute('INSERT INTO claims(actor,issue,claim_id,epoch,hb_at,run_id) VALUES(?,?,?,?,?,?)', (who, ident, cid, e, now, c.get('run_id')))
            db.execute('INSERT INTO agent_state(issue,attempt,cancel_requested) VALUES(?,1,0) ON CONFLICT(issue) DO UPDATE SET attempt=attempt+1', (ident,))
            emit(db, cmd, ident, c, {'claim_id': cid, 'epoch': e})
            result = {'id': ident, 'claim_id': cid, 'epoch': e, 'lease_until': until,
                      'revision': contract(db, ident)['revision']}
            # meta.autorun: enqueue a runner job so an external executor can
            # pick the work up crash-safely (attest kind:"run" records it).
            ar = meta(row).get('autorun')
            ar_cmd = ar if isinstance(ar, str) else (ar or {}).get('cmd', '')
            if isinstance(ar_cmd, str) and ar_cmd.strip():
                payload = {'issue': ident, 'actor': who, 'epoch': e, 'cmd': ar_cmd,
                           'cwd': (ar or {}).get('cwd') if isinstance(ar, dict) else None}
                db.execute("INSERT INTO outbox(kind,payload,run_id) VALUES('autorun',?,?)",
                           (canonical(payload), c.get('run_id')))
                result['autorun'] = True
            if cmd == 'acquire':
                result['contract'] = brief
            return finish(db, c, cmd, result)

    def op_heartbeat(db, a, c):
        duration = ttl(a)
        with tx(db):
            row = fence(db, a, c, allow_cancel=True)
            until = time.time() + duration
            db.execute('UPDATE issues SET lease_until=? WHERE id=?', (until, row['id']))
            db.execute('UPDATE claims SET hb_at=?,run_id=COALESCE(?,run_id) WHERE issue=?', (time.time(), c.get('run_id'), row['id']))
            emit(db, 'heartbeat', row['id'], c, {'epoch': row['lease_epoch']})
            return finish(db, c, 'heartbeat', {'ok': True, 'cancel_requested': cancelled(db, row['id']),
                          'revision': contract(db, row['id'])['revision'], 'lease_until': until})

    def fingerprint(db, row, cwd):
        if not isinstance(cwd, str) or not cwd:
            fail('bad_args', 'existing cwd required')
        try:
            root = Path(cwd).resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            fail('bad_args', f'invalid cwd: {exc}')
        if not root.is_dir():
            fail('bad_args', 'cwd must be a directory')
        scopes = paths(row)
        if not scopes:
            fail('missing_scope', 'allowed_paths must contain file or directory scope')
        dbpath = db.execute('PRAGMA database_list').fetchone()[2]
        ignored_files = {str(Path(dbpath).resolve()) + suffix for suffix in ('', '-wal', '-shm')}
        found = {}
        total = 0

        def add(path, boundary):
            nonlocal total
            resolved = path.resolve(strict=True)
            if not resolved.is_relative_to(boundary):
                fail('scope_escape', 'escaping symlink in allowed_paths')
            if str(resolved) in ignored_files:
                return
            if resolved.is_dir():
                return
            if not resolved.is_file():
                fail('invalid_scope', 'scope contains a nonregular file')
            key = str(path.absolute())
            if key in found:
                return
            length = resolved.stat().st_size
            total += length
            if len(found) >= 10000 or total > 32 * 1024 * 1024:
                fail('scope_too_large', 'source scope exceeds 32 MiB or 10000 files')
            digest = hashlib.sha256()
            size = 0
            with resolved.open('rb') as handle:
                for block in iter(lambda: handle.read(65536), b''):
                    size += len(block)
                    if total - length + size > 32 * 1024 * 1024:
                        fail('scope_too_large', 'source grew beyond 32 MiB')
                    digest.update(block)
            total += size - length
            found[key] = {'path': key, 'target': str(resolved), 'size': size, 'sha256': digest.hexdigest()}

        seen = set()

        def walk(path, boundary):
            if path.name in IGNORED:
                return
            resolved = path.resolve(strict=True)
            if not resolved.is_relative_to(boundary) or not resolved.is_relative_to(root):
                fail('scope_escape', 'escaping symlink in allowed_paths')
            if resolved.is_dir():
                if resolved in seen:
                    return
                seen.add(resolved)
                for child in sorted(path.iterdir()):
                    walk(child, boundary)
            else:
                add(path, boundary)

        try:
            for scope in scopes:
                raw = Path(scope)
                if '..' in raw.parts:
                    fail('scope_escape', 'parent traversal in allowed_paths')
                raw = raw if raw.is_absolute() else root / raw
                resolved = raw.resolve(strict=True)
                if not resolved.is_relative_to(root):
                    fail('invalid_cwd', 'cwd does not correspond to allowed project paths')
                boundary = resolved if resolved.is_dir() else resolved.parent
                if raw.is_symlink() and not resolved.is_relative_to(root):
                    fail('scope_escape', 'escaping scope symlink')
                walk(raw, boundary)
        except (OSError, RuntimeError) as exc:
            fail('invalid_scope', str(exc))
        manifest = {}
        for key, value in found.items():
            try:
                relative = str(Path(key).relative_to(root))
            except ValueError:
                relative = key
            manifest[relative] = value['sha256']
        return hashlib.sha256(canonical(manifest).encode()).hexdigest(), str(root)

    def valid_review(review, who, revision, source):
        return (isinstance(review, dict) and isinstance(review.get('reviewer'), str)
                and bool(review['reviewer'].strip()) and review['reviewer'] != who
                and review.get('verdict') == 'pass' and review.get('revision') == revision
                and review.get('source_hash') == source
                and bool(review.get('artifact') or review.get('artifact_ref')))

    def recorded_cost(db, ident):
        return db.execute(
            "WITH RECURSIVE sub(id) AS (SELECT ? UNION "
            "SELECT i.id FROM issues i JOIN sub s ON "
            "json_extract(i.meta_json,'$.parent')=s.id OR "
            "(i.id LIKE s.id||'.%' AND instr(substr(i.id,length(s.id)+2),'.')=0)) "
            "SELECT COALESCE(SUM(CASE WHEN c.cents>0 THEN c.cents ELSE 0 END),0) "
            "FROM costs c WHERE c.issue IN (SELECT id FROM sub)", (ident,)).fetchone()[0]

    def local_zero_guard(db, row):
        enabled = meta(row).get('local_zero') is True
        if not enabled:
            return False
        if row.get('budget_eur') is None or row['budget_eur'] != 0:
            fail('local_zero_budget', 'local_zero requires budget_eur exactly 0')
        if recorded_cost(db, row['id']) > 0:
            fail('budget_exceeded', 'local_zero refuses already recorded positive costs')
        if sys.platform != 'darwin' or not os.access('/usr/bin/sandbox-exec', os.X_OK):
            fail('local_zero_unavailable', 'local_zero requires the macOS sandbox-exec OS sandbox')
        return True

    def validate_controller_lock():
        try:
            controller_lock_fds()
        except (OSError, ValueError) as exc:
            fail('bad_args', str(exc))

    def local_run_contract(row, command, cwd):
        policy = meta(row)
        if policy.get('local_zero') is not True or 'execution' not in policy:
            return
        execution = policy['execution']
        if (not isinstance(execution, dict) or not isinstance(execution.get('cwd'), str)
                or execution.get('cmd') != command):
            fail('execution_mismatch', 'run cmd/cwd does not match meta.execution')
        try:
            matches = str(Path(execution['cwd']).resolve(strict=True)) == str(cwd)
        except OSError:
            matches = False
        if not matches:
            fail('execution_mismatch', 'run cmd/cwd does not match meta.execution')

    def op_verify(db, a, c):
        if db.in_transaction:
            fail('bad_args', 'verify cannot run inside batch')
        duration = finite(a.get('timeout_secs', 10), 'timeout_secs', 1, 300)
        row = fence(db, a, c)
        check_revision(db, a)
        local_zero = local_zero_guard(db, row)
        validate_controller_lock()
        task = contract(db, row['id'])
        if not row.get('oracle_cmd') or not row['oracle_cmd'].strip():
            fail('missing_oracle', 'oracle_cmd is required')
        source, cwd = fingerprint(db, row, a.get('cwd'))
        exitcode, timed_out, output = run_oracle(row['oracle_cmd'], cwd, duration, local_zero)
        after = fingerprint(db, row, cwd)[0]
        passed = exitcode == 0 and not timed_out and source == after
        proof = 'proof-' + secrets.token_hex(16)
        review = a.get('review_receipt')
        if review is not None and not valid_review(review, actor(a, c), task['revision'], source):
            fail('review_required', 'review receipt does not match builder, source and contract')
        with tx(db):
            current = fence(db, a, c)
            local_zero_guard(db, current)
            if task['revision'] != contract(db, row['id'])['revision'] or after != source:
                passed = False
            db.execute('INSERT INTO proofs(proof_id,issue,actor,epoch,revision,source_hash,cwd,oracle,exitcode,passed,timed_out,output,review_receipt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                       (proof, row['id'], actor(a, c), epoch(a), task['revision'], source, cwd,
                        row['oracle_cmd'], exitcode, int(passed), int(timed_out), output,
                        canonical(review) if review is not None else 'null'))
            db.execute('INSERT INTO agent_state(issue,last_error) VALUES(?,?) ON CONFLICT(issue) DO UPDATE SET last_error=excluded.last_error',
                       (row['id'], None if passed else ('timeout' if timed_out else 'oracle/source verification failed')))
            result = {'proof_id': proof, 'passed': passed, 'exit_code': exitcode,
                      'timed_out': timed_out, 'revision': task['revision'], 'source_hash': source}
            if local_zero:
                result['execution'] = execution_evidence(True)
            emit(db, 'verify', row['id'], c, result)
            return finish(db, c, 'verify', result)

    def op_close(db, a, c):
        who, e = actor(a, c), epoch(a)
        with tx(db):
            row = issue(db, a.get('id'))
            if not row:
                fail('not_found', str(a.get('id')))
            if row['status'] != 'closed':
                fence(db, a, c)
            proof = a.get('proof_id')
            if not proof:
                fail('proof_required', 'successful verify receipt required')
            p = db.execute('SELECT issue,actor,epoch,revision,source_hash,cwd,oracle,passed,review_receipt FROM proofs WHERE proof_id=?', (proof,)).fetchone()
            if not p or not p[7]:
                fail('proof_required', 'stored successful verify receipt required')
            current = contract(db, row['id'])
            if p[:3] != (row['id'], who, e):
                fail('stale_proof', 'receipt actor/epoch does not match')
            if current['revision'] != p[3] or fingerprint(db, row, p[5])[0] != p[4] or row['oracle_cmd'] != p[6]:
                fail('stale_proof', 'contract or source changed since verification')
            if meta(row).get('review_required'):
                review = json.loads(p[8]) if p[8] else None
                if not valid_review(review, who, p[3], p[4]):
                    fail('review_required', 'matching persisted independent review receipt required')
            req_att = meta(row).get('attest_required')
            if req_att:
                needed = ([req_att] if isinstance(req_att, str)
                          else list(req_att) if isinstance(req_att, list) else [])
                have = {r[0] for r in db.execute(
                    'SELECT DISTINCT kind FROM attests WHERE issue=? AND revision=? AND source_hash=? AND passed=1',
                    (row['id'], current['revision'], p[4]))}
                missing = [k for k in needed if k not in have]
                if missing or (not needed and not have):
                    fail('attest_required', 'passed attests required for current contract/source: %s' % missing)
            # meta.budget_gate: refuse close when the recorded cost rollup of
            # this issue's container subtree already exceeds its budget_eur.
            local_zero_guard(db, row)
            if meta(row).get('budget_gate'):
                if row.get('budget_eur') is None:
                    fail('budget_missing', 'budget_gate requires an explicit budget_eur')
                spent = recorded_cost(db, row['id'])
                budget = row['budget_eur'] * 100
                if spent > budget:
                    fail('budget_exceeded',
                         'cost rollup %dc exceeds budget %gc' % (spent, budget))
            if row['status'] == 'closed' and row['claim_actor'] == who and row['lease_epoch'] == e:
                return finish(db, c, 'close', {'ok': True})
            fence(db, a, c)
            if row['type'] in ('goal', 'epic') and not s['op_goal_done'](db, {'id': row['id']}, c)['done']:
                fail('not_ready', 'container descendants remain open')
            db.execute("UPDATE issues SET status='closed',closed_at=?,lease_until=NULL WHERE id=?", (time.time(), row['id']))
            db.execute('DELETE FROM claims WHERE issue=?', (row['id'],))
            emit(db, 'close', row['id'], c, {'epoch': e, 'proof_id': proof, 'reason': a.get('reason')})
            db.execute("INSERT INTO outbox(kind,payload,run_id) VALUES('lesson',?,?)", (canonical({'issue': row['id'], 'actor': who, 'reason': a.get('reason'), 'proof_id': proof}), c.get('run_id')))
            return finish(db, c, 'close', {'ok': True})

    def _xml_attr(tag, key):
        for q in ('"', "'"):
            needle = key + '=' + q
            p = tag.find(needle)
            if p >= 0:
                rest = tag[p + len(needle):]
                end = rest.find(q)
                try:
                    return int(rest[:end if end >= 0 else 12].strip())
                except ValueError:
                    return None
        return None

    def _junit_counts(text):
        tests, fails, errs, skips, hits = 0, 0, 0, 0, 0
        tags = []
        p = text.find('<testsuites')
        if p >= 0:
            e = text.find('>', p)
            tags.append(text[p:e if e >= 0 else len(text)])
        if not tags:
            pos = 0
            while True:
                p = text.find('<testsuite ', pos)
                if p < 0:
                    break
                e = text.find('>', p)
                tags.append(text[p:e if e >= 0 else len(text)])
                pos = p + 1
        for tag in tags:
            for key, name in (('tests', 'tests'), ('failures', 'fails'),
                              ('errors', 'errs'), ('skipped', 'skips')):
                n = _xml_attr(tag, key)
                if n is not None:
                    hits += 1
                    if name == 'tests':
                        tests += n
                    elif name == 'fails':
                        fails += n
                    elif name == 'errs':
                        errs += n
                    else:
                        skips += n
        return {'tests': tests, 'failures': fails, 'errors': errs,
                'skipped': skips, 'parsed': hits > 0}

    def _attest_run(db, a, c):
        if db.in_transaction:
            fail('bad_args', 'run attest cannot run inside batch')
        row = fence(db, a, c)
        check_revision(db, a)
        local_zero = local_zero_guard(db, row)
        validate_controller_lock()
        source, cwd = fingerprint(db, row, a.get('cwd'))
        revision = contract(db, row['id'])['revision']
        payload = a.get('payload')
        if len(json.dumps(payload or {})) > 65536:
            fail('bad_args', 'payload exceeds 64 KiB')
        payload = payload if isinstance(payload, dict) else {}
        cmd = a.get('cmd') or payload.get('cmd')
        if not isinstance(cmd, str) or not cmd.strip() or len(cmd) > 8192:
            fail('bad_args', 'run attest needs nonempty cmd within 8 KiB')
        duration = integer(a.get('timeout_secs', 10), 'timeout_secs', 1, 60)
        local_run_contract(row, cmd, cwd)
        autorun_delivery(db, a, cmd, duration + 2)
        result = run_oracle(cmd, cwd, duration, local_zero)
        with tx(db):
            current = fence(db, a, c)
            local_zero_guard(db, current)
            autorun_delivery(db, a, cmd, 0)
            if contract(db, row['id'])['revision'] != revision or fingerprint(db, current, cwd)[0] != source:
                fail('stale_proof', 'contract or source changed during attestation')
            return op_attest(db, a, c, result)

    def op_attest(db, a, c, _run_result=None):
        if a.get('kind') == 'run' and _run_result is None:
            return _attest_run(db, a, c)
        with tx(db):
            row = fence(db, a, c)
            source, cwd = fingerprint(db, row, a.get('cwd'))
            task = contract(db, row['id'])
            kind = a.get('kind')
            payload = a.get('payload')
            if len(json.dumps(payload or {})) > 65536:
                fail('bad_args', 'payload exceeds 64 KiB')
            pload = payload if isinstance(payload, dict) else {}
            if kind == 'junit':
                rel = a.get('path') or pload.get('path')
                if not rel:
                    fail('bad_args', 'junit attest needs path')
                root, f = Path(cwd), Path(cwd, rel).resolve()
                if not f.is_relative_to(root) or not f.is_file():
                    fail('bad_args', 'junit path must be a file inside cwd')
                if f.stat().st_size > 4 * 1024 * 1024:
                    fail('bad_args', 'junit file exceeds 4 MiB')
                summary = _junit_counts(f.read_text(errors='replace'))
                passed = summary['tests'] > 0 and summary['failures'] == 0 and summary['errors'] == 0
            elif kind == 'coverage':
                pct = finite(a.get('percent', pload.get('percent')), 'percent')
                if not 0 <= pct <= 100:
                    fail('bad_args', 'coverage needs percent 0..100')
                mn = finite(a.get('min', pload.get('min', 0)), 'min')
                summary = {'percent': pct, 'min': mn}
                passed = pct >= mn
            elif kind == 'smoke':
                url = a.get('url') or pload.get('url')
                status = integer(a.get('status', pload.get('status')), 'status')
                if not url or not 100 <= status <= 599:
                    fail('bad_args', 'smoke needs url and status 100..599')
                expect = integer(a.get('expect', pload.get('expect', 200)), 'expect')
                summary = {'url': url, 'status': status, 'expect': expect}
                passed = status == expect
            elif kind == 'artifact':
                ref = a.get('ref') or pload.get('ref') or a.get('path')
                if not ref or not str(ref).strip():
                    fail('bad_args', 'artifact needs ref or path')
                summary = {'ref': ref, 'digest': pload.get('digest')}
                passed = True
            elif kind == 'custom':
                pv = a.get('passed', pload.get('passed'))
                if not isinstance(pv, bool):
                    fail('bad_args', 'custom attest needs passed bool')
                summary = {'note': a.get('note') or pload.get('note')}
                passed = pv
            elif kind == 'run':
                # Execution evidence is supplied only by _attest_run, outside
                # the writer transaction, never by client JSON.
                cmd = a.get('cmd') or pload.get('cmd')
                if not isinstance(cmd, str) or not cmd.strip():
                    fail('bad_args', 'run attest needs cmd')
                if len(cmd) > 8192:
                    fail('bad_args', 'run cmd exceeds 8 KiB')
                duration = finite(a.get('timeout_secs', 10), 'timeout_secs', 1, 60)
                rc, timed, output = _run_result
                summary = {'cmd': cmd, 'exit_code': rc, 'timed_out': timed,
                           'output': output}
                if meta(row).get('local_zero') is True:
                    summary['execution'] = execution_evidence(True)
                passed = rc == 0 and not timed
            else:
                fail('bad_args', 'unknown attest kind %s' % kind)
            att = 'attest-' + secrets.token_hex(16)
            db.execute('INSERT INTO attests(attest_id,issue,actor,epoch,revision,source_hash,cwd,kind,payload,summary,passed,ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                       (att, row['id'], actor(a, c), epoch(a), task['revision'], source, cwd, kind,
                        canonical(payload), canonical(summary), int(passed), time.time()))
            emit(db, 'attest', row['id'], c, {'attest_id': att, 'kind': kind, 'passed': passed,
                                              'revision': task['revision'], 'source_hash': source})
            return finish(db, c, 'attest', {'attest_id': att, 'kind': kind, 'passed': passed,
                          'summary': summary, 'revision': task['revision'], 'source_hash': source})

    def op_cost_add(db, a, c):
        with tx(db):
            i = a.get('issue')
            if not issue(db, i):
                fail('not_found', str(i))
            ti = integer(a.get('tokens_in', 0), 'tokens_in')
            to = integer(a.get('tokens_out', 0), 'tokens_out')
            cents = a.get('cents')
            if cents is None and a.get('eur') is not None:
                cents = round(finite(a['eur'], 'eur') * 100)
            cents = integer(0 if cents is None else cents, 'cents')
            if ti < 0 or to < 0 or cents < 0:
                fail('bad_args', 'costs must be nonnegative')
            wave = a.get('wave')
            if wave is not None and len(str(wave)) > 64:
                fail('bad_args', 'wave must be at most 64 characters')
            cur = db.execute('INSERT INTO costs(issue,actor,run_id,wave,tokens_in,tokens_out,cents,currency,note,ts) VALUES(?,?,?,?,?,?,?,?,?,?)',
                             (i, a.get('actor'), a.get('run_id'), wave, ti, to, cents,
                              a.get('currency') or 'EUR', a.get('note'), time.time()))
            row_id = cur.lastrowid
            emit(db, 'cost_add', i, c, {'cost_id': row_id, 'tokens_in': ti,
                                        'tokens_out': to, 'cents': cents})
            return finish(db, c, 'cost_add', {'ok': True, 'id': row_id})

    def op_cost_list(db, a, c):
        wh, ps = [], []
        for k in ('issue', 'actor', 'run_id', 'wave'):
            if a.get(k) is not None:
                wh.append(k + '=?')
                ps.append(a[k])
        limit = integer(a.get('limit', 200), 'limit', 1, 1000)
        sql = 'SELECT id,issue,actor,run_id,wave,tokens_in,tokens_out,cents,currency,note,ts FROM costs'
        if wh:
            sql += ' WHERE ' + ' AND '.join(wh)
        sql += ' ORDER BY id DESC LIMIT ?'
        return [dict(zip(('id', 'issue', 'actor', 'run_id', 'wave', 'tokens_in',
                          'tokens_out', 'cents', 'currency', 'note', 'ts'), r))
                for r in db.execute(sql, (*ps, limit))]

    def op_cost_rollup(db, a, c):
        root = a.get('id')
        if not issue(db, root):
            fail('not_found', str(root))
        seen, stack = set(), [root]
        while stack and len(seen) <= 512:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            stack += [r[0] for r in db.execute(
                "SELECT id FROM issues WHERE json_extract(meta_json,'$.parent')=? "
                "OR (id LIKE ?||'.%' AND instr(substr(id,length(?)+2),'.')=0)",
                (cur, cur, cur)) if r[0] not in seen]
        marks = ','.join('?' * len(seen))
        ids = list(seen)

        def group(by):
            return [{'key': r[0] if r[0] is not None else '(none)',
                     'tokens_in': r[1], 'tokens_out': r[2], 'cents': r[3],
                     'entries': r[4]} for r in db.execute(
                f'SELECT {by},COALESCE(SUM(tokens_in),0),COALESCE(SUM(tokens_out),0),'
                f'COALESCE(SUM(cents),0),COUNT(*) FROM costs WHERE issue IN ({marks}) '
                f'GROUP BY {by} ORDER BY 4 DESC', ids)]
        t = db.execute(f'SELECT COALESCE(SUM(tokens_in),0),COALESCE(SUM(tokens_out),0),'
                       f'COALESCE(SUM(cents),0),COUNT(*) FROM costs WHERE issue IN ({marks})', ids).fetchone()
        row = issue(db, root)
        return {'id': root, 'issues': len(ids),
                'totals': {'tokens_in': t[0], 'tokens_out': t[1], 'cents': t[2],
                           'eur': t[2] / 100.0, 'entries': t[3]},
                'by_issue': group('issue'), 'by_actor': group('actor'),
                'by_wave': group('wave'), 'budget_eur': row.get('budget_eur')}

    def op_learn(db, a, c):
        """Honest aggregates over the ledger — pass rates, cost and
        time-to-accepted per group, no invented score. Issue metrics
        attribute to the issue's first matching membership; the actor key
        falls back to the latest prover since close clears claim_actor."""
        by = a.get('group_by') or 'actor'
        if by not in ('actor', 'wave', 'kind', 'issue'):
            fail('bad_args', 'group_by must be actor|wave|kind|issue')
        since = finite(a.get('since', 0), 'since')

        def key_of(entity):
            if by == 'actor':
                return entity + '.actor'
            if by == 'issue':
                return entity + '.issue'
            if by == 'kind':
                return ("COALESCE((SELECT kind FROM attests WHERE issue=%s.issue LIMIT 1),'verify')"
                        % entity)
            return ("(SELECT wave FROM costs WHERE issue=%s.issue "
                    "AND wave IS NOT NULL LIMIT 1)" % entity)
        groups = {}

        def bump(key, field, v):
            g = groups.setdefault(key, {'key': key})
            g[field] = v
        for k, n, p in db.execute(
                'SELECT COALESCE(%s,\'(none)\') k, COUNT(*), SUM(passed) '
                'FROM attests WHERE ts>=? GROUP BY k' % key_of('attests'), (since,)):
            bump(k, 'attests', n)
            bump(k, 'attest_passed', p or 0)
            bump(k, 'attest_pass_rate', (p or 0) / max(n, 1))
        for k, n, p in db.execute(
                'SELECT COALESCE(%s,\'(none)\') k, COUNT(*), SUM(passed) '
                "FROM proofs WHERE ?=0 OR proof_id IN (SELECT json_extract(data_json,'$.proof_id') FROM events WHERE op='verify' AND ts>=?) GROUP BY k" % key_of('proofs'), (since, since)):
            bump(k, 'proofs', n)
            bump(k, 'proofs_passed', p or 0)
            bump(k, 'proof_pass_rate', (p or 0) / max(n, 1))
        cost_key = 'issue' if by == 'issue' else key_of('costs')
        for k, cents, ti, to, entries in db.execute(
                'SELECT COALESCE(%s,\'(none)\') k, COALESCE(SUM(cents),0), '
                'COALESCE(SUM(tokens_in),0), COALESCE(SUM(tokens_out),0), COUNT(*) '
                'FROM costs WHERE ts>=? GROUP BY k' % cost_key, (since,)):
            bump(k, 'cents', cents)
            bump(k, 'tokens_in', ti)
            bump(k, 'tokens_out', to)
            bump(k, 'cost_entries', entries)
        iss_key = {'actor': "COALESCE(claim_actor,(SELECT actor FROM proofs WHERE issue=issues.id ORDER BY rowid DESC LIMIT 1),'(none)')",
                   'issue': 'id',
                   'wave': "COALESCE((SELECT wave FROM costs WHERE issue=issues.id AND wave IS NOT NULL LIMIT 1),'(none)')",
                   'kind': "COALESCE((SELECT kind FROM attests WHERE issue=issues.id LIMIT 1),'(none)')"}[by]
        for k, n, closed, accept in db.execute(
                "SELECT %s k, COUNT(*), SUM(status='closed'), "
                "AVG(CASE WHEN status='closed' AND closed_at>created_at "
                "THEN closed_at-created_at END) FROM issues WHERE created_at>=? GROUP BY k" % iss_key, (since,)):
            bump(k or '(none)', 'issues', n)
            bump(k or '(none)', 'closed', closed or 0)
            bump(k or '(none)', 'accept_secs', accept)
        out = sorted(groups.values(), key=lambda g: (-(g.get('cents') or 0), g['key']))
        return {'group_by': by, 'since': since, 'groups': out,
                'proof_window': 'verify event timestamps; unknown timestamps excluded for since > 0',
                'issue_window': 'created_at cohort', 'automatic_promotion': False}

    def autorun_delivery(db, a, cmd, remaining):
        if 'outbox_id' not in a:
            return
        delivery = {'id': a['outbox_id'], 'actor': a.get('delivery_actor'), 'epoch': a.get('delivery_epoch')}
        if a.get('idem') != f"outbox-{delivery['id']}-delivery-{delivery['epoch']}":
            fail('stale_fence', 'leased execution requires its stable idempotency key')
        lease = delivery_fence(db, delivery)
        if not lease or lease[2] <= time.time() + remaining:
            fail('stale_fence', 'delivery lease is too short for execution deadline')
        row = db.execute("SELECT payload FROM outbox WHERE id=? AND kind='autorun' AND state='running'", (a['outbox_id'],)).fetchone()
        payload = json.loads(row[0]) if row else {}
        if isinstance(payload.get('cwd'), str) and Path(payload['cwd']).resolve() != Path(a.get('cwd') or Path.cwd()).resolve():
            fail('stale_fence', 'execution directory differs from leased job')
        if any(payload.get(k) != a.get(k2) for k, k2 in (('issue', 'id'), ('actor', 'actor'), ('epoch', 'epoch'))) or payload.get('cmd') != cmd:
            fail('stale_fence', 'execution does not match leased job')

    def delivery_fence(db, a):
        lease = db.execute('SELECT actor,epoch,lease_until FROM outbox_leases WHERE outbox_id=?', (a.get('id'),)).fetchone()
        epoch = a.get('epoch')
        if lease and 'epoch' in a:
            integer(epoch, 'epoch', 1)
        if lease and (a.get('actor') != lease[0] or epoch != lease[1] or lease[2] <= time.time()):
            fail('stale_fence', 'outbox runner, delivery epoch and live lease required')
        return lease

    def delivery_ack(db, a, state):
        lease = delivery_fence(db, a)
        if lease:
            current = db.execute('SELECT state FROM outbox WHERE id=?', (a['id'],)).fetchone()
            if current is None or current[0] not in ('running', state):
                fail('stale_fence', 'delivery already finalized with a different outcome')
        return lease

    def op_outbox_done(db, a, c):
        delivery_ack(db, a, 'done')
        return s['op_outbox_done'](db, a, c)

    def op_outbox_fail(db, a, c):
        lease = delivery_ack(db, a, 'failed')
        if not lease:
            return s['op_outbox_fail'](db, a, c)
        db.execute("UPDATE outbox SET state='failed' WHERE id=?", (a['id'],))
        emit(db, 'outbox_fail', None, c, {'id': a['id'], 'err': a.get('err')})
        return finish(db, c, 'outbox_fail', {'ok': True})

    def op_outbox_export(db, a, c):
        fmt = a.get('format') or 'raw'
        limit = integer(a.get('limit', 100), 'limit', 1, 500)
        runner = actor(a, c) if a.get('actor') is not None else None
        duration = finite(a.get('ttl', 120), 'ttl', 5, 3600)
        if runner is None and 'ttl' in a:
            fail('bad_args', 'delivery ttl requires explicit runner actor')
        if runner is not None and a.get('drain') is True:
            fail('bad_args', 'leased export requires acknowledgement, not drain')
        now = time.time()
        if runner is not None:
            db.execute("UPDATE outbox SET state='failed' WHERE state='running' AND attempts>=3 AND id IN (SELECT outbox_id FROM outbox_leases WHERE lease_until<=?)", (now,))
        rows = db.execute("SELECT o.id,o.kind,o.payload,o.run_id FROM outbox o LEFT JOIN outbox_leases l ON l.outbox_id=o.id WHERE (o.state='pending' OR (? AND o.state='running' AND l.lease_until<=? AND o.attempts<3)) AND (? IS NULL OR o.kind=?) ORDER BY o.id LIMIT ?",
                          (runner is not None, now, a.get('kind'), a.get('kind'), limit)).fetchall()
        leases = {}
        if runner is not None:
            for oid, _, _, _ in rows:
                db.execute('INSERT INTO outbox_leases(outbox_id,actor,epoch,lease_until) VALUES(?,?,1,?) ON CONFLICT(outbox_id) DO UPDATE SET actor=excluded.actor,epoch=outbox_leases.epoch+1,lease_until=excluded.lease_until', (oid, runner, now + duration))
                db.execute("UPDATE outbox SET state='running',attempts=attempts+1 WHERE id=?", (oid,))
                leases[oid] = db.execute('SELECT epoch FROM outbox_leases WHERE outbox_id=?', (oid,)).fetchone()[0]

        def env(oid, kind, payload, run_id):
            try:
                p = json.loads(payload)
            except (ValueError, TypeError):
                p = payload
            job = {'outbox_id': oid, 'kind': kind, 'payload': p, 'run_id': run_id}
            if oid in leases:
                job.update(delivery_epoch=leases[oid], delivery_actor=runner,
                           lease_until=now + duration,
                           idempotency_key=f'outbox-{oid}-delivery-{leases[oid]}')
            return job
        if fmt == 'raw':
            out = {'format': 'raw', 'jobs': [env(*r) for r in rows]}
        elif fmt == 'pgboss-sql':
            sql = ''.join("INSERT INTO pgboss.job(name,data) VALUES('sis-event','%s'::jsonb);\n"
                          % canonical(env(*r)).replace("'", "''") for r in rows)
            out = {'format': 'pgboss-sql', 'sql': sql}
        elif fmt == 'hatchet':
            out = {'format': 'hatchet',
                   'jobs': [{'workflow': 'sis-event', 'input': env(*r)} for r in rows]}
        elif fmt == 'temporal':
            q = a.get('task_queue') or 'sis'
            out = {'format': 'temporal', 'jobs': [
                {'workflowType': 'SisEvent', 'taskQueue': q,
                 'workflowId': 'sis-outbox-%s' % r[0], 'args': [env(*r)]}
                for r in rows]}
        else:
            fail('bad_args', 'unknown export format %s' % fmt)
        drained = a.get('drain') is True
        if drained and rows:
            db.execute("UPDATE outbox SET state='done' WHERE id IN (%s)"
                       % ','.join('?' * len(rows)), [r[0] for r in rows])
        emit(db, 'outbox_export', None, c, {'format': fmt, 'n': len(rows), 'drained': drained})
        out['n'], out['drained'] = len(rows), drained
        return out

    def op_sync_export(db, a, c):
        issues = s['_idicts'](db.execute('SELECT * FROM issues ORDER BY id'))
        deps = {}
        for i, on, ty in db.execute("SELECT issue,depends_on,COALESCE(type,'blocks') FROM deps ORDER BY issue,depends_on"):
            deps.setdefault(i, []).append({'on': on, 'type': ty})
        for row in issues:
            if row['id'] in deps:
                row['deps'] = deps[row['id']]
            if isinstance(row.get('meta_json'), str):
                row['meta'] = json.loads(row['meta_json'])
                del row['meta_json']
        mems = [{'key': k, 'value': v, 'updated_at': t} for k, v, t in
                db.execute('SELECT key,value,updated_at FROM memories ORDER BY key')]
        pid = db.execute("SELECT v FROM kv WHERE k='project_id'").fetchone()
        # proof receipts travel with the bundle: a PR verified on machine A
        # must close on machine B with the same receipt identity.
        proofs = [dict(zip(('proof_id', 'issue', 'actor', 'epoch', 'revision',
                            'source_hash', 'cwd', 'oracle', 'exitcode', 'passed',
                            'timed_out', 'output', 'review_receipt'), r))
                  for r in db.execute(
                      'SELECT proof_id,issue,actor,epoch,revision,source_hash,cwd,'
                      'oracle,exitcode,passed,timed_out,output,review_receipt '
                      'FROM proofs ORDER BY proof_id')]
        attests = [dict(zip(('attest_id', 'issue', 'actor', 'epoch', 'revision',
                             'source_hash', 'cwd', 'kind', 'payload', 'summary',
                             'passed', 'ts'), r))
                   for r in db.execute(
                       'SELECT attest_id,issue,actor,epoch,revision,source_hash,'
                       'cwd,kind,payload,summary,passed,ts FROM attests ORDER BY attest_id')]
        events = []
        if a.get('events') is True:
            events = [dict(zip(('seq', 'ts', 'op', 'issue', 'actor', 'run_id',
                                'idem', 'data'), r[:7] + (json.loads(r[7]) if r[7] else None,)))
                      for r in db.execute(
                          'SELECT seq,ts,op,issue,actor,run_id,idem,data_json '
                          'FROM events ORDER BY seq')]
        return {'k': 'sis-sync', 'v': 1, 'schema': 7,
                'project_id': pid[0] if pid else None, 'exported_at': time.time(),
                'issues': issues, 'memories': mems,
                'proofs': proofs, 'attests': attests, 'events': events}

    def op_sync_import(db, a, c):
        if a.get('path'):
            bundle = json.loads(open(a['path']).read())
        elif isinstance(a.get('json'), dict):
            bundle = a['json']
        elif isinstance(a.get('json'), str):
            bundle = json.loads(a['json'])
        else:
            fail('bad_args', 'path or json required')
        if bundle.get('k') != 'sis-sync':
            fail('bad_args', 'not a sis-sync bundle')
        if (bundle.get('schema') or 0) > 7:
            fail('bad_args', 'bundle schema newer than this store')
        applied, skipped, conflicts = 0, 0, []
        with tx(db):
            for i in bundle.get('issues') or []:
                iid = i.get('id')
                if not iid:
                    skipped += 1
                    continue
                row = issue(db, iid)
                if row and row['status'] != 'closed' and (row['lease_until'] or 0) > time.time():
                    conflicts.append({'id': iid, 'reason': 'active_claim',
                                      'actor': row['claim_actor']})
                    continue
                meta_j = i.get('meta_json') or (canonical(i['meta']) if isinstance(i.get('meta'), dict) else None)
                db.execute('INSERT OR REPLACE INTO issues(id,title,status,priority,type,owner,oracle_cmd,allowed_paths,lane,budget_eur,acceptance,"desc",lease_until,lease_epoch,claim_actor,created_at,closed_at,defer_until,expires_at,meta_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                           (iid, i.get('title') or '', i.get('status') or 'open',
                            i.get('priority', 2), i.get('type') or 'task',
                            i.get('owner'), i.get('oracle_cmd'),
                            i.get('allowed_paths') if isinstance(i.get('allowed_paths'), str) else canonical(i.get('allowed_paths') or []),
                            i.get('lane'), i.get('budget_eur'), i.get('acceptance'),
                            i.get('desc') or i.get('description'), i.get('lease_until'),
                            i.get('lease_epoch', 0), i.get('claim_actor'),
                            i.get('created_at'), i.get('closed_at'),
                            i.get('defer_until'), i.get('expires_at'), meta_j))
                db.execute('DELETE FROM deps WHERE issue=?', (iid,))
                for d in i.get('deps') or []:
                    on = d.get('on') or d.get('depends_on')
                    if on:
                        db.execute('INSERT OR IGNORE INTO deps(issue,depends_on,type) VALUES(?,?,?)',
                                   (iid, on, d.get('type') or 'blocks'))
                applied += 1
            mem = 0
            for m in bundle.get('memories') or []:
                if m.get('key') is not None and m.get('value') is not None:
                    mem += db.execute('INSERT INTO memories(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE excluded.updated_at>memories.updated_at',
                                      (m['key'], m['value'], m.get('updated_at') or time.time())).rowcount
            # receipts merge by primary key — never overwrite (a receipt is an
            # append-only fact bound to actor+epoch+revision+source).
            proofs = 0
            for p in bundle.get('proofs') or []:
                if not p.get('proof_id'):
                    continue
                proofs += db.execute('INSERT OR IGNORE INTO proofs(proof_id,issue,actor,epoch,revision,source_hash,cwd,oracle,exitcode,passed,timed_out,output,review_receipt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                                     (p['proof_id'], p.get('issue'), p.get('actor'),
                                      p.get('epoch', 0), p.get('revision'),
                                      p.get('source_hash'), p.get('cwd'),
                                      p.get('oracle'), p.get('exitcode'),
                                      p.get('passed', 0), p.get('timed_out', 0),
                                      p.get('output'),
                                      p.get('review_receipt') or 'null')).rowcount
            attests = 0
            for t in bundle.get('attests') or []:
                if not t.get('attest_id'):
                    continue
                attests += db.execute('INSERT OR IGNORE INTO attests(attest_id,issue,actor,epoch,revision,source_hash,cwd,kind,payload,summary,passed,ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                                      (t['attest_id'], t.get('issue'), t.get('actor'),
                                       t.get('epoch', 0), t.get('revision'),
                                       t.get('source_hash'), t.get('cwd'),
                                       t.get('kind'), t.get('payload') or 'null',
                                       t.get('summary') or 'null',
                                       t.get('passed', 0),
                                       t.get('ts') or time.time())).rowcount
            emit(db, 'sync_import', None, c, {'applied': applied, 'skipped': skipped,
                                             'conflicts': len(conflicts), 'memories': mem,
                                             'proofs': proofs, 'attests': attests,
                                             'remote_project': bundle.get('project_id')})
            return finish(db, c, 'sync_import', {'applied': applied, 'skipped': skipped,
                          'conflicts': conflicts, 'memories': mem,
                          'proofs': proofs, 'attests': attests,
                          'remote_project': bundle.get('project_id')})

    def op_spans(db, a, c):
        path = s.get('_emit_path', lambda _d: None)(c.get('db_path'))
        if not path:
            return {'enabled': False, 'spans': []}
        limit = integer(a.get('limit', 100), 'limit', 1, 500)
        try:
            lines = open(path).read().splitlines()
        except OSError:
            lines = []
        spans = [json.loads(l) for l in lines[-limit:] if l.strip()]
        return {'enabled': True, 'path': path, 'spans': spans}

    def op_unclaim(db, a, c):
        with tx(db):
            row = fence(db, a, c, allow_cancel=True)
            db.execute("UPDATE issues SET status='open',claim_actor=NULL,lease_until=NULL,lease_epoch=lease_epoch+1 WHERE id=?", (row['id'],))
            db.execute('DELETE FROM claims WHERE issue=?', (row['id'],))
            emit(db, 'unclaim', row['id'], c, {})
            return finish(db, c, 'unclaim', {'ok': True})

    def controller(row, who):
        return who in (row.get('owner'), meta(row).get('controller'))

    def op_cancel(db, a, c):
        who = actor(a, c)
        with tx(db):
            row = issue(db, a.get('id'))
            if not row:
                fail('not_found', str(a.get('id')))
            if who != meta(row).get('controller'):
                fence(db, a, c, allow_cancel=True)
            db.execute('INSERT INTO cancellations(issue,requested,actor,ts) VALUES(?,1,?,?) ON CONFLICT(issue) DO UPDATE SET requested=1,actor=excluded.actor,ts=excluded.ts', (row['id'], who, time.time()))
            emit(db, 'cancel', row['id'], c, {})
            return finish(db, c, 'cancel', {'ok': True, 'cancel_requested': True})

    def op_cancel_ack(db, a, c):
        with tx(db):
            row = fence(db, a, c, allow_cancel=True)
            if not cancelled(db, row['id']):
                fail('bad_state', 'cancellation intent required')
            db.execute("UPDATE issues SET status='cancelled',claim_actor=NULL,lease_until=NULL,lease_epoch=lease_epoch+1 WHERE id=?", (row['id'],))
            db.execute('DELETE FROM claims WHERE issue=?', (row['id'],))
            emit(db, 'cancel_ack', row['id'], c, {})
            return finish(db, c, 'cancel_ack', {'ok': True})

    def op_reopen(db, a, c):
        who = actor(a, c)
        with tx(db):
            row = issue(db, a.get('id'))
            if not row:
                fail('not_found', str(a.get('id')))
            if not controller(row, who):
                admin(a)
            if a.get('epoch') is not None and epoch(a) != row['lease_epoch']:
                fail('stale_fence', 'epoch differs')
            db.execute("UPDATE issues SET status='open',claim_actor=NULL,lease_until=NULL,closed_at=NULL,lease_epoch=lease_epoch+1 WHERE id=?", (row['id'],))
            db.execute('DELETE FROM claims WHERE issue=?', (row['id'],))
            db.execute('INSERT INTO cancellations(issue,requested,actor,ts) VALUES(?,0,?,?) ON CONFLICT(issue) DO UPDATE SET requested=0,actor=excluded.actor,ts=excluded.ts', (row['id'], who, time.time()))
            emit(db, 'reopen', row['id'], c, {'reason': a.get('reason')})
            return finish(db, c, 'reopen', {'ok': True})

    def op_checkpoint(db, a, c):
        text, next_step = a.get('text'), a.get('next_step')
        if not isinstance(text, str) or not isinstance(next_step, str) or not next_step.strip():
            fail('bad_args', 'checkpoint needs text and next_step')
        artifacts = a.get('artifacts', [])
        if not isinstance(artifacts, list) or len(canonical({'text': text, 'next_step': next_step, 'artifacts': artifacts}).encode()) > 16384:
            fail('bad_args', 'checkpoint exceeds 16 KiB or artifacts is not an array')
        with tx(db):
            row = fence(db, a, c)
            check_revision(db, a)
            dbpath = db.execute('PRAGMA database_list').fetchone()[2]
            cwd = a.get('cwd') or c.get('project_root') or str(Path(dbpath).resolve().parent.parent if Path(dbpath).parent.name == '.sis' else Path(dbpath).resolve().parent)
            source, cwd = fingerprint(db, row, cwd)
            revision = contract(db, row['id'])['revision']
            cur = db.execute('INSERT INTO checkpoints(issue,actor,epoch,revision,source_hash,cwd,text,next_step,artifacts,ts) VALUES(?,?,?,?,?,?,?,?,?,?)', (row['id'], actor(a, c), epoch(a), revision, source, cwd, text, next_step, canonical(artifacts), time.time()))
            emit(db, 'checkpoint', row['id'], c, {'checkpoint_id': cur.lastrowid, 'revision': revision, 'source_hash': source})
            return finish(db, c, 'checkpoint', {'ok': True, 'checkpoint_id': cur.lastrowid, 'revision': revision, 'source_hash': source})

    def op_handoff(db, a, c):
        # checkpoint + lease release in one step: the next agent can claim
        # immediately instead of waiting out the lease TTL. `to` names the
        # intended successor (advisory, searchable in history).
        r = op_checkpoint(db, a, c)
        op_unclaim(db, a, c)
        with tx(db):
            emit(db, 'handoff', a.get('id'), c,
                 {'to': a.get('to'), 'next_step': a.get('next_step')})
            return finish(db, c, 'handoff',
                          {'ok': True, 'released': True,
                           'checkpoint_id': r.get('checkpoint_id')})

    def op_who(db, a, c):
        # dirty-worktree attribution: map each dirty/untracked path to the
        # recorded changes event (and hence claim/actor) that produced it.
        # Orphaned paths (no matching event) surface explicitly.
        repo = Path(a.get('repo') or '.').resolve()
        top = _git(repo, 'rev-parse', '--show-toplevel')
        if not top:
            fail('not_a_git_repo', f'{repo} is not inside a git worktree')
        root = Path(top.strip())
        head = _git(root, 'rev-parse', 'HEAD')
        branch = (_git(root, 'branch', '--show-current') or '').strip() or None
        # contract-scope fallback: open/in-progress issues whose
        # allowed_paths cover the file — declared (weaker) attribution.
        scope_rows = []
        for r in db.execute(
                "SELECT id,status,claim_actor,allowed_paths FROM issues"
                " WHERE status IN ('in_progress','open')"
                "   AND allowed_paths IS NOT NULL AND allowed_paths != ''"):
            try:
                stored = r[3]
                ps = json.loads(stored) if stored.lstrip().startswith('[') else [stored]
            except (ValueError, AttributeError):
                continue
            entries = []
            for e in (ps if isinstance(ps, list) else [ps]):
                if isinstance(e, str):
                    e = e.strip().removeprefix('./').removesuffix('**').rstrip('/')
                    if e:
                        entries.append(e)
            if entries:
                scope_rows.append((r[0], r[1], r[2], entries))
        dirty, by_issue = [], {}
        for line in (_git(root, 'status', '--porcelain', '-uall') or '').splitlines():
            if len(line) < 4:
                continue
            st, rest = line[:2].strip(), line[3:]
            renamed_from = None
            if ' -> ' in rest:
                old, rest = rest.split(' -> ', 1)
                renamed_from = old.strip()
            path = rest.strip().rstrip('/')
            if not path:
                continue
            claims = [{'issue': r[0], 'seq': r[1], 'actor': r[2],
                       'status': r[3], 'claim_actor': r[4],
                       'via': 'changes'} for r in db.execute(
                "SELECT e.issue,e.seq,e.actor,i.status,i.claim_actor,"
                "json_extract(e.data_json,'$.head_subject') AS head_subject"
                " FROM events e JOIN issues i ON i.id=e.issue"
                " JOIN (SELECT issue,MAX(seq) s FROM events WHERE op='changes' GROUP BY issue) latest"
                "   ON latest.issue=e.issue AND latest.s=e.seq"
                " WHERE EXISTS (SELECT 1 FROM json_each(e.data_json,'$.files') f"
                "             WHERE json_extract(f.value,'$.path')=?)", (path,)).fetchall()]
            if not claims:
                claims = [{'issue': i, 'status': s, 'claim_actor': a,
                           'actor': None, 'via': 'scope'}
                          for (i, s, a, entries) in scope_rows
                          if any(path == e or path.startswith(e + '/')
                                 for e in entries)]
            for cl in claims:
                k = (cl['issue'], cl['actor'], cl['status'], cl['claim_actor'])
                e = by_issue.setdefault(cl['issue'],
                        {'issue': cl['issue'], 'actor': cl['actor'],
                         'status': cl['status'], 'claim_actor': cl['claim_actor'], 'files': 0})
                e['files'] += 1
            entry = {'path': path, 'status': st, 'claims': claims}
            if renamed_from:
                entry['renamed_from'] = renamed_from
            dirty.append(entry)
        orphaned = [d['path'] for d in dirty if not d['claims']]
        return finish(db, c, 'who', {
            'repo': str(root), 'head': (head or '').strip() or None,
            'branch': branch, 'dirty': dirty,
            'summary': {'dirty': len(dirty),
                        'matched': len(dirty) - len(orphaned),
                        'by_issue': list(by_issue.values()),
                        'orphaned': orphaned}})

    def events_since(db, ident, since=None, limit=100):
        since = integer(0 if since is None else since, 'since')
        return [s['_edict'](r) for r in db.execute('SELECT seq,ts,op,issue,actor,run_id,idem,data_json FROM events WHERE issue=? AND seq>? ORDER BY seq LIMIT ?', (ident, since, limit))]

    def op_resume(db, a, c):
        ident = a.get('id')
        task = op_contract(db, a, c)
        state = db.execute('SELECT cancel_requested,attempt,last_error FROM agent_state WHERE issue=?', (ident,)).fetchone() or (0, 0, None)
        events = events_since(db, ident, a.get('since'))
        latest = db.execute(
            "SELECT data_json FROM events WHERE issue=? AND op='changes' "
            "ORDER BY seq DESC LIMIT 1", (ident,)).fetchone()
        changes = None
        if latest and latest[0]:
            try:
                changes = json.loads(latest[0])
            except ValueError:
                pass
        return {'id': ident, 'contract': task, 'checkpoint': checkpoint_latest(db, ident),
                'cancel_requested': cancelled(db, ident), 'attempt': state[1], 'last_error': state[2],
                'changes': changes,
                'run_state': s['_run_state'](db, ident, issue(db, ident)),
                'events': events, 'cursor': events[-1]['seq'] if events else a.get('since', 0)}

    def page(rows, a):
        limit = integer(a.get('limit', 1000), 'limit', 1, 1000)
        cursor_requested = 'cursor' in a or a.get('paginate') is True
        cursor = a.get('cursor')
        if cursor not in (None, ''):
            try:
                item = json.loads(cursor)
                value = [item['priority'], item['created_at'], item['id']]
                if not isinstance(value, list) or len(value) != 3 or isinstance(value[0], bool) or not isinstance(value[0], (float, int)) or not isinstance(value[1], (float, int)) or not isinstance(value[2], str) or not all(math.isfinite(x) for x in value[:2]):
                    raise ValueError('invalid ordering tuple')
            except (ValueError, TypeError, AttributeError, UnicodeError, KeyError):
                fail('bad_cursor', 'cursor must encode priority,created_at,id')
            rows = [r for r in rows if (r['priority'], r['created_at'], r['id']) > tuple(value)]
        more = len(rows) > limit
        rows = rows[:limit]
        next_cursor = None
        if more and rows:
            r = rows[-1]
            next_cursor = canonical({key:r[key] for key in ('priority','created_at','id')})
        fields = a.get('fields')
        if fields is not None:
            if not isinstance(fields, list) or any(not isinstance(k, str) or k not in s['ICOLS'] for k in fields):
                fail('bad_args', 'fields must be an array of issue field names')
            rows = [{k: r[k] for k in fields} for r in rows]
        return {'items': rows, 'next_cursor': next_cursor} if cursor_requested else rows

    def selected_page(db, a, where, parameters):
        limit = integer(a.get('limit',1000),'limit',1,1000)
        if a.get('cursor') not in (None,''):
            try:
                cur=json.loads(a['cursor'])
                priority=integer(cur['priority'],'cursor priority',-9223372036854775808,9223372036854775807)
                created=finite(cur['created_at'],'cursor timestamp')
                ident=cur['id']
                if not isinstance(ident,str):
                    raise ValueError('invalid id')
            except (ValueError,TypeError,KeyError):
                fail('bad_cursor','malformed cursor')
            where += ' AND (i.priority,i.created_at,i.id)>(?,?,?)'
            parameters.extend((priority,created,ident))
        sql=f"SELECT {s['ISEL_I']} FROM issues i"+where+' ORDER BY i.priority,i.created_at,i.id LIMIT ?'
        rows=s['_idicts'](db.execute(sql,parameters+[limit+1]))
        return page(rows,a)

    def op_ready(db, a, c):
        now=time.time()
        where=' WHERE '+s['READY_PRED']+' AND '+s['BLOCKED_SQL']
        parameters=[now,now,now]
        if a.get('lane') is not None:
            where+=' AND i.lane=?'
            parameters.append(a['lane'])
        if a.get('goal') is not None:
            where+=" AND i.id IN (WITH RECURSIVE sub(x) AS (SELECT ? UNION SELECT child.id FROM issues child JOIN sub parent ON json_extract(child.meta_json,'$.parent')=parent.x OR (child.id LIKE parent.x||'.%' AND instr(substr(child.id,length(parent.x)+2),'.')=0)) SELECT x FROM sub)"
            parameters.append(a['goal'])
        return selected_page(db,a,where,parameters)

    def op_list(db, a, c):
        where,parameters=s['_list_where'](a)
        rows=selected_page(db,a,where,parameters)
        items=rows['items'] if isinstance(rows,dict) else rows
        for r in items:
            latest=db.execute("SELECT data_json FROM events WHERE issue=? AND op='changes' ORDER BY seq DESC LIMIT 1",(r.get('id'),)).fetchone()
            if latest and latest[0]:
                try:r['changes']=json.loads(latest[0]).get('files')
                except ValueError:pass
        s['_attach_run_state'](db,items)
        if isinstance(rows,dict):rows['items']=items
        return rows

    def op_show(db, a, c):
        result = original['op_show'](db, a, c)
        task = contract(db, a.get('id'))
        result['revision'], result['blocked_by'] = task['revision'], task['blocked_by']
        result['attests'] = [dict(zip(
            ('attest_id', 'actor', 'epoch', 'revision', 'source_hash', 'kind',
             'summary', 'passed', 'ts'), r)) for r in db.execute(
            'SELECT attest_id,actor,epoch,revision,source_hash,kind,summary,passed,ts '
            'FROM attests WHERE issue=? ORDER BY ts DESC LIMIT 10', (a.get('id'),))]
        return result

    def op_plan(db, a, c):
        subs = a.get('subs') or []
        if a.get('template'):
            saved = db.execute('SELECT value FROM memories WHERE key=?', ('template:' + str(a['template']),)).fetchone()
            if not saved:
                fail('not_found', 'plan template not found')
            subs = json.loads(saved[0]).get('subs')
        if not isinstance(subs, list) or any(not isinstance(sub, dict) for sub in subs):
            fail('bad_args', 'subs must be an array of objects')
        for index, sub in enumerate(subs):
            if not isinstance(sub.get('deps', []), list):
                fail('bad_args', 'plan dependency indices must be an array')
            for dep in sub.get('deps', []):
                integer(dep, 'dependency index', 0, len(subs) - 1)
                if dep == index:
                    fail('dep_cycle', 'plan dependency cannot reference itself')
        with tx(db):
            cc = dict(c, idem=None)
            goal = s['op_goal'](db, a, cc)['id']
            ids = [s['op_sub'](db, dict(sub, parent=goal), cc)['id'] for sub in subs]
            for index, sub in enumerate(subs):
                for dep in sub.get('deps', []):
                    s['op_dep'](db, {'issue': ids[index], 'depends_on': ids[dep]}, cc)
            if a.get('save_as'):
                s['op_remember'](db, {'key': 'template:' + str(a['save_as']), 'value': {'name': a.get('name'), 'subs': subs}}, cc)
            return finish(db, c, 'plan', {'goal': goal, 'name': a.get('name'), 'children': ids})

    def op_batch(db, a, c):
        ops = a.get('ops')
        if not isinstance(ops, list):
            fail('bad_args', 'batch needs ops array')
        results = []
        with tx(db):
            for op in ops:
                if not isinstance(op, dict) or not isinstance(op.get('cmd'), str):
                    fail('bad_args', 'batch child needs cmd and args')
                child = op['cmd'].replace('-', '_')
                if child in ('verify', 'batch') or (child == 'attest' and (op.get('args') or {}).get('kind') == 'run'):
                    fail('bad_args', 'verification, run attest and nested batch are forbidden in batch')
                cc = dict(c, idem=op.get('idem'), run_id=op.get('run_id', c.get('run_id')))
                results.append(dispatch(db, op['cmd'], op.get('args'), cc))
            return finish(db, c, 'batch', {'results': results})

    def op_slot_acquire(db, a, c):
        who = actor(a, c)
        ttl(a)
        held = db.execute('SELECT holder,epoch,lease_until,claim_id FROM slots WHERE name=?', (a.get('name'),)).fetchone()
        if held and held[0] == who and (held[2] or 0) > time.time():
            return finish(db, c, 'slot_acquire', {'name': a.get('name'), 'holder': who,
                          'epoch': held[1], 'lease_until': held[2], 'claim_id': held[3]})
        return original['op_slot_acquire'](db, a, c)

    def op_slot_release(db, a, c):
        who, e = actor(a, c), epoch(a)
        with tx(db):
            row = db.execute('SELECT holder,epoch,lease_until FROM slots WHERE name=?', (a.get('name'),)).fetchone()
            if not row:
                fail('not_found', str(a.get('name')))
            if row[0] != who or row[1] != e or (row[2] or 0) <= time.time():
                fail('stale_fence', 'slot holder, epoch and lease must match')
            db.execute('UPDATE slots SET holder=NULL,lease_until=NULL,claim_id=NULL,updated_at=? WHERE name=?', (time.time(), a['name']))
            emit(db, 'slot_release', None, c, {'name': a['name'], 'epoch': e})
            return finish(db, c, 'slot_release', {'name': a['name'], 'released': True})

    def op_capabilities(db, a, c):
        project_id = db.execute("SELECT v FROM kv WHERE k='project_id'").fetchone()[0]
        registry = operation_registry()
        result = {'version': '0.9.1', 'protocol': 2, 'schema': 8, 'schema_version': 8,
                  'project_id': project_id, 'operations': [op['name'] for op in registry],
                  'encodings': ['o200k_base', 'cl100k_base'], 'proof_receipts': True,
                  'billing': False, 'token_billing': False, 'local_zero_execution': True,
                  'durability': db.execute('PRAGMA synchronous').fetchone()[0]}
        if a.get('schemas') is True:
            result['ops'] = registry
        return result

    def op_context(db, a, c):
        capabilities = op_capabilities(db, a, c)
        return {'project_id': capabilities['project_id'],
                'pid': os.getpid(), 'instance_id': INSTANCE_ID,
                'db_path': str(Path(db.execute('PRAGMA database_list').fetchone()[2]).resolve()),
                'capabilities': capabilities, 'stats': s['op_stats'](db, a, c)}

    def op_prime(db, a, c):
        return {'protocol':'Superiss 0.9; explicit project DB; NDJSON Unix socket or CLI',
                'loop':'acquire(actor) -> work inside contract -> verify(id,actor,epoch,cwd) -> close(id,actor,epoch,proof_id) -> readback',
                'rules':['executable oracle and satisfied dependencies before dispatch','heartbeat before lease expiry',
                         'checkpoint and resume for recovery','mandatory acceptance survives token budgets',
                         'no mutation retry after uncertain transport'], 'capabilities':op_capabilities(db,{},c)}

    def cached(db, cmd, c):
        r = db.execute('SELECT v FROM kv WHERE k=?', ('idem:' + str(c['idem']),)).fetchone()
        if not r:
            return False, None
        value = json.loads(r[0])
        if value.get('cmd') != cmd or value.get('actor') != c['actor'] or value.get('payload_hash') != c['payload_hash']:
            fail('idem_conflict', 'idempotency key reused for a different command, actor or payload')
        return True, value['data']

    def dispatch(db, cmd, args, ctx):
        if not isinstance(cmd, str):
            fail('bad_cmd', str(cmd))
        cmd = cmd.replace('-', '_')
        fn = s['OPS'].get(cmd)
        if fn is None:
            fail('bad_cmd', cmd)
        a = s['_coerce_args'](cmd, args)
        if cmd in ('admin_update', 'import', 'sync_import'):
            admin(a)
        if cmd in ('defer', 'undefer', 'delete', 'rename'):
            ident = a.get('id') or a.get('from')
            row = issue(db, ident)
            if row and row['status'] == 'in_progress':
                fence(db, dict(a, id=ident), ctx, allow_cancel=True)
        c = dict(ctx)
        c['_actor_explicit'] = c.get('_actor_explicit', c.get('actor') is not None)
        for key in ('actor', 'run_id', 'idem'):
            if a.get(key) is not None:
                c[key] = a[key]
                if key == 'actor':
                    c['_actor_explicit'] = True
            c.setdefault(key, None)
        if c['actor'] is None:
            c['actor'] = 'socket'
        c['payload_hash'] = hashlib.sha256(canonical({k: v for k, v in a.items() if k not in ('idem', 'admin_token')}).encode()).hexdigest()
        mutating = cmd in s['MUT']
        # The verifier executes outside all write transactions.
        if cmd == 'verify' or (cmd == 'attest' and a.get('kind') == 'run'):
            with verification_lock(db, a, c):
                if c.get('idem') is not None:
                    exists, data = cached(db, cmd, c)
                    if exists:
                        return data
                data = fn(db, a, c)
            notify()
            return data
        if mutating:
            outermost = not db.in_transaction
            with tx(db):
                if c.get('idem') is not None:
                    exists, data = cached(db, cmd, c)
                    if exists:
                        return data
                try:
                    data = fn(db, a, c)
                except s['sqlite3'].IntegrityError as exc:
                    fail('exists' if cmd in ('create', 'q') else 'conflict', str(exc))
                # Legacy composite ops may finish under a canonical alias.
                if c.get('idem') is not None:
                    db.execute('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v',
                               ('idem:' + str(c['idem']), canonical({'cmd': cmd, 'actor': c['actor'], 'payload_hash': c['payload_hash'], 'data': data})))
            if outermost:
                notify()
            return data
        return fn(db, a, c)

    @contextlib.contextmanager
    def verification_lock(db, a, c):
        if db.in_transaction:
            fail('bad_args', 'verify cannot run inside batch')
        if c.get('idem') is None:
            yield
            return
        path = Path(db.execute('PRAGMA database_list').fetchone()[2]).resolve()
        folder = path.parent / '.sis' / 'verify-locks'
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock = folder / hashlib.sha256((str(path) + '\0' + str(c['idem'])).encode()).hexdigest()
        fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
        deadline = time.monotonic() + finite(a.get('timeout_secs', 10), 'timeout_secs', 1, 300) + 5
        try:
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        fail('busy', 'bounded wait for matching verification exceeded')
                    time.sleep(.025)
            yield
        finally:
            os.close(fd)

    overrides = {'connect': connect, 'finish': finish, 'dispatch_op': dispatch,
                 'op_create': op_create, 'op_update': op_update,
                 'op_contract': op_contract, 'op_show': op_show,
                 'op_import': op_import, 'op_budget_claim': op_budget_claim,
                 'op_plan': op_plan, 'op_batch': op_batch, 'op_reopen': op_reopen,
                 'op_ready': op_ready, 'op_next': op_ready, 'op_list': op_list,
                 'op_heartbeat': op_heartbeat, 'op_close': op_close,
                 'op_unclaim': op_unclaim, 'op_slot_acquire': op_slot_acquire,
                 'op_slot_release': op_slot_release, 'op_who': op_who}
    s.update(overrides)
    operations = {name[3:]: fn for name, fn in overrides.items() if name.startswith('op_')}
    operations.update({'claim': lambda db, a, c: grant(db, a, c, 'claim'),
        'claim_next': lambda db, a, c: grant(db, a, c, 'claim_next'),
        'acquire': lambda db, a, c: grant(db, a, c, 'acquire'),
        'brief': op_brief, 'tokens': lambda db, a, c: token_count(a),
        'verify': op_verify, 'checkpoint': op_checkpoint, 'resume': op_resume,
        'handoff': op_handoff, 'who': op_who,
        'cancel': op_cancel, 'cancel_ack': op_cancel_ack,
        'admin_update': op_admin_update, 'capabilities': op_capabilities, 'context': op_context, 'prime': op_prime,
        'query': op_list, 'q': op_create, 'merge_slot': op_slot_acquire,
        'attest': op_attest, 'cost_add': op_cost_add, 'cost_list': op_cost_list,
        'cost_rollup': op_cost_rollup, 'outbox_export': op_outbox_export,
        'outbox_done': op_outbox_done, 'outbox_fail': op_outbox_fail,
        'sync_export': op_sync_export, 'sync_import': op_sync_import,
        'spans': op_spans, 'learn': op_learn})
    s['OPS'].update(operations)
    s['MUT'].update({'acquire', 'verify', 'checkpoint', 'handoff', 'cancel', 'cancel_ack', 'admin_update',
        'unclaim', 'defer', 'undefer', 'label', 'tag', 'rename', 'delete', 'note', 'comment', 'dep_remove',
        'attest', 'cost_add', 'outbox_export', 'sync_import'})
    s['MUT'].discard('goal_done')
    s['POS'].update({'acquire': ['actor'], 'brief': ['id'], 'tokens': ['text'],
        'verify': ['id', 'actor', 'epoch', 'cwd'], 'checkpoint': ['id', 'actor', 'epoch', 'text', 'next_step'],
        'handoff': ['id', 'actor', 'epoch', 'text', 'next_step'],
        'resume': ['id'], 'cancel': ['id', 'actor', 'epoch'], 'cancel_ack': ['id', 'actor', 'epoch'],
        'admin_update': ['id'], 'unclaim': ['id', 'actor', 'epoch'],
        'attest': ['id', 'actor', 'epoch', 'kind'],
        'cost_add': ['issue', 'tokens_in', 'tokens_out', 'cents'],
        'cost_rollup': ['id'], 'outbox_export': ['format', 'limit'],
        'sync_import': ['path'], 'learn': ['group_by', 'since']})
    s['POS']['who'] = ['repo']
    s['READS'].add('who')
    s['READS'].update({'cost_list', 'cost_rollup', 'sync_export', 'spans', 'learn'})
    s['VERSION'] = '0.9.1'


def notify():
    global EVENT_GENERATION
    with EVENT_CONDITION:
        EVENT_GENERATION += 1
        EVENT_CONDITION.notify_all()
