'use strict';

/* Доверенный статический каталог моделей.

   Зачем: метаданные модели способны вернуть инструменты мимо флагов конфигурации.
   В закреплённом наборе 0.154.0 у gpt-6-astra и gpt-5.6-* стоит tool_mode="code_mode_only",
   а astra ещё и объявляет clock и send_user_message_async. Один только [features] это не снимает
   (core/src/tools/mod.rs:68: model_info.tool_mode перекрывает флаги code-mode).

   Как закрывается: config-ключ model_catalog_json подменяет менеджер моделей на статический,
   который не подмешивает удалённый каталог (model-provider/src/provider.rs:450,
   models-manager/src/manager.rs:519,556,584).

   Модель НЕ выдумывается. Каталог собирается из официального встроенного набора самого
   закреплённого бинаря командой `codex debug models --bundled` (cli/src/main.rs:2383 —
   bundled_models_response, без сети и авторизации), затем у выбранной реальной записи
   ограничиваются только поля возможностей. Слаг, инструкции, контекст, тарифы и всё
   остальное сохраняются как есть, поэтому право доступа подписки не подделывается.

   Схема ModelInfo сверена с codex-rs/protocol/src/openai_models.rs:400 тега rust-v0.154.0. */

const crypto = require('node:crypto');

/* Реальные слаги из встроенного набора 0.154.0 без переопределения tool_mode
   и без экспериментальных инструментов. Порядок — предпочтение при сборке. */
const APPROVED_SLUGS = Object.freeze(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']);

/* Поля возможностей, которые мы перезаписываем. Значения выбраны так, чтобы
   набор инструментов был пустым, а не «почти пустым». */
const CAPABILITY_RESTRICTIONS = Object.freeze({
  tool_mode: 'direct',
  shell_type: 'disabled',
  apply_patch_tool_type: null,
  experimental_supported_tools: [],
  node_repl_disabled: true,
  node_repl_auto_review_required: false,
  supports_search_tool: false,
  supports_experimental_context: false,
  include_skills_usage_instructions: false,
  include_plugin_usage_instructions: false,
  include_apps_usage_instructions: false,
  multi_agent_version: null,
});

/* Обязательные ключи ModelInfo без serde-умолчаний: отсутствие любого из них — отказ разбора. */
const REQUIRED_KEYS = Object.freeze([
  'slug',
  'display_name',
  'description',
  'supported_reasoning_levels',
  'shell_type',
  'visibility',
  'supported_in_api',
  'priority',
  'availability_nux',
  'upgrade',
  'support_verbosity',
  'default_verbosity',
  'apply_patch_tool_type',
  'truncation_policy',
  'experimental_supported_tools',
]);

function hasInstructions(entry) {
  if (typeof entry.base_instructions === 'string' && entry.base_instructions.length > 0) return true;
  const template = entry.model_messages && entry.model_messages.instructions_template;
  return typeof template === 'string' && template.length > 0;
}

function parseBundled(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('встроенный каталог моделей не разобран как JSON');
  }
  if (!parsed || !Array.isArray(parsed.models) || parsed.models.length === 0) {
    throw new Error('встроенный каталог моделей пуст');
  }
  return parsed;
}

function chooseSlug(models, preferredSlug) {
  const available = new Set(models.map((entry) => entry && entry.slug).filter(Boolean));
  if (preferredSlug) {
    if (!available.has(preferredSlug)) {
      throw new Error(`слаг ${JSON.stringify(preferredSlug)} отсутствует во встроенном каталоге`);
    }
    return preferredSlug;
  }
  const slug = APPROVED_SLUGS.find((candidate) => available.has(candidate));
  if (!slug) {
    throw new Error(`ни один из согласованных слагов не найден: ${APPROVED_SLUGS.join(', ')}`);
  }
  return slug;
}

/* Собирает ограниченный каталог из вывода `codex debug models --bundled`.
   Возвращает детерминированный текст: одинаковый бинарь даёт одинаковые байты. */
function buildRestrictedCatalog(bundledText, options = {}) {
  const bundled = parseBundled(bundledText);
  const slug = chooseSlug(bundled.models, options.preferredSlug || null);
  const source = bundled.models.find((entry) => entry.slug === slug);
  const entry = JSON.parse(JSON.stringify(source));

  for (const key of REQUIRED_KEYS) {
    if (!Object.hasOwn(entry, key)) {
      throw new Error(`во встроенной записи ${slug} нет обязательного поля ${key}`);
    }
  }
  if (!hasInstructions(entry)) {
    throw new Error(`во встроенной записи ${slug} нет base_instructions и instructions_template`);
  }

  Object.assign(entry, CAPABILITY_RESTRICTIONS);
  // Описание асинхронного пользовательского инструмента больше не нужно: сам инструмент снят.
  if (entry.model_messages && entry.model_messages.tools) entry.model_messages.tools = null;

  const catalogText = `${JSON.stringify({models: [entry]}, null, 2)}\n`;
  return {
    slug,
    catalogText,
    sha256: crypto.createHash('sha256').update(catalogText).digest('hex'),
    sourceToolMode: source.tool_mode ?? null,
    sourceExperimentalTools: Array.isArray(source.experimental_supported_tools)
      ? [...source.experimental_supported_tools]
      : [],
  };
}

/* Строгая проверка уже собранного каталога. Рантайм отказывается стартовать при любом отклонении. */
function validateRestrictedCatalog(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {ok: false, reason: 'catalog_unparsable'};
  }
  if (!parsed || !Array.isArray(parsed.models)) return {ok: false, reason: 'catalog_shape_invalid'};
  if (parsed.models.length !== 1) return {ok: false, reason: 'catalog_not_single_model'};

  const entry = parsed.models[0];
  if (!entry || typeof entry !== 'object') return {ok: false, reason: 'catalog_entry_invalid'};
  if (typeof entry.slug !== 'string' || !entry.slug) return {ok: false, reason: 'catalog_slug_missing'};
  for (const key of REQUIRED_KEYS) {
    if (!Object.hasOwn(entry, key)) return {ok: false, reason: `catalog_missing_${key}`};
  }
  if (!hasInstructions(entry)) return {ok: false, reason: 'catalog_instructions_missing'};

  if (entry.tool_mode !== 'direct') return {ok: false, reason: 'catalog_tool_mode'};
  if (entry.shell_type !== 'disabled') return {ok: false, reason: 'catalog_shell_type'};
  if (entry.apply_patch_tool_type !== null) return {ok: false, reason: 'catalog_apply_patch'};
  if (!Array.isArray(entry.experimental_supported_tools) || entry.experimental_supported_tools.length !== 0) {
    return {ok: false, reason: 'catalog_experimental_tools'};
  }
  if (entry.node_repl_disabled !== true) return {ok: false, reason: 'catalog_node_repl'};
  if (entry.supports_search_tool !== false) return {ok: false, reason: 'catalog_search_tool'};
  if (entry.include_skills_usage_instructions !== false) return {ok: false, reason: 'catalog_skills_instructions'};
  if (entry.include_plugin_usage_instructions !== false) return {ok: false, reason: 'catalog_plugin_instructions'};
  if (entry.include_apps_usage_instructions !== false) return {ok: false, reason: 'catalog_apps_instructions'};
  if (entry.multi_agent_version != null) return {ok: false, reason: 'catalog_multi_agent'};

  return {ok: true, reason: 'catalog_ok', slug: entry.slug, sha256: crypto.createHash('sha256').update(text).digest('hex')};
}

module.exports = {
  APPROVED_SLUGS,
  CAPABILITY_RESTRICTIONS,
  REQUIRED_KEYS,
  buildRestrictedCatalog,
  validateRestrictedCatalog,
};
