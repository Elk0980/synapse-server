/* Avokado: one price document for the service showcase and full catalogue. */
(function(){
'use strict';
const esc=AlviPrice.esc;
const groups=[
{id:'laser',title:'Лазерная эпиляция',headline:'Меньше времени на бритьё. Больше — на себя.',intro:'Выберите отдельную зону или несколько зон за один визит. Подходящий вариант и подготовку обсудим перед процедурой.'},
{id:'apparatus',title:'Аппаратный массаж',headline:'Коррекция фигуры начинается с первого визита.',intro:'Знакомство с процедурой, работа с выбранными зонами и программа под вашу цель.'},
{id:'manual',title:'Ручной массаж и массаж лица',headline:'Время для себя — в руках мастера.',intro:'Массаж тела или лица: выбирайте подходящую процедуру и обсудите пожелания со специалистом.'}
];
function group(cat,it){if(['laser','apparatus','manual'].includes(it.direction))return it.direction;if(cat.id.startsWith('laser'))return 'laser';if(cat.id==='apparat'||(cat.id==='first-visit'&&it.id!=='first-3'))return 'apparatus';return 'manual';}
function safeUrl(value,fallback){try{const u=new URL(value,location.href);return ['https:','http:','tel:'].includes(u.protocol)?u.href:fallback;}catch(e){return fallback;}}
function contactUrl(full){return full?'index.html#contacts':'#contacts';}
function actions(data,id,full){return `<div class="av-actions"><a class="av-button av-button--gold" data-entry-point="catalog_${esc(id)}" href="${esc(safeUrl(data.links?.book,'#contacts'))}" target="_blank" rel="noopener">Записаться</a><a class="av-button" href="${contactUrl(full)}" data-contact-route data-entry-point="catalog_help_${esc(id)}">Помочь с выбором</a></div>`;}
function card(data,it,full,direction){
const photo=it.photo?safeUrl(it.photo,''):'';
const extra=[...(it.composition?[['Состав',it.composition]]:[]),...(it.who?[['Кому',it.who]]:[])];
const description=(it.desc?`<p class="av-description">${esc(it.desc)}</p>`:'')+(extra.length?`<dl class="av-facts">${extra.map(([k,v])=>`<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`:'')+(full&&it.items?.length?`<ul>${it.items.map(v=>`<li>${esc(v)}</li>`).join('')}</ul>`:'');
return `<article class="av-card${photo?' av-card--photo':''}" ${full?`id="${esc(it.id)}"`:''} data-service="${esc(it.id)}">${photo?`<img class="av-card-photo" src="${esc(photo)}" alt="" loading="lazy">`:''}<div class="av-card-body">${it.promo?'<p class="av-tag">Специальное предложение</p>':''}<h3>${full?esc(it.title):`<a href="price.html#${esc(it.id)}">${esc(it.card||it.title)}</a>`}</h3><dl class="av-facts av-facts--primary"><dt>Цена</dt><dd>${esc(it.price||'—')}${it.oldPrice?` <s>${esc(it.oldPrice)}</s>`:''}</dd>${direction==='laser'?'':`<dt>Время</dt><dd>${esc(it.duration||'—')}</dd>`}</dl>${description?`<details class="av-card-details" open><summary>Подробнее об услуге</summary><div class="av-card-details-content">${description}</div></details>`:''}${actions(data,it.id,full)}</div></article>`;
}
function table(data,cat,direction){const showTime=direction!=='laser';return `<div class="av-table-wrap"><table class="av-table${showTime?'':' av-table--no-duration'}"><thead><tr><th>Услуга</th>${showTime?'<th>Время</th>':''}<th>Цена</th></tr></thead><tbody>${cat.items.map(it=>`<tr id="${esc(it.id)}" data-service="${esc(it.id)}"><th scope="row">${esc(it.title)}${it.desc?`<small>${esc(it.desc)}</small>`:''}</th>${showTime?`<td>${esc(it.duration||'—')}</td>`:''}<td>${esc(it.price||'—')}${it.oldPrice?` <s>${esc(it.oldPrice)}</s>`:''}</td></tr>`).join('')}</tbody></table></div>${actions(data,cat.id,true)}`;}
function gift(data,full){const c=data.certificates||{};return `<section class="av-direction av-gift" id="certificate"><div><p class="av-kicker">04 · Сертификаты</p><h2>${esc(c.intro||'Подарите время для себя')}</h2><p class="av-intro">${esc(c.note||'Обсудите номинал и оформление сертификата с администратором студии.')}</p>${(c.types||[]).map(t=>`<h3>${esc(t.title)}</h3><p>${esc(t.text)}</p>`).join('')}<a class="av-button av-button--gold" href="${contactUrl(full)}" data-contact-route data-entry-point="catalog_certificate">${esc(c.button||'Обсудить сертификат')}</a></div><img src="${esc(safeUrl(c.photo||'assets/certificate-avokado-light.svg','assets/certificate-avokado-light.svg'))}" alt="Подарочный сертификат Авокадо" loading="lazy"></section>`;}
function render(data,full){const selected=new Set([...(data.showcase?.self||[]),...(data.showcase?.two||[])]);const output=[];for(const [i,g] of groups.entries()){const cats=(data.categories||[]).map(cat=>({...cat,items:(cat.items||[]).filter(it=>group(cat,it)===g.id)})).filter(cat=>cat.items.length);const all=cats.flatMap(c=>c.items);const items=full?all:[...selected].map(id=>all.find(it=>it.id===id)).filter(Boolean);let body;if(full){body=cats.map(cat=>`<div class="av-category" id="${g.id}-${esc(cat.id)}"><h3 class="av-category-title">${esc(cat.title)}</h3>${cat.kind==='table'?table(data,cat,g.id):`<div class="av-grid">${cat.items.map(it=>card(data,it,true,g.id)).join('')}</div>`}</div>`).join('');}else{body=`<div class="av-grid">${items.map(it=>card(data,it,false,g.id)).join('')}</div><a class="av-price-link" href="price.html#${g.id}">Посмотреть весь прайс — ${esc(g.title.toLowerCase())} →</a>`;}
output.push(`<section class="av-direction" id="${g.id}"><p class="av-kicker">0${i+1} · ${esc(g.title)}${g.id==='apparatus'?' · коррекция фигуры':''}</p><h2>${full?esc(g.title):esc(g.headline)}</h2><p class="av-intro">${esc(g.intro)}</p>${body}</section>`);}
return output.join('')+gift(data,full);}
function prepare(data,defaults){
 const source=data||defaults;if(!source||source.catalogVersion>=3)return source;
 const out=JSON.parse(JSON.stringify(source));
 if((out.catalogVersion||0)<2&&defaults){
 const initial=out.version===1&&out.updatedAt==='2026-09-04T00:00:00.000Z'&&out.blocks?.self?.title==='Авокадо'&&JSON.stringify(out.showcase?.self)===JSON.stringify(['first-1'])&&!(out.showcase?.two||[]).length;
 for(const cat of out.categories||[])for(const it of cat.items||[]){const found=AlviPrice.findItem(defaults,it.id);if(!found)continue;for(const k of ['photo','promo','direction'])if(it[k]===undefined&&found.it[k]!==undefined)it[k]=found.it[k];if(initial&&cat.id==='first-visit')it.card=found.it.card;if(!it.duration&&found.it.duration)it.duration=found.it.duration;}
 if(initial){out.showcase=defaults.showcase;out.blocks=defaults.blocks;}
 if(!Object.keys(out.certificates||{}).length)out.certificates=defaults.certificates;
 }
 // One-time owner-requested correction. Version 3 keeps subsequent editor changes intact.
 for(const cat of out.categories||[])for(const it of cat.items||[]){
  if(!it.promo&&cat.id!=='first-visit'&&cat.id!=='laser-offers')continue;
  it.duration='45 мин';
  for(const key of ['title','card'])if(typeof it[key]==='string')it[key]=it[key].replace(/\b\d+\s*мин(?:ут[аы]?)?\.?/gi,'45 мин');
 }
 out.catalogVersion=3;return out;
}
window.AvokadoCatalog={render,group,prepare};
const target=document.getElementById('av-catalog-content');if(!target)return;
const full=document.body.hasAttribute('data-full-price');
Promise.all([AlviPrice.load(['/api/price']),AlviPrice.load(['data/price.json'])]).then(([live,defaults])=>{const data=prepare(live,defaults);if(!data){target.innerHTML='<p class="av-loading">Прайс временно недоступен. <a href="tel:+79331901059">Уточнить у студии</a></p>';return;}target.innerHTML=render(data,full);document.dispatchEvent(new Event('avokado:catalog-ready'));const compact=matchMedia('(max-width:700px)');const fitCards=()=>target.querySelectorAll('.av-card-details').forEach(el=>{el.open=!compact.matches;});fitCards();compact.addEventListener('change',fitCards);if(location.hash){const el=document.getElementById(decodeURIComponent(location.hash.slice(1)));if(el&&target.contains(el))el.scrollIntoView();}});
})();
