'use strict';
const {hashPassword} = require('./passwords');
const ROLES = Object.freeze({
  administrator: {name:'Администратор', permissions:['crm.view','crm.edit','autoposting.view','autoposting.edit','company-information.view','actor-onboarding.self']},
  master: {name:'Мастер', permissions:['actor-onboarding.self','autoposting.view','company-information.view']},
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
      WHERE m.company_code=? AND u.role='editor' ORDER BY u.display_name`).all(code);
  }
  function create(actorId,body) {
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='companyCode,displayName,login,password,staffRole')fail(400,'Заполните данные сотрудника без дополнительных прав');
    access(actorId,body.companyCode);
    if(!Object.hasOwn(ROLES,body.staffRole))fail(400,'Выберите администратора или мастера');
    if(typeof body.login!=='string'||!/^[a-z0-9_-]{1,64}$/.test(body.login))fail(400,'Логин: латинские буквы, цифры, дефис или подчёркивание');
    if(typeof body.displayName!=='string'||!body.displayName.trim()||body.displayName.length>120)fail(400,'Укажите имя сотрудника');
    const passwordHash=hashPassword(body.password);
    db.exec('BEGIN IMMEDIATE');
    try {
      if(auth.getByLogin(body.login))fail(409,'Этот логин уже занят');
      const stamp=new Date().toISOString();
      const id=Number(db.prepare(`INSERT INTO auth_users(login,display_name,role,password_hash,created_at,updated_at)
        VALUES(?,?,'editor',?,?,?)`).run(body.login,body.displayName.trim(),passwordHash,stamp,stamp).lastInsertRowid);
      db.prepare('INSERT INTO auth_user_companies VALUES(?,?)').run(id,body.companyCode);
      for(const permission of ROLES[body.staffRole].permissions)db.prepare('INSERT INTO auth_user_permissions VALUES(?,?)').run(id,permission);
      db.prepare('INSERT INTO company_team_members VALUES(?,?,?,?)').run(id,body.companyCode,body.staffRole,actorId);
      db.prepare('INSERT INTO auth_audit(actor_user_id,target_user_id,action,details_json,created_at) VALUES(?,?,?,?,?)')
        .run(actorId,id,'TEAM_MEMBER_CREATED',JSON.stringify({companyCode:body.companyCode,staffRole:body.staffRole}),stamp);
      db.exec('COMMIT');
      return {id,login:body.login,displayName:body.displayName.trim(),staffRole:body.staffRole};
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  return {list,create};
}
module.exports={createCompanyTeam,ROLES};
