'use strict';

/* Доставка приглашения в подтверждённый личный канал (specs/085-safe-invitations).
   Одно задание — одна попытка. Перед отправкой заново проверяются: приглашение действует (не отозвано,
   не истекло, не принято), выдавший — действующий владелец, получатель подтверждён для этой компании,
   канал включён и отправитель совпадает. Подтверждение — только message_id от транспорта; неизвестный
   исход и истёкшая аренда — uncertain без повтора и без новой ссылки; payload с секретом стирается
   после любой попытки. Транспорт передаётся конфигурацией; в production он не задан (канал выключен). */

const LEASE_MS = 10 * 60 * 1000;

function createInvitationDelivery({ db, invitations, delivery, now = () => Date.now() }) {
  const stamp = (at = now()) => new Date(at).toISOString();
  const finish = (id, state, extra = {}) => db.prepare(`UPDATE invitations SET delivery=?, delivery_payload=NULL, claimed_at=NULL,
    delivery_message_id=COALESCE(?, delivery_message_id), delivery_error=?, delivered_at=? WHERE id=?`)
    .run(state, extra.messageId || null, extra.error || null, state === 'delivered' ? stamp() : null, id);

  function blocker(row) {
    if (!delivery || delivery.enabled !== true || !delivery.transport || !delivery.key) return 'channel_disabled';
    if (invitations.effectiveStatus(row) !== 'pending') return 'not_sent';
    if (!invitations.issuerAllowed(row.created_by)) return 'not_sent';
    const r = invitations.recipient(row.recipient_id);
    if (!invitations.recipientUsable(r, row.company_code) || !invitations.channelReady(r)) return 'recipient_unverified';
    return '';
  }

  async function tick() {
    // Истёкшая аренда: исход неизвестен — без повтора.
    for (const stale of db.prepare("SELECT id FROM invitations WHERE delivery='sending' AND claimed_at<?").all(stamp(now() - LEASE_MS))) {
      finish(stale.id, 'uncertain', { error: 'Нет подтверждения доставки; повтор не выполняется' });
      invitations.audit(stale.id, 'delivery_uncertain', 'system', { reason: 'lease' });
    }
    const row = db.prepare("SELECT * FROM invitations WHERE delivery='queued' ORDER BY id LIMIT 1").get();
    if (!row) return null;
    // Однократное взятие: только одно обновление queued → sending проходит.
    if (db.prepare("UPDATE invitations SET delivery='sending', claimed_at=? WHERE id=? AND delivery='queued'").run(stamp(), row.id).changes !== 1) return null;
    const stop = blocker(row);
    if (stop) { finish(row.id, stop); invitations.audit(row.id, 'delivery_blocked', 'system', { state: stop }); return { id: row.id, delivery: stop }; }
    const r = invitations.recipient(row.recipient_id);
    let secret;
    try { secret = invitations.unseal(row.delivery_payload); } catch { finish(row.id, 'failed', { error: 'payload' }); return { id: row.id, delivery: 'failed' }; }
    const link = `${delivery.acceptUrl}#invite=${secret}`;
    const text = `Приглашение в кабинет Synapse: ${row.display_name}, доступ к товарам и ценам ${row.company_code}. `
      + `Откройте ссылку и задайте свой пароль (действует 24 часа, один раз): ${link}`;
    let result;
    try {
      result = await delivery.transport.send({ channel: r.channel, senderId: r.sender_id, address: r.address, text });
    } catch (error) {
      const definite = error && error.definite === true;
      finish(row.id, definite ? 'failed' : 'uncertain', { error: definite ? 'Транспорт отказал' : 'Нет подтверждения доставки; повтор не выполняется' });
      invitations.audit(row.id, definite ? 'delivery_failed' : 'delivery_uncertain', 'system');
      return { id: row.id, delivery: definite ? 'failed' : 'uncertain' };
    }
    const messageId = result && /^[1-9]\d{0,19}$/.test(String(result.messageId)) && String(result.address ?? r.address) === r.address ? String(result.messageId) : '';
    finish(row.id, messageId ? 'delivered' : 'uncertain', messageId ? { messageId } : { error: 'Нет подтверждения доставки; повтор не выполняется' });
    invitations.audit(row.id, messageId ? 'delivered' : 'delivery_uncertain', 'system', messageId ? { messageId } : {});
    return { id: row.id, delivery: messageId ? 'delivered' : 'uncertain' };
  }
  return { tick };
}

module.exports = { createInvitationDelivery, LEASE_MS };
