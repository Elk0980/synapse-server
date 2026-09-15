const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./clients.js'), 'utf8');
const escape = value => String(value ?? '').replace(/[&<>"']/g,
  c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const plain = value => JSON.parse(JSON.stringify(value));
function setup({query} = {}) {
  const requests = [], renderedCards = [], status = {textContent: ''}, location = {hash: ''};
  const views = {}, content = {innerHTML: '', querySelectorAll: () => [],
    querySelector: selector => selector === '[data-card-status]' ? status : {addEventListener() {}}};
  const window = {SbCabinet: {registerView: (name, view) => views[name] = view,
    pipelineStages: {stages: [], load: async () => {}}}, testSavedCard: (view, id) => renderedCards.push({view, id})};
  const instrumented = source.replace('Object.assign(api, { renderCrmEntityRoute,',
    'window.testForms = {formPayload, saveEntityForm, repeatRow, renderEntityForm, normalizeRepeat, config: CRM_ENTITIES["crm-companies"]}; Object.assign(api, { renderCrmEntityRoute,')
    .replace('const renderEntityCard = async (view, id) => {',
      'const renderEntityCard = async (view, id) => window.testSavedCard(view, id); const originalRenderEntityCard = async (view, id) => {');
  vm.runInNewContext(instrumented, {window, URL, location});
  views.clients.render(null, {identity: {role: 'owner'}, escapeHTML: escape, navigate() {},
    hasPermission: () => true, scopeParams: () => ({companyId: 7}), byId: () => content,
    crmQuery: async (path, params, options) => { requests.push({path, params, options}); return query ? query(path, params, options) : {id: 42}; },
    csrfOptions: (method, body) => ({method, headers: {'X-CSRF-Token': 'test-token'}, body: JSON.stringify(body)})});
  return {ui: window.SbCabinet.companyLinksUI, forms: window.testForms, content, requests, renderedCards, status, location};
}
const rows = [
  {type: 'telegram', label: 'Главный чат', url: 'https://t.me/studio'},
  {type: 'unknown_provider', label: 'Сохранённая связь', url: 'https://example.test/old'},
  {type: 'telegram', label: 'Вторая точка', url: 'https://t.me/second'},
  {type: 'max', handle: '@old-max-handle'},
  {type: 'two_gis', label: 'Подтверждено по адресу', url: 'https://2gis.ru/city/firm/123'},
  {type: 'unknown_provider', label: 'Дубль намеренный', url: 'https://example.test/old'},
];
function formFor(ui, config, original = []) {
  const {selected, additional} = ui.split(original);
  const named = ui.fields.map(([type]) => ({dataset: {companySocial: type, originalIndex: String(selected.get(type)?.index ?? '')},
    value: selected.get(type)?.row.url || ''}));
  const extras = additional.map(({row, index}) => ({dataset: {originalIndex: String(index)},
    querySelector: selector => ({value: selector.includes('"type"') ? row.type || '' :
      selector.includes('"label"') ? row.label || '' : row.url || row.handle || ''})}));
  const fieldset = {dataset: {repeat: 'socials'}, querySelectorAll: () => extras};
  return {named, extras, elements: Object.fromEntries(Object.keys(config.labels).map(key => [key, {value: key === 'websiteUrl' ? 'https://studio.test/' : ''}])),
    querySelectorAll: selector => selector === '[data-repeat]' ? [fieldset] : named};
}

test('company editor shows eight optional URL fields and one website field with 2GIS first', async () => {
  const {ui, forms, content} = setup();
  await forms.renderEntityForm('crm-companies', {socials: rows, websiteUrl: 'https://studio.test/'});
  assert.deepEqual(plain(ui.fields.map(([type]) => type)), ['two_gis','yandex_maps','max','telegram','telegram_channel','whatsapp','vk','booking']);
  assert.equal((content.innerHTML.match(/name="websiteUrl"/g) || []).length, 1);
  assert.equal((content.innerHTML.match(/data-company-social=/g) || []).length, 8);
  assert.ok(content.innerHTML.indexOf('data-company-social="two_gis"') < content.innerHTML.indexOf('name="websiteUrl"'));
  for (const input of content.innerHTML.match(/<input[^>]*data-company-social[^>]*>/g)) assert.doesNotMatch(input, /\brequired\b/);
  assert.match(content.innerHTML, /Дополнительные ссылки и контакты/);
});

test('actual form payload round-trips unknown types, handles, labels and duplicate rows in their original order', () => {
  const {ui, forms} = setup(), form = formFor(ui, forms.config, rows);
  const payload = forms.formPayload(form, forms.config, {socials: rows});
  assert.deepEqual(plain(forms.normalizeRepeat(payload.socials)), plain(forms.normalizeRepeat(rows)));
  assert.equal(payload.socials.length, 6);
  assert.equal(payload.websiteUrl, 'https://studio.test/');
  assert.equal(payload.socials[3].handle, '@old-max-handle');
  const unknown = forms.repeatRow(rows[1], 'socials', 1);
  assert.match(unknown, /value="unknown_provider"\s+selected/);
});

test('changing one fixed contact preserves the other company links and does not discard a second same-type row', () => {
  const {ui, forms} = setup(), form = formFor(ui, forms.config, rows);
  form.named.find(input => input.dataset.companySocial === 'telegram').value = 'https://t.me/new_studio';
  form.named.find(input => input.dataset.companySocial === 'max').value = 'https://max.ru/u/public-studio';
  const result = forms.formPayload(form, forms.config, {socials: rows}).socials;
  assert.equal(result[0].url, 'https://t.me/new_studio');
  assert.equal(result[0].label, 'Главный чат');
  assert.equal(result[2].url, 'https://t.me/second');
  assert.equal(result[3].handle, '@old-max-handle');
  assert.equal(result[6].url, 'https://max.ru/u/public-studio');
  assert.equal(rows[0].url, 'https://t.me/studio', 'editing must not mutate the loaded record');
  const dual = [{type: 'telegram', url: 'https://t.me/old', handle: '@old'}];
  const merged = ui.merge([{type: 'telegram', value: 'https://t.me/new', index: 0}], [], dual);
  assert.equal(merged[0].handle, '@old', 'a URL edit must not erase another preserved legacy property');
});

test('empty optional fields add no rows and clearing one primary URL keeps unrelated and duplicate contacts', () => {
  const {ui, forms} = setup();
  assert.deepEqual(plain(forms.formPayload(formFor(ui, forms.config), forms.config).socials), []);
  const form = formFor(ui, forms.config, rows);
  form.named.find(input => input.dataset.companySocial === 'telegram').value = '   ';
  const result = forms.formPayload(form, forms.config, {socials: rows}).socials;
  assert.equal(result.length, 5);
  assert.ok(result.some(row => row.url === 'https://t.me/second'));
});

test('actual save submits all nine company links when an existing company has socials:null, and also supports creation', async () => {
  for (const existing of [true, false]) {
    const page = setup();
    const record = existing ? {id: 42, code: 'avokado', name: 'Авокадо', socials: null, websiteUrl: null} : undefined;
    const form = formFor(page.ui, page.forms.config);
    form.elements.code.value = 'avokado'; form.elements.name.value = 'Авокадо';
    for (const input of form.named) input.value = 'https://example.test/' + input.dataset.companySocial;
    const error = {hidden: true, textContent: ''};
    const submit = {disabled: false};
    form.querySelector = selector => selector === '[role=alert]' ? error : submit;
    let prevented = false;
    await page.forms.saveEntityForm({currentTarget: form, preventDefault() { prevented = true; }}, 'crm-companies', record);
    assert.equal(prevented, true);
    assert.equal(error.hidden, true, error.textContent);
    assert.equal(page.requests.length, 1, 'submit must reach the HTTP boundary');
    const request = page.requests[0], body = JSON.parse(request.options.body);
    assert.equal(request.path, existing ? '/companies/42' : '/companies');
    assert.equal(request.options.method, existing ? 'PATCH' : 'POST');
    assert.equal(request.options.headers['X-CSRF-Token'], 'test-token');
    assert.deepEqual(plain(request.params), {companyId: 7});
    assert.equal(body.websiteUrl, 'https://studio.test/');
    assert.equal(body.socials.length, 8);
    assert.deepEqual(body.socials.map(row => row.type), plain(page.ui.fields.map(([type]) => type)));
    for (const row of body.socials) assert.equal(row.url, 'https://example.test/' + row.type);
    if (existing) {
      assert.equal('code' in body, false, 'PATCH excludes unchanged company fields');
      assert.equal('name' in body, false);
      assert.equal(record.socials, null, 'save does not mutate the loaded nullable record');
      assert.deepEqual(page.renderedCards, [{view: 'crm-companies', id: 42}]);
      assert.equal(page.status.textContent, 'Сохранено');
    } else assert.equal(page.location.hash, 'crm-companies/42');
  }
});

test('actual save treats null, omitted and empty social arrays as unchanged when the form remains empty', async () => {
  for (const socials of [null, undefined, []]) {
    const page = setup();
    const record = {id: 42, code: 'avokado', name: 'Авокадо', socials, websiteUrl: 'https://studio.test/'};
    const form = formFor(page.ui, page.forms.config);
    form.elements.code.value = record.code; form.elements.name.value = record.name;
    const error = {hidden: true, textContent: ''}; form.querySelector = () => error;
    await page.forms.saveEntityForm({currentTarget: form, preventDefault() {}}, 'crm-companies', record);
    assert.equal(error.hidden, true, error.textContent);
    assert.equal(page.requests.length, 0, 'normalization must not create an empty PATCH');
    assert.deepEqual(page.renderedCards, [{view: 'crm-companies', id: 42}]);
  }
});

test('fixed links reject unsafe schemes, incomplete addresses and embedded credentials', () => {
  const {ui, forms} = setup();
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', '@name', 'https://user:password@example.test']) {
    const form = formFor(ui, forms.config);
    form.named[0].value = value;
    assert.throws(() => forms.formPayload(form, forms.config), /2ГИС: укажите полную ссылку/);
  }
});

test('company card and deals shared renderer produce escaped clickable public URLs without activating handles or scripts', () => {
  const {ui, forms} = setup();
  const html = ui.summary({socials: [...rows, {type: '<img src=x>', label: '" onmouseover="bad', url: 'javascript:alert(1)'}]}, escape);
  assert.match(html, /href="https:\/\/t.me\/studio"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /Telegram для записи/);
  assert.match(html, /@old-max-handle/);
  assert.doesNotMatch(html, /<img|href="javascript:|href="@/);
  assert.match(html, /&lt;img/);
  const unknown = forms.repeatRow({type: '"><img src=x>', url: 'https://example.test'}, 'socials');
  assert.doesNotMatch(unknown, /<img/);
});
