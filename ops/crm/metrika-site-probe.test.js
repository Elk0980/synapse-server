'use strict';
/* Поиск счётчика Метрики на сайте: распознавание на настоящем коде сайтов репозитория, только свой домен,
   без внутренних адресов, кэш. Сеть заменена заглушкой; домены синтетические. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createMetrikaSiteProbe, counterIn, publicHttpUrl } = require('./metrika-site-probe');
const site = (file) => fs.readFileSync(path.join(__dirname, '../../sites', file), 'utf8');

test('счётчик распознаётся в коде сайтов Авокадо и АЛВИ и в стандартной вставке', () => {
  assert.equal(counterIn(site('avokado3/attribution.js')), '112772817');
  assert.match(String(counterIn(site('alvi/metrika.js'))), /^\d{5,12}$/);
  assert.equal(counterIn('<script src="https://mc.yandex.ru/metrika/tag.js?id=4455667"></script>'), '4455667');
  assert.equal(counterIn("ym(7788990, 'init', {})"), '7788990');
  assert.equal(counterIn('const counterId = 123456; // без загрузчика Метрики'), null);
  assert.equal(counterIn(site('avokado3/index.html')), null);
});

test('внутренние и не-HTTP адреса не запрашиваются', () => {
  for (const bad of ['http://127.0.0.1/', 'http://localhost/', 'https://cms.internal/', 'ftp://a.example/', 'https://u:p@a.example/', 'http://[::1]/']) assert.equal(publicHttpUrl(bad), null, bad);
  assert.equal(publicHttpUrl('https://a.example/').hostname, 'a.example');
});

function fakeFetch(pages) {
  const calls = [];
  const impl = async (url) => { calls.push(url); const p = pages[url];
    if (!p) return { ok: false, status: 404, headers: new Map(), text: async () => '' };
    return { ok: !p.location, status: p.location ? 301 : 200, headers: new Map(p.location ? [['location', p.location]] : []), text: async () => p.body || '' }; };
  return { impl, calls };
}

test('счётчик ищется в скриптах своего сайта, сначала analytics/attribution; чужие скрипты не читаются; кэш', async () => {
  const scripts = Array.from({ length: 20 }, (_, i) => `<script src="s${i}.js"></script>`).join('');
  const { impl, calls } = fakeFetch({
    'http://a.example/': { location: 'https://www.a.example/' },
    'https://www.a.example/': { body: `<html>${scripts}<script src="https://cdn.other.example/x.js"></script><script src="attribution.js?v=1"></script></html>` },
    'https://www.a.example/attribution.js?v=1': { body: site('avokado3/attribution.js') },
  });
  let t = Date.parse('2026-11-05T00:00:00Z');
  const probe = createMetrikaSiteProbe({ fetchImpl: impl, now: () => t });
  const found = await probe.probe('http://a.example/');
  assert.equal(found.counterId, '112772817'); assert.equal(found.foundIn, 'https://www.a.example/attribution.js');
  assert.equal(calls.length, 3, 'после редиректа первым читается attribution.js');
  assert.ok(!calls.some((u) => u.includes('other.example')));
  await probe.probe('http://a.example/'); assert.equal(calls.length, 3, 'повтор из кэша');
  t += 7 * 3600_000; await probe.probe('http://a.example/'); assert.equal(calls.length, 6, 'через 6 ч проверка повторяется');
});

test('редирект на чужой домен и недоступный сайт — «не проверено», без счётчика', async () => {
  const { impl } = fakeFetch({ 'https://b.example/': { location: 'https://evil.example/' } });
  const probe = createMetrikaSiteProbe({ fetchImpl: impl });
  assert.deepEqual(await probe.probe('https://b.example/'), { counterId: null, checked: false, reason: 'сайт не ответил' });
  const down = createMetrikaSiteProbe({ fetchImpl: async () => { throw Error('timeout'); } });
  assert.equal((await down.probe('https://c.example/')).checked, false);
  const none = createMetrikaSiteProbe({ fetchImpl: fakeFetch({ 'https://d.example/': { body: '<html>без счётчика</html>' } }).impl });
  assert.deepEqual({ ...(await none.probe('https://d.example/')), checkedAt: undefined }, { counterId: null, checked: true, foundIn: null, checkedAt: undefined });
});
