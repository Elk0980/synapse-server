/* Source of an application entrance, never a client identity or a paid visit. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.SynapseAppEntrySource=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const labels=Object.freeze({'2gis':'2ГИС',telegram:'Telegram',vk:'ВК',instagram:'Instagram',youtube:'YouTube',tiktok:'TikTok',max:'MAX',yandex_maps:'Яндекс Карты',yandex:'Яндекс',google:'Google',whatsapp:'WhatsApp',other:'Другой источник',unknown:'Прямой вход / источник неизвестен'});
 const aliases=Object.freeze({'2gis':'2gis','2гис':'2gis',dgis:'2gis',telegram:'telegram',tg:'telegram','t.me':'telegram',vk:'vk',vkontakte:'vk','vk.com':'vk','vk.ru':'vk',instagram:'instagram',ig:'instagram',youtube:'youtube',yt:'youtube',tiktok:'tiktok',max:'max',yandex_maps:'yandex_maps',yandexmaps:'yandex_maps',yandex:'yandex',ya:'yandex',google:'google',whatsapp:'whatsapp',wa:'whatsapp'});
 const companies=new Set(['palitra-love','alvi','avokado']);
 const parse=value=>{try{const u=new URL(value);return ['https:','http:','android-app:'].includes(u.protocol)&&!u.username&&!u.password?u:null;}catch(_){return null;}};
 const domain=(host,name)=>host===name||host.endsWith('.'+name);
 function classify({url,referrer='',companyCode,ownedOrigins=[]}={}){
  if(!companies.has(companyCode))throw new TypeError('Компания входа не подтверждена');
  const landing=parse(url);if(!landing||!['https:','http:'].includes(landing.protocol))throw new TypeError('Нужен адрес приложения');
  const tagged=landing.searchParams.getAll('utm_source');
  if(tagged.length===1&&tagged[0].trim())return Object.freeze({companyCode,source:aliases[tagged[0].trim().toLowerCase()]||'other',evidence:'link_tag'});
  if(tagged.length>1)return Object.freeze({companyCode,source:'unknown',evidence:'ambiguous_tag'});
  const ref=parse(referrer);
  if(!ref)return Object.freeze({companyCode,source:'unknown',evidence:'unavailable'});
  if(ref.origin===landing.origin||ownedOrigins.includes(ref.origin))return Object.freeze({companyCode,source:'unknown',evidence:'internal'});
  const host=ref.hostname.toLowerCase().replace(/^www\./,'');let source='other';
  if(['2gis.ru','2gis.com','2gis.kz','2gis.kg','2gis.uz'].some(d=>domain(host,d)))source='2gis';
  else if(host==='t.me'||domain(host,'telegram.org')||host==='org.telegram.messenger')source='telegram';
  else if(['vk.com','vk.ru'].some(d=>domain(host,d))||host==='com.vkontakte.android')source='vk';
  else if(domain(host,'instagram.com'))source='instagram';
  else if(domain(host,'youtube.com')||host==='youtu.be')source='youtube';
  else if(domain(host,'tiktok.com'))source='tiktok';
  else if(domain(host,'max.ru'))source='max';
  else if(['wa.me','whatsapp.com'].some(d=>domain(host,d))||host==='com.whatsapp')source='whatsapp';
  else if(domain(host,'yandex.ru')||domain(host,'ya.ru'))source=host==='maps.yandex.ru'||ref.pathname==='/maps'||ref.pathname.startsWith('/maps/')?'yandex_maps':'yandex';
  else if(['google.com','google.ru'].some(d=>domain(host,d)))source='google';
  return Object.freeze({companyCode,source,evidence:'referrer'});
 }
 // Same document/route reload in an SPA is not another entrance. Company switches
 // are not external acquisition and must use their own business event if needed.
 function create({send,companyCode,url,referrer,ownedOrigins}={}){
  if(typeof send!=='function')throw new TypeError('Нужно подключение статистики');let sent=false;
  return Object.freeze({enter:async({audience='customer',doNotTrack=false}={})=>{
   if(sent||audience!=='customer'||doNotTrack)return false;
   const value=classify({companyCode,url,referrer,ownedOrigins});
   if(value.evidence==='internal')return false;
   sent=true; // Unknown delivery is never blindly replayed with a second event id.
   await send(value);return true;
  }});
 }
 // Called only by a verified customer entry. It is not auto-mounted in the staff
 // cabinet. Uses no cookies, localStorage, contacts, raw URLs or fingerprint.
 function mount({window:w,companyCode,endpoint='/app-entry',analyticsAllowed=()=>false,audience='customer',ownedOrigins=[]}={}){
  if(!w||typeof analyticsAllowed!=='function'||endpoint!=='/app-entry')throw new TypeError('Нужна проверенная точка сбора входов');
  let url=new URL(w.location.href),referrer=w.document.referrer||'';
  const standalone=Boolean(w.navigator.standalone||w.matchMedia?.('(display-mode: standalone)').matches);
  // An installed launch URL can retain old UTM tags. A home-screen launch is
  // never credited to that old campaign without a fresh external referrer.
  if(standalone&&!referrer)url.search='';
  const eventId=w.crypto.randomUUID();
  const tracker=create({companyCode,url:url.href,referrer,ownedOrigins,send:async value=>{
   const response=await w.fetch(endpoint,{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({eventId,source:value.source,evidence:value.evidence})});
   if(response.status!==202)throw new Error('Статистика входа не подтверждена');
  }});
  return Object.freeze({enter:()=>tracker.enter({audience,doNotTrack:!analyticsAllowed()||w.navigator.doNotTrack==='1'||w.navigator.globalPrivacyControl===true})});
 }
 return Object.freeze({labels,classify,create,mount});
});
