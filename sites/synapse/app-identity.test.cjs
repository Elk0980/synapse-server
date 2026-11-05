// Значок и название приложения: Синапс для всех, кроме пользователей только Palitra.
// Requires jsdom (как остальные тесты кабинета).
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const read=file=>fs.readFileSync(path.join(__dirname,file),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const script=read('brand/app-identity.js');
const owner={login:'vlad',role:'owner',companies:[{id:'palitra-love'},{id:'avokado'}]};
const palitra={login:'darya',role:'editor',companies:[{id:'palitra-love',name:'Palitra'}]};
const avokado={login:'lena',role:'editor',companies:[{id:'avokado',name:'Авокадо'}]};
const mixed={login:'mix',role:'editor',companies:[{id:'palitra-love'},{id:'avokado'}]};

async function page(file,profile){
  const html=read(file).replace(/<script[\s\S]*?<\/script>/g,'');
  const dom=new JSDOM(html,{url:'https://synapse.example/'+file,runScripts:'outside-only'});
  const calls=[];
  const state={profile};
  dom.window.fetch=async url=>{calls.push(url);profile=state.profile;return profile?{ok:true,status:200,json:async()=>structuredClone(profile)}:{ok:false,status:401,json:async()=>({})};};
  dom.window.eval(script);
  await tick();await tick();
  const doc=dom.window.document;
  const href=rel=>doc.querySelector(`link[rel="${rel}"]`).getAttribute('href');
  const meta=()=>doc.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content') ?? null;
  return {dom,doc,calls,href,meta,state};
}

test('cabinet: до входа и для владельца, Авокадо, смешанного пользователя — Синапс',async()=>{
  for(const profile of [null,owner,avokado,mixed]){
    const p=await page('cabinet.html',profile);
    assert.deepEqual(p.calls,['/content/whoami']);
    assert.equal(p.href('manifest'),'manifest.webmanifest');
    assert.equal(p.href('icon'),'brand/synapse-icon-32.png');
    assert.equal(p.href('apple-touch-icon'),'brand/synapse-icon-180.png');
    assert.equal(p.meta(),'Синапс');
  }
});

test('cabinet: пользователь только Palitra получает прежний значок и название',async()=>{
  const p=await page('cabinet.html',palitra);
  assert.equal(p.href('manifest'),'manifest-palitra.webmanifest');
  assert.equal(p.href('icon'),'brand/hugh-icon-32.png');
  assert.equal(p.href('apple-touch-icon'),'brand/hugh-icon-180.png');
  assert.equal(p.meta(),'Synapse Business');
  // Кабинет при смене раздела снова ставит manifest.webmanifest (строка setView) — вариант держится.
  p.doc.querySelector('link[rel="manifest"]').href='manifest.webmanifest';
  await tick();
  assert.equal(p.href('manifest'),'manifest-palitra.webmanifest');
});

test('cabinet: доска владельца сохраняет board.webmanifest',async()=>{
  const p=await page('cabinet.html',owner);
  p.doc.querySelector('link[rel="manifest"]').href='board.webmanifest';
  await tick();
  assert.equal(p.href('manifest'),'board.webmanifest');
  assert.match(read('cabinet.html'),/link\[rel="manifest"\]'\)\.href = ownerBoard \? 'board\.webmanifest' : 'manifest\.webmanifest'/);
});

test('people: Palitra — прежние ссылки и без apple-title; остальные — Синапс',async()=>{
  const p=await page('cabinet/people.html',palitra);
  assert.equal(p.href('manifest'),'people-palitra.webmanifest');
  assert.equal(p.href('icon'),'../brand/hugh-icon-32.png');
  assert.equal(p.href('apple-touch-icon'),'../brand/hugh-icon-180.png');
  assert.equal(p.meta(),null);
  for(const profile of [null,owner,avokado]){
    const q=await page('cabinet/people.html',profile);
    assert.equal(q.href('manifest'),'people.webmanifest');
    assert.equal(q.href('icon'),'../brand/synapse-icon-32.png');
    assert.equal(q.href('apple-touch-icon'),'../brand/synapse-icon-180.png');
    assert.equal(q.meta(),'Синапс');
  }
});

test('после входа значок переключается повторной проверкой whoami',async()=>{
  const p=await page('cabinet.html',null);
  assert.equal(p.href('icon'),'brand/synapse-icon-32.png');
  p.state.profile=palitra;
  p.doc.body.append(p.doc.createElement('form'));
  p.doc.querySelector('form').dispatchEvent(new p.dom.window.Event('submit',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,900));
  assert.equal(p.calls.length,2);
  assert.equal(p.href('icon'),'brand/hugh-icon-32.png');
  assert.equal(p.meta(),'Synapse Business');
  p.dom.window.SynapseAppIdentity.apply(null);
  assert.equal(p.href('icon'),'brand/synapse-icon-32.png');
  assert.equal(p.meta(),'Синапс');
});

test('манифесты: Синапс, Palitra — прежнее содержимое, id не меняется',()=>{
  const json=file=>JSON.parse(read(file));
  const main=json('manifest.webmanifest'),pal=json('manifest-palitra.webmanifest');
  assert.equal(main.name,'Синапс');assert.equal(main.short_name,'Синапс');
  assert.equal(pal.name,'Synapse Business');assert.equal(pal.short_name,'Synapse');
  assert.equal(main.id,'/cabinet.html');assert.equal(pal.id,'/cabinet.html');
  assert.ok(pal.icons.every(icon=>icon.src.startsWith('brand/hugh-icon-')));
  const people=json('cabinet/people.webmanifest'),peoplePal=json('cabinet/people-palitra.webmanifest');
  assert.equal(people.name,'Синапс · Моя работа');assert.equal(people.short_name,'Синапс');
  assert.equal(peoplePal.name,'Моя работа — Synapse Business');assert.equal(peoplePal.short_name,'Моя работа');
  assert.equal(people.id,'/cabinet/people.html');assert.equal(peoplePal.id,'/cabinet/people.html');
  const board=json('board.webmanifest');
  assert.equal(board.name,'Синапс · Задачи');assert.equal(board.id,'/board.html');
  for(const [m,base] of [[main,''],[people,'cabinet/'],[board,'']]){
    assert.ok(m.icons.some(icon=>icon.purpose==='maskable'));
    for(const icon of m.icons){
      assert.match(icon.src,/synapse-icon-/);
      assert.ok(fs.existsSync(path.join(__dirname,base,icon.src)),icon.src);
    }
  }
});

test('значки: размеры и тёмный фон без прозрачности',()=>{
  const png=file=>{const b=fs.readFileSync(path.join(__dirname,'brand',file));
    assert.equal(b.toString('latin1',1,4),'PNG');return {w:b.readUInt32BE(16),h:b.readUInt32BE(20),type:b[25]};};
  for(const [file,size,type] of [['synapse-icon-32.png',32,2],['synapse-icon-180.png',180,2],['synapse-icon-192.png',192,2],
    ['synapse-icon-512.png',512,2],['synapse-icon-512-maskable.png',512,2]]){
    assert.deepEqual(png(file),{w:size,h:size,type},file);
  }
  for(const size of [32,180,192,512])assert.ok(fs.existsSync(path.join(__dirname,'brand',`hugh-icon-${size}.png`)));
});
