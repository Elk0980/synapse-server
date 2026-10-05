'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBot } = require('./bot');

const OWNER = 123456;
function task(overrides = {}) {
  return { id: '71', title: 'Проверить макет', companyCode: 'synapse', companyName: 'Synapse',
    status: 'planned', dueAt: '2026-10-02', nextAction: 'Открыть текущую версию', blocker: '',
    waitingForOwner: false, ...overrides };
}
function harness(options = {}) {
  let serial = 1;
  const h = { tasks: options.tasks || [task()], reads: 0, events: [],
    instant: options.instant || '2026-10-02T12:00:00.000Z', fail: false };
  h.bot = createBot({ ownerUserId: String(OWNER), timeZone: options.timeZone || 'Etc/UTC',
    now: () => h.instant,
    source: { async listTasks() {
      h.reads += 1;
      if (h.fail) throw new Error('DO_NOT_LEAK_PRIVATE_SOURCE_ERROR');
      return h.tasks;
    } },
    audit: event => { h.events.push(event); }, ...options.config }).handleUpdate;
  h.message = (text = '/tasks', changes = {}) => ({ update_id: serial++, message: {
    message_id: 10, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, text, ...changes } });
  h.callback = (data, changes = {}) => ({ update_id: serial++, callback_query: {
    id: `callback-${serial}`, from: { id: OWNER }, data,
    message: { message_id: 10, chat: { id: OWNER, type: 'private' } }, ...changes } });
  h.start = () => h.bot(h.message('/start'));
  h.click = (actions, label) => h.bot(h.callback(findButton(actions, label).callback_data));
  return h;
}
function output(actions) {
  const result = actions.find(action => action.method === 'sendMessage' || action.method === 'editMessageText');
  assert.ok(result, 'Expected a rendered Telegram message');
  return result.params;
}
function buttons(actions) { return output(actions).reply_markup.inline_keyboard.flat(); }
function findButton(actions, label) {
  const found = buttons(actions).find(button => button.text === label || button.text.startsWith(label)
    || button.text.replace(/^\d+\.\s/, '').startsWith(label));
  assert.ok(found, `Missing button ${label}`);
  return found;
}

test('requires a numeric owner, source and explicit valid timezone', () => {
  const base = { ownerUserId: OWNER, source: { listTasks: async () => [] }, timeZone: 'Etc/UTC' };
  for (const ownerUserId of [undefined, null, '', '0123', 'owner-name', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createBot({ ...base, ownerUserId }));
  }
  assert.throws(() => createBot({ ...base, source: {} }));
  assert.throws(() => createBot({ ...base, timeZone: 'Somewhere/Unknown' }));
  assert.throws(() => createBot({ ...base, timeZone: '' }));
  assert.doesNotThrow(() => createBot({ ...base, ownerUserId: String(OWNER) }));
});

test('home exposes the four read-only CRM views and only the exact public cabinet URL', async () => {
  const h = harness();
  const actions = await h.start();
  assert.equal(h.reads, 1);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].method, 'sendMessage');
  assert.equal(output(actions).chat_id, OWNER);
  assert.match(output(actions).text, /Eva · SynapseBusiness/);
  assert.match(output(actions).text, /Источник: задачи CRM Synapse/);
  assert.match(output(actions).text, /ещё не связанные задачи/);
  assert.deepEqual(buttons(actions).filter(button => button.callback_data).map(button => button.text.split(' · ')[0]),
    ['Сегодня', 'Проекты', 'Все задачи', 'Ждут меня']);
  for (const button of buttons(actions)) {
    if (button.callback_data) assert.deepEqual(Object.keys(button), ['text', 'callback_data']);
    else assert.deepEqual(button, { text: 'Открыть кабинет', url: 'https://synapse.synapsebusiness.ru/cabinet.html#tasks' });
  }
  assert.equal(output(actions).parse_mode, undefined);
  assert.deepEqual(output(actions).link_preview_options, { is_disabled: true });
});

test('each message fails closed for spoofed, missing, non-private and mismatched identities', async () => {
  const h = harness();
  const variants = [
    { from: { id: OWNER + 1 } }, { from: null }, { from: { id: String(OWNER) } },
    { chat: { id: OWNER, type: 'group' } }, { chat: { id: -OWNER, type: 'supergroup' } },
    { chat: { id: OWNER + 1, type: 'private' } }, { chat: { id: String(OWNER), type: 'private' } },
    { chat: null }, { message_id: 0 }, { forward_origin: { type: 'user' } },
  ];
  for (const variant of variants) assert.deepEqual(await h.bot(h.message('/tasks', variant)), []);
  assert.equal(h.reads, 0);
  assert.ok(h.events.every(event => event === 'access_denied'));
});

test('unsupported or malformed updates do not query tasks', async () => {
  const h = harness();
  for (const update of [null, {}, { update_id: '1' }, { update_id: -1 }, { update_id: 1.5 },
    h.message('ordinary text'), h.message('/unknown'), h.message(null)]) {
    assert.deepEqual(await h.bot(update), []);
  }
  assert.equal(h.reads, 0);
  assert.ok((await h.bot(h.message('/tasks@SynapseBusinessEvaBot'))).length);
  assert.ok((await h.bot(h.message('/start entry'))).length);
});

test('every callback revalidates owner and private chat, including forwarded and inline forms', async () => {
  const h = harness();
  const data = findButton(await h.start(), 'Все задачи').callback_data;
  const variants = [
    { from: { id: OWNER + 1 } }, { from: null }, { from: { id: String(OWNER) } },
    { message: { message_id: 10, chat: { id: OWNER, type: 'group' } } },
    { message: { message_id: 10, chat: { id: OWNER + 1, type: 'private' } } },
    { message: { message_id: 10, chat: { id: String(OWNER), type: 'private' } } },
    { message: { message_id: 0, chat: { id: OWNER, type: 'private' } } },
    { message: { message_id: 10, chat: { id: OWNER, type: 'private' }, forward_origin: { type: 'user' } } },
    { message: { message_id: 10, chat: { id: OWNER, type: 'private' }, forward_date: 1700000000 } },
    { message: null, inline_message_id: 'inline' }, { inline_message_id: 'inline' },
    { id: '' }, { id: null },
  ];
  for (const variant of variants) assert.deepEqual(await h.bot(h.callback(data, variant)), []);
  assert.equal(h.reads, 1);
});

test('forged, oversized and malformed callback data never reach the task source', async () => {
  const h = harness();
  await h.start();
  for (const data of ['eva:abcdefghijklmnop', 'task:71', 'eva:../tasks/71', 'eva:' + 'a'.repeat(70),
    'eva:' + 'Ж'.repeat(16), null, { task: 71 }]) {
    const actions = await h.bot(h.callback(data));
    assert.equal(actions.length, 1);
    assert.equal(actions[0].method, 'answerCallbackQuery');
    assert.equal(actions[0].params.show_alert, true);
    assert.match(actions[0].params.text, /устарела или недействительна/);
  }
  assert.equal(h.reads, 1);
});

test('expired and previous-process buttons are safely rejected', async () => {
  const h = harness();
  const data = findButton(await h.start(), 'Сегодня').callback_data;
  const other = harness();
  assert.match((await other.bot(other.callback(data)))[0].params.text, /недействительна/);
  assert.equal(other.reads, 0);
  h.instant = '2026-10-02T12:30:00.000Z';
  assert.match((await h.bot(h.callback(data)))[0].params.text, /устарела/);
  assert.equal(h.reads, 1);
});

test('today includes overdue and local-today open tasks and respects timezone for timestamps', async () => {
  const h = harness({ instant: '2026-10-02T16:30:00Z', timeZone: 'Asia/Irkutsk', tasks: [
    task({ id: '1', title: 'Просроченная', dueAt: '2026-10-02' }),
    task({ id: '2', title: 'Местное сегодня', dueAt: '2026-10-03' }),
    task({ id: '3', title: 'ISO сегодня', dueAt: '2026-10-02T18:00:00Z' }),
    task({ id: '4', title: 'Завтра', dueAt: '2026-10-04' }),
    task({ id: '5', title: 'Готово', status: 'done' }),
    task({ id: '6', title: 'Отменено', status: 'cancelled' }),
    task({ id: '7', title: 'Нет даты', dueAt: '' }),
    task({ id: '8', title: 'Невозможная дата', dueAt: '2026-02-30' }),
    task({ id: '9', title: 'Неявная зона', dueAt: '2026-10-02T12:00:00' }),
  ] });
  const actions = await h.click(await h.start(), 'Сегодня');
  const rendered = output(actions).text;
  assert.match(rendered, /2026-10-03 · Asia\/Irkutsk/);
  assert.match(rendered, /2026-10-02 · просрочена/);
  assert.match(rendered, /Местное сегодня/);
  assert.match(rendered, /ISO сегодня/);
  assert.match(rendered, /Всего: 3/);
  for (const title of ['Завтра', 'Готово', 'Отменено', 'Нет даты', 'Невозможная дата', 'Неявная зона']) {
    assert.ok(!rendered.includes(title));
  }
});

test('date-only deadlines are calendar days, not UTC instants', async () => {
  const h = harness({ instant: '2026-10-03T01:00:00Z', timeZone: 'America/Los_Angeles', tasks: [
    task({ id: '1', title: 'Местный день', dueAt: '2026-10-02' }),
    task({ id: '2', title: 'Будущий день', dueAt: '2026-10-03' }),
  ] });
  const rendered = output(await h.click(await h.start(), 'Сегодня')).text;
  assert.match(rendered, /2026-10-02 · America\/Los_Angeles/);
  assert.match(rendered, /Местный день/);
  assert.ok(!rendered.includes('Будущий день'));
  assert.ok(!rendered.includes('· просрочена'));
});

test('waiting view uses only explicit boolean true, never blocker text or unknown values', async () => {
  const h = harness({ tasks: [
    task({ id: '1', title: 'Ждёт владельца', waitingForOwner: true }),
    task({ id: '2', title: 'Просто блокер', blocker: 'Ожидание поставщика' }),
    task({ id: '3', title: 'Неизвестно', waitingForOwner: null }),
    task({ id: '4', title: 'Строковое true', waitingForOwner: 'true' }),
    task({ id: '5', title: 'Завершено с устаревшим флагом', waitingForOwner: true, status: 'done' }),
    task({ id: '6', title: 'Отменено с устаревшим флагом', waitingForOwner: true, status: 'cancelled' }),
  ] });
  const home = await h.start();
  assert.equal(findButton(home, 'Ждут меня').text, 'Ждут меня · 1');
  const rendered = output(await h.click(home, 'Ждут меня')).text;
  assert.match(rendered, /Ждёт владельца/);
  for (const title of ['Просто блокер', 'Неизвестно', 'Строковое true',
    'Завершено с устаревшим флагом', 'Отменено с устаревшим флагом']) assert.ok(!rendered.includes(title));
  assert.match(rendered, /Всего: 1/);
});

test('all tasks retain done, cancelled and unknown statuses', async () => {
  const h = harness({ tasks: [task({ id: '1', status: 'done' }),
    task({ id: '2', status: 'cancelled' }), task({ id: '3', status: 'custom_status' }),
    task({ id: '4', status: 'constructor' })] });
  const rendered = output(await h.click(await h.start(), 'Все задачи')).text;
  assert.match(rendered, /Всего: 4/);
  assert.match(rendered, /Завершена/);
  assert.match(rendered, /Отменена/);
  assert.match(rendered, /custom_status/);
  assert.match(rendered, /constructor/);
  assert.match(rendered, /Все задачи CRM, включая завершённые и отменённые/);
});

test('task pagination and card Back preserve the selected page', async () => {
  const h = harness({ tasks: Array.from({ length: 15 }, (_, i) => task({
    id: String(i + 1), title: `Задача ${String(i + 1).padStart(2, '0')}`,
  })) });
  const first = await h.click(await h.start(), 'Все задачи');
  assert.match(output(first).text, /Страница 1 из 3/);
  assert.ok(!output(first).text.includes('Задача 07'));
  const second = await h.click(first, 'Следующая');
  assert.match(output(second).text, /Страница 2 из 3/);
  const card = await h.click(second, 'Задача 07');
  assert.match(output(card).text, /ID: CRM #7/);
  assert.match(output(card).text, /Следующий шаг:\nОткрыть текущую версию/);
  const back = await h.click(card, '‹ Назад');
  assert.match(output(back).text, /Страница 2 из 3/);
  const third = await h.click(back, 'Следующая');
  assert.match(output(third).text, /Страница 3 из 3/);
  assert.equal(buttons(third).filter(button => /^\d+\. Задача/.test(button.text)).length, 3);
  assert.equal(buttons(third).some(button => button.text.startsWith('Следующая')), false);
  assert.match(output(await h.click(third, '⌂ Главная')).text, /Eva · SynapseBusiness/);
});

test('projects derive from existing tasks and project Back preserves the project page', async () => {
  const h = harness({ tasks: Array.from({ length: 10 }, (_, i) => task({
    id: String(i + 1), title: `Работа ${i + 1}`, companyCode: `p${i + 1}`,
    companyName: `Проект ${String(i + 1).padStart(2, '0')}`,
  })) });
  const first = await h.click(await h.start(), 'Проекты');
  assert.match(output(first).text, /Страница 1 из 2/);
  assert.equal(buttons(first).filter(button => button.text.startsWith('Проект')).length, 8);
  const second = await h.click(first, 'Следующая');
  const project = await h.click(second, 'Проект 09');
  assert.match(output(project).text, /Проект: Проект 09/);
  assert.match(output(project).text, /Работа 9/);
  assert.ok(!output(project).text.includes('Работа 10'));
  const back = await h.click(project, '‹ Проекты');
  assert.match(output(back).text, /Страница 2 из 2/);
});

test('empty states are explicit for every view', async () => {
  const h = harness({ tasks: [] });
  const home = await h.start();
  assert.match(output(await h.click(home, 'Сегодня')).text, /Нет открытых задач/);
  assert.match(output(await h.click(home, 'Ждут меня')).text, /Нет задач, явно ожидающих/);
  assert.match(output(await h.click(home, 'Все задачи')).text, /Пока нет задач/);
  assert.match(output(await h.click(home, 'Проекты')).text, /Пока нет проектов/);
});

test('project grouping and filters match CRM NOCASE and preserve fresh task identity', async () => {
  const h = harness({ tasks: [
    task({ id: '1', title: 'Первая работа', companyCode: 'alvi', companyName: 'ALVI' }),
    task({ id: '2', title: 'Вторая работа', companyCode: 'ALVI', companyName: 'ALVI' }),
  ] });
  const projects = await h.click(await h.start(), 'Проекты');
  const projectButtons = buttons(projects).filter(button => button.text.startsWith('ALVI'));
  assert.equal(projectButtons.length, 1);
  assert.equal(projectButtons[0].text, 'ALVI · 2');
  const list = await h.click(projects, 'ALVI');
  assert.match(output(list).text, /Всего: 2/);
  assert.match(output(list).text, /Первая работа/);
  assert.match(output(list).text, /Вторая работа/);
  const data = findButton(list, 'Первая работа').callback_data;
  h.tasks[0] = task({ id: '1', title: 'Свежая работа', companyCode: 'ALVI', companyName: 'ALVI' });
  const card = await h.bot(h.callback(data));
  assert.match(output(card).text, /Свежая работа/);
  assert.match(output(card).text, /ID: CRM #1/);
  const back = await h.click(card, '‹ Назад');
  assert.match(output(back).text, /Всего: 2/);
  h.tasks[0] = task({ id: '1', companyCode: 'palitra', companyName: 'Palitra' });
  const moved = await h.bot(h.callback(data));
  assert.equal(moved.length, 1);
  assert.match(moved[0].params.text, /Задача больше недоступна/);
});

test('page clamps safely when tasks disappear between clicks', async () => {
  const h = harness({ tasks: Array.from({ length: 8 }, (_, i) => task({ id: String(i + 1) })) });
  const first = await h.click(await h.start(), 'Все задачи');
  h.tasks = [task()];
  const actions = await h.click(first, 'Следующая');
  assert.match(output(actions).text, /Страница 1 из 1/);
  assert.match(output(actions).text, /Всего: 1/);
});

test('card rereads task content and rejects deleted or company-moved task references', async () => {
  const h = harness();
  const list = await h.click(await h.start(), 'Все задачи');
  const data = findButton(list, 'Проверить макет').callback_data;
  h.tasks = [task({ title: 'Актуальная версия', nextAction: 'Новый следующий шаг' })];
  const card = await h.bot(h.callback(data));
  assert.match(output(card).text, /Актуальная версия/);
  assert.match(output(card).text, /Новый следующий шаг/);
  assert.ok(!output(card).text.includes('Проверить макет'));
  h.tasks = [task({ companyCode: 'different-project' })];
  let actions = await h.bot(h.callback(data));
  assert.equal(actions.length, 1);
  assert.match(actions[0].params.text, /Задача больше недоступна/);
  h.tasks = [];
  actions = await h.bot(h.callback(data));
  assert.equal(actions.length, 1);
  assert.match(actions[0].params.text, /Задача больше недоступна/);
  assert.equal(h.reads, 5);
});

test('same task id in different companies cannot select the adjacent project', async () => {
  const h = harness({ tasks: [task({ companyCode: 'a', companyName: 'Компания А', title: 'Работа А' }),
    task({ companyCode: 'b', companyName: 'Компания Б', title: 'Работа Б' })] });
  const list = await h.click(await h.start(), 'Все задачи');
  const card = await h.click(list, 'Работа Б');
  assert.match(output(card).text, /Проект: Компания Б \(b\)/);
  assert.ok(!output(card).text.includes('Компания А'));
});

test('identical task titles have distinguishable buttons matching list numbers', async () => {
  const h = harness({ tasks: [task({ id: '1', title: 'Согласовать макет', companyName: 'ALVI', companyCode: 'alvi' }),
    task({ id: '2', title: 'Согласовать макет', companyName: 'Palitra', companyCode: 'palitra' })] });
  const list = await h.click(await h.start(), 'Все задачи');
  assert.equal(buttons(list)[0].text, '1. Согласовать макет');
  assert.equal(buttons(list)[1].text, '2. Согласовать макет');
  assert.match(output(list).text, /1\. Согласовать макет\nALVI/);
  assert.match(output(list).text, /2\. Согласовать макет\nPalitra/);
  const selected = await h.bot(h.callback(buttons(list)[1].callback_data));
  assert.match(output(selected).text, /ID: CRM #2/);
  assert.match(output(selected).text, /Проект: Palitra/);
});

test('long and unsafe text is plain, bounded and excluded from callback payloads', async () => {
  const unsafe = '<b>Приватно</b> [link](https://example.invalid) \u0000\u202e';
  const h = harness({ tasks: [task({ id: 'PRIVATE_ID_' + '9'.repeat(300),
    title: unsafe + '😀'.repeat(3000), companyCode: 'PRIVATE_COMPANY_' + 'x'.repeat(300),
    companyName: unsafe.repeat(100), nextAction: unsafe.repeat(100), blocker: unsafe.repeat(100),
  })] });
  const list = await h.click(await h.start(), 'Все задачи');
  const card = await h.bot(h.callback(buttons(list)[0].callback_data));
  for (const actions of [list, card]) {
    const rendered = output(actions);
    assert.ok(rendered.text.length <= 4096);
    assert.equal(rendered.parse_mode, undefined);
    assert.match(rendered.text, /<b>Приватно<\/b>/);
    assert.ok(!/[\u0000\u202e]/.test(rendered.text));
    assert.ok(rendered.text.isWellFormed());
    for (const button of buttons(actions)) {
      assert.ok(button.text.length <= 64);
      if (button.url) {
        assert.equal(button.url, 'https://synapse.synapsebusiness.ru/cabinet.html#tasks');
        continue;
      }
      assert.ok(Buffer.byteLength(button.callback_data) <= 64);
      assert.match(button.callback_data, /^eva:[A-Za-z0-9_-]{16}$/);
      assert.ok(!button.callback_data.includes('PRIVATE'));
    }
  }
});

test('unknown deadline and missing next step are shown honestly on the card', async () => {
  const h = harness({ tasks: [task({ dueAt: '2026-02-30', nextAction: null, blocker: null,
    companyCode: '', companyName: '', status: '' })] });
  const list = await h.click(await h.start(), 'Все задачи');
  const rendered = output(await h.click(list, 'Проверить макет')).text;
  assert.match(rendered, /Проект: Без проекта/);
  assert.match(rendered, /Статус: Не указан/);
  assert.match(rendered, /Срок: Срок не распознан/);
  assert.match(rendered, /Следующий шаг:\nНе указан/);
  assert.match(rendered, /Блокер:\nНет записи/);
});

test('source failure is distinguishable from an empty list and retry recovers without leaking errors', async () => {
  const h = harness();
  h.fail = true;
  const failed = await h.start();
  assert.match(output(failed).text, /Задачи сейчас недоступны/);
  assert.ok(!JSON.stringify(failed).includes('DO_NOT_LEAK'));
  assert.ok(!output(failed).text.includes('Пока нет задач'));
  h.fail = false;
  const recovered = await h.click(failed, 'Повторить');
  assert.match(output(recovered).text, /Eva · SynapseBusiness/);
  const list = await h.click(recovered, 'Все задачи');
  h.fail = true;
  const failedCard = await h.click(list, 'Проверить макет');
  assert.match(output(failedCard).text, /Задачи сейчас недоступны/);
  assert.equal(failedCard[0].method, 'answerCallbackQuery');
  assert.equal(failedCard[1].method, 'editMessageText');
});

test('deferred async source settles before actions, rejects safely and rereads on retry', async () => {
  const requests = [];
  const h = harness({ config: { source: { listTasks: () => new Promise((resolve, reject) => {
    requests.push({ resolve, reject });
  }) } } });
  let completed = false;
  const starting = h.start().then(actions => { completed = true; return actions; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(completed, false, 'No actions are returned before async source data arrives');
  requests[0].resolve([task()]);
  const home = await starting;
  assert.match(output(home).text, /Eva · SynapseBusiness/);

  const data = findButton(home, 'Все задачи').callback_data;
  completed = false;
  const listing = h.bot(h.callback(data)).then(actions => { completed = true; return actions; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(completed, false);
  const unauthorized = h.callback(data, { from: { id: OWNER + 1 } });
  assert.deepEqual(await h.bot(unauthorized), []);
  assert.equal(requests.length, 2, 'A foreign sender cannot trigger a source read while another is pending');
  requests[1].reject(new Error('PRIVATE_UDS_PATH_OR_RESPONSE_MUST_NOT_LEAK'));
  const failed = await listing;
  assert.equal(failed[0].method, 'answerCallbackQuery');
  assert.equal(failed[1].method, 'editMessageText');
  assert.match(output(failed).text, /Задачи сейчас недоступны/);
  assert.ok(!JSON.stringify(failed).includes('PRIVATE_UDS'));
  assert.ok(!output(failed).text.includes('Пока нет задач'));

  const retrying = h.click(failed, 'Повторить');
  assert.equal(requests.length, 3);
  requests[2].resolve([task({ title: 'Свежие данные после переподключения' })]);
  const recovered = await retrying;
  assert.match(output(recovered).text, /Свежие данные после переподключения/);
  assert.ok(!output(recovered).text.includes('Проверить макет'));
  assert.equal(h.events.filter(event => event === 'source_error').length, 1);
});

test('malformed and duplicated source records do not become an empty or misleading view', async () => {
  for (const tasks of [null, { tasks: [] }, [null], [{ title: 'Missing identity' }], [task(), task()]]) {
    const h = harness({ config: { source: { listTasks: async () => tasks } } });
    assert.match(output(await h.start()).text, /Задачи сейчас недоступны/);
  }
});

test('sequential and simultaneous duplicate updates return no duplicate actions', async () => {
  let resolve;
  let reads = 0;
  const h = harness({ config: { source: { listTasks: () => {
    reads += 1;
    return new Promise(done => { resolve = done; });
  } } } });
  const update = h.message();
  const first = h.bot(update);
  assert.deepEqual(await h.bot(update), []);
  assert.equal(reads, 1);
  resolve([task()]);
  assert.ok((await first).length);
  assert.deepEqual(await h.bot(update), []);
  assert.equal(reads, 1);
  assert.equal(h.events.filter(event => event === 'duplicate_update').length, 2);
});

test('unauthorized duplicate update id cannot suppress the owner update', async () => {
  const h = harness();
  const update = h.message();
  const spoofed = structuredClone(update);
  spoofed.message.from.id += 1;
  assert.deepEqual(await h.bot(spoofed), []);
  assert.ok((await h.bot(update)).length);
  assert.equal(h.reads, 1);
});

test('process-local duplicate cache expires and is bounded', async () => {
  const h = harness({ tasks: [] });
  const first = h.message();
  await h.bot(first);
  h.instant = '2026-10-02T13:00:00Z';
  assert.ok((await h.bot(first)).length);
  for (let i = 0; i < 2048; i += 1) await h.bot(h.message('ignored text'));
  assert.ok((await h.bot(first)).length, 'Oldest update was evicted from the bounded cache');
});

test('audit has event names only and an unavailable audit sink cannot break the UI', async () => {
  const h = harness({ tasks: [task({ title: 'SECRET_TASK_CONTENT' })] });
  const start = await h.start();
  await h.click(start, 'Все задачи');
  await h.bot(h.callback('unknown'));
  assert.deepEqual(h.events, ['navigation', 'navigation', 'stale_callback']);
  assert.ok(h.events.every(event => typeof event === 'string'));
  const brokenAudit = harness({ config: { audit: async () => { throw new Error('PRIVATE_AUDIT_ERROR'); } } });
  assert.match(output(await brokenAudit.start()).text, /Eva · SynapseBusiness/);
});
