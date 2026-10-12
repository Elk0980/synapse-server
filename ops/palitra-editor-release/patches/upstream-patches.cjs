'use strict';
/* PALITRA-BOT-EDITOR-35, проход 2: точные кандидаты правок. НЕ ПРИМЕНЕНЫ.
   Каждая правка — только вставка целых строк рядом с якорем, который встречается в файле ровно один раз.
   Удалений и изменений существующих байтов нет. Перевод строки вставки берётся из самого файла
   (локальная копия BASE/server.js — CRLF). Проверка: tests/run-tests.cjs применяет кандидаты к BASE и
   убеждается, что после удаления вставок файл совпадает с BASE байт в байт.

   Применяет Root на свежем BASE: сверить sha256 файла, применить applyPatch, сравнить с ожидаемым, затем
   backup → установка → перезапуск → проверки из REPORT_PASS2.md. */

const SERVER_SHA256 = '7b60187397cb11fe7e382682fb65e5a1600b35255bf85c8bbdfe2b122c35d8a2';

/* 1. Фото черновика: импорт, инициализация после workspaceFeature, обработчик перед workspaceFeature.routes. */
const PHOTO_FEATURE = Object.freeze({
  name: 'photo-feature', file: 'server.js', baseSha256: SERVER_SHA256,
  edits: [
    { anchor: "const {createWorkspaceFeature}=require('./site-workspace-feature');\n", position: 'after',
      lines: ["const {createPalitraPhotoFeature}=require('./palitra-photo-feature');"] },
    { anchor: '  },databasePath:DATABASE_PATH,assetsDir:ASSETS_DIR});\n', position: 'after',
      lines: [
        '// Фото черновика Palitra: узкие права на фото, только site-44bbe13f1bad5e005b2a/index.html (PALITRA-BOT-EDITOR-35).',
        '// decodeImage:null — загрузка новых фото выключена до подключения декодера (server-adapter/DECODER.md).',
        'const photoFeature=createPalitraPhotoFeature({db,authStore,requireSession,requireCsrf,readJson,readRaw,',
        '  workspaceStore:workspaceFeature.store,assetsDir:ASSETS_DIR,decodeImage:null,expectedPublicUrl:null});'
      ] },
    { anchor: '    if(await workspaceFeature.routes(request,reply,url))return;\n', position: 'before',
      lines: ['    if(await photoFeature.handle(request,reply,url))return;'] }
  ]
});

/* 2. Прайс Palitra 12–18: CAS только для /content/palitra/price. Остальные документы, restore, auth — как были. */
const PRICE_CAS = Object.freeze({
  name: 'price-cas', file: 'server.js', baseSha256: SERVER_SHA256,
  edits: [
    { anchor: "const { resolveSessionSecret } = require('./session-secret');\n", position: 'after',
      lines: ["const palitraPrice = require('./palitra-price-validate.js');"] },
    { anchor: '      if (!row) fail(404, `Документ ${key} не найден`);\n', position: 'after',
      lines: [
        '      // Только palitra/price: заголовок обещает проверку If-Match в PUT ниже (пакет 12–18, ставится вместе с ним).',
        '      if (palitraPrice.isPalitraPrice(parts)) return reply(200, row.body, { etag: `"${row.version}"`, [palitraPrice.CAS_HEADER]: palitraPrice.CAS_HEADER_VALUE });'
      ] },
    { anchor: '      const doc = await readJson(request);\n', position: 'after',
      lines: [
        '      // Только palitra/price: форма документа → 422, версия If-Match проверяется внутри BEGIN IMMEDIATE (409), strict выключен.',
        '      if (palitraPrice.isPalitraPrice(parts)) {',
        '        // Права перепроверяются синхронно после чтения тела, непосредственно перед записью.',
        "        const current = requireContentAccess(request, 'price.edit', parts[1], true).author;",
        '        const problems = palitraPrice.validatePriceProblems(doc);',
        "        if (problems.length) fail(422, 'Документ не прошёл проверку', problems.slice(0, 50));",
        "        const saved = palitraPrice.saveWithCas(db, key, doc, current, request.headers['if-match'], { strict: false });",
        '        return reply(200, { ok: true, key, ...saved });',
        '      }'
      ] }
  ]
});

/* 3. Тестовый просмотр бота: обычная https-ссылка в кабинет, без параметров. Формы, заказы, demo и мост не меняются. */
const BOT_PREVIEW_LINK = Object.freeze({
  name: 'bot-preview-link', file: 'bot-preview-index.html', baseSha256: null,
  edits: [
    { anchor: '  <div id="previewBanner" class="preview-banner" role="alert" hidden></div>\n', position: 'before',
      lines: [
        '  <!-- PALITRA-BOT-EDITOR-35: обычная ссылка в кабинет. Сама прав не даёт: вход и права проверяет кабинет. Не связана с выбором «Участник». -->',
        '  <p class="staff-editor-link"><a href="https://synapse.synapsebusiness.ru/cabinet/palitra-editor.html" target="_blank" rel="noopener noreferrer">Сотрудникам — редактор Palitra</a></p>'
      ] }
  ]
});

const count = (text, needle) => { let n = 0, i = -1; while ((i = text.indexOf(needle, i + 1)) !== -1) n += 1; return n; };

/* Применяет правки по очереди. Любой неоднозначный или отсутствующий якорь — ошибка, файл не меняется. */
function applyPatch(text, patch) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (eol === '\r\n' && /(^|[^\r])\n/.test(text)) throw new Error(`${patch.name}: смешанные переводы строк`);
  let result = text;
  const inserted = [];
  for (const edit of patch.edits) {
    const anchor = edit.anchor.replace(/\n/g, eol);
    const n = count(result, anchor);
    if (n !== 1) throw new Error(`${patch.name}: якорь встречается ${n} раз: ${edit.anchor.trim()}`);
    const at = result.indexOf(anchor);
    if (at > 0 && result[at - 1] !== '\n') throw new Error(`${patch.name}: якорь не с начала строки`);
    const block = edit.lines.map(line => line + eol).join('');
    if (block.includes(anchor)) throw new Error(`${patch.name}: вставка повторяет якорь`);
    const position = edit.position === 'after' ? at + anchor.length : at;
    result = result.slice(0, position) + block + result.slice(position);
    inserted.push(block);
  }
  return { text: result, inserted, eol };
}

module.exports = { SERVER_SHA256, PHOTO_FEATURE, PRICE_CAS, BOT_PREVIEW_LINK, applyPatch };
