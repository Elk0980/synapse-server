/* Palitra: «Доступ к фото» для владельца (PALITRA-BOT-EDITOR-35, проход 2).
   Каждое изменение — отдельное подтверждение с точным текстом права, затем PUT и повторное чтение списка.
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

  function render(users) {
    byId('access-empty').hidden = users.length > 0;
    byId('access-list').replaceChildren(...users.map(user => {
      const name = user.displayName ? `${user.displayName} (${user.login})` : user.login;
      const row = document.createElement('tr');
      const who = document.createElement('th');
      who.scope = 'row';
      who.textContent = name;
      const box = (checked, label, onChange, disabled) => {
        const cell = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = checked;
        input.disabled = busy || disabled;
        input.setAttribute('aria-label', `${label}: ${name}`);
        input.addEventListener('change', () => onChange(input));
        cell.append(input);
        return cell;
      };
      row.append(who,
        box(user.view, 'Просмотр фото', input => change(user, input.checked, input.checked && user.edit, input), false),
        box(user.edit, 'Изменение фото', input => change(user, input.checked || user.view, input.checked, input), false));
      return row;
    }));
  }

  async function change(user, view, edit, input) {
    const parts = [view ? 'просмотр фото' : null, edit ? 'изменение фото' : null].filter(Boolean);
    const text = parts.length
      ? `Выдать сотруднику ${user.login}: ${parts.join(' и ')} черновика сайта Palitra (site-44bbe13f1bad5e005b2a)? Другие права аккаунта не меняются.`
      : `Отозвать у сотрудника ${user.login} все права на фото черновика сайта Palitra? Отзыв действует сразу.`;
    if (!confirm(text)) { input.checked = !input.checked; return; }
    busy = true; showError(''); say('Сохраняем и проверяем…');
    const result = await core.setAccess({ api, csrfToken, userId: user.userId, view, edit });
    busy = false;
    if (result.status === 'saved') say(result.message);
    else { showError(result.message); say(''); }
    await load(result.users);
  }

  async function load(users) {
    if (users) { render(users); return; }
    const list = await api.access();
    if (list.kind !== 'ok') {
      showError(list.kind === 'forbidden' ? 'Управлять доступом к фото может только владелец' : list.message);
      return;
    }
    byId('workspace').hidden = false;
    render(list.data.users || []);
  }

  (async () => {
    const who = await api.whoami();
    if (who.kind !== 'ok' || !who.data.csrfToken) { say(''); showError('Войдите в кабинет Synapse и откройте страницу снова'); return; }
    csrfToken = who.data.csrfToken;
    await load();
    say('');
  })();
})();
