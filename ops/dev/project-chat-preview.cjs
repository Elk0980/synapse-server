'use strict';

/**
 * Локальный предпросмотр общего чата проекта для визуальной проверки вёрстки.
 *
 * Это инструмент разработки, а не часть сервиса:
 *   - сервер слушает только 127.0.0.1 и отклоняет запросы с других адресов;
 *   - все данные вымышленные и помечены словом «образец»;
 *   - никаких обращений к Telegram, Codex, CRM и другим внешним службам нет;
 *   - секретов, ключей и настоящей переписки здесь не хранится.
 *
 * Страница загружает настоящие sites/synapse/cabinet/project-chat.{js,css} и hugh.{js,css}
 * с минимальным контекстом ЛК, поэтому в браузере видны реальные компоненты.
 *
 * Запуск:  node ops/dev/project-chat-preview.cjs [--port 8787]
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CABINET = path.join(__dirname, '..', '..', 'sites', 'synapse', 'cabinet');
const CSRF = 'preview-csrf-token';
const DEFAULT_PORT = 8787;
const MAX_BODY = 8 * 1024 * 1024;
// Рабочая страница — 100 сообщений. В предпросмотре меньше, чтобы кнопка
// «Показать более ранние сообщения» была видна на скриншоте.
const PAGE = 8;
const UPLOAD_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const isLoopback = (address) => typeof address === 'string' && LOOPBACK.has(address);
const allowedHost = (host) => {
  if (typeof host !== 'string' || !host) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return ['127.0.0.1', 'localhost', '[::1]'].includes(name);
};

/* ------------------------------------------------------------------ картинки */

const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();
const crc32 = (buffer) => {
  let c = -1;
  for (const byte of buffer) c = CRC[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const pngChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, checksum]);
};
// Картинки рисуются кодом: в предпросмотр не попадают ни чужие фотографии, ни бренд-ассеты.
const samplePng = (width, height, paint) => {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const pixel = paint(x, y);
      raw[row + 1 + x * 3] = pixel[0];
      raw[row + 2 + x * 3] = pixel[1];
      raw[row + 3 + x * 3] = pixel[2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
};
const frame = (x, y, width, height) => x < 4 || y < 4 || x >= width - 4 || y >= height - 4;
const wallPng = () => samplePng(480, 320, (x, y) => {
  if (frame(x, y, 480, 320)) return [214, 198, 176];
  if (y > 210) return [92, 82, 74];
  const band = Math.floor(y / 26) % 2 === 0 ? 12 : 0;
  return [176 + band, 160 + band, 140 + band];
});
const swatchPng = () => samplePng(360, 240, (x, y) => {
  if (frame(x, y, 360, 240)) return [40, 38, 36];
  const column = Math.floor(x / 90);
  const shade = 60 + Math.floor((y / 240) * 120);
  return [[232, 198, 150], [186, 204, 178], [198, 176, 200], [214, 160, 150]][column]
    .map((channel) => Math.min(255, Math.round((channel * shade) / 140)));
});
// Минимальный PDF-заглушка: ссылку в интерфейсе видно, активного просмотра нет.
const samplePdf = () => Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
  + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 150]>>endobj\n'
  + 'trailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');

/* ------------------------------------------------------------------ фикстура */

const PEOPLE = [
  { userId: 1, displayName: 'Влад (образец)' },
  { userId: 2, displayName: 'Дарья (образец)' },
  { userId: 3, displayName: 'Анна (образец)' },
  { userId: 4, displayName: 'Игорь (образец, пока не участник)' }
];
const COMPANIES = [
  { id: 'palitra-love', name: 'Палитра (образец)' },
  { id: 'alvi', name: 'АЛВИ (образец)' }
];
const AI_REPLY = 'Образец ответа для предпросмотра. Настоящая подписка Codex здесь не подключена — текст задан фикстурой.';

const at = (minutes) => new Date(Date.parse('2026-09-17T06:00:00.000Z') + minutes * 60000).toISOString();

const createFixture = () => {
  const attachments = new Map();
  const addAttachment = (companyCode, name, mime, bytes) => {
    const id = 'file-' + (attachments.size + 1);
    attachments.set(id, { id, companyCode, name, mime, bytes });
    return { id, name, mime, url: '/content/project-chat/' + encodeURIComponent(companyCode) + '/attachments/' + id };
  };
  const wall = addAttachment('palitra-love', 'ОБРАЗЕЦ — стена до покраски.png', 'image/png', wallPng());
  const swatch = addAttachment('palitra-love', 'ОБРАЗЕЦ — выкрасы колера.png', 'image/png', swatchPng());
  const estimate = addAttachment('palitra-love', 'ОБРАЗЕЦ — смета.pdf', 'application/pdf', samplePdf());

  const rooms = new Map([
    ['palitra-love', {
      companyCode: 'palitra-love',
      replyMode: 'addressed',
      telegramChatId: '-1000000000001',
      members: [1, 2, 3],
      everMembers: [1, 2, 3],
      nextMessage: 1,
      nextTask: 4,
      nextStage: 4,
      aiJobs: [],
      messages: [
        { id: 'm1', authorType: 'human', authorId: 1, authorName: 'Влад (образец)', text: 'Образец: начинаем ремонт переговорной. Собираю всех в общем чате проекта.', createdAt: at(0), deliveryStatus: 'sent', attachments: [] },
        { id: 'm2', authorType: 'telegram', authorId: 2, authorName: 'Дарья (образец)', text: 'Образец: замерила стену, 46 м². Фото прикладываю.', createdAt: at(12), deliveryStatus: 'sent', attachments: [wall] },
        { id: 'm3', authorType: 'human', authorId: 3, authorName: 'Анна (образец)', text: 'Образец: предлагаю тёплый бежевый, он лучше ложится на такую фактуру.', createdAt: at(21), deliveryStatus: 'sent', attachments: [] },
        { id: 'm4', authorType: 'human', authorId: 1, authorName: 'Влад (образец)', text: 'Образец: смета во вложении, посмотрите до среды.', createdAt: at(33), deliveryStatus: 'sent', attachments: [estimate] },
        { id: 'm5', authorType: 'telegram', authorId: 2, authorName: 'Дарья (образец)', text: 'Образец: снимала видео процесса, оно осталось в группе.', createdAt: at(41), deliveryStatus: 'sent', attachments: [{ id: 'external-1', name: 'ОБРАЗЕЦ — видео замера.mp4', mime: 'video/mp4', url: null, note: 'файл больше лимита, остался в Telegram' }] },
        { id: 'm6', authorType: 'human', authorId: 3, authorName: 'Анна (образец)', text: 'Образец: выкрасы колера при дневном свете.', createdAt: at(52), deliveryStatus: 'sent', attachments: [swatch] },
        { id: 'm7', authorType: 'human', authorId: 1, authorName: 'Влад (образец)', text: 'Образец: краску берём у прежнего поставщика.', createdAt: at(64), deliveryStatus: 'sent', attachments: [] },
        { id: 'm8', authorType: 'human', authorId: 2, authorName: 'Дарья (образец)', text: 'Образец: доставку подтвердили на четверг.', createdAt: at(77), deliveryStatus: 'uncertain', attachments: [] },
        { id: 'm9', authorType: 'human', authorId: 3, authorName: 'Анна (образец)', text: 'Образец: это сообщение не ушло в группу — видно отметку об ошибке.', createdAt: at(85), deliveryStatus: 'error', attachments: [] },
        { id: 'm10', authorType: 'human', authorId: 1, authorName: 'Влад (образец)', text: 'Образец: а это сообщение ещё ждёт отправки.', createdAt: at(92), deliveryStatus: 'pending', attachments: [] },
        { id: 'm11', authorType: 'telegram', authorId: 2, authorName: 'Дарья (образец)', text: 'Образец: из группы всё видно, отвечаю отсюда.', createdAt: at(101), deliveryStatus: 'sent', attachments: [] },
        { id: 'm12', authorType: 'human', authorId: 3, authorName: 'Анна (образец)', text: 'Образец: подготовку стены закончим завтра.', createdAt: at(112), deliveryStatus: 'sent', attachments: [] },
        { id: 'm13', authorType: 'human', authorId: 1, authorName: 'Влад (образец)', text: 'Хью, посчитай, сколько краски нужно на 46 м² в два слоя.', createdAt: at(120), deliveryStatus: 'sent', attachments: [], aiStatus: null, demoAi: true },
        { id: 'm14', authorType: 'assistant', authorName: 'Хью (образец)', text: AI_REPLY, createdAt: at(121), deliveryStatus: 'local', attachments: [] }
      ],
      tasks: [
        { id: 1, title: 'Образец: закупить краску и колеровку', status: 'in_progress', assigneeId: 2, stageId: 2, due: '2026-09-25', sourceMessageId: 'm7' },
        { id: 2, title: 'Образец: согласовать смету с владельцем', status: 'todo', assigneeId: 1, stageId: 1, due: '2026-09-20', sourceMessageId: 'm4' },
        { id: 3, title: 'Образец: сдать переговорную', status: 'done', assigneeId: 3, stageId: 3, due: '2026-09-30', sourceMessageId: null }
      ],
      stages: [
        { id: 1, title: 'Образец: подготовка' },
        { id: 2, title: 'Образец: закупка' },
        { id: 3, title: 'Образец: покраска' }
      ]
    }],
    ['alvi', {
      companyCode: 'alvi',
      replyMode: 'addressed',
      telegramChatId: '',
      members: [1, 3],
      everMembers: [1, 3],
      nextMessage: 1,
      nextTask: 1,
      nextStage: 1,
      aiJobs: [],
      messages: [
        { id: 'a1', authorType: 'human', authorId: 1, authorName: 'Влад (образец)', text: 'Образец: это другая компания. Переписка Палитры сюда не попадает.', createdAt: at(30), deliveryStatus: 'local', attachments: [] },
        { id: 'a2', authorType: 'human', authorId: 3, authorName: 'Анна (образец)', text: 'Образец: у АЛВИ свои участники, задачи и этапы.', createdAt: at(44), deliveryStatus: 'local', attachments: [] }
      ],
      tasks: [],
      stages: [{ id: 1, title: 'Образец: план' }]
    }]
  ]);

  const conversations = new Map();
  return { attachments, addAttachment, rooms, conversations, preview: { role: 'owner', ai: 'connected', access: 'granted' } };
};

/* ------------------------------------------------------------------- логика */

const accessFor = (role) => ({ canReply: role !== 'viewer', owner: role === 'owner' });
const aiBlock = (fixture, room) => {
  const queued = room.messages.filter((item) => ['pending', 'queued', 'running'].includes(item.aiStatus)).length;
  const failed = room.messages.filter((item) => ['failed', 'error'].includes(item.aiStatus)).length;
  const mode = fixture.preview.ai;
  if (mode === 'connected') return { configured: true, connected: true, runtimeState: 'connected', queued, failed };
  if (mode === 'off') return { configured: false, connected: false, runtimeState: 'disabled', queued: 0, failed: 0 };
  return { configured: true, connected: false, runtimeState: mode, queued, failed };
};
const runtimeStatus = (fixture) => {
  const mode = fixture.preview.ai;
  if (mode === 'connected') return { connected: true, authenticated: true, provider: 'codex', model: 'gpt-5-codex (образец)', state: 'connected' };
  if (mode === 'login_required') {
    // Код образца соблюдает настоящий формат ABCD-1234: кабинет показывает экран
    // подтверждения только при проверенной паре «ссылка + код».
    return { connected: false, authenticated: false, provider: 'codex', state: 'login_required', loginUrl: 'https://auth.openai.com/codex/device', userCode: 'DEMO-1234' };
  }
  if (mode === 'unavailable') return { connected: false, authenticated: false, provider: 'codex', state: 'unavailable', error: 'Образец: служба ответов не отвечает.' };
  return { connected: false, authenticated: false, provider: 'codex', state: 'unavailable', error: 'Образец: подписка не настроена.' };
};
// Доставка в Telegram и ответы Хью имитируются по часам этого процесса, наружу ничего не уходит.
const advance = (fixture, room) => {
  const now = Date.now();
  const mode = fixture.preview.ai;
  for (const item of room.messages) {
    if (item.deliveryStatus === 'sending' && item.deliverAt && now >= item.deliverAt) {
      item.deliveryStatus = 'sent';
      delete item.deliverAt;
    }
    // Заготовленное обращение к Хью сразу показывает состояние выбранного режима.
    if (item.demoAi) item.aiStatus = mode === 'login_required' ? 'queued' : mode === 'unavailable' ? 'failed' : null;
  }
  for (const job of room.aiJobs) {
    if (job.done || !job.answerAt || now < job.answerAt) continue;
    job.done = true;
    const source = room.messages.find((item) => item.id === job.messageId);
    if (source) source.aiStatus = null;
    room.nextMessage += 1;
    room.messages.push({
      id: 'preview-' + room.companyCode + '-' + room.nextMessage,
      authorType: 'assistant',
      authorName: 'Хью (образец)',
      text: AI_REPLY,
      createdAt: new Date().toISOString(),
      deliveryStatus: 'local',
      attachments: []
    });
  }
};
// \b не работает с кириллицей, поэтому проверяем, что дальше не идёт продолжение слова.
const addressesHugh = (text) => /^\s*хью(?![а-яё])/i.test(String(text || ''));

/* ------------------------------------------------------------------ страница */

const PAGE_HTML = `<!doctype html>
<html lang="ru" class="js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark">
<title>Предпросмотр · общий чат проекта (локальная фикстура)</title>
<link rel="stylesheet" href="/cabinet/common.css">
<link rel="stylesheet" href="/cabinet/hugh.css">
<link rel="stylesheet" href="/cabinet/project-chat.css">
<style>
/* Палитра и базовые правила скопированы из sites/synapse/cabinet.html,
   чтобы компоненты выглядели так же, как в кабинете. */
:root{--bg:#0b0908;--surface:#12100f;--surface-soft:#181513;--text:#f4f0eb;--muted:#b9afa7;--accent:#9fd4ff;--blue:#2e6bd6;--green:#79dcb6;--red:#ff9c9c;--line:rgba(244,240,235,.12)}
*{box-sizing:border-box}
html{min-width:0;background:var(--bg)}
body{min-width:0;min-height:100vh;margin:0;overflow-x:hidden;color:var(--text);background:radial-gradient(circle at 85% 0,rgba(46,107,214,.15),transparent 35rem),var(--bg);font-family:"Segoe UI",Arial,sans-serif;line-height:1.5}
button,input,select{font:inherit}
button{color:inherit}
[hidden]{display:none!important}
:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
h1{margin:0;font-family:Georgia,"Times New Roman",serif;font-size:clamp(2rem,4vw,3.4rem);font-weight:400}
.main{min-width:0;padding:clamp(24px,4vw,56px)}
.content-header{margin-bottom:26px}
.content-header p{margin:5px 0 0;color:var(--muted)}
.view-panel{width:min(100%,1180px)}
/* Панель предпросмотра намеренно отличается по стилю: на скриншоте видно, что это не продукт. */
.preview-bar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:10px clamp(16px,4vw,56px);border-bottom:2px dashed #e0b341;background:#2a2113;color:#ffe6ad;font-size:.82rem}
.preview-bar strong{font-size:.9rem}
.preview-bar label{display:inline-flex;gap:6px;align-items:center}
.preview-bar select,.preview-bar button{min-height:32px;padding:4px 8px;border:1px solid #e0b341;border-radius:8px;color:inherit;background:#3a2e18}
.preview-note{margin:0 0 20px;padding:12px 14px;border:1px dashed #e0b341;border-radius:12px;color:#ffe6ad;background:rgba(224,179,65,.08);font-size:.85rem}
.preview-note p{margin:4px 0}
</style>
</head>
<body>
<div class="preview-bar" role="region" aria-label="Управление предпросмотром">
  <strong>Локальный предпросмотр</strong>
  <label>Компания <select id="preview-company"></select></label>
  <label>Кто смотрит <select id="preview-role">
    <option value="owner">Владелец</option>
    <option value="member">Участник с ответом</option>
    <option value="viewer">Только чтение</option>
  </select></label>
  <label>Хью <select id="preview-ai">
    <option value="connected">Подключён (образец)</option>
    <option value="login_required">Ждёт входа</option>
    <option value="unavailable">Недоступен</option>
    <option value="off">Не настроен</option>
  </select></label>
  <label>Доступ <select id="preview-access">
    <option value="granted">Выдан</option>
    <option value="revoked">Отозван (403)</option>
  </select></label>
  <button type="button" id="preview-reset">Сбросить данные</button>
</div>
<main class="main" id="main-content">
  <section class="view-panel" id="hugh-view"></section>
  <div class="preview-note">
    <p><strong>Это фикстура для проверки вёрстки.</strong></p>
    <p>Участники, сообщения, фотографии, задачи и этапы вымышленные и помечены словом «образец».</p>
    <p>Отправка в Telegram и ответы Хью имитируются внутри этого процесса: внешних вызовов нет, подписка Codex не подключена.</p>
    <p>Мобильный вид: уменьшите окно примерно до 390&nbsp;px или включите эмуляцию устройства — раскладка переключается по ширине окна, а не контейнера.</p>
  </div>
</main>
<script>window.PREVIEW_CSRF = ${JSON.stringify(CSRF)}; window.SbCabinet = { views: {}, registerView: function (name, definition) { window.SbCabinet.views[name] = definition; } };</script>
<script src="/cabinet/hugh.js"></script>
<script src="/cabinet/project-chat.js"></script>
<script src="/preview.js"></script>
</body>
</html>
`;

// Клиентский код предпросмотра: строит минимальный контекст ЛК и монтирует настоящий модуль.
const PREVIEW_JS = `(function () {
  'use strict';
  var cabinet = window.SbCabinet;
  var token = window.PREVIEW_CSRF;
  var preview = { role: 'owner', ai: 'connected', access: 'granted', company: 'palitra-love' };
  var companies = [];
  var identity = null;
  var byId = function (id) { return document.getElementById(id); };
  var escapeHTML = function (value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>'"]/g, function (character) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character];
    });
  };
  var ctx = {
    get identity() { return identity; },
    get selectedProjectId() { return preview.company; },
    get currentView() { return 'hugh'; },
    byId: byId,
    escapeHTML: escapeHTML
  };
  var rebuild = function () {
    identity = {
      role: preview.role === 'owner' ? 'owner' : 'manager',
      userId: 1,
      login: 'preview',
      displayName: 'Влад (образец)',
      csrfToken: token,
      permissions: [],
      companies: companies
    };
  };
  var mount = function (projectChange) {
    rebuild();
    var view = cabinet.views.hugh;
    if (projectChange && view.onProjectChange) view.onProjectChange(ctx);
    else view.render(byId('hugh-view'), ctx);
  };
  var post = function (path, body) {
    return fetch(path, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify(body || {})
    }).then(function (response) { return response.json(); });
  };
  var fill = function (select, value) { select.value = value; };
  var apply = function (state) {
    preview.role = state.role;
    preview.ai = state.ai;
    preview.access = state.access;
    companies = state.companies;
    var companySelect = byId('preview-company');
    companySelect.replaceChildren();
    companies.forEach(function (company) {
      var option = document.createElement('option');
      option.value = company.id;
      option.textContent = company.name;
      companySelect.append(option);
    });
    fill(companySelect, preview.company);
    fill(byId('preview-role'), preview.role);
    fill(byId('preview-ai'), preview.ai);
    fill(byId('preview-access'), preview.access);
  };
  var change = function (patch, projectChange) {
    return post('/preview/state', patch).then(function (state) { apply(state); mount(projectChange); });
  };
  byId('preview-role').addEventListener('change', function (event) { change({ role: event.target.value }, false); });
  byId('preview-ai').addEventListener('change', function (event) { change({ ai: event.target.value }, false); });
  byId('preview-access').addEventListener('change', function (event) { change({ access: event.target.value }, false); });
  byId('preview-company').addEventListener('change', function (event) {
    preview.company = event.target.value;
    mount(true);
  });
  byId('preview-reset').addEventListener('click', function () {
    post('/preview/reset', {}).then(function (state) { apply(state); mount(false); });
  });
  fetch('/preview/state', { cache: 'no-store' }).then(function (response) { return response.json(); }).then(function (state) {
    apply(state);
    mount(false);
  });
})();
`;

/* -------------------------------------------------------------------- сервер */

const ASSETS = new Map([
  ['/cabinet/project-chat.js', ['project-chat.js', 'text/javascript; charset=utf-8']],
  ['/cabinet/project-chat.css', ['project-chat.css', 'text/css; charset=utf-8']],
  ['/cabinet/hugh.js', ['hugh.js', 'text/javascript; charset=utf-8']],
  ['/cabinet/hugh.css', ['hugh.css', 'text/css; charset=utf-8']],
  ['/cabinet/common.css', ['common.css', 'text/css; charset=utf-8']]
]);

const sendJson = (res, status, payload) => {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length });
  res.end(body);
};
const sendText = (res, status, type, body) => {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': buffer.length });
  res.end(buffer);
};
const readBody = (req) => new Promise((resolve, reject) => {
  const parts = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return; }
    parts.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(parts)));
  req.on('error', reject);
});
const readJson = async (req) => {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch (error) { throw new Error('BAD_JSON'); }
};

const createPreviewServer = () => {
  let fixture = createFixture();

  const previewState = () => ({ ...fixture.preview, csrfToken: CSRF, companies: COMPANIES });

  const handleProjectChat = async (req, res, method, segments, query) => {
    const companyCode = decodeURIComponent(segments[0] || '');
    const room = fixture.rooms.get(companyCode);
    if (!room) { sendJson(res, 404, { error: 'Компания не найдена в фикстуре' }); return; }
    if (fixture.preview.access === 'revoked') { sendJson(res, 403, { error: 'Образец: доступ к комнате отозван' }); return; }
    const access = accessFor(fixture.preview.role);
    const rest = segments.slice(1);
    advance(fixture, room);

    if (method === 'GET' && !rest.length) {
      const all = room.messages;
      const windowed = all.slice(-PAGE);
      sendJson(res, 200, {
        room: { companyCode, replyMode: room.replyMode, telegramChatId: room.telegramChatId },
        access,
        members: PEOPLE.filter((person) => room.members.includes(person.userId)),
        // Вышедшие участники нужны кабинету, чтобы показать историю назначений задач.
        formerMembers: PEOPLE.filter((person) => room.everMembers.includes(person.userId) && !room.members.includes(person.userId)),
        messages: windowed,
        hasMore: all.length > windowed.length,
        oldestMessageId: windowed.length ? windowed[0].id : null,
        tasks: room.tasks.map((task) => ({
          ...task,
          assigneeName: PEOPLE.find((person) => person.userId === task.assigneeId)?.displayName || null,
          assigneeActive: task.assigneeId ? room.members.includes(task.assigneeId) : null
        })),
        stages: room.stages,
        ai: aiBlock(fixture, room)
      });
      return;
    }

    if (method === 'GET' && rest[0] === 'messages' && rest.length === 1) {
      const limit = Math.min(Number(query.get('limit')) || PAGE, PAGE);
      const index = room.messages.findIndex((item) => item.id === query.get('before'));
      const end = index < 0 ? room.messages.length : index;
      const start = Math.max(0, end - limit);
      const slice = room.messages.slice(start, end);
      sendJson(res, 200, { messages: slice, hasMore: start > 0, oldestMessageId: slice.length ? slice[0].id : null });
      return;
    }

    if (method === 'GET' && rest[0] === 'attachments' && rest[1]) {
      const file = fixture.attachments.get(rest[1]);
      if (!file || file.companyCode !== companyCode) { sendJson(res, 404, { error: 'Файл не найден' }); return; }
      res.writeHead(200, {
        'Content-Type': file.mime,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(file.name),
        'Content-Length': file.bytes.length
      });
      res.end(file.bytes);
      return;
    }

    if (method === 'GET' && rest[0] === 'candidates') {
      if (!access.owner) { sendJson(res, 403, { error: 'Только владелец проекта' }); return; }
      sendJson(res, 200, { candidates: PEOPLE });
      return;
    }

    if (method === 'POST' && rest[0] === 'attachments' && rest.length === 1) {
      if (!access.canReply) { sendJson(res, 403, { error: 'Нет права ответа в комнате' }); return; }
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!UPLOAD_MIME.has(mime)) { sendJson(res, 400, { error: 'Такой тип файла не поддерживается: ' + (mime || 'не указан') }); return; }
      const bytes = await readBody(req);
      if (!bytes.length) { sendJson(res, 400, { error: 'Пустой файл' }); return; }
      let name = 'файл';
      try { name = decodeURIComponent(String(req.headers['x-filename'] || '')) || name; } catch (error) { name = 'файл'; }
      sendJson(res, 200, { attachment: fixture.addAttachment(companyCode, name, mime, bytes) });
      return;
    }

    if (method === 'POST' && rest[0] === 'messages' && rest.length === 1) {
      if (!access.canReply) { sendJson(res, 403, { error: 'Нет права ответа в комнате' }); return; }
      const payload = await readJson(req);
      const clientMessageId = String(payload.clientMessageId || '');
      const repeated = room.messages.find((item) => item.clientMessageId && item.clientMessageId === clientMessageId);
      if (repeated) { sendJson(res, 200, { message: repeated, duplicate: true }); return; }
      const files = (Array.isArray(payload.attachmentIds) ? payload.attachmentIds : [])
        .map((id) => fixture.attachments.get(String(id)))
        .filter((file) => file && file.companyCode === companyCode)
        .map((file) => ({ id: file.id, name: file.name, mime: file.mime, url: '/content/project-chat/' + encodeURIComponent(companyCode) + '/attachments/' + file.id }));
      const text = String(payload.text || '').trim().slice(0, 12000);
      if (!text && !files.length) { sendJson(res, 400, { error: 'Пустое сообщение' }); return; }
      room.nextMessage += 1;
      const message = {
        id: 'preview-' + companyCode + '-' + room.nextMessage,
        clientMessageId,
        authorType: 'human',
        authorId: 1,
        authorName: 'Влад (образец)',
        text,
        createdAt: new Date().toISOString(),
        deliveryStatus: room.telegramChatId ? 'sending' : 'local',
        deliverAt: room.telegramChatId ? Date.now() + 5000 : null,
        attachments: files
      };
      const mode = fixture.preview.ai;
      if (addressesHugh(text) || room.replyMode === 'delegate') {
        if (mode === 'connected') { message.aiStatus = 'queued'; room.aiJobs.push({ messageId: message.id, answerAt: Date.now() + 4000, done: false }); }
        else if (mode === 'login_required') message.aiStatus = 'queued';
        else if (mode === 'unavailable') message.aiStatus = 'failed';
      }
      room.messages.push(message);
      sendJson(res, 201, { message });
      return;
    }

    if (method === 'POST' && rest[0] === 'retry-ai') {
      if (!access.owner) { sendJson(res, 403, { error: 'Только владелец проекта' }); return; }
      await readJson(req);
      let retried = 0;
      for (const item of room.messages) {
        if (!['failed', 'error'].includes(item.aiStatus)) continue;
        retried += 1;
        item.demoAi = false;
        item.aiStatus = 'queued';
        if (fixture.preview.ai === 'connected') room.aiJobs.push({ messageId: item.id, answerAt: Date.now() + 3000, done: false });
      }
      sendJson(res, 200, { retried });
      return;
    }

    if (method === 'PUT' && rest[0] === 'members') {
      if (!access.owner) { sendJson(res, 403, { error: 'Только владелец проекта' }); return; }
      const payload = await readJson(req);
      const wanted = (Array.isArray(payload.userIds) ? payload.userIds : []).map(Number).filter((id) => PEOPLE.some((person) => person.userId === id));
      // Владельца предпросмотра оставляем в комнате, иначе из фикстуры нельзя было бы выйти обратно.
      room.members = wanted.includes(1) ? wanted : [1, ...wanted];
      room.everMembers = [...new Set([...room.everMembers, ...room.members])];
      sendJson(res, 200, { members: PEOPLE.filter((person) => room.members.includes(person.userId)) });
      return;
    }

    if (method === 'PATCH' && rest[0] === 'settings') {
      if (!access.owner) { sendJson(res, 403, { error: 'Только владелец проекта' }); return; }
      const payload = await readJson(req);
      if (payload.replyMode === 'delegate' || payload.replyMode === 'addressed') room.replyMode = payload.replyMode;
      if (typeof payload.telegramChatId === 'string') {
        const value = payload.telegramChatId.trim();
        if (value && !/^-?\d{5,20}$/.test(value)) { sendJson(res, 400, { error: 'Образец: ID группы должен состоять из цифр' }); return; }
        // Сохраняем только в памяти процесса: бот не вызывается, привязка не создаётся.
        room.telegramChatId = value;
      }
      sendJson(res, 200, { room: { companyCode, replyMode: room.replyMode, telegramChatId: room.telegramChatId } });
      return;
    }

    if ((method === 'POST' || method === 'PATCH') && rest[0] === 'tasks') {
      if (!access.canReply) { sendJson(res, 403, { error: 'Нет права ответа в комнате' }); return; }
      const payload = await readJson(req);
      const title = String(payload.title || '').trim().slice(0, 200);
      if (!title) { sendJson(res, 400, { error: 'Укажите название задачи' }); return; }
      if (payload.due && !/^\d{4}-\d{2}-\d{2}$/.test(String(payload.due))) { sendJson(res, 400, { error: 'Срок указан не датой' }); return; }
      if (payload.status && !['todo', 'in_progress', 'done', 'blocked'].includes(payload.status)) { sendJson(res, 400, { error: 'Неизвестный статус' }); return; }
      const existing = method === 'PATCH' ? room.tasks.find((item) => String(item.id) === String(rest[1])) : null;
      if (method === 'PATCH' && !existing) { sendJson(res, 404, { error: 'Задача не найдена' }); return; }
      const assigneeId = payload.assigneeId === null ? null : Number(payload.assigneeId) || null;
      // Исторического исполнителя разрешаем сохранить; назначить нового вышедшего — нет.
      const keptAssignee = existing && String(assigneeId === null ? '' : assigneeId) === String(existing.assigneeId === null || existing.assigneeId === undefined ? '' : existing.assigneeId);
      if (assigneeId && !room.members.includes(assigneeId) && !keptAssignee) { sendJson(res, 400, { error: 'Исполнитель не участвует в этом проекте' }); return; }
      const stageId = payload.stageId === null ? null : Number(payload.stageId) || null;
      if (stageId && !room.stages.some((stage) => stage.id === stageId)) { sendJson(res, 400, { error: 'Этап относится к другому проекту' }); return; }
      if (existing) {
        Object.assign(existing, { title, assigneeId, stageId, due: payload.due || null, status: payload.status || existing.status });
        sendJson(res, 200, { task: existing });
        return;
      }
      const sourceMessageId = payload.sourceMessageId && room.messages.some((item) => item.id === payload.sourceMessageId) ? payload.sourceMessageId : null;
      const task = { id: room.nextTask, title, assigneeId, stageId, due: payload.due || null, status: payload.status || 'todo', sourceMessageId };
      room.nextTask += 1;
      room.tasks.push(task);
      sendJson(res, 201, { task });
      return;
    }

    if ((method === 'POST' || method === 'PATCH') && rest[0] === 'stages') {
      if (!access.canReply) { sendJson(res, 403, { error: 'Нет права ответа в комнате' }); return; }
      const payload = await readJson(req);
      const title = String(payload.title || '').trim().slice(0, 200);
      if (!title) { sendJson(res, 400, { error: 'Укажите название этапа' }); return; }
      if (method === 'PATCH') {
        const stage = room.stages.find((item) => String(item.id) === String(rest[1]));
        if (!stage) { sendJson(res, 404, { error: 'Этап не найден' }); return; }
        stage.title = title;
        sendJson(res, 200, { stage });
        return;
      }
      const stage = { id: room.nextStage, title };
      room.nextStage += 1;
      room.stages.push(stage);
      sendJson(res, 201, { stage });
      return;
    }

    sendJson(res, 404, { error: 'Фикстура не знает такой маршрут' });
  };

  const handlePrivateHugh = async (req, res, method, segments) => {
    const conversationId = segments[1] || 'preview-conversation';
    if (method === 'POST' && segments.length === 1) {
      const payload = await readJson(req);
      const id = 'preview-' + String(payload.site || 'company');
      fixture.conversations.set(id, [{ role: 'assistant', text: 'Образец: это личная переписка владельца. Участники проекта её не видят.' }]);
      sendJson(res, 200, { id, visitorToken: 'preview-visitor', reply: 'Образец: это личная переписка владельца. Участники проекта её не видят.' });
      return;
    }
    if (method === 'GET' && segments.length === 2) {
      sendJson(res, 200, { messages: fixture.conversations.get(conversationId) || [{ role: 'assistant', text: 'Образец: личная переписка владельца.' }] });
      return;
    }
    if (method === 'POST' && segments[2] === 'messages') {
      const payload = await readJson(req);
      const history = fixture.conversations.get(conversationId) || [];
      const reply = 'Образец личного ответа. Подписка Codex в предпросмотре не подключена.';
      history.push({ role: 'owner', text: String(payload.text || '') }, { role: 'assistant', text: reply });
      fixture.conversations.set(conversationId, history);
      sendJson(res, 200, { reply });
      return;
    }
    sendJson(res, 404, { error: 'Фикстура не знает такой маршрут' });
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!isLoopback(req.socket.remoteAddress) || !allowedHost(req.headers.host)) {
        sendJson(res, 403, { error: 'Предпросмотр доступен только с этого компьютера' });
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      const method = (req.method || 'GET').toUpperCase();
      const pathname = url.pathname;
      if (method !== 'GET' && req.headers['x-csrf-token'] !== CSRF) {
        sendJson(res, 403, { error: 'Нет фикстурного CSRF-заголовка' });
        return;
      }

      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) { sendText(res, 200, 'text/html; charset=utf-8', PAGE_HTML); return; }
      if (method === 'GET' && pathname === '/preview.js') { sendText(res, 200, 'text/javascript; charset=utf-8', PREVIEW_JS); return; }
      if (method === 'GET' && pathname === '/preview/state') { sendJson(res, 200, previewState()); return; }
      if (method === 'POST' && pathname === '/preview/state') {
        const payload = await readJson(req);
        if (['owner', 'member', 'viewer'].includes(payload.role)) fixture.preview.role = payload.role;
        if (['connected', 'login_required', 'unavailable', 'off'].includes(payload.ai)) fixture.preview.ai = payload.ai;
        if (['granted', 'revoked'].includes(payload.access)) fixture.preview.access = payload.access;
        sendJson(res, 200, previewState());
        return;
      }
      if (method === 'POST' && pathname === '/preview/reset') {
        const keep = { ...fixture.preview };
        fixture = createFixture();
        fixture.preview = keep;
        sendJson(res, 200, previewState());
        return;
      }
      if (method === 'GET' && ASSETS.has(pathname)) {
        const [file, type] = ASSETS.get(pathname);
        sendText(res, 200, type, fs.readFileSync(path.join(CABINET, file)));
        return;
      }
      if (method === 'GET' && pathname === '/content/project-chat-runtime/status') { sendJson(res, 200, runtimeStatus(fixture)); return; }
      if (method === 'POST' && pathname === '/content/project-chat-runtime/login') {
        await readJson(req);
        // Вход не выполняется: фикстура только показывает экран, который увидит владелец.
        sendJson(res, 200, runtimeStatus(fixture));
        return;
      }
      if (pathname.startsWith('/content/project-chat/')) {
        await handleProjectChat(req, res, method, pathname.slice('/content/project-chat/'.length).split('/').filter(Boolean), url.searchParams);
        return;
      }
      if (pathname.startsWith('/content/hugh/conversations')) {
        await handlePrivateHugh(req, res, method, pathname.slice('/content/hugh/'.length).split('/').filter(Boolean));
        return;
      }
      sendJson(res, 404, { error: 'Нет такой страницы в предпросмотре' });
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      sendJson(res, error.message === 'BODY_TOO_LARGE' ? 413 : 500, { error: 'Ошибка фикстуры: ' + error.message });
    }
  });
  return server;
};

const readPort = (argv, env) => {
  const flag = argv.indexOf('--port');
  const raw = flag >= 0 ? argv[flag + 1] : env.PROJECT_CHAT_PREVIEW_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_PORT;
};

if (require.main === module) {
  const port = readPort(process.argv.slice(2), process.env);
  const server = createPreviewServer();
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    process.stdout.write('Предпросмотр общего чата проекта: http://127.0.0.1:' + address.port + '/\n');
    process.stdout.write('Только локальный доступ, данные вымышленные, внешних вызовов нет. Остановка — Ctrl+C.\n');
  });
}

module.exports = { createPreviewServer, isLoopback, allowedHost, readPort, samplePng, CSRF, PAGE, PEOPLE, COMPANIES };
