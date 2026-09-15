/* Owner rule: choose the communication channel in Contacts. */
(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host && host.document) api.start(host.document, host.location);
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  function isSocial(value, base) {
    try {
      const url = new URL(value, base);
      if (['whatsapp:', 'tg:', 'viber:'].includes(url.protocol)) return true;
      if (!['https:', 'http:'].includes(url.protocol)) return false;
      return /(^|\.)(wa\.me|whatsapp\.com|t\.me|telegram\.me|telegram\.org|vk\.com|vk\.me|vkontakte\.ru|instagram\.com|facebook\.com|fb\.com|messenger\.com|m\.me|ok\.ru|max\.ru)$/.test(url.hostname);
    } catch (_) { return false; }
  }
  function start(doc, location) {
    if (/(^|\/)contacts\.html$/.test(location.pathname)) return;
    const destination = doc.getElementById('contacts') ? '#contacts' : 'index.html#contacts';
    function rewrite(anchor) {
      if (anchor.closest('#contacts,[data-contact-choices]')) return;
      if (!isSocial(anchor.getAttribute('href'), location.href)) return;
      anchor.setAttribute('href', destination);
      anchor.removeAttribute('target');
      anchor.setAttribute('data-contact-route', '');
    }
    function scan(node) {
      if (node.matches && node.matches('a[href]')) rewrite(node);
      if (node.querySelectorAll) node.querySelectorAll('a[href]').forEach(rewrite);
    }
    scan(doc);
    // Price loading and site-editor hydration can add or replace links after first render.
    new MutationObserver(records => records.forEach(record => {
      if (record.type === 'attributes') rewrite(record.target);
      else record.addedNodes.forEach(scan);
    })).observe(doc.body, {subtree:true,childList:true,attributes:true,attributeFilter:['href']});
  }
  return {isSocial,start};
});
