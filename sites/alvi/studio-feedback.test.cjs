const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/index.html','utf8');
const start=html.indexOf('const DEFAULT_QUIZ_ITEMS =');
const end=html.indexOf('function quizPrice(',start);
const context={};vm.runInNewContext(html.slice(start,end)+';globalThis.quizAPI={quizFits,quizScore,DEFAULT_QUIZ_ITEMS};',context);
const {quizFits,quizScore,DEFAULT_QUIZ_ITEMS}=context.quizAPI;
const data=JSON.parse(fs.readFileSync(__dirname+'/data/price.json','utf8'));
const all=data.categories.flatMap(category=>category.items.map(item=>({item,category})));
function selected(answers,rows=all){return rows.filter(c=>(c.item.quizEnabled===true||(c.item.quizEnabled==null&&DEFAULT_QUIZ_ITEMS.has(c.item.id)))&&quizFits(c,answers)).sort((a,b)=>quizScore(b,answers)-quizScore(a,answers)).slice(0,2).map(c=>c.item.id);}
for(const priority of ['tension','restore','together'])test('short two-guest '+priority+' starts with 90-minute Relax',()=>{
 const ids=selected(['couple','hour',priority]);assert.equal(ids[0],'s2-6');assert.ok(ids.includes('s4-1'));
});
test('Relax for two respects duration, guest count and owner opt-out',()=>{
 assert.ok(!selected(['self','hour','restore']).includes('s2-6'));
 assert.ok(!selected(['couple','few-hours','restore']).includes('s2-6'));
 const rows=all.map(c=>c.item.id==='s2-6'?{...c,item:{...c.item,quizEnabled:false}}:c);
 assert.ok(!selected(['couple','hour','restore'],rows).includes('s2-6'));
});
test('known HQ photo is restored while an owner upload stays intact',()=>{
 const content=require('./subscription-promo-content');
 const doc={subscriptionPromoRevision:content.REVISION,sections:[{id:'promo',fields:[{key:'promo.promo-portrait-1',src:'img/subscription-alvi-20260916-hq.webp'}]}]};
 assert.equal(content.upgrade(doc,'alvi').sections[0].fields[0].src,'img/alvi-poster.png');
 doc.sections[0].fields[0].src='/api/assets/my-portrait.jpg';assert.equal(content.upgrade(doc,'alvi'),doc);
});
