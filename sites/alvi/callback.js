(function () {
  'use strict';

  const form = document.getElementById('callback-form');
  if (!form) return;
  const phone = form.elements.phone;
  const consent = form.elements.consent;
  const submit = form.querySelector('[type="submit"]');
  const status = form.querySelector('.callback-form__status');
  const validPhone = (value) => {
    const digits = String(value || '').replace(/\D/g, '');
    return (digits.length === 11 && /^[78]/.test(digits)) || (digits.length >= 10 && digits.length <= 15);
  };
  const update = () => { submit.disabled = !consent.checked || !form.elements.name.value.trim() || !validPhone(phone.value); };

  form.addEventListener('input', update);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.classList.remove('is-error');
    if (!validPhone(phone.value)) {
      status.textContent = 'Проверьте номер телефона.';
      status.classList.add('is-error');
      phone.setAttribute('aria-invalid', 'true');
      phone.focus();
      return;
    }
    phone.removeAttribute('aria-invalid');
    submit.disabled = true;
    status.textContent = 'Отправляем заявку…';
    const query = new URLSearchParams(location.search);
    const payload = {
      name: form.elements.name.value.trim(), contact: phone.value.trim(), companyCode: 'alvi',
      channel: 'Обратный звонок', source: query.get('utm_source') || 'Сайт ALVI',
      tag: 'callback', page: location.pathname, landingPage: location.href,
      referrer: document.referrer || undefined, comment: 'Просьба перезвонить клиенту'
    };
    try {
      const response = await fetch('/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error('request failed');
      form.classList.add('is-success');
      status.textContent = 'Спасибо! Заявка отправлена. Администратор ALVI свяжется с вами по указанному номеру.';
    } catch (_) {
      status.textContent = 'Не удалось отправить заявку. Попробуйте ещё раз или позвоните нам: +7 924 618-05-55.';
      status.classList.add('is-error');
      update();
    }
  });

  update();
}());
