'use strict';

const COMPANY_LINK_TYPES = Object.freeze([
  'two_gis', 'yandex_maps', 'max', 'telegram', 'telegram_channel', 'whatsapp', 'vk', 'booking',
]);
const publicTypes = new Set(COMPANY_LINK_TYPES);

function publicLinkUrl(value) {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!url || url.length > 2000 || /[\u0000-\u001f\u007f]/.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return url;
  } catch {
    return null;
  }
}

// Project only explicitly typed public URLs. Handles and labels cannot establish
// whether a Telegram address is a booking chat or a channel, so never guess.
function companyPublicLinks(company) {
  const links = {};
  const website = publicLinkUrl(company.website_url);
  if (website) links.website = website;
  let socials = company.socials;
  if (typeof socials === 'string') {
    try { socials = JSON.parse(socials); } catch { socials = []; }
  }
  if (Array.isArray(socials)) for (const social of socials) {
    if (!social || typeof social !== 'object' || Array.isArray(social)) continue;
    const type = typeof social.type === 'string' ? social.type.trim().toLowerCase() : '';
    if (!publicTypes.has(type) || Object.hasOwn(links, type)) continue;
    const url = publicLinkUrl(social.url);
    if (url) links[type] = url;
  }
  return { companyCode: company.code.toLowerCase(), links };
}

module.exports = { COMPANY_LINK_TYPES, publicLinkUrl, companyPublicLinks };
