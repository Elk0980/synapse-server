"""Issue cached admissions from authenticated comment provenance, not author text."""
import hashlib
import hmac
from pathlib import Path
import re
import time
from agent import GitHub, atomic, canonical, command, load, make_plan, need, private_file
from board import Board


def trusted(comment, registry, config, kind):
    identity = comment.get('identity', {})
    agent = next((a for a in registry if a['id'] == identity.get('agentId')), None)
    # These fields MUST be stamped by a trusted server, never supplied as comment args.
    return bool(agent and identity.get('verified') is True and agent.get('kind') == kind and
                identity.get('credentialId') == config['reviewerCredentials'].get(str(agent['id'])))


def issue(config, sha, parent):
    need(re.fullmatch('[a-f0-9]{40}', sha) and re.fullmatch('[a-f0-9]{40}', parent), 'ADMISSION_COMMIT')
    board = Board(config['boardUrlFile'])
    api = GitHub(config['repository'])
    prs = api.get('/commits/' + sha + '/pulls')
    prs = [p for p in prs if p.get('merged_at') and p['merge_commit_sha'] == sha and p['base']['ref'] == 'main']
    need(len(prs) == 1, 'PR_MERGE_LINK')
    pr = prs[0]
    url = 'https://github.com/' + config['repository'] + '/pull/' + str(pr['number'])
    registry = board.call('agents_list', {})['agents']
    task = None
    for offset in range(0, 10000, 100):
        page = board.call('tasks_list', {'limit': 100, 'offset': offset})
        for summary in page['tasks']:
            candidate = board.task(summary['id'])
            if any(link.get('url') == url for link in candidate.get('coordination', {}).get('links', [])):
                task = candidate
                break
        if task or len(page['tasks']) < 100:
            break
    need(task, 'TASK_PR_LINK')
    accepted = [c for c in task['comments'] if 'КОД ПРИНЯТ' in c['text'] and
                pr['head']['sha'] in c['text'] and trusted(c, registry, config, 'claude')]
    need(accepted, 'WAITS_AUTHENTICATED_CLAUDE_COMMENT')
    changed = command(['git', '-C', config['mirror'], 'diff', '--name-only', '-z', parent, sha]).decode().split('\0')
    changed = [p for p in changed if p]
    has_migration = any(re.search(r'(^|/)(migrations?|schema)(/|\.|$)|ops/(crm|content|chat)/server\.js$', p) for p in changed)
    irreversible = any('НЕОБРАТИМАЯ МИГРАЦИЯ' in c['text'] for c in accepted)
    if irreversible:
        approvals = [c for c in task['comments'] if 'ОТВЕТ: да' in c['text'] and sha in c['text'] and
                     trusted(c, registry, config, 'owner')]
        if not approvals:
            board.call('task_update', {'task_id': task['id'], 'revision': task['coordination']['revision'],
                'blocker': 'ждёт Влада: необратимая миграция ' + sha})
        need(approvals, 'WAITS_OWNER_MIGRATION')
    body = {'sha': sha, 'parent': parent, 'pr': pr['number'], 'taskId': task['id'], 'headSha': pr['head']['sha'],
            'reviewerRole': 'claude', 'codeAccepted': True, 'acceptedCommentId': accepted[0]['id'],
            'expires': time.time() + 7 * 86400, 'migration': 'forward-compatible',
            'ownerMigrationApproved': irreversible, 'hasMigration': has_migration,
            'reconciled': load(config['baseline'])['reconciled'] is True,
            'recipeSha256': hashlib.sha256(private_file(config['recipe'])).hexdigest(),
            'requiredChecks': config['requiredChecks']}
    plan = make_plan(config, body, changed)
    if plan['outcome'] == 'runtime':
        runtime = load(config['runtimeShaFile'])['sha']
        cumulative = command(['git', '-C', config['mirror'], 'diff', '--name-only', '-z', runtime, sha]).decode().split('\0')
        plan = make_plan(config, body, [p for p in cumulative if p])
    body.update(services=plan['services'], writers=plan['writers'])
    # Do not cache a signature until CI and PR/task/head checks all pass.
    api.gate(sha, body)
    envelope = {'body': body, 'signature': hmac.new(private_file(config['admissionKey']), canonical(body), hashlib.sha256).hexdigest()}
    atomic(Path(config['admissions']) / (sha + '.json'), envelope)
    return body
