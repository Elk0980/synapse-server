'use strict';
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else Object.defineProperty(root,'PalitraPublicationComposer',{value:api,writable:false});})(typeof globalThis==='undefined'?window:globalThis,()=>{
 const IMAGE_TYPES=new Set(['image/jpeg','image/png','image/webp']);
 const VIDEO_TYPES=new Set(['video/mp4','video/webm']);
 const FORMATS=new Set(['post','story','reel','carousel']);
 const KNOWN=['telegram','vk','youtube_shorts','instagram','tiktok','max'];
 const ERROR_TEXT={PROFILE_CHANGED:'Данные компании обновились. Закройте форму и откройте её снова, чтобы использовать актуальный часовой пояс и профиль.',ACCESS_DENIED:'Доступ к созданию материалов ограничен. Введённые данные остаются в форме.',AUTH_REQUIRED:'Сеанс завершён. Введённые данные остаются в форме.',FILE_TOO_LARGE:'Файл превышает допустимый размер.',MEDIA_UNSUPPORTED:'Формат файла не поддерживается.'};
 const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
 const validZone=value=>{try{new Intl.DateTimeFormat('ru',{timeZone:value});return typeof value==='string'&&value.length>0;}catch{return false;}};
 function localTime(iso,zone){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(iso));const part=key=>parts.find(p=>p.type===key).value;return part('year')+'-'+part('month')+'-'+part('day')+'T'+part('hour')+':'+part('minute');}
 function toUTC(local,zone){
  if(typeof local!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)||!day(local.slice(0,10))||!validZone(zone))throw Error('INVALID_DATE_TIME');
  const wall=Date.parse(local+':00Z');if(!Number.isFinite(wall))throw Error('INVALID_DATE_TIME');let time=wall;
  for(let i=0;i<5;i++)time+=wall-Date.parse(localTime(new Date(time).toISOString(),zone)+':00Z');
  const iso=new Date(time).toISOString();if(localTime(iso,zone)!==local)throw Error('INVALID_DATE_TIME');
  for(const offset of [-7200000,-3600000,-1800000,1800000,3600000,7200000])if(localTime(new Date(time+offset).toISOString(),zone)===local)throw Error('AMBIGUOUS_DATE_TIME');
  return iso;
 }
 function create(options){
  const {document:d,window:w,date,readContext,uploadAsset,saveDraft,onSaved=()=>{},onClose=()=>{}}=options;
  if(!d||!w||typeof readContext!=='function'||typeof uploadAsset!=='function'||typeof saveDraft!=='function')throw Error('COMPOSER_OPTIONS');
  let disposed=false,busy=false,dirty=false,unknown=false,saved=false,context=null,media=[],previews=new Map(),controllers=new Set();
  const previousFocus=d.activeElement,id='pc-'+(w.crypto?.randomUUID?.()||Math.random().toString(36).slice(2));
  const origin='palitra-app:'+(w.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));
  function h(tag,className,text){const el=d.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;}
  function button(text,className,handler){const el=h('button',className,text);el.type='button';if(handler)el.addEventListener('click',handler);return el;}
  function field(label,control,help){const wrap=h('div','palitra-composer-field');control.id=id+'-'+(control.name||Math.random().toString(36).slice(2));const labelEl=h('label','palitra-composer-label',label);labelEl.htmlFor=control.id;wrap.append(labelEl,control);if(help){const hint=h('p','palitra-composer-hint',help);hint.id=control.id+'-hint';control.setAttribute('aria-describedby',hint.id);wrap.append(hint);}return wrap;}
  function input(type,name){const el=h('input','palitra-composer-input');el.type=type;el.name=name;return el;}
  const element=h('div','palitra-composer-overlay');
  const panel=h('section','palitra-composer-panel');panel.tabIndex=-1;panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby',id+'-heading');
  const heading=h('h2','palitra-composer-heading','Создать публикацию');heading.id=id+'-heading';
  const close=button('×','palitra-composer-close',()=>requestClose());close.setAttribute('aria-label','Закрыть создание публикации');
  const header=h('header','palitra-composer-header');header.append(heading,close);
  const intro=h('p','palitra-composer-intro','Подготовьте материал и проверьте, как он выглядит на выбранных площадках.');
  const form=h('form','palitra-composer-form');form.noValidate=true;
  const status=h('p','palitra-composer-status','Загружаем площадки и настройки компании…');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const alert=h('p','palitra-composer-error');alert.setAttribute('role','alert');alert.hidden=true;
  const title=input('text','title');title.maxLength=200;title.required=true;title.placeholder='Например, Happy Birthday и три шара';title.autocomplete='off';
  const platforms=h('fieldset','palitra-composer-platforms');const legend=h('legend','palitra-composer-label','Площадки');platforms.append(legend,h('p','palitra-composer-hint','Отметьте площадки. «Предпросмотр» покажет материал с зонами интерфейса.'));
  const channelList=h('div','palitra-composer-channels');platforms.append(channelList);
  const format=h('select','palitra-composer-input');format.name='format';for(const [value,label]of [['post','Пост'],['story','История'],['reel','Короткое видео'],['carousel','Карусель фотографий']]){const option=h('option','',label);option.value=value;format.append(option);}
  const fileInput=input('file','media');fileInput.multiple=true;
  const mediaKind=h('select','palitra-composer-input');mediaKind.name='mediaKind';for(const [value,label]of [['photo','Фотографии'],['video','Видео']]){const option=h('option','',label);option.value=value;mediaKind.append(option);}
  const mediaHelp=h('p','palitra-composer-hint');mediaHelp.id=id+'-media-hint';fileInput.setAttribute('aria-describedby',mediaHelp.id);
  const mediaList=h('ul','palitra-composer-media-list');mediaList.setAttribute('aria-label','Прикреплённые файлы');
  const mediaFields=h('div','palitra-composer-media');mediaFields.append(field('Что загрузить',mediaKind),field('Фотографии или видео',fileInput),mediaHelp,mediaList);
  const dayInput=input('date','date');dayInput.required=true;if(day(date))dayInput.value=date;
  const timeInput=input('time','time');timeInput.required=true;timeInput.value='12:00';
  const zoneInput=input('text','timezone');zoneInput.required=true;zoneInput.autocomplete='off';zoneInput.setAttribute('spellcheck','false');
  const dateRow=h('div','palitra-composer-date-row');dateRow.append(field('Дата',dayInput),field('Время',timeInput));
  const text=h('textarea','palitra-composer-input palitra-composer-text');text.name='text';text.rows=5;text.maxLength=20000;text.placeholder='Текст публикации';
  const save=button('Сохранить','palitra-composer-primary');save.type='submit';save.disabled=true;
  const cancel=button('Отмена','palitra-composer-secondary',()=>requestClose());
  const footer=h('footer','palitra-composer-footer');footer.append(save,cancel);
  const saveNote=h('p','palitra-composer-save-note','Материал сохранится как черновик. На площадки он пока не отправляется.');
  const discard=h('div','palitra-composer-discard');discard.hidden=true;discard.setAttribute('role','alert');
  const discardText=h('p','','Отменить изменения? Несохранённый материал будет удалён из этой формы.');
  const stay=button('Продолжить редактирование','palitra-composer-secondary',()=>{discard.hidden=true;cancel.focus();});
  const leave=button('Отменить изменения','palitra-composer-danger',()=>finishClose());discard.append(discardText,stay,leave);
  form.append(field('Название материала',title),platforms,field('Формат',format),mediaFields,dateRow,field('Часовой пояс',zoneInput,'По умолчанию — часовой пояс вашей компании.'),field('Текст публикации',text),alert,status,saveNote,footer,discard);
  panel.append(header,intro,form);element.append(panel);
  const channelCheckboxes=new Map(),previewHosts=new Map();
  function error(message,target){alert.textContent=message;alert.hidden=false;if(target){target.setAttribute('aria-invalid','true');target.focus();}else alert.scrollIntoView?.({block:'nearest'});}
  function clearError(){alert.hidden=true;alert.textContent='';for(const control of form.querySelectorAll('[aria-invalid]'))control.removeAttribute('aria-invalid');}
  function selected(){return [...channelCheckboxes].filter(([,control])=>control.checked).map(([key])=>key);}
  function setBusy(value){busy=value;form.setAttribute('aria-busy',String(value));for(const control of form.querySelectorAll('input,select,textarea,button'))control.disabled=value;mediaKind.disabled=value||format.value==='reel'||format.value==='carousel';save.disabled=value||!context||unknown;close.disabled=value;}
  function markDirty(){dirty=true;discard.hidden=true;}
  function syncAccept(){const video=mediaKind.value==='video';fileInput.accept=video?'video/mp4,video/webm':'image/jpeg,image/png,image/webp';fileInput.multiple=format.value==='carousel'||(format.value==='post'&&!video);mediaHelp.textContent=video?'MP4 или WebM, до 60 МБ. Одно видео на материал.':format.value==='story'?'JPEG, PNG или WebP, до 10 МБ. Одна фотография для истории.':'JPEG, PNG или WebP, до 10 МБ каждый. До 10 фотографий для поста или карусели.';mediaKind.disabled=busy||format.value==='reel'||format.value==='carousel';}
  function previewProps(platform){return{document:d,window:w,platform,format:format.value,title:title.value,text:text.value,publisherLabel:context?.publisherLabel||'Палитра',media:media.map(item=>({url:item.url,type:item.file.type,name:item.file.name}))};}
  function updatePreviews(){for(const [platform,host]of previewHosts){const detail=host.parentElement;if(!detail.open)continue;const props=previewProps(platform);let current=previews.get(platform);if(current){try{current.update(props);}catch{host.replaceChildren(h('p','palitra-composer-hint','Не удалось обновить предпросмотр. Материал остаётся в форме.'));}continue;}const factory=options.previewFactory||w.PalitraPlatformPreview?.create;if(typeof factory!=='function'){host.replaceChildren(h('p','palitra-composer-hint','Предпросмотр временно недоступен. Файлы и текст остаются в форме.'));continue;}try{current=factory(props);if(!current||!current.element||typeof current.update!=='function'||typeof current.dispose!=='function')throw Error('PREVIEW_INTERFACE');previews.set(platform,current);host.replaceChildren(current.element);}catch{host.replaceChildren(h('p','palitra-composer-hint','Предпросмотр временно недоступен. Файлы и текст остаются в форме.'));}}}
  function renderMedia(){mediaList.replaceChildren();media.forEach((item,index)=>{const li=h('li','palitra-composer-media-item');const description=h('span','',item.file.name+' · '+(item.file.size/1048576).toLocaleString('ru-RU',{maximumFractionDigits:1})+' МБ');const remove=button('Удалить','palitra-composer-remove',()=>{if(busy||unknown)return;w.URL.revokeObjectURL(item.url);media.splice(index,1);markDirty();renderMedia();updatePreviews();});remove.disabled=busy||unknown;remove.setAttribute('aria-label','Удалить файл '+item.file.name);li.append(description,remove);mediaList.append(li);});}
  function requestClose(){if(busy)return;if(!saved&&(dirty||unknown)){discard.hidden=false;stay.focus();return;}finishClose();}
  function finishClose(){if(disposed)return;dispose();onClose();}
  function dispose(){if(disposed)return;disposed=true;for(const controller of controllers)controller.abort();controllers.clear();for(const preview of previews.values()){try{preview.dispose();}catch{}}previews.clear();for(const item of media)w.URL.revokeObjectURL(item.url);media=[];d.removeEventListener('keydown',onKeyDown,true);if(previousFocus?.isConnected)previousFocus.focus();}
  function onKeyDown(event){if(disposed||!element.isConnected)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();requestClose();return;}if(event.key!=='Tab')return;const focusable=[...panel.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')].filter(el=>!el.closest('[hidden]')&&!el.closest('details:not([open]) .palitra-composer-preview'));const first=focusable[0]||panel,last=focusable[focusable.length-1]||panel;if(event.shiftKey&&(d.activeElement===first||!panel.contains(d.activeElement))){event.preventDefault();last.focus();}else if(!event.shiftKey&&(d.activeElement===last||!panel.contains(d.activeElement))){event.preventDefault();first.focus();}}
  d.addEventListener('keydown',onKeyDown,true);
  form.addEventListener('input',event=>{if(busy||unknown)return;markDirty();if(event.target!==fileInput)updatePreviews();});
  form.addEventListener('change',event=>{if(busy||unknown)return;markDirty();if(event.target===format){if(format.value==='reel')mediaKind.value='video';if(format.value==='carousel')mediaKind.value='photo';syncAccept();}if(event.target===mediaKind)syncAccept();updatePreviews();});
  fileInput.addEventListener('change',()=>{
   if(disposed||busy||unknown)return;clearError();const files=[...fileInput.files];fileInput.value='';if(!files.length)return;
   const allowed=mediaKind.value==='video'?VIDEO_TYPES:IMAGE_TYPES;const maxCount=mediaKind.value==='video'||format.value==='story'?1:10;
   if(media.length+files.length>maxCount){error('Для этого формата можно добавить '+(maxCount===1?'один файл.':'до 10 файлов.'),fileInput);return;}
   for(const file of files){if(!allowed.has(file.type)){error('Выберите '+(mediaKind.value==='video'?'видео MP4 или WebM.':'фото JPEG, PNG или WebP.'),fileInput);return;}if(!file.size||file.size>(VIDEO_TYPES.has(file.type)?60:10)*1048576){error('Файл «'+file.name+'» должен быть не пустым и не больше '+(VIDEO_TYPES.has(file.type)?60:10)+' МБ.',fileInput);return;}}
   const added=[];try{for(const file of files)added.push({file,url:w.URL.createObjectURL(file),uploaded:null});}catch{for(const item of added)w.URL.revokeObjectURL(item.url);error('Не удалось открыть выбранные файлы. Попробуйте выбрать их снова.',fileInput);return;}
   media.push(...added);markDirty();renderMedia();updatePreviews();
  });
  async function loadContext(){if(disposed)return;const controller=new w.AbortController();controllers.add(controller);save.disabled=true;status.textContent='Загружаем площадки и настройки компании…';try{const value=await readContext({signal:controller.signal});if(disposed)return;if(!value||!Array.isArray(value.channels)||!validZone(value.timezone)||(value.profileRevision!==null&&(!Number.isSafeInteger(value.profileRevision)||value.profileRevision<1)))throw Error('COMPOSER_CONTEXT_INVALID');const channels=value.channels.filter(channel=>channel&&KNOWN.includes(channel.id)&&typeof channel.name==='string');if(!channels.length)throw Error('COMPOSER_CONTEXT_INVALID');if(new Set(channels.map(channel=>channel.id)).size!==channels.length)throw Error('COMPOSER_CONTEXT_INVALID');context=value;if(!zoneInput.value)zoneInput.value=value.timezone;if(!dayInput.value)dayInput.value=localTime(new Date().toISOString(),value.timezone).slice(0,10);channelList.replaceChildren();for(const channel of channels){const row=h('div','palitra-composer-channel');const label=h('label','palitra-composer-channel-label');const checkbox=input('checkbox','platform-'+channel.id);checkbox.value=channel.id;checkbox.id=id+'-platform-'+channel.id;checkbox.className='palitra-composer-checkbox';label.htmlFor=checkbox.id;label.append(checkbox,h('span','',channel.name));const detail=h('details','palitra-composer-details');const summary=h('summary','','Предпросмотр');summary.setAttribute('aria-label','Предпросмотр: '+channel.name);const host=h('div','palitra-composer-preview');detail.append(summary,host);detail.addEventListener('toggle',()=>{if(!disposed)updatePreviews();});previewHosts.set(channel.id,host);channelCheckboxes.set(channel.id,checkbox);checkbox.addEventListener('change',()=>{detail.open=checkbox.checked;updatePreviews();});row.append(label,detail);if(!channel.connected||!channel.enabled)row.append(h('p','palitra-composer-channel-note','Площадка пока не готова к отправке. Черновик сохранить можно.'));channelList.append(row);}status.textContent='';save.disabled=unknown||busy;}
   catch(err){if(disposed||err?.name==='AbortError')return;status.textContent='Не удалось загрузить площадки и настройки. Введённые данные сохранены в форме.';const retry=button('Повторить загрузку','palitra-composer-secondary',()=>{retry.remove();loadContext();});status.append(d.createTextNode(' '),retry);}finally{controllers.delete(controller);}}
  form.addEventListener('submit',async event=>{
   event.preventDefault();if(disposed||busy||unknown||!context)return;clearError();
   if(!title.value.trim()){error('Введите название материала.',title);return;}if(!selected().length){error('Отметьте хотя бы одну площадку.',channelCheckboxes.values().next().value);return;}
   if(!FORMATS.has(format.value)){error('Выберите формат.',format);return;}
   if(!validZone(zoneInput.value.trim())){error('Укажите корректный часовой пояс, например Europe/Moscow.',zoneInput);return;}
   let scheduledAt;try{scheduledAt=toUTC(dayInput.value+'T'+timeInput.value,zoneInput.value.trim());}catch(err){error(err.message==='AMBIGUOUS_DATE_TIME'?'Это время встречается дважды при переводе часов. Выберите другое время.':'Проверьте дату и время: выбранного времени может не быть из-за перевода часов.',dayInput);return;}
   if(!media.length&&(format.value!=='post'||!text.value.trim())){error('Добавьте '+(format.value==='reel'?'видео.':'фотографию или видео. Для текстового поста заполните текст.'),fileInput);return;}
   const video=mediaKind.value==='video',maxCount=video||format.value==='story'?1:10;
   if(media.length>maxCount||media.some(item=>!(video?VIDEO_TYPES:IMAGE_TYPES).has(item.file.type))){error('Прикреплённые файлы не соответствуют выбранному формату. Удалите лишние или измените формат.',fileInput);return;}
   setBusy(true);status.textContent=media.length?'Загружаем файлы…':'Сохраняем черновик…';const controller=new w.AbortController();controllers.add(controller);
   try{
    for(const item of media){if(item.uploaded)continue;const uploaded=await uploadAsset(item.file,{signal:controller.signal});if(disposed)return;if(!uploaded||typeof uploaded.url!=='string'||!/^https:\/\//.test(uploaded.url))throw Object.assign(Error('ASSET_RESPONSE_INVALID'),{unknown:true});item.uploaded=uploaded;}
    if(disposed)return;status.textContent='Сохраняем черновик…';
    const result=await saveDraft({title:title.value.trim(),text:text.value,format:format.value,platformIds:selected(),mediaUrls:media.map(item=>item.uploaded.url),mediaSha256:media.length===1&&typeof media[0].uploaded.sha256==='string'?media[0].uploaded.sha256:'',scheduledAt,timezone:zoneInput.value.trim(),...(Number.isSafeInteger(context.profileRevision)&&context.profileRevision>0?{profileRevision:context.profileRevision}:{}),dayKey:dayInput.value,origin},{signal:controller.signal});
    if(disposed)return;if(!result||!Number.isSafeInteger(result.id)||result.id<1||result.status!=='draft')throw Object.assign(Error('SAVE_RESPONSE_INVALID'),{unknown:true});
    dirty=false;unknown=true;saved=true;status.textContent='Черновик сохранён. На площадки материал не отправлялся.';save.textContent='Сохранено';try{onSaved(result);}catch{status.textContent='Черновик сохранён. Закройте форму, чтобы вернуться к материалам.';}
   }catch(err){if(disposed)return;if(err?.unknown||err?.definitive!==true||['SAVE_OUTCOME_UNKNOWN','UNKNOWN_OUTCOME'].includes(err?.code)){unknown=true;error('Не удалось подтвердить результат. Данные и файлы остаются в форме. Повторная отправка заблокирована, чтобы не создать дубль.');status.textContent='Требуется проверка результата сохранения.';}else{error(ERROR_TEXT[err?.code]||'Не удалось сохранить черновик. Введённые данные и загруженные файлы остаются в форме.');status.textContent='Черновик не подтверждён.';}}
   finally{controllers.delete(controller);if(!disposed){setBusy(false);if(unknown){for(const control of form.querySelectorAll('input,select,textarea,.palitra-composer-remove'))control.disabled=true;}}}
  });
  syncAccept();loadContext();(w.queueMicrotask||((fn)=>Promise.resolve().then(fn)))(()=>{if(!disposed&&element.isConnected)title.focus();});
  return Object.freeze({element,dispose});
 }
 return Object.freeze({create,toUTC,localTime});
});
