/* Additive Palitra catalog import. Authentication stays in the editor's request wrapper. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PalitraCatalogImport = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const PRICE = '/content/palitra/price';
  const ASSETS = '/content/palitra/assets';
  const MAX_ASSET = 8 * 1024 * 1024;
  const MAX_DOCUMENT = 1024 * 1024;
  const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);

  function validatePacket(packet) {
    if (!object(packet) || packet.format !== 'palitra-catalog-import-v1') {
      throw new Error('Нужен файл импорта Palitra (palitra-catalog-import-v1).');
    }
    if (!Number.isInteger(packet.expectedVersion) || packet.expectedVersion < 1) {
      throw new Error('В файле не указана исходная версия прайса expectedVersion.');
    }
    if (!Array.isArray(packet.items) || !packet.items.length) throw new Error('Список товаров пуст.');
    const ids = new Set();
    for (const entry of packet.items) {
      const item = entry?.item;
      if (typeof entry?.categoryId !== 'string' || !entry.categoryId.trim() || !object(item)) {
        throw new Error('У товара не указан раздел или карточка item.');
      }
      if (typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(item.id)) {
        throw new Error('У товара отсутствует допустимый постоянный id.');
      }
      if (ids.has(item.id)) throw new Error(`В файле повторяется id: ${item.id}.`);
      ids.add(item.id);
      if (typeof item.title !== 'string' || !item.title.trim()) {
        throw new Error(`У товара ${item.id} пустое название.`);
      }
      for (const key of ['price', 'oldPrice', 'desc', 'card', 'composition', 'who', 'duration', 'note']) {
        if (item[key] != null && typeof item[key] !== 'string') {
          throw new Error(`Товар ${item.id}: поле ${key} должно быть строкой.`);
        }
      }
      if (item.quizEnabled != null && typeof item.quizEnabled !== 'boolean') {
        throw new Error(`Товар ${item.id}: неверное значение quizEnabled.`);
      }
      const asset = entry.asset;
      if (!object(asset) || !TYPES.has(asset.mimeType) || typeof asset.filename !== 'string' ||
          !asset.filename.trim() || asset.filename.length > 240 || typeof asset.base64 !== 'string') {
        throw new Error(`Товар ${item.id}: нужен файл JPEG, PNG или WebP.`);
      }
      const encoded = asset.base64;
      const size = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
      if (!encoded.length || encoded.length % 4 || size > MAX_ASSET ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        throw new Error(`Товар ${item.id}: фотография повреждена или превышает 8 МБ.`);
      }
    }
    return packet;
  }

  function planImport(document, packet) {
    validatePacket(packet);
    if (!object(document) || !Array.isArray(document.categories)) {
      throw new Error('Не удалось прочитать действующий каталог.');
    }
    const categories = new Map(document.categories.map((category) => [category.id, category]));
    const categoryIds = new Set(categories.keys());
    const itemIds = new Set(document.categories.flatMap((category) => (category.items || []).map((item) => item.id)));
    const additions = [];
    let skipped = 0;
    for (const entry of packet.items) {
      if (categoryIds.has(entry.item.id)) throw new Error(`ID товара совпадает с разделом: ${entry.item.id}.`);
      if (itemIds.has(entry.item.id)) { skipped += 1; continue; }
      if (!categories.has(entry.categoryId)) throw new Error(`Не найден раздел ${entry.categoryId}.`);
      additions.push(entry);
    }
    // A completed packet may be retried after a lost response without creating another version.
    if (additions.length && document.version !== packet.expectedVersion) {
      throw new Error(`Каталог изменился: в файле версия ${packet.expectedVersion}, на сайте ${document.version}. Подготовьте файл заново по текущему каталогу.`);
    }
    return { additions, skipped, total: packet.items.length };
  }

  function mergeImport(document, additions, uploaded) {
    const merged = clone(document);
    const categories = new Map(merged.categories.map((category) => [category.id, category]));
    for (const entry of additions) {
      const photo = uploaded.get(entry.item.id);
      if (typeof photo !== 'string' || !/^\/api\/assets\/[a-zA-Z0-9_.-]+$/.test(photo)) {
        throw new Error(`Не подтверждена загрузка фотографии ${entry.item.id}.`);
      }
      const category = categories.get(entry.categoryId);
      if (!category) throw new Error(`Не найден раздел ${entry.categoryId}.`);
      (category.items ||= []).push({ ...clone(entry.item), price: entry.item.price ?? '', photo });
    }
    if (bytes(merged) > MAX_DOCUMENT) throw new Error('Описание каталога превышает 1 МБ. Сократите служебные данные в файле.');
    return merged;
  }

  async function runImport(packet, apiFetch, options = {}) {
    const uploaded = options.uploaded || new Map();
    const progress = options.onProgress || (() => {});
    const original = await apiFetch(PRICE);
    const plan = planImport(original, packet);
    if (!plan.additions.length) return { added: 0, skipped: plan.skipped, document: original };
    // Reject oversized metadata before uploading any files; base64 never enters the saved document.
    mergeImport(original, plan.additions, new Map(plan.additions.map((entry) =>
      [entry.item.id, '/api/assets/' + 'x'.repeat(220) + '.jpg'])));
    let next = 0;
    let completed = plan.additions.filter((entry) => uploaded.has(entry.item.id)).length;
    let failure = null;
    progress({ stage: 'upload', completed, total: plan.additions.length });
    async function worker() {
      while (!failure && next < plan.additions.length) {
        const entry = plan.additions[next++];
        if (uploaded.has(entry.item.id)) continue;
        try {
          const raw = atob(entry.asset.base64);
          const body = new Blob([Uint8Array.from(raw, (char) => char.charCodeAt(0))], { type: entry.asset.mimeType });
          const result = await apiFetch(ASSETS, {
            method: 'POST',
            headers: { 'Content-Type': entry.asset.mimeType, 'X-Filename': encodeURIComponent(entry.asset.filename) },
            body,
          });
          if (!/^\/api\/assets\/[a-zA-Z0-9_.-]+$/.test(result?.url || '')) {
            throw new Error('Сервер не подтвердил адрес загруженной фотографии.');
          }
          uploaded.set(entry.item.id, result.url);
          completed += 1;
          progress({ stage: 'upload', completed, total: plan.additions.length });
        } catch (error) { failure ||= error; }
      }
    }
    // Wait for every started upload before showing Retry, so two attempts cannot overlap.
    await Promise.all(Array.from({ length: Math.min(3, plan.additions.length) }, () => worker()));
    if (failure) throw failure;
    progress({ stage: 'save', completed, total: plan.additions.length });
    const latest = await apiFetch(PRICE);
    if (JSON.stringify(latest) !== JSON.stringify(original)) {
      throw new Error('Каталог изменился во время загрузки фотографий. Импорт остановлен, чужие изменения сохранены. Подготовьте файл по новой версии.');
    }
    const merged = mergeImport(latest, plan.additions, uploaded);
    await apiFetch(PRICE, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(merged) });
    progress({ stage: 'verify', completed, total: plan.additions.length });
    const saved = await apiFetch(PRICE);
    const withoutVersion = (value) => {
      const copy = clone(value);
      delete copy.version;
      delete copy.updatedAt;
      return copy;
    };
    if (JSON.stringify(withoutVersion(saved)) !== JSON.stringify(withoutVersion(merged))) {
      throw new Error('Сервер принял импорт, но повторная проверка отличается. Проверьте текущий каталог перед повтором.');
    }
    return { added: plan.additions.length, skipped: plan.skipped, document: saved };
  }

  function attach(context) {
    const button = document.getElementById('ed-import');
    const input = document.getElementById('ed-import-file');
    if (!button || !input) return;
    const modal = document.createElement('div');
    modal.className = 'ed-modal';
    modal.id = 'ed-import-modal';
    modal.innerHTML = '<div class="ed-modal__box" role="dialog" aria-modal="true" aria-labelledby="ed-import-title">' +
      '<h3 id="ed-import-title">Загрузка товаров</h3><p id="ed-import-summary"></p>' +
      '<p id="ed-import-progress" class="ed-status" role="status" aria-live="polite"></p>' +
      '<div class="ed-import-actions"><button type="button" class="ed-btn ed-btn--main" id="ed-import-apply" disabled>Импортировать</button>' +
      '<button type="button" class="ed-btn" id="ed-import-close">Закрыть</button></div></div>';
    document.body.appendChild(modal);
    const summary = modal.querySelector('#ed-import-summary');
    const status = modal.querySelector('#ed-import-progress');
    const apply = modal.querySelector('#ed-import-apply');
    const close = modal.querySelector('#ed-import-close');
    let packet = null;
    let uploaded = new Map();
    let busy = false;
    function ready() {
      const state = context.getState();
      if (!state.session || !state.data) throw new Error('Сначала войдите в кабинет и дождитесь загрузки прайса.');
      if (state.dirty || state.editing) throw new Error('Завершите редактирование карточки и сохраните изменения перед импортом.');
    }
    function message(text, error = false) {
      status.textContent = text;
      status.className = 'ed-status' + (error ? ' is-error' : '');
    }
    button.addEventListener('click', () => {
      try { ready(); input.click(); } catch (error) { context.setStatus(error.message, 'error'); }
    });
    close.addEventListener('click', () => {
      if (!busy) { modal.classList.remove('is-open'); button.focus(); }
    });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file || busy) return;
      packet = null;
      uploaded = new Map();
      apply.disabled = true;
      apply.textContent = 'Импортировать';
      summary.textContent = file.name;
      modal.classList.add('is-open');
      message('Проверяю файл и текущий каталог…');
      try {
        ready();
        if (file.size > 384 * 1024 * 1024) throw new Error('Файл импорта превышает 384 МБ. Разделите фотографии на меньшие наборы.');
        packet = validatePacket(JSON.parse(await file.text()));
        const current = await context.apiFetch(PRICE);
        const plan = planImport(current, packet);
        const byCategory = new Map();
        for (const entry of plan.additions) byCategory.set(entry.categoryId, (byCategory.get(entry.categoryId) || 0) + 1);
        const sections = current.categories.filter((category) => byCategory.has(category.id))
          .map((category) => `${category.title}: ${byCategory.get(category.id)}`).join('; ');
        summary.textContent = `В файле ${plan.total} товаров. Добавить: ${plan.additions.length}. Уже есть: ${plan.skipped}.` +
          (sections ? ` Разделы: ${sections}.` : '') + ' Существующие карточки и витрины сохранятся.';
        apply.textContent = `Импортировать ${plan.additions.length} товаров`;
        apply.disabled = !plan.additions.length;
        message(plan.additions.length ? 'После нажатия фотографии и новые карточки появятся на сайте. Не закрывайте эту вкладку.' : 'Все товары из файла уже есть в каталоге.');
      } catch (error) { packet = null; message(error.message, true); }
    });
    apply.addEventListener('click', async () => {
      if (!packet || busy) return;
      try { ready(); } catch (error) { message(error.message, true); return; }
      busy = true;
      apply.disabled = true;
      close.disabled = true;
      context.setBusy(true);
      try {
        const result = await runImport(packet, context.apiFetch, { uploaded, onProgress(progress) {
          message(progress.stage === 'upload' ? `Загружаю фотографии: ${progress.completed} из ${progress.total}…` :
            progress.stage === 'save' ? 'Проверяю каталог и сохраняю новые товары…' : 'Проверяю сохранённый каталог…');
        } });
        await context.refresh();
        message(`Готово. Добавлено ${result.added} товаров; уже существовали ${result.skipped}. Версия ${result.document.version}.`);
        context.setStatus(`Импорт завершён: добавлено ${result.added} товаров.`, 'ok');
        packet = null;
      } catch (error) {
        message(`${error.message} Уже загруженные фото (${uploaded.size}) сохраняются для повтора в этом окне.`, true);
        apply.textContent = 'Повторить импорт';
        apply.disabled = false;
      } finally {
        busy = false;
        close.disabled = false;
        context.setBusy(false);
      }
    });
  }

  return { validatePacket, planImport, mergeImport, runImport, attach };
});
