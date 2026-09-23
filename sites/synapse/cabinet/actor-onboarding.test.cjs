const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');

const script = fs.readFileSync(require.resolve('./actor-onboarding.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const clone = (value) => JSON.parse(JSON.stringify(value));
const profile = () => ({direction: '', role: '', cameraComfort: 'unknown', voiceComfort: 'unknown',
  boundaries: '', suggestions: ''});
const own = (code, overrides = {}) => ({companyCode: code, actorId: 17, actorName: 'Таня',
  revision: 0, profile: profile(), createdAt: null, updatedAt: null, ...overrides});
const summary = (code) => ({companyCode: code, total: 2, ready: 1, participants: [
  {actorId: 17, actorName: 'Таня', revision: 1, direction: 'Туризм', role: 'Эксперт',
    cameraComfort: 'small_steps', voiceComfort: 'text_only', hasBoundaries: true,
    hasSuggestions: true, updatedAt: '2026-09-23T10:00:00Z'},
  {actorId: 18, actorName: 'Сергей <img src=x>', revision: 1, direction: '', role: '',
    cameraComfort: 'unknown', voiceComfort: 'unknown', hasBoundaries: false,
    hasSuggestions: false, updatedAt: null},
]});

function fixture({role = 'editor', permissions = ['actor-onboarding.self'], override} = {}) {
  const dom = new JSDOM('<main><section id="view"></section></main>',
    {url: 'https://cabinet.test/#actor-onboarding', runScripts: 'outside-only'});
  const w = dom.window, container = w.document.getElementById('view'), views = {}, calls = [];
  const socialRows = new Map();
  w.SbCabinet = {registerView(name, view) {views[name] = view;}};
  w.eval(script);
  const ctx = {identity: {role, permissions, companies: [
    {id: 'taisabai', name: 'ТайСабай'}, {id: 'alvi', name: 'Алви'}]},
  selectedProjectId: 'taisabai',
  csrfOptions: (method, body) => ({method, headers: {'X-CSRF-Token': 'test'}, body: JSON.stringify(body)}),
  apiJson: async (url, options = {}) => {
    const parsed = new URL(url, 'https://cabinet.test');
    const code = parsed.searchParams.get('companyCode');
    const call = {path: parsed.pathname, code, query: parsed.searchParams, method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {}};
    calls.push(call);
    if (override) {
      const result = await override(call);
      if (result !== undefined) return clone(result);
    }
    if (call.path.endsWith('/social-links/review')) {
      if (call.method === 'PUT') {
        const key = `${code}:${call.body.platform}`;
        const previous = socialRows.get(key);
        if (previous) socialRows.set(key, {...previous, status: call.body.decision,
          revision: previous.revision + 1});
      }
      return {companyCode: code, links: [...socialRows.values()].filter((item) => item.companyCode === code)};
    }
    if (call.path.endsWith('/social-links')) {
      if (call.method === 'PUT') socialRows.set(`${code}:${call.body.platform}`, {
        companyCode: code, actorId: 17, actorName: 'Таня', platform: call.body.platform,
        publicUrl: call.body.publicUrl, revision: call.body.revision + 1, status: 'pending',
        updatedAt: '2026-09-23T10:00:00Z', reviewedAt: null,
      });
      if (call.method === 'DELETE') socialRows.delete(`${code}:${call.body.platform}`);
      return {companyCode: code, actorId: 17, platforms: ['instagram', 'youtube'],
        links: [...socialRows.values()].filter((item) => item.companyCode === code)};
    }
    if (call.path.endsWith('/summary')) return summary(code);
    if (call.method === 'PUT') return own(code, {revision: call.body.revision + 1,
      profile: call.body.profile, updatedAt: '2026-09-23T10:00:00Z'});
    return own(code);
  }};
  const settle = async () => {for (let i = 0; i < 8; i++) await tick();};
  const view = views['actor-onboarding'];
  return {dom, w, container, view, calls, ctx, settle, close: () => w.close()};
}

test('экран показывает шесть коротких вопросов и объяснение каждого, ничего не сохраняет при открытии', async () => {
  const f = fixture();
  try {
    f.view.render(f.container, f.ctx); await f.settle();
    assert.equal(f.view.title, 'Моя анкета');
    assert.equal(f.container.querySelectorAll('[data-actor-step]').length, 6);
    assert.equal(f.container.querySelectorAll('.actor-onboarding-why').length, 6);
    assert.equal(f.container.querySelectorAll('[data-actor-step]:not([hidden])').length, 1);
    f.container.querySelector('[data-actor-next]').click();
    assert.match(f.container.querySelector('[data-actor-progress]').textContent, /Шаг 2 из 6/);
    assert.ok(f.calls.every((call) => call.method === 'GET'));
    assert.equal(f.calls.some((call) => call.path.endsWith('/summary')), false);
  } finally {f.close();}
});

test('без личного права раздел не запрашивает и не показывает анкету', async () => {
  const f = fixture({permissions: []});
  try {
    f.view.render(f.container, f.ctx); await f.settle();
    assert.equal(f.calls.length, 0);
    assert.equal(f.container.querySelector('[data-actor-form]'), null);
    assert.match(f.container.textContent, /нет доступа/);
  } finally {f.close();}
});

test('участник сохраняет только свою анкету с версией и CSRF, не видит чужих ответов', async () => {
  const f = fixture();
  try {
    f.view.render(f.container, f.ctx); await f.settle();
    const direction = f.container.querySelector('[name="direction"]');
    direction.value = 'Недвижимость';
    direction.dispatchEvent(new f.w.Event('input', {bubbles: true}));
    const comfort = f.container.querySelector('[name="cameraComfort"]');
    comfort.value = 'off_camera';
    comfort.dispatchEvent(new f.w.Event('change', {bubbles: true}));
    const form = f.container.querySelector('[data-actor-form]');
    form.dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true}));
    await f.settle();
    const save = f.calls.find((call) => call.method === 'PUT');
    assert.equal(save.code, 'taisabai');
    assert.deepEqual([...save.query.keys()], ['companyCode']);
    assert.equal(save.headers['X-CSRF-Token'], 'test');
    assert.deepEqual(Object.keys(save.body).sort(), ['profile', 'revision']);
    assert.equal(save.body.revision, 0);
    assert.equal(save.body.profile.direction, 'Недвижимость');
    assert.equal(save.body.profile.cameraComfort, 'off_camera');
    assert.equal(f.calls.some((call) => call.path.endsWith('/summary')), false);
    assert.equal(f.container.querySelector('[data-actor-summary]'), null);
    assert.match(f.container.querySelector('[data-actor-status]').textContent, /Ответы сохранены/);
  } finally {f.close();}
});

test('руководитель видит обезличенную по содержанию сводку, но свою анкету редактирует отдельно', async () => {
  const f = fixture({role: 'owner', permissions: []});
  try {
    f.view.render(f.container, f.ctx); await f.settle();
    assert.equal(f.calls.filter((call) => call.path.endsWith('/summary')).length, 1);
    const node = f.container.querySelector('[data-actor-summary]');
    assert.match(node.textContent, /1 из 2/);
    assert.match(node.textContent, /Постепенно попробую/);
    assert.doesNotMatch(node.textContent, /Туризм|Эксперт/);
    assert.equal(node.querySelector('img'), null);
    assert.equal(f.container.querySelector('[name="direction"]').value, '');
  } finally {f.close();}
});

test('ответ старой компании не отображается после переключения проекта', async () => {
  let resolveOld;
  const f = fixture({override: (call) => call.code === 'taisabai' ?
    new Promise((resolve) => {resolveOld = resolve;}) : undefined});
  try {
    f.view.render(f.container, f.ctx);
    await f.settle();
    f.view.onProjectChange({...f.ctx, selectedProjectId: 'alvi'});
    await f.settle();
    assert.match(f.container.textContent, /Компания: Алви/);
    resolveOld(own('taisabai', {profile: {...profile(), direction: 'Старые данные'}}));
    await f.settle();
    assert.equal(f.container.querySelector('[name="direction"]').value, '');
    assert.doesNotMatch(f.container.textContent, /Старые данные/);
  } finally {f.close();}
});

test('задержавшаяся сводка прежней компании не смешивается с новой', async () => {
  let resolveOld;
  const f = fixture({role: 'owner', permissions: [], override: (call) =>
    call.code === 'taisabai' && call.path.endsWith('/summary') ?
      new Promise((resolve) => {resolveOld = resolve;}) : undefined});
  try {
    f.view.render(f.container, f.ctx); await f.settle();
    f.view.onProjectChange({...f.ctx, selectedProjectId: 'alvi'}); await f.settle();
    const before = f.container.querySelector('[data-actor-summary]').textContent;
    resolveOld({companyCode: 'taisabai', total: 99, ready: 99, participants: []});
    await f.settle();
    assert.equal(f.container.querySelector('[data-actor-summary]').textContent, before);
    assert.doesNotMatch(f.container.textContent, /99 из 99/);
  } finally {f.close();}
});

test('несохранённый ввод возвращается после смены компании и конфликт не стирает его', async () => {
  const f = fixture({override: (call) => {
    if (call.method === 'PUT') throw Object.assign(new Error('Conflict'), {status: 409});
    return undefined;
  }});
  try {
    f.view.render(f.container, f.ctx); await f.settle();
    const input = f.container.querySelector('[name="direction"]');
    input.value = 'Моя тема';
    input.dispatchEvent(new f.w.Event('input', {bubbles: true}));
    f.view.onProjectChange({...f.ctx, selectedProjectId: 'alvi'}); await f.settle();
    f.view.onProjectChange(f.ctx); await f.settle();
    assert.equal(f.container.querySelector('[name="direction"]').value, 'Моя тема');
    f.container.querySelector('[data-actor-form]').dispatchEvent(new f.w.Event('submit',
      {bubbles: true, cancelable: true}));
    await f.settle();
    assert.equal(f.container.querySelector('[name="direction"]').value, 'Моя тема');
    assert.match(f.container.querySelector('[data-actor-status]').textContent, /изменилась на сервере/);
  } finally {f.close();}
});

test('участник предлагает и удаляет только свою ссылку с CSRF; интерфейс не обещает подключение', async () => {
  const f = fixture();
  try {
    f.view.render(f.container, f.ctx); await f.settle();
    assert.match(f.container.textContent, /не подключает публикации и статистику/);
    assert.equal(f.container.querySelector('[data-actor-social-review]'), null);
    const form = f.container.querySelector('[data-actor-social-form]');
    form.elements.namedItem('publicUrl').value = 'https://instagram.com/actor';
    form.dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true}));
    await f.settle();
    const put = f.calls.find((call) => call.path.endsWith('/social-links') && call.method === 'PUT');
    assert.equal(put.code, 'taisabai');
    assert.equal(put.headers['X-CSRF-Token'], 'test');
    assert.deepEqual(put.body, {platform: 'instagram', publicUrl: 'https://instagram.com/actor', revision: 0});
    assert.match(f.container.querySelector('[data-actor-social-list]').textContent, /Ждёт проверки/);
    f.container.querySelector('[data-actor-social-delete]').click(); await f.settle();
    const del = f.calls.find((call) => call.path.endsWith('/social-links') && call.method === 'DELETE');
    assert.equal(del.code, 'taisabai');
    assert.equal(del.headers['X-CSRF-Token'], 'test');
    assert.deepEqual(del.body, {platform: 'instagram', revision: 1});
    assert.match(f.container.querySelector('[data-actor-social-list]').textContent, /ни одной ссылки/);
  } finally {f.close();}
});

test('директор проверяет предложенную ссылку, но не получает кнопки подключения аккаунта', async () => {
  const f = fixture({role: 'owner', permissions: []});
  try {
    f.view.render(f.container, f.ctx); await f.settle();
    const form = f.container.querySelector('[data-actor-social-form]');
    form.elements.namedItem('publicUrl').value = 'https://instagram.com/actor';
    form.dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true}));
    await f.settle();
    const review = f.container.querySelector('[data-actor-social-review]');
    assert.match(review.textContent, /не подключает API, автопубликацию или аналитику/);
    review.querySelector('[data-actor-social-decision="approved"]').click(); await f.settle();
    const decision = f.calls.find((call) => call.path.endsWith('/social-links/review') && call.method === 'PUT');
    assert.equal(decision.headers['X-CSRF-Token'], 'test');
    assert.deepEqual(decision.body, {actorId: 17, platform: 'instagram', revision: 1,
      decision: 'approved'});
    assert.match(review.textContent, /Ссылка подтверждена/);
    assert.equal(review.querySelector('[data-actor-social-decision="approved"]'), null);
  } finally {f.close();}
});

test('чужое имя и повреждённый URL в ответе сервера показываются только как текст', async () => {
  const f = fixture({role: 'owner', permissions: [], override: (call) => {
    if (call.path.endsWith('/social-links/review')) return {companyCode: call.code, links: [
      {actorId: 18, actorName: '<img src=x onerror=alert(1)>', platform: 'instagram',
        publicUrl: 'javascript:alert(1)', revision: 1, status: 'pending', updatedAt: null},
    ]};
    if (call.path.endsWith('/social-links')) return {companyCode: call.code, actorId: 17, links: [
      {platform: 'instagram', publicUrl: 'https://evil.example/profile', revision: 1,
        status: 'pending', updatedAt: null},
    ]};
    return undefined;
  }});
  try {
    f.view.render(f.container, f.ctx); await f.settle();
    assert.equal(f.container.querySelector('img'), null);
    assert.equal(f.container.querySelector('[data-actor-social-review] a'), null);
    assert.equal(f.container.querySelector('[data-actor-social-list] a'), null);
    assert.match(f.container.textContent, /<img src=x onerror=alert\(1\)>/);
  } finally {f.close();}
});

test('задержавшиеся ссылки и решения прежней компании не попадают в новый экран', async () => {
  let resolveOwn, resolveReview;
  const f = fixture({role: 'owner', permissions: [], override: (call) => {
    if (call.code !== 'taisabai') return undefined;
    if (call.path.endsWith('/social-links/review')) return new Promise((resolve) => {resolveReview = resolve;});
    if (call.path.endsWith('/social-links')) return new Promise((resolve) => {resolveOwn = resolve;});
    return undefined;
  }});
  try {
    f.view.render(f.container, f.ctx); await f.settle();
    f.view.onProjectChange({...f.ctx, selectedProjectId: 'alvi'}); await f.settle();
    resolveOwn({companyCode: 'taisabai', actorId: 17, links: [
      {platform: 'instagram', publicUrl: 'https://instagram.com/old.company',
        revision: 1, status: 'pending'}]});
    resolveReview({companyCode: 'taisabai', links: [
      {actorId: 18, actorName: 'Старый участник', platform: 'instagram',
        publicUrl: 'https://instagram.com/old.company', revision: 1, status: 'pending'}]});
    await f.settle();
    assert.match(f.container.textContent, /Компания: Алви/);
    assert.doesNotMatch(f.container.textContent, /old\.company|Старый участник/);
    assert.equal(f.calls.filter((call) => call.code === 'alvi' &&
      call.path.endsWith('/social-links')).length, 1);
  } finally {f.close();}
});

test('редактор с управлением не подтверждает собственную ссылку через интерфейс', async () => {
  const f = fixture({permissions: ['actor-onboarding.self', 'actor-onboarding.manage'],
    override: (call) => call.path.endsWith('/social-links/review') ? {companyCode: call.code, links: [
      {actorId: 17, actorName: 'Таня', platform: 'instagram',
        publicUrl: 'https://instagram.com/tanya', revision: 1, status: 'pending'},
    ]} : undefined});
  try {
    f.view.render(f.container, f.ctx); await f.settle();
    const review = f.container.querySelector('[data-actor-social-review]');
    assert.match(review.textContent, /другой управляющий/);
    assert.equal(review.querySelector('[data-actor-social-decision]'), null);
  } finally {f.close();}
});

test('ответ старой записи ссылки после смены компании игнорируется', async () => {
  let resolveSave;
  const f = fixture({override: (call) => call.code === 'taisabai' &&
    call.path.endsWith('/social-links') && call.method === 'PUT' ?
    new Promise((resolve) => {resolveSave = resolve;}) : undefined});
  try {
    f.view.render(f.container, f.ctx); await f.settle();
    const form = f.container.querySelector('[data-actor-social-form]');
    form.elements.namedItem('publicUrl').value = 'https://instagram.com/old.company';
    form.dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true}));
    await f.settle();
    f.view.onProjectChange({...f.ctx, selectedProjectId: 'alvi'}); await f.settle();
    resolveSave({companyCode: 'taisabai', actorId: 17, links: [
      {platform: 'instagram', publicUrl: 'https://instagram.com/old.company', revision: 1,
        status: 'pending'}]});
    await f.settle();
    assert.match(f.container.textContent, /Компания: Алви/);
    assert.doesNotMatch(f.container.textContent, /old\.company/);
  } finally {f.close();}
});
