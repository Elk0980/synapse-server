'use strict';
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else Object.defineProperty(root,'PalitraPublicationComposer',{value:api,writable:false});})(typeof globalThis==='undefined'?window:globalThis,()=>{
 const IMAGE_TYPES=new Set(['image/jpeg','image/png','image/webp']);
 const VIDEO_TYPES=new Set(['video/mp4','video/webm']);
 const FORMATS=new Set(['post','story','reel','carousel']);
 const KNOWN=['telegram','vk','youtube_shorts','instagram','tiktok','max'];
 const TIKTOK_PRIVACY=[['','Выберите аудиторию'],['PUBLIC_TO_EVERYONE','Публично для всех'],['MUTUAL_FOLLOW_FRIENDS','Взаимные подписчики'],['FOLLOWER_OF_CREATOR','Подписчики'],['SELF_ONLY','Только для себя']];
 /* 02.11.2026 · spec 049: все параметры Onlypult для наших площадок (SDK 0.1.9, openapi.yaml).
    Каждая отмеченная площадка получает свой блок; необязательное свёрнуто в «Дополнительно»
    и снабжено подсказкой. Пустое значение не отправляется — решает настройка аккаунта.
    Наборы по умолчанию задаются для компании и подставляются только в новую публикацию. */
 const TRI_ACCOUNT=[['','Как в настройках аккаунта'],['false','Разрешить'],['true','Запретить']];
 const DELETE_UNITS=[['','Не удалять'],['minutes','минут'],['hours','часов'],['days','дней'],['weeks','недель']];
 const POLL_FIELDS=[
  {key:'poll_question',type:'text',max:300,label:'Опрос: вопрос',hint:'Оставьте пустым, если опрос не нужен. До 300 символов.'},
  {key:'poll_options',type:'lines',label:'Опрос: варианты ответа',hint:'Каждый вариант с новой строки, от 2 до 10, каждый до 100 символов.'},
  {key:'poll_multiple',type:'select',label:'Опрос: сколько ответов',values:[['','Один ответ'],['true','Можно выбрать несколько']],bool:true},
  {key:'poll_anonymous',type:'select',label:'Опрос: кто голосовал',values:[['','Анонимно (обычно)'],['false','Видно, кто голосовал']],bool:true}];
 const DELETE_FIELD={key:'delete_after',type:'delete',label:'Автоудаление',hint:'Публикация сама удалится с площадки через указанное время после выхода. Например, для акции на 3 дня.'};
 const PLATFORM_OPTION_UI={
  telegram:{title:'Telegram',fields:[
   {key:'pin_message',type:'select',label:'Закрепить пост',values:[['','Не закреплять'],['true','Закрепить вверху канала']],bool:true,hint:'Пост закрепится сразу после выхода; прежнее закрепление Telegram заменит.'},
   {key:'show_caption_above_media',type:'select',label:'Где текст',values:[['','Под фото или видео (обычно)'],['true','Над фото или видео']],bool:true,hint:'Как Telegram покажет текст относительно вложения.'},
   ...POLL_FIELDS,DELETE_FIELD]},
  vk:{title:'ВКонтакте',fields:[
   {key:'disable_comment',type:'select',label:'Комментарии',values:TRI_ACCOUNT,bool:true,hint:'«Запретить» закроет комментарии под этой записью.'},
   {key:'attachments_mode',type:'select',label:'Как показать несколько фото',values:[['','Лента — листаются по одному (обычно)'],['grid','Сетка — видны сразу все']],hint:'Влияет только на запись с несколькими фото.'},
   ...POLL_FIELDS,DELETE_FIELD]},
  instagram:{title:'Instagram',fields:[
   {key:'disable_comment',type:'select',label:'Комментарии',values:TRI_ACCOUNT,bool:true,hint:'«Запретить» закроет комментарии под публикацией.'},
   {key:'first_comment',type:'textarea',max:2200,label:'Первый комментарий',hint:'Появится от имени аккаунта сразу после публикации: хештеги, ссылка «в профиле», вопрос к подписчикам.'},
   {key:'graduation_strategy',type:'select',label:'Пробный Reels',values:[['','Обычный Reels'],['SS_PERFORMANCE','Пробный: станет обычным сам, если хорошо зайдёт'],['MANUAL','Пробный: перевести в обычный вручную в Instagram']],hint:'Пробный Reels сначала видят только те, кто не подписан. Только для формата «Ролик».',reelOnly:true},
   DELETE_FIELD]},
  tiktok:{title:'TikTok',fields:[
   {key:'disable_comment',type:'select',name:'tiktok-disable_comment',label:'Комментарии',values:[['','Как разрешено в аккаунте'],['false','Разрешить'],['true','Запретить']],bool:true},
   {key:'disable_duet',type:'select',name:'tiktok-disable_duet',label:'Дуэты',values:[['','Как разрешено в аккаунте'],['false','Разрешить'],['true','Запретить']],bool:true,hint:'Дуэт — чужое видео рядом с вашим на одном экране.'},
   {key:'disable_stitch',type:'select',name:'tiktok-disable_stitch',label:'Сшивание',values:[['','Как разрешено в аккаунте'],['false','Разрешить'],['true','Запретить']],bool:true,hint:'Сшивание — другой автор вставляет фрагмент вашего видео в своё.'},
   DELETE_FIELD]},
  youtube_shorts:{title:'YouTube Shorts',fields:[
   {key:'privacy',type:'select',label:'Доступ к видео',values:[['','Открытое — видят все (обычно)'],['unlisted','По ссылке — только у кого есть ссылка'],['private','Закрытое — только владелец канала']],hint:'Открытое Shorts попадает в ленту; по ссылке — не ищется и не показывается в ленте.'},
   DELETE_FIELD]},
  max:{title:'MAX',fields:[
   {key:'pin_message',type:'select',label:'Закрепить пост',values:[['','Не закреплять'],['true','Закрепить']],bool:true},
   DELETE_FIELD]},
 };
 const COMPANY_OPTION_PRESETS=Object.freeze({
  // Палитра: TikTok публикуется для всех; остальное — как в настройках площадок. Меняется в каждой публикации.
  'palitra-love':{tiktok:{privacy:'PUBLIC_TO_EVERYONE'}},
 });
 function platformSettings(d,prefix,initial={},preset={}){
  const element=d.createElement('div');element.className='palitra-composer-options';
  const groups=new Map(),controls=new Map();let privacy=null;
  const node=(tag,cls,text)=>{const n=d.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  function hintOf(text){return text?node('p','palitra-composer-hint',text):null;}
  function select(name,values,value){const control=d.createElement('select');control.className='palitra-composer-input';control.name=name;control.id=prefix+'-'+name;for(const[key,text]of values){const option=d.createElement('option');option.value=key;option.textContent=text;control.append(option);}control.value=values.some(([key])=>key===value)?value:'';return control;}
  function fieldOf(platform,spec,saved,start){
   const wrap=node('label','palitra-composer-label');wrap.append(node('span','palitra-composer-label-text',spec.label));
   let control,value=Object.hasOwn(saved,spec.key)?saved[spec.key]:start[spec.key];
   const name=spec.name||platform+'-'+spec.key;
   if(spec.type==='select'){const text=value===undefined?'':String(value);const values=spec.values.some(([key])=>key===text)?spec.values:[...spec.values,[text,'Сохранённое значение: '+text]];control=select(name,values,text);}
   else if(spec.type==='text'){control=node('input','palitra-composer-input');control.type='text';control.name=name;control.maxLength=spec.max;control.value=typeof value==='string'?value:'';}
   else if(spec.type==='textarea'||spec.type==='lines'){control=node('textarea','palitra-composer-input palitra-composer-caption');control.name=name;control.rows=3;if(spec.max)control.maxLength=spec.max;control.value=Array.isArray(value)?value.join('\n'):typeof value==='string'?value:'';}
   else if(spec.type==='delete'){
    const row=node('span','palitra-composer-delete-row');const amount=node('input','palitra-composer-input');amount.type='number';amount.min='1';amount.max='999';amount.step='1';amount.inputMode='numeric';amount.name=platform+'-delete_after_value';amount.placeholder='Через';
    const storedValue=Object.hasOwn(saved,'delete_after_value')?saved.delete_after_value:start.delete_after_value,storedUnit=Object.hasOwn(saved,'delete_after_unit')?saved.delete_after_unit:start.delete_after_unit;
    if(Number.isSafeInteger(storedValue))amount.value=String(storedValue);const unit=select(platform+'-delete_after_unit',DELETE_UNITS,storedUnit||'');row.append(amount,unit);wrap.append(row);
    controls.set(platform+'.delete_after',{spec,amount,unit});const h=hintOf(spec.hint);if(h)wrap.append(h);return wrap;}
   control.id=prefix+'-'+name;wrap.append(control);const h=hintOf(spec.hint);if(h)wrap.append(h);controls.set(platform+'.'+spec.key,{spec,control});return wrap;
  }
  for(const[platform,ui]of Object.entries(PLATFORM_OPTION_UI)){
   const saved=initial[platform]||{},start=Object.keys(initial).length?{}:(preset[platform]||{});
   const group=d.createElement('fieldset');group.className='palitra-composer-field palitra-composer-platform-options';group.dataset.platform=platform;group.hidden=true;
   group.append(node('legend','',ui.title+' — параметры публикации'));
   if(platform==='tiktok'){
    const stored=Object.hasOwn(saved,'privacy')?saved.privacy:(start.privacy||''),choices=TIKTOK_PRIVACY.some(([key])=>key===stored)?TIKTOK_PRIVACY:[...TIKTOK_PRIVACY,[stored,'Сохранённый режим: '+stored]];
    const wrap=node('label','palitra-composer-label');wrap.append(node('span','palitra-composer-label-text','Кто увидит видео'));privacy=select('tiktokPrivacy',choices,stored);wrap.append(privacy);
    if(start.privacy&&!Object.hasOwn(saved,'privacy'))wrap.append(hintOf('Подставлено по умолчанию для компании. Можно изменить.'));
    group.append(wrap);
   }
   const more=d.createElement('details');more.className='palitra-composer-more';const summary=node('summary','','Дополнительно');const count=node('span','palitra-composer-more-count');summary.append(count);more.append(summary);
   for(const spec of ui.fields)more.append(fieldOf(platform,spec,saved,start));
   group.append(more);
   if(platform==='tiktok')group.append(hintOf('Режим сохраняется вместе с материалом и согласуется заново после изменения. Onlypult проверит его доступность для аккаунта; другой режим автоматически не выбирается.'));
   groups.set(platform,{group,count,more});element.append(group);
  }
  function valueOf(platform,spec){
   const record=controls.get(platform+'.'+(spec.type==='delete'?'delete_after':spec.key));
   if(spec.type==='delete'){const amount=record.amount.value.trim();return {amount,unit:record.unit.value};}
   const raw=record.control.value;
   if(spec.type==='select')return raw===''?undefined:spec.bool?raw==='true':raw;
   if(spec.type==='lines'){const lines=raw.split('\n').map(line=>line.trim()).filter(Boolean);return lines.length?lines:undefined;}
   const text=raw.trim();return text?text:undefined;
  }
  function counts(){for(const[platform,{count}]of groups){const value=readPlatform(platform,'reel');const n=Object.keys(value).filter(key=>key!=='privacy'&&key!=='delete_after_unit').length;count.textContent=n?' · настроено: '+n:'';}}
  function readPlatform(platform,format){
   const out={};
   for(const spec of PLATFORM_OPTION_UI[platform].fields){
    if(spec.type==='delete'){const{amount,unit}=valueOf(platform,spec);if(amount&&unit){out.delete_after_value=Number(amount);out.delete_after_unit=unit;}else if(amount||unit){out.delete_after_value=amount?Number(amount):undefined;out.delete_after_unit=unit||undefined;}continue;}
    if(spec.reelOnly&&format!=='reel')continue;
    const value=valueOf(platform,spec);if(value!==undefined)out[spec.key]=value;
   }
   return out;
  }
  function read(ids,format,mapInstagram=false){
   const value=JSON.parse(JSON.stringify(initial));
   for(const platform of Object.keys(PLATFORM_OPTION_UI)){
    if(!ids.includes(platform))continue;
    const known=new Set(PLATFORM_OPTION_UI[platform].fields.flatMap(spec=>spec.type==='delete'?['delete_after_value','delete_after_unit']:[spec.key]));if(platform==='tiktok')known.add('privacy');
    // Порядок сохранённых ключей не меняется: неизменённый материал не должен выглядеть изменённым.
    const next={...(value[platform]||{})},fresh=readPlatform(platform,format);
    if(platform==='tiktok'){if(privacy.value)fresh.privacy=privacy.value;else delete fresh.privacy;}
    for(const key of known){if(fresh[key]===undefined)delete next[key];else next[key]=fresh[key];}
    if(Object.keys(next).length)value[platform]=next;else delete value[platform];
   }
   if(mapInstagram&&ids.includes('instagram'))value.instagram={...(value.instagram||{}),is_story:format==='story',is_reels:format==='reel'};
   if(value.instagram&&value.instagram.is_reels!==true)delete value.instagram.graduation_strategy;
   return value;
  }
  function problem(ids,format){
   for(const platform of Object.keys(PLATFORM_OPTION_UI)){
    if(!ids.includes(platform))continue;
    const title=PLATFORM_OPTION_UI[platform].title,v=readPlatform(platform,format),open=()=>{groups.get(platform).more.open=true;};
    const amount=controls.get(platform+'.delete_after');
    if(Object.hasOwn(v,'delete_after_value')||Object.hasOwn(v,'delete_after_unit')){
     if(!Number.isSafeInteger(v.delete_after_value)||v.delete_after_value<1||v.delete_after_value>999||!v.delete_after_unit){open();return [title+': для автоудаления укажите число от 1 до 999 и единицу времени.',v.delete_after_unit?amount.amount:amount.unit];}
    }
    if(Object.hasOwn(v,'poll_question')||Object.hasOwn(v,'poll_options')||Object.hasOwn(v,'poll_multiple')||Object.hasOwn(v,'poll_anonymous')){
     const q=controls.get(platform+'.poll_question').control,o=controls.get(platform+'.poll_options').control;
     if(!v.poll_question){open();return [title+': напишите вопрос опроса или очистите варианты.',q];}
     const lines=v.poll_options||[];if(lines.length<2||lines.length>10){open();return [title+': в опросе нужно от 2 до 10 вариантов, каждый с новой строки.',o];}
     if(lines.some(line=>line.length>100)){open();return [title+': вариант опроса длиннее 100 символов.',o];}
     if(new Set(lines).size!==lines.length){open();return [title+': варианты опроса повторяются.',o];}
    }
   }
   return null;
  }
  function sync(ids,restricted=false){for(const[platform,{group}]of groups)group.hidden=restricted||!ids.includes(platform);element.hidden=restricted||![...groups.keys()].some(platform=>ids.includes(platform));counts();}
  element.addEventListener('input',counts);element.addEventListener('change',counts);
  return{element,privacy,read,sync,problem};
 }
 const ERROR_TEXT={PROFILE_CHANGED:'Данные компании обновились. Закройте форму и откройте её снова, чтобы использовать актуальный часовой пояс и профиль.',ACCESS_DENIED:'Доступ к созданию материалов ограничен. Введённые данные остаются в форме.',AUTH_REQUIRED:'Сеанс завершён. Введённые данные остаются в форме.',FILE_TOO_LARGE:'Файл превышает допустимый размер.',MEDIA_UNSUPPORTED:'Формат файла не поддерживается.'};
 const PUBLICATION_ERRORS={CHANNEL_DISABLED:'Отправка на выбранную площадку выключена. Можно согласовать материал без отправки.',CHANNEL_NOT_CONNECTED:'Выбранная площадка не подключена.',WORKFLOW_MANUAL_MODE:'В настройках процесса выбран ручной выпуск. Автоматическая публикация пока недоступна.',NOT_READY:'Материал не готов к публикации. Проверьте текст, файлы и выбранные площадки.',PROFILE_CHANGED:'Данные компании обновились. Сверьте сохранённый материал перед согласованием.',REVISION_CONFLICT:'Материал уже изменён. Откройте сохранённую карточку и сверьте новую версию.',FORBIDDEN:'У вас нет права согласовывать публикации.',APPROVAL_REQUIRED:'Сначала требуется согласование текущей версии материала и связанного плана.'};
 const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
 const validZone=value=>{try{new Intl.DateTimeFormat('ru',{timeZone:value});return typeof value==='string'&&value.length>0;}catch{return false;}};
 function localTime(iso,zone){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(iso));const part=key=>parts.find(p=>p.type===key).value;return part('year')+'-'+part('month')+'-'+part('day')+'T'+part('hour')+':'+part('minute');}
 const SOON_MS=2*60*1000;
 function toUTC(local,zone){
  if(typeof local!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)||!day(local.slice(0,10))||!validZone(zone))throw Error('INVALID_DATE_TIME');
  const wall=Date.parse(local+':00Z');if(!Number.isFinite(wall))throw Error('INVALID_DATE_TIME');let time=wall;
  for(let i=0;i<5;i++)time+=wall-Date.parse(localTime(new Date(time).toISOString(),zone)+':00Z');
  const iso=new Date(time).toISOString();if(localTime(iso,zone)!==local)throw Error('INVALID_DATE_TIME');
  for(const offset of [-7200000,-3600000,-1800000,1800000,3600000,7200000])if(localTime(new Date(time+offset).toISOString(),zone)===local)throw Error('AMBIGUOUS_DATE_TIME');
  return iso;
 }
 function createEdit(options){
  const {document:d,window:w,initialMaterial:base,readContext,uploadAsset,saveChanges,onSaved=()=>{},onClose=()=>{}}=options;
  if(!d||!w||!base||!Number.isSafeInteger(base.id)||!Number.isSafeInteger(base.revision)||typeof readContext!=='function'||typeof uploadAsset!=='function'||typeof saveChanges!=='function')throw Error('EDIT_OPTIONS');
  const restricted=Boolean(base.planLink&&options.restrictedPlanMaterial===true),linkedPlatform=base.planLink?.platform,needsLinkedPlatform=restricted&&!(base.platformIds||[]).length;
  if(restricted&&(typeof linkedPlatform!=='string'||(base.platformIds||[]).some(id=>id!==linkedPlatform)))throw Error('PLAN_PLATFORM_MISMATCH');
  if(base.planLink&&!restricted||!['draft','cancelled','failed','needs_review'].includes(base.status)||base.deleted||base.archive?.archivedAt||(base.deliveries||[]).some(item=>['published','publishing','needs_review'].includes(item.status)))throw Error('EDIT_READ_ONLY');
  let disposed=false,busy=false,dirty=false,unknown=false,saved=false,context=null,media=[],previews=new Map();const controllers=new Set(),checks=new Map(),captionInputs=new Map(),initialCaptions={...(base.captions||{})};
  const previousFocus=d.activeElement,uid='pce-'+(w.crypto?.randomUUID?.()||Math.random().toString(36).slice(2));
  const baselineFormat=base.meta?.format||'post';
  const el=(tag,cls,text)=>{const node=d.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
  const button=(text,cls,fn)=>{const node=el('button',cls,text);node.type='button';if(fn)node.addEventListener('click',fn);return node;};
  const input=(type,name,value)=>{const node=el('input','palitra-composer-input');node.type=type;node.name=name;if(value!==undefined)node.value=value;return node;};
  const field=(label,node)=>{const wrap=el('div','palitra-composer-field'),labelNode=el('label','palitra-composer-label',label);node.id=uid+'-'+node.name;labelNode.htmlFor=node.id;wrap.append(labelNode,node);return wrap;};
  const element=el('div','palitra-composer-overlay');element.setAttribute('data-content-composer-dialog','');const panel=el('section','palitra-composer-panel');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby',uid+'-heading');panel.tabIndex=-1;
  const heading=el('h2','palitra-composer-heading',restricted?'Медиа и время':'Изменить материал');heading.id=uid+'-heading';const close=button('×','palitra-composer-close',requestClose);close.setAttribute('aria-label','Закрыть редактирование');const header=el('header','palitra-composer-header');header.append(heading,close);
  const form=el('form','palitra-composer-form');form.noValidate=true;const status=el('p','palitra-composer-status','Загружаем настройки…');status.setAttribute('role','status');status.setAttribute('aria-live','polite');const alert=el('p','palitra-composer-error');alert.setAttribute('role','alert');alert.hidden=true;
  const title=input('text','title',base.title||'');title.maxLength=200;const text=el('textarea','palitra-composer-input palitra-composer-text');text.name='text';text.value=base.text||'';text.rows=5;text.maxLength=20000;
  const platformGroup=el('fieldset','palitra-composer-platforms');platformGroup.append(el('legend','palitra-composer-label','Площадки'));const channelList=el('div','palitra-composer-channels');platformGroup.append(channelList);
  const linkedAck=input('checkbox','planPlatformAck');linkedAck.className='palitra-composer-checkbox';const linkedAckLabel=el('label','palitra-composer-channel-label');linkedAckLabel.append(linkedAck,el('span','','Подтверждаю площадку версии плана: '+(linkedPlatform||'')));linkedAckLabel.hidden=!needsLinkedPlatform;platformGroup.append(linkedAckLabel);
  const format=el('select','palitra-composer-input');format.name='format';for(const[value,label]of [['post','Пост'],['story','История'],['reel','Короткое видео'],['carousel','Карусель фотографий'],...(!FORMATS.has(baselineFormat)?[[baselineFormat,'Исходный формат: '+baselineFormat]]:[])]){const item=el('option','',label);item.value=value;format.append(item);}format.value=baselineFormat;
  const platformConfig=platformSettings(d,uid,base.platformOptions||{});
  const fileInput=input('file','media');fileInput.multiple=true;fileInput.accept='image/jpeg,image/png,image/webp,video/mp4,video/webm';const mediaList=el('ul','palitra-composer-media-list');
  const dated=input('checkbox','dated');dated.checked=Boolean(base.scheduledAt);dated.className='palitra-composer-checkbox';const datedLabel=el('label','palitra-composer-channel-label');datedLabel.append(dated,el('span','','Указать дату и время'));const dateInput=input('date','date'),timeInput=input('time','time','12:00'),zone=input('text','timezone',base.timezone||'');zone.autocomplete='off';
  if(base.scheduledAt&&validZone(base.timezone)){const local=localTime(base.scheduledAt,base.timezone);dateInput.value=local.slice(0,10);timeInput.value=local.slice(11);}
  const dateRow=el('div','palitra-composer-date-row');dateRow.append(field('Дата',dateInput),field('Время',timeInput));
  const profileWrap=el('div','palitra-composer-discard');profileWrap.hidden=true;const profileAck=input('checkbox','profileAck');profileAck.className='palitra-composer-checkbox';const profileLabel=el('label','palitra-composer-channel-label');profileLabel.append(profileAck,el('span','','Проверил материал после обновления данных компании'));profileWrap.append(el('p','','Данные компании изменились. Сверьте текст, изображения и подписи перед сохранением.'),profileLabel);
  const save=button(restricted?'Сохранить медиа и время':'Сохранить изменения','palitra-composer-primary');save.type='submit';save.disabled=true;const cancel=button('Отмена','palitra-composer-secondary',requestClose);const footer=el('footer','palitra-composer-footer');footer.append(save,cancel);
  const discard=el('div','palitra-composer-discard');discard.hidden=true;discard.setAttribute('role','alert');const stay=button('Продолжить редактирование','palitra-composer-secondary',()=>{discard.hidden=true;cancel.focus();}),leave=button('Отменить изменения','palitra-composer-danger',finishClose);discard.append(el('p','','Отменить несохранённые изменения?'),stay,leave);
  if(restricted)form.append(el('p','palitra-composer-save-note','Текст, название, формат и подписи связаны с версией плана и здесь не меняются. Площадка фиксирована по плану; если она ещё не назначена, нужно её явно подтвердить. Можно подготовить файлы, дату и время; отправка не запускается.'));
  form.append(field('Название материала',title),field('Текст публикации',text),field('Формат',format),field('Добавить фотографии или видео',fileInput),el('p','palitra-composer-hint','JPEG/PNG/WebP — до 10 МБ; MP4/WebM — до 60 МБ. До 10 файлов. Существующие файлы повторно не загружаются.'),mediaList,datedLabel,dateRow,field('Часовой пояс',zone),platformGroup,platformConfig.element,profileWrap,alert,status,el('p','palitra-composer-save-note','Изменения сохранятся в этой же карточке. Отправка не запускается; согласование содержимого может потребоваться заново.'),footer,discard);panel.append(header,form);element.append(panel);
  const mime=url=>({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',mp4:'video/mp4',webm:'video/webm'})[/\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase()]||'';
  media=(base.mediaUrls||[]).map((url,index)=>({kind:'existing',url,type:mime(url),name:'Существующий файл '+(index+1),uploaded:{url}}));
  const selected=()=>[...(base.platformIds||[]).filter(id=>checks.get(id)?.checked),...[...checks].filter(([id,box])=>box.checked&&!(base.platformIds||[]).includes(id)).map(([id])=>id)];
  const markDirty=()=>{dirty=true;discard.hidden=true;};
  function showError(message,target){alert.textContent=message;alert.hidden=false;if(target){target.setAttribute('aria-invalid','true');target.focus();}}
  function sync(){dateInput.disabled=busy||unknown||!dated.checked;timeInput.disabled=busy||unknown||!dated.checked;platformConfig.sync(selected(),restricted);}
  function restrictFields(){if(!restricted)return;title.readOnly=true;text.readOnly=true;format.disabled=true;for(const box of checks.values())box.disabled=true;for(const control of captionInputs.values())control.readOnly=true;}
  function setBusy(value){busy=value;form.setAttribute('aria-busy',String(value));for(const node of form.querySelectorAll('input,textarea,select,button'))node.disabled=value||unknown;close.disabled=value;cancel.disabled=value;stay.disabled=value;leave.disabled=value;save.disabled=value||unknown||!context;sync();restrictFields();}
  function renderMedia(){mediaList.replaceChildren();media.forEach((item,index)=>{const row=el('li','palitra-composer-media-item'),name=el('span','',item.name+(item.kind==='existing'?' · сохранённый файл':' · '+(item.file.size/1048576).toLocaleString('ru',{maximumFractionDigits:1})+' МБ'));const remove=button('Удалить','palitra-composer-remove',()=>{if(busy||unknown)return;if(item.kind==='local')w.URL.revokeObjectURL(item.url);media.splice(index,1);markDirty();renderMedia();updatePreviews();});remove.setAttribute('aria-label','Удалить '+item.name);row.append(name,remove);mediaList.append(row);});}
  function previewProps(platform){return{document:d,window:w,platform,format:restricted?baselineFormat:format.value,title:restricted?base.title:title.value,text:restricted?(base.captions?.[platform]||base.text):(captionInputs.get(platform)?.value||text.value),publisherLabel:context?.publisherLabel||options.publisherLabel||'Компания',media:media.map(item=>({url:item.url,type:item.type,name:item.name}))};}
  function updatePreviews(){for(const[id,record]of previews){if(!record.detail.open)continue;const props=previewProps(id);if(record.api){try{record.api.update(props);}catch{record.host.textContent='Предпросмотр этого формата недоступен.';}continue;}const factory=options.previewFactory||w.PalitraPlatformPreview?.create;if(typeof factory!=='function'){record.host.textContent='Предпросмотр временно недоступен.';continue;}try{record.api=factory(props);record.host.replaceChildren(record.api.element);}catch{record.host.textContent='Предпросмотр этой площадки недоступен. Сохранённые данные не изменены.';}}}
  function requestClose(){if(busy)return;if(!saved&&(dirty||unknown)){discard.hidden=false;stay.focus();}else finishClose();}
  function finishClose(){if(disposed)return;dispose();onClose();}
  function dispose(){if(disposed)return;disposed=true;for(const controller of controllers)controller.abort();for(const record of previews.values())record.api?.dispose();for(const item of media)if(item.kind==='local')w.URL.revokeObjectURL(item.url);d.removeEventListener('keydown',keys,true);if(previousFocus?.isConnected)previousFocus.focus();}
  function keys(event){if(disposed||!element.isConnected)return;if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();requestClose();return;}if(event.key!=='Tab')return;const nodes=[...panel.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary')].filter(node=>!node.closest('[hidden]')&&!node.closest('details:not([open]) .palitra-composer-preview'));const first=nodes[0]||panel,last=nodes.at(-1)||panel;if(event.shiftKey&&(d.activeElement===first||!panel.contains(d.activeElement))){event.preventDefault();last.focus();}else if(!event.shiftKey&&(d.activeElement===last||!panel.contains(d.activeElement))){event.preventDefault();first.focus();}}
  d.addEventListener('keydown',keys,true);form.addEventListener('input',()=>{if(!busy&&!unknown){markDirty();updatePreviews();}});form.addEventListener('change',()=>{if(!busy&&!unknown){markDirty();sync();updatePreviews();}});
  fileInput.addEventListener('change',()=>{if(busy||unknown||disposed)return;const files=[...fileInput.files];fileInput.value='';if(media.length+files.length>10){showError('Можно прикрепить не более 10 файлов.',fileInput);return;}for(const file of files)if(!IMAGE_TYPES.has(file.type)&&!VIDEO_TYPES.has(file.type)||!file.size||file.size>(VIDEO_TYPES.has(file.type)?60:10)*1048576){showError('Проверьте тип и размер файлов.',fileInput);return;}const added=[];try{for(const file of files)added.push({kind:'local',file,url:w.URL.createObjectURL(file),type:file.type,name:file.name,uploaded:null});}catch{for(const item of added)w.URL.revokeObjectURL(item.url);showError('Не удалось открыть выбранные файлы. Сохранённые файлы не изменены.',fileInput);return;}media.push(...added);markDirty();renderMedia();updatePreviews();});
  async function load(){const controller=new w.AbortController();controllers.add(controller);try{const value=await readContext({signal:controller.signal});if(disposed)return;if(!value||!Array.isArray(value.channels)||!validZone(value.timezone))throw Error('EDIT_CONTEXT');context=value;if(restricted)linkedAckLabel.lastElementChild.textContent='Подтверждаю площадку версии плана: '+(value.channels.find(channel=>channel.id===linkedPlatform)?.name||linkedPlatform);if(!zone.value)zone.value=value.timezone;const channels=restricted?value.channels.filter(channel=>channel.id===linkedPlatform):[...value.channels];if(restricted&&!channels.some(channel=>channel.id===linkedPlatform))channels.push({id:linkedPlatform,name:linkedPlatform,connected:false,enabled:false});for(const id of base.platformIds||[])if(!channels.some(row=>row.id===id))channels.push({id,name:id,connected:false,enabled:false});for(const channel of channels){if(!channel||typeof channel.id!=='string'||checks.has(channel.id))continue;const row=el('div','palitra-composer-channel'),label=el('label','palitra-composer-channel-label'),box=input('checkbox','platform-'+channel.id);box.className='palitra-composer-checkbox';box.checked=restricted?channel.id===linkedPlatform:(base.platformIds||[]).includes(channel.id);label.append(box,el('span','',channel.name||channel.id));checks.set(channel.id,box);const detail=el('details','palitra-composer-details'),summary=el('summary','','Предпросмотр и подпись'),host=el('div','palitra-composer-preview');const caption=el('textarea','palitra-composer-input palitra-composer-caption');caption.name='caption-'+channel.id;caption.rows=3;caption.maxLength=20000;caption.placeholder='Индивидуальная подпись; пусто — общий текст';caption.value=initialCaptions[channel.id]||'';captionInputs.set(channel.id,caption);const preview=el('div');host.append(field('Подпись площадки',caption),preview);detail.append(summary,host);previews.set(channel.id,{detail,host:preview,api:null});detail.addEventListener('toggle',()=>{if(detail.open)for(const record of previews.values())if(record.detail!==detail&&record.detail.open)record.detail.open=false;updatePreviews();});box.addEventListener('change',()=>{if(box.checked)for(const record of previews.values())if(record.detail!==detail&&record.detail.open)record.detail.open=false;detail.open=box.checked;updatePreviews();});row.append(label,detail);channelList.append(row);}const current=value.currentProfileRevision??value.profileRevision;profileWrap.hidden=!(Number.isSafeInteger(current)&&current>0&&current!==base.profileRevision);status.textContent='';save.disabled=false;updatePreviews();}catch(error){if(disposed||error?.name==='AbortError')return;showError('Не удалось загрузить настройки. Данные материала остаются в форме.');status.replaceChildren(button('Повторить загрузку','palitra-composer-secondary',()=>{status.textContent='Загружаем…';load();}));}finally{controllers.delete(controller);}}
  form.addEventListener('submit',async event=>{
   event.preventDefault();if(disposed||busy||unknown||!context)return;alert.hidden=true;
   if(!title.value.trim()){showError('Введите название материала.',title);return;}if(!restricted&&!selected().length){showError('Отметьте площадку.',checks.values().next().value);return;}if(needsLinkedPlatform&&!linkedAck.checked){showError('Подтвердите единственную площадку из связанной версии плана.',linkedAck);return;}
   if(!validZone(zone.value.trim())){showError('Проверьте часовой пояс.',zone);return;}
   let scheduledAt=null;if(dated.checked){try{scheduledAt=toUTC(dateInput.value+'T'+timeInput.value,zone.value.trim());}catch{showError('Проверьте выбранные дату и время.',dateInput);return;}}
   const currentProfile=context.currentProfileRevision??context.profileRevision;if(!profileWrap.hidden&&!profileAck.checked){showError('Подтвердите проверку после изменения данных компании.',profileAck);return;}
   if(!restricted){const issue=platformConfig.problem(selected(),format.value);if(issue){showError(issue[0],issue[1]);return;}}
   const draft=restricted?{scheduledAt,timezone:zone.value.trim()}:{title:title.value.trim(),text:text.value,format:format.value,platformIds:selected(),scheduledAt,timezone:zone.value.trim()};const patch={revision:base.revision};if(!restricted){const opts=platformConfig.read(selected(),format.value,format.value!==baselineFormat);if(JSON.stringify(opts)!==JSON.stringify(base.platformOptions||{}))patch.platformOptions=opts;}for(const[key,value]of Object.entries(draft)){const initial=key==='format'?baselineFormat:base[key];if(JSON.stringify(value)!==JSON.stringify(initial??(key==='scheduledAt'?null:'')))patch[key]=value;}if(needsLinkedPlatform&&linkedAck.checked)patch.platformIds=[linkedPlatform];
   if(!profileWrap.hidden&&profileAck.checked&&Number.isSafeInteger(currentProfile))patch.profileRevision=currentProfile;
   const captions={...initialCaptions};if(!restricted){for(const[id,control]of captionInputs)if(control.value!==(initialCaptions[id]||'')){if(control.value)captions[id]=control.value;else delete captions[id];}if(JSON.stringify(captions)!==JSON.stringify(initialCaptions))patch.captions=captions;}
   const initialUrls=base.mediaUrls||[],currentUrls=media.map(item=>item.uploaded?.url||item.url),mediaChanged=JSON.stringify(initialUrls)!==JSON.stringify(currentUrls);
   const effectiveFormat=restricted?baselineFormat:format.value;if(mediaChanged||effectiveFormat!==baselineFormat){const videos=media.filter(item=>VIDEO_TYPES.has(item.type)),images=media.filter(item=>IMAGE_TYPES.has(item.type));if(!FORMATS.has(effectiveFormat)||effectiveFormat==='reel'&&(media.length!==1||videos.length!==1)||effectiveFormat==='carousel'&&images.length!==media.length||effectiveFormat==='story'&&media.length>1||effectiveFormat==='post'&&videos.length&&(media.length!==1||videos.length!==1)){showError('Файлы не соответствуют выбранному формату. Для короткого видео выберите одно видео, для карусели — фотографии.',fileInput);return;}}
   if(!mediaChanged&&Object.keys(patch).length===1){status.textContent='Изменений нет.';return;}
   setBusy(true);status.textContent='Сохраняем изменения…';const controller=new w.AbortController();controllers.add(controller);
   try{for(const item of media){if(item.uploaded)continue;const uploaded=await uploadAsset(item.file,{signal:controller.signal});if(disposed)return;if(!uploaded||typeof uploaded.url!=='string')throw Object.assign(Error('UPLOAD_ACK'),{unknown:true});item.uploaded=uploaded;}if(mediaChanged){patch.mediaUrls=media.map(item=>item.uploaded.url);if(media.length===1&&media[0].kind==='local'&&media[0].uploaded.sha256)patch.mediaSha256=media[0].uploaded.sha256;}
    const result=await saveChanges(patch,{signal:controller.signal});if(disposed)return;if(!result||result.id!==base.id||!Number.isSafeInteger(result.revision)||result.revision<=base.revision)throw Object.assign(Error('EDIT_ACK'),{unknown:true});saved=true;dirty=false;unknown=true;status.textContent='Изменения сохранены в этой же карточке. Отправка не запущена.';save.textContent='Сохранено';onSaved(result);
   }catch(error){if(disposed)return;if(error?.unknown||error?.definitive!==true){unknown=true;showError('Результат изменения не подтверждён. Ввод сохранён, повторная запись заблокирована.');}else showError(({REVISION_CONFLICT:'Материал уже изменён. Ваш ввод сохранён — сначала сверьте новую версию.',PROFILE_CHANGED:'Данные компании обновились. Ваш ввод сохранён — сверьте материал и профиль.',POST_STATE:'Материал сейчас недоступен для правки.',PUBLICATION_REVIEW_REQUIRED:'Сначала требуется проверить результат отправки.'})[error.code]||'Изменения отклонены. Ввод и файлы остаются в форме.');status.textContent='Сохранение не подтверждено.';}
   finally{controllers.delete(controller);if(!disposed)setBusy(false);}
  });
  renderMedia();sync();restrictFields();load().then(()=>{sync();restrictFields();});(w.queueMicrotask||((fn)=>Promise.resolve().then(fn)))(()=>{if(!disposed&&element.isConnected)(restricted?fileInput:title).focus();});return Object.freeze({element,dispose});
 }
 function create(options){
  if(options?.mode==='edit')return createEdit(options);
  const {document:d,window:w,date,readContext,uploadAsset,saveDraft,onSaved=()=>{},onClose=()=>{}}=options;
  if(!d||!w||typeof readContext!=='function'||typeof uploadAsset!=='function'||typeof saveDraft!=='function')throw Error('COMPOSER_OPTIONS');
  let disposed=false,busy=false,dirty=false,unknown=false,saved=false,context=null,confirmedDraft=null,approvalError='',media=[],previews=new Map(),controllers=new Set();
  const previousFocus=d.activeElement,id='pc-'+(w.crypto?.randomUUID?.()||Math.random().toString(36).slice(2));
  const origin='palitra-app:'+(w.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));
  function h(tag,className,text){const el=d.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;}
  function button(text,className,handler){const el=h('button',className,text);el.type='button';if(handler)el.addEventListener('click',handler);return el;}
  function field(label,control,help){const wrap=h('div','palitra-composer-field');control.id=id+'-'+(control.name||Math.random().toString(36).slice(2));const labelEl=h('label','palitra-composer-label',label);labelEl.htmlFor=control.id;wrap.append(labelEl,control);if(help){const hint=h('p','palitra-composer-hint',help);hint.id=control.id+'-hint';control.setAttribute('aria-describedby',hint.id);wrap.append(hint);}return wrap;}
  function input(type,name){const el=h('input','palitra-composer-input');el.type=type;el.name=name;return el;}
  const element=h('div','palitra-composer-overlay');element.setAttribute('data-content-composer-dialog','');
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
  const dated=input('checkbox','dated');dated.checked=false;dated.className='palitra-composer-checkbox';const datedLabel=h('label','palitra-composer-channel-label');datedLabel.append(dated,h('span','','Указать дату и время'));const dayInput=input('date','date');if(day(date))dayInput.value=date;
  const timeInput=input('time','time');timeInput.value='12:00';
  const zoneInput=input('text','timezone');zoneInput.required=true;zoneInput.autocomplete='off';zoneInput.setAttribute('spellcheck','false');
  const dateRow=h('div','palitra-composer-date-row');dateRow.append(field('Дата',dayInput),field('Время',timeInput));
  const draftDateNote=h('p','palitra-composer-hint','Дата и время для черновика. Отправка пока не запланирована.');draftDateNote.id=id+'-date-draft-note';dayInput.setAttribute('aria-describedby',draftDateNote.id);timeInput.setAttribute('aria-describedby',draftDateNote.id);const draftDateGroup=h('div','palitra-composer-field');draftDateGroup.append(datedLabel,dateRow,draftDateNote);
  const text=h('textarea','palitra-composer-input palitra-composer-text');text.name='text';text.rows=5;text.maxLength=20000;text.placeholder='Текст публикации';
  const platformConfig=platformSettings(d,id,{},COMPANY_OPTION_PRESETS[options.companyCode]||{});
  // 02.11.2026: на виду только обязательное; всё необязательное — под одной кнопкой «Дополнительные настройки».
  const tiktokRequired=h('div','palitra-composer-field palitra-composer-required');tiktokRequired.hidden=true;{const wrap=platformConfig.privacy.closest('label');if(wrap)tiktokRequired.append(wrap);}
  for(const more of platformConfig.element.querySelectorAll('.palitra-composer-more'))more.open=true;
  const advanced=h('details','palitra-composer-advanced');const advancedSummary=h('summary','','Дополнительные настройки');advanced.append(advancedSummary,h('p','palitra-composer-hint','Формат, дата и время, часовой пояс и параметры площадок. Без даты публикация уйдёт как можно скорее.'));const publicationStatus=h('select','palitra-composer-input');publicationStatus.name='publicationStatus';
  const approvalAllowed=options.canApprove===true&&typeof options.performPostAction==='function';
  for(const[value,label]of [['draft','Черновик'],['reviewed','Согласовать без отправки'],['approved','Согласовать и запланировать']]){const option=h('option','',label);option.value=value;option.disabled=value!=='draft'&&!approvalAllowed;publicationStatus.append(option);}
  const publicationHint=h('p','palitra-composer-hint');publicationHint.setAttribute('aria-live','polite');
  const save=button('Сохранить черновик','palitra-composer-primary');save.type='submit';save.disabled=true;
  const cancel=button('Отмена','palitra-composer-secondary',()=>requestClose());
  const footer=h('footer','palitra-composer-footer');footer.append(save,cancel);
  const saveNote=h('p','palitra-composer-save-note','Материал сохранится как черновик. На площадки он пока не отправляется.');
  const discard=h('div','palitra-composer-discard');discard.hidden=true;discard.setAttribute('role','alert');
  const discardText=h('p','','Отменить изменения? Несохранённый материал будет удалён из этой формы.');
  const stay=button('Продолжить редактирование','palitra-composer-secondary',()=>{discard.hidden=true;cancel.focus();});
  const leave=button('Отменить изменения','palitra-composer-danger',()=>finishClose());discard.append(discardText,stay,leave);
  advanced.append(field('Формат',format),draftDateGroup,field('Часовой пояс',zoneInput,'По умолчанию — часовой пояс вашей компании.'),platformConfig.element);form.append(field('Название материала',title),field('Текст публикации',text),mediaFields,platforms,tiktokRequired,advanced,field('Публикация',publicationStatus),publicationHint,alert,status,saveNote,footer,discard);
  panel.append(header,intro,form);element.append(panel);
  const channelCheckboxes=new Map(),previewHosts=new Map();
  function error(message,target){alert.textContent=message;alert.hidden=false;if(target&&advanced.contains(target))advanced.open=true;if(target){target.setAttribute('aria-invalid','true');target.focus();}else alert.scrollIntoView?.({block:'nearest'});}
  function clearError(){alert.hidden=true;alert.textContent='';for(const control of form.querySelectorAll('[aria-invalid]'))control.removeAttribute('aria-invalid');}
  function selected(){return [...channelCheckboxes].filter(([,control])=>control.checked).map(([key])=>key);}
  function setBusy(value){busy=value;form.setAttribute('aria-busy',String(value));for(const control of form.querySelectorAll('input,select,textarea,button'))control.disabled=value;mediaKind.disabled=value||format.value==='reel'||format.value==='carousel';save.disabled=value||!context||unknown;close.disabled=value;syncPublication();if(confirmedDraft)for(const control of form.querySelectorAll('input,select,textarea,.palitra-composer-remove'))control.disabled=true;}
  function syncPublication(){if(confirmedDraft)return;const planned=publicationStatus.value==='approved',reviewed=publicationStatus.value==='reviewed';save.textContent=planned?'Согласовать и запланировать':reviewed?'Согласовать без отправки':'Сохранить черновик';saveNote.textContent=planned?'После сохранения согласованная версия будет поставлена на публикацию в указанное время. Это ещё не подтверждение публикации на площадках.':reviewed?'Будет согласована только эта версия. Отправка не запланируется.':'Материал сохранится как черновик. На площадки он пока не отправляется.';draftDateNote.textContent=planned?'Если дата не указана или время уже прошло, публикация уйдёт как можно скорее — примерно через 2 минуты после сохранения.':'Дата необязательна. Отправка пока не запланирована.';publicationHint.textContent=planned?'Проверьте макеты, текст, площадки и время перед согласованием.':reviewed?'Проверьте макеты, текст, аудиторию и выбранные площадки. Для отправки затем отдельно задайте будущее время.':approvalAllowed?'Черновик можно доработать и согласовать позже.':'Черновик можно сохранить. Согласование доступно сотруднику с правом согласовывать публикации.';dayInput.disabled=busy||unknown||!dated.checked;timeInput.disabled=busy||unknown||!dated.checked;platformConfig.sync(selected());tiktokRequired.hidden=!selected().includes('tiktok');}
  function markDirty(){dirty=true;discard.hidden=true;}
  function syncAccept(){const video=mediaKind.value==='video';fileInput.accept=video?'video/mp4,video/webm':'image/jpeg,image/png,image/webp';fileInput.multiple=format.value==='carousel'||(format.value==='post'&&!video);mediaHelp.textContent=video?'MP4 или WebM, до 60 МБ. Одно видео на материал.':format.value==='story'?'JPEG, PNG или WebP, до 10 МБ. Одна фотография для истории.':'JPEG, PNG или WebP, до 10 МБ каждый. До 10 фотографий для поста или карусели.';mediaKind.disabled=busy||format.value==='reel'||format.value==='carousel';}
  function previewProps(platform){return{document:d,window:w,platform,format:format.value,title:title.value,text:text.value,publisherLabel:context?.publisherLabel||'Палитра',media:media.map(item=>({url:item.url,type:item.file.type,name:item.file.name}))};}
  function updatePreviews(){for(const [platform,host]of previewHosts){const detail=host.parentElement;if(!detail.open)continue;const props=previewProps(platform);let current=previews.get(platform);if(current){try{current.update(props);}catch{host.replaceChildren(h('p','palitra-composer-hint','Не удалось обновить предпросмотр. Материал остаётся в форме.'));}continue;}const factory=options.previewFactory||w.PalitraPlatformPreview?.create;if(typeof factory!=='function'){host.replaceChildren(h('p','palitra-composer-hint','Предпросмотр временно недоступен. Файлы и текст остаются в форме.'));continue;}try{current=factory(props);if(!current||!current.element||typeof current.update!=='function'||typeof current.dispose!=='function')throw Error('PREVIEW_INTERFACE');previews.set(platform,current);host.replaceChildren(current.element);}catch{host.replaceChildren(h('p','palitra-composer-hint','Предпросмотр временно недоступен. Файлы и текст остаются в форме.'));}}}
  function renderMedia(){mediaList.replaceChildren();media.forEach((item,index)=>{const li=h('li','palitra-composer-media-item');const description=h('span','',item.file.name+' · '+(item.file.size/1048576).toLocaleString('ru-RU',{maximumFractionDigits:1})+' МБ');const remove=button('Удалить','palitra-composer-remove',()=>{if(busy||unknown)return;w.URL.revokeObjectURL(item.url);media.splice(index,1);markDirty();renderMedia();updatePreviews();});remove.disabled=busy||unknown;remove.setAttribute('aria-label','Удалить файл '+item.file.name);li.append(description,remove);mediaList.append(li);});}
  function requestClose(){if(busy)return;if(!saved&&(dirty||unknown)){discard.hidden=false;stay.focus();return;}finishClose();}
  function finishClose(){if(disposed)return;dispose();onClose();}
  function dispose(){if(disposed)return;disposed=true;for(const controller of controllers)controller.abort();controllers.clear();for(const preview of previews.values()){try{preview.dispose();}catch{}}previews.clear();for(const item of media)w.URL.revokeObjectURL(item.url);media=[];d.removeEventListener('keydown',onKeyDown,true);if(previousFocus?.isConnected)previousFocus.focus();}
  function onKeyDown(event){if(disposed||!element.isConnected)return;if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();requestClose();return;}if(event.key!=='Tab')return;const focusable=[...panel.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')].filter(el=>!el.closest('[hidden]')&&!el.closest('details:not([open]) .palitra-composer-preview'));const first=focusable[0]||panel,last=focusable[focusable.length-1]||panel;if(event.shiftKey&&(d.activeElement===first||!panel.contains(d.activeElement))){event.preventDefault();last.focus();}else if(!event.shiftKey&&(d.activeElement===last||!panel.contains(d.activeElement))){event.preventDefault();first.focus();}}
  d.addEventListener('keydown',onKeyDown,true);
  form.addEventListener('input',event=>{if(busy||unknown)return;markDirty();if(event.target!==fileInput)updatePreviews();});
  form.addEventListener('change',event=>{if(busy||unknown||confirmedDraft)return;markDirty();if(event.target===format){if(format.value==='reel')mediaKind.value='video';if(format.value==='carousel')mediaKind.value='photo';syncAccept();}if(event.target===mediaKind)syncAccept();syncPublication();updatePreviews();});
  fileInput.addEventListener('change',()=>{
   if(disposed||busy||unknown)return;clearError();const files=[...fileInput.files];fileInput.value='';if(!files.length)return;
   const allowed=mediaKind.value==='video'?VIDEO_TYPES:IMAGE_TYPES;const maxCount=mediaKind.value==='video'||format.value==='story'?1:10;
   if(media.length+files.length>maxCount){error('Для этого формата можно добавить '+(maxCount===1?'один файл.':'до 10 файлов.'),fileInput);return;}
   for(const file of files){if(!allowed.has(file.type)){error('Выберите '+(mediaKind.value==='video'?'видео MP4 или WebM.':'фото JPEG, PNG или WebP.'),fileInput);return;}if(!file.size||file.size>(VIDEO_TYPES.has(file.type)?60:10)*1048576){error('Файл «'+file.name+'» должен быть не пустым и не больше '+(VIDEO_TYPES.has(file.type)?60:10)+' МБ.',fileInput);return;}}
   const added=[];try{for(const file of files)added.push({file,url:w.URL.createObjectURL(file),uploaded:null});}catch{for(const item of added)w.URL.revokeObjectURL(item.url);error('Не удалось открыть выбранные файлы. Попробуйте выбрать их снова.',fileInput);return;}
   media.push(...added);markDirty();renderMedia();updatePreviews();
  });
  async function loadContext(){if(disposed)return;const controller=new w.AbortController();controllers.add(controller);save.disabled=true;status.textContent='Загружаем площадки и настройки компании…';try{const value=await readContext({signal:controller.signal});if(disposed)return;if(!value||!Array.isArray(value.channels)||!validZone(value.timezone)||(value.profileRevision!==null&&(!Number.isSafeInteger(value.profileRevision)||value.profileRevision<1)))throw Error('COMPOSER_CONTEXT_INVALID');const channels=value.channels.filter(channel=>channel&&KNOWN.includes(channel.id)&&typeof channel.name==='string');if(!channels.length)throw Error('COMPOSER_CONTEXT_INVALID');if(new Set(channels.map(channel=>channel.id)).size!==channels.length)throw Error('COMPOSER_CONTEXT_INVALID');context=value;if(!zoneInput.value)zoneInput.value=value.timezone;if(!dayInput.value)dayInput.value=localTime(new Date().toISOString(),value.timezone).slice(0,10);channelList.replaceChildren();for(const channel of channels){const row=h('div','palitra-composer-channel');const label=h('label','palitra-composer-channel-label');const checkbox=input('checkbox','platform-'+channel.id);checkbox.value=channel.id;checkbox.id=id+'-platform-'+channel.id;checkbox.className='palitra-composer-checkbox';label.htmlFor=checkbox.id;label.append(checkbox,h('span','',channel.name));const detail=h('details','palitra-composer-details');const summary=h('summary','','Предпросмотр');summary.setAttribute('aria-label','Предпросмотр: '+channel.name);const host=h('div','palitra-composer-preview');detail.append(summary,host);detail.addEventListener('toggle',()=>{if(disposed)return;if(detail.open)for(const other of previewHosts.values()){const d=other.parentElement;if(d!==detail&&d.open)d.open=false;}updatePreviews();});previewHosts.set(channel.id,host);channelCheckboxes.set(channel.id,checkbox);checkbox.addEventListener('change',()=>{if(checkbox.checked)for(const other of previewHosts.values()){const d=other.parentElement;if(d!==detail&&d.open)d.open=false;}detail.open=checkbox.checked;updatePreviews();});row.append(label,detail);if(!channel.connected||!channel.enabled)row.append(h('p','palitra-composer-channel-note',channel.connected?'Доступ подтверждён. Отправка выключена; материал можно согласовать без отправки.':'Площадка не подключена. Черновик сохранить можно.'));channelList.append(row);}status.textContent='';save.disabled=unknown||busy;}
   catch(err){if(disposed||err?.name==='AbortError')return;status.textContent='Не удалось загрузить площадки и настройки. Введённые данные сохранены в форме.';const retry=button('Повторить загрузку','palitra-composer-secondary',()=>{retry.remove();loadContext();});status.append(d.createTextNode(' '),retry);}finally{controllers.delete(controller);}}
  form.addEventListener('submit',async event=>{
   event.preventDefault();if(disposed||busy||unknown||!context)return;if(confirmedDraft){onSaved(confirmedDraft,{approvalError});return;}clearError();
   // Видео в формате «Пост» уходит в Instagram как Reels: другого способа опубликовать там видео нет.
   if(mediaKind.value==='video'&&format.value==='post')format.value='reel';
   const scheduleRequested=publicationStatus.value==='approved',approveRequested=scheduleRequested||publicationStatus.value==='reviewed';if(!['draft','reviewed','approved'].includes(publicationStatus.value)||approveRequested&&!approvalAllowed){error('У вас нет права согласовывать публикации.',publicationStatus);return;}
   if(!title.value.trim()){error('Введите название материала.',title);return;}if(!selected().length){error('Отметьте хотя бы одну площадку.',channelCheckboxes.values().next().value);return;}
   if(!FORMATS.has(format.value)){error('Выберите формат.',format);return;}
   {const issue=platformConfig.problem(selected(),format.value);if(issue){error(issue[0],issue[1]);return;}}
   // 02.11.2026: Telegram принимает подпись к фото или видео только до 1024 знаков — говорим об этом до отправки.
   if(scheduleRequested&&selected().includes('telegram')&&media.length&&text.value.length>1024){error(`Telegram: подпись к фото или видео — до 1024 знаков, сейчас ${text.value.length}. Сократите текст или снимите отметку Telegram.`,text);return;}
   if(!validZone(zoneInput.value.trim())){error('Укажите корректный часовой пояс, например Europe/Moscow.',zoneInput);return;}
   let scheduledAt=null;try{if(dated.checked)scheduledAt=toUTC(dayInput.value+'T'+timeInput.value,zoneInput.value.trim());}catch(err){error(err.message==='AMBIGUOUS_DATE_TIME'?'Это время встречается дважды при переводе часов. Выберите другое время.':'Проверьте дату и время: выбранного времени может не быть из-за перевода часов.',dayInput);return;}
   // 02.11.2026: прошедшее, слишком близкое или не указанное время не мешает публикации —
   // перед самым сохранением оно сдвигается на ближайшее допустимое (через 2 минуты).
   let shiftedSoon=false;
   if(scheduleRequested){const missing=selected().filter(id=>!context.channels.some(c=>c.id===id&&c.connected===true)),off=selected().filter(id=>context.channels.some(c=>c.id===id&&c.connected===true&&c.enabled!==true)),names=ids=>ids.map(id=>context.channels.find(c=>c.id===id)?.name||id).join(', ');if(missing.length||off.length){error([missing.length?'Подключите площадки: '+names(missing)+'.':'',off.length?'Отправка выключена: '+names(off)+'.':'','Можно согласовать материал без отправки.'].filter(Boolean).join(' '),publicationStatus);return;}}if(approveRequested){if(selected().includes('tiktok')&&!platformConfig.privacy.value){error('Выберите, кто увидит видео TikTok.',platformConfig.privacy);return;}if(!text.value.trim()&&!(format.value==='story'&&selected().length===1&&selected()[0]==='instagram'&&media.length)){error('Добавьте текст публикации перед согласованием.',text);return;}}
   if(!media.length&&(format.value!=='post'||!text.value.trim())){error('Добавьте '+(format.value==='reel'?'видео.':'фотографию или видео. Для текстового поста заполните текст.'),fileInput);return;}
   const video=mediaKind.value==='video',maxCount=video||format.value==='story'?1:10;
   if(media.length>maxCount||media.some(item=>!(video?VIDEO_TYPES:IMAGE_TYPES).has(item.file.type))){error('Прикреплённые файлы не соответствуют выбранному формату. Удалите лишние или измените формат.',fileInput);return;}
   if(approveRequested&&selected().includes('tiktok')&&(media.length!==1||!VIDEO_TYPES.has(media[0].file.type))){error('Для TikTok нужно одно видео.',fileInput);return;}
   setBusy(true);status.textContent=media.length?'Загружаем файлы…':'Сохраняем черновик…';const controller=new w.AbortController();controllers.add(controller);
   try{
    for(const item of media){if(item.uploaded)continue;const uploaded=await uploadAsset(item.file,{signal:controller.signal});if(disposed)return;if(!uploaded||typeof uploaded.url!=='string'||!/^https:\/\//.test(uploaded.url))throw Object.assign(Error('ASSET_RESPONSE_INVALID'),{unknown:true});item.uploaded=uploaded;}
    if(disposed)return;status.textContent='Сохраняем черновик…';
    if(scheduleRequested){const soon=Date.now()+SOON_MS;if(!scheduledAt||Date.parse(scheduledAt)<soon){scheduledAt=new Date(Math.ceil(soon/60000)*60000).toISOString();shiftedSoon=true;}}
    const result=await saveDraft({title:title.value.trim(),text:text.value,format:format.value,platformIds:selected(),platformOptions:platformConfig.read(selected(),format.value,true),mediaUrls:media.map(item=>item.uploaded.url),mediaSha256:media.length===1&&typeof media[0].uploaded.sha256==='string'?media[0].uploaded.sha256:'',scheduledAt,timezone:zoneInput.value.trim(),...(Number.isSafeInteger(context.profileRevision)&&context.profileRevision>0?{profileRevision:context.profileRevision}:{}),origin},{signal:controller.signal});
    if(disposed)return;if(!result||!Number.isSafeInteger(result.id)||result.id<1||result.status!=='draft')throw Object.assign(Error('SAVE_RESPONSE_INVALID'),{unknown:true});
    confirmedDraft=result;saved=true;dirty=false;
    if(approveRequested){status.textContent='Черновик №'+result.id+' сохранён. Согласовываем'+(scheduleRequested?' и ставим в расписание':' без отправки')+'…';const planned=await options.performPostAction(result.id,'approve',{revision:result.revision,approved:true,...(scheduleRequested?{schedule:true}:{})},{signal:controller.signal});if(disposed)return;if(!planned||planned.id!==result.id||!Number.isSafeInteger(planned.revision)||planned.revision<=result.revision||(scheduleRequested?!['scheduled','publishing','published'].includes(planned.status):planned.status!=='draft')||planned.approval?.approved!==true)throw Object.assign(Error('SCHEDULE_RESPONSE_INVALID'),{unknown:true});unknown=true;status.textContent=scheduleRequested?'Согласовано. Публикация поставлена в расписание'+(shiftedSoon?': уйдёт как можно скорее, в '+localTime(scheduledAt,zoneInput.value.trim()).slice(11)+'.':'.'):'Согласовано без отправки. Материал не поставлен в расписание.';save.textContent=scheduleRequested?'В расписании':'Согласовано';try{onSaved(planned);}catch{status.textContent='Согласование и расписание сохранены. Закройте форму, чтобы вернуться к материалам.';}return;}
    dirty=false;unknown=true;saved=true;status.textContent='Черновик сохранён. На площадки материал не отправлялся.';save.textContent='Сохранено';try{onSaved(result);}catch{status.textContent='Черновик сохранён. Закройте форму, чтобы вернуться к материалам.';}
   }catch(err){if(disposed)return;if(err?.unknown||err?.definitive!==true||['SAVE_OUTCOME_UNKNOWN','UNKNOWN_OUTCOME'].includes(err?.code)){unknown=true;error(confirmedDraft?'Материал №'+confirmedDraft.id+' сохранён, но результат согласования и постановки не подтверждён. Не создавайте его повторно; проверьте состояние этой карточки.':'Не удалось подтвердить результат. Данные и файлы остаются в форме. Повторная отправка заблокирована, чтобы не создать дубль.');status.textContent='Требуется проверка результата. Автоматический повтор отключён.';}else if(confirmedDraft){approvalError=PUBLICATION_ERRORS[err?.code]||err?.message||'Не удалось поставить материал в расписание.';error('Черновик №'+confirmedDraft.id+' сохранён. '+approvalError);status.textContent='Публикация не запланирована. Откройте сохранённый черновик, чтобы исправить причину.';save.textContent='Открыть сохранённый черновик';}else{error(ERROR_TEXT[err?.code]||'Не удалось сохранить черновик. Введённые данные и загруженные файлы остаются в форме.');status.textContent='Черновик не подтверждён.';}}
   finally{controllers.delete(controller);if(!disposed){setBusy(false);if(unknown){for(const control of form.querySelectorAll('input,select,textarea,.palitra-composer-remove'))control.disabled=true;}}}
  });
  syncAccept();syncPublication();loadContext();(w.queueMicrotask||((fn)=>Promise.resolve().then(fn)))(()=>{if(!disposed&&element.isConnected)title.focus();});
  return Object.freeze({element,dispose});
 }
 return Object.freeze({create,toUTC,localTime});
});
