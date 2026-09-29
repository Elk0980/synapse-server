'use strict';
/* Счётчик подписчиков канала: только офлайн, все коды компаний, каналы и числа вымышленные.
   Ни одного реального токена и ни одного обращения в сеть. */
const test = require('node:test'), assert = require('node:assert/strict');
const { createTelegramChannelStats, normalizeChannel } = require('./telegram-channel-stats');

const links = (url) => ({ companyCode: 'alvi', links: url ? { telegram_channel: url } : {} });
function fixture({ url = 'https://t.me/demo_channel', answer = { ok: true, result: 136 }, linksImpl, tg } = {}) {
  const calls = { links: [], telegram: [] };
  const api = createTelegramChannelStats({
    readCompanyLinks: linksImpl || (async (code) => { calls.links.push(code); return links(url); }),
    telegramRequest: tg || (async (method, payload) => { calls.telegram.push({ method, payload }); return answer; }),
    now: () => Date.parse('2026-09-29T10:00:00Z'),
  });
  return { api, calls };
}
const rejects = async (promise, code) => {
  try { await promise; } catch (error) { assert.equal(error.code, code, error.message); return error; }
  assert.fail('ожидался отказ ' + code);
};

test('публичным каналом считается только явный адрес t.me/<имя>', () => {
  assert.equal(normalizeChannel('https://t.me/demo_channel'), '@demo_channel');
  assert.equal(normalizeChannel('https://telegram.me/Demo_Channel'), '@Demo_Channel');
  for (const [value, why] of [
    ['https://t.me/+AbCdEf123', 'приглашение'],
    ['https://t.me/joinchat/AbCdEf', 'старое приглашение'],
    ['https://t.me/c/1234567890/12', 'закрытый канал'],
    ['https://t.me/s/demo_channel', 'веб-просмотр'],
    ['https://t.me/demo_channel/42', 'ссылка на сообщение'],
    ['https://t.me/', 'без имени'],
    ['https://example.com/demo_channel', 'чужой домен'],
    ['http://t.me/demo_channel', 'не https'],
    ['https://user:pass@t.me/demo_channel', 'с учётными данными'],
    ['https://t.me/ab', 'слишком короткое имя'],
  ]) {
    assert.throws(() => normalizeChannel(value), (error) => error.code === 'UNSUPPORTED_LINK', why);
  }
  assert.throws(() => normalizeChannel(''), (error) => error.code === 'NO_BINDING');
});

test('счётчик снимается одним getChatMemberCount по привязке компании', async () => {
  const f = fixture();
  const out = await f.api.channelMembers('alvi');
  assert.deepEqual(f.calls.telegram, [{ method: 'getChatMemberCount', payload: { chat_id: '@demo_channel' } }],
    'вызывается ровно один метод Bot API и только он');
  assert.equal(out.companyCode, 'alvi');
  assert.equal(out.accountRef, '@demo_channel');
  assert.equal(out.metric, 'followers');
  assert.equal(out.value, 136);
  assert.equal(out.observedAt, '2026-09-29T10:00:00.000Z');
  assert.match(out.note, /Просмотры и реакции постов Bot API не отдаёт/);
  assert.equal(Object.hasOwn(out, 'token'), false);
});

test('настоящий ноль подписчиков сохраняется как ноль, дробь и отрицательное — отказ', async () => {
  assert.equal((await fixture({ answer: { ok: true, result: 0 } }).api.channelMembers('alvi')).value, 0);
  await rejects(fixture({ answer: { ok: true, result: 12.5 } }).api.channelMembers('alvi'), 'BAD_RESPONSE');
  await rejects(fixture({ answer: { ok: true, result: -1 } }).api.channelMembers('alvi'), 'BAD_RESPONSE');
  await rejects(fixture({ answer: { ok: true, result: '136' } }).api.channelMembers('alvi'), 'BAD_RESPONSE');
});

test('нет привязки, нет бота и чужая компания в ответе — честные отказы без нулей', async () => {
  await rejects(fixture({ url: null }).api.channelMembers('alvi'), 'NO_BINDING');
  // Обычное поле telegram каналом не считается: по нему нельзя установить, что это канал.
  const plain = fixture({ linksImpl: async () => ({ companyCode: 'alvi', links: { telegram: 'https://t.me/demo_manager' } }) });
  const noBinding = await rejects(plain.api.channelMembers('alvi'), 'NO_BINDING');
  assert.match(noBinding.message, /telegram_channel/);
  // Бот не подключён: warning вместо ok — это отказ, а не ноль подписчиков.
  await rejects(fixture({ answer: { ok: false, warning: 'не отправлено в Telegram: токен не задан' } }).api.channelMembers('alvi'), 'TELEGRAM_UNAVAILABLE');
  await rejects(fixture({ linksImpl: async () => ({ companyCode: 'avokado', links: {} }) }).api.channelMembers('alvi'), 'BINDING_CHANGED');
  await rejects(fixture().api.channelMembers('не код'), 'VALIDATION_ERROR');
  await rejects(fixture().api.channelMembers(''), 'VALIDATION_ERROR');
});

test('привязка, сменившаяся во время измерения, результат не получает', async () => {
  let call = 0;
  const f = fixture({ linksImpl: async () => {
    call += 1;
    return { companyCode: 'alvi', links: { telegram_channel: call === 1 ? 'https://t.me/demo_channel' : 'https://t.me/other_channel' } };
  } });
  const error = await rejects(f.api.channelMembers('alvi'), 'BINDING_CHANGED');
  assert.match(error.message, /изменилась во время измерения/);
});

test('отказ Telegram пробрасывается как есть и не превращается в число', async () => {
  const f = fixture({ tg: async () => { throw Object.assign(new Error('Telegram getChatMemberCount: HTTP 403'), { code: 'FORBIDDEN' }); } });
  await rejects(f.api.channelMembers('alvi'), 'FORBIDDEN');
});

/* Общий срок всей цепочки: сигнал должен доходить до нижележащего запроса, а не только
   прекращать ожидание внутри модуля. */
test('срок измерения отменяет сам запрос к Telegram, а не только ожидание', async () => {
  let seen = null, aborted = false;
  const api = createTelegramChannelStats({
    readCompanyLinks: async (code, options) => { seen = options?.signal || null; return links('https://t.me/demo_channel'); },
    telegramRequest: async (method, payload, options) => new Promise((resolve, reject) => {
      // Запрос «висит» и завершается только по сигналу отмены — как настоящий fetch.
      options.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('прервано'), { code: 'ABORT_ERR' })); });
    }),
    now: () => Date.parse('2026-09-29T10:00:00Z'),
  });
  // AbortSignal.timeout не держит цикл событий: в тесте держим его сами.
  const keepAlive = setInterval(() => {}, 10);
  const error = await rejects(api.channelMembers('alvi', { timeoutMs: 40 }), 'TIMEOUT');
  clearInterval(keepAlive);
  assert.match(error.message, /Срок измерения истёк/);
  assert.equal(aborted, true, 'нижележащий запрос действительно отменён');
  assert.ok(seen && typeof seen.addEventListener === 'function', 'сигнал уходит и в чтение привязки');
});

test('срок измерения отменяет и повторное чтение привязки', async () => {
  let call = 0, abortedOnSecondRead = false;
  const api = createTelegramChannelStats({
    readCompanyLinks: async (code, options) => {
      call += 1;
      if (call === 1) return links('https://t.me/demo_channel');
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
        abortedOnSecondRead = true; reject(Object.assign(new Error('прервано'), { code: 'ABORT_ERR' }));
      }));
    },
    telegramRequest: async () => ({ ok: true, result: 136 }),
    now: () => Date.parse('2026-09-29T10:00:00Z'),
  });
  const keepAlive = setInterval(() => {}, 10);
  await rejects(api.channelMembers('alvi', { timeoutMs: 40 }), 'TIMEOUT');
  clearInterval(keepAlive);
  assert.equal(abortedOnSecondRead, true);
});

/* Ограниченное чтение: предел в байтах, проверка по мере чтения, отмена потока до разбора. */
const { readJsonLimited, TELEGRAM_MAX_RESPONSE_BYTES } = require('./telegram-channel-stats');
const streamOf = (parts, state = {}) => {
  let index = 0;
  return { body: { getReader: () => ({
    read: async () => { state.reads = (state.reads || 0) + 1;
      if (index >= parts.length) return { done: true, value: undefined };
      return { done: false, value: Buffer.from(parts[index++], 'utf8') }; },
    cancel: async () => { state.cancelled = true; },
  }) }, text: async () => parts.join('') };
};

test('предел ответа считается в байтах: многобайтный текст в пределе символов не проходит', async () => {
  // 40 000 русских символов — это 80 000 байт: по символам «в пределе», по байтам нет.
  const long = JSON.stringify({ note: 'я'.repeat(40000) });
  assert.ok(long.length < TELEGRAM_MAX_RESPONSE_BYTES, 'по символам такой ответ прошёл бы');
  assert.ok(Buffer.byteLength(long, 'utf8') > TELEGRAM_MAX_RESPONSE_BYTES, 'по байтам он превышает предел');
  await assert.rejects(readJsonLimited({ text: async () => long }), (error) => error.code === 'RESPONSE_TOO_LARGE');
  const state = {};
  await assert.rejects(readJsonLimited(streamOf([long], state)), (error) => error.code === 'RESPONSE_TOO_LARGE');
  assert.equal(state.cancelled, true, 'поток отменён');
});

test('поток отменяется на превышении, а не после полной загрузки', async () => {
  const chunk = 'x'.repeat(8 * 1024);
  const parts = Array.from({ length: 640 }, () => chunk); // около 5 МиБ
  const state = {};
  await assert.rejects(readJsonLimited(streamOf(parts, state)), (error) => error.code === 'RESPONSE_TOO_LARGE');
  assert.equal(state.cancelled, true);
  assert.ok(state.reads <= 10, `прочитано кусков: ${state.reads} — до конца ответ не дочитывался`);
});

test('отменённый сигнал прекращает чтение ответа', async () => {
  const state = {};
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readJsonLimited(streamOf(['{"ok":true}'], state), { signal: controller.signal }),
    (error) => error.code === 'TIMEOUT');
  assert.equal(state.cancelled, true);
});

test('корректный небольшой JSON читается потоком без нареканий', async () => {
  const state = {};
  const body = await readJsonLimited(streamOf(['{"companyCode":"alvi",', '"links":{}}'], state));
  assert.deepEqual(body, { companyCode: 'alvi', links: {} });
  assert.equal(state.cancelled, undefined);
});
