const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Local DOM/API doubles: no live requests or authenticated sessions.
const source = fs.readFileSync(process.env.TASKS_SOURCE || path.join(__dirname, 'tasks.js'), 'utf8');
const escapeHTML = value => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
class Element {
  constructor() { this.handlers = {}; this.value = ''; this.disabled = false; this.hidden = false; }
  addEventListener(event, handler) { this.handlers[event] = handler; }
  querySelectorAll() { return []; }
  set innerHTML(html) {
    this.html = html;
    const options = [...html.matchAll(/<option value="([^"]*)"([^>]*)>/g)];
    if (options.length) this.value = (options.find(option => /\bselected\b/.test(option[2])) || options[0])[1];
  }
  get innerHTML() { return this.html || ''; }
}
async function fixture() {
  let projects = [{ id: 'palitra', name: 'Палитра' }, { id: 'alvi', name: 'Алви' }];
  let selected = 'palitra';
  let projectsError;
  const nodes = new Map();
  const byId = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const form = byId('task-create-form');
  form.elements = Object.fromEntries(['title', 'description', 'companyCode', 'assigneeRole',
    'assigneeName', 'priority', 'dueDate', 'status'].map(name => [name, new Element()]));
  const error = new Element();
  const submit = new Element();
  form.querySelector = selector => ({ '[role=alert]': error, '[type="submit"]': submit,
    '[data-task-company]': form.elements.companyCode, '[data-task-role]': form.elements.assigneeRole,
    '[data-task-priority]': form.elements.priority, '[data-task-status]': form.elements.status })[selector];
  const close = new Element();
  const dialog = byId('task-create-dialog');
  dialog.querySelector = () => close;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  const controls = new Map();
  byId('tasks-content').querySelector = selector => {
    if (!controls.has(selector)) controls.set(selector, new Element());
    return controls.get(selector);
  };
  const requests = [];
  const context = {
    // Deliberately different: the form must use the top picker's projects, not another identity mapping.
    identity: { role: 'owner', companies: [{ id: 'stale', name: 'Старое значение' }] },
    get projects() { if (projectsError) throw new Error(projectsError); return projects; },
    get selectedProjectId() { return selected; },
    currentView: 'tasks', byId, escapeHTML,
    scopeParams: () => ({ companyCode: selected }),
    chooseProject: value => { selected = value; },
    hasPermission: () => true,
    navigate: () => {},
    csrfOptions: (method, body) => ({ method, body }),
    crmQuery: async (route, scope, options = {}) => {
      requests.push({ route, scope, options });
      if (options.method === 'POST') return { id: 'created-task' };
      if (route === '/tasks/summary') return { inbox: 0 };
      return { tasks: [], pagination: { total: 0 } };
    }
  };
  let view;
  vm.runInNewContext(source, { window: { SbCabinet: { registerView: (name, definition) => { view = definition; } } },
    location: { hash: '#tasks' }, history: { replaceState() {} }, URLSearchParams, setTimeout, clearTimeout });
  view.render(byId('tasks-content'), context);
  await new Promise(resolve => setImmediate(resolve));
  return { form, error, submit, dialog, requests,
    setProjects: value => { projects = value; }, setSelected: value => { selected = value; },
    setError: value => { projectsError = value; },
    open: () => controls.get('[data-task-add]').handlers.click(),
    send: () => form.handlers.submit({ preventDefault() {}, currentTarget: form }),
    posts: () => requests.filter(request => request.options.method === 'POST') };
}

test('uses the shared picker list and current project on each opening', async () => {
  const f = await fixture(); await f.open();
  assert.match(f.form.elements.companyCode.innerHTML, /Палитра/);
  assert.match(f.form.elements.companyCode.innerHTML, /Алви/);
  assert.doesNotMatch(f.form.elements.companyCode.innerHTML, /stale/);
  assert.equal(f.form.elements.companyCode.value, 'palitra');
  assert.equal(f.submit.disabled, false);
  f.setSelected('alvi'); await f.open();
  assert.equal(f.form.elements.companyCode.value, 'alvi');
});

test('default submission explicitly scopes the task to the current project', async () => {
  const f = await fixture(); await f.open(); f.form.elements.title.value = 'Задача'; await f.send();
  assert.equal(f.posts()[0].scope.companyCode, 'palitra');
  assert.equal(f.posts()[0].options.body.companyCode, 'palitra');
});

test('another selected project is used in both POST scope and payload', async () => {
  const f = await fixture(); await f.open();
  f.form.elements.companyCode.value = 'alvi';
  f.form.elements.companyCode.handlers.change?.(); await f.send();
  assert.equal(f.posts().length, 1);
  assert.equal(f.posts()[0].scope.companyCode, 'alvi');
  assert.equal(f.posts()[0].options.body.companyCode, 'alvi');
});

for (const [name, projects, message] of [
  ['empty', [], /Нет доступных проектов/],
  ['unloaded', undefined, /Не удалось загрузить/]
]) test(`${name} project list disables selection and submission, including forced submit`, async () => {
  const f = await fixture(); f.setProjects(projects); await f.open();
  assert.equal(f.dialog.open, true);
  assert.equal(f.form.elements.companyCode.disabled, true);
  assert.equal(f.submit.disabled, true);
  assert.equal(f.error.hidden, false);
  assert.match(f.error.textContent, message);
  assert.match(f.form.elements.companyCode.innerHTML, message);
  await f.send(); assert.equal(f.posts().length, 0);
});

test('a failed project source is shown honestly and reopening recovers', async () => {
  const f = await fixture(); f.setError('Не удалось загрузить список проектов. Обновите страницу.'); await f.open();
  assert.equal(f.submit.disabled, true); assert.match(f.error.textContent, /Обновите страницу/);
  await f.send(); assert.equal(f.posts().length, 0);
  f.setError(undefined); await f.open(); assert.equal(f.submit.disabled, false);
});

test('empty or unavailable selection never silently falls back to the top picker', async () => {
  const f = await fixture(); await f.open();
  for (const value of ['', 'unavailable']) {
    f.form.elements.companyCode.value = value;
    f.form.elements.companyCode.handlers.change?.();
    assert.equal(f.submit.disabled, true);
    await f.send(); assert.equal(f.posts().length, 0);
  }
});

test('availability is rechecked when submitting an already open form', async () => {
  const f = await fixture(); await f.open(); f.setProjects([{ id: 'alvi', name: 'Алви' }]);
  await f.send(); assert.equal(f.posts().length, 0);
  assert.match(f.error.textContent, /недоступен/);
  assert.equal(f.submit.disabled, true);
});
