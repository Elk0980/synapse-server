/* Palitra: координатор редактора прайса — состояние документа (base/local) и все обращения к серверу, которые
   его меняют: загрузка, сохранение, проверка неизвестного исхода, конфликт, откат, импорт. Без DOM: тот же код
   работает в браузере (window.PalitraEditorSession) и в Node-тестах с поддельным api.
   Правила:
   - одна операция с сервером за раз (busy); пока она идёт, любые изменяющие действия отклоняются кодом;
   - неизвестный исход сохранения (pending) разрешается только «Проверить результат», а явный повтор — только
     после доказанного «не сохранено»; правки, сброс, импорт, откат и загрузка до этого отклонены;
   - сохранение и импорт отправляют PUT только если последний GET прайса вернул заголовок
     X-Palitra-Price-CAS: 1 (сервер проверяет If-Match). Нет заголовка — PUT не отправляется, правки остаются;
   - поколение gen растёт при каждой замене base/local: поздний ответ старой загрузки/формы не применяется. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PalitraEditorSession = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const PRICE = '/content/palitra/price';
  const ASSETS = '/content/palitra/assets';
  const CAS_HEADER = 'X-Palitra-Price-CAS';
  const CAS_MISSING = 'Сохранение недоступно: сервер не подтвердил проверку версии прайса (заголовок X-Palitra-Price-CAS). '
    + 'Без неё одновременная правка в другом окне может быть затёрта. Правки остаются в этом окне; нужна установка серверной части.';
  const BUSY_TEXT = {
    load: 'Идёт загрузка прайса — подождите.',
    save: 'Идёт сохранение — подождите окончания.',
    verify: 'Идёт проверка результата сохранения — подождите.',
    reconcile: 'Идёт чтение свежей версии — подождите.',
    restore: 'Идёт возврат версии — подождите.',
    import: 'Идёт загрузка товаров — подождите окончания.'
  };
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  function createSession(options) {
    const M = options.model;
    const api = options.api;                 // { request(method, url, opts) → Promise<{ data, cas }> }
    const categories = options.categories;
    const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
    const s = {
      base: null, local: null, deleted: new Set(), pending: null, conflict: null,
      cas: null,        // null — неизвестно; true/false — по заголовку последнего GET прайса
      busy: null,       // null | 'load' | 'save' | 'verify' | 'reconcile' | 'restore' | 'import'
      gen: 0, loadSeq: 0, importVersion: null
    };
    const notify = () => { try { onChange(); } catch (_) { /* отрисовка не ломает состояние */ } };
    const dirty = () => Boolean(s.local && s.base && M.hasChanges(s.base, s.local));
    const locked = (reason) => ({ status: 'locked', reason });

    /* Причина отказа действия или null. Действия: edit, reset, save, import, restore, load, reload, session,
       verify, retry, drop-pending, rebase, discard, conflict-retry, export. */
    function blockReason(action) {
      if (action === 'export') return null;  // скачать свои правки файлом можно всегда: сервер не меняется
      if (s.busy) return BUSY_TEXT[s.busy] || 'Подождите окончания операции.';
      if (s.pending) {
        if (action === 'verify') return null;
        if ((action === 'retry' || action === 'drop-pending') && s.pending.state === 'not-saved') return null;
        // Проверка входа документ не меняет (при загруженном прайсе) и нужна, чтобы «Проверить результат» смог прочитать прайс.
        if (action === 'session') return null;
        return 'Сначала проверьте результат прошлого сохранения (сообщение вверху).';
      }
      if (action === 'verify' || action === 'retry' || action === 'drop-pending') return 'Нет сохранения, которое нужно проверить.';
      if (s.conflict) {
        if (['rebase', 'discard', 'conflict-retry', 'edit', 'session'].includes(action)) return null;
        return 'Прайс изменён в другом месте — выберите действие в сообщении вверху.';
      }
      if (['rebase', 'discard', 'conflict-retry'].includes(action)) return 'Конфликта версий нет.';
      if (!s.local && !['load', 'session'].includes(action)) return 'Прайс ещё не загружен.';
      return null;
    }

    /* ---------- изменения в окне ---------- */
    function edit(next, opts = {}) {
      const reason = blockReason('edit');
      if (reason) return { ok: false, reason };
      if (!isObject(next) || !Array.isArray(next.categories)) return { ok: false, reason: 'Изменение не применено: документ в неожиданном виде.' };
      s.local = next;
      if (opts.deletedId !== undefined) s.deleted.add(opts.deletedId);
      notify();
      return { ok: true };
    }
    function reset() {
      const reason = blockReason('reset');
      if (reason) return { ok: false, reason };
      s.local = M.clone(s.base); s.deleted.clear(); s.gen += 1;
      notify();
      return { ok: true };
    }
    const ticket = () => s.gen;
    const isCurrent = (t) => t === s.gen;

    /* ---------- чтение ---------- */
    function setLatestCas(response) { s.cas = Boolean(response && response.cas === true); }
    async function getLatest() {
      const r = await api.request('GET', PRICE);
      setLatestCas(r);
      return r.data;
    }
    /* within — загрузка как шаг уже идущей операции этого вида (импорт/откат), а не отдельное действие. */
    async function load(opts = {}) {
      if (opts.within) { if (s.busy !== opts.within) return locked('Загрузка вне своей операции отклонена.'); }
      else {
        const reason = blockReason(opts.action || 'load');
        if (reason) return locked(reason);
        s.busy = 'load';
      }
      const seq = ++s.loadSeq, gen = s.gen;
      notify();
      try {
        let data;
        try { data = await getLatest(); } catch (error) { return { status: 'error', error }; }
        if (seq !== s.loadSeq || gen !== s.gen) return { status: 'stale' };
        const shape = M.shapeProblems(data);
        if (shape.length) return { status: 'bad-shape', problems: shape };
        s.base = data; s.local = M.clone(data); s.deleted.clear(); s.pending = null; s.conflict = null; s.gen += 1;
        return { status: 'loaded', version: data.version };
      } finally {
        if (!opts.within) s.busy = null;
        notify();
      }
    }

    /* ---------- сохранение ---------- */
    function enterConflict(latest) {
      if (M.shapeProblems(latest).length) {
        s.conflict = { latest: null, rebased: null, conflicts: ['Не удалось прочитать свежую версию'] };
      } else {
        const r = M.rebase(latest, s.base, s.local);
        s.conflict = { latest, rebased: r.doc, conflicts: r.conflicts };
      }
      return { status: 'conflict', conflict: s.conflict };
    }
    async function afterSaved(sent, version, updatedAt) {
      s.base = { ...M.clone(sent), version, updatedAt }; s.local = M.clone(s.base);
      s.deleted.clear(); s.pending = null; s.conflict = null; s.gen += 1;
      let check = null;
      try { check = await getLatest(); } catch (_) { check = null; }
      if (check && !M.shapeProblems(check).length && M.same(M.withoutMeta(check), M.withoutMeta(sent))) {
        s.base = check; s.local = M.clone(check); s.gen += 1;
        return { status: 'saved', version, updatedAt, verified: true };
      }
      if (check && !M.shapeProblems(check).length) return { status: 'saved-mismatch', version, updatedAt, latestVersion: check.version };
      return { status: 'saved', version, updatedAt, verified: false };
    }
    async function verifyInner() {
      let latest = null;
      try { latest = await getLatest(); } catch (_) { latest = null; }
      const outcome = M.saveOutcome(s.pending.base, s.pending.sent, latest);
      if (outcome === 'saved') { const sent = s.pending.sent; s.pending = null; return afterSaved(sent, latest.version, latest.updatedAt); }
      if (outcome === 'not-saved') { s.pending.state = 'not-saved'; return { status: 'not-saved', version: latest.version }; }
      if (outcome === 'conflict') { s.pending = null; return enterConflict(latest); }
      s.pending.state = 'unknown';
      return { status: 'unknown' };
    }
    async function save() {
      const reason = blockReason('save');
      if (reason) return locked(reason);
      if (!dirty()) return { status: 'nothing' };
      if (s.cas !== true) return { status: 'cas-unknown', reason: CAS_MISSING };
      const problems = M.validateDocument(s.local, { categories }).concat(M.validateDelta(s.base, s.local, { expectedDeleted: [...s.deleted] }));
      if (problems.length) return { status: 'invalid', problems };
      s.busy = 'save';
      notify();
      const startBase = M.clone(s.base);
      try {
        let latest;
        try { latest = await getLatest(); } catch (error) { return { status: 'error', stage: 'get', error }; }
        // Поддержка CAS подтверждается заново перед каждым PUT: сервер могли откатить на старую версию.
        if (s.cas !== true) return { status: 'cas-unknown', reason: CAS_MISSING };
        if (!isObject(latest) || latest.version !== startBase.version) return enterConflict(latest);
        const sent = M.clone(s.local);
        let res;
        try { res = (await api.request('PUT', PRICE, { json: sent, ifMatch: startBase.version, timeout: 45000 })).data; } catch (error) {
          const kind = error && error.status ? M.classifyPut(error.status) : 'unknown';
          if (kind === 'conflict') {
            let fresh = null;
            try { fresh = await getLatest(); } catch (_) { fresh = null; }
            return enterConflict(fresh);
          }
          if (kind === 'auth') return { status: 'auth', error };
          if (kind === 'rejected') return { status: 'rejected', error };
          s.pending = { sent, base: startBase, state: 'unknown' };
          return await verifyInner();
        }
        if (!res || !Number.isInteger(res.version)) { s.pending = { sent, base: startBase, state: 'unknown' }; return await verifyInner(); }
        // Ответ без cas:true — сервер версию не проверил: сохранено, но следующие PUT заблокированы до нового GET с заголовком.
        if (res.cas !== true) s.cas = false;
        const out = await afterSaved(sent, res.version, res.updatedAt);
        return { ...out, casConfirmed: res.cas === true };
      } finally {
        s.busy = null;
        notify();
      }
    }
    async function verify() {
      const reason = blockReason('verify');
      if (reason) return locked(reason);
      s.busy = 'verify';
      notify();
      try { return await verifyInner(); } finally { s.busy = null; notify(); }
    }
    async function retry() {
      const reason = blockReason('retry');
      if (reason) return locked(reason);
      s.pending = null;
      return save();
    }
    function dropPending() {
      const reason = blockReason('drop-pending');
      if (reason) return { ok: false, reason };
      s.pending = null;
      notify();
      return { ok: true };
    }

    /* ---------- конфликт ---------- */
    function rebase() {
      const reason = blockReason('rebase');
      if (reason) return { ok: false, reason };
      if (!s.conflict || !s.conflict.latest) return { ok: false, reason: 'Свежая версия не прочитана.' };
      const latest = s.conflict.latest;
      const r = M.rebase(latest, s.base, s.local); // заново: после сообщения могли быть новые «Готово»
      if (!r.doc) { enterConflict(latest); notify(); return { ok: false, reason: 'Правки пересекаются с чужими.', conflicts: r.conflicts }; }
      s.local = r.doc; s.base = latest; s.conflict = null; s.gen += 1;
      notify();
      return { ok: true, version: latest.version };
    }
    function discard() {
      const reason = blockReason('discard');
      if (reason) return { ok: false, reason };
      if (!s.conflict || !s.conflict.latest) return { ok: false, reason: 'Свежая версия не прочитана.' };
      const latest = s.conflict.latest;
      s.base = latest; s.local = M.clone(latest); s.deleted.clear(); s.conflict = null; s.gen += 1;
      notify();
      return { ok: true, version: latest.version };
    }
    async function conflictRetry() {
      const reason = blockReason('conflict-retry');
      if (reason) return locked(reason);
      s.busy = 'reconcile';
      notify();
      try {
        let latest;
        try { latest = await getLatest(); } catch (error) { return { status: 'error', error }; }
        return enterConflict(latest);
      } finally { s.busy = null; notify(); }
    }

    /* ---------- откат к версии истории ---------- */
    async function restore(version) {
      const reason = blockReason('restore');
      if (reason) return locked(reason);
      if (dirty()) return locked('Сначала сохраните или отмените правки, затем возвращайте версию.');
      if (!/^\d{1,9}$/.test(String(version))) return { status: 'error', error: new Error('Неверный номер версии') };
      s.busy = 'restore';
      notify();
      try {
        try { await api.request('POST', `${PRICE}/restore/${encodeURIComponent(String(version))}`); } catch (error) { return { status: 'error', error }; }
        const loaded = await load({ within: 'restore' });
        return { status: loaded.status === 'loaded' ? 'restored' : 'restored-unloaded', version, load: loaded };
      } finally { s.busy = null; notify(); }
    }

    /* ---------- импорт (palitra-catalog-import.js) ---------- */
    function beginImport() {
      const reason = blockReason('import') || (dirty() ? 'Сначала сохраните или отмените правки.' : null);
      if (reason) return { ok: false, reason };
      s.busy = 'import'; s.importVersion = null;
      notify();
      return { ok: true };
    }
    function endImport() {
      if (s.busy === 'import') { s.busy = null; s.importVersion = null; notify(); }
    }
    /* Тот же контракт, что apiFetch прежнего редактора. GET прайса без подтверждения CAS — ошибка до любых загрузок;
       загрузка фото и PUT — только внутри beginImport; PUT несёт If-Match версии последнего GET импорта. */
    async function importFetch(url, opts = {}) {
      const method = String(opts.method || 'GET').toUpperCase();
      const pass = { raw: opts.body, headers: opts.headers };
      if (url === PRICE && method === 'GET') {
        const r = await api.request('GET', PRICE);
        setLatestCas(r);
        notify();
        if (s.cas !== true) throw new Error(CAS_MISSING);
        if (s.busy === 'import') s.importVersion = isObject(r.data) ? r.data.version : null;
        return r.data;
      }
      if (s.busy !== 'import') throw new Error('Загрузка товаров не запущена — запись отклонена.');
      if (url === PRICE && method === 'PUT') {
        if (s.cas !== true) throw new Error(CAS_MISSING);
        if (!Number.isInteger(s.importVersion)) throw new Error('Версия прайса для загрузки товаров не прочитана.');
        return (await api.request('PUT', PRICE, { ...pass, ifMatch: s.importVersion })).data;
      }
      if (url === ASSETS && method === 'POST') return (await api.request('POST', ASSETS, pass)).data;
      throw new Error('Неизвестный запрос загрузки товаров отклонён.');
    }

    return {
      get base() { return s.base; }, get local() { return s.local; }, get pending() { return s.pending; },
      get conflict() { return s.conflict; }, get cas() { return s.cas; }, get busy() { return s.busy; },
      get deleted() { return s.deleted; }, get gen() { return s.gen; },
      dirty, blockReason, edit, reset, ticket, isCurrent, load, save, verify, retry, dropPending,
      rebase, discard, conflictRetry, restore, beginImport, endImport, importFetch
    };
  }

  return { createSession, PRICE, ASSETS, CAS_HEADER, CAS_MISSING };
});
