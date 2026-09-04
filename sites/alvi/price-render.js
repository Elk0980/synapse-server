/* ALVI · общий рендер прайса из data/price.json.
   Используется страницей прайса, главной (блоки-витрины) и редактором в кабинете.
   Никаких зависимостей. Глобальный объект window.AlviPrice. */
(function () {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  /* Фото карточек по умолчанию — пока позиции в базе без поля photo (задаётся в редакторе). */
    const DEFAULT_PHOTOS = { 's4-1': 'img/card-s4-1.jpg', 's2-2': 'img/card-s2-2.jpg', 's1-1': 'img/card-s1-1.jpg', 's1-2': 'img/card-s1-2.jpg', 's1-3': 'img/card-s1-3.jpg', 's1-4': 'img/card-s1-4.jpg', 's1-5': 'img/card-s1-5.jpg', 's1-6': 'img/card-s1-6.jpg', 's1-7': 'img/card-s1-7.jpg', 's1-9': 'img/card-s1-9.jpg', 's1-11': 'img/card-s1-11.jpg' };
  const photoOf = (it) => it.photo || DEFAULT_PHOTOS[it.id] || '';
  /* Смайлики разделов: у сертификатов — конверт, у акций — подарок. В заголовках они анимированы (класс ps__emoji). */
  const stripEmoji = (t) => String(t || '').replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '').trim();
  const certTitle = (data) => stripEmoji(data.certificates?.title) || 'Сертификаты';
  const isPromoCat = (cat) => !!cat && (cat.id === 'promo' || /^акци/iu.test(stripEmoji(cat.title)));
  const emojiHtml = (kind) => kind === 'cert'
    ? '<span class="ps__emoji ps__emoji--cert" aria-hidden="true">💌</span>'
    : '<span class="ps__emoji ps__emoji--promo" aria-hidden="true">🎁</span>';
  const headingHtml = (cat) => isPromoCat(cat) ? `${emojiHtml('promo')} ${esc(stripEmoji(cat.title))}` : esc(cat.title);
  const navTitle = (cat) => isPromoCat(cat) ? '🎁 ' + esc(stripEmoji(cat.title)) : esc(cat.title);
  /* Раздел «Акции», пока его нет в документе прайса: заглушка без выдуманных условий. */
  const DEFAULT_PROMO = { id: 'promo', title: 'Акции', kind: 'programs', block: 'self', items: [], note: 'Действующие акции и специальные предложения меняются по сезону — уточните у администратора, что актуально сейчас.' };
  /* Порядок разделов: акции сразу после сертификатов, остальное — как в документе. */
  function orderedCategories(data, opts = {}) {
    const cats = (data.categories || []).slice();
    const i = cats.findIndex(isPromoCat);
    const promo = i >= 0 ? cats.splice(i, 1)[0] : (opts.noDefaultPromo ? null : DEFAULT_PROMO);
    return promo ? [promo].concat(cats) : cats;
  }

  const BLOCK_BY_CATEGORY = (data, categoryId) => {
    const cat = (data.categories || []).find((c) => c.id === categoryId);
    return cat ? cat.block || 'self' : 'self';
  };

  function findItem(data, id) {
    for (const cat of data.categories || []) {
      for (const it of cat.items || []) if (it.id === id) return { cat, it };
    }
    return null;
  }

  function actions(data, sectionLevel) {
    const book = esc(data.links?.book || '#');
    const chat = esc(data.links?.chat || '#');
    return `<div class="pc__actions${sectionLevel ? ' pc__actions--section' : ''}">
            <a class="pc__button pc__button--main" href="${book}" target="_blank" rel="noopener">Записаться онлайн</a>
            <a class="pc__button" href="${chat}" target="_blank" rel="noopener">Подобрать с администратором</a>
          </div>`;
  }

  function programCard(data, it, opts) {
    const items = (it.items || []).map((x) => `            <li>${esc(x)}</li>`).join('\n');
    const star = opts.editor ? opts.starHtml(it) : (isPopular(data, it.id) ? '<span class="pc__badge" title="Популярная программа">★ популярное</span>' : '');
    return `        <article class="pc" id="${esc(it.id)}" data-id="${esc(it.id)}">
          ${star}
          <h3 class="pc__title">${esc(it.title)}</h3>
          <ul class="pc__list">
${items}
          </ul>
          <p class="pc__meta"><span class="pc__dur">${esc(it.duration)}</span><span class="pc__price">${esc(it.price)}</span></p>
          ${opts.editor ? opts.editHtml(it) : actions(data, false)}
        </article>`;
  }

  function tableSection(data, cat, opts) {
    const head = cat.head || ['Услуга', 'Длительность', 'Цена'];
    const rows = (cat.items || []).map((it) => {
      const star = opts.editor ? opts.starHtml(it, true) : (isPopular(data, it.id) ? ' <span class="pt__star" title="Популярное">★</span>' : '');
      const edit = opts.editor ? opts.editHtml(it, true) : '';
      return `            <tr id="${esc(it.id)}" data-id="${esc(it.id)}"><td>${star}${esc(it.title)}${edit}</td><td>${esc(it.duration)}</td><td class="pt__price">${esc(it.price)}</td></tr>`;
    }).join('\n');
    const note = cat.note ? `        <p class="ps__note">${esc(cat.note)}</p>\n` : '';
    return `${note}        <div class="pt-wrap">
          <table class="pt">
            <thead><tr><th>${esc(head[0])}</th><th>${esc(head[1])}</th><th>${esc(head[2])}</th></tr></thead>
            <tbody>
${rows}
            </tbody>
          </table>
        </div>
        ${opts.editor ? (opts.addRowHtml ? opts.addRowHtml(cat) : '') : actions(data, true)}`;
  }

  function certificates(data) {
    const c = data.certificates || {};
    const types = (c.types || []).map((t) => `          <article class="cert__card">
            <h3 class="pc__title">${esc(t.title)}</h3>
            <p>${esc(t.text)}</p>
          </article>`).join('\n');
    const photo = c.photo ? `        <div class="cert-photo">
          <img src="${esc(c.photo)}" alt="Подарочные сертификаты ALVI SPA" loading="lazy">
        </div>\n` : '';
    return `      <section class="ps" id="s8">
        <h2 class="ps__title">${emojiHtml('cert')} ${esc(certTitle(data))}</h2>
${photo}        <div class="cert">
${types}
        </div>
        <p class="ps__note">${esc(c.note || '')}</p>
        <div class="pc__actions pc__actions--section">
          <a class="pc__button pc__button--main" href="${esc(data.links?.chat || '#')}" target="_blank" rel="noopener">${esc(c.button || 'Оформить сертификат')}</a>
        </div>
      </section>`;
  }

  function isPopular(data, id) {
    const s = data.showcase || {};
    return (s.self || []).includes(id) || (s.two || []).includes(id);
  }

  /* Разделы прайса (без сертификатов, если opts.noCertificates). */
  function renderSections(data, opts = {}) {
    const out = [];
    for (const cat of orderedCategories(data, opts)) {
      const isDefault = cat === DEFAULT_PROMO;
      const title = `<h2 class="ps__title">${headingHtml(cat)}${opts.editor && opts.titleExtra && !isDefault ? opts.titleExtra(cat) : ''}</h2>`;
      let body;
      if (isDefault) body = `        <p class="ps__note">${esc(cat.note)}</p>\n        ${opts.editor ? (opts.promoPlaceholderHtml ? opts.promoPlaceholderHtml() : '') : actions(data, true)}`;
      else if (cat.kind === 'table') body = tableSection(data, cat, opts);
      else body = ((cat.items || []).map((it) => programCard(data, it, opts)).join('\n\n') || (cat.note ? `        <p class="ps__note">${esc(cat.note)}</p>` : '')) + (opts.editor && opts.addCardHtml ? opts.addCardHtml(cat) : '');
      out.push(`      <section class="ps" id="${esc(cat.id)}" data-cat="${esc(cat.id)}">
        ${title}
${body}
      </section>`);
    }
    if (!opts.noCertificates) out.unshift(certificates(data)); // сертификаты — первым разделом
    return out.join('\n\n');
  }

  /* Левое меню: разделы и подпункты (только для программ). */
  function renderNav(data, opts = {}) {
    const li = [];
    if (opts.prefix) li.push(opts.prefix);
    for (const cat of orderedCategories(data, opts)) {
      const subs = cat.kind === 'table' ? [] : (cat.items || []);
      const cls = subs.length ? ' class="has-sub"' : '';
      const sub = subs.length ? `\n          <ul class="pnav__sub">\n${subs.map((it) => `            <li><a href="#${esc(it.id)}">${esc(it.title)}</a></li>`).join('\n')}\n          </ul>` : '';
      li.push(`        <li${cls}><a class="pnav__top" href="#${esc(cat.id)}">${navTitle(cat)}</a>${sub}</li>`);
    }
    if (!opts.noCertificates) li.splice(opts.prefix ? 1 : 0, 0, `        <li><a class="pnav__top" href="#s8">💌 ${esc(certTitle(data))}</a></li>`);
    return li.join('\n');
  }

  /* Карточки витрины для главной: block = 'self' | 'two'. */
  function renderShowcase(data, block) {
    const ids = (data.showcase || {})[block] || [];
    const max = data.blocks?.[block]?.max || 8;
    return ids.slice(0, max).map((id) => {
      const f = findItem(data, id);
      if (!f) return '';
      const { cat, it } = f;
      const anchor = it.id;
      const facts = [];
      if (it.price) facts.push(['Цена', it.price]);
      if (it.duration) facts.push(['Время', it.duration]);
      const comp = it.composition || (it.items && it.items.length ? it.items.slice(0, 4).join(', ').toLowerCase() + '.' : '');
      if (comp) facts.push(['Состав', comp]);
      if (it.who) facts.push(['Кому', it.who]);
            const cap = (s) => { const t = String(s == null ? '' : s).trim(); return t ? t.charAt(0).toUpperCase() + t.slice(1) : t; };      const dl = facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(cap(v))}</dd>`).join('');
      const inner = `<h3>${esc(it.card || it.title)}</h3>
            ${it.desc ? `<p>${esc(it.desc)}</p>` : ''}
            <dl class="program-facts">${dl}</dl>`;
      const photo = photoOf(it);
      if (photo) {
        return `          <a class="program-card program-card--photo" href="price.html#${esc(anchor)}" style="--card-photo:url('${esc(photo)}')">
            <div class="program-card__body">${inner}</div>
          </a>`;
      }
      return `          <a class="program-card" href="price.html#${esc(anchor)}">
            ${inner}
          </a>`;
    }).join('\n');
  }

  /* Загрузка: сначала API, потом статичный файл. Возвращает null, если ничего не удалось. */
  async function load(paths) {
    for (const p of paths) {
      try {
        const r = await fetch(p, { cache: 'no-store' });
        if (!r.ok) continue;
        const j = await r.json();
        if (j && Array.isArray(j.categories)) return j;
      } catch (e) { /* пробуем следующий источник */ }
    }
    return null;
  }

  window.AlviPrice = { esc, load, findItem, isPopular, isPromoCat, renderSections, renderNav, renderShowcase, blockOf: BLOCK_BY_CATEGORY };
})();
