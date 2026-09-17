'use strict';
/* Команды Хью в группах: детерминированные меню/план/инструкция/статус без модели, /idea через общую очередь с тем же
   системным промптом, адресация (@бот, ответ боту, имя), изоляция компаний, отсутствие дублей, честный ACK без моделей. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store');
const { createProjectChat } = require('./project-chat');
const cmd = require('./hugh-commands');

const HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 7).toString('base64url')}$${Buffer.alloc(32, 9).toString('base64url')}`;
const requireSession = (request) => { if (!request.session) { const e = new Error('вход'); e.status = 401; throw e; } return request.session; };
const requireCsrf = () => {};
const sendJson = (response, status, payload) => { response.statusCode = status; response.payload = payload; };
const readBody = async (request) => request.body ?? {};

test('разбор команд: свои, с @ботом, чужому боту — нет; адресация по ответу боту, @упоминанию и имени', () => {
  assert.deepEqual(cmd.parseCommand('/plan'), { name: 'plan', target: '', argument: '' });
  assert.deepEqual(cmd.parseCommand('/idea@synapse_sb_bot про море утром', 'synapse_sb_bot'), { name: 'idea', target: 'synapse_sb_bot', argument: 'про море утром' });
  assert.equal(cmd.parseCommand('/plan@other_bot', 'synapse_sb_bot'), null);
  assert.equal(cmd.parseCommand('/bind 123'), null);
  assert.equal(cmd.parseCommand('план на завтра'), null);
  assert.equal(cmd.isAddressed({ text: 'просто разговор' }, 'synapse_sb_bot'), false);
  assert.equal(cmd.isAddressed({ text: 'Хью, что думаешь?' }), true);
  assert.equal(cmd.isAddressed({ text: 'ок', replyToBot: true }), true);
  assert.equal(cmd.isAddressed({ text: '@synapse_sb_bot привет', mentions: ['@synapse_sb_bot'] }, 'synapse_sb_bot'), true);
  assert.equal(cmd.isAddressed({ text: '@other привет', mentions: ['@other'] }, 'synapse_sb_bot'), false);
  for (const text of [cmd.menuText('ТайСабай'), cmd.contentText('ТайСабай', 'https://x/cabinet.html'), cmd.planText('ТайСабай', { items: [] }), cmd.statusText('ТайСабай', { primary: {}, fallback: { configured: false, providers: [] }, queue: {} })]) {
    assert.match(text, /ИИ/); assert.doesNotMatch(text, /token|key=|пароль/i);
  }
  assert.match(cmd.menuText('X'), /через меню они недоступны/);
});

function setup({ crm = null, runtime = { connected: false, state: 'login_required' }, providers = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hugh-commands-'));
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON;');
  const authStore = createAuthStore(db, `vlad:owner:${HASH}`);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const u = String(url); calls.push({ url: u, body: options.body ? JSON.parse(options.body) : null });
    if (u.endsWith('/status')) return { ok: true, status: 200, json: async () => runtime };
    if (u.includes('/autoposting/plan-summary')) { const v = typeof crm === 'function' ? crm(u) : crm; if (!v) throw new Error('down'); return { ok: v.status ? v.status < 400 : true, status: v.status || 200, json: async () => v.payload }; }
    if (u.startsWith('http://hugh-runtime')) return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) };
    const v = providers ? providers(u, calls) : null; if (!v) return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: v } }], model: 'm' }) };
  };
  const env = providers ? { HUGH_FALLBACK_PROVIDERS: 'qwen', HUGH_FALLBACK_QWEN_URL: 'https://qwen.example/v1', HUGH_FALLBACK_QWEN_KEY: 'k', HUGH_FALLBACK_QWEN_MODEL: 'qwen-plus' } : {};
  const chat = createProjectChat({ db, authStore, assetsDir: dir, runnerUrl: 'http://hugh-runtime:8080', chatApiKey: 'secret-key', requireSession, requireCsrf, sendJson, readBody, fetchImpl, statusTtl: 0,
    fallback: { env }, crmUrl: 'http://crm:8080', crmApiKey: 'crm-key', botUsername: 'synapse_sb_bot', cabinetUrl: 'https://synapse.example/cabinet.html' });
  const owner = { user: authStore.getById(1), csrf: 'csrf' };
  const bind = async (code, chatId) => { const response = { statusCode: 0, payload: null, writeHead() {}, end() {} }; await chat.handle({ method: 'PATCH', headers: {}, session: owner, body: { telegramChatId: chatId } }, response, new URL(`http://x/content/project-chat/${code}/settings`)); assert.equal(response.statusCode, 200, JSON.stringify(response.payload)); };
  const assistant = (code) => db.prepare(`SELECT text FROM project_chat_messages WHERE company_code=? AND author_type='assistant' ORDER BY id`).all(code).map((r) => r.text);
  const outbox = () => db.prepare('SELECT * FROM project_chat_outbox ORDER BY id').all();
  return { db, chat, calls, bind, assistant, outbox, owner };
}
let counter = 100;
const command = (chat, chatId, text, name) => chat.bridge.receiveCommand({ chatId, messageId: String(++counter), authorId: '7', authorName: 'Сергей', text, command: name });

test('/hugh и /help отвечают меню без модели; ответ уходит в исходящую очередь Telegram; повтор того же сообщения не дублирует ответ', async () => {
  const s = setup(); await s.bind('taisabai', '-1001');
  const first = await command(s.chat, '-1001', '/hugh', 'hugh');
  assert.equal(first.replied, true); assert.match(first.reply.text, /\/plan/); assert.match(first.reply.text, /через меню они недоступны/);
  assert.equal(s.outbox().length, 1, 'ответ поставлен в очередь отправки существующим мостом');
  const again = await s.chat.bridge.receiveCommand({ chatId: '-1001', messageId: String(counter), authorId: '7', authorName: 'Сергей', text: '/hugh', command: 'hugh' });
  assert.equal(again.duplicate, true); assert.equal(again.replied, false); assert.equal(s.assistant('taisabai').length, 1);
  await command(s.chat, '-1001', '/help@synapse_sb_bot', 'help'); assert.equal(s.assistant('taisabai').length, 2);
  assert.equal(s.calls.filter((c) => c.url.endsWith('/reply') || c.url.includes('qwen')).length, 0, 'модель не вызывалась');
  assert.equal(s.db.prepare('SELECT count(*) n FROM project_chat_ai_jobs').get().n, 0, 'задания модели не создаются');
  await assert.rejects(command(s.chat, '-1009', '/hugh', 'hugh'), (e) => e.status === 404, 'непривязанная группа');
  await assert.rejects(command(s.chat, '-1001', '/plan@other_bot', 'plan'), (e) => e.status === 400, 'команда чужому боту не наша');
});

test('/plan показывает план только своей компании из CRM без подписей; при недоступной CRM — честный ответ', async () => {
  const items = { taisabai: [{ id: 1, dayKey: 'D1', title: 'Это ТайСабай', reviewState: 'approved', status: 'draft', scheduledAt: '2026-09-18T01:00:00.000Z', timezone: 'Asia/Bangkok', mediaKind: 'video' }], alvi: [{ id: 9, dayKey: 'D1', title: 'Секретный план Алви', reviewState: 'draft', status: 'draft', scheduledAt: null, timezone: 'Asia/Irkutsk', mediaKind: 'none' }] };
  let crmDown = false;
  const s = setup({ crm: (u) => { if (crmDown) return null; const code = new URL(u).searchParams.get('companyCode'); return { payload: { companyCode: code, items: items[code] || [] } }; } });
  await s.bind('taisabai', '-1001'); await s.bind('alvi', '-1002');
  const plan = await command(s.chat, '-1001', '/plan', 'plan');
  assert.match(plan.reply.text, /D1 · Это ТайСабай — согласовано; план: 18\.09, 08:00 \(Asia\/Bangkok\)/); assert.doesNotMatch(plan.reply.text, /Алви/);
  assert.match(plan.reply.text, /Плановая дата — не отправка/);
  const crmCall = s.calls.find((c) => c.url.includes('plan-summary')); assert.match(crmCall.url, /companyCode=taisabai/);
  const other = await command(s.chat, '-1002', '/plan', 'plan'); assert.match(other.reply.text, /Секретный план Алви/); assert.doesNotMatch(other.reply.text, /ТайСабай/); assert.match(other.reply.text, /без материала/);
  crmDown = true; const down = await command(s.chat, '-1001', '/plan', 'plan'); assert.match(down.reply.text, /сейчас недоступен: CRM не отвечает/);
});

test('/content объясняет путь исходника; /status честно показывает «не подключён» и «резерв не настроен» без ключей', async () => {
  const s = setup(); await s.bind('palitra-love', '-1003');
  const content = await command(s.chat, '-1003', '/content', 'content'); assert.match(content.reply.text, /Пришлите видео или фото прямо в этот чат/); assert.match(content.reply.text, /synapse\.example\/cabinet\.html/); assert.match(content.reply.text, /сначала согласование владельцем/);
  const status = await command(s.chat, '-1003', '/status', 'status');
  assert.match(status.reply.text, /Резервные модели: не настроены/); assert.match(status.reply.text, /не обещание доступности/); assert.match(status.reply.text, /Очередь этого проекта: ждут ответа 0/);
});

test('/idea ставит вопрос в общую очередь с тем же системным промптом и инструкцией идеи; без моделей — честный ACK; с резервом — одна идея без дублей', async () => {
  const none = setup(); await none.bind('taisabai', '-1001');
  const ack = await command(none.chat, '-1001', '/idea утро у моря', 'idea');
  assert.equal(ack.replied, true); assert.match(ack.reply.text, /поставлен в очередь/); assert.match(ack.reply.text, /Действий по плану не выполнялось/);
  const job = none.db.prepare('SELECT * FROM project_chat_ai_jobs').get(); assert.ok(job, 'задание модели создано');
  await none.chat.processAIJobs(); assert.equal(none.db.prepare('SELECT status FROM project_chat_ai_jobs').get().status, 'blocked', 'ждёт, не сгорает');
  const s = setup({ providers: (u, calls) => (u.includes('qwen') ? 'Идея: тихое утро, хук — волна в первые 3 секунды. Это предложение для обсуждения.' : null) });
  await s.bind('taisabai', '-1001');
  const queued = await command(s.chat, '-1001', '/idea@synapse_sb_bot', 'idea');
  assert.equal(queued.replied, false, 'резерв доступен — немедленный ACK не нужен');
  await s.chat.processAIJobs(); await s.chat.processAIJobs();
  assert.deepEqual(s.assistant('taisabai'), ['Идея: тихое утро, хук — волна в первые 3 секунды. Это предложение для обсуждения.']);
  const sent = s.calls.find((c) => c.url.includes('qwen')).body;
  assert.match(sent.messages[0].content, /Хью, бизнес-ассистент Синапс Бизнес/); assert.match(sent.messages[0].content, /командой \/idea/); assert.match(sent.messages[0].content, /Без призывов купить/);
  // обычное сообщение без обращения не трогает модель; ответ боту — обращение
  s.chat.bridge.receiveTelegram({ chatId: '-1001', messageId: '900', authorId: '7', authorName: 'Сергей', text: 'обсуждаем между собой' });
  assert.equal(s.db.prepare('SELECT count(*) n FROM project_chat_ai_jobs').get().n, 1);
  s.chat.bridge.receiveTelegram({ chatId: '-1001', messageId: '901', authorId: '7', authorName: 'Сергей', text: 'а можно короче?', addressed: true });
  assert.equal(s.db.prepare('SELECT count(*) n FROM project_chat_ai_jobs').get().n, 2);
});

test('надёжность ответа на команду: повтор того же update после сбоя между входящим и ответом доводит ответ ровно один раз', async () => {
  const s = setup(); await s.bind('taisabai', '-1001');
  const first = await command(s.chat, '-1001', '/help', 'help');
  assert.equal(first.replied, true); assert.equal(s.assistant('taisabai').length, 1);
  // сбой до ответа: ожидающая запись осталась pending, ответа нет — повтор update завершает её
  s.db.prepare("UPDATE project_chat_command_replies SET state='pending', reply_message_id=NULL WHERE message_id=?").run(String(counter));
  s.db.prepare('DELETE FROM project_chat_outbox').run(); s.db.prepare("DELETE FROM project_chat_messages WHERE author_type='assistant'").run();
  const retry = await s.chat.bridge.receiveCommand({ chatId: '-1001', messageId: String(counter), authorId: '7', authorName: 'Сергей', text: '/help', command: 'help' });
  assert.equal(retry.duplicate, true); assert.equal(retry.replied, true); assert.equal(s.assistant('taisabai').length, 1); assert.equal(s.outbox().length, 1);
  const third = await s.chat.bridge.receiveCommand({ chatId: '-1001', messageId: String(counter), authorId: '7', authorName: 'Сергей', text: '/help', command: 'help' });
  assert.equal(third.replied, false); assert.equal(third.replyMessageId, s.assistant('taisabai').length && s.db.prepare("SELECT id FROM project_chat_messages WHERE author_type='assistant'").get().id);
  assert.equal(s.assistant('taisabai').length, 1, 'после done второго ответа нет');
  assert.doesNotMatch(cmd.contentText('X', 'u'), /попадёт в карточку плана/);
});
