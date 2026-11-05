'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createAuthStore,DEPENDENCIES,PERMISSIONS}=require('./auth-store'),{hashPassword}=require('./passwords');

test('№112: approve no longer implies edit; channels implies edit; migration grants channels to edit holders once',()=>{
  assert.ok(PERMISSIONS.includes('autoposting.channels'));
  assert.deepEqual([...DEPENDENCIES['autoposting.approve']].sort(),['autoposting.view','company-information.view']);
  assert.ok(DEPENDENCIES['autoposting.channels'].includes('autoposting.edit'));
  const db=new DatabaseSync(':memory:'),password='Fixture account password';
  try{
    let auth=createAuthStore(db,`owner:owner:${hashPassword(password)}`);const owner=auth.getByLogin('owner');
    const make=(login,permissions)=>{const user=auth.create(owner.id,{login,displayName:login,password},hashPassword(password));auth.updateAccess(owner.id,user.id,['alvi'],permissions);return auth.getById(user.id);};
    const approver=make('approver',['autoposting.approve']);
    assert.ok(approver.permissions.includes('autoposting.view'));assert.ok(!approver.permissions.includes('autoposting.edit'));
    assert.ok(!approver.permissions.includes('autoposting.channels'));
    const keys=make('keys',['autoposting.channels']);assert.ok(keys.permissions.includes('autoposting.edit'));
    // Simulate accounts saved before this release: edit without channels, then the first start of the new code.
    const editor=make('editor',['autoposting.edit']),legacyApprover=make('legacy',['autoposting.approve','autoposting.edit']);
    db.prepare("DELETE FROM auth_meta WHERE key='autoposting_channels_v1'").run();
    auth=createAuthStore(db,'');
    for(const user of [editor,legacyApprover])assert.ok(auth.getById(user.id).permissions.includes('autoposting.channels'),user.login);
    assert.ok(!auth.getById(approver.id).permissions.includes('autoposting.channels'),'approve-only account is not upgraded');
    const meta=JSON.parse(db.prepare("SELECT value FROM auth_meta WHERE key='autoposting_channels_v1'").get().value);
    assert.deepEqual(meta.users,[editor.id,legacyApprover.id]);
    // Owner removes channels later: a restart must not grant it again.
    auth.updateAccess(owner.id,editor.id,['alvi'],['autoposting.edit']);
    auth=createAuthStore(db,'');assert.ok(!auth.getById(editor.id).permissions.includes('autoposting.channels'));
  }finally{db.close();}
});
