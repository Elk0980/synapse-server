import { assertCompanyView, UiContractError } from './ui-state.mjs';

const clone = (value) => structuredClone(value);
const id = (value) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new UiContractError('API вернул идентификатор с потерянной точностью.');
  if (!['string', 'number'].includes(typeof value)) throw new UiContractError('API не подтвердил идентификатор.');
  return String(value);
};
const minor = (value) => {
  if (value === undefined || value === null) return undefined;
  if (!/^\d+$/.test(String(value))) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
};

/** Explicit projection: provider errors, arbitrary fields and secrets never reach the UI. */
export function normalizeServiceView(raw, companyId, viewer = {}) {
  if (raw?.companyId !== companyId || (raw.profile && raw.profile.companyId !== companyId))
    throw new UiContractError('Ответ сервера не привязан к выбранной компании.');
  const scope = (item) => {
    if (item.companyId && item.companyId !== companyId) throw new UiContractError('В ответе обнаружена другая компания.');
    return { companyId, id: id(item.Id ?? item.id) };
  };
  const facts = {};
  const sourceFacts = Array.isArray(raw.profile?.businessFacts) ? raw.profile.businessFacts : [];
  for (const fact of sourceFacts) {
    if (['services','resultsSource'].includes(fact.kind)) facts[fact.kind] = [facts[fact.kind], String(fact.value || '')].filter(Boolean).join('\n');
  }
  const provenances = new Set(sourceFacts.map((fact) => `${fact.source}\u0000${String(fact.verifiedAt).slice(0,10)}`));
  const sharedProvenance = provenances.size === 1 ? sourceFacts[0] : null;
  Object.assign(facts, {
    region: raw.profile?.region || '', goalMeaning: raw.profile?.goalMeaning || '', capacity: raw.profile?.capacity || '',
    source: sharedProvenance?.source || '', checkedAt: String(sharedProvenance?.verifiedAt || '').slice(0, 10),
  });
  const campaigns = (raw.objects?.campaigns || []).map((item) => ({
    ...scope(item), label: item.Name || `Кампания ${id(item.Id)}`, status: item.Status, state: item.State,
  }));
  const ads = (raw.objects?.ads || []).map((item) => ({
    ...scope(item), campaignId: id(item.CampaignId), label: `Объявление ${id(item.Id)}`, status: item.Status,
    responsiveAd: { Titles: clone(item.ResponsiveAd?.Titles || []), Texts: clone(item.ResponsiveAd?.Texts || []) },
  }));
  const boundCampaigns = new Set((raw.bindings?.campaignIds || []).map(id));
  if (campaigns.some((item) => !boundCampaigns.has(item.id)) || ads.some((item) => !boundCampaigns.has(item.campaignId)))
    throw new UiContractError('Объект не входит в привязки выбранной компании.');
  const counters = (raw.counters || (raw.bindings?.counterIds || []).map((counterId) => ({ id: counterId })))
    .map((item) => ({ ...scope(item), label: item.label || `Счётчик ${id(item.id ?? item.Id)} · проверка доступа отдельно` }));
  const boundCounters = new Set((raw.bindings?.counterIds || []).map(id));
  if (counters.some((item) => !boundCounters.has(item.id))) throw new UiContractError('Счётчик не входит в привязки выбранной компании.');
  const goals = (raw.goals || []).map((item) => ({ ...scope(item), counterId: id(item.counterId), label: item.label || id(item.id) }));
  const policy = raw.policy || {};
  const profile = { companyId, label: raw.profile?.label || '', siteHosts: clone(raw.profile?.siteHosts || []), methodologyVersion: raw.profile?.methodologyVersion || '', businessFacts: facts, factRecords: clone(sourceFacts), factBaseline: clone(facts) };
  const proposals = (raw.proposals || []).map((item) => ({
    ...scope(item), adId: id(item.adId), patch: clone(item.patch || {}), digest: item.digest,
    status: item.status, expiresAt: item.expiresAt, proposerId: item.proposerId,
    canApprove: (raw.viewer || viewer).kind === 'human' && (raw.viewer || viewer).id !== item.proposerId,
  }));
  const jobs = (raw.jobs || []).map((item) => ({
    ...scope(item), proposalId: item.proposalId, kind: 'Проверка и применение согласованного черновика', status: item.state,
    updatedAt: item.updatedAt || item.createdAt,
    nextStep: item.state === 'reconciled_locked' ? 'Результат сверен; блокировка записи остаётся до отдельного решения.' : item.state === 'unknown' ? 'Серверная сверка результата без повторной отправки.' :
      item.state === 'blocked' ? 'Проверьте доступ, разрешение и актуальность предложения.' : undefined,
  }));
  return assertCompanyView({
    companyId, environment: 'unconnected', version: raw.bindings?.version,
    profile, campaigns, ads, counters, goals, proposals, jobs,
    connection: raw.connection ? { accountId: String(raw.connection.accountId || ''), verifiedAt: raw.connection.verifiedAt } : null,
    capabilities: clone(raw.capabilities || {}),
    policy: { mode: policy.mode || 'observe', totalBudgetMinor: minor(policy.maxBudgetMinor), currency: policy.currency || 'RUB', period: clone(policy.period || {}) },
    bindings: { connectionId: raw.bindings?.connectionId, accountId: raw.bindings?.accountId,
      campaignIds: (raw.bindings?.campaignIds || []).map(id), counterIds: (raw.bindings?.counterIds || []).map(id), version: raw.bindings?.version },
    overview: { currency: policy.currency || 'RUB', metrics: {}, periodLabel: 'Рекламные отчёты ещё не подключены' },
  }, companyId);
}

/** invoke must use the host's authenticated same-origin transport; no Yandex fetch lives here.
 * The server injects actor. Never accept an actor from browser form fields. */
export function createServiceAdapter({ invoke, viewer = {} }) {
  if (typeof invoke !== 'function') throw new Error('Нужен доверенный транспорт invoke.');
  const scoped = async (companyId, method, args) => {
    const result = await invoke(method, { companyId, ...args });
    if (result?.companyId && result.companyId !== companyId) throw new UiContractError('Ответ действия принадлежит другой компании.');
    return result;
  };
  return {
    getCompanyView: async (companyId) => normalizeServiceView(await invoke('getCompanyView', { companyId }), companyId, viewer),
    async saveProfile(companyId, profile) {
      if (profile.companyId !== companyId) throw new UiContractError('Профиль другой компании.');
      const facts = profile.businessFacts || {};
      const managedKinds = ['services','resultsSource','region','goalMeaning','capacity'];
      const records = profile.factRecords || [];
      const changedKinds = managedKinds.filter((kind) => {
        const previous = profile.factBaseline?.[kind] ?? records.filter((fact) => fact.kind === kind).map((fact) => fact.value).join('\n');
        return String(facts[kind] || '') !== String(previous || '');
      });
      if (changedKinds.some((kind) => facts[kind]) && (!facts.source || !/^\d{4}-\d{2}-\d{2}$/.test(facts.checkedAt || '')))
        throw new UiContractError('Для изменённых фактов укажите источник и дату проверки.');
      // Preserve every unchanged record, including its exact source, timestamp and order.
      const businessFacts = [...records.filter((fact) => !changedKinds.includes(fact.kind)), ...changedKinds.flatMap((kind) => String(facts[kind] || '').split(/\r?\n/).filter(Boolean).map((value) => ({
        kind, value, source: facts.source, verifiedAt: `${facts.checkedAt}T00:00:00.000Z`,
      })))];
      const payload = { companyId, label: profile.label, siteHosts: profile.siteHosts, methodologyVersion: profile.methodologyVersion, businessFacts };
      for (const key of ['region','goalMeaning','capacity']) if (facts[key]) payload[key] = facts[key].replace(/[\r\n]+/g, ' ');
      const result = await scoped(companyId, 'saveProfile', { profile: payload });
      if (result?.companyId !== companyId) return { companyId, outcome: 'unknown' };
      return { companyId, outcome: 'saved' };
    },
    async saveBindings(companyId, binding) {
      const result = await scoped(companyId, 'saveBindings', { binding: {
        connectionId: binding.connectionId, accountId: binding.accountId, campaignIds: binding.campaignIds, counterIds: binding.counterIds,
      } });
      if (!Number.isSafeInteger(result?.version)) return { companyId, outcome: 'unknown' };
      return { companyId, outcome: 'saved' };
    },
    async createProposal(companyId, proposal) {
      const result = await scoped(companyId, 'createProposal', { proposal });
      if (!result?.id || !result.digest) return { companyId, outcome: 'unknown' };
      return { companyId, outcome: 'saved', proposalId: result.id, digest: result.digest };
    },
    async approveProposal(companyId, { proposalId, digest }) {
      const result = await scoped(companyId, 'approveProposal', { proposalId, digest });
      if (result?.proposalId !== proposalId || result.digest !== digest || !result.approvedAt) return { companyId, outcome: 'unknown' };
      return { companyId, outcome: 'approved' };
    },
    async enqueueProposal(companyId, { proposalId, digest }) {
      const result = await scoped(companyId, 'enqueueProposal', { proposalId, digest });
      if (!result?.id || !['queued', 'claimed', 'writing', 'running', 'leased', 'completed'].includes(result.state)) return { companyId, outcome: 'unknown' };
      return { companyId, outcome: 'queued' };
    },
  };
}
