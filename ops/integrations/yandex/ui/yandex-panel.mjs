import { buildAdPatch, buildProfile, createCompanyController, escapeHtml as e, formatMoney,
  metricDisplay, safeError, statusLabel, UiContractError, validateBindings } from './ui-state.mjs';

const capabilities = [
  ['connection', 'Соединение', 'Личность и ответ API проверены.'],
  ['read', 'Чтение', 'Получены доступные объекты и отчёты.'],
  ['import', 'Импорт', 'Существующая реклама прочитана без копирования.'],
  ['draftWrite', 'Подготовка черновиков', 'Требует отдельного разрешения.'],
  ['attribution', 'Связь с результатами бизнеса', 'Заявка и оплата — разные события.'],
  ['moderation', 'Модерация', 'Недоступна в этой поставке.'],
  ['launch', 'Запуск', 'Недоступен в этой поставке.'],
];
const input = (name, label, value = '', type = 'text', extra = '') => `<label class="ya-field">${e(label)}<input name="${e(name)}" type="${e(type)}" value="${e(value)}" ${extra}></label>`;
const textarea = (name, label, value = '', extra = '') => `<label class="ya-field">${e(label)}<textarea name="${e(name)}" rows="3" maxlength="2000" ${extra}>${e(value)}</textarea></label>`;
const pill = (status) => `<span class="ya-pill ya-status-${e(['verified','completed','succeeded','approved','failed','unknown'].includes(status) ? status : 'neutral')}">${e(statusLabel(status))}</span>`;
const date = (value) => {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Не проверено';
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(value));
};
const checkList = (kind, items, selected, label) => `<fieldset class="ya-check-list"><legend>${e(label)}</legend>${items.length ? items.map((item) => `<label><input type="checkbox" name="${e(kind)}" value="${e(item.id)}" ${selected.includes(item.id) ? 'checked' : ''}><span>${e(item.label || item.id)}<small>ID ${e(item.id)}</small></span></label>`).join('') : '<p class="ya-muted">Список пока не получен. Объекты не подставляются автоматически.</p>'}</fieldset>`;

/** Mount in any existing page. The host supplies its authenticated, company-bound adapter. */
export function mountYandexPanel(root, { adapter, companies, initialCompanyId, now = () => Date.now() }) {
  if (!root || typeof root.addEventListener !== 'function') throw new Error('Нужен DOM-элемент контейнера.');
  if (!Array.isArray(companies) || !companies.length || companies.some((item) => typeof item.id !== 'string')) throw new Error('Нужен разрешённый список компаний.');
  const allowedCompanies = companies.map(({ id, label }) => ({ id, label }));
  const prefix = `ya-${Math.random().toString(36).slice(2, 10)}`;
  const drafts = new Map();
  let localError = '';
  let currentState;
  const controller = createCompanyController({ adapter, companies: allowedCompanies, onChange: render });

  function rememberDrafts() {
    if (!currentState?.companyId || !currentState.view) return;
    const form = root.querySelector('[data-profile-form]');
    const proposal = root.querySelector('[data-proposal-form]');
    const bindings = root.querySelector('[data-binding-form]');
    const old = drafts.get(currentState.companyId) || {};
    const values = (node) => node ? Object.fromEntries(new FormData(node)) : undefined;
    drafts.set(currentState.companyId, {
      profile: values(form) || old.profile, proposal: values(proposal) || old.proposal,
      bindings: bindings ? { campaignIds: new FormData(bindings).getAll('campaignIds'), counterIds: new FormData(bindings).getAll('counterIds') } : old.bindings,
    });
  }

  function render(state) {
    currentState = state;
    const view = state.view;
    const selected = allowedCompanies.find((company) => company.id === state.companyId);
    const banner = view?.environment === 'demo'
      ? '<div class="ya-demo" role="note"><strong>Демонстрация</strong> Все компании, результаты и действия учебные. Данные живут в памяти этой страницы; Яндекс не подключён.</div>'
      : '<div class="ya-environment" role="note">Первоначальный режим — наблюдение. Состояние каждой возможности показано отдельно.</div>';
    root.innerHTML = `<div class="ya-app" aria-busy="${state.busy}">
      ${banner}
      <header class="ya-header"><div><p class="ya-eyebrow">Synapse Business · Рекламные площадки</p><h1>Яндекс: реклама и результаты</h1><p class="ya-muted">Проверенные данные, решения и постоянный список работ.</p></div>
        <div class="ya-header-actions"><label class="ya-field">Компания<select data-company aria-label="Выбрать компанию">${allowedCompanies.map((company) => `<option value="${e(company.id)}" ${company.id === state.companyId ? 'selected' : ''}>${e(company.label)}</option>`).join('')}</select></label><button type="button" data-action="refresh" ${state.busy ? 'disabled' : ''}>Проверить состояние</button></div></header>
      <nav class="ya-nav" aria-label="Разделы рекламы"><a href="#${prefix}-overview">Обзор</a><a href="#${prefix}-connect">Подключение</a><a href="#${prefix}-profile">Профиль</a><a href="#${prefix}-proposals">Решения</a><a href="#${prefix}-jobs">Список работ</a></nav>
      <div class="ya-notices" aria-live="polite" aria-atomic="true" data-status-focus tabindex="-1">${state.busy ? '<p class="ya-note">Проверяем данные выбранной компании…</p>' : ''}${state.error || localError ? `<p class="ya-error" role="alert">${e(localError || state.error)}</p>` : ''}${state.message && !localError ? `<p class="ya-success">${e(state.message)}</p>` : ''}${state.uncertain ? '<p class="ya-error">Есть операция с неизвестным результатом. Новые отправки приостановлены до серверной сверки; повтор не создаётся.</p>' : ''}</div>
      ${view ? content(view, state, selected?.label) : `<section class="ya-card"><h2>${e(selected?.label || 'Компания')}</h2><p>${state.busy ? 'Загружаем только данные выбранной компании.' : 'Данные пока не получены. Проверьте доступность серверного подключения.'}</p></section>`}
      <footer class="ya-footer">Изменения рекламы, модерация, запуск и увеличение бюджета требуют независимых разрешений. В этой версии нет запуска и платежей.</footer>
    </div>`;
    if (!state.busy && (state.message || state.error || localError)) root.querySelector('[data-status-focus]')?.focus();
  }

  function content(view, state, companyLabel) {
    const writable = !state.busy && !state.uncertain;
    const profile = view.profile;
    const draft = drafts.get(view.companyId) || {};
    const facts = draft.profile || profile.businessFacts || {};
    const profileFields = draft.profile || { label: profile.label || companyLabel, siteHosts: (profile.siteHosts || []).join(', '), methodologyVersion: profile.methodologyVersion };
    const bindings = draft.bindings || view.bindings;
    const overview = view.overview || {};
    const checkedTime = Date.parse(overview.checkedAt);
    const stale = !Number.isFinite(checkedTime) || checkedTime > now() + 300000 || now() - checkedTime > (overview.staleAfterMs || 3600000);
    const mode = view.policy?.mode || 'observe';
    const disable = (method) => !writable || typeof adapter[method] !== 'function' ? 'disabled' : '';
    const budget = Number.isSafeInteger(view.policy?.totalBudgetMinor) ? formatMoney(view.policy.totalBudgetMinor, view.policy.currency) : 'Не согласован';
    const metricCards = [['spend','Рекламный расход'], ['leads','Полезные заявки'], ['paidClients','Новые платящие клиенты'], ['cpl','Стоимость заявки · CPL'], ['cac','Стоимость нового клиента · CAC']]
      .map(([name, label]) => { const value = metricDisplay(view, name); return `<article class="ya-metric"><h3>${e(label)}</h3><p class="ya-metric-value">${e(value.value)}</p><p class="ya-muted">${e(value.note)}</p></article>`; }).join('');
    const proposalDraft = draft.proposal || {};
    const factNames = {services:'Услуги и предложения',resultsSource:'Источник результатов',region:'Регион',goalMeaning:'Бизнес-смысл цели',capacity:'Ёмкость'};
    const factSources = (profile.factRecords || []).length ? `<details class="ya-wizard"><summary>Источники сохранённых фактов</summary><dl class="ya-diff">${profile.factRecords.map((fact) => `<div><dt>${e(factNames[fact.kind] || 'Сохранённый бизнес-факт')}</dt><dd>${e(fact.value)}<small>${e(fact.source)} · ${e(String(fact.verifiedAt || '').slice(0,10))}</small></dd></div>`).join('')}</dl></details>` : '';
    const proposedAd = view.ads.find((ad) => ad.id === proposalDraft.adId) || view.ads[0];
    const defaultTitles = proposedAd?.responsiveAd?.Titles?.join('\n') || '';
    const defaultTexts = proposedAd?.responsiveAd?.Texts?.join('\n') || '';

    return `<section id="${prefix}-overview" class="ya-section" aria-labelledby="${prefix}-overview-title"><div class="ya-section-title"><h2 id="${prefix}-overview-title">${e(companyLabel)} · обзор</h2><span class="ya-pill">Режим: ${e(statusLabel(mode))}</span></div>
      <div class="ya-budget"><div><span>Общий согласованный лимит компании</span><strong>${e(budget)}</strong><small>${e(view.policy?.period?.from || 'Период не задан')} — ${e(view.policy?.period?.to || 'Период не задан')}</small></div><p>Один лимит на компанию, а не сумма для каждой новой кампании. Пополнение не входит в рекламный расход.</p></div>
      <div class="ya-freshness ${stale ? 'ya-stale' : ''}"><strong>${stale ? 'Данные требуют обновления' : 'Свежесть данных'}</strong><span>Последняя проверка: ${e(date(overview.checkedAt))} · Бангкок</span><span>${e(overview.periodLabel || 'Период статистики не подтверждён')}</span></div>
      <div class="ya-metrics">${metricCards}</div></section>

      <section id="${prefix}-connect" class="ya-card ya-section" aria-labelledby="${prefix}-connect-title"><div class="ya-section-title"><h2 id="${prefix}-connect-title">Подключение и привязки</h2>${pill(view.capabilities?.connection)}</div>
        <p>${view.connection?.verifiedAt ? `Аккаунт: <strong>${e(view.connection.accountLabel || view.connection.accountId || 'Имя не получено')}</strong>. Проверка ${e(date(view.connection.verifiedAt))}.` : 'Личность Яндекса и доступ API ещё не проверены.'}</p>
        <button type="button" data-action="connect" ${disable('beginConnection')}>Подключить Яндекс</button><p class="ya-muted">${typeof adapter.beginConnection === 'function' ? 'Подключение потребует личного подтверждения на стороне Яндекса.' : 'OAuth ещё не установлен. Кнопка станет доступна после монтажа серверного подключения.'} Пароли и коды сюда не вводятся.</p>
        <ol class="ya-capabilities">${capabilities.map(([key,label,note]) => `<li><div><strong>${e(label)}</strong><small>${e(note)}</small></div>${pill(view.capabilities?.[key])}</li>`).join('')}</ol>
        <details class="ya-wizard" open><summary>Выбрать разрешённые объекты компании</summary><p>Показан список, разрешённый сервером для этой компании. Привязка читает существующую рекламу и не создаёт копию.</p>
          <form data-binding-form><div class="ya-columns">${checkList('campaignIds', view.campaigns, bindings.campaignIds || [], 'Кампании')}${checkList('counterIds', view.counters, bindings.counterIds || [], 'Счётчики Метрики')}</div><p class="ya-muted">Цели выбранных счётчиков: ${e(view.goals.filter((goal) => (bindings.counterIds || []).includes(goal.counterId)).map((goal) => `${goal.label || goal.id} (${goal.id})`).join('; ') || 'Ещё не получены')}. Выбор цели для действующей рекламы — отдельное решение.</p><button type="submit" ${disable('saveBindings') || (view.environment !== 'demo' && (!view.bindings.connectionId || !view.bindings.accountId) ? 'disabled' : '')}>Подтвердить привязки</button></form>
        </details></section>

      <section id="${prefix}-profile" class="ya-card ya-section" aria-labelledby="${prefix}-profile-title"><h2 id="${prefix}-profile-title">Бизнес-профиль</h2><p class="ya-muted">Данные этой компании. Пустые поля не заполняются чужими ценами, целями или бюджетом.</p>
        <p><strong>Разрешённые сайты:</strong> ${e((profile.siteHosts || []).join(', ') || 'Не подтверждены')}<br><strong>Принятая методика:</strong> ${e(profile.methodologyVersion || 'Не выбрана')}</p>${factSources}
        <form data-profile-form><div class="ya-columns">${input('label','Название компании',profileFields.label,'text','required')}${input('siteHosts','Разрешённые домены сайтов, через запятую',profileFields.siteHosts,'text','required')}${input('methodologyVersion','Версия принятой методики',profileFields.methodologyVersion,'text','required')}${textarea('services','Приоритетные услуги и подтверждённые предложения',facts.services)}${textarea('goalMeaning','Бизнес-смысл цели: что считаем заявкой и клиентом',facts.goalMeaning)}${input('region','Регион',facts.region)}${input('capacity','Часы обработки и доступная ёмкость',facts.capacity)}${input('resultsSource','Источник заявок и подтверждённых оплат',facts.resultsSource)}${input('source','Источник новых или изменённых фактов',facts.source)}${input('checkedAt','Дата проверки новых или изменённых фактов',facts.checkedAt,'date')}</div><p class="ya-muted">Сохранение профиля не меняет цели, рекламный бюджет и настройки Яндекса.</p><button type="submit" ${disable('saveProfile')} data-focus="profile">Сохранить профиль</button></form></section>

      <section id="${prefix}-proposals" class="ya-section" aria-labelledby="${prefix}-proposals-title"><h2 id="${prefix}-proposals-title">Предложения и согласования</h2><p class="ya-muted">Согласование фиксирует конкретную версию. Применение — отдельное задание; устаревшее предложение требует новой проверки.</p>
        <div class="ya-proposals">${view.proposals.length ? view.proposals.map((proposal) => proposalCard(proposal, writable && (view.environment === 'demo' || mode === 'draft'))).join('') : '<div class="ya-card"><p>Предложений пока нет. Наблюдение продолжается без внешних изменений.</p></div>'}</div>
        <details class="ya-card"><summary>Подготовить предложение для существующего черновика</summary><p>Каждый заголовок и текст — с новой строки. Все варианты сохраняются в предложении. Этот шаг не меняет объявление.</p>
          <form data-proposal-form><label class="ya-field">Объявление<select name="adId" data-ad>${view.ads.filter((ad) => ad.status === 'DRAFT').map((ad) => `<option value="${e(ad.id)}" ${ad.id === proposedAd?.id ? 'selected' : ''}>${e(ad.label || ad.id)}</option>`).join('')}</select></label><div class="ya-columns">${textarea('Titles','Заголовки: от 1 до 7',proposalDraft.Titles ?? defaultTitles)}${textarea('Texts','Тексты: от 1 до 3',proposalDraft.Texts ?? defaultTexts)}</div><button type="submit" ${disable('createProposal') || (!view.ads.some((ad) => ad.status === 'DRAFT') ? 'disabled' : '')}>Сохранить предложение на проверку</button></form>
        </details></section>

      <section id="${prefix}-jobs" class="ya-card ya-section" aria-labelledby="${prefix}-jobs-title"><div class="ya-section-title"><h2 id="${prefix}-jobs-title">Постоянный список работ</h2><span>${e(view.jobs.length)} записей</span></div><p class="ya-muted">${view.environment === 'demo' ? 'Учебная очередь в памяти страницы. Перезагрузка очистит демонстрацию.' : 'Список приходит с сервера. Постоянная работа требует установленного серверного исполнителя.'}</p>
        ${view.jobs.length ? `<div class="ya-table-wrap" tabindex="0" aria-label="Прокручиваемый список работ"><table><caption class="ya-sr-only">Задания выбранной компании</caption><thead><tr><th scope="col">Работа</th><th scope="col">Состояние</th><th scope="col">Следующий шаг</th><th scope="col">Обновлено</th></tr></thead><tbody>${view.jobs.map((job) => `<tr><th scope="row">${e(job.label || job.kind || job.id)}<small>${e(job.id)}</small></th><td>${pill(job.status)}</td><td>${e(job.nextStep || (job.status === 'unknown' ? 'Сверить фактический результат. Повтор запрещён.' : 'Ожидать серверной проверки'))}</td><td>${e(date(job.updatedAt))}</td></tr>`).join('')}</tbody></table></div>` : '<p>Работ пока нет. Это не означает, что реклама подключена или проверена.</p>'}
      </section>`;
  }

  function proposalCard(proposal, writable) {
    const expired = proposal.expiresAt && Date.parse(proposal.expiresAt) <= now();
    const approved = proposal.status === 'approved';
    const canApprove = writable && !expired && proposal.status === 'proposed' && proposal.canApprove !== false && typeof adapter.approveProposal === 'function';
    const canQueue = writable && !expired && approved && typeof adapter.enqueueProposal === 'function';
    const diff = Object.entries(proposal.patch || {}).filter(([field]) => ['Titles','Texts','Href','DisplayUrlPath'].includes(field)).map(([field,value]) => `<div><dt>${e(({Titles:'Заголовки',Texts:'Тексты',Href:'Ссылка',DisplayUrlPath:'Отображаемый путь'})[field])}</dt><dd>${e(Array.isArray(value) ? value.join('\n') : value)}</dd></div>`).join('');
    return `<article class="ya-card"><div class="ya-section-title"><h3>${e(proposal.label || 'Изменение черновика')}</h3>${pill(expired ? 'expired' : proposal.status)}</div><p>${e(proposal.reason || 'Проверьте полный список изменений перед согласованием.')}</p><p><strong>Объявление:</strong> ${e(proposal.adId)}<br><strong>Бюджет:</strong> без изменения</p><dl class="ya-diff">${diff}</dl><p class="ya-muted">Срок: ${e(date(proposal.expiresAt))}. Версия ${e(String(proposal.digest || '').slice(0, 16) || 'не подтверждена')}.</p>${proposal.canApprove === false ? '<p class="ya-muted">Согласование требует другого уполномоченного пользователя.</p>' : ''}<div class="ya-button-row"><button type="button" data-action="approve" data-id="${e(proposal.id)}" ${canApprove ? '' : 'disabled'}>Согласовать эту версию</button><button type="button" data-action="queue" data-id="${e(proposal.id)}" ${canQueue ? '' : 'disabled'}>Поставить применение в очередь</button></div></article>`;
  }

  function showError(error) { localError = safeError(error); render(controller.getState()); }
  async function onSubmit(event) {
    if (!event.target.matches('form')) return;
    event.preventDefault(); rememberDrafts(); localError = '';
    const { view } = controller.getState();
    if (!view) return;
    const fields = Object.fromEntries(new FormData(event.target));
    try {
      if (event.target.matches('[data-profile-form]')) {
        await controller.act('saveProfile', buildProfile(view.profile, fields));
      } else if (event.target.matches('[data-binding-form]')) {
        const form = new FormData(event.target);
        await controller.act('saveBindings', validateBindings(view, { campaignIds: form.getAll('campaignIds'), counterIds: form.getAll('counterIds') }));
      } else if (event.target.matches('[data-proposal-form]')) {
        const ad = view.ads.find((item) => item.id === fields.adId && item.status === 'DRAFT');
        if (!ad) throw new UiContractError('Объявление не является доступным черновиком этой компании.');
        await controller.act('createProposal', { adId: fields.adId, patch: buildAdPatch(fields, ad), expiresAt: new Date(now() + 86400000).toISOString() });
      }
    } catch (error) { showError(error); }
  }
  async function onClick(event) {
    const button = event.target.closest('[data-action]');
    if (!button || !root.contains(button) || button.disabled) return;
    rememberDrafts(); localError = '';
    try {
      const action = button.dataset.action;
      if (action === 'refresh') return await controller.load();
      if (action === 'connect') return await controller.act('beginConnection', {});
      const proposal = controller.getState().view?.proposals.find((item) => item.id === button.dataset.id);
      if (!proposal?.digest) throw new UiContractError('Версия предложения не подтверждена.');
      if (action === 'approve') await controller.act('approveProposal', { proposalId: proposal.id, digest: proposal.digest });
      if (action === 'queue') await controller.act('enqueueProposal', { proposalId: proposal.id, digest: proposal.digest });
    } catch (error) { showError(error); }
  }
  async function onChange(event) {
    if (event.target.matches('[data-company]')) {
      rememberDrafts(); localError = ''; await controller.load(event.target.value);
    } else if (event.target.matches('[data-ad]')) {
      const ad = controller.getState().view?.ads.find((item) => item.id === event.target.value);
      if (!ad) return;
      const form = event.target.closest('form');
      form.elements.Titles.value = (ad.responsiveAd?.Titles || []).join('\n');
      form.elements.Texts.value = (ad.responsiveAd?.Texts || []).join('\n');
      rememberDrafts();
    } else rememberDrafts();
  }
  root.addEventListener('submit', onSubmit);
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', rememberDrafts);
  const ready = controller.load(initialCompanyId || allowedCompanies[0].id);
  return { ready, refresh: () => { rememberDrafts(); return controller.load(); },
    destroy() { controller.destroy(); root.removeEventListener('submit', onSubmit); root.removeEventListener('click', onClick); root.removeEventListener('change', onChange); root.removeEventListener('input', rememberDrafts); root.replaceChildren(); drafts.clear(); } };
}
