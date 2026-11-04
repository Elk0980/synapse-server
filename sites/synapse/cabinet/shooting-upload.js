/* Съёмка (№98 · В): клиент загрузки частями. Сессия создаётся POST, куски идут PATCH с
   Upload-Offset. Обрыв связи — пауза и продолжение с принятого сервером байта; перезагрузка
   страницы — та же сессия по отпечатку файла (имя, размер, дата изменения). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SbShooting = root.SbShooting || {}).upload = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  'use strict';
  const wait = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new Error('Отменено')); }, {once: true});
  });
  const fingerprint = (file) => `${file.name}:${file.size}:${file.lastModified || 0}`;

  async function json(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `Ошибка ${response.status}`);
      Object.assign(error, {status: response.status, code: body.details?.code, upload: body.details?.upload});
      throw error;
    }
    return body;
  }

  /* base — '/content/shooting'; headers — CSRF сессии кабинета (монтажёр работает по той же сессии). */
  async function upload({file, ideaId, frame = null, kind = 'take', companyCode, headers = {}, base = '/content/shooting',
    onProgress = () => {}, signal, fetchImpl = globalThis.fetch.bind(globalThis), retries = 8, backoffMs = 1000}) {
    const query = `companyCode=${encodeURIComponent(companyCode)}`;
    const created = await json(await fetchImpl(`${base}/uploads?${query}`, {method: 'POST', signal, credentials: 'same-origin',
      headers: {'content-type': 'application/json', ...headers},
      body: JSON.stringify({ideaId, frame, kind, name: file.name, size: file.size, mime: file.type || '', fingerprint: fingerprint(file)})}));
    let state = created.upload, failures = 0;
    onProgress(state.offset, file.size, state);
    while (state.status === 'uploading') {
      const end = Math.min(state.offset + (state.chunkBytes || 8 * 1024 * 1024), file.size);
      try {
        const response = await fetchImpl(`${base}/uploads/${state.id}?${query}`, {method: 'PATCH', signal, credentials: 'same-origin',
          headers: {'content-type': 'application/offset+octet-stream', 'upload-offset': String(state.offset), ...headers},
          body: file.slice(state.offset, end)});
        state = (await json(response)).upload;
        failures = 0;
        onProgress(state.offset, file.size, state);
      } catch (error) {
        if (signal?.aborted) throw error;
        // Сервер подсказал принятое смещение — продолжаем с него без паузы.
        if (error.status === 409 && error.upload) { state = error.upload; continue; }
        if (error.status && error.status < 500 && error.status !== 408 && error.status !== 429) throw error;
        failures += 1;
        if (failures > retries) throw Object.assign(new Error('Связь прерывается. Нажмите «Загрузить» с тем же файлом — продолжим с того же места.'), {resumable: true});
        onProgress(state.offset, file.size, {...state, waiting: true});
        if (globalThis.navigator && globalThis.navigator.onLine === false && globalThis.addEventListener) {
          await new Promise((resolve) => globalThis.addEventListener('online', resolve, {once: true}));
        } else await wait(Math.min(30000, backoffMs * 2 ** (failures - 1)), signal);
        const fresh = await json(await fetchImpl(`${base}/uploads/${state.id}?${query}`, {signal, credentials: 'same-origin', headers})).catch(() => null);
        if (fresh?.upload) state = fresh.upload;
      }
    }
    return state;
  }

  const size = (bytes) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2).replace('.', ',')} ГБ`
    : `${Math.max(0, Math.round(bytes / 1024 ** 2))} МБ`;
  return {upload, fingerprint, size};
});
