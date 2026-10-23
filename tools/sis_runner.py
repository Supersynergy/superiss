#!/usr/bin/env python3
"""Consume one fenced autorun delivery at a time; never retry uncertain execution."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import math
from pathlib import Path
import signal
import subprocess
import sys
import threading
from types import FrameType
from typing import cast


def _object(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or any(not isinstance(k, str) for k in value):
        raise ValueError("expected a JSON object with string keys")
    return cast(dict[str, object], value)


def _text(data: dict[str, object], key: str, maximum: int = 8192) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"invalid {key}")
    return value


def _integer(data: dict[str, object], key: str) -> int:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"invalid {key}")
    return value


@dataclass(frozen=True)
class Delivery:
    outbox_id: int
    delivery_epoch: int
    delivery_actor: str
    idem: str
    issue: str
    actor: str
    epoch: int
    cmd: str
    cwd: str

    @classmethod
    def parse(cls, value: object, default_cwd: Path) -> Delivery:
        job = _object(value)
        payload = _object(job.get("payload"))
        cwd_value = payload.get("cwd")
        if cwd_value is not None and not isinstance(cwd_value, str):
            raise ValueError("invalid cwd")
        cwd = Path(cwd_value or default_cwd).resolve(strict=True)
        if not cwd.is_dir():
            raise ValueError("cwd is not a directory")
        return cls(
            _integer(job, "outbox_id"),
            _integer(job, "delivery_epoch"),
            _text(job, "delivery_actor", 128),
            _text(job, "idempotency_key", 256),
            _text(payload, "issue", 256),
            _text(payload, "actor", 128),
            _integer(payload, "epoch"),
            _text(payload, "cmd"),
            str(cwd),
        )


def _call(
    binary: Path, db: Path, cmd: str, args: dict[str, object]
) -> dict[str, object]:
    result = subprocess.run(
        [str(binary), cmd, json.dumps(args, sort_keys=True), "--db", str(db)],
        capture_output=True,
        text=True,
        timeout=75 if cmd == "attest" else 15,
        check=False,
    )
    if len(result.stdout.encode()) > 1024 * 1024:
        raise ValueError("response exceeds 1 MiB")
    response = _object(json.loads(result.stdout))
    if result.returncode != 0 or response.get("ok") is False:
        error = response.get("error")
        code = error.get("code") if isinstance(error, dict) else "transport"
        safe_code = (
            code
            if isinstance(code, str) and code.replace("_", "").isalnum()
            else "unknown"
        )
        raise RuntimeError(
            f"{cmd} rejected ({safe_code}); delivery left unacknowledged"
        )
    # CLI output is unwrapped; HTTP/socket clients may return an envelope.
    return (
        _object(response["data"])
        if response.get("ok") is True and "data" in response
        else response
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument(
        "--sis", type=Path, default=Path(__file__).resolve().parents[1] / "bin/sis"
    )
    parser.add_argument("--actor", default="local-runner")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--poll", type=float, default=1.0)
    parser.add_argument("--max-jobs", type=int, default=100)
    parser.add_argument("--complete", action="store_true")
    parser.add_argument("--issue")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--deadline", type=int, default=180)
    options = parser.parse_args()
    if not math.isfinite(options.poll) or not 0.1 <= options.poll <= 60:
        parser.error("--poll must be finite within 0.1..60 seconds")
    if not 1 <= options.max_jobs <= 1000:
        parser.error("--max-jobs must be within 1..1000")
    if not options.actor.strip() or len(options.actor) > 128:
        parser.error("--actor must be nonempty within 128 characters")
    if options.complete:
        from sis_workflow import run
        return run(options)
    binary = options.sis.resolve(strict=True)
    db = options.db.resolve(strict=True)
    if not db.is_file():
        parser.error("--db must be an existing regular file")
    stopped = threading.Event()

    def stop(_signum: int, _frame: FrameType | None) -> None:
        stopped.set()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    completed = 0
    while not stopped.is_set() and completed < options.max_jobs:
        exported = _call(
            binary,
            db,
            "outbox_export",
            {
                "actor": options.actor,
                "kind": "autorun",
                "ttl": 120,
                "limit": 1,
            },
        )
        jobs = exported.get("jobs")
        if not isinstance(jobs, list) or len(jobs) > 1:
            raise ValueError("expected at most one leased job")
        if not jobs:
            if options.once:
                return 0
            stopped.wait(options.poll)
            continue
        delivery = Delivery.parse(jobs[0], Path.cwd())
        if stopped.is_set():
            return 2
        result = _call(
            binary,
            db,
            "attest",
            {
                "id": delivery.issue,
                "actor": delivery.actor,
                "epoch": delivery.epoch,
                "kind": "run",
                "cmd": delivery.cmd,
                "cwd": delivery.cwd,
                "timeout_secs": 60,
                "idem": delivery.idem,
                "outbox_id": delivery.outbox_id,
                "delivery_actor": delivery.delivery_actor,
                "delivery_epoch": delivery.delivery_epoch,
            },
        )
        passed = result.get("passed")
        if not isinstance(passed, bool):
            raise ValueError("attestation omitted its verdict")
        ack: dict[str, object] = {
            "id": delivery.outbox_id,
            "actor": delivery.delivery_actor,
            "epoch": delivery.delivery_epoch,
        }
        if not passed:
            ack["err"] = "command failed or timed out"
        _call(binary, db, "outbox_done" if passed else "outbox_fail", ack)
        print(
            json.dumps(
                {"outbox_id": delivery.outbox_id, "passed": passed}, sort_keys=True
            )
        )
        completed += 1
        if not passed:
            return 1
        if options.once:
            return 0
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        detail = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        state = "workflow checkpoint" if "--complete" in sys.argv else "outbox state"
        print(f"sis runner stopped: {detail}; inspect {state}", file=sys.stderr)
        raise SystemExit(2) from None
