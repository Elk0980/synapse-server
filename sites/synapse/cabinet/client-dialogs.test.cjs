/* Клиентский бот Palitra в ЛК: состояние бота, одноразовый код менеджера (с CSRF), канал заявок с
   предупреждением, переписка только для чтения с вложениями и статусами доставки, смена компании
   отбрасывает ответы. Встроено в вид «Заявки с сайта».
   node --test sites/synapse/cabinet/client-dialogs.test.cjs (jsdom из среды проекта) */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const recipient = (extra = {}) => ({ configured: true, telegramChatId: '555000111', label: 'Дарья', version: 1, verifiedAt: null, lastTestError: '', lastTest: null,
  unnotifiedOrders: 0, updatedAt: null, transport: 'project_bot', ...extra });
const bot = (extra = {}) => ({ enabled: true, username: 'palitra_qa_bot', operator: { bound: false }, pendingCode: null, transport: 'project_bot',
  transportReady: { ok: false, reason: 'Менеджер ещё не привязан к боту' }, dialogs: 0, unread: 0, deliveryProblems: 0, events: [], ...extra });

function fixture({ company = 'palitra-love', confirm = true } = {}) {
  const dom = new JSDOM('<section data-view="site-orders" id="view"></section>', { runScripts: 'outside-only' });
  const w = dom.window, d = w.document, views = {}, calls = [];
  w.SbCabinet = { registerView: (name, view) => { views[name] = view; } };
  w.confirm = () => confirm;
  w.eval(fs.readFileSync(__dirname + '/client-dialogs.js', 'utf8'));
  w.eval(fs.readFileSync(__dirname + '/site-orders.js', 'utf8'));
  const state = { company };
  const ctx = {
    identity: { role: 'owner', csrfToken: 'csrf-1' },
    get selectedProjectId() { return state.company; },
    escapeHTML: h,
    apiJson: (url, options = {}) => { const call = { url, options }; calls.push(call); return new Promise((resolve, reject) => { call.resolve = resolve; call.reject = reject; if (options.signal) options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }); },
  };
  const find = (url, method = 'GET') => calls.find((call) => call.url === url && (call.options.method || 'GET') === method && !call.done);
  const answer = async (url, payload, method = 'GET') => { const call = find(url, method); assert.ok(call, `нет запроса ${method} ${url}`); call.done = true; call.resolve(payload); await tick(); return call; };
  return { w, d, views, calls, ctx, state, answer, find, container: d.getElementById('view'), render: () => views['site-orders'].render(d.getElementById('view'), ctx) };
}

test('бот не подключён: честное состояние, кнопок и переписки нет, заявки как раньше', async () => {
  const f = fixture();
  f.render();
  await f.answer('/content/palitra/client-bot', bot({ enabled: false, username: '' }));
  await f.answer('/content/palitra/orders?limit=50', { orders: [], recipient: recipient() });
  assert.match(f.d.querySelector('[data-bot-summary]').textContent, /Бот не подключён.*После подключения/);
  assert.equal(f.d.querySelector('[data-bot-code]').hidden, true);
  assert.equal(f.d.querySelector('[data-bot-transport]').hidden, true);
  assert.equal(f.d.querySelector('[data-client-dialogs]').hidden, true);
  assert.equal(f.calls.some((call) => call.url.startsWith('/content/palitra/client-dialogs')), false);
  f.w.close();
});

test('код менеджера: POST с CSRF, показ один раз с командой и ссылкой; канал заявок — только при готовности и с подтверждением', async () => {
  const f = fixture();
  f.render();
  await f.answer('/content/palitra/client-bot', bot());
  await f.answer('/content/palitra/client-dialogs?limit=50', { dialogs: [], nextCursor: null });
  assert.match(f.d.querySelector('[data-bot-summary]').textContent, /Менеджер ещё не привязан/);
  assert.equal(f.d.querySelector('[data-bot-transport]').hidden, true, 'без привязанного менеджера переключения нет');
  f.d.querySelector('[data-bot-code]').click(); await tick();
  const post = f.find('/content/palitra/client-bot/operator-code', 'POST');
  assert.equal(post.options.headers['X-CSRF-Token'], 'csrf-1');
  await f.answer('/content/palitra/client-bot/operator-code', { code: 'ABCDEFGH23', command: '/operator ABCDEFGH23', deepLink: 'https://t.me/palitra_qa_bot?start=op_ABCDEFGH23', expiresAt: '2026-09-29T09:10:00Z' }, 'POST');
  assert.equal(f.d.querySelector('[data-bot-command]').textContent, '/operator ABCDEFGH23');
  assert.equal(f.d.querySelector('[data-bot-code-box] a').getAttribute('href'), 'https://t.me/palitra_qa_bot?start=op_ABCDEFGH23');
  assert.equal(f.d.querySelector('[data-bot-code-box] a').rel, 'noopener noreferrer');
  // После привязки: кнопка «Присылать заявки ботом Palitra» → PUT транспорта с CSRF и обновление списка заявок.
  await f.answer('/content/palitra/client-bot', bot({ operator: { bound: true, telegramUserId: '555000111', boundAt: '2026-09-29T09:05:00Z', matchesRecipient: true }, transportReady: { ok: true } }));
  const transport = f.d.querySelector('[data-bot-transport]');
  assert.deepEqual([transport.hidden, transport.textContent], [false, 'Присылать заявки ботом @palitra_qa_bot']);
  transport.click(); await tick();
  const put = f.find('/content/palitra/order-recipient/transport', 'PUT');
  assert.deepEqual([JSON.parse(put.options.body), put.options.headers['X-CSRF-Token']], [{ transport: 'client_bot' }, 'csrf-1']);
  await f.answer('/content/palitra/order-recipient/transport', recipient({ transport: 'client_bot' }), 'PUT');
  await f.answer('/content/palitra/client-bot', bot({ operator: { bound: true, telegramUserId: '555000111', boundAt: '2026-09-29T09:05:00Z', matchesRecipient: true }, transport: 'client_bot', transportReady: { ok: true } }));
  assert.match(f.d.querySelector('[data-bot-status]').textContent, /Отправьте проверочное сообщение/);
  assert.equal(transport.textContent, 'Вернуть заявки на бот Synapse');
  assert.ok(f.calls.filter((call) => call.url.startsWith('/content/palitra/orders')).length >= 2, 'список заявок перечитан после смены канала');
  f.w.close();
});

test('отказ в подтверждении — канал не меняется', async () => {
  const f = fixture({ confirm: false });
  f.render();
  await f.answer('/content/palitra/client-bot', bot({ operator: { bound: true, telegramUserId: '1', boundAt: 'x', matchesRecipient: true }, transportReady: { ok: true } }));
  f.d.querySelector('[data-bot-transport]').click(); await tick();
  assert.equal(f.find('/content/palitra/order-recipient/transport', 'PUT'), undefined);
  f.w.close();
});

test('переписка: список, чтение с отметкой прочитанного, вложения и статусы доставки; экранирование', async () => {
  const f = fixture();
  f.render();
  await f.answer('/content/palitra/client-bot', bot({ operator: { bound: true, telegramUserId: '1', boundAt: 'x', matchesRecipient: true }, unread: 1 }));
  await f.answer('/content/palitra/client-dialogs?limit=50', { dialogs: [{ id: 7, name: 'Анна <script>', username: 'anna', orderId: 12, unread: 1, lastMessageAt: '2026-09-29T09:00:00Z', lastMessage: 'Нужен букет' }], nextCursor: null });
  const item = f.d.querySelector('[data-dialog-id="7"]');
  assert.equal(item.innerHTML.includes('<script>'), false);
  assert.match(item.textContent, /заявка №12/);
  item.click(); await tick();
  await f.answer('/content/palitra/client-dialogs/7', { dialog: { id: 7, name: 'Анна', username: 'anna', source: 'ig', orderId: 12, unread: 1 }, order: { id: 12, work: { status: 'in_work' } }, messages: [
    { id: 1, direction: 'in', authorType: 'client', text: 'Нужен букет <b>', createdAt: 'x', deliveryStatus: 'sent', deliveryError: '', edited: true,
      versions: [{ text: 'Нужны шары', kind: 'client_edit', createdAt: 'x' }], attachments: [
        { id: 3, kind: 'voice', mime: 'audio/ogg', name: 'voice-1.ogg', size: 2048, status: 'stored', error: '' },
        { id: 4, kind: 'video', mime: 'video/mp4', name: 'big.mp4', size: 50000000, status: 'too_large', error: 'Файл больше 20 МБ' }] },
    { id: 2, direction: 'out', authorType: 'operator', text: 'Соберём', createdAt: 'x', deliveryStatus: 'uncertain', deliveryError: 'Нет подтверждения', edited: false, versions: [], attachments: [
      { id: 5, kind: 'photo', mime: 'image/jpeg', name: 'photo.jpg', size: 900, status: 'stored', error: '' }] },
    { id: 3, direction: 'system', authorType: 'system', text: 'Клиент открыл бота', createdAt: 'x', deliveryStatus: 'received', deliveryError: '', edited: false, versions: [], attachments: [] }] });
  const thread = f.d.querySelector('[data-dialog-thread]');
  assert.match(thread.textContent, /Диалог №7 · источник: ig · заявка №12/);
  assert.equal(thread.querySelector('audio').getAttribute('src'), '/content/palitra/client-dialogs/attachments/3');
  assert.equal(thread.querySelector('img').getAttribute('src'), '/content/palitra/client-dialogs/attachments/5');
  assert.match(thread.textContent, /big\.mp4.*файл не сохранён: слишком большой/);
  assert.equal(thread.querySelectorAll('video').length, 0, 'несохранённый файл не выдаётся за файл');
  assert.match(thread.textContent, /у менеджера в Telegram/);
  assert.match(thread.textContent, /доставка не подтверждена — проверьте переписку в Telegram/);
  assert.ok(thread.querySelector('.client-message--problem'));
  assert.match(thread.textContent, /Изменено клиентом/);
  assert.equal(thread.querySelector('.client-message__text').textContent, 'Нужен букет <b>', 'текст клиента показан как текст');
  assert.equal(thread.querySelector('.client-message__text b'), null);
  assert.equal(thread.querySelector('textarea:not([readonly]), form'), null, 'редактирования и отправки ответа из ЛК нет: менеджер отвечает в Telegram');
  const read = await f.answer('/content/palitra/client-dialogs/7/read', { ok: true }, 'POST');
  assert.equal(read.options.headers['X-CSRF-Token'], 'csrf-1');
  assert.equal(f.d.querySelector('[data-dialog-id="7"] .client-dialog__unread'), null);
  f.w.close();
});

test('смена компании: запросы бота отменяются, поздние ответы не применяются', async () => {
  const f = fixture();
  f.render();
  const botCall = f.find('/content/palitra/client-bot');
  f.state.company = 'avokado';
  await f.render(); await tick();
  assert.equal(botCall.options.signal.aborted, true);
  botCall.resolve(bot({ username: 'late_bot' }));
  await tick();
  assert.doesNotMatch(f.container.textContent, /late_bot/);
  assert.match(f.container.textContent, /доступен для Palitra и ALVI/);
  f.w.close();
});

test('диалог открывает одну CRM-карточку через CSRF, повторный клик заблокирован, чужая квитанция отклоняется',async()=>{
  const f=fixture({company:'alvi'});let mounted=0;
  f.ctx.crmQuery=async()=>{};f.w.SbCabinet.studioJourney={mountCard:async(node,ctx,id)=>{assert.equal(ctx,f.ctx);assert.equal(id,42);mounted++;node.textContent='Карточка визита';}};
  try{f.render();await f.answer('/content/alvi/client-bot',bot());await f.answer('/content/alvi/client-dialogs?limit=50',{dialogs:[{id:7,name:'Клиент',unread:0}],nextCursor:null});
    f.d.querySelector('[data-dialog-id="7"]').click();await tick();await f.answer('/content/alvi/client-dialogs/7',{dialog:{id:7,name:'Клиент',unread:0},messages:[]});
    const button=f.d.querySelector('[data-dialog-crm-open]');button.click();button.click();await tick();
    assert.equal(f.calls.filter(c=>c.url.endsWith('/7/crm')).length,1);assert.equal(f.find('/content/alvi/client-dialogs/7/crm','POST').options.headers['X-CSRF-Token'],'csrf-1');
    await f.answer('/content/alvi/client-dialogs/7/crm',{companyCode:'alvi',leadId:42,created:true},'POST');assert.equal(mounted,1);assert.match(f.container.textContent,/Карточка CRM №42 создана/);
    button.click();await tick();await f.answer('/content/alvi/client-dialogs/7/crm',{companyCode:'palitra-love',leadId:43},'POST');assert.equal(mounted,1);assert.match(f.container.textContent,/другой компании/);
  }finally{f.w.close();}
});

test('заявка показывает состояние обработки менеджером отдельно от статуса уведомления', async () => {
  const f = fixture();
  f.render();
  await f.answer('/content/palitra/client-bot', bot({ enabled: false, username: '' }));
  const base = { requestId: 'r', kind: 'request', createdAt: '2026-09-29T09:00:00Z', notifiedAt: null, name: 'Анна', phone: '+7 900', comment: '', items: [], knownTotal: 0, unknownCount: 0, page: '', utm: {}, notify: null };
  await f.answer('/content/palitra/orders?limit=50', { orders: [
    { ...base, id: 2, status: 'notified', work: { status: 'in_work', updatedBy: 'Менеджер в Telegram', updatedAt: '2026-09-29T09:30:00Z' } },
    { ...base, id: 1, status: 'notified', work: { status: 'new', updatedBy: '', updatedAt: null } }], recipient: recipient({ transport: 'client_bot' }) });
  const cards = f.d.querySelectorAll('.site-order');
  assert.match(cards[0].querySelector('.site-order__work').textContent, /Обработка: В работе/);
  assert.equal(cards[1].querySelector('.site-order__work'), null, 'новая заявка без лишней отметки');
  f.w.close();
});

test('«Обновить» и сохранение получателя перечитывают и заявки, и состояние бота; фонового опроса нет', async () => {
  const f = fixture();
  f.render();
  await f.answer('/content/palitra/client-bot', bot({ bridge: { ready: false, checkedAt: null, error: 'Нет свежего подтверждения от сервиса chat' } }));
  await f.answer('/content/palitra/client-dialogs?limit=50', { dialogs: [], nextCursor: null });
  await f.answer('/content/palitra/orders?limit=50', { orders: [], recipient: recipient() });
  assert.match(f.d.querySelector('[data-bot-summary]').textContent, /не подтвердил бота: Нет свежего подтверждения.*ссылки в Telegram после заявки не выдаются/);
  const count = (url) => f.calls.filter((call) => call.url === url).length;
  f.d.querySelector('[data-orders-refresh]').click(); await tick();
  assert.deepEqual([count('/content/palitra/orders?limit=50'), count('/content/palitra/client-bot')], [2, 2]);
  await f.answer('/content/palitra/client-bot', bot({ bridge: { ready: true, checkedAt: '2026-09-29T09:00:00Z', error: '' }, storage: { usedBytes: 5242880, limitBytes: 1073741824 } }));
  await f.answer('/content/palitra/orders?limit=50', { orders: [], recipient: recipient() });
  assert.match(f.d.querySelector('[data-bot-summary]').textContent, /Сервис chat подтвердил бота.*Файлы: 5 из 1024 МБ/);
  const form = f.d.querySelector('[data-recipient-form]');
  form.elements.telegramChatId.value = '555000222';
  form.dispatchEvent(new f.w.Event('submit', { cancelable: true })); await tick();
  await f.answer('/content/palitra/order-recipient', recipient({ telegramChatId: '555000222' }), 'PUT');
  assert.equal(count('/content/palitra/client-bot'), 3, 'после смены получателя состояние бота перечитано');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(count('/content/palitra/client-bot'), 3, 'без действий пользователя новых запросов нет');
  f.w.close();
});

test('заменённое клиентом вложение показано прежней версией, файл сверх лимита — явным статусом', async () => {
  const f = fixture();
  f.render();
  await f.answer('/content/palitra/client-bot', bot({ operator: { bound: true, telegramUserId: '1', boundAt: 'x', matchesRecipient: true } }));
  await f.answer('/content/palitra/client-dialogs?limit=50', { dialogs: [{ id: 3, name: 'Анна', username: '', orderId: null, unread: 0, lastMessageAt: 'x', lastMessage: '' }], nextCursor: null });
  f.d.querySelector('[data-dialog-id="3"]').click(); await tick();
  await f.answer('/content/palitra/client-dialogs/3', { dialog: { id: 3, name: 'Анна', username: '', source: '', orderId: null, unread: 0 }, order: null, messages: [
    { id: 1, direction: 'in', authorType: 'client', text: 'Вот так', createdAt: 'x', deliveryStatus: 'sent', deliveryError: '', edited: true, versions: [{ text: 'Было', kind: 'client_edit', createdAt: 'x' }], attachments: [
      { id: 10, kind: 'photo', mime: 'image/jpeg', name: 'old.jpg', size: 100, status: 'stored', error: '', superseded: true, supersededAt: '2026-09-29T09:10:00Z' },
      { id: 11, kind: 'photo', mime: 'image/jpeg', name: 'new.jpg', size: 120, status: 'stored', error: '', superseded: false },
      { id: 12, kind: 'video', mime: 'video/mp4', name: 'v.mp4', size: 5000, status: 'quota_exceeded', error: '', superseded: false }] }] });
  const thread = f.d.querySelector('[data-dialog-thread]');
  assert.deepEqual([...thread.querySelectorAll('img')].map((img) => img.getAttribute('src')), ['/content/palitra/client-dialogs/attachments/11'], 'как текущее показано только новое фото');
  assert.match(thread.querySelector('.client-file--replaced').textContent, /Прежняя версия \(клиент заменил вложение/);
  assert.match(thread.textContent, /v\.mp4.*исчерпан лимит хранилища бота/);
  f.w.close();
});

test('консультация: сервер проверяет версию, текст без HTML, повторная проверка убирает старую цену при ошибке',async()=>{
  const f=fixture({company:'alvi'}),requests=[];const revision='a'.repeat(64);
  f.ctx.crmQuery=(path,params)=>new Promise((resolve,reject)=>requests.push({path,params,resolve,reject}));
  try{
    f.render();await f.answer('/content/alvi/client-bot',bot());await f.answer('/content/alvi/client-dialogs?limit=50',{dialogs:[{id:7,name:'Клиент',unread:0}]});
    f.d.querySelector('[data-dialog-id]').click();await tick();await f.answer('/content/alvi/client-dialogs/7',{dialog:{id:7,name:'Клиент',unread:0},messages:[]});
    const click=key=>f.d.querySelector('[data-consult-'+key+']').click();
    click('load');click('load');assert.equal(requests.length,1);assert.equal(requests[0].params.companyCode,'alvi');
    requests[0].resolve({companyCode:'alvi',knowledgeRevision:revision,services:[{id:'course',title:'Курс'}]});await tick();
    const select=f.d.querySelector('[data-consult-service]');select.value='course';select.dispatchEvent(new f.w.Event('change'));
    click('prepare');assert.deepEqual({...requests[1].params},{companyCode:'alvi',serviceId:'course',knowledgeRevision:revision});
    requests[1].resolve({companyCode:'alvi',knowledgeRevision:revision,service:{id:'course'},text:'Курс <img src=x>\n15700 ₽ за 5 процедур.\nПродолжительность одной процедуры: 60 мин.'});await tick();
    const output=f.d.querySelector('[data-consult-text]');assert.match(output.value,/15700 ₽ за 5 процедур/);assert.match(output.value,/уточнит администратор/);assert.equal(output.readOnly,true);assert.equal(f.d.querySelector('[data-dialog-consultation] img'),null);
    assert.ok(!f.calls.some(c=>c.options.method==='POST'),'подготовка не создаёт карточку и ничего не отправляет');
    click('prepare');assert.equal(output.value,'');requests[2].reject(Error('Каталог изменился'));await tick();assert.equal(output.value,'');assert.equal(f.d.querySelector('[data-consult-result]').hidden,true);assert.match(f.container.textContent,/Каталог изменился.*Загрузите каталог заново/);
  }finally{f.w.close();}
});

test('консультация: чужой каталог и чужое предложение не показываются клиентским текстом',async()=>{
  const f=fixture({company:'alvi'}),revision='b'.repeat(64);let mode='foreignCatalog';
  f.ctx.crmQuery=async path=>path.endsWith('/knowledge')?{companyCode:mode==='foreignCatalog'?'palitra-love':'alvi',knowledgeRevision:revision,services:[{id:'one',title:'Услуга'}]}:{companyCode:'palitra-love',knowledgeRevision:revision,service:{id:'one'},text:'Чужая цена'};
  try{
    f.render();await f.answer('/content/alvi/client-bot',bot());await f.answer('/content/alvi/client-dialogs?limit=50',{dialogs:[{id:7,name:'Клиент',unread:0}]});f.d.querySelector('[data-dialog-id]').click();await tick();await f.answer('/content/alvi/client-dialogs/7',{dialog:{id:7,name:'Клиент',unread:0},messages:[]});
    f.d.querySelector('[data-consult-load]').click();await tick();assert.equal(f.d.querySelector('[data-consult-choice]').hidden,true);
    mode='foreignQuote';f.d.querySelector('[data-consult-load]').click();await tick();const select=f.d.querySelector('[data-consult-service]');select.value='one';select.dispatchEvent(new f.w.Event('change'));f.d.querySelector('[data-consult-prepare]').click();await tick();
    assert.equal(f.d.querySelector('[data-consult-text]').value,'');assert.match(f.container.textContent,/другой компании или услуги/);
  }finally{f.w.close();}
});

test('консультация: поздний ответ после смены компании не применяется',async()=>{
  const f=fixture({company:'alvi'});let resolve;
  f.ctx.crmQuery=()=>new Promise(r=>resolve=r);
  try{f.render();await f.answer('/content/alvi/client-bot',bot());await f.answer('/content/alvi/client-dialogs?limit=50',{dialogs:[{id:7,name:'Клиент',unread:0}]});f.d.querySelector('[data-dialog-id]').click();await tick();await f.answer('/content/alvi/client-dialogs/7',{dialog:{id:7,name:'Клиент',unread:0},messages:[]});f.d.querySelector('[data-consult-load]').click();f.state.company='avokado';await f.render();resolve({companyCode:'alvi',knowledgeRevision:'c'.repeat(64),services:[{id:'secret',title:'Поздняя услуга'}]});await tick();assert.doesNotMatch(f.container.textContent,/Поздняя услуга/);
  }finally{f.w.close();}
});
