(() => {
  'use strict';
  const cabinet = window.SbCabinet = window.SbCabinet || {};
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const errors = {
    CONNECTION_MISSING:'Сначала сохраните ID сообщества и ключ.', NOT_CONFIGURED:'Сначала сохраните ID сообщества и ключ.',
    ACCESS_DENIED:'ВК не подтвердил доступ. Проверьте ключ и разрешение на сообщения.', AUTH_FAILED:'ВК не принял ключ. Проверьте подключение.',
    GROUP_MISMATCH:'Ключ и выбранное сообщество не совпадают.', SETTINGS_CHANGED:'Подключение изменилось. Обновите раздел и повторите проверку.',
    CONNECTION_UNCERTAIN:'ВК не ответил вовремя. Доступ пока не подтверждён.', TOKEN_UNREADABLE:'Сохранённый ключ недоступен. Подключите сообщество заново.',
    RATE_LIMITED:'ВК ограничил частоту запросов. Повторите позже.', REPLY_NOT_ALLOWED:'Отправка в этот диалог недоступна.',
    NOT_CONNECTED:'Сначала проверьте доступ к сообщениям.', INVALID_SETTINGS:'Проверьте ID сообщества и ключ.',
    INVALID_REPLY:'Проверьте текст ответа и выбранный диалог.',
    PLATFORM_REJECTED:'ВК отклонил запрос. Проверьте подключение.', RESPONSE_INVALID:'ВК вернул неожиданный ответ. Действие не подтверждено.',
    DIALOG_REQUIRED:'Сначала обновите диалоги и откройте нужного клиента.', REPLY_DENIED:'ВК не разрешает отвечать в этот диалог.',
    REQUEST_CONFLICT:'Этот ответ уже обрабатывался. Обновите историю диалога.'
  };
  let controller;
  function create(container, initial) {
    let ctx = initial, companyCode = '', epoch = 0, settings = null, selected = null, dialogs = [], busy = false, offset = 0, total = 0, pendingReply = null;
    const isOwner = () => ctx.identity?.role === 'owner';
    const node = id => container.querySelector('#vk-' + id);
    const name = () => ctx.identity.companies?.find(c => String(c.id) === companyCode)?.name || companyCode;
    const message = text => { node('status').textContent = text; };
    const request = (path, body) => ctx.apiJson('/content/crm/vk-community' + path + '?companyCode=' + encodeURIComponent(companyCode), body === undefined ? undefined : ctx.csrfOptions('POST', body));
    const validate = data => { if (!data || data.companyCode !== companyCode) throw Error('WRONG_COMPANY'); return data; };
    const dirty = () => String(node('group').value).trim() !== String(settings?.groupId || '') || !!node('token').value;
    const replyUncertain = () => ['uncertain','sending'].includes(pendingReply?.status);
    const controls = () => {
      if (!node('status')) return;
      container.setAttribute('aria-busy', String(busy));
      container.querySelectorAll('button,input,textarea,select').forEach(el => { el.disabled = busy || !isOwner(); });
      node('check').disabled = busy || !settings?.configured || dirty();
      node('sync').disabled = busy || !settings?.connected || dirty();
      node('send').disabled = busy || !settings?.connected || !selected?.canReply || dirty() || !node('reply').value.trim() || replyUncertain();
      node('previous').disabled = busy || offset === 0;
      node('next').disabled = busy || offset + 30 >= total;
    };
    const run = async (text, action) => {
      if (busy || !isOwner()) return;
      const generation = epoch;
      busy = true; message(text); controls();
      const current = () => generation === epoch && isOwner();
      try { await action(current); } catch (error) { if (current()) message(replyUncertain() ? 'Результат отправки не подтверждён. Обновите диалоги и проверьте историю, чтобы не отправить ответ дважды.' : errors[error.code] || 'Не удалось выполнить действие. Проверьте подключение и повторите.'); }
      finally { if (current()) { busy = false; controls(); } }
    };
    const drawSettings = () => {
      node('group').value = settings?.groupId || '';
      node('connection').textContent = settings?.connected ? 'Сообщения: доступ подтверждён' : settings?.configured ? 'Сообщения: требуется проверка доступа' : 'Сообщения: не подключены';
      node('checked').textContent = settings?.checkedAt ? 'Последняя проверка: ' + new Date(settings.checkedAt).toLocaleString('ru-RU') : 'Проверка ещё не выполнена.';
      node('community-name').textContent = settings?.group?.name || 'Выберите сообщество этой компании';
      node('platform-links').innerHTML = [cabinet.platformLinks?.vkCommunityLink({companyCode,record:settings}), cabinet.platformLinks?.cabinetLink('vk')].filter(Boolean).join(' · ');
      node('step-key').dataset.complete = String(!!settings?.configured);
      node('step-check').dataset.complete = String(!!settings?.connected);
    };
    const clearConversation = () => { selected = null; pendingReply = null; node('recipient').textContent = 'Выберите диалог'; node('messages').replaceChildren(); node('reply').value = ''; node('reply-panel').hidden = true; };
    const drawDialogs = () => {
      node('dialog-list').innerHTML = dialogs.length ? dialogs.map(item => `<button type="button" class="vk-dialog" data-peer="${escape(item.peerId)}"><strong>${escape(item.title || 'Пользователь ' + item.peerId)}</strong><span>${escape(item.lastMessage?.text || 'Сообщение без текста')}</span><small>${item.unreadCount > 0 ? 'Непрочитанных: ' + escape(item.unreadCount) : 'Диалог'}</small></button>`).join('') : '<p>Диалогов в полученном списке нет.</p>';
      node('pages').hidden = total <= 30;
      node('page-label').textContent = total ? `Страница ${Math.floor(offset / 30) + 1} из ${Math.ceil(total / 30)} · личных диалогов: ${dialogs.length}` : 'Нет диалогов';
    };
    const sync = nextOffset => run('Получаем диалоги из ВК…', async current => {
      const data = await request('/conversations', {offset:nextOffset,count:30,revision:settings.revision}); if (!current()) return; validate(data);
      if (data.revision !== settings.revision) throw Error('WRONG_REVISION');
      dialogs = data.items || []; total = data.count || 0; offset = data.offset || 0; clearConversation(); drawDialogs(); message('Диалоги обновлены. Чтение списка не отправляет ответы.');
    });
    container.classList.add('vk-community-view');
    container.innerHTML = `<header class="vk-heading"><div><h2>ВКонтакте</h2><p id="vk-company-name"></p></div><button type="button" class="plain-button" id="vk-refresh">Обновить раздел</button></header>
      <p id="vk-status" role="status" aria-live="polite"></p>
      <div class="vk-capabilities">
        <a class="card" href="#autoposting"><strong>Публикации</strong><span id="vk-publishing">Проверяем сохранённое подключение…</span><small>Контент и расписание →</small></a>
        <a class="card" href="#ad-platforms"><strong>Реклама</strong><span>Ручные снимки показателей</span><small>Автоматический сбор ещё не подключён →</small></a>
        <a class="card" href="#analytics-through"><strong>Результат</strong><span>Переходы, заявки и этапы CRM</span><small>Визиты и покупки отмечает администратор →</small></a>
        <a class="card" href="#company-information"><strong>Оформление и сведения</strong><span>Эталонные данные компании</span><small>Изменения ВК пока применяются отдельно →</small></a>
      </div>
      <section class="card vk-setup"><h3 id="vk-connection">Сообщения: не подключены</h3><p id="vk-community-name"></p><p id="vk-platform-links"></p>
        <ol class="vk-steps"><li id="vk-step-key">Сохранить ID и ключ сообщества</li><li id="vk-step-check">Проверить доступ к сообщениям</li><li>Получить диалоги</li><li>Открыть диалог и отправить согласованный ответ</li></ol>
        <details id="vk-setup-details"><summary>Настроить сообщения сообщества</summary>
          <p>В управлении сообществом ВК включите сообщения. В разделе работы с API создайте ключ с доступом к сообщениям и информации сообщества. Вставьте его здесь. Ключ Onlypult используется отдельно, для публикаций.</p>
          <form id="vk-settings-form"><div class="vk-fields"><label>Числовой ID сообщества ВК<input id="vk-group" inputmode="numeric" pattern="[1-9][0-9]*" required autocomplete="off" placeholder="ID сообщества, не профиля Onlypult"></label><label>Ключ сообщества<input id="vk-token" type="password" autocomplete="new-password" spellcheck="false" placeholder="Пустое поле сохраняет прежний ключ"></label></div>
          <p class="vk-note">При смене сообщества нужен его ключ. Секрет хранится на сервере; после сохранения здесь не отображается.</p><button type="submit" class="plain-button" id="vk-save">Сохранить подключение</button></form>
        </details>
        <div class="vk-actions"><button type="button" class="plain-button" id="vk-check">Проверить доступ</button><button type="button" class="plain-button" id="vk-sync">Получить диалоги</button><span id="vk-checked"></span></div>
      </section>
      <section class="card"><h3>Сообщения клиентов</h3><p>Ответ отправляется выбранному клиенту только кнопкой «Отправить ответ». Автоответы ещё не настроены. В диалоге показаны последние 50 сообщений.</p>
        <div class="vk-inbox"><aside><div id="vk-dialog-list"><p>Подключите сообщения и нажмите «Получить диалоги».</p></div><div id="vk-pages" class="vk-actions" hidden><button type="button" id="vk-previous" class="plain-button">Назад</button><span id="vk-page-label"></span><button type="button" id="vk-next" class="plain-button">Далее</button></div></aside>
        <div><h4 id="vk-recipient" tabindex="-1">Выберите диалог</h4><div id="vk-messages" class="vk-messages"></div><form id="vk-reply-panel" hidden><label>Ваш ответ<textarea id="vk-reply" rows="4" maxlength="4000" required></textarea></label><button type="submit" class="plain-button" id="vk-send">Отправить ответ</button></form></div></div>
      </section>`;
    const load = async nextCode => {
      companyCode = String(nextCode || ''); epoch++; busy = false; settings = null; dialogs = []; total = 0; offset = 0; clearConversation();
      node('token').value = ''; node('group').value = ''; node('dialog-list').innerHTML = '<p>Подключите сообщения и нажмите «Получить диалоги».</p>'; node('pages').hidden = true; node('company-name').textContent = name(); node('publishing').textContent = 'Статус не получен'; drawSettings();
      if (!companyCode || !isOwner()) { message('Выберите компанию. Подключение доступно владельцу.'); controls(); return; }
      await run('Загружаем настройки выбранной компании…', async current => {
        const data = await request('/settings'); if (!current()) return; settings = validate(data); drawSettings(); node('setup-details').open = !settings.configured;
        message(settings.connected ? 'Можно получить диалоги сообщества.' : 'Настройте отдельное подключение сообщений ВК.');
        try { const publishing = await ctx.apiJson('/content/crm/autoposting/settings?companyCode=' + encodeURIComponent(companyCode)); if (!current()) return; const channel = publishing.channels?.find(c => c.platform === 'vk'); node('publishing').textContent = channel?.connected && channel.enabled ? 'Доступ проверен · отправка разрешена' : 'Требуется настройка публикаций'; } catch (_) { if (current()) node('publishing').textContent = 'Откройте раздел для проверки'; }
      });
    };
    node('refresh').addEventListener('click', () => { if (!busy) void load(companyCode); });
    ['group','token','reply'].forEach(id => node(id).addEventListener('input', () => { if (id === 'reply' && !replyUncertain()) pendingReply = null; controls(); }));
    node('settings-form').addEventListener('submit', event => {
      event.preventDefault(); if (!node('settings-form').reportValidity() || !settings) return;
      const groupId = node('group').value.trim(), token = node('token').value.trim();
      if (groupId !== String(settings.groupId || '') && !token) { message('Для нового сообщества вставьте его ключ.'); return; }
      void run('Сохраняем подключение…', async current => {
        const data = await ctx.apiJson('/content/crm/vk-community/settings?companyCode=' + encodeURIComponent(companyCode), ctx.csrfOptions('PUT', {revision:settings.revision,groupId,...(token?{communityToken:token}:{})}));
        if (!current()) return; settings = validate(data); node('token').value = ''; dialogs = []; total = 0; offset = 0; clearConversation(); drawDialogs(); drawSettings(); message('Подключение сохранено. Теперь проверьте доступ.');
      });
    });
    node('check').addEventListener('click', () => { if (dirty()) return; void run('Проверяем доступ без отправки сообщений…', async current => { const data = await request('/check', {}); if (!current()) return; settings = validate(data); drawSettings(); message(data.ok ? 'Доступ к сообщениям подтверждён. Получите диалоги.' : errors[data.code] || 'Доступ не подтверждён. Проверьте ID сообщества и разрешения ключа.'); }); });
    node('sync').addEventListener('click', () => void sync(0));
    node('previous').addEventListener('click', () => void sync(Math.max(0,offset-30)));
    node('next').addEventListener('click', () => void sync(offset+30));
    node('dialog-list').addEventListener('click', event => {
      const button = event.target.closest('[data-peer]'); if (!button || busy) return; const dialog = dialogs.find(d => String(d.peerId) === button.dataset.peer); if (!dialog) return;
      clearConversation(); selected = dialog; node('recipient').textContent = dialog.title || 'Пользователь ' + dialog.peerId;
      node('dialog-list').querySelectorAll('[data-peer]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      void run('Получаем историю диалога…', async current => {
        const data = await request('/history', {peerId:dialog.peerId,offset:0,count:50,revision:settings.revision}); if (!current()) return; validate(data);
        if (data.peerId !== dialog.peerId || data.revision !== settings.revision) throw Error('WRONG_CONVERSATION');
        const items = [...(data.items || [])].sort((a,b) => a.date - b.date || a.id - b.id);
        node('messages').innerHTML = items.map(item => `<article class="vk-message${item.out ? ' vk-message-out' : ''}"><small>${item.out ? 'Сообщество' : escape(dialog.title || 'Клиент')} · ${escape(new Date(item.date * 1000).toLocaleString('ru-RU'))}</small><p>${escape(item.text || 'Сообщение без текста')}</p></article>`).join('') || '<p>Текстовых сообщений пока нет.</p>';
        node('reply-panel').hidden = !dialog.canReply; message(dialog.canReply ? 'Проверьте историю и подготовьте ответ.' : 'ВК не разрешает отвечать в этот диалог.');
        if (window.matchMedia?.('(max-width: 1000px)').matches) { node('recipient').focus({preventScroll:true}); node('recipient').scrollIntoView?.({block:'start',behavior:'smooth'}); }
      });
    });
    node('reply-panel').addEventListener('submit', event => {
      event.preventDefault(); if (busy || !selected?.canReply || !settings?.connected || dirty() || replyUncertain()) return;
      const text = node('reply').value.trim(); if (!text) return;
      pendingReply = pendingReply || {requestId:crypto.randomUUID(),status:'ready'};
      const body = {revision:settings.revision,peerId:selected.peerId,text,requestId:pendingReply.requestId};
      void run('Отправляем ответ выбранному клиенту…', async current => {
        // A lost response is ambiguous: block repeated send until the user refreshes the history.
        pendingReply.status = 'uncertain';
        const data = await request('/reply', body); if (!current()) return; validate(data);
        if (data.peerId !== selected.peerId || data.revision !== settings.revision || data.requestId !== body.requestId) throw Error('WRONG_REPLY');
        pendingReply.status = ['sent','failed'].includes(data.status) ? data.status : 'uncertain';
        if (data.status === 'sent') { node('reply').value = ''; const item = document.createElement('article'); item.className = 'vk-message vk-message-out'; const p = document.createElement('p'); p.textContent = text; item.append(p); node('messages').append(item); pendingReply = null; message('ВК подтвердил отправку ответа.'); }
        else if (data.status === 'failed') message(errors[data.code] || 'ВК отклонил ответ. Проверьте доступ перед повторной отправкой.');
        else message('Результат отправки не подтверждён. Обновите диалоги и проверьте историю, чтобы не отправить ответ дважды.');
      });
    });
    return {load,ready:load(ctx.selectedProjectId),update(next) {ctx = next; if (!isOwner()) {epoch++; settings = null; dialogs = []; selected = null; pendingReply = null; container.replaceChildren(); controller = null; return;} if (String(next.selectedProjectId || '') !== companyCode) return load(next.selectedProjectId); controls();}};
  }
  cabinet.registerView('vk-community', {title:'ВКонтакте',render(container,ctx) {if (ctx.identity?.role !== 'owner') {controller?.update(ctx); container.replaceChildren(); controller = null; return;} if (!controller) controller = create(container,ctx); else return controller.update(ctx); return controller.ready;},onProjectChange(ctx) {return controller?.update(ctx);}});
})();
