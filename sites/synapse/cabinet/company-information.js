(() => {
"use strict";
const cabinet = window.SbCabinet = window.SbCabinet || {};
const allowed = (ctx, action) => ctx.identity?.role === "owner" || ctx.identity?.permissions?.includes("company-information." + action);
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const copy = value => JSON.parse(JSON.stringify(value));
const validZone = zone => {try {return !!zone && !!new Intl.DateTimeFormat("en",{timeZone:zone});} catch (_) {return false;}};
const toLocal = (value, zone) => {
  if (!value || !validZone(zone) || !Number.isFinite(Date.parse(value))) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"})
    .formatToParts(new Date(value)).map(item=>[item.type,item.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};
const toUTC = (value, zone) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !validZone(zone)) throw Error("Invalid local date");
  const wall = Date.parse(value+":00Z");
  if (!Number.isFinite(wall)) throw Error("Invalid date");
  let time=wall;
  for(let attempt=0;attempt<4;attempt++) time += wall-Date.parse(toLocal(new Date(time).toISOString(),zone)+":00Z");
  if (!Number.isFinite(time) || toLocal(new Date(time).toISOString(),zone)!==value) throw Error("Nonexistent local time");
  for(const delta of [-7200000,-3600000,-1800000,1800000,3600000,7200000])
    if(toLocal(new Date(time+delta).toISOString(),zone)===value)throw Error("Ambiguous local time");
  return new Date(time).toISOString();
};
cabinet.companyTime = {validZone,toLocal,toUTC};
const imageUrl=value=>{try{const url=new URL(value);return url.protocol==="https:"&&!url.username&&!url.password&&!/[\u0000-\u0020\u007f]/.test(value)?url.href:null;}catch(_){return null;}};
cabinet.companyAssets={imageUrl,async upload(ctx,companyCode,file){
  if(!file||!["image/jpeg","image/png","image/webp"].includes(file.type)||file.size>10*1024*1024||!file.size)throw Error("INVALID_PHOTO");
  const options=ctx.csrfOptions("POST");
  const result=await ctx.apiJson("/content/publishing-assets?companyCode="+encodeURIComponent(companyCode),{...options,body:file,
    headers:{...options.headers,"Content-Type":file.type,"X-Filename":encodeURIComponent(file.name)}});
  if(!imageUrl(result?.url))throw Error("INVALID_ASSET_URL");return result.url;
}};
const FIELDS = [
  ["name", "Название компании", 200], ["city", "Город", 200], ["timezone", "Часовой пояс", 80],
  ["phone", "Телефон", 100, "tel"], ["email", "Email", 254, "email"], ["websiteUrl", "Сайт", 2000, "url"],
  ["address", "Адрес", 1000], ["hours", "Часы работы", 2000, "textarea"], ["description", "Описание компании", 20000, "textarea"]
];
const ROW_FIELDS = {
  socials: [["type", "Площадка", "social"], ["url", "Ссылка", "url"], ["label", "Подпись", "text"]],
  services: [["title", "Название услуги", "text"], ["description", "Описание", "textarea"], ["price", "Цена", "number"], ["currency", "Валюта", "text"], ["durationMinutes", "Длительность процедуры, минут", "number"], ["bookingIntervalMinutes", "Интервал записи, минут", "number"]],
  promotions: [["title", "Название акции", "text"], ["description", "Условия акции", "textarea"], ["price", "Цена по акции", "number"], ["oldPrice", "Прежняя цена", "number"], ["startsAt", "Начало акции", "datetime-local"], ["endsAt", "Окончание акции", "datetime-local"]],
  materials: [["title","Название материала","text"],["url","Ссылка на материал","url"],["type","Тип материала","text"]]
};
const SOCIALS = {two_gis:"2ГИС", yandex_maps:"Яндекс Карты", max:"MAX", telegram:"Telegram — чат", telegram_channel:"Telegram — канал", whatsapp:"WhatsApp", vk:"ВКонтакте", booking:"Онлайн-запись"};
const STATES = {unknown:"Не подтверждено", confirmed:"Подтверждено владельцем", removed:"Удалено владельцем"};
let controller;
function create(container, context) {
  let ctx = context, companyCode = "", saved = null, rows = {}, busy = false, epoch = 0, baseline = null, baselineRaw = null;
  const drafts = new Map();
  const companies = (ctx.identity.companies || []).map(item => ({code:String(item.id), name:item.name || item.id}));
  container.classList.add("company-information-view");
  container.innerHTML = `<h2>Актуальность данных компании</h2>
    <p>Сохранённые вами сведения становятся эталоном. Внешняя площадка не заменяет их автоматически.</p>
    <div class="company-information-toolbar"><label for="information-company">Компания</label><select id="information-company">${companies.map(item => `<option value="${esc(item.code)}">${esc(item.name)}</option>`).join("")}</select>
      <button class="plain-button" id="information-refresh" type="button">Обновить сведения</button></div>
    <p id="information-status" role="status" aria-live="polite"></p>
    <section class="card" id="information-platform-links" hidden><h3>Сохранённые страницы компании и кабинеты</h3><p>Страница компании видна клиентам. Кабинет площадки откроется отдельно; вход и права проверяются на самой площадке.</p><ul id="information-platform-link-list"></ul></section>
    <form id="information-form"><section class="card information-fields" aria-label="Основные сведения">
    ${FIELDS.map(([key,label,max,type]) => `<label for="information-${key}">${label}<span class="information-field-state" data-field-state="${key}"></span>${type === "textarea" ? `<textarea id="information-${key}" maxlength="${max}" rows="${key === "description" ? 5 : 2}"></textarea>` : `<input id="information-${key}" type="${type || "text"}" maxlength="${max}"${key === "name" ? " required" : ""}${key === "timezone" ? ' placeholder="Asia/Irkutsk"' : ""}>`}</label>`).join("")}
    </section>
    ${[["socials","Ссылки на площадки"],["services","Услуги"],["promotions","Акции"],["materials","Фото и материалы"]].map(([key,title]) => `<section class="card information-repeater"><h3>${title}</h3><div id="information-${key}" class="information-rows"></div><button class="plain-button" type="button" data-add-row="${key}">Добавить</button>${key==="materials"?'<label>Фото с устройства<input id="information-photo" type="file" accept="image/jpeg,image/png,image/webp"></label><button class="plain-button" id="information-upload" type="button">Загрузить фото</button><p class="information-note">JPEG, PNG или WebP до 10 МБ. После загрузки сохраните данные компании.</p>':""}</section>`).join("")}
    <p class="information-note">Пустое поле после удаления значения сохраняет удаление. Длительность процедуры и интервал записи — разные сведения. Даты акций указаны в часовом поясе компании.</p>
    <button class="plain-button" id="information-save" type="submit">Сохранить данные компании</button><p id="information-form-status" aria-live="off"></p></form>
    <section class="card information-checks"><h3>Сверка площадок</h3><button class="plain-button" id="information-check" type="button">Проверить актуальность</button><div id="information-checks"></div></section>
    <section class="card"><h3>История подтверждённых версий</h3><div id="information-history"></div></section>`;
  const get = id => container.querySelector("#" + id);
  const form = get("information-form");
  const editable = () => allowed(ctx, "edit");
  const status = text => {get("information-status").textContent = text;get("information-form-status").textContent=text;};
  const path = endpoint => "/content/crm/company-information" + endpoint + "?companyCode=" + encodeURIComponent(companyCode);
  const api = (endpoint = "", method, body) => ctx.apiJson(path(endpoint), method ? ctx.csrfOptions(method, body) : undefined);
  const updateControls = () => {
    container.setAttribute("aria-busy", String(busy));
    form.querySelectorAll("input,textarea,select,button").forEach(node => {node.disabled = busy || !saved || !editable();});
    get("information-company").disabled = busy || !companies.length;
    get("information-refresh").disabled = busy || !companyCode;
    get("information-check").disabled = busy || !saved || !editable();
  };
  const renderRows = kind => {
    get("information-" + kind).innerHTML = rows[kind].map((item,index) => `<fieldset data-row="${kind}" data-index="${index}"><legend>${({socials:"Ссылка",services:"Услуга",promotions:"Акция",materials:"Материал"})[kind]} ${index + 1}</legend>${kind==="materials"&&imageUrl(item.url)?`<a href="${esc(imageUrl(item.url))}" target="_blank" rel="noopener noreferrer"><img class="information-thumbnail" src="${esc(imageUrl(item.url))}" alt="${esc(item.title||"Материал")}" loading="lazy"></a>`:""}<div class="information-row-fields">${ROW_FIELDS[kind].map(([key,label,type]) => {
      const value = type === "datetime-local" ? toLocal(item[key],get("information-timezone").value || "UTC") : item[key] ?? "";
      let control;
      if (type === "social") {
        const options = {...SOCIALS}; if (value && !Object.hasOwn(options,value)) options[value] = value;
        control = `<select data-row-field="${key}"><option value="">Выберите площадку</option>${Object.entries(options).map(([id,title]) => `<option value="${esc(id)}"${id === value ? " selected" : ""}>${esc(title)}</option>`).join("")}</select>`;
      } else if (type === "textarea") control = `<textarea data-row-field="${key}" rows="3" maxlength="5000">${esc(value)}</textarea>`;
      else control = `<input data-row-field="${key}" type="${type}" value="${esc(value)}"${type === "number" ? ' min="0" max="100000000" step="any"' : ` maxlength="${key==="title"?300:kind==="socials"||key==="url"?2000:100}"`}${key==="title"||kind==="materials"&&key==="url"?" required":""}>`;
      return `<label>${label}${control}</label>`;
    }).join("")}</div><button class="plain-button" type="button" data-remove-row="${kind}" data-index="${index}">Удалить ${({socials:"ссылку",services:"услугу",promotions:"акцию",materials:"материал"})[kind]}</button></fieldset>`).join("");
  };
  const read = () => {
    const profile = Object.fromEntries(FIELDS.map(([key]) => [key,get("information-" + key).value.trim()]));
    for (const kind of Object.keys(ROW_FIELDS)) profile[kind] = rows[kind].map((old,index) => {
      const next = {...old};
      const row = get("information-" + kind).querySelector(`[data-index="${index}"]`);
      ROW_FIELDS[kind].forEach(([key,,type]) => {const value = row.querySelector(`[data-row-field="${key}"]`).value.trim();
        next[key] = type === "number" ? (value === "" ? null : Number(value)) : type === "datetime-local" ? (value ? toUTC(value,profile.timezone || "UTC") : "") : value;
        if(type === "datetime-local" && value === toLocal(old[key],profile.timezone || "UTC")) next[key]=old[key] || "";
      });
      return next;
    });
    return profile;
  };
  const rawValues = () => ({fields:Object.fromEntries(FIELDS.map(([key])=>[key,get("information-"+key).value])),
    rows:Object.fromEntries(Object.keys(ROW_FIELDS).map(kind=>[kind,rows[kind].map((_,index)=>Object.fromEntries(ROW_FIELDS[kind].map(([key])=>
      [key,get("information-"+kind).querySelector(`[data-index="${index}"] [data-row-field="${key}"]`).value])))]))});
  const applyRaw = raw => {
    FIELDS.forEach(([key])=>{get("information-"+key).value=raw.fields[key]??"";});
    for(const kind of Object.keys(ROW_FIELDS)) raw.rows[kind].forEach((item,index)=>ROW_FIELDS[kind].forEach(([key])=>{
      get("information-"+kind).querySelector(`[data-index="${index}"] [data-row-field="${key}"]`).value=item[key]??"";
    }));
  };
  const stash = () => {if(companyCode&&saved){const raw=rawValues();if(JSON.stringify(raw)!==JSON.stringify(baselineRaw))
    drafts.set(companyCode,{saved:copy(saved),baseline:copy(baseline),baselineRaw:copy(baselineRaw),rows:copy(rows),raw});else drafts.delete(companyCode);}};
  const renderDiagnostics = data => {
    const checks = Array.isArray(data.checks) ? data.checks : [];
    const valueText=value=>value==null?"не указано":typeof value!=="object"?String(value):Array.isArray(value)?value.map(item=>typeof item==="object"?item?.title||item?.name||"запись":String(item)).join(", "):value.title||value.name||"составное значение";
    const labels=Object.fromEntries(FIELDS.map(([key,label])=>[key,label]));
    get("information-checks").innerHTML = checks.length ? `<ul>${checks.map(item => `<li><strong>${esc(({website:"Сайт",...SOCIALS})[item.platformId]||item.platformId||"Площадка")}</strong>: ${esc({differences:"Есть расхождения",partial:"Проверено частично",not_supported:"Автоматическая проверка недоступна",unavailable:"Площадка недоступна",needs_review:"Эталон изменился — повторите проверку"}[item.status]||"Требуется проверка")}${item.message?" — "+esc(item.message):""}${imageUrl(item.url)?` <a href="${esc(imageUrl(item.url))}" target="_blank" rel="noopener noreferrer">Открыть площадку</a>`:""}
      ${Array.isArray(item.fields)?`<ul>${item.fields.map(field=>`<li>${esc(labels[field.field]||field.field)}: ${esc({matches:"совпадает",differs:"расхождение",unverified:"не проверено"}[field.status]||"не проверено")}. Эталон: ${esc(valueText(field.expected))}; на площадке: ${esc(valueText(field.observed))}.</li>`).join("")}</ul>`:""}</li>`).join("")}</ul>` : '<p class="information-note">Сверка ещё не запускалась или не указаны ссылки на площадки. Добавьте ссылки и нажмите «Проверить актуальность».</p>';
    const history = Array.isArray(data.history) ? data.history : [];
    get("information-history").innerHTML = history.length ? `<ol>${history.map(item => `<li>Версия ${esc(item.revision)}${item.createdAt && Number.isFinite(Date.parse(item.createdAt)) ? " · " + esc(new Date(item.createdAt).toLocaleString("ru-RU")) : ""}${item.reason ? " — " + esc(item.reason) : ""}</li>`).join("")}</ol>` : "<p>Подтверждённых версий ещё нет.</p>";
  };
  const render = (data, draft) => {
    form.hidden=false;
    const links = cabinet.platformLinks?.companyLinks({companyCode,record:data}) || "";
    get("information-platform-link-list").innerHTML = links;
    get("information-platform-links").hidden = !links;
    saved = copy(draft?.saved || data);
    const profile = saved.profile || {};
    FIELDS.forEach(([key]) => {get("information-" + key).value = String(profile[key] ?? "");
      container.querySelector(`[data-field-state="${key}"]`).textContent = STATES[data.fieldStates?.[key]?.state] || STATES.unknown;});
    for (const kind of Object.keys(ROW_FIELDS)) {rows[kind] = copy(Array.isArray(profile[kind]) ? profile[kind] : []); renderRows(kind);}
    baseline = draft?.baseline || read();
    baselineRaw=draft?.baselineRaw||rawValues();
    if(draft){rows=copy(draft.rows);for(const kind of Object.keys(ROW_FIELDS))renderRows(kind);applyRaw(draft.raw);}
    renderDiagnostics(data); updateControls();
  };
  const load = async code => {
    stash(); get("information-photo").value=""; companyCode = code; const version = ++epoch;
    saved = null; busy = true; form.hidden=true; get("information-company").value = code; updateControls();
    get("information-platform-link-list").replaceChildren(); get("information-platform-links").hidden = true;
    if (!code) {busy=false; status("Нет доступных компаний."); updateControls(); return;}
    status("Загружаем подтверждённые сведения…");
    try {
      const data = await api(); if (version !== epoch) return;
      if (data.companyCode !== code) throw Error("Wrong company");
      const draft = drafts.get(code); render(data,draft);
      status(draft && data.revision !== draft.saved.revision ? "В компании уже есть новая версия. Ваш несохранённый ввод сохранён в форме; перед сохранением сверяйте изменения." : editable() ? "Сохранение подтверждает данные выбранной компании." : "Доступ только для просмотра.");
    } catch (_) {if (version === epoch) status("Не удалось загрузить данные. Ввод другой компании не будет сохранён здесь.");}
    finally {if (version === epoch) {busy=false; updateControls();}}
  };
  form.addEventListener("input", stash);
  form.addEventListener("change", stash);
  form.addEventListener("click", event => {
    const add = event.target.closest("[data-add-row]"), remove = event.target.closest("[data-remove-row]");
    if (busy || !saved || !editable() || (!add && !remove)) return;
    const raw=rawValues(), kind = add?.dataset.addRow || remove.dataset.removeRow;
    if (add) {if (rows[kind].length >= 200) {status("Можно добавить до 200 записей в раздел."); return;}
      rows[kind].push(kind === "socials" ? {type:"",url:"",label:""} : {id:crypto.randomUUID(),title:""});raw.rows[kind].push({});}
    else {const index=Number(remove.dataset.index);rows[kind].splice(index,1);raw.rows[kind].splice(index,1);}
    renderRows(kind);applyRaw(raw); stash(); updateControls();
  });
  form.addEventListener("submit", async event => {
    event.preventDefault(); if (busy || !saved || !editable() || !form.reportValidity()) return;
    let profile; try {profile=read();} catch (_) {status("Проверьте даты и часовой пояс: выбранное местное время должно существовать и быть однозначным.");return;}
    if (profile.timezone) {try {new Intl.DateTimeFormat("en",{timeZone:profile.timezone}).format();} catch (_) {status("Укажите существующий часовой пояс, например Asia/Irkutsk."); return;}}
    for (const item of profile.promotions) if(item.startsAt&&item.endsAt&&Date.parse(item.endsAt)<=Date.parse(item.startsAt)){status("Окончание акции должно быть позже её начала.");return;}
    const partial = Object.fromEntries(Object.entries(profile).filter(([key,value]) => (Array.isArray(value) ? value.length > 0 : value !== "") || JSON.stringify(value) !== JSON.stringify(baseline[key])));
    const version = epoch; busy=true; updateControls(); status("Сохраняем эталон компании…");
    try {
      const data = await api("","PUT",{revision:saved.revision,profile:partial}); if (version !== epoch) return;
      if (data.companyCode !== companyCode) throw Error("Wrong company");
      drafts.delete(companyCode); render(data); status("Данные компании сохранены и подтверждены. Публикации на площадках проверяются отдельно.");
    } catch (_) {if (version === epoch) status("Не удалось сохранить. Ввод остался в форме. Если версия изменена в другом окне, сначала сверьте свежие сведения.");}
    finally {if (version === epoch) {busy=false; updateControls();}}
  });
  get("information-company").addEventListener("change", () => {void load(get("information-company").value);});
  get("information-refresh").addEventListener("click", () => {void load(companyCode);});
  get("information-upload").addEventListener("click",async()=>{
    if(busy||!saved||!editable())return;const file=get("information-photo").files?.[0];
    if(!file){status("Выберите фото с устройства.");return;}if(rows.materials.length>=200){status("Можно сохранить до 200 материалов.");return;}
    const version=epoch,raw=rawValues();busy=true;updateControls();status("Загружаем фото…");
    try{const url=await cabinet.companyAssets.upload(ctx,companyCode,file);if(version!==epoch)return;
      rows.materials.push({id:crypto.randomUUID(),title:file.name,url,type:"image"});raw.rows.materials.push({title:file.name,url,type:"image"});
      renderRows("materials");applyRaw(raw);get("information-photo").value="";stash();status("Фото добавлено. Сохраните данные компании, чтобы подтвердить материал.");
    }catch(_){if(version===epoch)status("Не удалось загрузить фото. Нужен JPEG, PNG или WebP до 10 МБ.");}
    finally{if(version===epoch){busy=false;updateControls();}}
  });
  get("information-check").addEventListener("click", async () => {
    if (busy || !saved || !editable()) return;
    const version=epoch; busy=true; updateControls(); status("Проверяем состояние сверки…");
    try {const result=await api("/check","POST",{}); if(version!==epoch)return; renderDiagnostics({...saved,...result}); status("Состояние сверки обновлено. Результаты показаны ниже.");}
    catch (_) {if(version===epoch)status("Не удалось получить результаты сверки. Эталон не изменён.");}
    finally {if(version===epoch){busy=false;updateControls();}}
  });
  const selected = companies.find(item => item.code === ctx.selectedProjectId)?.code || companies[0]?.code || "";
  return {ready:load(selected), update(next){ctx=next;updateControls();}, change(next){ctx=next;const code=String(next.selectedProjectId||""); if(code!==companyCode&&companies.some(item=>item.code===code))return load(code);}};
}
cabinet.registerView("company-information", {title:"Актуальность", render(container,context){
  if(!allowed(context,"view")){container?.replaceChildren();return;}
  if(!controller)controller=create(container,context);else controller.update(context);return controller.ready;
},onProjectChange(context){if(allowed(context,"view"))return controller?.change(context);}});
})();
