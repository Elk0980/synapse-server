'use strict';
// Reader R2: built-ins only. Runtime module bytes are hashed, NEVER loaded,
// compiled, evaluated, required or imported, even after they match a pin.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const need=(ok,code)=>{if(!ok)throw Error(code)};
const CONFIG={"c2b4ae55a67246f7f4df7d82c24f00fabfd4cbe23c9b7fd49a47abc676340a2a":{"bytes":1391}},ORDER_VARIANTS=Object.freeze({"6b97b41375a3e5eaa8d2d6afd1305cb9c769d3fe53cdfb4c4002992ca562d24f":{"bytes":64954,"origins":["https://palitra-love.ru","https://palitra-love.synapsebusiness.ru"]},"cbded4d75f8539b8228a3957d24a90e73824f16e7148338ad3b92e8a1d56a49d":{"bytes":65120,"origins":["https://palitra-love.ru","https://palitra-love.synapsebusiness.ru"]}});
const keys=['dev','ino','size','mtimeMs','ctimeMs','uid','gid','mode','nlink'];
const same=(a,b)=>keys.every(k=>a[k]===b[k]);
function source(file,pins){
 const s=fs.lstatSync(file);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===0&&s.gid===0&&fs.realpathSync(file)===file&&Object.values(pins).some(p=>p.bytes===s.size),'CONFIG_SOURCE_BOUNDARY');
 let fd;try{
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const a=fs.fstatSync(fd);need(same(s,a),'CONFIG_SOURCE_RACE');
  const h=crypto.createHash('sha256'),buffer=Buffer.alloc(65536);let total=0,n;
  while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0){total+=n;need(total<=s.size,'CONFIG_SOURCE_RACE');h.update(buffer.subarray(0,n));}
  const end=fs.fstatSync(fd),last=fs.lstatSync(file);need(total===s.size&&same(s,end)&&same(s,last)&&!last.isSymbolicLink()&&fs.realpathSync(file)===file,'CONFIG_SOURCE_RACE');
  const digest=h.digest('hex');need(Object.hasOwn(pins,digest)&&pins[digest].bytes===total,'CONFIG_SOURCE_UNKNOWN');return {digest,stat:s};
 }finally{if(fd!==undefined)fs.closeSync(fd);}
}
const configSource=source('/app/client-bot-config.js',CONFIG),orderSource=source('/app/site-orders.js',ORDER_VARIANTS);
const PALITRA_ORDER_ORIGINS=Object.freeze(ORDER_VARIANTS[orderSource.digest].origins);
// The following PURE function is extracted at build from the independently
// pinned accepted source; it is shipped reader code, never runtime evaluation.
function clientCompanyConfig(env, companies) {
  const username = key => String(env[`${key}_CLIENT_BOT_USERNAME`] || '').trim().replace(/^@/, '');
  const policy = value => /^https:\/\/[\w.-]+\/[\w./-]*$/.test(value || '') ? value : '';
  return {
    orderSites: {
      palitra: { companyCode: companies.palitra, title: 'Palitra',
        origins: (env.PALITRA_ORDER_ORIGINS || PALITRA_ORDER_ORIGINS.join(',')).split(',').map(s => s.trim()).filter(Boolean) },
      // Получатель и диалоги доступны владельцу. Публичный приём заявок ALVI не включается.
      alvi: { companyCode: companies.alvi, title: 'ALVI', origins: [] },
      avokado: { companyCode: companies.avokado, title: 'Авокадо', origins: [] },
    },
    bots: {
      palitra: { companyCode: companies.palitra, site: 'palitra', title: 'Palitra', username: username('PALITRA'),
        hours: '09:00–21:00', policyUrl: policy(env.PALITRA_CLIENT_BOT_POLICY_URL) || 'https://palitra-love.ru/privacy' },
      alvi: { companyCode: companies.alvi, site: 'alvi', title: 'ALVI', username: username('ALVI'),
        hours: String(env.ALVI_CLIENT_BOT_HOURS || '').trim(), policyUrl: policy(env.ALVI_CLIENT_BOT_POLICY_URL) },
    },
  };
}
const config=clientCompanyConfig(process.env,{palitra:'palitra-love',alvi:'alvi'});
const bots=Object.entries(config.bots).filter(([,b])=>b&&b.site==='palitra').map(([key,b])=>({key,site:b.site,companyCode:b.companyCode,username:b.username}));
let secret=String(process.env.SESSION_SECRET||'').trim(),secretFile=null;
if(!secret){
 const file=path.join(path.dirname(process.env.DATABASE_PATH||'/data/content.sqlite'),'session-secret.key');
 let fd;
 try{const s=fs.lstatSync(file);if(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===0&&s.gid===0&&(s.mode&0o077)===0&&s.size<=128&&fs.realpathSync(file)===file){
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const a=fs.fstatSync(fd),buffer=Buffer.alloc(129),n=fs.readSync(fd,buffer,0,129,null),z=fs.fstatSync(fd),q=fs.lstatSync(file);
  const keys=['dev','ino','size','mtimeMs','ctimeMs','uid','gid','mode','nlink'];
  if(n===s.size&&keys.every(k=>s[k]===a[k]&&s[k]===z[k]&&s[k]===q[k])){const raw=buffer.subarray(0,n).toString('utf8').trim();if(/^[a-f0-9]{64}$/.test(raw)){secret=raw;secretFile={mode:s.mode&0o777,uid:s.uid,gid:s.gid};}}
 }}catch{ /* absent remains false, never create/chmod */ }finally{if(fd!==undefined)fs.closeSync(fd);}
}
const refKeyValid=secret.length>=32;
const refKeySha256=refKeyValid?hash(crypto.createHash('sha256').update('palitra-crm-site-ref:'+secret).digest()):null;
// Re-read and compare identity+bytes before emitting anything. A concurrent
// replacement after the first proof refuses; no external module is ever run.
for(const [file,pins,first] of [['/app/client-bot-config.js',CONFIG,configSource],['/app/site-orders.js',ORDER_VARIANTS,orderSource]]){const last=source(file,pins);need(first.digest===last.digest&&same(first.stat,last.stat),'CONFIG_SOURCE_CHANGED_DURING_PROBE');}
process.stdout.write(JSON.stringify({bots,orderOrigins:config.orderSites.palitra.origins,refKeyValid,refKeySha256,secretFile}));
