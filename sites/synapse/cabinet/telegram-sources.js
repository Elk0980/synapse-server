/* Отдельный список приватных исходников. Подключается владельцем экрана материалов;
   не меняет общий роутер и не включает приём Telegram. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SbCabinet = root.SbCabinet || {}).telegramSources = api;
}(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  function mount({element, companyCode, request, upload}) {
    if (!/^[a-z0-9_-]{1,64}$/.test(companyCode) || typeof request !== 'function') throw new Error('Не указан проект исходников');
    const doc = element.ownerDocument; let stopped = false, loading = false, cursor = null, sending=false, manualLimit=0;
    const make = (tag, text) => { const node = doc.createElement(tag); if (text) node.textContent = text; return node; };
    const heading = make('h3', 'Исходники из Telegram'), status = make('p', 'Загружаем исходники…');
    status.setAttribute('role', 'status');
    const note = make('p', 'Здесь появляются новые материалы после подключения. Старую историю бот не загружает. Публикации создаются и согласуются отдельно.');
    const list = make('ul'), more = make('button', 'Показать ещё'); more.type = 'button'; more.hidden = true;
    const retry = make('button', 'Повторить загрузку'); retry.type = 'button'; retry.hidden = true;
    const form=make('form'),importStatus=make('p');form.hidden=true;importStatus.setAttribute('role','status');
    form.append(make('h4','Ручной импорт старого файла'),make('p','Выберите ранее скачанный файл. Это ручное пополнение приватного архива, а не автоматическая загрузка истории Telegram.'));
    const field=(label,input)=>{const wrap=make('label',label);wrap.append(input);form.append(wrap);return input;};
    const mode=field('Происхождение ',make('select'));
    for(const [value,label] of [['link','Есть ссылка на сообщение'],['archive','Старое сообщение без ссылки']]){const option=make('option',label);option.value=value;mode.append(option);}
    const origin=field('Ссылка на сообщение Telegram ',make('input'));origin.type='url';origin.name='telegramUrl';origin.required=true;origin.placeholder='https://t.me/c/…/…';
    const source=field('Подключённый источник ',make('select'));source.name='sourceChatId';
    const provenance=field('Откуда этот файл: история беседы, дата, исходное имя ',make('textarea'));provenance.name='provenance';provenance.maxLength=1000;
    const file=field('Файл ',make('input'));file.type='file';file.name='file';file.required=true;file.accept='.jpg,.jpeg,.png,.webp,.mp4,.mov,.webm,.pdf';
    const limitNote=make('p');form.append(limitNote);
    const submit=make('button','Сохранить в приватный архив');submit.type='submit';form.append(submit,importStatus);
    const chooseMode=()=>{const legacy=mode.value==='archive';origin.parentElement.hidden=legacy;origin.required=!legacy;source.parentElement.hidden=!legacy;source.required=legacy;provenance.parentElement.hidden=!legacy;provenance.required=legacy;};
    mode.addEventListener('change',chooseMode);chooseMode();
    element.replaceChildren(heading, status, note, form, list, more, retry);
    const link = (label, href) => { const a = make('a', label); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };
    async function load() {
      if (stopped || loading) return;
      loading = true; retry.hidden = true; more.disabled = true;
      try {
        const data = await request(`/content/telegram-sources/${companyCode}${cursor ? '?before=' + cursor : ''}`);
        if (stopped) return;
        form.hidden=!(data.manualUploadAllowed&&typeof upload==='function');
        manualLimit=Number.isSafeInteger(data.manualMaxBytes)?data.manualMaxBytes:0;
        limitNote.textContent=manualLimit?`Один файл — до ${Math.floor(manualLimit/1024/1024)} МиБ. Файл останется доступен только в кабинете.`:'';
        if(!source.children.length)for(const [index,item] of (data.sources||[]).entries()){const option=make('option',`Источник ${index+1} (${item.chatId})`);option.value=item.chatId;source.append(option);}
        for (const item of data.items || []) {
          const row = make('li'), title = make('strong', item.name || 'Сообщение с исходниками'); row.append(title);
          row.append(make('p', item.status === 'stored' ? 'Файл сохранён' : item.status === 'text' ? 'Текст сохранён' : 'Нужен ручной импорт'));
          if(item.importMethod==='manual'||item.importMethod==='manual_archive')row.append(make('p',item.importMethod==='manual_archive'?'Ручной архивный импорт · без ссылки на сообщение':'Ручной импорт по ссылке на сообщение'));
          if(item.provenance)row.append(make('p',item.provenance));
          if (item.caption) row.append(make('p', item.caption));
          if (item.reason) row.append(make('p', item.reason));
          if (Number.isFinite(item.size)) row.append(make('p', `${(item.size / 1024 / 1024).toLocaleString('ru-RU', {maximumFractionDigits: 1})} МБ`));
          // Серверные ссылки также ограничены своей компанией и HTTPS Telegram.
          if (item.status === 'stored' && new RegExp(`^/content/telegram-sources/${companyCode}/[1-9]\\d*/file$`).test(item.fileUrl || '')) row.append(link('Скачать файл', item.fileUrl));
          if (/^https:\/\/t\.me\/c\/\d+\/\d+$/.test(item.telegramUrl || '')) { row.append(doc.createTextNode(' · ')); row.append(link('Открыть сообщение в Telegram', item.telegramUrl)); }
          list.append(row);
        }
        cursor = Number.isSafeInteger(data.nextBefore) && data.nextBefore > 0 ? data.nextBefore : null;
        more.hidden = !cursor;
        status.textContent = `${data.enabled ? 'Приём новых исходников включён.' : 'Приём новых исходников выключен.'}${list.children.length ? '' : ' Сохранённых исходников пока нет.'}`;
      } catch { if (!stopped) { status.textContent = 'Не удалось загрузить исходники. Проверьте доступ к проекту и повторите.'; retry.hidden = false; } }
      finally { loading = false; more.disabled = false; }
    }
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(stopped||sending||loading||form.hidden)return;
      const selected=file.files?.[0];if(!selected){importStatus.textContent='Выберите файл.';return;}
      if(!manualLimit||selected.size> manualLimit){importStatus.textContent='Файл превышает предел ручного импорта.';return;}
      const body=new doc.defaultView.FormData();
      if(mode.value==='archive'){body.set('sourceChatId',source.value);body.set('provenance',provenance.value.trim());}
      else body.set('telegramUrl',origin.value.trim());
      body.set('file',selected);sending=true;submit.disabled=true;more.disabled=true;importStatus.textContent='Загружаем файл в приватный архив…';
      try{
        const result=await upload(`/content/telegram-sources/${companyCode}/manual-upload`,body);
        if(stopped)return;
        importStatus.textContent=result.duplicate?'Этот файл уже есть в архиве. Повтор не создан.':'Файл сохранён в приватном архиве.';
        file.value='';list.replaceChildren();cursor=null;await load();
      }catch(error){if(!stopped)importStatus.textContent=error?.message||'Не удалось загрузить файл. Можно повторить без создания дубля.';}
      finally{sending=false;submit.disabled=false;more.disabled=false;}
    });
    more.addEventListener('click', load); retry.addEventListener('click', load); void load();
    return {destroy() { stopped = true; element.replaceChildren(); }};
  }
  return {mount};
}));
