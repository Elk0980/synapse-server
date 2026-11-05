/* Palitra: «Доступ к фото» для владельца (PALITRA-BOT-EDITOR-35, проход 2).
   Каждое изменение — отдельное подтверждение с точным текстом права, затем PUT и повторное чтение списка.
   Подтверждение — собственное окно <dialog> (showModal), а не window.confirm: фокус сначала на «Отмена»,
   Escape = отмена, после закрытия фокус возвращается на тот же флажок. Пока окно открыто или идёт сохранение,
   все флажки заблокированы, второго запроса нет. После сохранения права показываются только из повторно
   прочитанного списка; при отмене или ошибке флажок возвращается к прежнему значению.
   Данные выводятся только через textContent; пароли и токены сервер не отдаёт. */
(() => {
  'use strict';
  const core = window.PalitraSitePhotosCore;
  const byId = id => document.getElementById(id);
  const api = core.createApi(window.fetch.bind(window));
  let csrfToken = null;
  let busy = false;

  const say = text => { byId('status').textContent = text || ''; };
  const showError = text => { byId('error').textContent = text || ''; };
  const boxes = () => [...byId('access-list').querySelectorAll('input[type="checkbox"]')];
  const lockBoxes = locked => { for (const input of boxes()) input.disabled = locked; };

  function render(users) {
    byId('access-empty').hidden = users.length > 0;
    byId('access-list').replaceChildren(...users.map(user => {
      const name = user.displayName ? `${user.displayName} (${user.login})` : user.login;
      const row = document.createElement('tr');
      const who = document.createElement('th');
      who.scope = 'row';
      who.textContent = name;
      const box = (checked, right, label, onChange) => {
        const cell = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = checked;
        input.disabled = busy;
        input.dataset.userId = String(user.userId);
        input.dataset.right = right;
        input.setAttribute('aria-label', `${label}: ${name}`);
        input.addEventListener('change', () => onChange(input, checked));
        cell.append(input);
        return cell;
      };
      row.append(who,
        box(user.view, 'view', 'Просмотр фото', (input, previous) => change(user, input.checked, input.checked && user.edit, input, previous)),
        box(user.edit, 'edit', 'Изменение фото', (input, previous) => change(user, input.checked || user.view, input.checked, input, previous)));
      return row;
    }));
  }

  /* Окно подтверждения: true — «Подтвердить», false — «Отмена», Escape или закрытие любым другим способом.
     Окно и все его обработчики удаляются в любом исходе. */
  function confirmDialog(title, text) {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      const heading = document.createElement('h2');
      const message = document.createElement('p');
      const actions = document.createElement('div');
      const cancel = document.createElement('button');
      const accept = document.createElement('button');
      heading.id = 'access-confirm-title';
      heading.textContent = title;
      message.id = 'access-confirm-text';
      message.textContent = text;
      dialog.setAttribute('aria-labelledby', heading.id);
      dialog.setAttribute('aria-describedby', message.id);
      actions.className = 'sp-row';
      cancel.type = 'button';
      cancel.className = 'secondary';
      cancel.textContent = 'Отмена';
      accept.type = 'button';
      accept.textContent = 'Подтвердить';
      actions.append(cancel, accept);
      dialog.append(heading, message, actions);

      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        cancel.removeEventListener('click', onCancel);
        accept.removeEventListener('click', onAccept);
        dialog.removeEventListener('cancel', onEscape);
        dialog.removeEventListener('close', onClose);
        dialog.removeEventListener('keydown', onKeydown);
        if (dialog.open) dialog.close();
        dialog.remove();
        resolve(value);
      };
      const onCancel = () => finish(false);
      const onAccept = () => finish(true);
      const onEscape = event => { event.preventDefault(); finish(false); };
      const onClose = () => finish(false);
      // Фокус остаётся внутри окна: Tab и Shift+Tab ходят только между «Отмена» и «Подтвердить».
      const onKeydown = event => {
        if (event.key !== 'Tab') return;
        event.preventDefault();
        (document.activeElement === cancel ? accept : cancel).focus();
      };
      cancel.addEventListener('click', onCancel);
      accept.addEventListener('click', onAccept);
      dialog.addEventListener('cancel', onEscape);
      dialog.addEventListener('close', onClose);
      dialog.addEventListener('keydown', onKeydown);

      if (typeof dialog.showModal !== 'function') { finish(false); return; }
      document.body.append(dialog);
      try { dialog.showModal(); } catch (_) { finish(false); return; }
      cancel.focus();
    });
  }

  const focusBox = (userId, right) => {
    const target = boxes().find(input => input.dataset.userId === String(userId) && input.dataset.right === right);
    if (target && !target.disabled) target.focus();
  };

  async function change(user, view, edit, input, previous) {
    // Одно подтверждение и одно сохранение за раз: повторное изменение возвращается без запроса.
    if (busy) { input.checked = previous; return; }
    busy = true;
    lockBoxes(true);
    const right = input.dataset.right;
    const parts = [view ? 'просмотр фото' : null, edit ? 'изменение фото' : null].filter(Boolean);
    const text = parts.length
      ? `Выдать сотруднику ${user.login}: ${parts.join(' и ')} черновика сайта Palitra (site-44bbe13f1bad5e005b2a)? Другие права аккаунта не меняются.`
      : `Отозвать у сотрудника ${user.login} все права на фото черновика сайта Palitra? Отзыв действует сразу.`;
    const title = parts.length ? 'Подтвердите изменение доступа к фото' : 'Подтвердите отзыв доступа к фото';
    const confirmed = await confirmDialog(title, text);
    if (!confirmed) {
      input.checked = previous;
      busy = false;
      lockBoxes(false);
      if (input.isConnected) input.focus();
      return;
    }
    showError(''); say('Сохраняем и проверяем…');
    let result;
    try { result = await core.setAccess({ api, csrfToken, userId: user.userId, view, edit }); }
    catch (_) { result = { status: 'unknown', message: 'Результат изменения доступа неизвестен. Обновите список, прежде чем менять права снова' }; }
    if (result.status === 'saved') say(result.message);
    else {
      input.checked = previous; // до повторного чтения флажок не показывает непроверенное значение
      showError(result.message || 'Не удалось изменить доступ к фото. Обновите страницу и проверьте права');
      say('');
    }
    busy = false;
    const loaded = await load(result.users);
    if (loaded) focusBox(user.userId, right);
  }

  async function load(users) {
    if (users) { render(users); return true; }
    const list = await api.access();
    if (list.kind !== 'ok') {
      showError(list.kind === 'forbidden' ? 'Управлять доступом к фото может только владелец' : list.message || 'Список сотрудников не загрузился. Обновите страницу');
      lockBoxes(true); // без проверенного списка флажки не меняются
      return false;
    }
    byId('workspace').hidden = false;
    render(list.data.users || []);
    return true;
  }

  (async () => {
    const who = await api.whoami();
    if (who.kind !== 'ok' || !who.data.csrfToken) { say(''); showError('Войдите в кабинет Synapse и откройте страницу снова'); return; }
    csrfToken = who.data.csrfToken;
    await load();
    say('');
  })();
})();
