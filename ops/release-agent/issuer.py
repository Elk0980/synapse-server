"""Issue cached admissions from authenticated comment provenance, not author text."""
import hashlib
import hmac
from pathlib import Path
import re
import time
from agent import GitHub, atomic, canonical, command, exclude_applied_manual, load, make_plan, need, private_file
from board import Board


def trusted(comment, registry, config, kind):
    identity = comment.get('identity', {})
    agent = next((a for a in registry if a['id'] == identity.get('agentId')), None)
    # These fields MUST be stamped by a trusted server, never supplied as comment args.
    return bool(agent and identity.get('verified') is True and agent.get('kind') == kind and
                identity.get('credentialId') == config['reviewerCredentials'].get(str(agent['id'])))


def confirm_manual(config, plan):
    """Same authenticated comment path as acceptance; author text never grants this."""
    sha, parent = plan['sha'], plan['parent']
    need(re.fullmatch('[a-f0-9]{40}', sha) and re.fullmatch('[a-f0-9]{40}', parent), 'MANUAL_SHA')
    need(plan['taskId'] == config.get('taskId', 55), 'MANUAL_TASK')
    command(['git', '-C', config['mirror'], 'merge-base', '--is-ancestor', sha, 'origin/main'])
    first_parent = command(['git', '-C', config['mirror'], 'rev-parse', sha + '^1']).decode().strip()
    need(first_parent == parent, 'MANUAL_PARENT')
    changed = command(['git', '-C', config['mirror'], 'diff', '--name-only', '-z', parent, sha]).decode().split('\0')
    actual = make_plan(config, plan, [p for p in changed if p])
    need(actual['outcome'] == 'manual' and actual['manualPaths'] == plan['manualPaths'], 'MANUAL_PATHS')
    path = Path(config['stateDir']) / 'manual' / (sha + '.json')
    key = private_file(config['admissionKey'])
    if path.exists():
        saved = load(path)
        signature = hmac.new(key, canonical(saved['body']), hashlib.sha256).hexdigest()
        need(hmac.compare_digest(signature, saved['signature']), 'MANUAL_RECEIPT_SIGNATURE')
        need(all(saved['body'].get(k) == plan.get(k) for k in ('sha', 'parent', 'taskId', 'manualPaths')), 'MANUAL_RECEIPT_BINDING')
        return saved['body']
    board = Board(config['boardUrlFile'])
    task = board.task(plan['taskId'])
    registry = board.call('agents_list', {})['agents']
    exact = 'ПРИМЕНЕНО ВРУЧНУЮ ' + sha
    comments = [c for c in task['comments'] if c.get('text', '').strip() == exact and
                (trusted(c, registry, config, 'claude') or trusted(c, registry, config, 'owner'))]
    need(comments, 'WAITS_TRUSTED_MANUAL_CONFIRMATION')
    body = {k: plan[k] for k in ('sha', 'parent', 'taskId', 'manualPaths')}
    body.update(commentId=comments[0]['id'], recordedAt=time.time())
    atomic(path, {'body': body, 'signature': hmac.new(key, canonical(body), hashlib.sha256).hexdigest()})
    return body


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
    if plan['services']:
        runtime = load(config['runtimeShaFile'])['sha']
        cumulative = command(['git', '-C', config['mirror'], 'diff', '--name-only', '-z', runtime, sha]).decode().split('\0')
        receipts = [load(p)['body'] for p in (Path(config['stateDir']) / 'manual').glob('*.json')]
        cumulative = exclude_applied_manual(config, cumulative, sha, receipts)
        plan = make_plan(config, body, [p for p in cumulative if p])
    need(plan['outcome'] != 'manual', 'MANUAL_APPLICATION_REQUIRED')
    body.update(services=plan['services'], writers=plan['writers'])
    # Do not cache a signature until CI and PR/task/head checks all pass.
    api.gate(sha, body)
    envelope = {'body': body, 'signature': hmac.new(private_file(config['admissionKey']), canonical(body), hashlib.sha256).hexdigest()}
    atomic(Path(config['admissions']) / (sha + '.json'), envelope)
    return body
