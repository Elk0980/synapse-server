(() => {
  'use strict';
  const API = '/content/palitra/review39';
  const STATUS = { not_checked: 'Не проверено', checked: 'Проверено', needs_fix: 'Нужна правка' };
  const STAGE = { ready: 'Готово', in_progress: 'В работе', needs_recheck: 'Нужна повторная проверка',
    planned: 'Запланировано', waiting_data: 'Ждём данные', separate_release: 'Отдельное обновление' };
  const byId = id => document.getElementById(id);
  const draftNotes = new Map(); // Unsaved textarea drafts only; never a saved state or localStorage.
  let data = null;
  let csrf = '';
  let busy = false;

  function message(text) { byId('message').textContent = text; }
  function error(text) { byId('error').textContent = text; byId('error').hidden = !text; }
  function loginNeeded() { byId('login-needed').hidden = false; byId('review').hidden = true; byId('seed-tools').hidden = true; csrf = ''; }
  function accessChanged() { byId('review').hidden = true; byId('seed-tools').hidden = true; csrf = ''; error('Проверка задач недоступна для этого аккаунта. Вернитесь в кабинет'); }
  function lock(value) {
    busy = value;
    byId('review').setAttribute('aria-busy', String(value));
    document.querySelectorAll('#review select, #review button, #review input, #review textarea, #seed-tools input, #seed-tools button').forEach(control => { control.disabled = value; });
  }
  async function request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store',
        redirect: 'error', signal: controller.signal });
      let body = null;
      try { body = await response.json(); } catch { /* Unconfirmed response remains an error. */ }
      if (!response.ok) throw Object.assign(new Error(typeof body?.error === 'string' ? body.error : 'Не удалось получить ответ'), { status: response.status });
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Не удалось прочитать список');
      return body;
    } finally { clearTimeout(timer); }
  }
  function validateSnapshot(value) {
    if (!Number.isSafeInteger(value?.version) || value.version < 0 || value.companyCode !== 'palitra-love'
      || !Array.isArray(value.tasks) || value.tasks.length > 500) throw new Error('Не удалось прочитать список');
    if (value.version === 0 && (value.needsSeed !== true || value.tasks.length !== 0)) throw new Error('Не удалось прочитать список');
    if (value.version > 0 && value.needsSeed === true) throw new Error('Не удалось прочитать список');
    const seen = new Set();
    for (const task of value.tasks) {
      if (!task || typeof task.id !== 'string' || !/^\d{2,3}$/.test(task.id) || seen.has(task.id)
        || typeof task.title !== 'string' || typeof task.stage !== 'string' || !Object.hasOwn(STATUS, task.user_check)
        || typeof task.user_note !== 'string' || !Number.isSafeInteger(task.revision) || task.revision < 1) {
        throw new Error('Не удалось прочитать список');
      }
      seen.add(task.id);
    }
    return value;
  }
  function stamp(value) {
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'short' }).format(date);
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function cell(label) {
    const node = element('td'); node.append(element('span', 'mobile-label', label)); return node;
  }
  function render() {
    if (!data) return;
    if (!csrf) { byId('review').hidden = true; byId('seed-tools').hidden = true; return; }
    byId('seed-tools').hidden = data.needsSeed !== true;
    byId('review').hidden = data.needsSeed === true;
    if (data.needsSeed === true) { lock(busy); return; }
    const openNotes = new Set([...document.querySelectorAll('.task-note[open]')].map(node => node.dataset.taskId));
    const search = byId('search').value.trim().toLocaleLowerCase('ru-RU');
    const stage = byId('stage-filter').value; const check = byId('check-filter').value;
    const tasks = data.tasks.filter(task => (!search || (task.id + ' ' + task.title).toLocaleLowerCase('ru-RU').includes(search))
      && (stage === 'all' || task.stage === stage) && (check === 'all' || task.user_check === check));
    const rows = document.createDocumentFragment();
    for (const task of tasks) {
      const row = element('tr'); row.dataset.taskId = task.id;
      const number = cell('Номер'); number.append(element('span', 'task-no', task.id));
      const title = cell('Задача'); title.append(element('span', 'task-title', task.title));
      const progress = cell('Выполнение'); progress.append(element('span', 'stage ' + (Object.hasOwn(STAGE, task.stage) ? task.stage : ''), STAGE[task.stage] || 'В плане'));
      const review = cell('Ваша проверка');
      const select = element('select', 'review-select'); select.dataset.taskId = task.id;
      select.setAttribute('aria-label', 'Ваша проверка задачи ' + task.id + ': ' + task.title);
      for (const [value, label] of Object.entries(STATUS)) select.append(new Option(label, value));
      select.value = task.user_check;
      select.addEventListener('change', () => void save(task.id, select.value));
      const note = element('details', 'task-note'); note.dataset.taskId = task.id; note.open = openNotes.has(task.id);
      note.append(element('summary', '', task.user_note || draftNotes.has(task.id) ? 'Комментарий к задаче' : 'Добавить комментарий'));
      const textarea = element('textarea'); textarea.maxLength = 1000;
      textarea.setAttribute('aria-label', 'Комментарий к задаче ' + task.id);
      textarea.value = draftNotes.has(task.id) ? draftNotes.get(task.id) : task.user_note;
      const noteState = element('p', 'note-state', draftNotes.has(task.id) ? 'Комментарий ещё не сохранён' : '');
      textarea.addEventListener('input', () => {
        if (textarea.value === task.user_note) draftNotes.delete(task.id); else draftNotes.set(task.id, textarea.value);
        noteState.textContent = draftNotes.has(task.id) ? 'Комментарий ещё не сохранён' : '';
      });
      const noteSave = element('button', 'button secondary', 'Сохранить комментарий'); noteSave.type = 'button';
      noteSave.addEventListener('click', () => void save(task.id, task.user_check, textarea.value));
      note.append(textarea, noteSave, noteState);
      review.append(select, note, element('p', 'last-check', task.user_checked_at
        ? 'Последняя проверка: ' + stamp(task.user_checked_at) + ' (Бангкок)'
        : task.user_check === 'not_checked' ? 'Ещё не проверено' : 'Ранее отмечено: ' + STATUS[task.user_check]));
      row.append(number, title, progress, review); rows.append(row);
    }
    byId('task-rows').replaceChildren(rows); byId('empty').hidden = tasks.length !== 0;
    const checked = data.tasks.filter(task => task.user_check === 'checked').length;
    const fixing = data.tasks.filter(task => task.user_check === 'needs_fix').length;
    const ready = data.tasks.filter(task => task.stage === 'ready').length;
    byId('totals').textContent = `Всего ${data.tasks.length} · Готово ${ready} · Проверено ${checked} · Нужна правка ${fixing} · Показано ${tasks.length}`;
    byId('updated').textContent = stamp(data.updatedAt) ? 'Список обновлён: ' + stamp(data.updatedAt) + ' (Бангкок)' : '';
    lock(busy);
  }
  async function load() { data = validateSnapshot(await request(API)); render(); return data; }
  async function readSeedFile(file) {
    if (!file || file.size > 2 * 1024 * 1024) throw new Error('Выберите подготовленный файл списка задач');
    const text = typeof file.text === 'function' ? await file.text() : await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Файл не удалось прочитать')); reader.readAsText(file, 'utf-8');
    });
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('Выберите готовый файл списка задач в формате JSON'); }
    if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length !== 39) throw new Error('Файл должен содержать все 39 задач');
    const seen = new Set();
    return parsed.tasks.map(task => {
      if (!task || typeof task.id !== 'string' || !/^(?:0[1-9]|[12][0-9]|3[0-9])$/.test(task.id)
        || seen.has(task.id) || typeof task.title !== 'string' || task.title.length > 300
        || !task.title.trim() || !Object.hasOwn(STAGE, task.stage) || !Object.hasOwn(STATUS, task.user_check)
        || (task.user_note != null && (typeof task.user_note !== 'string' || task.user_note.length > 1000))) {
        throw new Error('В файле есть неверная задача. Выберите подготовленный список');
      }
      seen.add(task.id);
      // Only these five fields leave the browser. Never serialize the local file,
      // its evidence, source, authors, paths, credentials or other properties.
      return { id: task.id, title: task.title.trim(), stage: task.stage,
        user_check: task.user_check, user_note: (task.user_note || '').replace(/\r\n?/g, '\n') };
    });
  }
  function sameSeed(fresh, tasks) {
    if (fresh.tasks.length !== 39) return false;
    const expected = new Map(tasks.map(task => [task.id, task]));
    return fresh.tasks.every(task => {
      const value = expected.get(task.id);
      return value && ['title', 'stage', 'user_check', 'user_note'].every(key => task[key] === value[key]);
    });
  }
  byId('seed-submit').addEventListener('click', async () => {
    if (busy || !csrf || data?.needsSeed !== true) return;
    lock(true); error(''); message('Читаем список задач…');
    let tasks = null; let confirmed = false;
    try {
      tasks = await readSeedFile(byId('seed-file').files[0]);
      message('Загружаем список задач…');
      await request('/palitra-review/api/seed', { method: 'POST', headers: { 'content-type': 'application/json',
        'x-csrf-token': csrf, 'if-match': '"0"' }, body: JSON.stringify({ tasks }) });
      data = validateSnapshot(await request(API));
      if (!sameSeed(data, tasks) || data.version < 1) throw new Error('Загрузку пока не удалось подтвердить');
      confirmed = true;
    } catch (failure) {
      if (failure.status === 401) { loginNeeded(); error('Войдите в кабинет снова'); }
      else if (failure.status === 403) accessChanged();
      else {
        if (tasks) {
          try {
            data = validateSnapshot(await request(API));
            confirmed = failure.status !== 409 && data.version > 0 && sameSeed(data, tasks);
          } catch { /* Never repeat an import with an unknown outcome. */ }
        }
        if (!confirmed) error(failure.status === 409 ? 'Список уже загружен. Повторно заменить ваши проверки нельзя'
          : tasks ? 'Загрузку не удалось подтвердить. Обновите страницу' : failure.message);
      }
    } finally {
      message(confirmed ? 'Все 39 задач загружены. Ваши прежние проверки сохранены' : 'Загрузка не подтверждена');
      render(); lock(false);
    }
  });
  async function save(id, status, note) {
    if (busy || !data || !csrf) return;
    const oldTask = data.tasks.find(task => task.id === id);
    const desiredNote = note === undefined ? oldTask.user_note : note;
    const baseVersion = data.version;
    lock(true); error(''); message('Сохраняем проверку задачи ' + id + '…');
    let acknowledgedVersion = null;
    let succeeded = false;
    try {
      const body = { baseVersion, taskId: id, userCheck: status };
      if (note !== undefined) body.userNote = note;
      const saved = validateSnapshot(await request(API, { method: 'PATCH', headers: { 'content-type': 'application/json',
        'x-csrf-token': csrf, 'if-match': `"${baseVersion}"` }, body: JSON.stringify(body) }));
      acknowledgedVersion = saved.version;
      const fresh = validateSnapshot(await request(API));
      const current = fresh.tasks.find(task => task.id === id);
      data = fresh;
      if (!current || fresh.version < saved.version || current.user_check !== status || current.user_note !== desiredNote) {
        throw new Error('Изменение пока не подтверждено. Обновите список');
      }
      succeeded = true;
    } catch (failure) {
      if (failure.status === 401) { loginNeeded(); error('Войдите в кабинет снова'); }
      else if (failure.status === 403) accessChanged();
      else {
        // A lost response may follow a committed change. Never resend blindly:
        // obtain a fresh server snapshot and confirm this exact status/note first.
        try {
          const fresh = validateSnapshot(await request(API)); const current = fresh.tasks.find(task => task.id === id);
          data = fresh;
          if (failure.status !== 409 && failure.status !== 400 && failure.status !== 428
            && current?.user_check === status && current.user_note === desiredNote
            && (acknowledgedVersion === null || fresh.version >= acknowledgedVersion)) succeeded = true;
        } catch { /* Keep the change unconfirmed and display the error. */ }
        if (!succeeded) error(failure.status === 409 ? 'Список уже изменился. Выберите проверку ещё раз' : 'Не удалось подтвердить сохранение. Обновите список');
      }
    } finally {
      if (succeeded) {
        if (note !== undefined) draftNotes.delete(id);
        message('Задача ' + id + ': ' + STATUS[status] + '. Сохранено'); error('');
      } else message('Проверка задачи ' + id + ' не подтверждена');
      render(); lock(false);
      document.querySelector('.review-select[data-task-id="' + id + '"]')?.focus();
    }
  }
  byId('filters').addEventListener('submit', event => event.preventDefault());
  ['search', 'stage-filter', 'check-filter'].forEach(id => byId(id).addEventListener(id === 'search' ? 'input' : 'change', render));
  byId('reload').addEventListener('click', async () => {
    if (busy) return; lock(true); error(''); message('Обновляем список…');
    try { await load(); message('Список обновлён'); }
    catch (failure) {
      if (failure.status === 401) { loginNeeded(); error('Войдите в кабинет снова'); }
      else if (failure.status === 403) accessChanged();
      else error('Не удалось обновить список. Попробуйте ещё раз');
      message('');
    }
    finally { lock(false); }
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') document.querySelectorAll('.menu[open]').forEach(menu => { menu.open = false; menu.querySelector('summary').focus(); }); });
  (async () => {
    try {
      const identity = await request('/content/whoami');
      if (identity.role !== 'owner') { message(''); error('Проверка задач доступна только владельцу'); return; }
      if (typeof identity.csrfToken !== 'string' || !identity.csrfToken) throw new Error('Войдите снова');
      csrf = identity.csrfToken; await load();
      message(data.needsSeed === true ? 'Загрузите подготовленный список задач' : 'Выберите проверку задачи');
    } catch (failure) {
      message(''); if (failure.status === 401) loginNeeded();
      else error('Список пока недоступен. Попробуйте обновить страницу');
    }
  })();
})();
