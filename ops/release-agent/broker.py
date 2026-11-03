"""Local socket-activated privilege boundary; no Docker socket/group for worker.

Only typed release operations for the fixed service allowlist in root-owned config.
No caller-supplied commands, compose files, mounts, database paths or old recipes.
"""
import json
import os
from pathlib import Path
import socket
import sys
from agent import ComposeBackend, Blocked, atomic, canonical, load, need, private_file, verify_admission

OPERATIONS = {'capture', 'build', 'stop', 'backup', 'switch', 'health', 'commit', 'restore',
              'traffic_is_closed', 'return_traffic', 'restore_databases', 'admit', 'verify'}


class NativeBackend(ComposeBackend):
    def commit(self, plan):
        super().commit(plan)
        atomic(self.c['runtimeShaFile'], {'sha': plan['sha']})

    def restore(self, previous, plan):
        super().restore(previous, plan)
        atomic(self.c['runtimeShaFile'], {'sha': previous['sha']})

    def gate(self, operation, plan):
        from agent import command
        gate = self.c.get('trafficGate')
        need(gate and operation in ('close', 'open'), 'TRAFFIC_GATE_NOT_CONFIGURED')
        executable = Path(gate['executable'])
        private_file(executable)  # root-owned immutable executable, never worker input
        need(executable.stat().st_uid == 0 and not executable.stat().st_mode & 0o022, 'GATE_OWNERSHIP')
        command([str(executable), operation, *plan['writers']])


def validate_plan(config, plan, historical=False):
    import re
    need(isinstance(plan, dict) and re.fullmatch('[a-f0-9]{40}', plan.get('sha', '')), 'BROKER_SHA')
    need(set(plan.get('services', [])) <= set(config['services']) and
         set(plan.get('writers', [])) <= set(config['services']), 'BROKER_SERVICE_DENIED')
    envelope = load(Path(config['admissions']) / (plan['sha'] + '.json'))
    body = verify_admission(envelope, private_file(config['admissionKey']), plan['sha'], plan['parent'],
                            now=0 if historical else None)
    for key in ('sha', 'parent', 'pr', 'taskId', 'headSha', 'hasMigration', 'recipeSha256'):
        need(plan.get(key) == body.get(key), 'BROKER_PLAN_BINDING')
    # The signed receipt also binds the allowed service closure.
    for key in ('services', 'writers'):
        need(plan.get(key) == body.get(key), 'BROKER_SERVICE_BINDING')
    return body


def dispatch(config, request):
    operation = request.get('operation')
    need(operation in OPERATIONS, 'BROKER_OPERATION_DENIED')
    if operation == 'admit':
        from issuer import issue
        return issue(config, request['sha'], request['parent'])
    if operation == 'verify':
        envelope = load(Path(config['admissions']) / (request['sha'] + '.json'))
        return verify_admission(envelope, private_file(config['admissionKey']), request['sha'], request['parent'])
    plan = request['plan']
    import re
    need(re.fullmatch('[a-f0-9]{40}', plan.get('sha', '')), 'BROKER_SHA')
    backend = NativeBackend(config)
    receipt = Path(config['stateDir']) / plan['sha'] / 'previous.json'
    historical = operation in ('stop', 'restore', 'health', 'return_traffic', 'restore_databases') and receipt.exists()
    validate_plan(config, plan, historical=historical)
    if operation == 'capture':
        # Immutable previous receipt is reused on recovery, never overwritten.
        if not receipt.exists():
            current = load(config['runtimeShaFile'])['sha']
            need(request['current'] == current, 'RUNTIME_SHA_DRIFT')
            previous = backend.capture(current, plan)
            atomic(receipt, previous)
        return {'sha': load(receipt)['sha'], 'receipt': plan['sha']}
    if operation == 'restore':
        backend.restore(load(receipt), plan)
    elif operation == 'traffic_is_closed':
        closed = backend.traffic_is_closed(plan)
        if closed:
            atomic(backend.area(plan) / 'traffic.json', {'closed': True})
        return closed
    elif operation == 'return_traffic':
        atomic(backend.area(plan) / 'traffic.json', {'closed': False})
        backend.return_traffic(plan)
    elif operation == 'restore_databases':
        need(load(backend.area(plan) / 'traffic.json')['closed'] is True, 'DATABASE_RESTORE_TRAFFIC_OPEN')
        for name in plan['writers']:
            ids = backend.compose(config['recipe'], 'ps', '--status', 'running', '-q', name).decode().split()
            need(not ids, 'DATABASE_WRITER_RUNNING')
        backend.restore_databases(plan)
    elif operation == 'health':
        backend.health()
    else:
        return getattr(backend, operation)(plan)
    return None


class BrokerBackend:
    def __init__(self, config):
        self.c = config
        self.plan = None

    def invoke(self, operation, **args):
        need(operation in OPERATIONS, 'BROKER_OPERATION_DENIED')
        raw = canonical(dict(operation=operation, **args))
        need(len(raw) < 1024 * 1024, 'BROKER_REQUEST_LIMIT')
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(300)
            client.connect(self.c['brokerSocket'])
            client.sendall(raw)
            client.shutdown(socket.SHUT_WR)
            chunks, size = [], 0
            while data := client.recv(65536):
                size += len(data)
                need(size < 1024 * 1024, 'BROKER_RESPONSE_LIMIT')
                chunks.append(data)
        response = json.loads(b''.join(chunks))
        need(response.get('ok'), response.get('code', 'BROKER_FAILED'))
        return response.get('result')

    def capture(self, current, plan):
        self.plan = plan
        return self.invoke('capture', current=current, plan=plan)

    def health(self): return self.invoke('health', plan=self.plan)
    def restore(self, previous, plan):
        self.plan = plan
        return self.invoke('restore', plan=plan)

    def __getattr__(self, operation):
        if operation not in OPERATIONS:
            raise AttributeError(operation)
        def run(plan):
            self.plan = plan
            return self.invoke(operation, plan=plan)
        return run


def main():
    os.umask(0o077)
    try:
        config = json.loads(private_file('/etc/synapse/release-agent/broker.json'))
        need(os.geteuid() == 0, 'BROKER_ROOT_ONLY')
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        need(len(raw) <= 1024 * 1024, 'BROKER_REQUEST_LIMIT')
        result = dispatch(config, json.loads(raw))
        sys.stdout.buffer.write(canonical({'ok': True, 'result': result}))
    except Exception as error:
        code = str(error) if isinstance(error, Blocked) else 'BROKER_UNCONFIRMED'
        sys.stdout.buffer.write(canonical({'ok': False, 'code': code}))


if __name__ == '__main__': main()
