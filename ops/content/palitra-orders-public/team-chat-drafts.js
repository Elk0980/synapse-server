/* Local drafts belong to one verified actor and one server-resolved project. No credentials are stored. */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.SynapseTeamDrafts=api;})(typeof window==='undefined'?globalThis:window,function(){
  'use strict';
  const validId=v=>Number.isSafeInteger(v)&&v>0;
  function snapshot(value){
    if(!value||typeof value!=='object'||typeof value.text!=='string'||value.text.length>12000)throw new Error('Некорректный черновик');
    const attachments=(value.attachments||[]).map(a=>{
      if(!a||!validId(a.id)||typeof a.name!=='string'||a.name.length>512)throw new Error('Некорректное вложение');
      if(a.fileKey!==undefined&&!/^[a-zA-Z0-9_.:-]{8,128}$/.test(a.fileKey))throw new Error('Некорректный файл черновика');
      return {id:a.id,name:a.name,...(a.fileKey?{fileKey:a.fileKey}:{})};
    });
    if(attachments.length>10||new Set(attachments.map(a=>a.id)).size!==attachments.length)throw new Error('Некорректные вложения');
    let attempt=null;
    if(value.attempt){
      const a=value.attempt;
      if(typeof a.text!=='string'||a.text.length>12000||!/^[a-zA-Z0-9_.:-]{8,128}$/.test(a.clientMessageId||'')||!Array.isArray(a.attachmentIds)||a.attachmentIds.length>10||a.attachmentIds.some(id=>!validId(id))||new Set(a.attachmentIds).size!==a.attachmentIds.length)throw new Error('Некорректная попытка');
      if(a.attachmentIds.length!==attachments.length||a.attachmentIds.some((id,i)=>id!==attachments[i].id))throw new Error('Вложения попытки изменились');
      attempt={text:a.text,attachmentIds:[...a.attachmentIds],clientMessageId:a.clientMessageId};
      if(a.expectedChatId!==undefined){if(!/^-\d{1,20}$/.test(a.expectedChatId))throw new Error('Некорректный получатель');attempt.expectedChatId=a.expectedChatId;}
    }
    return {text:value.text,attachments,attempt};
  }
  function create({actor,storage,indexedDB}){
    if(!/^[1-9]\d*$/.test(String(actor)))throw new Error('Нет подтверждённого участника');
    let key='',dbPromise=null;
    const database=()=>dbPromise||=(new Promise((resolve,reject)=>{
      if(!indexedDB){reject(new Error('Не удалось сохранить файл на устройстве'));return;}
      const r=indexedDB.open('synapse-team-chat-drafts',1);
      r.onupgradeneeded=()=>r.result.createObjectStore('files');
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('Не удалось открыть хранилище файлов'));
    }));
    return {
      open(company){
        if(!/^[a-z0-9_-]{1,64}$/.test(company))throw new Error('Нет подтверждённого проекта');
        key='synapse-team-chat:'+actor+':'+company;
        try {const raw=storage.getItem(key);return raw?snapshot(JSON.parse(raw)):null;}catch(_){return null;}
      },
      save(value){if(!key)throw new Error('Чат ещё не открыт');const clean=snapshot(value);storage.setItem(key,JSON.stringify(clean));return clean;},
      async files(value){
        if(!key)throw new Error('Чат ещё не открыт');const ownKey=key,db=await database();
        return new Promise((resolve,reject)=>{
          const writing=value!==undefined,tx=db.transaction('files',writing?'readwrite':'readonly'),store=tx.objectStore('files');
          const r=writing?store.put(value,ownKey):store.get(ownKey);let result;
          r.onsuccess=()=>{result=r.result;};tx.oncomplete=()=>resolve(writing?value:(Array.isArray(result)?result:[]));
          tx.onerror=tx.onabort=()=>reject(new Error('Не удалось сохранить файл на устройстве'));
        });
      },
      close(){if(dbPromise)dbPromise.then(db=>db.close()).catch(()=>{});}
    };
  }
  return Object.freeze({snapshot,create});
});
