(() => {
  'use strict';
  const sb = window.SbCabinet = window.SbCabinet || {};
  const platforms = {instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', vk: 'ВКонтакте', telegram: 'Telegram'};
  const formats = {reel: 'Рилс', short: 'Шортс', clip: 'Клип', story: 'История', post: 'Пост', carousel: 'Карусель'};
  const statuses = {idea: 'Идея', script: 'Сценарий готов', recorded: 'Материал снят'};
  const metrics = {views: 'Просмотры', impressions: 'Показы', likes: 'Реакции', comments: 'Комментарии', shares: 'Репосты', saves: 'Сохранения'};
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
    (char) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const can = (ctx) => ctx.identity?.role === 'owner' || ctx.identity?.permissions?.includes('actor-onboarding.self');
  const actor = (ctx) => String(ctx.identity?.userId ?? '');
  const endpoint = (state, resource) => `/content/actor-workspace/${resource}?companyCode=${encodeURIComponent(state.code)}`;
  const drafts = new Map(); // Только память вкладки: личный текст не сохраняется в localStorage.
  let current = null;
  let sequence = 0;
  const live = (state) => current === state && state.id === sequence && state.container.isConnected &&
    state.ctx.selectedProjectId === state.code && actor(state.ctx) === state.actorId && can(state.ctx) &&
    (!state.ctx.currentView || state.ctx.currentView === 'actor-workspace');
  const node = (state, selector) => state.container.querySelector(selector);
  const messageId = () => window.crypto.randomUUID?.() ||
    `actor_${Date.now()}_${Array.from(window.crypto.getRandomValues(new Uint32Array(3)), (n) => n.toString(16)).join('_')}`;
  const dateLabel = (value) => value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('ru-RU', {day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'}) : '';
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  function notice(state, area, text, error = false) {
    if (!live(state)) return;
    const el = node(state, `[data-aw-${area}-status]`);
    el.textContent = text;
    el.dataset.error = String(error);
  }
  function errorText(error, fallback) {
    if (error?.status === 401) return 'Войдите в кабинет заново. Черновик остаётся в этой вкладке до её закрытия.';
    if (error?.status === 403) return 'Доступ к этому разделу изменился. Обратитесь к владельцу кабинета.';
    return fallback; // Не выводим произвольный текст сервера и технические ответы.
  }
  function checkScope(state, data, personal = true) {
    if (!data || data.companyCode !== state.code || (personal && String(data.actorId) !== state.actorId)) {
      throw new Error('INVALID_SCOPE');
    }
  }
  function validEntries(entries) {
    if (!Array.isArray(entries) || entries.length > 42) return 'В программе может быть не больше 42 материалов.';
    const dates = new Map();
    for (const item of entries) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !Number.isFinite(Date.parse(`${item.date}T00:00:00Z`)) ||
          new Date(`${item.date}T00:00:00Z`).toISOString().slice(0, 10) !== item.date) return 'Укажите дату каждого материала.';
      if (!Object.hasOwn(platforms, item.platform) || !Object.hasOwn(formats, item.format) ||
          !Object.hasOwn(statuses, item.status)) return 'Выберите площадку, формат и состояние каждого материала.';
      if (typeof item.topic !== 'string' || !item.topic.trim() || item.topic.length > 240) return 'Добавьте тему каждого материала — до 240 символов.';
      dates.set(item.date, (dates.get(item.date) || 0) + 1);
    }
    if (dates.size > 14 || [...dates.values()].some((count) => count > 3)) return 'Выберите до 14 дней и не больше трёх материалов на день.';
    return '';
  }
  function checkPlan(state, data) {
    checkScope(state, data);
    if (!Number.isSafeInteger(data.revision) || data.revision < 0 || validEntries(data.entries)) throw new Error('INVALID_PLAN');
    return {revision: data.revision, entries: data.entries.map(({date, platform, format, topic, status}) =>
      ({date, platform, format, topic, status})), updatedAt: data.updatedAt};
  }
  const options = (values, selected) => Object.entries(values).map(([value, label]) =>
    `<option value="${value}"${selected === value ? ' selected' : ''}>${esc(label)}</option>`).join('');
  function cards(state) {
    const target = node(state, '[data-aw-entries]');
    target.innerHTML = state.draft.entries.length ? state.draft.entries.map((item, index) =>
      `<fieldset class="aw-entry" data-aw-entry="${index}"><legend>Материал ${index + 1}</legend>
        <div class="aw-entry-fields">
          <label>Дата<input name="date" type="date" required value="${esc(item.date)}"></label>
          <label>Площадка<select name="platform">${options(platforms, item.platform)}</select></label>
          <label>Формат<select name="format">${options(formats, item.format)}</select></label>
          <label>Состояние<select name="status">${options(statuses, item.status)}</select></label>
          <label class="aw-topic">Тема<textarea name="topic" rows="2" maxlength="240" required
            placeholder="О чём расскажем и что покажем">${esc(item.topic)}</textarea></label>
        </div><button type="button" class="plain-button aw-remove" data-aw-remove="${index}"
          aria-label="Убрать материал ${index + 1}">Убрать материал</button></fieldset>`).join('') :
      '<p class="aw-empty">Начните с одной идеи. Добавьте материал, выберите дату и запишите тему.</p>';
    planControls(state);
  }
  function planControls(state) {
    if (!live(state)) return;
    const count = state.draft.entries.length;
    node(state, '[data-aw-plan-count]').textContent = `${count} из 42 материалов`;
    node(state, '[data-aw-add]').disabled = !state.planReady || state.saving || count >= 42;
    node(state, '[data-aw-save]').disabled = !state.planReady || state.saving || state.conflict || !state.draft.dirty;
    node(state, '[data-aw-save]').textContent = state.saving ? 'Сохраняем…' : 'Сохранить мою программу';
    node(state, '[data-aw-entries]').querySelectorAll('fieldset').forEach((el) => {el.disabled = state.saving;});
  }
  function recordInput(state, target) {
    if (!live(state) || state.saving || !state.planReady) return;
    const entry = target.closest('[data-aw-entry]');
    if (!entry || !['date', 'platform', 'format', 'topic', 'status'].includes(target.name)) return;
    state.draft.entries[Number(entry.dataset.awEntry)][target.name] = target.value;
    state.draft.dirty = true;
    notice(state, 'plan', state.conflict ? 'Есть другая сохранённая версия. Ваш ввод сохранён в этой вкладке.' :
      'Есть несохранённые изменения. Черновик хранится в этой вкладке.');
    planControls(state);
  }
  function savedPreview(plan) {
    return `<p>Версия ${plan.revision}${plan.updatedAt ? ` · ${esc(dateLabel(plan.updatedAt))}` : ''}</p>` +
      (plan.entries.length ? `<ul class="aw-saved-list">${plan.entries.map((item) =>
        `<li><strong>${esc(item.topic)}</strong><span>${esc(item.date)} · ${platforms[item.platform]} · ${formats[item.format]} · ${statuses[item.status]}</span></li>`).join('')}</ul>` :
        '<p>В сохранённой версии пока нет материалов.</p>');
  }
  function conflictView(state) {
    if (!live(state)) return;
    const target = node(state, '[data-aw-conflict]');
    target.hidden = !state.conflict;
    if (!state.conflict) {target.replaceChildren(); return;}
    target.innerHTML = '<h3>На сервере есть другая версия</h3><p>Ваши изменения остались в карточках. Сначала сравните их с сохранённой программой.</p>' +
      (state.latest ? `${savedPreview(state.latest)}<div class="aw-actions">
        <button type="button" class="plain-button" data-aw-use-saved>Взять сохранённую версию</button>
        <button type="button" class="plain-button" data-aw-replace-saved>Сохранить мой вариант вместо неё</button></div>` :
        '<button type="button" class="plain-button" data-aw-compare>Показать сохранённую версию</button>');
    target.querySelector('[data-aw-compare]')?.addEventListener('click', () => void comparePlan(state));
    target.querySelector('[data-aw-use-saved]')?.addEventListener('click', () => {
      if (!live(state) || state.saving) return;
      Object.assign(state.draft, {entries: clone(state.latest.entries), revision: state.latest.revision, dirty: false});
      state.conflict = false;
      state.latest = null;
      cards(state); conflictView(state);
      notice(state, 'plan', 'Открыта сохранённая версия.');
    });
    target.querySelector('[data-aw-replace-saved]')?.addEventListener('click', () => void savePlan(state, state.latest.revision));
  }
  async function comparePlan(state) {
    if (!live(state) || state.saving || state.comparing) return;
    state.comparing = true;
    const button = node(state, '[data-aw-compare]');
    button.disabled = true;
    try {
      const data = await state.ctx.apiJson(endpoint(state, 'plan'));
      if (!live(state)) return;
      state.latest = checkPlan(state, data);
      conflictView(state);
      notice(state, 'plan', 'Сравните сохранённую версию ниже с вашими карточками.');
    } catch (error) {
      notice(state, 'plan', errorText(error, 'Не удалось загрузить сохранённую версию. Ваш ввод не изменён.'), true);
    } finally {
      state.comparing = false;
      if (live(state) && button.isConnected) button.disabled = false;
    }
  }
  async function savePlan(state, replacementRevision) {
    if (!live(state) || !state.planReady || state.saving || (state.conflict && replacementRevision === undefined)) return;
    const validation = validEntries(state.draft.entries);
    if (validation) {notice(state, 'plan', validation, true); return;}
    state.saving = true;
    planControls(state);
    node(state, '[data-aw-conflict]').querySelectorAll('button').forEach((el) => {el.disabled = true;});
    notice(state, 'plan', 'Сохраняем личную программу…');
    try {
      const data = await state.ctx.apiJson(endpoint(state, 'plan'), state.ctx.csrfOptions('PUT', {
        revision: replacementRevision ?? state.draft.revision,
        entries: state.draft.entries.map((item) => ({...item, topic: item.topic.trim()})),
      }));
      if (!live(state)) return;
      const saved = checkPlan(state, data);
      Object.assign(state.draft, {revision: saved.revision, entries: saved.entries, dirty: false});
      state.conflict = false;
      state.latest = null;
      cards(state); conflictView(state);
      notice(state, 'plan', `Программа сохранена. Версия ${saved.revision}. Публикации не запускаются.`);
    } catch (error) {
      if (!live(state)) return;
      if (error?.status === 409) {
        state.conflict = true;
        state.latest = null;
        conflictView(state);
        notice(state, 'plan', 'Программа изменилась на сервере. Ваш ввод не потерян. Сравните версии ниже.', true);
      } else notice(state, 'plan', errorText(error, 'Не удалось подтвердить сохранение. Ваш ввод остался в карточках; попробуйте ещё раз.'), true);
    } finally {
      state.saving = false;
      if (live(state)) {
        planControls(state);
        node(state, '[data-aw-conflict]').querySelectorAll('button').forEach((el) => {el.disabled = false;});
      }
    }
  }
  async function loadPlan(state) {
    if (!live(state) || state.loadingPlan) return;
    state.loadingPlan = true;
    notice(state, 'plan', 'Загружаем личную программу…');
    try {
      const data = await state.ctx.apiJson(endpoint(state, 'plan'));
      if (!live(state)) return;
      const saved = checkPlan(state, data);
      if (state.draft.dirty) {
        state.conflict = state.draft.revision !== saved.revision;
        state.latest = null;
      } else Object.assign(state.draft, {entries: saved.entries, revision: saved.revision});
      state.planReady = true;
      cards(state); conflictView(state);
      notice(state, 'plan', state.conflict ? 'Программа изменилась на сервере. Ваш черновик сохранён в карточках — сравните версии.' :
        state.draft.dirty ? 'Восстановлен ваш несохранённый черновик из этой вкладки.' :
          saved.updatedAt ? `Сохранено ${dateLabel(saved.updatedAt)}. Версия ${saved.revision}.` : 'Программа пока пустая. Добавьте первую идею.');
      node(state, '[data-aw-load-plan]').hidden = true;
    } catch (error) {
      if (!live(state)) return;
      notice(state, 'plan', errorText(error, 'Не удалось загрузить программу. Повторите загрузку.'), true);
      node(state, '[data-aw-load-plan]').hidden = false;
    } finally {state.loadingPlan = false;}
  }
  const pendingText = 'Вопрос сохранён, но ответа пока нет. Автоматический повтор не выполняется.';
  function retryAvailable(message) {
    return message.aiStatus === 'pending' && Number.isSafeInteger(message.attempts) && message.attempts < 3 &&
      (!message.retryAfterAt || Date.parse(message.retryAfterAt) <= Date.now());
  }
  function chatControls(state) {
    if (!live(state)) return;
    const running = state.messages.some((item) => item.aiStatus === 'running');
    const input = node(state, '[data-aw-message]');
    input.disabled = !state.messagesReady || state.sending;
    input.readOnly = Boolean(state.draft.pending);
    node(state, '[data-aw-send]').disabled = !state.messagesReady || state.loadingMessages || state.sending || running || !state.draft.text.trim();
    node(state, '[data-aw-send]').textContent = state.sending ? 'Отправляем…' : state.draft.pending ? 'Повторить отправку' : 'Отправить Хью';
    node(state, '[data-aw-refresh-messages]').disabled = state.loadingMessages || state.sending;
    node(state, '[data-aw-messages]').querySelectorAll('[data-aw-retry]').forEach((button) => {
      button.disabled = state.sending || state.loadingMessages || running;
    });
  }
  function renderMessages(state) {
    if (!live(state)) return;
    node(state, '[data-aw-messages]').innerHTML = state.messages.length ? state.messages.map((item) => {
      const reply = item.aiStatus === 'done' && typeof item.reply === 'string' && item.reply.trim();
      const retry = retryAvailable(item);
      const waiting = item.aiStatus === 'running' ? 'Хью готовит ответ. Проверьте результат кнопкой «Обновить переписку».' : pendingText;
      const cooldown = item.aiStatus === 'pending' && item.retryAfterAt && Date.parse(item.retryAfterAt) > Date.now();
      const exhausted = item.aiStatus === 'pending' && item.attempts >= 3;
      return `<li class="aw-exchange"><article class="aw-message"><header><strong>Вы</strong><time>${esc(dateLabel(item.createdAt))}</time></header>
        <p>${esc(item.text)}</p></article><article class="aw-message aw-reply"><header><strong>Хью</strong>${reply ? `<time>${esc(dateLabel(item.replyAt))}</time>` : ''}</header>
        <p>${esc(reply || waiting)}</p>${exhausted ? '<p>Лимит повторов исчерпан. Обратитесь к управляющему.</p>' :
          cooldown ? `<p>Повтор доступен после ${esc(dateLabel(item.retryAfterAt))}. Затем обновите переписку.</p>` : ''}
        ${retry ? `<button type="button" class="plain-button" data-aw-retry="${item.id}">Повторить запрос</button>` : ''}</article></li>`;
    }).join('') : '<li class="aw-empty">Здесь будет ваша личная переписка. Начните с вопроса по теме или сценарию.</li>';
    node(state, '[data-aw-older]').hidden = !state.hasOlder;
    node(state, '[data-aw-messages]').querySelectorAll('[data-aw-retry]').forEach((button) => {
      button.disabled = state.sending || state.loadingMessages || state.messages.some((item) => item.aiStatus === 'running');
      button.addEventListener('click', () => void retryMessage(state, Number(button.dataset.awRetry)));
    });
    chatControls(state);
  }
  function checkMessages(state, data) {
    checkScope(state, data);
    if (!Array.isArray(data.messages) || data.messages.some((item) => !Number.isSafeInteger(item.id) ||
        item.id < 1 || typeof item.text !== 'string')) throw new Error('INVALID_MESSAGES');
    return data.messages;
  }
  async function loadMessages(state, older = false) {
    if (!live(state) || state.loadingMessages || state.sending) return;
    state.loadingMessages = true;
    chatControls(state);
    node(state, '[data-aw-older]').disabled = true;
    notice(state, 'chat', 'Загружаем личную переписку…');
    try {
      const before = older && state.messages.length ? `&before=${Math.min(...state.messages.map((item) => item.id))}` : '';
      const data = await state.ctx.apiJson(`${endpoint(state, 'messages')}&limit=50${before}`);
      if (!live(state)) return;
      const messages = checkMessages(state, data);
      state.messages = [...new Map((older ? [...messages, ...state.messages] : messages).map((item) => [item.id, item])).values()]
        .sort((a, b) => a.id - b.id);
      state.hasOlder = messages.length === 50;
      state.messagesReady = true;
      renderMessages(state);
      notice(state, 'chat', data.assistantEnabled === false ? 'Ответы Хью сейчас недоступны. При отправке вопрос будет сохранён, автоматического повтора нет.' :
        state.draft.pending ? 'Предыдущая отправка не подтверждена. Повторная отправка того же текста не создаёт дубль.' : 'Переписка обновлена.');
    } catch (error) {
      notice(state, 'chat', errorText(error, 'Не удалось обновить переписку. Повторите загрузку.'), true);
    } finally {
      state.loadingMessages = false;
      if (live(state)) {chatControls(state); node(state, '[data-aw-older]').disabled = false;}
    }
  }
  function acceptMessage(state, data) {
    const item = data?.message;
    if (!item || !Number.isSafeInteger(item.id) || item.id < 1 || typeof item.text !== 'string') throw new Error('INVALID_MESSAGE');
    state.messages = [...state.messages.filter((old) => old.id !== item.id), item].sort((a, b) => a.id - b.id);
    return item;
  }
  async function sendMessage(state) {
    if (!live(state) || !state.messagesReady || state.loadingMessages || state.sending || state.messages.some((item) => item.aiStatus === 'running')) return;
    const text = state.draft.text.trim();
    if (!text || text.length > 4000) {notice(state, 'chat', 'Напишите сообщение до 4000 символов.', true); return;}
    // Не меняем ключ при неизвестном результате: повторить можно только ту же отправку.
    const request = state.draft.pending || {text, clientMessageId: messageId()};
    state.draft.pending = request;
    state.sending = true;
    chatControls(state);
    notice(state, 'chat', 'Отправляем вопрос и ждём результат…');
    try {
      const data = await state.ctx.apiJson(endpoint(state, 'messages'), state.ctx.csrfOptions('POST', request));
      if (!live(state)) return;
      if (data?.message?.text !== request.text) throw new Error('INVALID_MESSAGE');
      const saved = acceptMessage(state, data);
      state.draft.pending = null;
      state.draft.text = '';
      node(state, '[data-aw-message]').value = '';
      renderMessages(state);
      notice(state, 'chat', saved.aiStatus === 'done' ? 'Ответ Хью получен.' : saved.aiStatus === 'running' ?
        'Вопрос сохранён. Хью готовит ответ; обновите переписку для проверки.' : pendingText);
    } catch (error) {
      if (!live(state)) return;
      notice(state, 'chat', errorText(error, error?.status === 409 ?
        'Сейчас нельзя отправить вопрос. Обновите переписку и повторите отправку после завершения предыдущего запроса.' :
        'Результат отправки неизвестен. Текст сохранён. Повторите отправку — это не создаст второй такой же вопрос.'), true);
    } finally {
      state.sending = false;
      if (live(state)) {chatControls(state); renderMessages(state);}
    }
  }
  async function retryMessage(state, id) {
    if (!live(state) || state.sending || state.loadingMessages || state.messages.some((item) => item.aiStatus === 'running')) return;
    const message = state.messages.find((item) => item.id === id);
    if (!message || !retryAvailable(message)) return;
    state.sending = true;
    renderMessages(state);
    notice(state, 'chat', 'Повторяем запрос к Хью…');
    try {
      const data = await state.ctx.apiJson(endpoint(state, 'retry'), state.ctx.csrfOptions('POST', {messageId: id, attempt: message.attempts}));
      if (!live(state)) return;
      if (data?.message?.id !== id) throw new Error('INVALID_MESSAGE');
      const saved = acceptMessage(state, data);
      notice(state, 'chat', saved.aiStatus === 'done' ? 'Ответ Хью получен.' : pendingText);
    } catch (error) {
      notice(state, 'chat', errorText(error, 'Не удалось подтвердить повтор. Обновите переписку, чтобы проверить состояние вопроса.'), true);
    } finally {
      state.sending = false;
      if (live(state)) renderMessages(state);
    }
  }
  const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? new Intl.NumberFormat('ru-RU').format(value) : 'Нет данных';
  const metricCards = (totals) => `<dl class="aw-metrics">${Object.entries(metrics).map(([key, label]) =>
    `<div><dt>${label}</dt><dd>${number(totals?.[key])}</dd></div>`).join('')}</dl>`;
  async function loadStats(state) {
    if (!live(state) || state.loadingStats) return;
    state.loadingStats = true;
    node(state, '[data-aw-refresh-stats]').disabled = true;
    notice(state, 'stats', 'Загружаем показатели компании…');
    try {
      const data = await state.ctx.apiJson(endpoint(state, 'stats'));
      if (!live(state)) return;
      checkScope(state, data, false);
      const period = [data.from, data.to].every((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
        ? `${data.from} — ${data.to}` : 'Период не указан';
      node(state, '[data-aw-stats]').innerHTML = `<p>Период: ${esc(period)}</p>${metricCards(data.socialAggregate)}
        <details class="aw-platforms"><summary>По площадкам</summary>${Object.entries(platforms).map(([key, label]) => {
          const platform = data.platforms?.[key];
          const status = platform?.configured !== true ? 'Источник не подключён' :
            platform.dataStatus === 'complete' ? 'Данные получены' : platform.dataStatus === 'partial' ? 'Данные неполные' : 'Данных пока нет';
          return `<section><h3>${label}</h3><p>${status}</p>${metricCards(platform?.totals)}</section>`;
        }).join('')}</details>`;
      notice(state, 'stats', 'Это общие показатели компании, без личных сообщений и результатов отдельных участников.');
    } catch (error) {
      if (!live(state)) return;
      node(state, '[data-aw-stats]')?.replaceChildren();
      notice(state, 'stats', errorText(error, 'Статистика сейчас недоступна. Это не означает нулевые показатели.'), true);
    } finally {
      state.loadingStats = false;
      if (live(state)) node(state, '[data-aw-refresh-stats]').disabled = false;
    }
  }
  function render(container, ctx) {
    sequence++;
    current = null;
    if (!can(ctx)) {container.innerHTML = '<div class="card">У вас нет доступа к личному рабочему месту.</div>'; return;}
    const code = String(ctx.selectedProjectId || ''), actorId = actor(ctx);
    if (!code || !actorId) {container.innerHTML = '<div class="card">Выберите компанию и войдите в личный аккаунт.</div>'; return;}
    const key = `${actorId}:${code}`;
    if (!drafts.has(key)) drafts.set(key, {revision: 0, entries: [], dirty: false, text: '', pending: null});
    const state = current = {id: sequence, container, ctx, code, actorId, draft: drafts.get(key),
      planReady: false, messagesReady: false, messages: [], hasOlder: false, saving: false, sending: false, conflict: false};
    const company = ctx.identity.companies?.find((item) => item.id === code)?.name || code;
    container.innerHTML = `<div class="content-header"><h1>Моё рабочее место</h1></div><div class="actor-workspace">
      <header class="aw-intro"><p class="aw-eyebrow">Лично для вас · Компания: ${esc(company)}</p>
        <p>Ваша программа, помощь Хью и общие результаты компании — в одном месте.</p><a href="#actor-onboarding">Открыть мою анкету →</a></header>
      <section class="card aw-section" aria-labelledby="aw-plan-title"><header class="aw-section-header"><div>
        <h2 id="aw-plan-title">Моя контент-программа</h2><p>Ваш собственный план. Сохранение не запускает публикации.</p></div><span data-aw-plan-count>0 из 42 материалов</span></header>
        <form data-aw-plan-form><p class="aw-hint">До 14 дней, до трёх материалов в день. Тему и состояние можно менять по мере подготовки.</p>
          <div data-aw-entries></div><div class="aw-actions"><button class="plain-button" type="button" data-aw-add disabled>+ Добавить материал</button>
            <button class="primary-button" type="submit" data-aw-save disabled>Сохранить мою программу</button></div></form>
        <p class="aw-status" role="status" aria-live="polite" data-aw-plan-status></p>
        <button type="button" class="plain-button" data-aw-load-plan hidden>Повторить загрузку программы</button>
        <aside class="aw-conflict" data-aw-conflict hidden></aside></section>
      <section class="card aw-section" aria-labelledby="aw-chat-title"><header class="aw-section-header"><div>
        <h2 id="aw-chat-title">Моя переписка с Хью</h2><p>Личный чат учитывает вашу сохранённую анкету и личный план.</p></div>
        <button type="button" class="plain-button" data-aw-refresh-messages>Обновить переписку</button></header>
        <p class="aw-hint">Это ваша переписка, отдельная от общего чата компании. Запрос уходит только по кнопке «Отправить Хью».</p>
        <button type="button" class="plain-button" data-aw-older hidden>Показать предыдущие сообщения</button>
        <ol class="aw-messages" data-aw-messages aria-label="Ваша личная переписка"></ol>
        <form data-aw-chat-form><label class="aw-message-label" for="aw-message">Ваш вопрос Хью</label>
          <textarea id="aw-message" data-aw-message maxlength="4000" rows="4" required placeholder="Помоги превратить мою идею в короткий сценарий" disabled>${esc(state.draft.text)}</textarea>
          <div class="aw-actions"><button type="submit" class="primary-button" data-aw-send disabled>Отправить Хью</button></div></form>
        <p class="aw-status" role="status" aria-live="polite" data-aw-chat-status></p></section>
      <section class="card aw-section" aria-labelledby="aw-stats-title"><header class="aw-section-header"><div><h2 id="aw-stats-title">Результаты компании</h2>
        <p>Общая обезличенная статистика площадок.</p></div><button type="button" class="plain-button" data-aw-refresh-stats>Обновить показатели</button></header>
        <div data-aw-stats></div><p class="aw-status" role="status" aria-live="polite" data-aw-stats-status></p>
        <p class="aw-hint">Просмотры и показы не равны продажам. Сумма показателей площадок не является уникальным охватом.</p></section></div>`;
    node(state, '[data-aw-plan-form]').addEventListener('submit', (event) => {event.preventDefault(); void savePlan(state);});
    node(state, '[data-aw-entries]').addEventListener('input', (event) => recordInput(state, event.target));
    node(state, '[data-aw-entries]').addEventListener('change', (event) => recordInput(state, event.target));
    node(state, '[data-aw-entries]').addEventListener('click', (event) => {
      const button = event.target.closest('[data-aw-remove]');
      if (!button || !live(state) || state.saving || !state.planReady) return;
      state.draft.entries.splice(Number(button.dataset.awRemove), 1);
      state.draft.dirty = true;
      cards(state);
      notice(state, 'plan', 'Материал убран из черновика. Сохраните программу, чтобы применить изменение.');
    });
    node(state, '[data-aw-add]').addEventListener('click', () => {
      if (!live(state) || state.saving || !state.planReady || state.draft.entries.length >= 42) return;
      state.draft.entries.push({date: today(), platform: 'instagram', format: 'reel', topic: '', status: 'idea'});
      state.draft.dirty = true;
      cards(state);
      node(state, '[data-aw-entries]').querySelector('fieldset:last-child textarea').focus();
      notice(state, 'plan', 'Добавьте тему нового материала и сохраните программу.');
    });
    node(state, '[data-aw-load-plan]').addEventListener('click', () => void loadPlan(state));
    node(state, '[data-aw-chat-form]').addEventListener('submit', (event) => {event.preventDefault(); void sendMessage(state);});
    node(state, '[data-aw-message]').addEventListener('input', (event) => {
      if (!live(state) || state.sending) return;
      if (state.draft.pending) {
        event.target.value = state.draft.text;
        notice(state, 'chat', 'Сначала подтвердите предыдущую отправку кнопкой «Повторить отправку». Это защищает от дублей.', true);
        return;
      }
      state.draft.text = event.target.value;
      chatControls(state);
    });
    node(state, '[data-aw-refresh-messages]').addEventListener('click', () => void loadMessages(state));
    node(state, '[data-aw-older]').addEventListener('click', () => void loadMessages(state, true));
    node(state, '[data-aw-refresh-stats]').addEventListener('click', () => void loadStats(state));
    planControls(state);
    void loadPlan(state); void loadMessages(state); void loadStats(state);
  }
  sb.registerView('actor-workspace', {title: 'Моё рабочее место', render,
    onProjectChange(ctx) {if (current?.container) render(current.container, ctx);}});
})();
