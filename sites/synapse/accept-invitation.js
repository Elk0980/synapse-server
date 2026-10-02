/* Страница принятия приглашения (specs/085). Секрет берётся из фрагмента URL, сразу убирается из адресной
   строки и живёт только в памяти страницы: не пишется в localStorage/sessionStorage/cookie, не уходит
   сторонним адресам. Запросы — только на свой сервер, POST JSON; пароль вводит сам получатель. */
(function (root) {
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LABELS = { 'sites.view': 'Просмотр сайтов', 'price.view': 'Просмотр прайса', 'price.edit': 'Изменение товаров и цен' };
  function takeSecret(win) {
    const match = /(?:^#|&)invite=([A-Za-z0-9_-]{43})(?:&|$)/.exec(win.location.hash || '');
    // Фрагмент убирается до любых запросов: в истории и при копировании адреса секрета нет.
    if (win.location.hash) win.history.replaceState(null, '', win.location.pathname + win.location.search);
    return match ? match[1] : '';
  }
  async function post(win, path, body) {
    const response = await win.fetch(path, { method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = null;
    try { data = await response.json(); } catch (_) { data = null; }
    return { ok: response.ok, status: response.status, data };
  }
  async function start(win) {
    const doc = win.document, box = doc.querySelector('[data-invite-state]');
    let secret = takeSecret(win);
    const show = (html) => { box.innerHTML = html; };
    if (!secret) { show('<p class="error">Ссылка приглашения неполная или уже открыта. Попросите владельца выдать новое приглашение.</p>'); return; }
    const info = await post(win, '/content/invitations/preview', { token: secret });
    if (!info.ok) { secret = ''; show(`<p class="error">${esc(info.data?.error || 'Приглашение недействительно')}</p>`); return; }
    const p = info.data;
    show(`<p>${esc(p.displayName)}, вас пригласили в кабинет компании <b>${esc(p.company.title)}</b>.</p>`
      + `<p>Логин: <b>${esc(p.login)}</b></p><p>Доступ: ${p.permissions.map((x) => esc(LABELS[x] || x)).join(', ')}.</p>`
      + `<p class="muted">Ссылка действует до ${esc(new Date(p.expiresAt).toLocaleString('ru-RU'))} и работает один раз.</p>`
      + '<form data-invite-form><label>Придумайте пароль (не короче 12 символов)<input type="password" name="password" autocomplete="new-password" minlength="12" maxlength="256" required></label>'
      + '<label>Повторите пароль<input type="password" name="repeat" autocomplete="new-password" minlength="12" maxlength="256" required></label>'
      + '<button type="submit">Сохранить пароль</button><p class="muted" data-invite-status role="status"></p></form>');
    const form = box.querySelector('[data-invite-form]'), status = box.querySelector('[data-invite-status]');
    let busy = false;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      const password = form.elements.password.value;
      if (password !== form.elements.repeat.value) { status.textContent = 'Пароли не совпадают'; return; }
      busy = true; form.querySelector('button').disabled = true; status.textContent = 'Сохраняем…';
      const result = await post(win, '/content/invitations/accept', { token: secret, password });
      form.elements.password.value = ''; form.elements.repeat.value = '';
      if (result.ok) {
        secret = '';
        show(`<p>Пароль сохранён. Войдите в кабинет обычным способом с логином <b>${esc(result.data.login)}</b>.</p><p><a href="/cabinet.html">Перейти ко входу</a></p>`);
        return;
      }
      busy = false; form.querySelector('button').disabled = false;
      status.textContent = result.data?.error || 'Не удалось сохранить пароль';
      if (result.status === 410 || result.status === 404) secret = '';
    });
  }
  if (typeof module === 'object' && module.exports) module.exports = { start, takeSecret };
  else if (root && root.document) start(root);
}(typeof window === 'undefined' ? null : window));
