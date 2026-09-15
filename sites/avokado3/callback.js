/* A callback request is confirmed only by the CRM response, never by email delivery. */
(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host && host.document) api.start(host, host.document);
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const fields = {utm_source: 'utmSource', utm_medium: 'utmMedium', utm_campaign: 'utmCampaign', utm_content: 'utmContent', utm_term: 'utmTerm'};
  function campaign(location, storage, now) {
    const query = new URL(location.href).searchParams;
    const tags = {};
    for (const key of Object.keys(fields)) {
      const value = query.get(key);
      if (value) tags[key] = value.slice(0, 512);
    }
    if (Object.keys(tags).length) return tags;
    try {
      const saved = JSON.parse(storage.getItem('avk_src') || '{}');
      const seen = Date.parse(saved.first_seen);
      if (!Number.isFinite(seen) || seen > now || now - seen >= 30 * 86400000) return tags;
      for (const key of Object.keys(fields)) {
        if (typeof saved[key] === 'string' && saved[key]) tags[key] = saved[key].slice(0, 512);
      }
    } catch (_) {}
    return tags;
  }
  function payload(values, location, storage, now = Date.now()) {
    const name = String(values.name || '').trim();
    const contact = String(values.contact || '').trim();
    const comment = String(values.comment || '').trim();
    function invalid(field, message) { throw Object.assign(new Error(message), {field}); }
    if (!name || name.length > 80) invalid('name', 'Укажите имя: не больше 80 символов.');
    const digits = contact.replace(/\D/g, '');
    if (contact.length > 32 || !/^\+?[\d\s().-]+$/.test(contact) || digits.length < 7 || digits.length > 15) {
      invalid('contact', 'Укажите номер телефона с кодом города или страны.');
    }
    if (comment.length > 1000) invalid('comment', 'Сократите комментарий до 1000 символов.');
    if (values.consent !== true) invalid('consent', 'Для отправки заявки нужно ваше согласие.');
    const tags = campaign(location, storage, now);
    const page = location.origin + location.pathname;
    const result = {companyCode: 'avokado', name, contact, channel: 'Обратный звонок',
      source: tags.utm_source || 'Сайт АВОКАДО', comment, page, landingPage: page};
    for (const [key, field] of Object.entries(fields)) if (tags[key]) result[field] = tags[key];
    return result;
  }
  async function send(win, body) {
    const controller = new win.AbortController();
    const timeout = win.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await win.fetch('/api/leads', {method: 'POST', credentials: 'omit',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: controller.signal});
      if (response.status === 429) throw Object.assign(new Error('rate limit'), {status: 429});
      if (!response.ok) throw Object.assign(new Error('request failed'), {status: response.status});
      const accepted = await response.json();
      if (!Number.isSafeInteger(accepted?.id) || accepted.id <= 0) throw new Error('unconfirmed response');
      return accepted.id;
    } finally { win.clearTimeout(timeout); }
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
    let pending = false;
    function message(text, state) {
      status.textContent = text;
      status.dataset.state = state;
    }
    form.hidden = false;
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
          comment: controls.namedItem('comment').value, consent: controls.namedItem('consent').checked}, win.location, storage);
      } catch (error) {
        if (error.field) {
          controls.namedItem(error.field).setCustomValidity(error.message);
          form.reportValidity();
        }
        return;
      }
      if (!form.reportValidity()) return;
      pending = true;
      fieldset.disabled = true;
      submit.disabled = true;
      submit.textContent = 'Отправляем…';
      form.setAttribute('aria-busy', 'true');
      message('Отправляем заявку…', 'pending');
      try {
        await send(win, body);
        form.reset();
        message('Заявка принята. Администратор свяжется с вами.', 'success');
      } catch (error) {
        message(errorMessage(error), 'error');
      } finally {
        pending = false;
        fieldset.disabled = false;
        submit.disabled = false;
        submit.textContent = 'Оставить заявку';
        form.setAttribute('aria-busy', 'false');
        status.focus();
      }
    });
  }
  function start(win, doc) { doc.querySelectorAll('[data-callback-form]').forEach(form => bind(win, form)); }
  return {campaign, payload, send, bind, start};
});
