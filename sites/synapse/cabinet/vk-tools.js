(() => {
  'use strict';
  const cabinet = window.SbCabinet = window.SbCabinet || {};
  const errorText = {
    SETTINGS_CHANGED:'Подключение изменилось. Обновите настройки и создайте новый предпросмотр.',
    GROUP_MISMATCH:'Доступ не соответствует выбранному сообществу.', TOKEN_TYPE_MISMATCH:'Тип ключа не подходит для выбранного подключения.',
    ACCESS_DENIED:'ВК не подтвердил необходимые права.', AUTH_FAILED:'ВК не принял ключ. Проверьте подключение.',
    NOT_CONNECTED:'Сначала проверьте подключение.', CONNECTION_MISSING:'Сначала сохраните подключение.', NOT_CONFIGURED:'Сначала сохраните подключение.',
    RATE_LIMITED:'ВК ограничил частоту запросов. Повторите позже.',
    PREVIEW_EXPIRED:'Предпросмотр устарел. Создайте новый.', STATE_CHANGED:'Сведения ВК изменились. Создайте новый предпросмотр.',
    IMAGE_INVALID:'Выберите подходящее изображение JPEG или PNG.', INVALID_IMAGE:'Выберите подходящее изображение JPEG или PNG.', IMAGE_TOO_LARGE:'Максимальный размер изображения — 8 МиБ.',
    REQUEST_CONFLICT:'Этот запрос уже зарегистрирован. Проверьте историю изменений.'
  };
  const statuses = {verified:'Проверено: изменение прочитано из ВК',applied_unverified:'ВК принял изменение; результат ещё не проверен',uncertain:'Результат не подтверждён',applying:'Операция зарегистрирована; результат ещё не получен',failed:'Изменение не выполнено'};
  cabinet.mountVkTools = (container, initial) => {
    let ctx=initial, companyCode='', epoch=0, busy=false, destroyed=false, settings={analytics:null,design:null}, preview=null, pending=null, image=null, observed=null;
    const owner=()=>ctx.identity?.role==='owner';
    const node=id=>container.querySelector('#vkt-'+id);
    const say=text=>{if(node('status'))node('status').textContent=text;};
    const request=(purpose,path,body,method='POST')=>ctx.apiJson('/content/crm/vk-tools/'+purpose+path+'?companyCode='+encodeURIComponent(companyCode),body===undefined?undefined:ctx.csrfOptions(method,body));
    const validate=(data,purpose,revision)=>{
      if(!data||data.companyCode!==companyCode||(data.purpose&&data.purpose!==purpose)||(revision!==undefined&&data.revision!==revision))throw Error('INVALID_SCOPE');
      if(revision!==undefined&&data.groupId!==undefined&&String(data.groupId)!==String(settings[purpose]?.groupId))throw Error('INVALID_GROUP');
      return data;
    };
    const dirty=purpose=>{const s=settings[purpose];return !s||node(purpose+'-group').value.trim()!==String(s.groupId||'')||node(purpose+'-type').value!==(s.tokenType||(purpose==='analytics'?'user':'group'))||node(purpose+'-enabled').checked!==(s.enabled!==false)||!!node(purpose+'-token').value;};
    const ready=purpose=>!!settings[purpose]?.connected&&settings[purpose]?.enabled!==false&&!dirty(purpose);
    const unresolved=()=>['uncertain','applying','applied_unverified'].includes(pending?.status);
    const controls=()=>{
      if(!node('status'))return;
      container.setAttribute('aria-busy',String(busy));
      container.querySelectorAll('button,input,textarea,select').forEach(el=>{el.disabled=busy||!owner();});
      for(const purpose of ['analytics','design']){
        node(purpose+'-save').disabled=busy||!owner()||!settings[purpose];
        node(purpose+'-check').disabled=busy||!owner()||!settings[purpose]?.configured||settings[purpose]?.enabled===false||dirty(purpose);
      }
      node('analytics-type').disabled=true;
      for(const id of ['state','description-preview','cover-preview'])node(id).disabled=busy||!owner()||!ready('design')||unresolved();
      node('state').disabled=busy||!owner()||!ready('design');
      node('description-preview').disabled ||= typeof observed?.description!=='string';
      node('cover-preview').disabled ||= !image||!observed?.cover;
      node('apply').disabled=busy||!owner()||!ready('design')||!preview||!!pending;
      node('history-refresh').disabled=busy||!owner()||!companyCode;
      container.querySelectorAll('[data-rollback]').forEach(el=>{el.disabled=busy||!owner()||!ready('design')||unresolved();});
    };
    const run=async(text,action)=>{
      if(busy||!owner()||destroyed)return;
      const generation=epoch;busy=true;say(text);controls();
      const current=()=>!destroyed&&generation===epoch&&owner();
      try{await action(current);}catch(error){if(current())say(unresolved()?'Результат не подтверждён. Обновите историю и проверьте ВК. Повторная отправка автоматически не выполняется.':errorText[error.code]||'Действие не выполнено. Проверьте подключение и обновите раздел.');}
      finally{if(current()){busy=false;controls();}}
    };
    const invalidate=()=>{preview=null;node('preview').replaceChildren();if(!unresolved())pending=null;controls();};
    const drawSetting=purpose=>{
      const s=settings[purpose];node(purpose+'-group').value=s?.groupId||'';node(purpose+'-type').value=s?.tokenType||(purpose==='analytics'?'user':'group');node(purpose+'-enabled').checked=s?.enabled!==false;
      node(purpose+'-connection').textContent=!s?'Настройки не получены':!s.configured?'Не настроено':s.enabled===false?'Подключение отключено':s.connected?(purpose==='design'?'Сообщество и тип ключа проверены; права на изменение проверяет ВК при операции':'Доступ к статистике проверен'):'Сохранено; требуется проверка';
      node(purpose+'-checked').textContent=s?.checkedAt?'Проверка: '+new Date(s.checkedAt).toLocaleString('ru-RU'):'Проверка ещё не выполнена';
      node(purpose+'-details').open=!s?.configured;
    };
    const paragraph=(parent,label,value)=>{const p=document.createElement('p'),strong=document.createElement('strong');strong.textContent=label+': ';p.append(strong,document.createTextNode(String(value??'—')));parent.append(p);};
    const drawPreview=data=>{
      const area=node('preview');area.replaceChildren();
      paragraph(area,'Сообщество',data.groupId);paragraph(area,'Действие',data.operation==='description'?'Изменить описание':'Загрузить статичную обложку');
      if(data.operation==='description'){paragraph(area,'До',data.before);paragraph(area,'После',data.after);}
      else{
        paragraph(area,'Изображение',`${data.after?.width||'?'} × ${data.after?.height||'?'} · ${data.after?.mime||''}`);
        paragraph(area,'Область обрезки',data.after?.crop?JSON.stringify(data.after.crop):'По параметрам предпросмотра сервера');
        if(image){const img=document.createElement('img');img.src='data:'+image.mime+';base64,'+image.base64;img.alt='Исходное изображение для статичной обложки';area.append(img);}
        paragraph(area,'Восстановление','Для возврата прежней обложки может понадобиться её исходный файл. Ссылка на прежнюю обложку сохраняется в истории.');
      }
      if(Array.isArray(data.warnings))data.warnings.forEach(w=>paragraph(area,'Примечание',w==='COVER_RESTORE_REQUIRES_ORIGINAL'?'Для восстановления прежней обложки нужен её исходный файл.':'Проверьте параметры изменения перед применением.'));
      paragraph(area,'Подтверждение','Нажатие «Применить в ВК» изменит выбранное сообщество. Публикации Onlypult не затрагиваются.');
    };
    const acceptPreview=data=>{preview=data;pending=null;drawPreview(data);say('Предпросмотр готов. Проверьте изменения перед применением.');};
    const drawHistory=data=>{
      const area=node('history');area.replaceChildren();
      if(!data.items?.length){paragraph(area,'История','Сохранённых операций пока нет');return;}
      for(const item of data.items){
        if(item.companyCode&&item.companyCode!==companyCode)throw Error('INVALID_SCOPE');
        const article=document.createElement('article');article.className='vkt-history-item';
        paragraph(article,'Операция',item.operation==='description'?'Описание':'Статичная обложка');paragraph(article,'Результат',statuses[item.status]||'Состояние неизвестно');paragraph(article,'Запрос',item.requestId);
        if(item.createdAt)paragraph(article,'Дата',new Date(item.createdAt).toLocaleString('ru-RU'));
        if(item.operation==='description'&&['verified','applied_unverified'].includes(item.status)&&item.requestId){const button=document.createElement('button');button.type='button';button.className='plain-button';button.dataset.rollback=item.requestId;button.textContent='Предпросмотр возврата описания';article.append(button);}
        area.append(article);
      }
      if(pending){const result=data.items?.find(item=>item.requestId===pending.requestId);if(result&&['verified','failed'].includes(result.status)){pending.status=result.status;preview=null;say(statuses[result.status]+'. Для нового изменения создайте новый предпросмотр.');}}
    };
    const panel=purpose=>`<section class="card vkt-connection"><h3>${purpose==='analytics'?'Статистика ВК':'Оформление сообщества'}</h3><p id="vkt-${purpose}-connection"></p><details id="vkt-${purpose}-details"><summary>Отдельное подключение ${purpose==='analytics'?'статистики':'оформления'}</summary><p>${purpose==='analytics'?'Для статистики требуется отдельная авторизация пользователя с доступом к статистике сообщества. Публикации продолжаются через Onlypult. Не получайте ключ через сторонние генераторы или консоль браузера.':'Для описания и статичной обложки подходит ключ сообщества с разрешениями на выбранные операции либо подтверждённая авторизация пользователя. Это подключение не включает переписку.'}</p><form id="vkt-${purpose}-form"><div class="vk-fields"><label>Числовой ID сообщества<input id="vkt-${purpose}-group" inputmode="numeric" pattern="[1-9][0-9]*" required autocomplete="off"></label><label>Тип доступа<select id="vkt-${purpose}-type"><option value="${purpose==='analytics'?'user':'group'}">${purpose==='analytics'?'Пользователь':'Сообщество'}</option>${purpose==='design'?'<option value="user">Пользователь</option>':''}</select></label><label>Ключ доступа<input id="vkt-${purpose}-token" type="password" autocomplete="new-password" spellcheck="false" placeholder="Пустое поле сохраняет прежний ключ"></label><label class="vkt-toggle"><input id="vkt-${purpose}-enabled" type="checkbox" checked>Включить это подключение</label></div><p class="vk-note">Вводите ключ лично только в защищённом кабинете. Не отправляйте его в чат. Сохранённый ключ не отображается; при смене сообщества или типа доступа нужен новый.</p><button type="submit" id="vkt-${purpose}-save" class="plain-button">Сохранить подключение</button></form></details><div class="vk-actions"><button type="button" id="vkt-${purpose}-check" class="plain-button">Проверить доступ</button><span id="vkt-${purpose}-checked"></span></div>${purpose==='analytics'?'<p><a href="#social-stats">Открыть статистику соцсетей →</a></p>':''}</section>`;
    container.classList.add('vk-tools');
    container.innerHTML=`<h3>Прямые инструменты ВК</h3><p>Оформление и статистика подключаются отдельно. Планирование и публикации остаются в Onlypult. Автоматический приём сообщений и автоответы здесь не включаются.</p><p id="vkt-status" role="status" aria-live="polite"></p><button type="button" id="vkt-refresh" class="plain-button">Обновить настройки инструментов</button><div class="vkt-connections">${panel('analytics')}${panel('design')}</div><section class="card vkt-editor"><h3>Предпросмотр оформления</h3><button type="button" id="vkt-state" class="plain-button">Прочитать текущее описание ВК</button><label>Новое описание сообщества<textarea id="vkt-description" maxlength="4000" rows="5"></textarea></label><button type="button" id="vkt-description-preview" class="plain-button">Предпросмотр описания</button><label>Файл статичной обложки (JPEG или PNG, до 8 МиБ)<input id="vkt-cover" type="file" accept="image/jpeg,image/png"></label><p id="vkt-file-info" class="vk-note"></p><button type="button" id="vkt-cover-preview" class="plain-button">Предпросмотр обложки</button><div id="vkt-preview" class="vkt-preview" aria-live="polite"></div><button type="button" id="vkt-apply" class="plain-button">Применить в ВК</button></section><section class="card"><div class="vk-actions"><h3>История оформления</h3><button type="button" id="vkt-history-refresh" class="plain-button">Обновить историю</button></div><div id="vkt-history"></div></section>`;
    const load=async code=>{
      companyCode=String(code||'');epoch++;busy=false;settings={analytics:null,design:null};preview=null;pending=null;image=null;observed=null;
      if(!owner()){container.querySelectorAll('input,textarea').forEach(el=>{el.value='';});container.replaceChildren();destroyed=true;return;}
      for(const purpose of ['analytics','design']){node(purpose+'-token').value='';drawSetting(purpose);}
      node('description').value='';node('cover').value='';node('file-info').textContent='';node('preview').replaceChildren();node('history').replaceChildren();node('current-state').replaceChildren();controls();
      if(!companyCode){say('Выберите компанию.');return;}
      await run('Загружаем отдельные подключения ВК…',async current=>{
        const responses=await Promise.allSettled(['analytics','design'].map(purpose=>request(purpose,'/settings')));if(!current())return;
        let failed=false;responses.forEach((response,index)=>{const purpose=['analytics','design'][index];if(response.status==='fulfilled'){try{settings[purpose]=validate(response.value,purpose);drawSetting(purpose);}catch(_){failed=true;}}else failed=true;});
        say(failed?'Часть настроек недоступна. Обновите раздел.':'Настройки загружены. Проверка доступа и изменения выполняются отдельными кнопками.');
      });
    };
    for(const purpose of ['analytics','design']){
      ['group','type','token','enabled'].forEach(field=>node(purpose+'-'+field).addEventListener(field==='enabled'||field==='type'?'change':'input',()=>{if(purpose==='design'){observed=null;invalidate();}controls();}));
      node(purpose+'-form').addEventListener('submit',event=>{
        event.preventDefault();if(busy||!owner()||!settings[purpose]||!node(purpose+'-form').reportValidity())return;
        const s=settings[purpose],groupId=node(purpose+'-group').value.trim(),tokenType=node(purpose+'-type').value,accessToken=node(purpose+'-token').value.trim();
        if((groupId!==String(s.groupId||'')||tokenType!==s.tokenType)&&!accessToken){say('Для нового сообщества или типа доступа нужен его ключ.');return;}
        const body={revision:s.revision,groupId,tokenType,enabled:node(purpose+'-enabled').checked,...(accessToken?{accessToken}:{})};
        node(purpose+'-token').value='';if(purpose==='design'){observed=null;invalidate();}
        void run('Сохраняем отдельное подключение…',async current=>{const data=await request(purpose,'/settings',body,'PUT');if(!current())return;settings[purpose]=validate(data,purpose);drawSetting(purpose);say('Подключение сохранено. Теперь отдельно проверьте доступ.');});
      });
      node(purpose+'-check').addEventListener('click',()=>{if(dirty(purpose))return;const revision=settings[purpose].revision;void run('Проверяем доступ без изменения сообщества…',async current=>{const data=await request(purpose,'/check',{revision});if(!current())return;settings[purpose]=validate(data,purpose,revision);drawSetting(purpose);say(data.connected?(purpose==='analytics'?'Доступ к статистике подтверждён.':'Тип ключа и чтение сообщества проверены; права на изменение ещё не проверены.'):errorText[data.errorCode]||'Доступ пока не подтверждён.');});});
    }
    node('description').addEventListener('input',invalidate);
    node('cover').addEventListener('change',()=>{
      image=null;invalidate();const file=node('cover').files?.[0];node('file-info').textContent='';if(!file)return;
      if(!['image/jpeg','image/png'].includes(file.type)||file.size>8*1024*1024||!file.size){say('Выберите JPEG или PNG размером до 8 МиБ.');node('cover').value='';return;}
      const generation=epoch,reader=new FileReader();reader.onload=()=>{if(generation!==epoch||!owner()||destroyed||node('cover').files?.[0]!==file)return;image={mime:file.type,base64:String(reader.result).split(',')[1]};node('file-info').textContent=file.name+' · '+Math.ceil(file.size/1024)+' КиБ';controls();};reader.onerror=()=>{if(generation===epoch&&!destroyed)say('Не удалось прочитать файл. Выберите его ещё раз.');};reader.readAsDataURL(file);
    });
    node('state').textContent='Прочитать текущие сведения ВК';
    const currentState=document.createElement('div');currentState.id='vkt-current-state';currentState.className='vkt-preview';node('state').after(currentState);
    node('state').addEventListener('click',()=>{if(!ready('design'))return;const revision=settings.design.revision;void run('Читаем сведения сообщества…',async current=>{const data=await request('design','/state');if(!current())return;validate(data,'design',revision);observed=data;currentState.replaceChildren();paragraph(currentState,'Текущее описание',typeof data.description==='string'?data.description:'Неизвестно — ВК не вернул поле');paragraph(currentState,'Текущая обложка',!data.cover?'Неизвестно — ВК не вернул поле':data.cover.enabled?'Установлена':'Не установлена');if(unresolved()){say('Сведения прочитаны. Результат предыдущей операции ещё не подтверждён; повторное применение заблокировано.');return;}invalidate();if(typeof data.description==='string')node('description').value=data.description;say(typeof data.description!=='string'||!data.cover?'Часть сведений ВК недоступна. Изменение неизвестного поля заблокировано.':'Текущие сведения получены. Подготовьте текст или выберите файл для предпросмотра.');});});
    const makePreview=operation=>{if(!ready('design')||unresolved()||(operation==='description'&&typeof observed?.description!=='string')||(operation==='cover'&&(!image||!observed?.cover)))return;const revision=settings.design.revision;invalidate();void run('Готовим предпросмотр без изменений ВК…',async current=>{const data=await request('design','/preview',{revision,operation,...(operation==='description'?{description:node('description').value}:{image})});if(!current())return;validate(data,'design',revision);if(!data.previewId||data.operation!==operation)throw Error('INVALID_PREVIEW');acceptPreview(data);});};
    node('description-preview').addEventListener('click',()=>makePreview('description'));node('cover-preview').addEventListener('click',()=>makePreview('cover'));
    node('apply').addEventListener('click',()=>{
      if(busy||!owner()||!ready('design')||!preview||pending)return;
      const body={revision:settings.design.revision,previewId:preview.previewId,requestId:crypto.randomUUID()};pending={...body,status:'uncertain'};
      void run('Применяем подтверждённое изменение…',async current=>{const data=await request('design','/apply',body);if(!current())return;validate(data,'design',body.revision);if(data.requestId!==body.requestId)throw Error('INVALID_REQUEST');pending.status=statuses[data.status]?data.status:'uncertain';say((statuses[pending.status]||statuses.uncertain)+'. Обновите историю перед следующим действием.');});
    });
    node('history-refresh').addEventListener('click',()=>void run('Читаем журнал изменений…',async current=>{const data=await request('design','/history');if(!current())return;validate(data,'design');drawHistory(data);if(!pending)say('История обновлена.');}));
    node('history').addEventListener('click',event=>{const button=event.target.closest('[data-rollback]');if(!button||!ready('design')||unresolved())return;const revision=settings.design.revision;invalidate();void run('Готовим предпросмотр возврата описания…',async current=>{const data=await request('design','/rollback-preview',{revision,requestId:button.dataset.rollback});if(!current())return;validate(data,'design',revision);if(!data.previewId||data.operation!=='description')throw Error('INVALID_PREVIEW');acceptPreview(data);});});
    node('refresh').addEventListener('click',()=>{if(!busy&&!unresolved())void load(companyCode);else if(unresolved())say('Сначала обновите историю и проверьте результат предыдущей операции.');});
    controls();
    return {update(next,code=next.selectedProjectId){ctx=next;if(destroyed)return;if(!owner()||String(code||'')!==companyCode)return load(code);controls();},load,destroy(){epoch++;destroyed=true;container.querySelectorAll('input,textarea').forEach(el=>{el.value='';});container.replaceChildren();settings={};preview=null;pending=null;image=null;}};
  };
})();
