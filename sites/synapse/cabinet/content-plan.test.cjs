'use strict';
/* №98 Б: экран «Контент-план» на настоящем файле модуля, ctx по контракту А и заглушке API (данные SAMPLE). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, 'content-plan.js'), 'utf8');
const importSource = fs.readFileSync(path.join(__dirname, 'reel-plan-import.js'), 'utf8');
const kitSource = fs.readFileSync(path.join(__dirname, 'cf-kit.js'), 'utf8');
const VOCAB = { platforms: [{ id: 'vk', label: 'ВКонтакте' }, { id: 'telegram', label: 'Telegram' }], formats: [{ id: 'reel', label: 'Рилс' }], roles: [{ id: 'reach', label: 'Охватный' }] };
const idea = (n, extra = {}) => ({ ideaId: `s-${n}`, date: `2026-11-1${n}`, platform: 'vk', format: 'reel', role: 'reach',
  topic: `SAMPLE тема ${n}`, hook: 'SAMPLE хук', script: 'Мастер: Здравствуйте!\nКлиент: <b>Привет</b>\nПауза, смех',
  broll: 'SAMPLE руки', style: 'SAMPLE тёплый свет', props: 'SAMPLE халат', filmingBy: 'SAMPLE оператор', variants: { vk: { text: 'SAMPLE подпись', contentRevision: 1 } }, ...extra });

function api({ plan = [idea(1), idea(2)], role = 'owner', permissions = [], stage = 'approval', withRegistry = true, settings = undefined, view = '', qPlatforms = ['vk'], briefPlatforms = ['vk'], suggest = null, withKit = false, variants = null, mentorExtra = {}, planExtra = {} } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://cabinet.test/', runScripts: 'outside-only' });
  const { window } = dom, calls = [], opened = [];
  const db = {
    mentor: { companyCode: 'alpha', brief: { revision: 2, fields: { goal: '', audience: 'есть', platforms: briefPlatforms } }, vocabulary: VOCAB,
      plan: plan.length ? { revision: 4, briefRevision: 2, days: plan, ...planExtra } : null, ...mentorExtra,
      variants: variants || plan.map((p, i) => ({ ideaId: p.ideaId, platform: 'vk', status: i ? 'pending' : 'approved', approvable: true })) },
    questionnaire: { companyCode: 'alpha', revision: 3, filled: 1, total: 8, updatedAt: null, updatedBy: '', rules: ['Цены — только подтверждённые.'],
      fields: { goals: 'SAMPLE цель', audience: '', tone: '', rubrics: '', frequency: '', onCamera: '', constraints: '', platforms: qPlatforms } },
    signoffs: { companyCode: 'alpha', approversSource: 'stub', planRevision: plan.length ? 4 : 0, briefRevision: 2, stage: plan.length ? stage : 'none',
      approvers: [{ slot: 'owner', label: 'Владелец', checked: false, actorName: '', canCheck: role === 'owner' }], ideas: 2, approvedIdeas: 1, emptyIdeas: [] },
  };
  const reply = (method, p, body) => {
    calls.push({ path: p, method, body: plain(body) });
    if (p === 'crm/media-mentor') return db.mentor;
    if (p === 'crm/media-mentor/questionnaire') return method === 'PUT' ? { ...db.questionnaire, revision: db.questionnaire.revision + 1, filled: 2, fields: { ...db.questionnaire.fields, ...body.fields } } : db.questionnaire;
    if (p === 'crm/media-mentor/plan/signoffs') return method === 'POST' ? { ...db.signoffs, stage: 'smm' } : db.signoffs;
    if (p === 'crm/media-mentor/brief') return { ...db.mentor, brief: { revision: 3, fields: { ...db.mentor.brief.fields, ...body.brief } } };
    if (p === 'crm/media-mentor/plan') return db.mentor;
    if (p === 'crm/media-mentor/plan/variants/decision') return db.mentor;
    if (p === 'crm/media-mentor/plan/import-preview') return { companyCode: 'alpha', rows: [['Дата', 'Площадка', 'Тема', 'Формат', 'Хук', 'Вставки', 'Стиль', 'Реквизит'],
      ['05.12.2026', 'вк', 'Импорт SAMPLE', 'рилс', 'Импорт хук', 'Импорт вставки', 'Импорт стиль', 'Импорт реквизит']] };
    if (p === 'media-mentor-suggest' && suggest) return suggest;
    if (p === 'media-mentor-suggest') return { status: 'ok', notice: 'Предложение модели', items: [{ date: '2026-11-20', platform: 'vk', format: 'reel', role: 'reach', topic: 'Новая', hook: 'Хук нов' },
      { date: '2026-11-09', platform: 'vk', format: 'reel', role: 'reach', topic: 'Ранняя', hook: '' }] };
    throw Error('unexpected ' + p);
  };
  const user = { role, permissions };
  const ctx = {
    moduleId: 'content-plan', companyCode: 'alpha', user: { id: 7, name: 'SAMPLE', role }, permissions,
    can: (perm) => role === 'owner' || permissions.includes(perm), signal: new window.AbortController().signal,
    route: { path: '', params: new URLSearchParams(view ? `view=${view}` : '') },
    api: { get: async (p) => reply('GET', p), put: async (p, b) => reply('PUT', p, b), post: async (p, b) => reply('POST', p, b) },
    settings: { content: { get: async () => { if (settings === 'missing') throw Object.assign(Error('нет'), { status: 404 }); return settings || null; } } },
    navigate: (v) => opened.push(['navigate', v]), openHughChat: () => opened.push(['hugh']),
  };
  const registered = [];
  window.SbCabinet = {};
  if (withRegistry) window.SynapseModules = { register: (name, def) => registered.push([name, def]) };
  window.eval(importSource);
  if (withKit) window.eval(kitSource);
  window.eval(source);
  const root = window.document.getElementById('root');
  const def = () => registered.find((r) => r[0] === 'content-plan')?.[1];
  return { window, root, ctx, calls, opened, registered, user, def, mount: () => def().mount(root, ctx) };
}
// Объекты из окна jsdom приводятся к обычным, чтобы deepEqual сравнивал содержимое.
const plain = (v) => v === undefined ? v : JSON.parse(JSON.stringify(v));
// №186: анкета открывается окном поверх (⚙ или «+ Новый»), на вкладке её нет.
const openQ = (a, sel = '[data-cp="settings-plan"]') => a.root.querySelector(sel).click();
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('registers through SynapseModules; without registry it waits in SynapseModulesQueue for the shell', () => {
  const a = api();
  assert.deepEqual(a.registered.map((r) => r[0]), ['content-plan']);
  assert.equal(typeof a.def().mount, 'function'); assert.equal(typeof a.def().unmount, 'function');
  const b = api({ withRegistry: false });
  assert.equal(b.registered.length, 0);
  assert.equal(b.window.SynapseModulesQueue[0][0], 'content-plan');
  assert.equal(typeof b.window.SynapseModulesQueue[0][1].mount, 'function');
});

test('макет 07.11: карточка — дата, статус, тема со стрелкой, значки площадок; без №; полный вид — поля идеи и детали', async () => {
  const a = api(); await a.mount();
  const rows = [...a.root.querySelectorAll('.cp-row')];
  assert.equal(rows.length, 2);
  assert.doesNotMatch(rows[0].textContent, /№/); assert.match(rows[0].textContent, /SAMPLE тема 1/);
  assert.equal(rows[0].querySelector('.cp-nets').getAttribute('aria-label'), 'Площадки: ВКонтакте');
  assert.deepEqual([...rows[0].querySelectorAll('.cp-nb')].map((n) => n.textContent), ['VK']);
  assert.match(rows[0].querySelector('.cp-st').textContent, /Согласовано/); assert.match(rows[1].querySelector('.cp-st').textContent, /На согласовании/);
  assert.equal(rows[0].querySelector('.cp-chev').textContent, '▾'); assert.equal(rows[0].querySelector('.cp-full'), null);
  rows[0].querySelector('[data-toggle]').click();
  const full = a.root.querySelector('.cp-full');
  assert.equal(a.root.querySelector('[data-idea="s-1"] .cp-chev').textContent, '▴');
  const fields = Object.fromEntries([...full.querySelectorAll('.cp-fgrid > div')].map((d) => [d.querySelector('dt').textContent, d.querySelector('dd').textContent]));
  // Порядок раскрытой карточки макета 07.11: Дата, Формат, Съёмка, Задача, Статус, Правки (Исходники и «Вышло» — когда есть данные).
  assert.deepEqual(Object.keys(fields), ['Дата', 'Формат', 'Что снять', 'Съёмка', 'Задача', 'Статус', 'Правки'], 'исходников и публикаций в данных нет — не показываются; правок нет — «—»');
  assert.equal(fields['Формат'], 'Рилс'); assert.equal(fields['Съёмка'], 'SAMPLE оператор'); assert.equal(fields['Задача'], 'Охватный'); assert.equal(fields['Правки'], '—');
  assert.match(fields['Дата'], /^(Пн|Вт|Ср|Чт|Пт|Сб|Вс) \d{2}\.\d{2}$/, 'дата как в макете: «Сб 01.11»');
  // «До съёмки» — после сцен.
  const blocks = [...full.children].map((n) => n.className);
  assert.ok(blocks.indexOf('cp-before') > blocks.indexOf('cp-secs'), 'блок «До съёмки» после «Сценария по секундам»');
  // Макет: «До съёмки» и детали плана — приглушённые строки «Подпись: значение», без отдельной таблицы.
  assert.equal(full.querySelector('.cp-before dl'), null);
  assert.equal(full.querySelector('.cp-before [data-key="hook"] b').textContent, 'Хук:');
  for (const text of ['SAMPLE хук', 'SAMPLE руки', 'SAMPLE тёплый свет', 'SAMPLE халат', 'SAMPLE подпись']) assert.ok(full.textContent.includes(text), text);
  assert.deepEqual([...full.querySelectorAll('.cp-sec th')].map((th) => th.textContent), ['Сцена', 'Кто говорит', 'Точная реплика', 'Действие / монтаж'], 'пустые колонки скрыты');
  const script = [...full.querySelectorAll('.cp-sec tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent));
  assert.deepEqual(script, [['Сцена №1', 'Мастер', 'Здравствуйте!', ''], ['Сцена №2', 'Клиент', '<b>Привет</b>', ''], ['Сцена №3', '', '', 'Пауза, смех']]);
  assert.equal(full.querySelector('.cp-sec td[data-label="Сцена"] b').textContent, 'Сцена №1', '«Сцена №N» жирным');
  assert.ok(![...full.querySelectorAll('b')].some((b) => b.textContent === 'Привет'), 'server text is escaped');
  assert.equal(a.root.querySelector('.cp-stage'), null, 'статус уже в шапке кабинета');
});

test('full plan is a sheet: one row per reel with hook, B-roll, style, roles, props; № opens the card', async () => {
  const a = api({ view: 'full' }); await a.mount();
  const head = [...a.root.querySelectorAll('.cp-sheet thead th')].map((th) => th.textContent);
  assert.deepEqual(head, ['№', 'Дата', 'Площадки', 'Тема', 'Хук (1–2 с)', 'Вставки (B-roll)', 'Стиль', 'Сценарий по ролям', 'Реквизит', 'Кто снимает', 'Статус']);
  const rows = [...a.root.querySelectorAll('.cp-sheet > tbody > tr')];
  assert.equal(rows.length, 2);
  const cells = Object.fromEntries([...rows[0].children].map((td) => [td.dataset.label, td.textContent.trim()]));
  assert.equal(cells['Хук (1–2 с)'], 'SAMPLE хук'); assert.equal(cells['Вставки (B-roll)'], 'SAMPLE руки'); assert.equal(cells['Реквизит'], 'SAMPLE халат');
  assert.equal(rows[0].querySelectorAll('.cp-script tr').length, 3);
  assert.equal(a.root.querySelector('[data-cp-view]'), null, 'переключатель вида убран');
  rows[1].querySelector('[data-open-row]').click();
  assert.equal(a.root.querySelector('.cp-sheet'), null);
  assert.equal(a.root.querySelector('.cp-row[data-idea="s-2"] .cp-full') !== null, true);
  assert.equal(a.root.querySelector('[data-cp-view]'), null);
});

test('questionnaire autosaves only the changed field with the last revision', async () => {
  const a = api(); await a.mount(); openQ(a);
  const tone = a.root.querySelector('[data-q="tone"]');
  tone.value = 'дружески'; tone.dispatchEvent(new a.window.Event('input'));
  await tick(800); await tick();
  const put = a.calls.filter((c) => c.path === 'crm/media-mentor/questionnaire' && c.method === 'PUT');
  assert.equal(put.length, 1); assert.deepEqual(put[0].body, { revision: 3, fields: { tone: 'дружески' } });
  assert.match(a.root.querySelector('[data-cp-saved]').textContent, /Сохранено · заполнено 2 из 8/);
});

test('Hugh plan fills only empty brief fields, then saves sorted days with captions from hook and topic', async () => {
  const a = api(); await a.mount(); openQ(a);
  a.root.querySelector('[data-cp="generate"]').click();
  await tick(); await tick(); await tick();
  const brief = a.calls.find((c) => c.path === 'crm/media-mentor/brief');
  assert.deepEqual(brief.body.brief, { goal: 'SAMPLE цель' }, 'filled audience and platforms are not overwritten');
  const suggest = a.calls.find((c) => c.path === 'media-mentor-suggest');
  assert.equal(suggest.body.days, 7);
  a.root.querySelector('[data-cp="accept"]').click(); await tick(); await tick();
  const put = a.calls.find((c) => c.path === 'crm/media-mentor/plan' && c.method === 'PUT');
  assert.equal(put.body.planRevision, 4); assert.equal(put.body.briefRevision, 3);
  assert.deepEqual(put.body.days.map((d) => d.date), ['2026-11-09', '2026-11-11', '2026-11-12', '2026-11-20']);
  assert.equal(put.body.days[3].variants.vk.text, 'Хук нов\n\nНовая'); assert.equal(put.body.days[0].variants.vk.text, 'Ранняя');
});

test('CSV/XLSX import from PR 496 runs inside the screen and saves hook, B-roll, style, props with a caption', async () => {
  const a = api(); await a.mount(); openQ(a);
  const panel = a.root.querySelector('[data-cp-import] .mentor-import');
  assert.ok(panel, 'import panel installed');
  const file = new a.window.File(['x'], 'plan.csv', { type: 'text/csv' });
  file.arrayBuffer = async () => new Uint8Array([120]).buffer;
  a.window.crypto.subtle = { digest: async () => new Uint8Array(32).buffer };
  const input = panel.querySelector('[data-import-file]');
  Object.defineProperty(input, 'files', { value: [file] });
  await input.onchange(); await tick();
  const add = panel.querySelector('[data-import-add]');
  assert.equal(add.disabled, false, panel.querySelector('[data-import-state]').textContent);
  add.click(); await tick(); await tick();
  const put = a.calls.find((c) => c.path === 'crm/media-mentor/plan' && c.method === 'PUT');
  const row = put.body.days.find((d) => d.topic === 'Импорт SAMPLE');
  assert.equal(row.hook, 'Импорт хук'); assert.equal(row.broll, 'Импорт вставки'); assert.equal(row.style, 'Импорт стиль'); assert.equal(row.props, 'Импорт реквизит');
  assert.equal(row.variants.vk.text, 'Импорт хук\n\nИмпорт SAMPLE');
  assert.equal(a.calls.find((c) => c.path === 'crm/media-mentor/plan/import-preview').method, 'POST');
});

test('row edit keeps other fields and replaces caption; signoff posts own slot; chat opens Hugh via ctx', async () => {
  const a = api(); await a.mount();
  a.root.querySelector('[data-toggle]').click();
  const form = a.root.querySelector('[data-edit="s-1"]');
  form.querySelector('[name="broll"]').value = ' новая вставка '; form.querySelector('[name="caption"]').value = 'Новая подпись';
  form.dispatchEvent(new a.window.Event('submit', { cancelable: true })); await tick(); await tick();
  const put = a.calls.find((c) => c.path === 'crm/media-mentor/plan' && c.method === 'PUT');
  assert.equal(put.body.days[0].broll, 'новая вставка'); assert.equal(put.body.days[0].variants.vk.text, 'Новая подпись');
  assert.equal(put.body.days[0].variants.vk.contentRevision, 1); assert.equal(put.body.days[1].broll, 'SAMPLE руки');
  const box = a.root.querySelector('[data-signoff="owner"]');
  box.checked = true; box.dispatchEvent(new a.window.Event('change')); await tick(); await tick();
  assert.deepEqual(a.calls.find((c) => c.method === 'POST' && c.path.endsWith('/signoffs')).body, { planRevision: 4, briefRevision: 2, slot: 'owner', checked: true });
  assert.equal(a.root.querySelector('[data-cp="chat"]'), null);
});

test('approvers come from Настройки → Контент: names from candidates, honest note when server fell back to the owner', async () => {
  const settings = { version: 2, canEdit: true, settings: { approverUserIds: [5, 7] }, candidates: [{ id: 5, name: 'SAMPLE Лена' }, { id: 7, name: 'SAMPLE Таня' }] };
  const a = api({ settings }); await a.mount();
  const block = a.root.querySelector('.cp-approve').textContent;
  assert.match(block, /Согласуют по «Настройкам → Контент»: SAMPLE Лена, SAMPLE Таня/);
  assert.match(block, /Сервер не принял выбранных согласующих/);
  a.root.querySelector('[data-cp="settings"]').click();
  assert.deepEqual(a.opened.at(-1), ['navigate', 'settings/content']);
  const b = api({ settings: 'missing', role: 'editor', permissions: ['autoposting.view'] }); await b.mount();
  assert.match(b.root.querySelector('.cp-approve').textContent, /задаётся в «Настройках → Контент»/);
  assert.equal(b.root.querySelector('[data-cp="settings"]'), null);
});

test('viewer without edit right sees the plan read-only and cannot tick another approver', async () => {
  const a = api({ role: 'editor', permissions: ['autoposting.view'] }); await a.mount(); openQ(a);
  assert.equal(a.root.querySelector('[data-cp="generate"]'), null); assert.equal(a.root.querySelector('.mentor-import'), null);
  assert.ok(a.root.querySelector('[data-q="goals"]').readOnly); assert.ok(a.root.querySelector('[data-signoff="owner"]').disabled);
  assert.equal(a.root.querySelectorAll('.cp-row').length, 2);
});

test('403 from the server is shown as no access, unmount drops late answers', async () => {
  const a = api();
  a.ctx.api.get = async () => { throw Object.assign(Error('x'), { status: 403 }); };
  await a.mount();
  assert.match(a.root.textContent, /Нет доступа к контент-плану/);
  const b = api(); const pending = b.mount(); b.def().unmount(b.root, b.ctx); await pending;
  assert.equal(b.root.querySelector('.cp'), null);
});

test('№128: header counter «заполнено N из 8» follows the save without reloading the module', async () => {
  const a = api(); await a.mount(); openQ(a);
  const head = a.root.querySelector('#cp-q-title');
  assert.match(head.textContent, /анкета заполнено 1 из 8/);
  const box = a.root.querySelector('[data-q-platform="telegram"]');
  box.checked = true; box.dispatchEvent(new a.window.Event('change'));
  await tick(800); await tick();
  assert.match(a.root.querySelector('[data-cp-saved]').textContent, /Сохранено · заполнено 2 из 8/);
  assert.match(a.root.querySelector('#cp-q-title').textContent, /анкета заполнено 2 из 8/);
});

test('№128: no platforms — hint points to the questionnaire and focuses «Площадки», the model is not called', async () => {
  const a = api({ qPlatforms: [], briefPlatforms: [] }); await a.mount(); openQ(a);
  a.root.querySelector('[data-cp="generate"]').click();
  await tick(); await tick(); await tick();
  const hint = a.root.querySelector('[data-cp-suggest]').textContent;
  assert.match(hint, /Отметьте площадки в анкете выше/); assert.doesNotMatch(hint, /бриф/i);
  assert.equal(a.calls.some((c) => c.path === 'media-mentor-suggest'), false);
  assert.equal(a.window.document.activeElement, a.root.querySelector('[data-cp-platforms] input'));
  assert.equal(a.root.querySelector('[data-cp-modal]') !== null, true);
});

test('№128: server answer brief_incomplete is shown with the questionnaire wording, not «в брифе»', async () => {
  const a = api({ suggest: { status: 'brief_incomplete', items: [], dropped: [], notice: 'Сначала укажите площадки компании в брифе.' } }); await a.mount(); openQ(a);
  a.root.querySelector('[data-cp="generate"]').click();
  await tick(); await tick(); await tick();
  const hint = a.root.querySelector('[data-cp-suggest]').textContent;
  assert.match(hint, /Отметьте площадки в анкете выше/); assert.doesNotMatch(hint, /бриф/i);
  assert.equal(a.root.querySelector('[data-cp="accept"]'), null);
});

test('№136: empty questionnaire with a leftover platform in the hidden brief — hint, no model call, no brief write', async () => {
  const a = api({ qPlatforms: [], briefPlatforms: ['instagram'] }); await a.mount(); openQ(a);
  a.root.querySelector('[data-cp="generate"]').click();
  await tick(); await tick(); await tick();
  assert.match(a.root.querySelector('[data-cp-suggest]').textContent, /Отметьте площадки в анкете выше/);
  assert.equal(a.calls.some((c) => c.path === 'media-mentor-suggest'), false, 'model is not called');
  assert.equal(a.calls.some((c) => c.path === 'crm/media-mentor/brief'), false, 'brief is not written');
  assert.equal(a.window.document.activeElement, a.root.querySelector('[data-cp-platforms] input'));
});

test('№136: unticked platform counts as not chosen even before the autosave reaches the server', async () => {
  const a = api({ qPlatforms: ['vk'], briefPlatforms: ['vk'] }); await a.mount(); openQ(a);
  const box = a.root.querySelector('[data-q-platform="vk"]');
  box.checked = false; box.dispatchEvent(new a.window.Event('change'));
  a.root.querySelector('[data-cp="generate"]').click();
  await tick(); await tick(); await tick(); await tick();
  assert.match(a.root.querySelector('[data-cp-suggest]').textContent, /Отметьте площадки в анкете выше/);
  assert.equal(a.calls.some((c) => c.path === 'media-mentor-suggest'), false);
});

test('№136: Hugh gets only questionnaire platforms; brief gains missing ones without losing old; foreign rows are dropped', async () => {
  const a = api({ qPlatforms: ['telegram'], briefPlatforms: ['vk'],
    suggest: { status: 'ok', notice: 'n', items: [{ date: '2026-11-20', platform: 'vk', format: 'reel', role: 'reach', topic: 'Старая площадка' },
      { date: '2026-11-21', platform: 'telegram', format: 'reel', role: 'reach', topic: 'Видимая площадка' }] } });
  await a.mount(); openQ(a);
  a.root.querySelector('[data-cp="generate"]').click();
  await tick(); await tick(); await tick();
  assert.deepEqual(a.calls.find((c) => c.path === 'crm/media-mentor/brief').body.brief.platforms, ['vk', 'telegram']);
  assert.deepEqual(a.calls.find((c) => c.path === 'media-mentor-suggest').body.platforms, ['telegram']);
  const shown = a.root.querySelector('.cp-suggest').textContent;
  assert.match(shown, /Видимая площадка/); assert.doesNotMatch(shown, /Старая площадка/);
});

test('№136: server before the fix rejects the new field — one retry without it', async () => {
  const a = api({ qPlatforms: ['vk'], briefPlatforms: ['vk'] }); await a.mount(); openQ(a);
  const post = a.ctx.api.post, bodies = [];
  a.ctx.api.post = async (p, b) => { if (p === 'media-mentor-suggest') { bodies.push(plain(b)); if (b.platforms) throw Object.assign(Error('Переданы лишние поля'), { status: 400 }); } return post(p, b); };
  a.root.querySelector('[data-cp="generate"]').click();
  await tick(); await tick(); await tick(); await tick();
  assert.deepEqual(bodies.map((b) => 'platforms' in b), [true, false]);
  assert.ok(a.root.querySelector('[data-cp="accept"]'));
});

test('№186: анкеты на вкладке нет; «+ Новый» и ⚙ открывают окно с анкетой, ← и ✕ закрывают и возвращают фокус', async () => {
  const a = api(); await a.mount();
  const order = [...a.root.querySelector('.cp').children].map((n) => n.classList[n.classList.length - 1]);
  assert.deepEqual(order, ['cp-head', 'cp-plan', 'cp-approve', 'cp-error']);
  assert.equal(a.root.querySelector('[data-cp-modal]'), null); assert.equal(a.root.querySelector('[data-q]'), null);
  assert.doesNotMatch(a.root.textContent, /Анкета проекта/);
  assert.equal(a.root.querySelectorAll('.cp-plan .cp-row').length, 2);
  const tools = [...a.root.querySelectorAll('.cp-tools > *')];
  assert.deepEqual(tools.map((n) => n.matches('.cp-gear') ? 'gear' : n.matches('.cp-sort') ? 'sort' : '?'), ['sort'], 'справа от «Публикации» только ▦ ⇅, без ⚙');
  assert.ok(a.root.querySelector('.cp-tab-plan [data-cp-tab="plan"] + .cp-gear'), 'макет 07.11: ⚙ стоит на вкладке «Контент-план ⚙»');
  assert.equal(a.root.querySelector('.cp-list-head h3').textContent, 'Публикации');
  assert.match(a.root.querySelector('.cp-gear').getAttribute('aria-label'), /настройка контент-плана/i);
  for (const [sel, title] of [['[data-cp="questionnaire"]', /Новый контент-план/], ['[data-cp="settings-plan"]', /Настройка контент-плана/]]) {
    const opener = a.root.querySelector(sel); opener.click();
    const modal = a.root.querySelector('[data-cp-modal]');
    assert.ok(modal && modal.getAttribute('role') === 'dialog' && modal.getAttribute('aria-modal') === 'true');
    assert.match(a.root.querySelector('#cp-q-title').textContent, title);
    assert.match(a.root.querySelector('#cp-q-title').textContent, /анкета заполнено 1 из 8/);
    assert.equal(modal.querySelectorAll('[data-q]').length, 7); assert.ok(modal.querySelector('[data-cp-platforms]'));
    assert.equal(a.window.document.activeElement, modal.querySelector('[data-q="goals"]'));
    assert.ok(modal.querySelector('.cp-modal-foot [data-cp="generate"]'), 'главная кнопка в закреплённом низу окна');
    assert.ok(a.window.document.body.classList.contains('cp-modal-open'));
    a.root.querySelector('.cp-back').click();
    assert.equal(a.root.querySelector('[data-cp-modal]'), null); assert.ok(!a.window.document.body.classList.contains('cp-modal-open'));
    assert.equal(a.window.document.activeElement, a.root.querySelector(sel), 'фокус вернулся на кнопку, открывшую окно');
  }
  a.root.querySelector('.cp-new').click(); a.root.querySelector('.cp-x').click(); assert.equal(a.root.querySelector('[data-cp-modal]'), null);
  a.root.querySelector('.cp-new').click(); a.root.dispatchEvent(new a.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert.equal(a.root.querySelector('[data-cp-modal]'), null);
});

test('№186: плана нет — на вкладке подсказка про «+ Новый», анкета закрыта; набранное до сохранения не теряется при закрытии', async () => {
  const a = api({ plan: [] }); await a.mount();
  assert.equal(a.root.querySelector('[data-cp-modal]'), null);
  assert.match(a.root.querySelector('.cp-plan').textContent, /Плана пока нет. Нажмите «\+ Новый»/);
  openQ(a, '[data-cp="questionnaire"]');
  const tone = a.root.querySelector('[data-q="tone"]'); tone.value = 'дружески'; tone.dispatchEvent(new a.window.Event('input'));
  a.root.querySelector('.cp-back').click();
  openQ(a); assert.equal(a.root.querySelector('[data-q="tone"]').value, 'дружески');
  await tick(800); await tick();
  assert.equal(a.calls.filter((c) => c.method === 'PUT' && c.path === 'crm/media-mentor/questionnaire').length, 1, 'автосохранение дошло до сервера');
});

test('№186: без права правки «+ Новый» нет, ⚙ показывает анкету только для чтения без кнопки формирования', async () => {
  const a = api({ role: 'viewer' }); await a.mount();
  assert.equal(a.root.querySelector('[data-cp="questionnaire"]'), null);
  openQ(a);
  assert.ok(a.root.querySelector('[data-q="goals"]').readOnly); assert.equal(a.root.querySelector('[data-cp="generate"]'), null);
});

test('№186: нижнее меню прячется, пока фокус в поле ввода, и возвращается после ухода фокуса (≤760 px — правило в workspace.css)', async () => {
  const a = api(); await a.mount(); openQ(a);
  const doc = a.window.document, body = doc.body;
  const input = a.root.querySelector('[data-q="goals"]'), box = a.root.querySelector('[data-q-platform="vk"]');
  assert.ok(body.classList.contains('kbd-open'), 'фокус в textarea — класс есть');
  box.focus(); await tick(); assert.ok(!body.classList.contains('kbd-open'), 'чекбокс клавиатуру не открывает');
  a.root.querySelector('[data-cp-start]').focus(); await tick(); assert.ok(body.classList.contains('kbd-open'));
  doc.activeElement.blur(); await tick(); assert.ok(!body.classList.contains('kbd-open'), 'фокус ушёл — меню вернулось');
  input.focus(); a.root.querySelector('[data-cp-days]').focus(); await tick(); assert.ok(body.classList.contains('kbd-open'), 'переход поле→поле не мигает');
  const css = fs.readFileSync(path.join(__dirname, 'workspace.css'), 'utf8');
  assert.match(css, /@media\(max-width:760px\)\{ body\.kbd-open \.mobile-shortcuts \{ display:none; \} \}/);
});

test('№141: «Начало» and «Дней» are an even grid — caption span + one control each, same height in CSS', async () => {
  const a = api({ plan: [] }); await a.mount(); openQ(a);
  const labels = [...a.root.querySelectorAll('.cp-gen > label')];
  assert.deepEqual(labels.map((l) => l.querySelector('span').textContent), ['Начало', 'Дней']);
  assert.deepEqual(labels.map((l) => l.children.length), [2, 2]);
  assert.ok(labels[0].querySelector('input[type="date"][data-cp-start]')); assert.ok(labels[1].querySelector('select[data-cp-days]'));
  const css = fs.readFileSync(path.join(__dirname, 'content-plan.css'), 'utf8');
  assert.match(css, /\.cp-gen \{ display:grid; grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /\.cp-gen label \{ grid-template-rows:auto 44px;/);
  assert.match(css, /\.cp-gen input\[type="date"\], \.cp-gen select \{[^}]*min-width:0; height:44px;/);
  assert.match(css, /\.cp-gen input\[type="date"\] \{ -webkit-appearance:none; appearance:none;/);
});

test('макет 07.11: телефон — карточка в колонку, ПК ≥1100 — таблица Дата · Тема · Площадки · Статус · «Сменить статус ▾»', async () => {
  const a = api(); await a.mount();
  const row = a.root.querySelector('.cp-row');
  assert.deepEqual([...row.children].map((el) => el.className), ['cp-top', 'cp-line', 'cp-acts']);
  assert.deepEqual([...a.root.querySelectorAll('.cp-thead span')].map((s) => s.textContent), ['Дата', 'Тема', 'Площадки', 'Статус', '']);
  assert.equal(row.querySelector('.cp-act').textContent, 'Сменить статус ▾');
  const css = fs.readFileSync(path.join(__dirname, 'content-plan.css'), 'utf8');
  const wide = css.slice(css.indexOf('@media (min-width: 1100px)'));
  assert.match(wide, /grid-template-areas:"date line nets st act" "full full full full full" "pop pop pop pop pop"/);
  assert.match(wide, /\.cp-top, \.cp-acts \{ display:contents; \}/);
  assert.match(css, /\.cp-thead \{ display:none; \}/);
});

test('макет 07.11: клик по любому месту карточки раскрывает, по кнопке — нет; «Внести правки» показывает поле', async () => {
  const a = api({ plan: [idea(1), idea(2, { script: '0–2 с | Гостья | «Сколько стоит?» | Гостья у стойки | Хук | Сколько стоит?\n2–6 с Мастер: Первый визит — …' })] }); await a.mount();
  const row = () => a.root.querySelector('[data-idea="s-2"]');
  row().querySelector('.cp-date').click();
  assert.ok(row().querySelector('.cp-full'), 'клик по дате раскрывает');
  assert.deepEqual([...row().querySelectorAll('.cp-sec thead th')].map((th) => th.textContent), ['Сцена', 'Время', 'Кто говорит', 'Точная реплика', 'Кто / что в кадре', 'Действие / монтаж', 'Титр']);
  assert.deepEqual([...row().querySelectorAll('.cp-sec tbody tr')[1].children].map((td) => td.textContent), ['Сцена №2', '2–6 с', 'Мастер', 'Первый визит — …', '', '', '']);
  row().querySelector('.cp-edit summary').click(); assert.ok(row().querySelector('.cp-full'), '«Изменить» в полном виде не сворачивает');
  row().querySelector('.cp-full dd').click(); assert.equal(row().querySelector('.cp-full'), null, 'макет 07.11: нажатие в открытой карточке сворачивает');
  row().querySelector('.cp-top').click(); assert.ok(row().querySelector('.cp-full'));
  row().querySelector('.cp-top').click(); assert.equal(row().querySelector('.cp-full'), null, 'повторный клик сворачивает');
  row().querySelector('[data-cp-menu]').click();
  assert.equal(row().querySelector('.cp-full'), null, 'кнопка не раскрывает');
  assert.deepEqual([...row().querySelectorAll('.cp-stg')].map((b) => [b.textContent, b.dataset.stg]), [['На согласовании', 'wait'], ['Согласовано', 'ok'], ['Внести правки', 'fix']]);
  assert.equal(row().querySelector('[data-cp-fix-form]'), null, 'поле правки только после «Внести правки»');
  assert.doesNotMatch(row().textContent, /открывается только/);
  row().querySelector('[data-cp-fix]').click();
  const box = row().querySelector('[data-cp-fix-form] textarea');
  assert.equal(box.placeholder, 'Напишите правку: что изменить в сценарии...');
  assert.deepEqual([...row().querySelectorAll('.cp-fix-btns button')].map((b) => b.textContent), ['Отправить', 'Закрыть']);
  row().querySelector('[data-cp-fix-cancel]').click(); assert.equal(row().querySelector('.cp-pop'), null);
});

test('№181: вкладки фильтруют существующие строки; новые используют анкету; сортировка запоминается у пользователя', async () => {
  const a = api({plan:[idea(2), idea(1), idea(3,{productionStatus:'draft'})]}); await a.mount();
  assert.equal(a.root.querySelector('.cp-head h2'),null);
  for (const text of ['Написать контент-план','Чат с Хью','Кратко','Полный план (таблица)']) assert.ok(![...a.root.querySelectorAll('button')].some(b=>b.textContent===text));
  const ids=()=>[...a.root.querySelectorAll('.cp-row')].map(n=>n.dataset.idea);
  assert.deepEqual(ids(),['s-1','s-2']);
  a.root.querySelector('[data-cp-tab="drafts"]').click(); assert.deepEqual(ids(),['s-3']);
  a.root.querySelector('[data-cp="questionnaire"]').click(); assert.ok(a.root.querySelector('[data-cp-modal]'));
  a.root.querySelector('.cp-back').click(); a.root.querySelector('[data-cp-tab="plan"]').click();
  a.root.querySelector('[data-cp-sort-toggle]').click(); assert.equal(a.root.querySelector('#cp-sort-menu').hidden,false);
  assert.equal(a.root.querySelector('[data-cp-sort="date"]').getAttribute('aria-pressed'),'true');
  a.root.querySelector('[data-cp-sort="platform"]').click();
  assert.equal(a.window.localStorage.getItem('sb-content-plan:7:alpha:sort'),'platform');
  await a.mount(); assert.equal(a.root.querySelector('[data-cp-sort="platform"]').getAttribute('aria-pressed'),'true');
  a.ctx.user.id=8; await a.mount(); assert.equal(a.root.querySelector('[data-cp-sort="date"]').getAttribute('aria-pressed'),'true');
  assert.ok(a.calls.every(c=>c.method==='GET'),'вкладки/сортировка не пишут план');
});
test('№181: безопасная ссылка настройки открывается отдельно, пустая и опасная скрыты', async () => {
  for (const url of ['', 'javascript:alert(1)', 'https://docs.google.com.evil.test/spreadsheets/d/test','https://docs.google.com/spreadsheets/d/sample/edit']) {
    const a=api({settings:{settings:{approverUserIds:[],contentPlanSheetUrl:url},candidates:[]}}); await a.mount();
    const link=a.root.querySelector('.cp-sheet-link');
    if (url.endsWith('/sample/edit')) { assert.equal(link.target,'_blank'); assert.match(link.rel,/noopener/); }
    else assert.equal(link,null);
  }
});

test('№181: сортировка по площадке/статусу меняет порядок, черновик редактирования переживает вкладки', async () => {
  const a=api({plan:[idea(1,{platform:'telegram',variants:{telegram:{text:'a'}}}),idea(2,{platform:'vk',variants:{vk:{text:'b'}}})]}); await a.mount();
  const ids=()=>[...a.root.querySelectorAll('.cp-row')].map(n=>n.dataset.idea);
  a.root.querySelector('[data-cp-sort-toggle]').click(); a.root.querySelector('[data-cp-sort="platform"]').click(); assert.deepEqual(ids(),['s-2','s-1']);
  a.root.querySelector('[data-cp-sort-toggle]').click(); a.root.querySelector('[data-cp-sort="status"]').click(); assert.deepEqual(ids(),['s-2','s-1'],'по статусу: сначала на согласовании');
  a.root.querySelector('[data-cp-sort-toggle]').click(); a.root.querySelector('[data-cp-sort="number"]').click(); assert.deepEqual(ids(),['s-1','s-2'],'по номеру рилса в плане');
  a.root.querySelector('[data-idea="s-1"] [data-toggle]').click();
  a.root.querySelector('[data-edit="s-1"] [name="topic"]').value='Несохранённый текст';
  a.root.querySelector('[data-cp-tab="drafts"]').click(); a.root.querySelector('[data-cp-tab="plan"]').click();
  assert.equal(a.root.querySelector('[data-edit="s-1"] [name="topic"]').value,'Несохранённый текст');
  assert.ok(!a.root.textContent.includes('Полный план (таблица)'));
});

test('Влад 06.11: у публикации «Согласовать» и «Внести правку» — решение по одной идее; правка требует комментария', async () => {
  const a = api(); await a.mount();
  const row2 = a.root.querySelector('[data-idea="s-2"]'), row1 = a.root.querySelector('[data-idea="s-1"]');
  assert.equal(row1.querySelector('.cp-st').textContent, 'Согласовано', 'один статус без «·»');
  assert.equal(row1.querySelector('.cp-n'), null, 'номер у строки убран');
  assert.equal(row2.querySelector('[data-cp-decide]'), null, 'действия спрятаны в списке');
  row2.querySelector('[data-cp-menu]').click();
  assert.equal(a.root.querySelector('[data-idea="s-2"] [data-cp-decide="withdrawn"]').disabled, true, 'уже на согласовании');
  a.root.querySelector('[data-idea="s-2"] [data-cp-decide="approved"]').click(); await tick(); await tick();
  assert.deepEqual(a.calls.find((c) => c.path.endsWith('/variants/decision')).body,
    { planRevision: 4, briefRevision: 2, scope: 'idea', ideaId: 's-2', decision: 'approved', comment: '' });
  a.root.querySelector('[data-idea="s-1"] [data-cp-menu]').click();
  a.root.querySelector('[data-idea="s-1"] [data-cp-decide="withdrawn"]').click(); await tick(); await tick();
  assert.equal(a.calls.filter((c) => c.path.endsWith('/variants/decision'))[1].body.decision, 'withdrawn', '«На согласовании» отменяет согласование');
  a.root.querySelector('[data-idea="s-2"] [data-cp-menu]').click();
  a.root.querySelector('[data-idea="s-2"] [data-cp-fix]').click();
  const form = a.root.querySelector('[data-idea="s-2"] [data-cp-fix-form]');
  form.dispatchEvent(new a.window.Event('submit', { cancelable: true })); await tick();
  assert.equal(a.calls.filter((c) => c.path.endsWith('/variants/decision')).length, 2, 'пустая правка не уходит');
  form.querySelector('textarea').value = 'Заменить хук'; form.dispatchEvent(new a.window.Event('submit', { cancelable: true })); await tick(); await tick();
  const fix = a.calls.filter((c) => c.path.endsWith('/variants/decision'))[2].body;
  assert.equal(fix.decision, 'rejected'); assert.equal(fix.comment, 'Заменить хук'); assert.equal(fix.ideaId, 's-2');
});

test('Влад 06.11: без роли владельца кнопок решения в списке нет', async () => {
  const a = api({ role: 'smm', permissions: ['autoposting.edit'] }); await a.mount();
  assert.equal(a.root.querySelector('[data-cp-menu]'), null);
});

/* №205: Контент-план на общем наборе CfKit (макет 07.11). */
test('CfKit: шапка «Публикации» — календарь, ▦, ⇅ в одну строку; ⚙ только на вкладке; сортировка из 4 пунктов запоминается', async () => {
  const a = api({ withKit: true, plan: [idea(1, { platform: 'telegram', variants: { telegram: { text: 'a' } } }), idea(2)] }); await a.mount();
  const head = a.root.querySelector('.cp-plan .cfk-head');
  assert.equal(head.querySelector('.cfk-title').textContent, 'Публикации');
  assert.deepEqual([...head.querySelectorAll('.cfk-ico')].map((n) => n.dataset.cfkAct), ['calendar', 'sheet', 'sort']);
  assert.ok(!head.textContent.includes('⚙'), '⚙ не в шапке списка');
  assert.ok(a.root.querySelector('.cp-tab-plan .cp-gear'));
  assert.ok(head.querySelector('[data-cfk-act="sheet"]').disabled, 'таблица не указана — ▦ неактивна с подсказкой');
  assert.equal(a.root.querySelector('.cp-list-head'), null, 'прежняя шапка не дублируется');
  head.querySelector('[data-cfk-act="sort"]').click();
  const items = [...head.querySelectorAll('[data-cfk-sort]')];
  assert.deepEqual(items.map((b) => b.dataset.cfkSort), ['date', 'status', 'platform', 'number']);
  assert.match(items[0].textContent, /По дате выхода.*по умолчанию/);
  items[1].click();
  assert.deepEqual([...a.root.querySelectorAll('.cp-row')].map((n) => n.dataset.idea), ['s-2', 's-1'], 'сначала на согласовании');
  assert.equal(a.window.localStorage.getItem('cfkit.sort.sb-content-plan:7:alpha:sort'), 'status');
  await a.mount();
  assert.equal(a.root.querySelector('.cfk-head').dataset.sort, 'status');
  const b = api({ withKit: true, settings: { settings: { approverUserIds: [], contentPlanSheetUrl: 'https://docs.google.com/spreadsheets/d/sample/edit' }, candidates: [] } }); await b.mount();
  assert.equal(b.root.querySelector('a[data-cfk-act="sheet"]').getAttribute('href'), 'https://docs.google.com/spreadsheets/d/sample/edit');
});

test('CfKit: один чип этапа общей цепочки по данным сервера; значки площадок в порядке TG VK YT TT IG', async () => {
  const plan = [idea(1, { variants: { instagram: { text: 'i' }, vk: { text: 'v' }, telegram: { text: 't' } } }), idea(2), idea(3, { productionStatus: 'shot' }), idea(4)];
  const variants = [{ ideaId: 's-1', platform: 'vk', status: 'approved', approvable: true }, { ideaId: 's-2', platform: 'vk', status: 'pending', approvable: true },
    { ideaId: 's-3', platform: 'vk', status: 'approved', approvable: true }, { ideaId: 's-4', platform: 'vk', status: 'rejected', approvable: true, comment: 'Короче хук' }];
  const a = api({ withKit: true, plan, variants }); await a.mount();
  const chip = (id) => a.root.querySelector(`[data-idea="${id}"] .cp-top .cfk-chip`);
  assert.deepEqual(['s-1', 's-2', 's-3', 's-4'].map((id) => [chip(id).dataset.stage, chip(id).textContent]),
    [['planned', 'Запланировано'], ['script_review', 'На согласовании'], ['shot', 'Отснято'], ['script_rework', 'На доработке']]);
  // Макет 07.11: в свёрнутой карточке короткая подпись этапа, полная — в подсказке и в раскрытом виде.
  assert.equal(chip('s-2').title, 'Сценарий на согласовании');
  assert.equal(a.root.querySelectorAll('[data-idea="s-2"] .cp-top .cfk-chip').length, 1, 'один статус без «Согласовано · …»');
  assert.deepEqual([...a.root.querySelectorAll('[data-idea="s-1"] .cp-nb')].map((n) => n.textContent), ['TG', 'VK', 'IG']);
  assert.ok(a.root.querySelector('[data-idea="s-1"] .cp-acts .cp-nets'), 'значки в одной строке с «Сменить статус ▾»');
  a.root.querySelector('[data-idea="s-4"] .cp-date').click();
  assert.match(a.root.querySelector('[data-idea="s-4"] .cp-full').textContent, /Правки.*Короче хук/s);
  assert.equal(a.root.querySelector('[data-idea="s-4"] .cp-fgrid .cfk-chip').textContent, 'Сценарий на доработке', 'в раскрытом виде — полная подпись');
  a.root.querySelector('[data-cp-tab="drafts"]').click();
  assert.equal(a.root.querySelectorAll('.cp-row').length, 0);
});

test('CfKit: полоса дат скрыта, календарь показывает её с точками дней плана; раскрытие карточки не пересоздаёт полосу', async () => {
  const a = api({ withKit: true }); await a.mount();
  const strip = a.root.querySelector('.cfk-dates');
  assert.ok(strip && strip.hidden);
  a.root.querySelector('[data-cfk-act="calendar"]').click();
  assert.equal(a.root.querySelector('.cfk-dates').hidden, false);
  assert.ok(strip.querySelector('[data-cfk-day="2026-11-11"]').classList.contains('has'));
  assert.ok(strip.querySelector('[data-cfk-day="2026-11-12"]').classList.contains('has'));
  a.root.querySelector('[data-idea="s-1"] [data-toggle]').click();
  assert.equal(a.root.querySelector('.cfk-dates'), strip, 'та же полоса после перерисовки');
  assert.equal(strip.hidden, false, 'и остаётся открытой');
  assert.equal(a.root.querySelector('[data-cfk-act="calendar"]').getAttribute('aria-pressed'), 'true');
  a.root.querySelector('[data-cfk-act="calendar"]').click();
  assert.ok(strip.hidden);
});

test('CfKit: лента стоит на первом неопубликованном — прошедшие согласованные выше пунктирной линии', async () => {
  const plan = [idea(1, { date: '2026-01-05' }), idea(2, { date: '2026-01-06' }), idea(3, { date: '2099-01-01' })];
  const variants = plan.map((p, i) => ({ ideaId: p.ideaId, platform: 'vk', status: i === 1 ? 'pending' : 'approved', approvable: true }));
  const a = api({ withKit: true, plan, variants }); await a.mount();
  const list = a.root.querySelector('.cp-list');
  assert.ok(list.classList.contains('cfk-feed'));
  assert.deepEqual([...list.querySelectorAll('.cp-row')].map((r) => r.dataset.above), ['1', '0', '0'], 'прошедшая, но не согласованная — не выше линии');
  const sep = list.querySelector('.cfk-feed-sep');
  assert.equal(sep.tagName, 'LI');
  assert.equal(sep.nextElementSibling.dataset.idea, 's-2');
  assert.match(sep.textContent, /выше — прошедшие даты/);
});

test('макет 07.11: строка «До съёмки: …» не становится сценой — она в блоке «До съёмки» после сцен', async () => {
  const a = api({ plan: [idea(1, { script: '0–2 с | Гостья | «Привет» | У стойки | Хук | Привет\nДо съёмки: подготовить форму' }), idea(2)] }); await a.mount();
  a.root.querySelector('[data-idea="s-1"] .cp-date').click();
  const full = a.root.querySelector('.cp-full');
  assert.equal(full.querySelectorAll('.cp-sec tbody tr').length, 1);
  assert.match(full.querySelector('.cp-before').textContent, /подготовить форму/);
});

test('макет 07.11, раскрытая карточка: «Формат · N с», «Сценарий по секундам · N с», «Вышло ↗» из publications, правка над сценарием', async () => {
  const script = '0–3 с | Актёр | Привет | У стойки | Входит | Первый визит\n3–8 с | Мастер | «Проходите» | Кабинет | Жест | «Знакомство»';
  const plan = [idea(1, { script, stage: 'published', publications: [
    { platform: 'instagram', status: 'published', url: 'https://example.com/p/1', publishedAt: '2026-11-05T10:00:00Z' },
    { platform: 'tiktok', status: 'published', url: '', publishedAt: '2026-11-05T10:00:00Z' },
    { platform: 'vk', status: 'published', url: 'javascript:alert(1)', publishedAt: '2026-11-05T10:00:00Z' },
    { platform: 'telegram', status: 'scheduled', url: '', publishedAt: '' }] }),
  idea(2, { stage: 'script_rework', publications: [] })];
  const variants = [{ ideaId: 's-1', platform: 'vk', status: 'approved', approvable: true }, { ideaId: 's-2', platform: 'vk', status: 'rejected', approvable: true, comment: 'Короче вступление' }];
  const a = api({ withKit: true, plan, variants, planExtra: { stageFacts: NEW_FACTS } }); await a.mount();
  a.root.querySelector('[data-idea="s-1"] .cp-date').click();
  const full = a.root.querySelector('[data-idea="s-1"] .cp-full');
  const fields = Object.fromEntries([...full.querySelectorAll('.cp-fgrid > div')].map((d) => [d.querySelector('dt').textContent, d.querySelector('dd')]));
  assert.equal(fields['Формат'].textContent, 'Рилс · 8 с');
  assert.equal(full.querySelector('.cp-secs > b').textContent, 'Сценарий по секундам · 8 с');
  const links = [...fields['Вышло'].querySelectorAll('a')];
  assert.deepEqual(links.map((l) => [l.textContent, l.getAttribute('href'), l.target, l.rel]), [['IG вышло ↗', 'https://example.com/p/1', '_blank', 'noopener noreferrer']], 'ссылка только http(s)');
  assert.match(fields['Вышло'].textContent, /TT вышло · ссылка позже/); assert.match(fields['Вышло'].textContent, /VK вышло · ссылка позже/); assert.match(fields['Вышло'].textContent, /TG ждёт/);
  const cells = full.querySelectorAll('.cp-sec tbody tr');
  assert.equal(cells[0].querySelector('[data-label="Точная реплика"]').dataset.q, '1', 'реплика без кавычек — «ёлочки» добавит стиль');
  assert.equal(cells[1].querySelector('[data-label="Точная реплика"]').dataset.q, undefined, 'уже в кавычках — не трогаем');
  assert.equal(cells[1].querySelector('[data-label="Титр"]').dataset.q, undefined);
  assert.equal(full.querySelector('.cp-pin'), null, 'опубликованному правка не закрепляется');
  a.root.querySelector('[data-idea="s-2"] .cp-date').click();
  const row2 = a.root.querySelector('[data-idea="s-2"]');
  assert.ok(row2.classList.contains('cp-rework'), 'карточка на доработке — коралловая');
  const pin = row2.querySelector('.cp-pin');
  assert.match(pin.textContent, /Правка: Короче вступление/);
  assert.ok(pin.compareDocumentPosition(row2.querySelector('.cp-secs')) & 4, 'правка закреплена над сценарием');
  assert.equal(row2.querySelector('.cp-fgrid').textContent.includes('Вышло'), false, 'не вышло — строки «Вышло» нет');
});

/* Пакет H (specs/209-cf-stages): новый сервер отдаёт idea.stage, publications, plan.stageFacts и company.timeZone. */
const NEW_FACTS = { stages: [], shooting: true, unpublished: false, note: '' };
test('пакет H, новый сервер: этап из idea.stage, граница ленты — опубликованные, пояс компании из /media-mentor', async () => {
  const plan = [idea(1, { date: '2026-01-04', stage: 'published', stageSource: 'publication', publications: [{ platform: 'vk', status: 'published', url: 'https://vk.com/wall-1_2', publishedAt: '2099-01-01T03:00:00Z' }] }),
    idea(2, { date: '2026-01-06', stage: 'edit_review', stageSource: 'montage', publications: [] }), idea(3, { date: '2099-01-02', stage: 'scheduled', publications: [] })];
  const variants = plan.map((p) => ({ ideaId: p.ideaId, platform: 'vk', status: 'approved', approvable: true }));
  const a = api({ withKit: true, plan, variants, planExtra: { stageFacts: NEW_FACTS }, mentorExtra: { company: { code: 'alpha', timeZone: 'Asia/Irkutsk', timeZoneSource: 'company' } } });
  await a.mount();
  const chip = (id) => a.root.querySelector(`[data-idea="${id}"] .cp-top .cfk-chip`).dataset.stage;
  assert.deepEqual(['s-1', 's-2', 's-3'].map(chip), ['published', 'edit_review', 'scheduled'], 'этап сервера, а не «Запланировано» по решению');
  const list = a.root.querySelector('.cp-list');
  const above = Object.fromEntries([...list.querySelectorAll('.cp-row')].map((r) => [r.dataset.idea, r.dataset.above]));
  assert.deepEqual(above, { 's-1': '1', 's-2': '0', 's-3': '0' }, 'выше — опубликованное; прошедшая дата без публикации (в монтаже) — не выше');
  assert.match(list.querySelector('.cfk-feed-sep').textContent, /выше — опубликованные/);
  assert.equal(a.root.querySelector('.cfk-tz').textContent, 'Иркутское время');
});

test('пакет H, старый сервер: без stageFacts — прежний расчёт этапа и граница «прошедшие даты», подпись «Время устройства»', async () => {
  const plan = [idea(1, { date: '2026-01-05' }), idea(2, { date: '2099-01-06' })];
  const variants = plan.map((p) => ({ ideaId: p.ideaId, platform: 'vk', status: 'approved', approvable: true }));
  const a = api({ withKit: true, plan, variants }); await a.mount();
  assert.equal(a.root.querySelector('[data-idea="s-1"] .cp-top .cfk-chip').dataset.stage, 'planned');
  assert.equal(a.root.querySelector('[data-idea="s-1"]').dataset.above, '1');
  assert.match(a.root.querySelector('.cfk-feed-sep').textContent, /прошедшие даты/);
  assert.equal(a.root.querySelector('.cfk-tz').textContent, 'Время устройства');
});

test('пакет H: при сохранении строки вычисленные сервером stage/stageSource/publications обратно не отправляются', async () => {
  const plan = [idea(1, { stage: 'planned', stageSource: 'script', publications: [] }), idea(2, { stage: 'script_review', stageSource: 'script', publications: [] })];
  const a = api({ withKit: true, plan, planExtra: { stageFacts: NEW_FACTS } }); await a.mount();
  a.root.querySelector('[data-idea="s-1"] [data-toggle]').click();
  const form = a.root.querySelector('[data-edit="s-1"]');
  form.querySelector('[name="hook"]').value = 'Новый хук';
  form.dispatchEvent(new a.window.Event('submit', { cancelable: true }));
  await tick(5);
  const put = a.calls.find((c) => c.method === 'PUT' && c.path === 'crm/media-mentor/plan');
  assert.ok(put, 'план сохранён');
  assert.ok(put.body.days.every((d) => !('stage' in d) && !('stageSource' in d) && !('publications' in d)));
  assert.equal(put.body.days.find((d) => d.ideaId === 's-1').hook, 'Новый хук');
});

/* specs/224-content-archive: «Убрать» строки плана с подтверждением и причиной, вкладка «Архив» с «Вернуть». */
test('specs/224: «Убрать» в списке и в полном виде — подтверждение, причина, POST archive; «Архив» — «Вернуть»', async () => {
  const archivedIdeas = [{ ideaId: 's-9', date: '2026-11-19', platform: 'vk', format: 'reel', topic: 'SAMPLE убранная', inPlan: true,
    archive: { archivedAt: '2026-11-07T03:00:00Z', archivedBy: 7, archivedByName: 'SAMPLE', reason: 'дубль' } }];
  const a = api({ role: 'editor', permissions: ['autoposting.view', 'autoposting.edit'], mentorExtra: { archivedIdeas } });
  const post = a.ctx.api.post, writes = [];
  a.ctx.api.post = async (p, b) => { if (/\/plan\/ideas\//.test(p)) { writes.push([p, plain(b)]); return {}; } return post(p, b); };
  await a.mount();
  const row = () => a.root.querySelector('[data-idea="s-1"]');
  assert.ok(row().querySelector('.cp-acts [data-cp-remove]'), 'в списке есть «Убрать»');
  assert.equal(row().querySelector('[data-cp-menu]'), null, 'не владельцу «Сменить статус» не показывается — только «Убрать»');
  row().querySelector('.cp-acts [data-cp-remove]').click();
  const form = row().querySelector('[data-cp-remove-form]');
  assert.match(form.textContent, /Убрать «SAMPLE тема 1» в архив\?/); assert.match(form.textContent, /вернуть можно во вкладке «Архив»/);
  assert.equal(writes.length, 0, 'без подтверждения ничего не пишется');
  form.querySelector('[data-cp-remove-cancel]').click(); assert.equal(row().querySelector('[data-cp-remove-form]'), null, '«Отмена» закрывает');
  row().querySelector('[data-toggle]').click();
  assert.ok(row().querySelector('.cp-full [data-cp-remove]'), 'в раскрытой карточке — «Убрать из плана»');
  row().querySelector('.cp-full [data-cp-remove]').click();
  row().querySelector('[data-cp-remove-form] [name="reason"]').value = 'дубль темы';
  row().querySelector('[data-cp-remove-form]').dispatchEvent(new a.window.Event('submit', { cancelable: true }));
  await tick(); await tick();
  assert.deepEqual(writes, [['crm/media-mentor/plan/ideas/s-1/archive', { reason: 'дубль темы' }]]);
  const tab = a.root.querySelector('[data-cp-tab="archive"]');
  assert.equal(tab.textContent.trim(), 'Архив · 1'); tab.click();
  const item = a.root.querySelector('[data-archived-idea="s-9"]');
  assert.match(item.textContent, /SAMPLE убранная/); assert.match(item.textContent, /Причина: дубль/);
  item.querySelector('[data-cp-restore]').click(); await tick(); await tick();
  assert.deepEqual(writes.at(-1), ['crm/media-mentor/plan/ideas/s-9/restore', {}]);
});

test('specs/224: без права правки и со старым сервером (нет archivedIdeas) кнопок «Убрать» и вкладки «Архив» нет', async () => {
  const viewer = api({ role: 'editor', permissions: ['autoposting.view'], mentorExtra: { archivedIdeas: [] } }); await viewer.mount();
  assert.equal(viewer.root.querySelector('[data-cp-remove]'), null);
  assert.ok(viewer.root.querySelector('[data-cp-tab="archive"]'), 'архив виден для просмотра');
  const old = api(); await old.mount();
  assert.equal(old.root.querySelector('[data-cp-remove]'), null); assert.equal(old.root.querySelector('[data-cp-tab="archive"]'), null);
});

test('specs/225: «Указать таблицу» видит и не-владелец с правом менять настройки контента; без права — нет', async () => {
  const hint = (root) => [...root.querySelectorAll('button')].some((b) => b.textContent === 'Указать таблицу');
  const editor = api({ role: 'editor', permissions: ['autoposting.view', 'autoposting.edit', 'settings.edit'], settings: { canEdit: true, settings: { approverUserIds: [] }, candidates: [] } });
  await editor.mount(); openQ(editor);
  assert.equal(hint(editor.root), true);
  const viewer = api({ role: 'editor', permissions: ['autoposting.view', 'autoposting.edit'], settings: { canEdit: false, settings: { approverUserIds: [] }, candidates: [] } });
  await viewer.mount(); openQ(viewer);
  assert.equal(hint(viewer.root), false);
});

test('specs/225: «📁 Исходники» и «🎬 Монтаж» в раскрытой карточке — ссылки в новой вкладке, «Изменить» шлёт PUT links', async () => {
  const ideaLinks = { 's-1': { sourcesUrl: 'https://drive.google.com/drive/folders/src1', montageUrl: '', updatedAt: '2026-11-07T03:00:00Z', updatedByName: 'SAMPLE' },
    's-2': { sourcesUrl: 'javascript:alert(1)', montageUrl: '' } };
  const a = api({ role: 'editor', permissions: ['autoposting.view', 'autoposting.edit'], mentorExtra: { ideaLinks } });
  const put = a.ctx.api.put, writes = [];
  a.ctx.api.put = async (p, b) => { if (/\/links$/.test(p)) { writes.push([p, plain(b)]);
    return { ...(await a.ctx.api.get('crm/media-mentor')), ideaLinks: { 's-1': { sourcesUrl: b.sourcesUrl, montageUrl: b.montageUrl } } }; } return put(p, b); };
  await a.mount();
  const row = () => a.root.querySelector('[data-idea="s-1"]');
  assert.equal(row().querySelector('[data-cp-links]'), null, 'в свёрнутой строке ссылок нет');
  row().querySelector('[data-toggle]').click();
  const src = row().querySelector('.cp-links a.cp-link');
  assert.equal(src.getAttribute('href'), 'https://drive.google.com/drive/folders/src1');
  assert.equal(src.target, '_blank'); assert.match(src.rel, /noopener/); assert.match(src.textContent, /📁 Исходники/);
  assert.match(row().querySelector('.cp-links').textContent, /🎬 Монтаж · не указано/);
  row().querySelector('[data-cp-links-edit]').click();
  const form = row().querySelector('[data-cp-links-form]');
  assert.equal(form.querySelector('[name="sourcesUrl"]').value, 'https://drive.google.com/drive/folders/src1');
  form.querySelector('[name="montageUrl"]').value = 'javascript:alert(1)';
  form.dispatchEvent(new a.window.Event('submit', { cancelable: true })); await tick();
  assert.equal(writes.length, 0, 'не https — запрос не уходит');
  assert.match(row().querySelector('[data-cp-links-error]').textContent, /https:\/\//);
  row().querySelector('[name="montageUrl"]').value = 'https://drive.google.com/drive/folders/m1';
  row().querySelector('[data-cp-links-form]').dispatchEvent(new a.window.Event('submit', { cancelable: true })); await tick(); await tick();
  assert.deepEqual(writes, [['crm/media-mentor/plan/ideas/s-1/links', { sourcesUrl: 'https://drive.google.com/drive/folders/src1', montageUrl: 'https://drive.google.com/drive/folders/m1' }]]);
  assert.equal(row().querySelector('[data-cp-links-form]'), null, 'после сохранения форма закрыта');
  assert.equal(row().querySelectorAll('.cp-links a.cp-link').length, 2);
  // Опасная ссылка от сервера не становится ссылкой.
  a.root.querySelector('[data-idea="s-2"] [data-toggle]').click();
  assert.equal(a.root.querySelector('[data-idea="s-2"] .cp-links a'), null);
});

test('specs/225: просмотр без права правки — ссылки видны, «Изменить» нет; старый сервер (нет ideaLinks) — блока нет', async () => {
  const viewer = api({ role: 'editor', permissions: ['autoposting.view'], mentorExtra: { ideaLinks: { 's-1': { sourcesUrl: 'https://disk.yandex.ru/d/x', montageUrl: '' } } } });
  await viewer.mount(); viewer.root.querySelector('[data-idea="s-1"] [data-toggle]').click();
  assert.ok(viewer.root.querySelector('[data-idea="s-1"] .cp-links a.cp-link'));
  assert.equal(viewer.root.querySelector('[data-cp-links-edit]'), null);
  const old = api(); await old.mount(); old.root.querySelector('[data-idea="s-1"] [data-toggle]').click();
  assert.equal(old.root.querySelector('[data-cp-links]'), null);
});
