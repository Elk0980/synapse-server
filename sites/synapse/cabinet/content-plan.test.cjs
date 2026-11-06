'use strict';
/* №98 Б: экран «Контент-план» на настоящем файле модуля, ctx по контракту А и заглушке API (данные SAMPLE). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, 'content-plan.js'), 'utf8');
const importSource = fs.readFileSync(path.join(__dirname, 'reel-plan-import.js'), 'utf8');
const VOCAB = { platforms: [{ id: 'vk', label: 'ВКонтакте' }, { id: 'telegram', label: 'Telegram' }], formats: [{ id: 'reel', label: 'Рилс' }], roles: [{ id: 'reach', label: 'Охватный' }] };
const idea = (n, extra = {}) => ({ ideaId: `s-${n}`, date: `2026-11-1${n}`, platform: 'vk', format: 'reel', role: 'reach',
  topic: `SAMPLE тема ${n}`, hook: 'SAMPLE хук', script: 'Мастер: Здравствуйте!\nКлиент: <b>Привет</b>\nПауза, смех',
  broll: 'SAMPLE руки', style: 'SAMPLE тёплый свет', props: 'SAMPLE халат', filmingBy: 'SAMPLE оператор', variants: { vk: { text: 'SAMPLE подпись', contentRevision: 1 } }, ...extra });

function api({ plan = [idea(1), idea(2)], role = 'owner', permissions = [], stage = 'approval', withRegistry = true, settings = undefined, view = '', qPlatforms = ['vk'], briefPlatforms = ['vk'], suggest = null } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://cabinet.test/', runScripts: 'outside-only' });
  const { window } = dom, calls = [], opened = [];
  const db = {
    mentor: { companyCode: 'alpha', brief: { revision: 2, fields: { goal: '', audience: 'есть', platforms: briefPlatforms } }, vocabulary: VOCAB,
      plan: plan.length ? { revision: 4, briefRevision: 2, days: plan } : null,
      variants: plan.map((p, i) => ({ ideaId: p.ideaId, platform: 'vk', status: i ? 'pending' : 'approved', approvable: true })) },
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

test('short view lists №, date, platform, topic, status; row opens hook, B-roll, style, roles and props as text', async () => {
  const a = api(); await a.mount();
  const rows = [...a.root.querySelectorAll('.cp-row')];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /№1/); assert.match(rows[0].textContent, /ВКонтакте/); assert.match(rows[0].textContent, /SAMPLE тема 1/);
  assert.match(rows[0].querySelector('.cp-st').textContent, /Согласовано/); assert.match(rows[1].querySelector('.cp-st').textContent, /На согласовании/);
  assert.equal(rows[0].querySelector('.cp-full'), null);
  rows[0].querySelector('[data-toggle]').click();
  const full = a.root.querySelector('.cp-full');
  for (const text of ['Хук — первые 1–2 с', 'SAMPLE хук', 'SAMPLE руки', 'SAMPLE тёплый свет', 'SAMPLE халат', 'SAMPLE подпись']) assert.ok(full.textContent.includes(text), text);
  const script = [...full.querySelectorAll('.cp-script tr')].map((tr) => [tr.querySelector('th').textContent, tr.querySelector('td').textContent]);
  assert.deepEqual(script, [['Мастер', 'Здравствуйте!'], ['Клиент', '<b>Привет</b>'], ['—', 'Пауза, смех']]);
  assert.equal(full.querySelector('b'), null, 'server text is escaped');
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
  assert.deepEqual(tools.map((n) => n.matches('.cp-gear') ? 'gear' : n.matches('.cp-sort') ? 'sort' : '?'), ['gear', 'sort'], '⚙ и ⇅ в одном ряду справа от «Публикации»');
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

test('№143: on 390 the row is four lines — «№ дата» / тема / площадки / статус; platforms never share the auto column with №', async () => {
  const a = api(); await a.mount();
  const line = a.root.querySelector('.cp-line');
  assert.deepEqual([...line.children].map((el) => el.className), ['cp-n', 'cp-date', 'cp-pl', 'cp-topic', 'cp-st']);
  const css = fs.readFileSync(path.join(__dirname, 'content-plan.css'), 'utf8');
  const mobile = css.slice(css.indexOf('@media (max-width: 640px)'));
  const rule = mobile.match(/\.cp-line \{([^}]*)\}/)[1];
  // Колонка «auto» растягивалась под площадки и отнимала ширину у даты; теперь первая колонка — только под номер.
  assert.match(rule, /grid-template-columns:max-content minmax\(0,1fr\)/);
  assert.match(rule, /grid-template-areas:"n date" "topic topic" "pl pl" "st st"/);
  assert.match(mobile, /\.cp-date \{ grid-area:date; white-space:nowrap; \}/);
  assert.match(mobile, /\.cp-st \{ grid-area:st; justify-self:start; max-width:100%; white-space:normal; \}/);
  // Широкая раскладка 641+ не тронута: пять колонок в одну строку.
  assert.match(css, /\.cp-line \{ width:100%; display:grid; grid-template-columns:52px 96px minmax\(90px,160px\) 1fr auto;/);
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
  a.root.querySelector('[data-cp-sort-toggle]').click(); a.root.querySelector('[data-cp-sort="status"]').click(); assert.deepEqual(ids(),['s-1','s-2']);
  a.root.querySelector('[data-idea="s-1"] [data-toggle]').click();
  a.root.querySelector('[data-edit="s-1"] [name="topic"]').value='Несохранённый текст';
  a.root.querySelector('[data-cp-tab="drafts"]').click(); a.root.querySelector('[data-cp-tab="plan"]').click();
  assert.equal(a.root.querySelector('[data-edit="s-1"] [name="topic"]').value,'Несохранённый текст');
  assert.ok(!a.root.textContent.includes('Полный план (таблица)'));
});
