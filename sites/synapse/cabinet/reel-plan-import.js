(() => {
  'use strict';
  const sb = window.SbCabinet = window.SbCabinet || {};
  const fields = {date:'Дата',platforms:'Площадки',topic:'Тема',format:'Формат',script:'Сценарий',filmingBy:'Кто снимает',productionStatus:'Статус подготовки',hook:'Хук',broll:'Вставки (B-roll)',style:'Стиль',props:'Реквизит'};
  const aliases = {date:['дата','date'],platforms:['площадка','площадки','platform','platforms'],topic:['тема','topic','название'],format:['формат','format'],script:['сценарий','script'],filmingBy:['ктоснимает','снимающий','filmingby'],productionStatus:['статус','статусподготовки','productionstatus'],hook:['хук','зацепка','hook'],broll:['вставки','вставкиbroll','broll','бролл'],style:['стиль','style'],props:['реквизит','props']};
  const statuses = {planned:'Запланировано',shot:'Отснято',editing:'В монтаже',draft:'Черновик'};
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const key = value => String(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  function date(value) {
    const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value);
    const iso = match ? `${match[3]}-${match[2].padStart(2,'0')}-${match[1].padStart(2,'0')}` : value;
    if (!/^[1-9]\d{3}-\d\d-\d\d$/.test(iso) || !Number.isFinite(Date.parse(iso+'T00:00:00Z')) || new Date(iso+'T00:00:00Z').toISOString().slice(0,10) !== iso) throw Error('Дата должна быть в формате ГГГГ-ММ-ДД или ДД.ММ.ГГГГ');
    return iso;
  }
  function convert(rows, mapping, data, prefix) {
    const items = [], errors = [], required = ['date','platforms','topic','format'];
    for (const field of required) if (!(mapping[field] >= 0)) errors.push(`Выберите столбец «${fields[field]}»`);
    const vocabulary = data.vocabulary, allowed = data.brief.fields.platforms;
    const lookup = (value,list,extra={}) => list.find(item => key(item.id) === key(value) || key(item.label) === key(value))?.id || extra[key(value)];
    const platformAliases = {tg:'telegram',тг:'telegram',вк:'vk',vkontakte:'vk',ig:'instagram',insta:'instagram',ютуб:'youtube_shorts',youtubeshorts:'youtube_shorts',shorts:'youtube_shorts'};
    if (errors.length) return {items,errors};
    rows.slice(1).forEach((cells,index) => {
      if (!cells.some(cell => String(cell).trim())) return;
      const value = field => mapping[field] >= 0 ? String(cells[mapping[field]] ?? '') : '';
      try {
        const platforms = [...new Set(value('platforms').split(/[,;]+/).map(part => lookup(part.trim(),vocabulary.platforms,platformAliases)))];
        if (!platforms.length || platforms.some(platform => !platform || !allowed.includes(platform))) throw Error('Неизвестная площадка или площадка не выбрана в брифе');
        const format = lookup(value('format'),vocabulary.formats,{reels:'reel',shorts:'reel',рилс:'reel'});
        if (!format || !vocabulary.formats.some(item => item.id === format)) throw Error('Неизвестный формат');
        const topic = value('topic').trim(), script = value('script').replace(/\r\n?/g,'\n'), filmingBy = value('filmingBy').trim();
        if (!topic || topic.length > 300 || script.length > 20000 || filmingBy.length > 200) throw Error('Проверьте тему (до 300), сценарий (до 20000) и снимающего (до 200 символов)');
        const statusText = value('productionStatus').trim();
        const productionStatus = statusText ? lookup(statusText,Object.entries(statuses).map(([id,label])=>({id,label}))) : 'planned';
        if (!productionStatus) throw Error('Статус: запланировано, отснято, в монтаже или черновик; согласование не импортируется');
        // №98 Б: хук, вставки, стиль, реквизит; подпись версии — из хука и темы, иначе версия «пустая» и не согласуется.
        const hook = value('hook').trim().slice(0,500), extras = Object.fromEntries([['broll',4000],['style',1000],['props',2000]].map(([k,max])=>[k,value(k).trim().slice(0,max)]).filter(([,v])=>v));
        const text = [hook,topic].filter(Boolean).join('\n\n');
        items.push({ideaId:`import-${prefix}-${index+1}`,date:date(value('date').trim()),platform:platforms[0],format,role:vocabulary.roles[0]?.id || 'reach',topic,script,filmingBy,productionStatus,...extras,
          hook,assetId:'',mentorNote:'',variants:Object.fromEntries(platforms.map(platform=>[platform,{text,hook,format,assetId:'',mentorNote:''}]))});
      } catch (error) { errors.push(`Строка ${index+2}: ${error.message}`); }
    });
    if (!items.length && !errors.length) errors.push('В файле нет материалов');
    if (items.length > 93) errors.push('За один раз можно добавить не больше 93 материалов');
    return {items,errors};
  }
  function install({node,data,ctx,code,form,collectDays,isCurrent,appendDays}) {
    if (!form || !(ctx.identity?.role === 'owner' || ctx.identity?.permissions?.includes('autoposting.edit'))) return;
    const panel = document.createElement('details'); panel.className = 'mentor-import';
    panel.innerHTML = '<summary>Импортировать план из CSV / XLSX</summary><p>Выберите файл до 1 МиБ: CSV в UTF-8 или первый лист XLSX. Сопоставьте столбцы и проверьте строки. После добавления сохраните план обычной кнопкой.</p><label>Файл плана<input type="file" accept=".csv,.xlsx" data-import-file></label><div data-import-mapping></div><pre data-import-preview></pre><p data-import-state role="status"></p><button type="button" data-import-add disabled>Добавить в план</button>';
    form.before(panel);
    const input = panel.querySelector('[data-import-file]'), mappingNode = panel.querySelector('[data-import-mapping]');
    const preview = panel.querySelector('[data-import-preview]'), message = panel.querySelector('[data-import-state]'), add = panel.querySelector('[data-import-add]');
    let generation = 0, rows = [], prefix = '', result = {items:[],errors:[]};
    const current = () => panel.isConnected && isCurrent();
    const mapping = () => Object.fromEntries([...mappingNode.querySelectorAll('select')].map(select=>[select.dataset.importMap,Number(select.value)]));
    function review() {
      result = convert(rows,mapping(),data,prefix);
      const known = new Set(collectDays(form).map(item=>item.ideaId));
      const fresh = result.items.filter(item=>!known.has(item.ideaId)), combined = [...collectDays(form),...fresh];
      const counts = new Map(), dates = combined.map(item=>item.date).filter(Boolean).sort();
      for (const item of combined) counts.set(item.date,(counts.get(item.date)||0)+1);
      if (combined.length > 93 || [...counts.values()].some(count=>count>3)) result.errors.push('В плане допускается до 93 материалов и не больше трёх в день');
      if (dates.length && (Date.parse(dates.at(-1))-Date.parse(dates[0]))/86400000 > 30) result.errors.push('Весь план должен помещаться в 31 день');
      preview.textContent = result.items.map(item=>`${item.date} · ${Object.keys(item.variants).join(', ')} · ${item.topic}\n${item.format} · ${item.filmingBy || 'Снимающий не указан'} · ${statuses[item.productionStatus]}${item.script ? '\n'+item.script.slice(0,200)+(item.script.length>200?'…':'') : ''}`).join('\n\n');
      message.textContent = result.errors.length ? result.errors.join('\n') : `Проверено: ${result.items.length}. Новых материалов: ${fresh.length}. Роль материала: ${data.vocabulary.roles[0]?.label || 'Охватный'}.`;
      add.disabled = result.errors.length > 0 || !fresh.length;
      return fresh;
    }
    input.onchange = async () => {
      const version = ++generation, file = input.files?.[0]; rows = []; mappingNode.replaceChildren(); preview.textContent = ''; add.disabled = true;
      if (!file) return;
      try {
        if (!/\.(csv|xlsx)$/i.test(file.name) || !file.size || file.size > 1048576) throw Error('Выберите CSV или XLSX размером до 1 МиБ');
        message.textContent = 'Читаем файл…';
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!current() || version !== generation) return;
        const hash = new Uint8Array(await window.crypto.subtle.digest('SHA-256',bytes));
        if (!current() || version !== generation) return;
        prefix = [...hash].map(value=>value.toString(16).padStart(2,'0')).join('').slice(0,32);
        let binary = ''; for (let offset=0;offset<bytes.length;offset+=32768) binary += String.fromCharCode(...bytes.subarray(offset,offset+32768));
        const response = await ctx.crmQuery('/media-mentor/plan/import-preview',{companyCode:code},ctx.csrfOptions('POST',{filename:file.name,base64:btoa(binary)}));
        if (!current() || version !== generation) return;
        if (response.companyCode !== String(code).toLowerCase() || !Array.isArray(response.rows) || response.rows.some(row=>!Array.isArray(row)||row.some(cell=>typeof cell!=='string'))) throw Error('Ответ файла не подходит к этой компании');
        rows = response.rows;
        if (!rows.length) throw Error('В файле нет строк');
        mappingNode.innerHTML = Object.entries(fields).map(([field,label])=>{
          const selected = rows[0].findIndex(header=>aliases[field].includes(key(header)));
          return `<label>${label}<select data-import-map="${field}"><option value="-1">Не выбран</option>${rows[0].map((header,index)=>`<option value="${index}"${index===selected?' selected':''}>${esc(header || `Столбец ${index+1}`)}</option>`).join('')}</select></label>`;
        }).join('');
        mappingNode.onchange = review; review();
      } catch (error) { if (current() && version === generation) message.textContent = error.message; }
    };
    add.onclick = () => {
      if (!current()) return;
      const fresh = review(); if (add.disabled) return;
      appendDays(fresh); review();
      message.textContent = `Добавлено в форму: ${fresh.length}. Теперь нажмите «Сохранить план».`;
    };
  }
  sb.reelPlanImport = {install,convert};
})();
