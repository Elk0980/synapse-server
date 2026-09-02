/* ALVI · применение текстов и фонов главной из документа alvi/site (редактируется в кабинете Synapse).
   Разметка страницы — запасной вариант: если документ недоступен, страница остаётся как есть. */
(function () {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /* Текст → безопасный HTML: разрешены только em, strong, b, i, sup и перенос строки. */
  function rich(value) {
    let h = esc(value);
    h = h.replace(/&lt;(\/?)(em|strong|b|i|sup)&gt;/g, '<$1$2>');
    return h.replace(/\n/g, '<br>');
  }

  function applyFields(doc) {
    const map = new Map();
    for (const sec of doc.sections || []) for (const f of sec.fields || []) map.set(f.key, f.value);
    document.querySelectorAll('[data-edit]').forEach((el) => {
      const key = el.getAttribute('data-edit');
      if (!map.has(key)) return;
      const html = rich(map.get(key));
      if (el.innerHTML.trim() !== html) el.innerHTML = html;
    });
  }

  function applyBackgrounds(doc) {
    for (const sec of doc.sections || []) {
      const bg = sec.background;
      if (!bg) continue;
      const section = document.getElementById(sec.id);
      if (!section) continue;
      let layer = section.querySelector(':scope > .section-backdrop');
      const image = bg.image || bg.default || '';
      if (!image && !layer) continue;
      if (!layer) {
        layer = document.createElement('div');
        layer.className = 'section-backdrop';
        layer.setAttribute('aria-hidden', 'true');
        section.prepend(layer);
      }
      layer.style.backgroundImage = image ? `url('${image.replace(/'/g, '%27')}')` : 'none';
      layer.style.opacity = bg.opacity != null && bg.opacity !== '' ? String(bg.opacity) : '';
    }
  }

  async function load() {
    for (const p of ['/api/site', 'data/site.json']) {
      try {
        const r = await fetch(p, { cache: 'no-store' });
        if (!r.ok) continue;
        const j = await r.json();
        if (j && Array.isArray(j.sections)) return j;
      } catch (e) { /* следующий источник */ }
    }
    return null;
  }

  window.AlviSite = { rich, applyFields, applyBackgrounds, load };

  const run = async () => {
    const doc = await load();
    if (!doc) return;
    applyFields(doc);
    applyBackgrounds(doc);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
})();
