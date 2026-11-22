#!/usr/bin/env python3
"""№289: отчёт на снимке CRM; адресная запись — отдельный, ещё не разрешённый этап."""
import argparse
import datetime as dt
import hashlib
import json
import re
import sqlite3
from pathlib import Path


VERSION = 1
REQUIRED = {
    'media_mentor_plan_versions', 'media_mentor_plan_approvals',
    'media_mentor_variant_approvals', 'media_mentor_variant_revisions',
    'media_mentor_plan_feedback', 'media_mentor_idea_archive',
    'media_mentor_idea_archive_events', 'media_mentor_idea_links',
    'media_mentor_idea_link_events', 'media_mentor_plan_transfers',
    'media_mentor_plan_transfer_items', 'media_mentor_variant_transfers',
    'reel_materials', 'autoposting_posts',
}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def pairs_unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def parse(raw):
    return json.loads(raw, object_pairs_hook=pairs_unique)


def without_id(day):
    return {k: v for k, v in day.items() if k != 'ideaId'}


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def file_sha(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def open_db(path, readonly=True):
    path = Path(path).resolve(strict=True)
    db = sqlite3.connect(path.as_uri() + ('?mode=ro' if readonly else '?mode=rw'), uri=True)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    if readonly:
        db.execute('PRAGMA query_only=ON')
    return db


# Находим границы значений через JSONDecoder, не нормализуем исходный JSON.
# Внешние пробелы, Unicode, числа и все прочие поля остаются побайтно прежними.
DECODER = json.JSONDecoder()


def skip(raw, index):
    while index < len(raw) and raw[index] in ' \t\r\n':
        index += 1
    return index


def fields(raw, start):
    index = skip(raw, start + 1)
    while raw[index] != '}':
        key, end = DECODER.raw_decode(raw, index)
        colon = skip(raw, end)
        if raw[colon] != ':':
            raise ValueError('object colon missing')
        value_start = skip(raw, colon + 1)
        value, value_end = DECODER.raw_decode(raw, value_start)
        yield key, value, value_start, value_end
        index = skip(raw, value_end)
        if raw[index] == '}':
            break
        if raw[index] != ',':
            raise ValueError('object comma missing')
        index = skip(raw, index + 1)


def patch_raw(raw, rows):
    parse(raw)  # в том числе отклоняем дубли ключей
    days_start = next(a for key, _, a, _ in fields(raw, skip(raw, 0)) if key == 'days')
    index, number, edits = skip(raw, days_start + 1), 0, []
    targets = {r['index']: r for r in rows}
    while raw[index] != ']':
        day, end = DECODER.raw_decode(raw, index)
        if number in targets:
            row = targets[number]
            if digest(canonical(without_id(day))) != row['rowSha256'] or day.get('ideaId') not in (None, ''):
                raise ValueError('candidate changed')
            value = json.dumps(row['futureId'])
            existing = next(((a, b) for key, _, a, b in fields(raw, index) if key == 'ideaId'), None)
            if existing:
                edits.append((*existing, value))
            else:
                edits.append((index + 1, index + 1, '"ideaId":' + value + (',' if day else '')))
        number += 1
        index = skip(raw, end)
        if raw[index] == ']':
            break
        if raw[index] != ',':
            raise ValueError('array comma missing')
        index = skip(raw, index + 1)
    if len(edits) != len(rows):
        raise ValueError('candidate index missing')
    for start, end, value in sorted(edits, reverse=True):
        raw = raw[:start] + value + raw[end:]
    return raw


def row_hash(rows):
    def safe(value):
        return {'blob': value.hex()} if isinstance(value, bytes) else value
    return digest('\n'.join(sorted(canonical({k: safe(v) for k, v in dict(row).items()}) for row in rows)))


def analyze(db, company, start, end, expected_count=7):
    dt.date.fromisoformat(start)
    dt.date.fromisoformat(end)
    if company.lower() != 'taisabai' or start != '2026-09-24' or end != '2026-10-07' or expected_count != 7:
        raise ValueError('scope must contain exactly seven approved rows')
    schema = [dict(r) for r in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]
    tables = {r['name'] for r in schema if r['type'] == 'table'}
    owner = db.execute('SELECT id,code FROM companies WHERE code=? COLLATE NOCASE', (company,)).fetchall()
    if len(owner) != 1:
        raise ValueError('company must be unique')
    owner = dict(owner[0])
    plan = db.execute('SELECT company_id,revision,brief_revision,updated_at,plan FROM media_mentor_plans WHERE company_id=?', (owner['id'],)).fetchone()
    if plan is None:
        raise ValueError('current plan missing')
    plan = dict(plan)
    raw, blocked = plan.pop('plan'), []
    days = parse(raw)['days']
    if not isinstance(days, list) or not all(isinstance(day, dict) for day in days):
        raise ValueError('days must be objects')
    candidates, existing_ids = [], set()
    for index, day in enumerate(days):
        idea_id = day.get('ideaId')
        if idea_id not in (None, ''):
            if not isinstance(idea_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,99}', idea_id) or idea_id in existing_ids:
                blocked.append('invalid_or_duplicate_existing_id')
            existing_ids.add(str(idea_id))
            continue
        date = day.get('date', '')
        if not isinstance(date, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date):
            blocked.append('undated_missing_id')
            continue
        dt.date.fromisoformat(date)
        if not start <= date <= end:
            blocked.append('missing_id_outside_approved_window')
            continue
        row_sha = digest(canonical(without_id(day)))
        future_id = f'legacy-289-{owner["id"]}-{plan["revision"]}-{index + 1}-{row_sha[:12]}'
        candidates.append({'index': index, 'date': date, 'platform': day.get('platform'),
                           'format': day.get('format'), 'rowSha256': row_sha, 'futureId': future_id})
    if len(candidates) != expected_count:
        blocked.append('candidate_count_not_seven')
    if len({r['rowSha256'] for r in candidates}) != len(candidates):
        blocked.append('duplicate_candidate_content')
    future_ids = {r['futureId'] for r in candidates}
    if future_ids & existing_ids:
        blocked.append('future_id_collision')
    if REQUIRED - tables:
        blocked.append('required_tables_missing:' + ','.join(sorted(REQUIRED - tables)))
    if any(r['type'] == 'trigger' and r['tbl_name'] == 'media_mentor_plans' for r in schema):
        blocked.append('current_plan_trigger_requires_review')
    if [r[0] for r in db.execute('PRAGMA integrity_check')] != ['ok']:
        blocked.append('integrity_check_failed')
    if db.execute('PRAGMA foreign_key_check').fetchall():
        blocked.append('foreign_key_check_failed')

    related, details, histories = {}, {}, {}
    for table in sorted(tables):
        columns = {r['name'] for r in db.execute('PRAGMA table_info(' + quote(table) + ')')}
        relevant = table.startswith('media_mentor_') or table in ('reel_materials', 'autoposting_posts') or 'idea_id' in columns
        if not relevant or table == 'media_mentor_plans':
            continue
        if table == 'media_mentor_plan_transfer_items':
            if 'media_mentor_plan_transfers' not in tables:
                blocked.append('transfer_parent_table_missing')
                continue
            rows = db.execute('SELECT i.*,t.plan_revision FROM media_mentor_plan_transfer_items i JOIN media_mentor_plan_transfers t ON t.id=i.transfer_id WHERE t.company_id=?', (owner['id'],)).fetchall()
        elif 'company_id' in columns:
            rows = db.execute('SELECT * FROM ' + quote(table) + ' WHERE company_id=?', (owner['id'],)).fetchall()
        elif 'company_code' in columns:
            rows = db.execute('SELECT * FROM ' + quote(table) + ' WHERE company_code=? COLLATE NOCASE', (owner['code'],)).fetchall()
        else:
            blocked.append('unscoped_reference_table:' + table)
            continue
        related[table] = {'count': len(rows), 'sha256': row_hash(rows)}
        details[table] = [dict(r) for r in rows]
        if table == 'media_mentor_plan_versions':
            histories = {r['revision']: parse(r['plan'])['days'] for r in rows}
        if 'idea_id' in columns:
            blank = sum(r['idea_id'] in (None, '') for r in rows)
            related[table]['blankIdeaIds'] = blank
            if blank and table.startswith('media_mentor_'):
                blocked.append('ambiguous_blank_idea_reference:' + table)
            if any(r['idea_id'] in future_ids for r in rows):
                blocked.append('future_id_collision:' + table)
    current_history = histories.get(plan['revision'])
    if current_history is None:
        blocked.append('current_history_missing')
    else:
        if canonical([without_id(d) for d in current_history]) != canonical([without_id(d) for d in days]):
            blocked.append('current_history_content_mismatch')
        # ID мог быть потерян в текущей проекции: не выдаём новый поверх прежнего.
        for history in histories.values():
            for day in history:
                if day.get('ideaId') and digest(canonical(without_id(day))) in {r['rowSha256'] for r in candidates}:
                    blocked.append('historical_id_for_candidate_requires_review')
    known_ids = existing_ids | {d['ideaId'] for history in histories.values() for d in history if isinstance(d.get('ideaId'), str) and d['ideaId']}
    known_ids |= {r['idea_id'] for r in details.get('media_mentor_idea_archive', []) if r['idea_id']}
    for table, rows in details.items():
        if table.startswith('media_mentor_') and any(r.get('idea_id') not in known_ids for r in rows if r.get('idea_id')):
            blocked.append('unresolved_idea_reference:' + table)
    for row in details.get('reel_materials', []):
        if not row.get('idea_id') and row.get('release_date') in {r['date'] for r in candidates}:
            blocked.append('ambiguous_unkeyed_reel_on_candidate_date')
    references = []
    for table in ('media_mentor_plan_approvals', 'media_mentor_plan_feedback', 'media_mentor_plan_transfer_items'):
        for row in details.get(table, []):
            item = {k: row[k] for k in ('id', 'transfer_id', 'plan_revision', 'day_index', 'decision', 'post_id') if k in row}
            if 'day_index' in row:
                history = histories.get(row['plan_revision'])
                index = row['day_index']
                if not isinstance(index, int) or history is None or not 0 <= index < len(history):
                    blocked.append('ambiguous_day_reference:' + table)
                else:
                    old = history[index]
                    matches = [r['index'] for r in candidates if digest(canonical(without_id(old))) == r['rowSha256']]
                    item['candidateIndexes'] = matches
                    if not matches and any((r['date'], r['platform']) == (old.get('date'), old.get('platform')) for r in candidates):
                        blocked.append('historical_day_content_requires_review:' + table)
                    if len(matches) > 1 or (row['plan_revision'] == plan['revision'] and index in {r['index'] for r in candidates} and matches != [index]):
                        blocked.append('ambiguous_day_reference:' + table)
                    if table.endswith('transfer_items') and (row['plan_date'] != old.get('date') or row['plan_platform'] != old.get('platform')):
                        blocked.append('transfer_coordinates_mismatch')
            references.append({'table': table, **item})
    for table in ('media_mentor_idea_archive', 'media_mentor_idea_archive_events'):
        for row in details.get(table, []):
            old = parse(row['idea'])
            if digest(canonical(without_id(old))) in {r['rowSha256'] for r in candidates}:
                blocked.append('archived_candidate_requires_review')
    # Другие строки текущего плана и все его метаданные входят в условие остановки.
    guard = {'company': owner, 'plan': plan, 'schemaSha256': digest(canonical(schema)),
             'related': related, 'otherDaysSha256': digest(canonical([d for i, d in enumerate(days) if i not in {r['index'] for r in candidates}]))}
    proposed = patch_raw(raw, candidates)
    return {'version': VERSION, 'scope': {'company': company, 'start': start, 'end': end, 'expectedCount': expected_count},
            'eligible': not blocked, 'blocked': sorted(set(blocked)), 'guard': guard, 'rows': candidates,
            'references': references, 'protectedReels': [r['id'] for r in details.get('reel_materials', []) if r['id'] in (21, 22, 23, 24)],
            'planSha256Before': digest(raw), 'planSha256After': digest(raw),
            'projectedPlanSha256': digest(proposed), 'writes': 0}


def report(path, company, start, end):
    path = Path(path).resolve(strict=True)
    if any(Path(str(path) + suffix).exists() for suffix in ('-wal', '-journal')):
        raise ValueError('use a completed standalone backup, not a live/WAL database')
    before = file_sha(path)
    db = open_db(path)
    try:
        db.execute('BEGIN')
        result = analyze(db, company, start, end)
        after = db.execute('SELECT plan FROM media_mentor_plans WHERE company_id=?', (result['guard']['company']['id'],)).fetchone()[0]
        result['planSha256After'] = digest(after)
        result['writes'] = db.total_changes
        if result['planSha256After'] != result['planSha256Before'] or result['writes']:
            result['eligible'] = False
            result['blocked'].append('unexpected_report_change')
        db.rollback()
    finally:
        db.close()
    result['databaseSha256Before'] = before
    result['databaseSha256After'] = file_sha(path)
    if before != result['databaseSha256After']:
        result['eligible'] = False
        result['blocked'].append('backup_changed_during_report')
    return result


def apply_reviewed(path, manifest):
    """Будущий шаг2. НЕ запускать до отдельного ревью отчёта/кода и поручения оператору."""
    if manifest.get('version') != VERSION or not manifest.get('eligible') or manifest.get('writes') != 0:
        raise ValueError('reviewable eligible report required')
    scope = manifest['scope']
    db = open_db(path, readonly=False)
    try:
        db.execute('BEGIN IMMEDIATE')
        current = analyze(db, scope['company'], scope['start'], scope['end'], scope['expectedCount'])
        if not current['eligible'] or current['guard'] != manifest['guard'] or current['rows'] != manifest['rows'] or current['planSha256Before'] != manifest['planSha256Before'] or current['projectedPlanSha256'] != manifest['projectedPlanSha256']:
            raise ValueError('STOP: data/schema/references/manifest changed; obtain a new report and review')
        owner = manifest['guard']['company']['id']
        raw = db.execute('SELECT plan FROM media_mentor_plans WHERE company_id=?', (owner,)).fetchone()[0]
        patched = patch_raw(raw, manifest['rows'])
        # Даже случайно добавленный DML вне единственной колонки не выполнится.
        def authorize(action, table, column, _db, _source):
            if action in (sqlite3.SQLITE_INSERT, sqlite3.SQLITE_DELETE):
                return sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_UPDATE and (table, column) != ('media_mentor_plans', 'plan'):
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        db.set_authorizer(authorize)
        changed = db.execute('UPDATE media_mentor_plans SET plan=? WHERE company_id=? AND plan=?', (patched, owner, raw)).rowcount
        if changed != 1 or db.total_changes != 1 or digest(db.execute('SELECT plan FROM media_mentor_plans WHERE company_id=?', (owner,)).fetchone()[0]) != manifest['projectedPlanSha256']:
            raise ValueError('STOP: unexpected write result')
        if db.execute('PRAGMA foreign_key_check').fetchall():
            raise ValueError('STOP: foreign key check failed')
        db.commit()
        return {'writes': 1, 'idsAdded': len(manifest['rows']), 'planSha256After': digest(patched), 'archiveWrites': 0}
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('report', 'apply'))
    parser.add_argument('--db', required=True)
    parser.add_argument('--company', default='taisabai')
    parser.add_argument('--start', default='2026-09-24')
    parser.add_argument('--end', default='2026-10-07')
    parser.add_argument('--manifest')
    args = parser.parse_args()
    if args.command == 'report':
        if args.manifest:
            parser.error('report does not consume a manifest')
        value = report(args.db, args.company, args.start, args.end)
    else:
        if not args.manifest:
            parser.error('apply requires the separately reviewed report; NOT authorized by step1')
        value = apply_reviewed(args.db, parse(Path(args.manifest).read_text(encoding='utf-8')))
    print(json.dumps(value, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
