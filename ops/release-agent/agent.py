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
import sys
import tempfile
import time
import urllib.request

# Keep board.py on the same exception/types when invoked as a systemd script.
if __name__ == '__main__':
    sys.modules['agent'] = sys.modules[__name__]


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
        need(st.st_uid in (0, os.geteuid()) and st.st_mode & 0o037 == 0, 'PRIVATE_FILE_PERMISSIONS')
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

    def checks(self, sha):
        checks = []
        for page in range(1, 21):
            data = self.get('/commits/' + sha + '/check-runs?per_page=100&page=' + str(page))
            checks.extend(data['check_runs'])
            if len(checks) >= data['total_count']:
                break
        else:
            raise Blocked('CHECKS_PAGE_LIMIT')
        # Reruns supersede old attempts with the same app/name.
        latest = {}
        for check in checks:
            identity = (check.get('app', {}).get('id'), check['name'])
            if check.get('id', 0) >= latest.get(identity, {}).get('id', -1):
                latest[identity] = check
        return list(latest.values())

    def gate(self, sha, admission):
        prs = self.get('/commits/' + sha + '/pulls')
        matches = [p for p in prs if p['number'] == admission['pr'] and p.get('merged_at') and
                   p['merge_commit_sha'] == sha and p['base']['ref'] == 'main']
        need(len(matches) == 1, 'PR_MERGE_LINK')
        head = matches[0]['head']['sha']
        need(head == admission.get('headSha'), 'ACCEPTED_PR_HEAD_CHANGED')
        checks = self.checks(head)
        required = set(admission.get('requiredChecks', []))
        need(required and required <= {c['name'] for c in checks}, 'REQUIRED_CHECKS_MISSING')
        need(checks and all(c['head_sha'] == head and c['status'] == 'completed' and
                            c['conclusion'] in ('success', 'neutral', 'skipped') for c in checks), 'PR_CI_NOT_GREEN')
        need(all(c['conclusion'] == 'success' for c in checks if c['name'] in required), 'REQUIRED_CHECK_FAILED')
        merge = self.checks(sha)
        spec = [c for c in merge if c['name'] == 'process-check' and c['head_sha'] == sha]
        need(spec and all(c['status'] == 'completed' and c['conclusion'] == 'success' for c in spec), 'MERGE_SPEC_KIT_NOT_GREEN')
        status = self.get('/commits/' + head + '/status')
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
        elif state.get('phase') == 'prepared':
            self.advance(state['plan'], 'skipped', 'INTERRUPTED_BUILD')
        elif state.get('phase') == 'rollback_failed':
            raise Blocked('ROLLBACK_NEEDS_REVIEW')

    def rollback(self, state=None, recovery=False):
        if state is None:
            state = self.state()
            need(state.get('phase') == 'verified', 'ROLLBACK_NOT_CURRENT_VERIFIED')
        need(state.get('previous') and state.get('plan'), 'NO_PREVIOUS_RELEASE')
        state['phase'] = 'rolling_back'
        self.save(state)
        try:
            self.backend.stop(state['plan'])
            state['restoreDatabase'] = bool(state['plan'].get('hasMigration') and state.get('backupComplete') and
                                            state.get('migrationAttempted') and not state.get('trafficReturned', True))
            if state['restoreDatabase']:
                self.backend.restore_databases(state['plan'])
            self.backend.restore(state['previous'], state['plan'])
            self.backend.health()
            if hasattr(self.backend, 'return_traffic'):
                self.backend.return_traffic(state['plan'])
        except Exception:
            state['phase'] = 'rollback_failed'
            self.save(state)
            raise Blocked('ROLLBACK_NEEDS_REVIEW') from None
        state['phase'] = 'rolled_back'
        state['failedSha'] = state['plan']['sha']
        state['current'] = state['previous']['sha']
        state['cursor'] = state['plan']['sha']
        state['recovered'] = recovery
        # Never restore an old SQLite over new requests. Images must accept forward data.
        state['dataPolicy'] = 'restore-pretraffic-snapshot' if state.get('restoreDatabase') else 'preserve-forward-data'
        state['needsDatabaseDecision'] = bool(state.get('trafficReturned') and state['plan'].get('hasMigration'))
        self.record(state)
        self.save(state)

    def deploy(self, plan):
        state = self.state()
        need(state['phase'] in ('idle', 'verified', 'rolled_back', 'build_failed', 'skipped', 'no_release', 'site_deferred'), 'QUEUE_HALTED')
        need(plan['parent'] == state.get('cursor', state['current']), 'OUT_OF_ORDER')
        previous = self.backend.capture(state['current'], plan)
        state.update(plan=plan, previous=previous, phase='prepared', trafficReturned=False,
                     backupComplete=False, migrationAttempted=False, needsDatabaseDecision=False)
        self.save(state)
        try:
            self.backend.build(plan)
        except Exception:
            self.advance(plan, 'build_failed', 'BUILD_FAILED_NO_SWITCH')
            raise Blocked('BUILD_FAILED_NO_SWITCH') from None
        try:
            state['phase'] = 'stopping'
            self.save(state)
            self.backend.stop(plan)
            state['phase'] = 'backing_up'
            self.save(state)
            self.backend.backup(plan)
            state['backupComplete'] = True
            state['phase'] = 'switching'
            self.save(state)
            # Without a real closed-traffic barrier, be conservative before up:
            # even crash during startup may have accepted customer writes.
            closed = self.backend.traffic_is_closed(plan) if hasattr(self.backend, 'traffic_is_closed') else False
            state['trafficReturned'] = not closed
            state['migrationAttempted'] = bool(plan.get('hasMigration'))
            self.save(state)
            self.backend.switch(plan)
            state['phase'] = 'checking'
            self.save(state)
            self.backend.health()
            # Journal BEFORE opening the gate: an unknown open result preserves data.
            state['trafficReturned'] = True
            self.save(state)
            if closed:
                self.backend.return_traffic(plan)
        except Exception:
            self.rollback(state)
            raise Blocked('RELEASE_ROLLED_BACK') from None
        state.update(phase='verified', current=plan['sha'], cursor=plan['sha'], verifiedAt=time.time(), reported=False)
        self.backend.commit(plan)
        self.save(state)
        atomic(self.directory / 'last-verified.json', state)
        self.record(state)

    def record(self, state):
        plan = state.get('plan', {})
        if plan.get('sha'):
            atomic(self.directory / 'history' / (plan['sha'] + '-' + state['phase'] + '.json'), state)

    def advance(self, plan, outcome, reason=''):
        state = self.state()
        need(plan['parent'] == state.get('cursor', state['current']), 'OUT_OF_ORDER')
        state.update(phase=outcome, cursor=plan['sha'], plan=plan, reason=reason)
        self.save(state)
        self.record(state)


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
        for name in plan['writers']:
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
        build_recipe = json.loads(private_file(self.c.get('buildRecipe', self.c['recipe'])))
        for name in plan['services']:
            spec = build_recipe['services'][name].get('build', self.c['services'][name].get('build',
                                                    {'context': self.c['services'][name]['context']}))
            spec = {'context': spec} if isinstance(spec, str) else dict(spec)
            original = Path(spec['context'])
            if original.is_absolute():
                need(original.is_relative_to(Path(self.c['checkout'])), 'BUILD_CONTEXT_ESCAPE')
                original = original.relative_to(Path(self.c['checkout']))
            context = (tree / original).resolve()
            need(context.is_relative_to(tree.resolve()), 'BUILD_CONTEXT_ESCAPE')
            spec['context'] = str(context)
            dockerfile = spec.get('dockerfile', 'Dockerfile')
            if Path(dockerfile).is_absolute():
                need(Path(dockerfile).is_relative_to(Path(self.c['checkout'])), 'DOCKERFILE_ESCAPE')
                dockerfile = str(tree / Path(dockerfile).relative_to(Path(self.c['checkout'])))
                spec['dockerfile'] = dockerfile
            need((context / dockerfile).resolve().is_relative_to(tree.resolve()), 'DOCKERFILE_ESCAPE')
            build_recipe['services'][name]['build'] = spec
            build_recipe['services'][name]['image'] = 'synapse-release-' + name + ':' + plan['sha']
        build_path = area / 'build.json'
        atomic(build_path, build_recipe)
        self.compose(build_path, 'build', *plan['services'])
        for name in plan['services']:
            tag = build_recipe['services'][name]['image']
            image = json.loads(command(['docker', 'image', 'inspect', tag]))[0]['Id']
            recipe['services'][name]['image'] = image
            recipe['services'][name].pop('build', None)
        atomic(area / 'candidate.json', recipe)

    def traffic_is_closed(self, plan):
        # No pretend barrier: only an actual configured broker gate can establish this.
        if not self.c.get('trafficGate'):
            return False
        self.gate('close', plan)
        return True

    def gate(self, operation, plan):
        raise Blocked('TRAFFIC_GATE_REQUIRES_BROKER')

    def return_traffic(self, plan):
        if self.c.get('trafficGate'):
            self.gate('open', plan)

    def restore_databases(self, plan):
        manifest = load(self.area(plan) / 'backups.json')
        for name in plan['writers']:
            for i, db in enumerate(self.c['services'][name].get('databases', [])):
                snapshot = self.area(plan) / (name + '-' + str(i) + '.sqlite')
                need(hashlib.sha256(snapshot.read_bytes()).hexdigest() == manifest[name + ':' + str(i)], 'SNAPSHOT_HASH')
                # Writers and ingress MUST still be closed. Keep failed DB, WAL and SHM.
                target = Path(db)
                for suffix in ('', '-wal', '-shm'):
                    old = Path(str(target) + suffix)
                    if old.exists():
                        saved = self.area(plan) / (name + '-' + str(i) + '-failed' + suffix)
                        need(not saved.exists(), 'RESTORE_ALREADY_ATTEMPTED')
                        shutil.copy2(old, saved)
                replacement = target.with_name(target.name + '.release-restore')
                need(not replacement.exists(), 'RESTORE_UNKNOWN')
                shutil.copy2(snapshot, replacement)
                with open(replacement, 'rb') as stream:
                    os.fsync(stream.fileno())
                for suffix in ('-wal', '-shm'):
                    old = Path(str(target) + suffix)
                    if old.exists():
                        old.rename(self.area(plan) / (name + '-' + str(i) + '-retained' + suffix))
                os.replace(replacement, target)

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
    services, deferred = set(), []
    for path in changed:
        matches = [name for name, value in config['services'].items()
                   if path.startswith(value['context'].rstrip('/') + '/')]
        services.update(matches)
        if path.startswith('sites/'):
            deferred.append(path)
    writers = set(services)
    for name in services:
        writers.update(config['services'][name].get('writers', []))
    need(writers <= config['services'].keys(), 'UNKNOWN_WRITER')
    return dict(admission, services=sorted(services), writers=sorted(writers),
                deferredSites=deferred, outcome='runtime' if services else 'site_deferred' if deferred else 'no_release')


def report_terminal(state, outbox, expected_sha=None, flush=True):
    plan = state.get('plan', {})
    if (state.get('phase') in ('verified', 'rolled_back', 'build_failed', 'skipped', 'no_release', 'site_deferred') and plan and
            (expected_sha is None or plan.get('sha') == expected_sha)):
        outbox.enqueue(plan['taskId'], plan['sha'],
                       'connected' if state['phase'] == 'verified' else state['phase'])
        if state.get('needsDatabaseDecision'):
            outbox.enqueue(plan['taskId'], plan['sha'], 'database_decision')
    if flush:
        outbox.flush()


def tick(config):
    from board import Board, Outbox
    from broker import BrokerBackend
    backend = BrokerBackend(config) if config.get('brokerSocket') else ComposeBackend(config)
    engine = Engine(config['stateDir'], backend)
    board = Board(config['boardUrlFile'])
    outbox = Outbox(Path(config['stateDir']) / 'outbox.json', board)
    with release_lock(config['lock']):
        engine.recover()
        state = engine.state()
        # Rebuild outbox from durable transaction journal after crash, before next PR.
        for receipt in sorted((Path(config['stateDir']) / 'history').glob('*.json')):
            report_terminal(load(receipt), outbox, flush=False)
        report_terminal(state, outbox, flush=False)
        outbox.flush()
        need(state['phase'] in ('idle', 'verified', 'rolled_back', 'build_failed', 'skipped', 'no_release', 'site_deferred'), 'QUEUE_HALTED')
        command(['git', '-C', config['mirror'], 'fetch', '--quiet', 'origin', 'main'])
        current = state.get('cursor', state['current'])
        command(['git', '-C', config['mirror'], 'merge-base', '--is-ancestor', current, 'origin/main'])
        commits = command(['git', '-C', config['mirror'], 'rev-list', '--first-parent', '--reverse',
                           current + '..origin/main']).decode().split()
        if not commits:
            return
        sha = commits[0]
        need(bool(re.fullmatch('[a-f0-9]{40}', sha)), 'COMMIT_FORMAT')
        changed = command(['git', '-C', config['mirror'], 'diff', '--name-only', '-z', current, sha]).decode().split('\0')
        classification = make_plan(config, {'sha': sha, 'parent': current, 'taskId': config.get('taskId', 55)}, [p for p in changed if p])
        if classification['outcome'] != 'runtime':
            engine.advance(classification, classification['outcome'])
            report_terminal(engine.state(), outbox, expected_sha=sha)
            return
        admission_path = Path(config['admissions']) / (sha + '.json')
        if config.get('brokerSocket'):
            try:
                admission = backend.invoke('verify', sha=sha, parent=current)
            except Exception:
                admission = backend.invoke('admit', sha=sha, parent=current)
        else:
            if not admission_path.exists():
                from issuer import issue
                issue(config, sha, current)
            admission = verify_admission(json.loads(private_file(admission_path)),
                                         private_file(config['admissionKey']), sha, current)
        GitHub(config['repository']).gate(sha, admission)
        # A valid signed admission is cached proof; reporting/board outages do not veto it.
        plan = make_plan(config, admission, [p for p in changed if p])
        if plan['outcome'] == 'runtime':
            cumulative = command(['git', '-C', config['mirror'], 'diff', '--name-only', '-z', state['current'], sha]).decode().split('\0')
            plan = make_plan(config, admission, [p for p in cumulative if p])
        try:
            if plan['outcome'] == 'runtime':
                engine.deploy(plan)
            else:
                engine.advance(plan, plan['outcome'])
        finally:
            state = engine.state()
            report_terminal(state, outbox, expected_sha=sha)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--rollback', action='store_true')
    parser.add_argument('--expected-sha')
    parser.add_argument('--request-id')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        config = json.loads(private_file(args.config))
        if args.rollback:
            rollback_command(config, args.expected_sha, args.request_id)
        else:
            tick(config)
        print('RELEASE_TICK_OK')
    except Exception as error:
        # Only fixed internal codes; neither exception text nor subprocess output.
        print('RELEASE_WAIT ' + (str(error) if isinstance(error, Blocked) else 'UNCONFIRMED'))
        return 1
    return 0


def rollback_command(config, expected_sha, request_id):
    from broker import BrokerBackend
    need(expected_sha and re.fullmatch('[a-f0-9]{40}', expected_sha), 'ROLLBACK_EXPECTED_SHA')
    need(request_id and re.fullmatch('[A-Za-z0-9_-]{1,100}', request_id), 'ROLLBACK_REQUEST_ID')
    backend = BrokerBackend(config) if config.get('brokerSocket') else ComposeBackend(config)
    engine = Engine(config['stateDir'], backend)
    with release_lock(config['lock']):
        done = Path(config['stateDir']) / 'commands' / (request_id + '.json')
        if done.exists():
            need(load(done)['sha'] == expected_sha, 'ROLLBACK_REQUEST_REUSED')
            need(load(done)['state'] == 'done', 'ROLLBACK_RESULT_UNCONFIRMED')
            return
        current = engine.state()
        need(current['current'] == expected_sha, 'ROLLBACK_STALE_SHA')
        last = load(Path(config['stateDir']) / 'last-verified.json')
        need(last['current'] == expected_sha, 'ROLLBACK_NOT_LAST_RELEASE')
        atomic(done, {'sha': expected_sha, 'state': 'unknown'})
        last['cursor'] = current.get('cursor', current['current'])
        last['trafficReturned'] = True  # manual rollback always preserves new data
        cursor = last['cursor']
        engine.rollback(last)
        state = engine.state()
        state['cursor'] = cursor
        engine.save(state)
        atomic(done, {'sha': expected_sha, 'state': 'done'})


if __name__ == '__main__':
    raise SystemExit(main())
