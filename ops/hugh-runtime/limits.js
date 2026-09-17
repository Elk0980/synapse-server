'use strict';

/* Границы входа и выхода приватного рантайма Hugh.
   Значения согласованы с чат-бэкендом: он присылает не больше 30 сообщений по 6000 символов,
   рантайм принимает запас до 40 сообщений, но никогда не отбрасывает лишнее молча — только 400.
   Символы считаются по кодовым точкам (Array.from), байты — по UTF-8; действуют оба предела. */

const {invalid} = require('./errors');

const LIMITS = Object.freeze({
  maxBodyBytes: 128 * 1024,
  maxMessages: 40,
  maxMessageChars: 6000,
  maxMessageBytes: 24000,
  maxTranscriptChars: 48000,
  maxTranscriptBytes: 192 * 1024,
  maxSystemChars: 8000,
  maxSystemBytes: 32000,
  maxOutputChars: 16000,
  maxJobIdChars: 128,
  maxCompanyCodeChars: 64,
});

const ROLES = new Set(['user', 'assistant']);
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const COMPANY_PATTERN = /^[A-Za-z0-9._-]+$/;
const REPLY_FIELDS = new Set(['jobId', 'companyCode', 'messages', 'system']);
const MESSAGE_FIELDS = new Set(['role', 'content']);

const countChars = (value) => Array.from(value).length;
const countBytes = (value) => Buffer.byteLength(value, 'utf8');

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value, field) {
  if (typeof value !== 'string') throw invalid(`Поле ${field} должно быть строкой`);
  return value;
}

function checkSize(value, field, maxChars, maxBytes) {
  if (countChars(value) > maxChars) throw invalid(`Поле ${field} длиннее ${maxChars} символов`);
  if (countBytes(value) > maxBytes) throw invalid(`Поле ${field} длиннее ${maxBytes} байт`);
}

/* Разбирает и проверяет тело POST /reply. Любое неизвестное поле — отказ, а не тихое игнорирование. */
function validateReplyPayload(raw) {
  if (!isPlainObject(raw)) throw invalid('Тело запроса должно быть JSON-объектом');
  for (const key of Object.keys(raw)) {
    if (!REPLY_FIELDS.has(key)) throw invalid(`Неизвестное поле ${key}`);
  }

  const jobId = requireString(raw.jobId, 'jobId').trim();
  if (!jobId || countChars(jobId) > LIMITS.maxJobIdChars || !JOB_ID_PATTERN.test(jobId)) {
    throw invalid('Поле jobId задано неверно');
  }

  const companyCode = requireString(raw.companyCode, 'companyCode').trim();
  if (!companyCode || countChars(companyCode) > LIMITS.maxCompanyCodeChars || !COMPANY_PATTERN.test(companyCode)) {
    throw invalid('Поле companyCode задано неверно');
  }

  const system = requireString(raw.system, 'system');
  if (!system.trim()) throw invalid('Поле system пустое');
  checkSize(system, 'system', LIMITS.maxSystemChars, LIMITS.maxSystemBytes);

  if (!Array.isArray(raw.messages)) throw invalid('Поле messages должно быть массивом');
  if (raw.messages.length === 0) throw invalid('Поле messages пустое');
  if (raw.messages.length > LIMITS.maxMessages) throw invalid(`Больше ${LIMITS.maxMessages} сообщений`);

  let transcriptChars = 0;
  let transcriptBytes = 0;
  const messages = raw.messages.map((item, index) => {
    if (!isPlainObject(item)) throw invalid(`Сообщение ${index} должно быть объектом`);
    for (const key of Object.keys(item)) {
      if (!MESSAGE_FIELDS.has(key)) throw invalid(`Неизвестное поле ${key} в сообщении ${index}`);
    }
    const role = requireString(item.role, `messages[${index}].role`);
    if (!ROLES.has(role)) throw invalid(`Недопустимая роль в сообщении ${index}`);
    const content = requireString(item.content, `messages[${index}].content`);
    if (!content.trim()) throw invalid(`Сообщение ${index} пустое`);
    checkSize(content, `messages[${index}].content`, LIMITS.maxMessageChars, LIMITS.maxMessageBytes);
    transcriptChars += countChars(content);
    transcriptBytes += countBytes(content);
    return {role, content};
  });

  if (transcriptChars > LIMITS.maxTranscriptChars) {
    throw invalid(`Переписка длиннее ${LIMITS.maxTranscriptChars} символов`);
  }
  if (transcriptBytes > LIMITS.maxTranscriptBytes) {
    throw invalid(`Переписка длиннее ${LIMITS.maxTranscriptBytes} байт`);
  }

  return {jobId, companyCode, system, messages};
}

/* Канонический вид для хэша идемпотентности: сравниваем именно проверенные данные. */
function canonicalPayload(payload) {
  return JSON.stringify({
    companyCode: payload.companyCode,
    jobId: payload.jobId,
    system: payload.system,
    messages: payload.messages.map((message) => ({role: message.role, content: message.content})),
  });
}

/* Ответ модели обрезаем по символам и по байтам; обрезка всегда помечается. */
function capOutput(text) {
  const trimmed = String(text).trim();
  const chars = Array.from(trimmed);
  let capped = chars.length > LIMITS.maxOutputChars ? chars.slice(0, LIMITS.maxOutputChars).join('') : trimmed;
  while (countBytes(capped) > LIMITS.maxOutputChars * 4) {
    capped = Array.from(capped).slice(0, -64).join('');
  }
  return {text: capped, truncated: capped.length !== trimmed.length};
}

module.exports = {LIMITS, validateReplyPayload, canonicalPayload, capOutput, countChars, countBytes};
