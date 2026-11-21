"""Stage the reviewed package only. Never starts a timer or changes production.

Activation requires a separately accepted baseline/config + admission issuer.
--root allows the identical installation to be verified on a disposable copy.
"""
import argparse
import hashlib
from pathlib import Path
import os
from agent import need, atomic

FILES = ('agent.py', 'board.py', 'audit.py', 'broker.py', 'issuer.py', 'bootstrap.py',
         'synapse-release-agent.service', 'synapse-release-agent.timer',
         'synapse-release-broker.socket', 'synapse-release-broker@.service')


def install(source, root):
    source, root = Path(source).resolve(), Path(root).resolve()
    manifest = {}
    for name in FILES:
        raw = (source / name).read_bytes()
        relative = ('etc/systemd/system/' if name.endswith(('.service', '.timer', '.socket'))
                    else 'opt/synapse-release-agent/') + name
        target = root / relative
        need(not any(p.is_symlink() for p in (target, *target.parents)), 'INSTALL_SYMLINK')
        need(not target.exists(), 'ALREADY_INSTALLED_REVIEW_UPGRADE')
        manifest[relative] = hashlib.sha256(raw).hexdigest()
    # Preflight all targets before writing. No production root, git or docker commands.
    for name in FILES:
        relative = next(p for p in manifest if p.endswith('/' + name))
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with target.open('xb') as out:
            out.write((source / name).read_bytes())
        target.chmod(0o644)
        target.parent.chmod(0o755)
        need(hashlib.sha256(target.read_bytes()).hexdigest() == manifest[relative], 'INSTALL_READBACK')
    atomic(root / 'var/lib/synapse-release-agent/installation.json',
           {'files': manifest, 'enabled': False, 'productionChanged': False})
    return manifest


def activate(root, bundle, run):
    """One accepted root command provisions only this worker and starts its timer.

    run is injected in copy tests. Real activation never infers reconciliation.
    """
    import json
    import re
    from agent import private_file
    root = Path(root).resolve()
    data = json.loads(private_file(bundle))
    need(data.get('acceptedByClaude') is True and data.get('reconciled') is True, 'ACCEPTED_BASELINE_REQUIRED')
    sha = data.get('initialSha', '')
    need(re.fullmatch('[a-f0-9]{40}', sha), 'BASELINE_SHA')
    worker, broker = data['worker'], data['broker']
    need(worker['stateDir'] == '/var/lib/synapse-release-agent' and
         broker['stateDir'] == '/var/lib/synapse-release-broker' and
         worker['brokerSocket'] == '/run/synapse-release/broker.sock', 'INSTALL_FIXED_PATHS')
    need('/opt/synapse-release-agent' not in worker['stateDir'], 'CODE_MUST_BE_READ_ONLY')
    need(broker['runtimeShaFile'] == '/var/lib/synapse-release-broker/runtime.json' and
         broker['admissions'] == '/var/lib/synapse-release-broker/admissions', 'BROKER_FIXED_PATHS')
    lock = root / 'opt/synapse/.palitra-app-release.lock'
    need(lock.exists() and not lock.is_symlink(), 'EXISTING_MANAGED_LOCK_REQUIRED')
    need(worker['mirror'] == broker['mirror'] == '/var/lib/synapse-release-agent/mirror', 'MIRROR_FIXED_PATH')
    need(broker['admissionKey'] == '/etc/synapse/release-agent/admission.key', 'ADMISSION_KEY_FIXED_PATH')
    # Copy the existing report credential; never rotate or print it.
    board_url = private_file(broker['boardUrlFile'])
    worker = dict(worker, boardUrlFile='/etc/synapse/release-agent/worker-board-url')
    # No docker group or sudoers entry. Root-only broker exposes typed fixed operations.
    run(['useradd', '--system', '--user-group', '--home-dir', '/var/lib/synapse-release-agent',
         '--shell', '/usr/sbin/nologin', 'synapse-release'])
    settings = root / 'etc/synapse/release-agent'
    settings.mkdir(mode=0o750, parents=True, exist_ok=True)
    atomic(settings / 'accepted-config.json', worker)
    atomic(settings / 'broker.json', broker)
    credential = settings / 'worker-board-url'
    credential.write_bytes(board_url)
    credential.chmod(0o640)
    import secrets
    key = settings / 'admission.key'
    need(not key.exists(), 'ADMISSION_KEY_ALREADY_EXISTS')
    key.write_bytes(secrets.token_bytes(32))
    key.chmod(0o600)
    for relative, mode in [('var/lib/synapse-release-agent', 0o700),
                           ('var/lib/synapse-release-broker', 0o700), ('run/synapse-release', 0o750)]:
        directory = root / relative
        directory.mkdir(mode=mode, parents=True, exist_ok=True)
        directory.chmod(mode)
    atomic(root / 'var/lib/synapse-release-agent/state.json', {'phase': 'idle', 'current': sha, 'cursor': sha})
    atomic(root / 'var/lib/synapse-release-broker/runtime.json', {'sha': sha})
    (root / 'var/lib/synapse-release-broker/admissions').mkdir(mode=0o700, exist_ok=True)
    # Retain old guard, checkout and lock inode. Only grant worker flock access.
    run(['chown', 'root:synapse-release', str(lock)])
    run(['chmod', '0660', str(lock)])
    run(['chown', '-R', 'synapse-release:synapse-release', str(root / 'var/lib/synapse-release-agent')])
    mirror = '/var/lib/synapse-release-agent/mirror'
    need(worker['mirror'] == broker['mirror'] == mirror, 'MIRROR_FIXED_PATH')
    for args in (['init', mirror], ['-C', mirror, 'remote', 'add', 'origin', 'https://github.com/' + worker['repository'] + '.git']):
        run(['runuser', '-u', 'synapse-release', '--', 'git', *args])
    run(['git', 'config', '--system', '--add', 'safe.directory', mirror])
    run(['chown', 'root:synapse-release', str(settings), str(settings / 'accepted-config.json'),
         str(credential), str(root / 'run/synapse-release')])
    (settings / 'accepted-config.json').chmod(0o640)
    tmpfiles = root / 'etc/tmpfiles.d/synapse-release.conf'
    tmpfiles.parent.mkdir(parents=True, exist_ok=True)
    tmpfiles.write_text('d /run/synapse-release 0750 root synapse-release -\n')
    # A snapshot is never deleted by the agent: retention is >=7 days, indefinitely by default.
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', '--now', 'synapse-release-broker.socket', 'synapse-release-agent.timer'])
    atomic(root / 'var/lib/synapse-release-agent/installation.json', {'enabled': True, 'sha': sha})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default='/')
    parser.add_argument('--bundle')
    args = parser.parse_args()
    os.umask(0o077)
    if Path(args.root).resolve() == Path('/').resolve():
        need(args.bundle and os.geteuid() == 0, 'ACCEPTED_BUNDLE_ROOT_REQUIRED')
    install(Path(__file__).parent, args.root)
    if args.bundle:
        from agent import command
        activate(args.root, args.bundle, command)
        print('INSTALLED_SERVICE_ENABLED')
    else:
        print('INSTALLED_COPY_INACTIVE')
