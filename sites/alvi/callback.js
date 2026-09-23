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

  form.addEventListener('input', update);
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
    const query = new URLSearchParams(location.search);
    const fields = ['Source', 'Medium', 'Campaign', 'Content', 'Term'];
    const hasCampaign = fields.some(field => query.get('utm_' + field.toLowerCase()));
    let saved = {}, clientId;
    if (typeof navigator === 'undefined' || navigator.doNotTrack !== '1') {
      try {
        const candidate = JSON.parse(localStorage.getItem('synapse_ft') || '{}');
        const age = Date.now() - Number(candidate?.ts);
        if (age >= 0 && age < 30 * 86400000) saved = candidate;
        const existingId = localStorage.getItem('synapse_cid');
        if (typeof existingId === 'string' && /^[\w-]{1,128}$/.test(existingId)) clientId = existingId;
      } catch (_) {}
    }
    const attribution = {};
    for (const field of fields) {
      const value = hasCampaign ? query.get('utm_' + field.toLowerCase()) : saved['utm' + field];
      if (typeof value === 'string' && value) attribution['utm' + field] = value.slice(0, 512);
    }
    const payload = {
      name: name.value.trim(), contact: phone.value.trim(), companyCode: 'alvi',
      channel: 'Обратный звонок', source: attribution.utmSource || (!hasCampaign && saved.source) || 'Сайт ALVI',
      tag: 'callback', page: location.pathname, landingPage: location.pathname,
      referrer: document.referrer || undefined, comment: commentText || 'Просьба перезвонить клиенту',
      ...attribution, ...(clientId ? {clientId} : {})
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
      if (!response.ok || ![200, 201].includes(response.status)) throw Object.assign(new Error('request failed'), {status: response.status});
      const accepted = await response.json();
      if (!Number.isSafeInteger(accepted?.id) || accepted.id <= 0) throw new Error('unconfirmed response');
      if (response.status === 200 && accepted.deduplicated === true) {
        status.textContent = 'Заявка с этим телефоном уже есть. Чтобы уточнить запрос, позвоните в ALVI: +7 924 618-05-55 или напишите нам.';
      } else {
        if (response.status !== 201 || accepted.deduplicated === true) throw new Error('unconfirmed response');
        completed = true;
        form.classList.add('is-success');
        status.textContent = 'Заявка принята. Спасибо за обращение!';
      }
    } catch (error) {
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
