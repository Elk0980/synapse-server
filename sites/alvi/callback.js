(function () {
  'use strict';

  const form = document.getElementById('callback-form');
  if (!form) return;
  const name = form.elements.name;
  const phone = form.elements.phone;
  const comment = form.elements.comment;
  const addComment = form.elements.addComment;
  const commentField = form.querySelector('.callback-form__comment');
  const consent = form.elements.consent;
  const submit = form.querySelector('[type="submit"]');
  const status = form.querySelector('.callback-form__status');
  let pending = false;
  let completed = false;

  /* Метрика: цели шлёт только этот файл, по фактическому ответу сервера.
     Персональные данные в параметры целей не попадают — только технические причины. */
  const track = (goalName, params) => {
    try { if (typeof window.alviGoal === 'function') window.alviGoal(goalName, params); } catch (_) {}
  };
  // Вебвизор не записывает нажатия клавиш в полях формы: имя, телефон и комментарий.
  for (const field of [name, phone, comment].filter(Boolean)) field.classList.add('ym-disable-keys');

  /* Атрибуция заявки (правка 08.10.2026). Только учёт: тексты, поля формы и цели не меняются.
     - clientId — тот же synapse_cid, с которым общий трекер track.js шлёт визиты этого домена;
     - пять меток кампании: из текущего адреса, а без них — из сохранённого касания synapse_ft
       (его пишет track.js, 30 дней), поэтому метки не теряются при переходах между страницами;
     - referrer и страница входа — из того же касания; без касания — как раньше.
     Ничего не придумывается: нет меток — нет utm-полей. При «Не отслеживать» (DNT) clientId
     и сохранённое касание не читаются и не передаются. В Метрику отсюда по-прежнему уходят
     только имена целей и техническая причина ошибки. */
  const UTM_KEYS = ['source', 'medium', 'campaign', 'content', 'term'];
  const FIELD_LIMIT = 500;
  const TOUCH_TTL = 30 * 86400000;
  const clip = (value) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, FIELD_LIMIT) : undefined);
  const stored = (key) => { try { return window.localStorage.getItem(key); } catch (_) { return null; } };
  const attribution = () => {
    const out = {};
    const dnt = navigator.doNotTrack === '1';
    const query = new URLSearchParams(location.search);
    const urlHasUtm = UTM_KEYS.some((key) => query.get('utm_' + key));
    let touch = null;
    if (!dnt) {
      try { touch = JSON.parse(stored('synapse_ft') || 'null') || window.__synapseFirstTouch; } catch (_) { touch = window.__synapseFirstTouch; }
      if (!touch || typeof touch !== 'object' || !(Date.now() - Number(touch.ts) < TOUCH_TTL)) touch = null;
    }
    for (const key of UTM_KEYS) {
      const field = 'utm' + key.charAt(0).toUpperCase() + key.slice(1);
      const value = clip(urlHasUtm ? query.get('utm_' + key) : touch && touch[field]);
      if (value) out[field] = value;
    }
    const touchSource = touch && clip(touch.source);
    out.source = out.utmSource || (touchSource && touchSource !== 'direct' ? touchSource : 'Сайт ALVI');
    let external = '';
    try { external = document.referrer && new URL(document.referrer).origin !== location.origin ? document.referrer : ''; } catch (_) {}
    out.referrer = clip(touch && touch.referrer) || clip(external);
    out.landingPage = touch && clip(touch.landingPage) ? clip(location.origin + touch.landingPage.split('#')[0]) : location.href;
    // Если localStorage недоступен, общий трекер держит CID в памяти этой же страницы.
    const cid = dnt ? null : clip(stored('synapse_cid')) || clip(window.__synapseClientId);
    if (cid && /^[A-Za-z0-9-]{8,64}$/.test(cid)) out.clientId = cid;
    return out;
  };

  let startSent = false;
  const markStart = () => {
    if (startSent) return;
    startSent = true;
    track('callback_start');
  };

  const validPhone = (value) => {
    const digits = String(value || '').replace(/\D/g, '');
    return (digits.length === 11 && /^[78]/.test(digits)) || (digits.length >= 10 && digits.length <= 15);
  };
  const update = () => {
    submit.disabled = pending || completed || !consent.checked || !name.value.trim() || !validPhone(phone.value);
    for (const field of [name, phone, addComment, consent].filter(Boolean)) field.disabled = pending;
    if (comment) comment.disabled = pending || Boolean(addComment && !addComment.checked);
    if (commentField && addComment) {
      commentField.hidden = !addComment.checked;
      addComment.setAttribute('aria-expanded', String(addComment.checked));
    }
  };

  form.addEventListener('input', () => { markStart(); update(); });
  addComment?.addEventListener('change', () => {update();if(addComment.checked)comment?.focus();});
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending || completed) return;
    status.classList.remove('is-error');
    if (!name.value.trim() || name.value.trim().length > 80 || !consent.checked) {
      status.textContent = !consent.checked ? 'Для отправки заявки нужно ваше согласие.' : 'Укажите имя: не больше 80 символов.';
      status.classList.add('is-error');
      (!consent.checked ? consent : name).focus();
      return;
    }
    if (!validPhone(phone.value)) {
      status.textContent = 'Проверьте номер телефона.';
      status.classList.add('is-error');
      phone.setAttribute('aria-invalid', 'true');
      phone.focus();
      return;
    }
    phone.removeAttribute('aria-invalid');
    const commentText = !addComment || addComment.checked ? String(comment?.value || '').trim() : '';
    if (commentText.length > 1000) {
      status.textContent = 'Сократите комментарий до 1000 символов.';
      status.classList.add('is-error');
      comment.focus();
      return;
    }
    pending = true;
    update();
    form.setAttribute('aria-busy', 'true');
    status.textContent = 'Отправляем заявку…';
    // Запрос действительно уходит на сервер — это попытка, а не лид.
    markStart();
    track('callback_attempt');
    const touch = attribution();
    const payload = {
      name: name.value.trim(), contact: phone.value.trim(), companyCode: 'alvi',
      channel: 'Обратный звонок', source: touch.source,
      tag: 'callback', page: location.pathname, landingPage: touch.landingPage,
      referrer: touch.referrer, comment: commentText || 'Просьба перезвонить клиенту',
      utmSource: touch.utmSource, utmMedium: touch.utmMedium, utmCampaign: touch.utmCampaign,
      utmContent: touch.utmContent, utmTerm: touch.utmTerm, clientId: touch.clientId
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
      if (!response.ok || ![200, 201].includes(response.status)) throw Object.assign(new Error('request failed'), {status: response.status});
      const accepted = await response.json();
      if (!Number.isSafeInteger(accepted?.id) || accepted.id <= 0) throw Object.assign(new Error('unconfirmed response'), {reason: 'bad_id'});
      if (response.status === 200 && accepted.deduplicated === true) {
        // Повтор того же телефона — не новый лид. Отдельная цель, callback_submit не шлём.
        track('callback_duplicate');
        status.textContent = 'Заявка с этим телефоном уже есть. Чтобы уточнить запрос, позвоните в ALVI: +7 924 618-05-55 или напишите нам.';
      } else {
        if (response.status !== 201 || accepted.deduplicated === true) throw Object.assign(new Error('unconfirmed response'), {reason: 'not_created'});
        completed = true;
        form.classList.add('is-success');
        // Новая заявка: ровно 201, положительный целочисленный id, без признака дубля.
        track('callback_submit');
        status.textContent = 'Заявка принята. Спасибо за обращение!';
      }
    } catch (error) {
      const reason = error?.name === 'AbortError' ? 'timeout'
        : error?.reason ? error.reason
        : Number.isFinite(error?.status) ? String(error.status)
        : 'network';
      track('callback_error', { reason });
      status.textContent = error.status === 429
        ? 'Слишком много заявок за короткое время. Подождите несколько минут или позвоните в ALVI: +7 924 618-05-55. Введённые данные сохранены в форме.'
        : 'Не удалось подтвердить отправку заявки. Попробуйте ещё раз или позвоните в ALVI: +7 924 618-05-55. Введённые данные сохранены в форме.';
      status.classList.add('is-error');
    } finally {
      clearTimeout(timeout);
      pending = false;
      form.setAttribute('aria-busy', 'false');
      update();
    }
  });

  update();
}());
