/* Один файл в существующий чат Palitra. Только внедрённый typed client, без fetch/авторизации/хранилища.
   Доноры: palitra-chat.js99fb и palitra-work.jsdf82 — prepare → bytes → точная receipt, тот же requestId при повторе.
   URL вложений только защищённые same-origin из client. Blob/object URLs не создаются. */
'use strict';
(() => {
  const LIMIT = 20 * 1024 * 1024, MAX_PENDING = 5;
  const UPLOAD = /^upload:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const STATES = { pending: 'Файл ещё загружается', too_large: 'Файл слишком большой', unavailable: 'Файл недоступен', quota_exceeded: 'Хранилище заполнено' };
  const safeTarget = t => t && ['thread', 'legacy'].includes(t.ns) && Number.isSafeInteger(t.id) && t.id > 0 ? Object.freeze({ ns: t.ns, id: t.id }) : null;
  const keyOf = t => `${t.ns}:${t.id}`;
  const sizeText = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`;
  function create({ document: doc, window: win, client, onUnauthorized = () => {} } = {}) {
    if (!doc || !win || !client || typeof client.prepare !== 'function' || typeof client.fileUrl !== 'function') throw new TypeError('Нужен подключённый модуль файлов');
    let identity = '', epoch = null, generation = 0, activeKey = '', binding = null;
    const records = new Map(), views = new Set();
    const h = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = String(text); return n; };
    const button = (text, click) => { const b = h('button', 'attachments__button', text); b.type = 'button'; b.addEventListener('click', click); return b; };
    const live = (r, token = generation) => token === generation && records.get(r.key) === r && Boolean(identity);
    function report(r) {
      const value = Object.freeze({ preparing: r.preparing, sending: r.sending, hasFile: Boolean(r.file), pending: Boolean(r.pending),
        blockingText: Boolean(r.file || r.preparing || r.pending || r.sending), status: r.status, message: r.message,
        requestId: r.pending && r.pending.body.requestId || null, uploadRef: r.pending && r.pending.ref || null });
      if (binding && binding.key === r.key) {
        const b = binding, can = enabled(r);
        b.input.disabled = !can || r.sending; b.pick.hidden = !can;
        b.remove.hidden = !r.file || r.sending; b.remove.disabled = r.sending;
        b.retry.hidden = !r.pending || r.sending; b.retry.disabled = r.preparing || (!can && !(r.pending && r.pending.ref && client.canRead(r.target)));
        b.name.textContent = r.preparing ? 'Проверяем файл…' : r.file ? `${r.file.name} · ${sizeText(r.file.size)}` : r.pending ? 'Для повтора выберите тот же файл.' : '';
        b.status.textContent = !can && !r.pending ? 'Отправка файлов пока недоступна. Сохранённые вложения можно открыть.' : r.message;
        b.status.setAttribute('data-state', r.status);
        if (typeof b.onState === 'function') b.onState(value);
      }
      return value;
    }
    function enabled(r) { return Boolean(identity && r.uploads && r.uploads.enabled === true && client.canWrite(r.target)); }
    function cancel(r) {
      r.seq++; r.sendSeq++; r.preparing = false; r.file = null;
      if (r.abort) { r.abort.abort(); r.abort = null; }
      if (r.sending && r.pending) { r.status = 'unknown'; r.message = 'Проверьте ту же отправку файла, когда вернётесь в чат.'; }
      r.sending = false;
    }
    function notifyCommitted(r) {
      if (!live(r) || !r.accepted || !binding || binding.key !== r.key || typeof binding.onCommitted !== 'function') return;
      const event = r.accepted; r.accepted = null;
      // Ошибка обновления оболочки не превращает полученную server receipt в неизвестную отправку.
      try { binding.onCommitted(event); } catch (_) { r.message = 'Файл сохранён в чате. Обновите переписку, чтобы увидеть его.'; }
    }
    function clearViews() { if (binding) { binding.box.remove(); binding = null; } for (const dispose of [...views]) dispose(); }
    function unmount() { clearViews(); if (activeKey && records.has(activeKey)) cancel(records.get(activeKey)); activeKey = ''; }
    function setIdentity(value = {}) {
      const next = typeof value.key === 'string' ? value.key : '';
      if (next === identity && value.epoch === epoch) return;
      generation++; for (const r of records.values()) cancel(r); clearViews(); records.clear(); activeKey = ''; identity = next; epoch = value.epoch;
    }
    async function selectFile(r, file) {
      if (!live(r) || !enabled(r) || r.sending) return;
      const seq = ++r.seq, token = generation; r.file = null; r.preparing = false;
      if (!file) { r.message = ''; report(r); return; }
      const max = Math.min(LIMIT, r.uploads.maxBytes || LIMIT);
      if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > max || typeof file.arrayBuffer !== 'function' || typeof file.name !== 'string') {
        r.status = 'error'; r.message = `Выберите непустой файл до ${Math.round(max / 1048576)} МБ.`; report(r); return;
      }
      r.preparing = true; r.status = 'preparing'; r.message = 'Проверяем файл…'; report(r);
      try {
        const buffer = await file.arrayBuffer();
        if (!live(r, token) || r.seq !== seq) return;
        if (buffer.byteLength !== file.size || buffer.byteLength > max) throw new Error('Размер файла изменился — выберите его заново.');
        const digest = await win.crypto.subtle.digest('SHA-256', buffer);
        if (!live(r, token) || r.seq !== seq) return;
        const sha256 = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
        if (r.pending && (r.pending.body.sha256 !== sha256 || r.pending.body.size !== file.size)) throw new Error('Для этой отправки нужен тот же файл. Номер прежнего запроса сохранён.');
        r.file = { file, name: file.name, size: file.size, sha256 }; r.status = 'selected';
        r.message = /\.heic$/i.test(file.name) ? 'HEIC будет файлом, а не фото этапа. Для фото выберите JPG, PNG, GIF или WebP.' : r.pending ? 'Тот же файл выбран. Проверьте и повторите прежнюю отправку.' : 'Файл выбран. Подпись отправится вместе с ним.';
      } catch (error) { if (live(r, token) && r.seq === seq) { r.status = 'error'; r.message = error.message || 'Не удалось прочитать файл.'; } }
      finally { if (live(r, token) && r.seq === seq) { r.preparing = false; report(r); } }
    }
    function validateUpload(r, data) {
      const u = data && data.upload, p = r.pending;
      if (!p || !u || !UPLOAD.test(String(u.ref || '')) || u.requestId !== p.body.requestId || u.target !== keyOf(r.target) ||
          u.name !== p.body.name || u.size !== p.body.size || u.sha256 !== p.body.sha256 || u.caption !== p.body.caption || (p.ref && p.ref !== u.ref)) throw new Error('Сервер не подтвердил именно эту загрузку. Проверьте ту же отправку.');
      return u;
    }
    function receiptOk(r, data) {
      const p = r.pending;
      if (!p || !p.ref || !data || data.ok !== true) return false;
      if (r.target.ns === 'legacy') return data.dialogId === r.target.id && Number.isSafeInteger(data.messageId) && data.messageId > 0 && data.upload && data.upload.ref === p.ref && data.upload.state === 'committed';
      return data.threadId === r.target.id && data.message && Number.isSafeInteger(data.message.id) && data.message.id > 0 &&
        Array.isArray(data.message.attachments) && data.message.attachments.some(a => a && a.ref === p.ref && a.storageStatus === 'stored');
    }
    async function send(r, caption) {
      if (!live(r)) return { handled: true, status: 'inactive' };
      if (!r.file && !r.preparing && !r.pending && !r.sending) return { handled: false };
      if (!enabled(r) && !(r.pending && r.pending.ref && client.canRead(r.target))) { r.status = 'disabled'; r.message = 'Новые файлы сейчас недоступны. Подпись не отправлена отдельно.'; report(r); return { handled: true, status: 'disabled' }; }
      if (r.preparing || r.sending) return { handled: true, status: r.preparing ? 'preparing' : 'sending' };
      if (!r.pending) {
        try {
          const body = client.normalizeInput({ requestId: win.crypto.randomUUID(), name: r.file.name, size: r.file.size, sha256: r.file.sha256, caption: String(caption || '') });
          r.pending = { body, ref: null, capturedCaption: String(caption || '') };
        } catch (error) { r.status = 'error'; r.message = error.message; report(r); return { handled: true, status: 'error' }; }
      }
      const p = r.pending, token = generation, sendSeq = ++r.sendSeq; r.sending = true; r.status = 'sending'; r.message = 'Проверяем и отправляем файл…';
      const controller = new AbortController(); r.abort = controller; report(r);
      try {
        let data = p.ref ? await client.status(r.target, p.ref, controller.signal) : await client.prepare(r.target, p.body, controller.signal);
        if (!live(r, token) || r.sendSeq !== sendSeq || r.pending !== p || controller.signal.aborted) return { handled: true, status: 'inactive' };
        const upload = validateUpload(r, data); p.ref = upload.ref;
        if (upload.state !== 'committed') {
          if (['expired', 'rejected'].includes(upload.state)) {
            r.pending = null; r.status = 'error'; r.message = 'Этот файл не отправлен: загрузка отклонена или истекла. Подпись сохранена; новую отправку можно начать отдельным нажатием.';
            return { handled: true, status: 'error' };
          }
          if (!enabled(r)) { r.status = 'disabled'; r.message = 'Состояние проверено. Новая передача байтов сейчас недоступна, подпись сохранена.'; return { handled: true, status: 'disabled' }; }
          if (!r.file || r.file.sha256 !== p.body.sha256 || r.file.size !== p.body.size) throw new Error('Выберите тот же файл для повтора прежней отправки.');
          data = await client.bytes(r.target, p.ref, r.file.file, controller.signal);
        }
        if (!live(r, token) || r.sendSeq !== sendSeq || r.pending !== p || controller.signal.aborted) return { handled: true, status: 'inactive' };
        if (!receiptOk(r, data)) throw new Error('Файл мог сохраниться. Сервер не подтвердил точную квитанцию — проверьте ту же отправку.');
        r.pending = null; r.file = null; r.status = 'committed'; r.message = '';
        r.accepted = { target: r.target, receipt: data, capturedCaption: p.capturedCaption }; notifyCommitted(r);
        return { handled: true, status: 'committed', receipt: data };
      } catch (error) {
        if (!live(r, token) || r.sendSeq !== sendSeq || r.pending !== p) return { handled: true, status: 'inactive' };
        if ((error.status === 401 || error.status === 403) && typeof onUnauthorized === 'function') onUnauthorized(error);
        if (!p.ref && error.status >= 400 && error.status < 500) { r.pending = null; r.status = 'error'; }
        else r.status = 'unknown';
        r.message = error.message || 'Исход неизвестен — проверьте и повторите ту же отправку.';
        return { handled: true, status: r.status };
      } finally { if (live(r, token) && r.sendSeq === sendSeq) { if (r.abort === controller) r.abort = null; r.sending = false; report(r); } }
    }
    function mountComposer({ container, target, uploads, getCaption = () => '', onCommitted, onState } = {}) {
      target = safeTarget(target); if (!target || !container || !identity) throw new TypeError('Нужны текущая identity, контейнер и typed чат');
      const key = keyOf(target);
      if (activeKey && activeKey !== key && records.has(activeKey)) cancel(records.get(activeKey));
      if (binding) { binding.box.remove(); binding = null; }
      if (!records.has(key)) {
        if (records.size >= MAX_PENDING) { const disposable = [...records.values()].find(r => !r.pending); if (!disposable) throw new Error('Сначала проверьте прежние отправки файлов.'); records.delete(disposable.key); }
        records.set(key, { key, target, uploads: null, seq: 0, sendSeq: 0, file: null, preparing: false, sending: false, pending: null, accepted: null, abort: null, status: '', message: '' });
      }
      const r = records.get(key); r.uploads = uploads && uploads.enabled === true && Number.isSafeInteger(uploads.maxBytes) && uploads.maxBytes > 0 ? { enabled: true, maxBytes: Math.min(LIMIT, uploads.maxBytes) } : null;
      if (!r.uploads && (r.file || r.preparing)) { r.seq++; r.file = null; r.preparing = false; }
      activeKey = key;
      const box = h('div', 'attachments'), input = h('input', 'attachments__input'), name = h('span', 'attachments__name'), status = h('p', 'attachments__status');
      input.type = 'file'; input.setAttribute('aria-label', 'Прикрепить файл'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      const pick = button('Прикрепить файл', () => input.click());
      const remove = button('Убрать выбранный файл', () => { if (r.sending) return; r.seq++; r.file = null; r.preparing = false; input.value = ''; report(r); });
      const retry = button('Проверить и повторить ту же отправку', () => send(r, getCaption()));
      input.addEventListener('change', () => { selectFile(r, input.files && input.files[0] || null); }); box.append(input, pick, name, remove, retry, status); container.append(box);
      const ownBinding = { key, box, input, pick, name, remove, retry, status, onCommitted, onState };
      binding = ownBinding; notifyCommitted(r); report(r);
      return Object.freeze({ interceptSend: caption => send(r, caption), retry: () => send(r, getCaption()), selectFile: file => selectFile(r, file), getState: () => report(r),
        unmount: () => { if (binding !== ownBinding) return; binding.box.remove(); binding = null; cancel(r); } });
    }
    function mountAttachments({ container, target, attachments } = {}) {
      target = safeTarget(target); if (!target || !container || !identity) throw new TypeError('Нужен текущий чат');
      const box = h('div', 'attachments-list'), media = [], token = generation;
      for (const file of (Array.isArray(attachments) ? attachments : []).slice(0, 50)) {
        const item = h('div', 'attachment'), name = typeof file.name === 'string' ? file.name.slice(0, 180) : 'Вложение';
        item.append(h('span', 'attachment__name', name));
        const stored = !file.superseded && (file.storageStatus === 'stored' || file.status === 'stored');
        let url; try { if (stored) url = client.fileUrl(target, file.ref || file.id); } catch (_) { url = ''; }
        if (!url) { item.append(h('span', 'attachment__state', STATES[file.storageStatus || file.status] || 'Файл недоступен.')); box.append(item); continue; }
        // Только строгие same-origin URLs из client; входные file.url/src/href никогда не используются.
        const mime = String(file.mime || ''), kind = file.presentation;
        let player = null;
        if (kind === 'image' && /^image\/(jpeg|png|gif|webp)$/.test(mime)) { player = h('img', 'attachment__image'); player.alt = name; player.loading = 'lazy'; player.decoding = 'async'; }
        else if (kind === 'audio' && /^audio\/(ogg|mpeg|mp4)$/.test(mime)) { player = h('audio', 'attachment__media'); player.controls = true; player.preload = 'none'; }
        else if (kind === 'video' && /^video\/(mp4|webm)$/.test(mime)) { player = h('video', 'attachment__media'); player.controls = true; player.preload = 'none'; player.playsInline = true; }
        if (player) { player.setAttribute('src', url); player.addEventListener('error', () => { if (token === generation) item.append(h('span', 'attachment__state', 'Не удалось открыть файл. Проверьте доступ к чату.')); }); item.append(player); media.push(player); }
        const link = h('a', 'attachment__download', 'Скачать файл'); link.setAttribute('href', url); link.setAttribute('download', ''); link.setAttribute('rel', 'noopener noreferrer'); item.append(link); box.append(item);
      }
      container.append(box);
      let done = false;
      const dispose = () => { if (done) return; done = true; for (const player of media) { try { if (typeof player.pause === 'function') player.pause(); } catch (_) {} player.removeAttribute('src'); } box.querySelectorAll('a').forEach(a => a.removeAttribute('href')); box.remove(); views.delete(dispose); };
      views.add(dispose); return Object.freeze({ unmount: dispose });
    }
    return Object.freeze({ setIdentity, mountComposer, mountAttachments, clearViews, unmount, destroy: () => { generation++; unmount(); for (const r of records.values()) cancel(r); records.clear(); identity = ''; epoch = null; } });
  }
  Object.defineProperty(window, 'PalitraAttachmentsUI', { value: Object.freeze({ create }), writable: false, configurable: false });
})();
