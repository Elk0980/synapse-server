'use strict';

const z = require('zod');
const short = z.string().trim().min(1).max(200);
const optionalName = z.string().trim().max(200);
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const project = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i);
const statuses = z.enum(['inbox', 'planned', 'in_progress', 'done', 'cancelled']);
const kinds = z.enum(['owner', 'claude', 'codex', 'gpt', 'gemini', 'hailuo']);
const states = z.enum(['work', 'wait', 'idle', 'unknown', 'error']);
const dueDate = z.union([z.literal(''), z.iso.date()]);
const links = z.array(z.strictObject({
  url:z.url().max(2000).refine(value => {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  }, 'Нужна HTTPS-ссылка без учётных данных'),
  label:z.string().max(200), kind:z.enum(['link', 'image', 'video'])
})).max(50);
const archiveModule = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const archiveLinks = z.array(z.strictObject({
  url:z.url().max(2000).refine(value => {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  }, 'Нужна HTTPS-ссылка без учётных данных'),
  label:z.string().max(200), kind:z.enum(['link', 'image', 'video', 'file'])
})).max(50);

const TOOLS = [
  ['tasks_list', 'Показать задачи разрешённых проектов с фильтрами; план дня рассчитывается по Asia/Bangkok.', {
    project:project.optional(), status:statuses.optional(), executor:short.optional(), parent_id:id.nullable().optional(),
    today:z.boolean().optional(), search:z.string().max(200).optional(), limit:z.number().int().min(1).max(100).optional(),
    offset:z.number().int().min(0).max(1000000).optional()
  }],
  ['task_get', 'Прочитать задачу, её подзадачи, комментарии и подтверждённые стадии координации. Большие списки возвращаются страницами.', {
    task_id:id, comments_limit:z.number().int().min(1).max(20).optional(),
    comments_offset:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    subtasks_limit:z.number().int().min(1).max(100).optional(),
    subtasks_offset:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
  }],
  ['task_create', 'Создать задачу в едином реестре CRM; повтор client_ref возвращает прежнюю запись без дубля.', {
    client_ref:short, title:short, description:z.string().max(10000).optional(), project,
    priority:z.enum(['low', 'normal', 'high', 'urgent']).optional(), due_date:dueDate.optional(),
    executor:optionalName.optional(), reviewer:optionalName.optional(), parent_id:id.nullable().optional(),
    source:z.enum(['claude', 'gpt', 'manual']).optional(), status:statuses.optional(), links:links.optional()
  }],
  ['task_update', 'Обновить задачу. Проверяющий отличается от исполнителя; стадия требует основания и даты проверки.', {
    task_id:id, status:statuses.optional(), stage:z.enum(['code', 'connected', 'verified', 'accepted']).optional(),
    evidence:z.string().trim().min(1).max(4000).optional(), checked_at:z.iso.datetime().optional(),
    executor:optionalName.optional(), reviewer:optionalName.optional(), due_date:dueDate.optional(),
    blocker:z.string().max(4000).optional(), next_step:z.string().max(4000).optional(), links:links.optional(),
    revision:z.number().int().min(0).optional()
  }],
  ['task_comment', 'Добавить неизменяемый комментарий к задаче от имени агента.', {
    task_id:id, author:short, text:z.string().trim().min(1).max(10000)
  }],
  ['agents_list', 'Показать вручную заявленные состояния агентов и их активные задачи; запись не доказывает запуск процесса.', {}],
  ['agent_report', 'Сообщить собственное состояние агента и последнее событие; автоматический запуск не выполняется.', {
    agent:short, kind:kinds.optional(), mode:z.enum(['permanent', 'periodic', 'event', 'once']).optional(),
    function:z.string().max(500).optional(), chat:z.string().max(500).optional(), state:states,
    last_event:z.string().trim().min(1).max(2000)
  }],
  ['agent_launch', 'Поставить локальную работу с кодом в dispatch для codex-code. Оркестратор обязан явно задать code_only:true и неизменяемую область allowed_paths. Только Owner и разрешённый проект; production/merge/deploy не разрешаются. Повтор client_ref не создаёт дубль.', {
    task_id:id,code_only:z.literal(true),allowed_paths:z.array(z.string().min(1).max(500)).min(1).max(100).refine(value => value.every(entry => {
      if (entry !== entry.trim() || entry.startsWith('/') || /[\x00-\x1f\x7f\\:*?\[\]{}]/.test(entry)) return false;
      return (entry.endsWith('/') ? entry.slice(0,-1) : entry).split('/').every(part => part && part !== '.' && part !== '..');
    }),'Нужны точные пути или префиксы каталогов без wildcard и выхода из репозитория'),
    executor_profile:z.literal('codex-code').optional(),client_ref:short.optional()
  }],
  ['agent_status', 'Прочитать состояние запуска, session_id и очищенный хвост технического журнала. Истёкшая аренда не доказывает остановку процесса.', {
    run_id:z.uuid()
  }],
  ['agent_message', 'Поставить продолжение в прежнем контексте и worktree после завершения turn. Только локальный код; production/merge/deploy запрещены.', {
    run_id:z.uuid(),text:z.string().trim().min(1).max(10000),client_ref:short.optional()
  }],
  ['agent_stop', 'Запросить остановку локального запуска. Живой процесс считается остановленным только после подтверждения его обработчика.', {
    run_id:z.uuid()
  }],
  ['agent_worker_claim', 'Локальному обработчику Owner: атомарно забрать локальный код из dispatch; максимум три живых или неизвестных процесса. Не перезапускает истёкшую аренду.', {
    worker_id:z.uuid()
  }],
  ['agent_worker_update', 'Локальному обработчику Owner: heartbeat, контекст и подтверждение завершения процесса. Сырые команды, секреты и клиентские данные в журнал не передавать.', {
    run_id:z.uuid(),worker_id:z.uuid(),lease_token:z.uuid(),
    event:z.enum(['heartbeat','started','complete','failed','stopped']),session_id:z.uuid().optional(),
    log_tail:z.string().max(8000).optional(),summary:z.string().max(4000).optional(),
    exit_code:z.number().int().min(-2147483648).max(2147483647).optional()
  }],
  ['session_start', 'Начать рабочую сессию: получить обязательные правила, карту документов под запрос и свои задачи.', {
    agent:short, kind:kinds, request:z.string().trim().min(1).max(4000)
  }],
  ['doc_read', 'Прочитать документ из утверждённой карты docs/handoff. Изменение документов запрещено.', {
    path:z.string().min(1).max(240)
  }],
  ['session_end', 'Завершить свою сессию, записать итог в журнал и обновить состояния задач.', {
    session_id:short, summary:z.string().trim().min(1).max(10000), state:states.optional(),
    statuses:z.array(z.strictObject({task_id:id, status:statuses})).max(100).optional()
  }],
  ['archive_list', 'Прочитать карточки модулей и журнал разрешённых проектов; каждое чтение учитывается в аудите.', {
    module:archiveModule.optional(), project:project.optional(), session_id:short.optional(),
    limit:z.number().int().min(1).max(100).optional(), offset:z.number().int().min(0).max(1000000).optional()
  }],
  ['archive_read', 'Прочитать неизменяемую запись архива; чтение записывается в аудит.', {
    id, session_id:short.optional()
  }],
  ['archive_write', 'Дописать запись в архив модуля от имени открытой сессии. Повтор client_ref не создаёт дубль; исправление — новая запись.', {
    session_id:short, client_ref:short, module:archiveModule, project,
    type:z.enum(['tried', 'succeeded', 'failed', 'report', 'decision', 'next_step']),
    text:z.string().trim().min(1).max(10000), links:archiveLinks.optional(),
    task_id:id.optional(), supersedes_id:id.optional()
  }]
].map(([name, description, shape]) => ({name, description, inputSchema:z.strictObject(shape)}));

const SESSION_RULES = [
  'До выполнения запроса прочитайте конституцию, DIRECTION и документы выданной карты. Канон правит постановщик.',
  'LIVE — фактически работает и проверено; QA — проверка; SAMPLE — образец; UNKNOWN — факт не подтверждён; BLOCKED — конкретный блокер.',
  'Исполнитель и проверяющий различаются (maker ≠ checker). Код, подключение, проверка и приёмка подтверждаются раздельно.',
  'Не раскрывайте секреты и клиентские данные CRM. Секреты не включаются в документы, комментарии и отчёты.',
  'Обновляйте задачи и своё состояние по ходу работы. После 60 минут без отчёта активная задача помечается «нет отчёта».',
  'Реестр agent_report — ручной учёт. agent_launch создаёт локальное поручение; фактический запуск подтверждается отдельным обработчиком. Только локальный код, PR без merge/deploy; разрешения Owner не расширяются.',
  'Архив модуля читайте через archive_list/read; результаты дописывайте через archive_write с session_id и уникальным client_ref. Исправление — новая запись с supersedes_id; файлы и секреты в Git не помещать.'
];

module.exports = {TOOLS, SESSION_RULES};
