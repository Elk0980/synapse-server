(function () {
  'use strict';

  const form = document.getElementById('callback-form');
  if (!form) return;
  const name = form.elements.name;
  const phone = form.elements.phone;
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
    for (const field of [name, phone, consent]) field.disabled = pending;
  };

  form.addEventListener('input', update);
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
    pending = true;
    update();
    form.setAttribute('aria-busy', 'true');
    status.textContent = 'Отправляем заявку…';
    const query = new URLSearchParams(location.search);
    const payload = {
      name: name.value.trim(), contact: phone.value.trim(), companyCode: 'alvi',
      channel: 'Обратный звонок', source: query.get('utm_source') || 'Сайт ALVI',
      tag: 'callback', page: location.pathname, landingPage: location.href,
      referrer: document.referrer || undefined, comment: 'Просьба перезвонить клиенту'
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
