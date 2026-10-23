#!/usr/bin/env python3
"""spec_stub — minimal SPEC-conformant gq server, used ONLY as a fixture to
self-test contract_suite.py (proves the checks can PASS on a conformant impl).
In-memory store, JSON-persisted to $SIS_DB after every mutation so it survives
kill -9 + restart. Not a reference implementation — single global lock, no WAL.
Run: SIS_DB=/tmp/x.db SIS_SOCK=/tmp/x.sock python3 spec_stub.py serve
"""
import copy, json, os, socket, socketserver, sys, threading, time

DB = os.environ.get("SIS_DB", "sis-stub.db")
SOCK = os.environ.get("SIS_SOCK", "/tmp/sis-stub.sock")
L = threading.RLock()
_ctr = [0]

ST = {"issues": {}, "deps": [], "events": [], "outbox": [],
      "memories": {}, "idem": {}, "seq": 0, "oid": 0}


def load():
    if os.path.exists(DB):
        try:
            ST.update(json.load(open(DB)))
        except Exception:
            pass


_dirty = [False]
_last_save = [0.0]


def save(force=True):
    """Persist ST to SIS_DB. Coalesced: at most every 0.3s unless forced —
    enough for restart-safety in tests without O(n²) writes under load."""
    _dirty[0] = True
    if not force and time.time() - _last_save[0] < 0.3:
        return
    _dirty[0] = False
    _last_save[0] = time.time()
    tmp = DB + ".tmp"
    json.dump(ST, open(tmp, "w"))
    os.replace(tmp, DB)


def err(code, msg):
    return {"ok": False, "error": {"code": code, "msg": msg}}


def ok(d):
    return {"ok": True, "data": d}


def genid():
    _ctr[0] += 1
    return "gq-s%x%x" % (time.time_ns() & 0xFFFFFF, _ctr[0])


def ev(op, issue, a, data=None):
    ST["seq"] += 1
    ST["events"].append({"seq": ST["seq"], "ts": time.time(), "op": op,
                         "issue": issue, "actor": a.get("actor"),
                         "run_id": a.get("run_id"), "idem": a.get("idem"),
                         "data": data})


def blocked(iid):
    for (i, d) in ST["deps"]:
        if i == iid:
            b = ST["issues"].get(d)
            if b and b["status"] != "closed":
                return True
    return False


def issue_pub(iid, it):
    d = dict(it)
    d["id"] = iid
    return d


def op(cmd, a):
    a = a or {}
    t = time.time()
    iss = ST["issues"]

    if cmd == "create":
        iid = a.get("id") or genid()
        if iid in iss:
            return err("exists", "issue %s exists" % iid)
        iss[iid] = {"title": a.get("title", ""), "status": "open",
                    "priority": a.get("priority", 2), "type": a.get("type", "task"),
                    "owner": a.get("owner"), "lane": a.get("lane") or "",
                    "budget_eur": a.get("budget_eur"), "desc": a.get("desc", ""),
                    "acceptance": a.get("acceptance", ""),
                    "oracle_cmd": a.get("oracle_cmd"), "lease_until": None,
                    "lease_epoch": 0, "claim_actor": None, "spent": 0.0,
                    "created_at": t, "closed_at": None}
        ev("create", iid, a, {"title": iss[iid]["title"]})
        return ok({"id": iid})

    if cmd == "dep":
        pairs = a.get("deps") if isinstance(a.get("deps"), list) else [a]
        for p in pairs:
            i, d = p.get("issue"), p.get("depends_on")
            # cycle check: would i->d create a path back to i?
            seen, stack = set(), [d]
            while stack:
                x = stack.pop()
                if x == i:
                    return err("dep_cycle", "%s->%s cycle" % (i, d))
                if x not in seen:
                    seen.add(x)
                    stack += [dd for (ii, dd) in ST["deps"] if ii == x]
            if [i, d] not in ST["deps"]:
                ST["deps"].append([i, d])
            ev("dep", i, a, {"depends_on": d})
        return ok({"ok": True})

    if cmd == "ready":
        lane, lim = a.get("lane"), a.get("limit")
        rows = [issue_pub(i, it) for i, it in iss.items()
                if it["status"] == "open" and not blocked(i)
                and (lane is None or it.get("lane") in (None, "", lane))]
        rows.sort(key=lambda r: (r["priority"], r["created_at"], r["id"]))
        return ok(rows[:lim] if lim else rows)

    if cmd in ("claim", "claim_next"):
        actor = a.get("actor", "cli")
        ttl = a.get("ttl", 1800.0)
        if cmd == "claim":
            iid = a.get("id")
            it = iss.get(iid)
            if not it:
                return err("not_found", "issue %s" % iid)
            if not (it["status"] == "open" or
                    (it["status"] == "in_progress" and
                     (it["lease_until"] or 0) < t)):
                return err("not_claimable", "issue %s" % iid)
        else:
            lane = a.get("lane")
            cands = [(i, it) for i, it in iss.items()
                     if (it["status"] == "open" or
                         (it["status"] == "in_progress" and
                          (it["lease_until"] or 0) < t))
                     and (it["lease_until"] is None or it["lease_until"] < t
                          or it["status"] == "open")
                     and (lane is None or it.get("lane") in (None, "", lane))
                     and not blocked(i)]
            if not cands:
                return ok({"id": None})
            cands.sort(key=lambda x: (x[1]["priority"], x[1]["created_at"], x[0]))
            iid, it = cands[0]
        it["status"] = "in_progress"
        it["claim_actor"] = actor
        it["lease_until"] = t + ttl
        it["lease_epoch"] += 1
        cid = genid()
        ev("claim", iid, a, {"actor": actor, "epoch": it["lease_epoch"]})
        return ok({"id": iid, "claim_id": cid, "epoch": it["lease_epoch"]})

    if cmd == "heartbeat":
        iid, ep = a.get("id"), a.get("epoch")
        it = iss.get(iid)
        if not it:
            return err("not_found", iid or "?")
        if it["lease_epoch"] != ep:
            return err("stale_fence", "epoch %r != %r" % (ep, it["lease_epoch"]))
        if it["claim_actor"] != a.get("actor") or it["status"] != "in_progress":
            return err("not_claimed", iid)
        it["lease_until"] = t + a.get("ttl", 1800.0)
        ev("heartbeat", iid, a, {"epoch": ep})
        return ok({"ok": True})

    if cmd == "close":
        iid, ep = a.get("id"), a.get("epoch")
        it = iss.get(iid)
        if not it:
            return err("not_found", iid or "?")
        if ep is not None and it["lease_epoch"] != ep:
            return err("stale_fence", "epoch %r != %r" % (ep, it["lease_epoch"]))
        if it["status"] != "closed":
            it["status"] = "closed"
            it["closed_at"] = t
            it["lease_until"] = None
            ev("close", iid, a, {"reason": a.get("reason", "done")})
            ST["oid"] += 1
            ST["outbox"].append({"id": ST["oid"], "kind": "lesson",
                                 "payload": json.dumps({"issue": iid,
                                    "title": it["title"]}),
                                 "state": "pending", "attempts": 0})
        return ok({"ok": True})

    if cmd == "reopen":
        iid = a.get("id")
        it = iss.get(iid)
        if not it:
            return err("not_found", iid or "?")
        ep = a.get("epoch")
        if ep is not None and it["lease_epoch"] != ep:
            return err("stale_fence", "epoch %r != %r" % (ep, it["lease_epoch"]))
        it["status"] = "open"
        it["closed_at"] = None
        ev("reopen", iid, a, {})
        return ok({"ok": True})

    if cmd == "show":
        iid = a.get("id")
        it = iss.get(iid)
        if not it:
            return err("not_found", iid or "?")
        d = issue_pub(iid, it)
        d["deps"] = [dd for (ii, dd) in ST["deps"] if ii == iid]
        d["blocked_by"] = [dd for (ii, dd) in ST["deps"]
                           if ii == iid and iss.get(dd, {}).get("status") != "closed"]
        d["events_tail"] = [e for e in ST["events"] if e["issue"] == iid][-10:]
        return ok({"issue": d})

    if cmd == "search":
        q = (a.get("q") or "").lower()
        lim = a.get("limit", 50)
        return ok([issue_pub(i, it) for i, it in iss.items()
                   if q in (it["title"] + it["desc"] + it["acceptance"]).lower()][:lim])

    if cmd == "stale":
        now = a.get("now", t)
        return ok([issue_pub(i, it) for i, it in iss.items()
                   if it["status"] == "in_progress" and
                   it["lease_until"] is not None and it["lease_until"] < now])

    if cmd == "orphans":
        def reaches_root(i):
            seen, stack = set(), [i]
            while stack:
                x = stack.pop()
                if x in seen:
                    continue
                seen.add(x)
                outs = [dd for (ii, dd) in ST["deps"] if ii == x]
                if not outs:
                    return True          # dep-free node = root
                stack += outs
            return False
        return ok([issue_pub(i, it) for i, it in iss.items()
                   if it["status"] == "open" and not reaches_root(i)])

    if cmd == "stats":
        n = lambda s: sum(1 for it in iss.values() if it["status"] == s)
        bl = sum(1 for i, it in iss.items()
                 if it["status"] == "open" and blocked(i))
        return ok({"total": len(iss), "open": n("open"),
                   "in_progress": n("in_progress"), "closed": n("closed"),
                   "deferred": n("deferred"), "blocked": bl,
                   "ready": n("open") - bl,
                   "pending_outbox": sum(1 for r in ST["outbox"]
                                         if r["state"] == "pending")})

    if cmd == "remember":
        ST["memories"][a.get("key")] = {"value": a.get("value"),
                                        "updated_at": t}
        return ok({"ok": True})

    if cmd == "recall":
        k = a.get("key")
        rows = [{"key": k2, **v} for k2, v in ST["memories"].items()
                if k is None or k2 == k]
        return ok(rows)

    if cmd == "export":
        return ok({"issues": [issue_pub(i, it) for i, it in iss.items()],
                   "events": list(ST["events"]),
                   "events_count": len(ST["events"])})

    if cmd == "import":
        text = a.get("jsonl") or ""
        if a.get("path"):
            text = open(a["path"]).read()
        n = 0
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            e = json.loads(line)
            ST["seq"] += 1
            e.setdefault("seq", ST["seq"])
            ST["events"].append(e)
            o, iid = e.get("op"), e.get("issue")
            if o == "create" and iid and iid not in iss:
                iss[iid] = {"title": (e.get("data") or {}).get("title", "imp"),
                            "status": "open", "priority": 2, "type": "task",
                            "desc": "", "acceptance": "", "lease_until": None,
                            "lease_epoch": 0, "claim_actor": None, "spent": 0.0,
                            "created_at": t, "closed_at": None}
            elif o in ("dep", "dep_add") and iid:
                d = (e.get("data") or {}).get("depends_on")
                if d and [iid, d] not in ST["deps"]:
                    ST["deps"].append([iid, d])
            elif o == "close" and iid in iss:
                iss[iid]["status"] = "closed"
            elif o == "reopen" and iid in iss:
                iss[iid]["status"] = "open"
            n += 1
        return ok({"n": n})

    if cmd == "batch":
        snap = copy.deepcopy(ST)
        out = []
        try:
            for i, o_ in enumerate(a.get("ops") or []):
                r = op(o_.get("cmd"), o_.get("args") or {})
                if not r.get("ok"):
                    raise RuntimeError("batch[%d]" % i)
                out.append(r["data"])
        except Exception:
            for k in list(ST):
                ST[k] = snap[k]
            return err("batch_failed", "rolled back")
        return ok({"results": out})

    if cmd == "budget_claim":
        iid = a.get("issue")
        it = iss.get(iid)
        if not it:
            return err("not_found", iid or "?")
        eur = float(a.get("eur") or 0)
        bud = it.get("budget_eur")
        if bud is None or bud - it.get("spent", 0) < eur:
            return err("over_budget", iid)
        it["spent"] += eur
        ev("budget_claim", iid, a, {"eur": eur})
        return ok({"ok": True, "remaining": bud - it["spent"]})

    if cmd == "contract":
        iid = a.get("id")
        it = iss.get(iid)
        if not it:
            return err("not_found", iid or "?")
        return ok({"contract_text": "# %s\n%s\nacceptance: %s"
                   % (iid, it["title"], it["acceptance"])})

    if cmd == "outbox_list":
        st = a.get("state")
        return ok([r for r in ST["outbox"] if st is None or r["state"] == st])

    if cmd in ("outbox_done", "outbox_fail"):
        rid = a.get("id")
        for r in ST["outbox"]:
            if r["id"] == rid:
                r["state"] = "done" if cmd == "outbox_done" else "failed"
                r["attempts"] += 1
                return ok({"ok": True})
        return err("not_found", "outbox %s" % rid)

    if cmd == "compact":
        days = a.get("days", 30)
        cut = t - days * 86400
        old = [e for e in ST["events"] if e["ts"] < cut]
        if old and a.get("archive_path"):
            with open(a["archive_path"], "w") as f:
                for e in old:
                    f.write(json.dumps(e) + "\n")
        ST["events"] = [e for e in ST["events"] if e["ts"] >= cut]
        return ok({"archived": len(old), "kept": len(ST["events"])})

    if cmd == "attest":
        return err("not_claimed", "no active claim")
    if cmd == "cost_add":
        if not a.get("issue"):
            return err("bad_args", "issue required")
        ST.setdefault("costs", []).append(dict(a, ts=t))
        return ok({"id": len(ST["costs"])})
    if cmd == "cost_list":
        return ok(ST.get("costs", []))
    if cmd == "cost_rollup":
        return ok({"id": a.get("id"), "totals": {}})
    if cmd == "outbox_export":
        return ok({"format": a.get("format", "raw"), "jobs": [], "n": 0,
                   "drained": False})
    if cmd == "sync_export":
        return ok({"k": "sis-sync", "v": 1, "issues": [], "memories": []})
    if cmd == "sync_import":
        return err("admin_disabled", "administrative API disabled")
    if cmd == "spans":
        return ok({"enabled": False, "spans": []})
    if cmd == "learn":
        return ok({"group_by": a.get("group_by", "actor"), "groups": []})

    return err("bad_cmd", "unknown cmd %s" % cmd)


IDEM_OPS = {"create", "dep", "claim", "claim_next", "heartbeat", "close",
            "reopen", "remember", "import", "budget_claim", "outbox_done",
            "outbox_fail"}
READ_OPS = {"ready", "show", "search", "stale", "orphans", "stats", "recall",
            "export", "contract", "outbox_list"}


def handle(req):
    cmd, a = req.get("cmd"), req.get("args") or {}
    for k in ("run_id", "idem", "actor"):
        if k in req and k not in a:
            a[k] = req[k]
    with L:
        ik = "%s:%s" % (cmd, a.get("idem")) if a.get("idem") else None
        if ik and cmd in IDEM_OPS and ik in ST["idem"]:
            return ok(ST["idem"][ik])
        r = op(cmd, a)
        if r.get("ok") and cmd not in READ_OPS:
            if ik:
                ST["idem"][ik] = r["data"]
            save(force=False)
        return r


class H(socketserver.StreamRequestHandler):
    def handle(self):
        while True:
            line = self.rfile.readline()
            if not line:
                return
            try:
                req = json.loads(line)
            except Exception:
                req = {"cmd": ""}
            self.wfile.write(json.dumps(handle(req)).encode() + b"\n")


class S(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128


def serve():
    if os.path.exists(SOCK):
        try:                                   # connect-probe, never blind-del
            s = socket.socket(socket.AF_UNIX)
            s.settimeout(1)
            s.connect(SOCK)
            s.close()
            print(json.dumps(err("bound", "live gq on socket")),
                  file=sys.stderr)
            sys.exit(3)
        except OSError:
            os.unlink(SOCK)                    # stale file
    load()
    open(SOCK + ".pid", "w").write(str(os.getpid()))
    srv = S(SOCK, H)
    srv.serve_forever()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "serve":
        serve()
    else:
        print("usage: spec_stub.py serve   (env SIS_DB, SIS_SOCK)", file=sys.stderr)
        sys.exit(2)
