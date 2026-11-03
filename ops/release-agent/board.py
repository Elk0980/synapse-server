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
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
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

    def enqueue(self, task_id, sha, kind):
        if self.path.exists():
            old = load(self.path)
            need(old['marker'] == f'release:{sha}:{kind}' or old['phase'] == 'done', 'OUTBOX_PENDING')
            if old['marker'] == f'release:{sha}:{kind}':
                return
        atomic(self.path, {'taskId': task_id, 'sha': sha, 'kind': kind,
                           'marker': f'release:{sha}:{kind}', 'phase': 'ready',
                           'at': datetime.now(timezone.utc).isoformat()})

    def flush(self):
        if not self.path.exists():
            return
        event = load(self.path)
        if event['phase'] == 'done':
            return
        task = self.board.task(event['taskId'])
        if event['kind'] == 'connected':
            previous = task['coordination']['milestones']['connected'].get('evidence', '')
            already = event['marker'] in previous
        else:
            already = any(event['marker'] in c['text'] for c in task['comments'])
        if already:
            event['phase'] = 'done'
            atomic(self.path, event)
            return
        need(event['phase'] != 'unknown', 'BOARD_UNKNOWN_AWAIT_RECONCILIATION')
        event['phase'] = 'unknown'
        atomic(self.path, event)
        if event['kind'] == 'connected':
            self.board.call('task_update', {'task_id': event['taskId'],
                'revision': task['coordination']['revision'], 'stage': 'connected',
                'evidence': event['marker'] + ' health PASS; commit=' + event['sha'],
                'checked_at': event['at']})
        else:
            self.board.call('task_comment', {'task_id': event['taskId'],
                'author': 'Выпускающий агент',
                'text': event['marker'] + ' Выпуск откатан; health или операция выпуска не прошла. Данные сохранены.'})
        event['phase'] = 'done'
        atomic(self.path, event)
