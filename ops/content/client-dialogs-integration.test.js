'use strict';

/* Клиентский бот Palitra целиком: живой сервис content (маршруты владельца, внутренние маршруты моста,
   приём заявок) и настоящий мост ops/chat/client-bot-bridge.js с поддельным Telegram в памяти.
   Проверяется сквозной сценарий: привязка менеджера, клиент → менеджер → клиент, голосовое сохраняется
   и выдаётся только владельцу, заявка приходит тем же ботом с кнопками, ссылка «Продолжить в Telegram».
   Реальных токенов, отправок и сети наружу нет.
   node --test ops/content/client-dialogs-integration.test.js */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./passwords');
const { createClientBotBridge } = require('../chat/client-bot-bridge');
const { parseQuietHours } = require('../chat/quiet-hours');

const ORIGIN = 'https://palitra-love.ru';
const DARYA = 555000111;
const CLIENT = 900000001;
const VOICE = Buffer.from('OggS synthetic voice');

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('живой content + мост: переписка через бота, вложение, заявка тем же ботом, ссылка и права владельца', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-dialogs-live-'));
  const ownerSecret = crypto.randomBytes(24).toString('hex');
  const serviceKey = crypto.randomBytes(24).toString('hex');
  const crmPort=await freePort(),crmKey=crypto.randomBytes(24).toString('hex'),crmBase=`http://127.0.0.1:${crmPort}`,crmDb=path.join(dir,'crm.sqlite');
  const crm=spawn(process.execPath,[path.join(__dirname,'../crm/server.js')],{env:{...process.env,PORT:String(crmPort),DATABASE_PATH:crmDb,API_KEY:crmKey,
    LEADS_SMTP_HOST:'',LEADS_SMTP_USER:'',LEADS_SMTP_PASSWORD:'',LEADS_NOTIFY_EMAIL:'',LEADS_NOTIFY_EMAIL_ALVI:'',LEADS_NOTIFY_EMAIL_AVOKADO:''},stdio:'ignore',windowsHide:true});
  t.after(async()=>{if(crm.exitCode===null&&crm.signalCode===null){const exited=once(crm,'exit');crm.kill();await exited;}});
  const crmOwner=Buffer.from(JSON.stringify({v:1,userId:1,role:'owner',permissions:[],companyCodes:[]})).toString('base64url');
  const crmRequest=(url,method='GET',body,identity=crmOwner)=>fetch(crmBase+url,{method,headers:{'x-api-key':crmKey,'x-synapse-crm-identity':identity,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  let crmReady=false;for(let i=0;i<200&&!crmReady;i++){try{crmReady=(await crmRequest('/companies')).ok;}catch{}if(!crmReady)await new Promise(r=>setTimeout(r,25));}
  assert.ok(crmReady,'CRM запущена');
  for(const code of ['palitra-love','alvi'])assert.equal((await crmRequest('/companies','POST',{code,name:code,timezone:'UTC'})).status,201);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: path.join(dir, 'db.sqlite'), ASSETS_DIR: path.join(dir, 'assets'),
      SEED_DIR: path.join(__dirname, 'seed'), API_KEY: '', CHAT_API_KEY: serviceKey, HUGH_RUNTIME_URL: `http://127.0.0.1:${await freePort()}`,
      PALITRA_CLIENT_BOT_USERNAME: '@palitra_qa_bot', PALITRA_ORDER_ORIGINS: ORIGIN,
      ALVI_CLIENT_BOT_USERNAME: '',
      CRM_URL:crmBase,CRM_API_KEY:crmKey,
      AUTH_USERS: `owner:owner:${hashPassword(ownerSecret)}`, SESSION_SECRET: crypto.randomBytes(32).toString('hex') },
    stdio: 'ignore',
  });
  // Сначала дождаться выхода процесса (он держит базу), затем удалить только свою временную папку; ошибки не подавляются.
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    if(crm.exitCode===null&&crm.signalCode===null){const exited=once(crm,'exit');crm.kill();await exited;}
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${port}`;
  const req = (url, session, method = 'GET', body, extra = {}) => fetch(base + url, { method,
    headers: { ...(session ? { cookie: session.cookie, ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}) } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let ready = false;
  for (let attempt = 0; attempt < 200 && !ready; attempt++) {
    try { ready = (await req('/health')).ok; } catch { /* поднимается */ }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(ready, 'сервис content запустился');
  const login = async (name, secret) => {
    const response = await req('/content/login', null, 'POST', { login: name, password: secret });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    return { cookie, csrf: (await (await req('/content/whoami', { cookie })).json()).csrfToken };
  };
  const owner = await login('owner', ownerSecret);
  // Дарья в ЛК с её нынешними правами (прайс и сайты): диалоги и бот ей не открываются.
  const dariaSecret = crypto.randomBytes(24).toString('hex');
  assert.equal((await req('/content/admin/accounts', owner, 'POST', { login: 'daria', displayName: 'Дарья', password: dariaSecret,
    companies: ['palitra-love'], permissions: ['price.edit', 'price.view', 'sites.view'] })).status, 201);
  const daria = await login('daria', dariaSecret);

  /* Поддельный Telegram и настоящий мост. Всё, что бот отправил, видно в sent. */
  const sent = [];
  let nextId = 1000;
  const inbox = [];
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('https://api.telegram.org/file/')) return { ok: true, status: 200, body: Readable.from([VOICE]) };
    if (target.startsWith('https://api.telegram.org/bot')) {
      const method = target.split('/').pop();
      const body = JSON.parse(options.body);
      if (method === 'getMe') return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: 42, is_bot: true, username: 'palitra_qa_bot' } }) };
      if (method === 'getFile') return { ok: true, status: 200, json: async () => ({ ok: true, result: { file_path: 'voice/file_1.oga', file_size: VOICE.length } }) };
      const result = ['sendMessage', 'copyMessage'].includes(method) ? { message_id: nextId++ } : true;
      sent.push({ method, body, result });
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    }
    return fetch(url, options);
  };
  const bridge = createClientBotBridge({ db: new DatabaseSync(':memory:'), botKey: 'palitra', token: '1:qa', expectedUsername: 'palitra_qa_bot', contentUrl: base, apiKey: serviceKey,
    fetchImpl, quietHours: parseQuietHours({}), now: () => new Date('2026-09-29T09:00:00Z'), log: { warn() {}, error() {} } });
  let updateId = 0, messageId = 1;
  const push = (from, text, extra = {}) => {
    const message = { message_id: ++messageId, date: 1790000000, chat: { id: from, type: 'private' }, from: { id: from, first_name: from === DARYA ? 'Дарья' : 'Анна' }, ...(text ? { text } : {}), ...extra };
    inbox.push(message);
    bridge.enqueue({ update_id: ++updateId, message });
    return message;
  };
  const settle = async () => { for (let i = 0; i < 6; i++) await bridge.tick(); };

  // Внутренние маршруты — только по ключу службы; кабинет — только владельцу и только Palitra.
  assert.equal((await fetch(`${base}/content/internal/client-bot/outbox?botKey=palitra`)).status, 401);
  assert.equal((await req('/content/palitra/client-bot', daria)).status, 403);
  assert.equal((await req('/content/palitra/client-dialogs', daria)).status, 403);
  const alviStatus = await (await req('/content/alvi/client-bot', owner)).json();
  assert.equal(alviStatus.enabled, false);
  assert.equal((await req('/content/alvi/client-bot', daria)).status, 403);
  assert.equal((await req('/content/alvi/order-recipient', { cookie: owner.cookie }, 'PUT', { telegramChatId: '555000222' })).status, 403);
  assert.equal((await req('/content/alvi/order-recipient', owner, 'PUT', { telegramChatId: '555000222', label: 'Администратор ALVI' })).status, 200);
  assert.equal((await (await req('/content/palitra/order-recipient', owner)).json()).configured, false, 'получатели раздельны');
  assert.equal((await req('/content/alvi/client-bot/operator-code', owner, 'POST')).status, 409, 'пустое имя не включает бота');
  assert.equal((await req('/public-orders/alvi', null, 'POST', {}, { Origin: 'https://example.test' })).status, 403, 'публичный приём ALVI закрыт');
  const status0 = await (await req('/content/palitra/client-bot', owner)).json();
  assert.deepEqual([status0.enabled, status0.username, status0.operator.bound, status0.transport, status0.bridge.ready], [true, 'palitra_qa_bot', false, 'project_bot', false]);
  await bridge.tick();   // мост проверяет getMe и подтверждает бота в content
  assert.equal((await (await req('/content/palitra/client-bot', owner)).json()).bridge.ready, true);

  // До привязки менеджера заявка принимается как раньше и без ссылки в Telegram.
  const priceDoc = await (await req('/public-content/palitra/price')).json();
  const itemId = priceDoc.categories[0].items[0].id;
  const order = () => ({ requestId: crypto.randomUUID(), kind: 'cart', name: 'Анна', phone: '89140001122', consent: true, items: [{ id: itemId, qty: 1 }], page: '/catalog/', website: '' });
  const early = await (await req('/public-orders/palitra', null, 'POST', order(), { Origin: ORIGIN })).json();
  assert.deepEqual([early.ok, early.telegram], [true, undefined]);

  // Код привязки: без CSRF — отказ; без получателя — 409; затем код и привязка из Telegram.
  assert.equal((await req('/content/palitra/client-bot/operator-code', { cookie: owner.cookie }, 'POST')).status, 403);
  assert.equal((await req('/content/palitra/client-bot/operator-code', owner, 'POST')).status, 409);
  assert.equal((await req('/content/palitra/order-recipient', owner, 'PUT', { telegramChatId: String(DARYA), label: 'Дарья' })).status, 200);
  assert.equal((await req('/content/palitra/order-recipient/transport', owner, 'PUT', { transport: 'client_bot' })).status, 409, 'менеджер ещё не привязан');
  const codeResponse = await req('/content/palitra/client-bot/operator-code', owner, 'POST');
  assert.equal(codeResponse.status, 201);
  const code = await codeResponse.json();
  push(DARYA, code.command);
  await settle();
  assert.match(sent.at(-1).body.text, /вы подключены как менеджер Palitra/);
  assert.equal((await (await req('/content/palitra/client-bot', owner)).json()).operator.bound, true);

  // Клиент: /start, текст и голосовое. Менеджер получает копии; голосовое сохранено в content.
  push(CLIENT, '/start ig');
  const hello = push(CLIENT, 'Нужен букет к 18:00');
  push(CLIENT, null, { voice: { file_id: 'voice-1', file_unique_id: 'u1', mime_type: 'audio/ogg', file_size: VOICE.length, duration: 3 } });
  await settle();
  const copies = sent.filter((item) => item.method === 'copyMessage' && item.body.chat_id === String(DARYA));
  assert.deepEqual(copies.map((item) => item.body.from_chat_id), [String(CLIENT), String(CLIENT)]);
  assert.equal(copies[0].body.message_id, hello.message_id);
  assert.ok(sent.some((item) => item.method === 'sendMessage' && item.body.chat_id === String(CLIENT) && /Это Palitra/.test(item.body.text)), 'клиент получил приветствие');
  // Ответ менеджера на копию — уходит клиенту копией от бота, на ответ ставится 👌.
  const copyOfHello = copies.find((item) => item.body.message_id === hello.message_id).result.message_id;
  const answer = push(DARYA, 'Добрый день! Соберём.', { reply_to_message: { message_id: copyOfHello } });
  await settle();
  const toClient = sent.filter((item) => item.method === 'copyMessage' && item.body.chat_id === String(CLIENT));
  assert.deepEqual(toClient.map((item) => [item.body.from_chat_id, item.body.message_id]), [[String(DARYA), answer.message_id]]);
  assert.ok(sent.some((item) => item.method === 'setMessageReaction' && item.body.message_id === answer.message_id));

  // Владелец читает переписку, статусы и слушает голосовое; посторонние — нет.
  const list = await (await req('/content/palitra/client-dialogs', owner)).json();
  assert.equal(list.dialogs.length, 1);
  const dialog = await (await req(`/content/palitra/client-dialogs/${list.dialogs[0].id}`, owner)).json();
  const intakeUrl=`/content/palitra/client-dialogs/${list.dialogs[0].id}/crm`,sentBeforeIntake=sent.length;
  assert.equal((await req(intakeUrl,daria,'POST')).status,403);
  assert.equal((await req(intakeUrl,{cookie:owner.cookie},'POST')).status,403);
  assert.equal((await req(`/content/alvi/client-dialogs/${list.dialogs[0].id}/crm`,owner,'POST')).status,404);
  const intake=await req(intakeUrl,owner,'POST',{companyCode:'alvi',telegramUserId:'forged'});assert.equal(intake.status,200);
  const receipt=await intake.json();assert.equal(receipt.companyCode,'palitra-love');assert.equal(receipt.created,true);
  const repeated=await (await req(intakeUrl,owner,'POST')).json();assert.equal(repeated.leadId,receipt.leadId);assert.equal(repeated.created,false);
  const crmLead=await (await crmRequest(`/leads/${receipt.leadId}?companyCode=palitra-love`)).json();assert.equal(crmLead.contact,`Telegram ID ${CLIENT}`);
  const infoUrl='/company-information?companyCode=palitra-love';
  const initialInfo=await (await crmRequest(infoUrl)).json();
  const catalog=await (await crmRequest(infoUrl,'PUT',{revision:initialInfo.revision,profile:{services:[{id:'qa-service',title:'Тестовая услуга',price:1500,currency:'RUB',procedureCount:1}]}})).json();
  assert.equal((await crmRequest(infoUrl,'PUT',{revision:catalog.revision,profile:{},factConfirmations:catalog.facts.filter(f=>f.key.startsWith('services/')).map(f=>({factId:f.id,source:'Синтетический прайс',sourceRef:'Тест, строка 1',checkedAt:new Date().toISOString()}))})).status,200);
  const knowledge=await (await crmRequest('/company-information/knowledge?companyCode=palitra-love')).json();
  const booked=await crmRequest(`/studio-journey/${receipt.leadId}/events?companyCode=palitra-love`,'POST',{revision:0,requestId:'dialog-booking-test',type:'booked',appointmentAt:new Date(Date.now()+86400000).toISOString(),serviceSelection:{id:'qa-service',knowledgeRevision:knowledge.knowledgeRevision}});
  assert.equal(booked.status,201);assert.equal((await booked.json()).state.serviceQuote.service.price,1500);
  assert.equal(sent.length,sentBeforeIntake,'создание CRM не отправляет Telegram');
  const inspectDb=new DatabaseSync(crmDb);assert.equal(inspectDb.prepare('SELECT count(*) n FROM lead_email_outbox').get().n,0);inspectDb.close();
  const byAuthor = (type) => dialog.messages.filter((message) => message.authorType === type);
  assert.deepEqual(byAuthor('client').map((message) => [message.text, message.deliveryStatus]), [['Нужен букет к 18:00', 'sent'], ['', 'sent']]);
  assert.deepEqual(byAuthor('operator').map((message) => [message.text, message.deliveryStatus]), [['Добрый день! Соберём.', 'sent']]);
  const voice = byAuthor('client')[1].attachments[0];
  assert.deepEqual([voice.kind, voice.status, voice.mime], ['voice', 'stored', 'audio/ogg']);
  const file = await req(`/content/palitra/client-dialogs/attachments/${voice.id}`, owner);
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), VOICE);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.match(file.headers.get('content-security-policy'), /sandbox/);
  assert.match(file.headers.get('content-disposition'), /^inline; filename\*=UTF-8''/);
  assert.equal((await req(`/content/palitra/client-dialogs/attachments/${voice.id}`, daria)).status, 403);
  assert.equal((await req(`/content/palitra/client-dialogs/attachments/99999`, owner)).status, 404);
  assert.equal((await req(`/content/palitra/client-dialogs/${list.dialogs[0].id}/read`, { cookie: owner.cookie }, 'POST')).status, 403, 'CSRF');

  // Канал заявок → бот Palitra: переключение ничего не рассылает; новая заявка приходит с кнопками и ссылкой.
  const before = sent.length;
  const switched = await req('/content/palitra/order-recipient/transport', owner, 'PUT', { transport: 'client_bot' });
  assert.equal(switched.status, 200);
  await settle();
  assert.equal(sent.length, before, 'переключение не отправляет старые заявки');
  const fresh = await (await req('/public-orders/palitra', null, 'POST', order(), { Origin: ORIGIN })).json();
  assert.match(fresh.telegram.url, /^https:\/\/t\.me\/palitra_qa_bot\?start=o_[A-Za-z0-9_-]{32}$/);
  await settle();
  const notice = sent.filter((item) => item.body.reply_markup?.inline_keyboard).at(-1);
  assert.equal(notice.body.chat_id, String(DARYA));
  assert.match(notice.body.text, new RegExp(`Заявка №${fresh.orderId} · Palitra[\\s\\S]*Статус обработки: Новая`));
  assert.equal((await (await fetch(`${base}/content/internal/project-chat/outbox`, { headers: { 'X-API-Key': serviceKey } })).json()).jobs.length, 0, 'старый маршрут заявку не дублирует');
  // Кнопка «В работе» из Telegram меняет статус обработки в ЛК.
  bridge.enqueue({ update_id: ++updateId, callback_query: { id: 'cb-1', from: { id: DARYA }, data: `ow:${fresh.orderId}:in_work`,
    message: { message_id: 1, chat: { id: DARYA, type: 'private' }, text: notice.body.text } } });
  await settle();
  const orders = await (await req('/content/palitra/orders', owner)).json();
  const listed = orders.orders.find((item) => item.id === fresh.orderId);
  assert.deepEqual([listed.status, listed.work.status], ['notified', 'in_work']);
  assert.equal(orders.recipient.transport, 'client_bot');
  assert.ok(sent.some((item) => item.method === 'answerCallbackQuery' && item.body.text === 'Статус: В работе'));
  // Клиент переходит по ссылке — диалог связывается с заявкой.
  push(CLIENT, `/start ${new URL(fresh.telegram.url).searchParams.get('start')}`);
  await settle();
  assert.equal((await (await req('/content/palitra/client-dialogs', owner)).json()).dialogs[0].orderId, fresh.orderId);
  // Отключение менеджера возвращает прежний канал.
  const revoked = await (await req('/content/palitra/client-bot/revoke-operator', owner, 'POST')).json();
  assert.deepEqual([revoked.operator.bound, revoked.transport], [false, 'project_bot']);
});
