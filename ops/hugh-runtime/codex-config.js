'use strict';

/* Доверенная конфигурация Codex app-server для приватного рантайма Hugh.
   Всё, что ограничивает инструменты, собрано в «изоляционной» части: именно она попадает
   в отпечаток и должна совпадать между продакшеном и проверочным прогоном с mock-провайдером.
   Ключи сверены с официальной схемой codex-rs/core/config.schema.json тега rust-v0.154.0
   (коммит 6b9826e3aa83b1a5947db50f4332cb9c65f1b340). Ничего не выдумано.

   Важные подтверждения из исходников:
   - environments: [] убирает exec/write_stdin/apply_patch/view_image (core/src/tools/spec_plan.rs:1083, :1255, :1269);
   - tools.experimental_request_user_input по умолчанию ВКЛЮЧЁН (core/src/config/mod.rs:2651), поэтому выключаем явно;
   - tools.update_plan по умолчанию выключен, но фиксируем явно;
   - features.token_budget добавляет get_context_remaining (spec_plan.rs:1206);
   - features.current_time_reminder добавляет clock (spec_plan.rs:1217). */

const crypto = require('node:crypto');

const PINNED_CODEX_VERSION = '0.154.0';
const DEVICE_VERIFICATION_URL = 'https://auth.openai.com/codex/device';

/* Корневые скаляры обязаны идти до любых таблиц TOML, иначе они попадут внутрь таблицы. */
const ISOLATION_ROOT_LINES = Object.freeze([
  'approval_policy = "never"',
  'allow_login_shell = false',
  'check_for_update_on_startup = false',
  'sandbox_mode = "read-only"',
  'web_search = "disabled"',
]);

/* Перечислены только ключи, подтверждённые в config.schema.json 0.154.0.
   Снятый ключ apply_patch_freeform намеренно не используется: он устарел и ничего не защищает. */
const DISABLED_FEATURES = Object.freeze([
  'apps',
  'browser_use',
  'code_mode',
  'code_mode_host',
  'code_mode_only',
  'codex_hooks',
  'computer_use',
  'connectors',
  'context_management',
  'current_time_reminder',
  'deferred_executor',
  'enable_mcp_apps',
  'goals',
  'hooks',
  'image_generation',
  'in_app_browser',
  'memories',
  'memory_tool',
  'multi_agent',
  'multi_agent_v2',
  'plugins',
  'remote_plugin',
  'request_permissions_tool',
  'shell_tool',
  'skill_search',
  'sleep_tool',
  'token_budget',
  'tool_suggest',
  'unified_exec',
  'view_image',
  'web_search',
  'workspace_dependencies',
]);

/* Корневой секции [token_budget] в схеме 0.154.0 НЕТ — есть только features.token_budget.
   С --strict-config лишняя корневая таблица останавливает запуск, поэтому её здесь нет. */
const ISOLATION_TABLE_BLOCKS = Object.freeze([
  ['[mcp_servers]'],
  ['[analytics]', 'enabled = false'],
  ['[feedback]', 'enabled = false'],
  ['[history]', 'persistence = "none"'],
  ['[agents]', 'enabled = false'],
  ['[orchestrator.skills]', 'enabled = false'],
  ['[orchestrator.mcp]', 'enabled = false'],
  ['[skills]', 'include_instructions = false'],
  ['[skills.bundled]', 'enabled = false'],
  ['[tools.update_plan]', 'enabled = false'],
  ['[tools.experimental_request_user_input]', 'enabled = false'],
  ['[features]', ...DISABLED_FEATURES.map((key) => `${key} = false`)],
].map((block) => Object.freeze(block)));

/* Шаблон параметров thread/start без изменяемых полей (модель и cwd подставляются отдельно).
   allowProviderModelFallback выключен: подмена модели провайдером недопустима. */
const THREAD_PARAMS_TEMPLATE = Object.freeze({
  ephemeral: true,
  sandbox: 'read-only',
  approvalPolicy: 'never',
  allowProviderModelFallback: false,
  environments: [],
  dynamicTools: [],
  selectedCapabilityRoots: [],
  runtimeWorkspaceRoots: [],
});

const TURN_PARAMS_TEMPLATE = Object.freeze({
  environments: [],
  runtimeWorkspaceRoots: [],
  approvalPolicy: 'never',
});

function tomlString(value) {
  return JSON.stringify(String(value));
}

/* Собирает config.toml: сначала все корневые скаляры, затем таблицы. */
function buildConfigToml(options = {}) {
  const rootLines = [...ISOLATION_ROOT_LINES];
  const tableBlocks = ISOLATION_TABLE_BLOCKS.map((block) => [...block]);

  if (options.managedChatgptAuth !== false) {
    rootLines.push('cli_auth_credentials_store = "file"', 'forced_login_method = "chatgpt"');
  }
  if (options.modelCatalogPath) {
    rootLines.push(`model_catalog_json = ${tomlString(options.modelCatalogPath)}`);
  }
  if (options.modelProvider) {
    rootLines.push(`model_provider = ${tomlString(options.modelProvider)}`);
  }
  if (options.model) {
    rootLines.push(`model = ${tomlString(options.model)}`);
  }
  for (const [id, provider] of Object.entries(options.modelProviders || {})) {
    const block = [`[model_providers.${id}]`];
    for (const [key, value] of Object.entries(provider)) {
      const literal = typeof value === 'boolean' || typeof value === 'number' ? String(value) : tomlString(value);
      block.push(`${key} = ${literal}`);
    }
    tableBlocks.push(block);
  }

  rootLines.sort();
  const body = [
    '# Синапс: доверенная конфигурация приватного рантайма Hugh. Правки только через ops/hugh-runtime.',
    ...rootLines,
    '',
    ...tableBlocks.map((block) => `${block.join('\n')}\n`),
  ];
  return `${body.join('\n').trimEnd()}\n`;
}

/* Отпечаток покрывает ровно то, что определяет набор инструментов.
   Блок провайдера и способ авторизации сюда не входят: в проверочном прогоне они другие,
   а на состав инструментов не влияют. */
function isolationFingerprint(extra = {}) {
  const material = JSON.stringify({
    schema: 2,
    codexVersion: PINNED_CODEX_VERSION,
    rootLines: ISOLATION_ROOT_LINES,
    tableBlocks: ISOLATION_TABLE_BLOCKS,
    threadParams: THREAD_PARAMS_TEMPLATE,
    turnParams: TURN_PARAMS_TEMPLATE,
    modelCatalogSha256: extra.modelCatalogSha256 || null,
    model: extra.model || null,
  });
  return crypto.createHash('sha256').update(material).digest('hex');
}

module.exports = {
  PINNED_CODEX_VERSION,
  DEVICE_VERIFICATION_URL,
  DISABLED_FEATURES,
  ISOLATION_ROOT_LINES,
  ISOLATION_TABLE_BLOCKS,
  THREAD_PARAMS_TEMPLATE,
  TURN_PARAMS_TEMPLATE,
  buildConfigToml,
  isolationFingerprint,
};
