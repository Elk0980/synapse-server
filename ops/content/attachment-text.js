'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TEXT = 6000;

// Локальное распознавание: файлы не передаются новому внешнему провайдеру.
async function extractText(file, storage) {
  if (!UUID.test(file.disk_name)) throw new Error('invalid_file');
  const root = fs.realpathSync(storage), location = fs.realpathSync(path.join(root, file.disk_name));
  if (path.dirname(location) !== root) throw new Error('invalid_file');
  const stat = fs.statSync(location);
  if (!stat.isFile() || stat.size < 1 || stat.size > 8 * 1024 * 1024) throw new Error('invalid_file');
  const options = { timeout: 20000, maxBuffer: 512 * 1024, windowsHide: true,
    env: { ...process.env, OMP_THREAD_LIMIT: '1' } };
  let output;
  if (file.mime === 'application/pdf') {
    output = await runFile('pdftotext', ['-f', '1', '-l', '12', '-layout', location, '-'], options);
  } else if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mime)) {
    output = await runFile('tesseract', [location, 'stdout', '-l', 'rus+eng', '--psm', '11'], options);
  } else throw new Error('unsupported_format');
  const text = String(output.stdout || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();
  if (!text) throw new Error('no_text');
  return text;
}

function createAttachmentText({ db, storage, extract = extractText }) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_chat_attachment_text (
    attachment_id INTEGER PRIMARY KEY REFERENCES project_chat_attachments(id),
    company_code TEXT NOT NULL, status TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
    truncated INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`);
  const inflight = new Map();
  let queue = Promise.resolve();
  function read(file) {
    return db.prepare('SELECT * FROM project_chat_attachment_text WHERE attachment_id=? AND company_code=?')
      .get(file.id, file.company_code);
  }
  function start(file) {
    if (inflight.has(file.id)) return;
    // Запуск после текущей синхронной транзакции. Один процесс OCR за раз.
    const pending = queue.then(async () => {
      let status = 'ready', text = '', truncated = 0;
      try {
        const result = String(await extract(file, storage));
        if (!result.trim()) throw new Error('no_text');
        truncated = Number(result.length > MAX_TEXT); text = result.slice(0, MAX_TEXT);
      } catch { status = 'unavailable'; }
      db.prepare(`INSERT INTO project_chat_attachment_text(attachment_id,company_code,status,text,truncated,updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(attachment_id) DO UPDATE SET status=excluded.status,text=excluded.text,
        truncated=excluded.truncated,updated_at=excluded.updated_at`)
        .run(file.id, file.company_code, status, text, truncated, new Date().toISOString());
    }).catch(() => {}).finally(() => inflight.delete(file.id));
    inflight.set(file.id, pending); queue = pending;
  }
  function ensure(files) {
    let pending = false;
    for (const file of files) {
      if (!read(file)) { start(file); pending = true; }
    }
    if (pending) throw Object.assign(new Error('Распознавание вложений: ответ готовится'), { attachmentPending: true });
  }
  return { read, ensure, idle: () => queue };
}

module.exports = { createAttachmentText, extractText };
