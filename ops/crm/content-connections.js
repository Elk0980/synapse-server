'use strict';
/* Контент → Подключения. Только чтение уже сохранённого: никаких запросов к площадкам,
   ключи не расшифровываются и наружу не выходят — отдаётся лишь «ключ есть / нет».
   Статус считается по факту: 🟢 green — свежие данные из автоматического источника;
   🟡 yellow — есть настройка, ссылка подключения, ручные/старые данные или подтверждение владельца;
   🔴 red — ничего из этого нет. Ссылки — только типизированные из CRM (companyPublicLinks). */
const { companyPublicLinks } = require('./company-links');
const { createMetrikaSiteProbe } = require('./metrika-site-probe');
/* Подтверждения владельца («подключено вне ЛК», напр. Метрика) — состояние клиента, в публичный
   репозиторий не пишется: приходит из приватной настройки сервера CONTENT_CONNECTIONS_DECLARED (JSON
   {"<компания>": {"metrika": {"by": "…", "date": "ГГГГ-ММ-ДД"}}}). Ошибка формата — пустой список. */
function declaredFromEnv(raw) {
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

const AUTO = new Set(['onlypult', 'direct']);
/* id → подпись, тип ссылки CRM, площадка social_*, канал автопостинга, коды external_stats. */
const PLATFORMS = Object.freeze([
  { id: 'instagram', label: 'Instagram', social: 'instagram', channel: 'instagram' },
  { id: 'tiktok', label: 'TikTok', social: 'tiktok', channel: 'tiktok' },
  { id: 'youtube', label: 'YouTube', social: 'youtube', channel: 'youtube_shorts' },
  { id: 'vk', label: 'ВКонтакте', link: 'vk', social: 'vk', channel: 'vk', external: ['vk', 'vk-ads'] },
  { id: 'telegram_channel', label: 'Telegram-канал', link: 'telegram_channel', social: 'telegram', channel: 'telegram' },
  { id: 'telegram_bot', label: 'Telegram-бот', link: 'telegram', leads: ['telegram', 'telegram-bot', 'telegram_bot'] },
  { id: 'max', label: 'MAX', link: 'max', channel: 'max', external: ['max'] },
  { id: 'two_gis', label: '2ГИС', link: 'two_gis', external: ['2gis'], gisReports: true },
  { id: 'yandex_maps', label: 'Яндекс Карты', link: 'yandex_maps', external: ['yandex-maps'] },
  /* marker — серверный признак работы: строки источника за 7 дн. дают 🟢, старее — 🟡. */
  { id: 'yandex_direct', label: 'Яндекс Директ', marker: true, paidYandex: true, external: ['yandex-direct', 'yandex-rsya', 'yandex-master', 'yandex-product', 'yandex-display', 'yandex-business'] },
  { id: 'metrika', label: 'Яндекс Метрика', marker: true, external: ['metrika', 'yandex-metrika'], siteCounter: true },
  { id: 'yclients', label: 'YCLIENTS', link: 'booking' },
  { id: 'website', label: 'Сайт', link: 'website', events: true },
]);
const NEEDS = Object.freeze({
  instagram: 'Профиль Instagram в Onlypult (публикация) и аналитический профиль Onlypult для статистики.',
  tiktok: 'Профиль TikTok в Onlypult (публикация) и аналитический профиль Onlypult для статистики.',
  youtube: 'Канал YouTube в Onlypult (публикация) и аналитический профиль для статистики.',
  vk: 'Ключ сообщества ВКонтакте (Контент → Соцсети ВК) и аккаунт в «Соцсети» для ежедневного сбора.',
  telegram_channel: 'Бот-администратор канала (токен) в настройках постинга и аккаунт канала в «Соцсети».',
  telegram_bot: 'Бот для записи должен передавать заявки в CRM (канал telegram).',
  max: 'Профиль MAX в Onlypult; сбор статистики MAX в ЛК пока не реализован.',
  two_gis: 'Настройки 2ГИС в «Спросе площадок» и загрузка официальной выгрузки кабинета.',
  yandex_maps: 'Снимки показателей Яндекс Карт (ручной ввод) — автоматического сбора нет.',
  yandex_direct: 'Доступ к API Директа (ждёт Влада) — до этого только ручные снимки расходов.',
  metrika: 'Доступ к API Метрики (ждёт Влада) — до этого данные в ЛК не приходят.',
  yclients: 'Интеграции YCLIENTS в ЛК нет: нужен ключ API YCLIENTS (ждёт Влада).',
  website: 'Ссылка на сайт в CRM и счётчик ЛК (track.js) на страницах сайта.',
});

const MARKER_DAYS = 7;
/* Платные переходы Яндекса на сайт: utm_source Яндекса с платным utm_medium или yclid в адресе входа. */
const PAID_YANDEX = "(lower(utm_source) IN ('yandex','yandex-direct','yandex_direct','direct.yandex','ya-direct') AND lower(utm_medium) IN ('cpc','ppc','paid','cpm','cpa')) OR landing_page LIKE '%yclid=%' OR page LIKE '%yclid=%'";

function createContentConnections(db, { now = () => Date.now(), declared = {}, siteProbe = null } = {}) {
  const tables = () => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

  async function list(code, { days = 14 } = {}) {
    if (typeof code !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code)) throw Object.assign(Error('Выберите компанию'), { status: 400 });
    if (!Number.isInteger(days) || days < 1 || days > 90) throw Object.assign(Error('Период — от 1 до 90 дней'), { status: 400 });
    const company = db.prepare('SELECT * FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(code);
    if (!company) throw Object.assign(Error('Компания не найдена'), { status: 404 });
    const cc = company.code, has = tables(), since = isoDay(now() - (days - 1) * 86400000), markerSince = isoDay(now() - (MARKER_DAYS - 1) * 86400000);
    const all = (sql, ...args) => db.prepare(sql).all(cc, ...args);
    const one = (sql, ...args) => db.prepare(sql).get(cc, ...args);
    const links = companyPublicLinks({ code: cc, website_url: company.website_url, socials: company.socials }).links;
    const ownDeclared = Object.entries(declared || {}).find(([key]) => key.toLowerCase() === cc.toLowerCase())?.[1] || {};

    const platforms = [];
    for (const p of PLATFORMS) {
      const facts = [], settings = {};
      let lastAuto = '', lastManual = '', lastAny = '';
      const seen = (date, auto) => { if (!date) return; if (date > lastAny) lastAny = date; if (auto && date > lastAuto) lastAuto = date; if (!auto && date > lastManual) lastManual = date; };
      if (p.social && has.has('social_snapshots')) {
        for (const r of all('SELECT provider, MAX(date) d FROM social_snapshots WHERE company_code=? COLLATE NOCASE AND platform=? AND value IS NOT NULL GROUP BY provider', p.social)) seen(r.d, AUTO.has(r.provider));
      }
      if (p.social && has.has('social_accounts')) {
        const a = one('SELECT account_ref, provider, enabled FROM social_accounts WHERE company_code=? COLLATE NOCASE AND platform=?', p.social);
        settings.statsAccount = Boolean(a && a.account_ref);
        if (settings.statsAccount) facts.push(`Аккаунт для статистики указан (${a.provider === 'manual' ? 'ручной ввод' : a.provider === 'onlypult' ? 'Onlypult' : 'прямой API'}).`);
      }
      if (p.channel && has.has('autoposting_channels')) {
        const c = one("SELECT provider, status, revision, checked_revision, encrypted_token <> '' AS token FROM autoposting_channels WHERE company_code=? COLLATE NOCASE AND id=?", p.channel);
        settings.publishing = c ? { provider: c.provider || 'direct', key: Boolean(c.token), connected: Boolean(c.token && c.status === 'connected' && c.checked_revision === c.revision) } : null;
        if (c) facts.push(`Постинг: ${c.provider === 'onlypult' ? 'Onlypult' : 'напрямую'}, ключ ${c.token ? 'есть' : 'нет'}, ${settings.publishing.connected ? 'проверен' : 'не проверен'}.`);
      }
      if (p.id === 'vk' && has.has('vk_community_connections')) {
        const v = one("SELECT status, encrypted_token <> '' AS token FROM vk_community_connections WHERE company_code=? COLLATE NOCASE", );
        settings.community = v ? { key: Boolean(v.token), status: v.status } : null;
        if (v) facts.push(`Сообщество ВК: ключ ${v.token ? 'есть' : 'нет'}.`);
      }
      if (p.external && has.has('external_stats')) {
        const r = db.prepare(`SELECT MAX(date) d FROM external_stats WHERE company_code=? COLLATE NOCASE AND source IN (${p.external.map(() => '?').join(',')})`).get(cc, ...p.external);
        if (r?.d) { seen(r.d, Boolean(p.marker)); facts.push(`${p.marker ? 'Данные площадки в ЛК' : 'Ручные снимки показателей'}: последние за ${r.d}.`); }
      }
      if (p.paidYandex && has.has('events')) {
        const r = one(`SELECT MAX(substr(created_at,1,10)) d, COUNT(*) n FROM events WHERE company_code=? COLLATE NOCASE AND type='visit' AND (${PAID_YANDEX})`);
        if (r?.d) { seen(r.d, true); facts.push(`Визиты на сайт с рекламы Яндекса (метки cpc/yclid): ${r.n}, последний ${r.d}.`); }
      }
      if (p.gisReports && has.has('platform_company_metric_values')) {
        const r = one('SELECT MAX(date) d FROM platform_company_metric_values WHERE company_code=? COLLATE NOCASE AND superseded_by IS NULL');
        if (r?.d) { seen(r.d, false); facts.push(`Выгрузка кабинета 2ГИС: данные по ${r.d}.`); }
      }
      if (p.leads && has.has('leads')) {
        const r = db.prepare(`SELECT MAX(substr(created_at,1,10)) d, COUNT(*) n FROM leads WHERE company_code=? COLLATE NOCASE AND (lower(channel) IN (${p.leads.map(() => '?').join(',')}) OR lower(source) IN (${p.leads.map(() => '?').join(',')}))`).get(cc, ...p.leads, ...p.leads);
        if (r?.d) { seen(r.d, true); facts.push(`Заявок из Telegram в CRM: ${r.n}, последняя ${r.d}.`); }
      }
      if (p.events && has.has('events')) {
        const r = one('SELECT MAX(substr(created_at,1,10)) d FROM events WHERE company_code=? COLLATE NOCASE');
        if (r?.d) { seen(r.d, true); facts.push(`Счётчик ЛК на сайте: последнее событие ${r.d}.`); }
      }
      const link = p.link ? links[p.link] || null : null;
      if (p.id === 'yclients' && link && !/(^|\.)yclients\.com$/i.test(new URL(link).hostname)) settings.bookingIsNotYclients = true;
      const decl = ownDeclared[p.id] && typeof ownDeclared[p.id] === 'object' ? ownDeclared[p.id] : null;
      if (decl) facts.push(`Подключено со слов владельца (${decl.by || 'владелец'}, ${decl.date || 'дата не указана'}).`);
      let counter = null;
      if (p.siteCounter && !lastAny && links.website && siteProbe) {
        counter = await siteProbe.probe(links.website).catch(() => null);
        settings.siteCounter = counter ? { found: Boolean(counter.counterId), counterId: counter.counterId || null, checked: Boolean(counter.checked) } : null;
        if (counter?.counterId) facts.push(`Счётчик Метрики ${counter.counterId} найден в коде сайта ${links.website}.`);
        else if (counter?.checked) facts.push(`Счётчик Метрики в коде сайта ${links.website} не найден.`);
        else if (counter) facts.push(`Сайт не проверен: ${counter.reason || 'нет ответа'}.`);
      }
      const configured = Boolean(settings.statsAccount || settings.publishing || settings.community || decl || counter?.counterId);
      let status, text;
      if (p.marker && lastAuto && lastAuto >= markerSince) { status = 'green'; text = 'Подключено, данные приходят'; }
      else if (p.marker && lastAny) { status = 'yellow'; text = `Данных за ${MARKER_DAYS} дн. нет (последние ${lastAny})`; }
      else if (counter?.counterId) { status = 'yellow'; text = 'Подключено вне ЛК, не проверено системой'; }
      else if (lastAuto && lastAuto >= since) { status = 'green'; text = 'Подключено, данные приходят'; }
      else if (lastManual && lastManual >= since) { status = 'yellow'; text = 'Данные только ручным вводом'; }
      else if (configured || lastAny) {
        status = 'yellow';
        text = decl && !lastAny ? 'Подключено, данные в ЛК ещё не приходят' : lastAny ? `Данных за ${days} дн. нет (последние ${lastAny})` : 'Настроено, данных нет';
      } else if (p.id === 'website' && link) { status = 'yellow'; text = 'Сайт есть, счётчик ЛК не присылает данные'; }
      else { status = 'red'; text = link ? 'Не подключено (в CRM есть только ссылка)' : 'Не подключено'; }
      platforms.push({ id: p.id, label: p.label, status, statusText: text, lastDataDate: lastAny || null,
        dataMode: lastAuto ? 'live' : lastManual ? 'manual' : 'none', link, settings, facts,
        next: status === 'green' ? '' : NEEDS[p.id] });
    }
    return { companyCode: cc.toLowerCase(), days, since, checkedAt: new Date(now()).toISOString(), platforms,
      note: 'Статус считается по сохранённым настройкам и данным ЛК. Ключи не показываются — только «есть / нет».' };
  }
  return { list, PLATFORMS };
}

/* GET /content-connections?companyCode=…&days=… — право autoposting.view ИЛИ analytics.view в своей компании. */
function createContentConnectionsHandler({ connections, companyModuleContext, send }) {
  return async function handle(request, response, url, cors = {}) {
    if (url.pathname !== '/content-connections') return false;
    const headers = { ...cors, 'cache-control': 'no-store' };
    if (request.method !== 'GET') { send(response, 405, { error: 'Метод не поддерживается.', code: 'METHOD_NOT_ALLOWED' }, headers); return true; }
    const code = url.searchParams.get('companyCode');
    try { companyModuleContext(request, code, 'autoposting.view'); }
    catch (error) { if (error?.status !== 403) throw error; companyModuleContext(request, code, 'analytics.view'); }
    const days = url.searchParams.has('days') ? Number(url.searchParams.get('days')) : 14;
    try { send(response, 200, await connections.list(code, { days }), headers); }
    catch (error) { if (!error.status) throw error; send(response, error.status, { error: error.message }, headers); }
    return true;
  };
}

module.exports = { createContentConnections, createContentConnectionsHandler, declaredFromEnv, createMetrikaSiteProbe, PLATFORMS };
