const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const content = require('./subscription-promo-content.js');
const source = fs.readFileSync(__dirname + '/subscription-promo.js', 'utf8');
function setup({ site = 'alvi', edit = false, seen = false } = {}) {
  const html = fs.readFileSync(__dirname + '/../' + site + '/index.html', 'utf8');
  const dom = new JSDOM(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''), {
    url: (site === 'alvi' ? 'https://spaalvi-38.ru/' : 'https://avokado38.ru/') + (edit ? '?edit=1' : ''), runScripts: 'outside-only'
  });
  const w = dom.window, d = w.document, promo = d.getElementById('promo');
  const scheduled = new Map(); let id = 0;
  w.setTimeout = cb => { scheduled.set(++id, cb); return id; };
  w.clearTimeout = key => scheduled.delete(key);
  Object.defineProperty(d, 'hidden', { value: false });
  Object.defineProperty(w, 'innerHeight', { value: 844 });
  w.scrollTo = options => { w.lastScroll = options; };
  promo.showModal = () => { promo.setAttribute('open', ''); };
  promo.close = () => { promo.removeAttribute('open'); };
  const trigger = d.querySelector(promo.dataset.promoTrigger);
  trigger.style.opacity = '1';
  trigger.getBoundingClientRect = () => ({ top: 2000, bottom: 2300 });
  if (seen) w.sessionStorage.setItem(site + '_subscription_promo_shown', '1');
  w.eval(source);
  return { dom, w, d, promo, trigger, scheduled, flush() { for (const [id, callback] of scheduled) { scheduled.delete(id); callback(); } } };
}
for (const site of ['alvi', 'avokado3']) {
  test(site + ': manual reopen, native dialog, Escape and focus restoration', () => {
    const s = setup({ site }), opener = s.d.querySelector('[data-promo-open]');
    assert.equal(opener.hidden, false);
    opener.focus(); opener.click();
    assert.equal(s.promo.open, true);
    assert.equal(s.d.activeElement, s.promo.querySelector('.promo__close'));
    assert.equal(s.d.documentElement.classList.contains('promo-open'), true);
    s.promo.dispatchEvent(new s.w.Event('cancel', { cancelable: true }));
    assert.equal(s.promo.open, false);
    assert.equal(s.d.activeElement, opener);
    opener.click(); assert.equal(s.promo.open, true);
    s.dom.window.close();
  });
  test(site + ': banner waits for visible reviews and appears once per visit', () => {
    const s = setup({ site });
    s.flush(); assert.equal(s.promo.open, false);
    s.trigger.getBoundingClientRect = () => ({ top: 150, bottom: 500 });
    s.trigger.style.opacity = '0'; s.w.dispatchEvent(new s.w.Event('scroll')); s.flush();
    assert.equal(s.promo.open, false, 'hidden animated review scene must not trigger');
    s.trigger.style.opacity = '1'; s.w.dispatchEvent(new s.w.Event('scroll')); s.flush();
    assert.equal(s.promo.open, true);
    s.w.alviPromoClose(); s.w.dispatchEvent(new s.w.Event('scroll')); s.flush();
    assert.equal(s.promo.open, false);
    s.dom.window.close();
  });
}
test('Avokado price anchor continues to the music-preserving overlay after closing promo', () => {
  const s = setup({ site: 'avokado3' }); s.w.alviPromoOpen();
  const button = s.promo.querySelector('[data-edit="promo.promo-button-2"]');
  assert.equal(button.getAttribute('href'), 'price.html#subscriptions');
  let captured = false;
  s.d.addEventListener('click', e => { captured = true; assert.equal(e.defaultPrevented, false); assert.equal(s.promo.open, false); e.preventDefault(); });
  button.click(); assert.equal(captured, true); s.dom.window.close();
});
test('ALVI site action returns to its home without unloading music; external CTA is a real link', () => {
  const s = setup(); s.w.alviPromoOpen();
  assert.equal(s.promo.querySelector('[data-edit="promo.promo-button-2"]').href, 'https://avokado38.ru/price.html#subscriptions');
  s.promo.querySelector('[data-edit="promo.promo-button-1"]').click();
  assert.equal(s.promo.open, false); assert.deepEqual({ ...s.w.lastScroll }, { top: 0, behavior: 'instant' });
  s.dom.window.close();
});
test('another modal, editor mode and deleted banner cannot auto-open', () => {
  const s = setup(); const other = s.d.createElement('dialog'); other.setAttribute('open', ''); s.d.body.append(other);
  s.w.alviPromoOpen(); assert.equal(s.promo.open, false);
  other.remove(); s.promo.hidden = true; s.w.alviPromoOpen(); assert.equal(s.promo.open, false); s.dom.window.close();
  const edit = setup({ edit: true }); edit.trigger.getBoundingClientRect = () => ({ top: 10, bottom: 400 });
  edit.w.dispatchEvent(new edit.w.Event('scroll')); edit.flush(); assert.equal(edit.promo.open, false); edit.dom.window.close();
});
test('one-time promo migration preserves unrelated content, subsequent edits and intentional deletions', () => {
  const unrelated = { id: 'contacts', fields: [{ key: 'contacts.phone', value: 'confirmed' }] };
  const original = { version: 3, custom: true, sections: [unrelated, { id: 'promo', fields: [{ key: 'promo.old', value: 'old', layout: { desktop: { x: -114 } } }] }] };
  const updated = content.upgrade(original, 'alvi');
  assert.equal(updated.sections[0], unrelated); assert.equal(original.sections[1].fields[0].key, 'promo.old');
  assert.equal(updated.subscriptionPromoRevision, content.REVISION);
  const promo = updated.sections[1]; promo.fields[0].value = 'New owner copy'; promo.fields.pop();
  assert.equal(content.upgrade(updated, 'alvi'), updated);
  updated.sections = [unrelated];
  assert.equal(content.upgrade(updated, 'alvi'), updated); assert.equal(updated.sections.length, 1);
  assert.equal(content.upgrade(original, 'avokado2'), original);
});
test('shared deployed controller and content helper stay equal across sites and editor', () => {
  for (const file of ['subscription-promo.js', 'subscription-promo.css', 'subscription-promo-content.js']) {
    assert.equal(fs.readFileSync(__dirname + '/' + file, 'utf8'), fs.readFileSync(__dirname + '/../avokado3/' + file, 'utf8'));
  }
  assert.equal(fs.readFileSync(__dirname + '/subscription-promo-content.js', 'utf8'), fs.readFileSync(__dirname + '/../synapse/subscription-promo-content.js', 'utf8'));
  const editor = fs.readFileSync(__dirname + '/../synapse/site-editor.html', 'utf8');
  assert.match(editor, /if \(sec.id === 'promo' && doc.subscriptionPromoRevision\) return/);
});

test('photo quality update refreshes default assets and preserves owner uploads and deletions', () => {
  const fields = [
    { key: 'promo.promo-portrait-1', src: 'img/subscription-alvi-20260915.webp' },
    { key: 'promo.promo-portrait-2', src: '/api/assets/owner-photo.webp' },
    { key: 'promo.deleted-photo', src: '', hidden: true }
  ];
  const original = { subscriptionPromoRevision: content.REVISION, sections: [{ id: 'promo', fields }] };
  const updated = content.upgrade(original, 'alvi');
  assert.equal(updated.sections[0].fields[0].src, 'img/alvi-poster.png');
  assert.equal(original.sections[0].fields[0].src, 'img/subscription-alvi-20260915.webp');
  assert.equal(updated.sections[0].fields[1], fields[1]);
  assert.equal(updated.sections[0].fields[2], fields[2]);
  assert.equal(content.upgrade(updated, 'alvi'), updated);
});
