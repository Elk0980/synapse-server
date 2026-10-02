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
  MEDIA_UNSUPPORTED:"Этот материал не поддерживается выбранной площадкой.",
  TIKTOK_PRIVACY_REQUIRED:"Для TikTok не выбран режим доступа. Выберите его в опциях материала — без выбора отправка не идёт.",
  TIKTOK_PRIVACY_UNCONFIRMED:"Отправка в TikTok остановлена: подтвердить, какие режимы доступа разрешены этому профилю, по нынешнему контракту Onlypult нельзя. Выбранный режим сохранён в плане; публиковать вслепую нельзя. TikTok подключённым не считается.",
  CHANNEL_MISCONFIGURED:"Канал настроен неверно: площадка и способ подключения не совпадают. Отправка остановлена."};
Object.assign(ERRORS,{EXTERNAL_PUBLICATION_RECORDED:"Площадка отмечена как опубликованная вне кабинета — отправка не выполнялась. Повторная отправка создала бы дубликат записи.",PROVIDER_PENDING:"Сервис принял задание. Ожидаем результат публикации.",PROVIDER_LINK_UNAVAILABLE:"Сервис сообщил о публикации. Проверьте запись в сообществе: ссылка пока не подтверждена.",PROVIDER_FAILED:"Сервис не смог опубликовать материал. Проверьте подробности в его кабинете.",PROVIDER_CHECK_FAILED:"Не удалось проверить результат. Проверьте подключение и повторите проверку статуса."});
const EDITABLE = new Set(["draft","needs_review","failed","cancelled"]);
// Ручные площадки сохраняют карточки со ссылками на компанию и внешний кабинет.
// Наличие 2ГИС в словаре плана не добавляет ей автоматическую доставку.
const PLANNING = [["two_gis","2ГИС"],["yandex_maps","Яндекс Карты"]];
/* Семь площадок Алви: единый словарь ПЛАНА и согласования, повторяет PLAN_PLATFORMS сервера.
   Он не зависит от того, какие каналы подключены: выбранная площадка остаётся в плане,
   даже когда доставка к ней недоступна, и честно помечается недоступной.
   delivery: "transport" — закрывается отправкой из Synapse при подключённом канале;
   "manual" — отправки из Synapse нет, закрывается вручную.
   limitSource: "confirmed" — лимит подписи из проверенного контракта площадки;
   "internal" — наш предел хранения, официальный лимит сервиса не проверен. */
const CAPTIONS = [["instagram","Instagram / Reels",2200,"transport","confirmed"],["tiktok","TikTok",2200,"transport","confirmed"],
  ["youtube_shorts","YouTube Shorts",5000,"transport","confirmed"],["vk","ВКонтакте",15000,"transport","confirmed"],
  ["telegram","Telegram",1024,"transport","confirmed"],["max","MAX",4000,"transport","confirmed"],
  ["two_gis","2ГИС",2000,"manual","internal"]];
const PLAN_DELIVERY = new Map(CAPTIONS.map(([id,,,delivery])=>[id,delivery]));
/* Подтверждение внешней публикации принимается только там, где формат адреса записи проверен.
   Список повторяет RECEIPT_PLATFORMS сервера; MAX и 2ГИС в него намеренно не входят. */
const RECEIPT_PLATFORMS = ["instagram","tiktok","youtube_shorts","vk","telegram"];
// Каналы без прямой интеграции: публикация только через Onlypult, способ подключения не выбирается.
const PROVIDER_ONLY = new Set(["youtube_shorts","instagram","tiktok","max"]);
const PROVIDER_HELP = {
  youtube_shorts:"Публикация только через Onlypult: нужны заголовок и ровно один видеофайл по HTTPS. Ролик выходит как Shorts в публичном доступе.",
  instagram:"Публикации, истории и Reels через Onlypult: нужны подпись и медиа; для Reel — ровно одно видео. Лимиты проверяются по профилю.",
  tiktok:"Для TikTok нужен один видеофайл. Отправка пока заблокирована: доступные профилю режимы видимости не подтверждены. Материал и выбранный режим можно сохранить в плане.",
  max:"Публикация через Onlypult: текст до 4000 символов и до 10 вложений. Вложения необязательны; ограничения дополнительно проверяются по профилю.",
};
/* Публикуемые опции площадок — тот же закрытый список, что на сервере. Опции входят в версию
   содержимого: их изменение снимает согласование, как правка текста. */
const PLATFORM_OPTIONS = [
  ["instagram",[["is_story","Публиковать как Story"],["is_reels","Публиковать как Reel"],["disable_comment","Отключить комментарии"]]],
  ["tiktok",[["disable_comment","Отключить комментарии"],["disable_duet","Запретить дуэты"],["disable_stitch","Запретить склейки"]]],
  ["max",[["pin_message","Закрепить сообщение"]]],
];
const TIKTOK_PRIVACY = [["","Не выбрано — отправка не пойдёт"],["PUBLIC_TO_EVERYONE","Публично для всех"],["SELF_ONLY","Только для себя"]];
/* Человеческие формулировки сохранённых опций для предпросмотра: владелец должен видеть
   утверждаемое поведение рядом с текстом, а не технические названия полей. */
const OPTION_WORDS = {
  instagram:{is_story:["Выйдет как Story","Как Story не выйдет"],is_reels:["Выйдет как Reel","Как Reel не выйдет"],
    disable_comment:["Комментарии отключены","Комментарии оставлены включёнными"]},
  tiktok:{disable_comment:["Комментарии отключены","Комментарии оставлены включёнными"],
    disable_duet:["Дуэты запрещены","Дуэты разрешены"],disable_stitch:["Склейки запрещены","Склейки разрешены"]},
  max:{pin_message:["Сообщение будет закреплено","Закрепление не запрашивается"]},
};
const optionWords = (platform,options) => {
  const words = [];
  if(platform==="tiktok")words.push("Кто увидит: "+(TIKTOK_PRIVACY.find(([id])=>id&&id===options.privacy)?.[1]||"не выбрано — отправка не пойдёт"));
  for(const [key,value] of Object.entries(options||{})){
    if(key==="privacy")continue;
    const pair=OPTION_WORDS[platform]?.[key];
    if(pair)words.push(value===true?pair[0]:pair[1]);
  }
  return words;
};
const PLATFORM_TITLE = {telegram:"Telegram",vk:"ВКонтакте",youtube_shorts:"YouTube Shorts"};
/* Единое правило ссылки на видео для YouTube Shorts во всех трёх проверках (кабинет, сервер, адаптер):
   разбирается как URL, схема только https, фрагмент пуст, расширение проверяется именно в пути.
   Поэтому jpg?name=.mp4 видео не считается, clip.mp4?version=1 проходит, clip.mp4#t=1 отклоняется. */
function isShortsVideoUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  let url;
  try {url = new URL(value);} catch {return false;}
  return url.protocol === 'https:' && url.hash === '' && /\.(mp4|mov|m4v|webm)$/i.test(url.pathname);
}
// Контент-план: формат и роль независимы; метаданные видны только в ЛК и не входят в подписи.
const FORMATS = [["post","Пост"],["story","Сторис"],["reel","Reels / Shorts / клип"],["carousel","Карусель"]];
/* CF3-BOARD: доска Контент-плана. ОВП — цель материала (Охват → Влюбление → Продажи), формат — отдельно.
   Статус карточки — одна понятная метка из уже существующих полей DTO (status, review, approval, deliveries);
   новых состояний кабинет не придумывает. Цвет площадки всегда дублируется подписью. */
const OVP = [["reach","Охват"],["affection","Влюбление"],["sale","Продажи"]];
// CF3-R1: одна подпись цели ОВП во всём модуле (доска, окно публикации, очередь). Значения в данных прежние: reach/affection/sale.
const ROLES = OVP;
const BOARD_STATUS = [["draft","Черновик"],["pending","Ждёт согласования"],["rework","На доработке"],["partial","Согласовано частично"],["approved","Согласовано"],
  ["scheduled","Запланировано"],["publishing","Публикуется"],["published","Опубликовано"],["failed","Ошибка отправки"],["uncertain","Результат уточняется"],["check","Нужна проверка"],["cancelled","Отменено"]];
const UNCERTAIN_CODES = new Set(["PUBLICATION_UNCERTAIN","PUBLICATION_REVIEW_REQUIRED","PROVIDER_PENDING"]);
const boardStatus = item => {
  if(["published","publishing","failed","scheduled","cancelled"].includes(item.status))return item.status;
  if(item.status==="needs_review")return (item.deliveries||[]).some(entry=>entry.status==="needs_review")||UNCERTAIN_CODES.has(item.lastErrorCode)?"uncertain":"check";
  if(item.approval?.approved&&!item.approval?.stale)return "approved";
  if((item.platformApprovals||[]).some(entry=>entry.approved))return "partial";
  if(item.review?.state==="pending")return "pending";
  if(item.review?.state==="rejected")return "rework";
  return "draft";
};
// CF3-R1: одна метка статуса для доски, окна публикации и списка «Открыть материал».
const statusLabel = item => BOARD_STATUS.find(([key])=>key===boardStatus(item))?.[1]||"Статус неизвестен";
const WEEKDAYS = ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];
/* CF4: замечания к версии (контракт CONTENT_FACTORY_CF4_REVIEW_CONTRACT_20261001). Отправка — существующий reject
   с необязательными annotations; время допустимо для любой категории; длительность сервер не проверяет. */
const NOTE_CATEGORIES = [["text","Текст"],["music","Музыка"],["visual","Изображение / видеоряд"],["other","Другое"]];
const TASK_STATUS = {inbox:"Входящие",planned:"Запланирована",in_progress:"В работе",done:"Выполнена",cancelled:"Отменена"};
const clock = ms => {if(!Number.isSafeInteger(ms)||ms<0)return "";const total=Math.floor(ms/1000),h=Math.floor(total/3600),m=Math.floor(total%3600/60),sec=total%60,tenth=Math.floor(ms%1000/100);
  return (h?`${h}:${String(m).padStart(2,"0")}`:String(m).padStart(2,"0"))+":"+String(sec).padStart(2,"0")+(tenth?`.${tenth}`:"");};
// «12», «0:12», «00:12.5», «1:02:03» → миллисекунды; неверный ввод → null.
const parseClock = value => {const text=String(value||"").trim().replace(",",".");if(!/^\d{1,2}(?::\d{1,2}){0,2}(?:\.\d{1,3})?$/.test(text))return null;
  const [main,frac=""]=text.split("."),parts=main.split(":").map(Number);if(parts.slice(1).some(n=>n>59))return null;
  const seconds=parts.reduce((sum,n)=>sum*60+n,0),ms=seconds*1000+Number((frac+"00").slice(0,3));return ms<=86400000?ms:null;};
const fileName = url => {try{return decodeURIComponent(new URL(url).pathname.split("/").pop()||url);}catch(_){return String(url||"");}};
const hintButton = (id,label,text) => `<button type="button" class="ap-hint" aria-label="Подсказка: ${esc(label)}" aria-expanded="false" aria-controls="ap-hint-${id}">?</button><span class="ap-hint-text" id="ap-hint-${id}" role="note" hidden>${esc(text)}</span>`;
/* CF5: подсказки «?» у полей карточки — короткое пояснение с примером, раскрывается по кнопке.
   Подпись связана с полем через for, поэтому кнопка не попадает в доступное имя поля. */
const field = (id,label,control,hint) => `<div class="ap-field"><label for="${id}">${label}</label>${hintButton("f-"+id,label,hint)}${control}</div>`;
const META_HINTS = {audience:"Для кого снимаем. Например: «мамы перед выпиской, 25–35 лет».",hook:"Что зритель увидит и услышит в первые 3 секунды. Например: «Шары уже ждут у роддома».",
  idea:"Одна мысль ролика. Например: «курьер встречает маму у выхода с шарами».",hughNote:"Почему материал может сработать. Например: «эмоция встречи, короткий ролик до 15 секунд».",
  metrics:"Что смотрим после выхода. Например: «досмотры до конца и сохранения».",methodSource:"Откуда приём. Например: «курс по Reels, урок 3»."};
/* CF5: удаление черновика. Удалить можно только то, что не стоит в плане и не отправлялось;
   запланированное сначала снимается с публикации отдельной кнопкой. Сервер проверяет то же самое. */
const PLATFORMS_LEGEND = `<legend class="ap-field-legend"><span id="ap-platforms-title">Куда опубликовать</span>${hintButton("f-autoposting-platforms","Куда опубликовать","Где должен выйти материал. Отметка — это план и согласование, а не отправка. Например: Telegram и ВКонтакте.")}</legend>`;
const ARCHIVABLE = new Set(["draft","failed","cancelled"]);
const archivedAt = item => item?.archive?.archivedAt||null;
const isActive = item => Boolean(item)&&!archivedAt(item);
const MONTHS_GEN = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const MONTHS_SHORT = ["янв","фев","мар","апр","мая","июн","июл","авг","сен","окт","ноя","дек"];
const daysOfMonth = value => {const [year,m]=value.split("-").map(Number),count=new Date(Date.UTC(year,m,0)).getUTCDate();return Array.from({length:count},(_,i)=>value+"-"+String(i+1).padStart(2,"0"));};
const weekdayOf = date => (new Date(date+"T12:00:00Z").getUTCDay()+6)%7;
// Недели доски — с понедельника, внутри выбранного месяца: первая и последняя бывают короче семи дней.
const weeksOf = value => {const out=[];for(const date of daysOfMonth(value)){if(!out.length||weekdayOf(date)===0)out.push([]);out.at(-1).push(date);}return out;};
const weekIndexOf = (value,date) => Math.max(0,weeksOf(value).findIndex(days=>days.includes(date)));
const dayLabel = date => `${WEEKDAYS[weekdayOf(date)]}, ${Number(date.slice(8))} ${MONTHS_SHORT[Number(date.slice(5,7))-1]}`;
const weekLabel = days => {const first=days[0],last=days.at(-1),name=MONTHS_GEN[Number(first.slice(5,7))-1];
  return (first===last?`${Number(first.slice(8))}`:`${Number(first.slice(8))}–${Number(last.slice(8))}`)+` ${name} ${first.slice(0,4)}`;};
const REVIEW = {draft:"Черновик",pending:"На согласовании",approved:"Согласовано",rejected:"На доработке"};
const META_TEXT = [["audience","Аудитория (для кого снимаем)",500],["hook","Хук — первые 3 секунды",500],["idea","Идея / сценарий (одна мысль)",4000],["hughNote","Комментарий Хью: почему может сработать",2000],["metrics","Что измеряем (удержание, репосты, сохранения)",1000],["methodSource","Источник методики",300]];
const HISTORY_LABEL = {submitted:"отправлено на согласование",approved:"согласовано",rejected:"возвращено на доработку",revoked:"согласование снято",edited:"правка",reordered:"порядок изменён",rescheduled:"плановая дата изменена"};
const DAYS = ["","D1","D2","D3","D4","D5","D6","D7"];
const isVideo = url => /\.(mp4|webm|mov|m4v)(?:[?#].*)?$/i.test(url);
const mediaPreview = urls => (urls||[]).map(url=>{const safe=safeUrl(url);if(!safe)return "<li>Некорректная ссылка на материал</li>";
  const player=isVideo(safe)?`<video class="autoposting-video" controls preload="metadata" playsinline src="${esc(safe)}"></video>`:cabinet.companyAssets?.imageUrl?.(url)||/\.(jpe?g|png|webp|gif)(?:[?#].*)?$/i.test(safe)?`<img class="autoposting-thumbnail" src="${esc(safe)}" alt="Материал публикации" loading="lazy">`:"";
  return `<li>${player}<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a></li>`;}).join("");
const isQueueCard = item => Boolean(item?.dayKey||Object.keys(item?.captions||{}).length);
// Сторис с материалом и без подписи — законный формат (текст на кадре, стикеры ставятся нативно):
// сторис по плану (формат) или по публикуемому режиму Instagram. Формат плана сам ничего не отправляет.
const mediaOnlyStory = data => (data?.mediaUrls||[]).length>0&&!data.text&&!Object.keys(data.captions||{}).length
  &&(data.format==="story"||data.platformOptions?.instagram?.is_story===true);
// Без текста транспорт Synapse отправляет только Instagram Story через Onlypult; остальные каналы — с текстом.
const storyTargetNote = name => `${name}: без текста Synapse отправляет только Instagram Story (включите «Публиковать как Story» и выберите Instagram); для этого канала транспорт Synapse требует текст.`;
const requiresApproval = item => Boolean(item?.approvalRequired||isQueueCard(item));
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
// Ссылка из уведомления только открывает карточку. Одобрение всегда остаётся
// отдельным действием с текущим предпросмотром и серверной проверкой версии.
function materialLink(hash) {
  const match=/^#(?:content-factory\/(?:plan|materials)|autoposting)\?(.+)$/.exec(hash);
  if(!match)return null;
  const query=new URLSearchParams(match[1]),company=query.get('company'),id=Number(query.get('post')),revision=Number(query.get('revision'));
  if([...query.keys()].some(key=>!['company','post','revision'].includes(key))||
    ['company','post','revision'].some(key=>query.getAll(key).length!==1)||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(company||'')||!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(revision)||revision<1)
    return {error:true,key:hash};
  return {company,id,revision,key:`${company}:${id}:${revision}`};
}
let controller;
const DELETABLE_STATUSES=new Set(["draft","cancelled","failed","needs_review"]);
function create(container, context) {
  const time = cabinet.companyTime;
  let ctx=context, companyCode="", settings=null, information=null, starterPlan=null, posts=[], post=null, busy=false, epoch=0, baseline=null, reviewed=null;
  let selectedDate="", month="", week=0, overview=false, filtersOpen=false, editorOpener=null, calendarData=null, calendarEpoch=0, calendarPending=false;
  const boardFilter={platform:"",format:"",role:"",status:""};
  const approvalSelection=new Map(), approvalResults=new Map(), approvalBlocked=new Set();
  let archived=null, archivedState="", archivedLimited=false, archivedEpoch=0, archiveConfirm=false, archiveFocus=null;
  const drafts=new Map(), selections=new Map(), channelDrafts=new Map(), providerProfiles=new Map();
  let pendingLink=null,handledLink='',linkEpoch=0,trashPosts=[],deleteArmed="";
  const companies=(ctx.identity.companies||[]).map(item=>({code:String(item.id),name:item.name||item.id}));
  container.classList.add("autoposting-view");
  container.innerHTML=`<h2 class="autoposting-sr-only">Контент-план</h2>
    <p id="autoposting-status" role="status" aria-live="polite"></p>
    <section class="card autoposting-calendar-section ap-board-section" aria-label="Доска публикаций">
    <div class="ap-board-nav"><button class="plain-button" id="autoposting-prev-week" type="button" aria-label="Предыдущая неделя">←</button><strong id="autoposting-week-label" class="ap-week-label" aria-live="polite"></strong><button class="plain-button" id="autoposting-next-week" type="button" aria-label="Следующая неделя">→</button>
      <label class="ap-nav-field">Месяц<input type="month" id="autoposting-month"></label><label class="ap-nav-field">Перейти к дате<input type="date" id="autoposting-jump"></label>
      <button class="plain-button" id="autoposting-overview" type="button" aria-pressed="false" aria-controls="autoposting-month-controls">Обзор месяца</button></div>
    <div class="ap-filters-bar"><button class="plain-button ap-filters-toggle" id="autoposting-filters-toggle" type="button" aria-expanded="false" aria-controls="autoposting-filters">Фильтры</button>
      <div id="autoposting-filters" class="ap-filters" role="group" aria-label="Фильтры доски">
      <label>Площадка<select id="autoposting-daily-platform"><option value="">Все площадки</option>${CAPTIONS.map(([id,label])=>`<option value="${id}">${label}</option>`).join("")}</select></label>
      <label>Формат<select id="autoposting-filter-format"><option value="">Все форматы</option>${FORMATS.map(([id,label])=>`<option value="${id}">${label}</option>`).join("")}<option value="none">Формат не указан</option></select></label>
      <label>Цель ОВП<select id="autoposting-filter-role"><option value="">Все цели</option>${OVP.map(([id,label])=>`<option value="${id}">${label}</option>`).join("")}<option value="none">Цель не указана</option></select></label>
      <label>Статус<select id="autoposting-filter-status"><option value="">Все статусы</option>${BOARD_STATUS.map(([id,label])=>`<option value="${id}">${label}</option>`).join("")}</select></label>
      <span id="autoposting-filter-count" class="autoposting-note" role="status"></span><button class="plain-button" id="autoposting-filter-reset" type="button">Сбросить</button></div></div>
    <p id="autoposting-calendar-zone" class="autoposting-note"></p><p id="autoposting-calendar-state" role="status"></p><p id="autoposting-plan-gaps" role="status" hidden></p>
    <div id="autoposting-month-controls" hidden><div id="autoposting-calendar" class="autoposting-calendar"></div></div>
    <nav id="autoposting-day-strip" class="ap-day-strip" aria-label="Дни недели"></nav>
    <div id="autoposting-batch"><p>Флажок на карточке — только выбор. Решение применяется к каждому выбранному материалу отдельно после нажатия кнопки ниже. Публикация не запускается.</p><fieldset id="autoposting-batch-platforms"><legend>Площадки решения</legend><label class="autoposting-checkbox"><input type="radio" name="autoposting-batch-scope" value="all" checked>Все площадки выбранных материалов</label><label class="autoposting-checkbox"><input type="radio" name="autoposting-batch-scope" value="subset">Только отмеченные ниже</label>${CAPTIONS.map(([id,label])=>`<label class="autoposting-checkbox"><input type="checkbox" data-batch-platform="${esc(id)}">${esc(label)}</label>`).join("")}<p class="autoposting-note">Решение применяется к пересечению отмеченных площадок с площадками каждой карточки. Материал без общих площадок пропускается — с указанием причины.</p></fieldset><div id="autoposting-selected-list"></div><button type="button" class="plain-button" id="autoposting-batch-approve" disabled>Согласовать выбранные (0)</button><label class="autoposting-batch-reason">Причина возврата на доработку (обязательна)<textarea id="autoposting-batch-reason" rows="2" maxlength="2000"></textarea></label><button type="button" class="danger" id="autoposting-batch-reject" disabled>Вернуть выбранные на доработку (0)</button></div><div id="autoposting-batch-results" role="status" aria-live="polite"></div><div id="autoposting-posts"></div><details id="autoposting-archive" class="ap-archive"><summary>Удалённые материалы</summary><p class="autoposting-note">Черновики, удалённые из плана. Восстановленный материал вернётся черновиком — без согласования и даты отправки.</p><div id="autoposting-archive-list"></div></details></section>
    <details class="autoposting-workspace-tools"><summary>Компания и настройки</summary>    <div class="autoposting-toolbar"><label for="autoposting-company">Компания</label><select id="autoposting-company">${companies.map(item=>`<option value="${esc(item.code)}">${esc(item.name)}</option>`).join("")}</select><button class="plain-button" id="autoposting-refresh" type="button">Обновить статусы</button><a href="#company-information">Данные компании</a></div>
    <details class="card autoposting-advanced"><summary>Подключения и подготовка материалов</summary><section class="card vk-connection-guide" id="vk-connection-guide" aria-labelledby="vk-connection-title"></section>
    <details class="card autoposting-connections"><summary>Подключение площадок</summary><p class="autoposting-note">Пустой ключ сохраняет прежний. Новый ключ применяется только кнопкой сохранения; после изменения канала проверьте доступ. Проверка не публикует посты.</p><div id="autoposting-channels" class="autoposting-channel-grid"></div><div id="autoposting-planning" class="autoposting-planning"></div></details>
    <section class="card autoposting-starter" id="autoposting-starter-plan" hidden></section></details>
</details>
    <details class="card autoposting-trash" id="autoposting-trash" hidden><summary>Корзина · <span id="autoposting-trash-count">0</span></summary><p class="autoposting-note">Удалённые материалы не показываются в списках и календаре, не согласуются и не публикуются. Файлы, тексты и история сохраняются; материал можно восстановить.</p><ul id="autoposting-trash-list" class="autoposting-daily-list"></ul></details>
    <details id="autoposting-editor" class="autoposting-editor" role="dialog" aria-modal="true" aria-labelledby="autoposting-editor-title"><summary>Редактор публикации</summary><div class="ap-editor-bar"><strong id="autoposting-editor-title" tabindex="-1">Публикация</strong><span id="autoposting-editor-note" class="autoposting-note"></span><button class="plain-button" id="autoposting-editor-close" type="button">Закрыть</button></div><div class="autoposting-editor-grid"><section class="card ap-editor-fields" aria-labelledby="ap-editor-fields-title"><h3 id="ap-editor-fields-title">Материал</h3>${field("autoposting-select","Открыть материал",'<select id="autoposting-select"><option value="">Новый черновик</option></select>',"Какую карточку править. «Новый черновик» — пустая форма. Например: «Отзыв клиента — Черновик».")}<p id="autoposting-post-state" class="ap-editor-state"></p><p id="autoposting-post-error" role="status" hidden></p><div id="autoposting-deliveries"></div>
    <form id="autoposting-form">${field("autoposting-title","Название в кабинете",'<input id="autoposting-title" maxlength="200" required>',"Видно в кабинете и на доске. Для YouTube Shorts это ещё и заголовок ролика — до 100 символов. Например: «Шары на выписку — отзыв».")}
    <fieldset id="autoposting-platforms" aria-labelledby="ap-platforms-title">${PLATFORMS_LEGEND}</fieldset>
    <div class="autoposting-date-fields ap-editor-plan-fields">${field("autoposting-format","Формат",`<select id="autoposting-format"><option value="">Не указан</option>${FORMATS.map(([v,l])=>`<option value="${v}">${l}</option>`).join("")}</select>`,"Вид материала. В подпись не попадает. Например: «Reels / Shorts / клип».")}${field("autoposting-role","Цель (ОВП)",`<select id="autoposting-role"><option value="">Не указана</option>${ROLES.map(([v,l])=>`<option value="${v}">${l}</option>`).join("")}</select>`,"Зачем материал: Охват → Влюбление → Продажи. В подпись не попадает. Например: «Охват» — для тех, кто видит вас впервые.")}</div>
    <div class="autoposting-date-fields">${field("autoposting-date","Дата и время",'<input id="autoposting-date" type="datetime-local">',"Когда отправить. Можно оставить пустым — черновик сохранится без даты. Например: 15.10.2026, 18:00.")}${field("autoposting-timezone","Часовой пояс",'<input id="autoposting-timezone" maxlength="80" required placeholder="Asia/Irkutsk">',"Пояс, в котором указано время, — не пояс вашего компьютера. Например: Europe/Moscow.")}</div>
    ${field("autoposting-text","Текст публикации",'<textarea id="autoposting-text" rows="9" maxlength="20000"></textarea>',"Общая подпись. Идёт на все площадки, где не задана своя. Например: «Шары к выписке за 2 часа — пишите в Telegram».")}
    ${field("autoposting-photo","Фото или видео с устройства",'<input id="autoposting-photo" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm">',"Фото JPEG, PNG или WebP до 10 МБ; видео MP4 или WebM до 60 МБ. Выберите файл и нажмите «Загрузить файл». Для фото во ВКонтакте нужно подключение Onlypult. Например: ролик 9:16 в MP4.")}<button class="plain-button" id="autoposting-upload" type="button">Загрузить файл</button><input type="hidden" id="autoposting-media-sha"><p id="autoposting-media-check" class="autoposting-note"></p>
    <details class="autoposting-captions"><summary>Подписи площадок (7)</summary><div class="ap-field ap-field-group"><span class="ap-field-title">Своя подпись для площадки</span>${hintButton("f-autoposting-captions","Подписи площадок",`Пустая подпись — значит, используется общий текст. Например, для TikTok короче: «Шары за 2 часа». Подтверждённые лимиты площадок: ${CAPTIONS.filter(([,,,,source])=>source==="confirmed").map(([,l,n])=>`${l} — ${n}`).join(", ")}. Для 2ГИС официальный лимит не подтверждён: ${CAPTIONS.find(item=>item[0]==="two_gis")[2]} — это наш внутренний предел поля, а не ограничение 2ГИС.`)}</div>${CAPTIONS.map(([id,label,limit,,source])=>`<label>${label}${source==="internal"?" · внутренний предел поля":""}<textarea data-caption="${id}" rows="3" maxlength="${limit}"></textarea><span class="autoposting-note" data-caption-count="${id}"></span></label>`).join("")}</details>
    <details class="autoposting-options"><summary>Публикуемые опции площадок</summary><div class="ap-field ap-field-group"><span class="ap-field-title">Настройки выхода на площадке</span>${hintButton("f-autoposting-options","Публикуемые опции","Меняют то, что выйдет на площадке, поэтому их правка снимает согласование. Для TikTok обязательно выберите, кто увидит. Например: TikTok — «Все».")}</div>${PLATFORM_OPTIONS.map(([platform,fields])=>`<fieldset data-options="${platform}"><legend>${esc(CAPTIONS.find(item=>item[0]===platform)[1])}</legend>${platform==='tiktok'?`<label>Кто увидит<select data-option="tiktok.privacy">${TIKTOK_PRIVACY.map(([v,l])=>`<option value="${v}">${l}</option>`).join("")}</select></label>`:''}${fields.map(([key,label])=>`<label class="autoposting-checkbox"><input type="checkbox" data-option="${platform}.${key}">${label}</label>`).join("")}</fieldset>`).join("")}</details>
    <details class="autoposting-meta"><summary>Для команды · источники и ссылки</summary>    <div class="autoposting-date-fields">${field("autoposting-day","День карточки",`<select id="autoposting-day">${DAYS.map(d=>`<option value="${d}">${d||"—"}</option>`).join("")}</select>`,"День в пакете из семи карточек — нужен для импорта. Обычно не меняется. Например: D3.")}${field("autoposting-origin","Происхождение материала",'<input id="autoposting-origin" maxlength="200" placeholder="например: видео Gemini, без надписи ИИ">',"Откуда материал — видно только команде. Например: «видео Gemini, без надписи ИИ».")}</div>
    ${field("autoposting-media","Материалы по ссылкам",'<textarea id="autoposting-media" rows="3" placeholder="https://example.com/video.mp4"></textarea>',"Открытые ссылки на файлы, по одной в строке, до 10. Например: https://example.com/video.mp4.")}
</details>
    <details class="autoposting-meta"><summary>Для команды · аудитория, хук, идея</summary><p class="autoposting-note">Служебные поля плана. В публичную подпись не попадают.</p>
    ${META_TEXT.map(([id,label,limit])=>field("ap-meta-"+id,label,`<textarea id="ap-meta-${id}" data-meta="${id}" rows="${id==="idea"?4:2}" maxlength="${limit}"></textarea>`,META_HINTS[id])).join("")}</details>
    <button class="plain-button" id="autoposting-save" type="submit">Сохранить черновик</button><p id="autoposting-form-status" aria-live="off"></p></form></section>
    <section class="card autoposting-preview-section ap-editor-preview" aria-labelledby="autoposting-preview-title"><h3 id="autoposting-preview-title" tabindex="-1">Проверка перед публикацией</h3>
    <div class="ap-editor-media"><ul id="autoposting-media-preview" class="autoposting-media-preview" data-empty="Файл ещё не добавлен"></ul></div>
    <div class="autoposting-actions"><button class="plain-button" id="autoposting-preview" type="button">Предпросмотр</button><button class="plain-button" id="autoposting-cancel" type="button" hidden>Снять с публикации</button><button class="plain-button" id="autoposting-reconcile" type="button" hidden>Проверить результат в сервисе</button></div><details class="autoposting-workspace-tools"><summary>Дополнительные действия</summary><button class="plain-button" id="autoposting-delete" type="button" hidden>Удалить в корзину</button></details><div id="autoposting-archive-zone" class="ap-archive-zone"></div>
    <div id="autoposting-preview-content"><p>Сохраните материал и откройте предпросмотр.</p></div><div id="autoposting-approval" class="autoposting-approval"></div><div id="autoposting-variant" class="ap-variant-zone"></div><div id="autoposting-receipts" class="autoposting-receipts"></div><button class="plain-button" id="autoposting-schedule" type="button" disabled>Поставить в план</button><p class="autoposting-note">После постановки в план материал отправляется автоматически. Уже начатую публикацию площадка может завершить после отмены.</p></section></div>
    </details><details class="card autoposting-queue-section"><summary>Для команды · очередь и импорт</summary><h3>Очередь контента</h3><p class="autoposting-note">Карточки дней с подписями пяти площадок. Согласование относится к конкретной версии: правка текста или материала снимает его. Галочки по умолчанию сняты; сохранение и согласование ничего не публикуют. Instagram / Reels, TikTok и YouTube Shorts здесь — подготовленные варианты подписей: их доставка не подключена и не заявляется; автоматическая отправка возможна только в подключённые каналы Telegram и ВКонтакте после постановки в план.</p><div id="autoposting-queue"></div>
    <details class="autoposting-import"><summary>Импорт пакета карточек</summary><p class="autoposting-note">JSON вида {"items":[{"dayKey":"D1","title":"…","mediaUrls":["https://…/d1.mp4"],"captions":{"instagram":"…","tiktok":"…","youtube_shorts":"…","vk":"…","telegram":"…"},"origin":"видео Gemini"}]}. Создаются только черновики без согласования; отсутствующее видео не подставляется. Повтор пакета не создаёт дубли.</p><textarea id="autoposting-import-json" rows="6"></textarea><button class="plain-button" id="autoposting-import" type="button">Импортировать черновики</button><p id="autoposting-import-state" role="status"></p></details></details>`;
  const get=id=>container.querySelector("#"+id), form=get("autoposting-form");
  const edit=()=>permitted(ctx,"edit"), zone=()=>information?.profile?.timezone||settings?.timezone||"UTC";
  const channels=()=>Array.isArray(settings?.channels)?settings.channels:[];
  /* Готовность доставки — отдельно от согласования. Согласование говорит «владелец принял версию»,
     готовность — «есть подключённый канал, которым её можно отправить». Неподключённая площадка
     остаётся в плане и честно помечается: опубликованной она от этого не становится. */
  const deliveryState=id=>{
    if(PLAN_DELIVERY.get(id)==='manual')return {ready:false,manual:true,label:'отправки из кабинета нет — закрывается вручную'};
    const channel=channels().find(item=>item.id===id);
    if(!channel)return {ready:false,manual:false,label:'канал не настроен'};
    if(!channel.connected)return {ready:false,manual:false,label:'доступ не подтверждён'};
    if(!channel.enabled)return {ready:false,manual:false,label:'отправка выключена'};
    return {ready:true,manual:false,label:'подключён'};
  };
  /* Площадки массового решения. «Все» — прежнее поведение (поле platformIds не передаётся).
     Подмножество — пересечение отмеченных площадок с площадками конкретной карточки:
     решение никогда не расширяется на площадки, которых владелец не отмечал. */
  const batchScope=()=>container.querySelector('[name="autoposting-batch-scope"]:checked')?.value||'all';
  const batchPlatforms=()=>[...container.querySelectorAll('[data-batch-platform]:checked')].map(node=>node.dataset.batchPlatform);
  const batchTargets=item=>{
    if(batchScope()==='all')return null;
    const chosen=batchPlatforms();
    return (item?.platformIds||[]).filter(id=>chosen.includes(id));
  };
  const endpoint=path=>"/content/crm"+path+"?companyCode="+encodeURIComponent(companyCode);
  const request=(path,method,body)=>ctx.apiJson(endpoint(path),method?ctx.csrfOptions(method,body):undefined);
  const message=text=>{get("autoposting-status").textContent=text;get("autoposting-form-status").textContent=text;};
  const renderProfileDiagnostics=(channel,diagnostics)=>{
    if(ctx.identity?.role!=='owner')return;
    const card=[...get('autoposting-channels').querySelectorAll('[data-channel]')].find(node=>node.dataset.channel===channel.id),details=card?.querySelector('[data-profile-diagnostics]');
    if(!details)return;const lines=profileShapeLines(diagnostics),content=details.querySelector('[data-profile-diagnostics-content]');
    content.replaceChildren();for(const line of lines){const paragraph=document.createElement('p');paragraph.textContent=line;content.append(paragraph);}details.hidden=!lines.length;
  };
  /* Опции — закрытый набор, и у каждого переключателя ТРИ состояния, которые не смешиваются:
     поля нет (владелец его не трогал — площадка решает сама), false (владелец явно снял) и
     true (владелец явно включил). Отсутствие поля не считается доказанным эквивалентом false
     у провайдера, поэтому новые false прежним карточкам не проставляются: false появляется
     только там, где он уже был сохранён, либо там, где владелец сам снял включённый ранее
     переключатель в этой сессии. Поэтому нужен снимок сохранённых опций. */
  let optionsBaseline={};
  const optionTouched=new Set();
  const readOptions=()=>{
    const out={};
    for(const [platform,fields] of PLATFORM_OPTIONS){
      const saved=optionsBaseline?.[platform]||{};
      const value={};
      if(platform==='tiktok'){
        const privacy=container.querySelector('[data-option="tiktok.privacy"]').value;
        if(privacy)value.privacy=privacy;
      }
      for(const [key] of fields){
        const node=container.querySelector(`[data-option="${platform}.${key}"]`);
        const path=platform+'.'+key;
        if(node.checked)value[key]=true;
        // false сохраняется, если он уже был в карточке или владелец сам снял этот переключатель.
        else if(Object.hasOwn(saved,key)||optionTouched.has(path))value[key]=false;
      }
      if(Object.keys(value).length)out[platform]=Object.fromEntries(Object.keys(value).sort().map(item=>[item,value[item]]));
    }
    return Object.fromEntries(Object.keys(out).sort().map(key=>[key,out[key]]));
  };
  const writeOptions=values=>{
    optionsBaseline=values&&typeof values==='object'&&!Array.isArray(values)?values:{};
    optionTouched.clear();
    for(const [platform,fields] of PLATFORM_OPTIONS){
      const saved=optionsBaseline?.[platform]||{};
      if(platform==='tiktok')container.querySelector('[data-option="tiktok.privacy"]').value=
        TIKTOK_PRIVACY.some(([id])=>id&&id===saved.privacy)?saved.privacy:'';
      for(const [key] of fields)container.querySelector(`[data-option="${platform}.${key}"]`).checked=saved[key]===true;
    }
  };
  const raw=()=>({title:get("autoposting-title").value,text:get("autoposting-text").value,media:get("autoposting-media").value,
    date:get("autoposting-date").value,timezone:get("autoposting-timezone").value,dayKey:get("autoposting-day").value,origin:get("autoposting-origin").value,mediaSha256:get("autoposting-media-sha").value,
    captions:Object.fromEntries(CAPTIONS.map(([id])=>[id,container.querySelector(`[data-caption="${id}"]`).value])),
    meta:{format:get("autoposting-format").value,role:get("autoposting-role").value,...Object.fromEntries(META_TEXT.map(([id])=>[id,container.querySelector(`[data-meta="${id}"]`).value]))},
    platformIds:[...get("autoposting-platforms").querySelectorAll("input:checked")].map(node=>node.value),
    platformOptions:readOptions()});
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
    writeOptions(values.platformOptions||{});
  };
  const read=()=>{
    const values=raw(), mediaUrls=values.media.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
    if(mediaUrls.length>10||mediaUrls.some(value=>!safeUrl(value)))throw Error("Укажите до 10 HTTP(S)-ссылок без логина и пароля.");
    if(!time.validZone(values.timezone))throw Error("Укажите существующий часовой пояс, например Asia/Irkutsk.");
    let scheduledAt=null;
    try {if(values.date)scheduledAt=time.toUTC(values.date,values.timezone);}catch(_){throw Error("Выбранное местное время не существует или неоднозначно. Укажите другое время.");}
    const captions={};for(const [id,,limit] of CAPTIONS){const value=(values.captions[id]||"").trim();if(value.length>limit)throw Error(`Подпись ${CAPTIONS.find(c=>c[0]===id)[1]} длиннее ${limit} символов.`);if(value)captions[id]=value;}
    const metaOut={format:values.meta.format||"",role:values.meta.role||""};for(const [id] of META_TEXT)metaOut[id]=(values.meta[id]||"").trim();
    const options=values.platformOptions||{};
    if(options.instagram?.is_story===true&&options.instagram?.is_reels===true)throw Error("Story и Reel — разные режимы Instagram: выберите один.");
    return {title:values.title.trim(),text:values.text.trim(),mediaUrls,platformIds:values.platformIds,scheduledAt,timezone:values.timezone,profileRevision:information.revision,dayKey:values.dayKey,origin:values.origin.trim(),captions,mediaSha256:values.mediaSha256||"",platformOptions:options,...metaOut};
  };
  const problems=({approving=false}={})=>{
    const result=[];let data;
    try{data=read();}catch(error){return [error.message];}
    const storyOnly=mediaOnlyStory(data);
    if(!data.title||(!data.text&&!Object.keys(data.captions).length&&!storyOnly))result.push("Заполните название и текст или подписи площадок.");
    if(!data.scheduledAt||Date.parse(data.scheduledAt)<=Date.now())result.push("Выберите дату и время в будущем.");
    if(!data.platformIds.length)result.push("Выберите подключённый канал публикации.");
    if(!Number.isSafeInteger(information?.revision)||information.revision<1)result.push("Сначала сохраните данные компании в разделе «Актуальность».");
    if(post&&post.profileRevision!==information.revision)result.push("Данные компании изменились. Проверьте текст и сохраните его заново.");
    if(post?.deliveries?.some(item=>["published","publishing","needs_review"].includes(item.status)))result.push("Материал уже отправлялся на площадку. Проверьте опубликованное вручную: автоматический повтор может создать дубль.");
    if(!approving&&post&&requiresApproval(post)&&!post.approval?.approved&&!approvedPlatforms(post).length)result.push("Ни одна площадка этой версии ещё не согласована.");
    const marked=receiptPlatforms(post);
    // Проверяются ровно те площадки, которые уйдут в план: при частичном согласовании это только
    // согласованные каналы, и неподключённый несогласованный канал отправке не мешает.
    const targets=approving?data.platformIds:scheduleTargets(post,data.platformIds);
    // Требования YouTube проверяются только если этот канал действительно уходит в план:
    // несогласованный YouTube не должен блокировать согласованный Telegram.
    if(targets.includes('youtube_shorts')){
      if(data.title.length>100)result.push('YouTube Shorts: название станет публичным заголовком, сократите его до 100 символов.');
      if(data.mediaUrls.length!==1||!data.mediaUrls.every(isShortsVideoUrl))
        result.push('YouTube Shorts: нужен ровно один видеофайл по HTTPS — mp4, mov, m4v или webm.');
    }
    for(const id of targets){
      const channel=channels().find(item=>item.id===id);
      // Площадка с подтверждением внешней публикации повторно не отправляется: сервер откажет, и дубликат не нужен.
      if(marked.has(channel?.platform||id))result.push(`${channel?.name||id}: площадка отмечена как опубликованная вне ЛК. Повторная отправка создаст дубликат.`);
      if(!channel?.connected||!channel.enabled){result.push((channel?.name||id)+": включите канал и проверьте доступ.");continue;}
      if(post?.approveAndScheduleAvailable&&!data.mediaUrls.length&&(channel.provider||'direct')!=='direct')result.push(`${channel.name||id}: текст без медиа поддержан только прямыми Telegram и ВКонтакте.`);
      const maxText=channel.platform==="telegram"&&data.mediaUrls.length?1024:(channel.caps?.maxText|| (channel.platform==="vk"?15000:4096));
      const maxMedia=Number.isSafeInteger(channel.caps?.maxMedia)?channel.caps.maxMedia:(channel.platform==="vk"?1:10);
      const channelText=data.captions[channel.platform]||data.text;
      if(!channelText&&storyOnly&&!((channel.platform||id)==="instagram"&&data.platformOptions?.instagram?.is_story===true))result.push(storyTargetNote(channel.name||id));
      else if(!channelText&&!storyOnly)result.push(`${channel.name||id}: нет ни общего текста, ни подписи площадки.`);
      if(channelText.length>maxText)result.push(`${channel.name||id}: текст до ${maxText} символов${data.mediaUrls.length&&channel.platform==="telegram"?" с изображениями":""}.`);
      if(data.mediaUrls.length>maxMedia)result.push(`${channel.name||id}: материалов не больше ${maxMedia}.`);
    }
    return result;
  };
  const readyToSchedule=()=>post&&EDITABLE.has(post.status)&&!dirty()&&reviewed===post.revision&&!problems().length;
  const readyToApproveAndSchedule=()=>post?.approveAndScheduleAvailable&&edit()&&permitted(ctx,'approve')
    &&EDITABLE.has(post.status)&&post.readiness?.ready&&!dirty()&&reviewed===post.revision&&!problems({approving:true}).length;
  const controls=()=>{
    container.setAttribute("aria-busy",String(busy));
    if(ctx.identity?.role!=='owner')get('autoposting-channels').querySelectorAll('[data-profile-diagnostics]').forEach(node=>node.remove());
    container.querySelectorAll("input,textarea,select,button").forEach(node=>{node.disabled=busy||!settings;});
    get("autoposting-company").disabled=busy||!companies.length;
    get('autoposting-batch').hidden=!permitted(ctx,'approve')||!approvalSelection.size;
    get('autoposting-batch-approve').disabled=busy||calendarPending||!settings||!permitted(ctx,'approve')||!approvalSelection.size;
    get('autoposting-batch-reject').disabled=busy||calendarPending||!settings||!permitted(ctx,'approve')||!approvalSelection.size;
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
    // Счётчик сам объясняет происхождение предела: внутренний предел поля не выдаётся за лимит площадки.
    for(const [id,,limit,,source] of CAPTIONS){const node=container.querySelector(`[data-caption-count="${id}"]`);const len=container.querySelector(`[data-caption="${id}"]`).value.length;node.textContent=`${len} / ${limit}`+(source==="internal"?" · внутренний предел поля, лимит площадки не подтверждён":"");node.classList.toggle("autoposting-over",len>limit);}
    get("autoposting-schedule").disabled=busy||!edit()||!readyToSchedule();
    const approveSchedule=get('autoposting-approve-schedule');if(approveSchedule)approveSchedule.disabled=busy||!readyToApproveAndSchedule();
    get("autoposting-cancel").hidden=!post||!["scheduled","publishing"].includes(post.status);
    get("autoposting-cancel").disabled=busy||!edit();
    get("autoposting-reconcile").hidden=!post?.deliveries?.some(item=>item.providerPostId);
    get("autoposting-reconcile").disabled=busy||!edit();
    // Удалить можно только то, что не стоит в очереди и не отправляется; сервер проверяет это ещё раз.
    const deleteButton=get("autoposting-delete");deleteButton.hidden=!post||!edit()||!DELETABLE_STATUSES.has(post.status);deleteButton.disabled=busy||dirty();
    if(!post||deleteArmed!==post.id+":"+post.revision){deleteArmed="";deleteButton.textContent="Удалить в корзину";}
    get("autoposting-trash-list").querySelectorAll("[data-trash-restore]").forEach(node=>{node.disabled=busy||!edit();node.hidden=!edit();});
    const importButton=get('autoposting-import-plan');if(importButton)importButton.disabled=busy||!edit()||Boolean(starterPlan?.imports?.[get('autoposting-plan-platform').value]);
    const archiveButton=get("autoposting-archive-button");if(archiveButton){archiveButton.disabled=busy||dirty();get("autoposting-archive-note").textContent=dirty()?"Сначала сохраните правки или закройте их без сохранения.":"";}
    const archiveYes=get("autoposting-archive-yes");if(archiveYes)archiveYes.disabled=busy;const archiveNo=get("autoposting-archive-no");if(archiveNo)archiveNo.disabled=busy;
    container.querySelectorAll("[data-restore-post]").forEach(node=>{node.disabled=busy||!edit();});
    // Подсказки — только чтение: доступны и при просмотре, и пока идёт запрос.
    container.querySelectorAll(".ap-hint").forEach(node=>{node.disabled=false;});
  };
  const invalidate=()=>{reviewed=null;get("autoposting-preview-content").innerHTML="<p>Предпросмотр не выполнен или устарел. Сохраните изменения и проверьте материал заново.</p>";get("autoposting-media-preview").closest(".ap-editor-media").hidden=false;controls();};
  const renderMediaPreview=()=>{const urls=get("autoposting-media").value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean).slice(0,10);get("autoposting-media-preview").innerHTML=mediaPreview(urls);};
  // Сверка загруженного ролика с пакетом материалов: без совпадения SHA-256 карточка не считается готовой.
  const renderMediaCheck=()=>{
    const node=get("autoposting-media-check"),expected=post?.expectedMediaSha256||"",actual=get("autoposting-media-sha").value;
    node.textContent=!expected?"":!actual?`Ожидается ролик из пакета${post?.expectedMediaFile?" "+post.expectedMediaFile:""}: загрузите его через кабинет, хеш сверится автоматически.`:actual===expected?"Хеш загруженного файла совпадает с пакетом.":"Загруженный файл не совпадает с роликом из пакета: это не то видео.";
    node.classList.toggle("autoposting-over",Boolean(expected&&actual&&actual!==expected));
  };
  /* ---------- CF4: замечания к версии ---------- */
  const pendingNotes=new Map();
  const notesKey=item=>companyCode+":"+item.id;
  const pendingFor=item=>pendingNotes.get(notesKey(item))||[];
  const noteWhere=(note,mediaUrls)=>note.timingKind==="whole"?"ко всему материалу"
    :`${clock(note.startMs)}${Number.isSafeInteger(note.endMs)?"–"+clock(note.endMs):""} · ${note.timingKind==="material"?`в файле №${note.mediaIndex+1}${mediaUrls?.[note.mediaIndex]?` (${fileName(mediaUrls[note.mediaIndex])})`:""}`:"пожелание к монтажу"}`;
  const categoryLabel=id=>NOTE_CATEGORIES.find(([key])=>key===id)?.[1]||id;
  // История замечаний и связанная задача — только факты из DTO. Текст выводится экранированным.
  const historyOpen=new Set();
  const reviewTrailMarkup=item=>{
    const groups=Array.isArray(item.reviewNotes)?[...item.reviewNotes].reverse():[],tasks=Array.isArray(item.reviewTasks)?item.reviewTasks:[];
    const notes=groups.map(group=>{
      const current=group.contentRevision===item.contentRevision;
      return `<li class="ap-note-group" data-note-group="${esc(group.id)}"><p class="autoposting-note">Версия содержимого v${esc(group.contentRevision)}${current?" (текущая)":" — прежняя версия, файлы с тех пор могли измениться"} · ${esc(group.actorName||"—")} · ${esc(time.toLocal(group.createdAt,zone()).replace("T"," "))}</p>
        <ol>${(group.annotations||[]).map(note=>`<li><strong>${esc(categoryLabel(note.category))}</strong> · ${esc(noteWhere(note,group.mediaUrls))} — <span data-note-comment>${esc(note.comment)}</span></li>`).join("")}</ol></li>`;
    }).join("");
    const task=tasks.map(entry=>`<li data-review-task="${esc(entry.taskId)}">Задача №${esc(entry.taskId)} · версия v${esc(entry.contentRevision)} · ${esc(TASK_STATUS[entry.status]||entry.status)} · ${entry.assigneeName?"исполнитель "+esc(entry.assigneeName):"Не назначен"} · ${entry.dueDate?"срок "+esc(entry.dueDate):"Срок не указан"}</li>`).join("");
    /* CF6: полная история свёрнута; сверху — компактная последняя доработка. DTO не обрезается: в списке все группы и версии. */
    const total=groups.reduce((sum,group)=>sum+(group.annotations||[]).length,0),latest=groups[0],first=latest?.annotations?.[0];
    const last=latest?`<p class="ap-review-last" data-review-last>Последняя доработка: замечаний ${(latest.annotations||[]).length} · версия v${esc(latest.contentRevision)}${latest.contentRevision===item.contentRevision?" (текущая)":""} · ${esc(latest.actorName||"—")} · ${esc(when(latest.createdAt))}${first?` — <span class="ap-review-last-text">${esc(categoryLabel(first.category))}: ${esc(first.comment)}</span>`:""}</p>`:"";
    return (groups.length?`<div class="ap-review-history">${last}<details class="ap-review-notes" data-review-history="${esc(item.id)}"${historyOpen.has(`${companyCode}:${item.id}`)?" open":""}><summary>Вся история замечаний: групп ${groups.length} · замечаний ${total}</summary><ul class="ap-note-groups">${notes}</ul></details></div>`:"")
      +(tasks.length?`<div class="ap-review-tasks"><h4>Задачи доработки</h4><ul>${task}</ul><p class="autoposting-note">Задача создана во входящих. Назначение и срок — в <a href="#tasks">Задачах</a>; уведомления отсюда не отправляются.</p></div>`:"");
  };
  const rejectMarkup=item=>{
    const media=item.mediaUrls||[],locked=item.status==="publishing"||item.status==="published";
    return `<form id="autoposting-reject-form" class="autoposting-reject" novalidate><h4>Вернуть на доработку</h4>
      ${field("autoposting-reject-comment","Что передать исполнителю (обязательно)",'<textarea id="autoposting-reject-comment" rows="2" maxlength="2000" required></textarea>',"Главное, что нужно переделать, одной-двумя фразами. Подробности по моментам — в замечаниях ниже. Например: «Светлее фон и другой трек».")}
      <ol id="ap-notes-pending" class="ap-notes-pending" aria-live="polite"></ol>
      <fieldset class="ap-note-form"><legend>Добавить замечание</legend>
        <div class="ap-note-row"><label for="ap-note-category">Категория</label>${hintButton("note-category","Категория","Что поправить: текст, музыку, изображение или видеоряд. Например: «Текст» — надпись на фото.")}
          <select id="ap-note-category">${NOTE_CATEGORIES.map(([id,label])=>`<option value="${id}">${label}</option>`).join("")}</select></div>
        <div class="ap-note-row"><label for="ap-note-comment">Замечание</label>${hintButton("note-comment","Замечание","Что и почему изменить. Например: «На 00:12 заменить надпись — закрывает композицию».")}
          <textarea id="ap-note-comment" rows="2" maxlength="2000"></textarea></div>
        <button type="button" class="plain-button" id="ap-note-time-toggle" aria-expanded="false" aria-controls="ap-note-time">Указать момент</button>
        <div id="ap-note-time" class="ap-note-time" hidden>
          <fieldset><legend>К чему относится время</legend>${hintButton("note-kind","Привязка времени","В файле — момент в уже загруженном файле этой версии. Пожелание к монтажу — время в будущем ролике, когда файла ещё нет.")}
            <label class="autoposting-checkbox"><input type="radio" name="ap-note-kind" value="material"${media.length?" checked":" disabled"}>В файле публикации${media.length?"":" (файла нет)"}</label>
            <label class="autoposting-checkbox"><input type="radio" name="ap-note-kind" value="editing_wish"${media.length?"":" checked"}>Пожелание к монтажу</label></fieldset>
          ${media.length?`<label>Файл<select id="ap-note-media">${media.map((url,index)=>`<option value="${index}">№${index+1} · ${esc(fileName(url))}</option>`).join("")}</select></label>`:""}
          <div class="autoposting-date-fields"><label>Начало<input id="ap-note-start" inputmode="decimal" placeholder="00:12" maxlength="12"></label><label>Конец (необязательно)<input id="ap-note-end" inputmode="decimal" placeholder="00:15" maxlength="12"></label></div>
          ${hintButton("note-time","Время","Минуты и секунды: 00:12 или 1:05. Для интервала укажите конец. Длительность файла сервер не проверяет.")}
          <button type="button" class="plain-button" id="ap-note-mark">Отметить текущий момент</button><p class="autoposting-note" id="ap-note-mark-note">Берёт время из проигрываемого видео в колонке предпросмотра.</p></div>
        <p class="cf-error ap-note-error" id="ap-note-error" role="alert" hidden></p>
        <button type="button" class="plain-button" id="ap-note-add">Добавить замечание</button></fieldset>
      <button class="danger" type="submit" id="ap-reject-submit"${locked?" disabled":""}>Вернуть на доработку</button></form>`;
  };
  const renderPendingNotes=()=>{
    const list=get("ap-notes-pending");if(!list||!post)return;const notes=pendingFor(post);
    list.innerHTML=notes.map((note,index)=>`<li>${note.contentRevision!==post.contentRevision?'<strong class="ap-card-warning">Версия изменилась — проверьте: </strong>':""}<strong>${esc(categoryLabel(note.category))}</strong> · ${esc(noteWhere(note,post.mediaUrls))} — ${esc(note.comment)} <button type="button" class="plain-button" data-note-remove="${index}" aria-label="Убрать замечание ${index+1}">Убрать</button></li>`).join("");
    const submit=get("ap-reject-submit");if(submit)submit.textContent=notes.length?`Вернуть на доработку · замечаний: ${notes.length}`:"Вернуть на доработку";
  };
  const noteError=text=>{const node=get("ap-note-error");if(node){node.textContent=text;node.hidden=!text;}};
  // Видео берётся из видимого списка файлов: после предпросмотра — из него, иначе — из колонки файлов формы.
  const markVideo=()=>{const index=Number(get("ap-note-media")?.value??-1);
    const lists=[get("autoposting-preview-content").querySelector(".autoposting-media-preview"),get("autoposting-media-preview")].filter(list=>list&&!list.closest("[hidden]"));
    return lists[0]?.children[index]?.querySelector("video")||null;};
  const bindNoteForm=()=>{
    const form=get("autoposting-reject-form");if(!form)return;renderPendingNotes();
    get("ap-note-time-toggle").addEventListener("click",event=>{const panel=get("ap-note-time"),open=panel.hidden;panel.hidden=!open;event.currentTarget.setAttribute("aria-expanded",String(open));event.currentTarget.textContent=open?"Без указания момента":"Указать момент";});
    get("ap-note-mark").addEventListener("click",()=>{
      const kind=form.querySelector('[name="ap-note-kind"]:checked')?.value,video=kind==="material"?markVideo():null;
      if(!video||!Number.isFinite(video.currentTime)){noteError("Отметка доступна у видео в колонке предпросмотра: включите его и остановите на нужном кадре. Для фото и пожелания к монтажу укажите время вручную.");return;}
      get("ap-note-start").value=clock(Math.round(video.currentTime*1000));noteError("");
    });
    get("ap-note-add").addEventListener("click",()=>{
      if(!post)return;const comment=get("ap-note-comment").value.trim(),category=get("ap-note-category").value,timed=!get("ap-note-time").hidden;
      if(!comment){noteError("Напишите, что исправить.");return;}
      if(pendingFor(post).length>=30){noteError("За один возврат — не больше 30 замечаний.");return;}
      const note={category,comment,timingKind:"whole",startMs:null,endMs:null,mediaIndex:null,contentRevision:post.contentRevision};
      if(timed){
        const kind=form.querySelector('[name="ap-note-kind"]:checked')?.value,start=parseClock(get("ap-note-start").value),endText=get("ap-note-end").value.trim(),end=endText?parseClock(endText):null;
        if(!["material","editing_wish"].includes(kind)){noteError("Выберите, к чему относится время.");return;}
        if(start===null){noteError("Укажите начало: минуты и секунды, например 00:12.");return;}
        if(endText&&end===null){noteError("Конец указан неверно: минуты и секунды, например 00:15.");return;}
        if(end!==null&&end<start){noteError("Конец раньше начала.");return;}
        note.timingKind=kind;note.startMs=start;note.endMs=end;
        if(kind==="material"){
          note.mediaIndex=Number(get("ap-note-media")?.value);
          if(!Number.isInteger(note.mediaIndex)||!(post.mediaUrls||[])[note.mediaIndex]){noteError("Выберите файл этой версии.");return;}
          const video=markVideo(),duration=video&&Number.isFinite(video.duration)?Math.round(video.duration*1000):null;
          if(duration!==null&&(start>duration||(end!==null&&end>duration))){noteError(`Момент позже конца ролика (${clock(duration)}).`);return;}
        }
      }
      pendingNotes.set(notesKey(post),[...pendingFor(post),note]);noteError("");get("ap-note-comment").value="";get("ap-note-start")&&(get("ap-note-start").value="");get("ap-note-end")&&(get("ap-note-end").value="");
      renderPendingNotes();get("ap-note-comment").focus?.();
    });
    get("ap-notes-pending").addEventListener("click",event=>{const node=event.target.closest("[data-note-remove]");if(!node||!post)return;
      const notes=pendingFor(post).filter((_,index)=>index!==Number(node.dataset.noteRemove));if(notes.length)pendingNotes.set(notesKey(post),notes);else pendingNotes.delete(notesKey(post));renderPendingNotes();});
  };
  /* CF23: полная история карточки — GET …/history по курсору (limit 30, before=nextBefore) до конца. Состояние — по компании
     и карточке; подгрузка меняет только тело блока истории, форма и замечания не пересоздаются. Встроенные записи карточки
     до загрузки и при ошибке названы предварительными — это не весь журнал. */
  const fullHistory=new Map(),historyOpenFull=new Set();
  const historyKey=id=>companyCode+":"+id;
  const HISTORY_PAGE=30;
  const fullHistoryItem=h=>`<li data-history-id="${esc(h.id)}">${esc(HISTORY_LABEL[h.action]||h.action)} · содержимое v${esc(h.contentRevision)} · ${esc(time.toLocal(h.createdAt,zone()).replace("T"," "))} · ${h.actorName?esc(h.actorName):"исполнитель не указан"}${h.comment?` — ${esc(h.comment)}`:""}</li>`;
  const historyBody=item=>{
    const state=fullHistory.get(historyKey(item.id)),embedded=(item.history||[]).slice(0,10);
    const prelim=embedded.length?`<p class="autoposting-note" data-history-preliminary-note>Предварительно — последние записи из карточки (${embedded.length}), не вся история.</p><ul data-history-preliminary>${embedded.map(h=>`<li>${esc(HISTORY_LABEL[h.action]||h.action)} · содержимое v${esc(h.contentRevision)} · ${esc(h.actorName||"—")} · ${esc(time.toLocal(h.createdAt,zone()).replace("T"," "))}${h.comment?` — ${esc(h.comment)}`:""}</li>`).join("")}</ul>`:"";
    const retry='<button class="plain-button" type="button" data-history-retry>Повторить</button>';
    if(!state)return `<p class="autoposting-note" data-history-state="idle">Полная история загрузится при раскрытии.</p>${prelim}`;
    if(!state.items.length){
      if(state.state==="loading")return `<p class="autoposting-note" data-history-state="loading" role="status">Загружаем полную историю…</p>${prelim}`;
      if(state.state==="error")return `<p class="autoposting-issues" data-history-state="error" role="alert">${esc(state.error)}</p>${retry}${prelim}`;
      return '<p class="autoposting-note" data-history-state="done">Записей истории нет.</p>';
    }
    const foot=state.state==="loading"?'<p class="autoposting-note" data-history-state="loading" role="status">Загружаем следующие записи…</p>'
      :state.state==="error"?`<p class="autoposting-issues" data-history-state="error" role="alert">${esc(state.error)}</p>${retry}`
      :state.hasMore?'<button class="plain-button" type="button" data-history-more>Показать ещё</button>'
      :`<p class="autoposting-note" data-history-state="done">Это вся история: записей ${state.items.length}.</p>`;
    return `<p class="autoposting-note" data-history-count>Полная история · загружено записей: ${state.items.length}${state.hasMore?", есть ещё":""}.</p><ol class="ap-history-list" data-history-full>${state.items.map(fullHistoryItem).join("")}</ol>${foot}`;
  };
  const paintHistory=id=>{
    if(!post||String(post.id)!==String(id))return;
    const body=container.querySelector(`[data-ap-history="${Number(id)}"] [data-ap-history-body]`);if(body)body.innerHTML=historyBody(post);
  };
  const historyError=error=>error.status===403?"Нет права просматривать историю этой карточки. Это не пустая история."
    :error.status===404?"Карточка не найдена в этой компании — история не показана."
    :[405,501].includes(error.status)?"Полная история на сервере пока не подключена."
    :error.status===400?`Сервер не принял запрос истории: ${error.message}.`
    :`Полная история не загрузилась${error.message?` (${error.message})`:""}.`;
  const loadHistory=async(id,more=false)=>{
    const key=historyKey(id),code=companyCode,version=epoch,source=post&&String(post.id)===String(id)?post:null;
    let state=fullHistory.get(key);
    if(state?.state==="loading")return;
    if(more){if(!state||!state.hasMore&&state.state!=="error")return;}
    else if(state&&state.state!=="error")return;
    if(!state||!more&&!state.items.length)state={state:"loading",items:[],ids:new Set(),hasMore:false,nextBefore:null,revision:source?.revision,token:0,error:""};
    state.state="loading";state.error="";const token=++state.token;fullHistory.set(key,state);paintHistory(id);
    const before=state.items.length?state.nextBefore:null;
    try{
      const page=await ctx.apiJson(endpoint("/autoposting/posts/"+encodeURIComponent(id)+"/history")+"&limit="+HISTORY_PAGE+(before?"&before="+encodeURIComponent(before):""));
      if(version!==epoch||fullHistory.get(key)!==state||state.token!==token)return; // другая компания, сброс или более новый запрос
      if(page?.companyCode!==code||Number(page.postId)!==Number(id)||!Array.isArray(page.items)||typeof page.hasMore!=="boolean")throw Object.assign(new Error("ответ не относится к этой карточке"),{scope:true});
      if(page.hasMore&&!(Number.isSafeInteger(page.nextBefore)&&page.nextBefore>0))throw Object.assign(new Error("сервер не указал, откуда продолжить"),{scope:true});
      let added=0;
      for(const item of page.items)if(item&&Number.isSafeInteger(item.id)&&!state.ids.has(item.id)){state.ids.add(item.id);state.items.push(item);added++;}
      if(page.hasMore&&!added)throw Object.assign(new Error("следующая страница не принесла новых записей"),{scope:true});
      state.hasMore=page.hasMore;state.nextBefore=page.hasMore?page.nextBefore:null;state.state="ok";
    }catch(error){
      if(version!==epoch||fullHistory.get(key)!==state||state.token!==token)return;
      state.state="error";state.error=historyError(error)+(state.items.length?" Уже загруженные записи сохранены.":" Ниже — только предварительные записи из карточки.");
    }
    paintHistory(id);
  };
  /* CF23: версия для площадки — отдельный черновик на сервере (POST …/variants). Ключ и тело хранятся до ответа: потерянный ответ
     повторяется тем же ключом, второй версии не будет. После ответа — свежий GET новой карточки: квитанция повтора — исторический DTO. */
  const VARIANT_PLATFORMS=[["telegram","Telegram"],["vk","ВКонтакте"],["instagram","Instagram"],["youtube_shorts","YouTube Shorts"],["tiktok","TikTok"],["rutube","RUTUBE"],["max","MAX"]];
  const variantLabel=id=>VARIANT_PLATFORMS.find(([key])=>key===id)?.[1]||id;
  const VARIANT_ERRORS={PLAN_LINKED_POST:"Этот материал пришёл из контент-плана. Версию для другой площадки создайте как отдельную версию идеи в плане и согласуйте её там — копия в обход согласования плана не создаётся. Ничего не создано.",
    POST_ARCHIVED:"Карточка удалена — восстановите её, чтобы создать версию. Ничего не создано.",
    REVISION_CONFLICT:"Карточка уже изменена в другом окне. Обновите статусы и повторите. Ничего не создано.",
    REQUEST_CONFLICT:"Этот запрос уже использован для другой версии. Ничего не создано — обновите статусы и проверьте материалы."};
  const variantJobs=new Map(),variantOpen=new Set();let variantBusy=-1;
  const newRequestId=()=>{try{if(window.crypto?.randomUUID)return window.crypto.randomUUID();}catch(_){}return "v-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,12);};
  const planLinkNote=(link,code)=>{
    const ok=link&&typeof link==="object"&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(link.ideaId||"")&&/^[a-z][a-z0-9_]{0,63}$/.test(link.platform||"")&&
      Number.isSafeInteger(link.contentRevision)&&link.contentRevision>0&&/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code||"");
    if(!ok)return `<p class="autoposting-note" data-plan-link="invalid">Материал из контент-плана, но связь с идеей пришла неполной. Откройте «Предложения плана» и найдите идею там; отдельная копия для другой площадки здесь не создаётся.</p>`;
    const href="#content-factory/plan/proposals?"+new URLSearchParams({company:code,idea:link.ideaId,platform:link.platform});
    return `<p class="autoposting-note" data-plan-link="${esc(link.ideaId)}">Материал из контент-плана: идея ${esc(link.ideaId)} · ${esc(variantLabel(link.platform))}. Карточка создана из содержимого v${esc(link.contentRevision)} — это версия на момент переноса, текущая версия идеи могла измениться. <a href="${esc(href)}" data-plan-link-open>Открыть версию идеи в плане</a> — там же готовится версия для другой площадки: её согласуют и переносят отдельно.</p>`;
  };
  const renderVariant=()=>{
    const node=get("autoposting-variant");if(!node)return;
    if(!post||post.companyCode&&post.companyCode!==companyCode){node.innerHTML="";return;}
    const link=post.variantOf&&Number.isSafeInteger(post.variantOf.postId)?post.variantOf:null,root=post.rootIdea&&Number.isSafeInteger(post.rootIdea.postId)?post.rootIdea:null;
    const origin=link?`<p class="autoposting-note" data-variant-origin>Версия для площадки из материала №${esc(link.postId)} (содержимое v${esc(link.contentRevision)})${root&&root.postId!==link.postId?`; исходная идея — материал №${esc(root.postId)}`:""}. У версии своё согласование; исходный материал от неё не меняется. <button class="plain-button" type="button" data-variant-open="${esc(link.postId)}">Открыть исходный №${esc(link.postId)}</button></p>`:"";
    const key=companyCode+":"+post.id,job=variantJobs.get(key);
    /* CF26: карточка из контент-плана. Независимую копию сервер отвергнет (409 PLAN_LINKED_POST), поэтому вместо неё — переход
       к ТЕКУЩЕЙ версии идеи в плане. Ссылка строится только из серверного planLink и кода компании, ничего не угадывается. */
    if(post.planLink!==null&&post.planLink!==undefined){node.innerHTML=origin+planLinkNote(post.planLink,post.companyCode||companyCode);return;}
    if(!edit()||archivedAt(post)){node.innerHTML=origin;return;}
    const unknown=job?.state==="unknown",pending=job?.state==="pending",chosen=job?.body?.platformId||job?.platformId||"",isDirty=dirty();
    node.innerHTML=`${origin}<details class="ap-variant" data-variant${variantOpen.has(key)||job?" open":""}><summary>Создать версию для площадки</summary>
      ${field("autoposting-variant-platform","Площадка версии",`<select id="autoposting-variant-platform"${unknown||pending?" disabled":""}><option value="">Выберите площадку</option>${VARIANT_PLATFORMS.map(([id,label])=>`<option value="${id}"${id===chosen?" selected":""}>${esc(label)}</option>`).join("")}</select>`,"Где выйдет отдельная версия этого материала: свой текст, медиа, время и согласование. Например: TikTok для ролика из поста Telegram.")}
      <p class="autoposting-note">Создаётся отдельный черновик только для этой площадки — без даты, со своим согласованием. Этот материал не меняется.</p>
      <p class="autoposting-note" data-variant-dirty${isDirty&&!unknown?"":" hidden"}>В форме есть несохранённые правки: в версию они не попадут — она создаётся из сохранённой версии ${esc(post.revision)}. Правки останутся в этой карточке; если они нужны в версии, сначала сохраните.</p>
      <button class="plain-button" type="button" id="autoposting-variant-create"${pending?" disabled":""}>${unknown?`Отправить ещё раз (${esc(variantLabel(job.body.platformId))})`:isDirty?"Создать из сохранённой версии":"Создать версию"}</button>
      <p class="autoposting-note" data-variant-status role="status">${job?.text?esc(job.text):""}${job?.childId&&!unknown&&!pending?` <button class="plain-button" type="button" data-variant-open="${esc(job.childId)}">Открыть №${esc(job.childId)}</button>`:""}</p></details>`;
  };
  // Только отметка о несохранённых правках — без перерисовки панели (выбор площадки не сбрасывается).
  const syncVariantDirty=()=>{
    const note=container.querySelector("[data-variant-dirty]"),button=get("autoposting-variant-create"),job=post&&variantJobs.get(companyCode+":"+post.id);
    if(!note||!button||job?.state==="unknown"||job?.state==="pending")return;
    const isDirty=dirty();note.hidden=!isDirty;button.textContent=isDirty?"Создать из сохранённой версии":"Создать версию";
  };
  const openFresh=async(id,opts={})=>{
    const version=epoch,code=companyCode,target=Number(id);
    if(!Number.isSafeInteger(target)||target<1)return false;
    try{
      const item=await request("/autoposting/posts/"+target);
      if(version!==epoch)return false;
      if(item?.companyCode!==code||item.id!==target)throw Error("Wrong material scope");
      if(archivedAt(item)){showArchived(item);if(opts.job){opts.job.state="done";opts.job.text=`Версия №${target} уже удалена из плана — она в «Удалённых материалах».`;}return true;}
      posts=[item,...posts.filter(value=>value.id!==item.id)];renderList();
      const here=editorNode.open&&(!opts.sourceId||post?.id===opts.sourceId);
      if(opts.job){opts.job.state="done";opts.job.text=`${opts.job.replay?"Эта версия уже была создана раньше":"Версия создана"}: материал №${target} для ${variantLabel(opts.job.body.platformId)}. Черновик без даты, нужно своё согласование.`;}
      if(here){selectPost(item.id);if(opts.job)message(`${opts.job.text} Открыта её текущая карточка. Исходный материал №${opts.sourceId} не изменён${drafts.has(code+":"+opts.sourceId)?"; его несохранённые правки остались в нём":""}.`);}
      else if(opts.job)message(`${opts.job.text} Окно закрыто или открыт другой материал — версия на доске, откройте её там.`);
      return true;
    }catch(_){
      if(version!==epoch)return false;
      if(opts.job){opts.job.state="fetchFailed";opts.job.text=`Версия создана: материал №${target}. Загрузить её текущую карточку не удалось — повторно создавать не нужно. «Открыть №${target}» повторит загрузку.`;message(opts.job.text);}
      else message(`Не удалось открыть материал №${target}. Он недоступен или временно не загружается.`);
      return false;
    }
  };
  const createVariant=async()=>{
    if(variantBusy===epoch||busy||!post||!edit()||archivedAt(post))return;
    const source=post,code=companyCode,version=epoch,key=code+":"+source.id;
    let job=variantJobs.get(key);
    if(job?.state!=="unknown"){
      const platformId=get("autoposting-variant-platform")?.value||"";
      if(!VARIANT_PLATFORMS.some(([id])=>id===platformId)){variantJobs.set(key,{state:"error",platformId:"",text:"Выберите площадку версии. Ничего не отправлено."});renderVariant();return;}
      job={state:"pending",body:{revision:source.revision,clientRequestId:newRequestId(),platformId}};
    }
    job.state="pending";job.text=`Создаём версию для ${variantLabel(job.body.platformId)}…`;variantJobs.set(key,job);variantBusy=version;renderVariant();
    try{
      const result=await request("/autoposting/posts/"+encodeURIComponent(source.id)+"/variants","POST",job.body);
      if(version!==epoch)throw Object.assign(new Error("late"),{late:true});
      const child=result?.post;
      if(result?.companyCode!==code||!child||!Number.isSafeInteger(child.id)||child.companyCode&&child.companyCode!==code||child.variantOf&&child.variantOf.postId!==source.id)
        throw Object.assign(new Error("ответ не относится к этой карточке"),{scope:true});
      job.state="created";job.childId=child.id;job.replay=result.created===false;
      job.text=`Версия ${job.replay?"уже была создана":"создана"}: материал №${child.id}. Загружаем её текущую карточку…`;
    }catch(error){
      const definite=!error.late&&!error.scope&&Number.isInteger(error.status)&&error.status>=400&&error.status<500&&![408,429].includes(error.status);
      /* CF26: общий разбор ответа берёт код и из details.code (так его отдаёт CRM). Если кода всё же нет — показывается текст сервера. */
      if(definite)variantJobs.set(key,{state:"error",platformId:job.body.platformId,text:VARIANT_ERRORS[error.code]||(error.status===403?"Недостаточно прав для создания версии. Ничего не создано."
        :error.status===404?"Материал не найден в этой компании. Ничего не создано."
        :error.status===409?`Сервер отказал: ${String(error.message||"конфликт состояния").replace(/[.\s]+$/,"")}. Ничего не создано; новый запрос автоматически не отправлялся.`
        :`Сервер не принял запрос: ${String(error.message||"").replace(/[.\s]+$/,"")}. Ничего не создано.`)});
      else{job.state="unknown";job.text=error.late?"Ответ пришёл после смены компании и не показан. Версия могла быть создана; «Отправить ещё раз» повторит тот же запрос — второй версии не будет."
        :`Ответ не получен${error.scope?" или не относится к этой карточке":error.message?` (${error.message})`:""}. Версия могла быть создана. «Отправить ещё раз» повторит тот же запрос — второй версии не будет.`;}
      if(variantBusy===version)variantBusy=-1;
      if(version===epoch){renderVariant();message(variantJobs.get(key).text);}
      return;
    }
    renderVariant();
    await openFresh(job.childId,{job,sourceId:source.id});
    if(variantBusy===version)variantBusy=-1;
    if(version===epoch)renderVariant();
  };
  const renderApproval=()=>{
    // Метка статуса окна обновляется вместе с решением (согласование, возврат, отправка на согласование), а не только при открытии.
    get("autoposting-post-state").textContent=post?`Статус: ${statusLabel(post)}`:"Новый черновик";editorBar();
    const node=get("autoposting-approval");if(!post){node.innerHTML="";return;}
    const a=post.approval||{},r=post.readiness||{ready:false,issues:[]},owner=permitted(ctx,"approve");
    const rv=post.review||{state:"draft"},canEdit=edit()&&!busy;
    // CF23: кэш полной истории действует, пока не изменилась версия карточки; иначе перечитывается при раскрытии.
    const cachedHistory=fullHistory.get(historyKey(post.id));if(cachedHistory&&cachedHistory.revision!==post.revision)fullHistory.delete(historyKey(post.id));
    const historyIsOpen=historyOpenFull.has(historyKey(post.id));
    node.innerHTML=`<p>Версия ${esc(post.revision)} · содержимое v${esc(post.contentRevision||"")} · <strong data-review-state="${esc(rv.state)}">${esc(REVIEW[rv.state]||rv.state)}</strong>${rv.byName?` (${esc(rv.byName)}${rv.at?", "+esc(time.toLocal(rv.at,zone()).replace("T"," ")):""})`:""}</p>
      ${rv.state==="rejected"&&rv.comment?`<p class="autoposting-issues" data-review-comment>Причина отклонения: ${esc(rv.comment)}</p>`:""}
      <p>${r.ready?"Материал готов к согласованию":"Материал не готов: "+esc((r.issues||[]).join("; "))}</p>
      ${(post.platformApprovals||[]).length?`<ul class="autoposting-platform-approvals">${post.platformApprovals.map(item=>`<li data-platform-state="${esc(item.state)}">${owner?`<label class="autoposting-checkbox"><input type="checkbox" data-approval-platform="${esc(item.platformId)}" checked>${esc(item.platformLabel)}</label>`:`<strong>${esc(item.platformLabel)}</strong>`} <span class="autoposting-badge">${esc(item.stateLabel)}</span>${item.stale?' <span class="autoposting-badge">решение относилось к прежней версии</span>':""}${item.comment?`<p class="autoposting-issues">Причина: ${esc(item.comment)}</p>`:""}${item.byName?`<p class="autoposting-note">${esc(item.byName)}${item.at?" · "+esc(time.toLocal(item.at,zone()).replace("T"," ")):""}</p>`:""}</li>`).join("")}</ul>${owner?'<p class="autoposting-note">Решение относится только к отмеченным площадкам.</p>':""}`:""}
      ${rv.state!=="pending"&&!a.approved&&requiresApproval(post)?`<button class="plain-button" type="button" id="autoposting-submit-review"${canEdit?"":" disabled"}>Отправить на согласование</button>`:""}
      <button type="button" class="primary-action ap-approve" id="autoposting-approve" data-approved="${a.approved?"true":"false"}"${owner?"":" disabled"}>${a.approved?"Снять согласование":"Согласовать"}${Number.isSafeInteger(post.contentRevision)?` · версия v${esc(post.contentRevision)}`:""}</button>
      <p class="autoposting-note" data-approve-effect>${a.approved?"Снятие согласования не трогает расписание и отправленное.":"Согласование не ставит в план и ничего не публикует."}</p>
      <p class="autoposting-note">${a.approved?`Согласовано ${esc(a.approvedByName||(post.approveAndScheduleAvailable?"согласующим":"владельцем"))}${a.approvedAt?" · "+esc(time.toLocal(a.approvedAt,zone()).replace("T"," ")):""}. ${post.approveAndScheduleAvailable?(post.status==='scheduled'?'Версия стоит в очереди на сохранённое время.':'В план — отдельной кнопкой.'):'Публикация начнётся только после «Поставить в план».'}`:a.stale?`Прежнее согласование относилось к версии содержимого ${esc(a.approvedRevision)} и снято после правки.`:post.approveAndScheduleAvailable?"Не согласовано. Согласующий проверяет предпросмотр перед решением.":"Не согласовано. Согласует владелец после проверки предпросмотра."}${owner?"":post.approveAndScheduleAvailable?" Согласует участник с правом согласования.":" Согласует владелец кабинета."}</p>
      ${requiresApproval(post)?`<p class="autoposting-note" data-schedule-scope>${approvedPlatforms(post).length?`В план уйдут только согласованные площадки: ${esc(approvedPlatforms(post).map(platformLabel).join(", "))}.`+((post.platformApprovals||[]).some(entry=>!entry.approved)?` Остальные остаются в карточке со своим статусом и не отправляются.`:""):"Согласованных площадок пока нет: ставить в план нечего."}</p>`:""}
      ${post.approveAndScheduleAvailable?`<p class="autoposting-note" data-approve-schedule-summary>«Согласовать и поставить в план»: каналы ${esc((post.platformIds||[]).map(platformLabel).join(', ')||'не выбраны')} · ${post.scheduledAt?esc(time.toLocal(post.scheduledAt,post.timezone).replace('T',' ')+' · '+post.timezone):'сначала сохраните дату'}. Нужны предпросмотр и подключённый канал.</p><button type="button" class="primary" id="autoposting-approve-schedule" disabled>Согласовать и поставить в план</button>`:""}
      ${(post.continuedPlatforms||[]).length?`<p class="autoposting-note" data-continued-to>Работа по площадкам ${esc(post.continuedPlatforms.map(entry=>entry.platformLabel).join(", "))} продолжена в отдельном материале №${esc(post.continuedPlatforms[0].childPostId)}. Второй раз в план эти площадки отсюда не ставятся.</p>`:""}
      ${post.continuedFrom?`<p class="autoposting-note" data-continued-from>Это продолжение материала №${esc(post.continuedFrom.postId)} по оставшимся площадкам. Согласование нужно новое.</p>`:""}
      ${edit()&&remainingPlatforms(post).length?`<button class="plain-button" type="button" id="autoposting-continue-remaining">Продолжить по оставшимся площадкам</button><p class="autoposting-note">Создаст отдельный материал только для площадок, по которым отправки не было: ${esc(remainingPlatforms(post).map(platformLabel).join(", "))}. Уже отправленное не повторяется.</p>`:""}
      ${owner&&(post.platformApprovals||[]).some(entry=>entry.approved)?`<button class="plain-button" type="button" id="autoposting-revoke-platforms"${post.status==="publishing"||post.status==="published"?" disabled":""}>Снять согласование выбранных площадок</button>`:""}
      ${reviewTrailMarkup(post)}${owner?rejectMarkup(post):""}
      <details class="autoposting-history" data-ap-history="${esc(post.id)}"${historyIsOpen?" open":""}><summary>История согласования${(post.history||[]).length?` (в карточке: ${esc(post.history.length)})`:""}</summary><div data-ap-history-body>${historyBody(post)}</div></details>`;
    if(historyIsOpen&&!fullHistory.has(historyKey(post.id)))void loadHistory(post.id);
    get("autoposting-submit-review")?.addEventListener("click",()=>{
      if(busy||!post||dirty())return;
      void run(async current=>{const result=await request("/autoposting/posts/"+encodeURIComponent(post.id)+"/submit-review","POST",{revision:post.revision});if(!current())return;
        post=result;posts=posts.map(item=>item.id===result.id?result:item);renderList();renderApproval();controls();message("Карточка отправлена на согласование.");
      },"Отправляем на согласование…","Не удалось отправить на согласование. Обновите статусы.");
    });
    // Какие площадки затрагивает решение владельца. Площадок в карточке нет — решение относится к содержимому.
    const chosenPlatforms=()=>{
      const nodes=[...node.querySelectorAll("[data-approval-platform]")];
      if(!nodes.length)return undefined;
      return nodes.filter(item=>item.checked).map(item=>item.dataset.approvalPlatform);
    };
    get('autoposting-approve-schedule')?.addEventListener('click',()=>{
      if(busy||!readyToApproveAndSchedule())return;
      const id=post.id,revision=post.revision;
      void run(async current=>{
        invalidate();
        const result=await request('/autoposting/posts/'+encodeURIComponent(id)+'/approve','POST',{revision,approved:true,schedule:true});
        if(!current())return;
        post=result;posts=posts.map(item=>item.id===result.id?result:item);drafts.delete(key());renderList();renderPost();
        message('Версия согласована и поставлена в план на сохранённое время для всех выбранных каналов.');
      },'Согласуем и ставим в план…','Не удалось подтвердить согласование и очередь. Обновите статусы и проверьте дату, каналы и версию материала.');
    });
    get("autoposting-continue-remaining")?.addEventListener("click",()=>{
      // Продолжение создаёт черновик и ничего не согласовывает: достаточно права правки материалов.
      if(busy||!post||!edit())return;
      const platformIds=remainingPlatforms(post);
      if(!platformIds.length){message("Оставшихся площадок нет.");return;}
      void run(async current=>{
        const outcome=await request("/autoposting/posts/"+encodeURIComponent(post.id)+"/split","POST",{revision:post.revision,platformIds});
        if(!current())return;
        posts=posts.map(item=>item.id===outcome.post.id?outcome.post:item);
        if(!posts.some(item=>item.id===outcome.child.id))posts=[...posts,outcome.child];
        post=outcome.child;renderList();renderPost();renderApproval();controls();
        message(outcome.created
          ?`Создан отдельный материал №${outcome.child.id} для площадок: ${platformIds.map(platformLabel).join(", ")}. Он ещё не согласован и в план не поставлен.`
          :`Продолжение по этим площадкам уже существует — материал №${outcome.child.id}. Второй материал не создан.`);
      },"Создаём продолжение по оставшимся площадкам…","Не удалось создать продолжение. Обновите статусы: результат отправки мог измениться.");
    });
    get("autoposting-revoke-platforms")?.addEventListener("click",()=>{
      if(busy||!post||!owner)return;
      const platformIds=chosenPlatforms();
      if(platformIds&&!platformIds.length){message("Отметьте хотя бы одну площадку.");return;}
      void run(async current=>{const result=await request("/autoposting/posts/"+encodeURIComponent(post.id)+"/approve","POST",{revision:post.revision,approved:false,...(platformIds?{platformIds}:{})});if(!current())return;
        post=result;posts=posts.map(item=>item.id===result.id?result:item);renderList();renderApproval();controls();
        message("Согласование отмеченных площадок снято. Публикация по ним не выполняется; решения по остальным площадкам сохранены.");
      },"Снимаем согласование площадок…","Не удалось снять согласование. Обновите статусы: версия могла измениться.");
    });
    bindNoteForm();
    /* CF4: возврат на доработку — существующий reject. Замечания уходят в annotations одним запросом.
       Ответ 400 — сервер ничего не изменил. Нет ответа, 409 или 5xx — карточка перечитывается, отправка не повторяется;
       успех показывается только по ответу сервера или по перечитанной карточке. */
    get("autoposting-reject-form")?.addEventListener("submit",event=>{
      event.preventDefault();const comment=get("autoposting-reject-comment").value.trim();
      const platformIds=chosenPlatforms();
      if(platformIds&&!platformIds.length){message("Отметьте хотя бы одну площадку.");return;}
      if(!comment){message("Для возврата на доработку нужен комментарий.");return;}if(busy||!post||dirty()||!owner)return;
      const notes=pendingFor(post);
      if(notes.some(note=>note.contentRevision!==post.contentRevision)){message("Версия изменилась после добавления замечаний. Проверьте отмеченные замечания и уберите лишние.");return;}
      const annotations=notes.map(({category,comment,timingKind,startMs,endMs,mediaIndex})=>timingKind==="whole"?{category,comment,timingKind}:{category,comment,timingKind,startMs,...(endMs!==null?{endMs}:{}),...(mediaIndex!==null?{mediaIndex}:{})});
      const id=post.id,sentRevision=post.revision,key=notesKey(post);
      const same=group=>JSON.stringify((group?.annotations||[]).map(({category,comment,timingKind,startMs,endMs,mediaIndex})=>[category,comment,timingKind,startMs??null,endMs??null,mediaIndex??null]))===JSON.stringify(annotations.map(a=>[a.category,a.comment,a.timingKind,a.startMs??null,a.endMs??null,a.mediaIndex??null]));
      const outcome=(result,prefix)=>{
        const task=(result.reviewTasks||[])[0];
        return `${prefix} Замечаний: ${annotations.length}. ${task?`Задача доработки №${task.taskId}: ${TASK_STATUS[task.status]||task.status} · ${task.assigneeName?"исполнитель "+task.assigneeName:"не назначен"} · ${task.dueDate?"срок "+task.dueDate:"срок не указан"}.`:"Связанную задачу сервер не показал."} Уведомления не отправлялись, публикация не выполнялась.`;
      };
      const apply=result=>{post=result;posts=posts.map(item=>item.id===result.id?result:item);renderList();renderApproval();controls();};
      void run(async current=>{
        let result;
        try{result=await request("/autoposting/posts/"+encodeURIComponent(id)+"/reject","POST",{revision:sentRevision,comment,...(platformIds?{platformIds}:{}),...(annotations.length?{annotations}:{})});}
        catch(error){
          if(!current())return;
          if(error.status===400){message(`Сервер не принял возврат: ${error.message}. Ничего не изменено; замечания остались в форме.`);return;}
          // Результат неизвестен (сеть, 409, 5xx): перечитываем карточку и не повторяем отправку сами.
          let fresh;try{fresh=await request("/autoposting/posts/"+encodeURIComponent(id));}catch(_){if(current())message("Ответ сервера не получен, и карточку перечитать не удалось. Не отправляйте повторно — обновите статусы и проверьте карточку.");return;}
          if(!current())return;if(fresh.companyCode!==companyCode||fresh.id!==id){message("Ответ не подходит к выбранной компании. Обновите раздел.");return;}
          const landed=fresh.revision>sentRevision&&fresh.review?.state==="rejected"&&fresh.review?.comment===comment&&(!annotations.length||same((fresh.reviewNotes||[]).at(-1)));
          if(landed)pendingNotes.delete(key);
          apply(fresh);
          message(landed?outcome(fresh,"Ответ не был получен, но по перечитанной карточке возврат сохранён."):`${error.status===409?"Карточка изменилась в другом окне.":"Ответ сервера не получен."} Карточка перечитана: ${statusLabel(fresh)}. Возврат не подтверждён; замечания остались в форме — проверьте и отправьте снова вручную.`);
          return;
        }
        if(!current())return;
        pendingNotes.delete(key);apply(result);message(outcome(result,"Возвращено на доработку."));
      },"Возвращаем на доработку…","Не удалось вернуть на доработку.");
    });
    // CF3-R1: одна явная кнопка. Тот же маршрут approve, та же ревизия и права; расписание не трогается.
    get("autoposting-approve").addEventListener("click",event=>{
      const approved=event.currentTarget.dataset.approved!=="true";if(busy||!post||dirty()||!owner)return;
      const platformIds=chosenPlatforms();
      if(platformIds&&!platformIds.length){message("Отметьте хотя бы одну площадку.");return;}
      void run(async current=>{const result=await request("/autoposting/posts/"+encodeURIComponent(post.id)+"/approve","POST",{revision:post.revision,approved,...(platformIds?{platformIds}:{})});if(!current())return;
        post=result;posts=posts.map(item=>item.id===result.id?result:item);renderList();renderApproval();controls();message(approved?"Версия согласована. В план не поставлена и не опубликована: постановка в план — отдельное действие.":"Согласование снято.");
      },approved?"Сохраняем согласование…":"Снимаем согласование…","Не удалось сохранить согласование. Обновите статусы: версия могла измениться.");
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
        ${field("autoposting-receipt-platform","Площадка",`<select id="autoposting-receipt-platform">${RECEIPT_PLATFORMS.map(id=>`<option value="${esc(id)}">${esc(CAPTIONS.find(item=>item[0]===id)[1])}</option>`).join("")}</select>`,"Где материал уже вышел без кабинета. Для MAX и 2ГИС формат ссылки ещё не подтверждён, поэтому отметка по ним не принимается. Например: Telegram.")}
        ${field("autoposting-receipt-url","Ссылка на публикацию",'<input id="autoposting-receipt-url" maxlength="500" placeholder="https://t.me/channel/123" required>',"Адрес самой записи, а не профиля. Например: https://t.me/channel/123.")}
        ${field("autoposting-receipt-date",`Когда опубликовано · ${esc(timezone)}`,'<input id="autoposting-receipt-date" type="datetime-local" required>',"Дата и время выхода по указанному поясу; будущее время не принимается. Например: 01.10.2026, 12:30.")}
        ${field("autoposting-receipt-note","Примечание (необязательно)",'<input id="autoposting-receipt-note" maxlength="500">',"Для команды, на площадку не уходит. Например: «вышло вручную из телефона».")}
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
  /* CF5: удаление черновика и «Удалённые материалы». Удаление — обратимое: сервер переносит карточку в архив
     (POST …/archive {revision}), текст, файлы, замечания и задачи сохраняются. Восстановление — отдельное
     действие (POST …/restore {revision}): возвращает черновик без согласования и даты отправки. */
  const when=value=>{const local=time.toLocal(value,zone());return local?`${local.slice(8,10)}.${local.slice(5,7)}.${local.slice(0,4)}, ${local.slice(11,16)}`:"";};
  const renderArchiveZone=()=>{
    const zone_=get("autoposting-archive-zone");if(!zone_)return;
    if(!post||!edit()||archivedAt(post)||receiptsOf(post).length||["publishing","published","needs_review"].includes(post.status)){zone_.innerHTML="";return;}
    if(post.status==="scheduled"){zone_.innerHTML='<p class="autoposting-note">Чтобы удалить материал, сначала снимите его с публикации.</p>';return;}
    if(!ARCHIVABLE.has(post.status)){zone_.innerHTML="";return;}
    zone_.innerHTML=archiveConfirm
      ?`<div class="ap-archive-confirm" role="group" aria-labelledby="autoposting-archive-question"><p id="autoposting-archive-question">Удалить «${esc(post.title||"Без названия")}»? Материал уйдёт из плана в «Удалённые материалы». Текст, файлы, замечания и задачи сохранятся — его можно вернуть.</p><div class="ap-archive-actions"><button type="button" class="danger" id="autoposting-archive-yes">Удалить</button><button type="button" class="plain-button" id="autoposting-archive-no">Отмена</button></div></div>`
      :'<button type="button" class="plain-button ap-archive-button" id="autoposting-archive-button">Удалить черновик</button><p class="autoposting-note" id="autoposting-archive-note"></p>';
  };
  const renderArchive=()=>{
    const node=get("autoposting-archive-list");if(!node)return;
    get("autoposting-archive").querySelector("summary").textContent=archived?`Удалённые материалы (${archived.length}${archivedLimited?"+":""})`:"Удалённые материалы";
    if(!archived){node.innerHTML=archivedState==="error"?'<p role="status">Не удалось загрузить удалённые материалы. <button type="button" class="plain-button" data-archive-reload>Повторить</button></p>':archivedState==="loading"?'<p class="autoposting-note" role="status">Загружаем…</p>':"";return;}
    if(!archived.length){node.innerHTML='<p class="autoposting-note">Удалённых материалов нет.</p>';return;}
    node.innerHTML=`<ul class="ap-archive-items">${archived.map(item=>{const notes=(item.reviewNotes||[]).reduce((sum,group)=>sum+(group.annotations||[]).length,0);
      return `<li class="ap-archive-item" data-archived-post="${esc(item.id)}"${archiveFocus===item.id?' data-focus="true"':''}><div><strong>${esc(item.title||"Без названия")}</strong><span class="autoposting-note">Удалено ${esc(when(archivedAt(item)))}${notes?` · замечаний: ${notes}`:""}</span></div>${edit()?`<button type="button" class="plain-button" data-restore-post="${esc(item.id)}">Восстановить</button>`:""}</li>`;}).join("")}</ul>${archivedLimited?'<p class="autoposting-note">Показаны 200 последних удалённых.</p>':""}`;
  };
  const loadArchive=async()=>{
    const version=epoch,mine=++archivedEpoch,code=companyCode;archived=null;archivedState="loading";renderArchive();
    try{const result=await request("/autoposting/archived");if(version!==epoch||mine!==archivedEpoch)return;
      if(result.companyCode!==code||!Array.isArray(result.posts)||result.posts.some(item=>item.companyCode!==code||!archivedAt(item)))throw Error("Wrong archive scope");
      archived=result.posts;archivedLimited=result.posts.length>=200;archivedState="ok";
    }catch(_){if(version===epoch&&mine===archivedEpoch){archived=null;archivedState="error";}}
    finally{if(version===epoch&&mine===archivedEpoch){renderArchive();controls();}}
  };
  const showArchived=item=>{
    posts=posts.filter(value=>value.id!==item.id);renderList();archiveFocus=item.id;
    const node=get("autoposting-archive");node.open=true;void loadArchive();node.scrollIntoView?.({block:"nearest"});
    message(`Материал «${item.title||"Без названия"}» удалён ${when(archivedAt(item))}. Он в «Удалённых материалах» внизу доски — его можно восстановить.`);
  };
  const dropArchived=item=>{
    posts=posts.filter(value=>value.id!==item.id);approvalSelection.delete(String(item.id));
    pendingNotes.delete(`${companyCode}:${item.id}`);drafts.delete(`${companyCode}:${item.id}`);
    if(post?.id===item.id){archiveConfirm=false;closeEditor(true);post=null;selections.set(companyCode,null);renderPost();}
    if(archived)archived=[item,...archived.filter(value=>value.id!==item.id)];
    if(calendarData)calendarData={...calendarData,posts:calendarData.posts.filter(value=>value.id!==item.id),undated:calendarData.undated.filter(value=>value.id!==item.id)};
    renderBatch();renderList();renderArchive();controls();void loadCalendar();
  };
  const archivePost=()=>{
    if(busy||!edit()||!post||!ARCHIVABLE.has(post.status)||dirty()||archivedAt(post))return;
    const target=post,title=target.title||"Без названия",code=companyCode;
    void run(async current=>{
      let result;
      try{result=await request("/autoposting/posts/"+encodeURIComponent(target.id)+"/archive","POST",{revision:target.revision});}
      catch(error){
        if(!current())return;
        if(error.status===400||error.status===403){message(`Сервер не принял удаление: ${error.message}. Ничего не изменено.`);return;}
        // 409 или неизвестный исход: повторно не отправляем, а перечитываем карточку.
        let fresh=null;try{fresh=await request("/autoposting/posts/"+encodeURIComponent(target.id));}catch(_){}
        if(!current())return;
        if(fresh&&(fresh.companyCode!==code||fresh.id!==target.id))fresh=null;
        if(fresh&&archivedAt(fresh)){dropArchived(fresh);message(`«${title}» удалён — это подтверждено после перечитывания карточки. Повторно ничего не отправлялось. Вернуть можно в «Удалённых материалах».`);return;}
        if(fresh){post=fresh;posts=posts.map(item=>item.id===fresh.id?fresh:item);archiveConfirm=false;drafts.delete(key());renderList();renderPost();
          message(`Удаление не выполнено${fresh.status==="scheduled"?": материал стоит в плане — сначала снимите его с публикации":error.status===409&&error.message?": "+error.message:""}. Карточка перечитана: ${statusLabel(fresh)}. Повторно ничего не отправлялось.`);return;}
        message("Не удалось подтвердить удаление и перечитать карточку. Обновите статусы, прежде чем удалять снова.");return;
      }
      if(!current())return;
      if(result.companyCode!==code||result.id!==target.id||!archivedAt(result)){message("Ответ сервера не подтверждает удаление. Обновите статусы, прежде чем удалять снова.");return;}
      dropArchived(result);
      message(`«${title}» удалён из плана. Вернуть можно в «Удалённых материалах» внизу доски.`);
    },"Удаляем черновик…","Не удалось подтвердить удаление. Обновите статусы, прежде чем удалять снова.");
  };
  const restorePost=id=>{
    const item=(archived||[]).find(value=>String(value.id)===String(id));if(!item||busy||!edit())return;
    const title=item.title||"Без названия",code=companyCode;
    const restored=fresh=>{archived=(archived||[]).filter(value=>value.id!==fresh.id);archiveFocus=null;posts=[fresh,...posts.filter(value=>value.id!==fresh.id)];renderList();renderArchive();void loadCalendar();};
    void run(async current=>{
      let result;
      try{result=await request("/autoposting/posts/"+encodeURIComponent(item.id)+"/restore","POST",{revision:item.revision});}
      catch(error){
        if(!current())return;
        if(error.status===400||error.status===403){message(`Сервер не принял восстановление: ${error.message}. Ничего не изменено.`);return;}
        let fresh=null;try{fresh=await request("/autoposting/posts/"+encodeURIComponent(item.id));}catch(_){}
        if(!current())return;
        if(fresh&&(fresh.companyCode!==code||fresh.id!==item.id))fresh=null;
        if(fresh&&!archivedAt(fresh)){restored(fresh);message(`«${title}» уже восстановлен — это подтверждено после перечитывания карточки: ${statusLabel(fresh)}. Повторно ничего не отправлялось.`);return;}
        if(fresh){archived=archived.map(value=>value.id===fresh.id?fresh:value);renderArchive();
          message(`Восстановление не выполнено${error.status===409&&error.message?": "+error.message:""}. Материал остался в удалённых; карточка перечитана. Повторно ничего не отправлялось.`);return;}
        message("Не удалось подтвердить восстановление и перечитать карточку. Откройте «Удалённые материалы» заново, прежде чем повторять.");return;
      }
      if(!current())return;
      if(result.companyCode!==code||result.id!==item.id||archivedAt(result)){message("Ответ сервера не подтверждает восстановление. Откройте «Удалённые материалы» заново.");return;}
      restored(result);
      message(`«${title}» восстановлен как черновик. Согласование и дата отправки не возвращаются — проверьте материал и согласуйте заново.`);
    },"Восстанавливаем материал…","Не удалось подтвердить восстановление. Откройте «Удалённые материалы» заново.");
  };
  const renderState=()=>{
    renderApproval();renderVariant();renderReceipts();renderArchiveZone();
    const node=get("autoposting-post-error");node.hidden=!post?.lastErrorCode;
    node.textContent=post?.lastErrorCode?(ERRORS[post.lastErrorCode]||"Не удалось подтвердить публикацию. Проверьте подключение и данные компании."):"";
    get("autoposting-deliveries").innerHTML=(post?.deliveries||[]).map(item=>`<p>${esc(channels().find(channel=>channel.id===item.channelId)?.name||item.channelId)}: ${esc(STATUS[item.status]||{pending:"Ожидает отправки"}[item.status]||"Требуется проверка")}${item.errorCode&&ERRORS[item.errorCode]?` · ${esc(ERRORS[item.errorCode])}`:""}${safeUrl(item.url)?` · <a href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer">Открыть публикацию</a>`:""}</p>`).join("");
  };
  const renderPost=()=>{
    /* Флажки строятся по словарю ПЛАНА, а не по подключённым каналам: иначе Instagram, TikTok,
       MAX и 2ГИС нельзя было бы выбрать, а уже сохранённый выбор пропадал бы при следующем
       сохранении. Неизвестные сохранённые идентификаторы тоже получают свой флажок и остаются
       в карточке: молча выбрасывать чужой выбор нельзя. */
    const known=CAPTIONS.map(([id])=>id);
    const stored=(post?.platformIds||[]).filter(id=>!known.includes(id));
    get("autoposting-platforms").innerHTML=PLATFORMS_LEGEND
      +CAPTIONS.map(([id,label])=>{const state=deliveryState(id);
        return `<label class="autoposting-checkbox"><input type="checkbox" value="${esc(id)}">${esc(label)} — ${esc(state.label)}</label>`;}).join("")
      +stored.map(id=>`<label class="autoposting-checkbox"><input type="checkbox" value="${esc(id)}">${esc(id)} — сохранённая площадка, неизвестная этой версии кабинета</label>`).join("")
      +'<p class="autoposting-note">Отметка площадки — это план и согласование, а не отправка. Площадка без подключённого канала остаётся в плане и опубликованной не становится.</p>';
    const timezone=post?.timezone||zone();
    const values={title:post?.title||"",text:post?.text||"",media:(post?.mediaUrls||[]).join("\n"),date:time.toLocal(post?.scheduledAt,timezone),timezone,platformIds:post?.platformIds||[],dayKey:post?.dayKey||"",origin:post?.origin||"",captions:post?.captions||{},mediaSha256:post?.mediaSha256||"",platformOptions:post?.platformOptions||{},meta:post?.meta||{}};
    setRaw(values);baseline=raw();archiveConfirm=false;
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
      return `<form class="autoposting-channel" data-channel="${esc(channel.id)}"${onlypult?' data-owner-connection':''}><h3>${esc(channel.name||PLATFORM_TITLE[channel.id]||channel.platform||channel.id)}</h3><p>${channel.connected?"Доступ подтверждён":"Доступ не подтверждён"}${channel.enabled?" · включён":" · выключен"}</p>
        <p data-channel-links>${[cabinet.platformLinks?.companyLink({companyCode,record:information,platform:channel.platform==='telegram'?'telegram_channel':channel.platform}),cabinet.platformLinks?.cabinetLink(channel.platform)].filter(Boolean).join(' · ')}</p>
        ${ctx.identity?.role!=='owner'?'<p class="autoposting-note">Onlypult подключает владелец Synapse. После подключения здесь можно готовить и планировать публикации своей компании.</p>':''}
        <label>Способ подключения<select data-channel-field="provider">${PROVIDER_ONLY.has(channel.id)?`<option value="onlypult" selected>Через Onlypult</option>`:`<option value="direct"${!onlypult?' selected':''}>Напрямую</option><option value="onlypult"${onlypult?' selected':''}${ctx.identity?.role!=='owner'?' disabled':''}>Через Onlypult</option>`}</select></label>${PROVIDER_ONLY.has(channel.id)?`<p class="autoposting-note" data-channel-publishing-help>${esc(PROVIDER_HELP[channel.id])}</p>`:''}
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
  const dateRange=()=>({from:month+'-01',to:daysOfMonth(month).at(-1)});
  const dailyItems=()=>{
    const source=calendarData?[...calendarData.posts,...calendarData.undated]:posts;
    return source.filter(isActive).map(item=>{
      const latest=posts.find(value=>value.id===item.id),value=latest&&latest.revision>=item.revision?{...item,...latest}:item;
      if(latest&&latest.revision>item.revision)value.calendarReadiness=null;
      const publishDate=localDay(value),plannedDate=item.plannedDate||null;
      return {...value,publishDate,plannedDate,effectiveDate:publishDate||plannedDate||null,dateKind:publishDate?'schedule':plannedDate?'plan':null};
    });
  };
  const platformsOf=item=>[...new Set([...(item.platformIds||[]).map(id=>channels().find(channel=>channel.id===id)?.platform||id),...Object.keys(item.captions||{}),...(item.planPlatform?[item.planPlatform]:[])])];
  const hasLocalChanges=item=>drafts.has(companyCode+':'+item.id)||(post?.id===item.id&&dirty());
  // Площадки, для которых согласована именно текущая версия. В план отправляются только они;
  // остальные остаются в карточке со своими статусами и причинами.
  const approvedPlatforms=item=>(item?.platformApprovals||[]).filter(entry=>entry.approved).map(entry=>entry.platformId);
  // Площадки, которые действительно уйдут в план. Готовность и постановка в план обязаны смотреть
  // на один и тот же список, иначе кабинет запрещает отправку из-за канала, который не отправляется.
  // Оставшиеся площадки: без своей отправки, без расписки и без переданного продолжения.
  // Кабинет только предлагает список — действительно неотправленные площадки считает сервер.
  const remainingPlatforms=item=>{
    if(!item)return [];
    const sent=new Set((item.deliveries||[]).filter(entry=>["published","publishing","needs_review"].includes(entry.status)).map(entry=>entry.channelId));
    if(!sent.size)return [];
    const marked=receiptPlatforms(item),moved=new Set((item.continuedPlatforms||[]).map(entry=>entry.platformId));
    return (item.platformIds||[]).filter(id=>!sent.has(id)&&!marked.has(id)&&!moved.has(id)
      &&!(item.deliveries||[]).some(entry=>entry.channelId===id&&["published","publishing","needs_review"].includes(entry.status)));
  };
  const scheduleTargets=(item,selected)=>{
    if(!item||!requiresApproval(item)||item.approval?.approved)return selected;
    const approved=approvedPlatforms(item);
    return approved.length?selected.filter(id=>approved.includes(id)):selected;
  };
  const canSelectApproval=item=>permitted(ctx,'approve')&&item?.companyCode===companyCode&&EDITABLE.has(item.status)&&item.readiness?.ready===true&&Number.isSafeInteger(item.contentRevision)&&Number.isSafeInteger(item.revision)&&!item.deliveries?.some(value=>['published','publishing','needs_review'].includes(value.status))&&!hasLocalChanges(item)&&!approvalBlocked.has(String(item.id));
  const renderBatch=()=>{
    get('autoposting-batch').hidden=!permitted(ctx,'approve')||!approvalSelection.size;
    get('autoposting-batch-approve').textContent=`Согласовать выбранные (${approvalSelection.size})`;
    get('autoposting-batch-reject').textContent=`Вернуть выбранные на доработку (${approvalSelection.size})`;
    get('autoposting-selected-list').innerHTML=approvalSelection.size?'<p>Будут согласованы все выбранные материалы, в том числе за пределами текущего фильтра:</p><ul>'+[...approvalSelection.values()].map(item=>`<li>${esc(item.title)} · версия ${esc(item.contentRevision)} <button type="button" class="plain-button" data-daily-unselect="${esc(item.id)}">Убрать из выбора</button></li>`).join('')+'</ul>':'';
    get('autoposting-batch-results').innerHTML=approvalResults.size?'<ul>'+[...approvalResults.values()].map(result=>`<li>${esc(result.title)}: ${esc(result.message)}</li>`).join('')+'</ul>':'';
  };
  const matchesFilter=item=>(!boardFilter.platform||platformsOf(item).includes(boardFilter.platform))
    &&(!boardFilter.format||(boardFilter.format==='none'?!item.meta?.format:item.meta?.format===boardFilter.format))
    &&(!boardFilter.role||(boardFilter.role==='none'?!item.meta?.role:item.meta?.role===boardFilter.role))
    &&(!boardFilter.status||boardStatus(item)===boardFilter.status);
  const activeFilters=()=>Object.values(boardFilter).filter(Boolean).length;
  const localTime=item=>item.scheduledAt?time.toLocal(item.scheduledAt,zone()).slice(11,16):'';
  const byTime=(a,b)=>(a.scheduledAt?0:1)-(b.scheduledAt?0:1)||String(a.scheduledAt||'').localeCompare(String(b.scheduledAt||''))||String(a.id).localeCompare(String(b.id),'en',{numeric:true});
  const approvedText=item=>{
    if(!(item.approval?.approved&&!item.approval?.stale))return '';
    const at=item.approval.approvedAt&&!Number.isNaN(Date.parse(item.approval.approvedAt))?time.toLocal(item.approval.approvedAt,zone()).replace('T',' '):'';
    const who=typeof item.approval.approvedByName==='string'?item.approval.approvedByName.trim():'';
    return who||at?`Согласовал${who?' '+who:''}${at?' · '+at:''}`:'';
  };
  /* Компактная карточка доски. Нажатие открывает существующий редактор поверх доски; флажок — только выбор
     для группового действия «Согласовать выбранные», он ничего не согласует сам. */
  const renderDailyCard=item=>{
    const id=String(item.id),platforms=platformsOf(item),status=boardStatus(item),label=statusLabel(item);
    const url=(item.mediaUrls||[]).map(safeUrl).find(Boolean);
    const thumb=url?(isVideo(url)?`<span class="ap-thumb ap-thumb-video"><video muted playsinline preload="metadata" src="${esc(url)}" aria-hidden="true" tabindex="-1"></video><span class="ap-thumb-label">▶ Видео</span></span>`
      :`<span class="ap-thumb"><img src="${esc(url)}" alt="" loading="lazy"></span>`):'';
    const format=FORMATS.find(([key])=>key===item.meta?.format)?.[1]||'',ovp=OVP.find(([key])=>key===item.meta?.role)?.[1]||'';
    const clock=localTime(item)||(item.plannedDate?'время не задано':'');
    const meta=[clock,format,ovp?'ОВП: '+ovp:''].filter(Boolean).join(' · ');
    const approved=approvedText(item);
    const chips=platforms.length?platforms.map(platform=>`<span class="ap-chip" data-platform="${esc(platform)}"><i aria-hidden="true"></i>${esc(platformLabel(platform))}</span>`).join(''):'<span class="ap-chip" data-platform="none"><i aria-hidden="true"></i>Площадка не выбрана</span>';
    const select=permitted(ctx,'approve')?`<label class="ap-card-select"><input type="checkbox" data-daily-approve="${esc(id)}" aria-label="Выбрать для группового решения: ${esc(item.title||'Без названия')}, версия ${esc(item.contentRevision||item.revision)}" ${approvalSelection.has(id)?'checked':''} ${canSelectApproval(item)?'':'disabled'}>Выбрать</label>`:'';
    return `<li class="ap-card${url?' has-thumb':''}" data-daily-post="${esc(id)}" data-platform="${esc(platforms[0]||'none')}">
      <button type="button" class="ap-card-open" data-open-post="${esc(id)}" aria-label="Открыть публикацию: ${esc(item.title||'Без названия')}">${thumb}<span class="ap-card-title">${esc(item.title||'Без названия')}</span></button>
      <p class="ap-chips">${chips}</p>${meta?`<p class="ap-card-meta">${esc(meta)}</p>`:''}
      <p class="ap-card-state"><span class="ap-status" data-status="${esc(status)}">${esc(label)}</span>${select}</p>
      ${approved?`<p class="ap-card-note">${esc(approved)}</p>`:''}${item.publishDate&&item.plannedDate&&item.publishDate!==item.plannedDate?`<p class="ap-card-note">Дата плана: ${esc(item.plannedDate)}</p>`:''}
      ${hasLocalChanges(item)?'<p class="ap-card-note ap-card-warning">Есть несохранённые правки в этом окне</p>':''}</li>`;
  };
  const renderCalendar=()=>{
    if(!month)return;
    const weeks=weeksOf(month);week=Math.min(Math.max(0,week),weeks.length-1);const days=weeks[week];
    get('autoposting-week-label').textContent=`Неделя ${week+1} из ${weeks.length} · ${weekLabel(days)}`;
    get('autoposting-month').value=month;
    get('autoposting-calendar-zone').textContent=`Время — по часовому поясу проекта ${zone()}. Сегодня: ${today()}.`;
    get('autoposting-month-controls').hidden=!overview;get('autoposting-overview').setAttribute('aria-pressed',String(overview));
    get('autoposting-calendar-state').textContent=calendarPending?'Обновляем доску…':calendarData?calendarData.truncated?'Список за месяц ограничен и может быть неполным.':calendarData.undatedTruncated?'Список публикаций без даты ограничен. Показаны первые 200.':'':`Доска за месяц недоступна. Показаны только загруженные материалы (до 200); список может быть неполным.`;
    const gaps=calendarData?.coverage?.basis==='current_plan'&&Array.isArray(calendarData.coverage.uncoveredDates)?[...new Set(calendarData.coverage.uncoveredDates.filter(date=>/^\d{4}-\d{2}-\d{2}$/.test(date)&&date>=today()&&date<=addDays(today(),2)))].sort():[];
    get('autoposting-plan-gaps').hidden=!gaps.length;
    get('autoposting-plan-gaps').textContent=gaps.length?'По текущему плану компании нужно подготовить публикацию к '+gaps.join(', ')+'.':'';
    const all=dailyItems(),items=all.filter(matchesFilter),count=activeFilters();
    get('autoposting-filter-count').textContent=count?`Активных фильтров: ${count}`:'';get('autoposting-filter-reset').hidden=!count;
    get('autoposting-filters-toggle').textContent=count?`Фильтры (${count})`:'Фильтры';get('autoposting-filters-toggle').setAttribute('aria-expanded',String(filtersOpen));get('autoposting-filters').classList.toggle('is-open',filtersOpen);
    let html=WEEKDAYS.map(day=>`<span class="autoposting-weekday">${day}</span>`).join('')+'<span></span>'.repeat(weekdayOf(month+'-01'));
    for(const date of daysOfMonth(month)){const total=items.filter(item=>item.effectiveDate===date).length;
      html+=`<button type="button" data-calendar-date="${date}" aria-pressed="${selectedDate===date}" aria-label="${date}: публикаций ${total}">${Number(date.slice(8))}${total?`<span>${total}</span>`:''}</button>`;}
    get('autoposting-calendar').innerHTML=html;
    const dayItems=date=>items.filter(item=>item.effectiveDate===date).sort(byTime);
    get('autoposting-day-strip').innerHTML=days.map(date=>{const total=dayItems(date).length;return `<button type="button" class="plain-button" data-strip-date="${date}" aria-pressed="${selectedDate===date}" aria-label="${dayLabel(date)}: публикаций ${total}"><span>${WEEKDAYS[weekdayOf(date)]}</span><b>${Number(date.slice(8))}</b>${total?`<em>${total}</em>`:''}</button>`;}).join('');
    const weekTotal=days.reduce((sum,date)=>sum+dayItems(date).length,0),weekAll=all.filter(item=>days.includes(item.effectiveDate)).length;
    const undated=items.filter(item=>!item.effectiveDate).sort(byTime);
    const invite=!all.length&&!calendarPending?`<div class="ap-empty-board"><p><strong>На доске пока пусто.</strong> Заполните вводные в «Настройках модуля», затем нажмите «Составить план» — или «Создать публикацию» вручную.</p><p><a href="#content-factory/settings">Перейти в «Настройки модуля»</a></p></div>`:'';
    const filtered=!weekTotal&&weekAll?`<p class="ap-filter-empty">По выбранным фильтрам на этой неделе публикаций нет. <button type="button" class="plain-button" data-filter-reset>Сбросить фильтры</button></p>`:'';
    const board=`<div class="ap-board" style="--ap-days:${days.length}" aria-label="Неделя: ${esc(weekLabel(days))}">${days.map(date=>{const list=dayItems(date);
      return `<section class="ap-day${date===today()?' is-today':''}${selectedDate===date?' is-selected':''}" data-board-day="${date}" aria-labelledby="ap-day-${date}"><h3 class="ap-day-head" id="ap-day-${date}">${esc(dayLabel(date))}${date===today()?' <span class="ap-today">Сегодня</span>':''}<span class="ap-day-count" aria-label="публикаций ${list.length}">${list.length||''}</span></h3>
        ${list.length?`<ul class="ap-day-list">${list.map(renderDailyCard).join('')}</ul>`:'<p class="ap-day-empty">Нет публикаций</p>'}</section>`;}).join('')}</div>`;
    const undatedBlock=`<section class="ap-undated autoposting-undated" data-board-day="undated" aria-labelledby="ap-undated-title"><h3 id="ap-undated-title">Без даты · ${undated.length}</h3>${undated.length?`<p class="autoposting-note">Дата публикации не назначена. Откройте карточку, чтобы назначить дату.</p><ul class="ap-undated-list">${undated.map(renderDailyCard).join('')}</ul>`:'<p class="autoposting-note">Публикаций без даты нет.</p>'}</section>`;
    get('autoposting-posts').innerHTML=invite+filtered+board+undatedBlock;
    renderBatch();
  };
  /* Корзина читается отдельно: если сервер её ещё не умеет, раздел просто скрыт, а материалы работают как прежде. */
  const renderTrash=()=>{
    const box=get("autoposting-trash");box.hidden=!trashPosts.length;get("autoposting-trash-count").textContent=String(trashPosts.length);
    get("autoposting-trash-list").innerHTML=trashPosts.map(item=>`<li><strong>${esc(item.title)}</strong><p class="autoposting-note">№${esc(item.id)} · удалено ${esc(item.deleted?.at?time.toLocal(item.deleted.at,zone()).replace("T"," "):"")}${item.deleted?.byName?" · "+esc(item.deleted.byName):""}${item.deleted?.comment?" · "+esc(item.deleted.comment):""}</p><button type="button" class="plain-button" data-trash-restore="${esc(item.id)}">Восстановить</button></li>`).join("");
    controls();
  };
  const loadTrash=async()=>{
    const version=epoch,code=companyCode;
    try{const result=await request("/autoposting/trash");if(version!==epoch)return;
      if(result.companyCode!==code||!Array.isArray(result.posts)||result.posts.some(item=>item.companyCode!==code))throw Error("Wrong trash scope");
      trashPosts=result.posts;}
    catch(_){if(version===epoch)trashPosts=[];}
    if(version===epoch)renderTrash();
  };
  const loadCalendar=async()=>{
    const version=epoch,calendarVersion=++calendarEpoch,code=companyCode,range=dateRange();calendarPending=true;calendarData=null;renderCalendar();controls();
    try{const result=await ctx.apiJson(endpoint('/autoposting/calendar')+'&from='+range.from+'&to='+range.to);
      if(version!==epoch||calendarVersion!==calendarEpoch)return;
      if(result.companyCode!==code||result.from!==range.from||result.to!==range.to||!Array.isArray(result.posts)||!Array.isArray(result.undated)||[...result.posts,...result.undated].some(item=>item.companyCode!==code))throw Error('Wrong calendar scope');
      calendarData=result;
      const merged=new Map(posts.map(item=>[item.id,item]));for(const item of [...result.posts,...result.undated])if(!merged.has(item.id)||merged.get(item.id).revision<item.revision)merged.set(item.id,item);posts=[...merged.values()].filter(isActive);
    }catch(_){if(version===epoch&&calendarVersion===calendarEpoch)calendarData=null;}
    finally{if(version===epoch&&calendarVersion===calendarEpoch){calendarPending=false;renderList();controls();}}
  };
  const renderList=()=>{
    get("autoposting-select").innerHTML='<option value="">Новый черновик</option>'+posts.map(item=>`<option value="${esc(item.id)}">${esc(item.title)} — ${esc(statusLabel(item))}</option>`).join("");
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
    finally{if(version===epoch){busy=false;controls();consumeOpen();}}
  };
  /* CF3-BOARD: редактор публикации — тот же единственный <details>, открытый окном поверх доски.
     Закрытие не теряет ввод: несохранённые правки остаются в памяти окна (stash) и отмечаются на карточке. */
  const editorNode=get('autoposting-editor');let editorOpenerId=null;
  // Заголовок окна следует за текущей карточкой: после сохранения, обновления и смены карточки.
  function editorBar(){
    get('autoposting-editor-title').textContent=post?`Публикация: ${post.title||'Без названия'}`:'Новая публикация';
    get('autoposting-editor-note').textContent=post?`${statusLabel(post)}${Number.isSafeInteger(post.contentRevision)?` · содержимое v${post.contentRevision}`:''}`:'Черновик ничего не публикует до согласования и назначения времени';
  }
  const syncEditor=()=>{container.ownerDocument.body.classList.toggle('autoposting-modal-open',editorNode.open);editorBar();};
  const openEditor=()=>{editorNode.open=true;syncEditor();get('autoposting-editor-title').focus?.({preventScroll:true});};
  const closeEditor=(quiet=false)=>{
    if(!editorNode.open)return;const unsaved=settings&&information&&dirty();stash();editorNode.open=false;syncEditor();renderCalendar();controls();
    if(unsaved&&!quiet)message('Окно закрыто. Несохранённые правки остались в этом окне и отмечены на карточке — откройте её, чтобы продолжить и сохранить.');
    const back=editorOpenerId&&[...container.querySelectorAll('[data-open-post]')].find(node=>node.dataset.openPost===editorOpenerId);editorOpenerId=null;if(back&&!quiet)back.focus?.();
  };
  editorNode.addEventListener('toggle',syncEditor);
  container.addEventListener("click",event=>{
    const target=event.target.closest("#autoposting-archive-button,#autoposting-archive-yes,#autoposting-archive-no,[data-restore-post],[data-archive-reload]");if(!target||target.disabled)return;
    if(target.id==="autoposting-archive-button"){if(busy||dirty())return;archiveConfirm=true;renderArchiveZone();controls();get("autoposting-archive-no")?.focus?.();}
    else if(target.id==="autoposting-archive-no"){archiveConfirm=false;renderArchiveZone();controls();get("autoposting-archive-button")?.focus?.();}
    else if(target.id==="autoposting-archive-yes")archivePost();
    else if(target.dataset.restorePost)restorePost(target.dataset.restorePost);
    else void loadArchive();
  });
  // CF6: раскрытие истории запоминается по карточке; на ввод в форме оно не влияет.
  // CF23: раскрытие полной истории и панели версии запоминается по компании и карточке.
  container.addEventListener("toggle",event=>{const node=event.target;
    if(node?.matches?.("[data-ap-history]")){const key=historyKey(node.dataset.apHistory);if(node.open){historyOpenFull.add(key);void loadHistory(Number(node.dataset.apHistory));}else historyOpenFull.delete(key);}
    else if(node?.matches?.("[data-variant]")&&post){const key=companyCode+":"+post.id;if(node.open)variantOpen.add(key);else variantOpen.delete(key);}},true);
  container.addEventListener("click",event=>{
    const target=event.target.closest("#autoposting-variant-create,[data-variant-open],[data-history-more],[data-history-retry]");if(!target||target.disabled)return;
    if(target.id==="autoposting-variant-create")void createVariant();
    else if(target.dataset.variantOpen){const id=Number(target.dataset.variantOpen),key=post&&companyCode+":"+post.id,job=key&&variantJobs.get(key);
      void openFresh(id,job&&job.childId===id?{job,sourceId:post.id}:{});}
    else if(post&&target.matches("[data-history-more]"))void loadHistory(post.id,true);
    else if(post&&target.matches("[data-history-retry]")){const state=fullHistory.get(historyKey(post.id));void loadHistory(post.id,Boolean(state?.items.length));}
  });
  container.addEventListener("toggle",event=>{const node=event.target;if(!node?.matches?.("[data-review-history]"))return;const key=`${companyCode}:${node.dataset.reviewHistory}`;if(node.open)historyOpen.add(key);else historyOpen.delete(key);},true);
  get("autoposting-archive").addEventListener("toggle",()=>{if(get("autoposting-archive").open&&archivedState!=="loading")void loadArchive();});
  container.addEventListener('click',event=>{const button=event.target.closest('.ap-hint');if(!button)return;const note=container.querySelector('#'+button.getAttribute('aria-controls'));const open=button.getAttribute('aria-expanded')!=='true';button.setAttribute('aria-expanded',String(open));if(note)note.hidden=!open;});
  /* CF3-R1: несохранённый ввод живёт только в памяти окна (stash по карточкам). При закрытии или перезагрузке
     вкладки браузер спрашивает подтверждение; без несохранённого ввода не мешаем. */
  window.addEventListener('beforeunload',event=>{
    if(!settings||!information||!(dirty()||drafts.size||pendingNotes.size))return;
    event.preventDefault();event.returnValue='';
  });
  get('autoposting-editor-close').addEventListener('click',()=>closeEditor());
  editorNode.addEventListener('click',event=>{if(event.target===editorNode)closeEditor();});
  container.addEventListener('keydown',event=>{if(event.key==='Escape'&&editorNode.open){event.preventDefault();closeEditor();}});
  const selectPost=id=>{stash();post=posts.find(item=>String(item.id)===String(id))||null;selections.set(companyCode,post?.id||null);renderPost();get("autoposting-select").value=post?String(post.id):"";openEditor();};
  const openLinkedPost=async()=>{
    const link=pendingLink||materialLink(window.location.hash);
    if(!link||(!pendingLink&&link.key===handledLink)||busy)return;
    if(link.error||!companies.some(item=>item.code===link.company)){
      pendingLink=null;handledLink=link.key;message('Материал по ссылке недоступен или ссылка неверна. Проверьте выбранную компанию и доступ.');return;
    }
    if(link.company!==companyCode){
      pendingLink=link;
      if(ctx.chooseProject)ctx.chooseProject(link.company);else await load(link.company);
      return;
    }
    pendingLink=null;handledLink=link.key;
    const version=epoch,requestVersion=++linkEpoch;busy=true;controls();
    try{
      // Прямой GET нужен даже если карточки нет в первом списке или текущем месяце.
      const item=await request('/autoposting/posts/'+link.id);
      if(version!==epoch||requestVersion!==linkEpoch)return;
      if(item.companyCode!==companyCode||item.id!==link.id)throw Error('Wrong material scope');
      if(archivedAt(item)){showArchived(item);return;}
      posts=[item,...posts.filter(value=>value.id!==item.id)];renderList();selectPost(item.id);
      message(dirty()?'У материала есть несохранённые правки в этом окне. Они сохранены; завершите правку и заново проверьте предпросмотр перед согласованием.':
        item.contentRevision===link.revision?'Материал открыт. Проверьте предпросмотр перед согласованием.':
        'После уведомления материал изменился. Открыта текущая версия; проверьте её заново перед согласованием.');
    }catch(_){if(version===epoch&&requestVersion===linkEpoch)message('Не удалось открыть материал по ссылке. Он удалён, недоступен или временно не загружается.');}
    finally{if(version===epoch&&requestVersion===linkEpoch){busy=false;controls();}}
    const next=materialLink(window.location.hash);
    if(version===epoch&&requestVersion===linkEpoch&&next&&next.key!==link.key)await openLinkedPost();
  };
  const load=async(code,refresh=false)=>{
    if(refresh)handledLink='';
    stash();get("autoposting-photo").value="";get("autoposting-channels").querySelectorAll('input[type="password"]').forEach(node=>{node.value="";});
    get('autoposting-channels').querySelectorAll('[data-profile-diagnostics]').forEach(node=>node.remove());
    companyCode=code;const version=++epoch;fullHistory.clear();trashPosts=[];renderTrash();calendarEpoch++;archivedEpoch++;archived=null;archivedState="";archiveFocus=null;renderArchive();calendarData=null;calendarPending=false;approvalSelection.clear();approvalResults.clear();approvalBlocked.clear();renderBatch();posts=[];get('autoposting-posts').replaceChildren();get('autoposting-calendar').replaceChildren();get('autoposting-batch-results').replaceChildren();get('autoposting-calendar-state').textContent='';get('autoposting-calendar-zone').textContent='';get('autoposting-plan-gaps').hidden=true;get('autoposting-plan-gaps').textContent='';get('autoposting-editor').open=false;syncEditor();busy=true;settings=null;information=null;starterPlan=null;post=null;get("autoposting-company").value=code;renderStarterPlan();
    get('autoposting-channels').querySelectorAll('[data-channel-links]').forEach(node=>node.replaceChildren());get('autoposting-planning').replaceChildren();
    get("vk-connection-guide").innerHTML='<h3 id="vk-connection-title">Подключение ВКонтакте</h3><p>Загружаем настройки выбранной компании…</p>';controls();
    if(!code){busy=false;get("vk-connection-guide").textContent="Выберите доступную компанию.";message("Нет доступных компаний.");controls();return;}
    message("Загружаем материалы и подключения…");
    try{const result=await Promise.all([request("/autoposting/settings"),request("/autoposting/posts"),request("/company-information"),request('/autoposting/starter-plan')]);if(version!==epoch)return;
      if(result[1].companyCode!==code||result[2].companyCode!==code||result[3].companyCode!==code)throw Error("Wrong company");
      [settings,,information,starterPlan]=result;posts=Array.isArray(result[1].posts)?result[1].posts.filter(isActive):[];
      if(!(refresh&&month)){month=time.toLocal(new Date().toISOString(),zone()).slice(0,7);week=weekIndexOf(month,today());}selectedDate="";
      post=posts.find(item=>item.id===selections.get(code))||null;
      renderChannels();renderList();renderPost();renderStarterPlan();message(edit()?"":"Доступ только для просмотра.");
      if(get("autoposting-archive").open)void loadArchive();
      await loadCalendar();await loadTrash();
    }catch(_){if(version===epoch){get("vk-connection-guide").textContent="Не удалось получить статус подключения выбранной компании. Обновите статусы.";message("Не удалось загрузить автопостинг. Ввод сохранён в текущем окне; повторите обновление.");}}
    finally{if(version===epoch){busy=false;controls();}}
    if(version===epoch&&settings&&information){await openLinkedPost();consumeOpen();}
  };
  /* CF2: черновики, созданные сервером из предложений контент-завода. Список перечитывается,
     черновик открывается прямым GET (его может не быть в первом списке). Одобрение и расписание
     остаются отдельными действиями в редакторе. */
  window.addEventListener('sb:content-factory-drafts',event=>{if(event.detail?.companyCode===companyCode&&!busy)void load(companyCode,true);});
  /* CF6: открытие по запросу из предложений или из статистики. Запрос ждёт окончания загрузки (вкладка могла
     только открыться) и выполняется только для той же компании: после смены компании он отбрасывается. Запрос из
     статистики пришёл и в общем слоте cabinet.pendingMaterialOpen — на случай, если вкладка ещё не была создана. */
  let pendingOpen=null;
  const consumeOpen=()=>{
    const req=pendingOpen||cabinet.pendingMaterialOpen;if(!req)return;
    if(busy||!settings||!information)return; // повторится после загрузки
    const lower=value=>String(value||'').toLowerCase(),same=lower(req.companyCode)===lower(companyCode);
    // Кабинет уже выбрал компанию запроса, а вкладка ещё не перешла на неё — ждём её загрузки.
    if(!same&&lower(ctx.selectedProjectId)===lower(req.companyCode))return;
    pendingOpen=null;const slot=cabinet.pendingMaterialOpen;if(slot&&slot.companyCode===req.companyCode&&Number(slot.postId)===Number(req.postId))cabinet.pendingMaterialOpen=null;
    const id=Number(req.postId),source=req.source==='stats'||req.source==='sources'?req.source:'proposal';
    const FROM={stats:'из статистики',sources:'из «Исходников»'};
    if(!same||!Number.isSafeInteger(id)||id<1){if(FROM[source])message(`Материал ${FROM[source]} не открыт: выбрана другая компания.`);return;}
    const version=epoch;busy=true;controls();
    void (async()=>{try{const item=await request('/autoposting/posts/'+id);if(version!==epoch)return;
      if(item.companyCode!==companyCode||item.id!==id)throw Error('Wrong material scope');
      if(archivedAt(item)){showArchived(item);return;}
      posts=[item,...posts.filter(value=>value.id!==item.id)];renderList();selectPost(item.id);
      // Состояние — по текущему DTO: ранее созданный материал мог быть уже согласован, запланирован или опубликован.
      const approval=item.approval?(item.approval.approved&&!item.approval.stale?'согласован':item.approval.stale?'согласование снято после правки':'не согласован'):'';
      // CF13: из «Исходников» — свежая карточка, а не квитанция прикрепления (её повтор возвращает первоначальный результат).
      message(FROM[source]?`Материал №${item.id} открыт ${FROM[source]}. Текущее состояние: ${statusLabel(item)}, содержимое v${item.contentRevision}.`
        :`Материал из предложения открыт: ${STATUS[item.status]||'статус неизвестен'}${approval?', '+approval:''}. Проверьте предпросмотр перед согласованием.`);
    }catch(_){if(version===epoch)message(FROM[source]?`Не удалось открыть материал ${FROM[source]}. Он недоступен или временно не загружается.`:'Не удалось открыть черновик. Он удалён, недоступен или временно не загружается.');}
    finally{if(version===epoch){busy=false;controls();}}})();
  };
  window.addEventListener('sb:content-factory-open-draft',event=>{
    const detail=event.detail||{};if(typeof detail.companyCode!=='string')return;
    pendingOpen={companyCode:detail.companyCode,postId:Number(detail.postId),source:detail.source};consumeOpen();
  });
  /* Снятие переключателя — осознанное решение владельца: с этого момента карточка везёт
     явное false, а не «поля нет». Отметка ставится до пересчёта формы. */
  const markOption=event=>{const node=event.target.closest('[data-option]');if(node&&node.type==='checkbox')optionTouched.add(node.dataset.option);};
  form.addEventListener("input",event=>{markOption(event);stash();invalidate();syncVariantDirty();if(event.target.id==="autoposting-media")renderMediaPreview();});
  form.addEventListener("change",event=>{markOption(event);stash();invalidate();syncVariantDirty();});
  get("autoposting-import-state").addEventListener("click",event=>{
    const target=event.target.closest("[data-import-archive]");if(!target)return;
    const id=Number(target.dataset.importArchive);archiveFocus=Number.isSafeInteger(id)&&id>0?id:null;
    const node=get("autoposting-archive");node.open=true;void loadArchive();node.scrollIntoView?.({block:"nearest"});
  });
  get("autoposting-import").addEventListener("click",()=>{
    if(busy||!edit()||!settings)return;let body;
    try{body=JSON.parse(get("autoposting-import-json").value);}catch(_){get("autoposting-import-state").textContent="Некорректный JSON пакета.";return;}
    if(!body||!Array.isArray(body.items)){get("autoposting-import-state").textContent="Ожидается объект с массивом items.";return;}
    void run(async current=>{const result=await request("/autoposting/import","POST",body);if(!current())return;if(result.companyCode!==companyCode)throw Error("Wrong company");
      const list=await request("/autoposting/posts");if(!current())return;posts=Array.isArray(list.posts)?list.posts:posts;renderList();
      const pending=Array.isArray(result.mediaPending)?result.mediaPending:[];
      /* Пропуски бывают разные, и называть их все дублями нечестно: карточка с другими
         публикуемыми опциями — это НЕ то же содержимое, и владелец должен увидеть её отдельно.
         Всё выводится через textContent, поэтому текст note с сервера остаётся текстом. */
      const skipped=Array.isArray(result.skipped)?result.skipped:[];
      const card=item=>`№${item.id??"—"}${item.dayKey?" · "+item.dayKey:""}${item.title?" · "+item.title:""}`;
      const note=item=>typeof item.note==="string"&&item.note.trim()?` — ${item.note.trim().slice(0,300).replace(/[.\s]+$/,"")}`:"";
      /* CF7: совпадение с удалённой карточкой — не «уже в плане»: на доске её нет, и импорт её не восстановил. */
      const removed=item=>typeof item.archivedAt==="string"&&item.archivedAt.trim()!=="";
      const groups=[
        ["archived","Совпадают с удалёнными из плана — импорт их не восстановил, на доске их нет",item=>removed(item)],
        ["duplicate","Уже были в плане (тот же материал)",item=>!removed(item)&&(!item.reason||item.reason==="duplicate")],
        ["options_differ","Не добавлены: у сохранённой карточки другие публикуемые опции",item=>!removed(item)&&item.reason==="options_differ"],
        ["other","Пропущены по другой причине",item=>!removed(item)&&item.reason&&item.reason!=="duplicate"&&item.reason!=="options_differ"],
      ].map(([key,label,match])=>({key,label,items:skipped.filter(match)})).filter(group=>group.items.length);
      const card_=item=>removed(item)?`${card(item)} · удалено ${when(item.archivedAt)}`:card(item);
      const lines=[`Создано черновиков: ${result.created.length}.`];
      if(!skipped.length)lines.push("Пропущенных материалов нет.");
      for(const group of groups)lines.push(`${group.label} (${group.items.length}): ${group.items.map(item=>card_(item)+note(item)).join("; ")}.`);
      lines.push("Согласование и публикация не выполнялись. Сохранённые карточки пакет не переписывает.");
      if(pending.length)lines.push(`Ждут загрузки видео: ${pending.map(item=>`${item.dayKey||"—"} ${item.file||"файл из пакета"}`).join(", ")}.`);
      const state_=get("autoposting-import-state");state_.textContent=lines.join(" ");
      const archivedItems=groups.find(group=>group.key==="archived")?.items||[];
      if(archivedItems.length){const open=document.createElement("button");open.type="button";open.className="plain-button";open.dataset.importArchive=String(archivedItems[0].id??"");
        open.textContent="Открыть «Удалённые материалы»";state_.append(" ",open);}
      // Итог не обещает созданные карточки, когда их нет.
      const differ=groups.find(group=>group.key==="options_differ")?.items.length||0;
      message(result.created.length
        ?`Пакет импортирован: черновиков создано ${result.created.length}.${skipped.length?` Пропущено материалов: ${skipped.length} — причины указаны ниже.`:""}`
        :archivedItems.length&&archivedItems.length===skipped.length
          ?"Новых черновиков не создано: материалы пакета совпадают с удалёнными из плана. Импорт их не восстановил — вернуть можно в «Удалённых материалах»."
        :differ
          ?"Новых черновиков не создано: у сохранённых карточек другие публикуемые опции. Проверьте их вручную — пакет ничего не переписал."
          :groups.some(group=>group.key==="other")
            ?"Новых черновиков не создано: материалы пропущены — проверьте причины ниже."
            :archivedItems.length
              ?"Новых черновиков не создано: часть материалов уже в плане, часть совпадает с удалёнными из плана — импорт их не восстановил. Причины указаны ниже."
            :skipped.length
              ?"Новых черновиков не создано: все материалы пакета уже были в плане."
              :"Новых черновиков не создано: в пакете не оказалось материалов для добавления.");
    },"Импортируем пакет…","Не удалось импортировать пакет. Проверьте JSON и ссылки на материалы (только HTTP(S)).");
  });
  form.addEventListener("submit",event=>{
    event.preventDefault();if(busy||!edit()||!settings||(post&&!EDITABLE.has(post.status))||!form.reportValidity())return;
    let data;try{data=read();}catch(error){message(error.message);return;}
    if(!data.title||(!data.text&&!Object.keys(data.captions).length&&!mediaOnlyStory(data))){message("Заполните название и текст материала или подписи площадок. Без текста сохраняется только сторис с материалом.");return;}
    void run(async current=>{const oldKey=key();const result=await request("/autoposting/posts"+(post?"/"+encodeURIComponent(post.id):""),post?"PATCH":"POST",{...data,...(post?{revision:post.revision}:{})});if(!current())return;
      drafts.delete(oldKey);post=result;posts=[result,...posts.filter(item=>item.id!==result.id)];selections.set(companyCode,result.id);renderList();renderPost();message("Черновик сохранён. Откройте предпросмотр перед постановкой в план.");
    },"Сохраняем черновик…","Не удалось сохранить. Ввод остался в форме; версия могла измениться в другом окне.");
  });
  get("autoposting-preview").addEventListener("click",()=>{
    if(busy||!post||dirty())return;const issues=problems();reviewed=post.revision;
    get("autoposting-preview-content").innerHTML=`<h4>${esc(post.title)}</h4>${(post.platformIds||[]).includes("youtube_shorts")?`<p class="autoposting-note" data-youtube-title>Публичный заголовок YouTube Shorts: «${esc(post.title)}» · ${esc(String(post.title||"").length)} / 100 · публичный доступ</p>`:""}<pre>${esc(post.text)}</pre><p>${post.scheduledAt?esc(time.toLocal(post.scheduledAt,post.timezone).replace("T"," ")+" · "+post.timezone):"Дата не задана"}</p>
      <p>Площадки: ${post.platformIds.map(id=>esc(channels().find(item=>item.id===id)?.name||platformLabel(id))).join(", ")||"не выбраны"}</p>
      ${(post.mediaUrls||[]).length?`<ul class="autoposting-media-preview">${mediaPreview(post.mediaUrls)}</ul>`:post.readiness?.textOnly?"<p>Текстовая публикация в Telegram / ВКонтакте: изображение не требуется.</p>":"<p>Материал не прикреплён.</p>"}
      ${Object.keys(post?.platformOptions||{}).length?`<div class="autoposting-platform-options-preview"><h4>Как это выйдет на площадках</h4>${Object.entries(post.platformOptions).map(([platform,options])=>`<p><strong>${esc(CAPTIONS.find(item=>item[0]===platform)?.[1]||platform)}</strong>: ${esc(optionWords(platform,options).join("; ")||"без особых настроек")}</p>`).join("")}<p class="autoposting-note">Эти настройки утверждаются вместе с текстом: их правка снимает согласование.</p></div>`:""}${isQueueCard(post)?`<p>Версия ${esc(post.revision)}${post.dayKey?" · день "+esc(post.dayKey):""}${post.origin?" · "+esc(post.origin):""}</p><div class="autoposting-platform-previews">${CAPTIONS.map(([id,label,limit,,source])=>{const caption=post.captions?.[id]||post.text||"";
        /* То же пояснение, что у поля подписи и у счётчика: у 2ГИС 2000 — внутренний предел
           нашего поля, а не подтверждённый лимит площадки. Иначе предпросмотр обещает знание
           о внешнем сервисе, которого у нас нет. */
        const internal=source==="internal";
        const over=caption.length>limit?(internal?" · превышен внутренний предел поля":" · превышен лимит"):"";
        return `<details${post.captions?.[id]?" open":""}><summary>${label} · ${caption.length} / ${limit}${internal?" · внутренний предел поля, лимит площадки не подтверждён":""}${over}${post.captions?.[id]?"":" · общий текст"}${deliveryState(id).ready?"":" · "+deliveryState(id).label}</summary><pre>${esc(caption)}</pre></details>`;}).join("")}</div>`:""}
      ${issues.length?`<ul class="autoposting-issues">${issues.map(item=>`<li>${esc(item)}</li>`).join("")}</ul>`:"<p>Материал готов к постановке в план.</p>"}`;
    // Файл показан один раз: после предпросмотра — в нём, а не ещё и в списке файлов формы.
    if((post.mediaUrls||[]).length)get("autoposting-media-preview").closest(".ap-editor-media").hidden=true;controls();
    const heading=get("autoposting-preview-title");heading.focus({preventScroll:true});
    heading.scrollIntoView?.({block:"start",behavior:window.matchMedia?.("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"});
  });
  get("autoposting-schedule").addEventListener("click",()=>{
    if(!edit()||!readyToSchedule())return;
    const selectedTargets=scheduleTargets(post,read().platformIds);
    const targets=requiresApproval(post)&&!post.approval?.approved&&approvedPlatforms(post).length?selectedTargets:null;
    if(targets&&!targets.length){message("Ни одна площадка этой версии не согласована: ставить в план нечего.");return;}
    void run(async current=>{invalidate();const result=await request("/autoposting/posts/"+encodeURIComponent(post.id)+"/schedule","POST",{revision:post.revision,...(targets?{platformIds:targets}:{})});if(!current())return;
      post=result;posts=posts.map(item=>item.id===result.id?result:item);drafts.delete(key());renderList();renderPost();
      message(targets?`Материал поставлен в план для согласованных площадок: ${targets.map(platformLabel).join(", ")}. Остальные площадки остались в карточке и не отправляются.`:"Материал поставлен в план. Публикация будет отправлена автоматически в указанное время.");
    },"Ставим материал в план…","Не удалось подтвердить постановку в план. Обновите статусы и заново проверьте материал.");
  });
  get("autoposting-cancel").addEventListener("click",()=>{
    if(!edit()||!post||!["scheduled","publishing"].includes(post.status))return;
    void run(async current=>{const result=await request("/autoposting/posts/"+encodeURIComponent(post.id)+"/cancel","POST",{revision:post.revision});if(!current())return;post=result;posts=posts.map(item=>item.id===result.id?result:item);renderList();renderPost();message("Материал снят с очереди. Уже начатую публикацию площадка может завершить.");
    },"Отменяем публикацию…","Не удалось подтвердить отмену. Обновите статусы.");
  });
  /* Удаление в корзину — второе нажатие той же кнопки по той же версии: без системных окон подтверждения. */
  get("autoposting-delete").addEventListener("click",()=>{
    if(busy||!edit()||!post||dirty()||!DELETABLE_STATUSES.has(post.status))return;
    const armed=post.id+":"+post.revision;
    if(deleteArmed!==armed){deleteArmed=armed;get("autoposting-delete").textContent="Подтвердить удаление";message(`Нажмите «Подтвердить удаление», чтобы убрать «${post.title}» в корзину. Файлы и история сохранятся, материал можно восстановить.`);return;}
    const target=post;deleteArmed="";
    void run(async current=>{const result=await request("/autoposting/posts/"+encodeURIComponent(target.id)+"/delete","POST",{revision:target.revision});if(!current())return;
      if(result.companyCode!==companyCode||result.id!==target.id||!result.deleted)throw Error("Wrong delete result");
      drafts.delete(key());posts=posts.filter(item=>item.id!==target.id);post=null;selections.set(companyCode,null);trashPosts=[result,...trashPosts.filter(item=>item.id!==result.id)];
      renderList();renderPost();renderTrash();message(`Материал «${target.title}» перемещён в корзину. Его можно восстановить.`);
      await loadCalendar();
    },"Перемещаем материал в корзину…","Не удалось подтвердить удаление. Обновите статусы: материал мог измениться или уже стоит в очереди.");
  });
  get("autoposting-trash-list").addEventListener("click",event=>{
    const button=event.target.closest("[data-trash-restore]");if(!button||busy||!edit())return;
    const item=trashPosts.find(value=>String(value.id)===button.dataset.trashRestore);if(!item)return;
    void run(async current=>{const result=await request("/autoposting/posts/"+encodeURIComponent(item.id)+"/restore","POST",{revision:item.revision});if(!current())return;
      if(result.companyCode!==companyCode||result.id!==item.id||result.deleted)throw Error("Wrong restore result");
      trashPosts=trashPosts.filter(value=>value.id!==item.id);posts=[result,...posts.filter(value=>value.id!==item.id)];
      renderList();renderTrash();message(`Материал «${item.title}» восстановлен в прежнем виде.`);
      await loadCalendar();
    },"Восстанавливаем материал…","Не удалось подтвердить восстановление. Обновите статусы.");
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
      message(video?(expected?(uploaded.sha256===expected?"Видео загружено, хеш совпадает с пакетом. Сохраните карточку.":"Видео загружено, но его хеш не совпадает с пакетом — это не тот ролик. Сохранить можно, согласовать нельзя."):"Видео загружено в черновик. Сохраните материал перед предпросмотром."):"Фото добавлено в черновик. Сохраните материал перед публикацией.");
    },video?"Загружаем видео…":"Загружаем фото…",video?"Не удалось загрузить видео. Нужен MP4 или WebM до 60 МБ.":"Не удалось загрузить фото. Нужен JPEG, PNG или WebP до 10 МБ.");
  });
  get("autoposting-refresh").addEventListener("click",()=>{void load(companyCode,true);});
  // Фильтры доски только меняют показ: запросов на запись нет, выбор и правки сохраняются.
  for(const [id,field] of [['autoposting-daily-platform','platform'],['autoposting-filter-format','format'],['autoposting-filter-role','role'],['autoposting-filter-status','status']])
    get(id).addEventListener('change',()=>{boardFilter[field]=get(id).value;renderCalendar();controls();});
  const resetFilters=()=>{for(const key of Object.keys(boardFilter))boardFilter[key]='';for(const id of ['autoposting-daily-platform','autoposting-filter-format','autoposting-filter-role','autoposting-filter-status'])get(id).value='';renderCalendar();controls();};
  get('autoposting-filter-reset').addEventListener('click',resetFilters);
  get('autoposting-filters-toggle').addEventListener('click',()=>{filtersOpen=!filtersOpen;renderCalendar();controls();});
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
          const targets=batchTargets(latest);
          if(targets&&!targets.length){
            approvalResults.set(id,{title:snapshot.title,message:'Пропущено: у этого материала нет отмеченных площадок. Решение к нему не применялось.'});
            renderBatch();renderList();renderCalendar();controls();continue;
          }
          // «Уже согласовано» считается по выбранным площадкам, а не по карточке целиком.
          const decided=(latest.platformApprovals||[]).filter(entry=>!targets||targets.includes(entry.platformId));
          const alreadyApproved=targets?decided.length&&decided.every(entry=>entry.approved):Boolean(latest.approval?.approved&&!latest.approval?.stale);
          if(alreadyApproved){
            approvalResults.set(id,{title:snapshot.title,message:targets?'Отмеченные площадки уже согласованы для этой версии.':'Уже согласовано: повторное согласование не требуется.'});
            renderBatch();renderList();renderCalendar();controls();continue;
          }
          if(!permitted(ctx,'approve')||latest.companyCode!==snapshot.companyCode||latest.id!==snapshot.id||latest.revision!==snapshot.revision||latest.contentRevision!==snapshot.contentRevision||!latest.readiness?.ready||!EDITABLE.has(latest.status)||latest.deliveries?.some(item=>['published','publishing','needs_review'].includes(item.status)))throw Error('Version changed');
          const result=await request('/autoposting/posts/'+encodeURIComponent(id)+'/approve','POST',{revision:snapshot.revision,approved:true,...(targets?{platformIds:targets}:{})});if(!current())return;
          /* Подтверждение проверяется по решениям именно выбранных площадок этой версии содержимого:
             требовать глобального approved нельзя — при частичном решении его законно нет. */
          const confirmed=targets
            ?targets.every(platform=>(result.platformApprovals||[]).some(entry=>entry.platformId===platform&&entry.approved&&entry.contentRevision===snapshot.contentRevision))
            :Boolean(result.approval?.approved);
          if(result.companyCode!==snapshot.companyCode||result.id!==snapshot.id||result.contentRevision!==snapshot.contentRevision||!confirmed)throw Error('Approval unconfirmed');
          posts=posts.map(item=>item.id===result.id?result:item);
          if(post?.id===result.id){post=result;renderPost();}
          approvalResults.set(id,{title:snapshot.title,message:targets
            ?`Согласована версия ${snapshot.contentRevision} для площадок: ${targets.map(platformLabel).join(', ')}. Остальные площадки не затронуты, публикация не запускалась.`
            :`Согласована версия ${snapshot.contentRevision}. Публикация не запускалась.`});
        }catch(_){if(!current())return;approvalResults.set(id,{title:snapshot.title,message:'Согласование не подтверждено. Обновите статусы и проверьте версию перед новым выбором.'});}
        renderList();controls();
      }
      message('Проверка выбранных материалов завершена. Результат указан для каждой карточки; публикация не запускалась.');
    },'Согласуем выбранные версии…','Не удалось подтвердить согласование. Обновите статусы перед новым выбором.');
  });
  get("autoposting-select").addEventListener("change",()=>selectPost(get("autoposting-select").value));
  get('autoposting-batch-reject').addEventListener('click',()=>{
    if(busy||calendarPending||!permitted(ctx,'approve')||!approvalSelection.size)return;
    const comment=get('autoposting-batch-reason').value.trim();
    if(!comment){message('Укажите причину возврата: без неё материал не возвращают.');get('autoposting-batch-reason').focus();return;}
    const selected=[...approvalSelection.values()];
    void run(async current=>{
      // Отдельный вызов существующего /reject на каждый материал: результат по каждому свой, ничего не публикуется.
      for(const snapshot of selected){
        if(!current()||!permitted(ctx,'approve'))return;
        const id=String(snapshot.id);approvalSelection.delete(id);approvalBlocked.add(id);
        try{
          const latest=await request('/autoposting/posts/'+encodeURIComponent(id),'GET');if(!current())return;
          if(!permitted(ctx,'approve')||latest.companyCode!==snapshot.companyCode||latest.id!==snapshot.id||latest.revision!==snapshot.revision||latest.contentRevision!==snapshot.contentRevision)throw Error('Version changed');
          const targets=batchTargets(latest);
          if(targets&&!targets.length){
            approvalResults.set(id,{title:snapshot.title,message:'Пропущено: у этого материала нет отмеченных площадок. Решение к нему не применялось.'});
            renderBatch();renderList();renderCalendar();controls();continue;
          }
          const result=await request('/autoposting/posts/'+encodeURIComponent(id)+'/reject','POST',{revision:snapshot.revision,comment,...(targets?{platformIds:targets}:{})});if(!current())return;
          // При частичном возврате общий статус карточки законно остаётся прежним: проверяем решения выбранных площадок.
          const confirmed=targets
            ?targets.every(platform=>(result.platformApprovals||[]).some(entry=>entry.platformId===platform&&entry.state==='rejected'&&entry.contentRevision===snapshot.contentRevision))
            :result.review?.state==='rejected';
          if(result.companyCode!==snapshot.companyCode||result.id!==snapshot.id||!confirmed)throw Error('Rejection unconfirmed');
          posts=posts.map(item=>item.id===result.id?result:item);if(post&&post.id===result.id)post=result;
          approvalResults.set(id,{title:snapshot.title,message:targets
            ?`Возвращены на доработку площадки: ${targets.map(platformLabel).join(', ')}. Версия ${snapshot.contentRevision}, остальные площадки не затронуты.`
            :`Возвращено на доработку с причиной. Версия ${snapshot.contentRevision}, публикация не запускалась.`});
        }catch(_){if(!current())return;approvalResults.set(id,{title:snapshot.title,message:'Возврат не подтверждён. Обновите статусы и проверьте версию перед новой попыткой.'});}
        renderBatch();renderList();renderCalendar();controls();
      }
      get('autoposting-batch-reason').value='';renderApproval();
    },'Возвращаем выбранные на доработку…','Не удалось вернуть часть материалов. Результат по каждому — в списке ниже.');
  });
  for(const id of ["autoposting-posts","autoposting-queue"])get(id).addEventListener("click",event=>{
    if(event.target.closest('[data-filter-reset]')){resetFilters();return;}
    if(event.target.closest('input,label,select,textarea,a,video'))return;
    const button=event.target.closest("[data-open-post]")||event.target.closest("[data-daily-post]")?.querySelector("[data-open-post]");
    if(button){editorOpenerId=button.dataset.openPost;selectPost(button.dataset.openPost);}});
  const showMonth=(value,date)=>{const changed=value!==month;month=value;week=date?weekIndexOf(month,date):weekIndexOf(month,today());selectedDate=date||'';renderCalendar();controls();if(changed)void loadCalendar();};
  const shiftWeek=delta=>{
    if(busy||!settings)return;const next=week+delta;
    if(next>=0&&next<weeksOf(month).length){week=next;selectedDate='';renderCalendar();controls();return;}
    const [year,m]=month.split('-').map(Number);const value=new Date(Date.UTC(year,m-1+(delta>0?1:-1),1)).toISOString().slice(0,7);
    month=value;week=delta>0?0:weeksOf(value).length-1;selectedDate='';renderCalendar();controls();void loadCalendar();
  };
  const revealDay=date=>{const node=container.querySelector(`[data-board-day="${date}"]`);node?.scrollIntoView?.({block:'nearest',inline:'nearest'});};
  get('autoposting-prev-week').addEventListener('click',()=>shiftWeek(-1));get('autoposting-next-week').addEventListener('click',()=>shiftWeek(1));
  get('autoposting-month').addEventListener('change',()=>{const value=get('autoposting-month').value;if(/^\d{4}-\d{2}$/.test(value)&&!busy&&settings)showMonth(value,value===today().slice(0,7)?today():'');});
  get('autoposting-jump').addEventListener('change',()=>{const value=get('autoposting-jump').value;if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||busy||!settings)return;showMonth(value.slice(0,7),value);revealDay(value);});
  get('autoposting-overview').addEventListener('click',()=>{overview=!overview;renderCalendar();controls();});
  get("autoposting-calendar").addEventListener("click",event=>{const button=event.target.closest("[data-calendar-date]");if(button){showMonth(month,button.dataset.calendarDate);revealDay(button.dataset.calendarDate);}});
  get('autoposting-day-strip').addEventListener('click',event=>{const button=event.target.closest('[data-strip-date]');if(button){selectedDate=button.dataset.stripDate;renderCalendar();controls();revealDay(selectedDate);}});
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
  return {ready:load(code),leave(){closeEditor(true);},update(next){ctx=next;controls();},change(next){ctx=next;const code=String(next.selectedProjectId||"");if(code!==companyCode&&companies.some(item=>item.code===code))return load(code);return (async()=>{await openLinkedPost();consumeOpen();})();}};
}
cabinet.registerView("autoposting",{title:"Контент-план",onLeave(){controller?.leave?.();},render(container,context){if(!permitted(context,"view")){container?.replaceChildren();return;}if(!controller)controller=create(container,context);else {controller.update(context);return controller.change(context);}return controller.ready;},
  onProjectChange(context){if(permitted(context,"view"))return controller?.change(context);}});
})();
