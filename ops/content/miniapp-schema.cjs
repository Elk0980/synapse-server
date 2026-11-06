'use strict';
const DDL=`CREATE TABLE IF NOT EXISTS palitra_miniapp_sessions (
  token_hash TEXT PRIMARY KEY REFERENCES palitra_crm_sessions(token_hash) ON DELETE CASCADE,
  company_code TEXT NOT NULL CHECK(company_code='palitra-love'), bot_key TEXT NOT NULL, bot_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);`;
function assertMiniappSchema(db){
 const fail=()=>{throw Object.assign(new Error('Приложение Telegram ещё не подготовлено к запуску'),{status:503,code:'MINIAPP_SCHEMA_NOT_READY'})};
 const table=db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='palitra_miniapp_sessions'").get();if(!table)fail();
 const columns=db.prepare('PRAGMA table_info(palitra_miniapp_sessions)').all(),names=['token_hash','company_code','bot_key','bot_id','created_at','expires_at'];
 if(columns.length!==names.length||columns.some((c,i)=>c.name!==names[i]||c.type!==(i<4?'TEXT':'INTEGER')||c.pk!==(i===0?1:0)||c.notnull!==(i===0?0:1)))fail();
 const fk=db.prepare('PRAGMA foreign_key_list(palitra_miniapp_sessions)').all();if(fk.length!==1||fk[0].table!=='palitra_crm_sessions'||fk[0].from!=='token_hash'||fk[0].to!=='token_hash'||fk[0].on_delete!=='CASCADE')fail();
 if(!/CHECK\s*\(\s*company_code\s*=\s*'palitra-love'\s*\)/i.test(table.sql))fail();return true;
}
// Explicit installer primitive. No HTTP handler/factory calls this and rollback never removes business data.
function initializeMiniappSchema(db){
 const existed=Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='palitra_miniapp_sessions'").get());
 db.exec('SAVEPOINT palitra_miniapp_install_v1');try{db.exec(DDL);assertMiniappSchema(db);db.exec('RELEASE palitra_miniapp_install_v1');return {schema:'palitra-miniapp-sessions/v1',created:!existed,businessRowsChanged:0};}
 catch(e){db.exec('ROLLBACK TO palitra_miniapp_install_v1');db.exec('RELEASE palitra_miniapp_install_v1');throw e;}
}
module.exports={DDL,assertMiniappSchema,initializeMiniappSchema};
