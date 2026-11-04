'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
// Existing file databases are snapshotted (including WAL) before the additive DDL.
function migratePasswordState(db) {
  const columns=db.prepare('PRAGMA table_info(auth_users)').all().map(c=>c.name);
  const additions=[['must_change_password','INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1))'],['temp_password_expires_at','TEXT']].filter(([name])=>!columns.includes(name));
  if(!columns.length||!additions.length)return;
  const file=db.prepare('PRAGMA database_list').all().find(r=>r.name==='main').file;
  if(file) {
    const dir=path.join(path.dirname(file),'auth-password-backups');
    fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(dir,0o700);
    const backup=path.join(dir,`${crypto.randomUUID()}.sqlite`);
    db.prepare('VACUUM INTO ?').run(backup);fs.chmodSync(backup,0o600);
    const copy=new DatabaseSync(backup,{readOnly:true});
    try {
      if(copy.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||copy.prepare('PRAGMA foreign_key_check').all().length)throw Error('Не пройдена проверка резервной копии auth');
    }finally{copy.close();}
  }
  db.exec('BEGIN IMMEDIATE');
  try {for(const [name,type] of additions)db.exec(`ALTER TABLE auth_users ADD COLUMN ${name} ${type}`);db.exec('COMMIT');}
  catch(error){db.exec('ROLLBACK');throw error;}
}
module.exports={migratePasswordState};
