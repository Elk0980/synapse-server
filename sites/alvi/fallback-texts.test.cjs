'use strict';
// Резервный документ ALVI (sites/alvi/data/site.json) — то, что увидит посетитель,
// если документ кабинета недоступен: site-apply.js берёт /api/site, а при отказе —
// этот файл. Значит принятые клиенткой правки обязаны быть и здесь, иначе сбой CMS
// молча откатывает сайт на прежние тексты.
//
// Тест проверяет именно сценарий отказа CMS: принятые тексты, девять вопросов FAQ
// и закрытое замечание А2. Отдельно — что синхронизация не притащила обратно то,
// что уже отменено: вопрос о переносе записи, чужой домен, старые кнопки, длинные
// отзывы. Проверяется только этот файл; живая страница подтверждается браузером.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, 'data', 'site.json');
const document = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const fields = new Map();
for (const section of document.sections) {
  for (const field of section.fields) fields.set(field.key, field);
}
const valueOf = key => String((fields.get(key) || {}).value ?? '');

test('резерв: структура документа не тронута', () => {
  assert.strictEqual(document.sections.length, 16);
  assert.strictEqual(fields.size, 139, 'число полей меняться не должно — синхронизировались только значения');
  for (const field of fields.values()) {
    assert.ok('key' in field && 'value' in field, 'у каждого поля остаются key и value');
  }
});

test('правка «ритуал» → «программа» дошла до резерва', () => {
  // Замечание Татьяны 18.09 13:00: «Поменять везде слово ритуал, на программу».
  for (const [key, expected] of [
    ['hero-7.need-card-fix-1', 'SPA-программа для себя'],
    ['promo.promo-copy-1', 'SPA-программы ALVI'],
    ['promo.promo-note-1', 'Выберите свою программу'],
    ['for-self.content-subtitle-1', 'SPA-программы в Иркутске'],
    ['gift.content-lead-1', 'программу получатель выберет сам'],
    ['quiz.content-title-1', 'Подобрать программу за 3 вопроса']
  ]) {
    assert.ok(valueOf(key).includes(expected), `${key}: ожидался текст «${expected}»`);
  }
  for (const field of fields.values()) {
    assert.ok(!/ритуал/i.test(String(field.value ?? '')), `в значении ${field.key} осталось слово «ритуал»`);
  }
});

test('А2 закрыт и в резерве: кросс-промо называет услуги Авокадо', () => {
  const brand = valueOf('promo.promo-brand-2');
  const copy = valueOf('promo.promo-copy-2');
  assert.ok(/массаж/i.test(brand) && /эпиляц/i.test(brand), 'в названии блока перечислены услуги');
  assert.ok(!/студия дизайна тела/i.test(brand), 'прежняя формулировка А2 не должна вернуться');
  for (const word of ['массаж', 'эпиляц', 'коррекц']) {
    assert.ok(new RegExp(word, 'i').test(copy), `в описании Авокадо ожидалось «${word}»`);
  }
});

test('прочие принятые правки на месте', () => {
  assert.ok(/Подарок уже выбран/.test(valueOf('gift.content-title-1')), 'подарок: «он уже выбранный» (12:58)');
  assert.ok(/Октябрьский район/.test(valueOf('gift.content-copy-1')), 'доставка по Октябрьскому району бесплатно (12:59)');
  assert.ok(/сразу после оплаты/.test(valueOf('gift.content-copy-1')), 'действующее описание электронного сертификата сохранено');
  assert.ok(/любую сумму или на конкретную программу/.test(valueOf('gift.content-copy-1')), 'остальное описание сертификата сохранено');
  assert.strictEqual(valueOf('hero-7.need-card-pain-2'), 'Давно не были вдвоём');
  assert.ok(/Свидание удалось/.test(valueOf('hero-7.need-card-proof-2')));
  assert.ok(/по предварительной записи/.test(valueOf('contacts.dd-2')), 'режим работы с оговоркой о записи');
});

test('FAQ: девять вопросов, переноса записи нет', () => {
  const questions = [...fields.keys()].filter(key => /^faq\.summary-\d+$/.test(key));
  assert.strictEqual(questions.length, 9, 'вопросов ровно девять');
  assert.ok(!fields.has('faq.summary-9'), 'отменённый вопрос не восстанавливается');
  assert.ok(!fields.has('faq.faq-answer-9'), 'и его ответ тоже');
  for (const field of fields.values()) {
    assert.ok(!/перенести запись/i.test(String(field.value ?? '')), `в ${field.key} появился отменённый вопрос о переносе записи`);
  }
});

test('домен прежнего подрядчика в резерв не возвращается', () => {
  // Решение Owner'а 11.09: spaalvi.ru убран отовсюду. Синхронизация из кабинета
  // не должна тащить его обратно, даже если в документе кабинета он ещё есть.
  const all = JSON.stringify(document);
  assert.ok(!/(^|[^-\w.])spaalvi\.ru/.test(all.replace(/spaalvi-38\.ru/g, 'OK')), 'домена spaalvi.ru в резерве быть не должно');
  assert.ok(!/mail@spaalvi/.test(all), 'почты на чужом домене в резерве быть не должно');
  assert.strictEqual(valueOf('contacts.text-link-8'), 'spaalvi-38.ru →');
});

test('актуальные тексты разметки синхронизацией не откачены', () => {
  // Эти значения в кабинете старше разметки: правка делалась в HTML.
  // Синхронизация «из кабинета» не должна их перетереть.
  assert.strictEqual(valueOf('hero-7.need-card-fix-3'), 'Сертификат на любую сумму или программу');
  assert.ok(/по предварительной записи/.test(valueOf('hero-7.span-1')), 'оговорка о записи в первом экране сохранена');
  assert.strictEqual(valueOf('floating.floating-cta-button-1'), 'Программы и цены', 'A9: онлайн-запись убрана');
  assert.strictEqual(valueOf('hero-7.button-1'), 'Программы и цены', 'A9: онлайн-запись убрана');
  for (const key of ['for-two.p-1', 'for-two.p-2', 'for-two.p-3']) {
    assert.ok(!/Ходили с женой|Был с девушкой|Были с парнем/.test(valueOf(key)), `${key}: сокращённый отзыв не должен вернуться к длинной версии`);
  }
});

test('резерв согласован с разметкой по синхронизированным ключам, где разметка — источник', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const plain = value => value.replace(/\s+/g, ' ').trim();
  // Единственный ключ, значение которого взято из действующей разметки.
  const marker = 'По Иркутску (Октябрьский район) привозим бесплатно';
  assert.ok(html.includes(marker), 'разметка обязана содержать текст, который скопирован в резерв');
  assert.ok(plain(valueOf('gift.content-copy-1')).includes(marker));
});
