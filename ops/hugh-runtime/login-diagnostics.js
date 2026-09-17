'use strict';

/* Разбор причины, по которой не удалось начать вход по коду устройства.

   Зачем. На проде вход возвращал только `LOGIN_FAILED`: причина RPC-ошибки отбрасывалась
   вместе с самой ошибкой, и отличить отказ TLS от таймаута или от ответа сервиса входа было
   нечем. Здесь причина сводится к одной категории из закрытого набора и к числам.

   Что НИКОГДА не выходит наружу и не попадает в журнал: сырое сообщение Codex, журнал
   дочернего процесса, адреса, тела ответов, код устройства, идентификаторы и токены.
   Сообщение только сопоставляется с образцами — ни одна его часть не переносится в вывод.
   Единственные данные на выходе: имя категории, числовой код ответа сервиса входа (если он
   действительно был) и числовой код JSON-RPC.

   Категории:
     tls       — соединение не прошло проверку сертификата или рукопожатие;
     dns       — имя сервиса входа не разрешилось;
     transport — соединение не установилось или разорвалось (сюда же выход app-server);
     http      — сервис входа ответил, но кодом ошибки; код сохраняется числом;
     timeout   — ответа не дождались (свой предел запроса или предел клиента Codex);
     unknown   — ничего из перечисленного не опознано; догадки не выдаются за причину.

   Что просматривается. Только та часть сообщения, где клиент формулирует отказ: адрес вместе
   со строкой запроса и всё после начала процитированного тела ответа выбрасываются до разбора.
   Кодом ответа считается лишь число в явной формулировке отказа, и берётся самая ранняя такая
   формулировка. Поэтому `?status=403` в адресе и `HTTP/1.1 401` из тела кодом ответа не
   становятся, а TLS и DNS решают раньше кода: без рукопожатия и без разрешённого имени
   никакого ответа не было. Если признаков недостаточно — категория `unknown`. */

const CATEGORIES = Object.freeze(['tls', 'dns', 'transport', 'http', 'timeout', 'unknown']);

/* Сообщения клиента app-server из app-server-client.js: у них нет текста от Codex вообще. */
const SENTINELS = Object.freeze({timeout: 'timeout', process_exit: 'transport'});

const TLS_PATTERNS = [
  /\btls\b/i,
  /\bssl\b/i,
  /certificate/i,
  /handshake/i,
  /self[\s-]?signed/i,
  /unknown\s?issuer/i,
  /not\s?valid\s?for\s?name/i,
  /\bx509\b/i,
  /\bca\b\s+(?:file|bundle|store)/i,
];

const DNS_PATTERNS = [
  /\bdns\b/i,
  /failed to lookup address/i,
  /name or service not known/i,
  /nodename nor servname/i,
  /getaddrinfo/i,
  /no such host/i,
  /name resolution/i,
];

/* Проверяется после транспортных образцов: см. порядок в classifyLoginFailure. */
const TIMEOUT_PATTERNS = [/timed out/i, /\btimeout\b/i, /deadline/i];

const TRANSPORT_PATTERNS = [
  /error sending request/i,
  /connect error/i,
  /connection (?:refused|reset|closed|aborted)/i,
  /broken pipe/i,
  /network is unreachable/i,
  /no route to host/i,
  /os error \d+/i,
  /econn(?:refused|reset|aborted)/i,
  /\bsocket\b/i,
  /channel closed/i,
  /incomplete message/i,
  /unexpected eof/i,
];

/* Код ответа засчитывается только там, где клиент сам назвал его кодом ответа. Число рядом с
   чем угодно («os error 110») кодом HTTP не считается: выдуманный статус хуже отсутствующего.
   Знак «=» не принимается намеренно — так пишутся параметры запроса (`?status=403`), а не
   формулировки отказа. */
const HTTP_STATUS_PATTERNS = [
  /\bhttp\/\d(?:\.\d)?\s+(\d{3})\b/i,
  /\bhttp\s+status\s+(?:client|server)\s+error\s*\(\s*(\d{3})\b/i,
  /\bunexpected\s+status(?:\s+code)?:?\s+(\d{3})\b/i,
  /\bstatus\s+code:?\s*(\d{3})\b/i,
  /\bstatus:\s*(\d{3})\b/i,
  /\bresponded\s+with\s+(?:status:?\s*)?(\d{3})\b/i,
  /\breturned\s+(?:http\s+)?(\d{3})\b/i,
];

/* Части сообщения, которые к формулировке отказа не относятся и потому не просматриваются:
   адрес вместе со строкой запроса и всё, что идёт после начала тела ответа. Без этого
   `?status=403` в адресе и `HTTP/1.1 401` из процитированного тела выдавали себя за код
   ответа сервиса входа. */
const BODY_MARKER = /\b(?:body|response\s+body|response\s+text|payload)\s*[:=]/i;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S*/gi;
const QUERY_PATTERN = /\?[^\s)]*/g;

function scannableText(raw) {
  if (typeof raw !== 'string' || raw === '') return '';
  const marker = BODY_MARKER.exec(raw);
  const head = marker ? raw.slice(0, marker.index) : raw;
  return head.replace(URL_PATTERN, ' ').replace(QUERY_PATTERN, ' ');
}

const MESSAGES = Object.freeze({
  tls: 'Защищённое соединение с сервисом входа не установлено',
  dns: 'Адрес сервиса входа не определяется',
  transport: 'Соединение с сервисом входа не установлено',
  timeout: 'Сервис входа не ответил за отведённое время',
  unknown: 'Причина не определена',
});

const matches = (patterns, text) => patterns.some((pattern) => pattern.test(text));

/* Берётся самая ранняя формулировка отказа, а не первый подошедший образец: в
   «unexpected status 503 …» ответ сервиса входа назван раньше всего остального. */
function leadingStatus(text) {
  let best = null;
  for (const pattern of HTTP_STATUS_PATTERNS) {
    const found = pattern.exec(text);
    if (!found) continue;
    const status = Number(found[1]);
    if (!Number.isInteger(status) || status < 100 || status > 599) continue;
    if (best === null || found.index < best.index) best = {index: found.index, status};
  }
  return best === null ? null : best.status;
}

/* Код ответа сервиса входа или null, если он не назван явно. Адрес, строка запроса и тело
   ответа при этом не просматриваются вовсе. */
function upstreamStatusOf(raw) {
  return leadingStatus(scannableText(raw));
}

/* Принимает ошибку app-server-client: {rpcCode, rpcMessage}. Возвращает только разрешённое. */
function classifyLoginFailure(error) {
  const code = error && typeof error === 'object' ? error.rpcCode : undefined;
  const rpcCode = Number.isInteger(code) ? code : null;
  const sentinel = typeof code === 'string' ? SENTINELS[code] || '' : '';
  const raw = error && typeof error.rpcMessage === 'string' ? error.rpcMessage : '';
  // Все образцы применяются к одному и тому же очищенному тексту: иначе адрес из сообщения
  // мог бы задать категорию словом из своего пути или параметра.
  const text = scannableText(raw);
  const status = leadingStatus(text);

  let category;
  if (sentinel) category = sentinel;
  // TLS и DNS проверяются раньше кода ответа: если рукопожатие или разрешение имени не
  // состоялись, никакого ответа не было, чем бы ни выглядело число в тексте.
  else if (matches(TLS_PATTERNS, text)) category = 'tls';
  else if (matches(DNS_PATTERNS, text)) category = 'dns';
  else if (status !== null) category = 'http';
  // Транспорт проверяется раньше таймаута: «connect error … timed out» — это несостоявшееся
  // соединение, а не ответ, которого не дождались. Чистый таймаут остаётся таймаутом.
  else if (matches(TRANSPORT_PATTERNS, text)) category = 'transport';
  else if (matches(TIMEOUT_PATTERNS, text)) category = 'timeout';
  else category = 'unknown';

  // Число отдаётся только вместе с категорией http: смешивать признаки нельзя.
  return {category, upstreamStatus: category === 'http' ? status : null, rpcCode};
}

/* Строка для журнала: только имя категории и числа. Любой другой символ здесь — ошибка. */
function formatLoginDiagnostics(detail) {
  const parts = [`category=${CATEGORIES.includes(detail.category) ? detail.category : 'unknown'}`];
  if (Number.isInteger(detail.upstreamStatus)) parts.push(`upstreamStatus=${detail.upstreamStatus}`);
  if (Number.isInteger(detail.rpcCode)) parts.push(`rpcCode=${detail.rpcCode}`);
  return parts.join(' ');
}

/* Текст для владельца. Ничего не утверждает сверх того, что установлено: при неопознанной
   причине это прямо сказано, а не подменено «временным сбоем сети». Код ответа сервиса входа
   называется числом без толкований — ни про регион, ни про учётную запись выводов не делается. */
function loginFailureMessage(detail) {
  if (detail.category === 'http' && Number.isInteger(detail.upstreamStatus)) {
    return `Сервис входа ответил кодом ${detail.upstreamStatus}`;
  }
  return MESSAGES[detail.category] || MESSAGES.unknown;
}

module.exports = {
  CATEGORIES,
  classifyLoginFailure,
  formatLoginDiagnostics,
  loginFailureMessage,
  upstreamStatusOf,
};
