(() => {
  'use strict';
  /* Защищённый ввод ключей провайдеров Хью в настройках системы (только владелец).
     Ключ уходит на сервер и обратно никогда не возвращается: его не хранит ни поле формы
     после отправки, ни localStorage, ни адрес страницы. Сохранение ничего не включает
     и не списывает денег; проверка соединения — отдельное явное действие. */
  const sb = window.SbCabinet = window.SbCabinet || {};
  const CHECK = {not_checked: 'не проверено', ok: 'проверено', failed: 'проверка не прошла'};
  let host, api, esc, state;

  const moment = (value) => (value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('ru-RU') : '—');

  /* Деньги показываем так, чтобы мелкий расход не превращался в «0,00 $»:
     до цента округление скрывает первые обращения и создаёт ложное «ничего не тратим». */
  const money = (value) => (Number.isFinite(value)
    ? `${value.toFixed(value > 0 && value < 0.01 ? 4 : 2).replace('.', ',')} $` : '—');

  /* Расход за окно и личный лимит. Отсутствие лимита названо словами, а не пустотой:
     пустое место читается как «лимит есть и он не достигнут», что неправда. */
  function spendMarkup(item) {
    const spend = item.spend;
    if (!spend) return '';
    const limit = spend.limitUsd === null || spend.limitUsd === undefined
      ? 'личный лимит не задан' : `личный лимит ${money(spend.limitUsd)}`;
    const stopped = spend.stopped
      ? `<strong> Остановлен: ${esc(spend.reason)}</strong>` : '';
    return `<p class="hugh-note" data-spend="${esc(item.name)}">За текущее окно: ` +
      `${esc(money(spend.spentUsd))}, обращений ${esc(spend.requests)} · ${esc(limit)}.${stopped}</p>`;
  }

  /* Общая граница расхода. «Не настроена» и «настроена, но неверно» — разные состояния:
     второе останавливает платный резерв целиком, и молчать об этом нельзя. */
  function budgetMarkup(budget) {
    if (!budget) return '';
    if (budget.blockedByConfig) {
      return `<p class="hugh-locked" role="alert" data-budget>Границы бюджета заданы неверно: ` +
        `платный резерв остановлен. ${esc(budget.reason)}</p>`;
    }
    if (!budget.configured) {
      return '<p class="hugh-note" data-budget>Общая граница расхода не задана: ' +
        'резервные провайдеры работают без денежного потолка.</p>';
    }
    const requests = budget.maxRequests > 0
      ? `, обращений ${budget.requests} из ${budget.maxRequests}` : `, обращений ${budget.requests}`;
    const stopped = budget.stopped ? ` Остановлено: ${budget.reason}.` : '';
    return `<p class="hugh-note" data-budget>Общий расход за окно ${esc(budget.windowDays)} дн.: ` +
      `${esc(money(budget.spentUsd))} из ${esc(money(budget.limitUsd))}${esc(requests)}. ` +
      `Окно обновится ${esc(moment(budget.resetAt))}.${esc(stopped)}</p>`;
  }

  function providerMarkup(item) {
    const locked = !state.storeAvailable;
    // Провайдер без реализованного контракта не предлагает форму: вид работы не изображаем.
    if (item.contractSupported === false) {
      return `<details class="hugh-provider" data-provider="${esc(item.name)}">
        <summary>${esc(item.title)} — через этот контракт не подключается</summary>
        <p class="hugh-note">${esc(item.unsupportedReason)}</p>
        <p class="hugh-note"><a href="${esc(item.console)}" target="_blank" rel="noopener">кабинет провайдера</a></p></details>`;
    }
    return `<details class="hugh-provider" data-provider="${esc(item.name)}"${item.keyConfigured ? ' open' : ''}>
      <summary>${esc(item.title)} — ключ ${item.keyConfigured ? 'задан' : 'не задан'} ·
        ${esc(item.enabled ? 'включён' : 'выключен')} · ${esc(CHECK[item.checkState] || item.checkState)}${item.checkStale ? ' (для прошлой версии настройки)' : ''}</summary>
      <p class="hugh-note">Официальные адреса: ${item.hosts.map((value) => esc(value)).join(', ')} ·
        <a href="${esc(item.console)}" target="_blank" rel="noopener">кабинет провайдера</a>.
        Успешная проверка подтверждает совместимость контракта, но не подтверждает, что хост
        принадлежит провайдеру.</p>
      ${item.keySetAt ? `<p class="hugh-note">Ключ задан: ${esc(moment(item.keySetAt))}. Значение не показывается и не возвращается сервером.</p>` : ''}
      ${item.checkedAt ? `<p class="hugh-note">Последняя проверка: ${esc(moment(item.checkedAt))} · ${esc(item.checkMessage)}</p>` : ''}
      ${spendMarkup(item)}
      <form class="crm-form" data-form="${esc(item.name)}"${locked ? ' hidden' : ''}>
        <input type="hidden" name="revision" value="${esc(item.revision)}">
        <label>Адрес API (только из официальных)<input name="baseUrl" value="${esc(item.baseUrl)}"
          placeholder="https://${esc(item.hosts[0])}/v1" required></label>
        <label>Фактический идентификатор модели<input name="modelId" value="${esc(item.modelId)}" required></label>
        <label>Ключ API (вводится один раз, обратно не показывается)
          <input name="apiKey" type="password" autocomplete="off" spellcheck="false"
            placeholder="${item.keyConfigured ? 'ключ задан — оставьте пустым, чтобы не менять' : 'вставьте ключ'}"></label>
        <label>Таймаут, мс<input name="timeoutMs" type="number" min="5000" max="180000" value="${esc(item.timeoutMs)}"></label>
        <label>Потолок ответа, токенов<input name="maxOutputTokens" type="number" min="1" max="200000" value="${esc(item.maxOutputTokens)}"></label>
        <label>Цена запроса, $ за 1000<input name="pricePromptUsdPer1k" type="number" step="0.000001" min="0"
          value="${item.pricePromptUsdPer1k === null ? '' : esc(item.pricePromptUsdPer1k)}"></label>
        <label>Цена ответа, $ за 1000<input name="priceCompletionUsdPer1k" type="number" step="0.000001" min="0"
          value="${item.priceCompletionUsdPer1k === null ? '' : esc(item.priceCompletionUsdPer1k)}"></label>
        <label>Лимит расходов, $<input name="budgetUsd" type="number" step="0.01" min="0"
          value="${item.budgetUsd === null ? '' : esc(item.budgetUsd)}"></label>
        <label class="hugh-check"><input name="enabled" type="checkbox"${item.enabled ? ' checked' : ''}${item.checkCurrent ? '' : ' disabled'}>
          Использовать этого провайдера для ответов</label>
        ${item.checkCurrent ? '' : '<p class="hugh-note">Включение станет доступно после успешной проверки этой настройки. Смена адреса, модели или ключа проверку обесценивает.</p>'}
        <div class="crm-actions wide"><button class="plain-button" type="submit">Сохранить настройку</button>
          <button class="plain-button" type="button" data-check="${esc(item.name)}"${item.keyConfigured ? '' : ' disabled'}>Проверить соединение</button>
          <span data-state="${esc(item.name)}" role="status"></span></div>
      </form></details>`;
  }

  function render() {
    host.hidden = false;
    host.innerHTML = `<h2>Провайдеры ответов Хью</h2>
      <p class="hugh-note">${esc(state.notice)}</p>
      ${state.storeAvailable ? '' : `<p class="hugh-locked" role="alert">${esc(state.lockedReason)}. Пока мастер-ключ не задан на сервере, ключи вводить нельзя.</p>`}
      ${budgetMarkup(state.budget)}
      ${state.providers.map((item) => providerMarkup(item)).join('')}`;
    host.querySelectorAll('form[data-form]').forEach((form) => {
      form.addEventListener('submit', (event) => { event.preventDefault(); void save(form); });
    });
    host.querySelectorAll('[data-check]').forEach((button) => {
      button.addEventListener('click', () => { void check(button.dataset.check); });
    });
  }

  const busy = (form, value) => form.querySelectorAll('button,input').forEach((element) => { element.disabled = value; });

  async function save(form) {
    const name = form.dataset.form, note = host.querySelector(`[data-state="${name}"]`);
    const number = (field) => (form.elements[field].value === '' ? null : Number(form.elements[field].value));
    const body = {revision: Number(form.elements.revision.value),
      baseUrl: form.elements.baseUrl.value.trim(), modelId: form.elements.modelId.value.trim(),
      timeoutMs: Number(form.elements.timeoutMs.value), maxOutputTokens: Number(form.elements.maxOutputTokens.value),
      pricePromptUsdPer1k: number('pricePromptUsdPer1k'), priceCompletionUsdPer1k: number('priceCompletionUsdPer1k'),
      budgetUsd: number('budgetUsd'), enabled: form.elements.enabled.checked};
    const key = form.elements.apiKey.value;
    if (key) body.apiKey = key;
    busy(form, true);
    note.textContent = 'Сохраняем…';
    try {
      await api(`/content/hugh-providers/${encodeURIComponent(name)}`, 'PUT', body);
      // Ключ стирается из формы сразу: в DOM он не задерживается.
      form.elements.apiKey.value = '';
      await load('Настройка сохранена. Это не включает ответы и не списывает денег.');
    } catch (error) {
      busy(form, false);
      form.elements.apiKey.value = '';
      note.textContent = error.message;
    }
  }

  async function check(name) {
    const note = host.querySelector(`[data-state="${name}"]`);
    note.textContent = 'Проверяем соединение…';
    try {
      const result = await api(`/content/hugh-providers/${encodeURIComponent(name)}/check`, 'POST');
      await load(`${result.checkState === 'ok' ? 'Проверка прошла' : 'Проверка не прошла'}: ${result.checkMessage}`);
    } catch (error) { note.textContent = error.message; }
  }

  async function load(message) {
    state = await api('/content/hugh-providers', 'GET');
    render();
    if (message) {
      const status = host.querySelector('[role=status]');
      if (status) status.textContent = message;
    }
  }

  sb.initHughProviders = ({identity, byId, apiJson, escapeHTML}) => {
    if (identity?.role !== 'owner') return;
    host = byId('hugh-providers');
    if (!host) return;
    esc = escapeHTML;
    api = async (path, method, body) => apiJson(path, {method,
      headers: {'X-CSRF-Token': identity.csrfToken},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    load().catch((error) => {
      host.hidden = false;
      host.innerHTML = `<h2>Провайдеры ответов Хью</h2><p role="alert">Не удалось загрузить настройки: ${escapeHTML(error.message)}</p>`;
    });
  };
})();
