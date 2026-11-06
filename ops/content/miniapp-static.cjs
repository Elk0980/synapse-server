'use strict';
const fs=require('node:fs'),path=require('node:path');
const TYPES=Object.freeze({'telegram.html':'text/html; charset=utf-8','miniapp-boot.js':'application/javascript; charset=utf-8','miniapp-transport.js':'application/javascript; charset=utf-8','miniapp-drafts.js':'application/javascript; charset=utf-8','miniapp-source-report.js':'application/javascript; charset=utf-8','miniapp-ui.js':'application/javascript; charset=utf-8','miniapp-ui.css':'text/css; charset=utf-8'});
const CSP="default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://web.telegram.org";
function createMiniappStatic({publicDir,origin='https://palitra-love.ru'}){
 if(origin!=='https://palitra-love.ru'||typeof publicDir!=='string'||!path.isAbsolute(publicDir))throw new TypeError('Нужен существующий каталог оболочки Палитры');
 const host=new URL(origin).host;
 function serve(req,res){const url=new URL(req.url,origin),name=url.pathname.slice('/love-app/'.length);
  if(!url.pathname.startsWith('/love-app/')||!Object.hasOwn(TYPES,name))return false;
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin'};
  const end=(status,text)=>{res.writeHead(status,{...headers,'Content-Type':'text/plain; charset=utf-8'});res.end(req.method==='HEAD'?undefined:text);return true};
  if(url.origin!==origin||req.headers.host!==host||req.headers.origin!==undefined&&req.headers.origin!==origin)return end(403,'Недопустимый адрес');
  if(!['GET','HEAD'].includes(req.method))return end(405,'Метод не поддерживается');
  // Only notification pointers on the HTML entry are accepted. They carry no access;
  // signed Telegram identity and the existing order/thread ACL still authorize reads.
  if(url.search){
   if(name!=='telegram.html')return end(404,'Не найдено');
   const entries=[...url.searchParams.entries()],keys=entries.map(([key])=>key);
   const positive=value=>/^[1-9]\d{0,15}$/.test(value||'')&&Number.isSafeInteger(Number(value));
   if(!keys.length||new Set(keys).size!==keys.length||keys.some(key=>key!=='order'&&key!=='chat'))return end(404,'Не найдено');
   if(url.searchParams.has('order')&&!positive(url.searchParams.get('order')))return end(404,'Не найдено');
   if(url.searchParams.has('chat')){
    const chat=/^(thread|legacy):([1-9]\d{0,15})$/.exec(url.searchParams.get('chat')||'');
    if(!chat||!positive(chat[2]))return end(404,'Не найдено');
   }
  }
  try{
   const base=fs.realpathSync(publicDir),file=fs.realpathSync(path.join(base,name));if(path.dirname(file)!==base)return end(404,'Не найдено');
   const bytes=fs.readFileSync(file);res.writeHead(200,{...headers,'Content-Type':TYPES[name],'Content-Length':bytes.length,...(name==='telegram.html'?{'Content-Security-Policy':CSP}:{})});res.end(req.method==='HEAD'?undefined:bytes);return true;
  }catch{return end(503,'Приложение Telegram временно недоступно. Можно продолжить на сайте.');}
 }
 return Object.freeze({serve});
}
module.exports={createMiniappStatic,CSP,TYPES};
