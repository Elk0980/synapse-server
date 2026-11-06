/* №180. Личное предпочтение проектов. Серверного хранилища в CRM нет: разрешённый fallback. */
(function(root){
  'use strict';
  const WINDOW=30*86400000;
  function historyStore(storage,userId,now=Date.now){
    const key='sb-project-history-v1:'+userId;
    let data={last:null,events:[]};
    try{const v=JSON.parse(storage.getItem(key)||'null');if(v&&Array.isArray(v.events))data=v;}catch(error){}
    const prune=()=>{data.events=data.events.filter(e=>e&&typeof e.id==='string'&&Number.isFinite(e.at)&&e.at>now()-WINDOW&&e.at<=now());};
    const save=()=>{prune();try{storage.setItem(key,JSON.stringify(data));}catch(error){/* Сессия работает и при запрете storage. */}};
    const stats=()=>{prune();const map=new Map();for(const e of data.events){const s=map.get(e.id)||{count:0,last:0};s.count++;s.last=Math.max(s.last,e.at);map.set(e.id,s);}return map;};
    return {record(id){data.last=id;data.events.push({id,at:now()});save();},remember(id){data.last=id;save();},
      defaultProject(allowed,legacy){return allowed.includes(data.last)?data.last:allowed.includes(legacy)?legacy:allowed[0]||null;},
      sort(ids,current){const map=stats(),index=new Map(ids.map((id,i)=>[id,i]));return [...ids].sort((a,b)=>Number(b===current)-Number(a===current)||(map.get(b)?.count||0)-(map.get(a)?.count||0)||(map.get(b)?.last||0)-(map.get(a)?.last||0)||index.get(a)-index.get(b));},key};
  }
  function install(w){
    const registry=w.SynapseModules;if(!registry||w.SynapseProjectPreferences)return;
    let user=null,store=null,last=null,observer=null,menu=null,canonical=[];
    function apply(){
      if(!store||!menu)return;
      const nodes=[...menu.querySelectorAll('[data-project-id]')],current=nodes.find(n=>n.getAttribute('aria-checked')==='true')?.dataset.projectId;
      if(!current)return;
      if(last&&last!==current)store.record(current);else store.remember(current);last=current;
      const ids=nodes.map(n=>n.dataset.projectId);for(const id of ids)if(!canonical.includes(id))canonical.push(id);
      const sorted=store.sort(canonical.filter(id=>ids.includes(id)),current);
      if(ids.some((id,i)=>id!==sorted[i]))for(const id of sorted)menu.append(nodes.find(n=>n.dataset.projectId===id));
    }
    function bind(){
      let ctx;try{ctx=registry.createContext('project-preferences');}catch(error){return;}
      const id=ctx.user?.id;if(id===null||id===undefined)return;
      menu=w.document.getElementById('project-menu');if(!menu)return;
      if(user!==id){
        user=id;last=null;
        let storage;try{storage=w.localStorage;}catch(error){storage={getItem(){return null;},setItem(){}};}
        store=historyStore(storage,id);
        const nodes=[...menu.querySelectorAll('[data-project-id]')],ids=nodes.map(n=>n.dataset.projectId),current=nodes.find(n=>n.getAttribute('aria-checked')==='true')?.dataset.projectId;
        canonical=[...ids];
        const preferred=store.defaultProject(ids,current);
        if(preferred&&preferred!==current)nodes.find(n=>n.dataset.projectId===preferred)?.click();
      }
      observer?.disconnect();observer=new w.MutationObserver(apply);observer.observe(menu,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-checked']});apply();
    }
    const attach=registry.attachShell;
    registry.attachShell=function(...args){const result=attach.apply(this,args);bind();return result;};
    w.SynapseProjectPreferences={bind,stop(){observer?.disconnect();registry.attachShell=attach;}};
    bind();
  }
  if(typeof module==='object'&&module.exports)module.exports={historyStore,install};else install(root);
})(typeof window==='object'?window:globalThis);
