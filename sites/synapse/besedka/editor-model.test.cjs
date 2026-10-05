'use strict';
const assert=require('node:assert/strict'),M=require('./editor-model.js');
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} ≠ ${b}`);
let work=M.example({length:4,width:3,height:2.5,roof:'shed',rise:1,cover:'pergola',section:100,material:'Древесина'});
assert.equal(work.parts.filter(p=>p.name.startsWith('Стойка')).length,4);
near(M.bounds(work).size[0],4);near(M.bounds(work).size[1],3.5);near(M.bounds(work).size[2],3);
for(const p of work.parts){assert.ok(M.points(p).every(v=>v.every(Number.isFinite)));assert.ok(p.dimensions.every(n=>n>0));}
let [a,b]=work.parts.map(p=>p.id),original=M.points(work.parts[0]);
work=M.group(work,[a,b],'Рама');const grouped=JSON.stringify(work.parts),groupId=work.groups[0].id;
assert.equal(M.selection(work,[a]).length,2);
assert.equal(JSON.stringify(M.ungroup(work,[groupId]).parts),grouped,'Разгруппировка должна сохранять мировую геометрию');
const moved=M.transform(work,[groupId],{translation:[.3,.5,-.7]});
for(let j=0;j<8;j++)for(let i=0;i<3;i++)near(M.points(moved.parts[0])[j][i],original[j][i]+[.3,.5,-.7][i]);
let turned=work;for(let i=0;i<4;i++)turned=M.transform(turned,[groupId],{rotation:[0,90,0]});
for(let j=0;j<8;j++)for(let i=0;i<3;i++)near(M.points(turned.parts[0])[j][i],original[j][i]);
const custom=M.update(work,[a],{dimensions:[.2,3,.1]},false);assert.deepEqual(custom.parts[0].dimensions,[.2,3,.1]);assert.deepEqual(custom.parts[1].dimensions,work.parts[1].dimensions);
const copied=M.duplicate(work,[groupId],[1,0,0]);assert.equal(copied.parts.length,work.parts.length+2);assert.equal(copied.groups.length,2);assert.ok(copied.groups[1].members.every(id=>!work.parts.some(p=>p.id===id)));
const history=M.history(work);history.commit(copied);history.commit(M.remove(copied,[copied.groups[1].id]));assert.deepEqual(history.undo(),copied);assert.deepEqual(history.undo(),work);assert.deepEqual(history.redo(),copied);
assert.deepEqual(M.load(JSON.stringify(custom)),custom);assert.equal(M.load(JSON.stringify({version:1,project:'Беседка',parameters:{length:'',width:'',height:''}})).parts.length,0);
assert.ok(M.load(JSON.stringify({version:1,project:'Беседка',parameters:{length:4,width:3,height:2.5,roof:'shed',rise:1,cover:'pergola',section:100}})).parts.length>8);
let locked=M.setFlags(work,[a],{locked:true});assert.throws(()=>M.transform(locked,[groupId],{translation:[1,0,0]}),/защит/);
const aligned=M.align(M.ungroup(work,[groupId]),[a],b,0,'end',.05);near(M.bounds(aligned,[a]).min[0],M.bounds(aligned,[b]).max[0]+.05);
assert.equal(M.mesh(M.setFlags(work,[a],{hidden:true})).faces.length,M.mesh(work).faces.length-12);
assert.ok(M.bill(work).reduce((n,r)=>n+r.count,0)===work.parts.length);
for(const roof of ['shed','gable','flat']){const p=M.example({length:4,width:3,height:2.5,roof,rise:1,cover:'solid',section:100});assert.ok(M.mesh(p).vertices.every(v=>v.every(Number.isFinite)));near(M.bounds(p).size[0],4);near(M.bounds(p).size[2],3);near(M.bounds(p).size[1],roof==='flat'?2.5:3.5);}
assert.throws(()=>M.validate({...work,parts:[{...work.parts[0],position:[NaN,0,0]}]}),/Положение/);
assert.throws(()=>M.validate({...work,groups:[...work.groups,{id:'bad',name:'bad',members:[a,b]}]}),/одной группе/);
assert.throws(()=>M.load('{broken'),/повреждён/);
for(const roof of ['shed','gable','flat']){const large=M.example({length:30,width:30,height:10,roof,rise:5,cover:'solid',section:300});near(M.bounds(large).size[0],30);near(M.bounds(large).size[2],30);assert.ok(large.parts.every(p=>p.dimensions.every(n=>n<=60)));}
console.log('PASS: geometry, independent editing, grouping, rigid movement/rotation, duplication, undo/redo, v1/v2 import, locks, alignment, visibility, bill');
