/* «Исходники» Контент завода: библиотека приватных файлов компании.
   CF13: обычная загрузка без Telegram (последовательная очередь, один файл за запрос), сведения исходника
   с ревизией, прикрепление готового материала к публикации и «Где использован». Telegram и прежний ручной
   импорт — дополнительные входы той же библиотеки. Модуль ничего не публикует и не согласует; все записи
   идут через зависимости, которые адаптер вида ограничивает текущей компанией. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SbCabinet = root.SbCabinet || {}).telegramSources = api;
}(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  // Готовый материал для публикации — только эти типы (их проверяет и сервер). MOV/PDF остаются исходниками.
  const READY_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']);
  const FORMATS = [['', 'Не выбран'], ['post', 'Пост'], ['story', 'Сторис'], ['reel', 'Reels / Shorts / клип'], ['carousel', 'Карусель']];
  const ROLES = [['', 'Не выбрана'], ['reach', 'Охват'], ['affection', 'Влюбление'], ['sale', 'Продажи']];
  const HINTS = {
    files: ['Файлы', 'Можно выбрать или перетащить несколько файлов: они загрузятся по очереди, по одному.', 'фото готовой композиции и видео сборки.'],
    caption: ['Подпись', 'Коротко, что на файле. Необязательно.', 'Фотозона к выпускному, зал «Лофт».'],
    materialState: ['Что это за файл', '«Исходник» — материал для будущего монтажа или идеи. «Готовый материал» — файл, который можно сразу прикрепить к публикации.', 'готовое видео 9:16 после монтажа.'],
    platforms: ['Площадки', 'Где файл может пригодиться. Можно несколько. Ничего не отмечено — «Пока не выбрано».', 'Telegram и ВКонтакте.'],
    formats: ['Форматы', 'Для каких видов публикаций подходит файл. Можно несколько или ничего.', 'Сторис и Reels / Shorts / клип.'],
    occasion: ['Повод или товар', 'К какому событию или товару относится файл.', 'выписка из роддома, набор «Нежность».'],
    eventDate: ['Дата события', 'Когда было или будет событие на файле. Необязательно.', '2026-10-15.'],
    usageRestrictions: ['Ограничения использования', 'Что нельзя делать с файлом.', 'без лиц детей; только с разрешения клиента.'],
    attachTarget: ['Куда прикрепить', 'Новый черновик создаётся без даты и согласования. В существующей карточке файл добавится к её материалам.', 'новый черновик «Фотозона к выпускному».'],
    attachTitle: ['Название черновика', 'Как карточка будет называться на доске. Можно изменить потом.', 'Фотозона к выпускному.'],
    attachFormat: ['Формат', 'Вид будущей публикации. Можно выбрать позже в карточке.', 'Reels / Shorts / клип.'],
    attachRole: ['Цель (ОВП)', 'Охват — привлечь новых, Влюбление — укрепить доверие, Продажи — подтолкнуть к заказу.', 'Продажи.'],
    attachPost: ['Карточка', 'Карточка этой компании, к которой добавится файл.', '№12 · Отзыв клиента о празднике.'],
  };
  const KNOWN_STATUS = {stored: 'Файл сохранён', text: 'Текст сохранён', manual_import: 'Нужен ручной импорт'};
  const mb = (bytes) => (bytes / 1024 / 1024).toLocaleString('ru-RU', {maximumFractionDigits: 1});
  const sizeText = (bytes) => bytes >= 1024 * 1024 ? `${mb(bytes)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  const limitText = (bytes) => bytes >= 1024 * 1024 ? `${mb(bytes)} МиБ` : `${Math.max(1, Math.round(bytes / 1024))} КиБ`;
  const key = () => {
    const bytes = new Uint8Array(16);
    (globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(bytes) : bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256); }));
    return 'src-' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const transient = (status) => !status || status === 408 || status === 429 || status >= 500;

  function mount({element, companyCode, request, upload, send, uploadFile, openPost}) {
    if (!/^[a-z0-9_-]{1,64}$/.test(companyCode) || typeof request !== 'function') throw new Error('Не указан проект исходников');
    const doc = element.ownerDocument; let stopped = false, loading = false, cursor = null, sending = false, manualLimit = 0;
    let data = null, running = false, hintSeq = 0;
    const items = new Map(), queue = [], panels = new Map();
    const make = (tag, text) => { const node = doc.createElement(tag); if (text) node.textContent = text; return node; };
    const button = (text, attrs = {}) => { const node = make('button', text); node.type = 'button'; for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); return node; };
    // «?» у поля: зачем → пример. Доступна мышью, клавиатурой и нажатием.
    function hint(id) {
      const [label, why, example] = HINTS[id], noteId = `src-hint-${++hintSeq}`;
      const toggle = button('?', {class: 'cf-hint', 'aria-label': `Подсказка: ${label}`, 'aria-expanded': 'false', 'aria-controls': noteId});
      const note = make('span', `${why} Например: ${example}`); note.id = noteId; note.className = 'cf-hint-text'; note.setAttribute('role', 'note'); note.hidden = true;
      toggle.addEventListener('click', () => { const open = toggle.getAttribute('aria-expanded') !== 'true'; toggle.setAttribute('aria-expanded', String(open)); note.hidden = !open; });
      return [toggle, note];
    }
    function labelRow(text, id, forId) {
      const row = make('div'); row.className = 'cf-label-row';
      const label = make(forId ? 'label' : 'span', text); if (forId) label.htmlFor = forId; else label.id = `${forId || 'src'}-${hintSeq + 1}-title`;
      row.append(label, ...hint(id)); return row;
    }
    const canEdit = () => Boolean(data?.uploadAllowed) && typeof send === 'function';
    const canUpload = () => Boolean(data?.uploadAllowed) && typeof uploadFile === 'function';
    const ownItem = (item) => item && Number.isSafeInteger(item.id) && item.id > 0 && (item.companyCode === undefined || item.companyCode === companyCode);

    /* ---------- Поля сведений (общие для загрузки и изменения) ---------- */
    function metaFields(prefix, values = {}) {
      const box = make('div'); box.className = 'src-meta';
      const vocab = data?.metadataVocabulary || {platforms: [], formats: []};
      const state = make('div'); state.className = 'cf-field'; state.setAttribute('role', 'radiogroup');
      const stateTitle = labelRow('Что это за файл', 'materialState'); state.setAttribute('aria-labelledby', stateTitle.firstChild.id);
      const choices = make('div'); choices.className = 'src-choices';
      for (const [value, text] of [['source', 'Исходник'], ['ready', 'Готовый материал']]) {
        const label = make('label'); label.className = 'cf-check'; const input = make('input');
        input.type = 'radio'; input.name = `${prefix}-materialState`; input.value = value; input.checked = (values.materialState || 'source') === value;
        label.append(input, text); choices.append(label);
      }
      state.append(stateTitle, choices); box.append(state);
      for (const kind of ['platforms', 'formats']) {
        const group = make('div'); group.className = 'cf-field'; group.setAttribute('role', 'group');
        const title = labelRow(kind === 'platforms' ? 'Площадки' : 'Форматы', kind); group.setAttribute('aria-labelledby', title.firstChild.id);
        const list = make('div'); list.className = 'src-choices';
        for (const option of vocab[kind] || []) {
          const label = make('label'); label.className = 'cf-check'; const input = make('input');
          input.type = 'checkbox'; input.name = `${prefix}-${kind}`; input.value = option.id; input.checked = (values[kind] || []).includes(option.id);
          label.append(input, option.label || option.id); list.append(label);
        }
        const empty = make('p', 'Ничего не отмечено — «Пока не выбрано».'); empty.className = 'cf-note';
        group.append(title, list, empty); box.append(group);
      }
      for (const [name, text, tag, max] of [['occasion', 'Повод или товар', 'input', 500], ['eventDate', 'Дата события', 'input', 10], ['usageRestrictions', 'Ограничения использования', 'textarea', 2000]]) {
        const field = make('div'); field.className = 'cf-field'; const id = `${prefix}-${name}`;
        const input = make(tag); input.id = id; input.name = name; input.maxLength = max; input.value = values[name] || '';
        if (name === 'eventDate') input.type = 'date'; if (tag === 'textarea') input.rows = 2;
        field.append(labelRow(text, name, id), input); box.append(field);
      }
      return box;
    }
    function readMeta(scope, prefix) {
      const checked = (name) => [...scope.querySelectorAll(`[name="${prefix}-${name}"]:checked`)].map((node) => node.value);
      return {platforms: checked('platforms'), formats: checked('formats'), occasion: scope.querySelector('[name="occasion"]').value.trim(),
        eventDate: scope.querySelector('[name="eventDate"]').value.trim(), usageRestrictions: scope.querySelector('[name="usageRestrictions"]').value.trim(),
        materialState: scope.querySelector(`[name="${prefix}-materialState"]:checked`)?.value || 'source'};
    }
    function metaSummary(meta = {}) {
      const vocab = data?.metadataVocabulary || {};
      const names = (kind) => (meta[kind] || []).map((id) => (vocab[kind] || []).find((o) => o.id === id)?.label || id).join(', ') || 'пока не выбрано';
      const parts = [`Площадки: ${names('platforms')}`, `Форматы: ${names('formats')}`];
      if (meta.occasion) parts.push(`Повод: ${meta.occasion}`);
      if (meta.eventDate) parts.push(`Дата события: ${meta.eventDate.split('-').reverse().join('.')}`);
      if (meta.usageRestrictions) parts.push(`Ограничения: ${meta.usageRestrictions}`);
      return parts.join(' · ');
    }

    /* ---------- Каркас экрана ---------- */
    const heading = make('h3', 'Исходники'), status = make('p', 'Загружаем исходники…'); status.setAttribute('role', 'status');
    const work = make('section'); work.className = 'src-work'; work.setAttribute('aria-label', 'Загрузка материалов'); work.hidden = true;
    const workNote = make('p'); workNote.className = 'cf-note';
    const list = make('ul'); list.className = 'src-list';
    const more = button('Показать ещё'); more.hidden = true;
    const retry = button('Повторить загрузку'); retry.hidden = true;
    const telegram = make('details'); telegram.className = 'src-telegram';
    telegram.append(make('summary', 'Telegram и ручной импорт'),
      make('p', 'Telegram — дополнительный вход в ту же библиотеку: здесь появляются новые материалы после подключения. Старую историю бот не загружает. Публикации создаются и согласуются отдельно.'));
    // Прежний ручной импорт из Telegram (контракт manual-upload не менялся).
    const form = make('form'), importStatus = make('p'); form.hidden = true; importStatus.setAttribute('role', 'status');
    form.append(make('h4', 'Ручной импорт старого файла'), make('p', 'Выберите ранее скачанный файл. Это ручное пополнение приватного архива, а не автоматическая загрузка истории Telegram.'));
    const field = (label, input) => { const wrap = make('label', label); wrap.append(input); form.append(wrap); return input; };
    const mode = field('Происхождение ', make('select'));
    for (const [value, label] of [['link', 'Есть ссылка на сообщение'], ['archive', 'Старое сообщение без ссылки']]) { const option = make('option', label); option.value = value; mode.append(option); }
    const origin = field('Ссылка на сообщение Telegram ', make('input')); origin.type = 'url'; origin.name = 'telegramUrl'; origin.required = true; origin.placeholder = 'https://t.me/c/…/…';
    const source = field('Подключённый источник ', make('select')); source.name = 'sourceChatId';
    const provenance = field('Откуда этот файл: история беседы, дата, исходное имя ', make('textarea')); provenance.name = 'provenance'; provenance.maxLength = 1000;
    const manualFile = field('Файл ', make('input')); manualFile.type = 'file'; manualFile.name = 'file'; manualFile.required = true; manualFile.accept = '.jpg,.jpeg,.png,.webp,.mp4,.mov,.webm,.pdf';
    const limitNote = make('p'); form.append(limitNote);
    const submit = make('button', 'Сохранить в приватный архив'); submit.type = 'submit'; form.append(submit, importStatus);
    const chooseMode = () => { const legacy = mode.value === 'archive'; origin.parentElement.hidden = legacy; origin.required = !legacy; source.parentElement.hidden = !legacy; source.required = legacy; provenance.parentElement.hidden = !legacy; provenance.required = legacy; };
    mode.addEventListener('change', chooseMode); chooseMode();
    telegram.append(form);
    element.replaceChildren(heading, status, work, workNote, list, more, retry, telegram);

    /* ---------- Загрузка: рабочий экран и очередь ---------- */
    const fileInput = make('input'); fileInput.type = 'file'; fileInput.multiple = true; fileInput.hidden = true; fileInput.id = `src-files-${companyCode}`;
    const pick = button('Загрузить материалы', {class: 'src-pick'});
    const drop = make('div'); drop.className = 'src-drop'; drop.append(pick, make('span', ' или перетащите файлы сюда'), ...hint('files'));
    const limitsLine = make('p'); limitsLine.className = 'cf-note src-limits';
    const captionField = make('div'); captionField.className = 'cf-field';
    const caption = make('textarea'); caption.id = `src-caption-${companyCode}`; caption.rows = 2; caption.maxLength = 12000;
    captionField.append(labelRow('Подпись (необязательно)', 'caption', caption.id), caption);
    const extra = make('details'); extra.className = 'src-extra'; extra.append(make('summary', 'Дополнительные сведения'));
    const queueList = make('ul'); queueList.className = 'src-queue'; queueList.setAttribute('aria-label', 'Очередь загрузки');
    const start = button('Начать загрузку'), again = button('Повторить неудавшиеся'), clear = button('Убрать завершённые');
    const actions = make('div'); actions.className = 'cf-actions'; actions.append(start, again, clear);
    const queueState = make('p'); queueState.className = 'cf-note'; queueState.setAttribute('role', 'status');
    work.append(drop, fileInput, limitsLine, captionField, extra, queueList, actions, queueState);

    function setupWork() {
      const limits = data?.limits || {};
      const extensions = Array.isArray(limits.extensions) ? limits.extensions : [];
      fileInput.accept = extensions.join(',');
      const kinds = extensions.map((e) => e.replace('.', '').toUpperCase()).filter((e, i, all) => e !== 'JPEG' || !all.includes('JPG'));
      limitsLine.textContent = `${kinds.length ? `Форматы: ${kinds.join(', ')}. ` : ''}${Number.isSafeInteger(limits.maxFileBytes) ? `Один файл — до ${limitText(limits.maxFileBytes)}. ` : ''}Файлы загружаются по одному; исходник доступен только в кабинете.`;
      if (!extra.querySelector('.src-meta')) extra.append(metaFields('src-up'));
      work.hidden = !canUpload();
      workNote.textContent = canUpload() ? '' : 'Загрузка и изменение сведений доступны с правом «Автопостинг: правка». Просмотр и «Где использован» доступны.';
      renderQueue();
    }
    const STATE_TEXT = {waiting: 'ожидает', uploading: 'загружается', done: 'сохранён', duplicate: 'уже есть в библиотеке', error: 'ошибка'};
    function renderQueue() {
      queueList.replaceChildren(...queue.map((entry) => {
        const row = make('li'); row.className = `src-q src-q-${entry.state}`; row.dataset.queueState = entry.state;
        const percent = entry.state === 'uploading' && entry.total > 0 ? ` ${Math.min(100, Math.round(entry.loaded / entry.total * 100))}%` : '';
        const name = make('strong', entry.file.name); const state = make('span', ` · ${sizeText(entry.file.size)} · ${STATE_TEXT[entry.state]}${percent}`);
        row.append(name, state);
        if (entry.message) { const note = make('p', entry.message); note.className = entry.state === 'error' ? 'cf-error' : 'cf-note'; row.append(note); }
        if (!running && ['waiting', 'error'].includes(entry.state)) {
          const remove = button('Убрать', {'aria-label': `Убрать из очереди: ${entry.file.name}`});
          remove.addEventListener('click', () => { queue.splice(queue.indexOf(entry), 1); renderQueue(); }); row.append(remove);
        }
        return row;
      }));
      const count = (state) => queue.filter((e) => e.state === state).length;
      const failed = queue.filter((e) => e.state === 'error' && e.retryable).length;
      start.disabled = running || !count('waiting'); again.hidden = !failed; again.disabled = running;
      clear.hidden = !queue.some((e) => ['done', 'duplicate'].includes(e.state)); clear.disabled = running;
      queueState.textContent = !queue.length ? 'Выберите файлы — они появятся в очереди.' : running ? `Загружаем по одному: готово ${count('done') + count('duplicate')} из ${queue.length}.`
        : `В очереди ${queue.length}: ожидают ${count('waiting')}, сохранены ${count('done')}, уже были ${count('duplicate')}, с ошибкой ${count('error')}.`;
    }
    function addFiles(files) {
      if (stopped || !canUpload()) return;
      for (const file of files) queue.push({file, state: 'waiting', loaded: 0, total: 0, message: '', retryable: false, unknown: false});
      renderQueue();
    }
    function precheck(file) {
      const limits = data?.limits || {}, ext = (file.name.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
      if (Array.isArray(limits.extensions) && !limits.extensions.includes(ext)) return 'Формат не поддерживается библиотекой.';
      if (Number.isSafeInteger(limits.maxFileBytes) && file.size > limits.maxFileBytes) return `Файл больше ${limitText(limits.maxFileBytes)}.`;
      if (!file.size) return 'Файл пустой.';
      return '';
    }
    async function uploadOne(entry, params) {
      const local = precheck(entry.file);
      if (local) { Object.assign(entry, {state: 'error', retryable: false, message: `${local} Файл не отправлен.`}); return; }
      const body = new doc.defaultView.FormData();
      if (params.caption) body.set('caption', params.caption);
      body.set('metadata', JSON.stringify(params.metadata));
      body.set('file', entry.file, entry.file.name);
      Object.assign(entry, {state: 'uploading', loaded: 0, total: 0, message: ''}); renderQueue();
      let result;
      try {
        result = await uploadFile(`/content/telegram-sources/${companyCode}/upload`, body, {onProgress: (loaded, total) => {
          if (stopped || entry.state !== 'uploading') return; entry.loaded = loaded; entry.total = total > 0 ? total : 0; renderQueue();
        }});
      } catch (error) { result = {status: error?.status || 0, body: {error: error?.message}}; }
      if (stopped) return;
      const ok = result.status === 200 || result.status === 201, item = result.body?.item;
      if (ok && ownItem(item)) {
        const duplicate = result.body.duplicate === true;
        // CF17: после неизвестного исхода «уже есть» не доказывает, что сохранились подпись и сведения именно этой попытки.
        const matches = (item.caption || '') === (params.caption || '') && JSON.stringify(item.metadata || {}) === JSON.stringify({...(item.metadata || {}), ...params.metadata});
        Object.assign(entry, duplicate && entry.unknown
          ? {state: 'duplicate', message: `Файл есть в библиотеке (№${item.id}). Сервер не подтверждает, какая попытка его сохранила${matches ? '; сохранённые подпись и сведения совпадают с отправленными' : ' — сохранённые подпись и сведения отличаются от отправленных, сверьте их в «Изменить сведения»'}.`}
          : duplicate ? {state: 'duplicate', message: `Уже есть в библиотеке (№${item.id}): сохранены прежние подпись и сведения, новые не применены. Изменить их можно в «Изменить сведения».`}
            : {state: 'done', message: `Сохранён (№${item.id}).`});
        entry.itemId = item.id; upsert(item, true); return;
      }
      if (ok) { Object.assign(entry, {state: 'error', retryable: true, unknown: true, message: 'Ответ сервера не подходит к этой компании. Результат неизвестен — «Повторить неудавшиеся» не создаст дубль.'}); return; }
      const message = typeof result.body?.error === 'string' && result.body.error ? result.body.error : 'Сервер не сообщил причину.';
      if (transient(result.status)) {
        const maybe = !result.status || result.status >= 500;
        Object.assign(entry, {state: 'error', retryable: true, unknown: entry.unknown || maybe,
          message: `${result.status === 429 ? 'Сервер занят другой загрузкой. Повторите чуть позже.' : maybe ? `Ответ не получен (${message}). Файл мог сохраниться — повтор не создаст дубль.` : message} Повтор отправит те же подпись и сведения, что и первая попытка.`});
      } else Object.assign(entry, {state: 'error', retryable: false, message: `${message} Файл не сохранён.`});
    }
    async function runQueue() {
      if (running || stopped || !canUpload()) return;
      running = true; renderQueue();
      // CF17: подпись и сведения фиксируются для файла при его первой отправке; повтор шлёт их же, даже если форму изменили.
      const current = Object.freeze({caption: caption.value.trim(), metadata: Object.freeze(readMeta(extra, 'src-up'))});
      try {
        for (let entry = queue.find((e) => e.state === 'waiting'); entry && !stopped; entry = queue.find((e) => e.state === 'waiting')) {
          if (!entry.params) entry.params = current;
          await uploadOne(entry, entry.params);
        }
      } finally {
        running = false;
        if (!stopped) renderQueue();
      }
    }
    pick.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { addFiles([...(fileInput.files || [])]); fileInput.value = ''; });
    drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('src-drop-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('src-drop-over'));
    drop.addEventListener('drop', (event) => { event.preventDefault(); drop.classList.remove('src-drop-over'); addFiles([...(event.dataTransfer?.files || [])]); });
    start.addEventListener('click', () => void runQueue());
    again.addEventListener('click', () => { for (const e of queue) if (e.state === 'error' && e.retryable) Object.assign(e, {state: 'waiting', message: ''}); void runQueue(); });
    clear.addEventListener('click', () => { for (let i = queue.length - 1; i >= 0; i--) if (['done', 'duplicate'].includes(queue[i].state)) queue.splice(i, 1); renderQueue(); });

    /* ---------- Библиотека ---------- */
    const link = (label, href) => { const a = make('a', label); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };
    const originText = (item) => item.importMethod === 'upload' ? 'Загрузка в кабинете' : item.importMethod === 'manual_archive' ? 'Ручной архивный импорт · без ссылки на сообщение'
      : item.importMethod === 'manual' ? 'Ручной импорт по ссылке на сообщение' : 'Telegram';
    function renderItem(item) {
      const row = make('li'); row.className = 'src-item'; row.dataset.sourceId = String(item.id ?? '');
      const head = make('div'); head.className = 'src-item-head'; head.append(make('strong', item.name || 'Сообщение с исходниками'));
      const ready = item.metadata?.materialState === 'ready';
      if (item.metadata) { const badge = make('span', ready ? 'Готовый материал' : 'Исходник'); badge.className = 'src-badge'; head.append(badge); }
      row.append(head);
      row.append(make('p', KNOWN_STATUS[item.status] || 'Состояние неизвестно'));
      row.append(make('p', originText(item)));
      if (item.provenance) row.append(make('p', item.provenance));
      if (item.caption) row.append(make('p', item.caption));
      if (item.reason) row.append(make('p', item.reason));
      if (item.metadata) { const meta = make('p', metaSummary(item.metadata)); meta.className = 'cf-note'; row.append(meta); }
      if (Number.isFinite(item.size)) row.append(make('p', sizeText(item.size)));
      // Серверные ссылки также ограничены своей компанией и HTTPS Telegram.
      if (item.status === 'stored' && new RegExp(`^/content/telegram-sources/${companyCode}/[1-9]\\d*/file$`).test(item.fileUrl || '')) row.append(link('Скачать файл', item.fileUrl));
      if (/^https:\/\/t\.me\/c\/\d+\/\d+$/.test(item.telegramUrl || '')) { row.append(doc.createTextNode(' · ')); row.append(link('Открыть сообщение в Telegram', item.telegramUrl)); }
      if (!Number.isSafeInteger(item.id) || item.id < 1) return row;
      const tools = make('div'); tools.className = 'src-tools';
      if (canEdit() && Number.isSafeInteger(item.revision)) tools.append(button('Изменить сведения', {'data-src-action': 'edit', 'aria-expanded': 'false'}));
      if (item.status === 'stored') tools.append(button('Где использован', {'data-src-action': 'usage', 'aria-expanded': 'false'}));
      if (canEdit() && item.status === 'stored') {
        if (ready && READY_MIME.has(item.mime)) tools.append(button('Прикрепить к публикации', {'data-src-action': 'attach', 'aria-expanded': 'false'}));
        else { const why = make('p', ready ? 'Этот формат подходит как исходник; для публикации нужен JPEG, PNG, WebP, MP4 или WebM.' : 'Это исходник. Чтобы прикрепить файл к публикации, отметьте его как готовый материал в «Изменить сведения».'); why.className = 'cf-note'; tools.append(why); }
      }
      if (tools.children.length) row.append(tools);
      const panel = make('div'); panel.className = 'src-panel'; panel.hidden = true; row.append(panel);
      return row;
    }
    function upsert(item, top = false) {
      if (!ownItem(item)) return;
      items.set(item.id, item);
      const old = list.querySelector(`[data-source-id="${item.id}"]`), fresh = renderItem(item);
      if (old) { panels.delete(item.id); old.replaceWith(fresh); } else if (top) list.prepend(fresh); else list.append(fresh);
      updateEmpty();
    }
    function updateEmpty() {
      // CF17: состояние Telegram — только про автоприём; обычная загрузка от него не зависит.
      status.textContent = `${data?.enabled ? 'Автоприём из Telegram включён.' : 'Автоприём из Telegram выключен.'}${canUpload() ? ' Загрузка файлов на этой странице работает и без Telegram.' : ''}${list.children.length ? '' : ' Сохранённых исходников пока нет.'}`;
    }
    async function load() {
      if (stopped || loading) return;
      loading = true; retry.hidden = true; more.disabled = true;
      try {
        const page = await request(`/content/telegram-sources/${companyCode}${cursor ? '?before=' + cursor : ''}`);
        if (stopped) return;
        data = {...(data || {}), ...page, items: undefined};
        form.hidden = !(page.manualUploadAllowed && typeof upload === 'function');
        manualLimit = Number.isSafeInteger(page.manualMaxBytes) ? page.manualMaxBytes : 0;
        limitNote.textContent = manualLimit ? `Один файл — до ${Math.floor(manualLimit / 1024 / 1024)} МиБ. Файл останется доступен только в кабинете.` : '';
        if (!source.children.length) for (const [index, item] of (page.sources || []).entries()) { const option = make('option', `Источник ${index + 1} (${item.chatId})`); option.value = item.chatId; source.append(option); }
        setupWork();
        for (const item of page.items || []) {
          if (item && item.companyCode !== undefined && item.companyCode !== companyCode) continue; // чужая запись не рисуется
          if (Number.isSafeInteger(item.id) && items.has(item.id)) continue; // уже показана (например, после загрузки)
          if (Number.isSafeInteger(item.id)) items.set(item.id, item);
          list.append(renderItem(item));
        }
        cursor = Number.isSafeInteger(page.nextBefore) && page.nextBefore > 0 ? page.nextBefore : null;
        more.hidden = !cursor;
        updateEmpty();
      } catch { if (!stopped) { status.textContent = 'Не удалось загрузить исходники. Проверьте доступ к проекту и повторите.'; retry.hidden = false; } }
      finally { loading = false; more.disabled = false; }
    }
    // Свежая версия одной записи: список отдаёт записи с id меньше before, поэтому before=id+1 начинается с неё.
    async function fetchItem(id) {
      const page = await request(`/content/telegram-sources/${companyCode}?before=${id + 1}`);
      const item = (page.items || []).find((row) => row.id === id);
      if (!ownItem(item)) throw Object.assign(new Error('Исходник не найден'), {status: 404});
      return item;
    }

    /* ---------- Панели записи: сведения, прикрепление, использование ---------- */
    list.addEventListener('click', (event) => {
      const target = event.target.closest('[data-src-action]'); if (!target || stopped) return;
      const row = target.closest('[data-source-id]'), id = Number(row?.dataset.sourceId), item = items.get(id);
      if (!item) return;
      const action = target.dataset.srcAction, panel = row.querySelector('.src-panel'), open = panels.get(id);
      row.querySelectorAll('[data-src-action]').forEach((node) => node.setAttribute('aria-expanded', 'false'));
      if (open?.action === action && !panel.hidden) { panel.hidden = true; panels.delete(id); return; }
      target.setAttribute('aria-expanded', 'true'); panel.hidden = false;
      const state = {action, item}; panels.set(id, state);
      if (action === 'edit') editPanel(panel, state);
      if (action === 'attach') attachPanel(panel, state);
      if (action === 'usage') void usagePanel(panel, state);
    });
    const alive = (state) => !stopped && panels.get(state.item.id) === state;

    function editPanel(panel, state) {
      const prefix = `src-edit-${state.item.id}`;
      const cap = make('textarea'); cap.id = `${prefix}-caption`; cap.rows = 2; cap.maxLength = 12000; cap.value = state.item.caption || '';
      const capField = make('div'); capField.className = 'cf-field'; capField.append(labelRow('Подпись', 'caption', cap.id), cap);
      const fields = metaFields(prefix, state.item.metadata || {});
      const save = button('Сохранить сведения'), refresh = button('Обновить'); refresh.hidden = true;
      const note = make('p'); note.setAttribute('role', 'status');
      const fresh = make('p'); fresh.className = 'cf-note';
      const bar = make('div'); bar.className = 'cf-actions'; bar.append(save, refresh);
      panel.replaceChildren(make('p', `Версия сведений ${state.item.revision}. Файл не меняется.`), capField, fields, bar, fresh, note);
      save.addEventListener('click', async () => {
        if (!alive(state) || state.busy) return;
        state.busy = true; save.disabled = true; note.textContent = 'Сохраняем…';
        try {
          const result = await send(`/content/telegram-sources/${companyCode}/${state.item.id}/metadata`, 'PATCH',
            {revision: state.item.revision, metadata: readMeta(fields, prefix), caption: cap.value.trim()});
          if (!alive(state)) return;
          if (!ownItem(result?.item) || result.item.id !== state.item.id) throw Object.assign(new Error('Ответ не подходит к этому исходнику'), {status: 0});
          const same = result.item.revision === state.item.revision;
          upsert(result.item);
          const row = list.querySelector(`[data-source-id="${result.item.id}"]`);
          const done = make('p', same ? 'Изменений нет.' : `Сведения сохранены (версия ${result.item.revision}). Уже прикреплённые публикации не меняются.`);
          done.setAttribute('role', 'status'); done.className = 'cf-note'; row?.append(done);
        } catch (error) {
          if (!alive(state)) return;
          if (error?.status === 409) { note.textContent = 'Сведения уже изменили в другом окне. Ваш ввод остался в форме: нажмите «Обновить», проверьте свежие значения и сохраните ещё раз.'; refresh.hidden = false; }
          else note.textContent = `Не сохранено: ${error?.message || 'ошибка'}. Ввод остался в форме.`;
        } finally { if (alive(state)) { state.busy = false; save.disabled = false; } }
      });
      refresh.addEventListener('click', async () => {
        if (!alive(state)) return; refresh.disabled = true;
        try {
          const item = await fetchItem(state.item.id); if (!alive(state)) return;
          state.item = item; items.set(item.id, item);
          fresh.textContent = `Загружена версия ${item.revision}: ${item.metadata?.materialState === 'ready' ? 'готовый материал' : 'исходник'}; ${metaSummary(item.metadata)}${item.caption ? `; подпись: ${item.caption}` : ''}.`;
          panel.firstChild.textContent = `Версия сведений ${item.revision}. Файл не меняется.`;
          note.textContent = 'Ваш ввод остался в форме. Сохраните, если он нужен поверх свежей версии.'; refresh.hidden = true;
        } catch (error) { if (alive(state)) note.textContent = `Не удалось обновить: ${error?.message || 'ошибка'}.`; }
        finally { if (alive(state)) refresh.disabled = false; }
      });
    }

    function attachPanel(panel, state) {
      const prefix = `src-att-${state.item.id}`, item = state.item;
      const intro = make('p', 'Копия готового файла уйдёт в публикацию, сам исходник останется в библиотеке. Новый черновик создаётся без даты и согласования. В существующей карточке файл добавится к её материалам, и согласование потребуется заново. Ничего не публикуется.');
      const target = make('div'); target.className = 'cf-field'; target.setAttribute('role', 'radiogroup');
      const targetTitle = labelRow('Куда прикрепить', 'attachTarget'); target.setAttribute('aria-labelledby', targetTitle.firstChild.id);
      const choices = make('div'); choices.className = 'src-choices';
      for (const [value, text] of [['new', 'Новый черновик'], ['existing', 'Существующая карточка']]) {
        const label = make('label'); label.className = 'cf-check'; const input = make('input');
        input.type = 'radio'; input.name = `${prefix}-target`; input.value = value; input.checked = value === 'new'; label.append(input, text); choices.append(label);
      }
      target.append(targetTitle, choices);
      const fresh = make('div'); fresh.className = 'src-attach-new';
      const title = make('input'); title.id = `${prefix}-title`; title.maxLength = 200;
      title.value = (String(item.caption || '').split('\n')[0].trim() || String(item.name || '').replace(/\.[^.]+$/, '')).slice(0, 200);
      const select = (id, options) => { const node = make('select'); node.id = id; for (const [value, text] of options) { const option = make('option', text); option.value = value; node.append(option); } return node; };
      const format = select(`${prefix}-format`, FORMATS), role = select(`${prefix}-role`, ROLES);
      for (const [text, hintId, control] of [['Название черновика', 'attachTitle', title], ['Формат', 'attachFormat', format], ['Цель (ОВП)', 'attachRole', role]]) {
        const f = make('div'); f.className = 'cf-field'; f.append(labelRow(text, hintId, control.id), control); fresh.append(f);
      }
      const existing = make('div'); existing.className = 'cf-field'; existing.hidden = true;
      const post = make('select'); post.id = `${prefix}-post`;
      const postsNote = make('p'); postsNote.className = 'cf-note';
      existing.append(labelRow('Карточка', 'attachPost', post.id), post, postsNote);
      const go = button('Прикрепить'), resend = button('Отправить ещё раз'), refresh = button('Обновить'), open = button('Открыть карточку');
      resend.hidden = true; refresh.hidden = true; open.hidden = true;
      const bar = make('div'); bar.className = 'cf-actions'; bar.append(go, resend, refresh, open);
      const note = make('p'); note.setAttribute('role', 'status');
      panel.replaceChildren(intro, target, fresh, existing, bar, note);
      const chosen = () => panel.querySelector(`[name="${prefix}-target"]:checked`).value;
      async function loadPosts(keep) {
        postsNote.textContent = 'Загружаем карточки…'; post.disabled = true;
        try {
          const result = await request(`/content/crm/autoposting/posts?companyCode=${encodeURIComponent(companyCode)}`);
          if (!alive(state)) return;
          if (!result || result.companyCode !== companyCode || !Array.isArray(result.posts)) throw new Error('ответ другой компании');
          state.posts = result.posts.filter((p) => p && p.companyCode === companyCode && Number.isSafeInteger(p.id) && p.id > 0 && !p.archive?.archivedAt);
          post.replaceChildren(...state.posts.map((p) => { const option = make('option', `№${p.id} · ${p.title || 'Без названия'}`); option.value = String(p.id); return option; }));
          if (keep && state.posts.some((p) => String(p.id) === keep)) post.value = keep;
          postsNote.textContent = state.posts.length ? 'Показаны карточки этой компании. Отправленные и опубликованные сервер не изменит.' : 'Карточек пока нет — выберите «Новый черновик».';
        } catch (error) { if (alive(state)) postsNote.textContent = `Не удалось загрузить карточки: ${error?.message || 'ошибка'}.`; }
        finally { if (alive(state)) post.disabled = false; }
      }
      choices.addEventListener('change', () => {
        const isNew = chosen() === 'new'; fresh.hidden = !isNew; existing.hidden = isNew;
        if (!isNew && !state.posts) void loadPosts();
      });
      function body() {
        if (chosen() === 'new') {
          const newPost = {}; if (title.value.trim()) newPost.title = title.value.trim();
          if (format.value) newPost.format = format.value; if (role.value) newPost.ovpRole = role.value;
          return {clientRequestId: key(), sourceRevision: state.item.revision, newPost};
        }
        const chosenPost = (state.posts || []).find((p) => String(p.id) === post.value);
        if (!chosenPost) return null;
        return {clientRequestId: key(), sourceRevision: state.item.revision, postId: chosenPost.id, revision: chosenPost.revision};
      }
      async function attach(payload) {
        if (!alive(state) || state.busy) return;
        state.busy = true; go.disabled = true; resend.disabled = true; refresh.hidden = true; note.textContent = 'Прикрепляем…';
        try {
          const result = await send(`/content/telegram-sources/${companyCode}/${state.item.id}/attach`, 'POST', payload);
          if (!alive(state)) return;
          const postId = result?.post?.id;
          if (!result || result.companyCode !== companyCode || result.link?.sourceId !== state.item.id || !Number.isSafeInteger(postId) || postId < 1 || result.post.companyCode !== companyCode)
            throw Object.assign(new Error('Ответ не подходит к этому исходнику или компании'), {status: 0});
          state.pending = null; resend.hidden = true; go.hidden = false;
          state.attachedPost = postId;
          note.textContent = `${result.duplicate ? 'Этот запрос уже был выполнен раньше. ' : ''}Файл прикреплён к ${payload.newPost ? 'новому черновику' : 'карточке'} №${postId}. Это квитанция на момент прикрепления; текущее состояние карточки откроется по кнопке «Открыть карточку».`;
          open.hidden = typeof openPost !== 'function';
        } catch (error) {
          if (!alive(state)) return;
          const code = error?.status;
          if (!code || code >= 500) {
            // Результат неизвестен: черновик мог быть создан. Тот же ключ и тело — повтор вернёт первоначальный результат.
            state.pending = payload; resend.hidden = false; go.hidden = true;
            note.textContent = `Ответ не получен (${error?.message || 'сеть'}). Результат неизвестен: прикрепление могло выполниться. «Отправить ещё раз» повторит тот же запрос — дубля не будет.`;
          } else if (code === 409) {
            state.pending = null; resend.hidden = true; go.hidden = false; refresh.hidden = false;
            note.textContent = `${error.message || 'Исходник или карточка изменились.'} Нажмите «Обновить»: выбор сохранится, затем прикрепите заново.`;
          } else { state.pending = null; resend.hidden = true; go.hidden = false; note.textContent = `Не прикреплено: ${error?.message || 'ошибка'}.`; }
        } finally { if (alive(state)) { state.busy = false; go.disabled = false; resend.disabled = false; } }
      }
      go.addEventListener('click', () => {
        if (state.pending) return; // неизвестный исход — только повтор того же запроса
        const payload = body(); if (!payload) { note.textContent = 'Выберите карточку.'; return; }
        void attach(payload);
      });
      resend.addEventListener('click', () => { if (state.pending) void attach(state.pending); });
      refresh.addEventListener('click', async () => {
        if (!alive(state)) return; refresh.disabled = true; const keep = post.value;
        try {
          const item = await fetchItem(state.item.id); if (!alive(state)) return;
          state.item = item; items.set(item.id, item);
          if (item.metadata?.materialState !== 'ready' || !READY_MIME.has(item.mime)) { note.textContent = 'Файл больше не отмечен как готовый материал — прикрепление недоступно.'; go.disabled = true; refresh.hidden = true; return; }
          if (chosen() === 'existing') await loadPosts(keep);
          if (!alive(state)) return;
          refresh.hidden = true; note.textContent = `Загружена версия исходника ${item.revision}${chosen() === 'existing' ? ' и свежий список карточек' : ''}. Выбор сохранён — нажмите «Прикрепить».`;
        } catch (error) { if (alive(state)) note.textContent = `Не удалось обновить: ${error?.message || 'ошибка'}.`; }
        finally { if (alive(state)) refresh.disabled = false; }
      });
      open.addEventListener('click', () => { if (state.attachedPost && typeof openPost === 'function') openPost(state.attachedPost); });
    }

    async function usagePanel(panel, state) {
      panel.replaceChildren(make('p', 'Загружаем, где использован файл…'));
      try {
        const result = await request(`/content/telegram-sources/${companyCode}/${state.item.id}/usage`);
        if (!alive(state)) return;
        if (!result || result.companyCode !== companyCode || result.sourceId !== state.item.id || !Array.isArray(result.usages)) throw new Error('ответ другой компании или исходника');
        const rows = result.usages.filter((u) => u && Number.isSafeInteger(u.post?.id) && u.post.id > 0);
        const when = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(t).toLocaleString('ru-RU', {day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'}) : ''; };
        const items_ = rows.map((u) => {
          const li = make('li'), archived = Boolean(u.post.archivedAt);
          li.append(make('strong', `№${u.post.id} · ${u.post.title || 'Без названия'}`));
          li.append(make('span', ` — ${archived ? `удалена из плана ${when(u.post.archivedAt)}` : u.current ? 'файл в карточке сейчас' : 'использовался раньше: в карточке файл заменён'}${u.attachedAt ? ` · прикреплён ${when(u.attachedAt)}` : ''}`));
          if (typeof openPost === 'function') { const go = button(archived ? 'Показать в удалённых' : 'Открыть карточку'); go.addEventListener('click', () => openPost(u.post.id)); li.append(' ', go); }
          return li;
        });
        const ul = make('ul'); ul.className = 'src-usage'; ul.append(...items_);
        const note = make('p', 'Замена файла в одной карточке не меняет остальные карточки.'); note.className = 'cf-note';
        panel.replaceChildren(rows.length ? ul : make('p', 'Пока не использован ни в одной карточке.'), note);
      } catch (error) { if (alive(state)) panel.replaceChildren(make('p', `Не удалось загрузить: ${error?.message || 'ошибка'}. Закройте и откройте снова.`)); }
    }

    /* ---------- Прежний ручной импорт ---------- */
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); if (stopped || sending || loading || form.hidden) return;
      const selected = manualFile.files?.[0]; if (!selected) { importStatus.textContent = 'Выберите файл.'; return; }
      if (!manualLimit || selected.size > manualLimit) { importStatus.textContent = 'Файл превышает предел ручного импорта.'; return; }
      const body = new doc.defaultView.FormData();
      if (mode.value === 'archive') { body.set('sourceChatId', source.value); body.set('provenance', provenance.value.trim()); }
      else body.set('telegramUrl', origin.value.trim());
      body.set('file', selected); sending = true; submit.disabled = true; more.disabled = true; importStatus.textContent = 'Загружаем файл в приватный архив…';
      try {
        const result = await upload(`/content/telegram-sources/${companyCode}/manual-upload`, body);
        if (stopped) return;
        importStatus.textContent = result.duplicate ? 'Этот файл уже есть в архиве. Повтор не создан.' : 'Файл сохранён в приватном архиве.';
        manualFile.value = ''; list.replaceChildren(); items.clear(); panels.clear(); cursor = null; await load();
      } catch (error) { if (!stopped) importStatus.textContent = error?.message || 'Не удалось загрузить файл. Можно повторить без создания дубля.'; }
      finally { sending = false; submit.disabled = false; more.disabled = false; }
    });
    more.addEventListener('click', load); retry.addEventListener('click', load); void load();
    return {destroy() { stopped = true; queue.length = 0; panels.clear(); element.replaceChildren(); }};
  }
  return {mount};
}));
