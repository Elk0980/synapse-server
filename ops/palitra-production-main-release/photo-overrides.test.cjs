'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function run(editor=false,photo='/original.jpg') {
  const ctx=vm.createContext({window:{},URL,location:{origin:'https://palitra-love.ru'}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'payload/site/config.js'),'utf8'),ctx);
  vm.runInContext(`window.PALITRA_CONFIG.FLOWERS_VISIBLE=true; window.PALITRA_CONFIG.HIDE_UNNAMED=false;
    window.PALITRA_CONFIG.SHOWCASE_PHOTO_OVERRIDES={'product-a':{sourcePhoto:'/original.jpg',photo:'/accepted.jpg'}};`,ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'payload/site/price-render.js'),'utf8'),ctx);
  return JSON.parse(vm.runInContext(`JSON.stringify(window.PalitraPrice.publicData({categories:[{id:'a',items:[{id:'product-a',name:'Набор',photo:${JSON.stringify(photo)},price:8780}]}]},{editor:${editor}}))`,ctx));
}
test('рабочее оформление сохраняет принятый ракурс и цену',()=>{
  const item=run().categories[0].items[0];assert.equal(item.photo,'/accepted.jpg');assert.equal(item.price,8780);
});
test('новое фото из общего прайса сразу имеет приоритет',()=>assert.equal(run(false,'/new-photo.jpg').categories[0].items[0].photo,'/new-photo.jpg'));
test('редактор получает исходные данные прайса',()=>assert.equal(run(true).categories[0].items[0].photo,'/original.jpg'));
