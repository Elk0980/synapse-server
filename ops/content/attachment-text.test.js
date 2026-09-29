'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createAttachmentText, extractText } = require('./attachment-text');

test('распознавание не блокирует цикл, выполняется один раз и сохраняется после перезапуска', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE project_chat_attachments(id INTEGER PRIMARY KEY); INSERT INTO project_chat_attachments VALUES(1),(2)');
  let calls = 0, release;
  const a = { id: 1, company_code: 'alvi' };
  const reader = createAttachmentText({ db, storage: '.', extract: async () => {
    calls++; return new Promise(resolve => { release = resolve; });
  } });
  assert.throws(() => reader.ensure([a]), { attachmentPending: true });
  assert.throws(() => reader.ensure([a]), { attachmentPending: true });
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  release('Массаж — 2500 ₽'); await reader.idle();
  reader.ensure([a]); assert.equal(reader.read(a).text, 'Массаж — 2500 ₽');
  assert.equal(reader.read({ ...a, company_code: 'foreign' }), undefined);
  const restarted = createAttachmentText({ db, storage: '.', extract: () => { throw Error('не вызывать'); } });
  restarted.ensure([a]); assert.equal(restarted.read(a).status, 'ready'); db.close();
});

test('неудачное OCR не выдаётся за прочитанный текст; вывод ограничен', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE project_chat_attachments(id INTEGER PRIMARY KEY); INSERT INTO project_chat_attachments VALUES(1),(2)');
  const reader = createAttachmentText({ db, storage: '.', extract: async file => {
    if (file.id === 1) throw Error('ошибка с приватными данными'); return 'Я'.repeat(7000);
  } });
  const files = [1, 2].map(id => ({ id, company_code: 'alvi' }));
  assert.throws(() => reader.ensure(files), { attachmentPending: true }); await reader.idle();
  reader.ensure(files);
  assert.equal(reader.read(files[0]).status, 'unavailable'); assert.equal(reader.read(files[0]).text, '');
  assert.equal(reader.read(files[1]).text.length, 6000); assert.equal(reader.read(files[1]).truncated, 1); db.close();
});

test('путь вложения не может выйти из хранилища', async () => {
  await assert.rejects(extractText({ disk_name: '../secret', mime: 'image/png' }, '.'), /invalid_file/);
});

