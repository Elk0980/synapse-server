/* Keep machine-readable FAQ aligned with the cabinet-edited answers. */
(function () {
  'use strict';
  const root = document.getElementById('faq');
  const schema = document.getElementById('faq-schema');
  if (!root || !schema) return;
  const clean = node => (node?.textContent || '').replace(/\s+/g, ' ').trim();
  function excluded(node) {
    for (let el = node; el && el !== root.parentElement; el = el.parentElement) {
      if (el.hidden || el.getAttribute('aria-hidden') === 'true' ||
          el.style.display === 'none' || el.style.visibility === 'hidden') return true;
    }
    return false;
  }
  function sync() {
    const mainEntity = Array.from(root.querySelectorAll('details')).flatMap(item => {
      const question = item.querySelector('summary');
      const answer = item.querySelector('p');
      if (!question || !answer || excluded(question) || excluded(answer)) return [];
      const name = clean(question), text = clean(answer);
      return name && text ? [{ '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text } }] : [];
    });
    const canonical = document.querySelector('link[rel="canonical"]')?.href;
    const value = JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage',
      ...(canonical && { '@id': canonical.split('#')[0] + '#faq' }), mainEntity });
    if (schema.textContent !== value) schema.textContent = value;
  }
  sync();
  new MutationObserver(sync).observe(root, { childList: true, subtree: true,
    characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'style'] });
})();
