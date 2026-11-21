import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

from agent import Blocked, load
from audit import inventory
from install import install, FILES


class Package(unittest.TestCase):
    def test_install_on_copy_inactive_exact_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = install(Path(__file__).parent, root)
            self.assertEqual(len(manifest), len(FILES))
            receipt = load(root / 'var/lib/synapse-release-agent/installation.json')
            self.assertFalse(receipt['enabled'])
            self.assertFalse((root / 'etc/systemd/system/timers.target.wants').exists())
            with self.assertRaisesRegex(Blocked, 'ALREADY_INSTALLED'):
                install(Path(__file__).parent, root)

    def test_private_inventory_keeps_source_secrets_and_rename(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.run(['git', '-C', str(root), *args], capture_output=True, check=True)
            git('init', '-q')
            git('config', 'user.email', 'fixture@example.invalid')
            git('config', 'user.name', 'Fixture')
            (root / 'source.txt').write_text('old source')
            (root / 'rename.txt').write_text('unchanged')
            git('add', '.')
            git('commit', '-qm', 'fixture')
            (root / 'source.txt').write_text('managed source')
            git('mv', 'rename.txt', 'renamed.txt')
            (root / '.env').write_text('PRIVATE_FIXTURE_DO_NOT_PUBLISH=synthetic')
            result = inventory(root)
            self.assertEqual(result['total'], 3)
            self.assertFalse(result['approved'])
            env = next(r for r in result['entries'] if r['path'] == '.env')
            self.assertEqual(env['proposal'], 'private-layer-review')
            self.assertNotIn('synthetic', str(result))
            self.assertEqual((root / '.env').read_text(), 'PRIVATE_FIXTURE_DO_NOT_PUBLISH=synthetic')
            renamed = next(r for r in result['entries'] if r['path'] == 'renamed.txt')
            self.assertEqual(renamed['previousPath'], 'rename.txt')


if __name__ == '__main__': unittest.main()
