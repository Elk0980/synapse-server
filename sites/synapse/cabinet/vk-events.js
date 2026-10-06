(() => {
  'use strict';
  // spec092-vk-events: owner-only view of VK incoming events (Callback API + Bots Long Poll).
  // Secrets are typed by the owner, sent once over the CSRF-protected proxy and never shown back.
  const cabinet = window.SbCabinet = window.SbCabinet || {};
  const errors = {
    INVALID_SETTINGS: 'Проверьте ID сообщества и поля событий.', SECRET_REQUIRED: 'Для Callback API нужны секретный ключ и строка подтверждения.',
    TOKEN_REQUIRED: 'Для Long Poll нужен ключ доступа сообщества.', SETTINGS_CHANGED: 'Настройки изменились. Раздел обновлён — повторите действие.',
    NOT_CONFIGURED: 'Сначала сохраните настройки.', TOKEN_UNREADABLE: 'Сохранённый ключ недоступен. Введите его заново.',
    NOT_CHECKED: 'Сначала нажмите «Проверить доступ».', LONGPOLL_DISABLED_IN_VK: 'Включите Long Poll API в сообществе: Управление → Дополнительно → Работа с API → Long Poll API.',
    LONGPOLL_NOT_ENABLED: 'Включите Long Poll в настройках выше и сохраните.', LEASE_HELD: 'Long Poll уже работает в другом процессе сервера.',
    ACCESS_DENIED: 'ВК не подтвердил доступ ключа сообщества.', GROUP_MISMATCH: 'Ответ ВК не совпадает с выбранным сообществом.',
    RESPONSE_INVALID: 'ВК вернул неожиданный ответ.', CONNECTION_UNCERTAIN: 'ВК не ответил вовремя.', LP_SERVER_UNTRUSTED: 'ВК выдал неизвестный адрес Long Poll; подключение остановлено.',
    STORE_FAILED: 'Не удалось сохранить события; Long Poll повторит попытку.', INVALID_REQUEST: 'Проверьте параметры.', FORBIDDEN: 'Раздел доступен владельцу.'
  };
  const transports = {callback: 'Callback', longpoll: 'Long Poll'};
  const lpStatus = {listening: 'слушает события', starting: 'запускается', retrying: 'повторяет подключение', error: 'остановлен с ошибкой', stopped: 'остановлен'};
  const time = value => value ? new Date(value).toLocaleString('ru-RU') : '—';

  cabinet.mountVkEvents = (container, initial) => {
    let ctx = initial, companyCode = '', epoch = 0, busy = false, settings = null, items = [], armed = '';
    const owner = () => ctx.identity?.role === 'owner';
    const node = id => container.querySelector('#vke-' + id);
    const say = text => { if (node('status')) node('status').textContent = text; };
    const request = (path, body, method = 'POST', query = {}) => ctx.apiJson('/content/crm/vk-events' + path + '?' + new URLSearchParams({companyCode, ...query}),
      body === undefined ? undefined : ctx.csrfOptions(method, body));
    const own = data => { if (!data || data.companyCode !== companyCode) throw Object.assign(Error('WRONG_COMPANY'), {code: 'WRONG_COMPANY'}); return data; };
    container.classList.add('vk-events');
    container.innerHTML = `<h3>События ВК: Callback API и Long Poll</h3>
      <p>Synapse только принимает события сообщества в журнал. Ничего не отправляется в ВК: нет автоответов, публикаций и платежей. Приём событий не означает доступ к товарам, статистике или оформлению.</p>
      <div class="vke-state"><p id="vke-callback-state"></p><p id="vke-longpoll-state"></p><p id="vke-vk-settings"></p></div>
      <form id="vke-form" autocomplete="off"><label>Числовой ID сообщества<input id="vke-group" inputmode="numeric" pattern="[1-9][0-9]*" required></label>
        <fieldset><legend>Callback API</legend><label class="vke-toggle"><input id="vke-cb-enabled" type="checkbox"> Принимать события по Callback</label>
          <label>Секретный ключ (из настроек Callback API в ВК)<input id="vke-cb-secret" type="password" autocomplete="new-password" spellcheck="false" placeholder="Пустое поле сохраняет прежний"></label>
          <label>Строка, которую должен вернуть сервер<input id="vke-cb-confirm" type="password" autocomplete="new-password" spellcheck="false" placeholder="Пустое поле сохраняет прежнюю"></label>
          <p class="vke-note">Адрес сервера для ВК: <code id="vke-url">появится после сохранения</code></p></fieldset>
        <fieldset><legend>Bots Long Poll</legend><label class="vke-toggle"><input id="vke-lp-enabled" type="checkbox"> Получать события через Long Poll</label>
          <label>Ключ доступа сообщества<input id="vke-lp-token" type="password" autocomplete="new-password" spellcheck="false" placeholder="Пустое поле сохраняет прежний"></label></fieldset>
        <button type="submit" class="plain-button" id="vke-save">Сохранить настройки событий</button></form>
      <div class="vk-actions"><button type="button" class="plain-button" id="vke-check">Проверить доступ</button>
        <button type="button" class="plain-button" id="vke-lp-start">Запустить Long Poll</button><button type="button" class="plain-button" id="vke-lp-stop">Остановить Long Poll</button>
        <button type="button" class="plain-button" id="vke-revoke-callback">Отозвать Callback</button><button type="button" class="plain-button" id="vke-revoke-longpoll">Отозвать ключ Long Poll</button></div>
      <p id="vke-status" role="status" aria-live="polite"></p>
      <section><div class="vk-actions"><h4>Журнал событий</h4><button type="button" class="plain-button" id="vke-journal-refresh">Обновить журнал</button></div>
        <p class="vke-note">Показаны тип, канал и время. Содержимое событий хранится зашифрованным и здесь не выводится.</p><ol id="vke-journal" class="vke-journal"></ol></section>
      <details id="vke-catalog"><summary>Какие события может прислать ВК</summary><div id="vke-catalog-body"></div></details>`;

    const dirty = () => !settings || node('group').value.trim() !== String(settings.groupId || '') || node('cb-enabled').checked !== settings.callback.enabled
      || node('lp-enabled').checked !== settings.longPoll.enabled || !!node('cb-secret').value || !!node('cb-confirm').value || !!node('lp-token').value;
    const controls = () => {
      container.setAttribute('aria-busy', String(busy));
      container.querySelectorAll('button,input').forEach(el => { el.disabled = busy || !owner() || !companyCode; });
      const lp = settings?.longPoll;
      node('check').disabled ||= !settings?.longPoll.tokenConfigured || dirty();
      node('lp-start').disabled ||= !lp?.enabled || !lp?.checked || lp?.vkEnabled !== true || lp?.running || dirty();
      node('lp-stop').disabled ||= !lp?.running;
      node('revoke-callback').disabled ||= !settings?.callback.secretConfigured && !settings?.callback.confirmationConfigured;
      node('revoke-longpoll').disabled ||= !lp?.tokenConfigured;
      node('revoke-callback').textContent = armed === 'callback' ? 'Нажмите ещё раз: отозвать Callback' : 'Отозвать Callback';
      node('revoke-longpoll').textContent = armed === 'longpoll' ? 'Нажмите ещё раз: отозвать ключ Long Poll' : 'Отозвать ключ Long Poll';
    };
    const drawSettings = () => {
      const s = settings, cb = s?.callback, lp = s?.longPoll;
      node('group').value = s?.groupId || ''; node('cb-enabled').checked = !!cb?.enabled; node('lp-enabled').checked = !!lp?.enabled;
      node('url').textContent = cb?.endpointPath ? window.location.origin + cb.endpointPath : 'появится после сохранения';
      node('callback-state').textContent = !s?.configured ? 'Callback: не настроен.' : `Callback: ${cb.enabled ? 'включён' : 'выключен'}; секрет ${cb.secretConfigured ? 'сохранён' : 'не задан'}; `
        + `подтверждение ВК: ${cb.confirmedAt ? time(cb.confirmedAt) : 'не получено'}; последнее событие: ${time(cb.lastEventAt)}`
        + (cb.rejected ? `; отклонено запросов: ${cb.rejected} (${cb.lastRejectCode})` : '') + '.';
      node('longpoll-state').textContent = !s?.configured ? 'Long Poll: не настроен.' : `Long Poll: ${lp.enabled ? 'включён' : 'выключен'}, ${lpStatus[lp.status] || lp.status}`
        + (lp.error ? ` — ${errors[lp.error] || lp.error}` : '') + `; проверка: ${lp.checked ? time(lp.checkedAt) : 'не выполнена'}; последнее событие: ${time(lp.lastEventAt)}`
        + (lp.gaps ? `; возможные пропуски истории: ${lp.gaps}` : '') + (lp.invalidUpdates ? `; отброшено некорректных событий: ${lp.invalidUpdates}` : '') + '.';
      node('vk-settings').textContent = lp?.vkEnabled === null || lp?.vkEnabled === undefined ? 'Настройки Long Poll в ВК ещё не прочитаны.'
        : `В ВК Long Poll API ${lp.vkEnabled ? 'включён' : 'выключен'}, версия ${lp.apiVersion || 'не указана'}${lp.apiVersionMatches === false ? ' (Synapse ожидает 5.199)' : ''}; `
          + `включённые типы: ${lp.vkEnabledEvents.length ? lp.vkEnabledEvents.join(', ') : 'нет'}.`;
      const body = node('catalog-body'); body.replaceChildren();
      for (const group of s?.events?.documented || []) {
        const p = document.createElement('p'); p.textContent = group.section + ': ' + group.types.map(t => t.type + (t.longPollSetting ? '' : ' (нет в настройках Long Poll — только Callback, по документации)')).join(', '); body.append(p);
      }
      if (s?.events?.longPollSchemaOnly?.length) { const p = document.createElement('p'); p.textContent = 'Есть в схеме Long Poll, но не в списке документации (UNKNOWN): ' + s.events.longPollSchemaOnly.join(', '); body.append(p); }
      if (s?.events?.unknownSeen?.length) { const p = document.createElement('p'); p.textContent = 'Получены неизвестные типы: ' + s.events.unknownSeen.join(', '); body.append(p); }
    };
    const drawJournal = () => {
      const list = node('journal'); list.replaceChildren();
      if (!items.length) { const li = document.createElement('li'); li.textContent = 'Событий пока нет.'; list.append(li); return; }
      for (const item of items) {
        const li = document.createElement('li'); if (!item.known) li.className = 'vke-unknown';
        li.textContent = `${time(item.receivedAt)} · ${item.type}${item.known ? '' : ' (неизвестный тип)'} · ${item.transports.map(t => transports[t] || t).join(' + ')}`
          + (item.duplicates ? ` · повторов: ${item.duplicates}` : '');
        list.append(li);
      }
    };
    const run = async (text, action) => {
      if (busy || !owner() || !companyCode) return;
      const generation = epoch; busy = true; say(text); controls();
      const current = () => generation === epoch && owner();
      try { await action(current); } catch (error) {
        if (!current()) return;
        say(errors[error.code] || 'Не удалось выполнить действие.');
        if (error.code === 'SETTINGS_CHANGED') { busy = false; await load(companyCode); return; }
      } finally { if (generation === epoch) { busy = false; controls(); } }
    };
    const refreshJournal = async current => { const data = own(await request('/journal', undefined, 'GET', {limit: '50'})); if (!current()) return; items = data.items; drawJournal(); };
    async function load(code) {
      companyCode = String(code || ''); epoch++; busy = false; settings = null; items = []; armed = '';
      for (const id of ['cb-secret', 'cb-confirm', 'lp-token']) node(id).value = '';
      drawSettings(); drawJournal(); say('');
      if (!companyCode || !owner()) { say('Выберите компанию. Раздел доступен владельцу.'); controls(); return; }
      await run('Загружаем настройки событий…', async current => {
        const data = own(await request('/settings', undefined, 'GET')); if (!current()) return;
        settings = data; drawSettings(); await refreshJournal(current); if (current()) say('');
      });
    }
    const after = (current, data, text) => { if (!current()) return; settings = own(data); armed = ''; drawSettings(); say(text); };
    node('form').addEventListener('submit', event => {
      event.preventDefault();
      run('Сохраняем настройки…', async current => {
        const callback = {enabled: node('cb-enabled').checked}, longPoll = {enabled: node('lp-enabled').checked};
        if (node('cb-secret').value) callback.secret = node('cb-secret').value;
        if (node('cb-confirm').value) callback.confirmationCode = node('cb-confirm').value.trim();
        if (node('lp-token').value) longPoll.communityToken = node('lp-token').value;
        const data = await request('/settings', {revision: settings?.revision || 0, groupId: node('group').value.trim(), callback, longPoll}, 'PUT');
        if (!current()) return;
        for (const id of ['cb-secret', 'cb-confirm', 'lp-token']) node(id).value = '';
        after(current, data, 'Сохранено. Для Long Poll нажмите «Проверить доступ»; Callback подтвердится, когда ВК обратится к адресу сервера.');
      });
    });
    node('check').addEventListener('click', () => run('Проверяем доступ…', async current => {
      const data = await request('/check', {revision: settings.revision});
      after(current, data, data.ok ? 'Доступ подтверждён: ключ, сообщество и настройки Long Poll прочитаны.' : (errors[data.code] || 'Доступ не подтверждён.'));
    }));
    for (const action of ['start', 'stop']) node('lp-' + action).addEventListener('click', () => run(action === 'start' ? 'Запускаем Long Poll…' : 'Останавливаем Long Poll…', async current => {
      after(current, await request('/longpoll', {revision: settings.revision, action}), action === 'start' ? 'Long Poll запущен.' : 'Long Poll остановлен.');
    }));
    for (const transport of ['callback', 'longpoll']) node('revoke-' + transport).addEventListener('click', () => {
      if (armed !== transport) { armed = transport; controls(); say('Отзыв удалит сохранённый секрет. Нажмите кнопку ещё раз для подтверждения.'); return; }
      run('Отзываем…', async current => { after(current, await request('/revoke', {revision: settings.revision, transport}), 'Отозвано. Секрет удалён из Synapse.'); });
    });
    node('journal-refresh').addEventListener('click', () => run('Обновляем журнал…', async current => { await refreshJournal(current); if (current()) say(''); }));
    container.addEventListener('input', () => { if (armed) armed = ''; controls(); });
    controls();
    return {
      update(next, code) {
        ctx = next;
        if (!owner()) { epoch++; settings = null; items = []; container.replaceChildren(); return; }
        if (String(code || '') !== companyCode) return load(code);
        controls();
      },
      destroy() { epoch++; settings = null; items = []; container.replaceChildren(); },
    };
  };
})();
