'use strict';
/*
 * Строгий адаптер отправки уведомления менеджеру через СУЩЕСТВУЮЩИЙ бот хоста (sendMessage Bot API).
 * Хост передаёт callBotApi(method, params, { signal }) — свою уже настроенную функцию вызова Bot API (токен
 * остаётся у хоста) — и botId этого бота. Адаптер ничего не повторяет сам: попытки решает очередь team-notify.
 *
 * Получатель — только личный чат менеджера (положительный id пользователя); группы, супергруппы и каналы
 * (отрицательный id) отклоняются ДО вызова Bot API.
 *
 * Квитанция засчитывается, только если Telegram вернул сообщение, которое отправил ожидаемый бот
 * (result.from.id === botId, from.is_bot === true) в личный чат (chat.type === 'private') того же получателя
 * (chat.id === chatId) с положительным message_id. Любое расхождение или неполный ответ — неизвестный исход.
 *
 * Результат для очереди:
 *  { ok:true, messageId, chatId, chatType:'private', botId } — строгая квитанция;
 *  { ok:false, retryable:true, uncertain:false }  — 429: Telegram явно не принял, можно позже;
 *  { ok:false, permanent:true, uncertain:false }  — 400/403 или неверный запрос: не отправлено;
 *  { ok:false, uncertain:true }                   — обрыв, таймаут, 5xx, чужая/неполная квитанция: могло дойти, не повторять.
 */
const PRIVATE_CHAT_ID = /^[1-9]\d{0,19}$/;
const BOT_ID = /^[1-9]\d{0,19}$/;
const FIELDS = new Set(['chatId', 'recipientVersion', 'text', 'idempotencyKey', 'signal']);
const permanent = (code) => ({ ok: false, permanent: true, uncertain: false, code });
const uncertain = (code = 'TELEGRAM_DELIVERY_UNKNOWN') => ({ ok: false, uncertain: true, code });

function createTeamTelegramTransport({ callBotApi, botId } = {}) {
  if (typeof callBotApi !== 'function') throw new TypeError('Требуется функция вызова Bot API существующего бота хоста');
  if (!BOT_ID.test(String(botId ?? ''))) throw new TypeError('Требуется id существующего бота, через который отправляются уведомления');
  const expectedBot = String(botId);
  return async function sendTelegram(input) {
    if (!input || typeof input !== 'object' || Object.keys(input).some((k) => !FIELDS.has(k))) return permanent('TELEGRAM_INVALID_REQUEST');
    if (!PRIVATE_CHAT_ID.test(String(input.chatId ?? ''))) return permanent('TELEGRAM_INVALID_RECIPIENT');
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.text)) {
      return permanent('TELEGRAM_INVALID_TEXT');
    }
    if (typeof input.idempotencyKey !== 'string' || !/^palitra:inquiry:\d+:new_inquiry:telegram:manager$/.test(input.idempotencyKey)) {
      return permanent('TELEGRAM_INVALID_REQUEST');
    }
    if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) return permanent('TELEGRAM_INVALID_REQUEST');
    if (input.signal?.aborted) return permanent('TELEGRAM_ABORTED_BEFORE_SEND');
    let response;
    try {
      // Без parse_mode: текст не интерпретируется как разметка.
      response = await callBotApi('sendMessage', { chat_id: String(input.chatId), text: input.text, link_preview_options: { is_disabled: true } },
        { signal: input.signal });
    } catch {
      return uncertain();
    }
    if (input.signal?.aborted) return uncertain('TELEGRAM_ABORTED_AFTER_SEND');
    if (response && response.ok === true) {
      const result = response.result;
      const messageId = result?.message_id;
      const strict = Number.isSafeInteger(messageId) && messageId > 0
        && result?.chat?.type === 'private' && Number.isSafeInteger(result.chat.id) && String(result.chat.id) === String(input.chatId)
        && result?.from?.is_bot === true && Number.isSafeInteger(result.from.id) && String(result.from.id) === expectedBot;
      if (strict) return { ok: true, messageId, chatId: String(result.chat.id), chatType: 'private', botId: expectedBot };
      return uncertain('TELEGRAM_RECEIPT_MISMATCH');
    }
    if (response && response.ok === false && Number.isInteger(response.error_code)) {
      if (response.error_code === 429) return { ok: false, retryable: true, uncertain: false, code: 'TELEGRAM_RATE_LIMITED' };
      if (response.error_code === 400 || response.error_code === 403) return permanent('TELEGRAM_REFUSED');
    }
    return uncertain();
  };
}

module.exports = { createTeamTelegramTransport };
