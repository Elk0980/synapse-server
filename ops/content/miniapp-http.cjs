'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const PREFIX='/api/telegram-miniapp/',COOKIE='__Host-PalitraMiniapp',TOKEN=/^pcrm\.[A-Za-z0-9_-]{43}$/;
const fail=(s,c,m)=>{throw Object.assign(new Error(m),{status:s,code:c});};
const csrf=token=>crypto.createHmac('sha256',token).update('palitra-miniapp-csrf-v1').digest('base64url');
const timing=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
function createMiniappHttp({authority,services,select,origin,sendFile,maxFile=20*1024*1024,now=Date.now}) {
  if(!authority||!services||!/^https:\/\/[^/?#]+$/.test(origin))throw new TypeError('Нужен HTTPS вход Mini App');
  const host=new URL(origin).host;
  const json=(res,status,body,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(body));};
  function sessionToken(req) {
    const bearer=req.headers.authorization;
    if(bearer!==undefined){if(typeof bearer!=='string'||!/^Bearer pcrm\.[A-Za-z0-9_-]{43}$/.test(bearer))fail(401,'MINIAPP_SESSION','Откройте приложение заново');return bearer.slice(7);}
    const cookies=String(req.headers.cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(COOKIE+'='));
    if(cookies.length!==1)return null;
    const token=cookies[0].slice(COOKIE.length+1);return TOKEN.test(token)?token:null;
  }
  async function read(req,limit) {
    const length=req.headers['content-length'];
    if(length!==undefined&&(!/^\d+$/.test(String(length))||Number(length)>limit))fail(413,'MINIAPP_SIZE','Файл слишком большой');
    const parts=[];let size=0;
    for await(const part of req){size+=part.length;if(size>limit)fail(413,'MINIAPP_SIZE','Файл слишком большой');parts.push(part);}
    return Buffer.concat(parts);
  }
  async function body(req) {
    if(!/^application\/json(?:;|$)/i.test(String(req.headers['content-type']||'')))fail(415,'MINIAPP_JSON','Нужен JSON запрос');
    let value;try{value=JSON.parse((await read(req,32768)).toString('utf8'));}catch(e){if(e.status)throw e;fail(400,'MINIAPP_JSON','Некорректный запрос');}
    if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'MINIAPP_INPUT','Некорректный запрос');return value;
  }
  const methods={orders:(t,b)=>services.list(t,b),order:(t,b)=>{if(Object.keys(b).some(k=>k!=='orderId'))fail(400,'MINIAPP_INPUT','Некорректный заказ');return services.readOrder(t,b.orderId);},
    conversation:(t,b)=>services.readConversation(t,b),message:(t,b)=>services.send(t,b),stage:(t,b)=>services.stage(t,b),
    'upload-prepare':(t,b)=>services.prepareUpload(t,b),'upload-status':(t,b)=>services.uploadStatus(t,b),'read':(t,b)=>services.markRead(t,b),'unread':(t,b)=>services.unread(t,b),'sources':(t,b)=>services.sources(t,b),'funnel':(t,b)=>services.funnel(t,b)};
  async function handle(req,res) {
    const url=new URL(req.url,origin);
    if(!url.pathname.startsWith(PREFIX))return false;
    try{
      if(url.origin!==origin||req.headers.host!==host||req.headers.origin!==origin)fail(403,'MINIAPP_ORIGIN','Запрос с другого адреса запрещён');
      if(req.method!=='POST'||url.search)fail(405,'MINIAPP_METHOD','Метод не поддерживается');
      const route=url.pathname.slice(PREFIX.length),token=sessionToken(req);
      if(route==='session'){
        const input=await body(req);
        if(Object.hasOwn(input,'resumeInitData')){
          if(Object.keys(input).length!==1||typeof input.resumeInitData!=='string'||!input.resumeInitData)fail(400,'MINIAPP_INPUT','Откройте приложение через Telegram');
          if(!token)fail(401,'MINIAPP_SESSION','Откройте приложение через Telegram');
          authority.resume(token,input.resumeInitData);const boot=services.bootstrap?services.bootstrap(token):authority.bootstrap(token);json(res,200,{...boot,csrfToken:csrf(token)});return true;
        }
        const receipt=authority.exchange(input),boot=services.bootstrap?services.bootstrap(receipt.token):authority.bootstrap(receipt.token);
        const seconds=Math.max(1,Math.floor((receipt.expiresAt-now())/1000));
        // A new dedicated HttpOnly session cookie; existing cabinet/chat/site cookies are never overwritten.
        // Telegram Web permits framing, therefore SameSite=None here; every POST still checks exact Origin and CSRF/Bearer.
        json(res,200,{...boot,token:receipt.token,csrfToken:csrf(receipt.token)}, {'Set-Cookie':`${COOKIE}=${receipt.token}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=${seconds}`});return true;
      }
      if(!token)fail(401,'MINIAPP_SESSION','Откройте приложение заново через Telegram');
      authority.actor(token);
      if(!req.headers.authorization&&!timing(req.headers['x-palitra-miniapp-csrf'],csrf(token)))fail(403,'MINIAPP_CSRF','Обновите приложение');
      if(Object.hasOwn(methods,route)){
        const input=await body(req);authority.actor(token); // Fresh after asynchronous request body.
        const result=await methods[route](token,input);json(res,200,result);return true;
      }
      if(route==='select'){
        if(typeof select!=='function')fail(503,'MINIAPP_SELECTION','Выбор заказа временно недоступен');
        const input=await body(req);authority.actor(token);json(res,200,select(token,input));return true;
      }
      if(route==='upload'){
        const orderHeader=req.headers['x-palitra-order'],orderId=orderHeader===undefined?null:Number(orderHeader),uuid=req.headers['x-palitra-upload'],conversationRef=req.headers['x-palitra-conversation'];
        if(orderHeader!==undefined&&(!Number.isSafeInteger(orderId)||orderId<1)||
          conversationRef!==undefined&&(typeof conversationRef!=='string'||!/^(thread|legacy):[1-9]\d{0,14}$/.test(conversationRef))||
          orderId===null&&conversationRef===undefined||typeof uuid!=='string'||!/^[-a-f0-9]{36}$/i.test(uuid))fail(400,'MINIAPP_INPUT','Некорректный файл');
        const input={orderId,uuid,...(conversationRef===undefined?{}:{conversationRef})};
        // Scope before receiving bytes, and again after receiving them; no arbitrary target or server claim from input.
        services.uploadStatus(token,input);
        const bytes=await read(req,maxFile);authority.actor(token);
        json(res,200,await services.uploadBytes(token,input,bytes));return true;
      }
      if(route==='file'){
        if(typeof sendFile!=='function')fail(503,'MINIAPP_FILES','Выдача файлов временно недоступна');
        const input=await body(req);authority.actor(token);const opened=await services.attachment(token,input);
        const file=await opened.open();
        try {
          authority.actor(token);
          const fresh=services.attachment(token,input).meta;
          if(fresh.id!==opened.meta.id||fresh.diskName!==opened.meta.diskName||fresh.sha256!==opened.meta.sha256||fresh.size!==opened.meta.size)
            fail(404,'MINIAPP_FILE','Файл изменился');
        }catch(error){if(Number.isInteger(file?.fd))fs.closeSync(file.fd);throw error;}
        // Existing verified media sender owns fd, range handling, filename and security headers.
        // No disk path, file_id, bot token or internal metadata is serialized to the client.
        sendFile(req,res,{...opened.meta,fd:file.fd,size:file.size});
        return true;
      }
      fail(404,'MINIAPP_ROUTE','Не найдено');
    }catch(error){if(!res.headersSent)json(res,[400,401,403,404,409,410,413,415,422,429,503].includes(error.status)?error.status:500,
      {ok:false,code:error.status?error.code||'MINIAPP_ERROR':'MINIAPP_ERROR',error:error.status?error.message:'Не удалось выполнить запрос'});else res.destroy();return true;}
  }
  return Object.freeze({handle});
}
module.exports={createMiniappHttp,PREFIX,COOKIE};
