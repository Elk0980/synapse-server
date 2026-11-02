  /* PALITRA_PROFILE_SESSION_PANEL_BEGIN */
  function bindProfileSessionPanel(container, userId) {
    const view = window.PalitraAccountView;
    let current = false, dirty = false;
    const knownId = typeof userId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(userId);
    const previousDisplay = [container.style.getPropertyValue('display'), container.style.getPropertyPriority('display')];
    const notice = doc.createElement('section');
    notice.className = 'sf-box sf-account-session-notice';
    notice.setAttribute('role', 'status');
    const message = doc.createElement('p');
    const retry = doc.createElement('button');
    retry.type = 'button'; retry.className = 'pill'; retry.textContent = 'Проверить вход';
    const login = doc.createElement('a');
    login.className = 'button pill'; login.href = '/account/login?next=%2Faccount';
    login.target = '_blank'; login.rel = 'noopener'; login.textContent = 'Войти снова';
    const reload = doc.createElement('button');
    reload.type = 'button'; reload.className = 'pill'; reload.textContent = 'Открыть текущий аккаунт';
    notice.append(message, retry, login, reload); container.before(notice);
    const hide = (element, hidden) => {
      element.hidden = hidden;
      if (hidden) element.style.setProperty('display', 'none', 'important');
      else element.style.removeProperty('display');
    };
    const render = snapshot => {
      current = knownId && snapshot?.status === 'ready' && snapshot.user?.id === userId;
      hide(container, !current); container.inert = !current;
      if (current) {
        container.removeAttribute('aria-hidden');
        if (previousDisplay[0]) container.style.setProperty('display', ...previousDisplay);
      } else container.setAttribute('aria-hidden', 'true');
      hide(notice, current);
      if (current) return;
      const loading = snapshot?.status === 'loading' || snapshot?.status === 'changing';
      const other = snapshot?.status === 'ready' && Boolean(snapshot.user);
      const signedOut = snapshot?.status === 'ready' && !snapshot.user;
      message.textContent = loading ? 'Проверяем вход. Несохранённые изменения остаются в этой вкладке.'
        : other ? 'Аккаунт изменился. Данные прежнего профиля скрыты; его несохранённый ввод не переносится в другой аккаунт.'
        : signedOut ? 'Вы вышли из аккаунта. Несохранённые изменения остаются в этой вкладке. После повторного входа в тот же аккаунт вернитесь сюда.'
        : 'Вход пока не подтверждён. Данные профиля скрыты, несохранённые изменения остаются в этой вкладке.';
      retry.disabled = loading; hide(login, loading || other); hide(reload, !other);
    };
    container.addEventListener('input', () => { dirty = true; });
    container.addEventListener('change', () => { dirty = true; });
    retry.addEventListener('click', () => { if (!retry.disabled) refreshMyOrdersAccount(); });
    reload.addEventListener('click', () => {
      if (dirty && !window.confirm('Открыть текущий аккаунт? Несохранённые изменения прежнего профиля будут потеряны.')) return;
      dirty = false; window.location.reload();
    });
    window.addEventListener('beforeunload', event => {
      if (dirty) { event.preventDefault(); event.returnValue = ''; }
    });
    if (view?.version === 1 && typeof view.subscribe === 'function' && typeof view.getSnapshot === 'function') {
      view.subscribe(render); render(view.getSnapshot());
    } else render(null);
    return { isCurrent: () => current, markSaved() { dirty = false; } };
  }
  /* PALITRA_PROFILE_SESSION_PANEL_END */
