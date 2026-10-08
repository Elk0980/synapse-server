/* A callback request is confirmed only by the CRM response, never by email delivery.
   Этапы заявки сообщаются аналитике ТОЛЬКО отсюда: глобальный fetch не
   перехватывается. Заявкой считается единственный случай — ответ 201 с целым
   положительным id и без признака дубля; дубль и ошибка — отдельные цели.
   В аналитику уходит имя цели и ничего больше: ни имя, ни телефон, ни комментарий. */
(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host && host.document) api.start(host, host.document);
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const fields = {utm_source: 'utmSource', utm_medium: 'utmMedium', utm_campaign: 'utmCampaign', utm_content: 'utmContent', utm_term: 'utmTerm'};
  // Сохранённые метки avk_src (пишет attribution.js). Запись без признака v:2, где есть только
  // utm_source и utm_medium=referral, — это старая искусственная метка органики (до правки 08.10.2026):
  // адрес предыдущего сайта, а не кампания. Такие метки не передаются как UTM.
  function legacySynthetic(saved) {
    if (!saved || saved.v === 2 || saved.utm_medium !== 'referral') return false;
    return Object.keys(saved).every(key => ['utm_source', 'utm_medium', 'first_seen'].includes(key));
  }
  function campaign(location, storage, now) {
    const query = new URL(location.href).searchParams;
    const tags = {};
    for (const key of Object.keys(fields)) {
      const value = query.get(key);
      if (value) tags[key] = value.slice(0, 500);
    }
    if (Object.keys(tags).length) return tags;
    try {
      const saved = JSON.parse(storage.getItem('avk_src') || '{}');
      const seen = Date.parse(saved.first_seen);
      if (!Number.isFinite(seen) || seen > now || now - seen >= 30 * 86400000 || legacySynthetic(saved)) return tags;
      for (const key of Object.keys(fields)) {
        if (typeof saved[key] === 'string' && saved[key]) tags[key] = saved[key].slice(0, 500);
      }
    } catch (_) {}
    return tags;
  }
  // Первое касание общего трекера track.js (synapse_ft) и его synapse_cid — тот же идентификатор,
  // что у визитов. При «Не отслеживать» (DNT) не читаются и не передаются.
  function touch(location, storage, now, env) {
    const result = {};
    const clip = value => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : '');
    if (!env || env.doNotTrack !== '1') {
      let first = null;
      try { first = JSON.parse(storage.getItem('synapse_ft') || 'null'); } catch (_) { first = null; }
      if (!first && env) first = env.memoryTouch;
      if (first && typeof first === 'object' && now - Number(first.ts) < 30 * 86400000) {
        if (clip(first.referrer)) result.referrer = clip(first.referrer);
        if (clip(first.landingPage)) result.landingPage = clip(location.origin + first.landingPage.split('#')[0]);
        if (clip(first.source) && first.source !== 'direct') result.source = clip(first.source);
      }
      let cid = '';
      try { cid = clip(storage.getItem('synapse_cid')); } catch (_) {}
      // Если localStorage недоступен, общий трекер держит CID в памяти этой же страницы.
      if (!cid && env && typeof env.memoryClientId === 'string') cid = clip(env.memoryClientId);
      if (/^[A-Za-z0-9-]{8,64}$/.test(cid)) result.clientId = cid;
    }
    if (!result.referrer && env && env.referrer) {
      try { if (new URL(env.referrer).origin !== location.origin) result.referrer = clip(env.referrer); } catch (_) {}
    }
    return result;
  }
  function payload(values, location, storage, now = Date.now(), env = {}) {
    const name = String(values.name || '').trim();
    const contact = String(values.contact || '').trim();
    const comment = String(values.comment || '').trim();
    function invalid(field, message) { throw Object.assign(new Error(message), {field}); }
    if (!name || name.length > 80) invalid('name', 'Укажите имя: не больше 80 символов.');
    const digits = contact.replace(/\D/g, '');
    if (contact.length > 32 || !/^\+?[\d\s().-]+$/.test(contact) || digits.length < 10 || digits.length > 15) {
      invalid('contact', 'Укажите номер телефона с кодом города или страны.');
    }
    if (comment.length > 1000) invalid('comment', 'Сократите комментарий до 1000 символов.');
    if (values.consent !== true) invalid('consent', 'Для отправки заявки нужно ваше согласие.');
    let tags = {};
    let first = {};
    try { tags = campaign(location, storage, now); } catch (_) { tags = {}; }
    try { first = touch(location, storage, now, env); } catch (_) { first = {}; }
    const page = location.origin + location.pathname;
    const result = {companyCode: 'avokado', name, contact, channel: 'Обратный звонок',
      source: tags.utm_source || first.source || 'Сайт АВОКАДО', comment, page, landingPage: first.landingPage || page};
    for (const [key, field] of Object.entries(fields)) if (tags[key]) result[field] = tags[key];
    if (first.referrer) result.referrer = first.referrer;
    if (first.clientId) result.clientId = first.clientId;
    return result;
  }
  async function send(win, body) {
    const controller = new win.AbortController();
    const timeout = win.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await win.fetch('/api/leads', {method: 'POST', credentials: 'omit',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: controller.signal});
      if (response.status === 429) throw Object.assign(new Error('rate limit'), {status: 429});
      if (!response.ok || ![200, 201].includes(response.status)) {
        throw Object.assign(new Error('request failed'), {status: response.status});
      }
      const accepted = await response.json();
      if (!Number.isSafeInteger(accepted?.id) || accepted.id <= 0) throw new Error('unconfirmed response');
      if (response.status === 200 && accepted.deduplicated === true) return {id: accepted.id, repeated: true};
      if (response.status !== 201 || accepted.deduplicated === true) throw new Error('unconfirmed response');
      return {id: accepted.id, repeated: false};
    } finally { win.clearTimeout(timeout); }
  }
  // Какая цель соответствует исходу отправки. Вынесено отдельно, чтобы правило
  // «заявка только при подтверждённом 201» проверялось тестом без DOM.
  function outcomeGoal(result, error) {
    if (error || !result || !Number.isSafeInteger(result.id) || result.id <= 0) return 'callback_error';
    if (result.repeated === true) return 'callback_duplicate';
    return result.repeated === false ? 'callback_submit' : 'callback_error';
  }
  // Единственный канал в аналитику. Отсутствие attribution.js ничего не ломает.
  function report(win, goal) {
    try {
      const analytics = win && win.AvokadoAnalytics;
      if (analytics && typeof analytics.track === 'function') analytics.track(goal);
    } catch (_) {}
  }
  function errorMessage(error) {
    if (error.status === 429) return 'Слишком много заявок за короткое время. Подождите несколько минут или позвоните в студию. Введённые данные сохранены в форме.';
    if (error.status === 400 || error.status === 422) return 'Не удалось принять заявку. Проверьте имя и номер телефона или позвоните в студию. Введённые данные сохранены в форме.';
    return 'Не удалось подтвердить отправку заявки. Проверьте подключение к интернету, попробуйте позже или позвоните в студию. Введённые данные сохранены в форме.';
  }
  function bind(win, form) {
    if (form.dataset.callbackReady || !win.fetch || !win.AbortController) return;
    form.dataset.callbackReady = '1';
    const controls = form.elements;
    const submit = form.querySelector('[type="submit"]');
    const fieldset = form.querySelector('fieldset');
    const status = form.querySelector('[data-callback-status]');
    const addComment = controls.namedItem('addComment');
    const comment = controls.namedItem('comment');
    const commentField = addComment ? form.querySelector('.av-callback-comment') : null;
    let pending = false;
    function updateComment() {
      if (!addComment) return;
      comment.disabled = pending || !addComment.checked;
      if (commentField) commentField.hidden = !addComment.checked;
      addComment.setAttribute('aria-expanded', String(addComment.checked));
      if (!addComment.checked) comment.setCustomValidity('');
    }
    function message(text, state) {
      status.textContent = text;
      status.dataset.state = state;
    }
    form.hidden = false;
    updateComment();
    addComment?.addEventListener('change', () => {
      updateComment();
      if (addComment.checked) comment.focus();
    });
    form.addEventListener('reset', () => Promise.resolve().then(updateComment));
    for (const name of ['name', 'contact', 'comment', 'consent']) {
      controls.namedItem(name).addEventListener('input', () => controls.namedItem(name).setCustomValidity(''));
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (pending) return;
      let body;
      try {
        let storage;
        try { storage = win.localStorage; } catch (_) {}
        body = payload({name: controls.namedItem('name').value, contact: controls.namedItem('contact').value,
          comment: !addComment || addComment.checked ? comment.value : '', consent: controls.namedItem('consent').checked}, win.location, storage,
          Date.now(), {doNotTrack: win.navigator && win.navigator.doNotTrack, referrer: win.document && win.document.referrer,
            memoryClientId: win.__synapseClientId, memoryTouch: win.__synapseFirstTouch});
      } catch (error) {
        if (error.field) {
          controls.namedItem(error.field).setCustomValidity(error.message);
          form.reportValidity();
        }
        return;
      }
      if (!form.reportValidity()) return;
      pending = true;
      updateComment();
      fieldset.disabled = true;
      submit.disabled = true;
      submit.textContent = 'Отправляем…';
      form.setAttribute('aria-busy', 'true');
      message('Отправляем заявку…', 'pending');
      // Попытка: валидация пройдена и запрос реально уходит. Это ещё не заявка.
      report(win, 'callback_attempt');
      try {
        const result = await send(win, body);
        if (result.repeated) {
          report(win, outcomeGoal(result));
          message('Заявка с этим телефоном уже есть. Чтобы уточнить запрос, позвоните в студию или напишите нам.', 'existing');
        } else {
          report(win, outcomeGoal(result));
          form.reset();
          message('Заявка сохранена. Спасибо за обращение!', 'success');
        }
      } catch (error) {
        report(win, outcomeGoal(null, error));
        message(errorMessage(error), 'error');
      } finally {
        pending = false;
        fieldset.disabled = false;
        updateComment();
        submit.disabled = false;
        submit.textContent = 'Заказать обратный звонок';
        form.setAttribute('aria-busy', 'false');
        status.focus();
      }
    });
  }
  function start(win, doc) { doc.querySelectorAll('[data-callback-form]').forEach(form => bind(win, form)); }
  return {campaign, touch, legacySynthetic, payload, send, report, outcomeGoal, bind, start};
});
