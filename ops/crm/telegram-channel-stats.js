'use strict';
/* Узкий клиент CRM → chat за текущим счётчиком подписчиков канала.

   Адрес берётся ТОЛЬКО из серверной настройки CHAT_STATS_URL; снаружи ни адрес, ни канал,
   ни метод Bot API не принимаются — в запрос уходит один код компании. Межсервисный ключ
   тот же, что у CRM уже есть: новых секретов не создаётся и в ответ они не попадают. */

const COMPANY_CODE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;
const TIMEOUT_MS = 10000;
// Предел ответа в БАЙТАХ, а не в символах: многобайтный текст иначе считается вдвое короче.
const MAX_BYTES = 64 * 1024;
const PATH = '/internal/telegram/channel-members';

const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };

/* Ошибки наружу — общие. Ни ключа, ни адреса с ключом, ни тела ответа источника в них нет:
   иначе секрет уехал бы в журнал запусков и в карточку кабинета. */
const STATUS_REASON = Object.freeze({
  400: 'сервис счётчика отклонил запрос',
  401: 'межсервисный ключ не принят сервисом счётчика',
  403: 'сервис счётчика отказал в доступе',
  404: 'компания или её канал не найдены',
  405: 'сервис счётчика не поддерживает такой запрос',
  409: 'канал компании не подтверждён или изменился во время измерения',
  502: 'бот не смог снять счётчик подписчиков',
});

/* Ограниченное чтение ответа по мере поступления.

   Прежде тело читалось целиком, и только потом длина СТРОКИ сравнивалась с пределом: ответ
   в несколько мегабайт успевал загрузиться полностью, а многобайтный текст проходил мимо
   предела. Теперь предел считается в байтах, проверяется на каждом куске, поток при
   превышении отменяется, и только после этого разбирается JSON. */
async function readJsonLimited(response, signal) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) fail('BAD_RESPONSE', 'ответ сервиса счётчика слишком большой');
    try { return JSON.parse(text); } catch { return fail('BAD_RESPONSE', 'ответ сервиса счётчика не разобран'); }
  }
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      if (signal?.aborted) { await reader.cancel().catch(() => {}); fail('UNAVAILABLE', 'сервис счётчика подписчиков не ответил'); }
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel().catch(() => {}); fail('BAD_RESPONSE', 'ответ сервиса счётчика слишком большой'); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (['BAD_RESPONSE', 'UNAVAILABLE'].includes(error?.code)) throw error;
    fail('UNAVAILABLE', 'сервис счётчика подписчиков не ответил');
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return fail('BAD_RESPONSE', 'ответ сервиса счётчика не разобран'); }
}

function createTelegramChannelStatsClient({baseUrl, apiKey, fetchImpl = fetch} = {}) {
  const configured = Boolean(String(baseUrl || '').trim() && String(apiKey || '').trim());
  let origin = null;
  if (configured) {
    try { origin = new URL(baseUrl); } catch { origin = null; }
    if (origin && !['http:', 'https:'].includes(origin.protocol)) origin = null;
  }
  const ready = Boolean(origin);

  async function channelMembers(companyCode) {
    if (!ready) fail('NOT_CONFIGURED', 'адрес сервиса счётчика подписчиков не настроен на сервере');
    if (typeof companyCode !== 'string' || !COMPANY_CODE.test(companyCode)) fail('VALIDATION_ERROR', 'некорректный код компании');
    const url = new URL(PATH, origin);
    url.searchParams.set('companyCode', companyCode.toLowerCase());
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(url.href, {
        method: 'GET',
        // За редиректом с межсервисным ключом не идём: это отдало бы ключ чужому адресу.
        redirect: 'error',
        headers: {'x-api-key': apiKey, accept: 'application/json'},
        signal,
      });
    } catch { fail('UNAVAILABLE', 'сервис счётчика подписчиков не ответил'); }
    if (!response.ok) {
      // Временный HTTP-сбой не должен закрывать дату как постоянное отсутствие доступа.
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      fail(retryable ? 'UNAVAILABLE' : 'REJECTED', STATUS_REASON[response.status] || 'сервис счётчика вернул ошибку');
    }
    const body = await readJsonLimited(response, signal);
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('BAD_RESPONSE', 'ответ сервиса счётчика не разобран');
    if (String(body.companyCode || '').toLowerCase() !== companyCode.toLowerCase())
      fail('COMPANY_MISMATCH', 'ответ относится к другой компании');
    if (typeof body.accountRef !== 'string' || !body.accountRef.startsWith('@'))
      fail('BAD_RESPONSE', 'сервис счётчика не назвал канал');
    if (typeof body.value !== 'number' || !Number.isInteger(body.value) || body.value < 0)
      fail('BAD_RESPONSE', 'сервис счётчика вернул не целое число подписчиков');
    const observedAt = typeof body.observedAt === 'string' && Number.isFinite(Date.parse(body.observedAt))
      ? new Date(body.observedAt).toISOString() : null;
    return {companyCode: companyCode.toLowerCase(), accountRef: body.accountRef, value: body.value,
      observedAt, source: 'getChatMemberCount'};
  }

  return {ready, channelMembers};
}

module.exports = {createTelegramChannelStatsClient, TELEGRAM_STATS_PATH: PATH,
  TELEGRAM_STATS_MAX_BYTES: MAX_BYTES, TELEGRAM_STATS_TIMEOUT_MS: TIMEOUT_MS};
