'use strict';
// Fixed readonly opaque computation. This module never imports application code.
const fs=require('node:fs'),crypto=require('node:crypto');
const SOURCE_PIN='6464ac246aa197ef8f9f197a332eed5d2b27f0acda445b08f89192c660514141';
const SOURCE_PATH='/app/hugh-providers.js',DB_PATH='/data/content.sqlite';
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const need=(ok)=>{if(!ok)throw Error('VAULT_PROBE_REFUSED');};
const FRAGMENTS=["const NAMESPACE = 'synapse/hugh-provider/v1';\nconst MIN_MASTER_KEY = 32;\nconst API_STYLE = 'openai-chat-completions';\n/* Список официальных хостов кандидатов. Он ограничивает адрес, но НЕ подтверждает, что провайдер\n   совместим с нашим контрактом: совместимость подтверждается только успешной проверкой.\n   Оператор сервера может дополнить список через HUGH_PROVIDER_ALLOWED_HOSTS. */\nconst CATALOG = Object.freeze([\n  {name: 'zai', title: 'Z.ai (GLM)', hosts: ['api.z.ai', 'open.bigmodel.cn'], console: 'https://z.ai/manage-apikey/billing', contractSupported: true},\n  {name: 'qwen', title: 'Alibaba Model Studio (Qwen)', hosts: ['dashscope-intl.aliyuncs.com', 'dashscope.aliyuncs.com'], console: 'https://modelstudio.console.alibabacloud.com/', contractSupported: true},\n  {name: 'deepseek', title: 'DeepSeek', hosts: ['api.deepseek.com'], console: 'https://platform.deepseek.com/', contractSupported: true},\n  {name: 'gemini', title: 'Google Gemini', hosts: ['generativelanguage.googleapis.com'], console: 'https://aistudio.google.com/apikey', contractSupported: true},\n  {name: 'mistral', title: 'Mistral', hosts: ['api.mistral.ai'], console: 'https://console.mistral.ai/', contractSupported: true},\n  {name: 'openai', title: 'OpenAI (резерв)', hosts: ['api.openai.com'], console: 'https://platform.openai.com/', contractSupported: true},\n  /* Anthropic Messages API устроен иначе, чем реализованный у нас OpenAI-совместимый\n     /chat/completions. Непроверенный адаптер не пишем: кандидат помечен недоступным\n     через этот контракт, ключ для него не принимается. */\n  {name: 'anthropic', title: 'Anthropic (резерв)', hosts: ['api.anthropic.com'], console: 'https://console.anthropic.com/',\n    contractSupported: false, unsupportedReason: 'Через реализованный контракт OpenAI-совместимого /chat/completions этот провайдер не подключается: его API устроен иначе. Адаптер не написан.'},\n]);\nconst BY_NAME = new Map(CATALOG.map((item) => [item.name, item]));", "function fail(status, message, code) {\n  throw Object.assign(new Error(message), {status, details: code ? {code} : undefined});\n}\n\nfunction extraHosts(env) {\n  return String(env.HUGH_PROVIDER_ALLOWED_HOSTS || '').split(',').map((value) => value.trim().toLowerCase())\n    .filter((value) => /^[a-z0-9.-]{3,253}$/.test(value));\n}\n\n/* Адрес принимается только из списка: произвольный URL и внутренние адреса невозможны. */\nfunction checkBaseUrl(value, provider, env) {\n  if (typeof value !== 'string' || value.length > 300) fail(400, 'Проверьте адрес API');\n  const clean = value.trim().replace(/\\/+$/, '');\n  let url;\n  try { url = new URL(clean); } catch { fail(400, 'Адрес API должен быть полным https-адресом'); }\n  if (url.protocol !== 'https:') fail(400, 'Адрес API должен начинаться с https://');\n  if (url.username || url.password) fail(400, 'Адрес API не должен содержать логин и пароль');\n  if (url.port && url.port !== '443') fail(400, 'Адрес API должен использовать стандартный порт');\n  if (url.search || url.hash) fail(400, 'Адрес API не должен содержать параметров');\n  const host = url.hostname.toLowerCase();\n  if (/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(host) || host.includes(':')) fail(400, 'Адрес по IP не принимается');\n  const allowed = new Set([...(BY_NAME.get(provider)?.hosts || []), ...extraHosts(env)]);\n  if (!allowed.has(host)) {\n    fail(400, `Хост ${host} не входит в список официальных адресов этого провайдера`, 'HOST_NOT_ALLOWED');\n  }\n  if (/\\.\\.|\\/\\//.test(url.pathname)) fail(400, 'Проверьте путь адреса API');\n  return `https://${host}${url.pathname.replace(/\\/+$/, '')}`;\n}", "  function crypt(name, value, decrypt = false) {\n    if (!available) fail(503, lockedReason, 'SECRET_STORE_LOCKED');\n    const aad = Buffer.from(`${NAMESPACE}/${name}`);\n    const envelope = decrypt ? JSON.parse(value)\n      : {v: 1, salt: crypto.randomBytes(16).toString('base64'), iv: crypto.randomBytes(12).toString('base64')};\n    if (envelope.v !== 1) throw new Error('Invalid credential envelope');\n    const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(masterKey), Buffer.from(envelope.salt, 'base64'), aad, 32));\n    try {\n      const cipher = decrypt ? crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))\n        : crypto.createCipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));\n      cipher.setAAD(aad);\n      if (decrypt) {\n        cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));\n        return Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]).toString('utf8');\n      }\n      envelope.data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64');\n      envelope.tag = cipher.getAuthTag().toString('base64');\n      return JSON.stringify(envelope);\n    } finally { key.fill(0); }\n  }", "  const checkCurrent = (saved) => Boolean(saved && saved.check_state === 'ok' &&\n    saved.checked_revision !== null && saved.checked_revision === saved.config_revision);", "  function runtimeReport() {\n    if (!available) return {ready: [], skipped: [], lockedReason};\n    const rows = db.prepare(\"SELECT * FROM hugh_provider_settings WHERE enabled=1 AND encrypted_key<>''\").all();\n    const ready = [], skipped = [];\n    const skip = (name, reason) => { skipped.push({name, reason}); };\n    for (const item of rows) {\n      // Включённого мало: в рантайм идёт только провайдер с успешной проверкой ЭТОЙ версии.\n      if (!checkCurrent(item)) {\n        skip(item.name, item.check_state === 'failed'\n          ? 'Последняя проверка соединения не прошла'\n          : item.checked_revision === null\n            ? 'Настройка ни разу не проверена'\n            : 'Настройку меняли после успешной проверки — нужна новая проверка');\n        continue;\n      }\n      if (BY_NAME.get(item.name)?.contractSupported === false) {\n        skip(item.name, BY_NAME.get(item.name).unsupportedReason || 'Контракт этого провайдера не реализован');\n        continue;\n      }\n      // Адрес перепроверяется и здесь: сохранённое значение не считается вечно доверенным.\n      try { checkBaseUrl(item.base_url, item.name, env); }\n      catch { skip(item.name, 'Сохранённый адрес API больше не проходит проверку официальных хостов'); continue; }\n      let secret;\n      try { secret = crypt(item.name, item.encrypted_key, true); }\n      catch { skip(item.name, 'Ключ не расшифровывается: мастер-ключ сервера изменился или ключ повреждён'); continue; }\n      ready.push({name: item.name, url: item.base_url, secret, model: item.model_id,\n        timeoutMs: item.timeout_ms, maxOutputTokens: item.max_output_tokens,\n        pricePromptMicroUsdPer1k: item.price_prompt_micro, priceCompletionMicroUsdPer1k: item.price_completion_micro,\n        budgetMicroUsd: item.budget_usd_micro});\n    }\n    return {ready, skipped, lockedReason: ''};\n  }"];
const ACCOUNT_FRAGMENT="    const r=row('deepseek');\n    if(!available||!r?.encrypted_key||!r.enabled||!/^https:\\/\\/api\\.deepseek\\.com(?:\\/v1)?$/.test(r.base_url))return null;\n    try{return {revision:r.config_revision,secret:crypt('deepseek',r.encrypted_key,true)};}catch{return null;}";

const NAMESPACE = 'synapse/hugh-provider/v1';
const MIN_MASTER_KEY = 32;
const API_STYLE = 'openai-chat-completions';
/* Список официальных хостов кандидатов. Он ограничивает адрес, но НЕ подтверждает, что провайдер
   совместим с нашим контрактом: совместимость подтверждается только успешной проверкой.
   Оператор сервера может дополнить список через HUGH_PROVIDER_ALLOWED_HOSTS. */
const CATALOG = Object.freeze([
  {name: 'zai', title: 'Z.ai (GLM)', hosts: ['api.z.ai', 'open.bigmodel.cn'], console: 'https://z.ai/manage-apikey/billing', contractSupported: true},
  {name: 'qwen', title: 'Alibaba Model Studio (Qwen)', hosts: ['dashscope-intl.aliyuncs.com', 'dashscope.aliyuncs.com'], console: 'https://modelstudio.console.alibabacloud.com/', contractSupported: true},
  {name: 'deepseek', title: 'DeepSeek', hosts: ['api.deepseek.com'], console: 'https://platform.deepseek.com/', contractSupported: true},
  {name: 'gemini', title: 'Google Gemini', hosts: ['generativelanguage.googleapis.com'], console: 'https://aistudio.google.com/apikey', contractSupported: true},
  {name: 'mistral', title: 'Mistral', hosts: ['api.mistral.ai'], console: 'https://console.mistral.ai/', contractSupported: true},
  {name: 'openai', title: 'OpenAI (резерв)', hosts: ['api.openai.com'], console: 'https://platform.openai.com/', contractSupported: true},
  /* Anthropic Messages API устроен иначе, чем реализованный у нас OpenAI-совместимый
     /chat/completions. Непроверенный адаптер не пишем: кандидат помечен недоступным
     через этот контракт, ключ для него не принимается. */
  {name: 'anthropic', title: 'Anthropic (резерв)', hosts: ['api.anthropic.com'], console: 'https://console.anthropic.com/',
    contractSupported: false, unsupportedReason: 'Через реализованный контракт OpenAI-совместимого /chat/completions этот провайдер не подключается: его API устроен иначе. Адаптер не написан.'},
]);
const BY_NAME = new Map(CATALOG.map((item) => [item.name, item]));
function fail(status, message, code) {
  throw Object.assign(new Error(message), {status, details: code ? {code} : undefined});
}

function extraHosts(env) {
  return String(env.HUGH_PROVIDER_ALLOWED_HOSTS || '').split(',').map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-z0-9.-]{3,253}$/.test(value));
}

/* Адрес принимается только из списка: произвольный URL и внутренние адреса невозможны. */
function checkBaseUrl(value, provider, env) {
  if (typeof value !== 'string' || value.length > 300) fail(400, 'Проверьте адрес API');
  const clean = value.trim().replace(/\/+$/, '');
  let url;
  try { url = new URL(clean); } catch { fail(400, 'Адрес API должен быть полным https-адресом'); }
  if (url.protocol !== 'https:') fail(400, 'Адрес API должен начинаться с https://');
  if (url.username || url.password) fail(400, 'Адрес API не должен содержать логин и пароль');
  if (url.port && url.port !== '443') fail(400, 'Адрес API должен использовать стандартный порт');
  if (url.search || url.hash) fail(400, 'Адрес API не должен содержать параметров');
  const host = url.hostname.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) fail(400, 'Адрес по IP не принимается');
  const allowed = new Set([...(BY_NAME.get(provider)?.hosts || []), ...extraHosts(env)]);
  if (!allowed.has(host)) {
    fail(400, `Хост ${host} не входит в список официальных адресов этого провайдера`, 'HOST_NOT_ALLOWED');
  }
  if (/\.\.|\/\//.test(url.pathname)) fail(400, 'Проверьте путь адреса API');
  return `https://${host}${url.pathname.replace(/\/+$/, '')}`;
}
function evaluate(source,db,env,nonce){
 need(typeof nonce==='string'&&/^[a-f0-9]{64}$/.test(nonce));
 need(digest(source)===SOURCE_PIN);const normalized=source.toString('utf8').replace(/\r\n/g,'\n');
 for(const part of FRAGMENTS)need(normalized.includes(part));need(normalized.includes(ACCOUNT_FRAGMENT));
 const masterKey=String(env.HUGH_PROVIDER_MASTER_KEY||'');const available=masterKey.length>=MIN_MASTER_KEY;
 const lockedReason='Opaque credential store unavailable';
  function crypt(name, value, decrypt = false) {
    if (!available) fail(503, lockedReason, 'SECRET_STORE_LOCKED');
    const aad = Buffer.from(`${NAMESPACE}/${name}`);
    const envelope = decrypt ? JSON.parse(value)
      : {v: 1, salt: crypto.randomBytes(16).toString('base64'), iv: crypto.randomBytes(12).toString('base64')};
    if (envelope.v !== 1) throw new Error('Invalid credential envelope');
    const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(masterKey), Buffer.from(envelope.salt, 'base64'), aad, 32));
    try {
      const cipher = decrypt ? crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
        : crypto.createCipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      cipher.setAAD(aad);
      if (decrypt) {
        cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        return Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]).toString('utf8');
      }
      envelope.data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64');
      envelope.tag = cipher.getAuthTag().toString('base64');
      return JSON.stringify(envelope);
    } finally { key.fill(0); }
  }
  const checkCurrent = (saved) => Boolean(saved && saved.check_state === 'ok' &&
    saved.checked_revision !== null && saved.checked_revision === saved.config_revision);
  function runtimeReport() {
    if (!available) return {ready: [], skipped: [], lockedReason};
    const rows = db.prepare("SELECT * FROM hugh_provider_settings WHERE enabled=1 AND encrypted_key<>''").all();
    const ready = [], skipped = [];
    const skip = (name, reason) => { skipped.push({name, reason}); };
    for (const item of rows) {
      // Включённого мало: в рантайм идёт только провайдер с успешной проверкой ЭТОЙ версии.
      if (!checkCurrent(item)) {
        skip(item.name, item.check_state === 'failed'
          ? 'Последняя проверка соединения не прошла'
          : item.checked_revision === null
            ? 'Настройка ни разу не проверена'
            : 'Настройку меняли после успешной проверки — нужна новая проверка');
        continue;
      }
      if (BY_NAME.get(item.name)?.contractSupported === false) {
        skip(item.name, BY_NAME.get(item.name).unsupportedReason || 'Контракт этого провайдера не реализован');
        continue;
      }
      // Адрес перепроверяется и здесь: сохранённое значение не считается вечно доверенным.
      try { checkBaseUrl(item.base_url, item.name, env); }
      catch { skip(item.name, 'Сохранённый адрес API больше не проходит проверку официальных хостов'); continue; }
      let secret;
      try { secret = crypt(item.name, item.encrypted_key, true); }
      catch { skip(item.name, 'Ключ не расшифровывается: мастер-ключ сервера изменился или ключ повреждён'); continue; }
      ready.push({name: item.name, url: item.base_url, secret, model: item.model_id,
        timeoutMs: item.timeout_ms, maxOutputTokens: item.max_output_tokens,
        pricePromptMicroUsdPer1k: item.price_prompt_micro, priceCompletionMicroUsdPer1k: item.price_completion_micro,
        budgetMicroUsd: item.budget_usd_micro});
    }
    return {ready, skipped, lockedReason: ''};
  }
 need(FRAGMENTS[2].trim()===crypt.toString()&&FRAGMENTS[4].trim()===runtimeReport.toString());
 for(const f of [fail,extraHosts,checkBaseUrl])need(normalized.includes(f.toString()));
 need(normalized.includes('const checkCurrent = '+checkCurrent.toString()+';'));
 const rows=db.prepare('SELECT * FROM hugh_provider_settings ORDER BY name').all();
 need(rows.length<=CATALOG.length&&rows.every(r=>BY_NAME.has(r.name))&&new Set(rows.map(r=>r.name)).size===rows.length);
 const metadata=rows.map(r=>{need(Object.values(r).every(v=>v===null||typeof v==='string'||(typeof v==='number'&&Number.isSafeInteger(v))));return Object.fromEntries(Object.keys(r).sort().map(k=>[k,r[k]]));});
 const report=runtimeReport(),ready=new Set(report.ready.map(r=>r.name));
 let balanceAccount;
 const row=name=>rows.find(r=>r.name===name)||null;
 const readBalanceAccount=()=>{
    const r=row('deepseek');
    if(!available||!r?.encrypted_key||!r.enabled||!/^https:\/\/api\.deepseek\.com(?:\/v1)?$/.test(r.base_url))return null;
    try{return {revision:r.config_revision,secret:crypt('deepseek',r.encrypted_key,true)};}catch{return null;}
 };
 need(readBalanceAccount.toString().includes(ACCOUNT_FRAGMENT));
 balanceAccount=readBalanceAccount();
 const result={nonce,sourceSha256:SOURCE_PIN,settingsBinding:crypto.createHmac('sha256',Buffer.from(nonce,'hex')).update('palitra-vault-snapshot/v2\n').update(JSON.stringify(metadata)).digest('hex'),providers:CATALOG.map(p=>({provider:p.name,canDecryptAndPassRuntimeSelection:ready.has(p.name)})),canUseBalanceAccount:Boolean(balanceAccount)};
 // Secrets remain transient and are never serialized, logged, or hashed.
 for(const r of report.ready)r.secret='';if(balanceAccount)balanceAccount.secret='';balanceAccount=null;
 return result;
}
function fileState(path){try{const s=fs.lstatSync(path,{bigint:true});need(!s.isSymbolicLink()&&s.isFile()&&s.nlink===1n);return {dev:String(s.dev),ino:String(s.ino)};}catch(e){if(e.code==='ENOENT')return null;throw Error('VAULT_PROBE_REFUSED');}}
function main(){let db;try{
 need(process.argv.length===2&&/^[a-f0-9]{64}$/.test(process.argv[1]));const nonce=process.argv[1];
 need(process.env.DATABASE_PATH===DB_PATH);const before=[DB_PATH,DB_PATH+'-wal'].map(fileState);need(before[0]);
 const fd=fs.openSync(DB_PATH,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),header=Buffer.alloc(20);try{need(fs.readSync(fd,header,0,20,0)===20);}finally{fs.closeSync(fd);}
 const shm=fileState(DB_PATH+'-shm');if(header[18]===2||header[19]===2)need(before[1]&&shm);
 const source=fs.readFileSync(SOURCE_PATH);need(digest(source)===SOURCE_PIN);
 const {DatabaseSync}=require('node:sqlite');db=new DatabaseSync(DB_PATH,{readOnly:true});db.exec('PRAGMA query_only=ON;BEGIN');
 const columns=new Set(db.prepare('PRAGMA table_info(hugh_provider_settings)').all().map(r=>r.name));
 for(const name of ['name','enabled','encrypted_key','base_url','config_revision','check_state','checked_revision','budget_usd_micro','model_id','timeout_ms','max_output_tokens','price_prompt_micro','price_completion_micro'])need(columns.has(name));
 const result=evaluate(source,db,process.env,nonce);need(db.prepare('SELECT total_changes() n').get().n===0);db.exec('ROLLBACK');db.close();db=null;
 need(digest(fs.readFileSync(SOURCE_PATH))===SOURCE_PIN);const after=[DB_PATH,DB_PATH+'-wal'].map(fileState);need(JSON.stringify(before)===JSON.stringify(after));const nextShm=fileState(DB_PATH+'-shm');need((!shm&&!nextShm)||(shm&&nextShm&&shm.dev===nextShm.dev&&shm.ino===nextShm.ino));
 process.stdout.write(JSON.stringify({...result,databasePath:DB_PATH,files:after,asOfMs:Date.now()}));
 }catch{try{db?.close();}catch{}process.stderr.write('VAULT_PROBE_REFUSED');process.exitCode=78;}}
module.exports={evaluate,SOURCE_PIN,main};
