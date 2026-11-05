const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const {validateEdl} = require(path.join(__dirname, '../../../ops/crm/reel-materials.js'));
const script = fs.readFileSync(require.resolve('./reel-editor.js'), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const plain = (value) => JSON.parse(JSON.stringify(value));
const reel = {id: 4, title: 'Рилс', currentVersion: {version: 2, mediaUrl: 'https://cabinet.test/v2.mp4', durationMs: 10000},
  versions: [{version: 1, mediaUrl: 'https://cabinet.test/v1.mp4', durationMs: 12000}, {version: 2, mediaUrl: 'https://cabinet.test/v2.mp4', durationMs: 10000}]};

function fixture() {
  const dom = new JSDOM('<main id="host"><button data-edit>Редактировать</button></main>', {url: 'https://cabinet.test/#content/materials', runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window, host = w.document.getElementById('host'), posts = [], chat = [], changes = [];
  w.HTMLMediaElement.prototype.pause = () => {};
  w.addEventListener('synapse:hugh-chat', (event) => chat.push(plain(event.detail)));
  w.eval(script);
  w.SbCabinet.reelEditor.frames = async (url, from, to) => [{ms: from, src: ''}, {ms: to, src: ''}];
  const ctx = {companyCode: 'avokado', signal: new w.AbortController().signal,
    api: {post: async (url, body) => {posts.push({url, body: plain(body)});return {edit: {id: 30 + posts.length, taskId: 90 + posts.length}, reel: {...reel, edits: []}};}}};
  const editor = w.SbCabinet.reelEditor.open(host, {ctx, reel, version: 2, onChange: (next) => changes.push(next)});
  const $ = (s) => editor.root.querySelector(s);
  const seekTo = (seconds) => {Object.defineProperty(editor.root.querySelector('[data-player]'), 'currentTime', {value: seconds, writable: true, configurable: true});};
  const change = (node, value) => {if (typeof value === 'boolean') node.checked = value;else node.value = value;node.dispatchEvent(new w.Event('change', {bubbles: true}));};
  return {w, host, editor, $, seekTo, change, posts, chat, changes, ops: w.SbCabinet.reelEditor.ops};
}

test('Операции дорожки: разделить, удалить, переставить, обрезать', () => {
  const {ops} = fixture();
  const one = ops.initial(10000).video;
  const two = ops.split(one, 4000);
  assert.deepEqual(plain(two), [{inMs: 0, outMs: 4000}, {inMs: 4000, outMs: 10000}]);
  assert.equal(ops.split(one, 50), one, 'у края не режется');
  assert.deepEqual(plain(ops.move(two, 1, -1)), [{inMs: 4000, outMs: 10000}, {inMs: 0, outMs: 4000}]);
  assert.equal(ops.remove(one, 0, true), one, 'последний видеоклип не удаляется');
  assert.deepEqual(plain(ops.trim(two, 0, -500, 3000, 10000)), [{inMs: 0, outMs: 3000}, {inMs: 4000, outMs: 10000}]);
  assert.equal(ops.sourceAt(two, 5000), 5000);
});

test('Редактор: правки в интерфейсе дают EDL, который принимает сервер; отправка — правка к версии v2', async () => {
  const f = fixture();
  assert.equal(f.$('.re-clips').children.length, 1);
  f.seekTo(3); f.$('[data-op=split]').click();
  f.seekTo(6); f.$('[data-op=split]').click();
  assert.equal(f.editor.edl.video.length, 3);
  f.$('[data-track=video][data-index="1"]').click(); f.$('[data-op=remove]').click();
  f.$('[data-track=video][data-index="1"]').click(); f.$('[data-op=left]').click();
  assert.deepEqual(plain(f.editor.edl.video), [{inMs: 6000, outMs: 10000}, {inMs: 0, outMs: 3000}]);
  f.change(f.$('[data-field=in]'), '6.5');
  assert.equal(f.editor.edl.video[0].inMs, 6500);
  f.$('[data-track=audio][data-index="0"]').click();
  f.change(f.$('[data-field=gain]'), '60'); f.change(f.$('[data-field=muted]'), true);
  assert.deepEqual(plain(f.editor.edl.audio[0]), {inMs: 0, outMs: 10000, gain: 0.6, muted: true});
  f.change(f.$('[data-speed]'), '1.25');
  f.seekTo(7); f.$('[data-op=cover]').click(); f.$('[data-op=caption]').click();
  f.change(f.$('[data-caption="0"]'), 'Запишитесь сегодня');
  assert.equal(f.editor.edl.coverMs, 500);
  assert.match(f.$('[data-tracks]').textContent, /Итог: 5,2 с/);
  const server = validateEdl(plain(f.editor.edl), 10000);
  assert.equal(server.outputMs, 5200); assert.equal(server.captions[0].text, 'Запишитесь сегодня');
  assert.ok(f.w.localStorage.getItem('sb-reel-edl:avokado:4:v2'), 'черновик правок сохранён в браузере');
  f.$('[data-op=submit]').click(); await tick();
  assert.equal(f.posts[0].url, 'crm/autoposting/reels/4/edits');
  assert.equal(f.posts[0].body.kind, 'edl'); assert.equal(f.posts[0].body.baseVersion, 2); assert.equal(f.posts[0].body.edl.speed, 1.25);
  assert.match(f.$('[data-status]').textContent, /задача №91/);
  assert.equal(f.w.localStorage.getItem('sb-reel-edl:avokado:4:v2'), null, 'после отправки черновик очищен');
  assert.equal(f.chat[0].taskId, 91); assert.equal(f.changes.length, 1);
});

test('«Отметить от … до …» ✓ → кадры → «Хью, измени…» → задача и запись в личный чат', async () => {
  const f = fixture();
  f.$('[data-mark=from]').value = '5'; f.$('[data-mark=to]').value = '4';
  f.$('[data-op=mark]').click(); await tick();
  assert.equal(f.$('[data-ask]').hidden, true); assert.match(f.$('[data-status]').textContent, /меньше/);
  f.$('[data-mark=to]').value = '7.5';
  f.$('[data-op=mark]').click(); await tick(); await tick();
  assert.equal(f.$('[data-ask]').hidden, false);
  assert.equal(f.$('[data-frames]').querySelectorAll('figure').length, 2);
  f.$('[data-op=ask-send]').click(); await tick();
  assert.equal(f.posts.length, 0, 'пустой запрос не отправляется');
  f.$('[data-ask-text]').value = 'убери паузу и сделай титр крупнее';
  f.$('[data-op=ask-send]').click(); await tick();
  assert.deepEqual({...f.posts[0].body, clientRequestId: 'x'}, {clientRequestId: 'x', baseVersion: 2, kind: 'request', startMs: 5000, endMs: 7500, comment: 'убери паузу и сделай титр крупнее'});
  assert.equal(f.$('[data-ask]').hidden, true);
  assert.match(f.$('[data-status]').textContent, /«исправлено»/);
  assert.equal(f.chat[0].companyCode, 'avokado'); assert.match(f.chat[0].text, /Хью, измени «Рилс» v2, 5,0–7,5 с/);
  f.$('[data-close]').click();
  assert.equal(f.host.querySelector('.re-editor'), null);
});
