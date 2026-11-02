'use strict';

const fs = require('node:fs/promises');
const {TOOLS} = require('./tools');
const {loadConfig, crmClient} = require('./server');
const fail = message => { throw new Error(message); };
const schema = name => TOOLS.find(tool => tool.name === name).inputSchema;
const statuses = new Set(['inbox', 'planned', 'in_progress', 'done', 'cancelled']);

function validateSeed(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['agents', 'tasks'].includes(key)) ||
      !Array.isArray(input.tasks) || input.tasks.length > 500 ||
      !Array.isArray(input.agents) || input.agents.length > 100) fail('Нужен JSON с массивами agents и tasks');
  const agents = input.agents.map(agent => schema('agent_report').parse(agent));
  if (new Set(agents.map(agent => agent.agent.toLocaleLowerCase('ru'))).size !== agents.length) fail('Имена агентов в seed повторяются');
  const tasks = input.tasks.map(task => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) fail('Некорректная задача seed');
    const {parent_ref, status = 'inbox', idea = false, ...create} = task;
    const parsed = schema('task_create').parse(create);
    if (typeof idea !== 'boolean' || !statuses.has(status)) fail('Некорректный статус seed');
    if (parent_ref !== undefined && (typeof parent_ref !== 'string' || !parent_ref.trim() || parent_ref.length > 200 || parsed.parent_id != null)) {
      fail('Укажите только один способ связи с родительской задачей');
    }
    if (parsed.executor && parsed.reviewer && parsed.executor.trim().toLocaleLowerCase('ru') === parsed.reviewer.trim().toLocaleLowerCase('ru')) {
      fail('Исполнитель и проверяющий должны различаться');
    }
    return {...parsed, parent_ref, status:idea ? 'inbox' : status};
  });
  const refs = new Map(tasks.map(task => [task.client_ref, task]));
  if (refs.size !== tasks.length) fail('client_ref в seed повторяются');
  for (const task of tasks) {
    if (!task.parent_ref) continue;
    const parent = refs.get(task.parent_ref);
    if (!parent || parent === task || parent.parent_ref || parent.parent_id || parent.project.toLowerCase() !== task.project.toLowerCase()) {
      fail('Родитель seed должен существовать в той же компании; разрешён один уровень подзадач');
    }
  }
  return {agents, tasks:[...tasks.filter(task => !task.parent_ref), ...tasks.filter(task => task.parent_ref)]};
}

async function importSeed(input, call) {
  // Весь файл проверяется до первого обращения с записью к CRM.
  const {agents, tasks} = validateSeed(input);
  const ids = new Map();
  const outcome = {created:0, existing:0, agents:0};
  for (const task of tasks) {
    const {parent_ref, ...create} = task;
    if (parent_ref) create.parent_id = ids.get(parent_ref);
    const result = await call('task_create', create);
    ids.set(task.client_ref, result.task.id);
    if (result.created) outcome.created++;
    else outcome.existing++;
  }
  // Повтор импорта не перезаписывает состояние существующих агентов.
  const existing = await call('agents_list', {});
  const names = new Set(existing.agents.map(agent => agent.name.toLocaleLowerCase('ru')));
  for (const agent of agents) {
    if (names.has(agent.agent.toLocaleLowerCase('ru'))) continue;
    await call('agent_report', agent);
    names.add(agent.agent.toLocaleLowerCase('ru'));
    outcome.agents++;
  }
  return outcome;
}

if (require.main === module) {
  (async () => {
    const file = process.argv[2];
    if (!file) fail('Укажите файл seed JSON, предоставленный постановщиком');
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) fail('Seed должен быть JSON-файлом не больше 2 MiB');
    const input = JSON.parse(await fs.readFile(file, 'utf8'));
    validateSeed(input);
    const config = loadConfig();
    const allowed = new Set([...config.projects, 'synapse', 'synapse-business']);
    if (input.tasks.some(task => !allowed.has(task.project.toLowerCase()))) fail('Seed содержит неразрешённый проект');
    process.stdout.write(JSON.stringify(await importSeed(input, crmClient(config))) + '\n');
  })().catch(() => {
    // Содержимое файла, сетевой адрес и исключения могут содержать частные сведения.
    process.stderr.write('Импорт не завершён. Проверьте seed, доступ CRM и конфигурацию. Повтор по client_ref не создаёт дублей.\n');
    process.exitCode = 1;
  });
}

module.exports = {validateSeed, importSeed};
