"""Managed-release transaction engine. No action at import; no shell commands.

Root-owned configuration and authenticated admissions are prerequisites. Never
trust task_comments.author as an authenticated reviewer (it is caller supplied).
"""
import argparse
import contextlib
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time
import urllib.request


class Blocked(Exception):
    pass


def need(condition, code):
    if not condition:
        raise Blocked(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(canonical(value))
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
        if os.name == 'posix':
            fd = os.open(path.parent, os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def load(path):
    return json.loads(Path(path).read_bytes())


def private_file(path):
    path = Path(path)
    need(not any(p.is_symlink() for p in (path, *path.parents)), 'PRIVATE_PATH_SYMLINK')
    st = path.stat()
    if os.name == 'posix':
        need(st.st_uid == 0 and st.st_mode & 0o077 == 0, 'PRIVATE_FILE_PERMISSIONS')
    return path.read_bytes()


def command(args, cwd=None, timeout=120):
    # Child output can contain env, tokens or private URLs: never relay it.
    try:
        result = subprocess.run(args, cwd=cwd, capture_output=True, timeout=timeout,
                                check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked('COMMAND_UNCONFIRMED') from None
    need(result.returncode == 0, 'COMMAND_FAILED')
    return result.stdout


@contextlib.contextmanager
def release_lock(path):
    # Same lock inode as the existing managed-release installers. Never unlink.
    import fcntl
    with open(path, 'a+b') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Blocked('RELEASE_BUSY') from None
        yield


def verified_backup(source, target):
    need(not Path(target).exists(), 'BACKUP_ALREADY_EXISTS')
    with contextlib.closing(sqlite3.connect(Path(source).resolve().as_uri() + '?mode=ro', uri=True)) as db:
        need(db.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'SOURCE_INTEGRITY')
        db.execute('VACUUM INTO ?', (str(target),))
    with contextlib.closing(sqlite3.connect(Path(target).resolve().as_uri() + '?mode=ro', uri=True)) as db:
        need(db.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'BACKUP_INTEGRITY')
        need(not db.execute('PRAGMA foreign_key_check').fetchall(), 'BACKUP_FOREIGN_KEYS')
    return hashlib.sha256(Path(target).read_bytes()).hexdigest()


def verify_admission(envelope, key, sha, parent, now=None):
    body = envelope['body']
    expected = hmac.new(key, canonical(body), hashlib.sha256).hexdigest()
    need(hmac.compare_digest(expected, envelope.get('signature', '')), 'ADMISSION_SIGNATURE')
    need(body.get('sha') == sha and body.get('parent') == parent, 'ADMISSION_COMMIT')
    need(body.get('reviewerRole') in ('claude', 'owner'), 'ADMISSION_REVIEWER')
    need(body.get('codeAccepted') is True and body.get('taskId', 0) > 0, 'ADMISSION_ACCEPTANCE')
    need(body.get('expires', 0) > (time.time() if now is None else now), 'ADMISSION_EXPIRED')
    need(body.get('migration') == 'forward-compatible', 'WAITS_OWNER_MIGRATION')
    need(body.get('reconciled') is True, 'BASELINE_NOT_RECONCILED')
    return body


class GitHub:
    def __init__(self, repo):
        need(bool(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo)), 'REPOSITORY')
        self.repo = repo

    def get(self, path):
        req = urllib.request.Request('https://api.github.com/repos/' + self.repo + path,
                                     headers={'User-Agent': 'synapse-release-agent',
                                              'Accept': 'application/vnd.github+json'})
        with urllib.request.urlopen(req, timeout=20) as response:
            raw = response.read(4 * 1024 * 1024 + 1)
            need(len(raw) <= 4 * 1024 * 1024, 'GITHUB_RESPONSE_LIMIT')
            return json.loads(raw)

    def gate(self, sha, admission):
        prs = self.get('/commits/' + sha + '/pulls')
        need(any(p['number'] == admission['pr'] and p.get('merged_at') and
                 p['merge_commit_sha'] == sha and p['base']['ref'] == 'main' for p in prs), 'PR_MERGE_LINK')
        checks = []
        for page in range(1, 21):
            data = self.get('/commits/' + sha + '/check-runs?per_page=100&page=' + str(page))
            checks.extend(data['check_runs'])
            if len(checks) >= data['total_count']:
                break
        else:
            raise Blocked('CHECKS_PAGE_LIMIT')
        # Require checks for the MERGE SHA, never borrow head-branch checks.
        need(checks and all(c['head_sha'] == sha and c['status'] == 'completed' and
                            c['conclusion'] == 'success' for c in checks), 'CI_NOT_GREEN')
        required = set(admission.get('requiredChecks', []))
        need(required and required <= {c['name'] for c in checks}, 'REQUIRED_CHECKS_MISSING')
        status = self.get('/commits/' + sha + '/status')
        need(status.get('total_count', 0) == 0 or status['state'] == 'success', 'COMMIT_STATUS_FAILED')


class Engine:
    def __init__(self, directory, backend):
        self.directory = Path(directory)
        self.path = self.directory / 'state.json'
        self.backend = backend

    def state(self):
        return load(self.path)

    def save(self, state):
        atomic(self.path, state)

    def recover(self):
        state = self.state()
        if state.get('phase') in ('stopping', 'backing_up', 'switching', 'checking', 'rolling_back'):
            # Journal is committed before ANY mutation. Unknown operations are not replayed.
            self.rollback(state, recovery=True)
        elif state.get('phase') in ('prepared', 'build_failed', 'rollback_failed'):
            raise Blocked('INTERRUPTED_RELEASE_NEEDS_REVIEW')

    def rollback(self, state=None, recovery=False):
        state = state or self.state()
        need(state.get('previous') and state.get('plan'), 'NO_PREVIOUS_RELEASE')
        state['phase'] = 'rolling_back'
        self.save(state)
        try:
            self.backend.restore(state['previous'], state['plan'])
            self.backend.health()
        except Exception:
            state['phase'] = 'rollback_failed'
            self.save(state)
            raise Blocked('ROLLBACK_NEEDS_REVIEW') from None
        state['phase'] = 'rolled_back'
        state['failedSha'] = state['plan']['sha']
        state['current'] = state['previous']['sha']
        state['recovered'] = recovery
        # Never restore an old SQLite over new requests. Images must accept forward data.
        state['dataPolicy'] = 'preserve-forward-data'
        self.save(state)

    def deploy(self, plan):
        state = self.state()
        need(state['phase'] in ('idle', 'verified'), 'QUEUE_HALTED')
        need(plan['parent'] == state['current'], 'OUT_OF_ORDER')
        previous = self.backend.capture(state['current'], plan)
        state.update(plan=plan, previous=previous, phase='prepared')
        self.save(state)
        try:
            self.backend.build(plan)
        except Exception:
            state['phase'] = 'build_failed'
            self.save(state)
            raise Blocked('BUILD_FAILED_NO_SWITCH') from None
        # build_failed is deliberately halted until explicit re-admission.
        try:
            state['phase'] = 'stopping'
            self.save(state)
            self.backend.stop(plan)
            state['phase'] = 'backing_up'
            self.save(state)
            self.backend.backup(plan)
            state['phase'] = 'switching'
            self.save(state)
            self.backend.switch(plan)
            state['phase'] = 'checking'
            self.save(state)
            self.backend.health()
        except Exception:
            self.rollback(state)
            raise Blocked('RELEASE_ROLLED_BACK') from None
        state.update(phase='verified', current=plan['sha'], verifiedAt=time.time(), reported=False)
        self.backend.commit(plan)
        self.save(state)


class ComposeBackend:
    """Uses the FULL resolved managed recipe supplied after reconciliation.

    Admission pins its digest; never falls back to docker-compose.yml in main.
    Unknown/static/infra paths fail closed rather than replacing managed files.
    """
    def __init__(self, config):
        self.c = config

    def compose(self, recipe, *args):
        return command(['docker', 'compose', '--project-name', self.c['project'],
                        '--project-directory', self.c['checkout'], '-f', str(recipe), *args], timeout=240)

    def capture(self, current, plan):
        raw = private_file(self.c['recipe'])
        need(hashlib.sha256(raw).hexdigest() == plan['recipeSha256'], 'RECIPE_DRIFT')
        recipe = json.loads(raw)
        previous = {'sha': current, 'recipe': recipe}
        for name in plan['services']:
            ids = self.compose(self.c['recipe'], 'ps', '-q', name).decode().split()
            need(len(ids) == 1, 'SERVICE_INSTANCE_COUNT')
            container = json.loads(command(['docker', 'inspect', ids[0]]))[0]
            # Pin the actual running immutable image, not mutable tags in recipes.
            recipe['services'][name]['image'] = container['Image']
            recipe['services'][name].pop('build', None)
        return previous

    def area(self, plan):
        path = Path(self.c['stateDir']) / plan['sha']
        path.mkdir(mode=0o700, exist_ok=True)
        return path

    def build(self, plan):
        source = Path(self.c['mirror'])
        area = self.area(plan)
        archive = command(['git', '-C', str(source), 'archive', plan['sha']])
        # git archive output is our own committed tree. Reject links and path escapes.
        import tarfile
        import io
        tree = area / 'source'
        tree.mkdir(mode=0o700)
        with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
            need(all(m.isfile() or m.isdir() for m in bundle.getmembers()), 'SOURCE_LINK')
            bundle.extractall(tree, filter='data')
        recipe = json.loads(private_file(self.c['recipe']))
        for name in plan['services']:
            directory = self.c['services'][name]['context']
            tag = 'synapse-release-' + name + ':' + plan['sha']
            command(['docker', 'build', '--tag', tag, str(tree / directory)], timeout=240)
            image = json.loads(command(['docker', 'image', 'inspect', tag]))[0]['Id']
            recipe['services'][name]['image'] = image
            recipe['services'][name].pop('build', None)
        atomic(area / 'candidate.json', recipe)

    def stop(self, plan):
        self.compose(self.c['recipe'], 'stop', *plan['writers'])

    def backup(self, plan):
        hashes = {}
        for name in plan['writers']:
            for i, db in enumerate(self.c['services'][name].get('databases', [])):
                hashes[name + ':' + str(i)] = verified_backup(db, self.area(plan) / (name + '-' + str(i) + '.sqlite'))
        atomic(self.area(plan) / 'backups.json', hashes)

    def switch(self, plan):
        candidate = self.area(plan) / 'candidate.json'
        self.compose(candidate, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', *plan['services'])
        untouched = [n for n in plan['writers'] if n not in plan['services']]
        if untouched:
            self.compose(candidate, 'start', *untouched)

    def health(self):
        # No side-effecting API endpoints; operator-reviewed checks include old resources.
        need(bool(self.c['health']), 'HEALTH_CONFIGURATION_REQUIRED')
        for probe in self.c['health']:
            for attempt in range(15):
                try:
                    with urllib.request.urlopen(probe['url'], timeout=3) as r:
                        need(r.status == 200, 'HEALTH_STATUS')
                        raw = r.read(2 * 1024 * 1024)
                        if 'sha256' in probe:
                            need(hashlib.sha256(raw).hexdigest() == probe['sha256'], 'HEALTH_BYTES')
                    break
                except Exception:
                    if attempt < 14:
                        time.sleep(0.5)
            else:
                raise Blocked('HEALTH_FAILED') from None

    def commit(self, plan):
        atomic(self.c['recipe'], load(self.area(plan) / 'candidate.json'))

    def restore(self, previous, plan):
        rollback = self.area(plan) / 'rollback.json'
        atomic(rollback, previous['recipe'])
        self.compose(rollback, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', *plan['writers'])
        # Make restart recovery use the actual previous recipe, never a failed candidate.
        atomic(self.c['recipe'], previous['recipe'])


def make_plan(config, admission, changed):
    services = set()
    for path in changed:
        matches = [name for name, value in config['services'].items()
                   if path.startswith(value['context'].rstrip('/') + '/')]
        need(matches, 'UNSUPPORTED_PATH_REQUIRES_REVIEW')
        services.update(matches)
    need(services, 'NO_RUNTIME_CHANGES')
    # Explicit data-writer closure is root-owned, includes consumers of shared DBs.
    writers = set(services)
    for name in services:
        writers.update(config['services'][name].get('writers', []))
    need(writers <= config['services'].keys(), 'UNKNOWN_WRITER')
    return dict(admission, services=sorted(services), writers=sorted(writers))


def tick(config):
    from board import Board, Outbox
    engine = Engine(config['stateDir'], ComposeBackend(config))
    board = Board(config['boardUrlFile'])
    outbox = Outbox(Path(config['stateDir']) / 'outbox.json', board)
    with release_lock(config['lock']):
        engine.recover()
        state = engine.state()
        # Rebuild outbox from durable transaction journal after crash, before next PR.
        if state.get('phase') in ('verified', 'rolled_back') and state.get('plan'):
            outbox.enqueue(state['plan']['taskId'], state['plan']['sha'],
                           'connected' if state['phase'] == 'verified' else 'rolled_back')
        outbox.flush()
        need(state['phase'] in ('idle', 'verified'), 'QUEUE_HALTED')
        command(['git', '-C', config['mirror'], 'fetch', '--quiet', 'origin', 'main'])
        current = state['current']
        command(['git', '-C', config['mirror'], 'merge-base', '--is-ancestor', current, 'origin/main'])
        commits = command(['git', '-C', config['mirror'], 'rev-list', '--first-parent', '--reverse',
                           current + '..origin/main']).decode().split()
        if not commits:
            return
        sha = commits[0]
        need(bool(re.fullmatch('[a-f0-9]{40}', sha)), 'COMMIT_FORMAT')
        admission_path = Path(config['admissions']) / (sha + '.json')
        need(admission_path.exists(), 'WAITS_AUTHENTICATED_ADMISSION')
        admission = verify_admission(json.loads(private_file(admission_path)),
                                     private_file(config['admissionKey']), sha, current)
        GitHub(config['repository']).gate(sha, admission)
        board.acceptance(admission, config['repository'])
        changed = command(['git', '-C', config['mirror'], 'diff', '--name-only', '-z', current, sha]).decode().split('\0')
        plan = make_plan(config, admission, [p for p in changed if p])
        try:
            engine.deploy(plan)
        finally:
            state = engine.state()
            if state.get('phase') in ('verified', 'rolled_back'):
                outbox.enqueue(admission['taskId'], sha,
                               'connected' if state['phase'] == 'verified' else 'rolled_back')
                outbox.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        config = json.loads(private_file(args.config))
        tick(config)
        print('RELEASE_TICK_OK')
    except Exception as error:
        # Only fixed internal codes; neither exception text nor subprocess output.
        print('RELEASE_WAIT ' + (str(error) if isinstance(error, Blocked) else 'UNCONFIRMED'))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
