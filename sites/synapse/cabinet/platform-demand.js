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
    let ctx=initial,company='',epoch=0,busy=false,data=null,dataset=null,preview=null,metrics=null,metricsPreview=null;
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
      const metricsSave=get('metrics-save');if(metricsSave)metricsSave.disabled=busy||!editable()||!metricsPreview;
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
      <label>ID организации<input name="organizationId" maxlength="20" inputmode="numeric" pattern="[1-9][0-9]{0,19}" required></label><label>Название в 2ГИС<input name="organizationName" maxlength="300" required></label><label>Город<input name="city" maxlength="150" required></label><label>Ссылка на кабинет организации<input name="cabinetUrl" type="url" maxlength="2000" placeholder="https://account.2gis.com/orgs/…/" required></label><label class="demand-wide">ID филиала (нужен только для показателей компании)<input name="branchId" maxlength="20" inputmode="numeric" pattern="[1-9][0-9]{0,19}"><span class="demand-note">Спрос по рубрикам работает и без филиала. Пустое поле очищает филиал; при смене организации филиал придётся указать заново.</span></label></div>
      <button class="plain-button" type="submit">Сохранить организацию</button></form></details><div id="demand-source-links" class="demand-actions"></div>
      <section class="card"><h3>Сохранённые отчёты</h3><label>Отчёт<select id="demand-dataset"></select></label><div id="demand-report"></div></section>
      <details class="card" id="demand-import"><summary>Добавить отчёт из JSON</summary><p>Вставьте структурированный отчёт, подготовленный из кабинета 2ГИС. Перед сохранением проверьте компанию, организацию, период и строки. Файл XLS здесь не загружается.</p>
      <form id="demand-import-form" data-demand-write><p id="demand-expected" class="demand-meta"></p><label>Данные отчёта JSON<textarea id="demand-json" rows="8" spellcheck="false" maxlength="1000000" required></textarea></label><button class="plain-button" type="submit" id="demand-preview-button">Проверить и показать</button>
      <div id="demand-preview" class="demand-preview" tabindex="-1" hidden></div><label class="demand-check"><input id="demand-confirm" type="checkbox">Я проверил компанию, организацию, период и данные отчёта</label><button class="primary-button" type="button" id="demand-import-save" disabled>Сохранить проверенный отчёт</button></form>
      <details><summary>Формат JSON — образец структуры, не данные компании</summary><pre id="demand-example"></pre></details></details>
      <section class="card" data-demand-write><h3>Целевые рубрики</h3><p class="demand-note">Выберите назначение рубрики и при необходимости сохраните причину. Общая строка «Все рубрики» не классифицируется. Доли запросов не складываются в количество клиентов.</p><form id="demand-category-form"><div class="demand-fields"><label>Рубрика<select id="demand-category" required></select></label><label>Назначение<select id="demand-classification">${Object.entries(CLASSES).map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></label><label class="demand-wide">Причина<textarea id="demand-reason" maxlength="2000" rows="2"></textarea></label></div><button class="plain-button" id="demand-category-save" type="submit">Сохранить назначение рубрики</button></form></section>
      <details class="card"><summary>История получения отчётов</summary><div id="demand-history"></div></details>
      <section class="card demand-company-metrics" id="demand-metrics-card"><h3>Показатели компании</h3>
      <p class="demand-note">Это фактические показатели карточки компании в 2ГИС: показы, позиция в выдаче, переходы и обращения. Они загружаются отдельно и со спросом по рубрикам не смешиваются.</p>
      <p class="demand-note">Прочерк означает «нет данных», а ноль — измеренный ноль. Показы не равны охвату, обращения не равны продажам, а категории обращений между собой не складываются.</p>
      <form id="demand-metrics-period" class="demand-fields"><label>С<input id="demand-metrics-from" type="date" required></label><label>По<input id="demand-metrics-to" type="date" required></label><button class="plain-button" type="submit">Показать период</button></form>
      <p id="demand-metrics-status" role="status" aria-live="polite"></p>
      <div id="demand-metrics-body"></div>
      <div id="demand-metrics-import" data-demand-write hidden><h4>Загрузить подготовленный файл</h4>
      <p class="demand-note">Выберите файл отчётов, подготовленный из кабинета 2ГИС. Ничего не сохранится, пока вы не посмотрите предпросмотр и не подтвердите загрузку.</p>
      <label>Файл отчётов<input id="demand-metrics-file" type="file" accept="application/json,.json"></label>
      <div id="demand-metrics-preview" class="demand-preview" tabindex="-1" hidden></div>
      <button class="primary-button" type="button" id="demand-metrics-save" disabled>Загрузить показатели</button></div>
      <details id="demand-metrics-history-box"><summary>История загрузок</summary><div id="demand-metrics-history"></div></details></section>`;
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
      const rubricRows=dataset?.reportKind==='rubric_demand'?(dataset.rows||[]).filter(row=>row.metric==='searches'):[];// поисковые фразы search_share — не рубрики
      const names=[...new Map([...(data.categories?.items||[]),...rubricRows].filter(row=>!aggregate(row)).map(row=>[categoryKey(row.category),row.category])).values()];
      get('category').innerHTML='<option value="">Выберите рубрику</option>'+names.map(name=>`<option>${esc(name)}</option>`).join('');get('classification').value='unclassified';get('reason').value='';controls();
    }
    function draw() {
      const settings=data.settings||{};
      for(const key of ['organizationId','organizationName','city','cabinetUrl','branchId'])get('settings-form').elements[key].value=settings[key]||'';
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
    const metricsStatus=text=>{get('metrics-status').textContent=text;};
    // Чтение выбранного файла через FileReader: работает и в браузере, и в тестовой среде.
    const readText=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=()=>reject(Error('READ_FAILED'));reader.readAsText(file);});
    function clearMetricsPreview(){metricsPreview=null;get('metrics-preview').replaceChildren();get('metrics-preview').hidden=true;controls();}
    function metricValue(item){return item.hasValue?number(item.value):'<span class="demand-no-data">нет данных</span>';}
    function drawMetrics() {
      const body=get('metrics-body');
      if(!metrics){body.innerHTML='<p>Показатели компании ещё не загружены за этот период.</p>';get('metrics-history').replaceChildren();return;}
      const coverage=metrics.coverage||{},summary=metrics.summary||{};
      const withData=(metrics.metrics||[]).filter(item=>item.daysWithValue>0);
      const rows=(metrics.metrics||[]).map(item=>`<tr><td>${esc(item.label)}<br><span class="demand-note">${esc(item.reportKindLabel||'')}</span></td>
        <td class="demand-numeric">${item.totalAvailable?number(item.total):'<span class="demand-no-data">не считается</span>'}${item.totalNote?`<br><span class="demand-note">${esc(item.totalNote)}</span>`:''}</td>
        <td class="demand-numeric">${item.aggregation==='daily_only'&&item.daysWithValue&&item.min!==null&&item.max!==null?esc(number(item.min))+' — '+esc(number(item.max)):'—'}</td>
        <td class="demand-numeric">${esc(String(item.daysWithValue))} / ${esc(String(coverage.expectedDays??0))}${item.daysWithoutValue?`<br><span class="demand-note">пустых значений в отчётах: ${esc(String(item.daysWithoutValue))}</span>`:''}</td>
        <td>${item.days.length?item.days.map(day_=>`${esc(day(day_.date))}: ${metricValue(day_)}`).join('<br>'):'—'}</td></tr>`).join('');
      const list=items=>(items||[]).length?`<ul>${items.map(line=>`<li>${esc(line)}</li>`).join('')}</ul>`:'';
      body.innerHTML=`<p class="demand-meta">Организация ${esc(metrics.organizationId)} · филиал ${esc(metrics.branchId)} · период ${esc(day(metrics.period.from))} — ${esc(day(metrics.period.to))}</p>
        ${withData.length?`<div class="demand-table-wrap" tabindex="0" aria-label="Показатели компании, таблица прокручивается по горизонтали"><table class="demand-table"><thead><tr><th scope="col">Показатель</th><th scope="col">Итог за период</th><th scope="col">Диапазон по дням</th><th scope="col">Дней со значением из дней периода</th><th scope="col">По дням</th></tr></thead><tbody>${rows}</tbody></table></div>`
          :'<p>За выбранный период загруженных значений нет. Это не ноль показов, а отсутствие загруженных отчётов.</p>'}
        <h4>Покрытие</h4><ul class="demand-coverage">
          <li>Дней в периоде: ${esc(String(coverage.expectedDays??0))}, из них с измерениями: ${esc(String((coverage.datesWithValue||[]).length))}${(coverage.dates||[]).length>(coverage.datesWithValue||[]).length?` (ещё ${esc(String((coverage.dates||[]).length-(coverage.datesWithValue||[]).length))} дат загружены с пустыми значениями)`:''}</li>
          <li>Показателей с данными: ${esc(String(coverage.metricsWithData??0))} из ${esc(String(coverage.metricsTotal??0))}</li>
          <li>Известных значений: ${esc(String(coverage.knownValues??0))} из ${esc(String(coverage.valuesRead??0))} прочитанных строк, из них измеренных нулей: ${esc(String(coverage.zeroValues??0))}</li>
          <li>Отчётов действующих: ${esc(String(coverage.reportsActive??0))}, заменённых прежними версиями: ${esc(String(coverage.reportsSuperseded??0))}</li>
          <li>Даты снятия: ${(coverage.capturedDates||[]).length?esc((coverage.capturedDates||[]).map(day).join(', ')):'—'} · точное время снятия ${coverage.capturedAtKnown?'известно':'известно не для всех отчётов'}</li>
          <li>Часовой пояс отчётов ${coverage.timezoneKnown?'известен':'неизвестен: даты оставлены как в источнике'}</li>
        </ul><p class="demand-note">${esc(coverage.note||'')}</p>
        ${summary.visible?`<h4>Что видно</h4>${list(summary.visible)}`:''}
        ${summary.cannotConclude?`<h4>Чего пока нельзя заключить</h4>${list(summary.cannotConclude)}`:''}
        ${summary.nextStep?`<h4>Следующий шаг</h4>${list(summary.nextStep)}`:''}
        <p class="demand-note">${esc(metrics.note||'')}</p>`;
      get('metrics-history').innerHTML=(metrics.history||[]).length
        ?'<ul>'+metrics.history.map(item=>`<li>${esc(item.reportKindLabel)} · ${esc(range(item))} · снято ${esc(day(item.capturedDate))}${item.capturedAtKnown?' в '+esc(instant(item.capturedAt)):' (точное время неизвестно)'} · ${esc(item.sourceKindLabel)} · версия ${esc(String(item.version))}${item.supersededBy?' · заменён более поздней загрузкой':''}${item.originalFilename?' · файл '+esc(item.originalFilename):''}${item.scopeNoteLabel?'<br>'+esc(item.scopeNoteLabel):''}<br>${link(item.sourceUrl,'Открыть источник в кабинете')}</li>`).join('')+'</ul>'
        :'<p>Загрузок ещё не было.</p>';
    }
    async function refreshMetrics(current) {
      const from=get('metrics-from').value,to=get('metrics-to').value;
      if(!date(from)||!date(to)||from>to){metricsStatus('Укажите период: дата начала не позже даты конца.');return;}
      const result=await ctx.apiJson('/content/crm/platform-demand/company-metrics?companyCode='+encodeURIComponent(company)+'&from='+encodeURIComponent(from)+'&to='+encodeURIComponent(to));
      if(!current())return;
      if(String(result.companyCode||'').toLowerCase()!==company.toLowerCase())throw Error('WRONG_COMPANY');
      metrics=result;drawMetrics();metricsStatus('Показаны загруженные показатели за выбранный период.');
    }
    async function load(code) {
      company=String(code||'');epoch++;busy=false;data=null;dataset=null;get('json').value='';clearPreview();get('settings-form').reset();get('source-links').replaceChildren();get('dataset').replaceChildren();get('report').replaceChildren();get('history').replaceChildren();get('category').replaceChildren();get('reason').value='';get('expected').textContent='';get('example').textContent='';get('import').open=false;
      metrics=null;clearMetricsPreview();get('metrics-file').value='';get('metrics-body').replaceChildren();get('metrics-history').replaceChildren();metricsStatus('');
      const today=new Date(),shift=new Date(today.getTime()-29*86400000);
      get('metrics-to').value=today.toISOString().slice(0,10);get('metrics-from').value=shift.toISOString().slice(0,10);
      get('metrics-import').hidden=!editable();
      get('company').textContent=ctx.identity?.companies?.find(item=>String(item.id)===company)?.name||company;
      if(!company||!allowed(ctx)){status('Выберите доступную компанию.');controls();return;}
      await run('Загружаем сохранённые отчёты компании…',async current=>{await refreshData(current);if(!current())return;
        status('Показаны сохранённые отчёты выбранной организации.');
        // Показатели компании доступны только после подтверждённого филиала; иначе блок честно об этом говорит.
        if(data?.settings?.branchConfirmed)await refreshMetrics(current);
        else{metrics=null;drawMetrics();metricsStatus('Укажите филиал организации в настройках 2ГИС: показатели компании снимаются по конкретному филиалу.');}});
    }
    get('refresh').addEventListener('click',()=>void load(company));
    get('settings-form').addEventListener('input',()=>{clearPreview();clearMetricsPreview();});
    get('settings-form').addEventListener('submit',event=>{event.preventDefault();if(!editable()||!data||!get('settings-form').reportValidity())return;
      const body={revision:data.settings.revision};for(const key of ['organizationId','organizationName','city','cabinetUrl'])body[key]=get('settings-form').elements[key].value.trim();
      // Филиал отправляется всегда, в том числе пустой: пустая строка — это явная очистка.
      body.branchId=get('settings-form').elements.branchId.value.trim();
      if(!/^[1-9]\d{0,19}$/.test(body.organizationId)||!validSource(body.cabinetUrl,body.organizationId)){status('Укажите ID и ссылку account.2gis.com/orgs/ID/ для одной организации.');return;}
      if(body.branchId&&!/^[1-9]\d{0,19}$/.test(body.branchId)){status('ID филиала — число, либо оставьте поле пустым.');return;}
      clearPreview();
      /* Настройки изменились — прежние предпросмотр и показатели относятся к прежнему филиалу
         и больше не действительны. Показатели перечитываются только для подтверждённого филиала. */
      clearMetricsPreview();metrics=null;drawMetrics();get('metrics-file').value='';
      void run('Сохраняем организацию…',async current=>{await api('/settings','PUT',body);if(!current())return;await refreshData(current);if(!current())return;
        status('Организация сохранена для выбранной компании. Отчёты другой организации не смешиваются с ней.');
        if(data?.settings?.branchConfirmed)await refreshMetrics(current);
        else{metrics=null;drawMetrics();metricsStatus('Укажите филиал организации в настройках 2ГИС: показатели компании снимаются по конкретному филиалу.');}},true);
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
    get('metrics-period').addEventListener('submit',event=>{event.preventDefault();clearMetricsPreview();
      void run('Загружаем показатели компании…',async current=>{await refreshMetrics(current);});});
    get('metrics-file').addEventListener('change',()=>{
      clearMetricsPreview();
      const file=get('metrics-file').files&&get('metrics-file').files[0];
      if(!file||!editable()||!data)return;
      if(file.size>5*1024*1024){metricsStatus('Файл слишком большой: ожидается подготовленный отчёт, а не выгрузка целиком.');return;}
      void run('Проверяем файл отчётов…',async current=>{
        let parsed;
        try{parsed=JSON.parse(await readText(file));}catch(_){if(current())metricsStatus('Файл не распознан: это должен быть подготовленный файл отчётов 2ГИС.');return;}
        if(!current())return;
        const reports=Array.isArray(parsed)?parsed:parsed&&Array.isArray(parsed.reports)?parsed.reports:null;
        if(!reports||!reports.length){metricsStatus('В файле нет отчётов.');return;}
        const result=await ctx.apiJson('/content/crm/platform-demand/company-metrics/preview?companyCode='+encodeURIComponent(company),ctx.csrfOptions('POST',{reports}));
        if(!current())return;
        if(String(result.companyCode||'').toLowerCase()!==company.toLowerCase())throw Error('WRONG_COMPANY');
        /* Подтверждение привязано к состоянию данных (dataRevision) и к отпечатку именно
           показанного пакета: устаревшее подтверждение сервер отклонит целиком. */
        metricsPreview={company,reports,settingsRevision:result.settingsRevision,dataRevision:result.dataRevision,
          packageHash:result.packageHash,requiresConfirmation:result.requiresConfirmation};
        get('metrics-preview').innerHTML=`<p><strong>Будет загружено в компанию: ${esc(data.company.name)}</strong> · отчётов: ${esc(String(result.reports.length))}</p>
          <ul>${result.reports.map(item=>`<li>${esc(item.reportKindLabel)} · ${esc(range(item))} · значений ${esc(String(item.rowCount))}, из них известных ${esc(String(item.knownValues))}, нулей ${esc(String(item.zeroValues))} · снято ${esc(day(item.capturedDate))}${item.capturedAtKnown?'':' (точное время неизвестно)'} · ${esc(item.sourceKindLabel)}${item.alreadyImported?'<br>Эти числа уже действуют с теми же условиями: повторная загрузка ничего не добавит.':''}${(item.conditionChanges||[]).length?'<br>Изменились условия или подтверждение источника: '+item.conditionChanges.map(change=>esc(change.label)+' — было «'+esc(change.previous)+'», станет «'+esc(change.next)+'»').join('; ')+(item.unchangedValuesWithNewConditions?`. Значений с теми же числами: ${esc(String(item.unchangedValuesWithNewConditions))}.`:''):''}${item.scopeNoteLabel?'<br>'+esc(item.scopeNoteLabel):''}${item.conflictCount?`<br>Совпадающих дат: ${esc(String(item.conflictCount))}, из них изменится значений: ${esc(String(item.changedValues))}`:''}</li>`).join('')}</ul>
          ${result.requiresConfirmation?`<p class="demand-warning">${esc(result.note)}</p>${result.conditionsOnly?'':`<ul>${result.reports.flatMap(item=>item.conflicts.filter(change=>change.changed).map(change=>`<li>${esc(day(change.date))} · ${esc(change.metricLabel)}: было ${change.previousValue===null?'нет данных':esc(number(change.previousValue))} → станет ${change.nextValue===null?'нет данных':esc(number(change.nextValue))}</li>`)).join('')}</ul>`}`:`<p class="demand-note">${esc(result.note)}</p>`}`;
        get('metrics-preview').hidden=false;get('metrics-preview').focus();
        metricsStatus('Предпросмотр готов. Ничего ещё не загружено.');controls();
      },true);
    });
    get('metrics-save').addEventListener('click',()=>{
      if(!metricsPreview||!editable()||metricsPreview.company!==company)return;
      void run('Загружаем показатели компании…',async current=>{
        const result=await ctx.apiJson('/content/crm/platform-demand/company-metrics/import?companyCode='+encodeURIComponent(company),
          ctx.csrfOptions('POST',{settingsRevision:metricsPreview.settingsRevision,dataRevision:metricsPreview.dataRevision,
            packageHash:metricsPreview.packageHash,confirmReplace:metricsPreview.requiresConfirmation,reports:metricsPreview.reports}));
        if(!current())return;
        clearMetricsPreview();get('metrics-file').value='';
        await refreshData(current);if(!current())return;
        await refreshMetrics(current);if(!current())return;
        metricsStatus(result.imported.length?`Загружено отчётов: ${result.imported.length}. Повторно уже загруженные не добавлялись.`:'Новых отчётов не было: эти значения уже загружены.');
      },true);
    });
    get('category').addEventListener('change',()=>{const item=data?.categories?.items?.find(item=>item.category===get('category').value);get('classification').value=item?.classification||'unclassified';get('reason').value=item?.reason||'';controls();});
    get('category-form').addEventListener('submit',event=>{event.preventDefault();if(!editable()||!data||!get('category-form').reportValidity())return;
      const body={revision:data.categories.revision,items:[{category:get('category').value,classification:get('classification').value,reason:get('reason').value.trim()}]};
      clearPreview();void run('Сохраняем назначение рубрики…',async current=>{await api('/categories','PUT',body);if(!current())return;await refreshData(current);if(current())status('Назначение рубрики и причина сохранены для этой компании.');},true);
    });
    return {ready:load(ctx.selectedProjectId),update(next){const hadEdit=editable();ctx=next;if(!allowed(ctx)){epoch++;busy=false;data=null;preview=null;container.replaceChildren();controller=null;return;}if(company!==String(ctx.selectedProjectId||''))return load(ctx.selectedProjectId);if(hadEdit&&!editable()){epoch++;busy=false;clearPreview();}controls();}};
  }
  sb.registerView('platform-demand',{title:'Потенциал 2ГИС',render(container,ctx){if(!allowed(ctx)){controller?.update(ctx);container.replaceChildren();return;}if(!controller)controller=create(container,ctx);else return controller.update(ctx);return controller.ready;},onProjectChange(ctx){return controller?.update(ctx);}});
})();
