#!/usr/bin/env python3
"""gq — universal agent-execution harness store. SPEC v0.1 reference impl.

Single file, python3 stdlib only. SQLite (WAL) issue graph with atomic
claims, lease fencing via lease_epoch, same-TX events, generic outbox,
FTS5 search, unix-socket NDJSON daemon, CLI spawn-fallback, stdio MCP.

  superiss.py <cmd> [json|@file|k=v|pos ...] [--db PATH] [--sock PATH] [--json]
  superiss.py serve --db PATH [--sock PATH]
  superiss.py mcp   --db PATH

Wire (NDJSON over unix socket): one line {"cmd","args","run_id","idem"}
-> one line {"ok":true,"data":...} | {"ok":false,"error":{"code","msg"}}.
Responses are always exactly one line (may exceed 64KiB; read line-wise).

Exit codes: 0 ok · 1 user error · 2 internal · 3 serve already bound.
"""
import contextlib
import agent
import fcntl
import hashlib
import json
import os
import re
import secrets
import select
import subprocess
import signal
import socket
import socketserver
import sqlite3
import sys
import threading
import time
from pathlib import Path

LEASE_S = 1800.0
VERSION = "0.3.0"

SCHEMA = """
CREATE TABLE IF NOT EXISTS issues(
  id TEXT PRIMARY KEY, title TEXT, status TEXT DEFAULT 'open',
  priority INT DEFAULT 2, type TEXT DEFAULT 'task',
  owner TEXT, oracle_cmd TEXT, allowed_paths TEXT, lane TEXT,
  budget_eur REAL, acceptance TEXT, "desc" TEXT,
  lease_until REAL, lease_epoch INT DEFAULT 0, claim_actor TEXT,
  created_at REAL, closed_at REAL, meta_json TEXT,
  defer_until REAL, expires_at REAL);
CREATE TABLE IF NOT EXISTS deps(
  issue TEXT, depends_on TEXT, type TEXT DEFAULT 'blocks',
  PRIMARY KEY(issue, depends_on));
CREATE TABLE IF NOT EXISTS claims(
  actor TEXT, issue TEXT, claim_id TEXT, epoch INT, hb_at REAL,
  run_id TEXT, PRIMARY KEY(actor, issue));
CREATE TABLE IF NOT EXISTS events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, op TEXT, issue TEXT,
  actor TEXT, run_id TEXT, idem TEXT, data_json TEXT);
CREATE TABLE IF NOT EXISTS memories(
  key TEXT PRIMARY KEY, value TEXT, updated_at REAL);
CREATE TABLE IF NOT EXISTS outbox(
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, payload TEXT,
  state TEXT DEFAULT 'pending', attempts INT DEFAULT 0, run_id TEXT);
CREATE TABLE IF NOT EXISTS gates(
  name TEXT PRIMARY KEY, state TEXT DEFAULT 'closed',
  payload TEXT, updated_at REAL);
CREATE TABLE IF NOT EXISTS slots(
  name TEXT PRIMARY KEY, holder TEXT, epoch INT DEFAULT 0,
  lease_until REAL, claim_id TEXT, updated_at REAL);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
CREATE INDEX IF NOT EXISTS idx_events_issue ON events(issue);
CREATE INDEX IF NOT EXISTS idx_events_idem ON events(idem);
CREATE INDEX IF NOT EXISTS idx_deps_on ON deps(depends_on);
CREATE INDEX IF NOT EXISTS idx_deps_issue ON deps(issue);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_ready ON issues(status,priority,created_at);
CREATE INDEX IF NOT EXISTS idx_issues_lane ON issues(lane);
CREATE INDEX IF NOT EXISTS idx_outbox_state ON outbox(state);
"""

FTS_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
  title, "desc", acceptance, content='issues');
CREATE TRIGGER IF NOT EXISTS issues_fts_ai AFTER INSERT ON issues BEGIN
  INSERT INTO issues_fts(rowid, title, "desc", acceptance)
  VALUES (new.rowid, new.title, new."desc", new.acceptance);
END;
CREATE TRIGGER IF NOT EXISTS issues_fts_ad AFTER DELETE ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, "desc", acceptance)
  VALUES ('delete', old.rowid, old.title, old."desc", old.acceptance);
END;
CREATE TRIGGER IF NOT EXISTS issues_fts_au AFTER UPDATE ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, "desc", acceptance)
  VALUES ('delete', old.rowid, old.title, old."desc", old.acceptance);
  INSERT INTO issues_fts(rowid, title, "desc", acceptance)
  VALUES (new.rowid, new.title, new."desc", new.acceptance);
END;
"""

ECOLS = ("seq", "ts", "op", "issue", "actor", "run_id", "idem", "data_json")

JD = {"separators": (",", ":"), "default": str}  # compact wire json kwargs

ICOLS = ("id", "title", "status", "priority", "type", "owner", "oracle_cmd",
         "allowed_paths", "lane", "budget_eur", "acceptance", "desc",
         "lease_until", "lease_epoch", "claim_actor", "created_at",
         "closed_at", "defer_until", "expires_at", "meta_json")
ISEL = "id,title,status,priority,type,owner,oracle_cmd,allowed_paths,lane," \
       'budget_eur,acceptance,"desc",lease_until,lease_epoch,claim_actor,' \
       "created_at,closed_at,defer_until,expires_at,meta_json"
ISEL_I = "i." + ISEL.replace(",", ",i.")  # qualified for joined queries

SETCOLS = ("title", "desc", "priority", "type", "status", "owner", "oracle_cmd",
           "allowed_paths", "lane", "budget_eur", "acceptance", "meta_json",
           "lease_until", "claim_actor", "defer_until", "expires_at")


class GqError(Exception):
    """User-level op failure -> {ok:false,error:{code,msg}} -> CLI exit 1."""

    def __init__(self, code, msg=""):
        super().__init__(msg or code)
        self.code = code
        self.msg = msg or code


def connect(path):
    db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=5000")
    db.execute("PRAGMA synchronous=" + ("NORMAL" if os.environ.get("SIS_SYNCHRONOUS") == "NORMAL" else "FULL"))
    db.execute("PRAGMA temp_store=MEMORY")
    ver = db.execute("PRAGMA user_version").fetchone()[0]
    if ver > 8:
        db.close()
        raise GqError('schema_version', f'unsupported schema {ver}; maximum 8')
    if ver == 0:
        db.executescript(SCHEMA)
        db.execute("PRAGMA user_version=4")
        try:
            db.executescript(FTS_SCHEMA)
            if (db.execute("SELECT COUNT(*) FROM issues").fetchone()[0] and
                    not db.execute("SELECT COUNT(*) FROM issues_fts").fetchone()[0]):
                db.execute("INSERT INTO issues_fts(issues_fts) VALUES('rebuild')")
        except sqlite3.Error:
            pass  # FTS5 unavailable -> op_search falls back to LIKE
    else:
        if ver < 2:
            db.execute("ALTER TABLE deps ADD COLUMN type TEXT DEFAULT 'blocks'")
            db.execute("ALTER TABLE issues ADD COLUMN defer_until REAL")
        if ver < 3:
            db.execute("CREATE TABLE IF NOT EXISTS gates("
                       "name TEXT PRIMARY KEY, state TEXT DEFAULT 'closed',"
                       " payload TEXT, updated_at REAL)")
            db.execute("ALTER TABLE issues ADD COLUMN expires_at REAL")
        if ver < 4:
            db.execute("CREATE TABLE IF NOT EXISTS slots("
                       "name TEXT PRIMARY KEY, holder TEXT, epoch INT DEFAULT 0,"
                       " lease_until REAL, claim_id TEXT, updated_at REAL)")
        if ver < 4:
            db.execute("PRAGMA user_version=4")
    return db


@contextlib.contextmanager
def tx(db):
    """Outermost call = real BEGIN/COMMIT; nested (inside batch) = savepoint."""
    if db.in_transaction:
        db.execute("SAVEPOINT sis_sp")
        try:
            yield
        except BaseException:
            try:
                db.execute("ROLLBACK TO sis_sp")
                db.execute("RELEASE sis_sp")
            except sqlite3.Error:
                pass
            raise
        db.execute("RELEASE sis_sp")
    else:
        # IMMEDIATE serializes writers up front (rust parity). Deferred BEGIN
        # + UPDATE...RETURNING hits BUSY_SNAPSHOT under concurrency — sqlite
        # does not retry snapshot busy, so 9/10 claimers failed on contact.
        db.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            db.execute("ROLLBACK")
            raise
        db.execute("COMMIT")


def _int(v, default=None):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _f(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _js(v):
    return json.dumps(v, default=str) if isinstance(v, (list, dict)) else v


def _dicts(cur):
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def _issue_dict(row):
    result = dict(zip(ICOLS, row))
    try:
        metadata = json.loads(result.get('meta_json') or '{}')
        if not isinstance(metadata, dict):
            raise ValueError('metadata must be an object')
        result['meta'] = metadata
    except (ValueError, TypeError):
        result['meta'] = {}
        result['meta_error'] = 'invalid_json_object'
    return result


def _idicts(cur):
    return [_issue_dict(row) for row in cur.fetchall()]


def _issue(db, i):
    r = db.execute(f"SELECT {ISEL} FROM issues WHERE id=?", (i,)).fetchone()
    return _issue_dict(r) if r else None


def _uid(db):
    while True:
        i = "sis-" + secrets.token_hex(4)
        if not db.execute("SELECT 1 FROM issues WHERE id=?", (i,)).fetchone():
            return i


def ev(db, op, issue, actor, run_id, idem, data=None):
    """One events row per mutation, same TX (SPEC §2)."""
    db.execute(
        "INSERT INTO events(ts,op,issue,actor,run_id,idem,data_json) "
        "VALUES(?,?,?,?,?,?,?)",
        (time.time(), op, issue, actor, run_id,
         str(idem) if idem is not None else None,
         json.dumps(data, default=str) if data is not None else None))


def finish(db, ctx, cmd, data):
    """Record idempotency key inside the op's TX: single effect guaranteed
    (concurrent dup -> IntegrityError -> caller returns cached response)."""
    idem = ctx.get("idem")
    if idem is not None:
        db.execute("INSERT INTO kv(k,v) VALUES(?,?)",
                   ("idem:" + str(idem),
                    json.dumps({"cmd": cmd, "data": data}, default=str)))
    return data


def _ep(a):
    """Epoch arg normalized to int when possible (None stays None)."""
    e = a.get("epoch")
    try:
        return int(e)
    except (TypeError, ValueError):
        return e


def _fence(db, i, actor, epoch, want_statuses):
    """Return row or raise stale_fence/not_found per SPEC §2."""
    row = db.execute(
        "SELECT status,claim_actor,lease_epoch FROM issues WHERE id=?",
        (i,)).fetchone()
    if not row:
        raise GqError("not_found", str(i))
    st, ca, le = row
    if st not in want_statuses or le != epoch or \
            (st == "in_progress" and ca != actor):
        raise GqError("stale_fence",
                      f"{i}: st={st} epoch {epoch}!={le} actor {actor}!={ca}")
    return row


# ---------------------------------------------------------------- ops

def op_create(db, a, c):
    i = a.get("id")
    title = a.get("title") or ""
    if not i and not title:
        raise GqError("bad_args", "title (or id) required")
    now = time.time()
    meta = a.get("meta")
    with tx(db):
        if i and db.execute("SELECT 1 FROM issues WHERE id=?", (i,)).fetchone():
            idem = c.get("idem")
            if idem is not None and db.execute(
                    "SELECT 1 FROM events WHERE op='create' AND issue=? AND idem=?",
                    (i, str(idem))).fetchone():
                return {"id": i}
            raise GqError("exists", str(i))
        if not i:
            i = _uid(db)
        status = "deferred" if a.get("status") == "deferred" else "open"
        if a.get("parent"):
            meta = dict(meta or {})
            meta["parent"] = a["parent"]
        # wisp/ephemeral: expires_at = now+ttl_secs|ttl (or explicit epoch);
        # auto-ages out of ready, `compact` reaps the row.
        expires = a.get("expires_at") or (
            now + _f(a.get("ttl_secs") or a.get("ttl"))
            if (a.get("ttl_secs") or a.get("ttl")) is not None else None)
        db.execute(
            'INSERT INTO issues(id,title,"desc",type,priority,status,owner,'
            "oracle_cmd,allowed_paths,lane,budget_eur,acceptance,created_at,"
            "meta_json,lease_epoch,defer_until,expires_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)",
            (i, title, a.get("desc") or a.get("descr") or "",
             a.get("type") or "task",
             _int(a.get("priority", a.get("prio")), 2), status, a.get("owner"),
             a.get("oracle_cmd"), _js(a.get("allowed_paths")), a.get("lane"),
             _f(a.get("budget_eur")), a.get("acceptance"), now, _js(meta),
             _f(a.get("defer_until")), _f(expires)))
        ev(db, "create", i, c["actor"], c["run_id"], c["idem"],
           {"title": title})
        return finish(db, c, "create", {"id": i})


def _dep_one(db, issue, on, c, dtype="blocks"):
    if dtype == "blocks":
        if issue == on:
            raise GqError("dep_cycle", f"{issue} depends on itself")
        reach = db.execute(
            "WITH RECURSIVE anc(x) AS (SELECT ? UNION "
            " SELECT d.depends_on FROM deps d JOIN anc a ON d.issue=a.x"
            " WHERE d.type IS NULL OR d.type='blocks') "
            "SELECT 1 FROM anc WHERE x=? LIMIT 1", (on, issue)).fetchone()
        if reach:
            raise GqError("dep_cycle", f"{issue}->{on} closes a cycle")
    db.execute("INSERT OR REPLACE INTO deps(issue,depends_on,type)"
               " VALUES(?,?,?)", (issue, on, dtype))
    ev(db, "dep", issue, c["actor"], c["run_id"], c["idem"],
       {"depends_on": on, "type": dtype})


def op_dep(db, a, c):
    items = a if isinstance(a, list) else (a.get("deps") or [a])
    if not isinstance(items, list):
        raise GqError("bad_args", "dep takes {issue,depends_on} or a list")
    with tx(db):
        for it in items:
            if not isinstance(it, dict) or not it.get("issue") \
                    or not it.get("depends_on"):
                raise GqError("bad_args", "dep needs issue+depends_on")
            _dep_one(db, it["issue"], it["depends_on"], c,
                     it.get("type") or
                     (a.get("type") if isinstance(a, dict) else None) or
                     "blocks")
        return finish(db, c, "dep", {"ok": True, "n": len(items)})


BLOCKED_SQL = """i.id NOT IN
 (SELECT d.issue FROM deps d JOIN issues b ON d.depends_on=b.id
  WHERE (d.type IS NULL OR d.type='blocks') AND b.status!='closed')
 AND i.id NOT IN
 (SELECT dg.issue FROM deps dg LEFT JOIN gates g ON dg.depends_on=g.name
  WHERE dg.type='gate' AND COALESCE(g.state,'closed')!='open')"""
READY_PRED = """(i.status='open' OR (i.status='deferred' AND
 i.defer_until IS NOT NULL AND i.defer_until<=?)) AND
 (i.defer_until IS NULL OR i.defer_until<=?) AND
 (i.expires_at IS NULL OR i.expires_at>?) AND
 i.type NOT IN ('goal','epic') AND i.oracle_cmd IS NOT NULL AND trim(i.oracle_cmd)!='' AND NOT EXISTS (SELECT 1 FROM cancellations x WHERE x.issue=i.id AND x.requested!=0) AND NOT EXISTS (SELECT 1 FROM issues child WHERE json_extract(child.meta_json,'$.parent')=i.id OR (child.id LIKE i.id||'.%' AND instr(substr(child.id,length(i.id)+2),'.')=0))"""
READY_WHERE = READY_PRED + " AND " + BLOCKED_SQL


def op_ready(db, a, c):
    now = time.time()
    sql = f"SELECT {ISEL_I} FROM issues i WHERE {READY_WHERE}"
    p = [now, now, now]
    if a.get("lane") is not None:
        sql += " AND i.lane=?"
        p.append(a["lane"])
    sql += " ORDER BY i.priority, i.created_at"
    if a.get("limit"):
        sql += " LIMIT ?"
        p.append(_int(a["limit"], 100))
    return _idicts(db.execute(sql, p))


def _grant(db, i, actor, c, now, op, epoch=None):
    if epoch is None:
        epoch = db.execute("SELECT lease_epoch FROM issues WHERE id=?",
                           (i,)).fetchone()[0]
    cid = secrets.token_hex(8)
    db.execute("DELETE FROM claims WHERE issue=?", (i,))  # one holder
    db.execute(
        "INSERT INTO claims(actor,issue,claim_id,epoch,hb_at,run_id)"
        " VALUES(?,?,?,?,?,?)", (actor, i, cid, epoch, now, c["run_id"]))
    ev(db, op, i, actor, c["run_id"], c["idem"],
       {"claim_id": cid, "epoch": epoch})
    return finish(db, c, op, {"id": i, "claim_id": cid, "epoch": epoch})


def op_claim(db, a, c):
    i, actor = a.get("id"), a.get("actor") or c.get("actor")
    if not i or not actor:
        raise GqError("bad_args", "claim needs id+actor")
    ttl, now = _f(a.get("ttl"), LEASE_S), time.time()
    with tx(db):
        ok = db.execute(
            "UPDATE issues SET status='in_progress',claim_actor=?,lease_until=?,"
            "lease_epoch=lease_epoch+1 WHERE id=? AND (status='open' OR "
            "(status='in_progress' AND (lease_until<? OR claim_actor=?)))",
            (actor, now + ttl, i, now, actor)).rowcount == 1
        if not ok:
            r = db.execute("SELECT status FROM issues WHERE id=?",
                           (i,)).fetchone()
            if not r:
                raise GqError("not_found", str(i))
            raise GqError({"closed": "closed", "deferred": "bad_state"}.get(
                r[0], "claimed"), str(i))
        epoch = db.execute("SELECT lease_epoch FROM issues WHERE id=?",
                           (i,)).fetchone()[0]
        return _grant(db, i, actor, c, now, "claim", epoch)


def op_claim_next(db, a, c):
    actor = a.get("actor") or c.get("actor")
    if not actor:
        raise GqError("bad_args", "claim_next needs actor")
    ttl, now, lane = _f(a.get("ttl"), LEASE_S), time.time(), a.get("lane")
    notin = BLOCKED_SQL
    with tx(db):
        # two single-index scans beat one OR'd scan+sort (SPEC: atomic claim)
        row = db.execute(
            "UPDATE issues SET status='in_progress',claim_actor=?,lease_until=?,"
            "lease_epoch=lease_epoch+1 WHERE id=(SELECT i.id FROM issues i "
            "WHERE " + READY_PRED + " AND (? IS NULL OR i.lane=?) AND " + notin +
            " ORDER BY i.priority, i.created_at LIMIT 1) "
            "RETURNING id, lease_epoch",
            (actor, now + ttl, now, now, now, lane, lane)).fetchone()
        if not row:  # nothing open: fall back to a stale-leased issue
            row = db.execute(
                "UPDATE issues SET status='in_progress',claim_actor=?,"
                "lease_until=?,lease_epoch=lease_epoch+1 WHERE id=(SELECT i.id "
                "FROM issues i WHERE i.status='in_progress' AND "
                "i.lease_until<? AND (? IS NULL OR i.lane=?) AND " + notin +
                " ORDER BY i.priority, i.created_at LIMIT 1) "
                "RETURNING id, lease_epoch",
                (actor, now + ttl, now, lane, lane)).fetchone()
        if not row:
            return finish(db, c, "claim_next", {"id": None})
        return _grant(db, row[0], actor, c, now, "claim_next", row[1])


def op_heartbeat(db, a, c):
    i, actor, epoch = a.get("id"), a.get("actor") or c.get("actor"), _ep(a)
    if not i or not actor:
        raise GqError("bad_args", "heartbeat needs id+actor")
    ttl, now = _f(a.get("ttl"), LEASE_S), time.time()
    with tx(db):
        _fence(db, i, actor, epoch, ("in_progress",))
        db.execute("UPDATE issues SET lease_until=? WHERE id=?",
                   (now + ttl, i))
        db.execute("UPDATE claims SET hb_at=?,run_id=COALESCE(?,run_id) "
                   "WHERE actor=? AND issue=?",
                   (now, c["run_id"], actor, i))
        ev(db, "heartbeat", i, actor, c["run_id"], c["idem"], {"epoch": epoch})
        return finish(db, c, "heartbeat", {"ok": True})


def op_close(db, a, c):
    i, actor, epoch = a.get("id"), a.get("actor") or c.get("actor"), _ep(a)
    if not i or not actor:
        raise GqError("bad_args", "close needs id+actor")
    now, reason = time.time(), a.get("reason")
    with tx(db):
        row = db.execute("SELECT status,claim_actor,lease_epoch,title,type "
                         "FROM issues WHERE id=?", (i,)).fetchone()
        if not row:
            raise GqError("not_found", str(i))
        st, ca, le, title, ty = row
        if st == "closed":
            return finish(db, c, "close", {"ok": True})  # idempotent no-op
        if (st == "in_progress" and (ca != actor or le != epoch)) or \
                (st != "in_progress" and le != epoch):
            raise GqError("stale_fence",
                          f"{i}: epoch {epoch}!={le} or actor {actor}!={ca}")
        db.execute("UPDATE issues SET status='closed',closed_at=? WHERE id=?",
                   (now, i))
        db.execute("DELETE FROM claims WHERE issue=?", (i,))
        ev(db, "close", i, actor, c["run_id"], c["idem"],
           {"reason": reason, "epoch": le})
        # SPEC §6.6: lesson outbox row in the SAME transaction as close.
        db.execute("INSERT INTO outbox(kind,payload,run_id) VALUES('lesson',?,?)",
                   (json.dumps({"issue": i, "type": ty,
                                "lesson": f"closed {i} ({ty}): {title}",
                                "reason": reason, "actor": actor},
                               default=str), c["run_id"]))
        return finish(db, c, "close", {"ok": True})


def op_reopen(db, a, c):
    i, actor = a.get("id"), a.get("actor") or c.get("actor")
    if not i or not actor:
        raise GqError("bad_args", "reopen needs id+actor")
    with tx(db):
        row = db.execute("SELECT status,claim_actor,lease_epoch FROM issues "
                         "WHERE id=?", (i,)).fetchone()
        if not row:
            raise GqError("not_found", str(i))
        st, ca, le = row
        e = _ep(a)
        if e is not None and (e != le or (st == "in_progress" and ca != actor)):
            raise GqError("stale_fence", f"{i}: epoch {e}!={le}")
        if st == "open":
            return finish(db, c, "reopen", {"ok": True})
        # epoch bump: any fence token held against the old run dies here
        db.execute("UPDATE issues SET status='open',closed_at=NULL,"
                   "lease_until=NULL,claim_actor=NULL,lease_epoch=lease_epoch+1 "
                   "WHERE id=?", (i,))
        db.execute("DELETE FROM claims WHERE issue=?", (i,))
        ev(db, "reopen", i, actor, c["run_id"], c["idem"],
           {"reason": a.get("reason")})
        return finish(db, c, "reopen", {"ok": True})


def op_reclaim(db, a, c):
    """Sweep stale claims -> open, epoch bumped so old actors stay fenced."""
    actor, now = a.get("actor") or "reaper", time.time()
    with tx(db):
        rows = db.execute(
            "UPDATE issues SET status='open',claim_actor=NULL,lease_until=NULL,"
            "lease_epoch=lease_epoch+1 WHERE status='in_progress' AND "
            "lease_until<? RETURNING id", (now,)).fetchall()
        for (i,) in rows:
            db.execute("DELETE FROM claims WHERE issue=?", (i,))
            ev(db, "reclaim", i, actor, c["run_id"], c["idem"],
               {"reason": "lease expired"})
        return finish(db, c, "reclaim", {"reclaimed": [r[0] for r in rows]})


def _edict(r):
    d = dict(zip(ECOLS, r))
    if d["data_json"] is not None:
        try:
            d["data"] = json.loads(d["data_json"])
        except ValueError:
            d['data'] = None
            d['data_error'] = 'invalid_json'
    return d


def op_show(db, a, c):
    i = a.get("id")
    issue = _issue(db, i)
    if not issue:
        raise GqError("not_found", str(i))
    deps = [{"depends_on": r[0], "type": r[1]} for r in db.execute(
        "SELECT depends_on,type FROM deps WHERE issue=?", (i,))]
    # blocked_by: open blocks-deps OR closed/absent gates — same predicate
    # as the ready gate.
    blocked_by = [r[0] for r in db.execute(
        "SELECT d.depends_on FROM deps d "
        "LEFT JOIN issues b ON b.id=d.depends_on "
        "LEFT JOIN gates g ON g.name=d.depends_on "
        "WHERE d.issue=? AND ("
        " ((d.type IS NULL OR d.type='blocks') AND b.status IS NOT NULL"
        "   AND b.status!='closed')"
        " OR (d.type='gate' AND COALESCE(g.state,'closed')!='open'))", (i,))]
    lim = _int(a.get("limit"), 100)
    evs = [_edict(r) for r in reversed(db.execute(
        "SELECT seq,ts,op,issue,actor,run_id,idem,data_json FROM events "
        "WHERE issue=? ORDER BY seq DESC LIMIT ?", (i, lim)).fetchall())]
    latest = db.execute(
        "SELECT data_json FROM events WHERE issue=? AND op='changes' "
        "ORDER BY seq DESC LIMIT 1", (i,)).fetchone()
    if latest and latest[0]:
        try:
            issue["changes"] = json.loads(latest[0]).get("files")
        except ValueError:
            pass
    issue["run_state"] = _run_state(db, i, issue)
    return {"issue": issue, "deps": deps, "blocked_by": blocked_by,
            "events_tail": evs}


def _run_state(db, i, issue):
    """Derived run stage from the event trail (goal-os L-1 FSM):
    queued -> claimed -> evidence -> verified -> closed."""
    verified = None
    v = db.execute(
        "SELECT data_json FROM events WHERE issue=? AND op='verify' "
        "ORDER BY seq DESC LIMIT 1", (i,)).fetchone()
    if v and v[0]:
        try:
            verified = bool(json.loads(v[0]).get("passed"))
        except ValueError:
            pass
    evidenced = bool(db.execute(
        "SELECT 1 FROM events WHERE issue=? "
        "AND op IN ('changes','checkpoint') LIMIT 1", (i,)).fetchone())
    return _stage(issue, verified, evidenced)


def op_search(db, a, c):
    q, lim = a.get("q") or "", _int(a.get("limit"), 20)
    try:
        return _idicts(db.execute(
            f"SELECT {ISEL_I} FROM issues_fts JOIN issues i "
            "ON i.rowid=issues_fts.rowid WHERE issues_fts MATCH ? "
            "ORDER BY rank, i.created_at LIMIT ?", (q, lim)))
    except sqlite3.Error:
        pass  # no FTS5 or bad MATCH syntax -> LIKE fallback
    like = f"%{q}%"
    return _idicts(db.execute(
        f'SELECT {ISEL} FROM issues WHERE title LIKE ? OR "desc" LIKE ? OR '
        "acceptance LIKE ? ORDER BY priority, created_at LIMIT ?",
        (like, like, like, lim)))


def op_stale(db, a, c):
    now = _f(a.get("now"), time.time())
    return _idicts(db.execute(
        f"SELECT {ISEL} FROM issues WHERE status='in_progress' AND "
        "lease_until IS NOT NULL AND lease_until<? ORDER BY lease_until",
        (now,)))


def op_orphans(db, a, c):
    """Open issues with no all-open dep path to an epic or a root (no deps)."""
    return _idicts(db.execute(
        "WITH RECURSIVE live(id) AS ("
        " SELECT i.id FROM issues i WHERE i.status='open' AND (i.type='epic' OR"
        "  NOT EXISTS (SELECT 1 FROM deps d WHERE d.issue=i.id))"
        " UNION"
        " SELECT d.issue FROM deps d JOIN live l ON d.depends_on=l.id"
        "  JOIN issues s ON s.id=d.issue WHERE s.status='open')"
        f"SELECT {ISEL} FROM issues WHERE status='open' AND "
        "id NOT IN (SELECT id FROM live)"))


def op_stats(db, a, c):
    """GROUP BY covers status counts (covering index); blocked scans deps
    outermost via CROSS JOIN (deps is small), not all open issues."""
    by = dict(db.execute(
        "SELECT status,COUNT(*) FROM issues GROUP BY status").fetchall())
    blocked = db.execute(
        "SELECT COUNT(*) FROM issues i WHERE i.status='open' AND NOT (" +
        BLOCKED_SQL + ")").fetchone()[0]
    pending = db.execute(
        "SELECT COUNT(*) FROM outbox WHERE state='pending'").fetchone()[0]
    o = by.get("open", 0)
    now = time.time()
    ready_n = db.execute(
        f"SELECT COUNT(*) FROM issues i WHERE {READY_WHERE}",
        (now, now, now)).fetchone()[0]
    return {"total": sum(by.values()), "open": o,
            "in_progress": by.get("in_progress", 0),
            "closed": by.get("closed", 0), "deferred": by.get("deferred", 0),
            "blocked": blocked, "ready": ready_n,
            "pending_outbox": pending}


def op_remember(db, a, c):
    k = a.get("key")
    if k is None:
        raise GqError("bad_args", "remember needs key")
    with tx(db):
        db.execute(
            "INSERT INTO memories(key,value,updated_at) VALUES(?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value,"
            "updated_at=excluded.updated_at",
            (k, _js(a.get("value")), time.time()))
        ev(db, "remember", None, c["actor"], c["run_id"], c["idem"],
           {"key": k})
        return finish(db, c, "remember", {"ok": True})


def op_recall(db, a, c):
    if a.get("key") is not None:
        rows = db.execute(
            "SELECT key,value,updated_at FROM memories WHERE key=?",
            (a["key"],)).fetchall()
    else:
        rows = db.execute(
            "SELECT key,value,updated_at FROM memories ORDER BY key").fetchall()
    return [{"key": k, "value": v, "updated_at": t} for k, v, t in rows]


def op_export(db, a, c):
    issues = _idicts(db.execute(
        f"SELECT {ISEL} FROM issues ORDER BY created_at, id"))
    if a.get("format") == "bd":
        dep_map = {}
        for i, d, ty in db.execute(
                "SELECT issue,depends_on,COALESCE(type,'blocks') FROM deps "
                "ORDER BY issue,depends_on"):
            dep_map.setdefault(i, []).append(
                {"issue_id": i, "depends_on_id": d, "type": ty})
        out = [{"id": i["id"], "title": i["title"], "description": i["desc"],
                "status": i["status"], "issue_type": i["type"],
                "priority": i["priority"],
                "labels": (i.get("meta") or {}).get("labels") or [],
                "created_at": i["created_at"], "closed_at": i["closed_at"],
                "acceptance": i["acceptance"], "oracle_cmd": i["oracle_cmd"],
                "owner": i["owner"], "lane": i["lane"],
                "dependencies": dep_map.get(i["id"], [])}
               for i in issues]
        return {"format": "bd", "issues": out, "n": len(out)}
    deps = [{"issue": i, "depends_on": d} for i, d in db.execute(
        "SELECT issue,depends_on FROM deps ORDER BY issue")]
    events = _dicts(db.execute(
        "SELECT seq,ts,op,issue,actor,run_id,idem,data_json FROM events "
        "ORDER BY seq"))
    return {"issues": issues, "deps": deps, "events": events,
            "events_count": len(events)}


def _imp_issue(db, o):
    cols = [k for k in o if k in SETCOLS or k in
            ("id", "status", "created_at", "closed_at", "lease_until",
             "lease_epoch", "claim_actor")]
    if "desc" not in cols and "descr" in o:
        o["desc"], cols = o["descr"], cols + ["desc"]
    if "priority" not in cols and "prio" in o:
        o["priority"], cols = o["prio"], cols + ["priority"]
    if "meta_json" not in cols and "meta" in o:
        o["meta_json"], cols = o["meta"], cols + ["meta_json"]
    i = o.get("id") or _uid(db)
    cols = [k for k in cols if k != "id"]
    vals = [_js(o[k]) if k in ("allowed_paths", "meta_json") else o[k]
            for k in cols]
    if cols:
        db.execute(f'INSERT OR REPLACE INTO issues(id,{",".join(cols)}) '
                   f"VALUES(?,{','.join('?' for _ in cols)})", (i, *vals))
    else:
        db.execute("INSERT OR IGNORE INTO issues(id) VALUES(?)", (i,))
    return 1


def _imp_event(db, o):
    cols = [k for k in ECOLS if k in o]
    if "data" in o and "data_json" not in cols:
        o["data_json"] = json.dumps(o["data"], default=str)
        cols.append("data_json")
    if "ts" not in cols:
        o["ts"], cols = time.time(), cols + ["ts"]
    db.execute(f"INSERT OR IGNORE INTO events({','.join(cols)}) "
               f"VALUES({','.join('?' for _ in cols)})",
               tuple(o[k] for k in cols))
    return 1


def snapshot_store(db, db_path, a=None):
    """Rewrite <db>.issues.jsonl atomically: one upsert line per issue,
    deps embedded, sorted by id. Git-diffable mirror of the issue state;
    same line format as the rust impl."""
    p = Path(db_path).with_name(Path(db_path).stem + ".issues.jsonl")
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    rows = db.execute(
        "SELECT id,title,status,priority,type,owner,oracle_cmd,"
        "allowed_paths,lane,budget_eur,acceptance,\"desc\",lease_until,"
        "lease_epoch,claim_actor,created_at,closed_at,defer_until,"
        "expires_at,meta_json FROM issues ORDER BY id").fetchall()
    deps = {}
    for i, d, t in db.execute(
            "SELECT issue,depends_on,type FROM deps "
            "ORDER BY issue,depends_on"):
        deps.setdefault(i, []).append({"on": d, "type": t or "blocks"})
    out = ['{"k":"sis-snapshot","v":1}\n']
    for r in rows:
        try:
            meta = json.loads(r[19]) if r[19] else None
        except ValueError:
            meta = {"_raw": r[19]}
        data = {"id": r[0], "title": r[1], "status": r[2],
                "priority": r[3], "type": r[4], "owner": r[5],
                "oracle_cmd": r[6], "allowed_paths": r[7],
                "lane": r[8], "budget_eur": r[9], "acceptance": r[10],
                "desc": r[11], "lease_until": r[12],
                "lease_epoch": r[13], "claim_actor": r[14],
                "created_at": r[15], "closed_at": r[16],
                "defer_until": r[17], "expires_at": r[18],
                "meta": meta, "deps": deps.get(r[0], [])}
        out.append(json.dumps({"op": "upsert", "issue": r[0],
                               "data": data}, sort_keys=True) + "\n")
    body = "".join(out).encode()
    # Deterministic content: unchanged mirror skips write+rename, so
    # writes that don't touch issue rows cost the scan only.
    try:
        if p.read_bytes() == body:
            return {"path": str(p), "issues": len(rows), "unchanged": True}
    except OSError:
        pass
    with open(tmp, "wb") as f:
        f.write(body)
    os.replace(tmp, p)
    return {"path": str(p), "issues": len(rows)}


def op_snapshot(db, a, c):
    return snapshot_store(db, c.get("db_path") or "sis.db", a)


def op_import(db, a, c):
    items = []
    if a.get("path"):
        try:
            with open(a["path"]) as f:
                items = [json.loads(line) for line in f if line.strip()]
        except OSError as e:
            raise GqError("bad_args", f"import: {e}")
    elif "jsonl" in a:
        jl = a["jsonl"]
        if isinstance(jl, str):
            items = [json.loads(line) for line in jl.splitlines() if line.strip()]
        elif isinstance(jl, list):
            items = [json.loads(x) if isinstance(x, str) else x for x in jl]
        else:
            items = [jl]
    elif isinstance(a.get("issues"), list) or isinstance(a.get("events"), list):
        items = [a]
    n = 0
    conflicts = []
    with tx(db):
        for o in items:
            if not isinstance(o, dict):
                continue
            if "issues" in o or "events" in o:
                for x in o.get("issues") or []:
                    n += _imp_issue(db, x)
                for x in o.get("events") or []:
                    n += _imp_event(db, x)
            elif a.get("format") == "bd" or (
                    "op" not in o and "issue_id" not in o and
                    ("issue_type" in o or "description" in o)):
                iid = o.get("id")
                if not iid:
                    continue
                if o.get("status") in ("open", "in_progress", "closed", "deferred"):
                    status = o["status"]
                else:
                    status = "open"
                # federation rules: a bd export must not steal a live claim or
                # implicitly reopen finished work (force overrides the latter).
                ex = db.execute(
                    "SELECT status,claim_actor,lease_until FROM issues WHERE id=?",
                    (iid,)).fetchone()
                if ex is not None:
                    if ex[0] != "closed" and (ex[2] or 0) > time.time():
                        conflicts.append({"id": iid, "reason": "active_claim",
                                          "actor": ex[1]})
                        continue
                    if ex[0] == "closed" and status != "closed" and a.get("force") is not True:
                        conflicts.append({"id": iid, "reason": "would_reopen"})
                        continue
                labels = o.get("labels") if isinstance(o.get("labels"), list) else []
                db.execute('INSERT OR REPLACE INTO issues(id,title,"desc",status,'
                           'priority,type,acceptance,closed_at,created_at,meta_json) '
                           'VALUES(?,?,?,?,?,?,?,?,COALESCE((SELECT created_at FROM issues '
                           'WHERE id=?),?),?)',
                           (iid, o.get("title") or "imported",
                            o.get("description") or o.get("desc") or "",
                            status, _f(o.get("priority"), 2),
                            o.get("issue_type") or o.get("type") or "task",
                            o.get("acceptance") or "",
                            _f(o.get("closed_at"), None), iid,
                            _f(o.get("created_at"), time.time()),
                            _js({"labels": labels})))
                for d in o.get("dependencies") or []:
                    if isinstance(d, dict):
                        on = d.get("depends_on_id") or d.get("depends_on")
                        if on:
                            db.execute("INSERT OR IGNORE INTO deps"
                                       "(issue,depends_on,type) VALUES(?,?,?)",
                                       (iid, on, d.get("type") or "blocks"))
                n += 1
            elif o.get("op") == "upsert":
                d = o.get("data") or {}
                iid = o.get("issue") or d.get("id")
                if not iid:
                    continue
                d["id"] = iid
                deps = d.get("deps")
                n += _imp_issue(db, d)
                if isinstance(deps, list):
                    db.execute("DELETE FROM deps WHERE issue=?", (iid,))
                    for dep in deps:
                        if isinstance(dep, dict) and dep.get("on"):
                            db.execute(
                                "INSERT OR IGNORE INTO deps"
                                "(issue,depends_on,type) VALUES(?,?,?)",
                                (iid, dep["on"], dep.get("type") or "blocks"))
            elif "op" in o or "seq" in o:
                n += _imp_event(db, o)
            else:
                n += _imp_issue(db, o)
        ev(db, "import", None, c["actor"], c["run_id"], c["idem"], {"n": n})
        return finish(db, c, "import", {"n": n, "conflicts": conflicts})


def op_batch(db, a, c):
    """All-or-nothing single TX (SPEC §6.7). Sub-ops run under savepoints."""
    ops = a.get("ops")
    if not isinstance(ops, list):
        raise GqError("bad_args", "batch needs ops:[{cmd,args}]")
    results = []
    with tx(db):
        for o in ops:
            if not isinstance(o, dict) or not o.get("cmd"):
                raise GqError("bad_args", "batch op needs cmd")
            cc = dict(c)
            cc["idem"] = o.get("idem")  # parent idem must NOT leak to children
            cc["run_id"] = o.get("run_id", c.get("run_id"))
            results.append(dispatch_op(db, o["cmd"], o.get("args"), cc))
    return finish(db, c, "batch", {"results": results})


def op_budget_claim(db, a, c):
    i, eur = a.get("issue"), _f(a.get("eur"))
    if not i or eur is None or eur < 0:
        raise GqError("bad_args", "budget_claim needs issue+eur>=0")
    with tx(db):
        row = db.execute("SELECT budget_eur FROM issues WHERE id=?",
                         (i,)).fetchone()
        if not row:
            raise GqError("not_found", str(i))
        if row[0] is None:
            ev(db, "budget_claim", i, c["actor"], c["run_id"], c["idem"],
               {"eur": eur, "remaining": None})
            return finish(db, c, "budget_claim", {"ok": True, "remaining": None})
        ok = db.execute(
            "UPDATE issues SET budget_eur=budget_eur-? WHERE id=? AND "
            "budget_eur>=?", (eur, i, eur)).rowcount == 1
        if not ok:
            raise GqError("over_budget",
                          f"{i}: requested {eur} > remaining {row[0]}")
        rem = db.execute("SELECT budget_eur FROM issues WHERE id=?",
                         (i,)).fetchone()[0]
        ev(db, "budget_claim", i, c["actor"], c["run_id"], c["idem"],
           {"eur": eur, "remaining": rem})
        return finish(db, c, "budget_claim", {"ok": True, "remaining": rem})


def op_contract(db, a, c):
    """Compatibility renderer; the installed agent module adds stable revision data."""
    i = a.get("id")
    issue = _issue(db, i)
    if not issue:
        raise GqError("not_found", str(i))
    deps = [r[0] for r in db.execute(
        "SELECT depends_on FROM deps WHERE issue=?", (i,))]
    blocked = [r[0] for r in db.execute(
        "SELECT d.depends_on FROM deps d JOIN issues b ON d.depends_on=b.id "
        "WHERE d.issue=? AND b.status!='closed'", (i,))]
    text = "\n".join([
        f"# contract {issue['id']}: {issue['title']}",
        f"type={issue['type']} status={issue['status']} "
        f"priority={issue['priority']} lane={issue['lane']} "
        f"owner={issue['owner']} budget_eur={issue['budget_eur']}",
        f"oracle_cmd: {issue['oracle_cmd'] or '-'}",
        f"acceptance: {issue['acceptance'] or '-'}",
        f"allowed_paths: {issue['allowed_paths'] or '-'}",
        f"deps: {','.join(deps) or '-'}",
        f"blocked_by: {','.join(blocked) or '-'}",
        "", issue["desc"] or ""])
    return {"contract_text": text, "anchors": [], "priors": None}


def op_outbox_list(db, a, c):
    if a.get("state") is not None:
        cur = db.execute(
            "SELECT id,kind,payload,state,attempts,run_id FROM outbox "
            "WHERE state=? ORDER BY id", (a["state"],))
    else:
        cur = db.execute(
            "SELECT id,kind,payload,state,attempts,run_id FROM outbox "
            "ORDER BY id")
    return _dicts(cur)


def op_outbox_done(db, a, c):
    with tx(db):
        ok = db.execute("UPDATE outbox SET state='done' WHERE id=?",
                        (_int(a.get("id")),)).rowcount == 1
        if not ok:
            raise GqError("not_found", str(a.get("id")))
        ev(db, "outbox_done", None, c["actor"], c["run_id"], c["idem"],
           {"id": a.get("id")})
        return finish(db, c, "outbox_done", {"ok": True})


def op_outbox_fail(db, a, c):
    with tx(db):
        ok = db.execute(
            "UPDATE outbox SET state='failed',attempts=attempts+1 WHERE id=?",
            (_int(a.get("id")),)).rowcount == 1
        if not ok:
            raise GqError("not_found", str(a.get("id")))
        ev(db, "outbox_fail", None, c["actor"], c["run_id"], c["idem"],
           {"id": a.get("id"), "err": a.get("err")})
        return finish(db, c, "outbox_fail", {"ok": True})


def op_compact(db, a, c):
    """Archive events older than `days` to jsonl, then delete them (SPEC §3)."""
    days = _f(a.get("days"), 30.0)
    ap = a.get("archive_path") or (c.get("db_path") or "sis.db") + \
        ".events-archive.jsonl"
    cutoff = time.time() - days * 86400.0
    with tx(db):
        rows = db.execute(
            "SELECT seq,ts,op,issue,actor,run_id,idem,data_json FROM events "
            "WHERE ts<? ORDER BY seq", (cutoff,)).fetchall()
        if rows:
            with open(ap, "a") as f:
                for r in rows:
                    f.write(json.dumps(dict(zip(ECOLS, r)), default=str) + "\n")
            db.execute("DELETE FROM events WHERE seq<=?", (rows[-1][0],))
        # wisp reap: expired issues deleted; events stay (provenance).
        reaped = db.execute(
            "DELETE FROM issues WHERE expires_at IS NOT NULL AND expires_at<=?",
            (time.time(),)).rowcount
        kept = db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        return finish(db, c, "compact", {"archived": len(rows), "kept": kept,
                                         "reaped": reaped, "archive_path": ap})


def op_update(db, a, c):
    i = a.get("id")
    if not i:
        raise GqError("bad_args", "update needs id")
    ren = {"descr": "desc", "prio": "priority", "meta": "meta_json"}
    sets = {}
    if a.get("field") is not None:
        sets[ren.get(a["field"], a["field"])] = a.get("value")
    for k, v in a.items():
        k2 = ren.get(k, k)
        if k2 in SETCOLS:
            sets[k2] = v
    if not sets:
        raise GqError("bad_args", "nothing to update")
    with tx(db):
        if not db.execute("SELECT 1 FROM issues WHERE id=?", (i,)).fetchone():
            raise GqError("not_found", str(i))
        sql = "UPDATE issues SET " + ",".join(
            f'"{k}"=?' for k in sets) + " WHERE id=?"
        db.execute(sql, [_js(v) if k in ("allowed_paths", "meta_json") else v
                         for k, v in sets.items()] + [i])
        ev(db, "update", i, c["actor"], c["run_id"], c["idem"],
           {"fields": sorted(sets)})
        return finish(db, c, "update", {"ok": True})


def op_watch(db, a, c):
    """CLI/snapshot form: events with seq > after (socket form streams live)."""
    after, lim = _int(a.get("after"), 0), _int(a.get("limit"), 1000)
    rows = db.execute(
        "SELECT seq,ts,op,issue,actor,run_id,idem,data_json FROM events "
        "WHERE seq>? ORDER BY seq LIMIT ?", (after, lim)).fetchall()
    return {"events": [_edict(r) for r in rows]}


def op_dep_list(db, a, c):
    sql = "SELECT issue,depends_on,type FROM deps"
    p = []
    if a.get("id") or a.get("issue"):
        sql += " WHERE (issue=? OR depends_on=?)"
        p += [a.get("id") or a.get("issue")] * 2
    rows = db.execute(sql + " ORDER BY issue,depends_on", p).fetchall()
    return [{"issue": i, "depends_on": d, "type": t or "blocks"}
            for i, d, t in rows]


def op_dep_remove(db, a, c):
    i, d = a.get("issue"), a.get("depends_on")
    if not i or not d:
        raise GqError("bad_args", "dep_remove needs issue+depends_on")
    with tx(db):
        n = db.execute("DELETE FROM deps WHERE issue=? AND depends_on=?",
                       (i, d)).rowcount
        if not n:
            raise GqError("not_found", f"dep {i}->{d}")
        ev(db, "dep_remove", i, c["actor"], c["run_id"], c["idem"],
           {"depends_on": d})
        return finish(db, c, "dep_remove", {"ok": True})


def op_children(db, a, c):
    i = a.get("id")
    if not i:
        raise GqError("bad_args", "children needs id")
    return _idicts(db.execute(
        f"SELECT {ISEL_I} FROM issues i "
        "WHERE json_extract(i.meta_json,'$.parent')=? "
        "ORDER BY i.priority,i.created_at", (i,)))


def _list_where(a):
    w, p = " WHERE 1=1", []
    for k, col in (("status", "i.status"), ("type", "i.type"),
                   ("lane", "i.lane"), ("owner", "i.owner")):
        if a.get(k) is not None:
            w += f" AND {col}=?"
            p.append(a[k])
    if a.get("priority") is not None:
        w += " AND i.priority=?"
        p.append(_int(a["priority"]))
    if a.get("label") is not None:
        w += (" AND EXISTS (SELECT 1 FROM json_each(i.meta_json,'$.labels')"
              " je WHERE je.value=?)")
        p.append(a["label"])
    if a.get("q") is not None:
        w += ' AND (i.title LIKE ? OR i."desc" LIKE ?)'
        p += [f"%{a['q']}%"] * 2
    return w, p


def op_list(db, a, c):
    w, p = _list_where(a)
    sql = (f"SELECT {ISEL_I} FROM issues i{w} "
           "ORDER BY i.priority,i.created_at,i.id")
    if a.get("limit"):
        sql += " LIMIT ?"
        p.append(_int(a["limit"]))
    rows = _idicts(db.execute(sql, p))
    for r in rows:
        latest = db.execute(
            "SELECT data_json FROM events WHERE issue=? AND op='changes' "
            "ORDER BY seq DESC LIMIT 1", (r.get("id"),)).fetchone()
        if latest and latest[0]:
            try:
                r["changes"] = json.loads(latest[0]).get("files")
            except ValueError:
                pass
    _attach_run_state(db, rows)
    return rows


def _attach_run_state(db, rows):
    """Derived `run_state` per listed row — two grouped queries for the
    whole page (chunked under the SQLite variable cap), never N+1 scans."""
    for i in range(0, len(rows), 500):
        chunk = [r for r in rows[i:i + 500] if r.get("id")]
        ids = [r["id"] for r in chunk]
        if not ids:
            continue
        marks = ",".join("?" * len(ids))
        verified = {}
        for iid, dj in db.execute(
                "SELECT issue,data_json FROM events WHERE op='verify' "
                f"AND issue IN ({marks}) ORDER BY seq", ids):
            try:
                verified[iid] = bool(json.loads(dj).get("passed"))
            except (ValueError, AttributeError):
                verified[iid] = False
        evidenced = {r[0] for r in db.execute(
            "SELECT DISTINCT issue FROM events "
            f"WHERE op IN ('changes','checkpoint') AND issue IN ({marks})",
            ids)}
        for r in chunk:
            r["run_state"] = _stage(r, verified.get(r["id"]),
                                    r["id"] in evidenced)


def _stage(issue, verified, evidenced):
    if issue.get("status") == "closed":
        return "closed"
    if verified is not None:
        return "verified" if verified else "evidence"
    if evidenced:
        return "evidence"
    if (issue.get("claim_actor")
            or (issue.get("lease_until") or 0) > time.time()):
        return "claimed"
    return "queued"


def op_count(db, a, c):
    w, p = _list_where(a)
    return {"count": db.execute(
        f"SELECT COUNT(*) FROM issues i{w}", p).fetchone()[0]}


def op_note(db, a, c):
    i, text = a.get("id"), a.get("text")
    if not i or text is None:
        raise GqError("bad_args", "note needs id+text")
    with tx(db):
        if not db.execute("SELECT 1 FROM issues WHERE id=?", (i,)).fetchone():
            raise GqError("not_found", str(i))
        ev(db, "note", i, c["actor"], c["run_id"], c["idem"], {"text": text})
        return finish(db, c, "note", {"ok": True})


def op_changes(db, a, c):
    """Append compact git-diff file summary (path, +adds/-dels, hunk ranges)
    as a `changes` event; caller-side computed, no code stored."""
    i = a.get("id")
    if not i:
        raise GqError("bad_args", "changes needs id")
    files = a.get("files") or []
    if not isinstance(files, list):
        raise GqError("bad_args", "files must be an array")
    with tx(db):
        if not db.execute("SELECT 1 FROM issues WHERE id=?", (i,)).fetchone():
            raise GqError("not_found", str(i))
        files = files[:80]
        adds = sum(int(f.get("adds") or 0) for f in files if isinstance(f, dict))
        dels = sum(int(f.get("dels") or 0) for f in files if isinstance(f, dict))
        fingerprint = hashlib.sha256(
            json.dumps(files, sort_keys=True).encode()).hexdigest()[:16]
        if a.get("force") is None:
            last = db.execute(
                "SELECT data_json FROM events WHERE issue=? AND op='changes' "
                "ORDER BY seq DESC LIMIT 1", (i,)).fetchone()
            if last and last[0]:
                try:
                    if (json.loads(last[0]).get("fingerprint") == fingerprint
                            and a.get("patch") is None):
                        return finish(db, c, "changes", {
                            "id": i, "files": files, "adds": adds,
                            "dels": dels, "unchanged": True})
                except ValueError:
                    pass
        ev(db, "changes", i, c["actor"], c["run_id"], c["idem"], {
            "files": files, "base": a.get("base"), "head": a.get("head"),
            "head_subject": a.get("head_subject"),
            "branch": a.get("branch"), "repo": a.get("repo"),
            "patch": a.get("patch"),
            "patch_truncated": a.get("patch_truncated"),
            "fingerprint": fingerprint,
            "summary": {"files": len(files), "adds": adds, "dels": dels}})
        return finish(db, c, "changes",
                      {"id": i, "files": files, "adds": adds, "dels": dels})


def _issue_events(db, i, opf=None):
    sql = ("SELECT seq,ts,op,actor,data_json FROM events WHERE issue=?")
    p = [i]
    if opf:
        sql += " AND op=?"
        p.append(opf)
    return db.execute(sql + " ORDER BY seq", p).fetchall()


def op_comments(db, a, c):
    i = a.get("id")
    if not i:
        raise GqError("bad_args", "comments needs id")
    return [{"ts": ts, "actor": ac,
             "text": (json.loads(dj or "{}").get("text"))}
            for _, ts, _, ac, dj in _issue_events(db, i, "note")]


def op_history(db, a, c):
    i = a.get("id")
    if not i:
        raise GqError("bad_args", "history needs id")
    return [{"seq": s, "ts": ts, "op": o, "actor": ac,
             "data": json.loads(dj) if dj else None}
            for s, ts, o, ac, dj in _issue_events(db, i)]


def op_unclaim(db, a, c):
    i = a.get("id")
    if not i:
        raise GqError("bad_args", "unclaim needs id")
    with tx(db):
        r = db.execute("SELECT status,claim_actor FROM issues WHERE id=?",
                       (i,)).fetchone()
        if not r:
            raise GqError("not_found", str(i))
        if r[0] != "in_progress":
            raise GqError("not_claimed", f"issue {i} not in_progress")
        db.execute("UPDATE issues SET status='open',claim_actor=NULL,"
                   "lease_until=NULL WHERE id=?", (i,))
        db.execute("DELETE FROM claims WHERE issue=?", (i,))
        ev(db, "unclaim", i, c["actor"], c["run_id"], c["idem"], {})
        return finish(db, c, "unclaim", {"ok": True})


def op_defer(db, a, c):
    i = a.get("id")
    if not i:
        raise GqError("bad_args", "defer needs id")
    until = _f(a.get("until") if a.get("until") is not None
               else a.get("defer_until"))
    with tx(db):
        if not db.execute("SELECT 1 FROM issues WHERE id=?", (i,)).fetchone():
            raise GqError("not_found", str(i))
        db.execute("UPDATE issues SET status='deferred',defer_until=?"
                   " WHERE id=?", (until, i))
        ev(db, "defer", i, c["actor"], c["run_id"], c["idem"], {"until": until})
        return finish(db, c, "defer", {"ok": True})


def op_undefer(db, a, c):
    i = a.get("id")
    if not i:
        raise GqError("bad_args", "undefer needs id")
    with tx(db):
        if not db.execute("SELECT 1 FROM issues WHERE id=?", (i,)).fetchone():
            raise GqError("not_found", str(i))
        db.execute("UPDATE issues SET status='open',defer_until=NULL"
                   " WHERE id=?", (i,))
        ev(db, "undefer", i, c["actor"], c["run_id"], c["idem"], {})
        return finish(db, c, "undefer", {"ok": True})


def op_label(db, a, c):
    i = a.get("id")
    if not i:
        raise GqError("bad_args", "label needs id")

    def arg_list(v):
        if isinstance(v, list):
            return [str(x) for x in v]
        if isinstance(v, str):
            if v.startswith("["):
                try:
                    return [str(x) for x in json.loads(v)]
                except ValueError:
                    return [v]
            return [v]
        return []

    with tx(db):
        r = db.execute("SELECT meta_json FROM issues WHERE id=?",
                       (i,)).fetchone()
        if not r:
            raise GqError("not_found", str(i))
        mo = json.loads(r[0] or "{}")
        labels = list(mo.get("labels") or [])
        for label in arg_list(a.get("add")):
            if label not in labels:
                labels.append(label)
        rm = arg_list(a.get("remove"))
        labels = [label for label in labels if label not in rm]
        mo["labels"] = labels
        db.execute("UPDATE issues SET meta_json=? WHERE id=?",
                   (json.dumps(mo, **JD), i))
        ev(db, "label", i, c["actor"], c["run_id"], c["idem"],
           {"labels": labels})
        return finish(db, c, "label", {"labels": labels})


def op_rename(db, a, c):
    old, new = a.get("from"), a.get("to")
    if not old or not new:
        raise GqError("bad_args", "rename needs from+to")
    with tx(db):
        if not db.execute("SELECT 1 FROM issues WHERE id=?", (old,)).fetchone():
            raise GqError("not_found", str(old))
        if db.execute("SELECT 1 FROM issues WHERE id=?", (new,)).fetchone():
            raise GqError("exists", str(new))
        db.execute("UPDATE issues SET id=? WHERE id=?", (new, old))
        db.execute("UPDATE issues SET meta_json=replace(meta_json,"
                   "'\"parent\":\"'||?||'\"','\"parent\":\"'||?||'\"')"
                   " WHERE meta_json LIKE '%\"parent\":\"'||?||'\"%'",
                   (old, new, old))
        db.execute("UPDATE deps SET issue=? WHERE issue=?", (new, old))
        db.execute("UPDATE deps SET depends_on=? WHERE depends_on=?",
                   (new, old))
        db.execute("UPDATE claims SET issue=? WHERE issue=?", (new, old))
        ev(db, "rename", new, c["actor"], c["run_id"], c["idem"],
           {"from": old})
        return finish(db, c, "rename", {"id": new})


def op_delete(db, a, c):
    i = a.get("id")
    if not i:
        raise GqError("bad_args", "delete needs id")
    with tx(db):
        if not db.execute("SELECT 1 FROM issues WHERE id=?", (i,)).fetchone():
            raise GqError("not_found", str(i))
        db.execute("DELETE FROM deps WHERE issue=? OR depends_on=?", (i, i))
        db.execute("DELETE FROM claims WHERE issue=?", (i,))
        db.execute("DELETE FROM issues WHERE id=?", (i,))
        ev(db, "delete", i, c["actor"], c["run_id"], c["idem"], {})
        return finish(db, c, "delete", {"ok": True})


def op_lint(db, a, c):
    rows = db.execute(
        "SELECT id,title FROM issues WHERE status!='closed' AND "
        "(oracle_cmd IS NULL OR oracle_cmd='') AND "
        "(acceptance IS NULL OR acceptance='') ORDER BY priority").fetchall()
    return {"needs_oracle": [
        {"id": i, "title": t, "missing": ["oracle_cmd", "acceptance"]}
        for i, t in rows]}


def op_types(db, a, c):
    return ["task", "bug", "feature", "epic", "chore", "question", "doc",
            "decision", "event"]


def op_statuses(db, a, c):
    return ["open", "in_progress", "blocked", "deferred", "closed"]


def op_gate(db, a, c):
    """Named wait-primitive: dep type='gate' blocks until state='open'."""
    name = a.get("name")
    if not name:
        raise GqError("bad_args", "gate needs name")
    state = a.get("state")
    with tx(db):
        if state is None:
            row = db.execute("SELECT state FROM gates WHERE name=?",
                             (name,)).fetchone()
            return finish(db, c, "gate", {"name": name,
                                          "state": row[0] if row else "closed"})
        db.execute("INSERT INTO gates(name,state,payload,updated_at)"
                   " VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET"
                   " state=?,payload=?,updated_at=?",
                   (name, state, a.get("payload"), time.time(),
                    state, a.get("payload"), time.time()))
        ev(db, "gate", None, c["actor"], c["run_id"], c["idem"],
           {"name": name, "state": state})
        return finish(db, c, "gate", {"name": name, "state": state})


def op_slot_acquire(db, a, c):
    """bd merge-slot: serialized merge token with fencing — holder only may
    merge; TTL + epoch mirror the claim invariants."""
    name, actor = a.get("name"), a.get("actor")
    if not name or not actor:
        raise GqError("bad_args", "slot_acquire needs name+actor")
    ttl, now = _f(a.get("ttl"), LEASE_S), time.time()
    cid = _uid(db)
    with tx(db):
        n = db.execute(
            "UPDATE slots SET holder=?,epoch=epoch+1,lease_until=?,"
            "claim_id=?,updated_at=? WHERE name=? AND"
            " (holder IS NULL OR lease_until<?)",
            (actor, now + ttl, cid, now, name, now)).rowcount
        if n == 0:
            db.execute("INSERT OR IGNORE INTO slots"
                       "(name,holder,epoch,lease_until,claim_id,updated_at)"
                       " VALUES(?,?,1,?,?,?)",
                       (name, actor, now + ttl, cid, now))
            held = db.execute("SELECT holder,lease_until FROM slots"
                              " WHERE name=?", (name,)).fetchone()
            if not held or held[0] != actor or held[1] < now:
                raise GqError("slot_held",
                              f"slot {name} held by "
                              f"{held[0] if held else '?'}")
        epoch, lu = db.execute(
            "SELECT epoch,lease_until FROM slots WHERE name=? AND holder=?",
            (name, actor)).fetchone()
        ev(db, "slot_acquire", None, c["actor"], c["run_id"], c["idem"],
           {"name": name, "actor": actor, "epoch": epoch})
        return finish(db, c, "slot_acquire",
                      {"name": name, "holder": actor, "epoch": epoch,
                       "claim_id": cid, "lease_until": lu})


def op_slot_release(db, a, c):
    name, actor, epoch = a.get("name"), a.get("actor"), a.get("epoch")
    if not name or not actor:
        raise GqError("bad_args", "slot_release needs name+actor")
    with tx(db):
        cur = db.execute("SELECT holder,epoch FROM slots WHERE name=?",
                         (name,)).fetchone()
        if not cur:
            raise GqError("not_found", f"slot {name}")
        if cur[0] != actor:
            raise GqError("slot_held", f"slot {name} held by {cur[0]}")
        if epoch is not None and epoch != cur[1]:
            raise GqError("stale_fence", f"epoch {cur[1]}")
        db.execute("UPDATE slots SET holder=NULL,lease_until=NULL,"
                   "claim_id=NULL,updated_at=? WHERE name=?",
                   (time.time(), name))
        ev(db, "slot_release", None, c["actor"], c["run_id"], c["idem"],
           {"name": name, "actor": actor})
        return finish(db, c, "slot_release",
                      {"name": name, "released": True})


def op_slot_list(db, a, c):
    rows = db.execute(
        "SELECT name,holder,epoch,lease_until,claim_id,updated_at"
        " FROM slots ORDER BY name").fetchall()
    return [{"name": r[0], "holder": r[1], "epoch": r[2],
             "lease_until": r[3], "claim_id": r[4],
             "updated_at": r[5]} for r in rows]


def op_gate_list(db, a, c):
    rows = db.execute(
        "SELECT name,state,payload,updated_at FROM gates ORDER BY name"
    ).fetchall()
    return [{"name": r[0], "state": r[1], "payload": r[2],
             "updated_at": r[3]} for r in rows]


def op_epic(db, a, c):
    """Parent + children + progress rollup in one op."""
    i = a.get("id")
    if not i:
        raise GqError("bad_args", "epic needs id")
    issue = _issue(db, i)
    if not issue:
        raise GqError("not_found", str(i))
    children = _idicts(db.execute(
        f"SELECT {ISEL_I} FROM issues i "
        "WHERE json_extract(i.meta_json,'$.parent')=? "
        "ORDER BY i.status='closed',i.priority,i.created_at", (i,)))
    counts = {"total": len(children)}
    for ch in children:
        s = ch.get("status") or "open"
        counts[s] = counts.get(s, 0) + 1
    counts["pct_done"] = (counts.get("closed", 0) * 100 // len(children)
                          if children else 0)
    return {"issue": issue, "children": children, "counts": counts}


def op_dup_scan(db, a, c):
    """bd find-duplicates (FTS variant): title-token overlap scoring."""
    minimum = max(1, _int(a.get("min"), 2))
    if a.get("id"):
        row = db.execute("SELECT title FROM issues WHERE id=?",
                         (a["id"],)).fetchone()
        if not row:
            raise GqError("not_found", str(a["id"]))
        titles = [(a["id"], row[0])]
    else:
        titles = db.execute(
            "SELECT id,title FROM issues WHERE status!='closed'").fetchall()
    out = []
    for i, title in titles:
        toks = {w for w in re.split(r"[^0-9A-Za-z]+", (title or "").lower())
                if len(w) >= 4}
        if len(toks) < minimum:
            continue
        q = " OR ".join(f'"{w}"' for w in toks)
        try:
            cands = db.execute(
                "SELECT i.id,i.title FROM issues_fts f JOIN issues i"
                " ON f.rowid=i.rowid WHERE issues_fts MATCH ? AND i.id!=?"
                " AND i.status!='closed'", (q, i)).fetchall()
        except sqlite3.Error:
            cands = db.execute(
                "SELECT id,title FROM issues WHERE id!=? AND"
                " status!='closed'", (i,)).fetchall()
            cands = [(cid, t) for cid, t in cands
                     if len(toks & {w for w in re.split(r"[^0-9A-Za-z]+",
                                  (t or "").lower()) if len(w) >= 4})
                     >= minimum]
        for cid, ctitle in cands:
            ct = {w for w in re.split(r"[^0-9A-Za-z]+", (ctitle or "").lower())
                  if len(w) >= 4}
            shared = len(toks & ct)
            # word-Jaccard + char-3gram Jaccard (typos/word-forms);
            # `threshold` adds a score gate on top of `min`.
            jacc = shared / max(1, len(toks | ct))
            def tri(text):
                return {text[k:k + 3] for k in range(max(0, len(text) - 2))}
            a3, b3 = tri((title or "").lower()), tri((ctitle or "").lower())
            t3 = len(a3 & b3) / max(1, len(a3 | b3))
            score = min(1.0, jacc * 0.6 + t3 * 0.4)
            thr = float(a.get("threshold") or 0.0)
            if shared >= minimum and score >= thr:
                out.append({"id": i, "dup": cid, "shared": shared,
                            "score": round(score, 3),
                            "title": title, "dup_title": ctitle})
    out.sort(key=lambda x: -x["shared"])
    return out


# ---------- goal layer: named goals, subgoals, atomic plans, dashboards ----------
def _slug(s: str) -> str:
    """`sis-<name-slug>` — readable goal/subgoal handles (umlauts → ae/oe/ue)."""
    t = (s or "").lower()
    for u, r in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        t = t.replace(u, r)
    out = re.sub(r"[^0-9a-z]+", "-", t).strip("-")[:40]
    return out or "goal"


def _child_where(alias: str = "i") -> str:
    """child predicate: meta.parent=p OR bd-dotted id p.<n> (single level —
    synced bd corpora carry hierarchy in the id itself)."""
    return (f"(json_extract({alias}.meta_json,'$.parent')=? OR "
            f"({alias}.id LIKE ?||'.%' AND "
            f"instr(substr({alias}.id,length(?)+2),'.')=0))")


def _next_sub_id(db, parent: str) -> str:
    """bd convention: <parent>.<n> — max numeric suffix + 1."""
    rows = db.execute("SELECT id FROM issues WHERE id LIKE ?",
                      (parent + ".%",)).fetchall()
    maxn = 0
    for (i,) in rows:
        tail = i[len(parent) + 1:]
        if tail.isdigit():
            maxn = max(maxn, int(tail))
    return f"{parent}.{maxn + 1}"


def op_goal(db, a, c):
    """`goal`: type='goal' issue with readable slug id; objective/target in meta."""
    name = a.get("name") or a.get("title") or ""
    if not name:
        raise GqError("bad_args", "goal needs name")
    i = a.get("id")
    if not i:
        base = "sis-" + _slug(name)
        i, n = base, 2
        while db.execute("SELECT 1 FROM issues WHERE id=?", (i,)).fetchone():
            i, n = f"{base}-{n}", n + 1
            if n > 99:
                i = _uid(db)
                break
    meta = dict(a.get("meta") or {})
    if a.get("objective"):
        meta["objective"] = a["objective"]
    if a.get("target"):
        meta["target"] = a["target"]
    args = dict(a, id=i, title=name, type="goal", meta=meta)
    return op_create(db, args, c)


def op_sub(db, a, c):
    """`sub`: child issue under a goal — id <parent>.<n>, meta.parent set."""
    parent = a.get("parent")
    if not parent:
        raise GqError("bad_args", "sub needs parent")
    if not db.execute("SELECT 1 FROM issues WHERE id=?", (parent,)).fetchone():
        raise GqError("not_found", str(parent))
    args = dict(a, id=_next_sub_id(db, parent), parent=parent)
    return op_create(db, args, c)


def op_plan(db, a, c):
    """`plan`: atomic goal tree — goal + subs in one tx; subs[i].deps=[j]
    wires intra-plan block edges. All-or-nothing."""
    g = op_goal(db, a, c)
    gid = g["id"]
    ids = []
    subs = a.get("subs") or []
    for s in subs:
        sa = dict(s, parent=gid)
        ids.append(op_sub(db, sa, c)["id"])
    for i, s in enumerate(subs):
        for j in (s.get("deps") or []):
            if isinstance(j, int) and 0 <= j < len(ids):
                op_dep(db, {"issue": ids[i], "depends_on": ids[j]}, c)
    return {"goal": gid, "name": a.get("name"), "children": ids}


def _goal_kids(db, i: str, depth: int = 0) -> list:
    if depth > 8:
        return []
    kids = _idicts(db.execute(
        f"SELECT {ISEL_I} FROM issues i WHERE {_child_where('i')} "
        "ORDER BY i.priority,i.created_at", (i, i, i)))
    for k in kids:
        k["children"] = _goal_kids(db, k["id"], depth + 1)
    return kids


def op_goal_tree(db, a, c):
    """`goal_tree`/`tree`: id → nested descendants; none → open goals + pct."""
    i = a.get("id")
    if i:
        root = _issue(db, i)
        if not root:
            raise GqError("not_found", str(i))
        root["children"] = _goal_kids(db, i)
        return root
    goals = _idicts(db.execute(
        f"SELECT {ISEL_I} FROM issues i WHERE i.type='goal' "
        "AND i.status!='closed' ORDER BY i.priority,i.created_at"))
    for g in goals:
        ch = _goal_kids(db, g["id"])
        closed = sum(1 for x in ch if x.get("status") == "closed")
        g["pct_done"] = closed * 100 // len(ch) if ch else 0
        g["children"] = ch
    return goals


def op_next(db, a, c):
    """`next`: ready issues inside a goal subtree (global when no goal)."""
    now = time.time()
    ps = [now, now, now]
    sql = f"SELECT {ISEL_I} FROM issues i WHERE {READY_PRED} AND {BLOCKED_SQL}"
    if a.get("goal"):
        sql += (" AND i.id IN (WITH RECURSIVE sub(x) AS ("
                f"SELECT id FROM issues WHERE {_child_where('issues')} "
                "UNION SELECT i2.id FROM issues i2 JOIN sub s ON "
                + _child_where("i2").replace("?", "s.x") +
                ") SELECT x FROM sub)")
        ps += [a["goal"], a["goal"], a["goal"]]
    if a.get("lane"):
        sql += " AND (i.lane=? OR i.lane IS NULL OR i.lane='')"
        ps.append(a["lane"])
    sql += " ORDER BY i.priority, i.created_at, i.id"
    if a.get("limit"):
        sql += " LIMIT ?"
        ps.append(_int(a["limit"]))
    return _idicts(db.execute(sql, ps))


def op_review(db, a, c):
    """`review`: supervisor dashboard — stats + oracle gaps + stale + gates +
    slots + orphans + pending lessons in one op (governor input)."""
    return {"stats": op_stats(db, a, c),
            "needs_oracle": op_lint(db, a, c)["needs_oracle"],
            "stale": op_stale(db, a, c), "gates": op_gate_list(db, a, c),
            "slots": op_slot_list(db, a, c), "orphans": op_orphans(db, a, c),
            "pending_outbox": db.execute(
                "SELECT COUNT(*) FROM outbox WHERE state='pending'"
            ).fetchone()[0]}


def op_goal_done(db, a, c):
    """`goal_done`: subtree-complete check — all descendants closed. Returns
    the goal's oracle_cmd; caller runs it as final proof before close."""
    i = a.get("id")
    if not i:
        raise GqError("bad_args", "goal_done needs id")
    issue = _issue(db, i)
    if not issue:
        raise GqError("not_found", str(i))
    open_ids = [r[0] for r in db.execute(
        "WITH RECURSIVE sub(x) AS ("
        f"SELECT id FROM issues WHERE {_child_where('issues')} "
        "UNION SELECT i.id FROM issues i JOIN sub s ON "
        + _child_where("i").replace("?", "s.x") +
        ") SELECT id FROM issues WHERE id IN (SELECT x FROM sub) "
        "AND status!='closed'", (i, i, i))]
    done = not open_ids
    return {"id": i, "done": done, "open": open_ids,
            "oracle_cmd": issue.get("oracle_cmd"),
            "hint": "subtree closed — run oracle_cmd as final proof"
                    if done else "children still open"}


def op_prime(db, a, c):
    return {
        "protocol": "NDJSON over unix socket /tmp/sis-<db-stem>.sock or `sis <op>` CLI",
        "loop": "claim_next(actor) → show/contract(id) → work inside allowed_paths → run oracle_cmd → close(id, epoch, proof) → outbox lesson",
        "rules": ["claim only with oracle", "heartbeats < lease TTL",
                  "close needs fencing epoch + proof",
                  "weak oracle → never dispatch",
                  "only blocks deps gate readiness",
                  "deferred auto-readies at defer_until"],
        "ops": sorted(OPS),
    }


OPS = {
    "create": op_create, "dep": op_dep, "ready": op_ready,
    "dep_list": op_dep_list, "dep_remove": op_dep_remove,
    "children": op_children, "list": op_list, "query": op_list,
    "count": op_count, "note": op_note, "comment": op_note,
    "changes": op_changes,
    "comments": op_comments, "history": op_history,
    "unclaim": op_unclaim, "defer": op_defer, "undefer": op_undefer,
    "label": op_label, "tag": op_label, "rename": op_rename,
    "delete": op_delete, "lint": op_lint, "types": op_types,
    "statuses": op_statuses, "prime": op_prime,
    "claim": op_claim, "claim_next": op_claim_next,
    "heartbeat": op_heartbeat, "close": op_close, "reopen": op_reopen,
    "reclaim": op_reclaim, "show": op_show, "search": op_search,
    "stale": op_stale, "orphans": op_orphans, "stats": op_stats,
    "remember": op_remember, "recall": op_recall, "export": op_export,
    "import": op_import, "batch": op_batch, "budget_claim": op_budget_claim,
    "contract": op_contract, "outbox_list": op_outbox_list,
    "outbox_done": op_outbox_done, "outbox_fail": op_outbox_fail,
    "compact": op_compact, "update": op_update, "watch": op_watch,
    "gate": op_gate, "gate_list": op_gate_list, "epic": op_epic,
    "dup_scan": op_dup_scan, "q": op_create,
    "slot_acquire": op_slot_acquire, "merge_slot": op_slot_acquire,
    "slot_release": op_slot_release, "slot_list": op_slot_list,
    "goal": op_goal, "goal_create": op_goal, "sub": op_sub,
    "subgoal": op_sub, "plan": op_plan, "goal_tree": op_goal_tree,
    "tree": op_goal_tree, "next": op_next, "review": op_review,
    "goal_done": op_goal_done, "snapshot": op_snapshot,
}

# ops that may write; only they consult the idem cache
MUT = {"create", "dep", "claim", "claim_next", "heartbeat", "close", "reopen",
       "reclaim", "remember", "import", "batch", "budget_claim", "update",
       "outbox_done", "outbox_fail", "compact", "gate", "q",
       "slot_acquire", "merge_slot", "slot_release",
       "goal", "goal_create", "sub", "subgoal", "plan", "goal_done"}

# Every cmd that can change issue state -> refreshes .issues.jsonl.
WRITERS = MUT | {"note", "comment", "unclaim", "defer", "undefer", "label",
                 "tag", "rename", "delete", "dep_remove", "verify",
                 "acquire", "admin_update"}

# positional list-args -> dict (goalos-style clients)
POS = {
    "dep": ["issue", "depends_on"], "ready": ["lane", "limit"],
    "claim": ["id", "actor", "ttl", "run_id"],
    "claim_next": ["actor", "lane", "ttl", "run_id"],
    "heartbeat": ["id", "actor", "epoch", "ttl"],
    "close": ["id", "actor", "epoch", "reason", "run_id"],
    "reopen": ["id", "actor", "epoch", "reason"],
    "reclaim": ["actor"], "show": ["id", "limit"],
    "search": ["q", "limit"], "stale": ["now"],
    "remember": ["key", "value"], "recall": ["key"],
    "import": ["path"], "budget_claim": ["issue", "eur", "run_id"],
    "contract": ["id"], "outbox_list": ["state"], "outbox_done": ["id"],
    "outbox_fail": ["id", "err"], "compact": ["days", "archive_path"],
    "update": ["id", "field", "value"], "watch": ["after", "limit"],
    "gate": ["name", "state"], "epic": ["id"],
    "dup_scan": ["id"], "q": ["title"],
    "slot_acquire": ["name", "actor"], "merge_slot": ["name", "actor"],
    "slot_release": ["name", "actor", "epoch"],
    "batch": ["ops"],
    "goal": ["name", "objective"], "sub": ["parent", "title"],
    "plan": ["name"], "goal_tree": ["id"], "tree": ["id"],
    "next": ["goal"], "goal_done": ["id"], "review": [],
}


def _coerce_args(cmd, args):
    if args is None:
        return {}
    if isinstance(args, dict):
        return args
    if not isinstance(args, (list, tuple)):
        args = [args]
    if cmd == "dep" and all(isinstance(x, dict) for x in args):
        return {"deps": list(args)}
    if cmd == "batch" and all(isinstance(x, dict) for x in args):
        return {"ops": list(args)}
    keys = POS.get(cmd)
    if keys:
        d = {k: v for k, v in zip(keys, args)}
        return d
    return {"_args": list(args)}


def dispatch_op(db, cmd, args, ctx):
    """cmd -> data. Raises GqError (user error) or Exception (internal)."""
    if not isinstance(cmd, str):
        raise GqError("bad_cmd", str(cmd))
    cmd = cmd.replace("-", "_")
    fn = OPS.get(cmd)
    if not fn:
        raise GqError("bad_cmd", cmd)
    a = _coerce_args(cmd, args)
    ctx = dict(ctx)
    if a.get("run_id") is not None:
        ctx["run_id"] = a["run_id"]
    if a.get("actor") is not None:
        ctx["actor"] = a["actor"]
    if a.get("idem") is not None:
        ctx["idem"] = a["idem"]
    if ctx.get("actor") is None:
        ctx["actor"] = "socket"
    idem = ctx.get("idem")
    if idem is not None and cmd in MUT:
        r = db.execute("SELECT v FROM kv WHERE k=?",
                       ("idem:" + str(idem),)).fetchone()
        if r:
            try:
                return json.loads(r[0]).get("data")
            except ValueError:
                return None
    try:
        return fn(db, a, ctx)
    except sqlite3.IntegrityError as e:
        # lost an idem race or hit a PK: return the winner's stored response
        if idem is not None:
            r = db.execute("SELECT v FROM kv WHERE k=?",
                           ("idem:" + str(idem),)).fetchone()
            if r:
                return json.loads(r[0]).get("data")
        if cmd == "create":
            raise GqError("exists", str(a.get("id")))
        raise GqError("conflict", str(e))


def _emit_path(dbp):
    v = os.environ.get("SIS_EMIT")
    if v is None or v == "0":
        return None
    if v in ("", "1", "true"):
        base, _ = os.path.splitext(dbp)
        return base + ".otel.jsonl"
    return v


def _emit_span(dbp, cmd, args, ok, code, started):
    try:
        path = _emit_path(dbp)
        if not path:
            return
        a = args if isinstance(args, dict) else {}
        end = time.time()
        span = {"trace_id": a.get("run_id") or a.get("id") or "sis",
                "span_id": "span-" + secrets.token_hex(8), "name": cmd,
                "start": started, "end": end,
                "duration_ms": round((end - started) * 1000.0),
                "status": "ok" if ok else "error", "error_code": code,
                "attributes": {"sis.cmd": cmd, "sis.issue": a.get("id"),
                               "sis.actor": a.get("actor"),
                               "sis.epoch": a.get("epoch")}}
        with open(path, "a") as f:
            f.write(json.dumps(span, separators=(",", ":")) + "\n")
    except Exception:  # noqa: BLE001 - emission is best-effort host evidence
        pass


def respond(db, req, db_path):
    ctx = {"actor": req.get("actor"), "run_id": req.get("run_id"),
           "idem": req.get("idem"), "db_path": db_path}
    args = req.get("args")
    if isinstance(args, dict):
        for k in ("run_id", "idem", "actor"):
            if args.get(k) is not None:
                ctx[k] = args[k]
    started = time.time()
    cmd = (req.get("cmd") or "").replace("-", "_")
    try:
        data = dispatch_op(db, req.get("cmd"), args, ctx)
        if cmd in WRITERS and cmd not in SNAP_SKIP:
            try:
                snapshot_store(db, db_path)
            except Exception as e:  # noqa: BLE001 - store is consistent;
                print(f"snapshot: {e}", file=sys.stderr)  # mirror is best-effort
        _emit_span(db_path, cmd, args, True, None, started)
        return {"ok": True, "data": data}
    except GqError as e:
        _emit_span(db_path, cmd, args, False, e.code, started)
        return {"ok": False, "error": {"code": e.code, "msg": e.msg}}
    except Exception as e:  # noqa: BLE001 -> internal error, exit 2 on CLI
        _emit_span(db_path, cmd, args, False, "internal", started)
        return {"ok": False, "error": {"code": "internal", "msg": str(e)}}


# ---------------------------------------------------------------- serve

def _watch_stream(h, db, a):
    """SPEC §4 watch: emit new event batches as one-line responses until the
    client sends more bytes, disconnects, or `wait`/`timeout` elapses."""
    after = _int(a.get("after"), 0)
    wait = _f(a.get("wait"), _f(a.get("timeout"), 300))
    if wait is None or not 0 < wait <= 300:
        raise GqError("bad_args", "watch wait must be finite in 1..300 seconds")
    deadline = time.monotonic() + wait
    while True:
        with agent.EVENT_CONDITION:
            generation = agent.EVENT_GENERATION
        rows = db.execute(
            "SELECT seq,ts,op,issue,actor,run_id,idem,data_json FROM events "
            "WHERE seq>? ORDER BY seq LIMIT 500", (after,)).fetchall()
        if rows:
            after = rows[-1][0]
            h.wfile.write(json.dumps(
                {"ok": True, "data": {"events": [_edict(r) for r in rows]}},
                **JD).encode() + b"\n")
            h.wfile.flush()
            if not a.get("follow"):
                return  # long-poll: one batch then done
        if time.monotonic() >= deadline or h.server.stopping.is_set():
            h.wfile.write(b'{"ok":true,"data":{"events":[]}}\n')
            h.wfile.flush()
            return
        rl, _, _ = select.select([h.connection], [], [], 0)
        if rl:
            return  # pipelined request pending or peer closed
        with agent.EVENT_CONDITION:
            agent.EVENT_CONDITION.wait_for(
                lambda: agent.EVENT_GENERATION != generation or h.server.stopping.is_set(),
                timeout=max(0, deadline - time.monotonic()))


def serve(db_path, sock_path, http_port=None):
    lock_p, pid_p = sock_path + ".lock", sock_path + ".pid"
    lfd = os.open(lock_p, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.stderr.write("sis: serve already bound\n")
        sys.exit(3)
    if os.path.lexists(sock_path):
        live = False
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(0.5)
        try:
            s.connect(sock_path)
            live = True
        except OSError:
            try:
                os.unlink(sock_path)  # stale file: probe failed, safe to remove
            except FileNotFoundError:
                live = False
        finally:
            s.close()
        if live:
            sys.stderr.write("sis: socket live, refusing to bind\n")
            sys.exit(3)
    with open(pid_p, "w") as f:
        f.write(str(os.getpid()))

    class H(socketserver.StreamRequestHandler):
        def handle(self):
            self.connection.settimeout(30)
            db = connect(db_path)
            try:
                while True:
                    try:
                        line = self.rfile.readline(agent.FRAME_MAX + 1)
                    except (TimeoutError, OSError):
                        return
                    if not line:
                        return
                    if len(line) > agent.FRAME_MAX:
                        self.wfile.write(b'{"ok":false,"error":{"code":"frame_too_large","msg":"request exceeds 1 MiB"}}\n')
                        self.wfile.flush()
                        return
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        req = json.loads(line)
                        if req is None:
                            resp = {"ok": False, "error": {"code": "bad_cmd", "msg": "request not an object"}}
                    except ValueError as e:
                        req = None
                        resp = {"ok": False, "error":
                                {"code": "bad_json", "msg": str(e)}}
                    if req is not None:
                        if not isinstance(req, dict):
                            resp = {"ok": False, "error": {
                                "code": "bad_cmd", "msg": "request not an object"}}
                        elif req.get("cmd") == "watch":
                            a = req.get("args") or {}
                            a = a if isinstance(a, dict) else {}
                            if a.get("follow") or _f(a.get("wait"), 0):
                                try:
                                    _watch_stream(self, db, a)
                                except GqError as exc:
                                    self.wfile.write(json.dumps({"ok": False, "error": {"code": exc.code, "msg": exc.msg}}, **JD).encode() + b"\n")
                                    self.wfile.flush()
                                continue
                        if isinstance(req, dict):
                            resp = respond(db, req, db_path)
                    encoded = json.dumps(resp, **JD).encode() + b"\n"
                    if len(encoded) > 4 * agent.FRAME_MAX:
                        encoded = b'{"ok":false,"error":{"code":"output_too_large","msg":"response exceeds 4 MiB; use fields and pagination"}}\n'
                    self.wfile.write(encoded)
                    self.wfile.flush()
            finally:
                db.close()

    clients = threading.BoundedSemaphore(64)

    class S(socketserver.ThreadingUnixStreamServer):
        daemon_threads = True
        allow_reuse_address = True
        request_queue_size = 64

        def __init__(self, *args):
            self.clients = clients
            self.stopping = threading.Event()
            super().__init__(*args)

        def process_request(self, request, client_address):
            if not self.clients.acquire(blocking=False):
                try:
                    request.settimeout(1)
                    request.sendall(b'{"ok":false,"error":{"code":"busy","msg":"client limit reached"}}\n')
                finally:
                    self.shutdown_request(request)
                return
            try:
                super().process_request(request, client_address)
            except BaseException:
                self.clients.release()
                raise

        def process_request_thread(self, request, client_address):
            try:
                super().process_request_thread(request, client_address)
            finally:
                self.clients.release()

    try:
        srv = S(sock_path, H)
        os.chmod(sock_path, 0o600)
    except OSError as e:
        sys.stderr.write(f"sis: bind failed: {e}\n")
        sys.exit(2)

    httpd = None
    http_thread = None
    try:
        if http_port is not None:
            httpd = agent.http_server(db_path, http_port, globals(), clients, srv.stopping)
    except (GqError, OSError):
        srv.server_close()
        for p in (sock_path, pid_p):
            with contextlib.suppress(OSError):
                os.unlink(p)
        os.close(lfd)
        raise

    def _bye(*_):
        srv.stopping.set()
        agent.notify()
        threading.Thread(target=srv.shutdown, daemon=True).start()
        if httpd is not None:
            threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _bye)
    signal.signal(signal.SIGINT, _bye)
    if httpd is not None:
        http_thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
        http_thread.start()
        print(f"sis http on http://127.0.0.1:{httpd.server_port}", file=sys.stderr, flush=True)
    print(sock_path, flush=True)
    try:
        srv.serve_forever()
    finally:
        srv.stopping.set()
        agent.notify()
        if httpd is not None:
            httpd.shutdown()
            httpd.server_close()
            http_thread.join(timeout=1)
        srv.server_close()
        for p in (sock_path, pid_p):
            try:
                os.unlink(p)
            except FileNotFoundError:
                continue
        os.close(lfd)


# ---------------------------------------------------------------- mcp

def mcp_loop(db_path):
    """stdio MCP: newline-delimited JSON-RPC; tools = sis_<op> (SPEC §5)."""
    db = connect(db_path)
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "ops.json")) as registry_file:
        registry = json.load(registry_file)
    tools = [{"name": "sis_" + op["name"], "description": op["description"],
              "inputSchema": op["inputSchema"]} for op in registry["ops"]
             if os.environ.get("SIS_MCP_PROFILE") != "agent" or op["name"] in agent.AGENT_OPS]
    out = sys.stdout
    while True:
        line = sys.stdin.buffer.readline(agent.FRAME_MAX + 1)
        if not line:
            break
        if len(line) > agent.FRAME_MAX:
            break
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        mid, m = msg.get("id"), msg.get("method")
        if mid is None:
            continue  # notification
        err = res = None
        if m == "initialize":
            res = {"protocolVersion": "2024-11-05",
                   "capabilities": {"tools": {}},
                   "serverInfo": {"name": "superiss", "version": VERSION}}
        elif m == "ping":
            res = {}
        elif m == "tools/list":
            res = {"tools": tools}
        elif m == "tools/call":
            p = msg.get("params") or {}
            name = p.get("name") or ""
            cmd = name[4:] if name.startswith("sis_") else name
            if not any(tool['name'] == name for tool in tools):
                out.write(json.dumps({'jsonrpc': '2.0', 'id': mid, 'error': {
                    'code': -32602, 'message': 'Unknown or unavailable tool'}}) + '\n')
                out.flush()
                continue
            try:
                response = respond(db, {"cmd": cmd, "args": p.get("arguments") or {}}, db_path)
                res = {"content": [{"type": "text",
                                    "text": json.dumps(response, default=str)}]}
                if not response["ok"]:
                    res["isError"] = True
            except GqError as e:
                res = {"content": [{"type": "text", "text": json.dumps(
                    {"code": e.code, "msg": e.msg})}], "isError": True}
            except Exception as e:  # noqa: BLE001
                res = {"content": [{"type": "text", "text": str(e)}],
                       "isError": True}
        else:
            err = {"code": -32601, "message": f"method not found: {m}"}
        reply = {"jsonrpc": "2.0", "id": mid}
        reply["error" if err else "result"] = err or res
        encoded = json.dumps(reply, default=str) + "\n"
        if len(encoded.encode()) > 4 * agent.FRAME_MAX:
            encoded = json.dumps({"jsonrpc": "2.0", "id": mid, "error": {
                "code": -32000, "message": "response exceeds 4 MiB; use fields and pagination"}}) + "\n"
        out.write(encoded)
        out.flush()


# ---------------------------------------------------------------- cli

def _parse_args(pos, cmd=None):
    """[json|@file|k=v|pos ...] -> args (dict or list).

    Mixed form allowed: `dep t1 g2 type=gate` — k=v tokens land in the dict,
    remaining positionals fill the op's POS key list in order."""
    if not pos:
        return {}
    first = pos[0]
    if first.startswith("@"):
        return json.loads(open(first[1:]).read())
    if first[0] in "{[":
        return json.loads(" ".join(pos))
    # --key value / --key=value / bare --key (=true) like normal flags;
    # `--` ends flag parsing so positionals may start with dashes.
    toks, i, no_flags = [], 0, False
    while i < len(pos):
        t = pos[i]
        if not no_flags and t == "--":
            no_flags = True
        elif not no_flags and t.startswith("--"):
            kv = t[2:]
            if "=" in kv:
                k, v = kv.split("=", 1)
                toks.append(k.replace("-", "_") + "=" + v)
            elif kv and re.fullmatch(r"[A-Za-z0-9_-]+", kv):
                k = kv.replace("-", "_")
                if i + 1 < len(pos) and not pos[i + 1].startswith("--"):
                    toks.append(f"{k}={pos[i + 1]}")
                    i += 1
                else:
                    toks.append(f"{k}=true")
            else:
                toks.append(t)
        else:
            toks.append(t)
        i += 1
    pos = toks
    if all("=" not in t for t in pos):
        return list(pos)
    d = {}
    bare = []
    for t in pos:
        k, sep, v = t.partition("=")
        if sep and k and re.fullmatch(r"[A-Za-z0-9_]+", k):
            try:
                d[k] = json.loads(v)
            except ValueError:
                d[k] = v
        else:
            bare.append(t)
    for i, t in enumerate(bare):
        keys = POS.get(cmd, ["id"])
        if i < len(keys) and keys[i] not in d:
            d[keys[i]] = t
    return d


def _git(repo, *args):
    """git -C repo <args> -> stdout or None."""
    try:
        out = subprocess.run(["git", "-C", str(repo), *args],
                             capture_output=True, text=True,
                             stdin=subprocess.DEVNULL, timeout=15)
        return out.stdout if out.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def _changes_from_git(args):
    """Compact per-file edit summary from the real worktree (CLI side):
    numstat counts + -U0 hunk ranges, untracked via porcelain. No code
    stored unless args['patch'] asks for a bounded snapshot."""
    repo = Path(args.get("repo") or ".")
    if _git(repo, "rev-parse", "--git-dir") is None:
        raise GqError("not_a_git_repo",
                      f"{repo} is not a git worktree; "
                      "pass --files '[{{..}}]' explicitly")
    head = _git(repo, "rev-parse", "--verify", "HEAD")
    branch = _git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    base = args.get("base") or "HEAD"
    has_base = _git(repo, "rev-parse", "--verify", base) is not None
    files = []
    out = {}
    if has_base:
        numstat = _git(repo, "diff", "--numstat", "-M", base, "--") or ""
        stat, order = {}, []
        for line in numstat.splitlines():
            parts = line.split("\t", 2)
            if len(parts) < 3:
                continue
            ad, de, path = parts
            renamed = None
            if " => " in path:
                old, new = path.split(" => ", 1)
                renamed = old.strip("{}")
                path = new.rstrip("}").strip()
            stat[path] = (_int(ad) if ad.isdigit() else None,
                          _int(de) if de.isdigit() else None, renamed)
            order.append(path)
        unified = _git(repo, "diff", "-U0", "--no-color", "-M", base, "--") or ""
        hunks, cur, old = {}, "", ""
        for line in unified.splitlines():
            if line.startswith("--- a/"):
                old = line[6:]
            elif line.startswith("+++ b/"):
                cur = line[6:]
            elif line.startswith("+++ /dev/null"):
                cur = old  # deleted file: hunks belong to the a/-side name
            elif line.startswith("@@ ") and cur:
                m = re.search(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", line)
                if not m:
                    continue
                os_, ol = int(m.group(1)), int(m.group(2) or 1)
                ns, nl = int(m.group(3)), int(m.group(4) or 1)
                s, e = (os_, os_ + ol - 1) if nl == 0 else (ns, ns + nl - 1)
                hunks.setdefault(cur, []).append([s, e])
        for path in order:
            ad, de, ren = stat[path]
            exists = (repo / path).exists()
            f = {"path": path, "adds": ad, "dels": de,
                 "status": "R" if ren else ("M" if exists else "D"),
                 "hunks": hunks.get(path, [])}
            if ad is None and de is None:
                f["binary"] = True
            if ren:
                f["renamed_from"] = ren
            files.append(f)
        if args.get("patch"):
            raw = _git(repo, "diff", "--no-color", "-M", base, "--") or ""
            out["patch"], out["patch_truncated"] = \
                (raw[:65536], True) if len(raw) > 65536 else (raw, False)
    porcelain = _git(repo, "status", "--porcelain") or ""
    for line in porcelain.splitlines():
        if line.startswith("?? "):
            # porcelain reports fully untracked dirs as "?? dir/" — no line
            # evidence; open() on a dir raises IsADirectoryError anyway
            path = line[3:].strip().rstrip("/")
            if not (repo / path).is_file():
                continue
            try:
                n = sum(1 for _ in open(repo / path, "rb"))
            except OSError:
                n = 0
            files.append({"path": path, "adds": n, "dels": 0, "status": "A",
                          "hunks": [[1, n]] if n else []})
    # the store's own snapshot mirror (<db-stem>.issues.jsonl) is rewritten
    # after every mutation — it would noise up every recorded diff
    mirror = args.get("mirror")
    if mirror:
        files = [f for f in files if f["path"] != mirror
                 and not f["path"].endswith("/" + mirror)]
    subject = _git(repo, "log", "-1", "--format=%s")
    out.update({"files": files, "base": base,
                "head": head.strip() if head else None,
                "head_subject": subject.strip() if subject else None,
                "branch": branch.strip() if branch else None})
    if "repo" not in args:
        out["repo"] = str(repo)
    return out


def _sock_default(db_path):
    canonical_path = os.path.realpath(os.path.abspath(db_path))
    digest = hashlib.sha256(canonical_path.encode()).hexdigest()[:20]
    return f"/tmp/sis-{digest}.sock"


def discover_db():
    # Nearest .sis/*.db upward from cwd (mk sis convention); else an
    # existing cwd "sis.db" (ad-hoc store). None => nothing resolved:
    # never silently create an implicit store.
    d = Path.cwd()
    while True:
        sis = d / ".sis"
        if sis.is_dir():
            dbs = sorted(p for p in sis.iterdir() if p.suffix == ".db")
            if dbs:
                return str(dbs[0])
        if d.parent == d:
            break
        d = d.parent
    if (Path.cwd() / "sis.db").is_file():
        return "sis.db"
    return None


# Pure reads: on a missing DB they would print an empty backlog, which the
# store-selection policy forbids.
READS = {"ready", "list", "query", "count", "dep_list", "children", "show",
         "search", "history", "comments", "stale", "orphans", "stats",
         "review", "lint", "export", "contract", "brief", "goal_tree", "tree",
         "next", "epic", "dup_scan", "recall", "outbox_list", "gate_list",
         "slot_list", "goal_done", "watch", "snapshot"}
# Write-ish cmds outside OPS (agent-installed or process-level).
EXTRA_WRITES = {"serve", "mcp", "acquire", "checkpoint", "handoff", "cancel",
                "cancel_ack", "admin_update", "verify"}

# Ops that must not trigger an .issues.jsonl snapshot rewrite.
SNAP_SKIP = {"heartbeat", "remember", "outbox_done", "outbox_fail", "gate",
             "slot_acquire", "merge_slot", "slot_release", "cancel",
             "cancel_ack", "checkpoint"}


def main(argv):
    if not argv:
        sys.stderr.write(
            "usage: superiss.py <cmd> [json|@file|k=v|pos] [--db P] [--sock P] "
            "[--json]\n")
        return 2
    # Global flags may precede the cmd (rs parity): `sis --db P changes x`.
    pre, i = {}, 0
    while i < len(argv):
        t = argv[i]
        if t in ("--db", "--sock", "--http") and i + 1 < len(argv):
            pre[t], i = argv[i + 1], i + 2
        elif t == "--json":
            pre[t], i = "1", i + 1
        elif t[:5] == "--db=":
            pre["--db"], i = t[5:], i + 1
        elif t[:7] == "--sock=":
            pre["--sock"], i = t[7:], i + 1
        elif t[:7] == "--http=":
            pre["--http"], i = t[7:], i + 1
        else:
            break
    argv = argv[i:]
    if not argv:
        sys.stderr.write("usage: superiss.py <cmd> [args] [--db P]\n")
        return 2
    cmd, rest = argv[0], argv[1:]
    explicit = os.environ.get("SIS_DB") is not None or "--db" in pre
    db_path = pre.get("--db") or os.environ.get("SIS_DB") or discover_db() or "sis.db"
    sock = pre.get("--sock")
    http_port = pre.get("--http") or os.environ.get("SIS_HTTP") or None
    jout = "--json" in pre
    pos = []
    i = 0
    while i < len(rest):
        t = rest[i]
        if t == "--db":
            db_path, i = rest[i + 1], i + 2
            explicit = True
        elif t.startswith("--db="):
            db_path, i = t[5:], i + 1
            explicit = True
        elif t == "--sock":
            sock, i = rest[i + 1], i + 2
        elif t.startswith("--sock="):
            sock, i = t[7:], i + 1
        elif t == "--http":
            http_port, i = rest[i + 1] if i + 1 < len(rest) else "", i + 2
        elif t.startswith("--http="):
            http_port, i = t[7:], i + 1
        elif t == "--json":
            jout, i = True, i + 1
        else:
            pos.append(t)
            i += 1
    cmd = cmd.replace("-", "_")
    # Store guards: no implicit fresh "sis.db" (phantom backlog), no read or
    # unknown cmd on a missing store. Creation is explicit-only.
    if not Path(db_path).exists():
        if not explicit and not os.environ.get("SIS_CWD_DB"):
            print(json.dumps({"error": {"code": "no_project_db", "msg":
                "no .sis/*.db found walking up and no SIS_DB/--db given; "
                "refusing to create implicit 'sis.db' in cwd. Pass --db "
                "or set SIS_CWD_DB=1 for an ad-hoc store."}}),
                file=sys.stderr)
            return 2
        if cmd in READS or (cmd not in OPS and cmd not in EXTRA_WRITES):
            print(json.dumps({"error": {"code": "db_missing", "msg":
                f"database {db_path} does not exist; refusing to report "
                f"an empty backlog (cmd {cmd})"}}), file=sys.stderr)
            return 2
    try:
        if cmd == "serve":
            serve(db_path, sock or os.environ.get("SIS_SOCK")
                  or _sock_default(db_path), http_port)
            return 0
        if cmd == "mcp":
            mcp_loop(db_path)
            return 0
        args = _parse_args(pos, cmd)
        mirror = Path(db_path).stem + ".issues.jsonl"
        # `sis changes`: compact diff computed caller-side in the real
        # worktree unless an explicit files payload was given.
        if cmd == "changes" and "files" not in args:
            args["mirror"] = mirror
            args.update(_changes_from_git(args))
    except GqError as e:
        print(json.dumps({"error": {"code": e.code, "msg": e.msg}}),
              file=sys.stderr)
        return 2 if e.code == "not_a_git_repo" else 1
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": {"code": "internal", "msg": str(e)}}),
              file=sys.stderr)
        return 2
    try:
        db = connect(db_path)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": {"code": "internal", "msg": str(e)}}),
              file=sys.stderr)
        return 2
    # `sis close`/`sis checkpoint`: auto-record the worktree diff first —
    # best-effort, a missing repo never blocks the command.
    # --no-changes opts out.
    if cmd in ("close", "checkpoint", "handoff") and "no_changes" not in args:
        try:
            ev_args = {"id": args.get("id"), "actor": args.get("actor"),
                       "run_id": args.get("run_id"), "mirror": mirror}
            ev_args.update(_changes_from_git(ev_args))
            respond(db, {"cmd": "changes", "args": ev_args}, db_path)
        except GqError:
            pass
    resp = respond(db, {"cmd": cmd, "args": args}, db_path)
    db.close()
    if resp["ok"]:
        out = resp if jout else resp["data"]
        print(json.dumps(out, default=str))
        return 0
    if jout:
        print(json.dumps(resp, default=str))
    else:
        print(json.dumps({"error": resp["error"]}, default=str),
              file=sys.stderr)
    return 2 if resp["error"]["code"] == "internal" else 1


agent.install(globals())


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
