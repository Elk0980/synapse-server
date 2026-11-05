const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom'),{PERMISSIONS}=require('../../../ops/content/auth-store');
test('all registered rights have Russian labels and accessible click/keyboard/hover help; never changes checkboxes',()=>{
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'});try{const w=dom.window;w.eval(fs.readFileSync(path.join(__dirname,'permission-help.js'),'utf8'));
 assert.deepEqual([...w.SynapsePermissionHelp.codes].sort(),[...PERMISSIONS].sort());w.document.querySelector('main').innerHTML=w.SynapsePermissionHelp.markup(PERMISSIONS,{selectable:true,checked:['price.edit']});
 const b=w.document.querySelector('.permission-help-button'),tip=w.document.getElementById(b.getAttribute('aria-describedby'));
 assert.equal(tip.hidden,true);b.dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}));assert.equal(tip.hidden,false);b.click();assert.equal(tip.hidden,false);
 b.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(tip.hidden,true);
 for(const key of ['Enter',' ']){b.dispatchEvent(new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));assert.equal(tip.hidden,false);b.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));}
 assert.equal(w.document.querySelectorAll('input:checked').length,1);assert.equal(w.document.querySelector('input:checked').value,'price.edit');
 for(const code of PERMISSIONS){const info=w.SynapsePermissionHelp.describe(code);assert.match(info.label,/[А-Яа-я]/);assert.ok(info.description.length>30);assert.ok(info.source);}
 assert.match(w.SynapsePermissionHelp.describe('account.view').description,/смена паролей/);assert.equal(w.SynapsePermissionHelp.describe('account.view').caution,true);
 assert.match(w.SynapsePermissionHelp.describe('chat.reply').description,/Пока не используется/);
 const crmEdit=w.SynapsePermissionHelp.describe('crm.edit').description;assert.match(crmEdit,/отзыв/);assert.match(crmEdit,/статистик/);assert.match(crmEdit,/Расходы вносит только владелец/);
 const hostile=w.SynapsePermissionHelp.row('<img src=x onerror=alert(1)>');assert.equal(hostile.querySelector('img'),null);
 }finally{dom.window.close();}
});
