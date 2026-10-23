#!/usr/bin/env python3
"""gq ops benchmark — impl-agnostic (SPEC §4 wire protocol).

Usage:
  python3 bench_ops.py --serve-cmd "python3 /path/superiss.py serve"
  python3 bench_ops.py --serve-cmd "cargo /path/superiss.rs serve" [--db x.db]

Measures sequential ready/stats, chunked-pipeline stats/create (<=100
outstanding — bulk-blast deadlocks when both socket buffers fill, so we
always drain a chunk before sending the next), and sequential claim_next.
Prints one JSON object. Exit 1 on transport failure.
"""
import argparse, json, os, shlex, socket, subprocess, sys, tempfile, time

CHUNK = 100          # spec §4: <=100 outstanding pipelined requests


class Conn:
    def __init__(self, path, timeout=30.0):
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.settimeout(timeout)
        self.s.connect(path)
        self.f = self.s.makefile("rb")

    def call(self, cmd, args=None):
        self.s.sendall(json.dumps({"cmd": cmd, "args": args or {}}).encode() + b"\n")
        line = self.f.readline()
        if not line:
            raise OSError("eof")
        return json.loads(line)

    def pipe(self, reqs):
        """Chunked pipeline: write <=CHUNK lines, drain replies, repeat."""
        n_ok = n_err = 0
        first_err = None
        for off in range(0, len(reqs), CHUNK):
            part = reqs[off:off + CHUNK]
            self.s.sendall(b"".join(
                json.dumps({"cmd": c, "args": a}).encode() + b"\n"
                for c, a in part))
            for _ in part:
                line = self.f.readline()
                if not line:
                    raise OSError("eof mid-pipeline")
                r = json.loads(line)
                if r.get("ok") is True or ("ok" in r and "err" not in r
                                           and r.get("ok") is not False):
                    n_ok += 1
                else:
                    n_err += 1
                    if first_err is None:
                        first_err = line[:160].decode(errors="replace")
        return n_ok, n_err, first_err

    def close(self):
        try:
            self.f.close()
            self.s.close()
        except Exception:
            pass


def timed(fn):
    t0 = time.perf_counter()
    n = fn()
    dt = time.perf_counter() - t0
    return n, dt, (n / dt if dt > 0 else 0.0)


class Srv:
    def __init__(self, cmd, db, sock, logdir):
        self.cmd, self.db, self.sock = cmd, db, sock
        self.logpath = os.path.join(logdir, "bench-serve.log")
        self.proc = None

    def start(self):
        e = dict(os.environ, SIS_DB=self.db, SIS_SOCK=self.sock)
        lf = open(self.logpath, "ab")
        self.proc = subprocess.Popen(shlex.split(self.cmd), env=e, stdout=lf,
                                     stderr=subprocess.STDOUT,
                                     stdin=subprocess.DEVNULL)
        t0 = time.time()
        while time.time() - t0 < 15:
            if self.proc.poll() is not None:
                raise SystemExit("serve exited rc=%s (see %s)"
                                 % (self.proc.returncode, self.logpath))
            try:
                c = Conn(self.sock, timeout=2)
                c.close()
                return
            except OSError:
                time.sleep(0.05)
        raise SystemExit("serve not ready in 15s")

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def okish(r):
    return isinstance(r, dict) and r.get("ok") is not False and "err" not in r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serve-cmd", required=True)
    ap.add_argument("--db")
    ap.add_argument("--sock")
    ap.add_argument("--n-seq", type=int, default=300)
    ap.add_argument("--n-pipe", type=int, default=2000)
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()

    tmp = None
    if a.db:
        db, logdir = a.db, os.path.dirname(os.path.abspath(a.db)) or "."
    else:
        tmp = tempfile.mkdtemp(prefix="gq-bench-")
        db, logdir = os.path.join(tmp, "sis.db"), tmp
    sock = a.sock or (db + ".sock")
    srv = Srv(a.serve_cmd, db, sock, logdir)
    srv.start()

    out = {"serve_cmd": a.serve_cmd, "n_seq": a.n_seq, "n_pipe": a.n_pipe}
    try:
        c = Conn(sock)

        n, dt, rate = timed(lambda: sum(
            okish(c.call("ready", {"limit": 10})) for _ in range(a.n_seq)))
        out["ready_seq"] = {"ops_s": round(rate, 1), "n": n, "errors": a.n_seq - n}

        n, dt, rate = timed(lambda: sum(
            okish(c.call("stats")) for _ in range(a.n_seq)))
        out["stats_seq"] = {"ops_s": round(rate, 1), "n": n, "errors": a.n_seq - n}

        reqs = [("stats", {})] * a.n_pipe
        t0 = time.perf_counter()
        n_ok, n_err, ferr = c.pipe(reqs)
        dt = time.perf_counter() - t0
        out["stats_pipe"] = {"ops_s": round(a.n_pipe / dt, 1), "n": n_ok,
                             "errors": n_err, "first_err": ferr}

        reqs = [("create", {"id": "bench-%d" % i, "title": "bench issue %d" % i,
                            "priority": 2}) for i in range(a.n_pipe)]
        t0 = time.perf_counter()
        n_ok, n_err, ferr = c.pipe(reqs)
        dt = time.perf_counter() - t0
        out["create_pipe"] = {"ops_s": round(a.n_pipe / dt, 1), "n": n_ok,
                              "errors": n_err, "first_err": ferr}

        claimed = [0]
        n_err2 = [0]

        def claims():
            for _ in range(n_ok):
                r = c.call("claim_next", {"actor": "bench", "ttl": 60})
                if okish(r):
                    d = r.get("data", r.get("ok"))
                    if isinstance(d, dict) and d.get("id") or isinstance(d, str):
                        claimed[0] += 1
                else:
                    n_err2[0] += 1
            return claimed[0]

        n, dt, rate = timed(claims)
        out["claim_next_seq"] = {"ops_s": round(rate, 1), "n": n,
                                 "errors": n_err2[0]}
        c.close()
    finally:
        srv.stop()

    out["db"] = db
    print(json.dumps(out, indent=2))
    if tmp and not a.keep:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
