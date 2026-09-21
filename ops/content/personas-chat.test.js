'use strict';
/* Две персоны в общем чате проекта: кого позвали, тот и отвечает своим контекстом.
   Проверяется на настоящем модуле чата, а не на копии правил. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store');
const { createProjectChat } = require('./project-chat');

const HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 7).toString('base64url')}$${Buffer.alloc(32, 9).toString('base64url')}`;
const ROOM = 'palitra-love';
const OWNER_ID = 1;
const requireSession = (request) => request.session;
const requireCsrf = () => {};
const sendJson = (response, status, payload) => { response.statusCode = status; response.payload = payload; };
const readBody = async (request) => request.body;

function setup({ reply = null, crm = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personas-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const authStore = createAuthStore(db, `vlad:owner:${HASH}`);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const address = String(url);
    calls.push({ url: address, body: options.body ? JSON.parse(options.body) : null });
    if (address.endsWith('/status')) return { ok: true, status: 200, json: async () => ({ connected: true }) };
    if (address.includes('/media-mentor')) {
      if (crm.mentorFails) throw new Error('CRM недоступна');
      return { ok: true, status: 200, json: async () => crm.mentor ?? null };
    }
    if (address.includes('/social-stats')) return { ok: true, status: 200, json: async () => crm.stats ?? {} };
    const value = (typeof reply === 'function' ? reply() : reply) || { status: 503 };
    return { ok: (value.status || 200) < 400, status: value.status || 200,
      headers: { get: () => null }, json: async () => value.payload ?? {} };
  };
  const chat = createProjectChat({ db, authStore, assetsDir: dir, runnerUrl: 'http://hugh-runtime:8080',
    chatApiKey: 'secret-key', crmUrl: 'http://crm:8080', crmApiKey: 'crm-key',
    requireSession, requireCsrf, sendJson, readBody, fetchImpl, statusTtl: 0,
    cabinetUrl: 'https://synapse.example.test' });
  const owner = { user: authStore.getById(OWNER_ID), csrf: 'csrf-1' };
  return { db, chat, owner, calls };
}
const say = async (chat, owner, text, id) => {
  const request = { method: 'POST', headers: { 'x-csrf-token': owner.csrf }, session: owner,
    body: { text, clientMessageId: id } };
  const response = { statusCode: 0, payload: null, writeHead() {}, end() {} };
  await chat.handle(request, response, new URL(`http://x/content/project-chat/${ROOM}/messages`));
  return response;
};
const job = (db) => db.prepare('SELECT * FROM project_chat_ai_jobs ORDER BY id DESC LIMIT 1').get();

test('обращение к Хью ставит задание с его персоной', async () => {
  const { db, chat, owner } = setup();
  await say(chat, owner, 'Хью, что со сроками?', 'persona-0001');
  assert.equal(job(db).persona, 'hugh');
});

test('обращение к Лео ставит задание с его персоной', async () => {
  const { db, chat, owner } = setup();
  await say(chat, owner, 'Лео, покажи контент-план', 'persona-0002');
  assert.equal(job(db).persona, 'leo');
});

test('сообщение без имени задания не ставит', async () => {
  const { db, chat, owner } = setup();
  await say(chat, owner, 'привет', 'persona-0003');
  assert.equal(job(db), undefined);
});

test('имя внутри другого слова обращением не считается', async () => {
  const { db, chat, owner } = setup();
  await say(chat, owner, 'леопард сбежал из Хьюстона', 'persona-0004');
  assert.equal(job(db), undefined);
});

test('Лео получает бриф и план, Хью — нет', async () => {
  const mentor = { brief: { revision: 3, fields: { goal: 'Записи на массаж', product: 'Тайский массаж',
    audience: 'Женщины', platforms: ['vk'], shootingComfort: { level: 'hands_only' }, assets: [] } },
    plan: { revision: 2, startDate: '2026-09-21', endDate: '2026-09-27',
      days: [{ date: '2026-09-21', platform: 'vk', format: 'reel', role: 'reach', topic: 'Разминка спины', assetId: '' }] },
    approval: { status: 'pending' } };
  const leo = setup({ crm: { mentor }, reply: { status: 200, payload: { text: 'готово' } } });
  await say(leo.chat, leo.owner, 'Лео, что в плане?', 'persona-0005');
  await leo.chat.processAIJobs();
  const leoRequest = leo.calls.find((item) => item.body?.system);
  assert.ok(leoRequest, 'запрос к модели должен быть собран');
  assert.match(leoRequest.body.system, /Записи на массаж/);
  assert.match(leoRequest.body.system, /Разминка спины/);
  assert.match(leoRequest.body.system, /Тебя зовут Лео/);

  const hugh = setup({ crm: { mentor }, reply: { status: 200, payload: { text: 'готово' } } });
  await say(hugh.chat, hugh.owner, 'Хью, что по сайту?', 'persona-0006');
  await hugh.chat.processAIJobs();
  const hughRequest = hugh.calls.find((item) => item.body?.system);
  assert.ok(!hughRequest.body.system.includes('Записи на массаж'), 'бриф Хью не нужен — это деньги и размытый ответ');
  assert.match(hughRequest.body.system, /Тебя зовут Хью/);
});

test('Хью не ходит в CRM за сведениями Медиа-наставника', async () => {
  const { chat, owner, calls } = setup({ reply: { status: 200, payload: { text: 'готово' } } });
  await say(chat, owner, 'Хью, привет', 'persona-0007');
  await chat.processAIJobs();
  assert.equal(calls.filter((item) => item.url.includes('/media-mentor')).length, 0);
});

test('недоступная CRM не ломает ответ Лео и не выдумывает сведения', async () => {
  const { chat, owner, calls } = setup({ crm: { mentorFails: true }, reply: { status: 200, payload: { text: 'готово' } } });
  await say(chat, owner, 'Лео, что в плане?', 'persona-0008');
  await chat.processAIJobs();
  const request = calls.find((item) => item.body?.system);
  assert.match(request.body.system, /сейчас недоступны/);
});

test('ответ подписывается именем позванной персоны', async () => {
  const { db, chat, owner } = setup({ reply: { status: 200, payload: { text: 'план такой' } } });
  await say(chat, owner, 'Лео, что в плане?', 'persona-0009');
  await chat.processAIJobs();
  const answer = db.prepare("SELECT * FROM project_chat_messages WHERE author_type='assistant' ORDER BY id DESC LIMIT 1").get();
  assert.equal(answer.author_name, 'Лео');
  assert.equal(answer.author_id, 'leo');
});

test('задание без персоны (созданное до разделения) обрабатывается как Хью', async () => {
  const { db, chat, owner } = setup({ reply: { status: 200, payload: { text: 'ответ' } } });
  await say(chat, owner, 'Хью, привет', 'persona-00010');
  db.prepare('UPDATE project_chat_ai_jobs SET persona=NULL').run();
  await chat.processAIJobs();
  const answer = db.prepare("SELECT * FROM project_chat_messages WHERE author_type='assistant' ORDER BY id DESC LIMIT 1").get();
  assert.equal(answer.author_name, 'Хью');
});

test('инструкция запрещает каждой персоне отвечать за соседа', async () => {
  const { chat, owner, calls } = setup({ reply: { status: 200, payload: { text: 'ответ' } } });
  await say(chat, owner, 'Лео, привет', 'persona-00011');
  await chat.processAIJobs();
  const request = calls.find((item) => item.body?.system);
  assert.match(request.body.system, /не отвечай по существу/);
  assert.match(request.body.system, /Хью/);
});
