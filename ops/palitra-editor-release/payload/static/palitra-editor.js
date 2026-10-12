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
  const MAX_UPLOAD = 8 * 1024 * 1024;
  const LIST_STEP = 60;
  const CATS = O ? O.DEFAULT_PUBLIC : [];
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
  let companyTz = null;     // подтверждённый сервером часовой пояс компании (или null)
  let view = 'items';
  let draft = null, draftSnap = '', draftNew = false;
  let holidayDraft = null, holidayOrig = null, holidaySnap = '';
  let renaming = null;
  let listQuery = '', listOwner = '', listLimit = LIST_STEP;

  const statusEl = $('#ed-status');
  const subEl = $('#ed-sub');
  const saveBtn = $('#ed-save');
  const alertEl = $('#ed-alert');
  const casNote = $('#ed-cas-note');
  const openPrice = $('#ed-open-price');
  if (openPrice) openPrice.href = SITE + '/price.html';

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
      // Пояс — только из настройки компании на сервере; часовой пояс браузера не используется.
      const tz = Array.isArray(profile.companies) ? (profile.companies.find((c) => c && c.id === COMPANY) || {}).timezone : null;
      companyTz = O.isValidTimeZone(tz) ? tz : null;
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

  const S = M && O && Sess ? Sess.createSession({ model: M, api: { request: requestFull }, categories: CATS, onChange: () => updateBar() }) : null;
  /* Изменение документа в окне — только через координатор: во время сохранения/проверки отклоняется. */
  function commit(next, opts) {
    const r = S.edit(next, opts);
    if (!r.ok) { setStatus(r.reason, 'error'); return false; }
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
          <label class="ed-field"><span>Раздел прайса</span><select id="ed-owner-filter"></select></label>
          <button class="ed-btn ed-btn--main ed-btn--big" id="ed-add-item" type="button">+ Добавить товар</button>
        </div>
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
    const search = $('#ed-search');
    if (search.value !== listQuery) search.value = listQuery;
    drawList();
  }
  function drawList() {
    const rows = M.searchItems(S.local, listQuery, { ownerId: listOwner || undefined, categories: CATS });
    const diff = S.base ? M.diffDocs(S.base, S.local) : { changed: [], added: [] };
    const changed = new Set(diff.changed.concat(diff.added));
    const total = M.itemCount(S.local);
    $('#ed-count').textContent = listQuery || listOwner ? `Найдено: ${rows.length} из ${total}` : `Всего товаров: ${total}`;
    $('#ed-list').innerHTML = rows.slice(0, listLimit).map((r) => `<li class="ed-row${changed.has(r.id) ? ' is-changed' : ''}">
      <div class="ed-thumb">${r.photo && imgUrl(r.photo) ? `<img src="${h(imgUrl(r.photo))}" alt="" loading="lazy" decoding="async">` : 'нет фото'}</div>
      <div class="ed-row__body">
        <p class="ed-row__title">${h(r.title || '(без названия)')}</p>
        <p class="ed-row__meta">${h(r.price || 'цена не указана')}${r.photos > 1 ? ` · фото: ${r.photos}` : ''}</p>
        <p class="ed-row__meta">Раздел: ${h(r.ownerTitle)} · № ${h(r.id)}</p>
        <p class="ed-row__meta">Поводы: ${r.publicKeys.length ? h(r.publicKeys.map(catTitle).join(', ')) : 'нет'}${r.explicit ? '' : ' <span class="ed-badge">по разделу</span>'}</p>
        ${changed.has(r.id) ? '<span class="ed-badge ed-badge--warn">изменён, не сохранён</span>' : ''}
      </div>
      <div class="ed-row__actions"><button class="ed-btn" type="button" data-edit="${h(r.id)}" aria-label="Изменить: ${h(r.title || r.id)}">Изменить</button></div>
    </li>`).join('') || '<li class="ed-status">Ничего не найдено. Измените запрос или раздел.</li>';
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
      itemsText: '', photos: [], photosTouched: false, manualCategories: true, publicCategories: [] };
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
        <span>Выбрать поводы вручную <small class="ed-hint">(можно несколько; товар останется одним, без копий)</small></span></label>
      <p class="ed-hint" id="ed-occ-legacy">${draft.manualCategories ? 'Отметьте поводы, в которых показывать товар.'
        : `Сейчас как раньше — по разделу прайса «${h(owner ? owner.title : draft.ownerId)}»: ${legacy.length ? h(legacy.map(catTitle).join(', ')) : 'ни в одном поводе'}.`}</p>
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
          <fieldset class="ed-card" id="ed-occ"><legend>Поводы на сайте</legend>${occasionsHtml()}</fieldset>
          <details class="ed-details ed-card"><summary>Дополнительно</summary>
            <label class="ed-field"><span>Раздел прайса</span><select data-owner>${sameKind.map((c) => `<option value="${h(c.id)}" ${c.id === draft.ownerId ? 'selected' : ''}>${h(c.title)}</option>`).join('')}</select>
              <small>Внутренний раздел (старые адреса /catalog/…). Поводы на сайте выбираются выше.</small></label>
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
      <figure class="ed-mainphoto"><div class="ed-mainphoto__frame">${main ? `<img src="${h(main)}" alt="${h('Основное фото: ' + title)}">` : '<span class="ed-hint">Фото нет — на сайте будет заглушка с логотипом</span>'}</div>
        <figcaption>Основное фото показывается целиком, без обрезки.</figcaption></figure>
      <ol class="ed-photos">${list.map((p, i) => `<li class="ed-photo${i === 0 ? ' is-cover' : ''}">
        <div class="ed-thumb">${imgUrl(p) ? `<img src="${h(imgUrl(p))}" alt="" loading="lazy">` : 'адрес скрыт'}</div>
        <span class="ed-photo__label">${i === 0 ? 'Основное' : `Фото ${i + 1}`}</span>
        <div class="ed-photo__tools">
          ${i > 0 ? `<button class="ed-btn" type="button" data-photo-act="cover" data-index="${i}" aria-label="Сделать фото ${i + 1} основным">Основное</button>` : ''}
          ${i > 0 ? `<button class="ed-btn ed-btn--icon" type="button" data-photo-act="left" data-index="${i}" aria-label="Фото ${i + 1}: раньше" ${i <= 1 ? 'disabled' : ''}>←</button>
          <button class="ed-btn ed-btn--icon" type="button" data-photo-act="right" data-index="${i}" aria-label="Фото ${i + 1}: позже" ${i >= list.length - 1 ? 'disabled' : ''}>→</button>` : ''}
          <label class="ed-btn ed-btn--file">Заменить<input type="file" accept="image/jpeg,image/png,image/webp" data-photo-replace="${i}" aria-label="Заменить ${i === 0 ? 'основное фото' : `фото ${i + 1}`}"></label>
          <button class="ed-btn ed-btn--danger" type="button" data-photo-act="remove" data-index="${i}" aria-label="Удалить ${i === 0 ? 'основное фото' : `фото ${i + 1}`}">Удалить</button>
        </div></li>`).join('')}</ol>
      <label class="ed-btn ed-btn--file${list.length >= M.MAX_PHOTOS ? ' is-full' : ''}" ${list.length >= M.MAX_PHOTOS ? 'aria-disabled="true"' : ''}>+ Добавить фото<input type="file" accept="image/jpeg,image/png,image/webp" multiple data-photo-add ${list.length >= M.MAX_PHOTOS ? 'disabled' : ''}></label>
      <p class="ed-hint">Основное и до ${M.MAX_GALLERY} дополнительных. JPEG, PNG или WebP; большие снимки уменьшаются до 1600 px без обрезки.</p>
      <p class="ed-status" id="ed-photo-status" role="status" aria-live="polite"></p>`;
  }
  function photoStatus(text, bad) {
    const el = $('#ed-photo-status');
    if (el) { el.textContent = text; el.className = 'ed-status' + (bad ? ' is-error' : ''); }
  }
  function photoAction(act, index) {
    if (!draft) return;
    const ops = { cover: () => M.photoOps.makeCover(draft.photos, index), left: () => M.photoOps.move(draft.photos, index, -1),
      right: () => M.photoOps.move(draft.photos, index, 1), remove: () => M.photoOps.remove(draft.photos, index) };
    if (!ops[act]) return;
    draft.photos = ops[act]();
    draft.photosTouched = true;
    renderPhotos();
    const focusIndex = act === 'left' ? index - 1 : act === 'right' ? index + 1 : act === 'cover' ? index : Math.min(index, draft.photos.length - 1);
    const next = document.querySelector(`#ed-photos-box [data-index="${focusIndex}"][data-photo-act="${act}"]`) || document.querySelector('#ed-photos-box [data-photo-add]');
    next?.focus();
    photoStatus(act === 'remove' ? 'Фото убрано из формы. Нажмите «Готово», затем «Сохранить».' : 'Порядок изменён. Нажмите «Готово», затем «Сохранить».');
  }
  /* Уменьшение до 1600 px по длинной стороне (без увеличения, без обрезки и дорисовки). */
  function shrinkImage(file) {
    return new Promise((resolve) => {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return resolve(null);
      const img = new Image(); const src = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(src);
        const max = 1600, k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        if (k === 1 && file.size < 1.5 * 1024 * 1024) return resolve(file);
        const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        c.toBlob((b) => resolve(b ? new File([b], file.name.replace(/\.[^.]+$/, '') + (type === 'image/png' ? '.png' : '.jpg'), { type }) : file), type, 0.86);
      };
      img.onerror = () => { URL.revokeObjectURL(src); resolve(file); };
      img.src = src;
    });
  }
  async function uploadImage(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error(`«${file.name}»: нужен JPEG, PNG или WebP`);
    const prepared = await shrinkImage(file) || file;
    if (prepared.size > MAX_UPLOAD) throw new Error(`«${file.name}»: больше 8 МБ даже после уменьшения`);
    const j = await request('POST', ASSETS, { raw: prepared, headers: { 'Content-Type': prepared.type, 'X-Filename': encodeURIComponent(prepared.name) } });
    if (!M.isUploadedAsset(j && j.url)) throw new Error('Сервер не подтвердил адрес загруженного фото');
    return j.url;
  }
  /* Результат загрузки попадает только в черновик той же открытой формы и того же поколения документа.
     Форма закрыта/отменена, правки сброшены или прайс перезагружен — поздний ответ ничего не меняет. */
  async function addPhotos(files, replaceIndex) {
    const target = draft;
    if (!target) return;
    const ticket = S.ticket();
    const current = () => draft === target && S.isCurrent(ticket);
    let added = 0;
    for (const file of files) {
      if (!current()) return;
      if (replaceIndex === undefined && target.photos.length >= M.MAX_PHOTOS) { photoStatus(`Не больше ${M.MAX_PHOTOS} фото: основное и ${M.MAX_GALLERY} дополнительных.`, true); break; }
      photoStatus(`Загружаю «${file.name}»…`);
      try {
        const url = await uploadImage(file);
        if (!current()) return;
        target.photos = replaceIndex === undefined ? M.photoOps.add(target.photos, url) : M.photoOps.replace(target.photos, replaceIndex, url);
        target.photosTouched = true; added += 1;
        renderPhotos();
      } catch (e) {
        if (current()) photoStatus('Не загружено: ' + e.message + ' Форма и уже загруженные фото остаются.', true);
        return;
      }
    }
    if (added && current()) photoStatus(`Фото ${replaceIndex === undefined ? 'добавлено' : 'заменено'}: ${added}. Нажмите «Готово», затем «Сохранить».`);
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

  /* ----- категории ----- */
  function renderCats(focusSel) {
    const panel = $('#panel-cats');
    const local = S.local;
    const home = M.homeOf(local, CATS);
    const counts = M.publicKeyCounts(local, CATS);
    const rest = CATS.filter((c) => !home.includes(c.key));
    const full = home.length >= O.HOME_MAX;
    const count = (key) => `${counts[key] || 0} ${plural(counts[key] || 0, ['товар', 'товара', 'товаров'])}`;
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
        <p><button class="ed-btn" type="button" data-home="reset">Вернуть шесть Дарьи</button></p>
      </div>
      <div class="ed-card">
        <h2>Разделы прайса</h2>
        <p class="ed-hint">Внутренние разделы прайса и старые адреса /catalog/…. Каждый товар лежит в одном разделе; поводы на сайте выбираются в карточке товара.</p>
        <ul class="ed-order">${local.categories.map((c) => renaming === c.id ? `<li><form class="ed-rename" data-rename-form="${h(c.id)}">
            <label class="ed-field"><span>Новое название раздела</span><input name="title" value="${h(c.title)}" maxlength="80" required></label>
            <button class="ed-btn ed-btn--main" type="submit">Готово</button> <button class="ed-btn" type="button" data-section="cancel">Отмена</button></form></li>`
          : `<li><span class="ed-order__name">${h(c.title)}<small>${(c.items || []).length} ${plural((c.items || []).length, ['товар', 'товара', 'товаров'])} · ${h(c.id)}</small></span>
            <span class="ed-order__tools"><button class="ed-btn" type="button" data-section="rename" data-id="${h(c.id)}" aria-label="Переименовать «${h(c.title)}»">Переименовать</button>
            ${(c.items || []).length ? '' : `<button class="ed-btn ed-btn--danger" type="button" data-section="delete" data-id="${h(c.id)}" aria-label="Удалить пустой раздел «${h(c.title)}»">Удалить</button>`}</span></li>`).join('')}</ul>
        <form class="ed-rename" data-section-new><label class="ed-field"><span>Новый раздел прайса</span><input name="title" maxlength="80" placeholder="например, Корзины"></label>
          <button class="ed-btn" type="submit">+ Добавить раздел</button></form>
      </div>`;
    if (focusSel) (document.querySelector(focusSel) || panel.querySelector('button:not([disabled])'))?.focus();
    if (renaming) panel.querySelector('[data-rename-form] input')?.focus();
  }
  function plural(n, forms) { const a = n % 100, b = n % 10; return forms[a > 10 && a < 20 ? 2 : b === 1 ? 0 : b > 1 && b < 5 ? 1 : 2]; }
  function homeAction(act, key) {
    let keys = M.homeOf(S.local, CATS);
    const i = keys.indexOf(key);
    let next;
    try {
      if (act === 'up') keys = M.homeOps.up(keys, i);
      else if (act === 'down') keys = M.homeOps.down(keys, i);
      else if (act === 'remove') keys = M.homeOps.remove(keys, i);
      else if (act === 'add') keys = M.homeOps.add(keys, key);
      else if (act === 'reset') keys = O.DEFAULT_HOME.slice();
      next = M.setHome(S.local, keys, CATS).doc;
    } catch (e) { setStatus(e.message, 'error'); return; }
    if (!commit(next)) return;
    const pos = keys.indexOf(key);
    setStatus(act === 'reset' ? 'Вернули шесть основных Дарьи. Нажмите «Сохранить».' : pos >= 0 ? `«${catTitle(key)}» — на месте ${pos + 1}. Нажмите «Сохранить».` : `«${catTitle(key)}» — в «Показать ещё». Нажмите «Сохранить».`, 'ok');
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
    const keys = O.baseKeys(CATS);
    const today = companyTz ? O.localDate(Date.now(), companyTz) : '';
    const tz = companyTz
      ? `<div class="ed-tz"><b>Часовой пояс компании: ${h(companyTz)}</b> (настройка компании на сервере). Сегодня по нему: ${h(dateText(today))}. Праздник показывается с начала даты «с» до конца даты «по» включительно.</div>`
      : `<div class="ed-tz is-missing"><b>Расписание праздников выключено.</b> На сервере не указан часовой пояс компании, а угадывать его нельзя: иначе праздник появится или исчезнет не в тот день. Подготовить праздники можно — на сайте они не появятся, пока администратор Synapse не укажет пояс компании.</div>`;
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
      <p class="ed-hint">Даты — по часовому поясу компании${companyTz ? ` (${h(companyTz)})` : ' (пока не указан)'}, не по часам этого компьютера.</p>
      <fieldset class="ed-card"><legend>Какие категории входят</legend>
        <div class="ed-checks">${CATS.map((c) => `<label class="ed-check"><input type="checkbox" data-hd-include="${h(c.key)}" ${d.include.includes(c.key) ? 'checked' : ''}><span>${h(c.title)}</span></label>`).join('')}</div>
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
    try { res = M.upsertHoliday(S.local, { key, title: d.title, start: d.start, end: d.end, include: d.include, pinned: d.pinned }, holidayOrig ? holidayOrig.key : null, CATS); }
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
    if (t.dataset.home) { homeAction(t.dataset.home, t.dataset.key); return; }
    if (t.dataset.section === 'rename') { renaming = t.dataset.id; renderCats(); return; }
    if (t.dataset.section === 'cancel') { const id = renaming; renaming = null; renderCats(`[data-section="rename"][data-id="${CSS.escape(id)}"]`); return; }
    if (t.dataset.section === 'delete') { sectionEdit(() => M.deleteSection(S.local, t.dataset.id).doc, 'Пустой раздел удалён в редакторе. Нажмите «Сохранить».'); return; }
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
      sectionEdit(() => M.addSection(S.local, title).doc, 'Раздел добавлен в редакторе. Нажмите «Сохранить».');
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
    if (t.id === 'ed-owner-filter') { listOwner = t.value; listLimit = LIST_STEP; drawList(); return; }
    if (draft && t.hasAttribute('data-manual')) {
      draft.manualCategories = t.checked;
      if (t.checked && !draft.publicCategories.length) draft.publicCategories = O.basePublicKeys({}, draft.ownerId, CATS);
      $('#ed-occ').innerHTML = '<legend>Поводы на сайте</legend>' + occasionsHtml();
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
      $('#ed-occ').innerHTML = '<legend>Поводы на сайте</legend>' + occasionsHtml();
      focus?.focus();
      return;
    }
    if (draft && t.hasAttribute('data-photo-add') && t.files && t.files.length) { const files = [...t.files]; t.value = ''; addPhotos(files); return; }
    if (draft && t.dataset.photoReplace !== undefined && t.files && t.files[0]) { const f = t.files[0]; const i = Number(t.dataset.photoReplace); t.value = ''; addPhotos([f], i); return; }
    if (holidayDraft && t.dataset.hdInclude) {
      const set = new Set(holidayDraft.include);
      if (t.checked) set.add(t.dataset.hdInclude); else set.delete(t.dataset.hdInclude);
      holidayDraft.include = CATS.map((c) => c.key).filter((k) => set.has(k));
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
    if (S && (S.dirty() || draft || holidayDraft || S.pending || S.busy)) { e.preventDefault(); e.returnValue = ''; }
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
