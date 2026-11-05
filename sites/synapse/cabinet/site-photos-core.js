/* Palitra: логика редактора фото без DOM (PALITRA-BOT-EDITOR-35). Тестируется в Node.
   - API-клиент: cookie-сессия кабинета (credentials same-origin) + X-CSRF-Token из /content/whoami.
   - Классы результата: ok / session / forbidden / conflict / invalid / failed / unavailable / unknown.
   - Локальный черновик правок в localStorage: переживает конфликт, истёкшую сессию, запрет и сбой загрузки.
   - Сохранение считается успешным только после повторного чтения состояния и совпадения всех слотов
     с ожидаемыми. При неизвестном результате — сначала чтение, автоматического повтора нет. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./palitra-photo-model.js'));
  else root.PalitraSitePhotosCore = factory(root.PalitraPhotoModel);
})(typeof self !== 'undefined' ? self : this, function (model) {
  'use strict';

  const STATE_URL = '/content/palitra/site-photos';
  const ASSETS_URL = '/content/palitra/site-photos/assets';
  const WHOAMI_URL = '/content/whoami';
  const ACCESS_URL = '/content/palitra/site-photos/access';
  const DRAFT_KEY = `palitra-site-photos-draft-v1:${model.TARGET.siteId}`;

  const classify = (status, data) => {
    if (status >= 200 && status < 300) return 'ok';
    if (status === 401) return 'session';
    if (status === 403) return 'forbidden';
    if (status === 409) return 'conflict';
    if (status === 400 || status === 413 || status === 415 || status === 422) return 'invalid';
    // upload_failed выдаётся только после проверки, что файла нет в хранилище (имя по sha256 — повтор безопасен).
    if (status === 502 && data && (data.error === 'write_failed' || data.error === 'upload_failed')) return 'failed';
    // Декодер не подключён: известный отказ до любой записи, не «неизвестный результат».
    if (status === 503 && data && (data.error === 'decoder_unavailable' || data.error === 'unavailable')) return 'unavailable';
    return 'unknown';
  };

  function createApi(fetchImpl) {
    async function request(url, options = {}) {
      let response;
      try {
        response = await fetchImpl(url, { credentials: 'same-origin', cache: 'no-store', ...options });
      } catch (_) {
        return { kind: 'unknown', status: 0, data: null, message: 'Нет связи с кабинетом. Результат неизвестен' };
      }
      let data = null;
      try { data = await response.json(); } catch (_) { data = null; }
      const kind = classify(response.status, data);
      if (kind === 'ok' && !data) return { kind: 'unknown', status: response.status, data: null, message: 'Кабинет ответил без данных. Результат неизвестен' };
      return { kind, status: response.status, data, message: (data && (data.message || data.error)) || `Ошибка ${response.status}` };
    }
    return {
      whoami: () => request(WHOAMI_URL),
      state: () => request(STATE_URL),
      apply: (csrfToken, body) => request(STATE_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(body) }),
      upload: (csrfToken, file) => request(ASSETS_URL, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-CSRF-Token': csrfToken }, body: file }),
      access: () => request(ACCESS_URL),
      setAccess: (csrfToken, body) => request(ACCESS_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(body) })
    };
  }

  /* ---------- Локальный черновик ---------- */

  const emptyDraft = baseRevision => ({ version: 1, siteId: model.TARGET.siteId, baseRevision, operations: [], removed: [], savedAt: null });

  function loadDraft(storage) {
    try {
      const raw = storage.getItem(DRAFT_KEY);
      if (!raw) return null;
      const draft = JSON.parse(raw);
      if (!draft || draft.version !== 1 || draft.siteId !== model.TARGET.siteId || !Array.isArray(draft.operations)) return null;
      if (!Array.isArray(draft.removed)) draft.removed = [];
      return draft;
    } catch (_) { return null; }
  }

  function storeDraft(storage, draft) {
    try {
      if (!draft.operations.length && !draft.removed.length) { storage.removeItem(DRAFT_KEY); return true; }
      storage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, savedAt: new Date().toISOString() }));
      return true;
    } catch (_) { return false; }
  }

  const clearDraft = storage => { try { storage.removeItem(DRAFT_KEY); } catch (_) { /* хранилище недоступно */ } };

  const targetOf = op => {
    if (op.type === 'hero.scene') return `hero:${op.scene}`;
    if (op.type === 'category.photo') return `category:${op.category}`;
    if (op.type === 'budget.photo') return `budget:${op.index}`;
    return 'gallery';
  };

  /* Одна операция на слот: новая правка слота заменяет прежнюю. */
  function upsert(draft, op) {
    const target = targetOf(op);
    return { ...draft, operations: [...draft.operations.filter(item => targetOf(item) !== target), op] };
  }
  const dropTarget = (draft, target) => ({ ...draft, operations: draft.operations.filter(item => targetOf(item) !== target) });

  /* Галерея: правка хранится как полный список; совпал с сохранённым — правки нет. */
  function setGallery(draft, slots, items) {
    const same = JSON.stringify(items.map(({ url, alt, width, height }) => ({ url, alt, width, height }))) === JSON.stringify(slots.gallery);
    return same ? dropTarget(draft, 'gallery') : upsert(draft, { type: 'gallery.set', items: items.map(({ url, alt, width, height }) => ({ url, alt, width, height })) });
  }

  /* Слоты с учётом черновика. Если черновик не проходит проверку модели — возвращаем ошибку, а не молча режем. */
  function effectiveSlots(slots, draft) {
    if (!draft || !draft.operations.length) return { slots, error: null };
    try { return { slots: model.projectSlots(slots, draft.operations), error: null }; }
    catch (error) { return { slots, error: error.message }; }
  }

  /* ---------- Сохранение ---------- */

  async function verifyAfter(api, expected) {
    const fresh = await api.state();
    if (fresh.kind !== 'ok') return { verified: false, fresh };
    return { verified: model.slotsEqual(fresh.data.slots, expected), fresh };
  }

  async function save({ api, csrfToken, state, draft, message }) {
    let expected;
    try { expected = model.projectSlots(state.slots, draft.operations); }
    catch (error) { return { status: 'invalid', message: error.message }; }
    if (draft.baseRevision !== state.revision) return { status: 'conflict', message: 'Черновик сайта изменился после начала правок. Обновите состояние и проверьте правки' };
    const sent = await api.apply(csrfToken, { baseRevision: state.revision, operations: draft.operations, message: message || '' });
    if (sent.kind === 'ok') {
      const check = await verifyAfter(api, expected);
      if (check.verified) return { status: 'saved', state: check.fresh.data, message: `Сохранено в черновик, версия ${check.fresh.data.version}. Проверено повторным чтением` };
      if (check.fresh.kind !== 'ok') return { status: 'unknown', message: 'Кабинет принял правки, но проверить их не удалось. Обновите состояние перед повтором' };
      return { status: 'unknown', state: check.fresh.data, message: 'После сохранения фото на сайте не совпали с правками. Проверьте состояние перед повтором' };
    }
    if (sent.kind === 'unknown') {
      // Сначала читаем результат: возможно, запись прошла, а ответ потерялся.
      const check = await verifyAfter(api, expected);
      if (check.verified) return { status: 'saved', state: check.fresh.data, message: `Сохранено в черновик, версия ${check.fresh.data.version}. Ответ потерялся, правки подтверждены чтением` };
      if (check.fresh.kind === 'ok' && check.fresh.data.revision === state.revision) return { status: 'failed', state: check.fresh.data, message: 'Черновик не изменился: правки не записаны. Они сохранены в браузере' };
      return { status: 'unknown', message: 'Результат сохранения неизвестен. Обновите состояние перед повтором' };
    }
    return { status: sent.kind, message: sent.message, revision: sent.data && sent.data.revision };
  }

  /* Новый материал: загрузка, ответ с адресом и размерами. Ошибка загрузки не трогает черновик правок. */
  async function upload({ api, csrfToken, file }) {
    if (!file) return { status: 'invalid', message: 'Файл не выбран' };
    if (!/^image\/(?:jpeg|png|webp)$/.test(file.type || '')) return { status: 'invalid', message: 'Подходят только фото JPEG, PNG или WebP' };
    const sent = await api.upload(csrfToken, file);
    if (sent.kind !== 'ok') return { status: sent.kind, message: sent.message };
    const { url, width, height } = sent.data;
    try { model.checkUrl(url); } catch (error) { return { status: 'failed', message: error.message }; }
    if (!Number.isInteger(width) || !Number.isInteger(height)) return { status: 'failed', message: 'Кабинет не вернул размеры фото' };
    return { status: 'ok', image: { url, width, height } };
  }

  /* Доступ к фото (только владелец): изменение считается сделанным только после повторного чтения списка.
     При неизвестном результате — сначала чтение, без повторной отправки. */
  async function setAccess({ api, csrfToken, userId, view, edit }) {
    if (!Number.isInteger(userId) || typeof view !== 'boolean' || typeof edit !== 'boolean' || (edit && !view)) return { status: 'invalid', message: 'Изменение фото возможно только вместе с просмотром' };
    const sent = await api.setAccess(csrfToken, { userId, view, edit });
    if (sent.kind !== 'ok' && sent.kind !== 'unknown') return { status: sent.kind, message: sent.message };
    const fresh = await api.access();
    if (fresh.kind !== 'ok') return { status: 'unknown', message: 'Результат изменения доступа неизвестен. Обновите список' };
    const user = (fresh.data.users || []).find(item => item.userId === userId);
    if (user && user.view === view && user.edit === edit) return { status: 'saved', users: fresh.data.users, message: 'Доступ изменён и проверен повторным чтением' };
    return { status: sent.kind === 'ok' ? 'unknown' : 'failed', users: fresh.data.users, message: sent.kind === 'ok' ? 'Сервер принял изменение, но список показывает другое. Обновите список' : 'Доступ не изменился' };
  }

  return Object.freeze({ STATE_URL, ASSETS_URL, WHOAMI_URL, ACCESS_URL, DRAFT_KEY, classify, createApi, emptyDraft, loadDraft, storeDraft, clearDraft, targetOf, upsert, dropTarget, setGallery, effectiveSlots, save, upload, setAccess });
});
