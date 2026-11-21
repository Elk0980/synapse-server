import importlib.util
import io
import json
import sys
from contextlib import redirect_stderr
from pathlib import Path
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('forced_command', Path(__file__).with_name('forced_command.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class AllowlistTest(unittest.TestCase):
    def test_allowed_existing_release_commands(self):
        for command in [
            'status', 'docker ps', 'df -h /',
            'journalctl -u synapse-sync.service -n 300 --no-pager -o cat --utc',
            './prpatch.sh 640 ' + 'a'*40 + ' ' + 'b'*40 + ' sites/synapse/cabinet/materials.js sites/synapse/cabinet/materials.css',
            'prpatch.sh 286 ' + 'a'*40 + ' ' + 'b'*40 + ' ops/crm/reel-materials-http.js ops/content/server.js',
            './prgo.sh 637', '/root/claude-rel/prgo.sh 286 crm content',
            'rel.sh snap pr286-before-build sites/synapse/cabinet.html',
            'rel.sh snap pr286-before-build',
            'rel.sh dbsnap /root/claude-rel/bk/20261121T081604Z-pr286 crm_data:crm.sqlite content_data:content.sqlite',
            './w286/rollback.sh', '/root/claude-rel/w286/rollback.sh',
        ]:
            with self.subTest(command=command):
                self.assertIn(m.plan(command)[0], ('status', 'read', 'release'))

    def test_arbitrary_shell_and_escape_attempts_are_denied(self):
        for command in [
            '', 'id', 'ls /root', 'bash', 'sh -c id', 'sftp', 'scp -t /root',
            'status; id', 'status && id', 'status\nid', 'status\x00', '$(id)',
            'docker exec crm id', 'docker ps -a', 'df /root',
            'journalctl -u ssh.service -n 5 --no-pager -o cat --utc',
            'journalctl -u synapse-sync.service -n 9999 --no-pager -o cat --utc',
            'rel.sh restore /root', 'rel.sh dbsnap /tmp/bak crm_data:crm.sqlite',
            'rel.sh dbsnap /root/claude-rel/bk/20261121T081604Z-pr286 other:secret',
            'rel.sh snap pr1 /etc/shadow', 'rel.sh snap pr1 sites/synapse/../../root/key',
            'prgo.sh 286 mcp', 'prgo.sh 286 crm crm', 'prgo.sh 286 --help',
            'prpatch.sh 286 main head ops/crm/server.js',
            'prpatch.sh 286 ' + 'a'*40 + ' ' + 'b'*40 + ' ops/crm/../secret.js',
            'prpatch.sh 286 ' + 'a'*40 + ' ' + 'b'*40 + ' sites/alvi/index.html',
            'prpatch.sh 286 ' + 'a'*40 + ' ' + 'b'*40 + ' ops/crm/.env',
            'prpatch.sh 286 ' + 'a'*40 + ' ' + 'b'*40 + ' ops/crm/server.test.js',
            'w286/../rollback.sh', 'w0/rollback.sh', 'w286/rollback.sh id',
            '--authorize-public-key AAAA',
        ]:
            with self.subTest(command=command):
                with self.assertRaises(m.Denied):
                    m.plan(command)

    def test_argv_is_fixed_and_not_a_shell(self):
        kind, argv = m.plan('./prgo.sh 286 crm')
        self.assertEqual(kind, 'release')
        self.assertEqual(argv, ['/bin/bash', '/root/claude-rel/prgo.sh', '286', 'crm'])
        self.assertNotIn('SSH_ORIGINAL_COMMAND', m.ENV)


class AuditTest(unittest.TestCase):
    def setUp(self):
        self.log = mock.Mock(LOG_PID=1, LOG_AUTHPRIV=80, LOG_INFO=6)
        self.modules = mock.patch.dict(sys.modules, {'syslog': self.log})
        self.modules.start()
        self.addCleanup(self.modules.stop)

    def records(self):
        return [json.loads(call.args[1]) for call in self.log.syslog.call_args_list]

    def test_allowed_read_logs_only_canonical_arguments(self):
        with mock.patch.object(m, 'trusted'), mock.patch.object(m.subprocess, 'run', return_value=mock.Mock(returncode=0)):
            self.assertEqual(m.run('docker "ps"'), 0)
        self.assertEqual(self.records(), [{'event':'accepted', 'kind':'read', 'argv':[
            '/usr/bin/docker', 'ps', '--format', '{{.ID}} {{.Names}} {{.Image}} {{.Status}}']}])
        self.log.openlog.assert_called_with('synapse-release-key', 1, 80)

    def test_denial_never_logs_original_input(self):
        with mock.patch.object(sys, 'argv', ['wrapper']), mock.patch.dict(m.os.environ, {'SSH_ORIGINAL_COMMAND':'id DO_NOT_LOG_THIS_INPUT'}, clear=True), redirect_stderr(io.StringIO()):
            self.assertEqual(m.main(), 126)
        self.assertEqual(self.records(), [{'event':'denied'}])

    def test_status_logs_request_and_all_fixed_reads(self):
        with mock.patch.object(m, 'trusted'), mock.patch.object(m.subprocess, 'run', return_value=mock.Mock(returncode=0)):
            self.assertEqual(m.run('status'), 0)
        self.assertEqual([r['kind'] for r in self.records()], ['status','read','read','read'])
        self.assertEqual(self.records()[0]['argv'], [])


if __name__ == '__main__':
    unittest.main()
