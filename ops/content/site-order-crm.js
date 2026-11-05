'use strict';

/* Передача заказов с сайта в CRM как заявок компании сайта.
   Заказ сохраняется и получает отметку crm_status='pending' в той же транзакции (site-orders.js);
   сама передача идёт отдельно и повторяется, пока CRM не подтвердит. Отказ или недоступность CRM
   не влияет на оформление заказа. Повтор безопасен: CRM узнаёт заказ по ключу
   «site-order:<сайт>:<номер>» и не создаёт вторую заявку, поэтому неизвестный исход сети повторяется.
   Компания берётся из сохранённого заказа и сверяется с конфигурацией сайта на сервере; расхождение —
   остановка без отправки. Служебный ключ CRM в журналы и ответы не попадает. */

const BATCH = 10;
const BASE_DELAY = 30 * 1000;
const MAX_DELAY = 60 * 60 * 1000;
/* Предел повторов: 7 суток с оформления заказа или 48 попыток — затем crm_status='error' (счётчик в кабинете). */
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 48;
const CONTACT_CHANNELS = Object.freeze({ phone: 'Звонок', telegram: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX' });
const COLUMNS = Object.freeze({
  crm_status: "TEXT NOT NULL DEFAULT ''", crm_attempts: 'INTEGER NOT NULL DEFAULT 0', crm_next_attempt_at: 'TEXT',
  crm_lead_id: 'INTEGER', crm_error: "TEXT NOT NULL DEFAULT ''", crm_synced_at: 'TEXT',
});

/* Обратимая миграция. Прежние заказы получают пустой статус: автоматически в CRM не уходят. */
function migrateSiteOrderCrm(db) {
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('site_orders')").all().map((row) => row.name));
  for (const [name, type] of Object.entries(COLUMNS)) if (!columns.has(name)) db.exec(`ALTER TABLE site_orders ADD COLUMN ${name} ${type}`);
  db.exec("CREATE INDEX IF NOT EXISTS site_orders_crm_pending ON site_orders(crm_status, crm_next_attempt_at) WHERE crm_status='pending'");
}
function revertSiteOrderCrm(db) {
  db.exec('DROP INDEX IF EXISTS site_orders_crm_pending');
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('site_orders')").all().map((row) => row.name));
  for (const name of Object.keys(COLUMNS)) if (columns.has(name)) db.exec(`ALTER TABLE site_orders DROP COLUMN ${name}`);
}

const formatRub = (kopecks) => {
  const rub = Math.floor(kopecks / 100), rest = kopecks % 100;
  return `${rub.toLocaleString('ru-RU')}${rest ? `,${String(rest).padStart(2, '0')}` : ''} ₽`;
};
const clip = (value, max) => String(value ?? '').slice(0, max);

/* Заявка CRM из сохранённого заказа: только то, что уже принято и проверено при оформлении. */
function leadPayload(order, config) {
  const items = JSON.parse(order.items_json || '[]');
  const utm = JSON.parse(order.utm_json || '{}');
  const cart = order.kind === 'cart';
  const lines = [`Заказ №${order.id} с сайта ${config.title} (${cart ? 'корзина' : 'форма без корзины'})`];
  if (items.length) {
    lines.push(`Состав: ${items.map((item) => `${item.title} × ${item.qty}`).join('; ')}`);
    lines.push(`Сумма по известным ценам: ${formatRub(order.known_total)}${order.unknown_count ? ` (ещё ${order.unknown_count} поз. уточняются)` : ''}`);
  }
  if (order.contact_channel) lines.push(`Связаться через: ${CONTACT_CHANNELS[order.contact_channel] || order.contact_channel}`);
  if (order.phone && order.phone !== order.contact) lines.push(`Телефон: ${order.phone}`);
  const delivery = [order.delivery_address, order.delivery_date, order.delivery_interval].filter(Boolean).join(', ');
  if (delivery) lines.push(`Доставка: ${delivery}`);
  if (order.comment) lines.push(`Комментарий клиента: ${order.comment}`);
  const channel = cart ? 'сайт · корзина' : 'сайт · форма';
  return {
    companyCode: order.company_code, externalRef: `site-order:${order.site}:${order.id}`,
    name: clip(order.name, 120), contact: clip(order.contact || order.phone, 120), channel,
    source: clip(utm.utm_source || channel, 120), page: order.page ? clip(order.page, 500) : undefined,
    comment: clip(lines.join('\n'), 4000), firstQuestion: order.comment ? clip(order.comment, 1000) : undefined,
    utmSource: utm.utm_source, utmMedium: utm.utm_medium, utmCampaign: utm.utm_campaign, utmContent: utm.utm_content, utmTerm: utm.utm_term,
  };
}

function createSiteOrderCrmSync({ db, sites = {}, crmUrl = '', apiKey = '', fetchImpl = globalThis.fetch, now = Date.now, intervalMs = 30000, timeoutMs = 10000 }) {
  // Колонки добавляет createSiteOrders (после создания site_orders); здесь схема не меняется.
  const base = String(crmUrl || '').replace(/\/$/, '');
  const configured = () => Boolean(base && apiKey);
  const stamp = (at = now()) => new Date(at).toISOString();
  const siteConfig = (site) => (Object.hasOwn(sites, site) ? sites[site] : null);
  let timer = null, running = null;

  const retry = (order, error) => {
    const attempts = order.crm_attempts + 1;
    const created = Date.parse(order.created_at);
    if (attempts >= MAX_ATTEMPTS || (Number.isFinite(created) && now() - created >= MAX_AGE)) return stop(order, `${error}; повторы исчерпаны`);
    const delay = Math.min(MAX_DELAY, BASE_DELAY * 2 ** Math.min(attempts - 1, 12));
    db.prepare("UPDATE site_orders SET crm_attempts=?, crm_next_attempt_at=?, crm_error=? WHERE id=? AND crm_status='pending'")
      .run(attempts, stamp(now() + delay), clip(error, 200), order.id);
  };
  const stop = (order, error) => db.prepare("UPDATE site_orders SET crm_status='error', crm_attempts=crm_attempts+1, crm_error=? WHERE id=? AND crm_status='pending'")
    .run(clip(error, 200), order.id);

  async function deliver(order) {
    const config = siteConfig(order.site);
    // Компания проверяется на сервере: заказ уходит только в CRM компании, за которой закреплён сайт.
    if (!config || !config.companyCode || config.companyCode !== order.company_code) return stop(order, 'Компания заказа не совпадает с сайтом');
    // Заявка собирается до сети: битая строка — ошибка подготовки (остановка), а не «CRM недоступна».
    const payload = JSON.stringify(leadPayload(order, config));
    let response;
    try {
      response = await fetchImpl(`${base}/internal/site-orders/lead`, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey }, body: payload,
        signal: AbortSignal.timeout(timeoutMs) });
    } catch { return retry(order, 'CRM недоступна'); }
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (response.ok && Number.isSafeInteger(data?.leadId) && String(data.companyCode || '').toLowerCase() === order.company_code.toLowerCase()) {
      db.prepare("UPDATE site_orders SET crm_status='sent', crm_lead_id=?, crm_synced_at=?, crm_error='', crm_attempts=crm_attempts+1 WHERE id=? AND crm_status='pending'")
        .run(data.leadId, stamp(), order.id);
      return;
    }
    // Компания ещё не заведена/не активна в CRM — повтор с паузой: после заведения заявка дойдёт.
    if (response.status === 409 && data?.details?.code === 'COMPANY_NOT_ACTIVE') return retry(order, 'Компания не найдена в CRM');
    // 400 и прочие 409 (заказ закреплён за другой компанией) — повтор того же не поможет.
    if (response.status === 400 || response.status === 409) return stop(order, `CRM отклонила заявку (${response.status})`);
    return retry(order, `CRM ответила ${response.status}`);
  }

  async function syncOnce() {
    if (!configured()) return { configured: false, processed: 0 };
    const rows = db.prepare(`SELECT * FROM site_orders WHERE crm_status='pending' AND (crm_next_attempt_at IS NULL OR crm_next_attempt_at<=?)
      ORDER BY id LIMIT ?`).all(stamp(), BATCH);
    for (const order of rows) {
      // Ошибка подготовки одной строки (битый items_json/utm_json) не блокирует очередь.
      try { await deliver(order); } catch (error) { stop(order, `Ошибка подготовки заявки: ${error?.message || error}`); }
    }
    return { configured: true, processed: rows.length };
  }
  /* Один проход за раз: параллельный вызов дожидается текущего. */
  function sync() {
    if (!running) running = syncOnce().finally(() => { running = null; });
    return running;
  }
  const kick = () => { void sync().catch(() => console.warn('content: передача заказов в CRM не выполнена; повтор позже')); };
  function start() {
    if (timer || !configured()) return false;
    timer = setInterval(kick, intervalMs); timer.unref?.();
    kick();
    return true;
  }
  async function stopSync() { if (timer) clearInterval(timer); timer = null; if (running) await running.catch(() => {}); }
  const status = (orderId) => {
    const row = db.prepare('SELECT crm_status,crm_attempts,crm_lead_id,crm_error,crm_synced_at FROM site_orders WHERE id=?').get(orderId);
    return row ? { status: row.crm_status || 'not_queued', attempts: row.crm_attempts, leadId: row.crm_lead_id, error: row.crm_error, syncedAt: row.crm_synced_at } : null;
  };
  return { sync, kick, start, stop: stopSync, status, configured };
}

module.exports = { createSiteOrderCrmSync, migrateSiteOrderCrm, revertSiteOrderCrm, leadPayload, MAX_AGE, MAX_ATTEMPTS };
