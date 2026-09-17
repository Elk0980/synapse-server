const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const preview = require('./project-chat-preview.cjs');

const CABINET = path.join(__dirname, '..', '..', 'sites', 'synapse', 'cabinet');
let server;
let base;

const call = (route, options = {}) => fetch(base + route, {
  ...options,
  headers: { 'X-CSRF-Token': preview.CSRF, ...(options.headers || {}) }
});
const json = async (route, options) => {
  const response = await call(route, options);
  return { status: response.status, body: await response.json() };
};
const post = (route, payload) => json(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
const reset = async (state = {}) => {
  await post('/preview/reset', {});
  await post('/preview/state', { role: 'owner', ai: 'connected', access: 'granted', ...state });
};

test.before(async () => {
  server = preview.createPreviewServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  // Keep-alive соединения fetch иначе не дают серверу закрыться.
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

test('предпросмотр отвечает только с этого компьютера и знает свой порт', () => {
  assert.equal(preview.isLoopback('127.0.0.1'), true);
  assert.equal(preview.isLoopback('::1'), true);
  assert.equal(preview.isLoopback('203.0.113.5'), false);
  assert.equal(preview.allowedHost('127.0.0.1:8787'), true);
  assert.equal(preview.allowedHost('localhost:8787'), true);
  assert.equal(preview.allowedHost('synapse.synapsebusiness.ru'), false);
  assert.equal(preview.readPort(['--port', '9000'], {}), 9000);
  assert.equal(preview.readPort([], { PROJECT_CHAT_PREVIEW_PORT: '9100' }), 9100);
  assert.equal(preview.readPort(['--port', 'нет'], {}), 8787);
});

test('страница отдаёт настоящие файлы кабинета и помечена как фикстура', async () => {
  await reset();
  const page = await call('/');
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  for (const asset of ['/cabinet/hugh.js', '/cabinet/project-chat.js', '/cabinet/project-chat.css', '/cabinet/common.css']) {
    assert.ok(html.includes(asset), 'страница должна подключать ' + asset);
  }
  assert.match(html, /Локальный предпросмотр/);
  assert.match(html, /вымышленные/);
  const script = await call('/cabinet/project-chat.js');
  assert.equal(await script.text(), fs.readFileSync(path.join(CABINET, 'project-chat.js'), 'utf8'));
  const styles = await call('/cabinet/project-chat.css');
  assert.equal(await styles.text(), fs.readFileSync(path.join(CABINET, 'project-chat.css'), 'utf8'));
  assert.equal((await call('/cabinet/../../.env')).status, 404);
  assert.equal((await call('/cabinet/settings.js')).status, 404);
});

test('снимок отдаёт последнюю страницу переписки, задачи, этапы и участников', async () => {
  await reset();
  const { status, body } = await json('/content/project-chat/palitra-love');
  assert.equal(status, 200);
  assert.equal(body.messages.length, preview.PAGE);
  assert.equal(body.hasMore, true);
  assert.equal(body.oldestMessageId, body.messages[0].id);
  const times = body.messages.map((message) => Date.parse(message.createdAt));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.deepEqual(body.access, { canReply: true, owner: true });
  assert.deepEqual(body.members.map((member) => member.userId), [1, 2, 3]);
  assert.ok(body.members.every((member) => /образец/i.test(member.displayName)));
  assert.equal(body.tasks.length, 3);
  assert.equal(body.stages.length, 3);
  assert.equal(body.ai.connected, true);
  const older = await json('/content/project-chat/palitra-love/messages?before=' + body.oldestMessageId + '&limit=100');
  const files = [...older.body.messages, ...body.messages].flatMap((message) => message.attachments);
  assert.ok(files.some((file) => file.mime === 'image/png' && file.url.startsWith('/content/project-chat/palitra-love/attachments/')));
  assert.ok(files.some((file) => file.mime === 'application/pdf'));
  assert.ok(files.some((file) => file.url === null && file.note));
});

test('более ранняя страница отдаётся по before и не пересекается с новой', async () => {
  await reset();
  const first = await json('/content/project-chat/palitra-love');
  const older = await json('/content/project-chat/palitra-love/messages?before=' + first.body.oldestMessageId + '&limit=100');
  assert.equal(older.status, 200);
  assert.equal(older.body.messages.length, 6);
  assert.equal(older.body.hasMore, false);
  assert.equal(older.body.oldestMessageId, 'm1');
  const newer = new Set(first.body.messages.map((message) => message.id));
  assert.ok(older.body.messages.every((message) => !newer.has(message.id)));
});

test('комната другой компании не показывает переписку и файлы Палитры', async () => {
  await reset();
  const alvi = await json('/content/project-chat/alvi');
  assert.equal(alvi.status, 200);
  assert.equal(alvi.body.messages.length, 2);
  assert.ok(alvi.body.messages.every((message) => !/переговорн|смет/i.test(message.text)));
  assert.deepEqual(alvi.body.members.map((member) => member.userId), [1, 3]);
  assert.equal((await call('/content/project-chat/alvi/attachments/file-1')).status, 404);
  assert.equal((await call('/content/project-chat/palitra-love/attachments/file-1')).status, 200);
});

test('запись без фикстурного CSRF не проходит', async () => {
  await reset();
  const response = await fetch(base + '/content/project-chat/palitra-love/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'без токена' })
  });
  assert.equal(response.status, 403);
});

test('повтор с тем же clientMessageId не создаёт второе сообщение', async () => {
  await reset();
  const payload = { text: 'Образец: проверка повтора', attachmentIds: [], clientMessageId: 'preview-client-1' };
  const first = await post('/content/project-chat/palitra-love/messages', payload);
  const second = await post('/content/project-chat/palitra-love/messages', payload);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.message.id, first.body.message.id);
  const snapshot = await json('/content/project-chat/palitra-love');
  assert.equal(snapshot.body.messages.filter((message) => message.clientMessageId === 'preview-client-1').length, 1);
  const empty = await post('/content/project-chat/palitra-love/messages', { text: '  ', attachmentIds: [], clientMessageId: 'preview-client-2' });
  assert.equal(empty.status, 400);
});

test('фотография загружается, возвращается с тем же типом и не видна другой компании', async () => {
  await reset();
  const bytes = preview.samplePng(8, 8, () => [10, 120, 200]);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const upload = await json('/content/project-chat/palitra-love/attachments', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('ОБРАЗЕЦ — новое фото.png') },
    body: bytes
  });
  assert.equal(upload.status, 200);
  assert.equal(upload.body.attachment.name, 'ОБРАЗЕЦ — новое фото.png');
  assert.ok(upload.body.attachment.url.startsWith('/content/project-chat/palitra-love/attachments/'));
  const file = await call(upload.body.attachment.url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  const foreign = await call(upload.body.attachment.url.replace('palitra-love', 'alvi'));
  assert.equal(foreign.status, 404);
  const rejected = await json('/content/project-chat/palitra-love/attachments', {
    method: 'POST', headers: { 'Content-Type': 'text/html', 'X-Filename': 'x.html' }, body: '<script>0</script>'
  });
  assert.equal(rejected.status, 400);
  const message = await post('/content/project-chat/palitra-love/messages', { text: '', attachmentIds: [upload.body.attachment.id], clientMessageId: 'preview-photo' });
  assert.equal(message.status, 201);
  assert.equal(message.body.message.attachments[0].mime, 'image/png');
});

test('роль в предпросмотре меняет права так же, как их проверяет сервер', async () => {
  await reset({ role: 'viewer' });
  const viewer = await json('/content/project-chat/palitra-love');
  assert.deepEqual(viewer.body.access, { canReply: false, owner: false });
  assert.equal((await post('/content/project-chat/palitra-love/messages', { text: 'нельзя', clientMessageId: 'v1' })).status, 403);
  assert.equal((await post('/content/project-chat/palitra-love/tasks', { title: 'нельзя' })).status, 403);

  await reset({ role: 'member' });
  const member = await json('/content/project-chat/palitra-love');
  assert.deepEqual(member.body.access, { canReply: true, owner: false });
  assert.equal((await json('/content/project-chat/palitra-love/candidates')).status, 403);
  assert.equal((await json('/content/project-chat/palitra-love/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"replyMode":"delegate"}' })).status, 403);
  assert.equal((await post('/content/project-chat/palitra-love/retry-ai', {})).status, 403);

  await reset({ access: 'revoked' });
  assert.equal((await json('/content/project-chat/palitra-love')).status, 403);
  assert.equal((await post('/content/project-chat/palitra-love/messages', { text: 'нельзя', clientMessageId: 'r1' })).status, 403);
});

test('задача принимает исполнителя и этап только своей комнаты', async () => {
  await reset();
  const snapshot = await json('/content/project-chat/palitra-love');
  const source = snapshot.body.messages[0].id;
  assert.equal((await post('/content/project-chat/palitra-love/tasks', { title: 'Образец', assigneeId: 4, stageId: null })).status, 400);
  assert.equal((await post('/content/project-chat/palitra-love/tasks', { title: 'Образец', assigneeId: 2, stageId: 99 })).status, 400);
  assert.equal((await post('/content/project-chat/palitra-love/tasks', { title: 'Образец', due: 'скоро' })).status, 400);
  assert.equal((await post('/content/project-chat/palitra-love/tasks', { title: '   ' })).status, 400);
  const created = await post('/content/project-chat/palitra-love/tasks', {
    title: 'Образец: '.repeat(60), assigneeId: 2, stageId: 3, due: '2026-10-01', status: 'in_progress', sourceMessageId: source
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.task.title.length, 200);
  assert.equal(created.body.task.sourceMessageId, source);
  assert.equal(created.body.task.assigneeId, 2);
  const stage = await post('/content/project-chat/palitra-love/stages', { title: 'Образец: приёмка' });
  assert.equal(stage.status, 201);
  const after = await json('/content/project-chat/palitra-love');
  assert.equal(after.body.tasks.length, 4);
  assert.equal(after.body.stages.length, 4);
});

test('вышедший участник остаётся историческим исполнителем задачи', async () => {
  await reset();
  const before = await json('/content/project-chat/palitra-love');
  assert.deepEqual(before.body.formerMembers, []);
  assert.equal(before.body.tasks.find((task) => task.id === 1).assigneeActive, true);

  const members = await json('/content/project-chat/palitra-love/members', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userIds: [1, 3] })
  });
  assert.equal(members.status, 200);
  const after = await json('/content/project-chat/palitra-love');
  assert.deepEqual(after.body.members.map((person) => person.userId), [1, 3]);
  assert.deepEqual(after.body.formerMembers.map((person) => person.userId), [2]);
  const task = after.body.tasks.find((item) => item.id === 1);
  assert.equal(task.assigneeId, 2);
  assert.equal(task.assigneeActive, false);
  assert.match(task.assigneeName, /Дарья/);

  const kept = await json('/content/project-chat/palitra-love/tasks/1', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Образец: закупить краску', assigneeId: 2, stageId: 2, due: '2026-09-25', status: 'done' })
  });
  assert.equal(kept.status, 200);
  assert.equal(kept.body.task.assigneeId, 2);
  assert.equal(kept.body.task.status, 'done');

  const rejected = await json('/content/project-chat/palitra-love/tasks/2', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Образец: согласовать смету', assigneeId: 2 })
  });
  assert.equal(rejected.status, 400);
});

test('настройки чата сохраняются локально и проверяют ID группы', async () => {
  await reset();
  const bad = await json('/content/project-chat/palitra-love/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telegramChatId: 'группа' }) });
  assert.equal(bad.status, 400);
  const good = await json('/content/project-chat/palitra-love/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replyMode: 'delegate', telegramChatId: '' }) });
  assert.equal(good.status, 200);
  assert.equal(good.body.room.replyMode, 'delegate');
  assert.equal(good.body.room.telegramChatId, '');
  const snapshot = await json('/content/project-chat/palitra-love');
  assert.equal(snapshot.body.room.replyMode, 'delegate');
});

test('состояния Хью показываются честно, ссылка входа только официальная', async () => {
  await reset({ ai: 'connected' });
  const connected = await json('/content/project-chat-runtime/status');
  assert.equal(connected.body.connected, true);
  assert.equal(connected.body.authenticated, true);

  await reset({ ai: 'login_required' });
  const waiting = await json('/content/project-chat-runtime/status');
  assert.equal(waiting.body.state, 'login_required');
  assert.equal(waiting.body.loginUrl, 'https://auth.openai.com/codex/device');
  assert.equal((await post('/content/project-chat-runtime/login', {})).body.connected, false);
  const queued = await json('/content/project-chat/palitra-love');
  assert.equal(queued.body.ai.connected, false);
  assert.equal(queued.body.ai.configured, true);
  assert.ok(queued.body.ai.queued >= 1);

  await reset({ ai: 'unavailable' });
  const failing = await json('/content/project-chat/palitra-love');
  assert.equal(failing.body.ai.runtimeState, 'unavailable');
  assert.ok(failing.body.ai.failed >= 1);
  const retried = await post('/content/project-chat/palitra-love/retry-ai', {});
  assert.equal(retried.status, 200);
  assert.ok(retried.body.retried >= 1);

  await reset({ ai: 'off' });
  const off = await json('/content/project-chat/palitra-love');
  assert.equal(off.body.ai.configured, false);
  assert.equal(off.body.ai.connected, false);
});

test('личная переписка владельца отвечает отдельной фикстурой', async () => {
  await reset();
  const created = await post('/content/hugh/conversations', { site: 'palitra-love', title: 'Хью · palitra-love' });
  assert.equal(created.status, 200);
  assert.ok(created.body.id);
  assert.ok(created.body.visitorToken);
  const history = await json('/content/hugh/conversations/' + created.body.id);
  assert.equal(history.status, 200);
  assert.ok(Array.isArray(history.body.messages));
  const reply = await post('/content/hugh/conversations/' + created.body.id + '/messages', { text: 'Образец вопроса' });
  assert.match(reply.body.reply, /Образец/);
  assert.match(reply.body.reply, /не подключена/);
});
