/* Main-page showcase only: the existing price anchor supplies full details.
   No copied prices, booking URLs or service content; desktop stays unchanged. */
(function () {
  'use strict';

  function prepareCard(card) {
    if (card.classList.contains('program-card--compact-ready')) return true;
    const titleLink = card.querySelector('h3 .program-card__link');
    const actions = card.querySelector('.pc__actions');
    const href = titleLink && titleLink.getAttribute('href');
    if (!href || !actions) return false;

    const details = document.createElement('a');
    details.className = 'pc__button program-card__details';
    details.href = href;
    details.textContent = 'Подробнее';
    details.setAttribute('aria-label', 'Подробнее: ' + titleLink.textContent.trim());
    actions.append(details);

    /* Retain only these facts in the small view, regardless of their order.
       All other facts remain available in the unchanged desktop card. */
    card.querySelectorAll('.program-facts dt').forEach((label) => {
      if (!/^(Цена|Время)$/iu.test(label.textContent.trim())) return;
      label.classList.add('program-fact--compact');
      const value = label.nextElementSibling;
      if (value && value.tagName === 'DD') value.classList.add('program-fact--compact');
    });
    card.classList.add('program-card--compact-ready');
    return true;
  }

  function init() {
    document.querySelectorAll('#for-self .program-grid, #for-two .program-grid').forEach((grid) => {
      const refresh = () => {
        const cards = Array.from(grid.querySelectorAll(':scope > .program-card'));
        const ready = cards.map(prepareCard);
        grid.classList.toggle('program-grid--compact-ready', cards.length > 0 && ready.every(Boolean));
      };
      refresh();
      /* The price loader replaces fallback markup asynchronously. */
      new MutationObserver(refresh).observe(grid, { childList: true, subtree: true });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
