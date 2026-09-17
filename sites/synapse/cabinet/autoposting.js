(() => {
"use strict";
const cabinet = window.SbCabinet = window.SbCabinet || {};
const permitted = (ctx, action) => ctx.identity?.role === "owner" || ctx.identity?.permissions?.includes("autoposting."+action);
const esc = value => String(value ?? "").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const safeUrl = value => {try {if(typeof value!=="string"||/[\u0000-\u0020\u007f]/.test(value))return null;const url=new URL(value);return ["https:","http:"].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch(_){return null;}};
const STATUS = {draft:"Черновик",scheduled:"В плане",publishing:"Публикуется",published:"Опубликовано",failed:"Ошибка публикации",needs_review:"Нужна проверка текста",cancelled:"Отменено"};
const ERRORS = {PROFILE_CHANGED:"Изменились данные компании. Проверьте текст и сохраните его с актуальной версией.",
  CHANNEL_CHANGED:"Изменилось подключение канала. Проверьте доступ и пересмотрите материал перед планированием.",
  PUBLICATION_UNCERTAIN:"Площадка могла принять материал. Проверьте публикацию вручную: автоматический повтор может создать дубль.",
  PUBLICATION_REVIEW_REQUIRED:"Материал уже отправлялся. Проверьте публикацию на площадке вручную перед дальнейшими действиями.",
  CHANNEL_NOT_CONNECTED:"Канал не подключён. Проверьте доступ в настройках площадки.",CHANNEL_DISABLED:"Канал выключен.",
  AUTH_FAILED:"Площадка не приняла ключ доступа. Проверьте подключение канала.",PROVIDER_AUTH:"Площадка не приняла ключ доступа.",
  RATE_LIMITED:"Площадка ограничила частоту запросов. Повторите позже.",PUBLISH_FAILED:"Площадка не подтвердила публикацию.",
  MEDIA_UNSUPPORTED:"Этот материал не поддерживается выбранной площадкой."};
Object.assign(ERRORS,{PROVIDER_PENDING:"Сервис принял задание. Ожидаем результат публикации.",PROVIDER_LINK_UNAVAILABLE:"Сервис сообщил о публикации. Проверьте запись в сообществе: ссылка пока не подтверждена.",PROVIDER_FAILED:"Сервис не смог опубликовать материал. Проверьте подробности в его кабинете.",PROVIDER_CHECK_FAILED:"Не удалось проверить результат. Проверьте подключение и повторите проверку статуса."});
const EDITABLE = new Set(["draft","needs_review","failed","cancelled"]);
const PLANNING = [["two_gis","2ГИС"],["yandex_maps","Яндекс Карты"],["max","MAX"]];
const CONNECTION_ERRORS = {
  WALL_PERMISSION_REQUIRED:"Ключ не даёт права публиковать записи. Требуется разрешение wall у приложения ВК.",
  ADMIN_REQUIRED:"Не подтверждены права на выбранное сообщество. Проверьте его ID и права пользователя, которому выдан ключ.",
  ACCESS_DENIED:"ВК не принял доступ. Ключ мог истечь или не иметь необходимых разрешений.",
  CONNECTION_UNCERTAIN:"Площадка не ответила вовремя. Статус подключения не подтверждён.",
  TOKEN_UNREADABLE:"Сохранённый ключ недоступен. Обратитесь к администратору Synapse.",
  SETTINGS_CHANGED:"Настройки изменились во время проверки. Обновите статусы перед повторной проверкой."
};
Object.assign(CONNECTION_ERRORS,{PROFILE_NOT_FOUND:"Этот профиль не найден в Onlypult. Обновите список и выберите нужное сообщество.",PROFILE_PLATFORM_MISMATCH:"Выбран профиль другой площадки. Выберите сообщество ВК или канал Telegram соответственно.",PROFILE_INACTIVE:"Подключение профиля в Onlypult требует обновления. Откройте его кабинет.",PROVIDER_AUTH:"Onlypult не принял ключ. Проверьте ключ и пробный период.",PROVIDER_NOT_CONFIGURED:"Сначала сохраните ключ Onlypult для выбранной компании."});
const emptyProfilesMessage=(channel,diagnostics)=>{
  const total=diagnostics?.totalProfiles;
  if(!Number.isSafeInteger(total)||total<0||total>1000)return "В ответе Onlypult нет подходящих профилей. Проверьте подключение нужного сообщества или канала в сервисе.";
  if(total===0)return "Onlypult не вернул профилей для этого ключа. Проверьте ключ и подключение профилей в Onlypult.";
  const remainder=total%100,ending=remainder>=11&&remainder<=14?'профилей':total%10===1?'профиль':total%10>=2&&total%10<=4?'профиля':'профилей';
  const counts=Array.isArray(diagnostics.platformCounts)?diagnostics.platformCounts.filter(item=>Number.isSafeInteger(item?.count)&&item.count>0&&item.count<=total).map(item=>`${typeof item.platform==='string'&&/^[a-z][a-z0-9_-]{0,39}$/.test(item.platform)?item.platform:'unknown'} — ${item.count}`):[];
  return `Onlypult вернул ${total} ${ending}, но для ${channel.platform==='vk'?'ВКонтакте':'Telegram'} подходящих профилей не найдено.${counts.length?' Обозначения площадок: '+counts.join(', ')+'.':''}`;
};
const profileShapeLines=diagnostics=>{
  const types=new Set(['undefined','null','array','string','number','boolean','object']);
  const lines=(Array.isArray(diagnostics?.profileShapes)?diagnostics.profileShapes:[]).slice(0,20).filter(item=>Number.isSafeInteger(item?.count)&&item.count>0&&item.count<=1000&&['idType','nameType','statusType','platformType'].every(key=>types.has(item[key]))).map(item=>{
    const fields=item.platformType==='undefined'&&Array.isArray(item.fieldNames)?item.fieldNames.filter(name=>typeof name==='string'&&/^[a-z_]{1,30}$/.test(name)).slice(0,20):[];
    return `Профилей: ${item.count}. id: ${item.idType}; name: ${item.nameType}; status: ${item.statusType}; platform: ${item.platformType}.${fields.length?' Поля: '+fields.join(', ')+'.':''}`;
  });
  if(Number.isSafeInteger(diagnostics?.otherShapesCount)&&diagnostics.otherShapesCount>0&&diagnostics.otherShapesCount<=1000)lines.push(`Профили с другой структурой: ${diagnostics.otherShapesCount}.`);
  return lines;
};
let controller;
function create(container, context) {
  const time = cabinet.companyTime;
  let ctx=context, companyCode="", settings=null, information=null, starterPlan=null, posts=[], post=null, busy=false, epoch=0, baseline=null, reviewed=null;
  let selectedDate="", month="";
  const drafts=new Map(), selections=new Map(), channelDrafts=new Map(), providerProfiles=new Map();
  const companies=(ctx.identity.companies||[]).map(item=>({code:String(item.id),name:item.name||item.id}));
  container.classList.add("autoposting-view");
  container.innerHTML=`<h2>Автопостинг</h2><p>Подготовьте материал, проверьте его и поставьте в план. Постановка в план разрешает автоматическую публикацию в указанное время.</p>
    <div class="autoposting-toolbar"><label for="autoposting-company">Компания</label><select id="autoposting-company">${companies.map(item=>`<option value="${esc(item.code)}">${esc(item.name)}</option>`).join("")}</select><button class="plain-button" id="autoposting-refresh" type="button">Обновить статусы</button><a href="#company-information">Данные компании</a></div>
    <p id="autoposting-status" role="status" aria-live="polite"></p>
    <section class="card vk-connection-guide" id="vk-connection-guide" aria-labelledby="vk-connection-title"></section>
    <details class="card autoposting-connections"><summary>Подключение площадок</summary><p class="autoposting-note">Пустой ключ сохраняет прежний. Новый ключ применяется только кнопкой сохранения; после изменения канала проверьте доступ. Проверка не публикует посты.</p><div id="autoposting-channels" class="autoposting-channel-grid"></div><div id="autoposting-planning" class="autoposting-planning"></div></details>
    <section class="card autoposting-starter" id="autoposting-starter-plan" hidden></section>
    <section class="card autoposting-calendar-section"><h3>Календарь публикаций</h3><p id="autoposting-calendar-zone" class="autoposting-note"></p><div class="autoposting-toolbar"><button class="plain-button" id="autoposting-prev" type="button" aria-label="Предыдущий месяц">←</button><label for="autoposting-month" class="autoposting-sr-only">Месяц календаря</label><input type="month" id="autoposting-month"><button class="plain-button" id="autoposting-next" type="button" aria-label="Следующий месяц">→</button><button class="plain-button" id="autoposting-all" type="button">Все даты</button></div><div id="autoposting-calendar" class="autoposting-calendar"></div><div id="autoposting-posts"></div></section>
    <div class="autoposting-editor-grid"><section class="card"><h3>Материал</h3><label for="autoposting-select">Открыть материал</label><select id="autoposting-select"><option value="">Новый черновик</option></select><p id="autoposting-post-state"></p><p id="autoposting-post-error" role="status" hidden></p><div id="autoposting-deliveries"></div>
    <form id="autoposting-form"><label>Название в кабинете<input id="autoposting-title" maxlength="200" required></label><label>Текст публикации<textarea id="autoposting-text" rows="9" maxlength="20000" required></textarea></label>
    <label>Материалы по ссылкам<textarea id="autoposting-media" rows="3" placeholder="https://example.com/photo.jpg"></textarea></label>
    <label>Фото с устройства<input id="autoposting-photo" type="file" accept="image/jpeg,image/png,image/webp"></label><button class="plain-button" id="autoposting-upload" type="button">Загрузить фото</button><p class="autoposting-note">Фото JPEG, PNG или WebP до 10 МБ. До 10 открытых HTTP(S)-ссылок, каждая с новой строки. Для фотографий во ВКонтакте выберите подключение Onlypult. Прямое подключение ВКонтакте поддерживает текст и одну ссылку.</p>
    <fieldset id="autoposting-platforms"><legend>Куда опубликовать</legend></fieldset>
    <div class="autoposting-date-fields"><label>Дата и время<input id="autoposting-date" type="datetime-local"></label><label>Часовой пояс<input id="autoposting-timezone" maxlength="80" required placeholder="Asia/Irkutsk"></label></div>
    <p class="autoposting-note">Время относится к указанному часовому поясу, а не настройкам компьютера. Черновик можно сохранить без даты и подключённого канала.</p>
    <button class="plain-button" id="autoposting-save" type="submit">Сохранить черновик</button><p id="autoposting-form-status" aria-live="off"></p></form>
    <div class="autoposting-actions"><button class="plain-button" id="autoposting-preview" type="button">Предпросмотр</button><button class="plain-button" id="autoposting-cancel" type="button" hidden>Снять с публикации</button><button class="plain-button" id="autoposting-reconcile" type="button" hidden>Проверить результат в сервисе</button></div></section>
    <section class="card autoposting-preview-section" aria-labelledby="autoposting-preview-title"><h3 id="autoposting-preview-title" tabindex="-1">Проверка перед публикацией</h3><div id="autoposting-preview-content"><p>Сохраните материал и откройте предпросмотр.</p></div><button class="plain-button" id="autoposting-schedule" type="button" disabled>Поставить в план</button><p class="autoposting-note">После постановки в план материал отправляется автоматически. Уже начатую публикацию площадка может завершить после отмены.</p></section></div>`;
  const get=id=>container.querySelector("#"+id), form=get("autoposting-form");
  const edit=()=>permitted(ctx,"edit"), zone=()=>information?.profile?.timezone||settings?.timezone||"UTC";
  const channels=()=>Array.isArray(settings?.channels)?settings.channels:[];
  const endpoint=path=>"/content/crm"+path+"?companyCode="+encodeURIComponent(companyCode);
  const request=(path,method,body)=>ctx.apiJson(endpoint(path),method?ctx.csrfOptions(method,body):undefined);
  const message=text=>{get("autoposting-status").textContent=text;get("autoposting-form-status").textContent=text;};
  const renderProfileDiagnostics=(channel,diagnostics)=>{
    if(ctx.identity?.role!=='owner')return;
    const card=[...get('autoposting-channels').querySelectorAll('[data-channel]')].find(node=>node.dataset.channel===channel.id),details=card?.querySelector('[data-profile-diagnostics]');
    if(!details)return;const lines=profileShapeLines(diagnostics),content=details.querySelector('[data-profile-diagnostics-content]');
    content.replaceChildren();for(const line of lines){const paragraph=document.createElement('p');paragraph.textContent=line;content.append(paragraph);}details.hidden=!lines.length;
  };
  const raw=()=>({title:get("autoposting-title").value,text:get("autoposting-text").value,media:get("autoposting-media").value,
    date:get("autoposting-date").value,timezone:get("autoposting-timezone").value,
    platformIds:[...get("autoposting-platforms").querySelectorAll("input:checked")].map(node=>node.value)});
  const key=()=>companyCode+":"+(post?.id||"new");
  const dirty=()=>JSON.stringify(raw())!==JSON.stringify(baseline);
  const stash=()=>{if(settings&&information){selections.set(companyCode,post?.id||null);if(dirty())drafts.set(key(),{raw:raw(),post,baseline});else drafts.delete(key());}};
  const setRaw=values=>{
    for(const name of ["title","text","media","date","timezone"])get("autoposting-"+name).value=values[name]??"";
    get("autoposting-platforms").querySelectorAll("input").forEach(node=>{node.checked=(values.platformIds||[]).includes(node.value);});
  };
  const read=()=>{
    const values=raw(), mediaUrls=values.media.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
    if(mediaUrls.length>10||mediaUrls.some(value=>!safeUrl(value)))throw Error("Укажите до 10 HTTP(S)-ссылок без логина и пароля.");
    if(!time.validZone(values.timezone))throw Error("Укажите существующий часовой пояс, например Asia/Irkutsk.");
    let scheduledAt=null;
    try {if(values.date)scheduledAt=time.toUTC(values.date,values.timezone);}catch(_){throw Error("Выбранное местное время не существует или неоднозначно. Укажите другое время.");}
    return {title:values.title.trim(),text:values.text.trim(),mediaUrls,platformIds:values.platformIds,scheduledAt,timezone:values.timezone,profileRevision:information.revision};
  };
  const problems=()=>{
    const result=[];let data;
    try{data=read();}catch(error){return [error.message];}
    if(!data.title||!data.text)result.push("Заполните название и текст.");
    if(!data.scheduledAt||Date.parse(data.scheduledAt)<=Date.now())result.push("Выберите дату и время в будущем.");
    if(!data.platformIds.length)result.push("Выберите подключённый канал Telegram или ВКонтакте.");
    if(!Number.isSafeInteger(information?.revision)||information.revision<1)result.push("Сначала сохраните данные компании в разделе «Актуальность».");
    if(post&&post.profileRevision!==information.revision)result.push("Данные компании изменились. Проверьте текст и сохраните его заново.");
    if(post?.deliveries?.some(item=>["published","publishing","needs_review"].includes(item.status)))result.push("Материал уже отправлялся на площадку. Проверьте опубликованное вручную: автоматический повтор может создать дубль.");
    for(const id of data.platformIds){
      const channel=channels().find(item=>item.id===id);
      if(!channel?.connected||!channel.enabled){result.push((channel?.name||id)+": включите канал и проверьте доступ.");continue;}
      const maxText=channel.platform==="telegram"&&data.mediaUrls.length?1024:(channel.caps?.maxText|| (channel.platform==="vk"?15000:4096));
      const maxMedia=Number.isSafeInteger(channel.caps?.maxMedia)?channel.caps.maxMedia:(channel.platform==="vk"?1:10);
      if(data.text.length>maxText)result.push(`${channel.name||id}: текст до ${maxText} символов${data.mediaUrls.length&&channel.platform==="telegram"?" с изображениями":""}.`);
      if(data.mediaUrls.length>maxMedia)result.push(`${channel.name||id}: материалов не больше ${maxMedia}.`);
    }
    return result;
  };
  const readyToSchedule=()=>post&&EDITABLE.has(post.status)&&!dirty()&&reviewed===post.revision&&!problems().length;
  const controls=()=>{
    container.setAttribute("aria-busy",String(busy));
    if(ctx.identity?.role!=='owner')get('autoposting-channels').querySelectorAll('[data-profile-diagnostics]').forEach(node=>node.remove());
    container.querySelectorAll("input,textarea,select,button").forEach(node=>{node.disabled=busy||!settings;});
    get("autoposting-company").disabled=busy||!companies.length;
    const canEdit=edit()&&(!post||EDITABLE.has(post.status))&&!post?.deliveries?.some(item=>["published","publishing","needs_review"].includes(item.status));
    form.querySelectorAll("input,textarea,select,button").forEach(node=>{node.disabled=busy||!settings||!canEdit;});
    get("autoposting-channels").querySelectorAll("input,select,button").forEach(node=>{
      const card=node.closest('[data-channel]');
      const needsProfile=node.matches('[data-channel-field="enabled"]')&&card.querySelector('[data-channel-field="provider"]').value==='onlypult'&&!card.querySelector('[data-channel-field="target"]').value.trim();
      if(needsProfile)node.checked=false;
      node.disabled=busy||!edit()||needsProfile||(ctx.identity?.role!=='owner'&&node.closest('[data-owner-connection]')&&!node.matches('[data-check-channel]'));
    });
    get("autoposting-preview").disabled=busy||!post||dirty();
    get("autoposting-schedule").disabled=busy||!edit()||!readyToSchedule();
    get("autoposting-cancel").hidden=!post||!["scheduled","publishing"].includes(post.status);
    get("autoposting-cancel").disabled=busy||!edit();
    get("autoposting-reconcile").hidden=!post?.deliveries?.some(item=>item.providerPostId);
    get("autoposting-reconcile").disabled=busy||!edit();
    const importButton=get('autoposting-import-plan');if(importButton)importButton.disabled=busy||!edit()||Boolean(starterPlan?.imports?.[get('autoposting-plan-platform').value]);
  };
  const invalidate=()=>{reviewed=null;get("autoposting-preview-content").innerHTML="<p>Предпросмотр не выполнен или устарел. Сохраните изменения и проверьте материал заново.</p>";controls();};
  const renderState=()=>{
    get("autoposting-post-state").textContent=post?STATUS[post.status]||"Статус неизвестен":"Новый черновик";
    const node=get("autoposting-post-error");node.hidden=!post?.lastErrorCode;
    node.textContent=post?.lastErrorCode?(ERRORS[post.lastErrorCode]||"Не удалось подтвердить публикацию. Проверьте подключение и данные компании."):"";
    get("autoposting-deliveries").innerHTML=(post?.deliveries||[]).map(item=>`<p>${esc(channels().find(channel=>channel.id===item.channelId)?.name||item.channelId)}: ${esc(STATUS[item.status]||{pending:"Ожидает отправки"}[item.status]||"Требуется проверка")}${item.errorCode&&ERRORS[item.errorCode]?` · ${esc(ERRORS[item.errorCode])}`:""}${safeUrl(item.url)?` · <a href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer">Открыть публикацию</a>`:""}</p>`).join("");
  };
  const renderPost=()=>{
    get("autoposting-platforms").innerHTML='<legend>Куда опубликовать</legend>'+channels().map(channel=>`<label class="autoposting-checkbox"><input type="checkbox" value="${esc(channel.id)}">${esc(channel.name||channel.platform)} — ${channel.connected&&channel.enabled?"подключён":"требуется подключение"}</label>`).join("");
    const timezone=post?.timezone||zone();
    const values={title:post?.title||"",text:post?.text||"",media:(post?.mediaUrls||[]).join("\n"),date:time.toLocal(post?.scheduledAt,timezone),timezone,platformIds:post?.platformIds||[]};
    setRaw(values);baseline=raw();
    const draft=drafts.get(key());if(draft){post=draft.post;baseline=draft.baseline;setRaw(draft.raw);}
    renderState();invalidate();
  };
  const renderChannels=()=>{
    const vk=channels().find(channel=>channel.id==="vk");
    const socials=Array.isArray(information?.profile?.socials)?information.profile.socials:[];
    const candidate=safeUrl(socials.find(item=>item.type==="vk")?.url);
    const communityUrl=candidate&&["vk.com","www.vk.com","vk.ru","www.vk.ru"].includes(new URL(candidate).hostname)?candidate:null;
    const companyName=companies.find(item=>item.code===companyCode)?.name||companyCode;
    const saved=Boolean(vk?.tokenConfigured||vk?.connected);
    get("vk-connection-guide").innerHTML=`<h3 id="vk-connection-title">ВКонтакте · ${esc(companyName)}</h3>
      <p class="vk-connection-state">${vk?.connected?"Доступ проверен" : saved?"Подключение сохранено — доступ требует проверки":"Подключение не настроено"}${vk?.enabled?" · автоматическая отправка разрешена":" · автоматическая отправка выключена"}</p>
      <ol class="vk-connection-steps">
        <li><strong>Сообщество компании</strong><p>${communityUrl?`Ссылка сохранена в карточке ${esc(companyName)}: <a href="${esc(communityUrl)}" target="_blank" rel="noopener noreferrer">${esc(communityUrl)}</a>`:'Добавьте ссылку на сообщество в разделе «Данные компании».'} Ссылка сама по себе не подтверждает права доступа.</p></li>
        <li><strong>Разрешение на публикации</strong><p>${vk?.provider==='onlypult'?"Сообщество подключается в Onlypult. Здесь сохраняется отдельный ключ сервиса и выбирается точный профиль компании.":saved?"Ключ сохранён. Его значение не отображается в кабинете.":"Авторизация через кнопку ВК в Synapse пока не настроена. Можно выбрать Onlypult в подключении площадок ниже. Для прямого подключения администратору Synapse нужно подтвердить доступный способ выдачи разрешения на публикации."}</p></li>
        <li><strong>Проверка выбранного сообщества</strong><p>${vk?.connected?"Права на сохранённое сообщество проверены. Изменение подключения потребует повторной проверки.":"После настройки доступа проверяется право публиковать именно в выбранном сообществе. Проверка не создаёт пост."}</p></li>
        <li><strong>Первый материал</strong><p>Сохраните черновик, проверьте предпросмотр и поставьте конкретный материал в план. Подключение канала само по себе не создаёт публикации.</p></li>
      </ol>
      <p class="autoposting-note">${vk?.provider==='onlypult'?'Выбран Onlypult: тексты и изображения отправляются через подключённый профиль. Принятое задание ещё не означает опубликованную запись.':'Прямое подключение поддерживает текст и одну ссылку. Для публикаций с фото можно выбрать Onlypult ниже.'} Изменение обложки, меню и описания сообщества, чтение сообщений и управление рекламой этим подключением не выполняются.</p>
      <a href="#company-information">Данные компании</a>
      <details class="vk-connection-help"><summary>Что потребуется от владельца</summary><p>Когда официальный способ авторизации будет настроен, владелец подтвердит доступ к нужному сообществу в ВК. Пароль ВК и ключи не нужно отправлять в переписку. Передача владения сообществом не требуется.</p><p>Если у администратора уже есть совместимый ключ пользователя с правом wall, ниже доступны ручные настройки существующего подключения. Обычный ключ сообщества не подходит текущему модулю.</p></details>`;
    get("autoposting-channels").innerHTML=channels().map(channel=>{
      const values=channelDrafts.get(companyCode+":"+channel.id)?.values||channel;
      const onlypult=values.provider==='onlypult', profiles=providerProfiles.get(companyCode+":"+channel.id)||[];
      return `<form class="autoposting-channel" data-channel="${esc(channel.id)}"${onlypult?' data-owner-connection':''}><h3>${esc(channel.platform==="vk"?"ВКонтакте":"Telegram")}</h3><p>${channel.connected?"Доступ подтверждён":"Доступ не подтверждён"}${channel.enabled?" · включён":" · выключен"}</p>
        ${ctx.identity?.role!=='owner'?'<p class="autoposting-note">Onlypult подключает владелец Synapse. После подключения здесь можно готовить и планировать публикации своей компании.</p>':''}
        <label>Способ подключения<select data-channel-field="provider"><option value="direct"${!onlypult?' selected':''}>Напрямую</option><option value="onlypult"${onlypult?' selected':''}${ctx.identity?.role!=='owner'?' disabled':''}>Через Onlypult</option></select></label>
        ${onlypult?'<p class="autoposting-note">Подключите сообщество в Onlypult. Сохраните его ключ здесь, загрузите список профилей и выберите профиль этой компании.</p><a href="https://app.ru.onlypult.com/" target="_blank" rel="noopener noreferrer">Открыть Onlypult</a>':channel.platform==="vk"?'<p class="autoposting-note">Для администратора с уже выданным совместимым доступом. Эти поля не создают приложение ВК и не выдают разрешения.</p>':''}
        <label>Название канала<input data-channel-field="name" value="${esc(values.name||"")}" maxlength="200" required></label>
        ${onlypult?`<label>Профиль этой компании<select data-channel-field="target"><option value="">Сначала загрузите профили</option>${values.target&&!profiles.some(p=>p.id===values.target)?`<option value="${esc(values.target)}" selected>Сохранённый профиль ${esc(values.target)}</option>`:''}${profiles.map(p=>`<option value="${esc(p.id)}"${String(values.target)===p.id?' selected':''}>${esc(p.name)} · ${esc(p.id)}${p.status==='active'?'':' · требует подключения'}</option>`).join('')}</select></label><button class="plain-button" type="button" data-load-profiles="${esc(channel.id)}">Загрузить профили Onlypult</button>`:`<label>${channel.platform==="vk"?"ID сообщества (число или clubNNN)":"Канал (@name или -100…)"}<input data-channel-field="target" value="${esc(values.target||"")}" maxlength="200"></label>`}
        <label>${onlypult?"Ключ Onlypult для подключения":channel.platform==="vk"?"Новый ключ пользователя с правом wall":"Новый токен бота — администратора канала"}<input data-channel-field="token" type="password" autocomplete="new-password" maxlength="4096"></label>
        <label class="autoposting-checkbox"><input data-channel-field="enabled" type="checkbox"${values.enabled?" checked":""}>Разрешить автоматическую отправку</label>
        ${onlypult?'<p class="autoposting-note">Отправку можно разрешить после выбора профиля.</p>':''}
        <div class="autoposting-actions"><button class="plain-button" type="submit">Сохранить подключение</button><button class="plain-button" type="button" data-check-channel="${esc(channel.id)}">Проверить доступ</button></div>${onlypult&&ctx.identity?.role==='owner'?'<details data-profile-diagnostics hidden><summary>Технические сведения профилей</summary><div data-profile-diagnostics-content></div></details>':''}</form>`;
    }).join("");
    get("autoposting-planning").innerHTML=PLANNING.map(([id,title])=>{const url=safeUrl(socials.find(item=>item.type===id)?.url);return `<div><strong>${title}</strong><p>Планирование материалов. Автоматическая отправка не подключена.</p>${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Открыть страницу компании</a>`:"<span class=autoposting-note>Ссылка компании не указана.</span>"}</div>`;}).join("");
  };
  const localDay=item=>time.toLocal(item.scheduledAt,zone()).slice(0,10);
  const renderCalendar=()=>{
    get("autoposting-calendar-zone").textContent="Часовой пояс календаря: "+zone();
    get("autoposting-month").value=month;
    const [year,m]=month.split("-").map(Number), start=new Date(Date.UTC(year,m-1,1)), days=new Date(Date.UTC(year,m,0)).getUTCDate();
    const offset=(start.getUTCDay()+6)%7;
    let html=["Пн","Вт","Ср","Чт","Пт","Сб","Вс"].map(day=>`<span class="autoposting-weekday">${day}</span>`).join("")+"<span></span>".repeat(offset);
    for(let day=1;day<=days;day++){const date=month+"-"+String(day).padStart(2,"0"),total=posts.filter(item=>localDay(item)===date).length;
      html+=`<button type="button" data-calendar-date="${date}" aria-pressed="${selectedDate===date}" aria-label="${date}: материалов ${total}">${day}${total?`<span>${total}</span>`:""}</button>`;}
    get("autoposting-calendar").innerHTML=html;
    const list=posts.filter(item=>!selectedDate||localDay(item)===selectedDate).slice().sort((a,b)=>(a.scheduledAt||"9999").localeCompare(b.scheduledAt||"9999"));
    get("autoposting-posts").innerHTML=list.length?`<ul class="autoposting-post-list">${list.map(item=>`<li><button class="plain-button" type="button" data-open-post="${esc(item.id)}">${esc(item.title||"Без названия")}</button><span>${item.scheduledAt?esc(time.toLocal(item.scheduledAt,zone()).replace("T"," ")):"Дата не задана"} · ${esc(STATUS[item.status]||"Статус неизвестен")}</span></li>`).join("")}</ul>`:"<p>На выбранную дату материалов нет.</p>";
  };
  const renderList=()=>{
    get("autoposting-select").innerHTML='<option value="">Новый черновик</option>'+posts.map(item=>`<option value="${esc(item.id)}">${esc(item.title)} — ${esc(STATUS[item.status]||"Статус неизвестен")}</option>`).join("");
    get("autoposting-select").value=post?String(post.id):"";renderCalendar();
  };
  const renderStarterPlan=()=>{
    const node=get('autoposting-starter-plan');node.hidden=!starterPlan?.available;
    if(!starterPlan?.available){node.replaceChildren();return;}
    node.innerHTML=`<h3>Недельный план · ${esc(companies.find(c=>c.code===companyCode)?.name||companyCode)}</h3><p>${esc(starterPlan.reviewNote||'Проверьте сведения компании и материалы перед публикацией.')}</p>
      <details><summary>Темы и материалы на 7 дней</summary><ol>${(starterPlan.topics||[]).map(item=>`<li><strong>${esc(item.title)}</strong><p>${esc(item.goal)}</p><p class="autoposting-note">${esc(typeof item.mediaBrief==='string'?item.mediaBrief:item.mediaBrief?.description||'Подберите фото компании')} · День ${Number(item.dayOffset)+1}, ${esc(item.localTime)} · ${esc(starterPlan.timezone)}</p></li>`).join('')}</ol></details>
      <div class="autoposting-toolbar"><label>Версия текстов для площадки<select id="autoposting-plan-platform"><option value="vk">ВКонтакте</option><option value="telegram">Telegram</option></select></label><button type="button" class="plain-button" id="autoposting-import-plan">Добавить 7 черновиков</button></div>
      <p class="autoposting-note">Добавляются только тексты со ссылками для выбранной площадки. Фото, дату и канал публикации выберите в каждом материале. Автоматическая отправка не включается.</p><p id="autoposting-plan-state" role="status"></p>`;
    const refresh=()=>{get('autoposting-plan-state').textContent=starterPlan.imports?.[get('autoposting-plan-platform').value]?'Эти черновики уже добавлены. Они доступны в календаре и списке материалов.':'';controls();};
    get('autoposting-plan-platform').addEventListener('change',refresh);refresh();
    get('autoposting-import-plan').addEventListener('click',()=>{
      if(busy||!edit())return;const platform=get('autoposting-plan-platform').value;
      void run(async current=>{await request('/autoposting/starter-plan','POST',{platform,profileRevision:information.revision});if(!current())return;
        const result=await Promise.all([request('/autoposting/starter-plan'),request('/autoposting/posts')]);if(!current())return;
        if(result[0].companyCode!==companyCode||result[1].companyCode!==companyCode)throw Error('Wrong company');
        starterPlan=result[0];posts=result[1].posts;renderList();renderStarterPlan();message('7 черновиков добавлены. Проверьте тексты и выберите фотографии перед постановкой в план.');
      },'Добавляем черновики…','Не удалось подтвердить добавление. Обновите статусы: повтор не создаст второй комплект.');
    });
  };
  const run=async(operation,pending,failure)=>{
    if(busy||!settings)return;const version=epoch;busy=true;controls();message(pending);
    try{await operation(()=>version===epoch);}catch(_){if(version===epoch)message(failure);}
    finally{if(version===epoch){busy=false;controls();}}
  };
  const selectPost=id=>{stash();post=posts.find(item=>String(item.id)===String(id))||null;selections.set(companyCode,post?.id||null);renderPost();get("autoposting-select").value=post?String(post.id):"";};
  const load=async(code,refresh=false)=>{
    stash();get("autoposting-photo").value="";get("autoposting-channels").querySelectorAll('input[type="password"]').forEach(node=>{node.value="";});
    get('autoposting-channels').querySelectorAll('[data-profile-diagnostics]').forEach(node=>node.remove());
    companyCode=code;const version=++epoch;busy=true;settings=null;information=null;starterPlan=null;post=null;get("autoposting-company").value=code;renderStarterPlan();
    get("vk-connection-guide").innerHTML='<h3 id="vk-connection-title">Подключение ВКонтакте</h3><p>Загружаем настройки выбранной компании…</p>';controls();
    if(!code){busy=false;get("vk-connection-guide").textContent="Выберите доступную компанию.";message("Нет доступных компаний.");controls();return;}
    message("Загружаем материалы и подключения…");
    try{const result=await Promise.all([request("/autoposting/settings"),request("/autoposting/posts"),request("/company-information"),request('/autoposting/starter-plan')]);if(version!==epoch)return;
      if(result[1].companyCode!==code||result[2].companyCode!==code||result[3].companyCode!==code)throw Error("Wrong company");
      [settings,,information,starterPlan]=result;posts=Array.isArray(result[1].posts)?result[1].posts:[];
      month=refresh&&month?month:time.toLocal(new Date().toISOString(),zone()).slice(0,7);selectedDate="";
      post=posts.find(item=>item.id===selections.get(code))||null;
      renderChannels();renderList();renderPost();renderStarterPlan();message(edit()?"Черновики не публикуются до постановки в план.":"Доступ только для просмотра.");
    }catch(_){if(version===epoch){get("vk-connection-guide").textContent="Не удалось получить статус подключения выбранной компании. Обновите статусы.";message("Не удалось загрузить автопостинг. Ввод сохранён в текущем окне; повторите обновление.");}}
    finally{if(version===epoch){busy=false;controls();}}
  };
  form.addEventListener("input",()=>{stash();invalidate();});form.addEventListener("change",()=>{stash();invalidate();});
  form.addEventListener("submit",event=>{
    event.preventDefault();if(busy||!edit()||!settings||(post&&!EDITABLE.has(post.status))||!form.reportValidity())return;
    let data;try{data=read();}catch(error){message(error.message);return;}
    if(!data.title||!data.text){message("Заполните название и текст материала.");return;}
    void run(async current=>{const oldKey=key();const result=await request("/autoposting/posts"+(post?"/"+encodeURIComponent(post.id):""),post?"PATCH":"POST",{...data,...(post?{revision:post.revision}:{})});if(!current())return;
      drafts.delete(oldKey);post=result;posts=[result,...posts.filter(item=>item.id!==result.id)];selections.set(companyCode,result.id);renderList();renderPost();message("Черновик сохранён. Откройте предпросмотр перед постановкой в план.");
    },"Сохраняем черновик…","Не удалось сохранить. Ввод остался в форме; версия могла измениться в другом окне.");
  });
  get("autoposting-preview").addEventListener("click",()=>{
    if(busy||!post||dirty())return;const issues=problems();reviewed=post.revision;
    get("autoposting-preview-content").innerHTML=`<h4>${esc(post.title)}</h4><pre>${esc(post.text)}</pre><p>${post.scheduledAt?esc(time.toLocal(post.scheduledAt,post.timezone).replace("T"," ")+" · "+post.timezone):"Дата не задана"}</p>
      <p>Площадки: ${post.platformIds.map(id=>esc(channels().find(item=>item.id===id)?.name||id)).join(", ")||"не выбраны"}</p>
      ${(post.mediaUrls||[]).length?`<ul>${post.mediaUrls.map(url=>safeUrl(url)?`<li><a href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${cabinet.companyAssets.imageUrl(url)?`<img class="autoposting-thumbnail" src="${esc(url)}" alt="Материал публикации" loading="lazy">`:""}${esc(url)}</a></li>`:"<li>Некорректная ссылка на материал</li>").join("")}</ul>`:""}
      ${issues.length?`<ul class="autoposting-issues">${issues.map(item=>`<li>${esc(item)}</li>`).join("")}</ul>`:"<p>Материал готов к постановке в план.</p>"}`;controls();
    const heading=get("autoposting-preview-title");heading.focus({preventScroll:true});
    heading.scrollIntoView?.({block:"start",behavior:window.matchMedia?.("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"});
  });
  get("autoposting-schedule").addEventListener("click",()=>{
    if(!edit()||!readyToSchedule())return;
    void run(async current=>{invalidate();const result=await request("/autoposting/posts/"+encodeURIComponent(post.id)+"/schedule","POST",{revision:post.revision});if(!current())return;
      post=result;posts=posts.map(item=>item.id===result.id?result:item);drafts.delete(key());renderList();renderPost();message("Материал поставлен в план. Публикация будет отправлена автоматически в указанное время.");
    },"Ставим материал в план…","Не удалось подтвердить постановку в план. Обновите статусы и заново проверьте материал.");
  });
  get("autoposting-cancel").addEventListener("click",()=>{
    if(!edit()||!post||!["scheduled","publishing"].includes(post.status))return;
    void run(async current=>{const result=await request("/autoposting/posts/"+encodeURIComponent(post.id)+"/cancel","POST",{revision:post.revision});if(!current())return;post=result;posts=posts.map(item=>item.id===result.id?result:item);renderList();renderPost();message("Материал снят с очереди. Уже начатую публикацию площадка может завершить.");
    },"Отменяем публикацию…","Не удалось подтвердить отмену. Обновите статусы.");
  });
  get('autoposting-reconcile').addEventListener('click',()=>{
    if(busy||!edit()||!post?.deliveries?.some(item=>item.providerPostId))return;
    void run(async current=>{const result=await request('/autoposting/posts/'+encodeURIComponent(post.id)+'/reconcile','POST',{revision:post.revision});if(!current())return;
      post=result;posts=posts.map(item=>item.id===result.id?result:item);renderList();renderPost();message(result.deliveries?.some(item=>item.errorCode==='PROVIDER_CHECK_FAILED')?'Не удалось проверить результат. Повторная отправка не выполнялась.':'Статус проверен. Повторная отправка не выполнялась.');
    },'Проверяем результат…','Не удалось проверить результат. Повторная отправка не выполнялась.');
  });
  get("autoposting-company").addEventListener("change",()=>{const code=get("autoposting-company").value;if(ctx.chooseProject)ctx.chooseProject(code);else void load(code);});
  get("autoposting-upload").addEventListener("click",()=>{
    if(busy||!edit()||!settings||(post&&!EDITABLE.has(post.status)))return;const file=get("autoposting-photo").files?.[0];
    if(!file){message("Выберите фото с устройства.");return;}
    const media=raw().media.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);if(media.length>=10){message("Можно добавить до 10 материалов.");return;}
    void run(async current=>{const url=await cabinet.companyAssets.upload(ctx,companyCode,file);if(!current())return;get("autoposting-media").value=[...media,url].join("\n");get("autoposting-photo").value="";stash();invalidate();message("Фото добавлено в черновик. Сохраните материал перед публикацией.");},"Загружаем фото…","Не удалось загрузить фото. Нужен JPEG, PNG или WebP до 10 МБ.");
  });
  get("autoposting-refresh").addEventListener("click",()=>{void load(companyCode,true);});
  get("autoposting-select").addEventListener("change",()=>selectPost(get("autoposting-select").value));
  get("autoposting-posts").addEventListener("click",event=>{const button=event.target.closest("[data-open-post]");if(button){selectPost(button.dataset.openPost);get("autoposting-select").focus();}});
  const changeMonth=delta=>{const [year,m]=month.split("-").map(Number);month=new Date(Date.UTC(year,m-1+delta,1)).toISOString().slice(0,7);selectedDate="";renderCalendar();controls();};
  get("autoposting-prev").addEventListener("click",()=>changeMonth(-1));get("autoposting-next").addEventListener("click",()=>changeMonth(1));
  get("autoposting-month").addEventListener("change",()=>{const value=get("autoposting-month").value;if(/^\d{4}-\d{2}$/.test(value)){month=value;selectedDate="";renderCalendar();controls();}});
  get("autoposting-all").addEventListener("click",()=>{selectedDate="";renderCalendar();controls();});
  get("autoposting-calendar").addEventListener("click",event=>{const button=event.target.closest("[data-calendar-date]");if(button){selectedDate=button.dataset.calendarDate;renderCalendar();controls();}});
  const channelValues=node=>{
    const provider=node.querySelector('[data-channel-field="provider"]').value,target=node.querySelector('[data-channel-field="target"]').value;
    return {provider,name:node.querySelector('[data-channel-field="name"]').value,target,enabled:!(provider==='onlypult'&&!target.trim())&&node.querySelector('[data-channel-field="enabled"]').checked};
  };
  get("autoposting-channels").addEventListener("input",event=>{
    const node=event.target.closest("[data-channel]");if(!node||event.target.type==="password")return;
    const channel=channels().find(item=>item.id===node.dataset.channel);channelDrafts.set(companyCode+":"+channel.id,{revision:channel.revision,values:channelValues(node)});
  });
  get("autoposting-channels").addEventListener("change",event=>{
    const node=event.target.closest('[data-channel]');if(!node||busy||!edit())return;
    const channel=channels().find(item=>item.id===node.dataset.channel),values=channelValues(node);
    if(event.target.dataset.channelField==='provider'){values.target='';values.enabled=false;providerProfiles.delete(companyCode+':'+channel.id);}
    channelDrafts.set(companyCode+':'+channel.id,{revision:channel.revision,values});
    if(event.target.dataset.channelField==='provider'){renderChannels();message('Способ подключения изменён. Введите новый ключ и сохраните подключение.');}
    controls();
  });
  get("autoposting-channels").addEventListener("submit",event=>{
    const node=event.target.closest("[data-channel]");if(!node)return;event.preventDefault();if(busy||!edit()||!node.reportValidity())return;
    const channel=channels().find(item=>item.id===node.dataset.channel), input=node.querySelector('[data-channel-field="token"]'), token=input.value.trim();
    if(ctx.identity?.role!=='owner'&&(channel.provider==='onlypult'||channelValues(node).provider==='onlypult')){message('Onlypult подключает владелец Synapse.');return;}
    const payload={id:channel.id,platform:channel.platform,...channelValues(node),revision:channelDrafts.get(companyCode+":"+channel.id)?.revision??channel.revision,...(token?{token}:{})};
    void run(async current=>{const result=await request("/autoposting/settings","PUT",{channels:[payload]});input.value="";if(!current())return;
      channelDrafts.delete(companyCode+":"+channel.id);settings=result;renderChannels();invalidate();
      const keySaved=channels().find(item=>item.id===channel.id)?.tokenConfigured;
      message(payload.provider==='onlypult'&&!payload.target.trim()?(keySaved?"Ключ сохранён. Загрузите профили и выберите сообщество или канал.":"Настройки сохранены. Вставьте ключ Onlypult и сохраните подключение."):"Подключение сохранено. Проверьте доступ к каналу перед публикацией.");
    },"Сохраняем подключение…","Не удалось сохранить подключение. Введённый ключ остаётся в поле; проверьте настройки и повторите сохранение.");
  });
  get("autoposting-channels").addEventListener("click",event=>{
    const profilesButton=event.target.closest('[data-load-profiles]');
    if(profilesButton){
      if(busy||!edit()||ctx.identity?.role!=='owner')return;const channel=channels().find(item=>item.id===profilesButton.dataset.loadProfiles),node=profilesButton.closest('[data-channel]');
      if(channel.provider!=='onlypult'||!channel.tokenConfigured||channelDrafts.has(companyCode+':'+channel.id)||node.querySelector('[data-channel-field="token"]').value){message('Сначала сохраните ключ Onlypult. Профиль можно выбрать после загрузки списка.');return;}
      void run(async current=>{const result=await request('/autoposting/settings/'+encodeURIComponent(channel.id)+'/profiles');if(!current())return;
        if(result.companyCode!==companyCode||!Array.isArray(result.profiles))throw Error('Wrong company');
        providerProfiles.set(companyCode+':'+channel.id,result.profiles);renderChannels();if(!result.profiles.length)renderProfileDiagnostics(channel,result.diagnostics);message(result.profiles.length?'Выберите профиль этой компании, сохраните и проверьте доступ.':emptyProfilesMessage(channel,result.diagnostics));
      },'Загружаем профили…','Не удалось загрузить профили. Проверьте сохранённый ключ Onlypult.');return;
    }
    const button=event.target.closest("[data-check-channel]");if(!button||busy||!edit())return;
    const node=button.closest("[data-channel]"), channel=channels().find(item=>item.id===button.dataset.checkChannel);
    if(channelDrafts.has(companyCode+":"+channel.id)||node.querySelector('[data-channel-field="token"]').value){message("Сначала сохраните изменения подключения. Проверка использует сохранённые данные.");return;}
    void run(async current=>{const result=await request("/autoposting/settings/"+encodeURIComponent(channel.id)+"/check","POST",{});if(!current())return;const refreshed=await request("/autoposting/settings");if(!current())return;settings=refreshed;
      renderChannels();invalidate();message(result.ok===true?"Доступ к каналу подтверждён. Проверка не публикует посты.":CONNECTION_ERRORS[result.code]||"Не удалось подтвердить доступ. Проверьте ключ и права в настройках площадки.");
    },"Проверяем доступ без публикации…","Не удалось проверить канал. Посты этой проверкой не публикуются.");
  });
  const code=companies.find(item=>item.code===ctx.selectedProjectId)?.code||companies[0]?.code||"";
  return {ready:load(code),update(next){ctx=next;controls();},change(next){ctx=next;const code=String(next.selectedProjectId||"");if(code!==companyCode&&companies.some(item=>item.code===code))return load(code);}};
}
cabinet.registerView("autoposting",{title:"Автопостинг",render(container,context){if(!permitted(context,"view")){container?.replaceChildren();return;}if(!controller)controller=create(container,context);else controller.update(context);return controller.ready;},
  onProjectChange(context){if(permitted(context,"view"))return controller?.change(context);}});
})();
