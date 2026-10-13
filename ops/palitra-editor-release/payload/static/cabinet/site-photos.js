/* Palitra: экран «Фото сайта» в кабинете (PALITRA-BOT-EDITOR-35). Без innerHTML с данными: только textContent/атрибуты.
   Порядок работы: whoami (CSRF) → состояние слотов → правки копятся в локальном черновике → «Сохранить» →
   PUT с baseRevision → повторное чтение и сверка всех слотов. Неизвестный результат блокирует новое сохранение
   до «Обновить состояние». */
(() => {
  'use strict';
  const model = window.PalitraPhotoModel;
  const core = window.PalitraSitePhotosCore;
  const byId = id => document.getElementById(id);
  const api = core.createApi(window.fetch.bind(window));
  const memory = new Map();
  const storage = (() => {
    try { const s = window.localStorage; s.setItem('palitra-sp-probe', '1'); s.removeItem('palitra-sp-probe'); return s; }
    catch (_) { return { getItem: k => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, String(v)), removeItem: k => memory.delete(k) }; }
  })();
  const LABELS = { desktop: 'Компьютер · горизонтальный 16:9', tablet: 'Планшет · горизонтальный 4:3', mobile: 'Телефон · вертикальный' };

  let identity = null;
  let state = null;
  let draft = null;
  let busy = false;
  let needsReload = false;

  const say = text => { byId('status').textContent = text || ''; };
  const showError = text => { byId('error').textContent = text || ''; };
  const canEdit = () => Boolean(state && state.canEdit) && !needsReload && !busy;

  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'onclick') node.addEventListener('click', value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children) if (child) node.append(child);
    return node;
  };

  /* Превью без обрезки: object-fit: contain в CSS, фото целиком. */
  const photo = (url, alt, caption) => {
    const img = el('img', { src: url, alt: alt || '', loading: 'lazy', decoding: 'async' });
    const figure = el('figure', { class: 'sp-photo' }, img, caption ? el('figcaption', { text: caption }) : null);
    img.addEventListener('error', () => { figure.classList.add('is-broken'); img.alt = 'Превью недоступно'; }, { once: true });
    return figure;
  };
  const button = (text, onclick, options = {}) => el('button', { type: 'button', class: options.secondary ? 'secondary' : null, disabled: options.disabled || !canEdit(), 'aria-label': options.label, text, onclick });
  const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b);

  const persist = () => {
    if (!core.storeDraft(storage, draft)) showError('Браузер не дал сохранить черновик правок. Не закрывайте вкладку до сохранения');
  };
  const view = () => {
    const result = core.effectiveSlots(state.slots, draft);
    if (result.error) showError(`Черновик правок не проходит проверку: ${result.error}`);
    return result.slots;
  };

  /* ---------- Окно выбора фото ---------- */

  function openPicker(spec) {
    const dialog = byId('picker');
    const fields = byId('picker-fields');
    const altWrap = byId('picker-alt-wrap');
    const alt = byId('picker-alt');
    const errorBox = byId('picker-error');
    const picks = {};
    const locals = [];
    const opener = document.activeElement;
    byId('picker-title').textContent = spec.title;
    errorBox.textContent = '';
    fields.replaceChildren();
    altWrap.hidden = !spec.alt;
    alt.value = spec.alt ? spec.alt.value || '' : '';
    alt.required = Boolean(spec.alt && spec.alt.required);

    const uploadsOff = state.decoder === false;
    for (const field of spec.fields) {
      const preview = el('div', { class: 'sp-picker__preview' }, el('p', { class: 'sp-help', text: 'Фото не выбрано' }));
      const info = el('p', { class: 'sp-help', 'aria-live': 'polite', text: uploadsOff ? 'Загрузка новых фото пока отключена: проверка фото на сервере не подключена. Можно указать адрес фото, которое уже стоит на сайте' : '' });
      const fileInput = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', disabled: uploadsOff, 'aria-label': `${field.label}: файл с устройства` });
      const urlInput = el('input', { type: 'url', inputmode: 'url', autocomplete: 'off', placeholder: 'https://synapse.synapsebusiness.ru/content/publishing-assets/palitra-love/…', 'aria-label': `${field.label}: адрес из хранилища материалов` });
      const accept = (image, previewUrl) => {
        if (field.orientation === 'landscape' && image.width <= image.height) { info.textContent = `Нужен горизонтальный кадр, а это ${image.width}×${image.height}`; return; }
        if (field.orientation === 'portrait' && image.height <= image.width) { info.textContent = `Нужен вертикальный кадр, а это ${image.width}×${image.height}`; return; }
        picks[field.key] = image;
        preview.replaceChildren(photo(previewUrl || image.url, '', `${image.width}×${image.height}`));
        info.textContent = 'Фото выбрано. Оригинал сохраняется целиком, без обрезки';
      };
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        delete picks[field.key];
        info.textContent = 'Загружаем фото в хранилище материалов…';
        const result = await core.upload({ api, csrfToken: identity.csrfToken, file });
        if (result.status !== 'ok') {
          const hint = result.status === 'unknown' ? ' Результат неизвестен — выберите файл ещё раз.' : '';
          info.textContent = `${result.message}.${hint} Правки на странице не потеряны`;
          return;
        }
        const local = URL.createObjectURL(file);
        locals.push(local);
        accept(result.image, local);
      });
      const check = el('button', { type: 'button', class: 'secondary', text: 'Проверить адрес' });
      check.addEventListener('click', () => {
        delete picks[field.key];
        const value = urlInput.value.trim();
        try { model.checkUrl(value); } catch (error) { info.textContent = error.message; return; }
        info.textContent = 'Проверяем фото…';
        const probe = new Image();
        probe.onload = () => accept({ url: value, width: probe.naturalWidth, height: probe.naturalHeight });
        probe.onerror = () => { info.textContent = 'Фото по этому адресу не открылось'; };
        probe.src = value;
      });
      fields.append(el('fieldset', { class: 'sp-picker__field' },
        el('legend', { text: field.optional ? `${field.label} — необязательно` : field.label }),
        preview, el('label', { class: 'sp-field', text: 'Файл с устройства' }, fileInput),
        el('label', { class: 'sp-field', text: 'Или адрес уже загруженного фото' }, urlInput), check, info));
    }

    return new Promise(resolve => {
      const form = byId('picker-form');
      const close = value => {
        form.removeEventListener('submit', submit);
        byId('picker-cancel').removeEventListener('click', cancel);
        dialog.removeEventListener('cancel', cancel);
        dialog.close();
        locals.forEach(url => URL.revokeObjectURL(url));
        if (opener && opener.focus) opener.focus();
        resolve(value);
      };
      const cancel = event => { if (event) event.preventDefault(); close(null); };
      const submit = event => {
        event.preventDefault();
        const missing = spec.fields.filter(field => !field.optional && !picks[field.key]);
        if (missing.length) { errorBox.textContent = `Выберите фото: ${missing.map(field => field.label).join(', ')}`; return; }
        let altValue = '';
        if (spec.alt) {
          try { altValue = model.checkAlt(alt.value, spec.alt.required); } catch (error) { errorBox.textContent = error.message; alt.focus(); return; }
        }
        close({ images: { ...picks }, alt: altValue });
      };
      form.addEventListener('submit', submit);
      byId('picker-cancel').addEventListener('click', cancel);
      dialog.addEventListener('cancel', cancel);
      dialog.showModal();
    });
  }

  /* ---------- Правки ---------- */

  const commit = next => {
    const check = core.effectiveSlots(state.slots, next);
    if (check.error) { showError(check.error); return; }
    showError('');
    draft = next;
    persist();
    render();
  };

  async function editHero(scene) {
    const result = await openPicker({ title: `Сцена «${scene.label}»`, fields: [
      { key: 'desktop', label: LABELS.desktop, orientation: 'landscape' },
      { key: 'tablet', label: LABELS.tablet, orientation: 'landscape' },
      { key: 'mobile', label: LABELS.mobile, orientation: 'portrait' }], alt: null });
    if (result) commit(core.upsert(draft, { type: 'hero.scene', scene: scene.scene, ...result.images }));
  }

  async function editCategory(card) {
    const result = await openPicker({ title: `Категория «${card.title}»`, fields: [
      { key: 'main', label: 'Фото карточки' },
      { key: 'mobile', label: 'Отдельное фото для телефона', optional: true }], alt: { required: false, value: card.alt } });
    if (!result) return;
    const op = { type: 'category.photo', category: card.key, ...result.images.main, alt: result.alt };
    if (result.images.mobile) op.mobile = result.images.mobile;
    commit(core.upsert(draft, op));
  }

  async function editBudget(card) {
    const result = await openPicker({ title: `Карточка «${card.ariaLabel}»`, fields: [{ key: 'main', label: 'Фото карточки' }], alt: { required: true, value: card.alt } });
    if (result) commit(core.upsert(draft, { type: 'budget.photo', index: card.index, ...result.images.main, alt: result.alt }));
  }

  /* Только подпись категории: фото и его ролик не меняются (F04). Если фото уже заменено в черновике правок —
     подпись дописывается в ту же правку, выбранные фото сохраняются. */
  async function editCategoryAlt(card) {
    const target = `category:${card.key}`;
    const pending = draft.operations.find(op => core.targetOf(op) === target);
    const result = await openPicker({ title: `Подпись категории «${card.title}»`, fields: [], alt: { required: false, value: card.alt } });
    if (!result) return;
    const saved = state.slots.categories.find(item => item.key === card.key);
    commit(core.upsert(draft, pending ? { ...pending, alt: result.alt } : { type: 'category.photo', category: card.key, url: saved.src, width: saved.width, height: saved.height, alt: result.alt }));
  }

  const setGallery = (items, removed = draft.removed) => commit({ ...core.setGallery(draft, state.slots, items), removed });

  async function galleryPhoto(index) {
    const items = view().gallery;
    const current = index === null ? null : items[index];
    const result = await openPicker({ title: current ? `Заменить фото №${index + 1}` : 'Добавить фото в «Ваши праздники»', fields: [{ key: 'main', label: 'Фото праздника' }], alt: { required: true, value: current ? current.alt : '' } });
    if (!result) return;
    const item = { ...result.images.main, alt: result.alt };
    if (items.some((other, i) => other.url === item.url && i !== index)) { showError('Это фото уже есть в галерее'); return; }
    const next = items.slice();
    if (current) next[index] = item; else next.push(item);
    // Заменённое фото не удаляется из хранилища: его можно вернуть из «Убрано из показа».
    setGallery(next, current ? [...draft.removed.filter(old => old.url !== current.url), current] : draft.removed);
  }

  const move = (index, delta) => {
    const items = view().gallery.slice();
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    [items[index], items[target]] = [items[target], items[index]];
    setGallery(items);
    const focusTarget = document.querySelector(`[data-gallery-move="${target}:${delta}"]`) || document.querySelector(`[data-gallery-row="${target}"] button`);
    if (focusTarget) focusTarget.focus();
  };

  const removeFromView = index => {
    const items = view().gallery.slice();
    if (items.length <= model.GALLERY_MIN) { showError(`В галерее должно остаться не меньше ${model.GALLERY_MIN} фото`); return; }
    const [removed] = items.splice(index, 1);
    setGallery(items, [...draft.removed.filter(old => old.url !== removed.url), removed]);
  };

  const restore = url => {
    const items = view().gallery.slice();
    const back = draft.removed.find(item => item.url === url);
    if (!back) return;
    if (items.length >= model.GALLERY_MAX) { showError(`В галерее не больше ${model.GALLERY_MAX} фото`); return; }
    if (!items.some(item => item.url === url)) items.push(back);
    setGallery(items, draft.removed.filter(item => item.url !== url));
  };

  const renameAlt = (index, value) => {
    const items = view().gallery.slice();
    let alt;
    try { alt = model.checkAlt(value, true); } catch (error) { showError(`Фото №${index + 1}: ${error.message}`); render(); return; }
    items[index] = { ...items[index], alt };
    setGallery(items);
  };

  /* ---------- Отрисовка ---------- */

  function render() {
    const slots = view();
    const editable = canEdit();
    const count = draft.operations.length;
    byId('pending').textContent = count ? `Несохранённых правок: ${count}. Они хранятся в этом браузере до сохранения` : 'Несохранённых правок нет';
    byId('save').disabled = !editable || !count;
    byId('discard').disabled = busy || (!count && !draft.removed.length);
    byId('readonly').hidden = Boolean(state.canEdit);
    byId('decoder-off').hidden = state.decoder !== false;
    byId('access-link').hidden = !state.owner;
    byId('conflict').hidden = !(count && draft.baseRevision !== state.revision);
    byId('rebase').disabled = busy || !state.canEdit;

    byId('hero-list').replaceChildren(...slots.hero.map((scene, i) => {
      const dirty = changed(scene, state.slots.hero[i]);
      return el('article', { class: `sp-card${dirty ? ' is-dirty' : ''}` },
        el('h3', { text: `${scene.scene}. ${scene.label}` }), dirty ? el('p', { class: 'sp-badge', text: 'Изменено, не сохранено' }) : null,
        el('div', { class: 'sp-formats' }, ...model.HERO_FORMATS.map(format => photo(scene.formats[format], '', LABELS[format]))),
        el('div', { class: 'sp-row' }, button('Заменить сцену', () => editHero(scene)),
          dirty ? button('Вернуть как было', () => commit(core.dropTarget(draft, `hero:${scene.scene}`)), { secondary: true }) : null));
    }));

    byId('category-list').replaceChildren(...slots.categories.map((card, i) => {
      const dirty = changed(card, state.slots.categories[i]);
      return el('article', { class: `sp-card${dirty ? ' is-dirty' : ''}` },
        photo(card.src, card.alt, `${card.width}×${card.height}`), el('h3', { text: card.title }),
        el('p', { class: 'sp-help', text: card.motion ? 'Ролик при наведении: есть' : dirty ? 'Ролик прежнего набора будет отключён' : 'Ролика нет, фото плавно движется' }),
        el('p', { class: 'sp-help', text: 'Порядок категорий на главной задаётся в редакторе прайса' }),
        dirty ? el('p', { class: 'sp-badge', text: 'Изменено, не сохранено' }) : null,
        el('div', { class: 'sp-row' }, button('Заменить фото', () => editCategory(state.slots.categories[i])),
          button('Подпись', () => editCategoryAlt(card), { secondary: true, label: `Подпись категории «${card.title}»` }),
          dirty ? button('Вернуть как было', () => commit(core.dropTarget(draft, `category:${card.key}`)), { secondary: true }) : null));
    }));

    byId('budget-list').replaceChildren(...slots.budget.map((card, i) => {
      const dirty = changed(card, state.slots.budget[i]);
      return el('article', { class: `sp-card${dirty ? ' is-dirty' : ''}` },
        photo(card.src, card.alt, `${card.width}×${card.height}`), el('h3', { text: card.ariaLabel }),
        el('p', { class: 'sp-help', text: `Подпись: ${card.alt || '—'}` }), dirty ? el('p', { class: 'sp-badge', text: 'Изменено, не сохранено' }) : null,
        el('div', { class: 'sp-row' }, button('Заменить фото', () => editBudget(card)),
          dirty ? button('Вернуть как было', () => commit(core.dropTarget(draft, `budget:${card.index}`)), { secondary: true }) : null));
    }));

    const gallery = slots.gallery;
    byId('gallery-list').replaceChildren(...gallery.map((item, index) => {
      const alt = el('input', { value: item.alt, maxlength: model.ALT_MAX, disabled: !editable, 'aria-label': `Подпись фото №${index + 1}` });
      alt.addEventListener('change', () => renameAlt(index, alt.value));
      return el('li', { class: 'sp-gallery__item', 'data-gallery-row': index },
        photo(item.url, item.alt, `${item.width}×${item.height}`),
        el('p', { class: 'sp-badge sp-badge--soft', text: index < model.GALLERY_INITIAL ? 'Видно сразу' : 'Под кнопкой «Показать ещё»' }),
        el('label', { class: 'sp-field', text: 'Подпись' }, alt),
        el('div', { class: 'sp-row' },
          el('button', { type: 'button', class: 'secondary', 'data-gallery-move': `${index}:-1`, disabled: !editable || index === 0, 'aria-label': `Фото №${index + 1} выше`, text: '↑', onclick: () => move(index, -1) }),
          el('button', { type: 'button', class: 'secondary', 'data-gallery-move': `${index}:1`, disabled: !editable || index === gallery.length - 1, 'aria-label': `Фото №${index + 1} ниже`, text: '↓', onclick: () => move(index, 1) }),
          button('Заменить', () => galleryPhoto(index), { secondary: true, label: `Заменить фото №${index + 1}` }),
          button('Убрать из показа', () => removeFromView(index), { secondary: true, disabled: gallery.length <= model.GALLERY_MIN, label: `Убрать из показа фото №${index + 1}` })));
    }));
    byId('gallery-add').disabled = !editable || gallery.length >= model.GALLERY_MAX;
    const removed = draft.removed.filter(item => !gallery.some(shown => shown.url === item.url));
    byId('gallery-removed').replaceChildren(...removed.map(item => el('li', { class: 'sp-gallery__item' }, photo(item.url, item.alt, item.alt),
      el('div', { class: 'sp-row' }, button('Вернуть в показ', () => restore(item.url), { secondary: true })))));
    byId('gallery-removed-empty').hidden = removed.length > 0;
  }

  /* ---------- Сохранение и состояние ---------- */

  /* После подтверждённого сохранения правки очищаются, а список «Убрано из показа» остаётся,
     чтобы убранное фото можно было вернуть и позже (сам материал в хранилище не удаляется). */
  const afterSave = () => {
    const next = { ...core.emptyDraft(state.revision), removed: draft ? draft.removed.filter(item => !state.slots.gallery.some(shown => shown.url === item.url)) : [] };
    core.clearDraft(storage);
    core.storeDraft(storage, next);
    return next;
  };

  const applyState = data => {
    state = data;
    const open = byId('open-site');
    if (/^https:\/\/(?:[a-z0-9-]+-draft-\d+|palitra-draft)\.synapsebusiness\.ru\/$/.test(String(data.publicUrl || ''))) { open.href = data.publicUrl; open.hidden = false; }
    else open.hidden = true;
  };

  async function reload() {
    busy = true; render();
    const fresh = await api.state();
    busy = false;
    if (fresh.kind !== 'ok') { showError(`${fresh.message}. Черновик правок сохранён в браузере`); render(); return false; }
    applyState(fresh.data);
    needsReload = false;
    // После неизвестного результата: если сохранённое состояние уже совпадает с ожидаемым — правки записаны.
    if (draft.expected && model.slotsEqual(state.slots, draft.expected)) {
      draft = afterSave();
      say(`Правки уже сохранены в черновик (версия ${state.version}), подтверждено чтением`);
    } else {
      if (!draft.operations.length) draft = { ...draft, baseRevision: state.revision };
      say(`Версия черновика ${state.version}. Состояние прочитано заново`);
    }
    showError('');
    render();
    return true;
  }

  async function save() {
    if (!canEdit() || !draft.operations.length) return;
    let expected;
    try { expected = model.projectSlots(state.slots, draft.operations); } catch (error) { showError(error.message); return; }
    draft = { ...draft, expected };
    persist();
    busy = true; showError(''); say('Сохраняем и проверяем…'); render();
    const result = await core.save({ api, csrfToken: identity.csrfToken, state, draft, message: byId('save-message').value });
    busy = false;
    if (result.status === 'saved') {
      applyState(result.state);
      draft = afterSave();
      byId('save-message').value = '';
      say(result.message);
    } else {
      if (result.state) applyState(result.state);
      if (result.status === 'unknown') needsReload = true;
      if (result.status === 'failed' || result.status === 'invalid' || result.status === 'conflict') { draft = { ...draft, expected: undefined }; persist(); }
      const extra = result.status === 'session' ? ' Войдите в кабинет в этой же вкладке браузера и вернитесь сюда.' : result.status === 'unknown' || result.status === 'conflict' ? ' Нажмите «Обновить состояние».' : '';
      showError(`${result.message}.${extra}`);
      say('Правки не потеряны: они хранятся в этом браузере');
    }
    render();
  }

  byId('save').addEventListener('click', save);
  byId('reload').addEventListener('click', reload);
  byId('discard').addEventListener('click', () => {
    if (!confirm('Отменить все несохранённые правки фото? Загруженные фото останутся в хранилище материалов.')) return;
    draft = core.emptyDraft(state.revision); core.clearDraft(storage); showError(''); render();
  });
  byId('rebase').addEventListener('click', () => {
    if (!confirm('Перенести ваши правки на новую версию черновика? В изменённых вами местах ваши фото заменят фото новой версии.')) return;
    commit({ ...draft, baseRevision: state.revision, expected: undefined });
  });
  byId('gallery-add').addEventListener('click', () => galleryPhoto(null));
  window.addEventListener('beforeunload', event => { if (draft && draft.operations.length) { event.preventDefault(); event.returnValue = ''; } });

  (async () => {
    const who = await api.whoami();
    if (who.kind !== 'ok' || !who.data.csrfToken) {
      byId('status').textContent = '';
      showError(who.kind === 'session' || who.status === 401 ? 'Войдите в кабинет Synapse своим аккаунтом и откройте эту страницу снова' : `Кабинет недоступен: ${who.message}`);
      return;
    }
    identity = who.data;
    const loaded = await api.state();
    if (loaded.kind !== 'ok') {
      say('');
      showError(loaded.kind === 'forbidden' ? 'У вашего аккаунта нет доступа к фото сайта Palitra. Доступ выдаёт администратор кабинета' : loaded.message);
      return;
    }
    applyState(loaded.data);
    draft = core.loadDraft(storage) || core.emptyDraft(state.revision);
    if (draft.expected && model.slotsEqual(state.slots, draft.expected)) { draft = afterSave(); }
    byId('workspace').hidden = false;
    say(`Версия черновика ${state.version}.${draft.operations.length ? ' Восстановлены несохранённые правки из этого браузера' : ''}`);
    render();
  })();
})();
