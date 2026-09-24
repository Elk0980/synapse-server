(() => {
  'use strict';
  const cabinet = window.SbCabinet = window.SbCabinet || {};
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const aliases = {
    '2gis':'two_gis', dgis:'two_gis', 'two-gis':'two_gis',
    'yandex-maps':'yandex_maps', 'yandex-business':'yandex_maps', yandex_business:'yandex_maps',
    'vk-ads':'vk_ads', 'telegram-ads':'telegram', telegram_channel:'telegram',
    'yandex-direct':'yandex_direct', 'yandex-rsya':'yandex_direct', 'yandex-master':'yandex_direct',
    'yandex-product':'yandex_direct', 'yandex-display':'yandex_direct'
  };
  const destinations = {
    two_gis:['https://account.2gis.com/', 'Открыть кабинет 2ГИС'],
    yandex_maps:['https://business.yandex.ru/', 'Открыть Яндекс Бизнес'],
    vk:['https://vk.com/', 'Открыть ВКонтакте'],
    youtube:['https://studio.youtube.com/', 'Открыть YouTube Studio'],
    vk_ads:['https://ads.vk.com/', 'Открыть VK Рекламу'],
    yandex_direct:['https://direct.yandex.ru/', 'Открыть Яндекс Директ'],
    telegram:['https://web.telegram.org/', 'Открыть Telegram'],
    // Existing publishing integration uses the Russian Onlypult application.
    onlypult:['https://app.ru.onlypult.com/', 'Открыть Onlypult']
  };
  const labels = {website:'Сайт',two_gis:'2ГИС',yandex_maps:'Яндекс Карты',max:'MAX',telegram:'Telegram — чат',telegram_channel:'Telegram — канал',whatsapp:'WhatsApp',vk:'ВКонтакте',booking:'Онлайн-запись',youtube:'YouTube'};
  const normalize = value => {const id=String(value || '').toLowerCase().trim();return Object.hasOwn(aliases,id) ? aliases[id] : id;};
  function safeUrl(value) {
    if (typeof value !== 'string' || !/^https:\/\//i.test(value) || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || url.hostname.endsWith('.localhost')) return null;
      // Do not turn an accidentally saved authentication URL into a clickable secret.
      const sensitive = /token|secret|password|passwd|authorization|api[_-]?key|signature|session|^(?:auth|key|code)$/i;
      if ([...url.searchParams.keys()].some(key => sensitive.test(key))) return null;
      if (/(?:token|secret|password|authorization|api[_-]?key|session|(?:^|[&#?])code)\s*=/i.test(decodeURIComponent(url.hash))) return null;
      return url.href;
    } catch (_) { return null; }
  }
  function link(url, label, kind = 'public') {
    const href = safeUrl(url);
    return href ? `<a class="plain-button" data-platform-link="${kind === 'cabinet' ? 'cabinet' : 'public'}" href="${escape(href)}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>` : '';
  }
  const cabinetLink = platform => {
    const id = normalize(platform), destination = Object.hasOwn(destinations,id) ? destinations[id] : null;
    return destination ? link(destination[0], destination[1], 'cabinet') : '';
  };
  const profileFor = (companyCode, record) => companyCode && record?.companyCode === companyCode ? record.profile : null;
  function companyLink({companyCode, record, platform, label = 'Открыть страницу компании'}) {
    const profile = profileFor(companyCode, record);
    if (!profile) return '';
    const socialType = value => value === 'telegram_channel' ? value : normalize(value);
    const id = socialType(platform);
    const url = id === 'website' ? profile.websiteUrl : (Array.isArray(profile.socials) ? profile.socials : [])
      .find(item => socialType(item.type) === id && safeUrl(item.url))?.url;
    return link(url, label);
  }
  function companyLinks({companyCode, record}) {
    const profile = profileFor(companyCode, record);
    if (!profile) return '';
    const items = [{type:'website',url:profile.websiteUrl}, ...(Array.isArray(profile.socials) ? profile.socials : [])];
    return items.map(item => {
      const publicLink = link(item.url, item.label || labels[item.type] || 'Сохранённая ссылка');
      return publicLink ? `<li>${publicLink}${cabinetLink(item.type) ? ' · ' + cabinetLink(item.type) : ''}</li>` : '';
    }).join('');
  }
  function vkCommunityLink({companyCode, record}) {
    if (!companyCode || record?.companyCode !== companyCode || !record.connected || !/^[1-9]\d{0,15}$/.test(String(record.groupId || '')) || !Number.isSafeInteger(Number(record.groupId))) return '';
    return link('https://vk.com/club' + record.groupId, 'Открыть сообщество компании');
  }
  cabinet.platformLinks = Object.freeze({safeUrl, normalize, link, cabinetLink, companyLink, companyLinks, vkCommunityLink});
})();
