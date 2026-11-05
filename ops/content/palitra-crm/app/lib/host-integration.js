'use strict';
/*
 * Palitra — единая точка подключения к СУЩЕСТВУЮЩЕМУ серверу Synapse (host).
 *
 * Связывает: проверку входа и прав (crm-access), обращения/заказы (workspace), защищённый HTTP (crm-http),
 * резервную почту (email-fallback + email-transport), приём Telegram (telegram-ingest) и Instagram (instagram-hook).
 * Модуль НИЧЕГО не запускает сам: не слушает порт, не делает polling/getUpdates и setWebhook, не отправляет
 * сообщений, не читает переменные окружения и секреты, не выдаёт прав людям. Хост вызывает перечисленные hooks
 * из своих штатных обработчиков и планировщика. Всё пишется в ОДНОЙ SQLite хоста через ЕГО transact-функцию
 * (та же, что у действующего siteOrders; она должна допускать вложенный вызов).
 *
 * PRODUCTION-INTEGRATION 13.10.2026: HOST-ONLY функции хоста siteRole/siteStaff (сотрудник по сессии кабинета),
 * telegramBind/telegramRole (сотрудник по проверенной существующей привязке Telegram→аккаунт), hostOrders
 * (подтверждённая хостом принадлежность заказа) передаются в crm-access; principal проверенного покупателя
 * в submitPublicOrder (только для новой заявки) и ссылка staffEditorUrl на существующий редактор в bootstrap
 * только для сотрудника. Права редактора проверяет сам редактор; ссылка их не даёт.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createCrmAccess } = require('./crm-access');
const { createWorkspace } = require('./workspace');
const { createCrmHttp } = require('./crm-http');
const { createInquiryEmailFallback } = require('./email-fallback');
const { createInquiryEmailTransport } = require('./email-transport');
const { createInstagramHook } = require('./instagram-hook');
const { createTeamNotifier } = require('./team-notify');
const { createTeamTelegramTransport } = require('./telegram-team-transport');

const PUBLIC = path.join(__dirname, '..', 'public');
const TELEGRAM_ORIGINS = 'https://web.telegram.org https://webk.telegram.org https://webz.telegram.org';
const VERSION = 'palitra-crm-2026-10-10';
// Принципал покупателя сайта от хоста: provider='site' и тот же формат subject, что у crm-access.
const SITE_SUBJECT = /^[A-Za-z0-9_.:@-]{1,128}$/;
// Опубликовать можно только эти файлы. index.html (демо-переключатель ролей) и form-preview — НЕ публикуются.
const STATIC = {
  '/': { file: 'miniapp.html', type: 'text/html; charset=utf-8', csp: `default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${TELEGRAM_ORIGINS}` },
  '/site': { file: 'site.html', type: 'text/html; charset=utf-8', csp: "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'" },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/crm-session.js': { file: 'crm-session.js', type: 'text/javascript; charset=utf-8' }
};

function createPalitraCrm({
  db, transact, siteOrders, priceReader, botId, publicKeyHex, validateSiteSession = null, resolveSitePrincipal = null,
  allowedOrigins, clientIp, email = {}, teamNotify = {}, telegramIngest = null, instagram = null, now = Date.now,
  apiPrefix = '/api/crm', appPrefix = '/palitra-app', createTelegramIngest = null,
  siteRole = null, siteStaff = null, telegramBind = null, telegramRole = null, hostOrders = null, staffEditorUrl = null,
  publicDir = PUBLIC
} = {}) {
  if (!db || typeof transact !== 'function' || !siteOrders || typeof priceReader !== 'function') {
    throw new TypeError('Нужны SQLite, transact и siteOrders хоста и общий прайс');
  }
  if (apiPrefix !== '/api/crm') throw new TypeError('Приложение обращается к /api/crm; другой префикс не поддерживается');
  if (!/^\/[a-z0-9-]+$/.test(appPrefix)) throw new TypeError('Некорректный адрес приложения');
  if (typeof publicDir !== 'string' || !path.isAbsolute(publicDir)) throw new TypeError('Каталог файлов приложения должен быть абсолютным путём');
  let editorLink = null;
  if (staffEditorUrl !== null) {
    let parsed = null;
    try { parsed = new URL(staffEditorUrl); } catch { parsed = null; }
    if (!parsed || parsed.href !== staffEditorUrl || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new TypeError('Ссылка на редактор должна быть точным https-адресом без параметров');
    }
    editorLink = staffEditorUrl;
  }
  const access = createCrmAccess({ db, botId, ...(publicKeyHex ? { publicKeyHex } : {}), now, validateSiteSession,
    siteRole, siteStaff, telegramBind, telegramRole, hostOrders });
  let workspace = null;
  const sendEmail = email.transport ? createInquiryEmailTransport({ transport: email.transport, from: email.from, messageIdDomain: email.messageIdDomain }) : null;
  const fallback = createInquiryEmailFallback({ db, now, sendEmail, enabled: email.enabled === true,
    inquiryExists: (id) => workspace.inquiryExists(id), primaryJobs: (id) => workspace.primaryJobs(id) });

  // Основное уведомление команды о ручных и Instagram-обращениях: личное сообщение подтверждённому менеджеру
  // через существующий бот хоста. recipient (личный чат подтверждённого менеджера + версия привязки), botId этого бота
  // и callBotApi передаёт хост из своих проверенных настроек; без любого из них — выключено, квитанции строгие.
  const teamBotId = teamNotify.botId === undefined || teamNotify.botId === null ? null : teamNotify.botId;
  // recipient:'site_queue' — тот же подтверждённый менеджер, что у очереди заявок сайта: строка site_order_recipients
  // Palitra с verified_at (хост проверил получателя тестовым сообщением) и её version. Без проверки — не отправляем.
  const siteQueueRecipient = () => {
    try {
      const row = db.prepare("SELECT telegram_chat_id, version, verified_at FROM site_order_recipients WHERE site='palitra' AND company_code='palitra-love'").get();
      return row && row.verified_at ? { chatId: row.telegram_chat_id, version: row.version } : null;
    } catch { return null; }
  };
  const teamRecipient = teamNotify.recipient === 'site_queue' ? siteQueueRecipient : teamNotify.recipient || null;
  const team = createTeamNotifier({ db, now, enabled: teamNotify.enabled === true, recipient: teamRecipient, botId: teamBotId,
    sendTelegram: teamNotify.callBotApi && teamBotId !== null ? createTeamTelegramTransport({ callBotApi: teamNotify.callBotApi, botId: teamBotId }) : null,
    inquiryExists: (id) => workspace.inquiryExists(id) });

  // Telegram: модуль приёма живёт ТОЛЬКО в серверном коде; capability не уходит в HTTP.
  let ingest = null;
  if (telegramIngest) {
    const factory = createTelegramIngest || require('../../telegram-ingest/lib/telegram-ingest').createTelegramIngest;
    ingest = factory({ db, config: telegramIngest, now, transact });
  }
  const tgMeta = ingest ? { capability: ingest.ingress.capability } : null;
  const tgIdOf = (row) => { const m = /^tg:(\d{1,15})$/.exec(row.external_thread || ''); return m ? Number(m[1]) : null; };
  let ig = null;
  if (instagram) {
    ig = createInstagramHook({ db, config: instagram, transact, now, recordInquiry: (input) => workspace.recordExternalInquiry(input) });
  }

  const external = {
    telegramConnected: Boolean(ingest), instagramConnected: Boolean(ig),
    messages(row, actor) {
      if (row.origin === 'telegram_hook' && ingest && tgIdOf(row)) {
        // Удалённые клиентом сообщения показываются с отметкой: история не стирается автоматически.
        return ingest.crm.conversation(tgIdOf(row), actor).messages.map((m) => ({
          direction: m.direction, authorLabel: m.authorLabel || (m.direction === 'in' ? 'Клиент' : 'Palitra'), kind: m.kind,
          text: m.text, sentAt: m.sentAt, edited: Boolean(m.editedAt), deleted: Boolean(m.deletedAt), link: m.link || null }));
      }
      if (row.origin === 'instagram_hook' && ig) return ig.messages(row.external_thread);
      return null;
    },
    // Закрытие/оформление в CRM переносится в обращение приёма Telegram: следующее сообщение после закрытия — новое обращение.
    status(row, status, actor) {
      if (row.origin !== 'telegram_hook' || !ingest || !tgIdOf(row)) return;
      const snap = ingest.ingress.inquirySnapshot(tgIdOf(row), tgMeta);
      if (!snap) return;
      const target = status === 'closed' ? 'closed' : 'accepted';
      const allowed = { new: ['accepted', 'closed'], review: ['accepted', 'closed'], accepted: ['closed'] }[snap.status] || [];
      if (allowed.includes(target)) ingest.crm.decide(snap.id, target, actor);
    },
    // Основной канал для резервной почты: уведомление команды о сообщении Telegram, отмеченное хостом после доставки.
    primaryJobs(row) {
      if (row.origin === 'telegram_hook' && ingest && tgIdOf(row)) {
        const snap = ingest.ingress.inquirySnapshot(tgIdOf(row), tgMeta);
        if (!snap) return [];
        return [{ status: snap.notifyState === 'notified' ? 'sent' : 'pending', created_at: snap.createdAt, claimed_at: null }];
      }
      return [];
    }
  };

  workspace = createWorkspace({
    db, origin: allowedOrigins?.[0], now, mode: 'integration', siteOrders, transact, priceReader,
    canAccessOrder: (id, actor) => access.hasOrderAccess(id, actor),
    staffDirectory: () => access.staffMembers(),
    notifier: fallback,
    teamNotifier: team,
    // Доступ к заказу получает только тот проверенный аккаунт, который сам создал обращение (без сопоставления по контакту).
    onOrderCreated: ({ orderId, inquiry }) => {
      if (['telegram', 'site'].includes(inquiry.principal_provider)) {
        access.grantOrder({ provider: inquiry.principal_provider, subject: inquiry.principal_subject, orderId }, { id: 'verified-own-request' });
      }
    },
    external
  });
  // Ссылка на существующий редактор — только в bootstrap сотрудника; роль перечитана по выданной сессии.
  if (editorLink) {
    const baseBootstrap = workspace.bootstrap;
    workspace.bootstrap = (actor) => {
      const out = baseBootstrap(actor);
      return ['owner', 'admin'].includes(access.currentRole(actor)) ? { ...out, links: { editor: editorLink } } : out;
    };
  }
  const http = createCrmHttp({ db, access, workspace, fallback, allowedOrigins, prefix: apiPrefix, resolveSitePrincipal, clientIp });

  function serveStatic(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== appPrefix && !url.pathname.startsWith(`${appPrefix}/`)) return false;
    const route = url.pathname === appPrefix ? '/' : url.pathname.slice(appPrefix.length);
    const entry = Object.hasOwn(STATIC, route) ? STATIC[route] : null;
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    if (!entry || !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Не найдено'); return true;
    }
    if (url.pathname === appPrefix) { res.writeHead(308, { ...headers, Location: `${appPrefix}/` }); res.end(); return true; }
    const content = fs.readFileSync(path.join(publicDir, entry.file));
    res.writeHead(200, { ...headers, 'Content-Type': entry.type, ...(entry.csp ? { 'Content-Security-Policy': entry.csp } : {}) });
    res.end(req.method === 'HEAD' ? undefined : content);
    return true;
  }

  return {
    version: VERSION,
    routes: Object.freeze({ api: `${apiPrefix}/*`, miniApp: `${appPrefix}/`, siteEntry: `${appPrefix}/site`,
      assets: Object.keys(STATIC).filter((k) => k !== '/' && k !== '/site').map((k) => `${appPrefix}${k}`) }),
    /** Подключить в общий router хоста ДО его 404. Возвращает true, если запрос обработан. */
    async handle(req, res) { if (await http.handle(req, res)) return true; return serveStatic(req, res); },
    /** Заменяет прямой вызов siteOrders.submit в существующем публичном маршруте формы/корзины сайта.
     *  Публичный ответ прежний; дополнительно в той же транзакции создаются обращение, заказ (для корзины) и задание резерва.
     *  principal — только проверенный хостом покупатель сайта ({provider:'site',subject}) или null (гость). Он закрепляется
     *  лишь за НОВОЙ заявкой (workspace.submitSite): повтор чужого requestId доступа не даёт. */
    submitPublicOrder({ body, origin, ip, principal = null }) {
      let verified = null;
      if (principal !== null) {
        if (!principal || typeof principal !== 'object' || principal.provider !== 'site' || typeof principal.subject !== 'string'
          || !SITE_SUBJECT.test(principal.subject) || Object.keys(principal).some((k) => !['provider', 'subject'].includes(k))) {
          throw new TypeError('Некорректный principal покупателя от хоста');
        }
        verified = Object.freeze({ provider: 'site', subject: principal.subject });
      }
      return workspace.submitSite(body, { requestOrigin: origin, ip, principal: verified }).result;
    },
    telegram: ingest ? Object.freeze({
      /**
       * Один вход для полного update (с update_id). Режим задаёт telegramIngest.ingress:
       *  'webhook' — из действующего webhook ПОСЛЕ проверки X-Telegram-Bot-Api-Secret-Token: { webhookSecretVerified: true };
       *  'polling' — из существующего единственного getUpdates-диспетчера хоста: { polledByHost: true }.
       * Повтор того же update_id безопасен: не создаёт второго обращения и уведомления.
       */
      receive(update, verification = {}) {
        const meta = { ...tgMeta };
        if (verification && Object.hasOwn(verification, 'webhookSecretVerified')) meta.webhookSecretVerified = verification.webhookSecretVerified;
        if (verification && Object.hasOwn(verification, 'polledByHost')) meta.polledByHost = verification.polledByHost;
        return transact(() => {
          const outcome = ingest.ingress.receive(update, meta);
          if (outcome.status === 'stored' && outcome.inquiryId) {
            const snap = ingest.ingress.inquirySnapshot(outcome.inquiryId, tgMeta);
            // Анонимные отправители (без пользователя) остаются в разборе модуля приёма и не становятся клиентами.
            if (snap?.customerTgId && !snap.historical && ['new', 'review', 'accepted'].includes(snap.status)) {
              const linked = workspace.recordExternalInquiry({ source: 'telegram', thread: `tg:${snap.id}`,
                customer: { id: snap.customerTgId, name: snap.customerName }, summary: snap.summary, sourceLink: snap.postLink });
              return { ...outcome, crmInquiryId: linked.inquiryId, crmCreated: linked.created };
            }
          }
          return outcome;
        });
      },
      pendingNotifications: (limit) => ingest.ingress.pendingNotifications(tgMeta, limit),
      /** Только после подтверждённой доставки уведомления команде штатным транспортом хоста. */
      markNotified: (inquiryId) => ingest.ingress.markNotified(inquiryId, tgMeta)
    }) : null,
    instagram: ig ? Object.freeze({
      /** Вызывать в действующем webhook Meta ПОСЛЕ проверки X-Hub-Signature-256. */
      receive: (payload, { signatureVerified } = {}) => ig.receive(payload, { capability: ig.capability, signatureVerified })
    }) : null,
    /** Планировщик хоста: раз в 30–60 с. Письмо уходит только при включённой почте, адресе собственника и транспорте. */
    // Сначала основной канал (Telegram менеджеру), затем резервная почта по обращениям без квитанции.
    scheduler: Object.freeze({ async tick() { const telegram = await team.drain(); const email = await fallback.drain(); return { telegram, email, processed: telegram.processed + email.processed }; } }),
    /** Для внутренней проверки хоста (не публичный маршрут): без контактов, адресов и секретов. */
    health() {
      const count = (sql) => db.prepare(sql).get().n;
      return { ok: true, version: VERSION, email: fallback.availability(), teamTelegram: team.availability(), telegramIngest: Boolean(ingest),
        telegramIngress: ingest ? (telegramIngest.ingress === 'polling' ? 'polling' : 'webhook') : null, instagram: Boolean(ig),
        staffMembers: access.staffMembers().length,
        openInquiries: count("SELECT count(*) n FROM palitra_crm_inquiries WHERE status='open'"),
        activeOrders: count("SELECT count(*) n FROM palitra_crm_orders WHERE status='active'") };
    },
    /** SERVER-ONLY. Не подключать к HTTP: вызывает доверенный серверный код после проверки владельца ресурса. */
    admin: Object.freeze({
      setMembership: (input, by) => access.setMembership(input, by),
      grantOrder: (input, by) => access.grantOrder(input, by),
      revokeOrder: (input, by) => access.revokeOrder(input, by),
      issueClaim: (input, by) => access.issueClaim(input, by),
      attachExisting: (siteOrderId) => workspace.attachExisting(siteOrderId)
    })
  };
}

module.exports = { createPalitraCrm, VERSION, STATIC: Object.freeze(Object.fromEntries(Object.entries(STATIC).map(([k, v]) => [k, Object.freeze({ ...v })]))) };
