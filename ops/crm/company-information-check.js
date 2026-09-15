'use strict';

const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');

function publicIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a,b,c] = address.split('.').map(Number);
  return a > 0 && a < 224 && a !== 10 && a !== 127 && !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) &&
    !(a === 192 && b === 0) && !(a === 192 && b === 88 && c === 99) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) && !(a === 203 && b === 0 && c === 113);
}
function checkedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || net.isIP(url.hostname) ||
      !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) throw new Error('UNSAFE_URL');
  return url;
}
async function readPublicPage(value, {lookup = dns.lookup, request = https.request, timeout = 7000, maxBytes = 1000000, redirects = 2, deadline = Date.now()+timeout} = {}) {
  const url = checkedUrl(value);
  const remaining = () => {const ms=deadline-Date.now(); if(ms<=0) throw new Error('PAGE_TIMEOUT'); return Math.min(timeout,ms);};
  let dnsTimer;
  const addresses = await Promise.race([lookup(url.hostname,{all:true,family:4}),new Promise((_, reject) => {
    dnsTimer = setTimeout(() => reject(new Error('DNS_TIMEOUT')),remaining());
  })]).finally(()=>clearTimeout(dnsTimer));
  if (!addresses.length || addresses.some(item => !publicIPv4(item.address))) throw new Error('UNSAFE_ADDRESS');
  const address = addresses[0].address;
  const requestTimeout = remaining();
  const result = await new Promise((resolve,reject) => {
    let finished = false, timer;
    const done = (error,result) => {if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(result);};
    const req = request(url, {method:'GET',agent:false, family:4,
      lookup(host,options,callback) {callback(null,options?.all ? [{address,family:4}] : address,4);},
      headers:{'user-agent':'Synapse-Information-Check/1.0','accept':'text/html,application/xhtml+xml','accept-encoding':'identity'}},response => {
      if ([301,302,303,307,308].includes(response.statusCode)) {
        done(null,{redirect:response.headers.location}); response.destroy(); return;
      }
      if (response.statusCode !== 200 || !/text\/html|application\/xhtml\+xml/i.test(response.headers['content-type'] || '')) {
        done(new Error('PAGE_UNAVAILABLE')); response.destroy(); return;
      }
      if (Number(response.headers['content-length']) > maxBytes) {done(new Error('PAGE_TOO_LARGE')); response.destroy(); return;}
      let size = 0; const chunks = [];
      response.on('data',chunk => {if(finished)return;size += chunk.length; if (size > maxBytes) {done(new Error('PAGE_TOO_LARGE')); response.destroy();} else chunks.push(chunk);});
      response.on('end',() => done(null,{url:url.href,html:Buffer.concat(chunks).toString('utf8')}));
      response.on('error',() => done(new Error('PAGE_UNAVAILABLE')));
      response.on('aborted',() => done(new Error('PAGE_UNAVAILABLE')));
    });
    timer = setTimeout(() => {done(new Error('PAGE_TIMEOUT')); req.destroy();},requestTimeout);
    req.on('error',() => done(new Error('PAGE_UNAVAILABLE'))); req.end();
  });
  if (result.redirect) {
    if (!redirects) throw new Error('TOO_MANY_REDIRECTS');
    return readPublicPage(new URL(result.redirect,url).href,{lookup,request,timeout,maxBytes,redirects:redirects-1,deadline});
  }
  return result;
}
const decode = value => String(value).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Math.min(Number(n),0x10ffff)))
  .replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>');
const phone = value => {let digits = String(value).replace(/\D/g,''); if (digits.length === 11 && digits[0] === '8') digits='7'+digits.slice(1); return digits;};
const normalized = value => decode(value).normalize('NFKC').toLocaleLowerCase('ru').replace(/[\s\u00a0]+/g,' ').trim();
function extractContacts(html) {
  const phones = [], emails = [], addresses = [], hours = [], names = [];
  for (const match of html.matchAll(/href\s*=\s*["'](tel:|mailto:)([^"']+)["']/gi)) {
    let value; try {value=decodeURIComponent(decode(match[2])).split('?')[0];} catch {continue;}
    (match[1].toLowerCase() === 'tel:' ? phones : emails).push(value);
  }
  function visit(node,depth=0) {
    if (!node || typeof node !== 'object' || depth>10) return;
    if (Array.isArray(node)) {node.slice(0,50).forEach(item=>visit(item,depth+1));return;}
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (types.some(type => /^(?:LocalBusiness|Organization|HealthAndBeautyBusiness|BeautySalon|DaySpa|HairSalon|SportsActivityLocation)$/.test(type))) {
      if (typeof node.telephone === 'string') phones.push(node.telephone);
      if (typeof node.email === 'string') emails.push(node.email);
      if (typeof node.name === 'string') names.push(node.name);
      if (typeof node.address === 'string') addresses.push(node.address);
      else if (node.address?.streetAddress) addresses.push(node.address.streetAddress);
      if (typeof node.openingHours === 'string') hours.push(node.openingHours);
    }
    if (node['@graph']) visit(node['@graph'],depth+1);
  }
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {visit(JSON.parse(match[1]));} catch {}
  }
  return Object.fromEntries(Object.entries({phone:phones,email:emails,address:addresses,hours,names})
    .map(([key,values])=>[key,[...new Set(values)].slice(0,20)]));
}
function createCompanyInformationCheck({readPage=readPublicPage, now=Date.now}={}) {
  return async function check({profile,revision}) {
    const deadline=Date.now()+20000;
    const links = [...(profile.socials || []).filter(row=>row.type === 'two_gis'),
      ...(profile.websiteUrl ? [{type:'website',url:profile.websiteUrl}] : []),
      ...(profile.socials || []).filter(row=>row.type !== 'two_gis')];
    const unique = [...new Map(links.filter(row=>row?.url).map(row=>[row.url,row])).values()].slice(0,12);
    const output=[];
    for (let offset=0;offset<unique.length;offset+=3) output.push(...await Promise.all(unique.slice(offset,offset+3).map(async link=>{
      const base={platformId:link.type,url:link.url,revision,checkedAt:new Date(now()).toISOString(),fields:[]};
      if (!['website','two_gis','yandex_maps','vk','telegram_channel','max'].includes(link.type)) return {...base,status:'not_supported',message:'Для этой площадки пока доступно хранение ссылки.'};
      try {
        const page=await readPage(link.url,{deadline:Math.min(deadline,Date.now()+7000)}), found=extractContacts(page.html);
        const fields=['phone','email','address','hours'].filter(field=>String(profile[field]||'').trim()).map(field=>{
          const values=found[field], expected=String(profile[field]);
          const normalize=field==='phone' ? phone : normalized;
          const matching=values.some(value=>normalize(value)===normalize(expected));
          return {field,expected,observed:values.join(' · '),status:matching?'matches':values.length?'differs':'unverified',
            evidence:values.length?`Опубликованные контакты: ${values.join(' · ')}`:'Поле не удалось прочитать из открытой страницы.'};
        });
        return {...base,url:page.url || link.url,fields,status:fields.some(field=>field.status==='differs')?'differences':'partial',
          message:'Проверены доступные контакты. Услуги, цены, акции и изображения требуют отдельной сверки; общий статус «Актуально» не присвоен.'};
      } catch {return {...base,status:'unavailable',message:'Не удалось прочитать открытую страницу. Данные в ЛК сохранены; требуется проверка площадки.'};}
    })));
    return {checks:output};
  };
}
module.exports={createCompanyInformationCheck,readPublicPage,publicIPv4,checkedUrl,extractContacts};
