'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{DatabaseSync}=require('node:sqlite');
const {hashPassword,verifyPassword}=require('./passwords'),{createAuthStore}=require('./auth-store');

test('добавочная миграция: проверенная копия старой WAL-базы, прежние данные/права, повторный запуск',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'people-password-migration-')),file=path.join(dir,'old.sqlite');
  const db=new DatabaseSync(file);t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE auth_users(id INTEGER PRIMARY KEY,login TEXT,display_name TEXT,role TEXT,password_hash TEXT,session_version INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE auth_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO auth_meta VALUES('auth_users_imported_v1','old');
    CREATE TABLE auth_user_permissions(user_id INTEGER,permission TEXT); INSERT INTO auth_user_permissions VALUES(2,'price.view');
    CREATE TABLE auth_user_companies(user_id INTEGER,company_code TEXT); INSERT INTO auth_user_companies VALUES(2,'alvi');
    CREATE TABLE preserved(value BLOB); INSERT INTO preserved VALUES(x'0001ff');`);
  const secret=crypto.randomBytes(18).toString('base64url'),hash=hashPassword(secret);
  db.prepare('INSERT INTO auth_users VALUES(1,?,?,?,?,3,?,?)').run('root','Владелец','owner',hash,'old','old');
  db.prepare('INSERT INTO auth_users VALUES(2,?,?,?,?,5,?,?)').run('editor','Редактор','editor',hash,'old','old');
  const old={...db.prepare('SELECT * FROM auth_users').get()};
  fs.writeFileSync(path.join(dir,'auth-password-backups'),'blocked');
  assert.throws(()=>require('./auth-password-migration').migratePasswordState(db));
  assert.equal(db.prepare('PRAGMA table_info(auth_users)').all().some(c=>c.name==='must_change_password'),false);
  fs.unlinkSync(path.join(dir,'auth-password-backups'));
  let auth=createAuthStore(db,`root:owner:${hash}`);
  assert.equal(auth.getById(1).mustChangePassword,false);assert.equal(auth.getById(1).tempPasswordExpiresAt,null);
  assert.equal(auth.getById(2).mustChangePassword,false);assert.equal(auth.getById(2).sessionVersion,5);assert.deepEqual(auth.getById(2).permissions,['price.view']);assert.deepEqual(auth.getById(2).companyCodes,['alvi']);
  const migrated={...db.prepare('SELECT * FROM auth_users').get()};delete migrated.must_change_password;delete migrated.temp_password_expires_at;assert.deepEqual(migrated,old);
  const files=fs.readdirSync(path.join(dir,'auth-password-backups'));assert.equal(files.length,1);
  const copy=new DatabaseSync(path.join(dir,'auth-password-backups',files[0]),{readOnly:true});
  try {assert.deepEqual({...copy.prepare('SELECT * FROM auth_users').get()},old);assert.deepEqual(copy.prepare('SELECT value FROM preserved').get().value,new Uint8Array([0,1,255]));assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{copy.close();}
  auth=createAuthStore(db);assert.equal(verifyPassword(secret,auth.getById(1).passwordHash),true);assert.equal(fs.readdirSync(path.join(dir,'auth-password-backups')).length,1);
});

test('реальный HTTP: временный доступ закрыт до смены, 72ч, сброс, CSRF, старые сеансы и безопасный аудит',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'people-password-http-')),file=path.join(dir,'db.sqlite');
  const secret=crypto.randomBytes(20).toString('base64url');
  const reserve=http.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const child=spawn(process.execPath,[path.join(__dirname,'server.js')],{stdio:'ignore',env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,NODE_PATH:process.env.NODE_PATH,
    TEMP:os.tmpdir(),TMP:os.tmpdir(),PORT:String(port),DATABASE_PATH:file,ASSETS_DIR:path.join(dir,'assets'),AUTH_USERS:`root:owner:${hashPassword(secret)}`,
    SESSION_SECRET:crypto.randomBytes(32).toString('hex'),API_KEY:'',CRM_URL:'http://127.0.0.1:1',CRM_API_KEY:'',PEOPLE_NOTIFICATIONS_ENABLED:'0'}});
  t.after(async()=>{if(child.exitCode===null){const done=once(child,'exit');child.kill();await done;}fs.rmSync(dir,{recursive:true,force:true});});
  const req=(route,session,method='GET',body)=>fetch(`http://127.0.0.1:${port}${route}`,{method,headers:{'content-type':'application/json',...(session?{cookie:session.cookie,'x-csrf-token':session.csrf||''}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  let ready=false;for(let i=0;i<200;i++){try{if((await req('/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,20));}assert.ok(ready);
  const login=async(login,password)=>{const r=await req('/content/login',null,'POST',{login,password});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie').split(';')[0];
    const who=await req('/content/whoami',{cookie}),data=await who.json();return {cookie,csrf:data.csrfToken||data.details?.csrfToken};};
  const owner=await login('root',secret),before=await(await req('/content/whoami',owner)).json();
  assert.equal((await req('/content/admin/team',owner,'POST',{companyCode:'synapse-business',displayName:'Обход',login:'bypass',staffRole:'human_executor',password:secret})).status,400);
  const created=await req('/content/people/members',owner,'POST',{companyCode:'synapse-business',displayName:'Исполнитель',login:'worker',staffRole:'human_executor'});
  assert.equal(created.status,201);assert.match(created.headers.get('cache-control'),/no-store/);
  const {member,temporaryPassword,expiresAt}=await created.json();assert.ok(temporaryPassword.length>=12);assert.ok(Math.abs(Date.parse(expiresAt)-Date.now()-72*3600000)<10000);
  assert.equal((await req(`/content/people/members/${member.id}/approval`,owner,'PUT',{companyCode:'synapse-business',enabled:true})).status,200);
  const one=await login('worker',temporaryPassword),two=await login('worker',temporaryPassword);
  for(const route of ['/content/whoami','/content/people/context','/content/admin/accounts','/content/people/tasks?companyCode=synapse-business','/content/project-chat/rooms','/content/alvi']){
    const r=await req(route,one);assert.equal(r.status,403,route);assert.equal((await r.json()).details.mustChangePassword,true);
  }
  assert.equal((await req('/content/logout',two,'POST')).status,200);
  assert.equal((await req('/content/password',{...one,csrf:''},'POST',{password:secret})).status,403);
  assert.equal((await req('/content/password',one,'POST',{password:'short'})).status,400);
  assert.equal((await req('/content/password',one,'POST',{password:temporaryPassword})).status,400);
  const personal=crypto.randomBytes(6).toString('hex').slice(0,10),changed=await req('/content/password',one,'POST',{password:personal});
  assert.equal(changed.status,200);assert.equal((await req('/content/whoami',one)).status,401);assert.equal((await req('/content/whoami',two)).status,401);
  assert.equal((await req('/content/login',null,'POST',{login:'worker',password:temporaryPassword})).status,401);
  const user=await login('worker',personal);assert.equal((await req('/content/people/context',user)).status,200);
  const reset=`/content/people/members/${member.id}/temp-password`,body={companyCode:'synapse-business'};
  assert.equal((await req(reset,user,'POST',body)).status,403);assert.equal((await req(reset,owner,'POST',{companyCode:'alvi'})).status,403);
  const newTemp=await(await req(reset,owner,'POST',body)).json();assert.notEqual(newTemp.temporaryPassword,temporaryPassword);
  assert.equal((await req('/content/whoami',user)).status,401);assert.equal((await req('/content/login',null,'POST',{login:'worker',password:personal})).status,401);
  const fresh=await login('worker',newTemp.temporaryPassword),db=new DatabaseSync(file);
  try {
    const row=db.prepare('SELECT * FROM auth_users WHERE id=?').get(member.id);assert.ok(verifyPassword(newTemp.temporaryPassword,row.password_hash));
    const audits=JSON.stringify(db.prepare('SELECT action,details_json FROM auth_audit').all());assert.match(audits,/TEMP_PASSWORD_ISSUED/);assert.match(audits,/PASSWORD_SET_BY_USER/);
    for(const value of [temporaryPassword,personal,newTemp.temporaryPassword,row.password_hash])assert.ok(!audits.includes(value));
    db.prepare('UPDATE auth_users SET temp_password_expires_at=? WHERE id=?').run(new Date(Date.now()-1).toISOString(),member.id);
    assert.equal((await req('/content/login',null,'POST',{login:'worker',password:newTemp.temporaryPassword})).status,401);
    assert.equal((await req('/content/password',fresh,'POST',{password:personal})).status,401);
  }finally{db.close();}
  assert.deepEqual(await(await req('/content/whoami',owner)).json(),before);
});
