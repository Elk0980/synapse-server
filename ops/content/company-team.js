'use strict';
const {hashPassword} = require('./passwords');
const crypto=require('node:crypto');
const ROLES = Object.freeze({
  administrator: {name:'Администратор', permissions:['crm.view','crm.edit','autoposting.view','autoposting.edit','autoposting.channels','company-information.view','actor-onboarding.self']},
  master: {name:'Мастер', permissions:['actor-onboarding.self','autoposting.view','company-information.view']},
  human_executor: {name:'Исполнитель — свои задачи', permissions:['tasks.self.view','tasks.self.edit']},
});
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
function createCompanyTeam(auth) {
  const db=auth.db;
  db.exec(`CREATE TABLE IF NOT EXISTS company_team_members (
    user_id INTEGER PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
    company_code TEXT NOT NULL, staff_role TEXT NOT NULL, created_by INTEGER NOT NULL);`);
  function access(actorId,code) {
    const actor=auth.getById(actorId);
    if(!actor || (actor.role!=='owner'&&!actor.permissions.includes('team.manage')))fail(403,'Нет права добавлять сотрудников');
    if(!actor.companyCodes.includes(code))fail(403,'Компания недоступна');
    return actor;
  }
  function list(actorId,code) {
    access(actorId,code);
    return db.prepare(`SELECT u.id,u.login,u.display_name displayName,m.staff_role staffRole
      FROM company_team_members m JOIN auth_users u ON u.id=m.user_id
      JOIN auth_user_companies c ON c.user_id=u.id AND c.company_code=m.company_code
      WHERE m.company_code=? AND u.role='editor' ORDER BY u.display_name`).all(code)
      .map(member=>({...member,executorKey:`person:${member.id}`}));
  }
  function create(actorId,body,temporary=false) {
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!==(temporary?'companyCode,displayName,login,staffRole':'companyCode,displayName,login,password,staffRole'))fail(400,'Заполните данные сотрудника без дополнительных прав');
    access(actorId,body.companyCode);
    if(!Object.hasOwn(ROLES,body.staffRole))fail(400,'Выберите администратора или мастера');
    if(body.staffRole==='human_executor'&&auth.getById(actorId)?.role!=='owner')fail(403,'Доступ исполнителя создаёт владелец');
    if(typeof body.login!=='string'||!/^[a-z0-9_-]{1,64}$/.test(body.login))fail(400,'Логин: латинские буквы, цифры, дефис или подчёркивание');
    if(typeof body.displayName!=='string'||!body.displayName.trim()||body.displayName.length>120)fail(400,'Укажите имя сотрудника');
    if(temporary&&(body.staffRole!=='human_executor'||auth.getById(actorId)?.role!=='owner'))fail(403,'Доступ создаёт владелец');
    const temporaryPassword=temporary?crypto.randomBytes(18).toString('base64url'):undefined;
    const expiresAt=temporary?new Date(Date.now()+72*3600000).toISOString():null;
    const passwordHash=hashPassword(temporaryPassword??body.password);
    db.exec('BEGIN IMMEDIATE');
    try {
      if(auth.getByLogin(body.login))fail(409,'Этот логин уже занят');
      const stamp=new Date().toISOString();
      const id=Number(db.prepare(`INSERT INTO auth_users(login,display_name,role,password_hash,created_at,updated_at,must_change_password,temp_password_expires_at)
        VALUES(?,?,'editor',?,?,?,?,?)`).run(body.login,body.displayName.trim(),passwordHash,stamp,stamp,temporary?1:0,expiresAt).lastInsertRowid);
      db.prepare('INSERT INTO auth_user_companies VALUES(?,?)').run(id,body.companyCode);
      for(const permission of ROLES[body.staffRole].permissions)db.prepare('INSERT INTO auth_user_permissions VALUES(?,?)').run(id,permission);
      db.prepare('INSERT INTO company_team_members VALUES(?,?,?,?)').run(id,body.companyCode,body.staffRole,actorId);
      db.prepare('INSERT INTO auth_audit(actor_user_id,target_user_id,action,details_json,created_at) VALUES(?,?,?,?,?)')
        .run(actorId,id,'TEAM_MEMBER_CREATED',JSON.stringify({companyCode:body.companyCode,staffRole:body.staffRole}),stamp);
      if(temporary)auth.audit(actorId,id,'TEMP_PASSWORD_ISSUED');
      db.exec('COMMIT');
      return {id,login:body.login,displayName:body.displayName.trim(),staffRole:body.staffRole,executorKey:`person:${id}`,...(temporary?{temporaryPassword,expiresAt}:{})};
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  function assignHuman(actorId,userId,companyCode) {
    const actor=access(actorId,companyCode),user=auth.getById(userId);
    if(actor.role!=='owner')fail(403,'Доступ исполнителя назначает владелец');
    if(!user||user.role==='owner')fail(400,'Выберите существующего редактора');
    const member=db.prepare(`SELECT 1 FROM company_team_members m
      JOIN auth_user_companies c ON c.user_id=m.user_id AND c.company_code=m.company_code
      WHERE m.user_id=? AND m.company_code=?`).get(userId,companyCode);
    if(!member)fail(403,'Пользователь не состоит в команде этой компании');
    // Явное действие владельца: права заменяются узким пресетом, данные аккаунта сохраняются.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM auth_user_companies WHERE user_id=?').run(userId);
      db.prepare('DELETE FROM auth_user_permissions WHERE user_id=?').run(userId);
      db.prepare('INSERT INTO auth_user_companies VALUES(?,?)').run(userId,companyCode);
      for(const p of ROLES.human_executor.permissions)db.prepare('INSERT INTO auth_user_permissions VALUES(?,?)').run(userId,p);
      db.prepare(`INSERT INTO company_team_members VALUES(?,?,'human_executor',?)
        ON CONFLICT(user_id) DO UPDATE SET company_code=excluded.company_code,staff_role=excluded.staff_role,created_by=excluded.created_by`).run(userId,companyCode,actorId);
      const stamp=new Date().toISOString();
      db.prepare('UPDATE auth_users SET updated_at=? WHERE id=?').run(stamp,userId);
      db.prepare('INSERT INTO auth_audit(actor_user_id,target_user_id,action,details_json,created_at) VALUES(?,?,?,?,?)')
        .run(actorId,userId,'HUMAN_EXECUTOR_ASSIGNED',JSON.stringify({companyCode,executorKey:`person:${userId}`,previousCompanies:user.companyCodes,previousPermissions:user.permissions}),stamp);
      db.exec('COMMIT');
      return {id:userId,login:user.login,displayName:user.displayName,staffRole:'human_executor',executorKey:`person:${userId}`};
    } catch(error){db.exec('ROLLBACK');throw error;}
  }
  return {list,create,assignHuman};
}
module.exports={createCompanyTeam,ROLES};
