#!/usr/bin/env python3
"""Check the public package and its exact GitHub main commit."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def output(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True, timeout=30).strip()


def main():
    registry = json.loads((ROOT / "ops.json").read_text())
    assert registry["version"] == "0.9.1"
    assert len(registry["ops"]) == 85
    catalog = (ROOT / "docs/OPERATIONS.md").read_text()
    for operation in registry["ops"]:
        assert f'| `{operation["name"]}` |' in catalog, operation["name"]
    for name in ("README.md", "README.de.md", "LICENSE", "SECURITY.md",
                 "docs/FEATURES.md", "docs/COMPARISON.md", "docs/VALIDATION.md"):
        assert (ROOT / name).stat().st_size > 100, name
    image = (ROOT / "assets/superiss-hero.png").read_bytes()
    assert image.startswith(b"\x89PNG\r\n\x1a\n") and len(image) > 10000
    validation = json.loads((ROOT / "docs/research/validation.json").read_text())
    assert validation["gate_exit"] == 0 and validation["bun"]["failed"] == 0
    assert validation["secret_findings"] == 0
    for name, digest in validation["tested_source_sha256"].items():
        assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest, name
    paths = output("git", "ls-files").splitlines()
    for name in paths:
        assert not name.endswith((".db", ".db-wal", ".db-shm", ".issues.jsonl")), name
        assert not name.startswith((".venv/", ".cache/", ".sis/")), name
        path = ROOT / name
        if path.suffix in (".md", ".py", ".rs", ".ts", ".js", ".json", ".yml"):
            text = path.read_text()
            assert "/Users/" + "master/" not in text, name
            if path.suffix == ".md":
                for target in re.findall(r'\]\(([^)]+)\)', text):
                    if not target.startswith(("http:", "https:", "#", "mailto:")):
                        assert (path.parent / target.split("#")[0]).exists(), (name, target)
    assert not output("git", "status", "--porcelain"), "publication worktree is dirty"
    repo = json.loads(output("gh", "api", "repos/Supersynergy/superiss"))
    assert repo["private"] is False and repo["default_branch"] == "main"
    remote = output("gh", "api", "repos/Supersynergy/superiss/commits/main", "--jq", ".sha")
    assert remote == output("git", "rev-parse", "HEAD"), "GitHub main differs"
    print(json.dumps({"passed": True, "public": repo["html_url"], "commit": remote,
                      "operations": 85, "files": len(paths)}))


if __name__ == "__main__":
    main()
