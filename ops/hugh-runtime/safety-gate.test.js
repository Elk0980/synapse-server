'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {evaluateProof, buildProof, loadGate, assertEmptyEnvironments, isForbiddenItem, FORBIDDEN_ITEM_TYPES} = require('./safety-gate');
const {isolationFingerprint, PINNED_CODEX_VERSION, ISOLATION_TABLE_BLOCKS, DISABLED_FEATURES} = require('./codex-config');
const {tempDir, removeDir} = require('./test-support/harness');

const fingerprint = () => isolationFingerprint({modelCatalogSha256: null, model: null});
const good = () =>
  buildProof({
    fingerprint: fingerprint(),
    codexVersion: PINNED_CODEX_VERSION,
    observedTools: [],
    injectedToolCallsExecuted: false,
    canaryIntact: true,
  });

test('корректное доказательство открывает предохранитель', () => {
  assert.deepEqual(evaluateProof(good(), {fingerprint: fingerprint(), codexVersion: PINNED_CODEX_VERSION}), {
    verified: true,
    reason: 'proof_ok',
  });
});

test('любое расхождение оставляет предохранитель закрытым', () => {
  const context = {fingerprint: fingerprint(), codexVersion: PINNED_CODEX_VERSION};
  const cases = [
    [null, 'proof_missing'],
    [{...good(), schema: 2}, 'proof_schema_mismatch'],
    [{...good(), codexVersion: '0.153.0'}, 'proof_version_mismatch'],
    [{...good(), fingerprint: 'другой'}, 'proof_fingerprint_mismatch'],
    [{...good(), observedTools: null}, 'proof_tools_missing'],
    [{...good(), observedTools: ['shell']}, 'proof_tools_not_empty'],
    [{...good(), injectedToolCallsExecuted: true}, 'proof_injection_unchecked'],
    [{...good(), canaryIntact: false}, 'proof_canary_unchecked'],
    [{...good(), verifiedAt: 'вчера'}, 'proof_timestamp_invalid'],
  ];
  for (const [proof, reason] of cases) {
    assert.deepEqual(evaluateProof(proof, context), {verified: false, reason}, reason);
  }
});

test('отсутствующий и нечитаемый файл доказательства обрабатываются безопасно', async () => {
  const dir = tempDir('hugh-gate-');
  const context = {fingerprint: fingerprint(), codexVersion: PINNED_CODEX_VERSION};
  assert.equal(loadGate({proofPath: null, ...context}).reason, 'proof_path_unset');
  assert.equal(loadGate({proofPath: path.join(dir, 'нет.json'), ...context}).reason, 'proof_missing');
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, 'не json');
  assert.equal(loadGate({proofPath: broken, ...context}).reason, 'proof_unreadable');
  await removeDir(dir);
});

test('каталог и слаг модели входят в отпечаток', () => {
  assert.notEqual(isolationFingerprint({modelCatalogSha256: 'abc', model: null}), fingerprint());
  assert.notEqual(isolationFingerprint({modelCatalogSha256: null, model: 'gpt-5.5'}), fingerprint());
  assert.notEqual(
    isolationFingerprint({modelCatalogSha256: 'abc', model: 'gpt-5.5'}),
    isolationFingerprint({modelCatalogSha256: 'abc', model: 'gpt-5.4'}),
  );
});

test('проверка пустых окружений различает три случая', () => {
  assert.deepEqual(assertEmptyEnvironments({environments: []}), {ok: true, reason: 'environments_empty'});
  assert.deepEqual(assertEmptyEnvironments({environments: [{id: 'x'}]}), {ok: false, reason: 'environments_not_empty'});
  assert.deepEqual(assertEmptyEnvironments({environments: null}), {ok: false, reason: 'environments_not_reported'});
  assert.deepEqual(assertEmptyEnvironments({}), {ok: false, reason: 'environments_not_reported'});
  assert.deepEqual(assertEmptyEnvironments(null), {ok: false, reason: 'environments_not_reported'});
});

test('опасные элементы хода распознаются, обычные — нет', () => {
  for (const type of FORBIDDEN_ITEM_TYPES) assert.equal(isForbiddenItem({type}), true, type);
  for (const type of ['agentMessage', 'userMessage', 'reasoning']) assert.equal(isForbiddenItem({type}), false, type);
  assert.equal(isForbiddenItem(null), false);
});

test('изоляционная конфигурация содержит подтверждённые ключи ограничений', () => {
  const flat = ISOLATION_TABLE_BLOCKS.flat();
  assert.ok(flat.includes('[mcp_servers]'));
  assert.ok(flat.includes('[tools.experimental_request_user_input]'));
  assert.ok(flat.includes('[orchestrator.mcp]'));
  for (const key of ['shell_tool', 'view_image', 'token_budget', 'current_time_reminder', 'multi_agent_v2', 'code_mode', 'image_generation']) {
    assert.ok(DISABLED_FEATURES.includes(key), key);
  }
  assert.ok(!DISABLED_FEATURES.includes('apply_patch_freeform'), 'снятый ключ не используется');
});
