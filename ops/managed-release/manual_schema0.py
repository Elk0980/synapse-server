"""Manual managed release: reviewed JSON data + frozen 477/482 helpers.

Only schema0 is implemented. No polling, identity issuer, arbitrary commands,
migrations, database restoration or automatic replay. Importing this module
does not touch the application. Root reviews this file AND the manifest first.
"""
from pathlib import Path, PurePosixPath
import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import subprocess as sp
import sys
import time
import types
import urllib.request

P = Path('/opt/synapse/releases/tasks-mcp-20261103-r1')
REPO = Path('/opt/synapse')
LOCK = REPO / '.palitra-app-release.lock'
R1 = P / 'release-475-476-25-r1'
LIBRARIES = {
    'lowlevel': (P / 'release477-resume-r2.py', '1a758b6c1609bec8e8aa431d6703d2380d334a2936a76c4a27ec1f8f52903cd8'),
    'schema0': (P / 'release482-onefile-r1.py', '6ae8ea27836a07f36c3d10cb58412b3658e7569f6dc88c39a06ed9b20b55d750'),
}
SERVICES = {'crm': 'synapse-crm-1', 'content': 'synapse-content-1', 'tasks-mcp': 'synapse-tasks-mcp-1'}
R = S = N = CONFIG = None
SOURCE_SHA = MANIFEST_SHA = None
LABEL = 'synapse.managed.manual'


class Refusal(Exception):
    pass


def need(value, code):
    if not value:
        raise Refusal(code)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
                      default=lambda x: str(x) if isinstance(x, Path) else None).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def filehash(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def regular(path, protected=False, directory=False):
    path = Path(path)
    need(path.is_absolute() and not any(p.is_symlink() for p in [path, *path.parents]), 'REGULAR_ABSOLUTE_PATH_REQUIRED')
    info = path.stat()
    need(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), 'REGULAR_PATH_TYPE')
    if protected:
        need(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == (0o700 if directory else 0o600)
             and (directory or info.st_nlink == 1), 'PRIVATE_ROOT_PERMISSIONS_REQUIRED')
    return info


def load(path):
    return json.loads(Path(path).read_bytes())


def write(path, value, raw=False):
    path = Path(path)
    need(path.is_relative_to(N) and not path.exists() and not path.is_symlink(), 'PRIVATE_WRITE_ONCE_REQUIRED')
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with path.open('xb') as stream:
        stream.write(value if raw else canonical(value) + b'\n')
        stream.flush()
        os.fsync(stream.fileno())
    path.chmod(0o600)


def event(code):
    need(re.fullmatch('[A-Z0-9_]+', code) is not None, 'FIXED_EVENT_CODE_REQUIRED')
    with (N / 'events.redacted.jsonl').open('ab') as stream:
        stream.write(canonical({'phase': code, 'at': time.time()}) + b'\n')
        stream.flush()
        os.fsync(stream.fileno())
    print('MANAGED_' + code, flush=True)


def validate_manifest(config, require_merge=True):
    need(config.get('format') == 1 and config.get('profile') == 'schema0', 'ONLY_SCHEMA0_PROFILE_IMPLEMENTED')
    need(config.get('schema_changes') == 0 and config.get('dependency_changes') is False, 'SCHEMA_AND_DEPENDENCIES_MUST_BE_UNCHANGED')
    need(type(config.get('pr')) is int and config['pr'] > 0 and re.fullmatch(r'pr[0-9]+-r[0-9]+', config.get('release_id', '')), 'RELEASE_ID_REQUIRED')
    need(config['release_id'].split('-')[0] == 'pr' + str(config['pr']), 'RELEASE_PR_BINDING')
    for key in ['approved_head', 'public_base']:
        need(re.fullmatch('[0-9a-f]{40}', config.get(key, '')) is not None, 'PUBLIC_COMMIT_PIN_REQUIRED')
    if require_merge:
        need(re.fullmatch('[0-9a-f]{40}', config.get('merge_sha') or '') is not None
             and config['merge_sha'] != config['approved_head'], 'ACTUAL_MERGE_PIN_REQUIRED')
    runtime, static = config.get('runtime_paths', []), config.get('static_paths', [])
    need(isinstance(runtime, list) and isinstance(static, list) and len(set(runtime + static)) == len(runtime + static)
         and bool(runtime or static), 'EXACT_NONEMPTY_PATH_SET_REQUIRED')
    targets = set()
    for path in runtime + static:
        parts = PurePosixPath(path)
        need(not parts.is_absolute() and '..' not in parts.parts and '\\' not in path, 'BOUNDED_RELATIVE_PATH_REQUIRED')
        if path in runtime:
            need(len(parts.parts) == 3 and parts.parts[0] == 'ops' and parts.parts[1] in SERVICES
                 and parts.suffix == '.js' and not parts.name.endswith('.test.js'), 'RUNTIME_JS_SCOPE_REQUIRED')
            targets.add(parts.parts[1])
        else:
            need(path.startswith('sites/synapse/cabinet/') or path == 'sites/synapse/cabinet.html', 'STATIC_CABINET_SCOPE_REQUIRED')
    need(sorted(targets) == sorted(config.get('target_services', [])), 'EXACT_SERVICE_PATH_CLOSURE_REQUIRED')
    rules = config.get('rules', {}).get('files', [])
    need(config.get('rules', {}).get('approved_head') == config['approved_head']
         and sorted(x.get('path') for x in rules) == sorted(runtime + static), 'EXACT_APPROVED_RULE_SET_REQUIRED')
    for rule in rules:
        need(rule.get('operation') in ['exact_unique_hunks', 'create_absent'], 'APPROVED_PATCH_OPERATION_REQUIRED')
        if rule['operation'] == 'exact_unique_hunks':
            need(isinstance(rule.get('edits'), list) and rule['edits'], 'PUBLIC_HUNKS_REQUIRED')
            for edit in rule['edits']:
                need(all(isinstance(edit.get(k), str) and edit[k] for k in ['before', 'after'])
                     and sha(edit['before'].encode()) == edit.get('before_sha256')
                     and sha(edit['after'].encode()) == edit.get('after_sha256'), 'PUBLIC_HUNK_DIGEST')
        else:
            need(type(rule.get('bytes')) is int and rule['bytes'] > 0
                 and re.fullmatch('[0-9a-f]{64}', rule.get('sha256', '')) is not None, 'NEW_PUBLIC_BLOB_PIN')
    need(config.get('publish_order', []) == static, 'DECLARED_STATIC_PUBLISH_ORDER_REQUIRED')
    need(config.get('no_business_smoke') is True, 'NO_BUSINESS_SMOKE_REQUIRED')
    blobs = config.get('public_blobs', {})
    need(set(blobs) == set(runtime + static), 'EXACT_PUBLIC_BLOB_SET_REQUIRED')
    for rule in rules:
        values = [blobs[rule['path']]]
        if rule['operation'] == 'exact_unique_hunks':
            values.append(values[0].get('before', {}))
        for value in values:
            need(type(value.get('bytes')) is int and 0 < value['bytes'] <= 4 * 1024 * 1024
                 and re.fullmatch('[0-9a-f]{64}', value.get('sha256', '')) is not None
                 and re.fullmatch('[0-9a-f]{40}', value.get('git_blob', '')) is not None, 'EXACT_PUBLIC_BLOB_METADATA_REQUIRED')


def own_source_pins(manifest_path):
    regular(Path(__file__), protected=True)
    regular(manifest_path, protected=True)
    need(filehash(Path(__file__)) == SOURCE_SHA == os.environ.get('SB_MANAGED_RELEASE_SCRIPT_SHA'), 'REVIEWED_RUNNER_SHA_REQUIRED')
    need(filehash(manifest_path) == MANIFEST_SHA == os.environ.get('SB_MANAGED_RELEASE_MANIFEST_SHA'), 'REVIEWED_MANIFEST_SHA_REQUIRED')


def last_run_number(directory):
    values = [int(p.name.split('-', 1)[0]) for p in directory.iterdir()
              if re.fullmatch(r'[0-9]+-.+\.rc\.json', p.name)]
    return max([50000, *values])


def clean_child_environment(values):
    prefixes = ('TASKS_', 'SB472_', 'SB477_', 'SB479_', 'SB480_', 'SB482_', 'SB485_',
                'SB_MANAGED_', 'COMPOSE_', 'PEOPLE_', 'VAPID_')
    need(isinstance(values, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in values.items())
         and not any(k.startswith(prefixes) for k in values), 'CLEAN_COMPOSE_CHILD_ENV_REQUIRED')
    return values


def library():
    global R, S
    modules = {}
    for key, (path, digest) in LIBRARIES.items():
        regular(path, protected=True)
        need(filehash(path) == digest, 'FROZEN_LIBRARY_SHA_REQUIRED')
        module = types.ModuleType('managed_manual_' + key)
        module.__file__ = str(path)
        exec(compile(path.read_bytes(), str(path), 'exec'), module.__dict__)
        modules[key] = module
    R, S = modules['lowlevel'], modules['schema0']
    R.N, R.SOURCE_SHA, R.RUN_NUMBER = N, LIBRARIES['lowlevel'][1], last_run_number(N)
    R.DEFAULT_DATABASES = {'crm': '/data/crm.sqlite', 'content': '/data/content.sqlite'}
    # Low-level readiness reads all three; mutation/foreign scope stays in S.
    R.TARGETS = SERVICES.copy()
    S.R, S.N, S.TARGETS = R, N, {k: SERVICES[k] for k in CONFIG['target_services']}
    S.LABEL, S.SOURCE_SHA, S.COUNT, S.OWNED = LABEL, SOURCE_SHA, 0, {}
    S.pins, S.event = pins, event


def pins(plan):
    own_source_pins(Path(CONFIG['_manifest_path']))
    R.pins(plan)


def selected_fact(proof, kind):
    value = proof.get('mcp' if kind == 'tasks-mcp' else kind)
    need(isinstance(value, dict), 'PARENT_CONTAINER_FACT_REQUIRED')
    return value


def preflight():
    parent = CONFIG['parent']
    for key in ['receipt', 'plan', 'source']:
        regular(parent[key], protected=True)
        need(filehash(parent[key]) == parent[key + '_sha256'], 'PARENT_' + key.upper() + '_SHA_REQUIRED')
    proof, previous = load(parent['receipt']), load(parent['plan'])
    need(proof.get('verified') is True and proof.get('merge') == parent['merge']
         and proof.get('source_sha256') == parent['source_sha256']
         and proof.get('release_plan_sha256') == parent['plan_sha256']
         and proof.get('notifications_off') is True and proof.get('database_restored') is False, 'ACTUAL_VERIFIED_PARENT_REQUIRED')
    rows = {row['Name']: row for row in R.running()}
    current = {}
    for kind, name in SERVICES.items():
        row = rows.get('/' + name)
        need(row is not None and R.matching_fact(row, selected_fact(proof, kind))
             and row['State']['Running'] and row['RestartCount'] == 0, 'CURRENT_PARENT_CONTAINER_FACT_CHANGED')
        R.flags(row)
        need(R.env_map(row).get('TASK_WATCHDOG_MODE', 'observe') in ['', 'observe'], 'WATCHDOG_OBSERVE_REQUIRED')
        current[kind] = row
    common = previous['command']
    R.verify_prefix(common)
    files = [common[i + 1] for i, item in enumerate(common[:-1]) if item in ['-f', '--file']]
    envfiles = [common[i + 1] for i, item in enumerate(common[:-1]) if item == '--env-file']
    need(envfiles and envfiles[-1] == str(R1 / '.env'), 'CANONICAL_ENV_LAST_REQUIRED')
    r1path = R1 / 'pr476/prepared-plan.json'
    regular(r1path, protected=True)
    envpath = Path(load(r1path)['child_environment_file'])
    regular(envpath, protected=True)
    R.GLOBAL_ENV = clean_child_environment(load(envpath))
    R.remember_build_secrets(R.GLOBAL_ENV)
    inputs = copy.deepcopy(previous['input_pins'])
    for kind, row in current.items():
        R.remember_build_secrets(R.env_map(row))
        context = R.compose_context(row)
        need(R.subsequence(context['config_files'], files) and R.subsequence(context['environment_files'], envfiles), 'FULL_CURRENT_RECIPE_COVERAGE_REQUIRED')
    for path, digest in inputs.items():
        regular(path)
        need(filehash(path) == digest, 'PREVIOUS_RELEASE_INPUT_CHANGED')
    for path in [*map(Path, files + envfiles), r1path, envpath, Path(__file__), Path(CONFIG['_manifest_path']),
                 *[Path(parent[k]) for k in ['receipt', 'plan', 'source']], *[x[0] for x in LIBRARIES.values()]]:
        regular(path)
        inputs[str(path)] = filehash(path)
    schemas = proof['schemas']
    need(set(schemas) == {'crm', 'content'}, 'BOTH_PARENT_DATABASE_SCHEMAS_REQUIRED')
    archive, _ = R.archive_receipts()
    databases = {}
    for kind in ['crm', 'content']:
        location = R.db_host_path(current[kind], kind)
        need(location['container_path'] == '/data/' + kind + '.sqlite', 'EXACT_MOUNTED_DATABASE_REQUIRED')
        databases[kind] = location['host_path']
        S.db_contract(Path(location['host_path']), kind, schemas[kind], archive)
        need(str(previous['databases'][kind]) == location['host_path'], 'PARENT_DATABASE_PATH_CHANGED')
    skips = {}
    for kind in CONFIG['target_services']:
        row = current[kind]
        need(not any(x['Destination'] == '/app' or x['Destination'].startswith('/app/node_modules') for x in row['Mounts']), 'APP_OR_DEPENDENCIES_MASKED')
        values = [x['Destination'] for x in row['Mounts'] if x['Destination'].startswith('/app/')]
        if kind == 'tasks-mcp':
            docs = R.env_map(row).get('TASKS_MCP_DOCS_DIR') or '/app/docs/handoff'
            if docs.startswith('/app/'):
                values.append(docs)
        if kind == 'content':
            assets = R.env_map(row).get('ASSETS_DIR') or '/data/assets'
            if assets.startswith('/app/'):
                values.append(assets)
        need(all('..' not in PurePosixPath(x).parts and x.startswith('/app/') for x in values), 'BOUNDED_MOUNT_DATA_SKIPS_REQUIRED')
        skips[kind] = sorted(set(values))
    plan = {'before': {k: current[k] for k in CONFIG['target_services']}, 'all_before': current,
            'foreign_before': S.foreign(), 'guards': previous['guards'], 'input_pins': inputs,
            'common': common, 'databases': databases, 'schemas': schemas, 'archive38': archive,
            'static_paths': CONFIG['static_paths'], 'checkout_before': R.checkout_snapshot(set(CONFIG['static_paths'])),
            'skips': skips, 'source_indexes': {}, 'sources': {}, 'static': {}, 'parent_receipt_sha256': parent['receipt_sha256'],
            'started_at': load(N / 'attempt.once.json')['at']}
    S.stable(plan)
    event('PREFLIGHT_PRODUCTION_READONLY_PASS')
    return plan


def stage_public(plan):
    """Fetch immutable PUBLIC blobs; patch actual managed bytes, never overwrite them."""
    def fetch(ref, rel, expected):
        url = 'https://raw.githubusercontent.com/Elk0980/synapse-server/' + ref + '/' + rel
        with urllib.request.urlopen(url, timeout=30) as response:
            data = response.read(4 * 1024 * 1024 + 1)
        need(0 < len(data) <= 4 * 1024 * 1024, 'PUBLIC_BLOB_SIZE_LIMIT')
        need(sha(data) == expected['sha256'] and len(data) == expected['bytes']
             and hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == expected['git_blob'], 'IMMUTABLE_PUBLIC_BLOB_PIN')
        return data
    for rule in CONFIG['rules']['files']:
        rel = rule['path']
        expected = CONFIG['public_blobs'][rel]
        data = fetch(CONFIG['approved_head'], rel, expected)
        if rule['operation'] == 'exact_unique_hunks':
            before = fetch(CONFIG['public_base'], rel, expected['before'])
            need(S.edit(before, rule) == data, 'HUNKS_MUST_REPRODUCE_ACCEPTED_PUBLIC_BLOB')
            base = N / 'public-base' / rel
            write(base, before, True)
            plan['input_pins'][str(base)] = filehash(base)
        path = N / 'approved' / rel
        write(path, data, True)
        plan['input_pins'][str(path)] = filehash(path)


def capture(plan):
    S.same_targets(plan)
    for kind, row in plan['before'].items():
        image = R.image(row['Image'])
        need(image['Config'].get('WorkingDir') == '/app' and (not image['Config'].get('Healthcheck')
             or image['Config']['Healthcheck'].get('Test') == ['NONE']), 'NO_IMAGE_HOOKS_REQUIRED')
        skip = json.dumps(plan['skips'][kind])
        active = json.loads(S.run(['docker', 'exec', row['Id'], 'node', '-e', S.INDEX_JS, skip], 'active-code-index'))
        raw, _ = S.helper(image['Id'], ['-e', S.INDEX_JS, skip], 'parent-code-index')
        need(active and active == json.loads(raw), 'LIVE_CODE_AND_DEPENDENCIES_MUST_EQUAL_IMAGE')
        plan['source_indexes'][kind] = active
    for rule in CONFIG['rules']['files']:
        rel = rule['path']
        is_runtime = rel in CONFIG['runtime_paths']
        before, meta = None, None
        if is_runtime:
            kind = PurePosixPath(rel).parts[1]
            target = '/app/' + PurePosixPath(rel).name
            row = plan['before'][kind]
            need(not any(target == x['Destination'] or PurePosixPath(x['Destination']) in PurePosixPath(target).parents for x in row['Mounts'])
                 and not any(target == x or target.startswith(x + '/') for x in plan['skips'][kind]), 'TARGET_MASKED_OR_SKIPPED')
            index = {x['path']: x for x in plan['source_indexes'][kind]}
            if rule['operation'] == 'create_absent':
                need(target not in index, 'NEW_RUNTIME_TARGET_EXISTS')
            else:
                meta = index.get(target)
                need(meta and meta['type'] == 'file' and (meta['uid'], meta['gid'], meta['mode']) == (0, 0, 0o644), 'TARGET_FILE_METADATA')
                before = S.run(['docker', 'exec', row['Id'], 'cat', target], 'capture-managed-source')
                need(sha(before) == meta['sha256'], 'LIVE_SOURCE_SHA_CHANGED')
        else:
            target = REPO / rel
            regular(target.parent, directory=True)
            if rule['operation'] == 'create_absent':
                need(not target.exists() and not target.is_symlink(), 'NEW_STATIC_TARGET_EXISTS')
            else:
                info = regular(target)
                before = target.read_bytes()
                meta = {'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode), 'dev': info.st_dev,
                        'ino': info.st_ino, 'size': info.st_size, 'mtime_ns': info.st_mtime_ns}
        if before is None:
            data = (N / 'approved' / rel).read_bytes()
            need(sha(data) == rule['sha256'] and len(data) == rule['bytes'], 'NEW_BLOB_SHA_REQUIRED')
        else:
            data = S.edit(before, rule)
            old = N / 'source-before' / rel
            write(old, before, True)
            plan['input_pins'][str(old)] = sha(before)
        output = N / ('source/' + kind + '/' + PurePosixPath(rel).name if is_runtime else 'static-after/' + rel)
        write(output, data, True)
        plan['input_pins'][str(output)] = filehash(output)
        if is_runtime:
            plan['sources'][rel] = {'kind': kind, 'target': target, 'source': str(output), 'before_sha256': sha(before) if before is not None else None,
                                    'after_sha256': sha(data), 'bytes': len(data)}
        else:
            plan['static'][rel] = {'path': str(target), 'source': str(output), 'before_source': str(N / 'source-before' / rel) if before is not None else None,
                                   'before_sha256': sha(before) if before is not None else None, 'after_sha256': sha(data), 'metadata': meta}
    S.same_targets(plan)
    event('ADAPTIVE_SOURCE_AND_STATIC_BACKUPS_VERIFIED')


def protected_backup(plan):
    plan['backup_sha256'] = {}
    if plan['before']:
        size = sum(Path(str(db) + suffix).stat().st_size for db in plan['databases'].values()
                   for suffix in ['', '-wal', '-shm'] if Path(str(db) + suffix).exists())
        need(shutil.disk_usage(P).free > max(2 * 1024**3, size * 6), 'BACKUP_SPACE_REQUIRED')
        for kind in ['crm', 'content']:
            output = N / 'before-build' / (kind + '.sqlite')
            S.backup(Path(plan['databases'][kind]), output)
            S.db_contract(output, kind, plan['schemas'][kind], plan['archive38'])
            plan['backup_sha256'][kind] = filehash(output)
        event('ONLINE_BACKUPS_AND_MEMORY_RESTORE_BEFORE_BUILD_PASS')
    else:
        event('STATIC_CURRENT_FILE_BACKUPS_PASS')


def build(plan):
    images = {}
    for kind, row in plan['before'].items():
        S.same_targets(plan)
        parent = R.image(row['Image'])
        base, tag = ['synapse-' + kind + ':' + prefix + CONFIG['release_id'] for prefix in ['before-', '']]
        for name in [base, tag]:
            need(not S.run(['docker', 'image', 'ls', '-q', '--no-trunc', name], 'fresh-build-tag').strip(), 'BUILD_TAG_ALREADY_EXISTS')
        items = [x for x in plan['sources'].values() if x['kind'] == kind]
        folder = N / 'source' / kind
        names = sorted(Path(x['source']).name for x in items)
        write(folder / 'Dockerfile', ('FROM ' + base + '\nCOPY --chown=0:0 --chmod=0644 ' + ' '.join(names) + ' /app/\n').encode(), True)
        need(set(x.name for x in folder.iterdir()) == set(names) | {'Dockerfile'}, 'EXACT_BUILD_CONTEXT_REQUIRED')
        S.run(['docker', 'tag', parent['Id'], base], 'local-parent-tag')
        need(R.image(base)['Id'] == parent['Id'], 'PARENT_TAG_DRIFT')
        event('BUILD_' + kind.upper().replace('-', '_') + '_START')
        S.run(['docker', 'build', '--network', 'none', '--pull=false', '-t', tag, str(folder)], 'build-' + kind, timeout=1200)
        candidate = R.image(tag)
        need(candidate['Config'] == parent['Config'] and candidate['RootFS']['Layers'][:len(parent['RootFS']['Layers'])] == parent['RootFS']['Layers']
             and len(candidate['RootFS']['Layers']) > len(parent['RootFS']['Layers']) and R.image(base)['Id'] == parent['Id'], 'CHILD_IMAGE_CONFIG_AND_LAYERS_REQUIRED')
        expected = {x['path']: x for x in plan['source_indexes'][kind]}
        for item in items:
            expected[item['target']] = {'path': item['target'], 'type': 'file', 'mode': 0o644, 'uid': 0, 'gid': 0,
                                        'bytes': item['bytes'], 'sha256': item['after_sha256']}
        raw, _ = S.helper(candidate['Id'], ['-e', S.INDEX_JS, json.dumps(plan['skips'][kind])], 'candidate-code-index')
        need({x['path']: x for x in json.loads(raw)} == expected, 'UNRELATED_CODE_OR_DEPENDENCIES_CHANGED')
        for item in items:
            S.helper(candidate['Id'], ['--check', item['target']], 'candidate-syntax')
        images[kind] = candidate['Id']
        S.same_targets(plan)
        event('BUILD_' + kind.upper().replace('-', '_') + '_PASS')
    return images


def recipe(plan, images):
    before = json.loads(S.run(plan['common'] + ['config', '--format', 'json'], 'current-recipe'))
    for kind, name in SERVICES.items():
        need(R.image(before['services'][kind]['image'])['Id'] == R.inspect(name)['Image'], 'CURRENT_RECIPE_IMAGE_CHANGED')
    if not images:
        plan.update(images={}, command=plan['common'], rollback_command=plan['common'])
        return
    candidate, rollback = N / 'candidate.json', N / 'rollback.json'
    write(candidate, {'services': {k: {'image': v} for k, v in images.items()}})
    command = plan['common'] + ['-f', str(candidate)]
    rendered = json.loads(S.run(command + ['config', '--format', 'json'], 'candidate-recipe'))
    expected = copy.deepcopy(before)
    for kind, image in images.items():
        expected['services'][kind]['image'] = image
    need(rendered == expected, 'ONLY_DECLARED_IMAGES_MAY_CHANGE')
    write(rollback, {'services': {k: {'image': row['Image']} for k, row in plan['before'].items()}})
    rollback_command = command + ['-f', str(rollback)]
    need(json.loads(S.run(rollback_command + ['config', '--format', 'json'], 'rollback-recipe')) == before, 'EXACT_ROLLBACK_RECIPE_REQUIRED')
    for kind, image in images.items():
        definition = rendered['services'][kind]
        health = definition.get('healthcheck')
        need((not health or health.get('disable') is True) and not definition.get('post_start') and not definition.get('pre_stop'), 'UNREVIEWED_COMPOSE_HOOKS_REFUSED')
        name = 'managed-' + CONFIG['release_id'] + '-probe-' + kind
        need(R.inspect(name, True) is None, 'PROBE_NAME_EXISTS')
        S.OWNED[name] = {'image': image, 'args': ['-e', S.PROBE_CODE], 'id': None, 'probe': True}
        try:
            S.run(command + ['run', '--detach', '--no-deps', '--pull', 'never', '--name', name,
                  '--label', LABEL + '=' + SOURCE_SHA, '--entrypoint', 'node', kind, '-e', S.PROBE_CODE], 'signal-probe')
            probe, old = R.inspect(name), plan['before'][kind]
            S.OWNED[name]['id'] = probe['Id']
            need(probe['State']['Running'] and probe['Image'] == image and R.env_map(probe) == R.env_map(old)
                 and R.mounts(probe) == R.mounts(old) and R.network(probe) == R.network(old), 'PROBE_ENV_MOUNT_NETWORK_CHANGED')
            need(probe['Config']['User'] == old['Config']['User'] and probe['Config']['WorkingDir'] == old['Config']['WorkingDir']
                 and probe['Config']['Entrypoint'] == ['node'] and probe['Config']['Cmd'] == ['-e', S.PROBE_CODE], 'SIGNAL_AWARE_NODE_PROBE_REQUIRED')
        finally:
            S.remove_owned(name)
    plan.update(images=images, command=command, rollback_command=rollback_command)
    plan['input_pins'].update({str(candidate): filehash(candidate), str(rollback): filehash(rollback)})
    S.same_targets(plan)
    event('EXACT_IMAGE_RECIPE_AND_SIGNAL_PROBES_PASS')


def public_checks(plan, after=True):
    for rel in CONFIG['static_paths']:
        value = plan['static'][rel]
        digest = value['after_sha256'] if after else value['before_sha256']
        if digest is None:
            continue
        need(filehash(REPO / rel) == digest, 'PUBLIC_HOST_BYTES_CHANGED')
        url = 'https://synapse.synapsebusiness.ru/' + rel.removeprefix('sites/synapse/')
        for query in CONFIG.get('public_queries', ['']):
            need(isinstance(query, str) and (query == '' or re.fullmatch(r'\?v=[A-Za-z0-9_-]+', query)), 'BOUNDED_PUBLIC_QUERY_REQUIRED')
            with urllib.request.urlopen(urllib.request.Request(url + query, headers={'Cache-Control': 'no-cache'}), timeout=30) as response:
                need(response.status == 200 and sha(response.read(8 * 1024 * 1024)) == digest, 'PUBLIC_HTTP_SHA_MISMATCH')


def restore_code(plan, intents):
    pins(plan)
    S.cleanup()
    S.state_check(plan)
    conflicts = S.rollback_static(intents)
    need(not conflicts, 'STATIC_ROLLBACK_CAS_CONFLICT_STOP')
    for kind, old in plan['before'].items():
        current = R.inspect(SERVICES[kind], True)
        if current is not None:
            need(current['Image'] in [old['Image'], plan['images'][kind]], 'UNKNOWN_ROLLBACK_IMAGE')
            need(R.normalized_config(current) == R.normalized_config(old) and R.normalized_host_config(current) == R.normalized_host_config(old)
                 and R.mounts(current) == R.mounts(old) and R.network(current) == R.network(old), 'UNKNOWN_ROLLBACK_SETTINGS')
        pins(plan)
        S.run(plan['rollback_command'] + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', kind], 'rollback-only-' + kind, timeout=300)
        R.runtime_contract(R.inspect(SERVICES[kind]), old, old['Image'])
        R.readiness(kind)
    S.state_check(plan)
    public_checks(plan, False)
    write(N / 'rollback.redacted.json', {'verified': True, 'code_only': True, 'database_restored': False,
                                       'forward_data_preserved': True, 'queue_must_stop': True})
    event('CODE_ONLY_ROLLBACK_VERIFIED_QUEUE_STOP')


def apply(plan):
    intents, up_intent = [], False
    started = plan.get('started_at', time.time())
    try:
        S.same_targets(plan)
        S.state_check(plan)
        for value in plan['static'].values():
            S.static_cas(value)
        write(N / 'apply-intent.once.json', {'at': time.time(), 'manifest_sha256': MANIFEST_SHA})
        for kind, image in plan['images'].items():
            up_intent = True
            event('UP_' + kind.upper().replace('-', '_') + '_INTENT')
            S.run(plan['command'] + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', kind], 'up-only-' + kind, timeout=300)
            R.readiness(kind)
            R.runtime_contract(R.inspect(SERVICES[kind]), plan['before'][kind], image)
        S.state_check(plan)
        health = {}
        for kind in SERVICES:
            R.readiness(kind)
            health['mcp' if kind == 'tasks-mcp' else kind] = True
        if plan['before']:
            S.readonly_smoke()
        for rel in CONFIG['publish_order']:
            pins(plan)
            value = plan['static'][rel]
            S.static_cas(value)
            data = Path(value['source']).read_bytes()
            need(sha(data) == value['after_sha256'], 'STATIC_PAYLOAD_PIN')
            meta = value['metadata']
            if meta is None:
                info = Path(value['path']).parent.stat()
                meta = {'uid': info.st_uid, 'gid': info.st_gid, 'mode': 0o644}
            intents.append(value)
            S.atomic_public(value['path'], data, meta)
            need(filehash(value['path']) == value['after_sha256'], 'STATIC_COPY_READBACK')
        public_checks(plan)
        state = S.state_check(plan)
        S.cleanup()
        S.stable(plan)
        proof = {'verified': True, 'pr': CONFIG['pr'], 'accepted_head': CONFIG['approved_head'], 'merge': CONFIG['merge_sha'],
                 'source_sha256': SOURCE_SHA, 'manifest_sha256': MANIFEST_SHA, 'release_plan_sha256': filehash(N / 'release-plan.private.json'),
                 'parent_receipt_sha256': CONFIG['parent']['receipt_sha256'], 'schemas': state, 'schema_changes': 0,
                 'crm': R.fact(R.inspect(SERVICES['crm'])), 'content': R.fact(R.inspect(SERVICES['content'])), 'mcp': R.fact(R.inspect(SERVICES['tasks-mcp'])),
                 'target_services': CONFIG['target_services'], 'runtime_paths': CONFIG['runtime_paths'], 'static_paths': CONFIG['static_paths'],
                 'started_at': started, 'finished_at': time.time(), 'notifications_off': True, 'database_restored': False,
                 'health': health, 'backup_sha256': plan['backup_sha256'], 'backup_verified': True,
                 'business_smoke_calls': 0, 'npm_executed': False, 'schema0_verified': True, 'foreign_guards_checkout_preserved': True,
                 'manual_operator_release': True, 'automated_identity_admission_claimed': False}
        write(N / 'final-verified.redacted.json', proof)
        event('SCHEMA0_MANUAL_RELEASE_VERIFIED')
        return proof
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        write(N / 'failure.redacted.json', {'apply_failed': True, 'up_intent': up_intent,
                                          'static_intents': len(intents), 'no_blind_retry': True, 'database_restored': False})
        event('APPLY_FAILURE_INSPECT_ONLY')
        if up_intent or intents:
            restore_code(plan, intents)
        else:
            S.cleanup()
            S.same_targets(plan)
        raise


def report(proof):
    marker = 'MANAGED_' + CONFIG['release_id'].upper().replace('-', '_') + '_VERIFIED'
    receipt = {'pr': CONFIG['pr'], 'verified': True, 'merge': CONFIG['merge_sha'], 'schema_changes': 0,
               'targets': CONFIG['target_services'], 'proof_sha256': filehash(N / 'final-verified.redacted.json'),
               'plan_sha256': proof['release_plan_sha256'], 'database_restored': False,
               'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(proof['started_at'])),
               'finished_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(proof['finished_at'])),
               'health': proof['health'], 'backup_verified': proof['backup_verified'], 'backup_sha256': proof['backup_sha256'],
               'backup_paths': 'PRIVATE_BEFORE_BUILD', 'receipt_path': str(N / 'final-verified.redacted.json')}
    text = marker + '\n' + canonical(receipt).decode()
    need(len(text) < 1800, 'COMPACT_REPORT_BOUND')
    # Fixed task25 only, existing MCP credentials stay inside its unchanged container.
    code = S.COMMENT_JS.replace('task_id:43', 'task_id:25')
    payload = {'marker': marker, 'author': 'Codex — Управляемый выпуск', 'text': text}
    try:
        raw = S.run(['docker', 'exec', '-i', SERVICES['tasks-mcp'], 'node', '-e', code], 'task25-report', data=canonical(payload), timeout=120)
        value = json.loads(raw)
        need(type(value.get('comment_id')) is int, 'COMMENT_READBACK_REQUIRED')
        write(N / 'task25-report.redacted.json', value)
        event('TASK25_REPORTED')
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        write(N / 'task25-report-pending.redacted.json', {'comment_only_retry': True, 'installer_must_not_run_again': True, **payload})
        event('VERIFIED_REPORT_PENDING')


def child(manifest_path, stage):
    global CONFIG, N, SOURCE_SHA, MANIFEST_SHA
    os.umask(0o077)
    SOURCE_SHA, MANIFEST_SHA = filehash(Path(__file__)), filehash(manifest_path)
    own_source_pins(manifest_path)
    CONFIG = load(manifest_path)
    validate_manifest(CONFIG)
    CONFIG['_manifest_path'] = str(manifest_path)
    need(sp.check_output(['hostname']).decode().strip() == 'msk-1-vm-tgnt', 'HOST_IDENTITY_REQUIRED')
    regular(P, protected=True, directory=True)
    need((P / '.gitignore').read_bytes().strip() == b'*', 'PRIVATE_PARENT_IGNORE_REQUIRED')
    N = P / ('managed-' + CONFIG['release_id'])
    if stage == 'apply':
        regular(N, protected=True, directory=True)
        need(not any((N / name).exists() for name in ['failure.redacted.json', 'apply-intent.once.json', 'final-verified.redacted.json']), 'ATTEMPT_OUTCOME_INSPECT_ONLY')
        for path in [N / 'prepared.redacted.json', N / 'release-plan.private.json']:
            regular(path, protected=True)
        prepared = load(N / 'prepared.redacted.json')
        need(prepared['source_sha256'] == SOURCE_SHA and prepared['manifest_sha256'] == MANIFEST_SHA
             and filehash(N / 'release-plan.private.json') == prepared['plan_sha256'], 'REVIEWED_PREPARED_PLAN_REQUIRED')
        library()
        plan = load(N / 'release-plan.private.json')
        plan['input_pins'][str(N / 'release-plan.private.json')] = prepared['plan_sha256']
        envpath = Path(plan['compose_child_environment'])
        regular(envpath, protected=True)
        need(filehash(envpath) == plan['input_pins'].get(str(envpath)), 'PREPARED_COMPOSE_ENV_PIN_REQUIRED')
        R.GLOBAL_ENV = clean_child_environment(load(envpath))
        R.remember_build_secrets(R.GLOBAL_ENV)
        R.lease()
        for row in R.running():
            R.remember_build_secrets(R.env_map(row))
        pins(plan)
        report(apply(plan))
        return 0
    need(not N.exists() and not N.is_symlink(), 'FRESH_RELEASE_NAMESPACE_REQUIRED')
    N.mkdir(mode=0o700)
    write(N / 'attempt.once.json', {'source_sha256': SOURCE_SHA, 'manifest_sha256': MANIFEST_SHA, 'stage': stage, 'at': time.time()})
    library()
    R.lease()
    try:
        plan = preflight()
        write(N / 'preflight.private.json', plan)
        if stage == 'inspect':
            event('READONLY_PREFLIGHT_COMPLETE_NO_BUILD_OR_APPLY')
            return 0
        stage_public(plan)
        capture(plan)
        protected_backup(plan)
        images = build(plan)
        recipe(plan, images)
        plan['compose_child_environment'] = load(R1 / 'pr476/prepared-plan.json')['child_environment_file']
        write(N / 'release-plan.private.json', plan)
        prepared = {'source_sha256': SOURCE_SHA, 'manifest_sha256': MANIFEST_SHA,
                    'plan_sha256': filehash(N / 'release-plan.private.json'), 'application_changed': False}
        write(N / 'prepared.redacted.json', prepared)
        plan['input_pins'][str(N / 'release-plan.private.json')] = prepared['plan_sha256']
        event('PREPARED_IMAGE_RECIPE_BACKUP_PASS')
        if stage == 'run':
            report(apply(plan))
        return 0
    finally:
        S.cleanup()


def parent(manifest_path, stage):
    global SOURCE_SHA, MANIFEST_SHA
    need(sys.platform.startswith('linux') and os.geteuid() == 0, 'LINUX_ROOT_REQUIRED')
    SOURCE_SHA, MANIFEST_SHA = filehash(Path(__file__)), filehash(manifest_path)
    own_source_pins(manifest_path)
    validate_manifest(load(manifest_path))
    need(not LOCK.is_symlink() and LOCK.exists(), 'EXISTING_MANAGED_LOCK_REQUIRED')
    info = LOCK.stat()
    need(info.st_uid == 0 and info.st_nlink == 1 and stat.S_ISREG(info.st_mode), 'ROOT_MANAGED_LOCK_INODE_REQUIRED')
    import fcntl
    with LOCK.open('r+b') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refusal('OTHER_WRITER_LOCK_HELD') from None
        env = dict(os.environ, SB477_LEASE_PID=str(os.getpid()), SB_MANAGED_RELEASE_LEASE_PID=str(os.getpid()))
        print('MANAGED_LOCK_ACQUIRED', flush=True)
        try:
            return sp.run([sys.executable, str(Path(__file__).resolve()), '--manifest', str(manifest_path), '--stage', stage, '--lease-child'], env=env).returncode
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)
            print('MANAGED_LOCK_RELEASED', flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--stage', choices=['inspect', 'prepare', 'apply', 'run'], default='prepare')
    parser.add_argument('--lease-child', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        return child(args.manifest.resolve(), args.stage) if args.lease_child else parent(args.manifest.resolve(), args.stage)
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        code = str(error) if isinstance(error, Refusal) or R is not None and isinstance(error, R.Refusal) or S is not None and isinstance(error, S.Refusal) else 'PRIVATE_JOURNAL_INSPECTION_REQUIRED'
        print('MANAGED_STOP_' + (code if re.fullmatch('[A-Z0-9_]+', code) else 'PRIVATE_JOURNAL_INSPECTION_REQUIRED'), flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
