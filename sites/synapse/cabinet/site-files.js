(() => {
'use strict';
const byId=id=>document.getElementById(id);
const id=new URL(location.href).searchParams.get('site');
let identity,workspace,currentFile,dirty=false;
const api=async(route,options={})=>{
  const response=await fetch(route,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...options.headers}});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||data.message||'Не удалось выполнить действие');
  return data;
};
const error=value=>{byId('error').textContent=value;};
const showHistory=async()=>{
  const data=await api(`/content/sites/${encodeURIComponent(id)}/history`);
  byId('history').replaceChildren();
  for(const version of data.revisions){
    const item=document.createElement('li');
    item.textContent=`Версия ${version.version} · ${new Date(version.createdAt).toLocaleString('ru-RU')} · ${version.message}`;
    byId('history').append(item);
  }
};
const loadFile=async(filename)=>{
  const file=await api(`/content/sites/${encodeURIComponent(id)}/file?path=${encodeURIComponent(filename)}`);
  if(file.revision!==workspace.revision)throw new Error('Черновик изменён. Обновите страницу перед редактированием');
  currentFile=file.path;byId('file-label').textContent=file.path;byId('file-content').value=file.content;
  dirty=false;byId('save-file').disabled=false;
};
const applyWorkspace=value=>{
  workspace=value;
  byId('site-name').textContent=value.name;document.title=`${value.name} — Synapse`;
  if(!/^https:\/\/(?:[a-z0-9-]+-draft-\d+|palitra-draft)\.synapsebusiness\.ru\/$/.test(value.publicUrl))throw new Error('Адрес черновика не подтверждён');
  byId('open-site').href=value.publicUrl;byId('open-site').hidden=false;
  byId('site-preview').src=value.publicUrl;
  byId('status').textContent=`Версия ${value.version}. Сохранено ${new Date(value.updatedAt).toLocaleString('ru-RU')}.`;
  const selected=currentFile||'index.html';byId('file-list').replaceChildren();
  for(const file of value.files.filter(file=>file.editable))byId('file-list').add(new Option(file.path,file.path));
  byId('file-list').value=selected;
};
byId('file-list').addEventListener('change',async()=>{
  const chosen=byId('file-list').value;
  if(dirty&&!confirm('Есть несохранённые изменения. Перейти к другому файлу?')){byId('file-list').value=currentFile;return;}
  error('');try{await loadFile(chosen);}catch(e){error(e.message);}
});
byId('file-content').addEventListener('input',()=>{dirty=true;});
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
byId('file-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!workspace||!currentFile||byId('save-file').disabled)return;
  error('');byId('save-file').disabled=true;
  try {
    const saved=await api(`/content/sites/${encodeURIComponent(id)}/files`,{method:'PUT',headers:{'X-CSRF-Token':identity.csrfToken},
      body:JSON.stringify({baseRevision:workspace.revision,files:[{path:currentFile,content:byId('file-content').value}],message:byId('save-message').value})});
    dirty=false;applyWorkspace(saved);byId('save-message').value='';await showHistory();
  } catch(e){error(e.message);}finally{byId('save-file').disabled=false;}
});
(async()=>{
  try {
    if(!id||!/^site-[a-f0-9]{20}$/.test(id))throw new Error('Сайт не выбран. Откройте черновик из кабинета проекта');
    identity=await api('/content/whoami');
    applyWorkspace(await api(`/content/sites/${encodeURIComponent(id)}/workspace`));
    byId('workspace').hidden=false;
    await loadFile('index.html');await showHistory();
  }catch(e){error(e.message);byId('site-name').textContent='Не удалось открыть черновик';}
})();
})();
