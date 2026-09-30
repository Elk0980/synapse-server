import shutil
import tempfile
import unittest
from pathlib import Path
import gate


class GateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.feature = 'specs/001-example'
        target = self.root / self.feature
        target.mkdir(parents=True)
        for name in ('spec.md', 'plan.md', 'tasks.md', 'evidence.md'):
            (target / name).write_text('Проверяемый документ с описанием требований и результата.' * 2, encoding='utf-8')

    def tearDown(self):
        self.tmp.cleanup()

    def test_missing_declaration(self):
        with self.assertRaises(ValueError):
            gate.check_pr(self.root, 'Готово')

    def test_full_spec_and_missing_evidence(self):
        self.assertEqual(gate.check_pr(self.root, 'Spec: ' + self.feature)['mode'], 'spec')
        (self.root / self.feature / 'evidence.md').unlink()
        with self.assertRaises(OSError):
            gate.check_pr(self.root, 'Spec: ' + self.feature)

    def test_traversal(self):
        for path in ('../secret', 'specs/../secret', '/tmp/secret', 'specs/001-x/../../secret'):
            with self.assertRaises(ValueError):
                gate.feature_files(self.root, path)

    def test_lite_needs_reason_and_single_mode(self):
        with self.assertRaises(ValueError):
            gate.check_pr(self.root, 'Spec-lite: TODO')
        with self.assertRaises(ValueError):
            gate.check_pr(self.root, 'Spec: ' + self.feature + '\nSpec-lite: Малое изменение текста без изменения поведения')
        self.assertTrue(gate.check_pr(self.root, 'Spec-lite: Исправлена опечатка в заголовке без изменения поведения')['reviewRequired'])

    def test_packet_reflects_changed_content(self):
        for folder in ('.specify', '.agents', '.claude', '.qwen'):
            shutil.copytree(gate.ROOT / folder, self.root / folder, ignore=shutil.ignore_patterns('__pycache__'))
        for name in (*gate.INPUTS, gate.POLICY):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(gate.ROOT / name, target)
        first = gate.packet(self.root, self.feature)
        self.assertEqual(first['deliveryStatus'], 'not_sent')
        path = self.root / self.feature / 'spec.md'
        path.write_text(path.read_text(encoding='utf-8') + '\nНовое требование.', encoding='utf-8')
        second = gate.packet(self.root, self.feature)
        self.assertNotEqual(first['files'][3]['sha256'], second['files'][3]['sha256'])
        skill = self.root / '.agents/skills/speckit-implement/SKILL.md'
        skill.write_text('повреждено', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Официальный файл изменён'):
            gate.check(self.root)


if __name__ == '__main__':
    unittest.main()
