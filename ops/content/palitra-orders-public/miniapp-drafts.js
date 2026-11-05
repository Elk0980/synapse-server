(function(root,build){'use strict';const api=build();if(typeof module==='object'&&module.exports)module.exports=api;else Object.defineProperty(root,'PalitraMiniappDrafts',{value:api,writable:false});})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 function create({indexedDB,scope}){
  if(!indexedDB||!/^[a-f0-9]{64}$/.test(scope))throw new Error('Хранилище черновиков недоступно. Откройте приложение заново.');
  let opened=null,closed=false;const writes=new Map();
  const key=target=>{if(typeof target!=='string'||!/^(native-order|thread|legacy):[1-9]\d*$/.test(target))throw new TypeError('Неизвестная переписка');return scope+':'+target};
  function db(){if(closed)return Promise.reject(new Error('Хранилище закрыто'));if(!opened)opened=new Promise((resolve,reject)=>{
   const req=indexedDB.open('palitra-miniapp-drafts-v1',1);req.onupgradeneeded=()=>req.result.createObjectStore('drafts');
   req.onsuccess=()=>{const value=req.result;value.onversionchange=()=>{value.close();opened=null};resolve(value)};
   req.onerror=()=>{opened=null;reject(new Error('Не удалось открыть черновики. Не закрывайте приложение.'))};
   req.onblocked=()=>reject(new Error('Закройте прежнее окно приложения и повторите вход.'));
  });return opened;}
  async function operation(mode,id,value,remove=false){const database=await db();return new Promise((resolve,reject)=>{
   const tx=database.transaction('drafts',mode),store=tx.objectStore('drafts');let result;
   const req=mode==='readonly'?store.get(id):remove?store.delete(id):store.put(value,id);req.onsuccess=()=>{result=req.result};
   tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>reject(new Error('Не удалось сохранить черновик. Не закрывайте приложение.'));
  })}
  const load=async target=>{const id=key(target);await writes.get(id);return operation('readonly',id)};
  function save(target,draft){const id=key(target),value={text:String(draft.text||''),pending:draft.pending?JSON.parse(JSON.stringify(draft.pending)):null,
   file:draft.file?{blob:draft.file,name:draft.file.name,type:draft.file.type||'',lastModified:draft.file.lastModified||0}:null};
   const next=Promise.resolve(writes.get(id)).catch(()=>{}).then(()=>operation('readwrite',id,value,!value.text&&!value.pending&&!value.file));writes.set(id,next);return next;
  }
  async function close(){if(closed)return;await Promise.allSettled([...writes.values()]);closed=true;if(opened)(await opened).close();}
  return Object.freeze({load,save,close});
 }
 return Object.freeze({create});
});
