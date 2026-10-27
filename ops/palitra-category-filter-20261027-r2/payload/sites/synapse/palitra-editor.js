/* Редактор прайса Palitra (кабинет Synapse). Пишет ОБЩИЙ документ /content/palitra/price.
   «Готово» меняет только черновик в этом окне; «Сохранить» отправляет документ на сервер.
   Сессия кабинета (cookie) + CSRF из /content/whoami в памяти; без обходов входа и демо-режимов.
   Состояние документа и все операции с сервером — в координаторе PalitraEditorSession (palitra-editor-session.js):
   здесь только отрисовка и формы. Сохранение возможно только при подтверждённом сервером заголовке
   X-Palitra-Price-CAS: 1 на чтении прайса. */
(() => {
  'use strict';
  const M = window.PalitraEditorModel;
  const O = window.PalitraOccasions;
  const Sess = window.PalitraEditorSession;
  const API = '/content/palitra/price';
  const ASSETS = '/content/palitra/assets';
  const CAS_HEADER = 'X-Palitra-Price-CAS';
  const COMPANY = 'palitra-love';
  /* Часовой пояс праздничных подборок Palitra — явное решение Влада 13.10.2026 (02:31): московское время.
     Проверенная константа только для palitra-love. Не берётся из браузера, адреса, хранилища браузера или профиля whoami. */
  const COMPANY_TIME_ZONE = 'Europe/Moscow';
  const COMPANY_TIME_ZONE_LABEL = 'Московское время (Europe/Moscow)';
  const MAX_UPLOAD = 8 * 1024 * 1024;
  const LIST_STEP = 60;
  /* Постоянные категории сайта (основные 6 и праздники — только из них). CATS — они же плюс свои категории
     текущего документа (publicCatalog.categories, PALITRA-CATEGORY-LINK): поводы товара, список и счётчики. */
  const CORE = O ? O.DEFAULT_PUBLIC : [];
  let CATS = CORE;
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  /* ?site= меняет только ссылку «Просмотр» и адрес фото сайта, и только на домены Palitra/Synapse по https. */
  const SITE = (() => {
    const fallback = 'https://palitra-love.synapsebusiness.ru';
    const raw = new URLSearchParams(location.search).get('site');
    if (!raw) return fallback;
    try {
      const u = new URL(raw);
      return u.protocol === 'https:' && !u.port && /^(?:[a-z0-9-]+\.)*(?:synapsebusiness\.ru|palitra-love\.ru)$/.test(u.hostname) ? u.origin : fallback;
    } catch (_) { return fallback; }
  })();

  const $ = (sel, root = document) => root.querySelector(sel);
  const h = (value) => M.esc(value);
  const catTitle = (key) => (CATS.find((c) => c.key === key) || {}).title || key;

  let session = null;       // профиль /content/whoami; CSRF только в памяти
  let companyTz = null;     // часовой пояс компании (COMPANY_TIME_ZONE) после подтверждённой сессии, иначе null
  let view = 'items';
  let draft = null, draftSnap = '', draftNew = false;
  let holidayDraft = null, holidayOrig = null, holidaySnap = '';
  let renaming = null;
  let listQuery = '', listOwner = '', listCategory = '', listLimit = LIST_STEP;
  let orderScope = 'all';

  const statusEl = $('#ed-status');
  const subEl = $('#ed-sub');
  const saveBtn = $('#ed-save');
  const alertEl = $('#ed-alert');
  const casNote = $('#ed-cas-note');
  const openPrice = $('#ed-open-price');
  if (openPrice) openPrice.href = SITE + '/price.html';

  /* PALITRA_EDITOR_HEADER_20261023: also normalize previously cached editor HTML.
     Move existing nodes, retaining handlers and form state; errors stay outside details. */
  const editorBar = $('.ed-bar');
  const editorTools = $('.ed-bar__tools');
  if (editorBar && subEl && editorTools && !$('#ed-more')) {
    const more = document.createElement('details');
    more.id = 'ed-more';
    more.className = 'ed-bar__more';
    const summary = document.createElement('summary');
    summary.textContent = 'Дополнительно';
    more.append(summary, subEl, editorTools);
    editorBar.append(more);
  }

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = 'ed-status ed-bar__status' + (kind ? ' is-' + kind : '');
  }
  function imgUrl(p) {
    if (typeof p !== 'string' || !p) return '';
    if (M.isUploadedAsset(p)) return ASSETS + p.slice('/api/assets'.length);
    if (/^\/(?!\/)[^\\\s"'<>]*$/.test(p) && !p.includes('..')) return SITE + p;
    if (/^https:\/\/[^\\\s"'<>]+$/i.test(p)) return p;
    return '';
  }
  function dateText(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(value || '—');
  }

  /* ---------- сессия и запросы ---------- */
  function sessionUnavailable(message) {
    session = null;
    saveBtn.disabled = true;
    $('#ed-login').hidden = false;
    $('#ed-session-retry').hidden = false;
    setStatus(message, 'error');
  }
  async function loadSession() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const r = await fetch('/content/whoami', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const profile = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(r.status === 401 ? 'Войдите в кабинет, чтобы редактировать прайс.'
        : 'Не удалось проверить вход. Повторите попытку.'), { status: r.status });
      const allowed = profile.role === 'owner' || (profile.permissions?.includes('price.edit') &&
        profile.companies?.some((company) => company.id === COMPANY));
      if (!allowed) throw Object.assign(new Error('Нет права редактировать прайс Palitra. Обратитесь к администратору.'), { status: 403 });
      if (typeof profile.csrfToken !== 'string' || !profile.csrfToken) {
        throw new Error('Не удалось подтвердить сессию. Войдите в кабинет снова.');
      }
      session = profile;
      // Пояс — фиксированная проверенная константа Palitra; профиль, браузер и адрес его не меняют.
      companyTz = O.isValidTimeZone(COMPANY_TIME_ZONE) ? COMPANY_TIME_ZONE : null;
      $('#ed-login').hidden = true;
      $('#ed-session-retry').hidden = true;
      return session;
    } catch (error) {
      const message = error.name === 'AbortError' ? 'Проверка входа не отвечает. Повторите попытку.' : error.message;
      sessionUnavailable(message);
      throw Object.assign(new Error(message), { status: error.status || 401, auth: true });
    } finally { clearTimeout(timeout); }
  }
  /* Запрос к кабинету → { data, cas }. cas — только для GET прайса: точный заголовок X-Palitra-Price-CAS: 1.
     Ошибка содержит status (0 — нет ответа/таймаут: исход неизвестен). */
  async function requestFull(method, url, opts = {}) {
    const write = !['GET', 'HEAD'].includes(method);
    if (write || url !== API) await loadSession();
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    if (write) headers['X-CSRF-Token'] = session.csrfToken;
    if (opts.ifMatch !== undefined && opts.ifMatch !== null) headers['If-Match'] = `"${opts.ifMatch}"`;
    let body = opts.raw;
    if (opts.json !== undefined) { body = JSON.stringify(opts.json); headers['Content-Type'] = 'application/json'; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout || 30000);
    let r;
    try { r = await fetch(url, { method, headers, body, credentials: 'same-origin', cache: 'no-store', signal: controller.signal }); }
    catch (e) {
      throw Object.assign(new Error(e.name === 'AbortError' ? 'Сервер не ответил вовремя' : 'Нет связи с сервером'), { status: 0 });
    } finally { clearTimeout(timer); }
    let data = null;
    try { data = await r.json(); } catch (_) { /* пустой или не JSON */ }
    if (!r.ok) {
      const msg = r.status === 401 ? 'Вход в кабинет истёк. Войдите снова — правки в этом окне сохранены.' : (data && typeof data.error === 'string' ? data.error : `HTTP ${r.status}`);
      if (r.status === 401 || r.status === 403) sessionUnavailable(msg);
      const details = Array.isArray(data?.details) ? data.details.filter((x) => typeof x === 'string').slice(0, 20) : [];
      throw Object.assign(new Error(msg), { status: r.status, details });
    }
    const cas = method === 'GET' && url === API && r.headers.get(CAS_HEADER) === '1';
    return { data, cas };
  }
  const request = async (method, url, opts) => (await requestFull(method, url, opts)).data;

  const S = M && O && Sess ? Sess.createSession({ model: M, api: { request: requestFull }, categories: CORE, onChange: () => updateBar() }) : null;
  /* Свои категории сайта берутся из текущего документа окна: после загрузки, правки, переноса и отмены. */
  const syncCats = () => { CATS = S && S.local && O ? O.categoriesOf(S.local, CORE) : CORE; };
  /* Изменение документа в окне — только через координатор: во время сохранения/проверки отклоняется. */
  function commit(next, opts) {
    const r = S.edit(next, opts);
    if (!r.ok) { setStatus(r.reason, 'error'); return false; }
    syncCats();
    return true;
  }
  const alertBlock = (act) => (act === 'close' ? null : S.blockReason(act));

  /* ---------- шапка ---------- */
  function updateBar() {
    if (!S) return;
    const dirty = S.dirty();
    const d = dirty ? M.diffDocs(S.base, S.local) : null;
    const n = d ? d.changed.length + d.added.length + d.deleted.length : 0;
    const parts = [];
    if (S.base) parts.push(`версия ${S.base.version ?? '—'}`);
    if (S.base && S.base.updatedAt) parts.push('обновлено ' + new Date(S.base.updatedAt).toLocaleString('ru-RU'));
    if (dirty) parts.push(n ? `не сохранено: товаров ${n}` : 'есть несохранённые изменения');
    if (S.cas === true) parts.push('проверка версии на сервере подтверждена');
    subEl.textContent = parts.join(' · ') || 'загрузка…';
    saveBtn.textContent = S.busy === 'save' ? 'Сохраняю…' : dirty ? 'Сохранить •' : 'Сохранить';
    saveBtn.disabled = !session || !S.local || S.cas !== true || Boolean(S.blockReason('save'));
    const reset = $('#ed-reset');
    reset.hidden = !dirty;
    reset.disabled = Boolean(S.blockReason('reset'));
    $('#ed-history').disabled = Boolean(S.busy);
    $('#ed-import').disabled = !S.local || Boolean(S.blockReason('import'));
    $('#ed-session-retry').disabled = Boolean(S.blockReason('session'));
    for (const b of document.querySelectorAll('#ed-alert [data-alert], #ed-cas-note [data-alert]')) b.disabled = Boolean(alertBlock(b.dataset.alert));
    for (const b of document.querySelectorAll('#ed-modal-box [data-restore]')) b.disabled = dirty || Boolean(S.blockReason('restore'));
    // Пока идёт запрос или исход сохранения не проверен, формы недоступны (правки не смешиваются с отправленными).
    const layout = $('.price-layout');
    if (layout) layout.inert = Boolean(S.busy || S.pending);
    document.querySelector('.ed-bar').setAttribute('aria-busy', String(Boolean(S.busy)));
    if (casNote) casNote.hidden = !(S.local && S.cas === false);
  }

  async function loadData(action) {
    const r = await S.load(action ? { action } : {});
    if (r.status === 'loaded') {
      draft = null; holidayDraft = null; holidayOrig = null; renaming = null;
      if (view === 'item') view = 'items';
      hideAlert();
      render();
      return r;
    }
    if (r.status === 'locked') { setStatus(r.reason, 'error'); return r; }
    if (r.status === 'bad-shape') throw new Error('Прайс на сервере в неожиданном виде — редактор не открывает его, чтобы ничего не испортить: ' + r.problems.slice(0, 3).join('; '));
    if (r.status === 'error') throw r.error;
    return r;
  }
  async function resumeSession() {
    const block = S.blockReason('session');
    if (block) { setStatus(block, 'error'); return; }
    try {
      await loadSession();
      // При загруженном прайсе проверка входа документ не трогает: правки и непроверенное сохранение остаются.
      if (!S.local) await loadData();
      setStatus(S.dirty() ? 'Вход подтверждён. Несохранённые правки остались в редакторе.' : 'Готово к работе', 'ok');
    } catch (error) { setStatus(error.message, 'error'); }
    updateBar();
  }

  /* ---------- вкладки ---------- */
  const TABS = [['items', 'tab-items', 'panel-items'], ['cats', 'tab-cats', 'panel-cats'], ['holidays', 'tab-holidays', 'panel-holidays']];
  function guardForms() {
    const formDirty = (draft && JSON.stringify(draft) !== draftSnap) || (holidayDraft && JSON.stringify(holidayDraft) !== holidaySnap);
    if (formDirty && !confirm('Закрыть форму без применения изменений? Уже применённые («Готово») правки останутся.')) return false;
    draft = null; holidayDraft = null; holidayOrig = null;
    return true;
  }
  function showTab(name, focusTab) {
    if (view === name) return;
    if ((draft || holidayDraft) && !guardForms()) return;
    view = name; renaming = null;
    render();
    if (focusTab) document.getElementById(TABS.find((t) => t[0] === name)[1]).focus();
  }

  /* ---------- отрисовка ---------- */
  function render() {
    syncCats();
    for (const [name, tab, panel] of TABS) {
      const active = view === name || (name === 'items' && view === 'item');
      const t = document.getElementById(tab);
      t.setAttribute('aria-selected', String(active));
      t.tabIndex = active ? 0 : -1;
      document.getElementById(panel).hidden = !(view === name);
    }
    $('#panel-item').hidden = view !== 'item';
    if (!S.local) { updateBar(); return; }
    if (view === 'items') renderItems();
    if (view === 'item') renderItemForm();
    if (view === 'cats') renderCats();
    if (view === 'holidays') renderHolidays();
    updateBar();
  }

  /* ----- список товаров ----- */
  function renderItems() {
    const panel = $('#panel-items');
    if (!panel.dataset.ready) {
      panel.innerHTML = `<h2 class="ed-sr">Товары</h2>
        <div class="ed-toolbar ed-card">
          <label class="ed-field ed-search"><span>Поиск товара</span>
            <input id="ed-search" type="search" autocomplete="off" placeholder="Название, номер или цена" aria-describedby="ed-search-hint">
            <small id="ed-search-hint">Можно несколько слов: «выписка мальчик». Цена — цифрами: 9270.</small></label>
          <label class="ed-field"><span>Категория на сайте</span><select id="ed-category-filter" aria-describedby="ed-category-hint"></select>
            <small id="ed-category-hint">Те же названия и товары, что в каталоге сайта.</small></label>
          <button class="ed-btn ed-btn--main ed-btn--big" id="ed-add-item" type="button">+ Добавить товар</button>
        </div>
        <details class="ed-storage-filter ed-card" id="ed-storage-filter">
          <summary>Дополнительно: раздел хранения</summary>
          <label class="ed-field"><span>Раздел хранения</span><select id="ed-owner-filter" aria-describedby="ed-storage-hint"></select>
            <small id="ed-storage-hint">Дополнительный фильтр по внутренним разделам прайса. Категории сайта выбираются выше.</small></label>
        </details>
        <p class="ed-count" id="ed-count" aria-live="polite"></p>
        <ul class="ed-list" id="ed-list"></ul>
        <button class="ed-btn ed-more-btn" id="ed-list-more" type="button" hidden>Показать ещё</button>`;
      panel.dataset.ready = '1';
    }
    const local = S.local;
    const owner = $('#ed-owner-filter');
    owner.innerHTML = '<option value="">Все разделы</option>' + local.categories.map((c) => `<option value="${h(c.id)}">${h(c.title)} (${(c.items || []).length})</option>`).join('');
    if (!local.categories.some((c) => c.id === listOwner)) listOwner = '';
    owner.value = listOwner;
    if (listOwner) $('#ed-storage-filter').open = true;
    const category = $('#ed-category-filter');
    const counts = M.publicKeyCounts(local, CATS);
    const unlisted = M.listItems(local, CATS).filter(row => !row.publicKeys.length).length;
    if (listCategory && listCategory !== '__unlisted' && !CATS.some(c => c.key === listCategory)) listCategory = '';
    category.innerHTML = `<option value="">Все товары (${M.itemCount(local)})</option>`
      + CATS.filter(c => c.key !== 'all' && !c.holiday).map(c => `<option value="${h(c.key)}">${h(c.title)} (${counts[c.key] || 0})</option>`).join('')
      + `<option value="__unlisted">Без категории на сайте (${unlisted})</option>`;
    category.value = listCategory;
    const search = $('#ed-search');
    if (search.value !== listQuery) search.value = listQuery;
    drawList();
  }
  function drawList() {
    const rows = M.searchItems(S.local, listQuery, { ownerId: listOwner || undefined,
      publicKey: listCategory && listCategory !== '__unlisted' ? listCategory : undefined, categories: CATS })
      .filter(row => listCategory !== '__unlisted' || !row.publicKeys.length);
    const diff = S.base ? M.diffDocs(S.base, S.local) : { changed: [], added: [] };
    const changed = new Set(diff.changed.concat(diff.added));
    const total = M.itemCount(S.local);
    $('#ed-count').textContent = listQuery || listOwner || listCategory ? `Найдено: ${rows.length} из ${total}` : `Всего товаров: ${total}`;
    $('#ed-list').innerHTML = rows.slice(0, listLimit).map((r) => `<li class="ed-row${changed.has(r.id) ? ' is-changed' : ''}">
      <div class="ed-thumb">${r.photo && imgUrl(r.photo) ? `<img src="${h(imgUrl(r.photo))}" alt="" loading="lazy" decoding="async">` : 'нет фото'}</div>
      <div class="ed-row__body">
        <p class="ed-row__title">${h(r.title || '(без названия)')}</p>
        <p class="ed-row__meta">${h(r.price || 'цена не указана')}${r.photos > 1 ? ` · фото: ${r.photos}` : ''}</p>
        <p class="ed-row__meta">Категории на сайте: ${r.publicKeys.length ? h(r.publicKeys.map(catTitle).join(', ')) : 'не выбраны'}${r.explicit ? '' : ' <span class="ed-badge">по разделу хранения</span>'}</p>
        <p class="ed-row__meta ed-row__storage">Хранение: ${h(r.ownerTitle)} · № ${h(r.id)}</p>
        ${changed.has(r.id) ? '<span class="ed-badge ed-badge--warn">изменён, не сохранён</span>' : ''}
      </div>
      <div class="ed-row__actions"><button class="ed-btn" type="button" data-edit="${h(r.id)}" aria-label="Изменить: ${h(r.title || r.id)}">Изменить</button></div>
    </li>`).join('') || '<li class="ed-status">Ничего не найдено. Измените запрос, категорию или дополнительный фильтр.</li>';
    const more = $('#ed-list-more');
    more.hidden = rows.length <= listLimit;
    more.textContent = `Показать ещё (${Math.max(0, rows.length - listLimit)})`;
  }

  /* ----- форма товара ----- */
  function openItem(id) {
    if (!guardForms()) return;
    const d = M.draftOf(S.local, id);
    if (!d) { setStatus('Товар не найден', 'error'); return; }
    draft = d; draftNew = false; draftSnap = JSON.stringify(d);
    view = 'item'; render();
    $('#ed-item-heading')?.focus();
  }
  function openNewItem() {
    if (!guardForms()) return;
    const cats = S.local.categories;
    const owner = cats.some((c) => c.id === 'prochee') ? 'prochee' : (cats[0] || {}).id;
    if (!owner) { setStatus('Сначала создайте раздел прайса во вкладке «Категории»', 'error'); return; }
    draft = { id: null, ownerId: owner, title: '', price: '', desc: '', note: '', composition: '', card: '', duration: '', who: '',
      itemsText: '', photos: [], photosTouched: false, frames: {}, framesTouched: false, manualCategories: true, publicCategories: listCategory && listCategory !== '__unlisted' ? [listCategory] : [] };
    draftNew = true; draftSnap = JSON.stringify(draft);
    view = 'item'; render();
    $('#ed-item-heading')?.focus();
  }
  function closeItem(focusId) {
    draft = null; view = 'items'; render();
    const target = focusId && document.querySelector(`[data-edit="${CSS.escape(focusId)}"]`);
    (target || $('#ed-search'))?.focus();
  }
  function occasionsHtml() {
    const legacy = O.basePublicKeys({}, draft.ownerId, CATS);
    const owner = S.local.categories.find((c) => c.id === draft.ownerId);
    return `<label class="ed-check"><input type="checkbox" data-manual ${draft.manualCategories ? 'checked' : ''}>
        <span>Выбрать категории вручную <small class="ed-hint">(можно несколько; товар останется одним, без копий)</small></span></label>
      <p class="ed-hint" id="ed-occ-legacy">${draft.manualCategories ? 'Отметьте категории каталога, в которых показывать товар.'
        : `Категории выбраны по разделу хранения «${h(owner ? owner.title : draft.ownerId)}»: ${legacy.length ? h(legacy.map(catTitle).join(', ')) : 'нет категорий на сайте'}.`}</p>
      <div class="ed-checks${draft.manualCategories ? '' : ' is-disabled'}">${CATS.map((c) => `<label class="ed-check"><input type="checkbox" data-occ="${h(c.key)}"
        ${(draft.manualCategories ? draft.publicCategories : legacy).includes(c.key) ? 'checked' : ''} ${draft.manualCategories ? '' : 'disabled'}><span>${h(c.title)}</span></label>`).join('')}</div>`;
  }
  function renderItemForm() {
    const panel = $('#panel-item');
    const field = (name, label, opts = {}) => {
      const value = h(draft[name] ?? '');
      const control = opts.area ? `<textarea name="${name}" data-draft="${name}" rows="${opts.rows || 4}" maxlength="${M.LIMITS[name] || 4000}">${value}</textarea>`
        : `<input name="${name}" data-draft="${name}" value="${value}" maxlength="${M.LIMITS[name] || 200}" ${opts.attrs || ''}>`;
      return `<label class="ed-field"><span>${label}${opts.req ? ' <b class="ed-req">обязательно</b>' : ''}</span>${control}${opts.hint ? `<small>${opts.hint}</small>` : ''}</label>`;
    };
    const cats = S.local.categories;
    const sameKind = cats.filter((c) => {
      const current = cats.find((x) => x.id === draft.ownerId);
      return !current || c.kind === current.kind;
    });
    panel.innerHTML = `<form id="ed-item-form" novalidate>
      <div class="ed-form-head">
        <button class="ed-btn" type="button" data-form-act="back">← К списку</button>
        <h2 id="ed-item-heading" tabindex="-1">${draftNew ? 'Новый товар' : 'Изменить товар'}</h2>
        ${draftNew ? '' : `<p class="ed-hint">№ ${h(draft.id)} — номер не меняется</p>`}
      </div>
      <div class="ed-form-grid">
        <div>
          <div class="ed-card">
            ${field('title', 'Название', { req: true, attrs: 'required autocomplete="off"', hint: 'Так товар называется на сайте, в корзине и в заявке.' })}
            ${field('price', 'Цена', { attrs: 'inputmode="decimal" autocomplete="off" placeholder="7720"', hint: '7720 → «7 720 руб.»; копейки через запятую. Пусто — «Цена уточняется». Текст («от 5000») сохранится как есть, но корзина его не посчитает.' })}
            ${field('desc', 'Описание', { area: true, hint: 'Показывается покупателю в карточке товара.' })}
            ${field('composition', 'Состав', { area: true, hint: 'Что входит в набор. Можно по строкам.' })}
            ${field('note', 'Примечание', { hint: 'Необязательно. Служебная строка «Цена из публикации…» на сайте не показывается.' })}
          </div>
          <fieldset class="ed-card" id="ed-occ"><legend>Категории на сайте</legend>${occasionsHtml()}</fieldset>
          <details class="ed-details ed-card"><summary>Дополнительно</summary>
            <label class="ed-field"><span>Раздел хранения</span><select data-owner>${sameKind.map((c) => `<option value="${h(c.id)}" ${c.id === draft.ownerId ? 'selected' : ''}>${h(c.title)}</option>`).join('')}</select>
              <small>Внутренний раздел для хранения товара. Показ в каталоге задают категории выше.</small></label>
            ${field('card', 'Короткое название (для списков редактора)')}
            ${field('duration', 'Длительность')}
            ${field('who', 'Кому подходит')}
            <label class="ed-field"><span>Состав по пунктам (старое поле)</span><textarea data-draft="itemsText" rows="4">${h(draft.itemsText)}</textarea><small>По одному пункту в строке. Сайт это поле сейчас не показывает.</small></label>
          </details>
        </div>
        <div class="ed-card" id="ed-photos-box"></div>
      </div>
      <div class="ed-errors" id="ed-form-errors" role="alert"></div>
      <div class="ed-form-actions">
        <button class="ed-btn ed-btn--main ed-btn--big" type="submit">Готово</button>
        <button class="ed-btn ed-btn--big" type="button" data-form-act="cancel">Отмена</button>
        ${draftNew ? '' : '<button class="ed-btn ed-btn--danger" type="button" data-form-act="delete">Удалить товар</button>'}
      </div>
    </form>`;
    renderPhotos();
  }
  function renderPhotos() {
    const box = $('#ed-photos-box');
    if (!box || !draft) return;
    const list = draft.photos;
    const title = draft.title || 'товар';
    const main = list[0] && imgUrl(list[0]);
    box.innerHTML = `<h3>Фото</h3>
      <figure class="ed-mainphoto"><div class="ed-mainphoto__frame" data-frame-preview>${main ? `<img src="${h(main)}" alt="${h('Основное фото: ' + title)}">` : '<span class="ed-hint">Фото нет — на сайте будет заглушка с логотипом</span>'}</div>
        <figcaption>${main && frameOf(list[0]) ? 'Так основное фото выглядит в карточке: кадр настроен.' : 'Так основное фото выглядит в карточке: целиком, без обрезки.'}</figcaption></figure>
      <ol class="ed-photos">${list.map((p, i) => `<li class="ed-photo${i === 0 ? ' is-cover' : ''}">
        <div class="ed-thumb">${imgUrl(p) ? `<img src="${h(imgUrl(p))}" alt="" loading="lazy">` : 'адрес скрыт'}</div>
        <span class="ed-photo__label">${i === 0 ? 'Основное' : `Фото ${i + 1}`}${frameOf(p) ? ' <span class="ed-badge">кадр настроен</span>' : ''}</span>
        <div class="ed-photo__tools">
          ${imgUrl(p) ? `<button class="ed-btn" type="button" data-photo-act="frame" data-index="${i}" aria-label="Настроить кадр: ${i === 0 ? 'основное фото' : `фото ${i + 1}`}">Настроить кадр</button>` : ''}
          ${i > 0 ? `<button class="ed-btn" type="button" data-photo-act="cover" data-index="${i}" aria-label="Сделать фото ${i + 1} основным">Основное</button>` : ''}
          ${i > 0 ? `<button class="ed-btn ed-btn--icon" type="button" data-photo-act="left" data-index="${i}" aria-label="Фото ${i + 1}: раньше" ${i <= 1 ? 'disabled' : ''}>←</button>
          <button class="ed-btn ed-btn--icon" type="button" data-photo-act="right" data-index="${i}" aria-label="Фото ${i + 1}: позже" ${i >= list.length - 1 ? 'disabled' : ''}>→</button>` : ''}
          <label class="ed-btn ed-btn--file">Заменить<input type="file" accept="image/jpeg,image/png,image/webp" data-photo-replace="${i}" aria-label="Заменить ${i === 0 ? 'основное фото' : `фото ${i + 1}`}"></label>
          <button class="ed-btn ed-btn--danger" type="button" data-photo-act="remove" data-index="${i}" aria-label="Удалить ${i === 0 ? 'основное фото' : `фото ${i + 1}`}">Удалить</button>
        </div></li>`).join('')}</ol>
      <label class="ed-btn ed-btn--file${list.length >= M.MAX_PHOTOS ? ' is-full' : ''}" ${list.length >= M.MAX_PHOTOS ? 'aria-disabled="true"' : ''}>+ Добавить фото<input type="file" accept="image/jpeg,image/png,image/webp" multiple data-photo-add ${list.length >= M.MAX_PHOTOS ? 'disabled' : ''}></label>
      <p class="ed-hint">Основное и до ${M.MAX_GALLERY} дополнительных. JPEG, PNG или WebP до 8 МБ; файл загружается как есть, без уменьшения. «Настроить кадр» меняет только то, как фото стоит в рамке.</p>
      <p class="ed-status" id="ed-photo-status" role="status" aria-live="polite"></p>`;
    const preview = box.querySelector('[data-frame-preview] img');
    if (preview) showFramed(preview, preview.parentElement, list[0], frameOf(list[0]));
  }
  function photoStatus(text, bad) {
    const el = $('#ed-photo-status');
    if (el) { el.textContent = text; el.className = 'ed-status' + (bad ? ' is-error' : ''); }
  }
  function photoAction(act, index) {
    if (!draft) return;
    if (act === 'frame') { openFramer(index); return; }
    const ops = { cover: () => M.photoOps.makeCover(draft.photos, index), left: () => M.photoOps.move(draft.photos, index, -1),
      right: () => M.photoOps.move(draft.photos, index, 1), remove: () => M.photoOps.remove(draft.photos, index) };
    if (!ops[act]) return;
    const removed = act === 'remove' ? draft.photos[index] : null;
    draft.photos = ops[act]();
    draft.photosTouched = true;
    // Кадр привязан к самому снимку: у удалённого фото он удаляется и не переходит на другое.
    if (removed && draft.frames && !draft.photos.includes(removed) && Object.prototype.hasOwnProperty.call(draft.frames, removed)) { delete draft.frames[removed]; draft.framesTouched = true; }
    renderPhotos();
    const focusIndex = act === 'left' ? index - 1 : act === 'right' ? index + 1 : act === 'cover' ? index : Math.min(index, draft.photos.length - 1);
    const next = document.querySelector(`#ed-photos-box [data-index="${focusIndex}"][data-photo-act="${act}"]`) || document.querySelector('#ed-photos-box [data-photo-add]');
    next?.focus();
    photoStatus(act === 'remove' ? 'Фото убрано из формы. Нажмите «Готово», затем «Сохранить».' : 'Порядок изменён. Нажмите «Готово», затем «Сохранить».');
  }
  /* ---------- кадр фото (PALITRA-PHOTO-COMPOSITION-36) ----------
     «Настроить кадр» у каждого фото формы: рамка покупателя 4:5, перетаскивание мышью/пальцем, клавиатура, масштаб,
     «По центру», «Сбросить». Превью карточки и корзины считаются тем же общим модулем (M.photoFrame), что
     и публичный price-render.js. Исходный файл не меняется: в форме хранится только { x, y, scale } для адреса фото.
     «Готово» окна пишет кадр в черновик формы; «Отмена»/Escape ничего не меняют. */
  const PF = M.photoFrame;
  const frameOf = (src) => (draft && draft.frames && Object.prototype.hasOwnProperty.call(draft.frames, src) ? draft.frames[src] : null);
  /* Пересчёт превью при изменении размера рамки (поворот телефона, ширина окна). */
  const previewRuns = new WeakMap();
  const previewResize = typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => { for (const entry of entries) { const run = previewRuns.get(entry.target); if (run) run(); } }) : null;
  /* Показ фото в рамке так, как его увидит покупатель (без кадра — как сейчас на сайте). */
  function showFramed(img, box, src, frame) {
    const run = () => PF.applyImg(img, box, frame || PF.DEFAULT, PF.publicUrl(src));
    previewRuns.set(box, run);
    if (previewResize) previewResize.observe(box);
    img.addEventListener('load', run);
    if (img.complete && img.naturalWidth) run();
    return run;
  }
  let framerOpen = false;
  function openFramer(index, categoryKey = null) {
    const category = typeof categoryKey === 'string';
    if (framerOpen || (!category && !draft)) return;
    if (S.blockReason('edit')) { setStatus(S.blockReason('edit'), 'error'); return; }
    const generation = S.ticket();
    const categorySource = category ? O.categoryPhoto(S.local, categoryKey) : '';
    const categoryStartFrame = category ? O.categoryPhotoFrame(S.local, categoryKey) : null;
    const target = category ? { photos: [categorySource], title: catTitle(categoryKey), price: '' } : draft;
    const current = () => S.isCurrent(generation) && (category
      ? O.categoryPhoto(S.local, categoryKey) === categorySource && M.same(O.categoryPhotoFrame(S.local, categoryKey), categoryStartFrame)
      : draft === target && target.photos.includes(src));
    const src = target.photos[index];
    const url = src ? imgUrl(src) : '';
    if (!url) { photoStatus('Это фото нельзя показать в редакторе — кадр настроить нельзя.', true); return; }
    framerOpen = true;
    const opener = document.activeElement;
    const label = category ? `обложка «${catTitle(categoryKey)}»` : index === 0 ? 'основное фото' : `фото ${index + 1}`;
    const price = M.normalizePrice(M.cleanText(target.price, false)).value || 'Цена уточняется';
    const initialState = PF.normalize((category ? categoryStartFrame : frameOf(src)) || PF.DEFAULT);
    let state = PF.normalize(initialState);
    const dialog = document.createElement('dialog');
    dialog.className = 'ed-framer' + (category ? ' ed-framer--category' : '');
    dialog.setAttribute('aria-labelledby', 'ed-framer-title');
    dialog.innerHTML = `<div class="ed-framer__inner">
      <h2 id="ed-framer-title">Кадр: ${h(label)}</h2>
      <p class="ed-hint" id="ed-framer-help">Перетащите фото мышью или пальцем. С клавиатуры: стрелки — сдвиг (с Shift — крупнее), «+» и «−» — масштаб, Home — по центру. Сам файл фото не меняется.</p>
      <div class="ed-framer__layout">
        <div class="ed-framer__stage">
          <div class="ed-framer__frame" data-framer-stage tabindex="0" role="group" aria-roledescription="рамка фото" aria-label="${category ? 'Рамка обложки категории' : 'Рамка фото в карточке товара'}" aria-describedby="ed-framer-help"><img alt="" draggable="false" src="${h(url)}"></div>
          <p class="ed-status" data-framer-status role="status" aria-live="polite">Загружаю фото…</p>
        </div>
        <div class="ed-framer__side">
          <p class="ed-label">Так увидит покупатель</p>
          <div class="ed-framer__card" aria-hidden="true"><div class="ed-framer__media" data-framer-card><img alt="" src="${h(url)}"></div>
            <div class="ed-framer__body"><p class="ed-framer__title">${h(M.cleanText(target.title, false) || 'Название товара')}</p>${category ? '' : `<p class="ed-framer__price">${h(price)}</p>`}</div></div>
          ${category ? '' : `<p class="ed-label">В корзине</p>
          <div class="ed-framer__cart" data-framer-cart aria-hidden="true"><img alt="" src="${h(url)}"></div>`}
        </div>
      </div>
      <div class="ed-framer__controls">
        <label class="ed-field ed-framer__zoom"><span>Масштаб: <output data-framer-zoom-value>100%</output></span>
          <input type="range" min="100" max="${Math.round(PF.MAX_SCALE * 100)}" step="1" value="100" data-framer-zoom></label>
        <div class="ed-framer__buttons">
          <button class="ed-btn" type="button" data-framer="center">По центру</button>
          <button class="ed-btn" type="button" data-framer="reset">Сбросить</button>
        </div>
      </div>
      <div class="ed-framer__actions">
        <button class="ed-btn ed-btn--main ed-btn--big" type="button" data-framer="apply">Готово</button>
        <button class="ed-btn ed-btn--big" type="button" data-framer="cancel">Отмена</button>
      </div></div>`;
    document.body.append(dialog);
    const stage = dialog.querySelector('[data-framer-stage]');
    const stageImg = stage.querySelector('img');
    const views = [[stageImg, stage], [dialog.querySelector('[data-framer-card] img'), dialog.querySelector('[data-framer-card]')],
      [dialog.querySelector('[data-framer-cart] img'), dialog.querySelector('[data-framer-cart]')]].filter(([img, box]) => img && box);
    const status = dialog.querySelector('[data-framer-status]');
    const zoom = dialog.querySelector('[data-framer-zoom]');
    const zoomValue = dialog.querySelector('[data-framer-zoom-value]');
    const publicSrc = PF.publicUrl(src);
    let ready = false;
    const applyButton = dialog.querySelector('[data-framer="apply"]');
    applyButton.disabled = true;
    const coverFloor = () => PF.fillScale(stage.clientWidth, stage.clientHeight, stageImg.naturalWidth, stageImg.naturalHeight,
      PF.usefulRect(publicSrc, stageImg.naturalWidth, stageImg.naturalHeight));
    const zoomRatio = () => Math.max(1, state.scale / coverFloor());
    const zoomTo = (ratio) => setState(PF.zoom(state, coverFloor() * Math.max(1, ratio)));
    const draw = () => {
      for (const [img, box] of views) PF.applyImg(img, box, state, publicSrc);
      const max = Math.max(100, Math.floor(PF.MAX_SCALE / coverFloor() * 100));
      zoom.max = String(max);
      zoom.disabled = !ready || max === 100;
      const percent = Math.min(max, Math.round(zoomRatio() * 100));
      zoom.value = String(percent);
      zoomValue.textContent = `${percent}%`;
      zoom.setAttribute('aria-valuetext', `${percent}% от заполнения карточки`);
    };
    const setState = (next) => { state = PF.normalize(next); draw(); };
    for (const [img] of views) img.addEventListener('load', draw);
    for (const [, box] of views) { previewRuns.set(box, draw); if (previewResize) previewResize.observe(box); }
    const onReady = () => { ready = true; applyButton.disabled = false; status.textContent = PF.isDefault(state) ? 'Фото заполняет карточку. Можно увеличить и сдвинуть кадр.' : 'Показан сохранённый кадр. Можно увеличить и сдвинуть фото.'; draw(); };
    stageImg.addEventListener('load', onReady, { once: true });
    stageImg.addEventListener('error', () => { status.textContent = 'Фото не загрузилось — кадр настроить нельзя. Закройте окно и попробуйте позже.'; status.classList.add('is-error'); }, { once: true });
    if (stageImg.complete && stageImg.naturalWidth) onReady();
    const panBy = (dx, dy) => setState(PF.pan(state, dx, dy, stage.clientWidth, stage.clientHeight, stageImg.naturalWidth, stageImg.naturalHeight,
      PF.usefulRect(publicSrc, stageImg.naturalWidth, stageImg.naturalHeight)));
    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
      if (!ready || (e.pointerType === 'mouse' && e.button !== 0)) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      try { stage.setPointerCapture(e.pointerId); } catch (_) { /* захват недоступен — движение всё равно идёт по событиям рамки */ }
      stage.classList.add('is-dragging');
      e.preventDefault();
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      panBy(dx, dy);
    });
    const endDrag = (e) => { if (drag && (!e || e.pointerId === drag.id)) { drag = null; stage.classList.remove('is-dragging'); } };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('lostpointercapture', endDrag);
    stage.addEventListener('keydown', (e) => {
      if (!ready) return;
      const step = (e.shiftKey ? 0.1 : 0.02);
      const bw = stage.clientWidth, bh = stage.clientHeight;
      const moves = { ArrowLeft: [-step * bw, 0], ArrowRight: [step * bw, 0], ArrowUp: [0, -step * bh], ArrowDown: [0, step * bh] };
      if (moves[e.key]) { e.preventDefault(); panBy(moves[e.key][0], moves[e.key][1]); return; }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomTo(zoomRatio() + 0.1); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomTo(zoomRatio() - 0.1); return; }
      if (e.key === 'Home') { e.preventDefault(); setState({ ...state, x: 0.5, y: 0.5 }); }
    });
    zoom.addEventListener('input', () => { if (ready) zoomTo(Number(zoom.value) / 100); });
    const close = (apply) => {
      if (!framerOpen || (apply && !ready)) return;
      framerOpen = false;
      const valid = current();
      const changed = !M.same(initialState, state);
      // Close and release observers before redrawing the parent form.
      if (typeof dialog.close === 'function') { if (dialog.open) dialog.close(); } else dialog.removeAttribute('open');
      if (previewResize) for (const [, box] of views) { previewResize.unobserve(box); previewRuns.delete(box); }
      dialog.remove();
      if (apply && valid && changed) {
        if (category) {
          sectionEdit(() => M.setCategoryPhotoFrame(S.local, categoryKey,
            PF.isDefault(state) ? null : { v: 1, ...PF.normalize(state) }, CORE).doc,
            'Кадр обложки выбран. Нажмите «Сохранить», чтобы применить на сайте.',
            `[data-category-photo-frame="${CSS.escape(categoryKey)}"]`);
        } else {
          target.frames = target.frames && typeof target.frames === 'object' ? target.frames : {};
          if (PF.isDefault(state)) delete target.frames[src];
          else target.frames[src] = PF.normalize(state);
          target.framesTouched = true;
          renderPhotos();
          photoStatus('Кадр выбран. Нажмите «Готово» в форме товара, затем «Сохранить».');
        }
      } else if (apply && !valid) setStatus('Данные обновились, кадр не применён. Откройте его ещё раз.', 'error');
      const at = !category && draft === target ? target.photos.indexOf(src) : -1;
      const back = (category ? document.querySelector(`[data-category-photo-frame="${CSS.escape(categoryKey)}"]`)
        : at >= 0 ? document.querySelector(`#ed-photos-box [data-photo-act="frame"][data-index="${at}"]`) : null)
        || (opener && opener.isConnected ? opener : null)
        || document.querySelector('#ed-photos-box [data-photo-add]') || document.querySelector('#ed-item-heading');
      if (back && typeof back.focus === 'function') back.focus();
    };
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(false); });
    // Escape и без нативного dialog (там нет события cancel): то же, что «Отмена».
    dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(false); } });
    dialog.addEventListener('click', (e) => {
      const act = e.target.closest && e.target.closest('[data-framer]');
      if (!act) return;
      const kind = act.dataset.framer;
      if (kind === 'apply') close(true);
      else if (kind === 'cancel') close(false);
      else if (kind === 'center' && ready) setState({ ...state, x: 0.5, y: 0.5 });
      else if (kind === 'reset' && ready) setState(PF.DEFAULT);
    });
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    stage.focus();
  }
  /* Фото загружается как есть — полный оригинал без уменьшения и перекодирования (кадр задаётся отдельно и файл не меняет).
     Предел сервера 8 МБ не обходится: больший файл не отправляется, причина видна сразу. */
  async function uploadImage(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error(`«${file.name}»: нужен JPEG, PNG или WebP`);
    if (!(file.size > 0)) throw new Error(`«${file.name}»: пустой файл`);
    if (file.size > MAX_UPLOAD) throw new Error(`«${file.name}»: файл больше 8 МБ (${(file.size / 1024 / 1024).toFixed(1).replace('.', ',')} МБ). Уменьшите фото и загрузите снова`);
    const j = await request('POST', ASSETS, { raw: file, headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name) } });
    if (!M.isUploadedAsset(j && j.url)) throw new Error('Сервер не подтвердил адрес загруженного фото');
    return j.url;
  }
  /* Результат загрузки попадает только в черновик той же открытой формы и того же поколения документа.
     Форма закрыта/отменена, правки сброшены или прайс перезагружен — поздний ответ ничего не меняет.
     Замена ищет заменяемое фото по адресу уже после ответа: если его удалили или заменили — чужая позиция не трогается. */
  async function addPhotos(files, replaceIndex) {
    const target = draft;
    if (!target) return;
    const ticket = S.ticket();
    const current = () => draft === target && S.isCurrent(ticket);
    const replacing = replaceIndex === undefined ? null : target.photos[replaceIndex];
    if (replaceIndex !== undefined && !replacing) return;
    let added = 0;
    for (const file of files) {
      if (!current()) return;
      if (replacing === null && target.photos.length >= M.MAX_PHOTOS) { photoStatus(`Не больше ${M.MAX_PHOTOS} фото: основное и ${M.MAX_GALLERY} дополнительных.`, true); break; }
      photoStatus(`Загружаю «${file.name}»…`);
      try {
        const url = await uploadImage(file);
        if (!current()) return;
        if (replacing === null) target.photos = M.photoOps.add(target.photos, url);
        else {
          const at = target.photos.indexOf(replacing);
          if (at < 0) { photoStatus('Это фото уже удалено или заменено в форме — новая загрузка не поставлена на его место. Добавьте её кнопкой «+ Добавить фото».', true); return; }
          target.photos = M.photoOps.replace(target.photos, at, url);
          // Кадр относился к прежнему снимку и на новый не переносится.
          if (target.frames && !target.photos.includes(replacing) && Object.prototype.hasOwnProperty.call(target.frames, replacing)) { delete target.frames[replacing]; target.framesTouched = true; }
        }
        target.photosTouched = true; added += 1;
        renderPhotos();
      } catch (e) {
        if (current()) photoStatus('Не загружено: ' + e.message + ' Форма и уже загруженные фото остаются.', true);
        return;
      }
    }
    if (added && current()) photoStatus(`Фото ${replacing === null ? 'добавлено' : 'заменено'}: ${added}. Нажмите «Готово», затем «Сохранить».`);
  }
  function showFormErrors(list) {
    const box = $('#ed-form-errors');
    box.innerHTML = list.length ? `<p>Не применено:</p><ul>${list.map((e) => `<li>${h(e)}</li>`).join('')}</ul>` : '';
  }
  function applyItem() {
    if (!draft) return;
    if (!M.cleanText(draft.title, false)) { showFormErrors(['Название товара обязательно']); $('[data-draft="title"]')?.focus(); return; }
    let doc = S.local, id = draft.id;
    if (draftNew) {
      try { const r = M.addItem(S.local, draft.ownerId, draft.title); doc = r.doc; id = r.id; }
      catch (e) { showFormErrors([e.message]); return; }
    }
    const res = M.applyDraft(doc, { ...draft, id }, { categories: CATS });
    if (res.errors.length) { showFormErrors(res.errors); return; }
    if (!commit(res.doc)) { showFormErrors([S.blockReason('edit') || 'Изменение не применено']); return; }
    const wasNew = draftNew;
    closeItem(id);
    listLimit = Math.max(listLimit, LIST_STEP);
    const changed = wasNew || res.changed;
    setStatus((changed ? (wasNew ? `Товар добавлен (№ ${id}) в редакторе.` : 'Изменения применены в редакторе.') + ' Нажмите «Сохранить», чтобы они появились на сайте.' : 'Изменений в товаре нет.')
      + (res.warnings.length ? ' ' + res.warnings.join(' ') : ''), res.warnings.length ? 'error' : changed ? 'ok' : '');
  }
  function deleteCurrent() {
    if (!draft || draftNew) return;
    const f = M.findItem(S.local, draft.id);
    if (!f || !confirm(`Удалить «${f.item.title}» из прайса? На сайте товар исчезнет после «Сохранить».`)) return;
    if (!commit(M.deleteItem(S.local, draft.id).doc, { deletedId: draft.id })) return;
    draft = null; view = 'items'; render();
    $('#ed-search')?.focus();
    setStatus('Товар удалён в редакторе. Нажмите «Сохранить», чтобы применить на сайте.', 'ok');
  }


  function categoryPhotosHtml() {
    const scopes = O.productOrderScopes(S.local, CORE).filter(scope => scope.key !== 'all');
    return `<div class="ed-card" id="ed-category-photos"><h2>Фотографии категорий</h2>
      <p class="ed-hint">Загрузите отдельную обложку категории или подборки. Обложка заполнит карточку без полос. После загрузки нажмите «Настроить кадр»: увеличьте и сдвиньте фото, затем сохраните. Исходный файл и фотографии товаров остаются прежними.</p>
      <ul class="ed-order">${scopes.map(scope => {
        const photo = O.categoryPhoto(S.local, scope.key);
        return `<li><span class="ed-order__name">${h(scope.title)}${scope.holiday ? ' · подборка' : ''}
          ${photo ? `<span class="ed-category-cover" data-category-cover="${h(scope.key)}"><img src="${h(imgUrl(photo))}" alt="Обложка: ${h(scope.title)}" width="112" height="112"></span>` : '<small>Используется стандартная фотография</small>'}</span>
          <span class="ed-order__tools"><label class="ed-btn ed-btn--file">${photo ? 'Заменить фото' : 'Загрузить фото'}<input type="file" accept="image/jpeg,image/png,image/webp" data-category-photo="${h(scope.key)}" aria-label="Фото категории: ${h(scope.title)}"></label>
          ${photo ? `<button type="button" class="ed-btn" data-category-photo-frame="${h(scope.key)}" aria-label="Настроить кадр: ${h(scope.title)}">Настроить кадр</button><button type="button" class="ed-btn" data-category-photo-reset="${h(scope.key)}" aria-label="Стандартное фото: ${h(scope.title)}">Стандартное фото</button>` : ''}</span></li>`;
      }).join('')}</ul></div>`;
  }
  const categoryUploads = new Map();
  async function uploadCategoryPhoto(key, file) {
    const block = S.blockReason('edit');
    if (block) { setStatus(block, 'error'); return; }
    const generation = S.ticket(), operation = {};
    categoryUploads.set(key, operation);
    const previous = O.categoryPhoto(S.local, key);
    const current = () => categoryUploads.get(key) === operation && S.isCurrent(generation)
      && O.categoryPhoto(S.local, key) === previous;
    setStatus('Загружаю фотографию категории…');
    try {
      const src = await uploadImage(file);
      if (!current()) return;
      sectionEdit(() => M.setCategoryPhoto(S.local, key, src, CORE).doc,
        'Фотография добавлена. Нажмите «Настроить кадр», затем «Сохранить».');
    } catch (error) { if (current()) setStatus('Фото не добавлено: ' + error.message + '. Прежняя обложка сохранена.', 'error'); }
    finally { if (categoryUploads.get(key) === operation) categoryUploads.delete(key); }
  }

  function productOrderHtml() {
    const scopes = O.productOrderScopes(S.local, CORE);
    if (!scopes.some(scope => scope.key === orderScope)) orderScope = scopes[0]?.key || 'all';
    const rows = M.productOrderItems(S.local, orderScope, CORE);
    return `<div class="ed-card" id="ed-product-order"><h2>Порядок товаров на сайте</h2>
      <p class="ed-hint">У каждой категории и подборки свой порядок. Стрелки или номер позиции меняют его только здесь. Сортировка покупателя по цене временно перекрывает этот порядок. Нажмите «Сохранить», чтобы применить.</p>
      <label class="ed-field"><span>Категория или подборка</span><select id="ed-product-order-scope">${scopes.map(scope => `<option value="${h(scope.key)}" ${scope.key === orderScope ? 'selected' : ''}>${h(scope.title)}${scope.holiday ? ' · подборка' : ''}</option>`).join('')}</select></label>
      <ol class="ed-order" aria-label="Порядок товаров">${rows.map((row, i) => `<li>
        <label class="ed-field"><span>Позиция</span><input type="number" style="width:4.5em;min-height:44px" min="1" max="${rows.length}" step="1" value="${i + 1}" data-product-position="${h(row.id)}" aria-label="Позиция: ${h(row.title)}"></label>
        <span class="ed-order__name">${h(row.title)}<small>№ ${h(row.id)}</small></span>
        <span class="ed-order__tools"><button class="ed-btn ed-btn--icon" type="button" style="min-width:44px;min-height:44px" data-product-order="up" data-id="${h(row.id)}" aria-label="«${h(row.title)}» выше" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="ed-btn ed-btn--icon" type="button" style="min-width:44px;min-height:44px" data-product-order="down" data-id="${h(row.id)}" aria-label="«${h(row.title)}» ниже" ${i === rows.length - 1 ? 'disabled' : ''}>↓</button></span></li>`).join('') || '<li>В этой категории пока нет товаров.</li>'}</ol></div>`;
  }
  function productOrderAction(id, position, delta) {
    if (alertBlock('edit')) { setStatus(alertBlock('edit'), 'error'); return; }
    try {
      const result = delta ? M.moveProduct(S.local, orderScope, id, delta, CORE) : M.placeProduct(S.local, orderScope, id, position, CORE);
      if (!commit(result.doc)) return;
      renderCats(); updateBar();
      const selector = delta ? `[data-product-order="${delta < 0 ? 'up' : 'down'}"][data-id="${CSS.escape(id)}"]:not([disabled])` : `[data-product-position="${CSS.escape(id)}"]`;
      const focus = document.querySelector(selector) || document.querySelector(`[data-product-position="${CSS.escape(id)}"]`);
      focus?.focus();
      setStatus('Порядок изменён в редакторе. Нажмите «Сохранить».', 'ok');
    } catch (error) { setStatus(error.message, 'error'); renderCats(); }
  }

  /* ----- категории ----- */
  function renderCats(focusSel) {
    const panel = $('#panel-cats');
    const local = S.local;
    const home = M.homeOf(local, CORE);
    const counts = M.publicKeyCounts(local, CATS);
    const rest = CATS.filter((c) => c.key !== 'all' && !c.holiday && !home.includes(c.key));
    const full = home.length >= O.HOME_MAX;
    const count = (key) => `${counts[key] || 0} ${plural(counts[key] || 0, ['товар', 'товара', 'товаров'])}`;
    // Категория сайта, в которую попадают товары раздела (постоянная или своя); без неё раздел на сайте не виден.
    const siteOf = (id) => CATS.find((p) => p && p.key !== 'all' && !p.holiday && Array.isArray(p.source) && p.source.includes(id)) || null;
    panel.innerHTML = `<div class="ed-card">
        <h2>Основные категории на главной</h2>
        <p class="ed-hint">До ${O.HOME_MAX} категорий в этом порядке. Остальные покупатель видит по кнопке «Показать ещё». Товары при этом не меняются.</p>
        <ol class="ed-order" aria-label="Основные категории">${home.map((key, i) => `<li>
          <span class="ed-order__num" aria-hidden="true">${i + 1}</span>
          <span class="ed-order__name">${h(catTitle(key))}<small>${count(key)}</small></span>
          <span class="ed-order__tools">
            <button class="ed-btn ed-btn--icon" type="button" data-home="up" data-key="${h(key)}" aria-label="«${h(catTitle(key))}» выше" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="ed-btn ed-btn--icon" type="button" data-home="down" data-key="${h(key)}" aria-label="«${h(catTitle(key))}» ниже" ${i === home.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="ed-btn" type="button" data-home="remove" data-key="${h(key)}" aria-label="Убрать «${h(catTitle(key))}» в «Показать ещё»">В «Показать ещё»</button>
          </span></li>`).join('') || '<li>Основных категорий нет — все в «Показать ещё».</li>'}</ol>
        <h3>В «Показать ещё»</h3>
        <ul class="ed-order">${rest.map((c) => `<li>
          <span class="ed-order__name">${h(c.title)}<small>${count(c.key)}</small></span>
          <span class="ed-order__tools"><button class="ed-btn" type="button" data-home="add" data-key="${h(c.key)}" ${full ? 'disabled' : ''} aria-label="Сделать «${h(c.title)}» основной">В основные</button></span></li>`).join('') || '<li>Все категории основные.</li>'}</ul>
        ${full ? '<p class="ed-hint">Уже 6 основных: чтобы добавить другую, сначала уберите одну.</p>' : ''}
        <p><button class="ed-btn" type="button" data-home="reset">Вернуть по умолчанию</button></p>
      </div>
      <div class="ed-card">
        <h2>Разделы хранения</h2>
        <p class="ed-hint">Каждый товар хранится в одном разделе и может показываться в нескольких категориях сайта. Категории выбираются в карточке товара. «Показать на сайте» создаёт категорию с названием раздела.</p>
        <ul class="ed-order">${local.categories.map((c) => renaming === c.id ? `<li><form class="ed-rename" data-rename-form="${h(c.id)}">
            <label class="ed-field"><span>Новое название раздела</span><input name="title" value="${h(c.title)}" maxlength="80" required></label>
            <button class="ed-btn ed-btn--main" type="submit">Готово</button> <button class="ed-btn" type="button" data-section="cancel">Отмена</button></form></li>`
          : `<li><span class="ed-order__name">${h(c.title)}<small>${(c.items || []).length} ${plural((c.items || []).length, ['товар', 'товара', 'товаров'])} · ${h(c.id)}</small><small>${siteOf(c.id) ? `На сайте: «${h(siteOf(c.id).title)}»` : 'На сайте не показывается'}</small></span>
            <span class="ed-order__tools"><button class="ed-btn" type="button" data-section="rename" data-id="${h(c.id)}" aria-label="Переименовать «${h(c.title)}»">Переименовать</button>
            ${siteOf(c.id) || !O.customKeyFor(c.id) ? '' : `<button class="ed-btn" type="button" data-section="publish" data-id="${h(c.id)}" aria-label="Показать раздел «${h(c.title)}» на сайте как категорию">Показать на сайте</button>`}
            ${(c.items || []).length ? '' : `<button class="ed-btn ed-btn--danger" type="button" data-section="delete" data-id="${h(c.id)}" aria-label="Удалить пустой раздел «${h(c.title)}»">Удалить</button>`}</span></li>`).join('')}</ul>
        <form class="ed-rename" data-section-new><label class="ed-field"><span>Новая категория</span><input name="title" maxlength="60" placeholder="например, День отца"></label>
          <label class="ed-check"><input type="checkbox" name="site" checked><span>Показывать на сайте (иначе — только раздел прайса)</span></label>
          <button class="ed-btn" type="submit">+ Добавить</button></form>
      </div>`;
    panel.insertAdjacentHTML('beforeend', categoryPhotosHtml() + productOrderHtml());
    for (const box of panel.querySelectorAll('[data-category-cover]')) {
      const key = box.dataset.categoryCover;
      showFramed(box.querySelector('img'), box, O.categoryPhoto(S.local, key), O.categoryPhotoFrame(S.local, key));
    }
    if (focusSel) (document.querySelector(focusSel) || panel.querySelector('button:not([disabled])'))?.focus();
    if (renaming) panel.querySelector('[data-rename-form] input')?.focus();
  }
  function plural(n, forms) { const a = n % 100, b = n % 10; return forms[a > 10 && a < 20 ? 2 : b === 1 ? 0 : b > 1 && b < 5 ? 1 : 2]; }
  function homeAction(act, key) {
    let keys = M.homeOf(S.local, CORE);
    const i = keys.indexOf(key);
    let next;
    try {
      if (act === 'up') keys = M.homeOps.up(keys, i);
      else if (act === 'down') keys = M.homeOps.down(keys, i);
      else if (act === 'remove') keys = M.homeOps.remove(keys, i);
      else if (act === 'add') keys = M.homeOps.add(keys, key);
      else if (act === 'reset') keys = O.DEFAULT_HOME.slice();
      next = M.setHome(S.local, keys, CORE).doc;
    } catch (e) { setStatus(e.message, 'error'); return; }
    if (!commit(next)) return;
    const pos = keys.indexOf(key);
    setStatus(act === 'reset' ? 'Вернули основные категории по умолчанию. Нажмите «Сохранить».' : pos >= 0 ? `«${catTitle(key)}» — на месте ${pos + 1}. Нажмите «Сохранить».` : `«${catTitle(key)}» — в «Показать ещё». Нажмите «Сохранить».`, 'ok');
    const focus = act === 'up' || act === 'down' ? `[data-home="${act}"][data-key="${CSS.escape(key)}"]:not([disabled]), [data-home][data-key="${CSS.escape(key)}"]`
      : act === 'reset' ? '[data-home="reset"]' : `[data-key="${CSS.escape(key)}"]`;
    renderCats(focus);
    updateBar();
  }
  function sectionEdit(fn, message, focusSel) {
    let next;
    try { next = fn(); } catch (err) { setStatus(err.message, 'error'); return false; }
    if (!commit(next)) return false;
    renderCats(focusSel); updateBar(); setStatus(message, 'ok');
    return true;
  }

  /* ----- праздники ----- */
  const STATUS_TEXT = { active: 'Показывается сейчас', upcoming: 'Запланирован', ended: 'Завершён',
    'no-timezone': 'Не показывается: часовой пояс компании не подтверждён', invalid: 'Ошибка в записи — не показывается' };
  function renderHolidays(focusSel) {
    const panel = $('#panel-holidays');
    const local = S.local;
    const list = M.holidaysOf(local);
    const keys = O.baseKeys(CORE);
    const today = companyTz ? O.localDate(Date.now(), companyTz) : '';
    const tz = companyTz
      ? `<div class="ed-tz"><b>Часовой пояс компании: ${h(COMPANY_TIME_ZONE_LABEL)}</b>. Сегодня по нему: ${h(dateText(today))}. Праздник показывается с начала даты «с» до конца даты «по» включительно.</div>`
      : `<div class="ed-tz is-missing"><b>Расписание праздников выключено.</b> Часовой пояс компании (${h(COMPANY_TIME_ZONE_LABEL)}) не подтверждён: вход не проверен или браузер не поддерживает этот пояс. Угадывать пояс нельзя: иначе праздник появится или исчезнет не в тот день. Подготовить праздники можно; проверьте вход и откройте редактор снова.</div>`;
    panel.innerHTML = `<div class="ed-card"><h2>Праздничные подборки</h2>
        <p class="ed-hint">Временная подборка собирает товары выбранных категорий на время праздника. Товары и обычные категории не меняются и не удаляются; вне дат подборки на сайте нет.</p>
        ${tz}
        <ul class="ed-order">${list.map((hd, i) => {
          const st = O.holidayStatus(hd, Date.now(), companyTz, keys);
          const n = Array.isArray(hd && hd.include) ? M.holidayItemIds(local, hd.include, CATS).length : 0;
          const title = hd && (hd.title || hd.key);
          return `<li><span class="ed-order__name">${h(title)}${hd && hd.pinned ? ' <span class="ed-badge">закреплён</span>' : ''}
            <small>с ${h(dateText(hd && hd.start))} по ${h(dateText(hd && hd.end))} включительно · ${h((Array.isArray(hd && hd.include) ? hd.include : []).map(catTitle).join(', '))} · ${n} ${plural(n, ['товар', 'товара', 'товаров'])}</small>
            <small><b>${h(STATUS_TEXT[st] || st)}</b></small></span>
            <span class="ed-order__tools"><button class="ed-btn" type="button" data-holiday="edit" data-index="${i}" aria-label="Изменить праздник «${h(title)}»">Изменить</button>
            <button class="ed-btn ed-btn--danger" type="button" data-holiday="delete" data-index="${i}" aria-label="Удалить праздник «${h(title)}»">Удалить</button></span></li>`;
        }).join('') || '<li>Праздников пока нет.</li>'}</ul>
        ${holidayDraft ? '' : '<p><button class="ed-btn ed-btn--main ed-btn--big" type="button" data-holiday="new">+ Новый праздник</button></p>'}
      </div>
      ${holidayDraft ? holidayFormHtml() : ''}`;
    if (focusSel) (document.querySelector(focusSel) || panel.querySelector('button'))?.focus();
  }
  function holidayFormHtml() {
    const d = holidayDraft;
    return `<form class="ed-card" id="ed-holiday-form" novalidate aria-labelledby="ed-holiday-heading">
      <h2 id="ed-holiday-heading" tabindex="-1">${holidayOrig ? 'Изменить праздник' : 'Новый праздник'}</h2>
      <label class="ed-field"><span>Название <b class="ed-req">обязательно</b></span><input data-hd="title" value="${h(d.title)}" maxlength="60" required placeholder="например, 8 Марта"></label>
      <div class="ed-dates">
        <label class="ed-field"><span>Показывать с</span><input type="date" data-hd="start" value="${h(d.start)}" required></label>
        <label class="ed-field"><span>по (включительно)</span><input type="date" data-hd="end" value="${h(d.end)}" required></label>
      </div>
      <p class="ed-hint">Даты — по часовому поясу компании${companyTz ? ` (${h(COMPANY_TIME_ZONE_LABEL)})` : ' (пока не подтверждён)'}, не по часам этого компьютера.</p>
      <fieldset class="ed-card"><legend>Какие категории входят</legend>
        <div class="ed-checks">${CORE.map((c) => `<label class="ed-check"><input type="checkbox" data-hd-include="${h(c.key)}" ${d.include.includes(c.key) ? 'checked' : ''}><span>${h(c.title)}</span></label>`).join('')}</div>
        <p class="ed-hint">Товар из нескольких выбранных категорий показывается в подборке один раз.</p>
      </fieldset>
      <label class="ed-check"><input type="checkbox" data-hd="pinned" ${d.pinned ? 'checked' : ''}><span>Закрепить первым на главной и в каталоге на время праздника</span></label>
      ${holidayOrig ? `<p class="ed-hint">Адрес подборки: /catalog?cat=${h(holidayOrig.key)}</p>` : ''}
      <div class="ed-errors" id="ed-holiday-errors" role="alert"></div>
      <div class="ed-form-actions"><button class="ed-btn ed-btn--main ed-btn--big" type="submit">Готово</button>
        <button class="ed-btn ed-btn--big" type="button" data-holiday="cancel">Отмена</button></div>
    </form>`;
  }
  function openHoliday(index) {
    if ((draft || holidayDraft) && !guardForms()) return;
    const list = M.holidaysOf(S.local);
    holidayOrig = index === null ? null : list[index] || null;
    const src = holidayOrig || {};
    holidayDraft = { title: String(src.title || ''), start: String(src.start || ''), end: String(src.end || ''),
      include: Array.isArray(src.include) ? src.include.filter((k) => typeof k === 'string') : [], pinned: src.pinned === true };
    holidaySnap = JSON.stringify(holidayDraft);
    renderHolidays();
    $('#ed-holiday-heading')?.focus();
  }
  function applyHoliday() {
    const d = holidayDraft;
    const showErrors = (list) => { $('#ed-holiday-errors').innerHTML = `<p>Не применено:</p><ul>${list.map((e) => `<li>${h(e)}</li>`).join('')}</ul>`; };
    const taken = new Set(M.holidaysOf(S.local).map((x) => x && x.key));
    const key = holidayOrig ? holidayOrig.key : M.holidayKey(d.title, taken);
    let res;
    try { res = M.upsertHoliday(S.local, { key, title: d.title, start: d.start, end: d.end, include: d.include, pinned: d.pinned }, holidayOrig ? holidayOrig.key : null, CORE); }
    catch (e) { showErrors([e.message]); return; }
    if (res.errors.length) { showErrors(res.errors); return; }
    if (!commit(res.doc)) { showErrors([S.blockReason('edit') || 'Изменение не применено']); return; }
    holidayDraft = null; holidayOrig = null;
    renderHolidays('[data-holiday="new"]'); updateBar();
    setStatus('Праздник применён в редакторе. Нажмите «Сохранить».' + (companyTz ? '' : ' На сайте он не появится, пока не указан часовой пояс компании.'), 'ok');
  }

  /* ---------- сохранение ---------- */
  function hideAlert() { alertEl.hidden = true; alertEl.innerHTML = ''; alertEl.className = 'ed-alert'; }
  function showAlert(kind, html) { alertEl.className = 'ed-alert' + (kind ? ' is-' + kind : ''); alertEl.innerHTML = html; alertEl.hidden = false; updateBar(); }
  function showProblems(title, list) {
    showAlert('error', `<p><b>${h(title)}</b></p><ul>${list.slice(0, 30).map((p) => `<li>${h(p)}</li>`).join('')}</ul>
      <div class="ed-alert__actions"><button class="ed-btn" type="button" data-alert="close">Понятно</button></div>`);
  }
  async function save() {
    if (categoryUploads.size) { setStatus('Дождитесь загрузки фотографии категории.', 'error'); return; }
    if (!S || !S.local) return;
    if (draft || holidayDraft) { setStatus('Сначала нажмите «Готово» или «Отмена» в открытой форме.', 'error'); return; }
    const block = S.blockReason('save');
    if (block) { setStatus(block, 'error'); return; }
    if (S.cas === true && S.dirty()) setStatus('Проверяю свежую версию и сохраняю…');
    showSaveResult(await S.save());
  }
  /* Отрисовка результата операции координатора (сохранение, повтор, проверка). */
  function showSaveResult(r) {
    const msg = (e) => (e && e.message) || 'неизвестная ошибка';
    switch (r.status) {
      case 'locked': setStatus(r.reason, 'error'); break;
      case 'nothing': setStatus('Изменений нет — сохранять нечего.', 'ok'); break;
      case 'cas-unknown': setStatus(r.reason, 'error'); break;
      case 'invalid': showProblems('Прайс не сохранён: исправьте ошибки', r.problems); setStatus('Не сохранено: есть ошибки.', 'error'); break;
      case 'error': setStatus('Не сохранено: ' + msg(r.error) + (r.error && r.error.status === 401 ? '' : ' Правки остаются в редакторе.'), 'error'); break;
      case 'auth': setStatus('Не сохранено: ' + msg(r.error), 'error'); break;
      case 'rejected': showProblems('Сервер не принял прайс: ' + msg(r.error), r.error && r.error.details && r.error.details.length ? r.error.details : [msg(r.error)]); setStatus('Не сохранено.', 'error'); break;
      case 'conflict': showConflict(); break;
      case 'not-saved':
        showAlert('error', `<p><b>Прайс НЕ сохранён</b>: проверка показала прежнюю версию ${h(r.version)}. Ваши правки остаются в этом окне.</p>
          <div class="ed-alert__actions"><button class="ed-btn ed-btn--main" type="button" data-alert="retry">Сохранить ещё раз</button>
          <button class="ed-btn" type="button" data-alert="drop-pending">Пока не сохранять</button></div>`);
        setStatus('Не сохранено. Можно повторить.', 'error');
        break;
      case 'unknown':
        showAlert('error', `<p><b>Связь прервалась — неизвестно, сохранился ли прайс.</b> Ваши правки остаются в этом окне. Повторять сохранение вслепую нельзя: можно создать лишнюю версию или затереть чужие правки.</p>
          <div class="ed-alert__actions"><button class="ed-btn ed-btn--main" type="button" data-alert="verify">Проверить результат</button>
          <button class="ed-btn" type="button" data-alert="export">Скачать мои правки (файл)</button></div>`);
        setStatus('Исход сохранения неизвестен — нажмите «Проверить результат».', 'error');
        break;
      case 'saved': {
        const t = r.updatedAt ? new Date(r.updatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
        hideAlert();
        setStatus(`Сохранено ${t} · версия ${r.version}. ` + (r.verified ? 'Проверено повторным чтением.' : 'Повторное чтение не удалось — обновите страницу позже для проверки.')
          + (r.casConfirmed === false ? ' Сервер не подтвердил проверку версии — следующие сохранения заблокированы до обновления сервера.' : ''), 'ok');
        break;
      }
      case 'saved-mismatch':
        showAlert('', `<p><b>Сохранено (версия ${h(r.version)}), но повторное чтение отличается.</b> Возможно, сразу после вас прайс сохранил кто-то ещё (сейчас версия ${h(r.latestVersion)}). Загрузите свежую версию перед новыми правками.</p>
          <div class="ed-alert__actions"><button class="ed-btn ed-btn--main" type="button" data-alert="reload">Загрузить свежую версию</button></div>`);
        setStatus(`Сохранено · версия ${r.version}; на сервере уже версия ${r.latestVersion}.`, 'error');
        break;
      default: setStatus('Неожиданный результат сохранения — правки остаются в окне.', 'error');
    }
    render();
  }
  function showConflict() {
    const c = S.conflict;
    if (!c) return;
    if (!c.latest) {
      showAlert('error', `<p><b>Прайс изменён в другом месте, свежую версию прочитать не удалось.</b> Ваши правки остаются в этом окне, ничего не затёрто.</p>
        <div class="ed-alert__actions"><button class="ed-btn ed-btn--main" type="button" data-alert="conflict-retry">Прочитать ещё раз</button>
        <button class="ed-btn" type="button" data-alert="export">Скачать мои правки (файл)</button></div>`);
    } else {
      const head = `<p><b>Прайс уже изменён в другом окне или другим человеком</b> (на сервере версия ${h(c.latest.version)}, ваши правки сделаны по версии ${h(S.base.version)}). Ничего не сохранено и не затёрто; ваши правки остаются в этом окне.</p>`;
      const actions = c.rebased
        ? `<p>Ваши правки не пересекаются с чужими — их можно перенести на свежую версию и проверить перед сохранением.</p>
           <div class="ed-alert__actions"><button class="ed-btn ed-btn--main" type="button" data-alert="rebase">Перенести мои правки на версию ${h(c.latest.version)}</button>
           <button class="ed-btn" type="button" data-alert="export">Скачать мои правки (файл)</button></div>`
        : `<p>Те же товары изменены и там, и здесь:</p><ul>${c.conflicts.slice(0, 15).map((x) => `<li>${h(x)}</li>`).join('')}</ul>
           <div class="ed-alert__actions"><button class="ed-btn" type="button" data-alert="export">Скачать мои правки (файл)</button>
           <button class="ed-btn ed-btn--danger" type="button" data-alert="discard">Загрузить версию ${h(c.latest.version)} без моих правок</button></div>`;
      showAlert('error', head + actions);
    }
    setStatus('Не сохранено: конфликт версий.', 'error');
  }
  function exportLocal() {
    if (!S.local) return;
    const blob = new Blob([JSON.stringify(S.local, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `palitra-price-moi-pravki-v${S.base ? S.base.version : 'x'}.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function closeForms() { draft = null; holidayDraft = null; holidayOrig = null; renaming = null; if (view === 'item') view = 'items'; }
  async function alertAction(act) {
    if (act === 'close') { hideAlert(); return; }
    if (act === 'export') { exportLocal(); return; }
    const block = alertBlock(act);
    if (block) { setStatus(block, 'error'); return; }
    if (act === 'verify') { showAlert('', '<p><b>Проверяю, сохранился ли прайс…</b></p>'); showSaveResult(await S.verify()); return; }
    if (act === 'retry') { hideAlert(); setStatus('Сохраняю ещё раз…'); showSaveResult(await S.retry()); return; }
    if (act === 'drop-pending') {
      const r = S.dropPending();
      if (r.ok) { hideAlert(); setStatus('Правки остаются в редакторе, не сохранены.'); } else setStatus(r.reason, 'error');
      render();
      return;
    }
    if (act === 'reload') {
      if (!S.dirty() || confirm('Несохранённые правки будут потеряны. Загрузить свежую версию?')) {
        try { const r = await loadData('reload'); if (r.status === 'loaded') setStatus(`Загружена версия ${r.version}.`, 'ok'); } catch (e) { setStatus(e.message, 'error'); }
      }
      return;
    }
    if (act === 'conflict-retry') {
      const r = await S.conflictRetry();
      if (r.status === 'conflict') showConflict(); else setStatus(r.reason || (r.error && r.error.message) || 'Не удалось прочитать свежую версию', 'error');
      return;
    }
    if (act === 'rebase') {
      // Открытая форма построена по старой версии — её значения могли бы перезаписать чужую правку.
      if (draft || holidayDraft) { setStatus('Сначала нажмите «Готово» или «Отмена» в открытой форме, затем перенесите правки.', 'error'); return; }
      const r = S.rebase();
      if (!r.ok) { if (S.conflict) showConflict(); else setStatus(r.reason, 'error'); return; }
      hideAlert(); render();
      setStatus(`Правки перенесены на версию ${r.version}. Проверьте и нажмите «Сохранить».`, 'ok');
      return;
    }
    if (act === 'discard') {
      if (!confirm('Ваши несохранённые правки будут удалены из этого окна. Сначала можно скачать их файлом. Продолжить?')) return;
      const r = S.discard();
      if (!r.ok) { setStatus(r.reason, 'error'); return; }
      closeForms(); hideAlert(); render();
      setStatus(`Загружена версия ${r.version}.`, 'ok');
    }
  }

  /* ---------- история ---------- */
  let modalReturn = null;
  function openModal(html) {
    modalReturn = document.activeElement;
    $('#ed-modal-box').innerHTML = html;
    $('#ed-modal').classList.add('is-open');
    ($('#ed-modal-box [data-close]') || $('#ed-modal-box button'))?.focus();
  }
  function closeModal() {
    $('#ed-modal').classList.remove('is-open');
    if (modalReturn && typeof modalReturn.focus === 'function') modalReturn.focus();
  }
  async function showHistory() {
    if (S.busy) { setStatus(S.blockReason('restore'), 'error'); return; }
    openModal('<h3 id="ed-modal-title">История версий</h3><p class="ed-status">Загружаю…</p><button class="ed-btn" type="button" data-close="1">Закрыть</button>');
    try {
      const hist = await request('GET', API + '/history');
      const li = (Array.isArray(hist && hist.versions) ? hist.versions : []).map((v) => `<li><span>версия ${h(v.version)} · ${h(new Date(v.created_at).toLocaleString('ru-RU'))} · ${h(v.author || '')}</span>
        <button class="ed-btn" type="button" data-restore="${h(v.version)}">Вернуть</button></li>`).join('');
      const block = S.dirty() ? 'Есть несохранённые правки: вернуть старую версию можно после «Сохранить» или «Отменить все правки».' : S.blockReason('restore');
      $('#ed-modal-box').innerHTML = `<h3 id="ed-modal-title">История версий</h3>
        ${block ? `<p class="ed-status is-error">${h(block)}</p>` : ''}
        <ul class="ed-modal__list">${li || '<li>пусто</li>'}</ul>
        <button class="ed-btn" type="button" data-close="1">Закрыть</button>`;
      updateBar();
      $('#ed-modal-box [data-close]')?.focus();
    } catch (e) {
      $('#ed-modal-box').innerHTML = `<h3 id="ed-modal-title">История версий</h3><p class="ed-status is-error">${h(e.message)}</p><button class="ed-btn" type="button" data-close="1">Закрыть</button>`;
    }
  }
  async function restore(version) {
    if (draft || holidayDraft || S.dirty()) { setStatus('Сначала сохраните или отмените правки, затем возвращайте версию.', 'error'); return; }
    const block = S.blockReason('restore');
    if (block) { setStatus(block, 'error'); return; }
    if (!confirm(`Вернуть версию ${version}? Текущее состояние станет новой версией истории.`)) return;
    const r = await S.restore(version);
    if (r.status === 'restored') { closeModal(); closeForms(); hideAlert(); render(); setStatus(`Возвращена версия ${version}`, 'ok'); }
    else if (r.status === 'restored-unloaded') { closeModal(); setStatus('Версия возвращена, но прочитать прайс не удалось — обновите страницу.', 'error'); }
    else setStatus('Откат не выполнен: ' + (r.reason || (r.error && r.error.message) || 'ошибка'), 'error');
  }

  /* ---------- события ---------- */
  // «Загрузить товары» обрабатывает модуль импорта; во время другой операции клик останавливается здесь (фаза захвата).
  document.addEventListener('click', (e) => {
    if (!S || !e.target.closest || !e.target.closest('#ed-import')) return;
    const block = S.blockReason('import');
    if (block) { e.preventDefault(); e.stopImmediatePropagation(); setStatus(block, 'error'); }
  }, true);
  document.addEventListener('click', (e) => {
    if (!S) return;
    if (S.busy === 'import' && !e.target.closest('#ed-import-modal')) return;
    const t = e.target.closest('button, a');
    if (!t) return;
    if (t.dataset.alert) { alertAction(t.dataset.alert); return; }
    if (t.dataset.edit) { openItem(t.dataset.edit); return; }
    if (t.id === 'ed-add-item') { openNewItem(); return; }
    if (t.id === 'ed-list-more') { listLimit += LIST_STEP; drawList(); return; }
    if (t.dataset.formAct === 'back' || t.dataset.formAct === 'cancel') { const id = draft && draft.id; if (guardForms()) closeItem(id); return; }
    if (t.dataset.formAct === 'delete') { deleteCurrent(); return; }
    if (t.dataset.photoAct) { photoAction(t.dataset.photoAct, Number(t.dataset.index)); return; }
    if (t.dataset.categoryPhotoFrame) { openFramer(0, t.dataset.categoryPhotoFrame); return; }
    if (t.dataset.categoryPhotoReset) {
      categoryUploads.delete(t.dataset.categoryPhotoReset);
      sectionEdit(() => M.setCategoryPhoto(S.local, t.dataset.categoryPhotoReset, '', CORE).doc,
        'Вернули стандартное фото в редакторе. Нажмите «Сохранить».'); return;
    }
    if (t.dataset.productOrder) { productOrderAction(t.dataset.id, null, t.dataset.productOrder === 'up' ? -1 : 1); return; }
    if (t.dataset.home) { homeAction(t.dataset.home, t.dataset.key); return; }
    if (t.dataset.section === 'rename') { renaming = t.dataset.id; renderCats(); return; }
    if (t.dataset.section === 'cancel') { const id = renaming; renaming = null; renderCats(`[data-section="rename"][data-id="${CSS.escape(id)}"]`); return; }
    if (t.dataset.section === 'delete') { sectionEdit(() => M.deleteSection(S.local, t.dataset.id).doc, 'Пустой раздел удалён в редакторе. Нажмите «Сохранить».'); return; }
    if (t.dataset.section === 'publish') {
      const id = t.dataset.id;
      sectionEdit(() => M.publishSection(S.local, id).doc, 'Раздел показан на сайте как категория (в редакторе). Товары с ручным выбором поводов отметьте в их карточках, затем нажмите «Сохранить».', `[data-section="rename"][data-id="${CSS.escape(id)}"]`);
      return;
    }
    if (t.dataset.holiday === 'new') { openHoliday(null); return; }
    if (t.dataset.holiday === 'edit') { openHoliday(Number(t.dataset.index)); return; }
    if (t.dataset.holiday === 'cancel') { if (JSON.stringify(holidayDraft) === holidaySnap || confirm('Закрыть форму праздника без применения?')) { holidayDraft = null; holidayOrig = null; renderHolidays('[data-holiday="new"]'); } return; }
    if (t.dataset.holiday === 'delete') {
      const hd = M.holidaysOf(S.local)[Number(t.dataset.index)];
      if (hd && confirm(`Удалить праздник «${hd.title || hd.key}»? Товары и категории останутся.`) && commit(M.removeHoliday(S.local, hd.key).doc)) {
        renderHolidays('[data-holiday="new"]'); updateBar(); setStatus('Праздник удалён в редакторе. Нажмите «Сохранить».', 'ok');
      }
      return;
    }
    if (t.dataset.restore) { restore(t.dataset.restore); return; }
    if (t.dataset.close) { closeModal(); return; }
    if (t.id === 'ed-save') { save(); return; }
    if (t.id === 'ed-history') { showHistory(); return; }
    if (t.id === 'ed-session-retry') { resumeSession(); return; }
    if (t.id === 'ed-reset') {
      const block = S.blockReason('reset');
      if (block) { setStatus(block, 'error'); return; }
      if ((draft || holidayDraft) && !guardForms()) return;
      if (confirm('Отменить все несохранённые правки в этом окне?')) {
        const r = S.reset();
        if (!r.ok) { setStatus(r.reason, 'error'); return; }
        closeForms(); render(); setStatus('Правки отменены.', 'ok');
      }
      return;
    }
    const tab = TABS.find((x) => x[1] === t.id);
    if (tab) showTab(tab[0]);
  });
  document.addEventListener('submit', (e) => {
    const form = e.target;
    e.preventDefault();
    if (!S) return;
    if (form.id === 'ed-item-form') applyItem();
    else if (form.id === 'ed-holiday-form') applyHoliday();
    else if (form.dataset.renameForm) {
      const id = form.dataset.renameForm;
      const title = form.elements.title.value;
      renaming = null;
      if (!sectionEdit(() => M.renameSection(S.local, id, title).doc, 'Раздел переименован в редакторе. Нажмите «Сохранить».', `[data-section="rename"][data-id="${CSS.escape(id)}"]`)) { renaming = id; renderCats(); }
    } else if (form.hasAttribute('data-section-new')) {
      const title = form.elements.title.value;
      // Новая категория: раздел прайса и категория сайта вместе (по отметке), одним изменением черновика.
      const site = Boolean(form.elements.site && form.elements.site.checked);
      sectionEdit(() => (site ? M.addCategory(S.local, title) : M.addSection(S.local, title)).doc,
        site ? 'Категория добавлена в редакторе: раздел прайса и категория на сайте. Отметьте её в карточках товаров и нажмите «Сохранить».'
          : 'Раздел добавлен в редакторе. Нажмите «Сохранить».');
    }
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'ed-search') { listQuery = t.value; listLimit = LIST_STEP; drawList(); return; }
    if (draft && t.dataset.draft) { draft[t.dataset.draft] = t.value; return; }
    if (holidayDraft && t.dataset.hd && t.type !== 'checkbox') { holidayDraft[t.dataset.hd] = t.value; }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.hasAttribute('data-category-photo') && t.files && t.files[0]) { const file = t.files[0], key = t.dataset.categoryPhoto; t.value = ''; uploadCategoryPhoto(key, file); return; }
    if (t.id === 'ed-product-order-scope') { orderScope = t.value; renderCats('#ed-product-order-scope'); return; }
    if (t.hasAttribute('data-product-position')) { productOrderAction(t.dataset.productPosition, Number(t.value), null); return; }
    if (t.id === 'ed-category-filter') {
      listCategory = t.value; listOwner = ''; listLimit = LIST_STEP;
      renderItems(); $('#ed-category-filter')?.focus(); return;
    }
    if (t.id === 'ed-owner-filter') { listOwner = t.value; listLimit = LIST_STEP; drawList(); return; }
    if (draft && t.hasAttribute('data-manual')) {
      draft.manualCategories = t.checked;
      if (t.checked && !draft.publicCategories.length) draft.publicCategories = O.basePublicKeys({}, draft.ownerId, CATS);
      $('#ed-occ').innerHTML = '<legend>Категории на сайте</legend>' + occasionsHtml();
      $('#ed-occ [data-manual]')?.focus();
      return;
    }
    if (draft && t.dataset.occ) {
      const set = new Set(draft.publicCategories);
      if (t.checked) set.add(t.dataset.occ); else set.delete(t.dataset.occ);
      draft.publicCategories = CATS.map((c) => c.key).filter((k) => set.has(k));
      return;
    }
    if (draft && t.hasAttribute('data-owner')) {
      draft.ownerId = t.value;
      const focus = document.activeElement;
      $('#ed-occ').innerHTML = '<legend>Категории на сайте</legend>' + occasionsHtml();
      focus?.focus();
      return;
    }
    if (draft && t.hasAttribute('data-photo-add') && t.files && t.files.length) { const files = [...t.files]; t.value = ''; addPhotos(files); return; }
    if (draft && t.dataset.photoReplace !== undefined && t.files && t.files[0]) { const f = t.files[0]; const i = Number(t.dataset.photoReplace); t.value = ''; addPhotos([f], i); return; }
    if (holidayDraft && t.dataset.hdInclude) {
      const set = new Set(holidayDraft.include);
      if (t.checked) set.add(t.dataset.hdInclude); else set.delete(t.dataset.hdInclude);
      holidayDraft.include = CORE.map((c) => c.key).filter((k) => set.has(k));
      return;
    }
    if (holidayDraft && t.dataset.hd === 'pinned') { holidayDraft.pinned = t.checked; return; }
    if (holidayDraft && t.dataset.hd) holidayDraft[t.dataset.hd] = t.value;
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'ы')) { e.preventDefault(); save(); return; }
    if (e.key === 'Escape' && $('#ed-modal').classList.contains('is-open')) { closeModal(); return; }
    const tab = e.target.closest && e.target.closest('[role="tab"]');
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const i = TABS.findIndex((x) => x[1] === tab.id);
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
      showTab(TABS[j][0], true);
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (S && (S.dirty() || draft || holidayDraft || S.pending || S.busy || categoryUploads.size)) { e.preventDefault(); e.returnValue = ''; }
  });

  if (S && window.PalitraCatalogImport) window.PalitraCatalogImport.attach({
    // Чтение прайса — только при подтверждённом CAS; фото и PUT — только внутри beginImport, PUT с If-Match.
    apiFetch: (url, opts) => S.importFetch(url, opts),
    getState: () => ({ session, data: S.local, dirty: S.dirty(), editing: draft || holidayDraft ? 'form' : S.blockReason('import') ? 'locked' : null }),
    setBusy(value) {
      if (value) {
        const r = S.beginImport();
        if (!r.ok) setStatus(r.reason, 'error'); // importFetch отклонит запись: импорт вне beginImport ничего не меняет
      } else S.endImport();
      updateBar();
    },
    async refresh() {
      const r = await S.load({ within: 'import' });
      if (r.status === 'loaded') { closeForms(); hideAlert(); render(); }
      else setStatus('Товары загружены, но обновить окно не удалось — обновите страницу.', 'error');
    },
    setStatus,
  });

  (async () => {
    if (!S) {
      setStatus('Не загрузились файлы редактора (palitra-editor-model.js, palitra-occasions.js, palitra-editor-session.js). Обновите страницу.', 'error');
      $('#panel-items').innerHTML = '<p class="ed-status is-error">Не удалось загрузить файлы редактора. Обновите страницу; если не помогло — сообщите администратору Synapse.</p>';
      return;
    }
    if (casNote) $('#ed-cas-note-text').textContent = Sess.CAS_MISSING;
    try {
      await loadSession(); await loadData();
      if (S.cas === true) setStatus('Готово к работе');
      else setStatus('Прайс открыт только для просмотра и подготовки правок: сохранение недоступно, пока сервер не подтвердит проверку версии.', 'error');
    } catch (e) {
      setStatus(e.message, 'error');
      $('#ed-session-retry').hidden = false;
      $('#panel-items').innerHTML = `<p class="ed-status is-error">${h(e.message)}</p><p><a href="/cabinet.html" target="_blank" rel="noopener">Войти в кабинет</a>, затем нажмите «Проверить вход».</p>`;
    }
    updateBar();
  })();
})();

/* Reviewed application explanations; isolated per document, no requests or editor state changes. */
(()=>{if(window.PalitraHelp)return;
function h(tag,props,...kids){const node=document.createElement(tag);for(const [k,v]of Object.entries(props||{})){if(v===null||v===undefined||v===false)continue;if(k==='class')node.className=v;else if(k==='text')node.textContent=String(v);else if(k==='dataset')Object.assign(node.dataset,v);else if(k.startsWith('on')&&typeof v==='function')node.addEventListener(k.slice(2),v);else node.setAttribute(k,v===true?'':String(v));}for(const child of kids.flat(Infinity)){if(child!==null&&child!==undefined&&child!==false)node.append(typeof child==='object'?child:String(child));}return node;}
  // PALITRA_APP_HELP_BEGIN: only reviewed, static explanations; never data, errors or consent.
  const appHelpTexts = new Set([
    'Фото работ ведутся штатным редактором фото сайта; здесь они не копируются.',
    'Продолжим в чате. Контакт пригодится, если не сможем связаться здесь.',
    'Нажатие не отмечает, что связь состоялась или клиент ответил.',
    'Palitra Love · данные существующей CRM за выбранный период по московскому времени. Заявки сайта и этапы доставки ведутся в разделе «Заказы».',
    'Каталог и цены — на сайте магазина; копий товаров и фото здесь нет.',
    'Права, CSRF и сохранение — внутри штатного редактора.',
    'Статус обработки отделён от доставки уведомления.',
    'Можно несколько слов: «выписка мальчик». Цена — цифрами: 9270.',
    '(можно несколько; товар останется одним, без копий)',
    'Так товар называется на сайте, в корзине и в заявке.',
    '7720 → «7 720 руб.»; копейки через запятую. Пусто — «Цена уточняется». Текст («от 5000») сохранится как есть, но корзина его не посчитает.',
    'Показывается покупателю в карточке товара.',
    'Что входит в набор. Можно по строкам.',
    'Необязательно. Служебная строка «Цена из публикации…» на сайте не показывается.',
    'Перетащите фото мышью или пальцем. С клавиатуры: стрелки — сдвиг (с Shift — крупнее), «+» и «−» — масштаб, Home — по центру. Сам файл фото не меняется.',
    'Каждый товар хранится в одном разделе и может показываться в нескольких категориях сайта. Категории выбираются в карточке товара. «Показать на сайте» создаёт категорию с названием раздела.',
    'Временная подборка собирает товары выбранных категорий на время праздника. Товары и обычные категории не меняются и не удаляются; вне дат подборки на сайте нет.',
    'Товар из нескольких выбранных категорий показывается в подборке один раз.',
    'Для сцены нужны три кадра: для компьютера (горизонтальный, на сайте 16:9), для планшета (горизонтальный, 4:3) и для телефона (вертикальный). Тексты, кнопки и смена сцен не меняются.',
    'При замене фото у этой карточки отключается прежний ролик, чтобы не показывать чужой набор. Новое фото плавно движется, как у карточки «День рождения мужчины». Остальные карточки не меняются.',
    'Меняется только фото и его подпись. Ссылки, суммы и надписи остаются прежними.',
    'Первые 4 фото видны сразу, остальные открываются кнопкой «Показать ещё» (если фото 4 или меньше, кнопки нет). В галерее остаётся хотя бы одно фото. Фото, убранное из показа, остаётся в хранилище материалов, и его можно вернуть.',
    'Порядок категорий на главной задаётся в редакторе прайса',
    'Внутренний раздел для хранения товара. Показ в каталоге задают категории выше.',
    'По одному пункту в строке. Сайт это поле сейчас не показывает.',
    'Можно продолжить переписку в Telegram — она останется и здесь.',
    '«На сайте» ставится только после проверки работающей страницы: нужны ссылка и дата. Статус работы «Отменено» оставляет задачу видимой, но исправлением она не считается — даже если раньше была опубликована.',
    'Ожидается объект с полями schemaVersion, asOf и tasks. Уже существующие задачи обновляются по их идентификатору реестра, копии не создаются.',
    'В режиме «По обращению» начните сообщение с «Хью». В режиме замены Хью участвует в обсуждении проекта.',
    'У одного собственника может быть несколько сайтов в одной переписке. Метка сайта у задачи принимается только из этого списка.'
  ]);
  const appHelp = (()=>{
    let opened=null,sequence=0,scanQueued=false;
    function close(restore=false) {
      if(!opened)return;const old=opened;opened=null;clearTimeout(old.timer);
      old.button.setAttribute('aria-expanded','false');old.pop.remove();
      window.removeEventListener('resize',old.position);window.removeEventListener('scroll',old.position,true);
      window.visualViewport?.removeEventListener('resize',old.position);window.visualViewport?.removeEventListener('scroll',old.position);
      if(restore && old.button.isConnected)old.button.focus({preventScroll:true});
    }
    function helpPosition(anchor,pop,viewport,composer) {
      const gap=8,left=viewport.left+gap,right=viewport.right-gap,top=viewport.top+gap;
      const bottom=Math.max(top+1,Math.min(viewport.bottom-gap,composer?.top>top?composer.top-gap:Infinity));
      const width=Math.max(1,Math.min(320,right-left)),height=Math.max(1,bottom-top);
      const x=Math.min(Math.max(left,anchor.left),Math.max(left,right-width));
      const below=anchor.bottom+gap,above=anchor.top-gap-pop.height;
      const y=below+pop.height<=bottom?below:above>=top?above:Math.min(Math.max(top,below),Math.max(top,bottom-Math.min(pop.height,height)));
      return {left:x,top:y,width,maxHeight:height};
    }
    function button(text,label='Пояснение') {
      const copy=text==='Права, CSRF и сохранение — внутри штатного редактора.'?'Доступ и сохранение изменений проверяются в редакторе.':text;
      const id='app-help-'+(++sequence),trigger=h('button',{type:'button',class:'app-help__trigger','aria-label':label,'aria-expanded':'false','aria-controls':id,text:'?'});
      trigger.addEventListener('click',event=>{
        if(opened?.button===trigger){close();return;}close();
        const pop=h('section',{id,class:'app-help__popover',role:'region','aria-label':label},h('p',{text:copy}),h('button',{type:'button',class:'app-help__close','aria-label':'Закрыть пояснение',text:'×',onclick:()=>close(pop.contains(document.activeElement))}));
        const position=()=>{
          if(!trigger.isConnected){close();return;}
          const v=window.visualViewport,l=v?.offsetLeft||0,t=v?.offsetTop||0;
          // Measure after setting the phone-safe width so wrapping cannot extend below the composer.
          pop.style.width=Math.max(1,Math.min(320,(v?.width||window.innerWidth)-16))+'px';
          const composer=document.querySelector('.chat__dock, .chat__compose, #pc-compose, .pc-compose-row, [data-pc-compose]')?.getBoundingClientRect();
          const r=helpPosition(trigger.getBoundingClientRect(),pop.getBoundingClientRect(),{left:l,top:t,right:l+(v?.width||window.innerWidth),bottom:t+(v?.height||window.innerHeight)},composer);
          Object.assign(pop.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',maxHeight:r.maxHeight+'px'});
        };
        (trigger.closest('dialog[open]') || document.body).append(pop);trigger.setAttribute('aria-expanded','true');
        opened={button:trigger,pop,position,timer:setTimeout(()=>close(pop.contains(document.activeElement)),6000)};
        position();window.addEventListener('resize',position);window.addEventListener('scroll',position,true);
        window.visualViewport?.addEventListener('resize',position);window.visualViewport?.addEventListener('scroll',position);
        if(event.detail===0)pop.querySelector('button').focus({preventScroll:true});
      });
      return h('span',{class:'app-help'},trigger);
    }
    function scan(root=document) {
      if(typeof activeCompany!=='undefined' && activeCompany!=='palitra-love')return;
      for(const node of root.querySelectorAll('p,small')) {
        const text=node.textContent.trim();
        const scheduleText='Сообщение уйдёт в чат проекта и в связанную Telegram-группу в указанное время. До отправки его можно изменить или отменить.';
        const staticTemplate=/^Основное и до \d+ дополнительных\. JPEG, PNG или WebP до 8 МБ; файл загружается как есть, без уменьшения\. «Настроить кадр» меняет только то, как фото стоит в рамке\.$/.test(text) || /^До \d+ категорий в этом порядке\. Остальные покупатель видит по кнопке «Показать ещё»\. Товары при этом не меняются\.$/.test(text);
        if(node.closest('.app-help, .app-help__popover, .chat__msg, .pc-messages, .pc-message-text, .pc-msg__text, .pc-scheduled-item, .pc-personas, #pc-contact, #pc-welcome, [role="log"], [role="alert"], [role="status"]') || node.querySelector('button,input,textarea,select,a') || (!appHelpTexts.has(text)&&!staticTemplate&&text!==scheduleText))continue;
        if(text===scheduleText) {
          node.textContent='Сообщение уйдёт в чат проекта и в связанную Telegram-группу в указанное время.';
          node.append(' ',button('До отправки его можно изменить или отменить.','О запланированном сообщении'));continue;
        }
        const label=node.closest('label'),fieldLabel=label?.querySelector('span')?.textContent.trim();
        const help=button(node.textContent.trim(),fieldLabel?'Пояснение к полю «'+fieldLabel+'»':'Пояснение');
        if(node.id==='pc-telegram-state') {
          // This existing paragraph is updated by the chat renderer. Keep its target identity alive.
          help.append(h('span',{class:'app-help__description',text}));node.replaceChildren(help);continue;
        }
        // Design text styles and layout anchor stay on this small help control.
        for(const [key,value]of Object.entries(node.dataset))help.dataset[key]=value;
        if(node.id)help.append(h('span',{id:node.id,class:'app-help__description',text}));
        node.replaceWith(help);
        if(label) {
          // Keep one form-grid item and the original label/control; never nest another button in a label.
          const group=h('div',{class:'app-help__field'});label.replaceWith(group);group.append(label,help);
        }
      }
      if(opened && !opened.button.isConnected)close();
    }
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&opened){event.preventDefault();close(opened.pop.contains(document.activeElement));}});
    document.addEventListener('pointerdown',event=>{if(opened&&!opened.pop.contains(event.target)&&!opened.button.contains(event.target))close();});
    const observer=new MutationObserver(()=>{if(!scanQueued){scanQueued=true;queueMicrotask(()=>{scanQueued=false;scan();});}});
    observer.observe(document.body,{childList:true,subtree:true});
    scan();
    return Object.freeze({button,scan,close,helpPosition});
  })();
  Object.defineProperty(window,'PalitraHelp',{value:appHelp,writable:false});
  // PALITRA_APP_HELP_END

})();
