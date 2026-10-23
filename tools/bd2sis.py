#!/usr/bin/env python3
"""Import an explicit legacy JSON/JSONL export; never execute a legacy tracker.

Dry-run is the default. --apply requires an explicit database and an admin
token in SIS_ADMIN_TOKEN, configured separately on the destination daemon.
"""
import argparse
import collections
import hashlib
import json
import math
import os
from pathlib import Path
import socket
import sys

MAX_FRAME = 1024 * 1024
MAX_EXPORT = 8 * MAX_FRAME
STATUSES = {'open', 'in_progress', 'blocked', 'deferred', 'closed', 'cancelled'}


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode()


def text(value, field, required=False):
    if not isinstance(value, str) or (required and not value.strip()):
        raise ValueError(f'invalid {field}')
    return value


def load_export(path):
    with path.open('rb') as handle:
        raw = handle.read(MAX_EXPORT + 1)
    if len(raw) > MAX_EXPORT:
        raise ValueError('export exceeds 8 MiB')
    source = raw.decode('utf-8-sig')
    try:
        data = json.loads(source)
    except json.JSONDecodeError:
        data = [json.loads(line) for line in source.splitlines() if line.strip()]
    if isinstance(data, dict):
        data = data.get('issues', [data] if 'id' in data else None)
    if not isinstance(data, list) or not data or len(data) > 10000:
        raise ValueError('export must contain 1..10000 issue objects')
    return data, hashlib.sha256(raw).hexdigest()


def prepare(records, path, source_hash, token, actor):
    creates, updates, deps, history, ids = [], [], [], [], set()
    statuses = collections.Counter()
    graph = {}
    for index, row in enumerate(records):
        if not isinstance(row, dict):
            raise ValueError(f'issue {index} must be an object')
        ident = text(row.get('id'), 'id', True)
        if ident in ids:
            raise ValueError('duplicate issue id')
        ids.add(ident)
        status = row.get('status', 'open')
        if not isinstance(status, str) or status not in STATUSES:
            raise ValueError('unsupported legacy status')
        statuses[status] += 1
        priority = row.get('priority', 2)
        if isinstance(priority, bool) or not isinstance(priority, int):
            raise ValueError('priority must be an integer')
        labels = row.get('labels') or []
        if not isinstance(labels, list) or any(not isinstance(x, str) for x in labels):
            raise ValueError('labels must be a string array')
        provenance = {'status': status, 'source_file': str(path), 'source_sha256': source_hash,
                      'acceptance_verified': False, 'live_claim_restored': False}
        for key in ('assignee', 'close_reason'):
            if row.get(key) is not None:
                provenance[key] = text(row[key], key)
        for key in ('created_at', 'closed_at'):
            value = row.get(key)
            if value is not None:
                if not isinstance(value, str) and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0):
                    raise ValueError('invalid historical timestamp')
                provenance[key] = value
        meta = {'labels': labels, 'legacy_import': provenance}
        if row.get('parent') is not None:
            meta['parent'] = text(row['parent'], 'parent', True)
        args = {'id': ident, 'title': text(row.get('title'), 'title', True),
                'desc': text(row.get('description', row.get('desc', '')) or '', 'description'),
                'acceptance': text(row.get('acceptance_criteria', row.get('acceptance', '')) or '', 'acceptance'),
                'priority': priority, 'type': text(row.get('issue_type', row.get('type', 'task')), 'type', True),
                'meta': meta}
        for key in ('owner', 'lane', 'oracle_cmd'):
            if row.get(key) is not None:
                args[key] = text(row[key], key)
        if row.get('allowed_paths') is not None:
            scopes = row['allowed_paths']
            if not isinstance(scopes, list) or any(not isinstance(x, str) or not x for x in scopes):
                raise ValueError('invalid allowed_paths')
            args['allowed_paths'] = scopes
        for key in ('budget_eur', 'defer_until', 'expires_at'):
            if row.get(key) is not None:
                number = row[key]
                if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number) or number < 0:
                    raise ValueError(f'invalid {key}')
                args[key] = number
        creates.append({'cmd': 'create', 'args': args})
        mapped = 'deferred' if status == 'in_progress' else status
        if mapped != 'open':
            update = {'id': ident, 'status': mapped, 'admin_token': token,
                      'reason': 'Explicit legacy export import; historical state, no new acceptance proof'}
            if status == 'in_progress':
                update['defer_until'] = None
            updates.append({'cmd': 'admin_update', 'args': update})
        relations = row.get('dependencies') or []
        if not isinstance(relations, list):
            raise ValueError('dependencies must be an array')
        graph[ident] = set()
        seen_relations = {}
        for dep in relations:
            target = dep.get('depends_on_id', dep.get('depends_on')) if isinstance(dep, dict) else dep
            target = text(target, 'dependency target', True)
            kind = text(dep.get('type', 'blocks') or 'blocks', 'dependency type', True) if isinstance(dep, dict) else 'blocks'
            if target in seen_relations:
                if seen_relations[target] != kind:
                    raise ValueError('conflicting dependency types for one target')
                continue
            seen_relations[target] = kind
            if kind == 'parent-child':
                if target == ident or (meta.get('parent') is not None and meta['parent'] != target):
                    raise ValueError('invalid or conflicting parent relation')
                meta['parent'] = target
            if kind == 'blocks':
                if target == ident:
                    raise ValueError('self-blocking dependency')
                graph[ident].add(target)
            deps.append({'cmd': 'dep', 'args': {'issue': ident, 'depends_on': target, 'type': kind}})
        history.append({'op': 'legacy_history', 'issue': ident, 'actor': actor,
                        'data': {'source_sha256': source_hash, 'original_status': status,
                                 'mapped_status': mapped, 'acceptance_verified': False}})
    counts = {ident: sum(target in ids for target in targets) for ident, targets in graph.items()}
    reverse = collections.defaultdict(list)
    for ident, targets in graph.items():
        for target in targets & ids:
            reverse[target].append(ident)
    ready = collections.deque(ident for ident, count in counts.items() if not count)
    visited = 0
    while ready:
        visited += 1
        for dependent in reverse[ready.popleft()]:
            counts[dependent] -= 1
            if not counts[dependent]:
                ready.append(dependent)
    if visited != len(ids):
        raise ValueError('cyclic blocking dependencies')
    operations = creates + deps + updates + [{'cmd': 'import', 'args': {'admin_token': token,
        'jsonl': '\n'.join(encoded(row).decode() for row in history)}}]
    public_hash = hashlib.sha256(encoded({'source_sha256': source_hash, 'source_file': str(path), 'actor': actor})).hexdigest()
    requests = []
    # Ordered chunking for large backlogs: creates -> deps -> status updates
    # -> history. deps may reference later creates (dangling rows resolve);
    # admin_update requires the issue, so it never precedes its create.
    hist_ops = [{'cmd': 'import', 'args': {'admin_token': token,
        'jsonl': '\n'.join(encoded(row).decode() for row in history[i:i + 200])}}
        for i in range(0, len(history), 200)] or []
    phases = [creates, deps, updates, hist_ops]
    index = 0
    for phase in phases:
        chunk = []
        size = 0
        for op in phase:
            cost = len(encoded(op)) + 1
            if cost > MAX_FRAME - 4096:
                raise ValueError(f'single operation exceeds frame budget: {op.get("cmd")}')
            if chunk and size + cost > MAX_FRAME - 4096:
                requests.append({'cmd': 'batch', 'args': {'actor': actor,
                    'idem': f'legacy-file:{public_hash}:{index}', 'ops': chunk}})
                index += 1
                chunk, size = [], 0
            chunk.append(op)
            size += cost
        if chunk:
            requests.append({'cmd': 'batch', 'args': {'actor': actor,
                'idem': f'legacy-file:{public_hash}:{index}', 'ops': chunk}})
            index += 1
    request = requests[0] if len(requests) == 1 else requests
    summary = {'source_file': str(path), 'source_sha256': source_hash, 'issues': len(records),
               'dependencies': len(deps), 'original_statuses': dict(statuses),
               'prepared_operations': len(operations), 'batches': len(requests),
               'acceptance_receipts_created': 0,
               'historical_claims_deferred': statuses.get('in_progress', 0),
               'external_dependencies': sorted({target for targets in graph.values() for target in targets if target not in ids})}
    return request, summary


def rpc(path, request):
    frame = encoded(request) + b'\n'
    if len(frame) > MAX_FRAME:
        raise ValueError('request exceeds 1 MiB')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(30)
        client.connect(path)
        client.sendall(frame)
        with client.makefile('rb') as reader:
            response = reader.readline(4 * MAX_FRAME + 1)
    if len(response) > 4 * MAX_FRAME or not response.endswith(b'\n'):
        raise ValueError('invalid server response')
    result = json.loads(response)
    if not isinstance(result, dict) or result.get('ok') is not True:
        raise ValueError('server rejected request')
    return result.get('data')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('export_file', type=Path)
    parser.add_argument('--db', default=os.environ.get('SIS_DB'), help='explicit target project database; required with --apply')
    parser.add_argument('--sock', default=os.environ.get('SIS_SOCK'))
    parser.add_argument('--actor', default='legacy-file-import')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--apply', action='store_true')
    modes.add_argument('--dry-run', '--dry', action='store_true', help='validate without connecting (default)')
    args = parser.parse_args(argv)
    try:
        actor = text(args.actor, 'actor', True)
        if len(actor) > 128:
            raise ValueError('actor exceeds 128 characters')
        path = args.export_file.resolve(strict=True)
        records, digest = load_export(path)
        token = os.environ.get('SIS_ADMIN_TOKEN', '') if args.apply else '<admin-token>'
        request, summary = prepare(records, path, digest, token, actor)
        if not args.apply:
            print(json.dumps(dict(summary, mode='dry-run'), sort_keys=True))
            return 0
        if not args.db or not token:
            raise ValueError('explicit database and admin authority required')
        db = str(Path(args.db).resolve(strict=True))
        sock = args.sock or '/tmp/sis-' + hashlib.sha256(db.encode()).hexdigest()[:20] + '.sock'
        context = rpc(sock, {'cmd': 'context', 'args': {}})
        if not isinstance(context, dict) or not context.get('project_id') or str(Path(context.get('db_path', '')).resolve()) != db:
            raise ValueError('database/socket identity mismatch')
        for req in (request if isinstance(request, list) else [request]):
            rpc(sock, req)
        print(json.dumps(dict(summary, mode='applied', project_id=context['project_id']), sort_keys=True))
        return 0
    except (ValueError, OSError, UnicodeError, TypeError, OverflowError):
        print('Import rejected: invalid export, missing authority, identity mismatch or failed atomic request. No token or payload is printed.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
