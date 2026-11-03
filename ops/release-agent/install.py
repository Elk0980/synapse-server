"""Stage the reviewed package only. Never starts a timer or changes production.

Activation requires a separately accepted baseline/config + admission issuer.
--root allows the identical installation to be verified on a disposable copy.
"""
import argparse
import hashlib
from pathlib import Path
import os
from agent import need, atomic

FILES = ('agent.py', 'board.py', 'audit.py', 'synapse-release-agent.service', 'synapse-release-agent.timer')


def install(source, root):
    source, root = Path(source).resolve(), Path(root).resolve()
    manifest = {}
    for name in FILES:
        raw = (source / name).read_bytes()
        relative = ('etc/systemd/system/' if name.endswith(('.service', '.timer'))
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
        target.chmod(0o600)
        need(hashlib.sha256(target.read_bytes()).hexdigest() == manifest[relative], 'INSTALL_READBACK')
    atomic(root / 'var/lib/synapse-release-agent/installation.json',
           {'files': manifest, 'enabled': False, 'productionChanged': False})
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default='/')
    args = parser.parse_args()
    os.umask(0o077)
    install(Path(__file__).parent, args.root)
    print('INSTALLED_INACTIVE_NO_SERVER_CHANGES')
