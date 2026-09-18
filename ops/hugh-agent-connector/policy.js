'use strict';

/* Политика честного статуса. Здесь решается, что коннектор имеет право сказать серверу о себе.

   ДВА ОГРАНИЧЕНИЯ, ЗАЛОЖЕННЫЕ В КОД, А НЕ В ДОГОВОРЁННОСТЬ:

   1. safety.toolIsolationVerified у этого коннектора ВСЕГДА false. Настройки, которая делала бы
      его true, нет и не должно появиться: подтвердить изоляцию инструментов внешнего
      интерактивного ИИ коннектор не может, а поддельное подтверждение открыло бы клиентский
      чат агенту с shell и браузером. Режим изолированного Codex этим не ослабляется:
      там по-прежнему нужен настоящий proof из ops/hugh-runtime/isolation-check.js.

   2. authenticated ВСЕГДА false. Успешная проба (`--version`) и непустой файл секрета не
      доказывают, что модель вошла в свою подписку: это разные вещи. Вместо ложного
      authenticated коннектор заявляет готовность отдельным полем readiness='attested' —
      «исполнитель ручается, что может подготовить ответ». Проверяемые основания этой заявки:
      проба процесса завершилась кодом 0, файлы секретов на месте и непусты, запуск прошёл
      spawn-guard. Чем она НЕ является: подтверждением входа модели и изоляции её инструментов.

   Разрешение отвечать даёт только сервер: компания должна быть названа в
   HUGH_TRUSTED_AGENT_COMPANIES. Поля trustedAgent и readiness сами по себе ничего не включают.

   Что коннектор сообщает честно:
   - authenticated: всегда false; вход в модель этой проверкой не подтверждается;
   - connected: последняя проба прошла;
   - available: есть маршрут на компанию и запуск агента прошёл проверку spawn-guard;
   - provider/model: из конфигурации или из ответа агента, пустая строка при неизвестной модели;
   - state: одно из значений закрытого списка сервера.

   Про вход (kind='login'): это устройство-логин Codex, адрес зашит регуляркой сервера
   (LOGIN_URL в project-chat-local-worker.js). Коннектор такие задания НЕ выполняет
   и отвечает отказом UNAVAILABLE, не присылая ни loginUrl, ни userCode. */

const SAFETY_REASON = 'external_agent_unproven';
const READINESS_ATTESTED = 'attested';

function agentStatus(probe) {
  const credentialsOk = Boolean(probe?.credentials?.ok);
  const spawnOk = Boolean(probe?.spawnGuard?.safe);
  const ok = Boolean(probe?.ok) && credentialsOk && spawnOk;
  return { ok, credentialsOk, spawnOk };
}

/* Собирает status для heartbeat. Никаких полей сверх закрытого списка publicStatus сервера. */
function buildStatus({ probe, agent }) {
  const view = agentStatus(probe);
  // Локальная готовность не заменяет разрешение сервера для компании.
  const state = !view.spawnOk ? 'error'
    : !view.credentialsOk ? 'unavailable'
      : view.ok ? 'connected' : 'unavailable';
  return {
    state,
    // Вход модели коннектор не подтверждает и не выдумывает: см. пункт 2 выше.
    authenticated: false,
    connected: Boolean(probe?.ok),
    // Готов запускать агента. Разрешение отвечать клиентам всё равно даёт сервер.
    available: view.ok,
    limited: false,
    retryAfter: 0,
    provider: agent?.provider || '',
    model: agent?.model || '',
    safety: { toolIsolationVerified: false, reason: SAFETY_REASON },
    trustedAgent: true,
    readiness: view.ok ? 'attested' : '',
    errorCode: view.ok ? '' : 'UNAVAILABLE',
  };
}

/* Поля, которые сервер всё равно отбросит, лучше не отправлять: убираем undefined. */
function cleanStatus(status) {
  return Object.fromEntries(Object.entries(status).filter(([, value]) => value !== undefined));
}

module.exports = { SAFETY_REASON, READINESS_ATTESTED, buildStatus: (args) => cleanStatus(buildStatus(args)), agentStatus };
