#!/usr/bin/env python3
"""Exercise a claim, rejected close, executed oracle and final readback."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix="superiss-demo-") as temp:
        cwd = Path(temp).resolve()
        db = cwd / "tasks.db"
        (cwd / "artifact.txt").write_text("A real acceptance input.\n")
        env = dict(os.environ, SIS_DIRECT="1")
        for name in ("SIS_DB", "SIS_SOCK", "SIS_HTTP"):
            env.pop(name, None)

        def call(command, args, *, expect_success=True):
            result = subprocess.run(
                [str(ROOT / "bin/sis"), command, json.dumps(args), "--db", str(db)],
                env=env, cwd=cwd, text=True, capture_output=True, timeout=120,
            )
            if expect_success and result.returncode:
                raise RuntimeError(result.stderr or result.stdout)
            data = json.loads(result.stdout or result.stderr)
            if expect_success and data.get("ok") is False:
                raise RuntimeError(data)
            if not expect_success:
                assert result.returncode != 0 and data.get("ok") is False, data
            return data.get("data", data)

        call("create", {
            "id": "demo", "title": "Verify a local artifact", "owner": "demo-worker",
            "oracle_cmd": "test -s artifact.txt", "acceptance": "artifact.txt has content",
            "allowed_paths": [str(cwd / "artifact.txt")],
        })
        claim = call("claim", {"id": "demo", "actor": "demo-worker", "ttl": 300})
        identity = {"id": "demo", "actor": "demo-worker", "epoch": claim["epoch"]}
        print("✓ Claimed task with an actor, epoch and lease")
        call("close", identity, expect_success=False)
        print("✓ Close without proof rejected")
        proof = call("verify", {**identity, "cwd": str(cwd), "timeout_secs": 10})
        assert proof["passed"] is True, proof
        print("✓ Oracle passed; source-bound proof stored")
        call("close", {**identity, "proof_id": proof["proof_id"], "reason": "demo oracle passed"})
        state = call("show", {"id": "demo"})
        task = state.get("issue", state.get("task", state))
        assert task["status"] == "closed", state
        print("✓ Task closed and read back")


if __name__ == "__main__":
    main()
