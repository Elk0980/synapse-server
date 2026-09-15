const test=require('node:test');
const assert=require('node:assert/strict');
const {isSocial,start}=require('./contact-route.js');
test('recognizes communication links without treating booking, maps or similar domains as social',()=>{
  for(const url of ['https://wa.me/79501001059','https://api.whatsapp.com/send?phone=79501001059','tg://resolve?domain=studio','https://vk.com/lasermkt','https://t.me/avocado_studio38','https://max.ru/u/example'])assert.ok(isSocial(url,'https://avokado3.synapsebusiness.ru/'));
  for(const url of ['https://n396010.yclients.com/company/375899/personal/menu','https://2gis.ru/irkutsk/firm/70000001045439507','https://wa.me.example.com/','tel:+79501001059','#contacts'])assert.ok(!isSocial(url,'https://avokado3.synapsebusiness.ru/'));
});
test('reroutes initial, added and CMS-updated links while contact choices stay direct',()=>{
  let onMutation;
  const saved=global.MutationObserver;
  global.MutationObserver=class{constructor(fn){onMutation=fn;}observe(){}};
  function anchor(href,choice=false){return {attrs:{href,target:'_blank'},closest(){return choice?{}:null;},getAttribute(k){return this.attrs[k];},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];},matches(){return true;}};}
  try{
    for(const main of [false,true]){
      const outside=anchor('https://wa.me/79501001059'),choice=anchor('https://wa.me/79501001059',true);
      const doc={body:{},getElementById(){return main?{}:null;},querySelectorAll(){return [outside,choice];}};
      start(doc,{href:'https://avokado3.synapsebusiness.ru/'+(main?'':'price.html'),pathname:main?'/':'/price.html'});
      const expected=main?'#contacts':'index.html#contacts';
      assert.equal(outside.attrs.href,expected);assert.equal(outside.attrs.target,undefined);
      assert.equal(choice.attrs.href,'https://wa.me/79501001059');assert.equal(choice.attrs.target,'_blank');
      outside.attrs.href='https://vk.com/lasermkt';onMutation([{type:'attributes',target:outside}]);
      assert.equal(outside.attrs.href,expected);
      const added=anchor('https://t.me/avocado_studio38');onMutation([{type:'childList',addedNodes:[added]}]);
      assert.equal(added.attrs.href,expected);
    }
    start({},{pathname:'/contacts.html'});
  }finally{global.MutationObserver=saved;}
});
