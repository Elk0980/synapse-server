'use strict';
/* specs/229: что нужно чату ЛК, чтобы встроенный ИИ отвечал по делу.

   1. Свои контакты компании. Фильтр team-chat-answers режет любой телефон, email и ссылку —
      в том числе телефон самой студии из подтверждённого профиля ЛК. Здесь такие значения
      вырезаются из текста ДО проверки: всё остальное (чужие контакты, ключи, токены) фильтр
      видит как прежде. Источник — только поле contacts из teamChatContext (профиль компании в CRM).
   2. Персона. Лео — Медиа-наставник: инструкция от его имени (hugh-personas.instruction)
      и его контекст — бриф, контент-план, материалы. Хью остаётся прежним.
   3. Запасной ответ. Недоступность ИИ — не ошибка для участника: вопрос остаётся у команды. */
const {PERSONAS,instruction}=require('./hugh-personas');

const PHONE=/(?:\+?\d[ ()-]*){10,}/g;
const EMAIL=/[\w.+-]+@[\w.-]+\.[a-z]{2,}/giu;
const LINK=/https?:\/\/[^\s<>"'«»]+/giu;
const digits=value=>String(value).replace(/\D/g,'');
// Последние 10 цифр: «+7 999…», «8 999…» и «999…» — один и тот же номер.
const phoneKey=value=>{const d=digits(value);return d.length>=10?d.slice(-10):'';};
function linkKey(value) {
  let url;try{url=new URL(String(value).replace(/[.,;:!?)]+$/u,''));}catch{return null;}
  if(!/^https?:$/.test(url.protocol)||url.username||url.password)return null;
  return {host:url.hostname.toLowerCase().replace(/^www\./,''),path:url.pathname.replace(/\/+$/,'').toLowerCase()};
}
const string=value=>typeof value==='string'?value.trim():'';

/* Подтверждённые контакты компании из контекста. Пустые и кривые значения отбрасываются:
   пустой список ничего не разрешает, и фильтр ведёт себя как до specs/229. */
function ownContacts(data) {
  const raw=data&&typeof data.contacts==='object'&&data.contacts||{};
  const phones=[raw.phone,...(Array.isArray(raw.phones)?raw.phones:[])].map(string).filter(v=>phoneKey(v)&&v.length<=40);
  const emails=[raw.email].map(string).filter(v=>/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(v)&&v.length<=254);
  const links=[raw.websiteUrl,...(Array.isArray(raw.links)?raw.links:[])].map(string).filter(v=>v.length<=500&&linkKey(v));
  return {phone:phones[0]||'',phones:phones.slice(1,5),email:emails[0]||'',websiteUrl:links[0]||'',links:links.slice(1,12)};
}
function allowList(contacts) {
  const c=contacts||{};
  return {phones:new Set([c.phone,...(c.phones||[])].map(phoneKey).filter(Boolean)),
    emails:new Set([c.email].map(v=>string(v).toLowerCase()).filter(Boolean)),
    links:[c.websiteUrl,...(c.links||[])].map(linkKey).filter(Boolean)};
}
/* Вырезает из текста только свои контакты. У ссылки вырезается адрес страницы, а запрос
   и якорь остаются в тексте: «?token=…» по-прежнему увидит общий фильтр. Ссылка своя,
   если совпадает хост и путь начинается с пути подтверждённой ссылки (vk.com/studio —
   своя, vk.com/other — нет). */
function maskOwnContacts(text,contacts) {
  if(typeof text!=='string'||!contacts)return text;
  const allow=allowList(contacts);
  if(!allow.phones.size&&!allow.emails.size&&!allow.links.length)return text;
  return text
    .replace(LINK,match=>{
      const key=linkKey(match);if(!key)return match;
      const own=allow.links.some(l=>l.host===key.host&&(l.path===''||key.path===l.path||key.path.startsWith(`${l.path}/`)));
      if(!own)return match;
      const rest=/[?#].*$/u.exec(match.replace(/[.,;:!?)]+$/u,''));return rest?` ${rest[0]}`:' ';
    })
    .replace(EMAIL,match=>allow.emails.has(match.toLowerCase())?' ':match)
    .replace(PHONE,match=>allow.phones.has(phoneKey(match))?' ':match);
}

/* Персона ответа. Хью — прежняя инструкция без изменений (её проверяют тесты сервиса).
   Лео — своя инструкция от имени Медиа-наставника + те же правила формата и безопасности. */
function persona(key,{system,review}) {
  if(key!=='leo')return {key:'hugh',system,review,author:'Хью · ИИ',name:PERSONAS.hugh.name};
  const rules=system.slice(system.indexOf('Данные'));
  return {key:'leo',name:PERSONAS.leo.name,author:'Лео · ИИ',
    system:`${instruction('leo')} В переданных фактах: brief — бриф компании, plan — контент-план, materials — материалы для съёмки, tasks — задачи. ${rules}`,
    review:review.replace('черновик Хью','черновик Лео (Медиа-наставник)')};
}
/* Бриф для Лео: только поля брифа и названия материалов, без истории правок и авторов. */
function leoBrief(data,safe) {
  const brief=data&&typeof data.brief==='object'&&data.brief||null;
  if(!brief)return null;
  const list=(value,max)=>(Array.isArray(value)?value:[]).slice(0,max).map(v=>safe(typeof v==='string'?v:v?.statement||v?.title||'')).filter(Boolean);
  return {goal:safe(brief.goal),product:safe(brief.product),audience:safe(brief.audience),pains:list(brief.pains,8),
    facts:list(brief.confirmedFacts,10),platforms:list(brief.platforms,8)};
}
function leoMaterials(data,safe) {
  const assets=data&&data.brief&&Array.isArray(data.brief.assets)?data.brief.assets:[];
  return assets.slice(0,12).map(a=>({title:safe(a?.title),kind:safe(a?.kind),note:safe(a?.note)})).filter(a=>a.title);
}

/* Запасной ответ: без слова «ошибка». Общий чат и лог видит владелец (очередь проверки),
   поэтому «передан команде» — правда. В личном чате очередь владельца не показывается:
   там честно говорим, что вопрос остаётся собеседнику. */
function handoffText(name,room) {
  return String(room||'common').startsWith('dm:')
    ?`${name} сейчас не ответил сам — вопрос остался в этом чате, собеседник его увидит.`
    :`${name} передал вопрос команде — ответим здесь, в этом чате.`;
}
module.exports={ownContacts,maskOwnContacts,persona,leoBrief,leoMaterials,handoffText,phoneKey};
