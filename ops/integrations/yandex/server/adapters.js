'use strict';

const { fail, exact, id, ids, text, clone, period, hash, losslessParse, directJson } = require('./core');

const RESPONSIVE_FIELDS = Object.freeze(['Titles', 'Texts', 'Href', 'DisplayUrlPath', 'AdImages',
  'VideoExtensions', 'SitelinkSetId', 'AdExtensions', 'PriceExtension', 'BusinessId', 'ErirAdDescription']);

function normalizedAd(raw) {
  if (!raw || raw.Type !== 'RESPONSIVE_AD' || !raw.ResponsiveAd) fail('UNSUPPORTED_AD');
  const content = raw.ResponsiveAd;
  const strings = (items, field) => {
    if (!Array.isArray(items) || !items.length) fail('INCOMPLETE_RESPONSIVE_AD');
    return items.map((item) => text(item?.[field], 2048));
  };
  const result = { Id: id(raw.Id), CampaignId: id(raw.CampaignId), AdGroupId: id(raw.AdGroupId),
    Type: raw.Type, Status: text(raw.Status), State: text(raw.State), ResponsiveAd: {
      Titles: strings(content.Titles, 'Title'), Texts: strings(content.Texts, 'Text') } };
  // Keep the read projection for comparison, never send it back wholesale to update.
  for (const field of RESPONSIVE_FIELDS.filter((field) => !['Titles', 'Texts'].includes(field))) {
    if (Object.hasOwn(content, field)) result.ResponsiveAd[field] = clone(content[field]);
  }
  hash(result); // Reject unsafe numbers / non-JSON values before persistence.
  return result;
}
function validatePatch(patch, ad, siteHosts) {
  exact(patch, ['Titles', 'Texts', 'Href', 'DisplayUrlPath']);
  if (!Object.keys(patch).length) fail('EMPTY_PATCH');
  const next = clone(ad);
  for (const field of ['Titles', 'Texts']) {
    if (!Object.hasOwn(patch, field)) continue;
    // This first version supports replacements only; never silently drop variants.
    if (!Array.isArray(patch[field]) || patch[field].length !== ad.ResponsiveAd[field].length) fail('VARIANT_LOSS_FORBIDDEN');
    patch[field].forEach((value) => {
      text(value, field === 'Titles' ? 200 : 400);
      // Conservative documented subset: no special expansion for templates/narrow punctuation.
      const max = field === 'Titles' ? 56 : 81;
      const wordMax = field === 'Titles' ? 22 : 23;
      if (Array.from(value).length > max || value.split(/\s+/u).some((word) => Array.from(word).length > wordMax)) fail('INVALID_AD_TEXT');
    });
    next.ResponsiveAd[field] = clone(patch[field]);
  }
  if (Object.hasOwn(patch, 'Href')) {
    let url;
    try { url = new URL(text(patch.Href, 2048)); } catch { fail('INVALID_HREF'); }
    if (url.protocol !== 'https:' || url.username || url.password || !siteHosts.includes(url.hostname)) fail('HREF_NOT_ALLOWED');
    if ([...url.searchParams.keys()].some((name) => /token|secret|password|auth|cookie/i.test(name))) fail('SENSITIVE_HREF');
    next.ResponsiveAd.Href = patch.Href;
  }
  if (Object.hasOwn(patch, 'DisplayUrlPath')) {
    const display = text(patch.DisplayUrlPath, 20);
    if (/[\s_]/u.test(display) || display.includes('--') || display.includes('//')) fail('INVALID_DISPLAY_PATH');
    next.ResponsiveAd.DisplayUrlPath = display;
  }
  return next;
}

class YandexAdapters {
  #transport;
  #resolve;
  constructor({ transport, resolveSecret } = {}) {
    if ((transport && typeof transport !== 'function') || (resolveSecret && typeof resolveSecret !== 'function')) fail('INVALID_DEPENDENCY');
    this.#transport = transport;
    this.#resolve = resolveSecret;
  }
  get available() { return Boolean(this.#transport && this.#resolve); }
  async #send(context, service, request, reserve, beforeSend = () => {}) {
    if (!this.available) fail('TRANSPORT_NOT_CONFIGURED');
    // Authorization and quota reservation occur before obtaining any credential.
    reserve(service, true);
    let credential;
    let response;
    try {
      try {
        credential = await this.#resolve(context.secretRef, {
          companyId: context.companyId, connectionId: context.connectionId,
          accountId: context.accountId, principalId: context.principalId, service });
      } catch { fail('CREDENTIAL_UNAVAILABLE'); }
      if (typeof credential !== 'string' || !credential.length) fail('CREDENTIAL_UNAVAILABLE');
      reserve(service, false);
      beforeSend(); // Recheck lease/approval after any asynchronous secret resolution.
      try {
        response = await this.#transport({ ...request, service,
          headers: { ...(request.headers || {}), Authorization: `${service === 'metrika' ? 'OAuth' : 'Bearer'} ${credential}` } });
      } catch { fail('TRANSPORT_FAILED'); } // Raw errors may contain credentials.
    } finally { credential = undefined; }
    if (!response || !Number.isInteger(response.status)) fail('INVALID_RESPONSE');
    if ([401, 403].includes(response.status)) fail('ACCESS_REVOKED');
    if (response.status === 429) fail('QUOTA_EXCEEDED');
    if (response.status !== 200) fail('API_RESPONSE_FAILED');
    const body = losslessParse(response.body);
    if (!body || typeof body !== 'object' || body.error || body.errors) fail('API_RESPONSE_FAILED');
    return body;
  }
  async #direct(context, service, method, params, reserve, beforeSend) {
    return this.#send(context, 'direct', {
      url: `https://api.direct.yandex.com/json/v501/${service}`, method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Accept-Language': 'ru',
        'Client-Login': context.clientLogin }, body: directJson({ method, params }) }, reserve, beforeSend);
  }
  async readObjects(context, selection, reserve) {
    const campaignIds = ids(selection.campaignIds);
    const adIds = ids(selection.adIds);
    if (!campaignIds.length || !adIds.length) fail('EMPTY_SELECTION');
    const campaigns = await this.#direct(context, 'campaigns', 'get', {
      SelectionCriteria: { Ids: campaignIds }, FieldNames: ['Id', 'Name', 'Status', 'State', 'Type', 'Currency'] }, reserve);
    const ads = await this.#direct(context, 'ads', 'get', {
      SelectionCriteria: { Ids: adIds, CampaignIds: campaignIds },
      FieldNames: ['Id', 'CampaignId', 'AdGroupId', 'Type', 'Status', 'State'],
      ResponsiveAdFieldNames: [...RESPONSIVE_FIELDS] }, reserve);
    if (campaigns.result?.LimitedBy !== undefined || ads.result?.LimitedBy !== undefined) fail('INCOMPLETE_RESPONSE');
    const campaignRows = campaigns.result?.Campaigns;
    const adRows = ads.result?.Ads;
    if (!Array.isArray(campaignRows) || !Array.isArray(adRows)) fail('INVALID_RESPONSE');
    const normalizedCampaigns = campaignRows.map((row) => ({ Id: id(row.Id),
      Status: text(row.Status), State: text(row.State), Type: text(row.Type), Currency: text(row.Currency) }));
    const normalizedAds = adRows.map(normalizedAd);
    const sameIds = (rows, wanted) => hash(rows.map((row) => row.Id).sort()) === hash(wanted);
    if (!sameIds(normalizedCampaigns, campaignIds) || !sameIds(normalizedAds, adIds) ||
        normalizedAds.some((ad) => !campaignIds.includes(ad.CampaignId))) fail('RESPONSE_SCOPE_MISMATCH');
    return { campaigns: normalizedCampaigns, ads: normalizedAds };
  }
  async updateResponsive(context, adId, patch, reserve, beforeSend) {
    const body = await this.#direct(context, 'ads', 'update', {
      Ads: [{ Id: id(adId), ResponsiveAd: clone(patch) }] }, reserve, beforeSend);
    const results = body.result?.UpdateResults;
    if (!Array.isArray(results) || results.length !== 1 || results[0].Errors?.length || id(results[0].Id) !== adId) fail('WRITE_UNCONFIRMED');
    return { confirmed: true };
  }
  async report(context, { counterId, range }, reserve) {
    counterId = id(counterId);
    range = period(range);
    const offset = { UTC: '+00:00', 'Europe/Moscow': '+03:00', 'Asia/Bangkok': '+07:00' }[range.timezone];
    if (!offset) fail('REPORT_TIMEZONE_UNSUPPORTED');
    const query = new URLSearchParams({ ids: counterId, date1: range.from, date2: range.to,
      dimensions: 'ym:s:date', metrics: 'ym:s:visits,ym:s:users', limit: '100000', accuracy: 'full', timezone: offset });
    const body = await this.#send(context, 'metrika', {
      url: `https://api-metrika.yandex.net/stat/v1/data?${query}`, method: 'GET' }, reserve);
    if (!Array.isArray(body.data) || !Array.isArray(body.totals) ||
        !Number.isInteger(body.total_rows) || body.total_rows > body.data.length) fail('INCOMPLETE_REPORT');
    // Return a minimal aggregate projection, never arbitrary response keys or URLs.
    const numbers = (values) => {
      if (!Array.isArray(values) || values.length !== 2 || values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) fail('INVALID_REPORT');
      return values;
    };
    return { counterId, range, totals: numbers(body.totals),
      rows: body.data.map((row) => {
        const date = text(row.dimensions?.[0]?.name, 10);
        if (!/^\d{4}-\d\d-\d\d$/.test(date) || date < range.from || date > range.to) fail('INVALID_REPORT_DATE');
        return { date, metrics: numbers(row.metrics) };
      }),
      sampled: typeof body.sampled === 'boolean' ? body.sampled : null,
      sampleShare: typeof body.sample_share === 'number' && body.sample_share >= 0 && body.sample_share <= 1 ? body.sample_share : null,
      dataLagSeconds: Number.isSafeInteger(body.data_lag) && body.data_lag >= 0 ? body.data_lag : null };
  }
}

module.exports = { YandexAdapters, normalizedAd, validatePatch, RESPONSIVE_FIELDS };
