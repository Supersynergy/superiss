#!/usr/bin/env python3
"""Paired, model-free Unix-socket benchmarks of accepted Superiss workflows."""

from __future__ import annotations

import argparse
from collections.abc import Callable, Iterator
import concurrent.futures
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
from typing import Protocol, cast


def _object(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ValueError("expected JSON object")
    return cast(dict[str, object], value)


class _Wire(Protocol):
    def write(self, data: bytes, /) -> int | None: ...
    def flush(self) -> None: ...
    def readline(self, size: int = -1, /) -> bytes: ...


def _rpc(stream: _Wire, cmd: str, args: dict[str, object]) -> dict[str, object]:
    frame = (json.dumps({"cmd": cmd, "args": args}, sort_keys=True) + "\n").encode()
    offset = 0
    while offset < len(frame):
        written = stream.write(frame[offset:])
        if written is None or written <= 0:
            raise ConnectionError("socket did not accept request bytes")
        offset += written
    stream.flush()
    line = stream.readline(1024 * 1024 + 1)
    if len(line) > 1024 * 1024 or not line.endswith(b"\n"):
        raise ValueError("incomplete or oversized response")
    raw: object = json.loads(line)
    response = _object(raw)
    if response.get("ok") is not True:
        raise RuntimeError(f"benchmark operation rejected: {cmd}")
    return _object(response.get("data"))


def _request(sock: Path, cmd: str, args: dict[str, object]) -> dict[str, object]:
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(20)
        client.connect(str(sock))
        with client.makefile("rwb", buffering=0) as stream:
            return _rpc(stream, cmd, args)


@dataclass(frozen=True)
class Config:
    backlog: int
    jobs_per_worker: int
    workers: tuple[int, ...]
    repeats: int

    def __post_init__(self) -> None:
        if not 0 <= self.backlog <= 100_000 or not 1 <= self.jobs_per_worker <= 8:
            raise ValueError("backlog must be 0..100000 and jobs per worker 1..8")
        if not self.workers or tuple(sorted(set(self.workers))) != self.workers:
            raise ValueError("worker counts must be unique and sorted")
        if (
            any(not 1 <= count <= 32 for count in self.workers)
            or not 3 <= self.repeats <= 10
        ):
            raise ValueError("workers must be 1..32 and repeats 3..10")


@contextmanager
def _server(
    binary: Path, db: Path, sock: Path, clock: Callable[[], float]
) -> Iterator[None]:
    env = dict(os.environ, SIS_DB=str(db), SIS_SOCK=str(sock))
    for key in ("SIS_HTTP", "SIS_ADMIN_TOKEN", "SIS_DIRECT"):
        env.pop(key, None)
    with (db.parent / "server.log").open("wb") as log:
        child = subprocess.Popen(
            [str(binary), "serve", "--db", str(db)],
            env=env,
            cwd=db.parent,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            deadline = clock() + 10
            while True:
                if child.poll() is not None:
                    raise RuntimeError("owned benchmark server exited")
                try:
                    _request(sock, "stats", {})
                    break
                except OSError:
                    if clock() >= deadline:
                        raise TimeoutError(
                            "owned benchmark server did not become ready"
                        )
                    threading.Event().wait(0.01)
            yield
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=3)


def _batch(
    binary: Path, config: Config, workers: int, clock: Callable[[], float]
) -> dict[str, object]:
    jobs = workers * config.jobs_per_worker
    with tempfile.TemporaryDirectory(prefix="sis-mw-") as temporary:
        root = Path(temporary).resolve()
        db, sock = root / "bench.db", root / "bench.sock"
        (root / "input.txt").write_text("fixed benchmark input\n", encoding="utf-8")
        subprocess.run(
            [str(binary), "context", "--db", str(db)],
            check=True,
            capture_output=True,
            timeout=10,
        )
        # Synthetic data only, in this function's private temporary store.
        # The same accepted jobs and clock-independent fixture enter both arms.
        with sqlite3.connect(db) as connection:
            connection.executemany(
                "INSERT INTO issues(id,title,status,priority,type,oracle_cmd,allowed_paths,created_at,closed_at,meta_json) VALUES(?,?,?,2,'task',?,'[\"input.txt\"]',1700000000,?, '{}')",
                (
                    (
                        f"closed-{index:06}",
                        "historical job",
                        "closed",
                        "test -s input.txt",
                        1700000001,
                    )
                    for index in range(config.backlog)
                ),
            )
            connection.executemany(
                "INSERT INTO issues(id,title,status,priority,type,oracle_cmd,allowed_paths,created_at,meta_json) VALUES(?,?,'open',2,'task','test -s input.txt','[\"input.txt\"]',1700000000,'{}')",
                ((f"job-{index:06}", "accepted job") for index in range(jobs)),
            )
        with _server(binary, db, sock, clock):
            _request(sock, "stats", {})  # Both arms are measured warm.

            def worker(number: int) -> list[float]:
                latencies: list[float] = []
                with socket.socket(socket.AF_UNIX) as client:
                    client.settimeout(20)
                    client.connect(str(sock))
                    with client.makefile("rwb", buffering=0) as stream:
                        actor = f"worker-{number}"
                        for _ in range(config.jobs_per_worker):
                            began = clock()
                            claim = _rpc(
                                stream, "claim_next", {"actor": actor, "ttl": 120}
                            )
                            ident, epoch = claim.get("id"), claim.get("epoch")
                            if not isinstance(ident, str) or not isinstance(epoch, int):
                                raise ValueError("missing claimed issue or epoch")
                            args: dict[str, object] = {
                                "id": ident,
                                "actor": actor,
                                "epoch": epoch,
                                "cwd": str(root),
                            }
                            proof = _rpc(stream, "verify", args)
                            if proof.get("passed") is not True or not isinstance(
                                proof.get("proof_id"), str
                            ):
                                raise RuntimeError("acceptance oracle failed")
                            _rpc(
                                stream, "close", dict(args, proof_id=proof["proof_id"])
                            )
                            latencies.append((clock() - began) * 1000)
                return latencies

            began = clock()
            with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
                futures = [pool.submit(worker, number) for number in range(workers)]
                samples = [
                    latency
                    for future in futures
                    for latency in future.result(timeout=90)
                ]
            stats = _request(sock, "stats", {})
            elapsed = (clock() - began) * 1000
            if stats.get("closed") != config.backlog + jobs or len(samples) != jobs:
                raise RuntimeError("accepted issue count differs from the workload")
            samples.sort()
            return {
                "durationMs": elapsed,
                "pass": True,
                "attempts": 1,
                "accepted": jobs,
                "workers": workers,
                "acceptedPerSecond": jobs * 1000 / elapsed,
                "taskP95Ms": samples[min(len(samples) - 1, int(len(samples) * 0.95))],
            }


def _source_hash(root: Path, revision: str | None) -> str:
    digest = hashlib.sha256()
    for name in (
        "Cargo.lock",
        "Cargo.toml",
        "agent.rs",
        "ops.json",
        "superiss.rs",
        "transport.rs",
    ):
        if revision is None:
            content = (root / name).read_bytes()
        else:
            content = subprocess.check_output(
                ["git", "-C", str(root), "show", f"{revision}:{name}"], timeout=10
            )
        digest.update(name.encode() + b"\0" + content + b"\0")
    return digest.hexdigest()


def _hash_json(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--baseline-ref", required=True)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--backlog", type=int, default=10_000)
    parser.add_argument("--workers", default="1,2,4,8")
    parser.add_argument("--jobs-per-worker", type=int, default=2)
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if not re.fullmatch(r"[a-f0-9]{40}", args.baseline_ref):
        parser.error("--baseline-ref must be a complete commit hash")
    config = Config(
        args.backlog,
        args.jobs_per_worker,
        tuple(int(value) for value in args.workers.split(",")),
        args.repeats,
    )
    binaries = {
        "baseline": args.baseline.resolve(strict=True),
        "candidate": args.candidate.resolve(strict=True),
    }
    output = args.out.resolve()
    if not output.is_relative_to(root) or output.exists():
        parser.error("--out must be a new path inside this checkout")
    workload = {
        "backlog": config.backlog,
        "workers": config.workers,
        "jobsPerWorker": config.jobs_per_worker,
        "repeats": config.repeats,
        "acceptance": "claim, source-bound verify, proof-bound close, exact closed count",
    }
    environment = {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "profile": "debug",
        "setupExcluded": True,
        "modelCalls": 0,
    }
    source_hashes = {
        arm: _source_hash(root, args.baseline_ref if arm == "baseline" else None)
        for arm in sorted(binaries)
    }
    binary_hashes = {
        arm: hashlib.sha256(binary.read_bytes()).hexdigest()
        for arm, binary in sorted(binaries.items())
    }
    harness_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    trials: list[dict[str, object]] = []
    for repeat in range(config.repeats):
        for workers in config.workers:
            order = (
                ("baseline", "candidate")
                if repeat % 2 == 0
                else ("candidate", "baseline")
            )
            for arm in order:
                trial = _batch(binaries[arm], config, workers, time.perf_counter)
                trial.update(pairId=f"workers-{workers}-round-{repeat}", arm=arm)
                trials.append(trial)
                print(f"accepted: {arm}, workers={workers}, round={repeat}", flush=True)
    for arm, binary in sorted(binaries.items()):
        if hashlib.sha256(binary.read_bytes()).hexdigest() != binary_hashes[arm]:
            raise RuntimeError("binary changed during measurement")
        revision = args.baseline_ref if arm == "baseline" else None
        if _source_hash(root, revision) != source_hashes[arm]:
            raise RuntimeError("source changed during measurement")
    if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != harness_hash:
        raise RuntimeError("benchmark harness changed during measurement")
    artifact = {
        "schemaVersion": 1,
        "baseline": "baseline",
        "candidate": "candidate",
        "protocol": {
            "workloadSha256": _hash_json(workload),
            "oracleSha256": _hash_json(
                {"command": "test -s input.txt", "harness": harness_hash}
            ),
            "environmentSha256": _hash_json(environment),
            "cacheState": "warm",
            "varied": ["source"],
            "objective": "time",
            "minPairs": 3,
        },
        "arms": {
            arm: {
                "sourceSha256": source_hashes[arm],
                "binarySha256": binary_hashes[arm],
                "model": "none-local-native",
                "effort": "none",
                "transport": "unix-ndjson",
            }
            for arm in sorted(binaries)
        },
        "trials": trials,
        "workload": workload,
        "environment": environment,
        "automaticPromotion": False,
        "limits": "Virtual clients, not coding agents. No optimum agent count or billing claim.",
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as stream:
        json.dump(artifact, stream, sort_keys=True, indent=2, allow_nan=False)
        stream.write("\n")
    print(f"Wrote paired comparison: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
