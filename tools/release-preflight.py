#!/usr/bin/env python3
"""№281: readonly summary or zero-fuzz trial on private copies; never builds/activates."""
import difflib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request

ROOT = Path('/root/claude-rel')
REPO = 'https://raw.githubusercontent.com/Elk0980/synapse-server/'
RELEASES = {
    '642': ('5b2904a6a8df5fb7333aadb06905a02e09fa2aab', '5c27970376c1434e6deec8f13d11121426fef239', [
        'ops/crm/reel-problems.js', 'ops/crm/reel-requests.js', 'ops/crm/reel-materials-http.js',
        'ops/content/server.js', 'ops/content/reel-materials-chat.js']),
    '644': ('5c27970376c1434e6deec8f13d11121426fef239', '4db110e6c31f971cfba4b52684c2c5389d6da3d1', [
        'ops/content/server.js', 'ops/content/montage-watcher-bundle.js']),
}


def sha(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def gitfile(rev, path, missing=False):
    try:
        with urllib.request.urlopen(REPO + rev + '/' + path, timeout=30) as response:
            data = response.read(2_000_001)
    except urllib.error.HTTPError as error:
        if missing and error.code == 404:
            return None
        raise
    if len(data) > 2_000_000:
        raise RuntimeError('file too large')
    return data


def livefile(path):
    _, service, name = path.split('/')
    container = 'synapse-' + service + '-1'
    exists = subprocess.run(['docker', 'exec', container, 'test', '-e', '/app/' + name], capture_output=True, timeout=30)
    if exists.returncode == 1:
        return None
    exists.check_returncode()
    return subprocess.check_output(['docker', 'exec', container, 'cat', '/app/' + name], timeout=30)


def difference(base, live):
    lines = list(difflib.unified_diff(base.decode().splitlines(True), live.decode().splitlines(True), n=3))
    return {'added': sum(s.startswith('+') and not s.startswith('+++') for s in lines),
            'removed': sum(s.startswith('-') and not s.startswith('---') for s in lines),
            'hunks': [s.strip() for s in lines if s.startswith('@@')]}


def inspect():
    path = 'ops/content/server.js'
    base = gitfile(RELEASES['642'][0], path)
    if sha(base) != '73e7d396c2431d58eac3a2e887b82b210614c4693329837ea69d1bebf01c00dc':
        raise RuntimeError('base hash mismatch')
    live = livefile(path)
    print('BASE', sha(base));print('LIVE', sha(live))
    d = difference(base, live)
    print('DIFF added=%d removed=%d total=%d hunks=%d' % (d['added'], d['removed'], d['added'] + d['removed'], len(d['hunks'])))
    for h in d['hunks']:
        print(h)
    labels = json.loads(subprocess.check_output(['docker', 'inspect', '--format', '{{json .Config.Labels}}', 'synapse-content-1'], timeout=30))
    work = labels.get('com.docker.compose.project.working_dir')
    candidates = {Path('/opt/synapse/ops/content/server.js')}
    if work and Path(work).is_absolute():
        candidates.add(Path(work) / 'ops/content/server.js')
    for candidate in sorted(candidates):
        data = candidate.read_bytes() if candidate.is_file() else None
        print('HOST', str(candidate), sha(data), 'equal_live=' + str(data == live))
    prep = (ROOT / 'prpatch.sh').read_text()
    go = (ROOT / 'prgo.sh').read_text()
    print('RECIPE live_parent=' + str('docker inspect' in prep and 'FROM ' in prep), 'prgo_no_build=' + str('--no-build' in go))


def private_file(path, data):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
        stream.write(data)


def prepare(number):
    base, head, paths = RELEASES[number]
    directory = ROOT / ('pre' + number)
    directory.mkdir(mode=0o700)  # Existing snapshots are never overwritten.
    manifest = {'base': base, 'head': head, 'files': {}, 'ok': False}
    for path in paths:
        before = gitfile(base, path, missing=True)
        after = gitfile(head, path)
        live = livefile(path)
        name = path.replace('/', '_')
        row = {'base': sha(before), 'head': sha(after), 'live': sha(live)}
        manifest['files'][path] = row
        if live is not None:
            private_file(directory / (name + '.live'), live)
        target = directory / name
        if before is None:
            if live is not None:
                raise RuntimeError('new file exists: ' + path)
            private_file(target, after)
            row['candidate'] = sha(after)
            print('NEW', path, row['candidate'])
            continue
        if live is None:
            raise RuntimeError('live file absent: ' + path)
        private_file(target, live)
        diff = ''.join(difflib.unified_diff(before.decode().splitlines(True), after.decode().splitlines(True), fromfile='file', tofile='file')).encode()
        patch = directory / (name + '.diff')
        private_file(patch, diff)
        args = ['patch', '--batch', '--forward', '--fuzz=0', str(target), str(patch)]
        trial = subprocess.run([*args[:1], '--dry-run', *args[1:]], capture_output=True, timeout=30)
        if trial.returncode:
            print('DRYFAIL', path, 'live=' + row['live'])
            for line in (trial.stdout + trial.stderr).decode(errors='replace').splitlines():
                if line.startswith('Hunk #') or 'FAILED' in line:
                    print(line)
            private_file(directory / 'manifest.failed.json', json.dumps(manifest, indent=2).encode())
            return 1
        applied = subprocess.run(args, capture_output=True, timeout=30)
        if applied.returncode:
            raise RuntimeError('copy patch failed: ' + path)
        row['candidate'] = sha(target.read_bytes())
        print('DRY_OK', path, 'candidate=' + row['candidate'])
    # A concurrent source modification must stop the release before build.
    for path, row in manifest['files'].items():
        if sha(livefile(path)) != row['live']:
            raise RuntimeError('live changed during trial: ' + path)
    manifest['ok'] = True
    private_file(directory / 'manifest.json', json.dumps(manifest, indent=2).encode())
    print('ALL_DRY_OK', number, 'files=' + str(len(paths)), str(directory))
    return 0


def main():
    if sys.argv[1:] == ['inspect']:
        inspect()
        return 0
    if len(sys.argv) == 3 and sys.argv[1] == 'prepare' and sys.argv[2] in RELEASES:
        return prepare(sys.argv[2])
    print('usage: inspect | prepare 642|644', file=sys.stderr)
    return 2


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        # Never print downloaded/live source, environment or HTTP headers.
        print('PREFLIGHT_ERROR', type(error).__name__, file=sys.stderr)
        sys.exit(1)
