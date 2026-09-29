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
Object.assign(ERRORS,{EXTERNAL_PUBLICATION_RECORDED:"Площадка отмечена как опубликованная вне кабинета — отправка не выполнялась. Повторная отправка создала бы дубликат записи.",PROVIDER_PENDING:"Сервис принял задание. Ожидаем результат публикации.",PROVIDER_LINK_UNAVAILABLE:"Сервис сообщил о публикации. Проверьте запись в сообществе: ссылка пока не подтверждена.",PROVIDER_FAILED:"Сервис не смог опубликовать материал. Проверьте подробности в его кабинете.",PROVIDER_CHECK_FAILED:"Не удалось проверить результат. Проверьте подключение и повторите проверку статуса."});
const EDITABLE = new Set(["draft","needs_review","failed","cancelled"]);
const PLANNING = [["two_gis","2ГИС"],["yandex_maps","Яндекс Карты"],["max","MAX"]];
// Очередь контента: пять площадок с лимитами подписей (совпадают с сервером), карточки дней и одобрение конкретной версии.
const CAPTIONS = [["instagram","Instagram / Reels",2200],["tiktok","TikTok",2200],["youtube_shorts","YouTube Shorts",5000],["vk","ВКонтакте",15000],["telegram","Telegram",1024]];
// Доставка подключена только для каналов Telegram/ВКонтакте из настроек; остальные площадки — подготовленные варианты подписей.
const DELIVERY_CONNECTED = new Set(["vk","telegram"]);
// Контент-план: формат и роль независимы; метаданные видны только в ЛК и не входят в подписи.
const FORMATS = [["post","Пост"],["story","Сторис"],["reel","Reels / Shorts / клип"],["carousel","Карусель"]];
const ROLES = [["reach","Охватный"],["affection","На влюбление"],["sale","На продажу"]];
const REVIEW = {draft:"Черновик",pending:"На согласовании",approved:"Согласовано",rejected:"Отклонено"};
const META_TEXT = [["audience","Аудитория (для кого снимаем)",500],["hook","Хук — первые 3 секунды",500],["idea","Идея / сценарий (одна мысль)",4000],["hughNote","Комментарий Хью: почему может сработать",2000],["metrics","Что измеряем (удержание, репосты, сохранения)",1000],["methodSource","Источник методики",300]];
const HISTORY_LABEL = {submitted:"отправлено на согласование",approved:"согласовано",rejected:"отклонено",revoked:"согласование снято",edited:"правка",reordered:"порядок изменён",rescheduled:"плановая дата изменена"};
const DAYS = ["","D1","D2","D3","D4","D5","D6","D7"];
const isVideo = url => /\.(mp4|webm|mov|m4v)(?:[?#].*)?$/i.test(url);
const mediaPreview = urls => (urls||[]).map(url=>{const safe=safeUrl(url);if(!safe)return "<li>Некорректная ссылка на материал</li>";
  const player=isVideo(safe)?`<video class="autoposting-video" controls preload="metadata" playsinline src="${esc(safe)}"></video>`:cabinet.companyAssets?.imageUrl?.(url)||/\.(jpe?g|png|webp|gif)(?:[?#].*)?$/i.test(safe)?`<img class="autoposting-thumbnail" src="${esc(safe)}" alt="Материал публикации" loading="lazy">`:"";
  return `<li>${player}<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a></li>`;}).join("");
const isQueueCard = item => Boolean(item?.dayKey||Object.keys(item?.captions||{}).length);
// Подтверждение внешней публикации: доказательство уже вышедшей записи. Та же проверка формата, что на сервере
// (ops/crm/autoposting.js): https, домен площадки, путь адреса записи, никаких учётных данных, порта, части после «#»
// и лишних параметров; значение разрешённого параметра сверяется с форматом. Применяется и до отправки, и при выводе.
const RECEIPT_FORMATS = {
  instagram:{hosts:["instagram.com","www.instagram.com"],forms:[{path:/^\/(?:[A-Za-z0-9._]{1,30}\/)?(?:p|reel|reels|tv)\/[A-Za-z0-9_-]{5,40}\/?$/,query:{}}]},
  tiktok:{hosts:["tiktok.com","www.tiktok.com"],forms:[{path:/^\/@[A-Za-z0-9._]{1,30}\/(?:video|photo)\/\d{5,30}\/?$/,query:{}}]},
  youtube_shorts:{hosts:["youtube.com","www.youtube.com","m.youtube.com"],
    forms:[{path:/^\/shorts\/[A-Za-z0-9_-]{5,20}\/?$/,query:{}},{path:/^\/watch$/,query:{v:/^[A-Za-z0-9_-]{5,20}$/}}]},
  vk:{hosts:["vk.com","www.vk.com","m.vk.com","vk.ru","www.vk.ru"],
    forms:[{path:/^\/(?:wall|video|clip|photo)-?\d{1,20}_\d{1,20}\/?$/,query:{}},
      {path:/^\/[A-Za-z0-9._]{2,40}\/?$/,query:{w:/^(?:wall|video|clip|photo)-?\d{1,20}_\d{1,20}$/}}]},
  telegram:{hosts:["t.me","telegram.me"],forms:[{path:/^\/(?:c\/\d{1,20}\/\d{1,20}|[A-Za-z0-9_]{4,32}\/\d{1,20})\/?$/,query:{}}]},
};
const safeReceiptUrl = (platform,value) => {
  const spec=RECEIPT_FORMATS[platform];
  if(!spec||typeof value!=="string")return null;
  const raw=value.trim();
  if(!raw||raw.length>500||/[\u0000-\u0020\u007f-\u009f<>"'`\\]/.test(raw))return null;
  let url;
  try {url=new URL(raw);}catch(_){return null;}
  if(url.protocol!=="https:"||url.username||url.password||url.port||url.hash)return null;
  if(!spec.hosts.includes(url.hostname.toLowerCase()))return null;
  const keys=[...url.searchParams.keys()];
  if(new Set(keys).size!==keys.length)return null;
  const form=spec.forms.find(item=>item.path.test(url.pathname)&&keys.length===Object.keys(item.query).length
    &&Object.entries(item.query).every(([key,pattern])=>pattern.test(url.searchParams.get(key)??"")));
  return form?url.href:null;
};
const receiptsOf = item => Array.isArray(item?.externalReceipts)?item.externalReceipts:[];
const receiptPlatforms = item => new Set(receiptsOf(item).map(receipt=>receipt.platform));
const platformLabel = id => CAPTIONS.find(item=>item[0]===id)?.[1]||id;
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
  let selectedDate="", month="", dailyView="today", dailyPlatform="", calendarData=null, calendarEpoch=0, calendarPending=false;
  const approvalSelection=new Map(), approvalResults=new Map(), approvalBlocked=new Set();
  const drafts=new Map(), selections=new Map(), channelDrafts=new Map(), providerProfiles=new Map();
  const companies=(ctx.identity.companies||[]).map(item=>({code:String(item.id),name:item.name||item.id}));
  container.classList.add("autoposting-view");
  container.innerHTML=`<h2>Материалы</h2><p>Готовые материалы и ближайшие даты.</p>
    <p id="autoposting-status" role="status" aria-live="polite"></p>
    <section class="card autoposting-calendar-section" aria-label="Ваши материалы">
    <div class="autoposting-daily-tabs" aria-label="Период материалов">${[["today","Сегодня"],["upcoming","Ближайшие"],["month","Месяц"]].map(([id,label])=>`<button type="button" class="plain-button" data-daily-view="${id}" aria-pressed="${id==='today'}">${label}</button>`).join("")}</div>
    <label class="autoposting-daily-filter">Площадка<select id="autoposting-daily-platform"><option value="">Все площадки</option>${CAPTIONS.map(([id,label])=>`<option value="${id}">${label}</option>`).join("")}</select></label>
    <p id="autoposting-calendar-zone" class="autoposting-note"></p><p id="autoposting-calendar-state" role="status"></p><p id="autoposting-plan-gaps" role="status" hidden></p>
    <div id="autoposting-month-controls" hidden><div class="autoposting-toolbar"><button class="plain-button" id="autoposting-prev" type="button" aria-label="Предыдущий месяц">←</button><label for="autoposting-month" class="autoposting-sr-only">Месяц календаря</label><input type="month" id="autoposting-month"><button class="plain-button" id="autoposting-next" type="button" aria-label="Следующий месяц">→</button><button class="plain-button" id="autoposting-all" type="button">Весь месяц</button></div><div id="autoposting-calendar" class="autoposting-calendar"></div></div>
    <div id="autoposting-batch"><p>Согласуется вся карточка со всеми подписями. Публикация не запускается.</p><div id="autoposting-selected-list"></div><button type="button" class="plain-button" id="autoposting-batch-approve" disabled>Согласовать выбранные (0)</button></div><div id="autoposting-batch-results" role="status" aria-live="polite"></div><div id="autoposting-posts"></div></section>
    <details class="autoposting-workspace-tools"><summary>Компания и настройки</summary>    <div class="autoposting-toolbar"><label for="autoposting-company">Компания</label><select id="autoposting-company">${companies.map(item=>`<option value="${esc(item.code)}">${esc(item.name)}</option>`).join("")}</select><button class="plain-button" id="autoposting-refresh" type="button">Обновить статусы</button><a href="#company-information">Данные компании</a></div>
    <details class="card autoposting-advanced"><summary>Подключения и подготовка материалов</summary><section class="card vk-connection-guide" id="vk-connection-guide" aria-labelledby="vk-connection-title"></section>
    <details class="card autoposting-connections"><summary>Подключение площадок</summary><p class="autoposting-note">Пустой ключ сохраняет прежний. Новый ключ применяется только кнопкой сохранения; после изменения канала проверьте доступ. Проверка не публикует посты.</p><div id="autoposting-channels" class="autoposting-channel-grid"></div><div id="autoposting-planning" class="autoposting-planning"></div></details>
    <section class="card autoposting-starter" id="autoposting-starter-plan" hidden></section></details>
</details>
    <details id="autoposting-editor" class="autoposting-editor"><summary>Открыть редактор / новый материал</summary><div class="autoposting-editor-grid"><section class="card"><h3>Материал</h3><label for="autoposting-select">Открыть материал</label><select id="autoposting-select"><option value="">Новый черновик</option></select><p id="autoposting-post-state"></p><p id="autoposting-post-error" role="status" hidden></p><div id="autoposting-deliveries"></div>
    <form id="autoposting-form"><label>Название в кабинете<input id="autoposting-title" maxlength="200" required></label><label>Текст публикации<textarea id="autoposting-text" rows="9" maxlength="20000"></textarea></label>
    <details class="autoposting-meta"><summary>Для команды · источники и ссылки</summary>    <div class="autoposting-date-fields"><label>День карточки<select id="autoposting-day">${DAYS.map(d=>`<option value="${d}">${d||"—"}</option>`).join("")}</select></label><label>Происхождение материала<input id="autoposting-origin" maxlength="200" placeholder="например: видео Gemini, без надписи ИИ"></label></div>
    <label>Материалы по ссылкам<textarea id="autoposting-media" rows="3" placeholder="https://example.com/video.mp4"></textarea></label>
</details><ul id="autoposting-media-preview" class="autoposting-media-preview"></ul>
    <details class="autoposting-captions"><summary>Подписи площадок (5)</summary><p class="autoposting-note">Пустая подпись означает: для площадки используется общий текст. Лимиты: ${CAPTIONS.map(([,l,n])=>`${l} — ${n}`).join(", ")}.</p>${CAPTIONS.map(([id,label,limit])=>`<label>${label}<textarea data-caption="${id}" rows="3" maxlength="${limit}"></textarea><span class="autoposting-note" data-caption-count="${id}"></span></label>`).join("")}</details>
    <label>Фото или видео с устройства<input id="autoposting-photo" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"></label><button class="plain-button" id="autoposting-upload" type="button">Загрузить файл</button><input type="hidden" id="autoposting-media-sha"><p id="autoposting-media-check" class="autoposting-note"></p><p class="autoposting-note">Фото JPEG, PNG или WebP до 10 МБ; видео MP4 или WebM до 60 МБ. До 10 открытых HTTP(S)-ссылок, каждая с новой строки. Для фотографий во ВКонтакте выберите подключение Onlypult. Прямое подключение ВКонтакте поддерживает текст и одну ссылку.</p>
    <details class="autoposting-meta"><summary>Контент-план: формат, роль, идея</summary><p class="autoposting-note">Служебные поля плана. В публичную подпись не попадают. Роль не зависит от формата.</p>
    <div class="autoposting-date-fields"><label>Формат<select id="autoposting-format"><option value="">—</option>${FORMATS.map(([v,l])=>`<option value="${v}">${l}</option>`).join("")}</select></label><label>Роль<select id="autoposting-role"><option value="">—</option>${ROLES.map(([v,l])=>`<option value="${v}">${l}</option>`).join("")}</select></label></div>
    ${META_TEXT.map(([id,label,limit])=>`<label>${label}<textarea data-meta="${id}" rows="${id==="idea"?4:2}" maxlength="${limit}"></textarea></label>`).join("")}</details>
    <fieldset id="autoposting-platforms"><legend>Куда опубликовать</legend></fieldset>
    <div class="autoposting-date-fields"><label>Дата и время<input id="autoposting-date" type="datetime-local"></label><label>Часовой пояс<input id="autoposting-timezone" maxlength="80" required placeholder="Asia/Irkutsk"></label></div>
    <p class="autoposting-note">Время относится к указанному часовому поясу, а не настройкам компьютера. Черновик можно сохранить без даты и подключённого канала.</p>
    <button class="plain-button" id="autoposting-save" type="submit">Сохранить черновик</button><p id="autoposting-form-status" aria-live="off"></p></form>
    <section id="autoposting-voice" class="autoposting-voice" aria-labelledby="autoposting-voice-title"><h4 id="autoposting-voice-title">Голос для монтажа</h4><p class="autoposting-note">Приватный исходник для монтажёра: не публикуется, не уходит в Onlypult или ВКонтакте и не заменяет видео ролика. M4A, MP3, OGG или WAV до 25 МБ.</p><div id="autoposting-voice-body"></div><p id="autoposting-voice-status" class="autoposting-note" role="status"></p></section>
    <div class="autoposting-actions"><button class="plain-button" id="autoposting-preview" type="button">Предпросмотр</button><button class="plain-button" id="autoposting-cancel" type="button" hidden>Снять с публикации</button><button class="plain-button" id="autoposting-reconcile" type="button" hidden>Проверить результат в сервисе</button></div></section>
    <section class="card autoposting-preview-section" aria-labelledby="autoposting-preview-title"><h3 id="autoposting-preview-title" tabindex="-1">Проверка перед публикацией</h3><div id="autoposting-preview-content"><p>Сохраните материал и откройте предпросмотр.</p></div><div id="autoposting-approval" class="autoposting-approval"></div><div id="autoposting-receipts" class="autoposting-receipts"></div><button class="plain-button" id="autoposting-schedule" type="button" disabled>Поставить в план</button><p class="autoposting-note">После постановки в план материал отправляется автоматически. Уже начатую публикацию площадка может завершить после отмены.</p></section></div>
    </details><details class="card autoposting-queue-section"><summary>Для команды · очередь и импорт</summary><h3>Очередь контента</h3><p class="autoposting-note">Карточки дней с подписями пяти площадок. Одобрение относится к конкретной версии: правка текста или материала снимает его. Галочки по умолчанию сняты; сохранение и одобрение ничего не публикуют. Instagram / Reels, TikTok и YouTube Shorts здесь — подготовленные варианты подписей: их доставка не подключена и не заявляется; автоматическая отправка возможна только в подключённые каналы Telegram и ВКонтакте после постановки в план.</p><div id="autoposting-queue"></div>
    <details class="autoposting-import"><summary>Импорт пакета карточек</summary><p class="autoposting-note">JSON вида {"items":[{"dayKey":"D1","title":"…","mediaUrls":["https://…/d1.mp4"],"captions":{"instagram":"…","tiktok":"…","youtube_shorts":"…","vk":"…","telegram":"…"},"origin":"видео Gemini"}]}. Создаются только черновики без одобрения; отсутствующее видео не подставляется. Повтор пакета не создаёт дубли.</p><textarea id="autoposting-import-json" rows="6"></textarea><button class="plain-button" id="autoposting-import" type="button">Импортировать черновики</button><p id="autoposting-import-state" role="status"></p></details></details>`;
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
    date:get("autoposting-date").value,timezone:get("autoposting-timezone").value,dayKey:get("autoposting-day").value,origin:get("autoposting-origin").value,mediaSha256:get("autoposting-media-sha").value,
    captions:Object.fromEntries(CAPTIONS.map(([id])=>[id,container.querySelector(`[data-caption="${id}"]`).value])),
    meta:{format:get("autoposting-format").value,role:get("autoposting-role").value,...Object.fromEntries(META_TEXT.map(([id])=>[id,container.querySelector(`[data-meta="${id}"]`).value]))},
    platformIds:[...get("autoposting-platforms").querySelectorAll("input:checked")].map(node=>node.value)});
  const key=()=>companyCode+":"+(post?.id||"new");
  const dirty=()=>JSON.stringify(raw())!==JSON.stringify(baseline);
  const stash=()=>{if(settings&&information){selections.set(companyCode,post?.id||null);if(dirty())drafts.set(key(),{raw:raw(),post,baseline});else drafts.delete(key());}};
  const setRaw=values=>{
    for(const name of ["title","text","media","date","timezone","origin"])get("autoposting-"+name).value=values[name]??"";
    get("autoposting-day").value=DAYS.includes(values.dayKey)?values.dayKey:"";get("autoposting-media-sha").value=values.mediaSha256||"";renderMediaCheck();
    for(const [id] of CAPTIONS)container.querySelector(`[data-caption="${id}"]`).value=values.captions?.[id]??"";
    get("autoposting-format").value=values.meta?.format||"";get("autoposting-role").value=values.meta?.role||"";
    for(const [id] of META_TEXT)container.querySelector(`[data-meta="${id}"]`).value=values.meta?.[id]??"";
    renderMediaPreview();
    get("autoposting-platforms").querySelectorAll("input").forEach(node=>{node.checked=(values.platformIds||[]).includes(node.value);});
  };
  const read=()=>{
    const values=raw(), mediaUrls=values.media.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
    if(mediaUrls.length>10||mediaUrls.some(value=>!safeUrl(value)))throw Error("Укажите до 10 HTTP(S)-ссылок без логина и пароля.");
    if(!time.validZone(values.timezone))throw Error("Укажите существующий часовой пояс, например Asia/Irkutsk.");
    let scheduledAt=null;
    try {if(values.date)scheduledAt=time.toUTC(values.date,values.timezone);}catch(_){throw Error("Выбранное местное время не существует или неоднозначно. Укажите другое время.");}
    const captions={};for(const [id,,limit] of CAPTIONS){const value=(values.captions[id]||"").trim();if(value.length>limit)throw Error(`Подпись ${CAPTIONS.find(c=>c[0]===id)[1]} длиннее ${limit} символов.`);if(value)captions[id]=value;}
    const metaOut={format:values.meta.format||"",role:values.meta.role||""};for(const [id] of META_TEXT)metaOut[id]=(values.meta[id]||"").trim();
    return {title:values.title.trim(),text:values.text.trim(),mediaUrls,platformIds:values.platformIds,scheduledAt,timezone:values.timezone,profileRevision:information.revision,dayKey:values.dayKey,origin:values.origin.trim(),captions,mediaSha256:values.mediaSha256||"",...metaOut};
  };
  const problems=()=>{
    const result=[];let data;
    try{data=read();}catch(error){return [error.message];}
    if(!data.title||(!data.text&&!Object.keys(data.captions).length))result.push("Заполните название и текст или подписи площадок.");
    if(!data.scheduledAt||Date.parse(data.scheduledAt)<=Date.now())result.push("Выберите дату и время в будущем.");
    if(!data.platformIds.length)result.push("Выберите подключённый канал Telegram или ВКонтакте.");
    if(!Number.isSafeInteger(information?.revision)||information.revision<1)result.push("Сначала сохраните данные компании в разделе «Актуальность».");
    if(post&&post.profileRevision!==information.revision)result.push("Данные компании изменились. Проверьте текст и сохраните его заново.");
    if(post?.deliveries?.some(item=>["published","publishing","needs_review"].includes(item.status)))result.push("Материал уже отправлялся на площадку. Проверьте опубликованное вручную: автоматический повтор может создать дубль.");
    if(post&&isQueueCard(post)&&!post.approval?.approved)result.push("Карточка очереди контента не одобрена владельцем для этой версии.");
    const marked=receiptPlatforms(post);
    for(const id of data.platformIds){
      const channel=channels().find(item=>item.id===id);
      // Площадка с подтверждением внешней публикации повторно не отправляется: сервер откажет, и дубликат не нужен.
      if(marked.has(channel?.platform||id))result.push(`${channel?.name||id}: площадка отмечена как опубликованная вне ЛК. Повторная отправка создаст дубликат.`);
      if(!channel?.connected||!channel.enabled){result.push((channel?.name||id)+": включите канал и проверьте доступ.");continue;}
      const maxText=channel.platform==="telegram"&&data.mediaUrls.length?1024:(channel.caps?.maxText|| (channel.platform==="vk"?15000:4096));
      const maxMedia=Number.isSafeInteger(channel.caps?.maxMedia)?channel.caps.maxMedia:(channel.platform==="vk"?1:10);
      const channelText=data.captions[channel.platform]||data.text;
      if(!channelText)result.push(`${channel.name||id}: нет ни общего текста, ни подписи площадки.`);
      if(channelText.length>maxText)result.push(`${channel.name||id}: текст до ${maxText} символов${data.mediaUrls.length&&channel.platform==="telegram"?" с изображениями":""}.`);
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
    get('autoposting-batch').hidden=!permitted(ctx,'approve')||!approvalSelection.size;
    get('autoposting-batch-approve').disabled=busy||calendarPending||!settings||!permitted(ctx,'approve')||!approvalSelection.size;
    container.querySelectorAll('[data-daily-approve]').forEach(node=>{node.disabled=busy||calendarPending||!settings||!canSelectApproval(posts.find(item=>String(item.id)===node.dataset.dailyApprove));});
    const canEdit=edit()&&(!post||EDITABLE.has(post.status))&&!post?.deliveries?.some(item=>["published","publishing","needs_review"].includes(item.status));
    form.querySelectorAll("input,textarea,select,button").forEach(node=>{node.disabled=busy||!settings||!canEdit;});
    get("autoposting-channels").querySelectorAll("input,select,button").forEach(node=>{
      const card=node.closest('[data-channel]');
      const needsProfile=node.matches('[data-channel-field="enabled"]')&&card.querySelector('[data-channel-field="provider"]').value==='onlypult'&&!card.querySelector('[data-channel-field="target"]').value.trim();
      if(needsProfile)node.checked=false;
      node.disabled=busy||!edit()||needsProfile||(ctx.identity?.role!=='owner'&&node.closest('[data-owner-connection]')&&!node.matches('[data-check-channel]'));
    });
    get("autoposting-preview").disabled=busy||!post||dirty();
    const approve=get("autoposting-approve");if(approve)approve.disabled=busy||!permitted(ctx,"approve")||!post||dirty()||!post.readiness?.ready;
    container.querySelectorAll("[data-move][data-edge]").forEach(node=>{node.disabled=true;});
    const submitReview=get("autoposting-submit-review");if(submitReview)submitReview.disabled=busy||!edit()||!post||dirty();
    const importButton2=get("autoposting-import");if(importButton2)importButton2.disabled=busy||!edit()||!settings;get("autoposting-import-json").disabled=busy||!edit()||!settings;
    for(const [id,,limit] of CAPTIONS){const node=container.querySelector(`[data-caption-count="${id}"]`);const len=container.querySelector(`[data-caption="${id}"]`).value.length;node.textContent=`${len} / ${limit}`;node.classList.toggle("autoposting-over",len>limit);}
    get("autoposting-schedule").disabled=busy||!edit()||!readyToSchedule();
    get("autoposting-cancel").hidden=!post||!["scheduled","publishing"].includes(post.status);
    get("autoposting-cancel").disabled=busy||!edit();
    get("autoposting-reconcile").hidden=!post?.deliveries?.some(item=>item.providerPostId);
    get("autoposting-reconcile").disabled=busy||!edit();
    const importButton=get('autoposting-import-plan');if(importButton)importButton.disabled=busy||!edit()||Boolean(starterPlan?.imports?.[get('autoposting-plan-platform').value]);
  };
  const invalidate=()=>{reviewed=null;get("autoposting-preview-content").innerHTML="<p>Предпросмотр не выполнен или устарел. Сохраните изменения и проверьте материал заново.</p>";controls();};
  const renderMediaPreview=()=>{const urls=get("autoposting-media").value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean).slice(0,10);get("autoposting-media-preview").innerHTML=mediaPreview(urls);};
  // Сверка загруженного ролика с пакетом материалов: без совпадения SHA-256 карточка не считается готовой.
  const renderMediaCheck=()=>{
    const node=get("autoposting-media-check"),expected=post?.expectedMediaSha256||"",actual=get("autoposting-media-sha").value;
    node.textContent=!expected?"":!actual?`Ожидается ролик из пакета${post?.expectedMediaFile?" "+post.expectedMediaFile:""}: загрузите его через кабинет, хеш сверится автоматически.`:actual===expected?"Хеш загруженного файла совпадает с пакетом.":"Загруженный файл не совпадает с роликом из пакета: это не то видео.";
    node.classList.toggle("autoposting-over",Boolean(expected&&actual&&actual!==expected));
  };
  const renderApproval=()=>{
    const node=get("autoposting-approval");if(!post){node.innerHTML="";return;}
    const a=post.approval||{},r=post.readiness||{ready:false,issues:[]},owner=permitted(ctx,"approve");
    const rv=post.review||{state:"draft"},canEdit=edit()&&!busy;
    const historyItems=(post.history||[]).slice(0,10).map(h=>`<li>${esc(HISTORY_LABEL[h.action]||h.action)} · содержимое v${esc(h.contentRevision)} · ${esc(h.actorName||"—")} · ${esc(time.toLocal(h.createdAt,zone()).replace("T"," "))}${h.comment?` — ${esc(h.comment)}`:""}</li>`).join("");
    node.innerHTML=`<p>Версия ${esc(post.revision)} · содержимое v${esc(post.contentRevision||"")} · <strong data-review-state="${esc(rv.state)}">${esc(REVIEW[rv.state]||rv.state)}</strong>${rv.byName?` (${esc(rv.byName)}${rv.at?", "+esc(time.toLocal(rv.at,zone()).replace("T"," ")):""})`:""}</p>
      ${rv.state==="rejected"&&rv.comment?`<p class="autoposting-issues" data-review-comment>Причина отклонения: ${esc(rv.comment)}</p>`:""}
      <p>${r.ready?"Материал готов к согласованию":"Материал не готов: "+esc((r.issues||[]).join("; "))}</p>
      ${rv.state!=="pending"&&!a.approved&&isQueueCard(post)?`<button class="plain-button" type="button" id="autoposting-submit-review"${canEdit?"":" disabled"}>Отправить на согласование</button>`:""}
      <label class="autoposting-checkbox"><input type="checkbox" id="autoposting-approve"${a.approved?" checked":""}${owner?"":" disabled"}>Одобрено публиковать (содержимое v${esc(post.contentRevision||"")})</label>
      <p class="autoposting-note">${a.approved?`Согласовано ${esc(a.approvedByName||"владельцем")}${a.approvedAt?" · "+esc(time.toLocal(a.approvedAt,zone()).replace("T"," ")):""}. Согласование не запускает публикацию; плановая дата — тоже. Отправка начинается только кнопкой «Поставить в план».`:a.stale?`Прежнее согласование относилось к версии содержимого ${esc(a.approvedRevision)} и снято после правки.`:"Не согласовано. Согласует владелец после проверки предпросмотра."}${owner?"":" Согласует владелец кабинета."}</p>
      ${owner?`<form id="autoposting-reject-form" class="autoposting-reject"><label>Отклонить с комментарием (обязателен)<textarea id="autoposting-reject-comment" rows="2" maxlength="2000" required></textarea></label><button class="danger" type="submit"${post.status==="publishing"||post.status==="published"?" disabled":""}>Отклонить</button></form>`:""}
      ${historyItems?`<details class="autoposting-history"><summary>История согласования (${post.history.length})</summary><ul>${historyItems}</ul></details>`:""}`;
    get("autoposting-submit-review")?.addEventListener("click",()=>{
      if(busy||!post||dirty())return;
      void run(async current=>{const result=await request("/autoposting/posts/"+encodeURIComponent(post.id)+"/submit-review","POST",{revision:post.revision});if(!current())return;
        post=result;posts=posts.map(item=>item.id===result.id?result:item);renderList();renderApproval();controls();message("Карточка отправлена на согласование.");
      },"Отправляем на согласование…","Не удалось отправить на согласование. Обновите статусы.");
    });
    get("autoposting-reject-form")?.addEventListener("submit",event=>{
      event.preventDefault();const comment=get("autoposting-reject-comment").value.trim();
      if(!comment){message("Для отклонения нужен комментарий.");return;}if(busy||!post||dirty()||!owner)return;
      void run(async current=>{const result=await request("/autoposting/posts/"+encodeURIComponent(post.id)+"/reject","POST",{revision:post.revision,comment});if(!current())return;
        post=result;posts=posts.map(item=>item.id===result.id?result:item);renderList();renderApproval();controls();message("Карточка отклонена с комментарием. Отправка не выполнялась.");
      },"Сохраняем отклонение…","Не удалось сохранить отклонение. Версия могла измениться.");
    });
    get("autoposting-approve").addEventListener("change",event=>{
      const approved=event.target.checked;if(busy||!post||dirty()||!owner){event.target.checked=!approved;return;}
      void run(async current=>{const result=await request("/autoposting/posts/"+encodeURIComponent(post.id)+"/approve","POST",{revision:post.revision,approved});if(!current())return;
        post=result;posts=posts.map(item=>item.id===result.id?result:item);renderList();renderApproval();controls();message(approved?"Версия одобрена. Публикация не запускалась: постановка в план — отдельное действие.":"Одобрение снято.");
      },approved?"Сохраняем одобрение…":"Снимаем одобрение…","Не удалось сохранить одобрение. Обновите статусы: версия могла измениться.");
    });
  };
  // Публикации вне кабинета: отдельный список доказательств. Кабинет не отправлял их и не заявляет,
  // что опубликована текущая версия содержимого — у каждой ссылки показана её собственная ревизия.
  const renderReceipts=()=>{
    const node=get("autoposting-receipts");if(!post){node.replaceChildren();return;}
    const list=receiptsOf(post),owner=ctx.identity?.role==="owner",timezone=post.timezone||zone();
    const local=value=>{try{return time.toLocal(value,timezone).replace("T"," ");}catch(_){return "";}};
    const rows=list.map(item=>{
      const link=safeReceiptUrl(item.platform,item.url);
      return `<li data-receipt="${esc(item.platform)}"${item.stale?" data-receipt-stale":""}>
        <span><strong>${esc(platformLabel(item.platform))}</strong> · Опубликовано вне ЛК${link?` · <a href="${esc(link)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Открыть публикацию</a>`:" · ссылку не удалось распознать"}</span>
        <span class="autoposting-note">${esc(local(item.publishedAt))} · содержимое v${esc(item.contentRevision)} · отметил ${esc(item.recordedByName||"владелец")}${item.recordedAt?", "+esc(local(item.recordedAt)):""}</span>
        ${item.stale?`<span class="autoposting-issues" data-receipt-stale-note>Подтверждена публикация версии содержимого v${esc(item.contentRevision)}. Публикация текущей версии v${esc(post.contentRevision||"")} не подтверждена.</span>`:""}
        ${item.note?`<span class="autoposting-note">${esc(item.note)}</span>`:""}</li>`;
    }).join("");
    node.innerHTML=`<h4>Публикации вне кабинета</h4>
      <p class="autoposting-note">Отметка фиксирует уже вышедшую запись: кабинет ничего не отправляет, согласование не меняется. Отмеченную площадку нельзя отправить из плана повторно.</p>
      <p class="autoposting-note">Отметка не отменяет отправку, уже переданную площадке: если доставка началась, отсутствие дубля не гарантировано — проверьте её результат ниже.</p>
      ${rows?`<ul class="autoposting-receipt-list">${rows}</ul>`:"<p>Публикаций вне кабинета не отмечено.</p>"}
      ${owner?`<form id="autoposting-receipt-form" class="autoposting-receipt-form">
        <p class="autoposting-note">Ссылка — только обычный https-адрес самой записи: без логина, пароля, порта, части после «#» и лишних параметров. Короткие ссылки (vm.tiktok.com, youtu.be) не принимаются.</p>
        <p class="autoposting-issues" data-receipt-warning>Перед сохранением: отметка навсегда заблокирует повторную отправку этой площадки для карточки и в текущем интерфейсе не отзывается.</p>
        <label>Площадка<select id="autoposting-receipt-platform">${CAPTIONS.map(([id,label])=>`<option value="${esc(id)}">${esc(label)}</option>`).join("")}</select></label>
        <label>Ссылка на публикацию<input id="autoposting-receipt-url" maxlength="500" placeholder="https://t.me/channel/123" required></label>
        <label>Когда опубликовано · ${esc(timezone)}<input id="autoposting-receipt-date" type="datetime-local" required></label>
        <label>Примечание (необязательно)<input id="autoposting-receipt-note" maxlength="500"></label>
        <button class="plain-button" type="submit">Отметить как опубликованное вне ЛК (содержимое v${esc(post.contentRevision||"")})</button></form>`
        :'<p class="autoposting-note">Отмечает публикацию вне кабинета владелец.</p>'}`;
    get("autoposting-receipt-form")?.addEventListener("submit",event=>{
      event.preventDefault();if(busy||!post||ctx.identity?.role!=="owner")return;
      const platform=get("autoposting-receipt-platform").value,url=get("autoposting-receipt-url").value.trim();
      const when=get("autoposting-receipt-date").value,note=get("autoposting-receipt-note").value.trim(),card=post;
      if(!safeReceiptUrl(platform,url)){message("Укажите обычный https-адрес записи выбранной площадки: без логина, пароля, порта, части после «#» и лишних параметров.");return;}
      let publishedAt=null;
      try{if(when)publishedAt=time.toUTC(when,timezone);}catch(_){publishedAt=null;}
      if(!publishedAt){message("Укажите существующее местное время публикации.");return;}
      if(Date.parse(publishedAt)>Date.now()){message("Дата публикации в будущем: запланированная запись ещё не опубликована.");return;}
      void run(async current=>{
        const result=await request("/autoposting/posts/"+encodeURIComponent(card.id)+"/receipts","POST",{platform,url,publishedAt,contentRevision:card.contentRevision,note});
        if(!current())return;
        post=result;posts=posts.map(item=>item.id===result.id?result:item);renderList();renderState();controls();
        message("Публикация отмечена как вышедшая вне кабинета. Кабинет ничего не отправлял и согласование не менял.");
      },"Сохраняем подтверждение публикации…","Не удалось сохранить подтверждение. Проверьте ссылку и версию содержимого: карточку могли изменить.");
    });
  };
  const queueFilter={role:"",format:"",review:"",platform:""};
  const queueCards=()=>posts.filter(isQueueCard).slice().sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)||a.id-b.id);
  const renderQueue=()=>{
    const all=queueCards();
    const cards=all.filter(item=>(!queueFilter.role||item.meta?.role===queueFilter.role)&&(!queueFilter.format||item.meta?.format===queueFilter.format)
      &&(!queueFilter.review||(item.review?.state||"draft")===queueFilter.review)&&(!queueFilter.platform||Boolean(item.captions?.[queueFilter.platform])));
    const option=(list,selected)=>list.map(([v,l])=>`<option value="${v}"${selected===v?" selected":""}>${l}</option>`).join("");
    const filters=`<div class="autoposting-queue-filters"><label>Роль<select data-queue-filter="role"><option value="">Все</option>${option(ROLES,queueFilter.role)}</select></label>
      <label>Формат<select data-queue-filter="format"><option value="">Все</option>${option(FORMATS,queueFilter.format)}</select></label>
      <label>Согласование<select data-queue-filter="review"><option value="">Все</option>${option(Object.entries(REVIEW),queueFilter.review)}</select></label>
      <label>Площадка<select data-queue-filter="platform"><option value="">Все</option>${option(CAPTIONS.map(([v,l])=>[v,l]),queueFilter.platform)}</select></label></div>`;
    get("autoposting-queue").innerHTML=filters+(cards.length?`<ul class="autoposting-queue-list">${cards.map((item,index)=>`<li class="autoposting-queue-card" data-approved="${item.approval?.approved?"yes":"no"}" data-review="${esc(item.review?.state||"draft")}" data-post-id="${esc(item.id)}">
      <div class="autoposting-queue-head"><button class="plain-button" type="button" data-open-post="${esc(item.id)}"><strong>${esc(item.dayKey||"—")}</strong> ${esc(item.title||"Без названия")}</button>
        <span class="autoposting-queue-order"><button type="button" data-move="up" data-post-id="${esc(item.id)}" aria-label="Выше"${index===0||!edit()?" disabled data-edge":""}>↑</button><button type="button" data-move="down" data-post-id="${esc(item.id)}" aria-label="Ниже"${index===cards.length-1||!edit()?" disabled data-edge":""}>↓</button></span></div>
      <span><span class="autoposting-badge" data-review="${esc(item.review?.state||"draft")}">${esc(REVIEW[item.review?.state]||"Черновик")}</span> ${item.meta?.role?`<span class="autoposting-badge">${esc(ROLES.find(r=>r[0]===item.meta.role)?.[1]||item.meta.role)}</span>`:""} ${item.meta?.format?`<span class="autoposting-badge">${esc(FORMATS.find(r=>r[0]===item.meta.format)?.[1]||item.meta.format)}</span>`:""}</span>
      <span>${item.readiness?.mediaKind==="video"?"видео":item.readiness?.mediaKind==="image"?"изображение":"без материала"} · содержимое v${esc(item.contentRevision||"")} · ${item.approval?.approved?"согласовано":item.approval?.stale?"согласование снято после правки":"не согласовано"} · ${esc(STATUS[item.status]||"Статус неизвестен")}${item.scheduledAt?" · план "+esc(time.toLocal(item.scheduledAt,item.timezone||zone()).replace("T"," "))+" "+esc(item.timezone||zone()):" · дата не задана"}</span>
      ${item.meta?.hook?`<span class="autoposting-note">Хук: ${esc(item.meta.hook)}</span>`:""}
      <span class="autoposting-note">Площадки: ${CAPTIONS.filter(([id])=>item.captions?.[id]).map(([,l])=>esc(l)).join(", ")||"общий текст"}${item.origin?" · "+esc(item.origin):""}${item.expectedMediaSha256?(item.mediaSha256===item.expectedMediaSha256?" · ролик сверен с пакетом":" · ролик из пакета не сверен"):""}</span>
      ${receiptsOf(item).length?`<span class="autoposting-note" data-receipt-summary>Опубликовано вне ЛК: ${[...receiptPlatforms(item)].map(id=>esc(platformLabel(id))).join(", ")}${receiptsOf(item).some(receipt=>receipt.stale)?" (публикация текущей версии содержимого не подтверждена)":""}</span>`:""}</li>`).join("")}</ul>`:"<p>Карточек по этим фильтрам нет. Добавьте день карточки в материале или импортируйте пакет.</p>");
    get("autoposting-queue").querySelectorAll("[data-queue-filter]").forEach(node=>node.addEventListener("change",()=>{queueFilter[node.dataset.queueFilter]=node.value;renderQueue();}));
    get("autoposting-queue").querySelectorAll("[data-move]").forEach(button=>button.addEventListener("click",()=>{
      if(busy||!edit())return;const id=Number(button.dataset.postId),ids=all.map(item=>item.id),i=ids.indexOf(id),j=button.dataset.move==="up"?i-1:i+1;
      if(i<0||j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];
      void run(async current=>{const result=await request("/autoposting/order","PUT",{ids});if(!current())return;if(result.companyCode!==companyCode)throw Error("Wrong company");
        posts=Array.isArray(result.posts)?result.posts:posts;if(post)post=posts.find(item=>item.id===post.id)||post;renderList();message("Порядок плана сохранён.");
      },"Сохраняем порядок…","Не удалось сохранить порядок. Обновите статусы.");
    }));
  };
  const renderState=()=>{
    renderApproval();renderReceipts();
    get("autoposting-post-state").textContent=post?STATUS[post.status]||"Статус неизвестен":"Новый черновик";
    const node=get("autoposting-post-error");node.hidden=!post?.lastErrorCode;
    node.textContent=post?.lastErrorCode?(ERRORS[post.lastErrorCode]||"Не удалось подтвердить публикацию. Проверьте подключение и данные компании."):"";
    get("autoposting-deliveries").innerHTML=(post?.deliveries||[]).map(item=>`<p>${esc(channels().find(channel=>channel.id===item.channelId)?.name||item.channelId)}: ${esc(STATUS[item.status]||{pending:"Ожидает отправки"}[item.status]||"Требуется проверка")}${item.errorCode&&ERRORS[item.errorCode]?` · ${esc(ERRORS[item.errorCode])}`:""}${safeUrl(item.url)?` · <a href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer">Открыть публикацию</a>`:""}</p>`).join("");
  };
  const renderPost=()=>{
    get("autoposting-platforms").innerHTML='<legend>Куда опубликовать</legend>'+channels().map(channel=>`<label class="autoposting-checkbox"><input type="checkbox" value="${esc(channel.id)}">${esc(channel.name||channel.platform)} — ${channel.connected&&channel.enabled?"подключён":"требуется подключение"}</label>`).join("");
    const timezone=post?.timezone||zone();
    const values={title:post?.title||"",text:post?.text||"",media:(post?.mediaUrls||[]).join("\n"),date:time.toLocal(post?.scheduledAt,timezone),timezone,platformIds:post?.platformIds||[],dayKey:post?.dayKey||"",origin:post?.origin||"",captions:post?.captions||{},mediaSha256:post?.mediaSha256||"",meta:post?.meta||{}};
    setRaw(values);baseline=raw();
    const draft=drafts.get(key());if(draft){post=draft.post;baseline=draft.baseline;setRaw(draft.raw);}
    renderState();invalidate();renderVoice();
  };
  // Голос хранится отдельно от mediaUrls карточки: приватная ссылка открывается только в кабинете.
  let voiceEpoch=0;
  const voiceStatus=text=>{get("autoposting-voice-status").textContent=text;};
  const renderVoice=()=>{
    const version=++voiceEpoch,code=companyCode,postId=post?.id,body=get("autoposting-voice-body");voiceStatus("");
    if(!postId){body.innerHTML='<p class="autoposting-note">Сначала сохраните черновик ролика: запись привязывается к сохранённой карточке.</p>';return;}
    body.innerHTML='<p class="autoposting-note">Загружаем записи…</p>';
    const query="?companyCode="+encodeURIComponent(code)+"&postId="+encodeURIComponent(postId);
    const current=()=>version===voiceEpoch&&code===companyCode&&String(post?.id)===String(postId);
    ctx.apiJson("/content/voice-sources"+query).then(result=>{
      if(!current())return;if(result?.companyCode!==code||!Array.isArray(result.items))throw Error("Wrong company");
      const items=result.items.filter(item=>item.companyCode===code&&String(item.postId)===String(postId)&&/^\/content\/voice-sources\/\d+\?/.test(String(item.url)));
      body.innerHTML=(items.length?`<ul class="autoposting-voice-list">${items.map(item=>`<li><span>${esc(item.name)} · ${Math.max(1,Math.round(item.size/1024))} КБ · ${esc(String(item.createdAt||"").slice(0,16).replace("T"," "))}</span><audio controls preload="none" src="${esc(item.url)}" aria-label="Голос: ${esc(item.name)}"></audio></li>`).join("")}</ul>`:'<p class="autoposting-note">Записей пока нет.</p>')+
        (edit()?'<label class="plain-button autoposting-voice-pick">Добавить голосовую запись<input id="autoposting-voice-file" type="file" accept="audio/mp4,audio/x-m4a,audio/mpeg,audio/ogg,audio/wav,audio/x-wav,.m4a,.mp3,.ogg,.oga,.opus,.wav"></label>':"");
    }).catch(()=>{if(current())body.innerHTML='<p class="autoposting-note">Не удалось загрузить записи. Обновите страницу.</p>';});
  };
  const VOICE_EXT={m4a:"audio/mp4",mp3:"audio/mpeg",ogg:"audio/ogg",oga:"audio/ogg",opus:"audio/ogg",wav:"audio/wav"};
  const uploadVoice=file=>{
    const code=companyCode,postId=post?.id;if(!file||!postId||!edit())return;
    const type=VOICE_EXT[(/\.([a-z0-9]+)$/i.exec(file.name||"")?.[1]||"").toLowerCase()]||file.type;
    if(!/^audio\/(mp4|x-m4a|m4a|aac|mpeg|mp3|ogg|opus|wav|x-wav|wave|vnd\.wave)$/.test(type||"")||!file.size||file.size>25*1024*1024){voiceStatus("Нужна запись M4A, MP3, OGG или WAV до 25 МБ.");return;}
    voiceStatus("Загружаем запись…");const options=ctx.csrfOptions("POST");
    ctx.apiJson("/content/voice-sources?companyCode="+encodeURIComponent(code)+"&postId="+encodeURIComponent(postId)+"&name="+encodeURIComponent(file.name||""),{...options,body:file,headers:{...options.headers,"Content-Type":type}})
      .then(result=>{if(code!==companyCode||String(post?.id)!==String(postId))return;if(result?.item?.companyCode!==code)throw Error("Wrong company");renderVoice();voiceStatus("Запись сохранена и привязана к ролику.");})
      .catch(()=>{if(code===companyCode&&String(post?.id)===String(postId))voiceStatus("Не удалось загрузить запись. Нужен файл M4A, MP3, OGG или WAV до 25 МБ.");});
  };
  get("autoposting-voice-body").addEventListener("change",event=>{if(event.target.id==="autoposting-voice-file"){uploadVoice(event.target.files?.[0]);event.target.value="";}});
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
        <p data-channel-links>${[cabinet.platformLinks?.companyLink({companyCode,record:information,platform:channel.platform==='telegram'?'telegram_channel':channel.platform}),cabinet.platformLinks?.cabinetLink(channel.platform)].filter(Boolean).join(' · ')}</p>
        ${ctx.identity?.role!=='owner'?'<p class="autoposting-note">Onlypult подключает владелец Synapse. После подключения здесь можно готовить и планировать публикации своей компании.</p>':''}
        <label>Способ подключения<select data-channel-field="provider"><option value="direct"${!onlypult?' selected':''}>Напрямую</option><option value="onlypult"${onlypult?' selected':''}${ctx.identity?.role!=='owner'?' disabled':''}>Через Onlypult</option></select></label>
        ${onlypult?'<p class="autoposting-note">Подключите сообщество в Onlypult. Сохраните его ключ здесь, загрузите список профилей и выберите профиль этой компании.</p>'+(cabinet.platformLinks?.cabinetLink('onlypult') || ''):channel.platform==="vk"?'<p class="autoposting-note">Для администратора с уже выданным совместимым доступом. Эти поля не создают приложение ВК и не выдают разрешения.</p>':''}
        <label>Название канала<input data-channel-field="name" value="${esc(values.name||"")}" maxlength="200" required></label>
        ${onlypult?`<label>Профиль этой компании<select data-channel-field="target"><option value="">Сначала загрузите профили</option>${values.target&&!profiles.some(p=>p.id===values.target)?`<option value="${esc(values.target)}" selected>Сохранённый профиль ${esc(values.target)}</option>`:''}${profiles.map(p=>`<option value="${esc(p.id)}"${String(values.target)===p.id?' selected':''}>${esc(p.name)} · ${esc(p.id)}${p.status==='active'?'':' · требует подключения'}</option>`).join('')}</select></label><button class="plain-button" type="button" data-load-profiles="${esc(channel.id)}">Загрузить профили Onlypult</button>`:`<label>${channel.platform==="vk"?"ID сообщества (число или clubNNN)":"Канал (@name или -100…)"}<input data-channel-field="target" value="${esc(values.target||"")}" maxlength="200"></label>`}
        <label>${onlypult?"Ключ Onlypult для подключения":channel.platform==="vk"?"Новый ключ пользователя с правом wall":"Новый токен бота — администратора канала"}<input data-channel-field="token" type="password" autocomplete="new-password" maxlength="4096"></label>
        <label class="autoposting-checkbox"><input data-channel-field="enabled" type="checkbox"${values.enabled?" checked":""}>Разрешить автоматическую отправку</label>
        ${onlypult?'<p class="autoposting-note">Отправку можно разрешить после выбора профиля.</p>':''}
        <div class="autoposting-actions"><button class="plain-button" type="submit">Сохранить подключение</button><button class="plain-button" type="button" data-check-channel="${esc(channel.id)}">Проверить доступ</button></div>${onlypult&&ctx.identity?.role==='owner'?'<details data-profile-diagnostics hidden><summary>Технические сведения профилей</summary><div data-profile-diagnostics-content></div></details>':''}</form>`;
    }).join("");
    get("autoposting-planning").innerHTML=PLANNING.map(([id,title])=>{const publicLink=cabinet.platformLinks?.companyLink({companyCode,record:information,platform:id});return `<div><strong>${title}</strong><p>Планирование материалов. Автоматическая отправка не подключена.</p>${publicLink||"<span class=autoposting-note>Ссылка компании не указана.</span>"}<p>${cabinet.platformLinks?.cabinetLink(id)||""}</p></div>`;}).join("");
  };
  const localDay=item=>item.scheduledAt?time.toLocal(item.scheduledAt,zone()).slice(0,10):"";
  const today=()=>time.toLocal(new Date().toISOString(),zone()).slice(0,10);
  const addDays=(date,count)=>new Date(Date.parse(date+"T12:00:00Z")+count*86400000).toISOString().slice(0,10);
  const dateRange=()=>dailyView==='month'?{from:month+'-01',to:month+'-'+String(new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).getUTCDate()).padStart(2,'0')}:{from:today(),to:addDays(today(),30)};
  const dailyItems=()=>{
    const source=calendarData?[...calendarData.posts,...calendarData.undated]:posts;
    return source.map(item=>{
      const latest=posts.find(value=>value.id===item.id),value=latest&&latest.revision>=item.revision?{...item,...latest}:item;
      if(latest&&latest.revision>item.revision)value.calendarReadiness=null;
      const publishDate=localDay(value),plannedDate=item.plannedDate||null;
      return {...value,publishDate,plannedDate,effectiveDate:publishDate||plannedDate||null,dateKind:publishDate?'schedule':plannedDate?'plan':null};
    });
  };
  const platformsOf=item=>[...new Set([...(item.platformIds||[]).map(id=>channels().find(channel=>channel.id===id)?.platform||id),...Object.keys(item.captions||{}),...(item.planPlatform?[item.planPlatform]:[])])];
  const hasLocalChanges=item=>drafts.has(companyCode+':'+item.id)||(post?.id===item.id&&dirty());
  const canSelectApproval=item=>permitted(ctx,'approve')&&item?.companyCode===companyCode&&EDITABLE.has(item.status)&&item.readiness?.ready===true&&Number.isSafeInteger(item.contentRevision)&&Number.isSafeInteger(item.revision)&&!item.approval?.approved&&!item.deliveries?.some(value=>['published','publishing','needs_review'].includes(value.status))&&!hasLocalChanges(item)&&!approvalBlocked.has(String(item.id));
  const renderBatch=()=>{
    get('autoposting-batch').hidden=!permitted(ctx,'approve')||!approvalSelection.size;
    get('autoposting-batch-approve').textContent=`Согласовать выбранные (${approvalSelection.size})`;
    get('autoposting-selected-list').innerHTML=approvalSelection.size?'<p>Будут согласованы все выбранные материалы, в том числе за пределами текущего фильтра:</p><ul>'+[...approvalSelection.values()].map(item=>`<li>${esc(item.title)} · версия ${esc(item.contentRevision)} <button type="button" class="plain-button" data-daily-unselect="${esc(item.id)}">Убрать из выбора</button></li>`).join('')+'</ul>':'';
    get('autoposting-batch-results').innerHTML=approvalResults.size?'<ul>'+[...approvalResults.values()].map(result=>`<li>${esc(result.title)}: ${esc(result.message)}</li>`).join('')+'</ul>':'';
  };
  const renderDailyCard=item=>{
    const id=String(item.id),platforms=platformsOf(item),approved=item.approval?.approved&&!item.approval?.stale;
    const readiness=['published','publishing','cancelled'].includes(item.status)?'':approved?'Согласовано':item.readiness?.ready?'Готово к проверке':'Нужно подготовить';
    const issues=[...(item.readiness?.issues||[]),...(item.calendarReadiness?.issues||[])];
    const error=item.lastErrorCode?(ERRORS[item.lastErrorCode]||'Нужна проверка результата публикации. Откройте материал.'):'';
    const url=(item.mediaUrls||[]).map(safeUrl).find(Boolean),preview=url?(isVideo(url)?`<video data-reel-preview preload="metadata" playsinline src="${esc(url)}" aria-label="Материал: ${esc(item.title)}"></video><button type="button" class="autoposting-reel-play" aria-label="Смотреть ролик: ${esc(item.title)}"><span aria-hidden="true">▶</span></button><span class="autoposting-reel-error" hidden>Не удалось загрузить видео. Откройте материал для проверки файла.</span>`:`<img src="${esc(url)}" alt="Материал: ${esc(item.title)}" loading="lazy">`):'<span class="autoposting-no-media">Файл не добавлен</span>';
    const date=item.publishDate?`Время публикации: ${time.toLocal(item.scheduledAt,zone()).replace('T',' ')}`:item.plannedDate?`Дата плана: ${item.plannedDate} · время публикации не задано`:'Дата не задана';
    return `<li class="autoposting-daily-card" data-daily-post="${esc(id)}"><div class="autoposting-daily-media">${preview}</div><div class="autoposting-daily-content"><p class="autoposting-note">${esc(platforms.map(platformLabel).join(' · ')||'Площадка не выбрана')}</p><h4>${esc(item.title||'Без названия')}</h4><p>${esc(date)}</p>${item.publishDate&&item.plannedDate&&item.publishDate!==item.plannedDate?`<p>Дата плана: ${esc(item.plannedDate)}</p>`:''}<p><span class="autoposting-badge">${esc(STATUS[item.status]||'Статус неизвестен')}</span>${readiness?`<span class="autoposting-badge">${esc(readiness)}</span>`:""}</p>${item.text?`<p class="autoposting-daily-excerpt">${esc(item.text.slice(0,240))}${item.text.length>240?'…':''}</p>`:''}${error?`<p class="autoposting-issues">${esc(error)}</p>`:''}${issues.length?`<ul class="autoposting-issues">${[...new Set(issues)].map(issue=>`<li>${esc(issue)}</li>`).join('')}</ul>`:''}${platforms.some(platform=>!DELIVERY_CONNECTED.has(platform))?'<p class="autoposting-note">Для части площадок подготовлена подпись; доставка из кабинета не подключена.</p>':''}<button type="button" class="plain-button" data-open-post="${esc(id)}">Посмотреть${edit()&&EDITABLE.has(item.status)?' / изменить':''}</button>${permitted(ctx,'approve')?`<label class="autoposting-checkbox"><input type="checkbox" data-daily-approve="${esc(id)}" ${approvalSelection.has(id)?'checked':''} ${canSelectApproval(item)?'':'disabled'}>Выбрать для согласования · версия ${esc(item.contentRevision||item.revision)}</label>`:''}${hasLocalChanges(item)?'<p class="autoposting-note">Есть несохранённые правки. Сначала сохраните материал и проверьте его.</p>':''}</div></li>`;
  };
  const renderCalendar=()=>{
    if(!month)return;
    get('autoposting-calendar-zone').textContent=`Даты в часовом поясе ${zone()}. Сегодня: ${today()}. ${dailyView==='upcoming'?'Ближайшие 31 день.':''}`;
    get('autoposting-month-controls').hidden=dailyView!=='month';
    container.querySelectorAll('[data-daily-view]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.dailyView===dailyView)));
    get('autoposting-calendar-state').textContent=calendarPending?'Обновляем календарь…':calendarData?calendarData.truncated?'Список за период ограничен и может быть неполным.':calendarData.undatedTruncated?'Список материалов без даты ограничен. Показаны первые 200.':'':`Календарь за период недоступен. Показаны только загруженные материалы (до 200); список может быть неполным.`;
    const gaps=calendarData?.coverage?.basis==='current_plan'&&Array.isArray(calendarData.coverage.uncoveredDates)?[...new Set(calendarData.coverage.uncoveredDates.filter(date=>/^\d{4}-\d{2}-\d{2}$/.test(date)&&date>=today()&&date<=addDays(today(),2)))].sort():[];
    get('autoposting-plan-gaps').hidden=!gaps.length;
    get('autoposting-plan-gaps').textContent=gaps.length?'По текущему плану компании нужно подготовить публикацию к '+gaps.join(', ')+'.':'';
    get('autoposting-month').value=month;
    const items=dailyItems().filter(item=>!dailyPlatform||platformsOf(item).includes(dailyPlatform));
    const [year,m]=month.split('-').map(Number),start=new Date(Date.UTC(year,m-1,1)),days=new Date(Date.UTC(year,m,0)).getUTCDate();
    const offset=(start.getUTCDay()+6)%7;
    let html=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(day=>`<span class="autoposting-weekday">${day}</span>`).join('')+'<span></span>'.repeat(offset);
    for(let day=1;day<=days;day++){const date=month+'-'+String(day).padStart(2,'0'),total=items.filter(item=>item.effectiveDate===date).length;
      html+=`<button type="button" data-calendar-date="${date}" aria-pressed="${selectedDate===date}" aria-label="${date}: материалов ${total}">${day}${total?`<span>${total}</span>`:''}</button>`;}
    get('autoposting-calendar').innerHTML=html;
    const range=dateRange(),list=items.filter(item=>item.effectiveDate&&(dailyView==='today'?item.effectiveDate===today():item.effectiveDate>=(selectedDate||range.from)&&item.effectiveDate<=(selectedDate||range.to))).sort((a,b)=>a.effectiveDate.localeCompare(b.effectiveDate)||String(a.id).localeCompare(String(b.id)));
    const undated=items.filter(item=>!item.effectiveDate),overdue=items.filter(item=>item.effectiveDate&&item.effectiveDate<today()&&!['published','cancelled'].includes(item.status));
    get('autoposting-posts').innerHTML=(list.length?`<ul class="autoposting-daily-list">${list.map(renderDailyCard).join('')}</ul>`:'<p>В этом периоде материалов нет. Посмотрите ближайшие даты или материалы без даты.</p>'+(dailyView==='today'?'<button type="button" class="plain-button" data-daily-upcoming>Посмотреть материалы на ближайшие дни</button>':'' ))+(dailyView!=='month'&&overdue.length?`<details><summary>Ранее запланированные · ${overdue.length}</summary><ul class="autoposting-daily-list">${overdue.map(renderDailyCard).join('')}</ul></details>`:'')+(undated.length?`<details class="autoposting-undated"><summary>Без даты · ${undated.length}</summary><p>Дата публикации не назначена. Откройте материал, чтобы посмотреть или изменить его.</p><ul class="autoposting-daily-list">${undated.map(renderDailyCard).join('')}</ul></details>`:'');
    get('autoposting-posts').querySelectorAll('[data-reel-preview]').forEach(video=>{
      const frame=video.parentElement,button=frame.querySelector('.autoposting-reel-play');
      // Seek a paused frame so mobile browsers show the cover before the first play.
      video.addEventListener('loadedmetadata',()=>{if(video.paused&&Number.isFinite(video.duration)&&video.duration>0)video.currentTime=Math.min(.15,video.duration/2);},{once:true});
      video.addEventListener('play',()=>{video.controls=true;frame.classList.add('is-playing');});
      video.addEventListener('pause',()=>frame.classList.remove('is-playing'));
      video.addEventListener('ended',()=>{frame.classList.remove('is-playing');video.currentTime=Math.min(.15,video.duration/2);});
      video.addEventListener('error',()=>{button.hidden=true;frame.querySelector('.autoposting-reel-error').hidden=false;});
      button.addEventListener('click',()=>{video.controls=true;const play=video.play();if(play?.catch)play.catch(()=>{frame.classList.remove('is-playing');video.controls=true;});});
    });
    renderBatch();
  };
  const loadCalendar=async()=>{
    const version=epoch,calendarVersion=++calendarEpoch,code=companyCode,range=dateRange();calendarPending=true;calendarData=null;renderCalendar();controls();
    try{const result=await ctx.apiJson(endpoint('/autoposting/calendar')+'&from='+range.from+'&to='+range.to);
      if(version!==epoch||calendarVersion!==calendarEpoch)return;
      if(result.companyCode!==code||result.from!==range.from||result.to!==range.to||!Array.isArray(result.posts)||!Array.isArray(result.undated)||[...result.posts,...result.undated].some(item=>item.companyCode!==code))throw Error('Wrong calendar scope');
      calendarData=result;
      const merged=new Map(posts.map(item=>[item.id,item]));for(const item of [...result.posts,...result.undated])if(!merged.has(item.id)||merged.get(item.id).revision<item.revision)merged.set(item.id,item);posts=[...merged.values()];
    }catch(_){if(version===epoch&&calendarVersion===calendarEpoch)calendarData=null;}
    finally{if(version===epoch&&calendarVersion===calendarEpoch){calendarPending=false;renderList();controls();}}
  };
  const renderList=()=>{
    get("autoposting-select").innerHTML='<option value="">Новый черновик</option>'+posts.map(item=>`<option value="${esc(item.id)}">${esc(item.title)} — ${esc(STATUS[item.status]||"Статус неизвестен")}</option>`).join("");
    get("autoposting-select").value=post?String(post.id):"";renderCalendar();renderQueue();
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
  const selectPost=id=>{get("autoposting-editor").open=true;stash();post=posts.find(item=>String(item.id)===String(id))||null;selections.set(companyCode,post?.id||null);renderPost();get("autoposting-select").value=post?String(post.id):"";};
  const load=async(code,refresh=false)=>{
    stash();get("autoposting-photo").value="";get("autoposting-channels").querySelectorAll('input[type="password"]').forEach(node=>{node.value="";});
    get('autoposting-channels').querySelectorAll('[data-profile-diagnostics]').forEach(node=>node.remove());
    companyCode=code;const version=++epoch;calendarEpoch++;calendarData=null;calendarPending=false;approvalSelection.clear();approvalResults.clear();approvalBlocked.clear();renderBatch();posts=[];get('autoposting-posts').replaceChildren();get('autoposting-calendar').replaceChildren();get('autoposting-batch-results').replaceChildren();get('autoposting-calendar-state').textContent='';get('autoposting-calendar-zone').textContent='';get('autoposting-plan-gaps').hidden=true;get('autoposting-plan-gaps').textContent='';get('autoposting-editor').open=false;busy=true;settings=null;information=null;starterPlan=null;post=null;get("autoposting-company").value=code;renderStarterPlan();
    get('autoposting-channels').querySelectorAll('[data-channel-links]').forEach(node=>node.replaceChildren());get('autoposting-planning').replaceChildren();
    get("vk-connection-guide").innerHTML='<h3 id="vk-connection-title">Подключение ВКонтакте</h3><p>Загружаем настройки выбранной компании…</p>';controls();
    if(!code){busy=false;get("vk-connection-guide").textContent="Выберите доступную компанию.";message("Нет доступных компаний.");controls();return;}
    message("Загружаем материалы и подключения…");
    try{const result=await Promise.all([request("/autoposting/settings"),request("/autoposting/posts"),request("/company-information"),request('/autoposting/starter-plan')]);if(version!==epoch)return;
      if(result[1].companyCode!==code||result[2].companyCode!==code||result[3].companyCode!==code)throw Error("Wrong company");
      [settings,,information,starterPlan]=result;posts=Array.isArray(result[1].posts)?result[1].posts:[];
      month=refresh&&month?month:time.toLocal(new Date().toISOString(),zone()).slice(0,7);selectedDate="";
      post=posts.find(item=>item.id===selections.get(code))||null;
      renderChannels();renderList();renderPost();renderStarterPlan();message(edit()?"":"Доступ только для просмотра.");
      await loadCalendar();
    }catch(_){if(version===epoch){get("vk-connection-guide").textContent="Не удалось получить статус подключения выбранной компании. Обновите статусы.";message("Не удалось загрузить автопостинг. Ввод сохранён в текущем окне; повторите обновление.");}}
    finally{if(version===epoch){busy=false;controls();}}
  };
  form.addEventListener("input",event=>{stash();invalidate();if(event.target.id==="autoposting-media")renderMediaPreview();});form.addEventListener("change",()=>{stash();invalidate();});
  get("autoposting-import").addEventListener("click",()=>{
    if(busy||!edit()||!settings)return;let body;
    try{body=JSON.parse(get("autoposting-import-json").value);}catch(_){get("autoposting-import-state").textContent="Некорректный JSON пакета.";return;}
    if(!body||!Array.isArray(body.items)){get("autoposting-import-state").textContent="Ожидается объект с массивом items.";return;}
    void run(async current=>{const result=await request("/autoposting/import","POST",body);if(!current())return;if(result.companyCode!==companyCode)throw Error("Wrong company");
      const list=await request("/autoposting/posts");if(!current())return;posts=Array.isArray(list.posts)?list.posts:posts;renderList();
      const pending=Array.isArray(result.mediaPending)?result.mediaPending:[];
      get("autoposting-import-state").textContent=`Создано черновиков: ${result.created.length}, пропущено как дубли: ${result.skipped.length}. Одобрение и публикация не выполнялись.${pending.length?` Ждут загрузки видео: ${pending.map(item=>`${item.dayKey||"—"} ${item.file||"файл из пакета"}`).join(", ")}.`:""}`;message("Пакет импортирован как черновики.");
    },"Импортируем пакет…","Не удалось импортировать пакет. Проверьте JSON и ссылки на материалы (только HTTP(S)).");
  });
  form.addEventListener("submit",event=>{
    event.preventDefault();if(busy||!edit()||!settings||(post&&!EDITABLE.has(post.status))||!form.reportValidity())return;
    let data;try{data=read();}catch(error){message(error.message);return;}
    if(!data.title||(!data.text&&!Object.keys(data.captions).length)){message("Заполните название и текст материала или подписи площадок.");return;}
    void run(async current=>{const oldKey=key();const result=await request("/autoposting/posts"+(post?"/"+encodeURIComponent(post.id):""),post?"PATCH":"POST",{...data,...(post?{revision:post.revision}:{})});if(!current())return;
      drafts.delete(oldKey);post=result;posts=[result,...posts.filter(item=>item.id!==result.id)];selections.set(companyCode,result.id);renderList();renderPost();message("Черновик сохранён. Откройте предпросмотр перед постановкой в план.");
    },"Сохраняем черновик…","Не удалось сохранить. Ввод остался в форме; версия могла измениться в другом окне.");
  });
  get("autoposting-preview").addEventListener("click",()=>{
    if(busy||!post||dirty())return;const issues=problems();reviewed=post.revision;
    get("autoposting-preview-content").innerHTML=`<h4>${esc(post.title)}</h4><pre>${esc(post.text)}</pre><p>${post.scheduledAt?esc(time.toLocal(post.scheduledAt,post.timezone).replace("T"," ")+" · "+post.timezone):"Дата не задана"}</p>
      <p>Площадки: ${post.platformIds.map(id=>esc(channels().find(item=>item.id===id)?.name||id)).join(", ")||"не выбраны"}</p>
      ${(post.mediaUrls||[]).length?`<ul class="autoposting-media-preview">${mediaPreview(post.mediaUrls)}</ul>`:"<p>Материал не прикреплён.</p>"}
      ${isQueueCard(post)?`<p>Версия ${esc(post.revision)}${post.dayKey?" · день "+esc(post.dayKey):""}${post.origin?" · "+esc(post.origin):""}</p><div class="autoposting-platform-previews">${CAPTIONS.map(([id,label,limit])=>{const caption=post.captions?.[id]||post.text||"";return `<details${post.captions?.[id]?" open":""}><summary>${label} · ${caption.length} / ${limit}${caption.length>limit?" · превышен лимит":""}${post.captions?.[id]?"":" · общий текст"}${DELIVERY_CONNECTED.has(id)?"":" · вариант подготовлен, доставка не подключена"}</summary><pre>${esc(caption)}</pre></details>`;}).join("")}</div>`:""}
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
    if(!file){message("Выберите фото или видео с устройства.");return;}
    const media=raw().media.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);if(media.length>=10){message("Можно добавить до 10 материалов.");return;}
    const video=/^video\//.test(file.type);
    void run(async current=>{const uploaded=await cabinet.companyAssets.upload(ctx,companyCode,file,{details:true});if(!current())return;
      // Видео пакета заменяет прежние ссылки: у карточки один ролик, и хеш относится именно к нему.
      get("autoposting-media").value=(video?[uploaded.url]:[...media,uploaded.url]).join("\n");get("autoposting-media-sha").value=video?uploaded.sha256||"":"";get("autoposting-photo").value="";
      renderMediaPreview();renderMediaCheck();stash();invalidate();
      const expected=post?.expectedMediaSha256||"";
      message(video?(expected?(uploaded.sha256===expected?"Видео загружено, хеш совпадает с пакетом. Сохраните карточку.":"Видео загружено, но его хеш не совпадает с пакетом — это не тот ролик. Сохранить можно, одобрить нельзя."):"Видео загружено в черновик. Сохраните материал перед предпросмотром."):"Фото добавлено в черновик. Сохраните материал перед публикацией.");
    },video?"Загружаем видео…":"Загружаем фото…",video?"Не удалось загрузить видео. Нужен MP4 или WebM до 60 МБ.":"Не удалось загрузить фото. Нужен JPEG, PNG или WebP до 10 МБ.");
  });
  get("autoposting-refresh").addEventListener("click",()=>{void load(companyCode,true);});
  container.querySelectorAll('[data-daily-view]').forEach(node=>node.addEventListener('click',()=>{
    if(busy||!settings)return;dailyView=node.dataset.dailyView;selectedDate='';renderCalendar();controls();void loadCalendar();
  }));
  get('autoposting-daily-platform').addEventListener('change',()=>{dailyPlatform=get('autoposting-daily-platform').value;renderCalendar();controls();});
  get('autoposting-posts').addEventListener('change',event=>{
    const node=event.target.closest('[data-daily-approve]');if(!node)return;const item=posts.find(value=>String(value.id)===node.dataset.dailyApprove);
    if(busy||!canSelectApproval(item)){node.checked=false;return;}
    if(node.checked)approvalSelection.set(String(item.id),{id:item.id,companyCode,revision:item.revision,contentRevision:item.contentRevision,title:item.title});else approvalSelection.delete(String(item.id));
    renderBatch();controls();
  });
  get('autoposting-selected-list').addEventListener('click',event=>{const node=event.target.closest('[data-daily-unselect]');if(!node||busy||!permitted(ctx,'approve'))return;approvalSelection.delete(node.dataset.dailyUnselect);renderCalendar();controls();});
  get('autoposting-batch-approve').addEventListener('click',()=>{
    if(busy||calendarPending||!permitted(ctx,'approve')||!approvalSelection.size)return;
    const selected=[...approvalSelection.values()];
    void run(async current=>{
      for(const snapshot of selected){
        if(!current()||!permitted(ctx,'approve'))return;
        const id=String(snapshot.id);approvalSelection.delete(id);approvalBlocked.add(id);
        try{
          if(hasLocalChanges(snapshot))throw Error('Local changes');
          const latest=await request('/autoposting/posts/'+encodeURIComponent(id));if(!current())return;
          if(!permitted(ctx,'approve')||latest.companyCode!==snapshot.companyCode||latest.id!==snapshot.id||latest.revision!==snapshot.revision||latest.contentRevision!==snapshot.contentRevision||!latest.readiness?.ready||!EDITABLE.has(latest.status)||latest.deliveries?.some(item=>['published','publishing','needs_review'].includes(item.status)))throw Error('Version changed');
          const result=await request('/autoposting/posts/'+encodeURIComponent(id)+'/approve','POST',{revision:snapshot.revision,approved:true});if(!current())return;
          if(result.companyCode!==snapshot.companyCode||result.id!==snapshot.id||result.contentRevision!==snapshot.contentRevision||!result.approval?.approved)throw Error('Approval unconfirmed');
          posts=posts.map(item=>item.id===result.id?result:item);
          if(post?.id===result.id){post=result;renderPost();}
          approvalResults.set(id,{title:snapshot.title,message:`Согласована версия ${snapshot.contentRevision}. Публикация не запускалась.`});
        }catch(_){if(!current())return;approvalResults.set(id,{title:snapshot.title,message:'Согласование не подтверждено. Обновите статусы и проверьте версию перед новым выбором.'});}
        renderList();controls();
      }
      message('Проверка выбранных материалов завершена. Результат указан для каждой карточки; публикация не запускалась.');
    },'Согласуем выбранные версии…','Не удалось подтвердить согласование. Обновите статусы перед новым выбором.');
  });
  get("autoposting-select").addEventListener("change",()=>selectPost(get("autoposting-select").value));
  for(const id of ["autoposting-posts","autoposting-queue"])get(id).addEventListener("click",event=>{const button=event.target.closest("[data-open-post]");if(button){selectPost(button.dataset.openPost);get("autoposting-select").focus();}else if(event.target.closest("[data-daily-upcoming]")&&!busy&&settings){dailyView="upcoming";selectedDate="";renderCalendar();controls();void loadCalendar();}});
  const changeMonth=delta=>{const [year,m]=month.split("-").map(Number);month=new Date(Date.UTC(year,m-1+delta,1)).toISOString().slice(0,7);dailyView='month';selectedDate="";renderCalendar();controls();void loadCalendar();};
  get("autoposting-prev").addEventListener("click",()=>changeMonth(-1));get("autoposting-next").addEventListener("click",()=>changeMonth(1));
  get("autoposting-month").addEventListener("change",()=>{const value=get("autoposting-month").value;if(/^\d{4}-\d{2}$/.test(value)){month=value;dailyView='month';selectedDate="";renderCalendar();controls();void loadCalendar();}});
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
cabinet.registerView("autoposting",{title:"Материалы",render(container,context){if(!permitted(context,"view")){container?.replaceChildren();return;}if(!controller)controller=create(container,context);else controller.update(context);return controller.ready;},
  onProjectChange(context){if(permitted(context,"view"))return controller?.change(context);}});
})();
