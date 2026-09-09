/* Run: node --test docs/alvi/tests/site-copy.test.js */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.resolve(__dirname, '../../../sites/alvi/site-apply.js'), 'utf8');
const fallback = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../sites/alvi/data/site.json'), 'utf8'));
const fallbackFields = new Map(fallback.sections.flatMap((section) => section.fields || []).map((field) => [field.key, field.value]));

function renderer(fields, width = 390) {
  const elements = fields.map((field) => ({
    innerHTML: '', style: {}, tagName: 'P',
    getAttribute(name) { return name === 'data-edit' ? field.key : null; }
  }));
  const window = { innerWidth: width, matchMedia: () => ({ matches: window.innerWidth <= 899.84 }), addEventListener() {} };
  const document = {
    readyState: 'loading', addEventListener() {},
    querySelectorAll(selector) { return selector === '[data-edit]' ? elements : []; }
  };
  vm.runInNewContext(script, { window, document, location: { search: '' }, URLSearchParams });
  return (nextWidth = width) => {
    window.innerWidth = nextWidth;
    window.AlviSite.applyFields({ sections: [{ id: 'promo', fields }] });
    return elements.map((element) => element.innerHTML);
  };
}

const render = (fields, width) => renderer(fields, width)();

const oldPromo = [
  ['promo.promo-tagline-1', 'Совершенство — там, где есть и то, и другое: <em>красота без боли</em> в Авокадо и <em>отдых и расслабление</em> в ALVI.', 'Время для себя · ALVI и АВОКАДО'],
  ['promo.promo-title-1', 'Абонемент ALVI — ритуалы по одной цене', 'Абонемент ALVI'],
  ['promo.promo-copy-1', 'Несколько визитов одной покупкой — выгоднее разовых и спокойнее: дата уже выбрана, остаётся только прийти. Подходит для себя и в подарок.', 'Несколько визитов одной покупкой — время для отдыха в вашем ритме.'],
  ['promo.promo-title-2', 'Красота без боли: аппаратная коррекция фигуры и лазерная эпиляция', 'Пробный аппаратный массаж']
];

test('hydrating the old cabinet document retains the approved compact banner', () => {
  assert.deepEqual(render(oldPromo.map(([key, value]) => ({ key, value }))), oldPromo.map(([, , expected]) => expected));
  for (const [key, original] of oldPromo) assert.equal(fallbackFields.get(key), original);
});

test('desktop preserves the approved document and mobile copy does not leak across resize', () => {
  const fields = oldPromo.map(([key, value]) => ({ key, value }));
  const apply = renderer(fields);
  const original = fields.map(({ value }) => value);
  assert.deepEqual(apply(1440), original);
  assert.deepEqual(apply(390), oldPromo.map(([, , compact]) => compact));
  assert.deepEqual(apply(900), original);
  assert.deepEqual(apply(1920), original);
});

test('later cabinet edits, empty text and unchanged notes remain intact', () => {
  const fields = [
    ...oldPromo.map(([key], index) => ({ key, value: index ? 'Обновлено салоном' : '' })),
    { key: 'promo.promo-note-1', value: 'Новые условия салона' },
    { key: 'promo.promo-note-2', value: 'Новый адрес' }
  ];
  assert.deepEqual(render(fields), fields.map((field) => field.value));
});

test('the current offer amount still comes from the cabinet document', () => {
  const [html] = render([{ key: 'promo.promo-copy-2', value: 'Пробный сеанс — 750 ₽ вместо 2 300 ₽.' }]);
  assert.match(html, /promo__price\">750 ₽<\/strong>/);
  assert.match(html, /promo__was\">вместо 2 300 ₽<\/span>/);
  assert.doesNotMatch(html, /500 ₽|2 100 ₽/);
  assert.match(html, /<\/span><\/span>$/); // No punctuation-only line after the price.
  const [continued] = render([{ key: 'promo.promo-copy-2', value: '750 ₽ вместо 2 300 ₽. Только по записи.' }]);
  assert.match(continued, /<\/span><\/span>\. Только по записи\.$/);
});

test('certificate hydration still corrects old delivery terms and preserves later edits', () => {
  const key = 'faq.faq-answer-4';
  const old = 'Напишите в Telegram: сертификат бывает электронный (приходит в мессенджер) или бумажный в конверте с лентой. Оформляется на любую сумму или конкретную программу, доставка по Иркутску бесплатная.';
  assert.equal(render([{ key, value: old }])[0], fallbackFields.get(key));
  assert.match(render([{ key, value: old }])[0], /в отдалённые районы — за доплату/);
  assert.equal(render([{ key, value: 'Новые условия доставки' }])[0], 'Новые условия доставки');
});
