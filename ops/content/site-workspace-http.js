'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {TYPES,validPath}=require('./site-workspaces');

// PALITRA-MAIN: only on the approved production alias — remove <meta name="robots" …noindex|nofollow…> tags located
// before the first </head>. Body, scripts and every other byte stay exactly as published.
function indexableHead(buffer) {
  const text=buffer.toString('utf8');
  const end=text.search(/<\/head\s*>/i);
  if(end<0)return buffer;
  const head=text.slice(0,end);
  const clean=head.replace(/<meta\b[^>]*>/gi,tag=>/\bname\s*=\s*["']?robots["']?/i.test(tag)&&/noindex|nofollow/i.test(tag)?'':tag);
  return clean===head?buffer:Buffer.from(clean+text.slice(end),'utf8');
}

// The public host never reaches cabinet routes or cabinet sessions.
function createDraftHostHandler(workspaces,{accountFactory,alias=null,aliases=null}={}) {
  // PALITRA-MAIN: approved shop hostnames (host config) for exactly one fixed workspace; previous single alias still accepted.
  const aliasList=[...(Array.isArray(aliases)?aliases:[]),...(alias?[alias]:[])].filter(a=>a&&typeof a.hostname==='string'&&a.hostname);
  const accounts=new Map();
  // PALITRA: at most one route hook for one exactly fixed workspace, registered once by the host; without it nothing changes.
  let draftHook=null;
  // PALITRA-MAIN: one AccountService per workspace AND actual origin (same account database, origin-bound cookie/CSRF).
  const accountFor=(draft,origin='https://'+draft.hostname)=>{
    const key=draft.id+'|'+origin;
    let service=accounts.get(key);
    if(!service) {
      if(accounts.size>=100)return null;
      service=accountFactory(draft,origin);if(!service)return null;accounts.set(key,service);
    }
    return service;
  };
  async function handleDraftHost(request,response) {
    const hostname=String(request.headers.host||'').toLowerCase().split(':')[0];
    // PALITRA: an approved shop hostname (host config) maps only to its fixed published workspace; default none.
    const aliasEntry=aliasList.find(a=>a.hostname===hostname)||null;
    const aliased=Boolean(aliasEntry);
    if(!aliased&&!/^(?:[a-z0-9-]+-draft-\d+|palitra-draft)\.synapsebusiness\.ru$/.test(hostname))return false;
    let draft=workspaces.publishedHost(aliased?aliasEntry.canonicalHostname:hostname);
    if(aliased&&(!draft||draft.id!==aliasEntry.draftId||draft.company_code!==aliasEntry.companyCode||draft.runtime!=='palitra-draft'))draft=null;
    const json=(status,body,headers={})=>{
      response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});
      response.end(JSON.stringify(body));
    };
    // PALITRA-MAIN: only the explicitly approved production alias is indexable; every draft keeps noindex.
    const indexable=Boolean(aliasEntry&&aliasEntry.indexable===true&&draft);
    if(!indexable)response.setHeader('X-Robots-Tag','noindex, nofollow');
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Referrer-Policy','same-origin');
    response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; media-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors https://synapse.synapsebusiness.ru; base-uri 'self'");
    if(!draft){json(404,{message:'Черновик не найден'});return true;}
    const url=new URL(request.url,'https://'+hostname);
    // PALITRA: only the exact fixed workspace id + company + shop hostname reaches the hook, before the unchanged guard below.
    if(draftHook&&draft.runtime==='palitra-draft'&&draft.id===draftHook.draftId&&draft.company_code===draftHook.companyCode&&draftHook.hostnames.includes(hostname)) {
      if(await draftHook.handle({request,response,url,draft,hostname}))return true;
    }
    if(!(url.pathname==='/assets/order.js'&&['GET','HEAD'].includes(request.method))&&(url.pathname==='/api/orders'||url.pathname.includes('/submit')||url.pathname.includes('/order'))) {
      json(403,{message:'Это черновик. Реальные заявки не отправляются.'});return true;
    }
    if(url.pathname.startsWith('/api/draft-account/')&&draft.runtime==='palitra-draft'&&accountFactory) {
      const service=accountFor(draft,'https://'+hostname);
      if(!service){json(503,{message:'Сервис временно недоступен'});return true;}
      let body={};
      if(!['GET','HEAD'].includes(request.method)) {
        const chunks=[];let count=0;
        for await(const chunk of request) {
          count+=chunk.length;
          if(count>8192){json(413,{message:'Слишком большой запрос'});return true;}
          chunks.push(chunk);
        }
        try{body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}
        catch{json(400,{message:'Некорректные данные'});return true;}
      }
      const result=await service.dispatch({method:request.method,path:url.pathname.slice('/api/draft-account'.length),
        body,headers:request.headers,ip:request.socket.remoteAddress||'unknown'});
      json(result.status,result.body,result.headers);return true;
    }
    if(!['GET','HEAD'].includes(request.method)){json(403,{message:'Это черновик. Отправка заявок отключена.'});return true;}
    let requested;
    try{requested=decodeURIComponent(url.pathname);}catch{json(400,{message:'Некорректный адрес'});return true;}
    if(requested==='/api/price')requested='/data/price.json';
    if(requested==='/api/site')requested='/data/site.json';
    if(requested.startsWith('/api/assets/'))requested='/data/assets/'+requested.slice('/api/assets/'.length);
    if(requested==='/robots.txt') {
      // PALITRA-MAIN: the approved production alias allows indexing (Sitemap only if the workspace really has sitemap.xml).
      const sitemap=indexable&&fs.existsSync(path.join(draft.root,'sitemap.xml'))?'Sitemap: https://'+hostname+'/sitemap.xml\n':'';
      response.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});response.end(indexable?'User-agent: *\nAllow: /\n'+sitemap:'User-agent: *\nDisallow: /\n');return true;
    }
    let relative=requested.replace(/^\//,'');
    if(!relative||relative.endsWith('/'))relative+='index.html';
    let candidate=path.join(draft.root,relative);
    if(!path.extname(relative)&&fs.existsSync(candidate)&&fs.statSync(candidate).isDirectory()) {
      relative+='/index.html';candidate=path.join(draft.root,relative);
    }
    if(!validPath(relative)||!fs.existsSync(candidate)||!fs.statSync(candidate).isFile()) {
      json(404,{message:'Страница не найдена'});return true;
    }
    const actual=fs.realpathSync(candidate);
    if(!actual.startsWith(fs.realpathSync(draft.root)+path.sep)){json(404,{message:'Страница не найдена'});return true;}
    const stat=fs.statSync(actual),headers={'Content-Type':TYPES[path.extname(relative).toLowerCase()],
      'Content-Length':stat.size,'Cache-Control':'no-store'};
    let start=0,end=stat.size-1,status=200;
    if(request.headers.range&&['.mp4','.webm','.mp3','.wav','.ogg','.m4a'].includes(path.extname(relative))) {
      const match=/^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
      start=match?Number(match[1]):-1;end=match?.[2]?Math.min(Number(match[2]),end):end;
      if(start<0||start>end||start>=stat.size){response.writeHead(416,{'Content-Range':`bytes */${stat.size}`});response.end();return true;}
      status=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;headers['Accept-Ranges']='bytes';headers['Content-Length']=end-start+1;
    }
    // PALITRA-MAIN: HTML of the approved production alias without robots noindex meta in <head>; MIME/nosniff/CSP unchanged.
    if(indexable&&status===200&&['.html','.htm'].includes(path.extname(relative).toLowerCase())) {
      const page=indexableHead(fs.readFileSync(actual));
      headers['Content-Length']=page.length;
      response.writeHead(200,headers);
      response.end(request.method==='HEAD'?undefined:page);return true;
    }
    response.writeHead(status,headers);
    if(request.method==='HEAD'||stat.size===0)response.end();
    else fs.createReadStream(actual,{start,end}).on('error',()=>response.destroy()).pipe(response);
    return true;
  }
  // PALITRA: the same AccountService instance of a workspace (same Map) for server-side session checks; null without factory.
  handleDraftHost.accountFor=(draft,origin)=>accountFactory?accountFor(draft,origin||'https://'+draft.hostname):null;
  handleDraftHost.setDraftHook=hook=>{
    if(draftHook)throw new Error('Palitra draft hook is already registered');
    const hostnames=hook&&Array.isArray(hook.hostnames)?hook.hostnames:hook&&typeof hook.hostname==='string'?[hook.hostname]:[];
    if(!hook||typeof hook.handle!=='function'||typeof hook.draftId!=='string'||typeof hook.companyCode!=='string'||!hostnames.length||hostnames.some(h=>typeof h!=='string'||!h))throw new TypeError('Invalid draft hook');
    draftHook=Object.freeze({draftId:hook.draftId,companyCode:hook.companyCode,hostname:hostnames[0],hostnames:Object.freeze([...hostnames]),handle:hook.handle});
  };
  return handleDraftHost;
}
module.exports={createDraftHostHandler};
