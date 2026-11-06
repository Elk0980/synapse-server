'use strict';
// Автосинхронизация контент-плана с Google Таблицей без ИИ (задача №193, specs/194-google-sheets-sync).
// Эталон — ЛК (OD-2026-09-15-COMPANY-TRUTH). Таблица — зеркало для команды: модуль пишет только
// служебный лист «Synapse · план», ручные листы не трогает. Правки команды в колонках «Статус» и
// «Правки/Комментарии» возвращаются в ЛК как предложения (onProposal), эталон не переписывается.
const {extractSpreadsheetId, quoteSheet} = require('./google-sheets-client');

const SHEET_TITLE = 'Synapse · план';
const HEADER = ['ideaId', '№', 'Дата', 'Тема', 'Формат', 'Площадки', 'Статус', 'Правки/Комментарии'];
const COLUMNS = HEADER.length; // A..H
const STATUS_COL = 6; // G
const COMMENT_COL = 7; // H
const LAST_COL = 'H';
const MINUTE = 60_000;

function cell(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(cell).filter(Boolean).join(', ');
  if (typeof value === 'object') return cell(value.title || value.name || value.text || '');
  return String(value).trim();
}

const pad = (row) => { const out = Array.from({length: COLUMNS}, (_, i) => cell(row && row[i])); return out; };
const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

// Плановая строка ЛК → строка листа. Принимает распространённые имена полей плана.
function toRow(item, index) {
  const ideaId = cell(item.ideaId ?? item.id);
  return [
    ideaId,
    cell(item.number ?? item.no ?? index + 1),
    cell(item.date ?? item.publishDate ?? item.publishAt ?? item.plannedDate),
    cell(item.topic ?? item.title ?? item.theme),
    cell(item.format ?? item.kind),
    cell(item.platforms ?? item.platform),
    cell(item.status ?? item.productionStatus),
    cell(item.comments ?? item.comment ?? item.revisions),
  ];
}

function createGoogleSheetsSync({
  db, client, getPlan, getSheetUrl, onProposal = async () => {}, now = () => Date.now(),
  intervalMs = MINUTE, importEveryMs = 5 * MINUTE, fullSyncHourUtc = 20, fullSyncMinGapMs = 20 * 60 * MINUTE,
  retryBaseMs = 30_000, retryMaxMs = 6 * 60 * MINUTE, batchSize = 10, log = () => {},
}) {
  if (!db || !client || typeof getPlan !== 'function' || typeof getSheetUrl !== 'function') throw new Error('createGoogleSheetsSync: нужны db, client, getPlan, getSheetUrl');
  db.exec(`CREATE TABLE IF NOT EXISTS google_sheets_sync_queue (
    company_code TEXT PRIMARY KEY, full INTEGER NOT NULL DEFAULT 0, enqueued_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, last_error TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS google_sheets_sync_state (
    company_code TEXT PRIMARY KEY, spreadsheet_id TEXT, last_modified_time TEXT, last_import_at INTEGER,
    last_push_at INTEGER, last_full_at INTEGER, rows_json TEXT NOT NULL DEFAULT '{}', last_error TEXT)`);

  const q = {
    enqueue: db.prepare(`INSERT INTO google_sheets_sync_queue(company_code, full, enqueued_at, attempts, next_attempt_at)
      VALUES(?, ?, ?, 0, ?) ON CONFLICT(company_code) DO UPDATE SET full = MAX(full, excluded.full), enqueued_at = excluded.enqueued_at,
      next_attempt_at = MIN(next_attempt_at, excluded.next_attempt_at)`),
    due: db.prepare('SELECT * FROM google_sheets_sync_queue WHERE next_attempt_at <= ? ORDER BY next_attempt_at, enqueued_at LIMIT ?'),
    done: db.prepare('DELETE FROM google_sheets_sync_queue WHERE company_code = ? AND enqueued_at = ?'),
    requeued: db.prepare('UPDATE google_sheets_sync_queue SET attempts = 0, last_error = NULL WHERE company_code = ?'),
    retry: db.prepare('UPDATE google_sheets_sync_queue SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE company_code = ?'),
    queued: db.prepare('SELECT * FROM google_sheets_sync_queue WHERE company_code = ?'),
    state: db.prepare('SELECT * FROM google_sheets_sync_state WHERE company_code = ?'),
    states: db.prepare('SELECT * FROM google_sheets_sync_state'),
    upsert: db.prepare(`INSERT INTO google_sheets_sync_state(company_code, spreadsheet_id, rows_json) VALUES(?, ?, '{}')
      ON CONFLICT(company_code) DO UPDATE SET spreadsheet_id = excluded.spreadsheet_id`),
    reset: db.prepare(`UPDATE google_sheets_sync_state SET rows_json = '{}', last_modified_time = NULL WHERE company_code = ?`),
    saveRows: db.prepare('UPDATE google_sheets_sync_state SET rows_json = ? WHERE company_code = ?'),
    pushed: db.prepare('UPDATE google_sheets_sync_state SET last_push_at = ?, last_error = NULL WHERE company_code = ?'),
    full: db.prepare('UPDATE google_sheets_sync_state SET last_full_at = ? WHERE company_code = ?'),
    imported: db.prepare('UPDATE google_sheets_sync_state SET last_modified_time = ?, last_import_at = ?, last_error = NULL WHERE company_code = ?'),
    importTouched: db.prepare('UPDATE google_sheets_sync_state SET last_import_at = ? WHERE company_code = ?'),
    error: db.prepare('UPDATE google_sheets_sync_state SET last_error = ? WHERE company_code = ?'),
  };

  const range = (a1) => quoteSheet(SHEET_TITLE) + '!' + a1;
  const backoff = (attempts) => Math.min(retryMaxMs, retryBaseMs * 2 ** attempts);

  function enqueue(companyCode, {full = false} = {}) {
    const code = String(companyCode || '').trim();
    if (!code) throw new Error('Нужен код компании');
    const at = now();
    q.enqueue.run(code, full ? 1 : 0, at, at);
    return {companyCode: code, queued: true};
  }

  async function target(companyCode) {
    const spreadsheetId = extractSpreadsheetId(await getSheetUrl(companyCode));
    if (!spreadsheetId) return null;
    const state = q.state.get(companyCode);
    if (state && state.spreadsheet_id !== spreadsheetId) { q.upsert.run(companyCode, spreadsheetId); q.reset.run(companyCode); }
    else if (!state) q.upsert.run(companyCode, spreadsheetId);
    return spreadsheetId;
  }

  async function planRows(companyCode) {
    const plan = await getPlan(companyCode);
    const items = Array.isArray(plan) ? plan : plan && Array.isArray(plan.items) ? plan.items : [];
    const rows = [];
    const seen = new Set();
    items.forEach((item, index) => {
      const row = toRow(item || {}, index);
      if (!row[0] || seen.has(row[0])) return; // без ключа строку нельзя сопоставить
      seen.add(row[0]);
      rows.push(row);
    });
    return rows;
  }

  // Сравнивает колонки «Статус»/«Комментарии» листа с тем, что модуль писал в последний раз,
  // и отдаёт новые правки команды предложениями. Возвращает изменённый снимок.
  async function collectProposals(companyCode, sheetRows, snapshot, lkById) {
    const proposals = [];
    for (const [ideaId, values] of sheetRows) {
      const known = snapshot[ideaId];
      if (!known) continue; // строка добавлена вручную, не наша
      const lk = lkById.get(ideaId);
      for (const [field, col] of [['status', STATUS_COL], ['comment', COMMENT_COL]]) {
        const value = values[col];
        const written = known.written[col];
        if (value === written) continue;
        const proposed = known.proposed && known.proposed[field];
        if (value === proposed) continue;
        const lkValue = lk ? lk[col] : null;
        if (lk && value === lkValue) continue; // команда сделала то же, что уже в ЛК
        proposals.push({companyCode, ideaId, field, value, source: 'google-sheet', lkValue,
          conflict: Boolean(lk && lkValue !== written)});
      }
    }
    for (const proposal of proposals) {
      await onProposal(proposal); // ошибка — предложение не помечается и повторится
      const known = snapshot[proposal.ideaId];
      known.proposed = {...(known.proposed || {}), [proposal.field]: proposal.value};
    }
    return proposals;
  }

  function sheetIndex(values) {
    const byId = new Map();
    const positions = new Map();
    let lastUsed = 1; // строка 1 — заголовок
    values.forEach((raw, i) => {
      const rowNumber = i + 1;
      const row = pad(raw);
      if (row.some(Boolean)) lastUsed = Math.max(lastUsed, rowNumber);
      if (rowNumber === 1 || !row[0] || positions.has(row[0])) return;
      positions.set(row[0], rowNumber);
      byId.set(row[0], row);
    });
    return {byId, positions, lastUsed};
  }

  // ЛК → Таблица. Пишет только изменённые строки; full=true — полная сверка с уплотнением листа.
  async function pushCompany(companyCode, {full = false} = {}) {
    const spreadsheetId = await target(companyCode);
    if (!spreadsheetId) return {companyCode, skipped: 'no_sheet'};
    const desired = await planRows(companyCode);
    const lkById = new Map(desired.map((row) => [row[0], row]));
    await client.ensureSheet(spreadsheetId, SHEET_TITLE);
    const current = await client.getValues(spreadsheetId, range('A1:' + LAST_COL));
    const {byId, positions, lastUsed} = sheetIndex(current);
    const state = q.state.get(companyCode);
    const snapshot = JSON.parse(state.rows_json || '{}');

    // Сначала сохранить несогласованные правки команды, чтобы ЛК их не затёр молча.
    const proposals = await collectProposals(companyCode, byId, snapshot, lkById);

    const data = [];
    const header = pad(current[0]);
    if (!same(header, HEADER)) data.push({range: range('A1:' + LAST_COL + '1'), values: [HEADER]});
    const nextSnapshot = {};
    let written = 0;
    let cleared = 0;

    if (full) {
      desired.forEach((row, i) => {
        const rowNumber = i + 2;
        const onRow = pad(current[rowNumber - 1]);
        if (!same(onRow, row)) { data.push({range: range('A' + rowNumber + ':' + LAST_COL + rowNumber), values: [row]}); written++; }
        nextSnapshot[row[0]] = {written: row};
      });
      for (let rowNumber = desired.length + 2; rowNumber <= lastUsed; rowNumber++) {
        if (pad(current[rowNumber - 1]).some(Boolean)) {
          data.push({range: range('A' + rowNumber + ':' + LAST_COL + rowNumber), values: [Array(COLUMNS).fill('')]});
          cleared++;
        }
      }
    } else {
      let append = lastUsed + 1;
      for (const row of desired) {
        const id = row[0];
        const known = snapshot[id];
        const onSheet = byId.get(id);
        let rowNumber = positions.get(id);
        const lkChanged = !known || !same(known.written, row);
        // Колонки ЛК (A..F) сверяются с листом всегда; статус и комментарии переписываются,
        // только если они изменились в ЛК — правка команды живёт до решения или ночной сверки.
        const lkColumnsDiffer = !onSheet || !same(onSheet.slice(0, STATUS_COL), row.slice(0, STATUS_COL));
        if (!rowNumber) rowNumber = append++;
        if (lkChanged || lkColumnsDiffer) {
          if (!onSheet || !same(onSheet, row)) {
            data.push({range: range('A' + rowNumber + ':' + LAST_COL + rowNumber), values: [row]});
            written++;
          }
          nextSnapshot[id] = {written: row};
        } else {
          nextSnapshot[id] = known;
        }
      }
      for (const [id, rowNumber] of positions) {
        if (lkById.has(id) || !snapshot[id]) continue; // удалённая в ЛК наша строка; чужие не трогаем
        data.push({range: range('A' + rowNumber + ':' + LAST_COL + rowNumber), values: [Array(COLUMNS).fill('')]});
        cleared++;
      }
    }

    await client.batchUpdateValues(spreadsheetId, data);
    q.saveRows.run(JSON.stringify(nextSnapshot), companyCode);
    q.pushed.run(now(), companyCode);
    if (full) q.full.run(now(), companyCode);
    return {companyCode, spreadsheetId, written, cleared, header: data.length > 0 && !same(header, HEADER), proposals: proposals.length, full};
  }

  // Таблица → ЛК. Читает только ключ, «Статус» и «Комментарии» и только при новом modifiedTime.
  async function importCompany(companyCode) {
    const spreadsheetId = await target(companyCode);
    if (!spreadsheetId) return {companyCode, skipped: 'no_sheet'};
    const state = q.state.get(companyCode);
    q.importTouched.run(now(), companyCode);
    const modifiedTime = await client.getModifiedTime(spreadsheetId);
    if (modifiedTime && modifiedTime === state.last_modified_time) return {companyCode, unchanged: true, proposals: 0};
    const [ids, tail] = await client.batchGetValues(spreadsheetId, [range('A2:A'), range('G2:' + LAST_COL)]);
    const sheetRows = new Map();
    ids.forEach((idRow, i) => {
      const id = cell(idRow && idRow[0]);
      if (!id || sheetRows.has(id)) return;
      const row = Array(COLUMNS).fill('');
      row[STATUS_COL] = cell(tail[i] && tail[i][0]);
      row[COMMENT_COL] = cell(tail[i] && tail[i][1]);
      sheetRows.set(id, row);
    });
    const desired = await planRows(companyCode);
    const lkById = new Map(desired.map((row) => [row[0], row]));
    const snapshot = JSON.parse(state.rows_json || '{}');
    const proposals = await collectProposals(companyCode, sheetRows, snapshot, lkById);
    q.saveRows.run(JSON.stringify(snapshot), companyCode);
    q.imported.run(modifiedTime, now(), companyCode);
    return {companyCode, proposals: proposals.length};
  }

  async function processQueue() {
    const results = [];
    for (const item of q.due.all(now(), batchSize)) {
      try {
        const result = await pushCompany(item.company_code, {full: Boolean(item.full)});
        q.done.run(item.company_code, item.enqueued_at);
        if (q.queued.get(item.company_code)) q.requeued.run(item.company_code); // за время работы поставлен новый запрос
        results.push(result);
      } catch (error) {
        const attempts = item.attempts + 1;
        const delay = error && error.code === 'NOT_CONNECTED' ? retryMaxMs : backoff(item.attempts);
        q.retry.run(now() + delay, String(error && error.message || error).slice(0, 500), item.company_code);
        if (q.state.get(item.company_code)) q.error.run(String(error && error.message || error).slice(0, 500), item.company_code);
        log('google-sheets push failed', item.company_code, attempts, error && error.code);
        results.push({companyCode: item.company_code, error: error && error.code || 'ERROR', retryInMs: delay});
      }
    }
    return results;
  }

  async function importDue() {
    const results = [];
    for (const state of q.states.all()) {
      if (state.last_import_at && now() - state.last_import_at < importEveryMs) continue;
      try { results.push(await importCompany(state.company_code)); } catch (error) {
        q.error.run(String(error && error.message || error).slice(0, 500), state.company_code);
        results.push({companyCode: state.company_code, error: error && error.code || 'ERROR'});
      }
    }
    return results;
  }

  function scheduleNightly() {
    const hour = new Date(now()).getUTCHours();
    if (hour !== fullSyncHourUtc) return 0;
    let count = 0;
    for (const state of q.states.all()) {
      if (state.last_full_at && now() - state.last_full_at < fullSyncMinGapMs) continue;
      enqueue(state.company_code, {full: true});
      count++;
    }
    return count;
  }

  let running = null;
  async function tick() {
    if (!client.status().connected) return {connected: false, reason: client.status().reason};
    if (running) return running;
    running = (async () => {
      const nightly = scheduleNightly();
      const pushed = await processQueue();
      const imported = await importDue();
      return {connected: true, nightly, pushed, imported};
    })();
    try { return await running; } finally { running = null; }
  }

  let timer = null;
  return {
    SHEET_TITLE, HEADER, enqueue, pushCompany, importCompany, processQueue, importDue, tick,
    start() { if (!timer) { timer = setInterval(() => { tick().catch((error) => log('google-sheets tick failed', error && error.message)); }, intervalMs); timer.unref?.(); } return this; },
    stop() { if (timer) clearInterval(timer); timer = null; },
    status(companyCode) {
      const state = q.state.get(companyCode) || null;
      const queued = q.queued.get(companyCode) || null;
      return {
        ...client.status(),
        companyCode,
        lastPushAt: state && state.last_push_at || null,
        lastImportAt: state && state.last_import_at || null,
        lastFullAt: state && state.last_full_at || null,
        lastError: state && state.last_error || queued && queued.last_error || null,
        queued: Boolean(queued),
        nextAttemptAt: queued && queued.next_attempt_at || null,
      };
    },
  };
}

module.exports = {createGoogleSheetsSync, toRow, SHEET_TITLE, HEADER};
