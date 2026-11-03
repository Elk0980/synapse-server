"""Pinned one-command bootstrap, intended to run only AFTER Claude accepts bundle.

Fetches only source files from the exact immutable commit, never floating main.
No tokens are accepted on the command line or printed.
"""
import argparse
import importlib.util
from pathlib import Path
import re
import tempfile
import urllib.request
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--commit', required=True)
    parser.add_argument('--bundle', required=True)
    args = parser.parse_args()
    if not re.fullmatch('[a-f0-9]{40}', args.commit):
        raise SystemExit('IMMUTABLE_COMMIT_REQUIRED')
    names = ('agent.py', 'board.py', 'audit.py', 'broker.py', 'issuer.py', 'bootstrap.py', 'install.py',
             'synapse-release-agent.service', 'synapse-release-agent.timer',
             'synapse-release-broker.socket', 'synapse-release-broker@.service')
    with tempfile.TemporaryDirectory(prefix='synapse-release-install-') as temporary:
        directory = Path(temporary)
        for name in names:
            url = 'https://raw.githubusercontent.com/Elk0980/synapse-server/' + args.commit + '/ops/release-agent/' + name
            with urllib.request.urlopen(url, timeout=30) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise SystemExit('PACKAGE_LIMIT')
                (directory / name).write_bytes(raw)
        sys.path.insert(0, str(directory))
        import install
        from agent import command
        install.install(directory, '/')
        install.activate('/', args.bundle, command)
        print('INSTALLED_SERVICE_ENABLED')


if __name__ == '__main__': main()
