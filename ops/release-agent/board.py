"""Outgoing board transport and durable reporting; no inbound listener.

The URL file contains an EXISTING credential and is never printed. A request
with an unknown result is reconciled by reads, not blindly sent again.
"""
import json
from pathlib import Path
import urllib.request
from datetime import datetime, timezone
from agent import Blocked, atomic, canonical, load, need, private_file


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Blocked('BOARD_REDIRECT_DENIED')


class Board:
    def __init__(self, url_file):
        self.url = private_file(url_file).decode().strip()
        need(self.url.startswith('https://') and '\n' not in self.url, 'BOARD_HTTPS_REQUIRED')

    def call(self, name, args):
        request = urllib.request.Request(self.url, method='POST',
            headers={'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'},
            data=canonical({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                            'params': {'name': name, 'arguments': args}}))
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=5) as response:
                raw = response.read(4 * 1024 * 1024 + 1)
                need(len(raw) <= 4 * 1024 * 1024, 'BOARD_RESPONSE_LIMIT')
                result = json.loads(raw)['result']
                need(not result.get('isError'), 'BOARD_TOOL_ERROR')
                if 'structuredContent' in result:
                    return result['structuredContent']
                return json.loads(result['content'][0]['text'])
        except Exception:
            raise Blocked('BOARD_RESULT_UNCONFIRMED') from None

    def task(self, task_id):
        task = self.call('task_get', {'task_id': task_id, 'comments_limit': 20})
        comments = list(task['comments'])
        total = task['comments_pagination']['total']
        for offset in range(20, total, 20):
            need(offset < 10000, 'COMMENTS_PAGE_LIMIT')
            page = self.call('task_get', {'task_id': task_id, 'comments_limit': 20, 'comments_offset': offset})
            comments.extend(page['comments'])
        task['comments'] = comments
        return task

    def acceptance(self, admission, repository):
        task = self.task(admission['taskId'])
        url = 'https://github.com/' + repository + '/pull/' + str(admission['pr'])
        links = task.get('coordination', {}).get('links', [])
        need(any(link.get('url') == url for link in links), 'TASK_PR_LINK')
        # Identity is established by the signed receipt, not the author's string.
        need(any(c['id'] == admission.get('acceptedCommentId') and
                 'КОД ПРИНЯТ' in c['text'] for c in task['comments']), 'ACCEPTANCE_COMMENT_MISSING')


class Outbox:
    def __init__(self, path, board):
        self.path, self.board = Path(path), board

    def events(self):
        if not self.path.exists():
            return []
        saved = load(self.path)
        return saved if isinstance(saved, list) else [saved]

    def enqueue(self, task_id, sha, kind):
        events = self.events()
        marker = f'release:{sha}:{kind}'
        if any(e['marker'] == marker for e in events):
            return
        events.append({'taskId': task_id, 'sha': sha, 'kind': kind, 'marker': marker,
                       'phase': 'ready', 'attempts': 0, 'nextAttempt': 0,
                       'at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')})
        atomic(self.path, events)

    def flush(self):
        import time
        events = self.events()
        attempted = 0
        for event in events:
            if event['phase'] == 'done' or event.get('nextAttempt', 0) > time.time():
                continue
            if attempted >= 2:
                break
            attempted += 1
            try:
                task = self.board.task(event['taskId'])
                # Every report is a CAS task update; retries cannot duplicate comments.
                coordination = task['coordination']
                evidence = coordination['milestones']['connected'].get('evidence', '')
                seen = (event['marker'] in evidence or event['marker'] in coordination.get('nextAction', '') or
                        any(event['marker'] in c['text'] for c in task['comments']))
                if not seen:
                    event['phase'] = 'unknown'
                    atomic(self.path, events)
                    args = {'task_id': event['taskId'], 'revision': coordination['revision']}
                    if event['kind'] == 'connected':
                        args.update(stage='connected', evidence=event['marker'] + ' health PASS; commit=' + event['sha'], checked_at=event['at'])
                    else:
                        messages = {'rolled_back': 'Пропущен (откат), данные сохранены',
                                    'build_failed': 'Пропущен: сборка не прошла', 'skipped': 'Пропущен после прерывания сборки',
                                    'no_release': 'Выпуск не требуется', 'site_deferred': 'Выпуск сайта отдельным шагом №57',
                                    'database_decision': 'ждёт Влада: восстановить БД из сохранённого снимка?',
                                    'waiting': 'Ожидается приёмка или зелёный CI'}
                        args['next_step'] = event['marker'] + ' ' + messages.get(event['kind'], event['kind'])
                        if event['kind'] == 'database_decision':
                            args['blocker'] = messages['database_decision'] + ' ' + event['sha']
                    self.board.call('task_update', args)
                event['phase'] = 'done'
            except Exception:
                event['attempts'] = event.get('attempts', 0) + 1
                event['nextAttempt'] = time.time() + min(3600, 5 * 2 ** min(event['attempts'], 9))
            atomic(self.path, events)
