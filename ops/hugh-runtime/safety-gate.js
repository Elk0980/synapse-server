'use strict';

/* Предохранитель «нулевого набора инструментов».
   Пока не доказано, что реальный закреплённый Codex 0.154.0 отправляет провайдеру пустой tools,
   маршрут /reply обязан отвечать 503 TOOL_ISOLATION_UNVERIFIED и не обращаться к модели.

   Доказательство нельзя подделать переменной окружения: это файл, который пишет проверочный прогон
   (tool-isolation.integration.test.js) с настоящим бинарём и локальным mock-провайдером. Файл
   привязан к отпечатку изоляционной конфигурации и к версии CLI, поэтому при любой правке
   ограничений он перестаёт подходить и предохранитель снова закрывается.

   Предохранитель — не единственная защита. В рантайме дополнительно действуют:
   проверка thread.environments === [], отказ на любой запрос инструмента и запрет опасных item-ов. */

const fs = require('node:fs');

const PROOF_SCHEMA = 1;
const FORBIDDEN_ITEM_TYPES = Object.freeze([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'imageView',
  'webSearch',
  'imageGeneration',
  'functionCallOutput',
  'sleep',
  'plan',
]);

function readProofFile(proofPath) {
  try {
    return JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/* Возвращает {verified, reason}. reason — короткий код для журналов и /status. */
function evaluateProof(proof, {fingerprint, codexVersion}) {
  if (!proof) return {verified: false, reason: 'proof_missing'};
  if (proof.schema !== PROOF_SCHEMA) return {verified: false, reason: 'proof_schema_mismatch'};
  if (proof.codexVersion !== codexVersion) return {verified: false, reason: 'proof_version_mismatch'};
  if (proof.fingerprint !== fingerprint) return {verified: false, reason: 'proof_fingerprint_mismatch'};
  if (!Array.isArray(proof.observedTools)) return {verified: false, reason: 'proof_tools_missing'};
  if (proof.observedTools.length !== 0) return {verified: false, reason: 'proof_tools_not_empty'};
  if (proof.injectedToolCallsExecuted !== false) return {verified: false, reason: 'proof_injection_unchecked'};
  if (proof.canaryIntact !== true) return {verified: false, reason: 'proof_canary_unchecked'};
  if (!Number.isFinite(Date.parse(proof.verifiedAt || ''))) return {verified: false, reason: 'proof_timestamp_invalid'};
  return {verified: true, reason: 'proof_ok'};
}

function loadGate({proofPath, fingerprint, codexVersion}) {
  if (!proofPath) return {verified: false, reason: 'proof_path_unset'};
  let proof = null;
  try {
    proof = readProofFile(proofPath);
  } catch {
    return {verified: false, reason: 'proof_unreadable'};
  }
  return evaluateProof(proof, {fingerprint, codexVersion});
}

/* Используется только проверочным прогоном. Прод никогда не вызывает эту функцию. */
function buildProof({fingerprint, codexVersion, observedTools, injectedToolCallsExecuted, canaryIntact}) {
  return {
    schema: PROOF_SCHEMA,
    codexVersion,
    fingerprint,
    observedTools,
    injectedToolCallsExecuted,
    canaryIntact,
    verifiedAt: new Date().toISOString(),
  };
}

/* Проверяет ответ thread/start: пустой список окружений обязателен перед любым ходом. */
function assertEmptyEnvironments(thread) {
  const environments = thread && thread.environments;
  if (!Array.isArray(environments)) return {ok: false, reason: 'environments_not_reported'};
  if (environments.length !== 0) return {ok: false, reason: 'environments_not_empty'};
  return {ok: true, reason: 'environments_empty'};
}

function isForbiddenItem(item) {
  return Boolean(item) && FORBIDDEN_ITEM_TYPES.includes(item.type);
}

module.exports = {
  PROOF_SCHEMA,
  FORBIDDEN_ITEM_TYPES,
  loadGate,
  evaluateProof,
  buildProof,
  assertEmptyEnvironments,
  isForbiddenItem,
};
