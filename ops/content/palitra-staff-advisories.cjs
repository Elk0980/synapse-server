'use strict';
// Read-only current advice. Never a customer message, send receipt, timer or mutation.
const REQUIREMENTS = Object.freeze({ contact_confirmed: 'связаться с клиентом', details_confirmed: 'согласовать детали заказа', payment_confirmed: 'подтвердить оплату', photo_sent: 'отправить фото клиенту', handover_confirmed: 'подтвердить передачу заказа', feedback_requested: 'предложить оставить отзыв' });
const stamp = value => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function contactOf(channel, value) {
  if (!['phone', 'telegram', 'whatsapp', 'max'].includes(channel) || typeof value !== 'string' || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) return null;
  value = value.trim();
  if (!value) return null;
  if (channel === 'phone' || channel === 'whatsapp') {
    if (!/^[+\d\s().-]+$/.test(value)) return null;
    let digits = value.replace(/\D/g, '');
    if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
    if (!/^\d{10,15}$/.test(digits)) return null;
    value = '+' + digits;
  } else if (channel === 'telegram' && !/^(?:@|(?:https:\/\/)?t\.me\/)?[a-zA-Z][a-zA-Z0-9_]{4,31}\/?$/.test(value) && !/^\+?\d{10,15}$/.test(value)) return null;
  return { kind: 'contact', channel, value };
}
function createStaffAdvisories({ db, followup, workflowOrder }) {
  if (!db || typeof followup !== 'function' || typeof workflowOrder !== 'function') throw new TypeError('Existing staff readers required');
  const orderSql = `SELECT o.id,o.created_at,o.contact_channel,o.contact,w.status AS work_status
    FROM site_orders o JOIN chat_threads t ON t.order_id=o.id
    LEFT JOIN site_order_work w ON w.order_id=o.id
    WHERE t.id=? AND t.site='palitra' AND t.company_code='palitra-love'
      AND o.id=? AND o.site='palitra' AND o.company_code='palitra-love'`;
  return function read({ owner, threads }) {
    const items = [];
    const orderRow = db.prepare(orderSql);
    for (const thread of threads) {
      if (thread.orderId === null) continue;
      const order = orderRow.get(thread.id, thread.orderId);
      if (!order || ['done', 'cancelled'].includes(order.work_status)) continue;
      const createdAt = stamp(order.created_at);
      if (!createdAt) continue;
      const work = workflowOrder(owner, order.id);
      if (!work || work.orderRef !== 'native-order:' + order.id || work.cancelled || work.terminal) continue;
      const base = { threadId: thread.id, orderId: order.id, author: 'hugh', audience: 'staff', state: 'current' };
      const actions = [{ kind: 'order', ref: 'native-order:' + order.id }];
      const contact = contactOf(order.contact_channel, order.contact);
      const f = followup('palitra', order.id, owner);
      const contacted = Array.isArray(work.confirmations) && work.confirmations.some(c => c?.requirement === 'contact_confirmed');
      if (!contacted && f?.state === 'due' && f.orderRef === 'native-order:' + order.id && f.threadRef === 'thread:' + thread.id && stamp(f.dueAt)) {
        items.push({ ...base, key: `contact-followup:thread:${thread.id}:order:${order.id}:due:${Date.parse(f.dueAt)}`, kind: 'contact-followup',
          text: contact?.channel === 'phone' ? 'После оформления заявки клиент ещё не написал в чат. Позвоните клиенту по телефону из заявки.' : 'После оформления заявки клиент ещё не написал в чат. Свяжитесь удобным для него способом.',
          basisAt: stamp(f.dueAt), basis: 'due-at', actions: [...actions, ...(contact ? [contact] : [])] });
      }
      const stage = Array.isArray(work.stages) && work.stages.find(s => s.id === work.currentStageId);
      if (!stage || typeof stage.id !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(stage.id) || typeof stage.label !== 'string' || !Number.isSafeInteger(work.revision)) continue;
      const entered = Array.isArray(work.history) ? [...work.history].reverse().find(e => e?.action === 'advance' && e.nextStageId === stage.id && stamp(e.at)) : null;
      const missing = Array.isArray(work.missing) ? work.missing.filter(r => Object.hasOwn(REQUIREMENTS, r)).map(r => REQUIREMENTS[r]) : [];
      const hint = typeof stage.hint === 'string' ? stage.hint.trim().slice(0, 500) : '';
      items.push({ ...base, key: `workflow:thread:${thread.id}:order:${order.id}:stage:${stage.id}:revision:${work.revision}`, kind: 'workflow',
        text: `Этап «${stage.label.slice(0, 100)}».${hint ? ' ' + hint : ''}${missing.length ? '\nОсталось: ' + missing.join('; ') + '.' : ''}`,
        basisAt: entered ? stamp(entered.at) : createdAt, basis: entered ? 'stage-entered' : 'order-created',
        actions: [...actions, ...(contact && missing.includes(REQUIREMENTS.contact_confirmed) ? [contact] : [])] });
    }
    return items;
  };
}
module.exports = { createStaffAdvisories, contactOf };
