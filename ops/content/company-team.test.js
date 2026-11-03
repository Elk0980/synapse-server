'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createAuthStore}=require('./auth-store');
const {hashPassword}=require('./passwords');
const {createCompanyTeam}=require('./company-team');
const password='Example-Only-Password-42';
const hash=hashPassword(password);
function setup(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const auth=createAuthStore(db,`root:owner:${hash}`),owner=auth.getByLogin('root');
  const manager=auth.create(owner.id,{login:'manager',displayName:'Руководитель',password,companies:['alvi','avokado'],permissions:['team.manage']},hash);
  return {db,auth,owner,manager,team:createCompanyTeam(auth)};
}
const body=(extra={})=>({companyCode:'alvi',staffRole:'master',login:'worker',displayName:'Сотрудник',password,...extra});
test('руководитель создает мастера только в выбранном салоне, без доступа к CRM и делегированию',t=>{
  const {team,manager,auth,db}=setup(t),m=team.create(manager.id,body());
  const user=auth.getById(m.id);assert.deepEqual(user.companyCodes,['alvi']);
  assert.ok(user.permissions.includes('actor-onboarding.self'));
  for(const p of ['team.manage','account.view','crm.view','crm.edit','autoposting.edit'])assert.ok(!user.permissions.includes(p));
  assert.equal(user.role,'editor');assert.equal(team.list(manager.id,'alvi').length,1);
  assert.deepEqual(team.list(manager.id,'avokado'),[]);
  assert.ok(!JSON.stringify(team.list(manager.id,'alvi')).includes(hash));
  assert.ok(!db.prepare("SELECT details_json FROM auth_audit WHERE action='TEAM_MEMBER_CREATED'").get().details_json.includes(password));
});
test('администратор получает ограниченный набор без управления пользователями',t=>{
  const {team,manager,auth}=setup(t),m=team.create(manager.id,body({staffRole:'administrator'}));
  const p=auth.getById(m.id).permissions;assert.ok(p.includes('crm.edit'));assert.ok(p.includes('autoposting.edit'));assert.ok(!p.includes('team.manage'));assert.ok(!p.includes('account.view'));
  assert.throws(()=>team.create(m.id,body({login:'second'})),{status:403});
});
test('чужая компания, лишние права и системная роль отклоняются',t=>{
  const {team,manager,auth}=setup(t);
  for(const input of [body({companyCode:'taisabai'}),body({staffRole:'owner'}),body({permissions:['account.view']}),body({role:'owner'}),body({companyCode:['alvi','taisabai']})])assert.throws(()=>team.create(manager.id,input));
  assert.equal(auth.getByLogin('worker'),null);
  assert.throws(()=>team.list(manager.id,'taisabai'),{status:403});
});
test('после отзыва права или компании старый actorId не дает доступа',t=>{
  const {team,manager,db}=setup(t);
  db.prepare('DELETE FROM auth_user_companies WHERE user_id=? AND company_code=?').run(manager.id,'alvi');
  assert.throws(()=>team.create(manager.id,body()),{status:403});
  db.prepare('DELETE FROM auth_user_permissions WHERE user_id=?').run(manager.id);
  assert.throws(()=>team.list(manager.id,'avokado'),{status:403});
});
test('повтор логина не создает вторую запись, пароль проверяется',t=>{
  const {team,manager,auth}=setup(t);team.create(manager.id,body());
  assert.throws(()=>team.create(manager.id,body()),{status:409});
  assert.throws(()=>team.create(manager.id,body({login:'other',password:'short'})),{status:400});
  assert.equal(team.list(manager.id,'alvi').length,1);assert.equal(auth.getByLogin('other'),null);
});
test('ошибка вставки откатывает аккаунт и доступы атомарно',t=>{
  const {team,manager,auth,db}=setup(t);
  db.exec("CREATE TRIGGER fail_team BEFORE INSERT ON company_team_members BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  assert.throws(()=>team.create(manager.id,body()));assert.equal(auth.getByLogin('worker'),null);
});

function snapshot(db){
  return {
    users:db.prepare('SELECT * FROM auth_users ORDER BY id').all(),
    companies:db.prepare('SELECT * FROM auth_user_companies ORDER BY user_id,company_code').all(),
    permissions:db.prepare('SELECT * FROM auth_user_permissions ORDER BY user_id,permission').all(),
    members:db.prepare('SELECT * FROM company_team_members ORDER BY user_id').all(),
    audit:db.prepare('SELECT * FROM auth_audit ORDER BY id').all(),
    changes:db.prepare('SELECT total_changes() AS n').get().n,
  };
}

test('перевод исполнителя не переносит сотрудника из другой команды и не снимает его доступы',t=>{
  const {team,owner,auth,db}=setup(t),member=team.create(owner.id,body());
  auth.updateAccess(owner.id,member.id,['alvi','avokado'],['crm.edit','autoposting.edit']);
  const before=snapshot(db);
  assert.throws(()=>team.assignHuman(owner.id,member.id,'avokado'),{status:403});
  assert.deepEqual(snapshot(db),before);
});

test('обычная учётная запись с доступом к компании без членства в команде не переводится в исполнителя',t=>{
  const {team,owner,auth,db}=setup(t);
  const user=auth.create(owner.id,{login:'existing',displayName:'Существующий редактор',password,companies:['alvi'],permissions:['crm.edit']},hash);
  const before=snapshot(db);
  assert.throws(()=>team.assignHuman(owner.id,user.id,'alvi'),{status:403});
  assert.deepEqual(snapshot(db),before);
});

test('устаревшее членство после отзыва компании не разрешает перевод и не меняет запись',t=>{
  const {team,owner,auth,db}=setup(t),member=team.create(owner.id,body());
  auth.updateAccess(owner.id,member.id,['avokado'],['crm.view']);
  const before=snapshot(db);
  assert.throws(()=>team.assignHuman(owner.id,member.id,'alvi'),{status:403});
  assert.deepEqual(snapshot(db),before);
});

test('владелец переводит действующего члена своей команды, сохраняя пароль и данные учётной записи',t=>{
  const {team,owner,auth,db}=setup(t),member=team.create(owner.id,body({staffRole:'administrator'}));
  const before=auth.getById(member.id);
  const result=team.assignHuman(owner.id,member.id,'alvi'),after=auth.getById(member.id);
  assert.equal(result.staffRole,'human_executor');
  assert.equal(after.id,before.id);assert.equal(after.login,before.login);assert.equal(after.displayName,before.displayName);
  assert.equal(after.passwordHash,before.passwordHash);assert.equal(after.createdAt,before.createdAt);assert.equal(after.sessionVersion,before.sessionVersion);
  assert.deepEqual(after.companyCodes,['alvi']);assert.deepEqual(after.permissions,['tasks.self.edit','tasks.self.view']);
  assert.equal(db.prepare('SELECT company_code FROM company_team_members WHERE user_id=?').get(member.id).company_code,'alvi');
  assert.equal(db.prepare("SELECT count(*) n FROM auth_audit WHERE action='HUMAN_EXECUTOR_ASSIGNED' AND target_user_id=?").get(member.id).n,1);
});
