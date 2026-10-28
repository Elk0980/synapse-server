/** Pure UI contracts. Authorization remains the responsibility of the server. */
export class UiContractError extends Error {
  constructor(message) { super(message); this.name = 'UiContractError'; }
}

export const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g,
  (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export const statusLabels = Object.freeze({
  verified: 'Проверено', unverified: 'Не проверено', revoked: 'Доступ отозван',
  disabled: 'Выключено', configured: 'Настроено, проверка записи не выполнена',
  unsupported: 'Недоступно в этой версии', queued: 'В очереди', running: 'В работе',
  leased: 'В работе', claimed: 'В работе', writing: 'Проверяем применение', completed: 'Завершено', succeeded: 'Завершено',
  failed: 'Ошибка', blocked: 'Нужен следующий шаг', unknown: 'Результат неизвестен',
  proposed: 'На проверке', approved: 'Согласовано', expired: 'Срок истёк',
  applied: 'Применено', draft: 'Черновик', observe: 'Наблюдение',
  reconciled_locked: 'Результат сверен, блокировка сохранена',
});
export const statusLabel = (status) => statusLabels[status] || 'Состояние не подтверждено';

function inspectScope(value, companyId) {
  if (!value || typeof value !== 'object') return;
  if (Object.hasOwn(value, 'companyId') && value.companyId !== companyId)
    throw new UiContractError('Ответ содержит данные другой компании. Отображение остановлено.');
  for (const child of Object.values(value)) inspectScope(child, companyId);
}

export function assertCompanyView(view, companyId) {
  if (!view || view.companyId !== companyId)
    throw new UiContractError('Сервер не подтвердил компанию ответа. Данные не показаны.');
  inspectScope(view, companyId);
  for (const collection of ['campaigns', 'ads', 'counters', 'goals', 'proposals', 'jobs']) {
    if (!Array.isArray(view[collection])) throw new UiContractError(`Некорректный список: ${collection}.`);
    for (const item of view[collection]) {
      if (item.companyId !== companyId || typeof item.id !== 'string' || !item.id)
        throw new UiContractError('Объект не привязан к компании или его идентификатор повреждён.');
    }
  }
  if (view.profile?.companyId !== companyId)
    throw new UiContractError('Профиль не привязан к выбранной компании.');
  return view;
}

export function validateBindings(view, selection) {
  for (const [field, list] of [['campaignIds', view.campaigns], ['counterIds', view.counters]]) {
    if (!Array.isArray(selection[field]) || selection[field].some((id) => typeof id !== 'string'))
      throw new UiContractError('Идентификаторы должны передаваться строками.');
    const allowed = new Set(list.map((item) => item.id));
    if (selection[field].some((id) => !allowed.has(id)))
      throw new UiContractError('Выбран объект вне доступного списка компании.');
  }
  return {
    ...view.bindings,
    campaignIds: [...new Set(selection.campaignIds)],
    counterIds: [...new Set(selection.counterIds)],
  };
}

export function buildProfile(profile, fields) {
  const businessFacts = {
    services: String(fields.services || '').trim(),
    region: String(fields.region || '').trim(),
    goalMeaning: String(fields.goalMeaning || '').trim(),
    capacity: String(fields.capacity || '').trim(),
    resultsSource: String(fields.resultsSource || '').trim(),
    source: String(fields.source || '').trim(),
    checkedAt: String(fields.checkedAt || '').trim(),
  };
  if (Object.values(businessFacts).some((value) => value.length > 2000))
    throw new UiContractError('Одно поле профиля превышает 2 000 символов.');
  const changedFacts = Object.entries(businessFacts).some(([key, value]) => !['source', 'checkedAt'].includes(key)
    && value !== String(profile.factBaseline?.[key] || ''));
  if (changedFacts
      && (!businessFacts.source || !/^\d{4}-\d{2}-\d{2}$/.test(businessFacts.checkedAt)))
    throw new UiContractError('Для бизнес-фактов укажите источник и дату проверки.');
  const result = { ...profile, businessFacts };
  for (const key of ['label', 'methodologyVersion']) {
    if (Object.hasOwn(fields, key)) result[key] = String(fields[key] || '').trim();
  }
  if (Object.hasOwn(fields, 'siteHosts')) {
    result.siteHosts = [...new Set(String(fields.siteHosts || '').split(/[\s,]+/).filter(Boolean).map((host) => host.toLowerCase()))];
    if (!result.siteHosts.length || result.siteHosts.some((host) => !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(host)))
      throw new UiContractError('Укажите домен сайта без https:// и пути страницы.');
  }
  if (!result.label || !result.methodologyVersion) throw new UiContractError('Укажите название компании и версию принятой методики.');
  return result;
}

export function buildAdPatch(fields, ad) {
  const patch = {};
  for (const [name, max] of [['Titles', 7], ['Texts', 3]]) {
    const items = String(fields[name] || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (items.length < 1 || items.length > max) throw new UiContractError(`Заполните ${name === 'Titles' ? 'от 1 до 7 заголовков' : 'от 1 до 3 текстов'}, каждый с новой строки.`);
    patch[name] = items;
    if (ad && items.length !== ad.responsiveAd?.[name]?.length)
      throw new UiContractError('В этой версии можно заменить варианты, сохранив их количество. Добавление и удаление требуют отдельной поддержки.');
  }
  return patch;
}

export function formatMoney(minor, currency = 'RUB') {
  if (!Number.isSafeInteger(minor) || minor < 0 || !/^[A-Z]{3}$/.test(currency)) return 'Нет данных';
  try { return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100); }
  catch { return 'Нет данных'; }
}

export function metricDisplay(view, name) {
  const metric = view.overview?.metrics?.[name];
  if (!metric || !['api', 'crm', 'synthetic'].includes(metric.evidence) || !metric.periodVerified)
    return { value: 'Нет данных', note: 'Нужны подтверждённый источник и период.' };
  if (metric.evidence === 'synthetic' && view.environment !== 'demo')
    return { value: 'Нет данных', note: 'Демонстрационные данные скрыты.' };
  if (['cpl', 'cac'].includes(name) && !metric.attributionVerified)
    return { value: 'Недостаточно данных', note: 'Связь с рекламой не подтверждена.' };
  if (['paidClients', 'cac'].includes(name) && !metric.paymentVerified)
    return { value: 'Недостаточно данных', note: 'Нужны подтверждённые оплаты и правило нового клиента.' };
  if (!Number.isSafeInteger(metric.value) || metric.value < 0)
    return { value: 'Нет данных', note: 'Значение не подтверждено.' };
  return {
    value: ['spend', 'cpl', 'cac'].includes(name) ? formatMoney(metric.value, view.overview.currency) : String(metric.value),
    note: metric.evidence === 'synthetic' ? 'Учебный пример, не результат рекламы.' : (metric.sourceLabel || 'Подтверждённый источник'),
  };
}

function mutationMatches(method, payload, view, receipt) {
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  if (method === 'saveProfile') {
    return ['label','methodologyVersion'].every((key) => same(payload[key], view.profile[key]))
      && same([...(payload.siteHosts || [])].sort(), [...(view.profile.siteHosts || [])].sort())
      && Object.entries(payload.businessFacts || {}).every(([key, value]) => {
        if (['source','checkedAt'].includes(key)) return true;
        const expected = key === 'goalMeaning' ? String(value).replace(/[\r\n]+/g, ' ') : String(value);
        return String(view.profile.businessFacts?.[key] || '') === expected;
      });
  }
  if (method === 'saveBindings') return ['campaignIds','counterIds'].every((key) => same([...payload[key]].sort(), [...view.bindings[key]].sort()));
  if (method === 'createProposal') return typeof receipt.proposalId === 'string' && typeof receipt.digest === 'string'
    && view.proposals.some((item) => item.id === receipt.proposalId && item.digest === receipt.digest
      && item.adId === payload.adId && same(item.patch, payload.patch) && Date.parse(item.expiresAt) === Date.parse(payload.expiresAt));
  if (method === 'approveProposal') return view.proposals.some((item) => item.id === payload.proposalId && item.digest === payload.digest && ['approved','queued','applied'].includes(item.status));
  if (method === 'enqueueProposal') return view.jobs.some((item) => item.proposalId === payload.proposalId && ['queued','claimed','writing','completed'].includes(item.status));
  return false;
}

/** Late responses cannot reveal the previous company's data after navigation. */
export function createCompanyController({ adapter, companies, onChange = () => {} }) {
  const allowed = new Set(companies.map((company) => company.id));
  let epoch = 0;
  let destroyed = false;
  let state = { companyId: null, view: null, busy: false, error: '', message: '', uncertain: false };
  const uncertain = new Set();
  const pending = new Set();
  const notify = () => { if (!destroyed) onChange({ ...state }); };
  async function load(companyId = state.companyId) {
    if (!allowed.has(companyId)) throw new UiContractError('Компания не разрешена для этого раздела.');
    const ticket = ++epoch;
    state = { companyId, view: null, busy: true, error: '', message: '', uncertain: uncertain.has(companyId) };
    notify();
    try {
      const view = assertCompanyView(await adapter.getCompanyView(companyId), companyId);
      if (ticket !== epoch) return;
      if (view.reconciliation?.status === 'verified' && view.reconciliation?.operationId)
        uncertain.delete(companyId);
      state = { ...state, view, busy: pending.has(companyId), uncertain: uncertain.has(companyId) || view.jobs.some((job) => ['unknown','reconciled_locked'].includes(job.status)) };
    } catch (error) {
      if (ticket !== epoch) return;
      state = { ...state, view: null, busy: pending.has(companyId), error: safeError(error) };
    }
    notify();
  }
  async function act(method, payload) {
    const { companyId, view, busy } = state;
    if (!view || busy || pending.has(companyId) || state.uncertain) throw new UiContractError('Сначала проверьте текущее состояние компании.');
    if (typeof adapter[method] !== 'function') throw new UiContractError('Это действие пока не подключено.');
    pending.add(companyId);
    state = { ...state, busy: true, error: '', message: '' }; notify();
    try {
      const receipt = await adapter[method](companyId, payload, { expectedVersion: view.version });
      if (!receipt || receipt.companyId !== companyId || !['saved', 'approved', 'queued'].includes(receipt.outcome)) {
        uncertain.add(companyId);
        throw new UiContractError('Результат действия неизвестен. Повторная отправка заблокирована до серверной сверки.');
      }
      // Verify even after navigation, while keeping the other company's screen untouched.
      const readback = assertCompanyView(await adapter.getCompanyView(companyId), companyId);
      if (!mutationMatches(method, payload, readback, receipt))
        throw new UiContractError('Повторное чтение не подтвердило ожидаемое изменение. Повторная отправка заблокирована.');
      pending.delete(companyId);
      if (state.companyId === companyId) {
        epoch += 1; // Discard a concurrent older load for this now-current company.
        state = { ...state, view: readback, busy: false, uncertain: readback.jobs.some((job) => ['unknown','reconciled_locked'].includes(job.status)),
          message: receipt.outcome === 'queued' ? 'Задание поставлено в очередь. Применение ещё не подтверждено.' : receipt.outcome === 'approved' ? 'Предложение согласовано. Реклама не изменена.' : 'Сохранение подтверждено повторным чтением.' };
        notify();
      }
    } catch (error) {
      // Network errors cannot prove that a mutation was not committed.
      uncertain.add(companyId);
      pending.delete(companyId);
      if (state.companyId !== companyId) return;
      epoch += 1;
      state = { ...state, busy: false, uncertain: true, error: safeError(error) }; notify();
    }
  }
  return { load, act, getState: () => ({ ...state }), destroy: () => { destroyed = true; epoch += 1; } };
}

export function safeError(error) {
  if (error instanceof UiContractError) return error.message;
  // Never forward provider errors: they may contain URLs, tokens or other tenants.
  return 'Операция не подтверждена. Проверьте список работ и состояние подключения.';
}
