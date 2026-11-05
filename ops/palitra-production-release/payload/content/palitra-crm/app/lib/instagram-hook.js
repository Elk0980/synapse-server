'use strict';
/*
 * Instagram Direct → обращения Palitra внутри СУЩЕСТВУЮЩЕГО webhook хоста (Meta Messenger Platform для Instagram).
 * Хост сам проверяет подпись X-Hub-Signature-256 секретом приложения и verify token подписки; сюда передаётся уже
 * проверенное событие и флаг signatureVerified. Модуль не делает запросов к Graph API, не отправляет ответов,
 * не читает секреты и не сохраняет username/фото профиля: только IGSID (идентификатор в рамках аккаунта) и текст.
 * Конфигурация fail-closed: принимаются только явно перечисленные Instagram-аккаунты Palitra.
 */
const MAX_ENTRIES = 50;
const MAX_EVENTS = 100;
const MAX_TEXT = 4096;
const ID = /^\d{1,24}$/;
const MID = /^[A-Za-z0-9_=+/:.-]{1,256}$/;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function createInstagramHook({ db, config, recordInquiry, transact = null, now = Date.now } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('Требуется SQLite');
  if (typeof recordInquiry !== 'function') throw new TypeError('Требуется запись обращения');
  if (!plain(config) || !Array.isArray(config.accountIds)) throw new TypeError('Требуется конфигурация Instagram-аккаунтов');
  const accounts = new Set(config.accountIds.map((id) => { const v = String(id); if (!ID.test(v)) throw new TypeError('Некорректный ID аккаунта Instagram'); return v; }));
  const capability = Symbol('palitra.instagram-hook.host');
  db.exec(`CREATE TABLE IF NOT EXISTS ig_hook_messages (
    account_id TEXT NOT NULL, mid TEXT NOT NULL, sender_id TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('in','out')),
    kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', sent_at TEXT NOT NULL, inquiry_id INTEGER, received_at TEXT NOT NULL,
    PRIMARY KEY(account_id, mid)
  ); CREATE INDEX IF NOT EXISTS ig_hook_messages_thread ON ig_hook_messages(account_id, sender_id, sent_at);`);
  let savepoint = 0;
  const atomic = transact || ((fn) => {
    const name = `ig_hook_${++savepoint}`;
    db.exec(`SAVEPOINT ${name}`);
    try { const result = fn(); db.exec(`RELEASE ${name}`); return result; }
    catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
  });
  const stamp = (ms = now()) => new Date(ms).toISOString();

  /** Вызывать из существующего обработчика webhook ПОСЛЕ проверки подписи. Повтор доставки безопасен (дедупликация по mid). */
  function receive(payload, meta) {
    if (!plain(meta) || meta.capability !== capability) fail(403, 'Приём Instagram доступен только штатному обработчику хоста');
    if (meta.signatureVerified !== true) fail(403, 'Хост не подтвердил подпись webhook');
    const summary = { stored: 0, duplicate: 0, ignored: 0, rejected: 0, inquiries: [] };
    if (!plain(payload) || payload.object !== 'instagram' || !Array.isArray(payload.entry)) { summary.rejected++; return summary; }
    return atomic(() => {
      for (const entry of payload.entry.slice(0, MAX_ENTRIES)) {
        const account = plain(entry) ? String(entry.id ?? '') : '';
        if (!accounts.has(account)) { summary.rejected++; continue; }
        for (const event of (Array.isArray(entry.messaging) ? entry.messaging : []).slice(0, MAX_EVENTS)) {
          const sender = plain(event?.sender) ? String(event.sender.id ?? '') : '';
          const recipient = plain(event?.recipient) ? String(event.recipient.id ?? '') : '';
          const message = plain(event?.message) ? event.message : null;
          if (!message) { summary.ignored++; continue; } // реакции, прочтения, postback не являются обращениями
          if (!ID.test(sender) || !ID.test(recipient) || typeof message.mid !== 'string' || !MID.test(message.mid)) { summary.rejected++; continue; }
          const outbound = message.is_echo === true || sender === account;
          if (!outbound && recipient !== account) { summary.rejected++; continue; }
          const customer = outbound ? recipient : sender;
          const text = typeof message.text === 'string' ? message.text.slice(0, MAX_TEXT) : '';
          const kind = text ? 'text' : Array.isArray(message.attachments) && message.attachments.length ? String(message.attachments[0]?.type || 'file').slice(0, 20) : 'other';
          const sentAt = Number.isSafeInteger(event.timestamp) && event.timestamp > 0 ? stamp(event.timestamp) : stamp();
          const inserted = Number(db.prepare(`INSERT OR IGNORE INTO ig_hook_messages(account_id,mid,sender_id,direction,kind,text,sent_at,received_at)
            VALUES(?,?,?,?,?,?,?,?)`).run(account, message.mid, customer, outbound ? 'out' : 'in', kind, text, sentAt, stamp()).changes);
          if (!inserted) { summary.duplicate++; continue; }
          summary.stored++;
          if (outbound) continue; // ответ сотрудника из Instagram сохраняется в беседе, обращение не создаёт
          const result = recordInquiry({ source: 'instagram', thread: `ig:${account}:${customer}`, customer: { id: customer, name: '' },
            summary: text || 'Вложение в Instagram' });
          db.prepare('UPDATE ig_hook_messages SET inquiry_id=? WHERE account_id=? AND mid=?').run(result.inquiryId, account, message.mid);
          if (result.created) summary.inquiries.push(result.inquiryId);
        }
      }
      return summary;
    });
  }
  /** Сообщения беседы для карточки сотрудника (только серверный вызов workspace). */
  function messages(thread) {
    const m = /^ig:(\d{1,24}):(\d{1,24})$/.exec(String(thread || ''));
    if (!m) return [];
    return db.prepare('SELECT direction,kind,text,sent_at FROM ig_hook_messages WHERE account_id=? AND sender_id=? ORDER BY sent_at,mid LIMIT 200')
      .all(m[1], m[2]).map((r) => ({ direction: r.direction, kind: r.kind, text: r.text, sentAt: r.sent_at,
        authorLabel: r.direction === 'out' ? 'Palitra' : 'Клиент' }));
  }
  return { capability, receive, messages };
}

module.exports = { createInstagramHook };
