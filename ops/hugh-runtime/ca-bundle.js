'use strict';

/* Проверка хранилища доверенных корневых сертификатов.

   Зачем отдельная проверка. Вход в подписку идёт по TLS к auth.openai.com, и клиент
   закреплённого бинаря берёт корни из системного хранилища Debian
   (/etc/ssl/certs/ca-certificates.crt). Если файла нет или он пуст, соединение не
   устанавливается вовсе: наружу это видно как «error sending request», хотя ни сеть,
   ни учётные данные ни при чём.

   Проверка намеренно не ходит в сеть и ничего не отключает: она читает файл и разбирает
   каждый PEM-блок настоящим X509-разборщиком Node. «Файл есть» доказательством не
   считается — набор без единого разобранного и действующего на сегодня сертификата
   бесполезен ровно так же, как отсутствующий файл. */

const fs = require('node:fs');
const {X509Certificate} = require('node:crypto');

/* Путь по умолчанию — тот же, что использует OpenSSL в Debian и к которому обращается
   клиент Codex. Подменять его переменной окружения рантайм не даёт: параметр нужен
   только тестам и ручному запуску проверки. */
const DEFAULT_CA_BUNDLE_PATH = '/etc/ssl/certs/ca-certificates.crt';

/* В пакете ca-certificates Debian корней больше сотни. Порог занижен намеренно:
   он ловит пустой, обрезанный или подменённый заглушкой набор, но не зависит от того,
   сколько именно корней осталось после очередного обновления пакета. */
const MIN_VALID_CERTIFICATES = 20;

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

function certificateWindow(certificate) {
  const from = certificate.validFromDate instanceof Date ? certificate.validFromDate.getTime() : Date.parse(certificate.validFrom);
  const to = certificate.validToDate instanceof Date ? certificate.validToDate.getTime() : Date.parse(certificate.validTo);
  return {from, to};
}

/* Чистая проверка содержимого: её можно прогнать на фикстуре без образа и без файловой системы. */
function inspectCaBundle(text, options = {}) {
  const minValid = Number.isFinite(options.minValid) ? options.minValid : MIN_VALID_CERTIFICATES;
  const now = options.now === undefined ? Date.now() : new Date(options.now).getTime();
  // expired считает сертификаты вне их окна действия: и просроченные, и ещё не начавшиеся.
  const counts = {blocks: 0, parsed: 0, valid: 0, expired: 0, unparsable: 0, minValid};

  if (typeof text !== 'string' || text.trim() === '') {
    return {ok: false, reason: 'ca_bundle_empty', ...counts};
  }
  const blocks = text.match(PEM_BLOCK) || [];
  counts.blocks = blocks.length;
  if (blocks.length === 0) return {ok: false, reason: 'ca_bundle_without_certificates', ...counts};

  for (const block of blocks) {
    let certificate;
    try {
      certificate = new X509Certificate(block);
    } catch {
      counts.unparsable += 1;
      continue;
    }
    counts.parsed += 1;
    const {from, to} = certificateWindow(certificate);
    if (Number.isFinite(from) && Number.isFinite(to) && from <= now && now <= to) counts.valid += 1;
    else counts.expired += 1;
  }

  if (counts.parsed === 0) return {ok: false, reason: 'ca_bundle_unparsable', ...counts};
  if (counts.valid < minValid) return {ok: false, reason: 'ca_bundle_without_valid_certificates', ...counts};
  return {ok: true, reason: 'ca_bundle_ok', ...counts};
}

/* Чтение выполняется ровно тем пользователем, от которого запущена проверка: в образе это
   рабочий hugh, поэтому недоступный на чтение файл — такой же провал, как отсутствующий. */
function checkCaBundle(options = {}) {
  const bundlePath = options.path || DEFAULT_CA_BUNDLE_PATH;
  let text;
  try {
    text = fs.readFileSync(bundlePath, 'utf8');
  } catch (error) {
    const reason = error.code === 'ENOENT' ? 'ca_bundle_missing' : 'ca_bundle_unreadable';
    return {ok: false, reason, path: bundlePath, bytes: 0, blocks: 0, parsed: 0, valid: 0, expired: 0, unparsable: 0,
      minValid: Number.isFinite(options.minValid) ? options.minValid : MIN_VALID_CERTIFICATES, code: error.code || null};
  }
  return {...inspectCaBundle(text, options), path: bundlePath, bytes: Buffer.byteLength(text)};
}

module.exports = {
  DEFAULT_CA_BUNDLE_PATH,
  MIN_VALID_CERTIFICATES,
  inspectCaBundle,
  checkCaBundle,
};
