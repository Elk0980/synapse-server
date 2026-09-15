/* Owner-requested banner revision. Unrelated site sections are never changed. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SubscriptionPromoContent = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const REVISION = 'subscription-story-20260915';
  function section(site) {
    const field = (key, label, value, extra = {}) => ({ key: 'promo.' + key, label, value, multiline: true, ...extra });
    return { id: 'promo', title: 'Баннер · ALVI и АВОКАДО', revision: REVISION, fields: [
      field('promo-tagline-1', 'Фраза сверху', 'Два места, где есть время для себя'),
      field('promo-portrait-1', 'Фото · ALVI', '', { kind: 'image', src: 'img/subscription-alvi-20260916-hq.webp', zone: 'promo-alvi' }),
      field('promo-brand-1', 'Подпись бренда · ALVI', 'SPA ALVI · время восстановиться'),
      field('promo-title-1', 'Заголовок · ALVI', 'Мой способ быть в ресурсе'),
      field('promo-copy-1', 'Текст · ALVI', 'В моём ритме важно находить время для себя. SPA-ритуалы ALVI помогают мне расслабиться и снова почувствовать себя в тонусе.'),
      field('promo-note-1', 'Примечание · ALVI', 'Выберите свой ритуал — для себя или вдвоём.'),
      field('promo-button-1', 'Кнопка · ALVI', 'Открыть мир ALVI', { kind: 'button', href: 'https://spaalvi-38.ru/' }),
      field('promo-portrait-2', 'Фото · Авокадо', '', { kind: 'image', src: 'img/subscription-avokado-20260916-hq.webp', zone: 'promo-avokado' }),
      field('promo-brand-2', 'Подпись бренда · Авокадо', 'АВОКАДО · студия дизайна тела'),
      field('promo-title-2', 'Заголовок · Авокадо', 'С абонементом дешевле'),
      field('promo-copy-2', 'Текст · Авокадо', 'Забота о теле — по понятному плану. Подберём процедуры под вашу цель, составим расписание и будем отмечать прогресс вместе.'),
      field('promo-note-2', 'Примечание · Авокадо', 'Состав, стоимость и условия обсудим до начала курса.'),
      field('promo-button-2', 'Кнопка · Авокадо', 'Посмотреть абонементы', { kind: 'button', href: site === 'avokado3' ? 'price.html#subscriptions' : 'https://avokado38.ru/price.html#subscriptions' })
    ] };
  }
  function upgrade(doc, site) {
    if (!['alvi', 'avokado3'].includes(site) || !doc || !Array.isArray(doc.sections)) return doc;
    // Refresh only our two default photos; preserve owner uploads and deletions.
    const defaultPhoto = field => /^img\/subscription-(alvi|avokado)-20260915\.webp$/.test(field.src || '');
    if (doc.sections.some(section => section.id === 'promo' && section.fields?.some(defaultPhoto))) {
      doc = { ...doc, sections: doc.sections.map(section => section.id !== 'promo' ? section : {
        ...section, fields: section.fields.map(field => defaultPhoto(field)
          ? { ...field, src: field.src.replace('-20260915.webp', '-20260916-hq.webp') } : field)
      }) };
    }
    // Keep intentional deletions made after this one-time revision.
    if (doc.subscriptionPromoRevision === REVISION) return doc;
    const index = doc.sections.findIndex(s => s.id === 'promo');
    if (index >= 0 && doc.sections[index].revision === REVISION) return { ...doc, subscriptionPromoRevision: REVISION };
    // This revision replaces the old campaign as requested, including its old
    // manually shifted coordinates. Subsequent owner edits retain the marker.
    const sections = doc.sections.slice();
    if (index >= 0) sections[index] = section(site);
    else sections.push(section(site));
    return { ...doc, sections, subscriptionPromoRevision: REVISION };
  }
  return { REVISION, section, upgrade };
});
