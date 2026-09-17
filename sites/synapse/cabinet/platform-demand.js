(() => {
  'use strict';
  const sb = window.SbCabinet = window.SbCabinet || {};
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const REPORTS = {rubric_demand:'Спрос по рубрикам',search_share:'Доли поисковых запросов'};
  const CLASSES = {target:'Целевая',non_target:'Нецелевая',unclassified:'Не определено'};
  const allowed = (ctx,write=false) => ctx.identity?.role==='owner' || ctx.identity?.permissions?.includes(write?'crm.edit':'analytics.view');
  const date = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
  const day = value => date(value) ? value.split('-').reverse().join('.') : '—';
  const instant = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ru-RU') : '—';
  const number = value => typeof value==='number'&&Number.isFinite(value) ? new Intl.NumberFormat('ru-RU',{maximumFractionDigits:4}).format(value) : '—';
  const range = item => day(item.periodStart)+' — '+day(item.periodEnd);
  const categoryKey = value => String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
  const aggregate = row => row.isAggregate===true || categoryKey(row.category)==='все рубрики';
  const object = value => !!value && typeof value==='object' && !Array.isArray(value);
  const exact = (value,keys) => object(value) && Object.keys(value).every(key=>keys.includes(key));
  function validSource(value,id) {
    try {const url=new URL(value),keys=new Set(['period','dateFrom','dateTo','from','to','sectionId','subsectionId','id','tab','demandPeriod','demandGroup','demandRubrics']);return /^https:\/\//.test(value)&&value.length<=2000&&!/[\\\s]/.test(value)&&url.hostname==='account.2gis.com'&&!url.username&&!url.password&&!url.port&&!url.hash&&url.pathname.startsWith('/orgs/'+id+'/')&&/^\/orgs\/\d+\/[A-Za-z0-9_/-]*$/.test(url.pathname)&&[...url.searchParams].every(([key,value])=>keys.has(key)&&value.length<=100&&!/[\u0000-\u001f]/.test(value));}
    catch (_) {return false;}
  }
  function parseReport(raw,settings) {
    if(!settings?.configured)throw Error('Сначала сохраните организацию 2ГИС для этой компании.');
    if(raw.length>1000000)throw Error('Отчёт слишком большой. Используйте до 2000 строк и 1 МБ JSON.');
    let value;try{value=JSON.parse(raw);}catch(_){throw Error('Не удалось прочитать JSON. Проверьте формат отчёта.');}
    const fields=['organizationId','organizationName','city','sourceUrl','reportKind','periodStart','periodEnd','granularity','capturedAt','originalFilename','rows'];
    if(!exact(value,fields))throw Error('В отчёте есть неизвестные поля. Сверьте формат JSON ниже.');
    for(const key of ['organizationId','organizationName','city'])if(typeof value[key]!=='string'||value[key].trim()!==String(settings[key]||''))throw Error('Организация или город отчёта не совпадают с сохранёнными настройками этой компании.');
    if(!validSource(value.sourceUrl,settings.organizationId))throw Error('Нужна ссылка на отчёт этой организации в account.2gis.com без паролей и параметров входа.');
    if(!Object.hasOwn(REPORTS,value.reportKind)||!['month','day','week','period'].includes(value.granularity))throw Error('Проверьте вид отчёта и группировку периода.');
    if(!date(value.periodStart)||!date(value.periodEnd)||value.periodStart>value.periodEnd)throw Error('Проверьте даты начала и конца отчёта.');
    if(typeof value.capturedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.capturedAt)||!Number.isFinite(Date.parse(value.capturedAt))||new Date(value.capturedAt).toISOString().slice(0,10)!==value.capturedAt.slice(0,10))throw Error('Укажите время получения отчёта capturedAt в UTC, например 2026-09-17T10:00:00Z.');
    if(value.originalFilename!=null&&(typeof value.originalFilename!=='string'||value.originalFilename.length>255||/[\\/\u0000-\u001f]/.test(value.originalFilename)))throw Error('В originalFilename укажите только название исходного файла, без пути.');
    if(!Array.isArray(value.rows)||!value.rows.length||value.rows.length>2000)throw Error('Нужно от 1 до 2000 строк отчёта.');
    const metric=value.reportKind==='rubric_demand'?'searches':'share_percent';
    const seen=new Set();value.rows.forEach((row,index)=>{
      const fail=message=>{throw Error('Строка '+(index+1)+': '+message);};
      if(!exact(row,['periodStart','periodEnd','category','metric','value','partial']))fail('неизвестные поля.');
      if(typeof row.category!=='string'||!row.category.trim()||row.category.length>200)fail('укажите название рубрики до 200 знаков.');
      if(!date(row.periodStart)||!date(row.periodEnd)||row.periodStart>row.periodEnd||row.periodStart<value.periodStart||row.periodEnd>value.periodEnd)fail('период строки должен входить в период отчёта.');
      if(row.metric!==metric)fail('этот отчёт использует '+metric+'; количества и проценты нельзя смешивать.');
      if(typeof row.value!=='number'||!Number.isFinite(row.value)||row.value<0||(metric==='searches'&&(!Number.isSafeInteger(row.value)||row.value>1e12))||(metric==='share_percent'&&row.value>100))fail('проверьте числовое значение и единицу измерения.');
      if(typeof row.partial!=='boolean')fail('partial должен быть true или false.');
      const length=(Date.parse(row.periodEnd)-Date.parse(row.periodStart))/86400000;
      if(value.granularity==='day'&&length!==0||value.granularity==='week'&&length>6||value.granularity==='month'&&row.periodStart.slice(0,7)!==row.periodEnd.slice(0,7))fail('период не соответствует группировке day, week или month.');
      const key=[row.periodStart,row.periodEnd,categoryKey(row.category),row.metric].join('|');if(seen.has(key))fail('строка этой рубрики и периода повторяется.');seen.add(key);
    });
    return value;
  }
  let controller;
  function create(container,initial) {
    let ctx=initial,company='',epoch=0,busy=false,data=null,dataset=null,preview=null;
    const get=id=>container.querySelector('#demand-'+id);
    const editable=()=>allowed(ctx,true);
    const status=text=>{get('status').textContent=text;};
    const api=(path='',method,body)=>ctx.apiJson('/content/crm/platform-demand'+path+'?companyCode='+encodeURIComponent(company),method?ctx.csrfOptions(method,body):undefined);
    const validate=value=>{if(value?.company?.code!==company)throw Error('WRONG_COMPANY');return value;};
    const link=(url,label)=>sb.platformLinks?.link(url,label)||'';
    const clearPreview=()=>{preview=null;get('preview').replaceChildren();get('preview').hidden=true;get('confirm').checked=false;controls();};
    function controls() {
      container.setAttribute('aria-busy',String(busy));
      container.querySelectorAll('input,textarea,select,button').forEach(node=>{node.disabled=busy||!data;});
      container.querySelectorAll('[data-demand-write] input,[data-demand-write] textarea,[data-demand-write] select,[data-demand-write] button').forEach(node=>{node.disabled=busy||!data||!editable();});
      get('refresh').disabled=busy||!company;
      get('import-save').disabled=busy||!editable()||!preview||!get('confirm').checked;
      get('category-save').disabled=busy||!editable()||!get('category').value;
    }
    async function run(label,work,write=false) {
      if(busy||!allowed(ctx)||write&&!editable())return;
      const stamp=epoch;busy=true;status(label);controls();
      const current=()=>stamp===epoch&&company===String(ctx.selectedProjectId||'')&&allowed(ctx)&&(!write||editable());
      try{await work(current);}catch(error){if(current())status(error.status===409?'Настройки или рубрики изменились. Обновите раздел и проверьте данные заново.':error.status===400?'Сервер отклонил данные. Проверьте организацию, даты и формат отчёта.':'Не удалось выполнить действие. Данные другой компании не будут показаны здесь. Повторите загрузку.');}
      finally{if(current()){busy=false;controls();}}
    }
    container.classList.add('platform-demand-view');
    container.innerHTML=`<header class="demand-heading"><div><h2>Потенциал 2ГИС</h2><p id="demand-company"></p></div><button class="plain-button" id="demand-refresh" type="button">Обновить отчёты</button></header>
      <p id="demand-status" role="status" aria-live="polite"></p>
      <p class="demand-warning">Поисковый спрос показывает интерес к услугам, а не число клиентов студии. Запросы не равны заявкам, записям или визитам.</p>
      <p><a href="#analytics-through">Открыть фактические заявки и результаты компании</a><span class="demand-note"> — в сквозной аналитике выберите такой же период.</span></p>
      <details class="card" id="demand-settings"><summary>Организация и кабинет 2ГИС</summary><form id="demand-settings-form" data-demand-write><div class="demand-fields">
      <label>ID организации<input name="organizationId" maxlength="20" inputmode="numeric" pattern="[1-9][0-9]{0,19}" required></label><label>Название в 2ГИС<input name="organizationName" maxlength="300" required></label><label>Город<input name="city" maxlength="150" required></label><label>Ссылка на кабинет организации<input name="cabinetUrl" type="url" maxlength="2000" placeholder="https://account.2gis.com/orgs/…/" required></label></div>
      <button class="plain-button" type="submit">Сохранить организацию</button></form></details><div id="demand-source-links" class="demand-actions"></div>
      <section class="card"><h3>Сохранённые отчёты</h3><label>Отчёт<select id="demand-dataset"></select></label><div id="demand-report"></div></section>
      <details class="card" id="demand-import"><summary>Добавить отчёт из JSON</summary><p>Вставьте структурированный отчёт, подготовленный из кабинета 2ГИС. Перед сохранением проверьте компанию, организацию, период и строки. Файл XLS здесь не загружается.</p>
      <form id="demand-import-form" data-demand-write><p id="demand-expected" class="demand-meta"></p><label>Данные отчёта JSON<textarea id="demand-json" rows="8" spellcheck="false" maxlength="1000000" required></textarea></label><button class="plain-button" type="submit" id="demand-preview-button">Проверить и показать</button>
      <div id="demand-preview" class="demand-preview" tabindex="-1" hidden></div><label class="demand-check"><input id="demand-confirm" type="checkbox">Я проверил компанию, организацию, период и данные отчёта</label><button class="primary-button" type="button" id="demand-import-save" disabled>Сохранить проверенный отчёт</button></form>
      <details><summary>Формат JSON — образец структуры, не данные компании</summary><pre id="demand-example"></pre></details></details>
      <section class="card" data-demand-write><h3>Целевые рубрики</h3><p class="demand-note">Выберите назначение рубрики и при необходимости сохраните причину. Общая строка «Все рубрики» не классифицируется. Доли запросов не складываются в количество клиентов.</p><form id="demand-category-form"><div class="demand-fields"><label>Рубрика<select id="demand-category" required></select></label><label>Назначение<select id="demand-classification">${Object.entries(CLASSES).map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></label><label class="demand-wide">Причина<textarea id="demand-reason" maxlength="2000" rows="2"></textarea></label></div><button class="plain-button" id="demand-category-save" type="submit">Сохранить назначение рубрики</button></form></section>
      <details class="card"><summary>История получения отчётов</summary><div id="demand-history"></div></details>`;
    function table(report) {
      return `<div class="demand-table-wrap" tabindex="0" aria-label="Таблица отчёта, прокручивается по горизонтали"><table class="demand-table"><thead><tr><th scope="col">Рубрика / запрос</th><th scope="col">Период</th><th scope="col">Количество запросов</th><th scope="col">Доля, %</th><th scope="col">Назначение</th></tr></thead><tbody>${(report.rows||[]).map(row=>{
        const saved=data?.categories?.items?.find(item=>categoryKey(item.category)===categoryKey(row.category)),classification=saved?.classification||row.classification||'unclassified';
        return `<tr><td>${esc(row.category)}${aggregate(row)?'<br><span class="demand-note">Итог площадки</span>':''}</td><td>${esc(range(row))}${row.partial?'<br><strong>Неполный период</strong>':''}</td><td class="demand-numeric">${row.metric==='searches'?number(row.value):'—'}</td><td class="demand-numeric">${row.metric==='share_percent'?number(row.value)+' %':'—'}</td><td>${aggregate(row)?'—':`<span class="demand-tag" data-classification="${Object.hasOwn(CLASSES,classification)?classification:'unclassified'}">${esc(CLASSES[classification]||CLASSES.unclassified)}</span>${saved?.reason?'<br>'+esc(saved.reason):''}`}</td></tr>`;
      }).join('')}</tbody></table></div>`;
    }
    function details(report) {
      return `<h4>${esc(REPORTS[report.reportKind]||report.reportKind)} · ${esc(range(report))}</h4><p>${esc(report.organizationName)} · ${esc(report.city)} · ID ${esc(report.organizationId)}</p><p class="demand-meta">Получен из 2ГИС: ${esc(instant(report.capturedAt))}${report.importedAt?' · Сохранён в ЛК: '+esc(instant(report.importedAt)):''}${report.lastCheckedAt?' · Последняя сверка снимка: '+esc(instant(report.lastCheckedAt)):''}${report.originalFilename?'<br>Исходный файл: '+esc(report.originalFilename):''}</p>${link(report.sourceUrl,'Открыть источник отчёта')}${report.rows?.some(row=>row.partial)?'<p class="demand-warning">В отчёте есть неполный период. Сравнивайте его только с таким же интервалом.</p>':''}${report.reportKind==='search_share'?'<p class="demand-note">Доли показаны отдельно: проценты разных строк не складываются в число запросов.</p>':''}${table(report)}`;
    }
    function drawReport(){get('report').innerHTML=dataset?details(dataset):'<p>Для этой организации отчётов пока нет. Пустой список не означает нулевой спрос.</p>';}
    function drawCategories() {
      const names=[...new Map([...(data.categories?.items||[]),...(dataset?.rows||[])].filter(row=>!aggregate(row)).map(row=>[categoryKey(row.category),row.category])).values()];
      get('category').innerHTML='<option value="">Выберите рубрику</option>'+names.map(name=>`<option>${esc(name)}</option>`).join('');get('classification').value='unclassified';get('reason').value='';controls();
    }
    function draw() {
      const settings=data.settings||{};
      for(const key of ['organizationId','organizationName','city','cabinetUrl'])get('settings-form').elements[key].value=settings[key]||'';
      get('settings').open=!settings.configured;
      get('source-links').innerHTML=link(settings.cabinetUrl,'Открыть кабинет этой организации')||sb.platformLinks?.cabinetLink('two_gis')||'';
      get('expected').textContent=`Компания: ${data.company.name}. Организация: ${settings.organizationName||'не настроена'}; ID ${settings.organizationId||'—'}; город ${settings.city||'—'}.`;
      get('example').textContent=JSON.stringify({organizationId:settings.organizationId||'ID_ИЗ_НАСТРОЕК',organizationName:settings.organizationName||'НАЗВАНИЕ_ИЗ_НАСТРОЕК',city:settings.city||'ГОРОД_ИЗ_НАСТРОЕК',sourceUrl:settings.cabinetUrl||'https://account.2gis.com/orgs/ID/',reportKind:'rubric_demand',periodStart:'ГГГГ-ММ-ДД',periodEnd:'ГГГГ-ММ-ДД',granularity:'month',capturedAt:'ГГГГ-ММ-ДДTЧЧ:ММ:ССZ',originalFilename:'исходный-отчёт.xls',rows:[{periodStart:'ГГГГ-ММ-ДД',periodEnd:'ГГГГ-ММ-ДД',category:'Название рубрики',metric:'searches',value:null,partial:false}]},null,2)+'\nДля долей: reportKind="search_share", metric="share_percent", value от 0 до 100. Для количества value — целое неотрицательное число. Допустимая группировка: month, day, week, period.';
      const reports=new Map([...(data.datasets||[]),...(data.history||[])].map(item=>[String(item.id),item]));
      get('dataset').innerHTML=reports.size?[...reports.values()].map(item=>`<option value="${esc(item.id)}">${esc(REPORTS[item.reportKind]||item.reportKind)} · ${esc(range(item))} · получен ${esc(instant(item.capturedAt))}</option>`).join(''):'<option value="">Отчётов пока нет</option>';
      dataset=(data.datasets||[])[0]||null;get('dataset').value=dataset?String(dataset.id):'';drawReport();drawCategories();
      get('history').innerHTML=(data.history||[]).length?'<ul>'+data.history.map(item=>`<li>${esc(REPORTS[item.reportKind]||item.reportKind)} · ${esc(range(item))} · получен ${esc(instant(item.capturedAt))} · сохранён ${esc(instant(item.importedAt))}${item.lastCheckedAt?' · проверен '+esc(instant(item.lastCheckedAt)):''}</li>`).join('')+'</ul>':'<p>История появится после сохранения первого отчёта.</p>';
    }
    async function refreshData(current){const result=await api();if(!current())return;data=validate(result);draw();}
    async function load(code) {
      company=String(code||'');epoch++;busy=false;data=null;dataset=null;get('json').value='';clearPreview();get('settings-form').reset();get('source-links').replaceChildren();get('dataset').replaceChildren();get('report').replaceChildren();get('history').replaceChildren();get('category').replaceChildren();get('reason').value='';get('expected').textContent='';get('example').textContent='';get('import').open=false;
      get('company').textContent=ctx.identity?.companies?.find(item=>String(item.id)===company)?.name||company;
      if(!company||!allowed(ctx)){status('Выберите доступную компанию.');controls();return;}
      await run('Загружаем сохранённые отчёты компании…',async current=>{await refreshData(current);if(current())status('Показаны сохранённые отчёты выбранной организации.');});
    }
    get('refresh').addEventListener('click',()=>void load(company));
    get('settings-form').addEventListener('input',clearPreview);
    get('settings-form').addEventListener('submit',event=>{event.preventDefault();if(!editable()||!data||!get('settings-form').reportValidity())return;
      const body={revision:data.settings.revision};for(const key of ['organizationId','organizationName','city','cabinetUrl'])body[key]=get('settings-form').elements[key].value.trim();
      if(!/^[1-9]\d{0,19}$/.test(body.organizationId)||!validSource(body.cabinetUrl,body.organizationId)){status('Укажите ID и ссылку account.2gis.com/orgs/ID/ для одной организации.');return;}
      clearPreview();void run('Сохраняем организацию…',async current=>{await api('/settings','PUT',body);if(!current())return;await refreshData(current);if(current())status('Организация сохранена для выбранной компании. Отчёты другой организации не смешиваются с ней.');},true);
    });
    get('json').addEventListener('input',clearPreview);get('confirm').addEventListener('change',controls);
    get('import-form').addEventListener('submit',event=>{event.preventDefault();if(busy||!editable()||!data)return;clearPreview();
      try{const raw=get('json').value,value=parseReport(raw,data.settings);preview={raw,value,company,settingsRevision:data.settings.revision};get('preview').innerHTML=`<p><strong>Будет сохранено в компанию: ${esc(data.company.name)}</strong> · строк: ${value.rows.length}</p>${details(value)}`;get('preview').hidden=false;get('preview').focus();status('Предпросмотр готов. Данные ещё не сохранены.');controls();}catch(error){status(error.message);}
    });
    get('import-save').addEventListener('click',()=>{if(!preview||!editable()||!get('confirm').checked||preview.company!==company||preview.settingsRevision!==data?.settings?.revision||preview.raw!==get('json').value)return;
      const body=preview.value;void run('Сохраняем проверенный отчёт…',async current=>{const result=await api('/import','POST',body);if(!current())return;clearPreview();await refreshData(current);if(!current())return;if(result.dataset){dataset=result.dataset;get('dataset').value=String(dataset.id);drawReport();drawCategories();}status(result.duplicate?'Такой отчёт уже сохранён. Обновлено время проверки; второй снимок не создан.':'Отчёт сохранён для выбранной компании.');},true);
    });
    get('dataset').addEventListener('change',()=>{const id=get('dataset').value;if(!id)return;dataset=null;drawReport();void run('Загружаем выбранный отчёт…',async current=>{
      const result=await api('/datasets/'+encodeURIComponent(id));if(!current())return;const item=result.dataset;if(!item||item.organizationId!==data.settings.organizationId||item.organizationName!==data.settings.organizationName||item.city!==data.settings.city)throw Error('WRONG_ORGANIZATION');dataset=item;drawReport();drawCategories();status('Выбранный отчёт загружен.');
    });});
    get('category').addEventListener('change',()=>{const item=data?.categories?.items?.find(item=>item.category===get('category').value);get('classification').value=item?.classification||'unclassified';get('reason').value=item?.reason||'';controls();});
    get('category-form').addEventListener('submit',event=>{event.preventDefault();if(!editable()||!data||!get('category-form').reportValidity())return;
      const body={revision:data.categories.revision,items:[{category:get('category').value,classification:get('classification').value,reason:get('reason').value.trim()}]};
      clearPreview();void run('Сохраняем назначение рубрики…',async current=>{await api('/categories','PUT',body);if(!current())return;await refreshData(current);if(current())status('Назначение рубрики и причина сохранены для этой компании.');},true);
    });
    return {ready:load(ctx.selectedProjectId),update(next){const hadEdit=editable();ctx=next;if(!allowed(ctx)){epoch++;busy=false;data=null;preview=null;container.replaceChildren();controller=null;return;}if(company!==String(ctx.selectedProjectId||''))return load(ctx.selectedProjectId);if(hadEdit&&!editable()){epoch++;busy=false;clearPreview();}controls();}};
  }
  sb.registerView('platform-demand',{title:'Потенциал 2ГИС',render(container,ctx){if(!allowed(ctx)){controller?.update(ctx);container.replaceChildren();return;}if(!controller)controller=create(container,ctx);else return controller.update(ctx);return controller.ready;},onProjectChange(ctx){return controller?.update(ctx);}});
})();
