const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'price-render.js'), 'utf8');
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/price.json'), 'utf8'));
function fixture(responses, stored = null, blockedStorage = false) {
  let saved = stored;
  const calls = [];
  const window = {};
  vm.runInNewContext(source, { window, AbortController, setTimeout: (fn) => setTimeout(fn, 15), clearTimeout,
    localStorage: {
      getItem: () => { if (blockedStorage) throw Error('blocked'); return saved; },
      setItem: (key, value) => { if (blockedStorage) throw Error('blocked'); saved = value; }
    },
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      const value = responses.shift();
      if (value === 'hang') return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(Error('timeout'))));
      if (value instanceof Error) throw value;
      return { ok: value !== null, json: async () => value };
    }
  });
  return { load: () => window.PalitraPrice.load(['/content/palitra/price', '/data/price.json']), calls, saved: () => saved };
}
test('public API data wins over the old seed and is cached without credentials', async () => {
  const current = { ...seed, version: 2 };
  const f = fixture([current]);
  assert.equal((await f.load()).version, 2);
  assert.equal(JSON.parse(f.saved()).version, 2);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].opts.credentials, 'omit');
  assert.equal(f.calls[0].opts.headers, undefined);
});
test('outage retains the last successfully read version', async () => {
  const f = fixture([null], JSON.stringify({ ...seed, version: 3 }));
  assert.equal((await f.load()).version, 3);
  assert.equal(f.calls.length, 1);
});
test('first visitor during outage gets the bundled price', async () => {
  const f = fixture([new Error('offline'), seed]);
  assert.equal((await f.load()).version, seed.version);
  assert.equal(f.calls[1].url, '/data/price.json');
});
test('a stalled API times out and falls back', async () => {
  const f = fixture(['hang', seed]);
  assert.equal((await f.load()).version, seed.version);
  assert.equal(f.calls[0].opts.signal.aborted, true);
});
test('malformed remote data cannot overwrite the last good price', async () => {
  const cache = JSON.stringify({ ...seed, version: 4 });
  const f = fixture([{ categories: [{ items: 'broken' }] }], cache);
  assert.equal((await f.load()).version, 4);
  assert.equal(f.saved(), cache);
});
test('blocked storage still allows API and bundled fallback reads', async () => {
  assert.equal((await fixture([seed], null, true).load()).version, seed.version);
  assert.equal((await fixture([null, seed], null, true).load()).version, seed.version);
});
