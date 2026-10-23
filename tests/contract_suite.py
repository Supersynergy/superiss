#!/usr/bin/env python3
"""gq contract suite — impl-agnostic checker for SPEC v0.1.

Usage:
  python3 contract_suite.py --serve-cmd "python3 /path/superiss.py serve"
  python3 contract_suite.py --serve-cmd "cargo /path/superiss.rs serve" [--db /tmp/x.db]

Launches the serve subprocess (env SIS_DB/SIS_SOCK point at fresh temp paths),
waits for socket readiness (connect-probe <=10s), runs every SPEC §6 invariant
as a named check, then a §3 op-coverage smoke. Prints PASS/FAIL/MISSING per
check plus an evidence line. Exit 1 if any check FAILs.

Speaks the SPEC §4 wire protocol only: one line {"cmd","args":{...}} in,
one line {"ok":true,"data":...} / {"ok":false,"error":{code,msg}} out.
Response parsing is tolerant of the legacy {"ok":<payload>} / {"err":msg}
shape so partial implementations report real gaps instead of parse crashes.
"""
import argparse, json, os, shlex, signal, socket, subprocess, sys
import tempfile, threading, time

# SPEC §3 op list (authoritative).
OPS = ["create", "dep", "dep_list", "dep_remove", "ready", "list", "query",
       "count", "update", "note", "comments", "history", "claim",
       "claim_next", "unclaim", "reclaim", "heartbeat", "close", "reopen",
       "delete", "defer", "undefer", "show", "search", "children", "label",
       "rename", "lint", "types", "statuses", "prime", "watch", "stale",
       "orphans", "stats", "remember", "recall", "export", "import", "batch",
       "budget_claim", "contract", "outbox_list", "outbox_done", "outbox_fail",
       "compact", "gate", "gate_list", "epic", "dup_scan", "q",
       "slot_acquire", "slot_release", "slot_list",
       "goal", "sub", "plan", "goal_tree", "next", "review", "goal_done"]
registry_path = os.path.join(os.path.dirname(__file__), "..", "ops.json")
if os.path.isfile(registry_path):
    with open(registry_path) as registry_file:
        OPS = [op["name"] for op in json.load(registry_file)["ops"]]


class TransErr(Exception):
    """Transport failure: connect/read/parse broke."""


class Missing(Exception):
    """Op reported unknown — check cannot run (spec gap)."""


class OpErr(Exception):
    """Op exists but returned an error we did not expect."""


class R:
    __slots__ = ("ok", "data", "code", "msg")

    def __init__(self, ok, data=None, code=None, msg=None):
        self.ok, self.data, self.code, self.msg = ok, data, code, msg or ""

    @property
    def missing(self):
        return (not self.ok and (self.code == "bad_cmd"
                or "unknown cmd" in self.msg.lower()
                or "bad_cmd" in self.msg.lower()))

    def __repr__(self):
        return ("R(ok=%r)" % self.data) if self.ok else \
               ("R(err %s: %s)" % (self.code, self.msg[:80]))


def parse(line):
    """Normalize spec + legacy response shapes into R."""
    try:
        r = json.loads(line)
    except Exception as e:
        raise TransErr("bad json: %r (%s)" % (line[:120], e))
    if not isinstance(r, dict):
        raise TransErr("non-dict response: %r" % (r,))
    if "err" in r:                                  # legacy {err:msg}
        return R(False, code="err", msg=str(r["err"]))
    if r.get("ok") is True:
        return R(True, data=r.get("data"))
    if r.get("ok") is False:
        e = r.get("error") or {}
        if not isinstance(e, dict):
            e = {"code": "err", "msg": str(e)}
        return R(False, code=e.get("code", "err"), msg=str(e.get("msg", "")))
    if "ok" in r:                                   # legacy {ok:<payload>}
        return R(True, data=r["ok"])
    if "error" in r:
        e = r["error"] or {}
        return R(False, code=e.get("code", "err"),
                 msg=str(e.get("msg", "")))
    raise TransErr("unrecognized response shape: %r" % (r,))


class Conn:
    """One persistent socket connection; call() = write line, read line."""

    def __init__(self, path, timeout=15.0, retry_s=2.0):
        """Connect with a bounded retry on ECONNREFUSED/ENOENT — absorbs
        listen-backlog bursts and stale-file windows around restarts."""
        t0, last = time.time(), None
        while True:
            self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.s.settimeout(timeout)
            try:
                self.s.connect(path)
                break
            except OSError as e:
                last = e
                self.s.close()
                if time.time() - t0 > retry_s or not isinstance(
                        e, (ConnectionRefusedError, FileNotFoundError)):
                    raise TransErr("connect %s: %s" % (path, e))
                time.sleep(0.03)
        self.f = self.s.makefile("rb")

    def call(self, cmd, args=None):
        req = {"cmd": cmd, "args": args or {}}
        try:
            self.s.sendall(json.dumps(req).encode() + b"\n")
            line = self.f.readline()
        except OSError as e:
            raise TransErr("%s io: %s" % (cmd, e))
        if not line:
            raise TransErr("%s: empty response" % cmd)
        return parse(line)

    def close(self):
        try:
            self.f.close()
        except Exception:
            pass
        try:
            self.s.close()
        except Exception:
            pass


def call(sock, cmd, args=None):
    c = Conn(sock)
    try:
        return c.call(cmd, args)
    finally:
        c.close()


def need(r, what=""):
    """Unwrap R → data; raise Missing/OpErr on error."""
    if r.missing:
        raise Missing(what or "op")
    if not r.ok:
        raise OpErr("%s → %s: %s" % (what, r.code, r.msg[:100]))
    return r.data


# ---- shape-tolerant field extractors --------------------------------------

def issue_id(x):
    if isinstance(x, dict):
        return x.get("id")
    if isinstance(x, str):
        return x
    if isinstance(x, (list, tuple)) and x:
        return x[0]
    return None


def ev_op(e):
    if isinstance(e, dict):
        return e.get("op") or e.get("kind")
    if isinstance(e, (list, tuple)) and len(e) > 2:
        return e[2]
    return None


def ev_seq(e):
    if isinstance(e, dict):
        v = e.get("seq")
        return v if isinstance(v, (int, float)) else None
    if isinstance(e, (list, tuple)) and e and isinstance(e[0], (int, float)):
        return e[0]
    return None


def show_events(data):
    if isinstance(data, dict):
        iss = data.get("issue")
        if isinstance(iss, dict) and isinstance(iss.get("events_tail"), list):
            return iss["events_tail"]
        for k in ("events_tail", "events", "history"):
            if isinstance(data.get(k), list):
                return data[k]
    return []


def stats_total(d):
    if not isinstance(d, dict):
        return None
    if isinstance(d.get("total"), (int, float)):
        return d["total"]
    vals = [v for v in d.values() if isinstance(v, (int, float))]
    return sum(vals) if vals else None


def ready_ids(data):
    if not isinstance(data, list):
        return []
    return [issue_id(i) for i in data]


# ---- server lifecycle ------------------------------------------------------

class Srv:
    def __init__(self, cmd, db, sock, logdir):
        self.cmd, self.db, self.sock = cmd, db, sock
        self.logpath = os.path.join(logdir, "serve.log")
        self.proc = None

    def env(self):
        e = dict(os.environ)
        e["SIS_DB"], e["SIS_SOCK"] = self.db, self.sock
        return e

    def spawn(self):
        """Popen a serve proc without tracking it as the primary."""
        lf = open(self.logpath, "ab")
        return subprocess.Popen(shlex.split(self.cmd), env=self.env(),
                                stdout=lf, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL)

    def start(self):
        self.proc = self.spawn()
        return self.proc

    def wait_ready(self, timeout=10.0):
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self.proc and self.proc.poll() is not None:
                tail = ""
                try:
                    tail = open(self.logpath).read()[-300:].strip()
                except Exception:
                    pass
                raise OpErr("serve exited rc=%s before ready. log: %s"
                            % (self.proc.returncode, tail))
            try:
                call(self.sock, "stats", {})
                return time.time() - t0
            except TransErr:
                time.sleep(0.05)
        raise OpErr("socket %s not ready in %.1fs" % (self.sock, timeout))

    def alive(self):
        try:
            call(self.sock, "stats", {})
            return True
        except TransErr:
            return False

    def restart(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(10)
        self.start()
        return self.wait_ready()

    def kill9(self):
        if self.proc and self.proc.poll() is None:
            os.kill(self.proc.pid, signal.SIGKILL)
            self.proc.wait(10)

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.kill9()


# ---- check plumbing ---------------------------------------------------------

CHECKS = []
_ctx = {"n": 0}


def check(name):
    def deco(fn):
        CHECKS.append((name, fn))
        return fn
    return deco


def mkissue(srv, tag, **kw):
    _ctx["n"] += 1
    scope = os.path.join(os.path.dirname(srv.logpath), "oracle-input.txt")
    if not os.path.exists(scope):
        with open(scope, "w") as fixture:
            fixture.write("verified contract fixture\n")
    args = {"id": "%s-%d" % (tag, _ctx["n"]), "title": "%s issue %d" % (tag, _ctx["n"]),
            "oracle_cmd": "test -s oracle-input.txt", "allowed_paths": [scope]}
    args.update(kw)
    return issue_id(need(call(srv.sock, "create", args), "create"))


def verified_close(srv, ident, actor, epoch):
    receipt = need(call(srv.sock, "verify", {"id": ident, "actor": actor,
        "epoch": epoch, "cwd": os.path.dirname(srv.logpath), "timeout_secs": 2}), "verify")
    assert receipt.get("passed"), "fixture oracle failed: %r" % receipt
    return call(srv.sock, "close", {"id": ident, "actor": actor, "epoch": epoch,
        "proof_id": receipt["proof_id"], "reason": "Executed source-bound fixture oracle"})


# ---- §6 invariants -----------------------------------------------------------

@check("atomic_claim_next")
def c_atomic(srv):
    """10 threads claim_next on 6 ready → 6 unique + 4 null, zero dup."""
    ids = {mkissue(srv, "c1", priority=0) for _ in range(6)}
    bar, res, errs = threading.Barrier(10), [None] * 10, []

    def w(t):
        try:
            cn = Conn(srv.sock)
            bar.wait(15)
            res[t] = cn.call("claim_next", {"actor": "thr%d" % t, "ttl": 300})
            cn.close()
        except Exception as e:
            errs.append("thr%d: %s" % (t, e))

    ths = [threading.Thread(target=w, args=(i,), daemon=True) for i in range(10)]
    [t.start() for t in ths]
    [t.join(30) for t in ths]
    if any(res[t] is None for t in range(10)) or errs:
        raise OpErr("thread failures: %s" % (errs or "hung threads"))
    if any(r.missing for r in res):
        raise Missing("claim_next")
    bad = [r for r in res if not r.ok]
    assert not bad, "claim_next errors: %s" % bad
    got = [issue_id(r.data) for r in res]
    non = [g for g in got if g]
    assert len(set(non)) == len(non), "duplicate claims: %s" % got
    assert len(non) == 6 and got.count(None) == 4, \
        "expected 6 claims + 4 null, got %s" % got
    return "6 unique claims %s + 4 null, 0 errors over 10 threads" % sorted(non)


@check("dep_blocked_never_claimed")
def c_dep(srv):
    """Blocked issue with top priority is never returned by claim_next."""
    a = mkissue(srv, "c2-blocker", priority=1)
    b = mkissue(srv, "c2-blocked", priority=0)
    need(call(srv.sock, "dep", {"issue": b, "depends_on": a}), "dep")
    seen, cid = [], 0
    for _ in range(12):
        r = call(srv.sock, "claim_next", {"actor": "c2", "ttl": 300})
        if r.missing:
            raise Missing("claim_next")
        need(r, "claim_next")
        i = issue_id(r.data)
        if not i:
            break
        seen.append(i)
        cid += 1
    assert b not in seen, "blocked issue %s was claimed! seen=%s" % (b, seen)
    assert a in seen, "blocker %s never claimed in %s" % (a, seen)
    return "%s claimed over %d claim_next; blocked %s skipped" % (a, cid, b)


@check("fencing_stale_epoch")
def c_fence(srv):
    """Lease expiry → reclaim bumps epoch → old actor close = stale_fence."""
    i = mkissue(srv, "c3")
    d = need(call(srv.sock, "claim", {"id": i, "actor": "old", "ttl": 1}),
             "claim")
    e1 = d.get("epoch") if isinstance(d, dict) else None
    assert isinstance(e1, int), "claim returned no epoch fencing token: %r" % (d,)
    time.sleep(1.1)
    d2 = need(call(srv.sock, "claim_next", {"actor": "new", "ttl": 300}),
              "claim_next(reclaim)")
    i2 = issue_id(d2)
    assert i2 == i, "expired lease not reclaimable: claim_next → %r" % (i2,)
    e2 = d2.get("epoch")
    assert isinstance(e2, int) and e2 != e1, "epoch not bumped: %r → %r" % (e1, e2)
    r = call(srv.sock, "close", {"id": i, "actor": "old", "epoch": e1})
    if r.missing:
        raise Missing("close")
    assert not r.ok, "old actor close with stale epoch SUCCEEDED (fencing broken)"
    assert r.code == "stale_fence", \
        "stale close rejected with %s, expected stale_fence" % r.code
    need(verified_close(srv, i, "new", e2), "close(new epoch)")
    return "epoch %d→%d on reclaim; old close → stale_fence; new close ok" % (e1, e2)


@check("events_ordered_export")
def c_events(srv):
    """Mutations append ordered events; show tail + export preserve seq."""
    i = mkissue(srv, "c4")
    d = need(call(srv.sock, "claim", {"id": i, "actor": "ev", "ttl": 60}), "claim")
    ep = d.get("epoch", 0)
    hb_note = ""
    r = call(srv.sock, "heartbeat", {"id": i, "actor": "ev", "epoch": ep, "ttl": 60})
    if r.ok:
        hb_note = "+heartbeat"
    need(verified_close(srv, i, "ev", ep), "close")
    sh = need(call(srv.sock, "show", {"id": i}), "show")
    evs = show_events(sh)
    assert evs, "show returned no events_tail/history for %s" % i
    ops = [ev_op(e) for e in evs]

    def pos(name):
        return next((k for k, o in enumerate(ops) if o == name), -1)

    assert 0 <= pos("create") < pos("claim") > -1 and pos("close") > pos("claim"), \
        "event order wrong: %s" % ops
    seqs = [s for s in (ev_seq(e) for e in evs) if s is not None]
    if seqs:
        assert seqs == sorted(seqs), "show events not seq-ordered: %s" % seqs
    ex = need(call(srv.sock, "export", {}), "export")
    note = "no export events"
    if isinstance(ex, dict):
        xl = ex.get("events") if isinstance(ex.get("events"), list) else None
        if xl:
            xs = [s for s in (ev_seq(e) for e in xl) if s is not None]
            assert not xs or xs == sorted(xs), "export events out of order"
            note = "export %d events seq-ordered" % len(xl)
        elif isinstance(ex.get("events_count"), int):
            assert ex["events_count"] >= len(evs), \
                "export events_count %d < %d" % (ex["events_count"], len(evs))
            note = "export events_count=%d" % ex["events_count"]
    elif isinstance(ex, list):
        note = "export returned %d rows" % len(ex)
    return "show ops %s %s; %s" % (ops, hb_note, note)


@check("idem_dedup")
def c_idem(srv):
    """create with same id+idem → same id, single effect; no idem → exists."""
    t0 = stats_total(need(call(srv.sock, "stats", {}), "stats"))
    d1 = need(call(srv.sock, "create",
                   {"id": "dup-x", "title": "dup", "idem": "k-idem-1"}), "create")
    d2 = need(call(srv.sock, "create",
                   {"id": "dup-x", "title": "dup", "idem": "k-idem-1"}),
              "create(dup idem)")
    assert issue_id(d1) == issue_id(d2) == "dup-x", \
        "dup idem create: %r vs %r" % (d1, d2)
    if t0 is not None:
        t1 = stats_total(need(call(srv.sock, "stats", {}), "stats"))
        assert t1 == t0 + 1, "duplicate idem create mutated db (total %d→%d)" % (t0, t1)
    r = call(srv.sock, "create", {"id": "dup-x", "title": "dup no-idem"})
    assert not r.ok, "duplicate create without idem accepted"
    assert r.code == "exists", "dup create → %s, expected exists" % r.code
    return "same id+idem → same id, total +1 only; no-idem dup → exists"


@check("outbox_on_close")
def c_outbox(srv):
    """close inserts outbox(kind='lesson') row in the same transaction."""
    i = mkissue(srv, "c6")
    d = need(call(srv.sock, "claim", {"id": i, "actor": "ob", "ttl": 60}), "claim")
    need(verified_close(srv, i, "ob", d.get("epoch", 0)), "close")
    rows = need(call(srv.sock, "outbox_list", {}), "outbox_list")
    assert isinstance(rows, list), "outbox_list → %r" % (rows,)
    hit = [r for r in rows if isinstance(r, dict) and
           (i in json.dumps(r) or "lesson" in str(r.get("kind", "")))]
    if not hit:  # tuple rows: scan serialized form
        hit = [r for r in rows if i in json.dumps(r, default=str)]
    assert hit, "no outbox row mentioning %s in %d rows" % (i, len(rows))
    return "close(%s) produced outbox row: %s" % (
        i, json.dumps(hit[0], default=str)[:100])


@check("batch_rollback")
def c_batch(srv):
    """One failing op inside batch rolls back all ops."""
    have = mkissue(srv, "c7-exists")
    t0 = stats_total(need(call(srv.sock, "stats", {}), "stats"))
    r = call(srv.sock, "batch", {"ops": [
        {"cmd": "create", "args": {"id": "c7-new", "title": "rolled"}},
        {"cmd": "create", "args": {"id": have, "title": "dup → error"}}]})
    if r.missing:
        raise Missing("batch")
    assert not r.ok, "batch with duplicate create SUCCEEDED"
    sr = call(srv.sock, "show", {"id": "c7-new"})
    assert not (sr.ok and sr.data), "rolled-back create 'c7-new' is visible"
    if t0 is not None:
        t1 = stats_total(need(call(srv.sock, "stats", {}), "stats"))
        assert t1 == t0, "batch rollback leaked rows (total %d→%d)" % (t0, t1)
    return "batch aborted on op[1] (exists); c7-new absent, total unchanged"


@check("stale_socket_restart")
def c_restart(srv):
    """Second serve refused; kill -9 → stale socket probed → clean restart."""
    ev = []
    p2 = srv.spawn()                       # double-bind probe (not tracked)
    try:
        rc = p2.wait(6)
        ev.append("2nd bind rc=%d" % rc)
        assert rc != 0, "second serve exited 0 — double bind allowed"
    except subprocess.TimeoutExpired:
        p2.kill()
        p2.wait(5)
        ev.append("no bind protection (2nd serve kept running)")
    if not srv.alive():                    # probe may have stolen socket
        ev.append("primary lost after 2nd bind — restarting")
        srv.restart()
    else:
        ev.append("primary still serving")
    srv.kill9()
    ev.append("kill -9")
    srv.start()
    dt = srv.wait_ready()
    stats = need(call(srv.sock, "stats", {}), "stats(post-restart)")
    return "%s; restart ready in %.2fs, stats.total=%s" % (
        "; ".join(ev), dt, stats_total(stats))


@check("ready_correctness")
def c_ready(srv):
    """ready = open ∧ ¬blocked — excludes in_progress/closed/blocked."""
    a = mkissue(srv, "c9-open")
    b = mkissue(srv, "c9-prog")
    need(call(srv.sock, "claim", {"id": b, "actor": "r", "ttl": 300}), "claim")
    c = mkissue(srv, "c9-closed")
    d = need(call(srv.sock, "claim", {"id": c, "actor": "r", "ttl": 300}), "claim")
    need(verified_close(srv, c, "r", d.get("epoch", 0)), "close")
    e = mkissue(srv, "c9-blocked")
    need(call(srv.sock, "dep", {"issue": e, "depends_on": a}), "dep")
    ids = set(ready_ids(need(call(srv.sock, "ready", {"limit": 1000}), "ready")))
    assert a in ids, "open unblocked %s missing from ready" % a
    bad = ids & {b, c, e}
    assert not bad, "ready returned non-ready issues: %s" % bad
    return ("ready has %s; excludes in_progress %s, closed %s, blocked %s "
            "(deferred: no §3 op sets it — untested)") % (a, b, c, e)


@check("readers_during_heartbeat")
def c_readers(srv):
    """Concurrent readers don't error while a writer heartbeats (WAL)."""
    i = mkissue(srv, "c10")
    d = need(call(srv.sock, "claim", {"id": i, "actor": "w", "ttl": 120}), "claim")
    ep = d.get("epoch", 0)
    if call(srv.sock, "heartbeat",
            {"id": i, "actor": "w", "epoch": ep, "ttl": 120}).missing:
        raise Missing("heartbeat")
    stop = threading.Event()
    stat = {"r": 0, "re": 0, "w": 0, "we": 0, "errs": []}
    rd_ops = [("ready", {}), ("stats", {}), ("show", {"id": i}), ("stale", {})]

    def writer(n):
        while not stop.is_set():
            try:
                r = call(srv.sock, "heartbeat",
                         {"id": i, "actor": "w", "epoch": ep, "ttl": 120})
                stat["w"] += 1
                if not r.ok:
                    stat["we"] += 1
                    stat["errs"].append("hb %s" % r.code)
            except Exception as e:
                stat["we"] += 1
                stat["errs"].append("hb %s" % e)
            time.sleep(0.005)

    def reader(n):
        k = 0
        while not stop.is_set():
            cmd, args = rd_ops[k % len(rd_ops)]
            k += 1
            try:
                r = call(srv.sock, cmd, args)
                stat["r"] += 1
                if not r.ok and not r.missing:
                    stat["re"] += 1
                    stat["errs"].append("%s %s" % (cmd, r.code))
            except Missing:
                pass
            except Exception as e:
                stat["re"] += 1
                stat["errs"].append("%s %s" % (cmd, e))

    ths = [threading.Thread(target=writer, args=(w,), daemon=True)
           for w in range(2)]
    ths += [threading.Thread(target=reader, args=(r,), daemon=True)
            for r in range(4)]
    [t.start() for t in ths]
    time.sleep(1.5)
    stop.set()
    [t.join(10) for t in ths]
    assert stat["re"] == 0, "read errors during heartbeat: %s" % stat["errs"][:5]
    assert stat["r"] > 0 and stat["w"] > 0, "no traffic: %s" % stat
    return "%d reads / %d heartbeats over 1.5s, %d read errors, %d hb errors" % (
        stat["r"], stat["w"], stat["re"], stat["we"])


@check("op_coverage")
def c_smoke(srv):
    """Every §3 op: present (ok or any non-bad_cmd error) vs MISSING."""
    try:
        i = mkissue(srv, "smoke")
    except Exception:
        i = "smoke-ghost"
    args = {
        "create": {"title": "smoke-x"}, "dep": {"issue": i, "depends_on": "g"},
        "dep_list": {}, "dep_remove": {"issue": i, "depends_on": "g"},
        "ready": {}, "list": {"limit": 5}, "query": {"status": "open"},
        "count": {}, "update": {"id": i, "priority": 3},
        "note": {"id": i, "text": "smoke"}, "comments": {"id": i},
        "history": {"id": i}, "claim": {"id": i, "actor": "s"},
        "claim_next": {"actor": "s"}, "unclaim": {"id": i},
        "reclaim": {}, "watch": {"after": 0, "limit": 5},
        "heartbeat": {"id": i, "actor": "s", "epoch": 0},
        "close": {"id": i, "actor": "s", "epoch": 0},
        "reopen": {"id": i, "actor": "s"}, "delete": {"id": "ghost-x"},
        "defer": {"id": i, "until": 1}, "undefer": {"id": i},
        "children": {"id": i}, "label": {"id": i, "add": ["smk"]},
        "rename": {"from": "ghost-a", "to": "ghost-b"},
        "lint": {}, "types": {}, "statuses": {}, "prime": {},
        "show": {"id": i},
        "search": {"q": "smoke"}, "stale": {}, "orphans": {}, "stats": {},
        "remember": {"key": "smk", "value": "v"}, "recall": {"key": "smk"},
        "export": {}, "import": {"jsonl": ""},
        "batch": {"ops": [{"cmd": "stats", "args": {}}]},
        "budget_claim": {"issue": i, "eur": 0}, "contract": {"id": i},
        "outbox_list": {}, "outbox_done": {"id": -1},
        "outbox_fail": {"id": -1, "err": "x"}, "compact": {"days": 30},
        "gate": {"name": "smoke-g"}, "gate_list": {},
        "epic": {"id": i}, "dup_scan": {"id": i},
        "q": {"title": "smoke-q"},
        "slot_acquire": {"name": "smoke-sl", "actor": "s"},
        "slot_release": {"name": "smoke-sl", "actor": "s"},
        "slot_list": {},
    }
    missing, terrs, present, lines = [], [], 0, []
    for op in OPS:
        try:
            r = call(srv.sock, op, args.get(op, {}))
        except TransErr as e:
            lines.append("    %-13s TRANSPORT-ERR %s" % (op, e))
            terrs.append(op)
            continue
        if r.missing:
            missing.append(op)
            lines.append("    %-13s MISSING" % op)
        elif r.ok:
            present += 1
            lines.append("    %-13s ok" % op)
        else:
            present += 1
            lines.append("    %-13s present (err %s: %s)"
                         % (op, r.code, r.msg[:50]))
    for l in lines:
        print(l)
    if terrs:
        raise OpErr("transport broke on: %s" % ",".join(terrs))
    if missing:
        raise Missing(",".join(missing))
    return "all %d §3 ops present on the wire" % present


# ---- main --------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="gq SPEC v0.1 contract suite")
    ap.add_argument("--serve-cmd", required=True,
                    help='e.g. "python3 /path/superiss.py serve"')
    ap.add_argument("--db", help="db path (default: fresh temp)")
    ap.add_argument("--sock", help="socket path (default: <db>.sock)")
    ap.add_argument("--keep", action="store_true", help="keep temp dir")
    a = ap.parse_args()

    tmp = None
    if a.db:
        db = a.db
        logdir = os.path.dirname(os.path.abspath(db)) or "."
    else:
        tmp = tempfile.mkdtemp(prefix="gq-contract-")
        db = os.path.join(tmp, "sis.db")
        logdir = tmp
    sock = a.sock or (db + ".sock")
    srv = Srv(a.serve_cmd, db, sock, logdir)

    print("== gq contract suite ==")
    print("serve: %s" % a.serve_cmd)
    print("db:    %s\nsock:  %s" % (db, sock))
    try:
        srv.start()
        srv.wait_ready()
    except Exception as e:
        print("FATAL serve did not come up: %s" % e)
        srv.stop()
        return 1

    npass = nfail = nmiss = 0
    for name, fn in CHECKS:
        try:
            ev = fn(srv)
            print("[PASS]    %-26s %s" % (name, ev))
            npass += 1
        except Missing as e:
            print("[MISSING] %-26s op missing: %s" % (name, e))
            nmiss += 1
        except AssertionError as e:
            print("[FAIL]    %-26s %s" % (name, e))
            nfail += 1
        except OpErr as e:
            print("[FAIL]    %-26s op error: %s" % (name, e))
            nfail += 1
        except Exception as e:
            print("[FAIL]    %-26s %s: %s" % (name, type(e).__name__, e))
            nfail += 1

    srv.stop()
    print("== %d PASS / %d FAIL / %d MISSING over %d checks =="
          % (npass, nfail, nmiss, len(CHECKS)))
    print("artifacts kept: %s" % (tmp or logdir) if (a.keep or nfail or nmiss)
          else "artifacts: %s" % (tmp or logdir))
    if tmp and not a.keep and not nfail and not nmiss:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)
    return 1 if nfail else 0


if __name__ == "__main__":
    sys.exit(main())
