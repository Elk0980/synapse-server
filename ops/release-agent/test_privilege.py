"""Exercise the local broker socket from a real unprivileged uid on CI copy."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
import agent
import broker


@unittest.skipUnless(os.environ.get('RELEASE_DOCKER_TEST') == '1' and os.name == 'posix', 'root Linux CI copy only')
class PrivilegeBoundary(unittest.TestCase):
    def test_nonroot_can_call_typed_broker_but_cannot_read_key_or_run_shell(self):
        import pwd
        account = pwd.getpwnam('nobody')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            root.chmod(0o755)
            key_path = root / 'signing.key'
            key_path.write_bytes(b'synthetic-fixture-only')
            key_path.chmod(0o600)
            admissions = root / 'admissions'
            admissions.mkdir(mode=0o700)
            body = {'sha': 'a' * 40, 'parent': 'b' * 40, 'taskId': 55,
                    'reviewerRole': 'claude', 'codeAccepted': True, 'migration': 'forward-compatible',
                    'expires': 9999999999, 'reconciled': True, 'services': ['fixture'], 'writers': ['fixture']}
            agent.atomic(admissions / (body['sha'] + '.json'), {'body': body,
                'signature': hmac.new(key_path.read_bytes(), agent.canonical(body), hashlib.sha256).hexdigest()})
            config = {'services': {'fixture': {}}, 'admissions': str(admissions), 'admissionKey': str(key_path)}
            sock = socket.socket(socket.AF_UNIX)
            path = root / 'broker.sock'
            sock.bind(str(path))
            os.chown(path, 0, account.pw_gid)
            path.chmod(0o660)
            sock.listen()
            responses = []
            def serve():
                try:
                    for _ in range(2):
                        connection, _ = sock.accept()
                        with connection:
                            raw = b''
                            while chunk := connection.recv(65536): raw += chunk
                            try:
                                result = broker.dispatch(config, json.loads(raw))
                                response = {'ok': True, 'result': result}
                            except agent.Blocked as error:
                                response = {'ok': False, 'code': str(error)}
                            responses.append(response)
                            connection.sendall(agent.canonical(response))
                finally: sock.close()
            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            code = '''import json,os,socket,sys
assert os.geteuid()!=0
try: open(sys.argv[2],'rb'); raise AssertionError('key exposed')
except PermissionError: pass
for operation in ('verify','shell'):
 with socket.socket(socket.AF_UNIX) as client:
  client.connect(sys.argv[1]); client.sendall(json.dumps({'operation':operation,'sha':'a'*40,'parent':'b'*40}).encode()); client.shutdown(socket.SHUT_WR)
  data=b''
  while chunk:=client.recv(65536): data+=chunk
  response=json.loads(data)
  assert response['ok'] is (operation=='verify')
'''
            result = subprocess.run(['runuser', '-u', 'nobody', '--', 'python3', '-c', code, str(path), str(key_path)],
                                    capture_output=True, timeout=30)
            thread.join(timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertFalse(thread.is_alive())
            self.assertEqual(responses[-1]['code'], 'BROKER_OPERATION_DENIED')


if __name__ == '__main__': unittest.main()
