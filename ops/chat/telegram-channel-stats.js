'use strict';
/* Текущий счётчик подписчиков публичного Telegram-канала через УЖЕ РАБОТАЮЩЕГО бота Synapse.

   Что этот модуль делает: по коду компании берёт её серверную привязку канала из защищённого
   маршрута CRM, проверяет, что это явно указанный публичный канал, и спрашивает у Bot API
   ровно одно число — getChatMemberCount.

   Чего он не делает и не должен:
   — не принимает URL, chat_id, метод Bot API или иной адрес снаружи: всё строится здесь;
   — не подменяет канал обычной ссылкой telegram, приглашением, ссылкой на пост или личным
     профилем: по ним нельзя установить, что это канал компании;
   — не даёт просмотров, реакций и охватов: Bot API их не отдаёт, и выдумывать их нельзя;
   — не создаёт новых секретов и не расширяет права бота;
   — не пишет ключи, токены и адреса с ключами ни в ответ, ни в журнал. */

/* Общий срок всей цепочки: чтение привязки, вызов Bot API и повторное чтение привязки.
   Отдельные таймауты каждого шага складывались бы, и «10 секунд» превращались в 30. */
const CHAIN_TIMEOUT_MS = 12000;
// Предел ответа считается в БАЙТАХ и проверяется по мере чтения, до разбора JSON.
const MAX_RESPONSE_BYTES = 64 * 1024;

const COMPANY_CODE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;
/* Публичное имя канала Telegram: латиница, цифры и подчёркивания, 5–32 символа.
   Ровно один сегмент пути. Всё остальное — не подтверждённый публичный канал. */
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
// Сегменты, которые публичным именем канала не являются ни при каких условиях.
const RESERVED = new Set(['joinchat', 'addstickers', 'share', 'proxy', 'socks', 'iv', 'c', 's', 'setlanguage', 'confirmphone', 'login', 'addtheme', 'bg']);

const fail = (message, code = 'UNSUPPORTED_LINK') => { throw Object.assign(new Error(message), {code}); };

/* Ограниченное чтение ответа.

   Раньше тело читалось целиком (response.text()), и только потом длина СТРОКИ сравнивалась
   с пределом: ответ в несколько мегабайт успевал полностью загрузиться, а многобайтный текст
   считался вдвое короче, чем он есть. Здесь предел — байты, проверка идёт по мере чтения, и
   при превышении поток отменяется, не дочитываясь. JSON разбирается только после этого. */
async function readJsonLimited(response, {limit = MAX_RESPONSE_BYTES, signal = null} = {}) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    // Тела-потока нет: читаем как есть и меряем настоящие байты, а не символы.
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > limit) fail('Ответ источника слишком большой', 'RESPONSE_TOO_LARGE');
    return parseJson(text);
  }
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      if (signal?.aborted) { await reader.cancel().catch(() => {}); fail('Срок ожидания истёк', 'TIMEOUT'); }
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); fail('Ответ источника слишком большой', 'RESPONSE_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error?.code === 'RESPONSE_TOO_LARGE' || error?.code === 'TIMEOUT') throw error;
    fail('Ответ источника не прочитан', 'BAD_RESPONSE');
  }
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}
function parseJson(text) {
  try { return JSON.parse(text); } catch { return fail('Ответ источника не разобран', 'BAD_RESPONSE'); }
}

/* Нормализация ссылки канала в @username.
   Принимается ТОЛЬКО явный публичный адрес вида https://t.me/<username>. Приглашение
   (t.me/+…, /joinchat/…), ссылка на пост (t.me/<name>/123), закрытый канал (t.me/c/…) и
   веб-просмотр (t.me/s/…) каналом компании не подтверждаются: по ним счётчик снимать нельзя. */
function normalizeChannel(value) {
  if (typeof value !== 'string' || !value.trim()) fail('Ссылка на канал не указана', 'NO_BINDING');
  const raw = value.trim();
  if (raw.length > 2000 || /[\u0000-\u001f\u007f\s]/.test(raw)) fail('Ссылка на канал имеет недопустимый вид');
  let parsed;
  try { parsed = new URL(raw); } catch { fail('Ссылка на канал не разобрана'); }
  if (parsed.protocol !== 'https:') fail('Поддерживается только https-ссылка на публичный канал');
  if (parsed.username || parsed.password) fail('Ссылка на канал не должна содержать учётных данных');
  const host = parsed.hostname.toLowerCase();
  if (host !== 't.me' && host !== 'telegram.me') fail('Поддерживается только адрес t.me');
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 1) {
    fail(segments.length === 0
      ? 'В ссылке нет имени канала'
      : 'Это ссылка на сообщение, закрытый канал или веб-просмотр, а не на публичный канал');
  }
  const name = segments[0];
  if (name.startsWith('+')) fail('Это ссылка-приглашение, а не публичный канал: по ней канал компании не подтверждается');
  if (RESERVED.has(name.toLowerCase())) fail('Это служебный адрес Telegram, а не публичный канал');
  if (!USERNAME.test(name)) fail('Имя публичного канала не распознано');
  return `@${name}`;
}

/* Отпечаток привязки без секретов: компания и нормализованный канал. Сверяется до и после
   сетевого измерения — сменившаяся компания или канал не должны получить прежний ответ. */
const bindingFingerprint = (companyCode, accountRef) => `${String(companyCode).toLowerCase()}|${accountRef}`;

function createTelegramChannelStats({readCompanyLinks, telegramRequest, now = () => Date.now()} = {}) {
  if (typeof readCompanyLinks !== 'function') throw new Error('Нужен доступ к привязкам компании');
  if (typeof telegramRequest !== 'function') throw new Error('Нужен вызов Telegram Bot API');

  async function binding(companyCode, signal) {
    const links = await readCompanyLinks(companyCode, {signal});
    if (!links || typeof links !== 'object') fail('Привязки компании не прочитаны', 'NO_BINDING');
    if (String(links.companyCode || '').toLowerCase() !== String(companyCode).toLowerCase())
      fail('Ответ относится к другой компании', 'BINDING_CHANGED');
    const value = links.links?.telegram_channel;
    if (!value) {
      fail('У компании не указана ссылка на публичный канал Telegram (поле telegram_channel). Обычная ссылка telegram, приглашение или ссылка на пост его не заменяют.', 'NO_BINDING');
    }
    return normalizeChannel(value);
  }

  /* Текущее число подписчиков. Это состояние на момент наблюдения, а не результат периода.
     Время фиксируется ДО запроса: задержавшийся ответ не должен выглядеть свежее. */
  async function channelMembers(companyCode, {timeoutMs = CHAIN_TIMEOUT_MS} = {}) {
    if (typeof companyCode !== 'string' || !COMPANY_CODE.test(companyCode)) fail('Некорректный код компании', 'VALIDATION_ERROR');
    const code = companyCode.toLowerCase();
    /* Один срок на всю цепочку. Сигнал уходит и в чтение привязки, и в вызов Bot API, и в
       повторное чтение: по истечении срока отменяется сам нижележащий запрос, а не только
       ожидание внутри этого модуля. */
    const controller = AbortSignal.timeout(timeoutMs);
    const guard = (error) => {
      if (controller.aborted && error?.code !== 'RESPONSE_TOO_LARGE') fail('Срок измерения истёк', 'TIMEOUT');
      throw error;
    };
    const accountRef = await binding(code, controller).catch(guard);
    const before = bindingFingerprint(code, accountRef);
    const observedAt = new Date(now()).toISOString();
    const answer = await telegramRequest('getChatMemberCount', {chat_id: accountRef}, {signal: controller}).catch(guard);
    // Бот не подключён — это честный отказ, а не ноль подписчиков.
    if (!answer || answer.ok !== true) fail('Бот Synapse не ответил по этому каналу', 'TELEGRAM_UNAVAILABLE');
    const value = answer.result;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
      fail('Telegram вернул не целое число подписчиков', 'BAD_RESPONSE');
    const after = bindingFingerprint(code, await binding(code, controller).catch(guard));
    if (before !== after) fail('Привязка канала изменилась во время измерения: результат не записан', 'BINDING_CHANGED');
    return {companyCode: code, accountRef, metric: 'followers', value, observedAt,
      source: 'getChatMemberCount',
      note: 'Текущее число подписчиков канала. Просмотры и реакции постов Bot API не отдаёт.'};
  }

  return {channelMembers, normalizeChannel, bindingFingerprint};
}

module.exports = {createTelegramChannelStats, normalizeChannel, readJsonLimited,
  TELEGRAM_CHANNEL_USERNAME: USERNAME, TELEGRAM_CHAIN_TIMEOUT_MS: CHAIN_TIMEOUT_MS,
  TELEGRAM_MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES};
