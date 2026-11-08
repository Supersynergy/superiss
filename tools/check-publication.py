#!/usr/bin/env python3
"""Validate current source versions/catalog/links; historical receipts stay historical."""
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]

def main():
    runtime = json.loads((ROOT / 'packages/superiss/package.json').read_text())
    registry = json.loads((ROOT / 'packages/superiss/ops.json').read_text())
    reference = json.loads((ROOT / 'ops.json').read_text())
    assert runtime['version'] == registry['version'] == '1.1.0'
    assert "export const VERSION = '1.1.0'" in (ROOT / 'packages/superiss/runtime.ts').read_text()
    assert len(registry['ops']) == 88 and len(reference['ops']) == 85
    assert len({op['name'] for op in registry['ops']}) == 88
    for op in registry['ops']:
        assert f'| `{op["name"]}` |' in (ROOT / 'docs/OPERATIONS.md').read_text(), op['name']
    assert 'packages/superiss/cli.ts' in (ROOT / 'bin/sis').read_text()
    paths = subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard'],cwd=ROOT,text=True).splitlines()
    for name in paths:
        assert not name.endswith(('.db','.db-wal','.db-shm','.issues.jsonl')), name
        assert not name.startswith(('.venv/','.cache/','.sis/')), name
        path = ROOT / name
        if not path.is_file(): continue
        if path.suffix == '.md':
            text = path.read_text()
            for target in re.findall(r'\]\(([^)]+)\)',text):
                if target.startswith(('http:','https:','#','mailto:')): continue
                assert (path.parent / target.split('#')[0]).exists(), (name,target)
    # These records describe original reference snapshots, not current-file hashes.
    for name in ['validation.json','forge-validation.json','source-snapshot.json']:
        json.loads((ROOT / 'docs/research' / name).read_text())
    print(json.dumps({'passed':True,'stage':'source-content-only','version':'1.1.0','operations':88,'forge_tools':10,'reference_operations':85,'files':len(paths),'remote_publication_checked':False}))

if __name__ == '__main__': main()
