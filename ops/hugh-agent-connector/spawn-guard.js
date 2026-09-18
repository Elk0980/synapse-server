'use strict';

/* ЧТО ЭТОТ МОДУЛЬ ПРОВЕРЯЕТ И ЧЕГО ОН НЕ ДОКАЗЫВАЕТ.

   Проверяется ровно одно: как коннектор ЗАПУСКАЕТ дочерний процесс ИИ.
   Это НЕ доказательство изоляции инструментов самой модели и не заменяет его.
   Внешний интерактивный ИИ (Claude, Codex, любой агентский CLI) может иметь собственные
   shell, файловый доступ, браузер и MCP — ни stdin-JSON, ни наш запретный список аргументов
   этого не отменяют. Поэтому результат этого модуля НИКОГДА не превращается
   в safety.toolIsolationVerified: см. policy.js, где это поле жёстко равно false.

   Настоящий proof в этом репозитории делает ops/hugh-runtime/isolation-check.js —
   он гоняет реальный бинарь Codex с канарейками, попыткой навязать вызов инструмента
   и попыткой утечки. Воспроизвести его для произвольного внешнего ИИ коннектор не может
   и не имитирует.

   Проверяемые факты запуска:
   1. процесс запускается без оболочки (shell:false), аргументами-массивом — подстановки нет;
   2. рабочий каталог — отдельный пустой каталог коннектора, а не репозиторий и не дом пользователя.
      Это НЕ песочница: права процесса остаются правами пользователя, и агент при желании читает
      и пишет любые доступные этому пользователю файлы по абсолютным путям. Отдельный каталог
      меняет только то, что агент видит «под рукой», и ничего не запрещает;
   3. окружение собрано с нуля: только имена из envPassthrough и секреты из secretEnvFrom;
      ключ сервера, cookies и токен бота в дочерний процесс через окружение не передаются
      (файлы на диске этим не защищены — см. пункт 2);
   4. в аргументах нет флагов из запретного списка — тех, что включают инструменты,
      правку файлов, MCP или снятие подтверждений;
   5. вывод ограничен по размеру и времени, дочерний процесс убивается по таймауту.

   Невыполненный факт — причина отказаться запускать агента вообще. Выполненные факты
   не дают права отвечать клиентам: это решает серверная политика. */

const path = require('node:path');

/* Запретный список: подстроки аргументов, которые дают агенту инструменты или снимают подтверждения.
   Сравнение по нижнему регистру и по подстроке — чтобы не обойти его формой --flag=value. */
const FORBIDDEN_ARG_PARTS = Object.freeze([
  '--dangerously', '--yolo', '--mcp', 'mcp-config', '--allowedtools', '--allowed-tools',
  '--allow-tools', '--enable-tools', '--tools', '--permission-mode', 'acceptedits', 'bypasspermissions',
  '--allow-all', '--auto-approve', '--sandbox=danger', 'danger-full-access', '--full-auto',
  '--add-dir', '--cwd', '--exec', '--shell',
]);

/* Имена окружения, которые нельзя пробрасывать: ключ сервера и всё, что похоже на секрет чужого
   назначения. Секреты агента задаются только через secretEnvFrom (файл), не через passthrough. */
const FORBIDDEN_ENV_NAMES = Object.freeze([
  'HUGH_LOCAL_WORKER_KEY', 'HUGH_WORKER_KEY', 'BOT_TOKEN', 'TELEGRAM_BOT_TOKEN', 'SESSION', 'COOKIE',
]);

const REASON = Object.freeze({
  ok: '',
  forbidden_argument: 'forbidden_argument',
  forbidden_env: 'forbidden_env',
  workdir_unsafe: 'workdir_unsafe',
  no_timeout: 'no_timeout',
  no_output_limit: 'no_output_limit',
  shell_enabled: 'shell_enabled',
});

const lower = (value) => String(value ?? '').toLowerCase();

function checkArguments(args) {
  for (const arg of Array.isArray(args) ? args : []) {
    const text = lower(arg);
    for (const part of FORBIDDEN_ARG_PARTS) if (text.includes(part)) return { ok: false, offender: part };
  }
  return { ok: true, offender: '' };
}

function checkEnvNames(names) {
  for (const name of Array.isArray(names) ? names : []) {
    const text = String(name ?? '').toUpperCase();
    for (const forbidden of FORBIDDEN_ENV_NAMES) if (text.includes(forbidden)) return { ok: false, offender: forbidden };
  }
  return { ok: true, offender: '' };
}

/* Рабочий каталог обязан лежать внутри каталога состояния коннектора и не совпадать с ним.
   Это гигиена запуска, а не ограничение прав: процесс по-прежнему работает от имени пользователя. */
function checkWorkdir(workdir, stateDir) {
  const resolved = path.resolve(String(workdir || ''));
  const base = path.resolve(String(stateDir || ''));
  if (!resolved || !base) return false;
  const inside = resolved.startsWith(base + path.sep);
  return inside && resolved !== base;
}

/* Возвращает {verified, reason, facts} по конфигурации запуска. Ничего не запускает. */
function inspectSpawn(plan) {
  const facts = {
    shell: plan.shell === false,
    workdir: checkWorkdir(plan.workdir, plan.stateDir),
    timeout: Number.isFinite(plan.timeoutMs) && plan.timeoutMs > 0,
    outputLimit: Number.isFinite(plan.maxOutputBytes) && plan.maxOutputBytes > 0,
    args: checkArguments(plan.args),
    env: checkEnvNames(plan.envNames),
  };
  if (!facts.shell) return { safe: false, reason: REASON.shell_enabled, facts };
  if (!facts.workdir) return { safe: false, reason: REASON.workdir_unsafe, facts };
  if (!facts.timeout) return { safe: false, reason: REASON.no_timeout, facts };
  if (!facts.outputLimit) return { safe: false, reason: REASON.no_output_limit, facts };
  if (!facts.args.ok) return { safe: false, reason: REASON.forbidden_argument, facts };
  if (!facts.env.ok) return { safe: false, reason: REASON.forbidden_env, facts };
  return { safe: true, reason: REASON.ok, facts };
}

module.exports = { FORBIDDEN_ARG_PARTS, FORBIDDEN_ENV_NAMES, REASON, inspectSpawn, checkArguments, checkEnvNames, checkWorkdir };
