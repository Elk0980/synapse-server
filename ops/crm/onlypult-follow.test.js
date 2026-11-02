'use strict';
// 02.11.2026: ответ создания списком, чтение постов профиля, отозванный доступ, ссылка YouTube из RSS.
const test=require('node:test'),assert=require('node:assert/strict');
const {createOnlypultProvider}=require('./onlypult-provider');
const failure=(code,ambiguous=false)=>Object.assign(Error(code),{code,ambiguous,status:502});
function provider(routes){
  const calls=[];
  const fetchImpl=async(url,init={})=>{calls.push((init.method||'GET')+' '+url.replace('https://api.onlypult.com/v1',''));
    const key=Object.keys(routes).find(k=>url.includes(k));const body=routes[key];
    return {ok:body!==undefined,status:body===undefined?404:200,text:typeof body==='string'?body:JSON.stringify(body)};};
  const readResponse=async r=>r.text;
  return {calls,api:createOnlypultProvider({failure,readResponse,fetchImpl,tokenFor:()=>'secret'})};
}
const row={id:'youtube_shorts',target:'1864750'};
test('ответ создания списком из одного поста принимается как квитанция',async()=>{
  const {api}=provider({'/profiles':{data:[{id:'1864750',name:'P',status:'active',platform:'youtube'}]},'/account':{data:{plan_active:true,timezone:'Asia/Bangkok'}},
    '/posts/limits':{data:{}},'/posts':{data:[{id:'abc',status:'scheduled',profile_id:1864750,platform:'youtube'}]}});
  const receipt=await api.publish(row,{text:'Тест',title:'Тест',mediaUrls:['https://example.test/v.mp4']},()=>{});
  assert.equal(receipt.providerPostId,'abc');assert.equal(receipt.providerStatus,'scheduled');
});
test('устаревшая причина status_message не блокирует отправку: итог даёт Onlypult',async()=>{
  const {api}=provider({'/profiles':{data:[{id:'1864750',name:'P',status:'active',platform:'youtube',status_message:'invalid_access_token'}]}});
  assert.equal((await api.check(row)).id,'1864750');
});
test('файл больше лимита тарифа Onlypult отклоняется до POST; неизвестный размер не блокирует',async()=>{
  const routes={'/profiles':{data:[{id:'1864750',name:'P',status:'active',platform:'youtube'}]},'/account':{data:{plan_active:true}},
    '/posts/limits':{data:{global_max_file_size:1000}},'/posts':{data:{id:'abc',status:'scheduled',profile_id:1864750,platform:'youtube'}}};
  const calls=[];
  const make=size=>require('./onlypult-provider').createOnlypultProvider({failure,readResponse:async r=>r.text,tokenFor:()=>'t',fetchImpl:async(url,init={})=>{
    calls.push((init.method||'GET')+' '+url);
    if(url.startsWith('https://media.test/'))return {ok:true,status:200,headers:{get:k=>k==='content-length'&&size!==null?String(size):null},text:''};
    const key=Object.keys(routes).find(k=>url.includes(k));return {ok:true,status:200,text:JSON.stringify(routes[key])};}});
  const post={text:'Т',title:'Т',mediaUrls:['https://media.test/v.mp4']};
  await assert.rejects(make(5000).publish(row,post,()=>{}),e=>e.code==='FILE_TOO_LARGE'&&e.ambiguous===false);
  assert.ok(!calls.some(c=>c.startsWith('POST')),'POST не отправлялся');
  assert.equal((await make(null).publish(row,post,()=>{})).providerPostId,'abc');
  assert.equal((await make(900).publish(row,post,()=>{})).providerPostId,'abc');
});
test('посты профиля: только этот профиль, время аккаунта переводится в UTC',async()=>{
  const {api}=provider({'/account':{data:{timezone:'Asia/Bangkok'}},'/posts?':{data:[
    {id:'p1',status:'published',content:'Тест',profile_id:1864750,platform:'youtube',created_at:'2026-11-02 21:37:35',published_at:null},
    {id:'p2',status:'published',content:'Чужой',profile_id:999,platform:'youtube',created_at:'2026-11-02 21:37:35'}]}});
  assert.deepEqual(await api.listPosts(row),[{id:'p1',status:'published',content:'Тест',title:'',createdAt:'2026-11-02T14:37:35.000Z',publishedAt:null,error:null}]);
});
test('ссылка YouTube: единственное совпадение заголовка и времени, иначе null',async()=>{
  const entry=(id,title,at)=>`<entry><yt:videoId>${id}</yt:videoId><title>${title}</title><published>${at}</published></entry>`;
  const feed=entries=>({'/profiles/1864750':{data:{platform_id:'UCQOAm6RMI8CIrtXYIbKVr1Q'}},'feeds/videos.xml':`<feed>${entries.join('')}</feed>`});
  let {api}=provider(feed([entry('aaaaaaaaaaa','Тест','2026-11-02T14:38:00+00:00'),entry('bbbbbbbbbbb','Другое','2026-11-02T14:38:00+00:00')]));
  assert.equal(await api.findLink(row,{title:'Тест',publishedAt:'2026-11-02T14:40:00.000Z'}),'https://www.youtube.com/shorts/aaaaaaaaaaa');
  ({api}=provider(feed([entry('aaaaaaaaaaa','Тест','2026-11-02T14:38:00+00:00'),entry('ccccccccccc','Тест','2026-11-02T14:50:00+00:00')])));
  assert.equal(await api.findLink(row,{title:'Тест',publishedAt:'2026-11-02T14:40:00.000Z'}),null,'два одинаковых — не угадываем');
  ({api}=provider(feed([entry('aaaaaaaaaaa','Тест','2026-11-01T14:38:00+00:00')])));
  assert.equal(await api.findLink(row,{title:'Тест',publishedAt:'2026-11-02T14:40:00.000Z'}),null,'старое видео не подходит');
  assert.equal(await api.findLink({id:'vk',target:'1'},{title:'Тест',publishedAt:'2026-11-02T14:40:00.000Z'}),null);
});
