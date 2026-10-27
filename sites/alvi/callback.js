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
  if (!name || !phone || !consent || !submit || !status) return;

  const REQUEST_TIMEOUT_MS = 15000;
  const CALL_ALVI = 'позвоните в ALVI: +7 924 618-05-55';
  let pending = false;
  let completed = false;
  // На экране сейчас объяснение, каких полей не хватает: обновляется по мере исправления.
  let explaining = false;

  /* Метрика: цели шлёт только этот файл, по фактическому ответу сервера.
     Персональные данные в параметры целей не попадают — только технические причины. */
  const track = (goalName, params) => {
    try { if (typeof window.alviGoal === 'function') window.alviGoal(goalName, params); } catch (_) {}
  };
  // Вебвизор не записывает нажатия клавиш в полях формы: имя, телефон и комментарий.
  for (const field of [name, phone, comment]) if (field) field.classList.add('ym-disable-keys');

  let startSent = false;
  const markStart = () => {
    if (startSent) return;
    startSent = true;
    track('callback_start');
  };

  const startsWithPlus7 = (raw) => /^\+\s*7/.test(raw);
  const validPhone = (value) => {
    const raw = String(value || '').trim();
    const digits = raw.replace(/\D/g, '');
    // Номер, начатый с +7, — российский или казахстанский: после кода страны не меньше 10 цифр
    // (меньше — пропущена цифра; больше допускаем, как и раньше, — например, добавочный).
    if (startsWithPlus7(raw)) return digits.length >= 11 && digits.length <= 15;
    return (digits.length === 11 && /^[78]/.test(digits)) || (digits.length >= 10 && digits.length <= 15);
  };
  const commentOn = () => !addComment || addComment.checked;
  const commentText = () => (comment && commentOn() ? String(comment.value || '').trim() : '');

  // Что мешает отправке — в порядке полей на экране. Пустой список: можно отправлять.
  const problems = () => {
    const list = [];
    const nameValue = String(name.value || '').trim();
    const phoneValue = String(phone.value || '').trim();
    if (!nameValue) list.push({ field: name, text: 'укажите имя' });
    else if (nameValue.length > 80) list.push({ field: name, text: 'сократите имя до 80 символов' });
    if (!phoneValue) list.push({ field: phone, text: 'укажите телефон' });
    else if (!validPhone(phoneValue)) {
      const short = startsWithPlus7(phoneValue) && phoneValue.replace(/\D/g, '').length < 11;
      list.push({ field: phone, text: short ? 'проверьте номер: после +7 нужно 10 цифр' : 'проверьте номер телефона' });
    }
    if (commentText().length > 1000) list.push({ field: comment, text: 'сократите комментарий до 1000 символов' });
    if (!consent.checked) list.push({ field: consent, text: 'отметьте согласие на обработку персональных данных' });
    return list;
  };

  const setStatus = (text, isError) => {
    if (status.textContent !== text) status.textContent = text;
    status.classList.toggle('is-error', Boolean(isError));
  };
  const markInvalid = (list) => {
    for (const field of [name, phone, comment, consent]) {
      if (!field) continue;
      if (list.some((item) => item.field === field)) field.setAttribute('aria-invalid', 'true');
      else field.removeAttribute('aria-invalid');
    }
  };
  const explain = (list) => {
    explaining = list.length > 0;
    markInvalid(list);
    setStatus(explaining ? 'Чтобы отправить заявку, ' + list.map((item) => item.text).join(', ') + '.' : '', explaining);
  };
  // Пока человек исправляет поля, текст меняется только когда исправлено поле целиком,
  // а не на каждое нажатие: так экранный диктор не повторяет фразу снова и снова.
  const fieldsOf = (list) => list.map((item) => item.field);
  let shownFields = [];
  const explainLive = () => {
    const list = problems();
    const fields = fieldsOf(list);
    if (fields.length === shownFields.length && fields.every((field, i) => field === shownFields[i])) return;
    shownFields = fields;
    explain(list);
  };
  // Объяснение в строке статуса связано и с теми полями, у которых в разметке нет aria-describedby.
  if (status.id) for (const field of [name, consent]) if (!field.hasAttribute('aria-describedby')) field.setAttribute('aria-describedby', status.id);

  const update = () => {
    // Кнопку не блокируем из-за незаполненных полей: иначе нажатие и Enter молча ничего не делают,
    // а объяснение, чего не хватает, человек не увидит.
    submit.disabled = pending || completed;
    for (const field of [name, phone, addComment, consent]) if (field) field.disabled = pending;
    if (comment) comment.disabled = pending || !commentOn();
    if (commentField && addComment) {
      commentField.hidden = !addComment.checked;
      addComment.setAttribute('aria-expanded', String(addComment.checked));
    }
    if (explaining && !pending && !completed) explainLive();
  };

  const onEdit = () => { markStart(); update(); };
  form.addEventListener('input', onEdit);
  // Автозаполнение, менеджеры паролей и часть мобильных браузеров сообщают о новом значении только событием change.
  form.addEventListener('change', onEdit);
  if (addComment) addComment.addEventListener('change', () => { update(); if (addComment.checked && comment) comment.focus(); });

  const failure = (message, extra) => Object.assign(new Error(message), extra);

  // Подготовка запроса: всё, что может упасть ДО отправки. Ошибка здесь — POST не уходит и цель попытки не шлётся.
  const prepareLead = () => {
    if (typeof fetch !== 'function') throw failure('fetch unavailable');
    const query = new URLSearchParams(location.search);
    const text = commentText();
    const body = JSON.stringify({
      name: name.value.trim(), contact: phone.value.trim(), companyCode: 'alvi',
      channel: 'Обратный звонок', source: query.get('utm_source') || 'Сайт ALVI',
      tag: 'callback', page: location.pathname, landingPage: location.href,
      referrer: document.referrer || undefined, comment: text || 'Просьба перезвонить клиенту'
    });
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    return { body, controller };
  };

  // Отправка: единственный реальный fetch вызывается синхронно, сразу после цели callback_attempt.
  // Один запрос, без автоматических повторов. Таймаут покрывает и ответ, и чтение тела.
  const sendLead = async (prepared) => {
    const controller = prepared.controller;
    let timer = null;
    const request = (async () => {
      const response = await fetch('/api/leads', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: prepared.body, signal: controller ? controller.signal : undefined
      });
      if (response.status !== 200 && response.status !== 201) throw failure('request failed', { status: response.status });
      let accepted;
      try {
        accepted = await response.json();
      } catch (error) {
        if (error && error.name === 'AbortError') throw error;
        throw failure('response is not JSON', { reason: 'bad_json' });
      }
      return { status: response.status, accepted };
    })();
    request.catch(() => {}); // проигравший гонку запрос не должен давать необработанную ошибку
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (controller) controller.abort();
        reject(failure('timeout', { reason: 'timeout' }));
      }, REQUEST_TIMEOUT_MS);
    });
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending || completed) return;
    const list = problems();
    if (list.length) {
      shownFields = fieldsOf(list);
      explain(list);
      list[0].field.focus();
      return;
    }
    shownFields = [];
    explain([]);
    let prepared;
    try {
      prepared = prepareLead();
    } catch (_) {
      // Запрос не отправлялся: ни POST, ни цели попытки. Поля остаются доступными.
      setStatus('Не удалось отправить заявку из этого браузера. Введённые данные сохранены в форме: ' + CALL_ALVI + '.', true);
      return;
    }
    pending = true;
    update();
    form.setAttribute('aria-busy', 'true');
    setStatus('Отправляем заявку…', false);
    markStart();
    // Запрос действительно уходит на сервер — это попытка, а не лид. Цель стоит вплотную к fetch.
    track('callback_attempt');
    try {
      const result = await sendLead(prepared);
      const accepted = result.accepted;
      if (!accepted || !Number.isSafeInteger(accepted.id) || accepted.id <= 0) throw failure('unconfirmed response', { reason: 'bad_id' });
      if (result.status === 200 && accepted.deduplicated === true) {
        // Повтор того же телефона — не новый лид. Отдельная цель, callback_submit не шлём.
        track('callback_duplicate');
        setStatus('Заявка с этим телефоном уже есть. Чтобы уточнить запрос, позвоните в ALVI: +7 924 618-05-55 или напишите нам.', false);
      } else {
        if (result.status !== 201 || accepted.deduplicated === true) throw failure('unconfirmed response', { reason: 'not_created' });
        completed = true;
        form.classList.add('is-success');
        // Новая заявка: ровно 201, положительный целочисленный id, без признака дубля.
        track('callback_submit');
        setStatus('Заявка принята. Спасибо за обращение!', false);
      }
    } catch (error) {
      const code = error && Number.isFinite(error.status) ? error.status : null;
      const reason = error && error.reason ? error.reason
        : error && error.name === 'AbortError' ? 'timeout'
        : code !== null ? String(code)
        : 'network';
      track('callback_error', { reason });
      const kept = 'Введённые данные сохранены в форме';
      let message;
      if (code === 429) {
        message = 'Слишком много заявок за короткое время. Подождите несколько минут или ' + CALL_ALVI + '. ' + kept + '.';
      } else if (code === 400 || code === 422) {
        // Отказ по существующему контракту: сервер не принял данные заявки.
        message = 'Заявка не отправлена: сервер не принял данные. ' + kept + ': проверьте имя и телефон и отправьте ещё раз или ' + CALL_ALVI + '.';
      } else {
        // Запрос уже ушёл, а подтверждения нет (таймаут, обрыв связи, другие коды, непонятный ответ):
        // исход неизвестен. Повторов сами не делаем.
        message = 'Не получили подтверждения от сервера — заявка могла дойти. ' + kept + ': можно отправить ещё раз или ' + CALL_ALVI + '.';
      }
      setStatus(message, true);
    } finally {
      pending = false;
      form.setAttribute('aria-busy', 'false');
      update();
    }
  });

  update();
}());
