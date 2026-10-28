import { assertCompanyView, buildProfile, validateBindings, UiContractError } from './ui-state.mjs';

export const demoCompanies = Object.freeze([
  { id: 'demo-north', label: 'Учебная компания «Север»' },
  { id: 'demo-south', label: 'Учебная компания «Юг»' },
]);
const clone = (value) => structuredClone(value);

export function makeSyntheticViews(now = Date.now()) {
  const checkedAt = new Date(now - 7200000).toISOString();
  const metric = (value, extra = {}) => ({ value, evidence: 'synthetic', periodVerified: true, ...extra });
  return Object.fromEntries(demoCompanies.map(({ id: companyId, label }, index) => [companyId, {
    companyId, environment: 'demo', version: 1,
    profile: { companyId, label, siteHosts: [index ? 'south.example' : 'north.example'], methodologyVersion: 'Учебная методика 1', businessFacts: {} },
    connection: null,
    capabilities: { connection:'unverified', read:'unverified', import:'unverified', draftWrite:'disabled', attribution:'unverified', moderation:'unsupported', launch:'unsupported' },
    policy: { mode: 'observe', currency: 'RUB', ...(index ? {} : { totalBudgetMinor: 1500000, period:{from:'2026-10-01',to:'2026-10-31'} }) },
    bindings: { campaignIds: index ? [] : ['demo-campaign-n'], counterIds: [], version:1 },
    campaigns: [{ companyId, id: index ? 'demo-campaign-s' : 'demo-campaign-n', label: index ? 'Учебный черновик Юга' : 'Учебный черновик Севера', status:'DRAFT' }],
    counters: [{ companyId, id:`demo-counter-${index}`, label:'Учебный счётчик' }],
    goals: [{ companyId, id:`demo-goal-${index}`, counterId:`demo-counter-${index}`, label:'Учебная заявка, не клиент' }],
    ads: [{ companyId, id:`demo-ad-${index}`, campaignId:index ? 'demo-campaign-s' : 'demo-campaign-n', status:'DRAFT', label:'Учебное комбинаторное объявление', responsiveAd:{Titles:['Первый учебный заголовок','Второй учебный заголовок'],Texts:['Первый учебный текст','Второй учебный текст']} }],
    overview: { currency:'RUB', checkedAt, periodLabel:index ? 'Период не подтверждён' : 'Учебный период: 1–28 октября 2026', metrics:index ? {} : {
      spend:metric(450000),leads:metric(12),paidClients:metric(0,{paymentVerified:false}),
      cpl:metric(37500,{attributionVerified:true}),cac:metric(0,{paymentVerified:false,attributionVerified:false}),
    } },
    proposals:index ? [] : [{companyId,id:'demo-proposal-1',adId:'demo-ad-0',status:'proposed',digest:'demo-version-1',expiresAt:new Date(now+86400000).toISOString(),reason:'Учебный пример: проверить ясность предложения. Эффективность ещё не измерена.',patch:{Titles:['Первый учебный заголовок','Уточнённый учебный заголовок'],Texts:['Первый учебный текст','Второй учебный текст']}}],
    jobs:index ? [] : [{companyId,id:'demo-job-1',kind:'Учебная проверка доступности',status:'blocked',updatedAt:checkedAt,nextStep:'Подключение API ещё не установлено; внешних действий нет.'}],
  }]));
}

/** Local memory only. Intentionally has no connection, execution, launch or payment method. */
export function createSyntheticAdapter({ now = () => Date.now() } = {}) {
  const views = makeSyntheticViews(now());
  let sequence = 1;
  const get = (companyId) => {
    if (!Object.hasOwn(views, companyId)) throw new UiContractError('Учебная компания не разрешена.');
    return assertCompanyView(views[companyId], companyId);
  };
  return {
    async getCompanyView(companyId) { return clone(get(companyId)); },
    async saveProfile(companyId, profile) {
      const view = get(companyId);
      if (profile.companyId !== companyId) throw new UiContractError('Профиль другой компании.');
      view.profile = clone(buildProfile(profile, profile.businessFacts || {})); view.version += 1;
      return {companyId,outcome:'saved'};
    },
    async saveBindings(companyId, selection) {
      const view = get(companyId); view.bindings = validateBindings(view, selection); view.version += 1;
      return {companyId,outcome:'saved'};
    },
    async createProposal(companyId, { adId, patch, expiresAt }) {
      const view = get(companyId);
      if (!view.ads.some((ad) => ad.id === adId && ad.status === 'DRAFT')) throw new UiContractError('Черновик другой компании.');
      const proposalId = `demo-proposal-${++sequence}`;
      view.proposals.push({companyId,id:proposalId,adId,patch:clone(patch),expiresAt,status:'proposed',digest:`demo-version-${sequence}`,reason:'Учебное предложение. Реклама не изменена.'});
      view.version += 1; return {companyId,outcome:'saved',proposalId,digest:`demo-version-${sequence}`};
    },
    async approveProposal(companyId, { proposalId, digest }) {
      const proposal = get(companyId).proposals.find((item) => item.id === proposalId);
      if (!proposal || proposal.digest !== digest || Date.parse(proposal.expiresAt) <= now()) throw new UiContractError('Версия учебного предложения устарела.');
      proposal.status='approved'; return {companyId,outcome:'approved'};
    },
  };
}
