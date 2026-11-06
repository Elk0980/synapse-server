/* №180. Сервер — источник предпочтений. localStorage содержит только кэш ответа. */
(function(w){
 'use strict';
 function sortProjects(ids,current,prefs){const stats=new Map((prefs?.companies||[]).map(s=>[s.companyCode,s]));return [...ids].sort((a,b)=>Number(b===current)-Number(a===current)||(stats.get(b)?.picks30d||0)-(stats.get(a)?.picks30d||0)||(stats.get(b)?.lastPickedAt||0)-(stats.get(a)?.lastPickedAt||0));}
 function install(w){
  const registry=w.SynapseModules;if(!registry||w.SynapseProjectPreferences)return;
  let ctx=null,observer=null,prefs=null,user=null,busy=false,stopped=false;
  const viewAs=()=>{try{return Boolean(w.sessionStorage.getItem('synapse-view-as'));}catch{return false;}};
  const cache=()=>{try{w.localStorage.setItem('sb-project-prefs-cache-v2:'+user,JSON.stringify(prefs));}catch{}};
  function paint(){
   if(!ctx||viewAs())return;const menu=w.document.getElementById('project-menu');if(!menu)return;
   const nodes=[...menu.querySelectorAll('[data-project-id]')],ids=nodes.map(n=>n.dataset.projectId),current=nodes.find(n=>n.getAttribute('aria-checked')==='true')?.dataset.projectId;
   const sorted=sortProjects(ids,current,prefs);if(ids.some((id,i)=>id!==sorted[i]))for(const id of sorted)menu.append(nodes.find(n=>n.dataset.projectId===id));
  }
  async function flush(){
   if(busy||!ctx||viewAs()||stopped)return;busy=true;const active=ctx,id=user;
   try{
    const queue=w.SynapseProjectPreferenceQueue ||= [];
    while(queue.length&&ctx===active&&!stopped){
     const item=queue[0];if(item.userId!==id){queue.shift();continue;}
     const result=await active.api.put('user-project-prefs',{companyCode:item.companyCode,requestId:item.requestId},{companyCode:''});
     if(ctx!==active)return;prefs=result.preferences;cache();queue.shift();paint();
    }
   }catch(error){/* Неизвестный результат не считается новым выбором: тот же requestId при повторе. */}
   finally{busy=false;if(ctx!==active&&!stopped)void flush();}
  }
  function bind(){
   if(viewAs()){observer?.disconnect();return;}
   let next;try{next=registry.createContext('project-preferences');}catch{return;}
   if(next.user?.id==null)return;ctx=next;user=next.user.id;prefs=next.projectPreferences||{lastCompanyCode:null,companies:[]};cache();
   const menu=w.document.getElementById('project-menu');observer?.disconnect();if(menu){observer=new w.MutationObserver(paint);observer.observe(menu,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-checked']});paint();}void flush();
  }
  const attach=registry.attachShell;registry.attachShell=function(...args){const result=attach.apply(this,args);bind();return result;};
  w.addEventListener('sb:project-picked',flush);w.addEventListener('online',flush);
  w.SynapseProjectPreferences={bind,flush,stop(){stopped=true;observer?.disconnect();w.removeEventListener('sb:project-picked',flush);w.removeEventListener('online',flush);registry.attachShell=attach;}};bind();
 }
 if(typeof module==='object'&&module.exports)module.exports={sortProjects,install};else install(w);
})(typeof window==='object'?window:globalThis);
