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
