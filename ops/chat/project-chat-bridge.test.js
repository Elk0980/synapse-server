'use strict';

/* Мост Telegram ↔ комната проекта: очередь событий, классификация отказов, части доставки.
   Только встроенные модули Node: node --test ops/chat/project-chat-bridge.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');
const { createProjectChatBridge } = require('./project-chat-bridge');
const { parseQuietHours } = require('./quiet-hours');

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 1)]);
const CONTENT = 'http://content:8080';
const PREFIX = '/content/internal/project-chat';
const json = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });

function setup({ rooms = {}, jobs = [], files = {}, telegram = () => ({ result: { message_id: 500 } }),
  contentUrl = CONTENT, apiKey = 'secret', content = null, now = () => new Date('2026-09-17T12:00:00Z'),
  db = new DatabaseSync(':memory:') } = {}) {
  const calls = { content: [], telegram: [], legacy: [], files: 0 };
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('https://api.telegram.org/file/')) {
      calls.files += 1;
      return { ok: true, status: 200, body: Readable.from([PNG]) };
    }
    if (target.startsWith('https://api.telegram.org/bot')) {
      const method = target.split('/').pop();
      calls.telegram.push({ method, body: options.body });
      const outcome = telegram(method, options.body, calls.telegram.length);
      if (outcome instanceof Error) throw outcome;
      if (outcome.broken) return { ok: true, status: 200, json: async () => { throw new Error('не JSON'); } };
      if (outcome.status && outcome.status >= 400) {
        return { ok: false, status: outcome.status, json: async () => ({ ok: false, description: outcome.description || 'ошибка' }) };
      }
      return json({ ok: true, result: outcome.result || { message_id: 500 } });
    }
    const route = target.slice(target.indexOf(PREFIX) + PREFIX.length);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.content.push({ route: route.split('?')[0], query: Object.fromEntries(new URL(target).searchParams), body });
    if (content) { const custom = content(route, body); if (custom) return custom; }
    if (route.startsWith('/binding')) return json({ room: rooms[new URL(target).searchParams.get('chatId')] || null });
    if (route.startsWith('/outbox')) return json({ jobs: jobs.length ? [jobs.shift()] : [] });
    if (route.startsWith('/attachment')) return json(files[new URL(target).searchParams.get('id')] || {});
    if (route.startsWith('/migrate')) return json({ ok: true, migrated: true });
    if (route.startsWith('/receive')) return json({ message: { id: 1 }, duplicate: false });
    if (route.startsWith('/acknowledge')) return json({ ok: true });
    return json({ error: 'нет маршрута' }, 404);
  };
  const bridge = createProjectChatBridge({ db, contentUrl, apiKey, telegramToken: 'bot-token',
    legacyHandler: async (update) => { calls.legacy.push(update); }, fetchImpl,
    quietHours: parseQuietHours({}), now });
  return { db, bridge, calls };
}

const groupUpdate = (id, message) => ({ update_id: id,
  message: { message_id: id * 10, chat: { id: -1001, type: 'supergroup' }, from: { id: 777, first_name: 'Дарья' }, ...message } });
const ROOMS = { '-1001': { companyCode: 'palitra-love', title: 'Palitra' } };
const routes = (calls) => calls.content.map((c) => c.route);

test('в очередь попадают только групповые события и только при настроенной комнате', () => {
  const { db, bridge } = setup();
  assert.equal(bridge.enqueue(groupUpdate(1, { text: 'Привет' })), true);
  assert.equal(bridge.enqueue(groupUpdate(1, { text: 'Привет' })), true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_telegram_inbox').get().n, 1, 'дубль update_id не создаёт второй записи');
  assert.equal(bridge.enqueue({ update_id: 2, message: { chat: { id: 5, type: 'private' }, text: 'Привет' } }), false);
  assert.equal(bridge.enqueue({ update_id: 3, edited_message: { chat: { id: -1001, type: 'group' } } }), false);
  assert.throws(() => bridge.enqueue({ update_id: 1.5, message: { chat: { type: 'group' } } }), /Некорректный номер/);
  const off = setup({ contentUrl: '' });
  assert.equal(off.bridge.enqueue(groupUpdate(4, { text: 'Привет' })), false, 'без адреса комнаты событие остаётся прежнему обработчику');
  const noKey = setup({ apiKey: '' });
  assert.equal(noKey.bridge.enqueue(groupUpdate(5, { text: 'Привет' })), false);
});

test('свои и чужие боты не попадают в комнату и не вызывают ответ', async () => {
  const { bridge, calls } = setup({ rooms: ROOMS });
  await bridge.receive(groupUpdate(1, { text: 'Хью, ответь', from: { id: 42, is_bot: true, first_name: 'Бот' } }));
  assert.deepEqual(routes(calls), []);
  assert.equal(calls.legacy.length, 0);
});

test('непривязанная группа и команды остаются прежнему обработчику', async () => {
  const { bridge, calls } = setup({ rooms: ROOMS });
  await bridge.receive({ update_id: 9, message: { message_id: 90, chat: { id: -2002, type: 'group' }, from: { id: 1, first_name: 'Аня' }, text: 'Привет' } });
  assert.equal(calls.legacy.length, 1);
  await bridge.receive(groupUpdate(2, { text: '/привязать palitra' }));
  assert.equal(calls.legacy.length, 2);
  assert.ok(!routes(calls).includes('/receive'), 'команда не сохраняется как сообщение проекта');
});

test('перенос группы в супергруппу сохраняет привязку без сообщения', async () => {
  const { bridge, calls } = setup({ rooms: ROOMS });
  await bridge.receive(groupUpdate(3, { migrate_to_chat_id: -1009 }));
  const migrate = calls.content.find((c) => c.route === '/migrate');
  assert.deepEqual(migrate.body, { chatId: '-1001', newChatId: '-1009' });
  assert.ok(!routes(calls).includes('/receive'));
  const created = setup({ rooms: {} });
  await created.bridge.receive({ update_id: 4, message: { message_id: 40, chat: { id: -1009, type: 'supergroup' },
    from: { id: 1, first_name: 'Аня' }, migrate_from_chat_id: -1001 } });
  assert.deepEqual(created.calls.content.find((c) => c.route === '/migrate').body, { chatId: '-1001', newChatId: '-1009' });
  assert.equal(created.calls.legacy.length, 0);
});

test('фото из группы доходит до комнаты вместе с автором', async () => {
  const { bridge, calls } = setup({ rooms: ROOMS, telegram: () => ({ result: { file_path: 'photos/a.jpg', file_size: PNG.length } }) });
  await bridge.receive(groupUpdate(5, { photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'big', file_size: PNG.length }], caption: 'Витрина' }));
  const received = calls.content.find((c) => c.route === '/receive');
  assert.equal(received.body.chatId, '-1001');
  assert.equal(received.body.messageId, '50');
  assert.equal(received.body.authorName, 'Дарья');
  assert.equal(received.body.text, 'Витрина');
  assert.equal(received.body.files.length, 1);
  assert.equal(Buffer.from(received.body.files[0].base64, 'base64').equals(PNG), true);
  assert.equal(calls.files, 1);
});

test('неподдерживаемый или слишком большой файл заменяется пометкой, а не исчезает', async () => {
  const { bridge, calls } = setup({ rooms: ROOMS });
  await bridge.receive(groupUpdate(6, { document: { file_id: 'zip', mime_type: 'application/zip', file_size: 100 }, caption: 'Архив' }));
  const received = calls.content.find((c) => c.route === '/receive');
  assert.equal(received.body.files.length, 0);
  assert.ok(received.body.text.includes('Архив'));
  assert.ok(received.body.text.includes('Вложение доступно в Telegram'));
});

test('отказ Telegram различает повторяемый, окончательный и неизвестный результат', async () => {
  const job = { id: 11, companyCode: 'palitra-love', chatId: '-1001', text: 'Привет', authorName: 'Дарья', authorType: 'human', attachments: [] };
  const definite = setup({ telegram: () => ({ status: 400, description: 'chat not found' }) });
  const first = await definite.bridge.delivery({ ...job });
  assert.equal(first.ok, false);
  assert.equal(first.uncertain, false);
  assert.equal(first.retryable, false);
  assert.ok(first.error.includes('chat not found'));
  const forbidden = setup({ telegram: () => ({ status: 403, description: 'bot was kicked' }) });
  assert.deepEqual(await forbidden.bridge.delivery({ ...job, id: 111 }), {
    ok: false, uncertain: false, retryable: false,
    error: 'Telegram: 403 — bot was kicked', externalMessageIds: [],
  });
  const limited = setup({ telegram: () => ({ status: 429, description: 'Too Many Requests' }) });
  const second = await limited.bridge.delivery({ ...job, id: 12 });
  assert.equal(second.retryable, true);
  assert.equal(second.uncertain, false);
  const broken = setup({ telegram: () => new Error('сеть недоступна') });
  const third = await broken.bridge.delivery({ ...job, id: 13 });
  assert.equal(third.uncertain, true);
  assert.equal(third.retryable, false);
  // Неизвестный результат не повторяется: часть могла уйти в группу.
  const fourth = await broken.bridge.delivery({ ...job, id: 13 });
  assert.equal(fourth.uncertain, true);
  assert.equal(broken.calls.telegram.length, 1, 'повторной отправки не было');
});

test('5xx, нечитаемый ответ и ответ без номера сообщения считаются неизвестным результатом', async () => {
  const job = { id: 14, companyCode: 'palitra-love', chatId: '-1001', text: 'Привет', authorName: 'Дарья', authorType: 'human', attachments: [] };
  for (const [name, outcome] of [
    ['5xx', { status: 500, description: 'Bad Gateway' }],
    ['5xx c ok:false', { status: 503, description: 'Service Unavailable' }],
    ['нечитаемый ответ', { broken: true }],
    ['ответ без message_id', { result: { chat: { id: -1001 } } }],
  ]) {
    const { bridge, calls } = setup({ telegram: () => outcome });
    const result = await bridge.delivery({ ...job });
    assert.equal(result.uncertain, true, `${name}: результат неизвестен`);
    assert.notEqual(result.retryable, true, `${name}: автоповтор запрещён`);
    assert.equal(result.ok, false);
    // Часть могла уйти в группу: следующая попытка не отправляет её снова.
    const again = await bridge.delivery({ ...job });
    assert.equal(again.uncertain, true);
    assert.equal(calls.telegram.length, 1, `${name}: повторной отправки не было`);
  }
});

test('подтверждённые части не отправляются повторно', async () => {
  let failPhoto = true;
  const { bridge, calls } = setup({
    files: { 7: { name: 'photo.png', mime: 'image/png', base64: PNG.toString('base64') } },
    telegram: (method) => {
      // 429 — единственный определённый отказ, который безопасно повторить.
      if (method === 'sendPhoto' && failPhoto) return { status: 429, description: 'Too Many Requests' };
      return { result: { message_id: method === 'sendPhoto' ? 601 : 600 } };
    },
  });
  const job = { id: 21, companyCode: 'palitra-love', chatId: '-1001', text: 'Афиша готова',
    authorName: 'Дарья', authorType: 'human', attachments: [{ id: 7, name: 'photo.png', mime: 'image/png' }] };
  const first = await bridge.delivery(job);
  assert.equal(first.ok, false);
  assert.equal(first.retryable, true);
  assert.deepEqual(first.externalMessageIds, ['600']);
  failPhoto = false;
  const second = await bridge.delivery(job);
  assert.equal(second.ok, true);
  assert.deepEqual(second.externalMessageIds, ['600', '601']);
  assert.equal(calls.telegram.filter((c) => c.method === 'sendMessage').length, 1, 'текст отправлен один раз');
  assert.equal(calls.telegram.filter((c) => c.method === 'sendPhoto').length, 2);
});

test('такт моста берёт задания по одному и подтверждает каждое', async () => {
  const base = { companyCode: 'palitra-love', chatId: '-1001', authorName: 'Хью', authorType: 'assistant', attachments: [] };
  const { bridge, calls } = setup({ rooms: ROOMS, jobs: [{ id: 31, text: 'Первый', ...base }, { id: 32, text: 'Второй', ...base }] });
  await bridge.tick();
  // Ответ ИИ уходит в группу с постоянной подписью бота, а не под именем человека.
  assert.ok(JSON.parse(calls.telegram[0].body).text.startsWith('Хью, бизнес-ассистент Синапс Бизнес (ИИ)\nПервый'));
  const acknowledged = calls.content.filter((c) => c.route === '/acknowledge');
  assert.deepEqual(acknowledged.map((c) => c.body.jobId), [31, 32]);
  assert.equal(acknowledged[0].body.ok, true);
  assert.deepEqual(acknowledged[0].body.externalMessageIds, ['500']);
  assert.equal(calls.content.filter((c) => c.route === '/outbox').length, 3, 'пустой ответ останавливает опрос');
});

test('заявка с сайта: строковый id order:<n> доставляется в личный чат, подтверждается тем же id и не повторяется после неизвестного результата', async () => {
  const orderJob = (id) => ({ id, text: 'Заявка №7 · Palitra', companyCode: 'palitra-love', chatId: '123456789', authorName: 'Заявка с сайта', authorType: 'system', attachments: [] });
  const { bridge, calls } = setup({ jobs: [orderJob('order:7')] });
  await bridge.tick();
  const sent = calls.telegram.filter((c) => c.method === 'sendMessage');
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].body), { chat_id: '123456789', text: 'Заявка с сайта\nЗаявка №7 · Palitra' });
  const acknowledged = calls.content.filter((c) => c.route === '/acknowledge');
  assert.deepEqual(acknowledged.map((c) => [c.body.jobId, c.body.ok, c.body.externalMessageIds]), [['order:7', true, ['500']]], 'id остаётся строкой');
  // Обрыв после отправки: результат неизвестен, подтверждение говорит об этом, второй отправки нет.
  const broken = setup({ jobs: [orderJob('order:8')], telegram: () => ({ broken: true }) });
  await broken.bridge.tick();
  await broken.bridge.tick();
  assert.equal(broken.calls.telegram.filter((c) => c.method === 'sendMessage').length, 1);
  const uncertain = broken.calls.content.filter((c) => c.route === '/acknowledge');
  assert.equal(uncertain.length, 1);
  assert.deepEqual([uncertain[0].body.jobId, uncertain[0].body.ok, uncertain[0].body.uncertain], ['order:8', false, true]);
});

test('недоступность комнаты не теряет входящие: событие ждёт сколько нужно', async () => {
  let offline = true;
  const { db, bridge, calls } = setup({ rooms: ROOMS,
    content: (route) => (offline && route.startsWith('/binding') ? json({ error: 'сбой' }, 503) : null) });
  bridge.enqueue(groupUpdate(41, { text: 'Первое' }));
  bridge.enqueue(groupUpdate(42, { text: 'Второе' }));
  for (let attempt = 0; attempt < 15; attempt++) {
    db.prepare('UPDATE project_telegram_inbox SET retry_at=0').run();
    await bridge.tick();
  }
  const waiting = db.prepare('SELECT update_id,state,attempts,body FROM project_telegram_inbox ORDER BY update_id').all();
  assert.deepEqual(waiting.map((row) => row.state), ['pending', 'pending'], 'временный сбой не отбрасывает событие');
  assert.ok(waiting[0].attempts >= 10, 'попытки продолжаются');
  assert.ok(waiting[0].body.includes('Первое'), 'тело события сохранено для повтора');
  assert.equal(calls.content.filter((c) => c.route === '/receive').length, 0);
  offline = false;
  db.prepare('UPDATE project_telegram_inbox SET retry_at=0').run();
  await bridge.tick();
  const received = calls.content.filter((c) => c.route === '/receive');
  assert.deepEqual(received.map((c) => c.body.text), ['Первое', 'Второе'], 'после восстановления порядок сохранён');
  assert.deepEqual(db.prepare("SELECT count(*) AS n FROM project_telegram_inbox WHERE state='done'").get().n, 2);
});

test('отказ комнаты по содержимому завершается разбираемо и с возвратом вручную', async () => {
  const { db, bridge } = setup({ rooms: ROOMS,
    content: (route) => (route.startsWith('/receive') ? json({ error: 'Некорректное событие' }, 400) : null) });
  bridge.enqueue(groupUpdate(51, { text: 'Плохое событие' }));
  await bridge.tick();
  const row = db.prepare('SELECT * FROM project_telegram_inbox WHERE update_id=51').get();
  assert.equal(row.state, 'failed');
  assert.ok(row.error.includes('400'));
  assert.ok(row.body.includes('Плохое событие'), 'тело сохранено для разбора владельцем');
  assert.deepEqual(bridge.failedInbox().map((item) => Number(item.update_id)), [51]);
  assert.deepEqual(bridge.retryInbox(51), { ok: true });
  assert.equal(db.prepare('SELECT state FROM project_telegram_inbox WHERE update_id=51').get().state, 'pending');
  assert.deepEqual(bridge.retryInbox(99), { ok: false });
  // Совсем неразбираемое тело не остаётся в очереди навсегда.
  db.prepare("INSERT INTO project_telegram_inbox(update_id,body) VALUES (52,'{не json')").run();
  await bridge.tick();
  assert.equal(db.prepare('SELECT state FROM project_telegram_inbox WHERE update_id=52').get().state, 'failed');
});

test('сбой одной группы не задерживает события другой', async () => {
  const { db, bridge, calls } = setup({
    rooms: { '-1001': { companyCode: 'palitra-love' }, '-2002': { companyCode: 'alvi' } },
    content: (route) => (route.includes('chatId=-1001') ? json({ error: 'сбой' }, 503) : null),
  });
  bridge.enqueue(groupUpdate(61, { text: 'Из первой группы' }));
  bridge.enqueue({ update_id: 62, message: { message_id: 620, chat: { id: -1001, type: 'supergroup' }, from: { id: 1, first_name: 'Дарья' }, text: 'Следом за сбоем' } });
  bridge.enqueue({ update_id: 63, message: { message_id: 630, chat: { id: -2002, type: 'supergroup' }, from: { id: 2, first_name: 'Анна' }, text: 'Из второй группы' } });
  await bridge.tick();
  const received = calls.content.filter((c) => c.route === '/receive');
  assert.deepEqual(received.map((c) => c.body.text), ['Из второй группы']);
  const states = db.prepare('SELECT update_id,state FROM project_telegram_inbox ORDER BY update_id').all();
  assert.deepEqual(states.map((row) => `${row.update_id}:${row.state}`), ['61:pending', '62:pending', '63:done']);
});

test('вложение, не принятое комнатой, не уносит с собой подпись', async () => {
  const { bridge, calls } = setup({ rooms: ROOMS,
    telegram: () => ({ result: { file_path: 'photos/a.jpg', file_size: PNG.length } }),
    content: (route, body) => (route.startsWith('/receive') && body.files?.length ? json({ error: 'Не распознан' }, 415) : null) });
  await bridge.receive(groupUpdate(71, { photo: [{ file_id: 'big', file_size: PNG.length }], caption: 'Смотрите афишу' }));
  const received = calls.content.filter((c) => c.route === '/receive');
  assert.equal(received.length, 2, 'после отказа по файлу событие уходит без него');
  assert.deepEqual(received[1].body.files, []);
  assert.ok(received[1].body.text.startsWith('Смотрите афишу'));
  assert.ok(received[1].body.text.includes('Вложение не принято'));
  assert.equal(received[1].body.messageId, received[0].body.messageId, 'то же событие, без дубля');
});

test('окончательный отказ Telegram по файлу не зацикливает событие и сохраняет подпись', async () => {
  const { db, bridge, calls } = setup({ rooms: ROOMS, telegram: () => ({ status: 400, description: 'file is too big' }) });
  bridge.enqueue(groupUpdate(91, { photo: [{ file_id: 'big', file_size: 1024 }], caption: 'Афиша' }));
  await bridge.tick();
  const received = calls.content.find((c) => c.route === '/receive');
  assert.equal(received.body.files.length, 0);
  assert.ok(received.body.text.startsWith('Афиша'));
  assert.ok(received.body.text.includes('недоступно боту'));
  assert.equal(db.prepare('SELECT state FROM project_telegram_inbox WHERE update_id=91').get().state, 'done');
});

test('тихие часы бота действуют и в общем чате проекта: текст, фото и документ', async () => {
  const quiet = new Date('2026-09-17T23:30:00+03:00');
  const day = new Date('2026-09-17T12:30:00+03:00');
  const files = { 7: { name: 'photo.png', mime: 'image/png', base64: PNG.toString('base64') },
    8: { name: 'doc.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.4').toString('base64') } };
  const job = (id) => ({ id, companyCode: 'palitra-love', chatId: '-1001', text: 'Афиша',
    authorName: 'Дарья', authorType: 'human',
    attachments: [{ id: 7, name: 'photo.png', mime: 'image/png' }, { id: 8, name: 'doc.pdf', mime: 'application/pdf' }] });
  const night = setup({ files, now: () => quiet });
  assert.equal((await night.bridge.delivery(job(81))).ok, true);
  const sent = night.calls.telegram;
  assert.equal(JSON.parse(sent[0].body).disable_notification, true, 'ночью текст приходит без звука');
  for (const call of sent.slice(1)) {
    assert.equal(call.body.get('disable_notification'), 'true', `${call.method} ночью без звука`);
  }
  const noon = setup({ files, now: () => day });
  assert.equal((await noon.bridge.delivery(job(82))).ok, true);
  assert.equal(JSON.parse(noon.calls.telegram[0].body).disable_notification, undefined, 'днём звук не глушится');
  for (const call of noon.calls.telegram.slice(1)) {
    assert.equal(call.body.get('disable_notification'), null);
  }
});

test('старейшее событие группы держит очередь и во время паузы повтора', async () => {
  let offline = true;
  const { db, bridge, calls } = setup({
    rooms: { '-1001': { companyCode: 'palitra-love' }, '-2002': { companyCode: 'alvi' } },
    content: (route) => (offline && route.includes('chatId=-1001') ? json({ error: 'сбой' }, 503) : null),
  });
  bridge.enqueue(groupUpdate(101, { text: 'Первое' }));
  bridge.enqueue(groupUpdate(102, { text: 'Второе' }));
  bridge.enqueue({ update_id: 103, message: { message_id: 1030, chat: { id: -2002, type: 'supergroup' }, from: { id: 2, first_name: 'Анна' }, text: 'Другая группа' } });
  await bridge.tick();
  // Второй такт без правки retry_at: пауза повтора первого события ещё идёт.
  await bridge.tick();
  assert.deepEqual(calls.content.filter((c) => c.route === '/receive').map((c) => c.body.text),
    ['Другая группа'], 'второе событие группы не обгоняет первое');
  assert.deepEqual(db.prepare('SELECT update_id,state FROM project_telegram_inbox ORDER BY update_id').all()
    .map((row) => `${row.update_id}:${row.state}`), ['101:pending', '102:pending', '103:done']);
  assert.equal(db.prepare('SELECT attempts FROM project_telegram_inbox WHERE update_id=101').get().attempts, 1,
    'во время паузы событие не повторяется');
  offline = false;
  db.prepare('UPDATE project_telegram_inbox SET retry_at=0').run();
  await bridge.tick();
  assert.deepEqual(calls.content.filter((c) => c.route === '/receive').map((c) => c.body.text),
    ['Другая группа', 'Первое', 'Второе'], 'порядок внутри группы сохранён');
  assert.equal(db.prepare("SELECT count(*) AS n FROM project_telegram_inbox WHERE state='done'").get().n, 3);
});

test('подтверждение доставки переживает недоступность комнаты и перезапуск', async () => {
  let ackDown = true;
  const job = { id: 41, text: 'Ответ Хью', companyCode: 'palitra-love', chatId: '-1001',
    authorName: 'Хью', authorType: 'assistant', attachments: [] };
  const { db, bridge, calls } = setup({ jobs: [job],
    content: (route) => (ackDown && route.startsWith('/acknowledge') ? json({ error: 'сбой' }, 503) : null) });
  await bridge.tick();
  assert.equal(calls.telegram.filter((c) => c.method === 'sendMessage').length, 1);
  const queued = bridge.pendingAcks();
  assert.equal(queued.length, 1, 'известный исход сохранён до обращения к комнате');
  assert.equal(queued[0].jobId, 41);
  assert.deepEqual(queued[0].result, { ok: true, externalMessageIds: ['500'] });
  // Пока результат не возвращён, новые задания не забираются и Telegram не трогается.
  await bridge.tick();
  assert.equal(calls.telegram.length, 1, 'повторной отправки в Telegram не было');
  assert.equal(calls.content.filter((c) => c.route === '/outbox').length, 1, 'новое задание не забирается');
  ackDown = false;
  db.prepare('UPDATE project_telegram_ack SET retry_at=0').run();
  // Перезапуск процесса: очередь подтверждений хранится в базе, а не в памяти.
  const restarted = setup({ db });
  await restarted.bridge.tick();
  const replayed = restarted.calls.content.filter((c) => c.route === '/acknowledge');
  assert.equal(replayed.length, 1);
  assert.deepEqual(replayed[0].body, { jobId: 41, ok: true, externalMessageIds: ['500'] },
    'исход и внешние идентификаторы повторены без изменений');
  assert.equal(restarted.calls.telegram.length, 0, 'повтор подтверждения ничего не отправляет в Telegram');
  assert.deepEqual(bridge.pendingAcks(), []);
});

test('подтверждение безопасного повтора 429 повторяется тем же результатом', async () => {
  let ackDown = true;
  const { db, bridge, calls } = setup({
    jobs: [{ id: 51, text: 'Афиша', companyCode: 'palitra-love', chatId: '-1001',
      authorName: 'Дарья', authorType: 'human', attachments: [] }],
    telegram: () => ({ status: 429, description: 'Too Many Requests' }),
    content: (route) => (ackDown && route.startsWith('/acknowledge') ? json({ error: 'сбой' }, 503) : null),
  });
  await bridge.tick();
  const queued = bridge.pendingAcks();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].result.ok, false);
  assert.equal(queued[0].result.retryable, true);
  assert.equal(queued[0].result.uncertain, false);
  ackDown = false;
  db.prepare('UPDATE project_telegram_ack SET retry_at=0').run();
  await bridge.tick();
  const acks = calls.content.filter((c) => c.route === '/acknowledge');
  assert.equal(acks.length, 2, 'подтверждение повторено после восстановления комнаты');
  assert.deepEqual(acks[1].body, acks[0].body, 'тот же результат без изменений');
  assert.equal(acks[1].body.retryable, true);
  assert.equal(calls.telegram.length, 1, 'сообщение не отправлено в Telegram повторно');
  assert.deepEqual(bridge.pendingAcks(), []);
});

test('неизвестный результат отправки подтверждается как неизвестный и не повторяется', async () => {
  let ackDown = true;
  const { db, bridge, calls } = setup({
    jobs: [{ id: 61, text: 'Сообщение', companyCode: 'palitra-love', chatId: '-1001',
      authorName: 'Дарья', authorType: 'human', attachments: [] }],
    telegram: () => new Error('обрыв сети'),
    content: (route) => (ackDown && route.startsWith('/acknowledge') ? json({ error: 'сбой' }, 503) : null),
  });
  await bridge.tick();
  assert.equal(bridge.pendingAcks()[0].result.uncertain, true);
  assert.notEqual(bridge.pendingAcks()[0].result.retryable, true);
  ackDown = false;
  db.prepare('UPDATE project_telegram_ack SET retry_at=0').run();
  await bridge.tick();
  const ack = calls.content.filter((c) => c.route === '/acknowledge').at(-1).body;
  assert.equal(ack.uncertain, true);
  assert.notEqual(ack.retryable, true);
  assert.equal(calls.telegram.length, 1, 'неизвестный результат не приводит к повторной отправке');
  assert.deepEqual(bridge.pendingAcks(), []);
});

test('подтверждение неизвестной комнате отправки не остаётся в очереди навсегда', async () => {
  const { bridge, calls } = setup({
    jobs: [{ id: 71, text: 'Сообщение', companyCode: 'palitra-love', chatId: '-1001',
      authorName: 'Дарья', authorType: 'human', attachments: [] }],
    content: (route) => (route.startsWith('/acknowledge') ? json({ error: 'Отправка не найдена' }, 404) : null),
  });
  await bridge.tick();
  assert.deepEqual(bridge.pendingAcks(), [], 'окончательный отказ комнаты снимает подтверждение с очереди');
  assert.equal(calls.telegram.length, 1);
});

test('offset Telegram переживает перезапуск процесса', () => {
  const { bridge } = setup();
  assert.equal(bridge.getOffset(), undefined);
  bridge.saveOffset(120);
  bridge.saveOffset(121);
  assert.equal(bridge.getOffset(), 121);
});
