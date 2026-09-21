'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./hugh-personas');

test('имя в начале сообщения определяет персону', () => {
  assert.equal(P.detect('Хью, привет'), 'hugh');
  assert.equal(P.detect('Лео, покажи план'), 'leo');
  assert.equal(P.detect('Leo, hi'), 'leo');
});

test('имя внутри другого слова не срабатывает', () => {
  assert.equal(P.detect('леопард сбежал'), null);
  assert.equal(P.detect('Хьюстон, у нас проблема'), null);
  assert.equal(P.detect('галеон'), null);
});

test('без имени никто не отвечает', () => {
  assert.equal(P.detect('привет'), null);
  assert.equal(P.addressedPersona('привет'), null);
});

test('ответ боту и режим замены отвечают персоной по умолчанию', () => {
  assert.equal(P.addressedPersona('привет', {addressed: true}), 'hugh');
  assert.equal(P.addressedPersona('привет', {delegate: true}), 'hugh');
});

test('названы оба — отвечает тот, чьё имя раньше', () => {
  assert.equal(P.detect('Лео, спроси у Хью про сайт'), 'leo');
  assert.equal(P.detect('Хью, передай Лео план'), 'hugh');
});

test('имя посреди фразы тоже считается обращением', () => {
  assert.equal(P.detect('слушай, Лео, что по контенту'), 'leo');
});

test('у персон разный контекст, и лишнее не кладётся', () => {
  const site = P.contextKeys('hugh'), media = P.contextKeys('leo');
  assert.ok(site.includes('siteNotes'));
  assert.ok(!site.includes('brief'), 'Хью не нужен бриф — это деньги и размытый ответ');
  assert.ok(media.includes('brief') && media.includes('contentPlan'));
  assert.ok(!media.includes('siteNotes'));
});

test('контекст неизвестной персоны не падает, а берёт значение по умолчанию', () => {
  assert.deepEqual(P.contextKeys('нет-такой'), P.contextKeys('hugh'));
});

test('чужая тема переадресуется по имени, а не замалчивается', () => {
  const fromLeo = P.handoff('leo');
  assert.match(fromLeo, /это не ко мне/i);
  assert.match(fromLeo, /Хью/);
  const fromHugh = P.handoff('hugh');
  assert.match(fromHugh, /Лео/);
});

test('инструкция запрещает отвечать за соседа и додумывать', () => {
  const leo = P.instruction('leo');
  assert.match(leo, /Тебя зовут Лео/);
  assert.match(leo, /не отвечай по существу/);
  assert.match(leo, /не выдумывай/);
  assert.match(leo, /Хью/);
});

test('подсказка называет оба имени и их темы', () => {
  assert.match(P.PERSONAS_HINT, /Хью/);
  assert.match(P.PERSONAS_HINT, /Лео/);
  assert.match(P.PERSONAS_HINT, /контент-план/);
});

test('баннер честно говорит, что помощник один', () => {
  const text = P.PERSONAS_BANNER.lines.join(' ');
  assert.match(text, /только когда его зовут по имени/);
  assert.match(text, /не два независимых помощника/);
  assert.ok(P.PERSONAS_BANNER.id, 'у баннера должен быть идентификатор версии');
});
