(() => {
  'use strict';
  /* Раздел «Модули» карточки компании CRM: какие модули каталога Synapse включены компании.
     Только владелец; компания — карточка, а не выбранный проект (сервер проверяет её сам).
     Ответ устаревшей карточки отбрасывается. Секреты здесь не вводятся: SMTP — в настройках системы. */
  const sb = window.SbCabinet = window.SbCabinet || {};
  const statusLabels = { available: 'Доступен', development: 'В разработке', removed: 'Удалён из каталога' };
  const billingLabels = { once: 'разовая работа', monthly: 'ежемесячно' };
  let sequence = 0;

  const historyLine = (item, names, esc) => {
    const was = item.before ? (item.before.enabled ? 'включён' : 'выключен') : 'не настроен';
    const now = item.after.enabled ? 'включён' : 'выключен';
    const params = item.before && JSON.stringify(item.before.params) !== JSON.stringify(item.after.params) ? ' · параметры изменены' : '';
    return `<li><strong>${esc(names.get(item.moduleKey) || item.moduleKey)}</strong>: ${esc(was)} → ${esc(now)}${esc(params)}
      <span>${esc(item.actor)} · ${esc(new Date(item.at).toLocaleString('ru-RU'))}</span></li>`;
  };

  const paramField = (module, field, esc) => {
    if (field.type !== 'emailList') return '';
    const set = Object.hasOwn(module.params, field.name);
    return `<fieldset class="company-module-param"><legend>${esc(field.label)}</legend>
      <label class="company-module-check"><input type="checkbox" data-param-inherit="${esc(field.name)}"${set ? '' : ' checked'}>
        Как в прежних настройках компании</label>
      <input type="text" inputmode="email" maxlength="1024" autocomplete="off" data-param="${esc(field.name)}"
        value="${esc(set ? module.params[field.name] : '')}"${set ? '' : ' disabled'} aria-label="${esc(field.label)}">
      <p class="field-hint">${esc(field.hint || '')}</p></fieldset>`;
  };

  const moduleCard = (module, esc) => {
    const bought = module.purchasedIn.map((deal) =>
      `<a href="#deals/${encodeURIComponent(deal.dealId)}">${esc(deal.title)}</a>`).join(', ');
    const action = module.enabled ? 'Выключить' : module.purchased ? 'Включить — приобретён' : 'Включить';
    const removed = module.status === 'removed';
    return `<article class="company-module${module.enabled ? ' is-enabled' : ''}" data-module="${esc(module.key)}">
      <header><h3>${esc(module.name)}</h3>
        <span class="company-module-state">${module.enabled ? 'Включён' : 'Выключен'}</span></header>
      <p class="crm-muted">${esc(statusLabels[module.status] || module.status)}${module.billing ? ` · ${esc(billingLabels[module.billing] || module.billing)}` : ''}</p>
      ${module.purchased ? `<p class="company-module-bought">Приобретён в сделке: ${bought}</p>` : ''}
      ${module.updatedAt ? `<p class="crm-muted">Изменил ${esc(module.updatedBy || '')} · ${esc(new Date(module.updatedAt).toLocaleString('ru-RU'))}</p>` : ''}
      ${module.paramsSchema.map((field) => paramField(module, field, esc)).join('')}
      <div class="crm-actions">
        ${removed && !module.enabled ? '' : `<button type="button" class="plain-button${module.enabled ? '' : ' company-module-enable'}" data-module-toggle>${esc(action)}</button>`}
        ${module.paramsSchema.length ? '<button type="button" class="plain-button" data-module-save>Сохранить параметры</button>' : ''}
      </div>
      <p class="crm-error" role="alert" hidden></p></article>`;
  };

  async function render(target, { company, crmQuery, csrfOptions, escapeHTML: esc, identity }) {
    const turn = ++sequence;
    if (identity?.role !== 'owner') { target.innerHTML = '<p class="crm-muted">Модули компании настраивает владелец.</p>'; return; }
    const path = '/company-modules';
    const query = { companyCode: company.code };
    const paint = (data) => {
      if (turn !== sequence || data.companyCode.toLowerCase() !== String(company.code).toLowerCase()) return;
      const names = new Map(data.modules.map((m) => [m.key, m.name]));
      target.innerHTML = `<p class="company-modules-intro">Модули каталога «Финансы → Модули и пакеты», включённые компании
        ${esc(data.companyName)}. Включение не выставляет счёт и не подтверждает оплату.</p>
        <div class="company-modules">${data.modules.map((m) => moduleCard(m, esc)).join('')}</div>
        <section class="company-modules-history"><h3>История изменений</h3>${data.history.length
          ? `<ul>${data.history.map((item) => historyLine(item, names, esc)).join('')}</ul>` : '<p class="crm-muted">Изменений пока нет</p>'}</section>`;
      target.querySelectorAll('[data-module]').forEach((card) => bind(card, data.modules.find((m) => m.key === card.dataset.module)));
    };
    const bind = (card, module) => {
      const error = card.querySelector('[role=alert]');
      card.querySelectorAll('[data-param-inherit]').forEach((box) => box.addEventListener('change', () => {
        const input = card.querySelector(`[data-param="${box.dataset.paramInherit}"]`);
        input.disabled = box.checked;
        if (!box.checked) input.focus();
      }));
      const params = () => Object.fromEntries([...card.querySelectorAll('[data-param]')].map((input) =>
        [input.dataset.param, input.disabled ? null : input.value.trim()]));
      const save = async (button, enabled) => {
        if (button.disabled || turn !== sequence) return;
        button.disabled = true; error.hidden = true;
        try {
          const body = { enabled, version: module.version };
          if (module.paramsSchema.length) body.params = params();
          const data = await crmQuery(`${path}/${encodeURIComponent(module.key)}`, query, csrfOptions('PUT', body));
          paint(data);
        } catch (failure) {
          if (turn !== sequence) return;
          error.textContent = failure.message; error.hidden = false; button.disabled = false;
        }
      };
      card.querySelector('[data-module-toggle]')?.addEventListener('click', (event) => save(event.currentTarget, !module.enabled));
      card.querySelector('[data-module-save]')?.addEventListener('click', (event) => save(event.currentTarget, module.enabled));
    };
    target.innerHTML = '<p>Модули: загрузка…</p>';
    try { paint(await crmQuery(path, query)); } catch (failure) {
      if (turn === sequence) target.innerHTML = `<p class="crm-error" role="alert">${esc(failure.message)}</p>`;
    }
  }
  const reset = () => { sequence += 1; };
  sb.companyModulesUI = { render, reset };
})();
