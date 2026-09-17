'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {buildRestrictedCatalog, validateRestrictedCatalog, APPROVED_SLUGS, REQUIRED_KEYS} = require('./model-catalog');

/* Форма записи повторяет ModelInfo из codex-rs/protocol/src/openai_models.rs:400.
   Это тестовая заготовка формы, а не «своя модель»: сборка всегда берёт настоящую запись
   из `codex debug models --bundled`. */
function entry(slug, overrides = {}) {
  return {
    slug,
    display_name: slug.toUpperCase(),
    description: 'Тестовое описание.',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [{effort: 'medium', description: 'Обычный режим'}],
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: 10,
    availability_nux: null,
    upgrade: null,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: 'freeform',
    truncation_policy: {mode: 'tokens', limit: 10000},
    experimental_supported_tools: ['clock', 'send_user_message_async'],
    supports_search_tool: true,
    node_repl_disabled: false,
    include_skills_usage_instructions: true,
    include_plugin_usage_instructions: true,
    include_apps_usage_instructions: true,
    tool_mode: 'code_mode_only',
    multi_agent_version: 'v2',
    context_window: 400000,
    base_instructions: 'Ты Codex.',
    model_messages: {instructions_template: 'Ты Codex.', tools: {send_user_message_async: {description: 'x'}}},
    ...overrides,
  };
}

const bundled = (models) => JSON.stringify({models});

test('ограничения снимают все опасные возможности реальной записи', () => {
  const result = buildRestrictedCatalog(bundled([entry('gpt-6-astra'), entry('gpt-5.5')]));
  assert.equal(result.slug, 'gpt-5.5', 'выбран согласованный слаг, а не первый попавшийся');
  assert.equal(result.sourceToolMode, 'code_mode_only');
  assert.deepEqual(result.sourceExperimentalTools, ['clock', 'send_user_message_async']);

  const model = JSON.parse(result.catalogText).models[0];
  assert.equal(model.slug, 'gpt-5.5', 'слаг реальной модели сохранён');
  assert.equal(model.tool_mode, 'direct');
  assert.equal(model.shell_type, 'disabled');
  assert.equal(model.apply_patch_tool_type, null);
  assert.deepEqual(model.experimental_supported_tools, []);
  assert.equal(model.node_repl_disabled, true);
  assert.equal(model.supports_search_tool, false);
  assert.equal(model.include_skills_usage_instructions, false);
  assert.equal(model.include_plugin_usage_instructions, false);
  assert.equal(model.include_apps_usage_instructions, false);
  assert.equal(model.multi_agent_version, null);
  assert.equal(model.model_messages.tools, null);
});

test('право доступа и метаданные подписки сохраняются без изменений', () => {
  const source = entry('gpt-5.5');
  const model = JSON.parse(buildRestrictedCatalog(bundled([source])).catalogText).models[0];
  for (const key of ['slug', 'display_name', 'description', 'supported_reasoning_levels', 'visibility', 'supported_in_api', 'priority', 'truncation_policy', 'context_window', 'base_instructions']) {
    assert.deepEqual(model[key], source[key], `поле ${key} не должно меняться`);
  }
  assert.equal(model.model_messages.instructions_template, 'Ты Codex.');
});

test('сборка детерминирована: одинаковый вход даёт одинаковые байты', () => {
  const first = buildRestrictedCatalog(bundled([entry('gpt-5.5')]));
  const second = buildRestrictedCatalog(bundled([entry('gpt-5.5')]));
  assert.equal(first.catalogText, second.catalogText);
  assert.equal(first.sha256, second.sha256);
});

test('явный слаг обязан присутствовать во встроенном наборе', () => {
  assert.equal(buildRestrictedCatalog(bundled([entry('gpt-5.4')]), {preferredSlug: 'gpt-5.4'}).slug, 'gpt-5.4');
  assert.throws(() => buildRestrictedCatalog(bundled([entry('gpt-5.5')]), {preferredSlug: 'выдуманная'}), /отсутствует/);
});

test('без согласованных слагов сборка падает, а не выдумывает модель', () => {
  assert.throws(() => buildRestrictedCatalog(bundled([entry('gpt-6-astra')])), /согласованных слагов/);
  assert.ok(APPROVED_SLUGS.length > 0);
});

test('неполная запись и пустой набор отклоняются', () => {
  assert.throws(() => buildRestrictedCatalog('не json'), /не разобран/);
  assert.throws(() => buildRestrictedCatalog(bundled([])), /пуст/);
  const broken = entry('gpt-5.5');
  delete broken.truncation_policy;
  assert.throws(() => buildRestrictedCatalog(bundled([broken])), /truncation_policy/);
  const noInstructions = entry('gpt-5.5', {base_instructions: '', model_messages: null});
  assert.throws(() => buildRestrictedCatalog(bundled([noInstructions])), /instructions_template/);
});

test('проверка собранного каталога ловит любое послабление', () => {
  const good = buildRestrictedCatalog(bundled([entry('gpt-5.5')])).catalogText;
  const checked = validateRestrictedCatalog(good);
  assert.equal(checked.ok, true);
  assert.equal(checked.slug, 'gpt-5.5');

  const tamper = (mutate) => {
    const parsed = JSON.parse(good);
    mutate(parsed.models[0], parsed);
    return validateRestrictedCatalog(JSON.stringify(parsed)).reason;
  };
  assert.equal(tamper((model) => {
    model.tool_mode = 'code_mode';
  }), 'catalog_tool_mode');
  assert.equal(tamper((model) => {
    model.shell_type = 'unified_exec';
  }), 'catalog_shell_type');
  assert.equal(tamper((model) => {
    model.apply_patch_tool_type = 'freeform';
  }), 'catalog_apply_patch');
  assert.equal(tamper((model) => {
    model.experimental_supported_tools = ['clock'];
  }), 'catalog_experimental_tools');
  assert.equal(tamper((model) => {
    model.node_repl_disabled = false;
  }), 'catalog_node_repl');
  assert.equal(tamper((model) => {
    model.supports_search_tool = true;
  }), 'catalog_search_tool');
  assert.equal(tamper((model) => {
    model.multi_agent_version = 'v2';
  }), 'catalog_multi_agent');
  assert.equal(tamper((model, parsed) => {
    parsed.models.push(model);
  }), 'catalog_not_single_model');
  assert.equal(validateRestrictedCatalog('{"models":[]}').reason, 'catalog_not_single_model');
  assert.equal(validateRestrictedCatalog('не json').reason, 'catalog_unparsable');
});

test('обязательные поля ModelInfo перечислены полностью', () => {
  for (const key of ['slug', 'shell_type', 'apply_patch_tool_type', 'truncation_policy', 'experimental_supported_tools', 'availability_nux', 'upgrade', 'default_verbosity', 'description']) {
    assert.ok(REQUIRED_KEYS.includes(key), key);
  }
});
