/* Owner-supplied comparisons: equal crop scale, manual browsing, no autoplay. */
(function () {
  'use strict';
  const scene = document.getElementById('method-results');
  if (!scene) return;
  const rail = scene.querySelector('.results-rail');
  const cards = Array.from(scene.querySelectorAll('.results-card'));
  const filters = Array.from(scene.querySelectorAll('.results-filter'));
  const previous = scene.querySelector('[data-results-previous]');
  const next = scene.querySelector('[data-results-next]');
  const count = scene.querySelector('.results-count');
  const dialog = document.getElementById('results-dialog');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  if (!rail || !cards.length || !previous || !next || !count) return;
  let visible = cards;
  let modalIndex = 0;
  let returnFocus = null;
  let savedOverflow = '';
  const dialogImage = dialog && dialog.querySelector('.results-dialog-image');
  const dialogTitle = dialog && dialog.querySelector('.results-dialog-title');
  const dialogCount = dialog && dialog.querySelector('.results-dialog-count');
  const dialogPrevious = dialog && dialog.querySelector('[data-dialog-previous]');
  const dialogNext = dialog && dialog.querySelector('[data-dialog-next]');

  function firstIndex() {
    const left = rail.getBoundingClientRect().left;
    let nearest = 0;
    let distance = Infinity;
    visible.forEach((card, index) => {
      const value = Math.abs(card.getBoundingClientRect().left - left);
      if (value < distance) { nearest = index; distance = value; }
    });
    return nearest;
  }
  function pageSize() {
    const width = visible[0] && visible[0].getBoundingClientRect().width;
    return width ? Math.max(1, Math.round(rail.clientWidth / width)) : 1;
  }
  function updateControls() {
    const first = firstIndex();
    const last = Math.min(visible.length, first + pageSize());
    const label = (last === first + 1 ? String(last) : (first + 1) + '–' + last) + ' / ' + visible.length;
    if (count.textContent !== label) count.textContent = label;
    previous.disabled = rail.scrollLeft < 2;
    next.disabled = rail.scrollLeft >= rail.scrollWidth - rail.clientWidth - 2;
  }
  function go(index) {
    const target = visible[Math.max(0, Math.min(visible.length - 1, index))];
    if (!target) return;
    const left = rail.scrollLeft + target.getBoundingClientRect().left - rail.getBoundingClientRect().left;
    rail.scrollTo({ left, behavior: reduced.matches ? 'instant' : 'smooth' });
  }
  function filter(category) {
    cards.forEach(card => { card.hidden = card.dataset.resultCategory !== category; });
    visible = cards.filter(card => !card.hidden);
    filters.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.resultFilter === category)));
    rail.scrollTo({ left: 0, behavior: 'instant' });
    requestAnimationFrame(updateControls);
  }
  filters.forEach(button => button.addEventListener('click', () => filter(button.dataset.resultFilter)));
  previous.addEventListener('click', () => go(firstIndex() - pageSize()));
  next.addEventListener('click', () => go(firstIndex() + pageSize()));
  let queued = false;
  rail.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; updateControls(); });
  }, { passive: true });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(updateControls).observe(rail);
  rail.addEventListener('keydown', event => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    go(firstIndex() + (event.key === 'ArrowRight' ? pageSize() : -pageSize()));
  });

  function renderModal() {
    const card = visible[modalIndex];
    const source = card.querySelector('.results-comparison, img');
    dialogImage.replaceChildren(source.cloneNode(true));
    dialogTitle.textContent = card.querySelector('figcaption span').textContent;
    dialogCount.textContent = (modalIndex + 1) + ' / ' + visible.length;
    dialogPrevious.disabled = modalIndex === 0;
    dialogNext.disabled = modalIndex === visible.length - 1;
  }
  if (dialog && typeof dialog.showModal === 'function') {
    cards.forEach(card => card.querySelector('a').addEventListener('click', event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      modalIndex = visible.indexOf(card);
      if (modalIndex < 0) return;
      returnFocus = event.currentTarget;
      renderModal();
      savedOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      dialog.showModal();
    }));
    dialogPrevious.addEventListener('click', () => { if (modalIndex > 0) { modalIndex--; renderModal(); } });
    dialogNext.addEventListener('click', () => { if (modalIndex < visible.length - 1) { modalIndex++; renderModal(); } });
    dialog.querySelector('[data-dialog-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        modalIndex = Math.max(0, Math.min(visible.length - 1, modalIndex + (event.key === 'ArrowRight' ? 1 : -1)));
        renderModal();
      }
    });
    dialog.addEventListener('close', () => {
      document.documentElement.style.overflow = savedOverflow;
      if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
    });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
  }
  filter('body');
})();
