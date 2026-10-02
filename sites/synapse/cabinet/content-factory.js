(() => {
  'use strict';
  /* Контент завод, пакет CF1: «Настройки модуля», «Статистика» и строка действий Контент-плана.
     Здесь ничего не генерируется и не публикуется. Вводные читаются из брифа Медиа-наставника
     (продукт, ситуация покупателя, аудитория) и из отдельного профиля контент-завода; пожелания
     месяца не меняют постоянный профиль. CF2 (клиент): запуск серверного составления плана, его состояния,
     вопросы, предложения и создание черновиков — через серверную очередь, без автосогласования и публикации. */
  const sb = window.SbCabinet;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
  const canRead = (ctx) => ctx.identity?.role === 'owner' || (ctx.identity?.permissions || []).includes('autoposting.view');
  const canEdit = (ctx) => ctx.identity?.role === 'owner' || (ctx.identity?.permissions || []).includes('autoposting.edit');
  const canAnalytics = (ctx) => ctx.identity?.role === 'owner' || (ctx.identity?.permissions || []).includes('analytics.view');
  const lines = (value) => [...new Set(String(value || '').split('\n').map((item) => item.trim()).filter(Boolean))];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const number = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const GENDERS = [['women', 'Женщины'], ['men', 'Мужчины']];

  /* Подсказка поля: зачем → пример. Ошибки показываются рядом с полем постоянно, а не здесь. */
  const HINTS = {
    product: ['Продукт', 'Что именно вы предлагаете в этом контенте.', 'Оформление шарами под ключ для праздников.'],
    situation: ['Ситуация и задача покупателя', 'С какой жизненной ситуацией человек приходит и что хочет получить. Каждая ситуация — с новой строки.',
      'Скоро день рождения ребёнка. Хочу красиво украсить место праздника шарами, но нет времени заниматься оформлением.'],
    audience: ['Аудитория', 'Кто покупает или для кого покупают. Без догадок о доходе и интересах.', 'Родители детей дошкольного возраста.'],
    gender: ['Пол аудитории', 'Отметьте одну или обе галочки. Если не важно или неизвестно — оставьте пустыми.', 'Женщины и Мужчины — обе галочки.'],
    age: ['Возраст аудитории', 'Необязательно. Пустое значение — без ограничения.', 'от 25 до 45.'],
    geography: ['География', 'Где находятся покупатели и куда вы реально доставляете или приезжаете.', 'Город и пригороды до 30 км.'],
    targetAction: ['Целевое действие', 'Что человек должен сделать после публикации.', 'Запросить расчёт оформления.'],
    targetUrl: ['Куда вести', 'Конкретная форма сайта или канал обращений. Только адрес http(s).', 'https://example.ru/zakaz'],
    occasions: ['Поводы покупки', 'Когда обычно покупают. Каждый повод — с новой строки.', 'День рождения, выписка из роддома, выпускной.'],
    questions: ['Частые вопросы и сомнения', 'Что спрашивают и чего опасаются до покупки.', 'Успеете ли к утру? Сколько продержатся шары?'],
    proofs: ['Реальные преимущества и доказательства', 'Только то, что можно подтвердить: фото работ, отзывы с разрешением, сроки.', 'Фото 30 оформлений из собственного архива.'],
    sourcesNote: ['Доступные исходники', 'Какие фото, видео и тексты уже есть или можно снять.', 'Фото готовых композиций, видео сборки.'],
    styleNotes: ['Стиль и ограничения съёмки', 'Как можно и нельзя снимать.', 'Без лиц детей, только руки и процесс.'],
    month: ['Месяц', 'Пожелания относятся только к выбранному месяцу и не меняют постоянные вводные.', '2026-10.'],
    priorities: ['Приоритетные товары и услуги', 'Что важно продвинуть в этом месяце. Каждое — с новой строки.', 'Фотозона на выпускной.'],
    events: ['События и акции', 'Указывайте только подтверждённые условия; отметьте, проверены ли они.', 'Осенняя акция с 15 числа по прайсу владельца.'],
    excluded: ['Дни без публикаций', 'Числа месяца через запятую.', '4, 5.'],
    platforms: ['Площадки и объём', 'Где и сколько публикаций в день нужно. Итог виден сразу.', 'Telegram — 1 в день.'],
    formats: ['Форматы публикаций', 'Какие виды публикаций предлагать в этом месяце: Пост, Сторис, Reels / Shorts / клип, Карусель. «Все подходящие» — любые, которые поддерживает площадка. Объём и площадки от выбора не меняются.',
      'только Пост и Reels / Shorts / клип — без Сторис и Карусели.'],
    roles: ['Цели публикаций (ОВП)', 'Зачем нужна публикация: Охват — привлечь новых людей, Влюбление — укрепить доверие, Продажи — подтолкнуть к заказу. Процентов и обязательных долей нет.',
      'только Охват и Продажи.'],
    dailyPlatform: ['Площадка графика', 'Чей дневной ряд показать. Дни считаются по поясу аккаунта этой площадки.', 'Telegram.'],
    filterPlatform: ['Площадка', 'Отбирает публикации и сводку по одной площадке. Просмотры и переходы — по её аккаунту.', 'Telegram.'],
    filterFormat: ['Формат', 'Отбирает карточки и публикации с этим форматом. Просмотры и переходы по формату не разбиваются.', 'Сторис.'],
    filterRole: ['Цель ОВП', 'Отбирает карточки и публикации с этой целью. Неизвестная цель в отбор не входит.', 'Продажи.'],
    releaseMode: ['Режим выпуска', 'Как выходят согласованные материалы. Ручной — публикуете сами, постановка в очередь из кабинета отключена. По расписанию — согласованный материал можно отдельно поставить в план на его время. Действует на новые назначения.',
      'Ручной, пока аккаунты площадок не подключены.'],
    hours: ['Часы публикаций', 'Удобное время выхода по местному времени проекта, через запятую. Пожелание для новых заданий плана, а не обещанное время готовности.', '10:00, 18:30.'],
    preparationDays: ['Дни на подготовку', 'Сколько дней обычно нужно на съёмку и монтаж до выхода. Целое число от 0 до 30; пожелание для плана, не срок задачи.', '3.'],
    reviewDays: ['Дни на согласование', 'Сколько дней заложить на проверку и правки до выхода. Целое число от 0 до 30.', '1.'],
    publisherName: ['Кто выпускает', 'Имя человека, который выпускает материалы. Это подпись для команды — не подключённый аккаунт и не назначенная задача.', 'Дарья.'],
    approver: ['Кто согласует', 'Согласование материалов — у владельца кабинета. Здесь не меняется.', 'Владелец кабинета.'],
    dailyMetric: ['Показатель графика', 'Просмотры — сумма просмотров за день, не уникальные люди. Переходы — клики по ссылке, где площадка их отдаёт.', 'Переходы по ссылке за 12 октября.'],
  };
  function hint(id) {
    const [label, why, example] = HINTS[id];
    return `<button type="button" class="cf-hint" aria-label="Подсказка: ${esc(label)}" aria-expanded="false" aria-controls="cf-hint-${id}">?</button>` +
      `<span class="cf-hint-text" id="cf-hint-${id}" role="note" hidden>${esc(why)} Например: ${esc(example)}</span>`;
  }
  function bindHints(node) {
    node.querySelectorAll('.cf-hint').forEach((button) => button.addEventListener('click', () => {
      const note = node.ownerDocument.getElementById(button.getAttribute('aria-controls'));
      const open = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(open));
      if (note) note.hidden = !open;
    }));
  }
  const field = (id, label, control) => `<div class="cf-field"><div class="cf-label-row"><label for="cf-${id}">${esc(label)}</label>${hint(id)}</div>${control}</div>`;
  function monthNow(timezone) {
    const format = (zone) => new Intl.DateTimeFormat('en-CA', {...(zone ? {timeZone: zone} : {}), year: 'numeric', month: '2-digit'}).format(new Date()).slice(0, 7);
    try { return format(timezone || undefined); } catch { return format(); }
  }
  const lastDay = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

  /* ---------- Настройки модуля ---------- */
  const settings = {epoch: 0, monthEpoch: 0, state: null, focus: null};

  function businessMarkup(data, edit) {
    const b = data.brief.fields, p = data.inputs.profile.fields;
    const dis = edit ? '' : ' disabled';
    const gender = GENDERS.map(([id, label]) => `<label class="cf-check"><input type="checkbox" name="gender" value="${id}"${p.genders.includes(id) ? ' checked' : ''}${dis}>${label}</label>`).join('');
    return `<form id="cf-business-form" class="cf-form" data-company="${esc(data.code)}" novalidate>
      ${field('product', 'Продукт', `<textarea id="cf-product" name="product" rows="2" maxlength="2000"${dis}>${esc(b.product)}</textarea>`)}
      ${field('situation', 'Ситуация и задача покупателя', `<textarea id="cf-situation" name="situation" rows="3"${dis}>${esc(b.pains.join('\n'))}</textarea>`)}
      ${field('audience', 'Аудитория', `<input id="cf-audience" name="audience" maxlength="2000" value="${esc(b.audience)}"${dis}>`)}
      <div class="cf-field"><div class="cf-label-row"><span id="cf-gender-label">Пол</span>${hint('gender')}</div>
        <div class="cf-inline" role="group" aria-labelledby="cf-gender-label">${gender}<span id="cf-gender-summary" class="cf-note"></span></div></div>
      <div class="cf-field"><div class="cf-label-row"><span id="cf-age-label">Возраст</span>${hint('age')}</div>
        <div class="cf-inline" role="group" aria-labelledby="cf-age-label">
          <label>от <input name="ageFrom" type="number" min="0" max="120" step="1" inputmode="numeric" value="${p.ageFrom ?? ''}"${dis}></label>
          <label>до <input name="ageTo" type="number" min="0" max="120" step="1" inputmode="numeric" value="${p.ageTo ?? ''}"${dis}></label>
          <span id="cf-age-summary" class="cf-note"></span></div>
        <p class="cf-error" id="cf-age-error" role="alert" hidden></p></div>
      ${field('geography', 'География', `<input id="cf-geography" name="geography" maxlength="500" value="${esc(p.geography)}"${dis}>`)}
      ${field('targetAction', 'Целевое действие (необязательно)', `<input id="cf-targetAction" name="targetAction" maxlength="500" value="${esc(p.targetAction)}"${dis}>`)}
      ${field('targetUrl', 'Куда вести (необязательно)', `<input id="cf-targetUrl" name="targetUrl" type="url" maxlength="2000" value="${esc(p.targetUrl)}"${dis}>`)}
      <p class="cf-error" id="cf-url-error" role="alert" hidden></p>
      <details id="cf-refine" class="cf-refine"><summary>Уточнить план</summary>
        ${field('occasions', 'Поводы покупки', `<textarea id="cf-occasions" name="occasions" rows="2"${dis}>${esc(p.occasions.join('\n'))}</textarea>`)}
        ${field('questions', 'Частые вопросы и сомнения', `<textarea id="cf-questions" name="questions" rows="2"${dis}>${esc(p.questions.join('\n'))}</textarea>`)}
        ${field('proofs', 'Реальные преимущества и доказательства', `<textarea id="cf-proofs" name="proofs" rows="2"${dis}>${esc(p.proofs.join('\n'))}</textarea>`)}
        ${field('sourcesNote', 'Доступные исходники', `<textarea id="cf-sourcesNote" name="sourcesNote" rows="2" maxlength="2000"${dis}>${esc(p.sourcesNote)}</textarea>`)}
        ${field('styleNotes', 'Стиль и ограничения съёмки', `<textarea id="cf-styleNotes" name="styleNotes" rows="2" maxlength="2000"${dis}>${esc(p.styleNotes)}</textarea>`)}
      </details>
      <p class="cf-warning" id="cf-brief-warning" role="note" hidden>Изменение продукта, ситуации или аудитории создаст новую версию брифа: текущий план и его согласования останутся по прежней версии и потребуют повторного согласования.</p>
      ${edit ? '<div class="cf-actions"><button class="plain-button" type="submit">Сохранить вводные</button>' : '<p class="cf-note">У вас только просмотр вводных.</p>'}
      <span id="cf-business-state" class="cf-note" role="status"></span>${edit ? '</div>' : ''}
    </form>`;
  }
  function readBusiness(form) {
    const value = (name) => form.elements[name].value.trim();
    const age = (name) => { const raw = value(name); return raw === '' ? null : Number(raw); };
    return {
      brief: {product: value('product'), audience: value('audience'), pains: lines(form.elements.situation.value)},
      profile: {genders: GENDERS.map(([id]) => id).filter((id) => form.querySelector(`[name="gender"][value="${id}"]`).checked),
        ageFrom: age('ageFrom'), ageTo: age('ageTo'), geography: value('geography'), targetAction: value('targetAction'), targetUrl: value('targetUrl'),
        occasions: lines(form.elements.occasions.value), questions: lines(form.elements.questions.value), proofs: lines(form.elements.proofs.value),
        sourcesNote: value('sourcesNote'), styleNotes: value('styleNotes')},
    };
  }
  const changed = (next, current) => Object.fromEntries(Object.entries(next).filter(([key, value]) => !same(value, current[key])));
  function summaries(form) {
    const {profile} = readBusiness(form);
    const node = form.querySelector('#cf-gender-summary');
    node.textContent = profile.genders.length === 2 ? 'Женщины и мужчины' : profile.genders.length ? (profile.genders[0] === 'women' ? 'Только женщины' : 'Только мужчины') : 'Не указано';
    const from = profile.ageFrom, to = profile.ageTo;
    form.querySelector('#cf-age-summary').textContent = from === null && to === null ? 'Не ограничивать'
      : `${from === null ? '' : `от ${from} `}${to === null ? '' : `до ${to}`}`.trim();
  }
  function validateBusiness(form, profile) {
    const ageError = form.querySelector('#cf-age-error'), urlError = form.querySelector('#cf-url-error');
    const ok = (value) => value === null || (Number.isInteger(value) && value >= 0 && value <= 120);
    let error = '';
    if (!ok(profile.ageFrom) || !ok(profile.ageTo)) error = 'Возраст — целое число от 0 до 120 или пусто.';
    else if (profile.ageFrom !== null && profile.ageTo !== null && profile.ageFrom > profile.ageTo) error = 'Возраст «от» должен быть не больше возраста «до».';
    ageError.textContent = error; ageError.hidden = !error;
    let urlProblem = '';
    if (profile.targetUrl) {
      try { const url = new URL(profile.targetUrl); if (!['http:', 'https:'].includes(url.protocol)) urlProblem = 'Только адрес http(s).'; }
      catch { urlProblem = 'Только адрес http(s).'; }
    }
    urlError.textContent = urlProblem; urlError.hidden = !urlProblem;
    return !error && !urlProblem;
  }
  function bindBusiness(node, ctx) {
    const form = node.querySelector('#cf-business-form');
    if (!form) return;
    summaries(form);
    form.addEventListener('input', () => {
      summaries(form);
      const state = settings.state, next = readBusiness(form);
      node.querySelector('#cf-brief-warning').hidden = !Object.keys(changed(next.brief, briefFields(state))).length;
    });
    form.addEventListener('change', () => summaries(form));
    /* Бриф и профиль — две независимые записи со своими ревизиями. Каждая сохраняется и сообщается отдельно:
       частичный успех не выдаётся ни за полный, ни за отказ. Ввод в форме не сбрасывается; повтор отправляет
       только то, что ещё отличается от сохранённого, поэтому лишней версии брифа и нового сброса согласования нет. */
    let busy = false;
    const button = form.querySelector('button[type="submit"]');
    const warning = () => { node.querySelector('#cf-brief-warning').hidden = !Object.keys(changed(readBusiness(form).brief, briefFields(settings.state))).length; };
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!canEdit(ctx) || busy) return;
      const state = settings.state, status = node.querySelector('#cf-business-state'), next = readBusiness(form);
      if (!validateBusiness(form, next.profile)) { status.textContent = 'Исправьте отмеченные поля.'; return; }
      const briefPatch = changed(next.brief, briefFields(state)), profilePatch = changed(next.profile, state.inputs.profile.fields);
      if (!Object.keys(briefPatch).length && !Object.keys(profilePatch).length) { status.textContent = 'Изменений нет.'; status.classList.remove('cf-warning'); return; }
      const code = state.code, epoch = settings.epoch, stale = () => epoch !== settings.epoch || state !== settings.state;
      busy = true; if (button) button.disabled = true; form.setAttribute('aria-busy', 'true');
      status.classList.remove('cf-warning');
      status.textContent = 'Сохраняем…';
      const done = [], failed = [];
      const parts = [
        {name: 'бриф', changedWord: 'изменён', patch: briefPatch, kind: 'brief', base: () => briefFields(state),
          put: () => ctx.crmQuery('/media-mentor/brief', {companyCode: code}, ctx.csrfOptions('PUT', {revision: state.brief.revision, brief: briefPatch})),
          apply: (saved) => { state.brief = saved.brief; return saved.brief.revision; },
          refresh: async () => { const fresh = await ctx.crmQuery('/media-mentor', {companyCode: code}); if (fresh.companyCode !== code) throw new Error('Ответ другой компании'); state.brief = fresh.brief; return fresh.brief.revision; }},
        {name: 'вводные профиля', changedWord: 'изменены', patch: profilePatch, kind: 'profile', base: () => state.inputs.profile.fields,
          put: () => ctx.crmQuery('/media-mentor/inputs', {companyCode: code}, ctx.csrfOptions('PUT', {revision: state.inputs.profile.revision, profile: profilePatch})),
          apply: (saved) => { state.inputs = {...state.inputs, profile: saved.profile}; return saved.profile.revision; },
          refresh: async () => { const fresh = await ctx.crmQuery('/media-mentor/inputs', {companyCode: code}); if (fresh.companyCode !== code) throw new Error('Ответ другой компании'); state.inputs = {...state.inputs, profile: fresh.profile}; return fresh.profile.revision; }}];
      try {
        for (const part of parts) {
          if (!Object.keys(part.patch).length) continue;
          try {
            const saved = await part.put();
            if (stale()) return;
            done.push(`${part.name} (версия ${part.apply(saved)})`);
          } catch (error) {
            if (stale()) return;
            if (error.status !== 409) { failed.push(`${part.name} — ${error.message}`); continue; }
            // Конфликт ревизий: подтягиваем актуальную версию; поля, которые здесь не меняли, берутся из неё, свой ввод остаётся.
            const before = part.base();
            try {
              const revision = await part.refresh();
              if (stale()) return;
              const conflicts = mergeFresh(form, part.kind, before, part.base());
              failed.push(`${part.name} — ${part.changedWord} в другом окне: загружена версия ${revision}, поля, которые вы не меняли, обновлены из неё` +
                (conflicts.length ? `; в обоих окнах изменено: ${conflicts.join(', ')} — при повторе сохранится ваш вариант` : ''));
            } catch (refreshError) {
              if (stale()) return;
              failed.push(`${part.name} — ${part.changedWord} в другом окне, актуальную версию загрузить не удалось (${refreshError.message})`);
            }
          }
        }
      } finally {
        if (!stale()) { busy = false; if (button) button.disabled = false; form.removeAttribute('aria-busy'); }
      }
      summaries(form); warning();
      const retry = 'Значения остались в форме; проверьте их и нажмите «Сохранить вводные» ещё раз — отправится только несохранённое.';
      if (!failed.length) status.textContent = `Сохранено: ${done.join(', ')}. Вводные учитываются в следующих предложениях плана; сохранённые публикации не меняются.`;
      else status.textContent = `${done.length ? `Частично сохранено. Сохранено: ${done.join(', ')}.` : 'Ничего не сохранено.'} Не сохранено: ${failed.join('; ')}. ${retry}`;
      status.classList.toggle('cf-warning', Boolean(failed.length));
    });
  }
  const FIELD_NAMES = {product: 'продукт', audience: 'аудитория', pains: 'ситуация покупателя', genders: 'пол', ageFrom: 'возраст от', ageTo: 'возраст до',
    geography: 'география', targetAction: 'целевое действие', targetUrl: 'куда вести', occasions: 'поводы', questions: 'вопросы и сомнения',
    proofs: 'доказательства', sourcesNote: 'исходники', styleNotes: 'стиль'};
  function writeField(form, key, value) {
    if (key === 'genders') { form.querySelectorAll('[name="gender"]').forEach((box) => { box.checked = (value || []).includes(box.value); }); return; }
    const name = key === 'pains' ? 'situation' : key, control = form.elements[name];
    if (!control) return;
    control.value = Array.isArray(value) ? value.join('\n') : value ?? '';
  }
  // Трёхсторонняя сверка после конфликта: чужая правка не затирается молча, свой ввод не теряется.
  function mergeFresh(form, kind, before, fresh) {
    const current = readBusiness(form)[kind], conflicts = [];
    for (const key of Object.keys(current)) {
      if (same(before[key], fresh[key])) continue;
      if (same(current[key], before[key])) writeField(form, key, fresh[key]);
      else if (!same(current[key], fresh[key])) conflicts.push(FIELD_NAMES[key] || key);
    }
    return conflicts;
  }
  const briefFields = (state) => ({product: state.brief.fields.product || '', audience: state.brief.fields.audience || '', pains: state.brief.fields.pains || []});

  /* CF7: форматы и цели ОВП месяца — две независимые группы. Пустой список (и отсутствующее поле месяца,
     сохранённого до CF7) означает «Все подходящие», а не «ничего не выбрано». Объём и площадки выбор не меняет. */
  const CHOICES = {formats: {title: 'Форматы публикаций', item: 'format', none: 'Отметьте хотя бы один формат или выберите «Все подходящие».', all: 'все подходящие для площадки'},
    roles: {title: 'Цели публикаций (ОВП)', item: 'role', none: 'Отметьте хотя бы одну цель или выберите «Все подходящие».', all: 'все подходящие, без обязательных долей'}};
  const MONTH_NAMES = {priorities: 'приоритеты', events: 'события', excludedDays: 'дни без публикаций', platforms: 'площадки', perDay: 'объём',
    formats: 'форматы', roles: 'цели ОВП'};
  const choiceList = (state, kind) => {
    const list = state.inputs.vocabulary?.[kind] || state.mentorVocabulary?.[kind];
    return Array.isArray(list) && list.length ? list : null;
  };
  const choiceName = (kind, item) => (kind === 'roles' ? OVP_LABEL[item.id] : '') || item.label || item.id;
  const choiceIds = (value) => (Array.isArray(value) ? value : []);
  // Короткая сводка выбора: «все подходящие…», «только …» или «выбраны все: …». Никогда не «0 разрешено».
  function choiceText(list, kind, selected) {
    const ids = choiceIds(selected);
    if (!ids.length) return CHOICES[kind].all;
    const names = (list || []).filter((item) => ids.includes(item.id)).map((item) => choiceName(kind, item));
    return `${list && names.length === list.length ? 'выбраны все: ' : 'только '}${names.join(', ') || ids.join(', ')}`;
  }
  const shortsConflict = (inputs) => inputs.platforms.includes('youtube_shorts') && Number(inputs.perDay.youtube_shorts) > 0
    && choiceIds(inputs.formats).length > 0 && !choiceIds(inputs.formats).includes('reel');
  function choiceMarkup(state, kind, selected, dis) {
    const list = choiceList(state, kind), meta = CHOICES[kind], ids = choiceIds(selected), some = ids.length > 0;
    if (!list) return '';
    return `<div class="cf-field cf-choice" role="group" aria-labelledby="cf-${kind}-title" data-cf-choice="${kind}" tabindex="-1">
      <div class="cf-label-row"><span id="cf-${kind}-title">${esc(meta.title)}</span>${hint(kind)}</div>
      <div class="cf-choice-modes">
        <label class="cf-check"><input type="radio" name="${kind}-mode" value="all"${some ? '' : ' checked'}${dis}>Все подходящие</label>
        <label class="cf-check"><input type="radio" name="${kind}-mode" value="some"${some ? ' checked' : ''}${dis}>Только выбранные</label></div>
      <div class="cf-choice-list" data-cf-choice-list="${kind}"${some ? '' : ' hidden'}>${list.map((item) =>
        `<label class="cf-check"><input type="checkbox" name="${meta.item}" value="${esc(item.id)}"${ids.includes(item.id) ? ' checked' : ''}${dis}>${esc(choiceName(kind, item))}</label>`).join('')}</div>
      <p class="cf-note cf-choice-summary" data-cf-choice-summary="${kind}"></p>
      <p class="cf-error" data-cf-choice-error="${kind}" role="alert" hidden></p></div>`;
  }
  function monthMarkup(state, data, edit) {
    const dis = edit ? '' : ' disabled', inputs = data.inputs;
    const platforms = state.inputs.vocabulary.platforms.map((item) => {
      const on = inputs.platforms.includes(item.id), count = inputs.perDay[item.id] ?? 1;
      return `<div class="cf-platform"><label class="cf-check"><input type="checkbox" name="platform" value="${esc(item.id)}"${on ? ' checked' : ''}${dis}>${esc(item.label)}</label>
        <label>в день <select name="perDay-${esc(item.id)}"${dis}>${[0, 1, 2, 3].map((n) => `<option value="${n}"${n === count ? ' selected' : ''}>${n}</option>`).join('')}</select></label></div>`;
    }).join('');
    const events = inputs.events.map((item) => eventRow(item, dis)).join('');
    const choices = choiceMarkup(state, 'formats', inputs.formats, dis) + choiceMarkup(state, 'roles', inputs.roles, dis);
    return `<form id="cf-month-form" class="cf-form" data-month="${esc(data.month)}" data-days="${data.daysInMonth}" novalidate>
      ${field('priorities', 'Приоритетные товары и услуги', `<textarea id="cf-priorities" name="priorities" rows="2"${dis}>${esc(inputs.priorities.join('\n'))}</textarea>`)}
      <div class="cf-field"><div class="cf-label-row"><span>События и акции</span>${hint('events')}</div>
        <div data-cf-events>${events}</div>${edit ? '<button class="plain-button" type="button" data-cf-add-event>Добавить событие</button>' : ''}</div>
      ${field('excluded', 'Дни без публикаций', `<input id="cf-excluded" name="excluded" inputmode="numeric" value="${esc(inputs.excludedDays.map((day) => Number(day.slice(8))).join(', '))}"${dis}>`)}
      <p class="cf-error" id="cf-excluded-error" role="alert" hidden></p>
      <div class="cf-field" data-cf-choice="platforms" tabindex="-1"><div class="cf-label-row"><span>Площадки и объём</span>${hint('platforms')}</div><div class="cf-platforms">${platforms}</div></div>
      <p class="cf-total" id="cf-month-total" role="status"></p>
      ${choices ? `<div class="cf-choices">${choices}</div>
      <p class="cf-warning" data-cf-shorts-warning hidden>Для YouTube Shorts нужен формат «Reels / Shorts / клип». Добавьте его в выбранные форматы, выберите «Все подходящие» или уберите объём YouTube Shorts — иначе план попросит уточнение.</p>
      <p class="cf-note">Форматы и цели влияют только на следующие составления плана. Уже созданные предложения и публикации не меняются.</p>` : ''}
      ${edit ? '<div class="cf-actions"><button class="plain-button" type="submit">Сохранить пожелания месяца</button>' : ''}
      <span id="cf-month-state" class="cf-note" role="status"></span>${edit ? '</div>' : ''}
    </form>`;
  }
  function eventRow(item = {title: '', date: '', conditions: '', confirmed: false}, dis = '') {
    return `<fieldset class="cf-event" data-cf-event><legend>Событие</legend>
      <label>Название<input name="eventTitle" maxlength="300" value="${esc(item.title)}"${dis}></label>
      <label>Дата (необязательно)<input name="eventDate" type="date" value="${esc(item.date)}"${dis}></label>
      <label>Условия<input name="eventConditions" maxlength="1000" value="${esc(item.conditions)}"${dis}></label>
      <label class="cf-check"><input type="checkbox" name="eventConfirmed"${item.confirmed ? ' checked' : ''}${dis}>Условия подтверждены</label>
      ${dis ? '' : '<button class="plain-button" type="button" data-cf-remove-event aria-label="Удалить событие">Удалить событие</button>'}</fieldset>`;
  }
  function readMonth(form) {
    const month = form.dataset.month, days = Number(form.dataset.days);
    const raw = form.elements.excluded.value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
    const bad = raw.filter((item) => !/^\d{1,2}$/.test(item) || Number(item) < 1 || Number(item) > days);
    const excludedDays = [...new Set(raw.filter((item) => !bad.includes(item)).map((item) => `${month}-${String(Number(item)).padStart(2, '0')}`))].sort();
    const platforms = [...form.querySelectorAll('[name="platform"]:checked')].map((node) => node.value);
    const perDay = Object.fromEntries(platforms.map((id) => [id, Number(form.querySelector(`[name="perDay-${id}"]`).value)]));
    const events = [...form.querySelectorAll('[data-cf-event]')].map((row) => ({title: row.querySelector('[name="eventTitle"]').value.trim(),
      date: row.querySelector('[name="eventDate"]').value, conditions: row.querySelector('[name="eventConditions"]').value.trim(),
      confirmed: row.querySelector('[name="eventConfirmed"]').checked})).filter((item) => item.title || item.conditions || item.date);
    const inputs = {priorities: lines(form.elements.priorities.value), events, excludedDays, platforms, perDay}, emptyChoices = [];
    // Группа есть только при словаре с сервера; без неё поле не отправляется и сохранённое значение не меняется.
    for (const kind of Object.keys(CHOICES)) {
      const some = form.querySelector(`[name="${kind}-mode"][value="some"]`);
      if (!some) continue;
      inputs[kind] = some.checked ? [...form.querySelectorAll(`[name="${CHOICES[kind].item}"]:checked`)].map((node) => node.value) : [];
      if (some.checked && !inputs[kind].length) emptyChoices.push(kind);
    }
    return {bad, days, emptyChoices, inputs};
  }
  // Сохранённые пожелания месяца в виде, сравнимом с формой: у старого месяца форматов и целей нет — это [].
  const savedMonth = (inputs) => ({...inputs, formats: choiceIds(inputs.formats), roles: choiceIds(inputs.roles)});
  function monthTotal(form, state) {
    const {inputs, days, bad, emptyChoices} = readMonth(form);
    const per = inputs.platforms.reduce((sum, id) => sum + inputs.perDay[id], 0);
    form.querySelector('#cf-month-total').textContent = bad.length ? 'Итог появится после исправления дней без публикаций.'
      : per ? `Итого за месяц: ${(days - inputs.excludedDays.length) * per} публикаций (${days - inputs.excludedDays.length} дн. × ${per} в день). Это объём для будущего плана, публикации не создаются.`
        : 'Выберите площадки и объём, чтобы увидеть итог.';
    const saved = state?.month ? savedMonth(state.month.inputs) : null;
    for (const kind of Object.keys(CHOICES)) {
      const summary = form.querySelector(`[data-cf-choice-summary="${kind}"]`);
      if (!summary) continue;
      const some = form.querySelector(`[name="${kind}-mode"][value="some"]`).checked;
      form.querySelector(`[data-cf-choice-list="${kind}"]`).hidden = !some;
      const pending = saved && !same(inputs[kind], saved[kind]) ? ' — не сохранено' : '';
      summary.textContent = emptyChoices.includes(kind) ? CHOICES[kind].none : `Сейчас: ${choiceText(choiceList(state, kind), kind, inputs[kind])}${pending}.`;
      if (!emptyChoices.includes(kind)) { const error = form.querySelector(`[data-cf-choice-error="${kind}"]`); error.hidden = true; error.textContent = ''; }
    }
    const warning = form.querySelector('[data-cf-shorts-warning]');
    if (warning) warning.hidden = !shortsConflict(inputs);
  }
  // Переход из вопроса плана: нужная группа подсвечивается и получает фокус. Ничего не сохраняется и не запускается.
  function applyFocus(box, focus) {
    const group = box.querySelector(`[data-cf-choice="${focus.field}"]`);
    if (!group) return false;
    group.classList.add('cf-focus');
    group.scrollIntoView?.({block: 'center'});
    const control = group.querySelector('input:checked:not([disabled])') || group.querySelector('input:not([disabled])') || group;
    control.focus?.({preventScroll: true});
    const state = box.querySelector('#cf-month-state');
    const what = {formats: 'форматы', roles: 'цели ОВП', platforms: 'площадки и объём'}[focus.field];
    if (state) state.textContent = `Уточните ${what} месяца и сохраните. План не составляется автоматически — после сохранения нажмите «Составить план» в Контент-плане.`;
    return true;
  }
  function drawMonth(node, ctx, state, epoch, month, inputs) {
    const box = node.querySelector('[data-cf-month-body]');
    box.innerHTML = monthMarkup(state, {...state.month, inputs}, canEdit(ctx));
    bindHints(box);
    const form = box.querySelector('#cf-month-form');
    monthTotal(form, state);
    form.addEventListener('input', () => monthTotal(form, state));
    form.addEventListener('change', () => monthTotal(form, state));
    box.querySelector('[data-cf-add-event]')?.addEventListener('click', () => {
      box.querySelector('[data-cf-events]').insertAdjacentHTML('beforeend', eventRow());
    });
    // Удаление события — явной кнопкой; в сохранённые пожелания уходит при «Сохранить пожелания месяца».
    box.querySelector('[data-cf-events]').addEventListener('click', (event) => {
      const remove = event.target.closest('[data-cf-remove-event]');
      if (!remove) return;
      remove.closest('[data-cf-event]').remove();
      monthTotal(form, state);
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!canEdit(ctx) || form.dataset.busy) return;
      const status = form.querySelector('#cf-month-state'), error = form.querySelector('#cf-excluded-error'), read = readMonth(form);
      error.textContent = read.bad.length ? `Нет такого числа в месяце: ${read.bad.join(', ')}.` : '';
      error.hidden = !read.bad.length;
      if (read.bad.length) { status.textContent = 'Исправьте дни без публикаций.'; return; }
      if (read.inputs.events.some((item) => !item.title)) { status.textContent = 'У события нужно название.'; return; }
      if (read.emptyChoices.length) {
        for (const kind of read.emptyChoices) { const note = form.querySelector(`[data-cf-choice-error="${kind}"]`); note.textContent = CHOICES[kind].none; note.hidden = false; }
        status.textContent = 'Ничего не сохранено: в группе «Только выбранные» не отмечено ни одного значения.';
        form.querySelector(`[data-cf-choice="${read.emptyChoices[0]}"] input[type="radio"][value="some"]`)?.focus?.();
        return;
      }
      const before = savedMonth(state.month.inputs);
      const patch = changed(read.inputs, before);
      if (!Object.keys(patch).length) { status.textContent = 'Изменений нет.'; return; }
      status.textContent = 'Сохраняем…'; form.dataset.busy = 'true';
      try {
        const saved = await ctx.crmQuery(`/media-mentor/inputs/months/${encodeURIComponent(month)}`, {companyCode: state.code},
          ctx.csrfOptions('PUT', {revision: state.month.revision, inputs: read.inputs}));
        if (epoch !== settings.monthEpoch || state !== settings.state) return;
        if (!saved || saved.companyCode !== state.code || saved.month !== month) throw Object.assign(new Error('Ответ другой компании или месяца'), {scope: true});
        state.month = saved;
        status.textContent = 'Сохранено. Постоянные вводные не изменены; выбор влияет на следующие составления плана.';
        monthTotal(form, state);
      } catch (failure) {
        if (epoch !== settings.monthEpoch || state !== settings.state) return;
        if (failure.status !== 409) {
          status.textContent = failure.scope ? 'Ответ сервера не подходит к этой компании или месяцу. Обновите страницу.' : `Не удалось сохранить: ${failure.message}. Ввод остался в форме.`;
          return;
        }
        // Перечитываем месяц: поля, которые вы не трогали, берутся из свежей версии; ваш ввод не теряется.
        try {
          const fresh = await ctx.crmQuery(`/media-mentor/inputs/months/${encodeURIComponent(month)}`, {companyCode: state.code});
          if (epoch !== settings.monthEpoch || state !== settings.state) return;
          if (!fresh || fresh.companyCode !== state.code || fresh.month !== month) throw new Error('ответ другой компании или месяца');
          const now = savedMonth(fresh.inputs), merged = {...now}, conflicts = [];
          for (const key of Object.keys(read.inputs)) {
            if (same(read.inputs[key], before[key])) continue;
            merged[key] = read.inputs[key];
            if (!same(now[key], before[key]) && !same(now[key], read.inputs[key])) conflicts.push(MONTH_NAMES[key] || key);
          }
          state.month = fresh;
          drawMonth(node, ctx, state, epoch, month, merged);
          node.querySelector('#cf-month-state').textContent = `Пожелания месяца уже изменили в другом окне: загружена версия ${fresh.revision}. Ваш ввод сохранён на экране, остальное обновлено из неё.` +
            `${conflicts.length ? ` В другом окне тоже меняли: ${conflicts.join(', ')} — оставлен ваш вариант, проверьте.` : ''} Нажмите «Сохранить пожелания месяца» ещё раз.`;
        } catch (refresh) {
          if (epoch === settings.monthEpoch && state === settings.state) status.textContent = `Пожелания уже изменили в другом окне, свежую версию загрузить не удалось (${refresh.message}). Ввод остался в форме; обновите страницу.`;
        }
      } finally {
        delete form.dataset.busy;
      }
    });
    return box;
  }
  async function loadMonth(node, ctx, month) {
    const state = settings.state, epoch = ++settings.monthEpoch, code = state.code, box = node.querySelector('[data-cf-month-body]');
    box.innerHTML = '<p class="cf-note">Загружаем пожелания месяца…</p>';
    try {
      const data = await ctx.crmQuery(`/media-mentor/inputs/months/${encodeURIComponent(month)}`, {companyCode: code});
      if (epoch !== settings.monthEpoch || state !== settings.state || data.companyCode !== code || data.month !== month) return;
      state.month = data;
      drawMonth(node, ctx, state, epoch, month, savedMonth(data.inputs));
      const focus = settings.focus;
      if (focus && focus.code === code && focus.month === month) { settings.focus = null; applyFocus(box, focus); }
    } catch (error) {
      if (epoch === settings.monthEpoch) box.innerHTML = `<p class="crm-error" role="alert">Не удалось загрузить пожелания месяца: ${esc(error.message)}</p>`;
    }
  }
  /* Состояние площадки — только по полям DTO настроек автопостинга (ops/crm/autoposting-transport.js getSettings):
     target, tokenConfigured, status (not_configured | needs_check | connected | error), connected, enabled, checkedAt.
     Строка приходит для каждой площадки, даже ненастроенной, поэтому connected=false сам по себе ничего не говорит об аккаунте. */
  function checkedText(value, timezone) {
    if (!value || Number.isNaN(Date.parse(value))) return '';
    const options = {day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'};
    try { return new Date(value).toLocaleString('ru-RU', {...options, ...(timezone ? {timeZone: timezone} : {})}); }
    catch { return new Date(value).toLocaleString('ru-RU', options); }
  }
  function channelState(channel, timezone) {
    if (!channel) return 'Нужно подключить';
    const target = String(channel.target || '').trim(), at = checkedText(channel.checkedAt, timezone);
    if (!target && !channel.tokenConfigured) return 'Нужно подключить';
    if (!target) return 'Аккаунт не указан';
    if (!channel.tokenConfigured) return 'Аккаунт указан, ключ доступа не задан';
    if (channel.status === 'error') return `Требует внимания: проверка подключения не прошла${at ? ` · проверка ${at}` : ''}`;
    if (!channel.connected) return 'Аккаунт указан, подключение не проверено';
    if (!channel.enabled) return `Подключение проверено, отправка выключена${at ? ` · проверка ${at}` : ''}`;
    return `Подключение проверено${at ? ` · проверка ${at}` : ''}`;
  }
  function channelsMarkup(state) {
    if (!state.channels) return '<p class="cf-note">Состояние площадок не загрузилось. Подключённость не предполагается.</p>';
    const list = state.inputs.vocabulary.platforms.map((item) => {
      const channel = state.channels.find((row) => row.id === item.id || row.platform === item.id);
      return `<li><strong>${esc(item.label)}</strong> — ${esc(channelState(channel, state.channelsTimezone || state.inputs.timezone))}</li>`;
    }).join('');
    return `<ul class="cf-list">${list}</ul>
      <p class="cf-note">«Проверка» — время последней проверки доступа из кабинета; после неё доступ мог измениться. Ссылка на аккаунт сама по себе не означает подключение.</p>
      <p class="cf-note">Управление ключами и проверка доступа пока находятся во вкладке <a href="#content-factory/plan">Контент-план</a> → «Подключения и подготовка материалов».</p>`;
  }
  /* CF23: «Подготовка и выпуск» — сохранённый выбор компании (GET/PUT /media-mentor/workflow). Первая загрузка ничего не пишет;
     значение по умолчанию manual при configured=false выбором не считается. Форма не перерисовывается при сохранении —
     ввод остаётся, пока сервер не подтвердил запись. */
  const WORKFLOW_UNAVAILABLE = new Set([404, 405, 501]);
  const HOUR_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const workflowFields = (dto) => (dto && dto.fields && typeof dto.fields === 'object' ? dto.fields : {});
  const workflowValid = (dto, code) => Boolean(dto && dto.companyCode === code && Number.isSafeInteger(dto.revision) && dto.revision >= 0
    && typeof dto.configured === 'boolean' && dto.fields && typeof dto.fields === 'object' && ['manual', 'scheduled'].includes(dto.fields.releaseMode)
    && Array.isArray(dto.fields.hours));
  const MODE_TEXT = {manual: 'ручной выпуск', scheduled: 'по расписанию'};
  function workflowSummary(dto) {
    const f = workflowFields(dto);
    if (!dto.configured) return 'режим ещё не выбран';
    return `${MODE_TEXT[f.releaseMode] || f.releaseMode}; часы: ${f.hours?.length ? f.hours.join(', ') : 'не указаны'}; подготовка — ${f.preparationDays} дн., согласование — ${f.reviewDays} дн.; выпускает: ${f.publisherName || 'не указано'}`;
  }
  function workflowMarkup(state, edit) {
    const wf = state.workflow;
    if (!wf || wf.unavailable) return '<p class="cf-note" data-cf-workflow-state>Настройки выпуска на сервере пока не подключены. Время и отправка задаются в каждой карточке, как раньше.</p>';
    if (wf.error) return `<p class="crm-error" role="alert" data-cf-workflow-state>Настройки выпуска не загрузились: ${esc(wf.error)}. Ничего не изменено.</p>`;
    const dto = wf.dto, f = workflowFields(dto), dis = edit ? '' : ' disabled';
    const mode = (id, text) => `<label class="cf-check"><input type="radio" name="releaseMode" value="${id}"${dto.configured && f.releaseMode === id ? ' checked' : ''}${dis}>${esc(text)}</label>`;
    const err = (id) => `<p class="cf-error" data-cf-workflow-error="${id}" role="alert" hidden></p>`;
    return `<form id="cf-workflow-form" class="cf-form" data-cf-workflow novalidate>
      <p class="cf-note" data-cf-workflow-state>${dto.configured ? `Сохранено: версия ${esc(dto.revision)}.` : 'Режим ещё не выбран — сохранённых настроек выпуска нет. До сохранения всё работает как раньше: время и отправка задаются в каждой карточке.'}</p>
      <fieldset class="cf-field cf-mode"><legend class="cf-label-row">Режим выпуска ${hint('releaseMode')}</legend>
        ${mode('manual', 'Ручной выпуск')}${mode('scheduled', 'По расписанию')}${err('releaseMode')}</fieldset>
      ${field('hours', 'Часы публикаций (местное время проекта)', `<input id="cf-hours" name="hours" value="${esc((f.hours || []).join(', '))}" placeholder="10:00, 18:30" autocomplete="off"${dis}>`)}${err('hours')}
      <div class="cf-daily-controls">${field('preparationDays', 'Дни на подготовку', `<input id="cf-preparationDays" name="preparationDays" type="number" min="0" max="30" step="1" inputmode="numeric" value="${esc(f.preparationDays ?? 0)}"${dis}>`)}
        ${field('reviewDays', 'Дни на согласование', `<input id="cf-reviewDays" name="reviewDays" type="number" min="0" max="30" step="1" inputmode="numeric" value="${esc(f.reviewDays ?? 0)}"${dis}>`)}</div>${err('preparationDays')}${err('reviewDays')}
      ${field('publisherName', 'Кто выпускает (имя)', `<input id="cf-publisherName" name="publisherName" maxlength="200" value="${esc(f.publisherName || '')}" autocomplete="off"${dis}>`)}${err('publisherName')}
      <div class="cf-field"><div class="cf-label-row"><span>Кто согласует</span>${hint('approver')}</div><p data-cf-workflow-approver>Владелец кабинета <span class="cf-note">(только для чтения)</span></p></div>
      <ul class="cf-list cf-note" data-cf-workflow-notes><li>Режим действует на новые назначения; уже стоящую очередь не отменяет.</li>
        <li>«По расписанию» лишь позволяет отдельно поставить согласованный материал в план — сам расписание не создаёт и генерацию не запускает.</li>
        <li>Часы и дни передаются в новые задания плана как пожелания; это не обещанные даты готовности.</li>
        <li>«Кто выпускает» — указанное имя, не подключённый аккаунт и не назначенная задача.</li></ul>
      ${edit ? '<div class="cf-actions"><button class="primary" type="submit" data-cf-workflow-save>Сохранить подготовку и выпуск</button><button class="plain-button" type="button" data-cf-workflow-check hidden>Проверить, что сохранилось</button></div>'
        : '<p class="cf-note">Изменить может участник с правом «Автопостинг: правка».</p>'}
      <p class="cf-note" data-cf-workflow-status role="status"></p></form>`;
  }
  function planningMarkup(state, edit) {
    const zone = state.inputs.timezone;
    return `<ul class="cf-list"><li>Часовой пояс проекта: ${zone ? `${esc(zone)} <span class="cf-note">(меняется в <a href="#company-information">«Актуальность» → «Часовой пояс»</a>)</span>` : 'не задан — укажите его в <a href="#company-information">«Актуальность» → «Часовой пояс»</a>'}.</li>
      <li>Согласование не включает автоматическую публикацию: время и отправка задаются отдельно для каждой карточки.</li></ul>
      ${workflowMarkup(state, edit)}`;
  }
  // Чтение формы и проверка до запроса; ошибки — рядом с полем.
  function readWorkflow(form, dto) {
    const errors = {}, mode = form.querySelector('[name="releaseMode"]:checked')?.value || '';
    if (!['manual', 'scheduled'].includes(mode)) errors.releaseMode = dto.configured ? 'Выберите режим выпуска.' : 'Выберите режим выпуска: первое сохранение фиксирует ваш выбор.';
    const hours = form.elements.hours.value.split(/[\s,;]+/).filter(Boolean);
    const badHour = hours.find((item) => !HOUR_RE.test(item));
    if (badHour) errors.hours = `«${badHour}» — укажите время как ЧЧ:ММ, например 09:00 или 18:30.`;
    else if (new Set(hours).size !== hours.length) errors.hours = 'Часы повторяются — оставьте каждый один раз.';
    else if (hours.length > 24) errors.hours = 'Не больше 24 разных часов.';
    const day = (name) => {
      const raw = String(form.elements[name].value).trim(), value = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value > 30) { errors[name] = 'Целое число дней от 0 до 30.'; return null; }
      return value;
    };
    const preparationDays = day('preparationDays'), reviewDays = day('reviewDays');
    const publisherName = form.elements.publisherName.value.trim();
    if (publisherName.length > 200) errors.publisherName = 'Не больше 200 символов.';
    return {errors, fields: {releaseMode: mode, publisherName, hours: [...hours].sort(), preparationDays, reviewDays}};
  }
  const sameWorkflow = (dto, fields) => Boolean(dto?.configured) && ['releaseMode', 'publisherName', 'preparationDays', 'reviewDays']
    .every((key) => dto.fields[key] === fields[key]) && JSON.stringify([...(dto.fields.hours || [])].sort()) === JSON.stringify(fields.hours);
  function bindWorkflow(node, ctx, state) {
    const form = node.querySelector('[data-cf-workflow]');
    if (!form || !canEdit(ctx)) return;
    const wf = state.workflow, status = form.querySelector('[data-cf-workflow-status]'), check = form.querySelector('[data-cf-workflow-check]');
    const save = form.querySelector('[data-cf-workflow-save]'), stateLine = form.querySelector('[data-cf-workflow-state]');
    const live = () => settings.state === state && form.isConnected;
    const showErrors = (errors) => form.querySelectorAll('[data-cf-workflow-error]').forEach((p) => {
      const text = errors[p.dataset.cfWorkflowError] || ''; p.textContent = text; p.hidden = !text;
    });
    // Сохранённое сервером — в строку состояния; поля формы при ошибке не трогаем.
    const accept = (dto) => {
      wf.dto = dto; const f = dto.fields;
      form.querySelectorAll('[name="releaseMode"]').forEach((input) => { input.checked = dto.configured && input.value === f.releaseMode; });
      form.elements.hours.value = (f.hours || []).join(', '); form.elements.preparationDays.value = f.preparationDays;
      form.elements.reviewDays.value = f.reviewDays; form.elements.publisherName.value = f.publisherName || '';
      stateLine.textContent = `Сохранено: версия ${dto.revision}.`;
    };
    const fetchSaved = async () => {
      const dto = await ctx.crmQuery('/media-mentor/workflow', {companyCode: state.code});
      if (!workflowValid(dto, state.code)) throw new Error('Ответ не относится к этой компании');
      return dto;
    };
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (wf.saving || !live()) return;
      const {errors, fields} = readWorkflow(form, wf.dto);
      showErrors(errors);
      if (Object.keys(errors).length) { status.textContent = 'Проверьте отмеченные поля. Ничего не отправлено.'; return; }
      const revision = wf.dto.revision;
      wf.saving = true; save.disabled = true; check.hidden = true; wf.intended = fields; status.textContent = 'Сохраняем…';
      try {
        const dto = await ctx.crmQuery('/media-mentor/workflow', {companyCode: state.code}, ctx.csrfOptions('PUT', {revision, fields}));
        if (!live()) return;
        if (!workflowValid(dto, state.code) || dto.configured !== true || dto.revision < revision) {
          check.hidden = false;
          status.textContent = 'Ответ сервера не подтвердил сохранение. Ввод остаётся в форме; «Проверить, что сохранилось» перечитает сохранённые настройки.';
          return;
        }
        const noop = dto.revision === revision;
        accept(dto); wf.intended = null;
        status.textContent = noop ? `Изменений нет — действует сохранённая версия ${dto.revision}.`
          : `Сохранено: версия ${dto.revision}. Действует для новых назначений; очередь, расписание и генерация не изменены.`;
      } catch (error) {
        if (!live()) return;
        if (error.status === 409) {
          let fresh = null;
          try { fresh = await fetchSaved(); } catch {}
          if (!live()) return;
          if (fresh) { wf.dto = fresh; stateLine.textContent = `На сервере сейчас версия ${fresh.revision}: ${workflowSummary(fresh)}.`; }
          status.textContent = fresh ? `Настройки уже изменили в другом окне (версия ${fresh.revision}). Ваш ввод не сохранён и остаётся в форме. Проверьте и нажмите «Сохранить» ещё раз — запись пойдёт поверх версии ${fresh.revision}.`
            : 'Настройки уже изменили в другом окне, а свежую версию прочитать не удалось. Ваш ввод не сохранён и остаётся в форме; обновите страницу позже.';
        } else if (error.status === 400) status.textContent = `Сервер не принял настройки: ${error.message}. Ничего не сохранено; ввод остаётся в форме.`;
        else if (error.status === 403) status.textContent = 'Недостаточно прав для изменения настроек выпуска. Ничего не сохранено.';
        else if (WORKFLOW_UNAVAILABLE.has(error.status)) status.textContent = 'Сохранение настроек выпуска на сервере пока не подключено. Ничего не сохранено.';
        else { check.hidden = false; status.textContent = `Ответ сервера не получен (${error.message}). Настройки могли сохраниться. Ввод остаётся в форме; «Проверить, что сохранилось» перечитает сохранённое.`; }
      } finally {
        if (live()) { wf.saving = false; save.disabled = false; }
      }
    });
    check.addEventListener('click', async () => {
      if (wf.saving || !live()) return;
      check.disabled = true; status.textContent = 'Перечитываем сохранённые настройки…';
      try {
        const dto = await fetchSaved();
        if (!live()) return;
        if (wf.intended && sameWorkflow(dto, wf.intended)) { accept(dto); wf.intended = null; check.hidden = true; status.textContent = `Подтверждено перечитыванием: сохранено, версия ${dto.revision}.`; }
        else { wf.dto = dto; stateLine.textContent = `На сервере сейчас версия ${dto.revision}: ${workflowSummary(dto)}.`;
          status.textContent = `Ваш ввод не сохранён — на сервере версия ${dto.revision} с другими значениями. Ввод остаётся в форме; нажмите «Сохранить» ещё раз.`; }
      } catch (error) {
        if (live()) status.textContent = `Перечитать не удалось (${error.message}). Ввод остаётся в форме.`;
      } finally { if (live()) check.disabled = false; }
    });
  }
  async function loadSettings(container, ctx) {
    const epoch = ++settings.epoch, code = String(ctx.selectedProjectId || '').toLowerCase(), node = container.querySelector('[data-cf-settings]');
    if (!node) return;
    try {
      const [mentor, inputs, autoposting, workflow] = await Promise.all([
        ctx.crmQuery('/media-mentor', {companyCode: code}),
        ctx.crmQuery('/media-mentor/inputs', {companyCode: code}),
        ctx.crmQuery('/autoposting/settings', {companyCode: code}).catch(() => null),
        ctx.crmQuery('/media-mentor/workflow', {companyCode: code}).then((dto) => ({dto}), (error) => ({error}))]);
      // Ответ прежней компании не рисуется: вводные компаний не смешиваются.
      if (epoch !== settings.epoch || !node.isConnected) return;
      if (mentor.companyCode !== code || inputs.companyCode !== code) throw new Error('Ответ другой компании');
      const state = {code, brief: mentor.brief, inputs, mentorVocabulary: mentor.vocabulary || null,
        channels: Array.isArray(autoposting?.channels) && autoposting.companyCode === code ? autoposting.channels : null,
        channelsTimezone: typeof autoposting?.timezone === 'string' ? autoposting.timezone : '', month: null,
        workflow: workflow.error ? (WORKFLOW_UNAVAILABLE.has(workflow.error.status) ? {unavailable: true} : {error: workflow.error.message || 'ошибка запроса'})
          : workflowValid(workflow.dto, code) ? {dto: workflow.dto, saving: false, intended: null} : {error: 'ответ не относится к этой компании'}};
      // Переход из вопроса плана относится к компании, где его нажали; для другой компании не применяется.
      if (settings.focus && settings.focus.code !== code) settings.focus = null;
      settings.state = state;
      const edit = canEdit(ctx);
      node.innerHTML = `<section class="card" data-cf-section="business"><h3>О бизнесе и покупателях</h3>
          <p class="cf-note">Коротко о главном. Обязательны продукт, ситуация покупателя и аудитория; остальное можно оставить неизвестным.</p>
          ${businessMarkup({...state, brief: mentor.brief, inputs, code}, edit)}</section>
        <section class="card" data-cf-section="month"><h3>Пожелания на месяц</h3>
          ${field('month', 'Месяц', `<input id="cf-month" type="month" value="${esc(settings.focus?.month || monthNow(inputs.timezone))}">`)}
          <div data-cf-month-body></div></section>
        <details class="card" data-cf-section="channels"><summary>Площадки и обращения</summary>${channelsMarkup(state)}</details>
        <details class="card" data-cf-section="planning"><summary>Подготовка и выпуск</summary>${planningMarkup(state, edit)}</details>`;
      bindHints(node);
      bindBusiness(node, ctx);
      bindWorkflow(node, ctx, state);
      const month = node.querySelector('#cf-month');
      month.addEventListener('change', () => { if (/^\d{4}-\d{2}$/.test(month.value)) void loadMonth(node, ctx, month.value); });
      await loadMonth(node, ctx, month.value);
    } catch (error) {
      if (epoch === settings.epoch && node.isConnected) node.innerHTML = `<p class="crm-error" role="alert">Не удалось загрузить настройки модуля: ${esc(error.message)}</p>`;
    }
  }
  /* CF7: адрес вопроса плана — #content-factory/settings?month=ГГГГ-ММ&focus=formats. Параметры читаются один раз
     и убираются из адреса, чтобы повторная отрисовка (например, смена компании) не подсвечивала группу снова. */
  const FOCUS_FIELDS = new Set(['formats', 'roles', 'platforms']);
  function takeFocus(ctx) {
    const hash = window.location.hash, query = hash.includes('?') ? new URLSearchParams(hash.slice(hash.indexOf('?') + 1)) : null;
    if (!query || !/^#content-factory\/settings\?/.test(hash)) return;
    const month = query.get('month') || '', field = query.get('focus') || '';
    window.history.replaceState(null, '', '#content-factory/settings');
    const code = String(ctx.selectedProjectId || '').toLowerCase();
    if (/^\d{4}-\d{2}$/.test(month) && FOCUS_FIELDS.has(field) && (!query.get('company') || query.get('company') === code)) settings.focus = {code, month, field};
  }
  function renderSettings(container, ctx) {
    takeFocus(ctx);
    if (!canRead(ctx)) { container.innerHTML = '<div class="card"><p>Настройки контент-завода доступны по праву «Автопостинг: просмотр».</p></div>'; return; }
    container.innerHTML = `<div class="content-header"><h2>Настройки модуля</h2>
      <p>Вводные о бизнесе и покупателях, пожелания месяца, площадки и порядок согласования. Изменения влияют на следующие предложения и не переписывают сохранённые публикации.</p></div>
      <div data-cf-settings aria-live="polite"><p>Загружаем настройки…</p></div>`;
    void loadSettings(container, ctx);
  }

  /* ---------- Статистика ---------- */
  const stats = {epoch: 0, code: '', month: '', filter: {platform: '', format: '', role: ''}, calendar: null, social: null, socialState: ''};
  /* CF19: общие фильтры статистики. Формат и цель берутся только из явных полей: календарь — meta.format/role карточки,
     публикации — crm.posts[].format/ovpRole (nullable, однозначная связь). Отсутствует или иное — неизвестно. */
  const STAT_FORMATS = [['post', 'Пост'], ['story', 'Сторис'], ['reel', 'Reels / Shorts / клип'], ['carousel', 'Карусель']];
  const STAT_ROLES = [['reach', 'Охват'], ['affection', 'Влюбление'], ['sale', 'Продажи']];
  const known = (list, value) => (list.some(([id]) => id === value) ? value : null);
  const filterCount = () => Object.values(stats.filter).filter(Boolean).length;
  /* Подписи повторяют фактическую семантику источников (сверено тестом ops/crm/content-factory-stats-contract.test.js):
     календарь — дата карточки (расписание или план) в поясе компании; соцсети — дневные снимки в поясе каждого аккаунта;
     заявки — created_at сутками UTC; реестр публикаций attribution — последние до 200 известных, без фильтра по месяцу. */
  /* R2: в карточке — показатель, значение и короткое необходимое уточнение; полная методика — в закрытом «Как считаем». */
  const METRICS = [['published', 'Опубликовано', 'по дате карточки, не по факту выхода', 'Пары «карточка × площадка» с отметкой «опубликовано», у которых дата карточки (расписание или план) попадает в месяц по поясу календаря{tz}. Это не фактическое время выхода.'],
    ['views', 'Просмотры', 'не уникальный охват', 'Сумма дневных просмотров площадок; дни считаются по дням каждого аккаунта в его поясе. Просмотры не равны уникальному охвату: один человек может быть учтён несколько раз.'],
    ['clicks', 'Переходы', 'где площадка их отдаёт', 'Сумма дневных переходов по ссылке там, где площадка их отдаёт; дни — по поясу аккаунта.'],
    ['leads', 'Заявки', 'связанные с публикациями', 'Заявки, созданные с 1 по последнее число месяца по UTC и связанные с известной публикацией по ссылке или метке; публикация могла выйти раньше месяца. Все заявки проекта — в «Сквозной аналитике».']];
  const utcDay = (value) => { const ms = Date.parse(String(value || '')); return Number.isNaN(ms) ? '—' : new Date(ms).toISOString().slice(0, 10); };
  const metricNote = (note, timezone) => note.replace('{tz}', timezone ? ` (${timezone})` : '');
  const METHOD_EXTRA = [['posts', 'Таблица публикаций', 'Показываем до 200 последних известных публикаций компании — не только за выбранный месяц; на экране — первые 50. Дата выхода — по UTC. Заявки в таблице — за выбранный месяц.'],
    ['sources', 'Источники', 'Календарь материалов кабинета, статистика соцсетей и заявки CRM. У источников разные границы дня — они указаны выше. Нет данных — показываем словами, не нулём.']];
  /* CF29: период заявок CRM. Вкладка просит у сервера месяц по поясу проекта (crmPeriod=project). Подтверждённым считается
     только crm.period с основанием project, выбранными датами, действующим поясом и границами ровно по началу дня from и
     началу дня после to в этом поясе. Пояс — только из crm.period: timezone ответа, календарь и аккаунты его не подменяют.
     Нет ключа period — старый сервер: прежний месяц по UTC с пометкой. Неверный period — заявки не числом. */
  const shiftDay = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
  const zoneDay = (ms, zone) => {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date(ms));
    const get = (type) => parts.find((part) => part.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  };
  const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  function crmPeriodState(data, from, to) {
    const crm = data?.crm;
    if (!crm || typeof crm !== 'object' || !Object.hasOwn(crm, 'period')) return {state: 'legacy'};
    const period = crm.period;
    try {
      if (!period || typeof period !== 'object' || Array.isArray(period)) return {state: 'invalid'};
      if (period.basis !== 'project' || period.from !== from || period.to !== to) return {state: 'invalid'};
      const zone = period.timezone;
      if (typeof zone !== 'string' || !zone.trim() || !ISO_UTC.test(period.startInclusive) || !ISO_UTC.test(period.endExclusive)) return {state: 'invalid'};
      const start = Date.parse(period.startInclusive), end = Date.parse(period.endExclusive);
      if (!(start < end) || zoneDay(start, zone) !== from || zoneDay(start - 1, zone) !== shiftDay(from, -1)
        || zoneDay(end - 1, zone) !== to || zoneDay(end, zone) !== shiftDay(to, 1)) return {state: 'invalid'};
      return {state: 'project', period};
    } catch { return {state: 'invalid'}; } // неизвестный пояс: Intl бросает RangeError
  }
  const ruDate = (date) => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
  const utcMoment = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  function leadsMethod(period) {
    const p = period?.period;
    if (period?.state === 'project') return `Заявки, созданные с ${ruDate(p.from)} по ${ruDate(p.to)} включительно по поясу проекта ${p.timezone} (границы сервера: с ${utcMoment(p.startInclusive)} включительно до ${utcMoment(p.endExclusive)} не включительно) и связанные с известной публикацией по ссылке или метке; публикация могла выйти раньше месяца. Пояс проекта относится только к заявкам CRM: календарь считается по своему поясу, просмотры и переходы — по суткам аккаунтов. Все заявки проекта — в «Сквозной аналитике».`;
    if (period?.state === 'legacy') return `${METRICS[3][3]} Сервер не вернул период проекта: месяц для заявок — по UTC, пояс проекта не подтверждён.`;
    if (period?.state === 'invalid') return 'Сервер вернул период заявок, который не совпадает с выбранным месяцем или не проходит проверку (основание, даты, пояс, границы). Пока период не подтверждён, заявки не показываем числом; просмотры и переходы от этого не зависят. Все заявки проекта — в «Сквозной аналитике».';
    return 'Заявки за выбранный месяц, связанные с известной публикацией по ссылке или метке. Границы месяца для заявок называет сервер: по поясу проекта, у старой версии — по UTC.';
  }
  function periodLine(period) {
    const p = period?.period;
    if (period?.state === 'project') return `Заявки CRM — ${ruDate(p.from)}–${ruDate(p.to)} по поясу проекта ${p.timezone}; просмотры и переходы — по суткам аккаунтов.`;
    if (period?.state === 'legacy') return 'Заявки CRM — месяц по UTC: сервер не подтвердил пояс проекта.';
    if (period?.state === 'invalid') return 'Период заявок CRM не подтверждён — заявки не показываем числом.';
    return '';
  }
  const methodMarkup = () => `<details class="cf-method" id="cf-stats-method"><summary>Как считаем</summary><dl>
    ${[...METRICS.map(([id, label, , full]) => [id, label, id === 'leads' ? leadsMethod(null) : metricNote(full, '')]), ...METHOD_EXTRA].map(([id, label, text]) =>
      `<div><dt>${esc(label)}</dt><dd data-cf-method="${id}">${esc(text)}</dd></div>`).join('')}</dl></details>`;
  function setMetric(node, id, value) {
    const target = node.querySelector(`[data-cf-metric="${id}"] [data-cf-value]`);
    target.textContent = value;
    // Слова («Нет данных», «Нужно право…») — обычным размером, чтобы не рвать их по буквам.
    target.classList.toggle('cf-word', !/^[\d\s]+$/.test(value));
  }
  /* CF6: дневной график одной площадки и одного показателя. Источник — только platforms[p].days[date][metric]
     ({value, kind, completeness, provider}) активной системы суток аккаунта (activeInterval). totals, latest и
     lifetime не подставляются; нет записи, null или нераспознанная разметка — разрыв; подтверждённый 0 — точка «0». */
  const DAILY_METRICS = [['views', 'Просмотры'], ['link_clicks', 'Переходы по ссылке']];
  const KNOWN_KINDS = new Set(['organic', 'paid', 'mixed', 'unknown']);
  const KIND_NOTE = {paid: 'реклама', mixed: 'органика и реклама', unknown: 'разметка не указана'};
  const dayRu = (date) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;
  const datesBetween = (from, to) => { const out = []; for (let t = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); t <= end; t += 864e5) out.push(new Date(t).toISOString().slice(0, 10)); return out; };
  const todayIn = (zone) => { try { return new Intl.DateTimeFormat('en-CA', {timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date()); } catch { return new Date().toISOString().slice(0, 10); } };
  function dailySeries(platform, metric, from, to, zone) {
    const today = todayIn(zone), last = to < today ? to : today;
    if (last < from) return [];
    return datesBetween(from, last).map((date) => {
      const cell = platform?.days?.[date]?.[metric];
      if (!cell || typeof cell !== 'object') return {date, state: 'gap', reason: 'нет данных'};
      if (typeof cell.value !== 'number' || !Number.isFinite(cell.value)) return {date, state: 'gap', reason: 'нет значения'};
      if (!KNOWN_KINDS.has(cell.kind)) return {date, state: 'gap', reason: 'разметка не распознана'};
      const state = cell.completeness === 'complete' ? 'complete' : cell.completeness === 'partial' ? 'partial' : 'unknown';
      return {date, state, value: cell.value, kind: cell.kind, provider: cell.provider || ''};
    });
  }
  const pointWords = (point) => point.state === 'gap' ? point.reason : `${number(point.value)}${point.state === 'partial' ? ' · частично' : point.state === 'unknown' ? ' · полнота неизвестна' : ''}${KIND_NOTE[point.kind] ? ` · ${KIND_NOTE[point.kind]}` : ''}`;
  function renderDaily(node, data, month) {
    const box = node.querySelector('[data-cf-daily]'); if (!box) return;
    const chart = box.querySelector('[data-cf-daily-chart]'), note = box.querySelector('[data-cf-daily-note]'), table = box.querySelector('[data-cf-daily-table]');
    const platformSelect = box.querySelector('#cf-daily-platform'), metricSelect = box.querySelector('#cf-daily-metric');
    chart.innerHTML = ''; table.innerHTML = ''; table.hidden = true;
    const ids = Object.keys(data?.platforms || {});
    platformSelect.disabled = metricSelect.disabled = !ids.length;
    if (!ids.length) { platformSelect.innerHTML = ''; note.textContent = 'Площадок со статистикой нет — графика нет.'; return; }
    const from = `${month}-01`, to = `${month}-${String(lastDay(month)).padStart(2, '0')}`, metric = metricSelect.value || 'views';
    const hasValues = (id) => dailySeries(data.platforms[id], metric, from, to, data.platforms[id].activeInterval || data.timezone || 'UTC').some((point) => point.state !== 'gap');
    const chosen = ids.includes(stats.dailyPlatform) ? stats.dailyPlatform : ids.find(hasValues) || ids.find((id) => data.platforms[id].configured) || ids[0];
    stats.dailyPlatform = chosen;
    platformSelect.innerHTML = ids.map((id) => `<option value="${esc(id)}"${id === chosen ? ' selected' : ''}>${esc(data.platforms[id].label || id)}${data.platforms[id].configured ? '' : ' — не подключена'}</option>`).join('');
    const platform = data.platforms[chosen], label = DAILY_METRICS.find(([id]) => id === metric)?.[1] || metric;
    const zone = platform.activeInterval || data.timezone || 'UTC';
    const series = dailySeries(platform, metric, from, to, zone), values = series.filter((point) => point.state !== 'gap');
    const zoneNote = platform.activeInterval ? `Сутки — по поясу аккаунта ${platform.activeInterval}.` : `Пояс аккаунта не задан — сутки по поясу компании ${zone}.`;
    const other = (platform.otherIntervals || []).length ? ' Наблюдения в другой системе суток в график не входят.' : '';
    if (!values.length) {
      note.textContent = !platform.configured && !Object.keys(platform.days || {}).length ? `${platform.label || chosen} не подключена — графика нет.`
        : platform.dataStatus === 'lifetime_only' ? `Есть только накопительные значения, дневных за месяц нет — график не строится. ${zoneNote}`
          : `За месяц нет дневных значений «${label}» — график не строится. ${zoneNote}${other}`;
      return;
    }
    const max = Math.max(...values.map((point) => point.value)), peak = values.find((point) => point.value === max), gaps = series.length - values.length;
    const partial = values.filter((point) => point.state !== 'complete').length;
    note.textContent = `${zoneNote}${other}`;
    const summary = `${label}, ${platform.label || chosen}, по дням с ${dayRu(series[0].date)} по ${dayRu(series.at(-1).date)}: дней со значением ${values.length} из ${series.length}${gaps ? `, без данных ${gaps}` : ''}${partial ? `, неполных ${partial}` : ''}; максимум ${number(max)} (${dayRu(peak.date)}).`;
    const height = (point) => (max > 0 ? Math.max(2, Math.round(point.value / max * 100)) : 0);
    const bars = series.map((point) => {
      const title = `${dayRu(point.date)}: ${pointWords(point)}`;
      if (point.state === 'gap') return `<span class="cf-day cf-day-gap" title="${esc(title)}" data-cf-day="${point.date}" data-state="gap"></span>`;
      if (point.value === 0) return `<span class="cf-day cf-day-zero" title="${esc(title)}" data-cf-day="${point.date}" data-state="${point.state}" data-value="0"><i></i></span>`;
      return `<span class="cf-day" title="${esc(title)}" data-cf-day="${point.date}" data-state="${point.state}" data-value="${point.value}"><i class="cf-bar${point.state === 'complete' ? '' : ' cf-bar-partial'}" style="height:${height(point)}%"></i></span>`;
    }).join('');
    const legend = [partial ? '<span class="cf-key"><i class="cf-bar cf-bar-partial"></i>неполные данные</span>' : '', gaps ? '<span class="cf-key"><i class="cf-key-gap"></i>нет данных</span>' : '',
      series.some((point) => point.state !== 'gap' && point.value === 0) ? '<span class="cf-key"><i class="cf-key-zero"></i>подтверждённый 0</span>' : ''].filter(Boolean).join('');
    const mid = series[Math.floor((series.length - 1) / 2)];
    chart.innerHTML = `<div class="cf-chart" role="img" aria-label="${esc(summary)}"><span class="cf-axis-max" aria-hidden="true">${esc(number(max))}</span>
        <div class="cf-days" aria-hidden="true" style="--cf-days:${series.length}">${bars}</div><span class="cf-axis-zero" aria-hidden="true">0</span></div>
      <div class="cf-axis-dates" aria-hidden="true"><span>${dayRu(series[0].date)}</span>${series.length > 2 ? `<span>${dayRu(mid.date)}</span>` : ''}<span>${dayRu(series.at(-1).date)}</span></div>
      ${legend ? `<p class="cf-legend">${legend}</p>` : ''}<p class="cf-note" data-cf-daily-summary>${esc(summary)}</p>`;
    table.hidden = false;
    table.innerHTML = `<summary>Значения по дням (${series.length})</summary><table class="cf-table"><thead><tr><th scope="col">День</th><th scope="col">${esc(label)}</th><th scope="col">Источник</th></tr></thead><tbody>
      ${series.map((point) => `<tr data-cf-day-row="${point.date}"><td>${esc(dayRu(point.date))}</td><td>${esc(pointWords(point))}</td><td>${esc(point.provider || '—')}</td></tr>`).join('')}</tbody></table>`;
  }
  function dailyUnavailable(node, text) {
    const box = node.querySelector('[data-cf-daily]'); if (!box) return;
    box.querySelector('[data-cf-daily-chart]').innerHTML = ''; box.querySelector('[data-cf-daily-table]').hidden = true; box.querySelector('[data-cf-daily-table]').innerHTML = '';
    box.querySelector('[data-cf-daily-note]').textContent = text; box.querySelector('#cf-daily-platform').innerHTML = '';
    box.querySelector('#cf-daily-platform').disabled = box.querySelector('#cf-daily-metric').disabled = true;
  }
  /* CF6: «Открыть материал» — только по доказанному crm.posts[].autopostingId (положительное целое из контракта).
     Сначала переход на Контент-план, затем существующее событие открытия с новым GET карточки; запрос помечен
     источником, чтобы Контент-план назвал состояние по текущей карточке, а не «черновик из предложения». */
  const provenId = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
  function openMaterial(ctx, code, postId) {
    const detail = {companyCode: code, postId, source: 'stats'};
    sb.pendingMaterialOpen = detail;
    ctx.navigate?.('content-factory/plan');
    setTimeout(() => window.dispatchEvent(new window.CustomEvent('sb:content-factory-open-draft', {detail: {...detail}})), 0);
  }
  async function loadStats(container, ctx, month) {
    const epoch = ++stats.epoch, code = String(ctx.selectedProjectId || '').toLowerCase(), node = container.querySelector('[data-cf-stats]');
    if (!node) return;
    stats.month = month; stats.code = code; stats.calendar = null; stats.social = null; stats.socialState = 'loading'; stats.period = null; stats.socialError = '';
    for (const [id] of METRICS) setMetric(node, id, 'Загружаем…');
    stats.data = null; dailyUnavailable(node, 'Загружаем дневные значения…');
    node.querySelector('[data-cf-posts]').innerHTML = ''; node.querySelector('#cf-stats-source').textContent = '';
    node.querySelector('[data-cf-crm-period]').textContent = ''; node.querySelector('#cf-stats-method [data-cf-method="leads"]').textContent = leadsMethod(null);
    const from = `${month}-01`, to = `${month}-${String(lastDay(month)).padStart(2, '0')}`;
    const current = () => epoch === stats.epoch && node.isConnected && String(ctx.selectedProjectId || '').toLowerCase() === code;
    const analytics = canAnalytics(ctx);
    const [calendar, social] = await Promise.allSettled([
      ctx.crmQuery('/autoposting/calendar', {companyCode: code, from, to}),
      // CF29: только эта вкладка просит заявки за месяц по поясу проекта; общая аналитика не меняется.
      analytics ? ctx.crmQuery('/social-stats', {companyCode: code, from, to, crmPeriod: 'project'}) : Promise.resolve(null)]);
    if (!current()) return;
    stats.calendar = calendar.status === 'fulfilled' && calendar.value?.companyCode === code ? calendar.value : null;
    const data = social.status === 'fulfilled' ? social.value : null;
    stats.socialState = !analytics ? 'noright' : data && data.companyCode === code ? 'ok' : 'failed';
    stats.social = stats.socialState === 'ok' ? data : null;
    stats.socialError = stats.socialState !== 'failed' ? '' : social.status === 'rejected' ? String(social.reason?.message || 'ошибка запроса') : 'ответ другой компании';
    stats.period = stats.social ? crmPeriodState(stats.social, from, to) : null;
    stats.data = stats.social;
    platformOptions(node);
    applyStats(node);
  }
  /* CF19-R1: календарь хранит площадку выхода (youtube_shorts), статистика соцсетей — аккаунт (youtube). Для фильтра и счёта это
     одна площадка. Псевдоним единственный и явный: остальные не угадываются, исходные ответы не меняются — только сравнение и список. */
  const STAT_PLATFORM_ALIAS = {youtube_shorts: 'youtube'};
  const statPlatform = (id) => (Object.hasOwn(STAT_PLATFORM_ALIAS, id) ? STAT_PLATFORM_ALIAS[id] : id);
  // Площадки фильтра — из всех трёх источников месяца; выбранная остаётся в списке, даже если в новом месяце её нет.
  function platformOptions(node) {
    const select = node.querySelector('#cf-filterPlatform'), labels = new Map();
    for (const post of stats.calendar?.posts || []) for (const item of post.calendarReadiness?.platforms || []) if (item?.platform) labels.set(statPlatform(item.platform), statPlatform(item.platform));
    for (const [id, item] of Object.entries(stats.social?.platforms || {})) labels.set(statPlatform(id), item?.label || id);
    for (const item of stats.social?.crm?.posts || []) if (item?.platform && !labels.has(statPlatform(item.platform))) labels.set(statPlatform(item.platform), statPlatform(item.platform));
    for (const [id] of labels) if (stats.social?.platforms?.[id]?.label) labels.set(id, stats.social.platforms[id].label);
    if (stats.filter.platform && !labels.has(stats.filter.platform)) labels.set(stats.filter.platform, stats.filter.platform);
    select.innerHTML = `<option value="">Все площадки</option>${[...labels].map(([id, text]) => `<option value="${esc(id)}"${id === stats.filter.platform ? ' selected' : ''}>${esc(text)}</option>`).join('')}`;
  }
  // Пересчёт сводки, графика и таблицы по сохранённым ответам и фильтрам — без нового запроса.
  function applyStats(node) {
    const f = stats.filter, month = stats.month, code = stats.code, split = Boolean(f.format || f.role), count = filterCount();
    node.querySelector('[data-cf-filter-count]').textContent = count ? ` · активно ${count}` : '';
    node.querySelector('[data-cf-filter-reset]').disabled = !count;
    const calendar = stats.calendar, notes = [];
    if (calendar) {
      const zone = typeof calendar.timezone === 'string' ? calendar.timezone : '';
      node.querySelector('#cf-stats-method [data-cf-method="published"]').textContent = metricNote(METRICS[0][3], zone);
      let published = 0, unknownCards = 0;
      for (const post of (calendar.posts || []).filter((item) => String(item.effectiveDate || '').startsWith(month + '-'))) {
        const fmt = known(STAT_FORMATS, post.meta?.format), role = known(STAT_ROLES, post.meta?.role);
        if ((f.format && !fmt) || (f.role && !role)) { unknownCards++; continue; }
        if ((f.format && fmt !== f.format) || (f.role && role !== f.role)) continue;
        published += (post.calendarReadiness?.platforms || []).filter((item) => item.state === 'published' && (!f.platform || statPlatform(item.platform) === f.platform)).length;
      }
      setMetric(node, 'published', published ? number(published) : count ? 'Нет совпадений' : 'Нет опубликованных');
      if (split && unknownCards) notes.push(`Карточек месяца без ${f.format ? 'указанного формата' : 'указанной цели ОВП'}: ${unknownCards} — в отбор не входят.`);
    } else setMetric(node, 'published', 'Не загрузилось');
    const source = node.querySelector('#cf-stats-source'), list = node.querySelector('[data-cf-posts]');
    list.innerHTML = ''; source.textContent = '';
    const period = stats.socialState === 'ok' ? stats.period : null, unconfirmed = period?.state === 'invalid';
    node.querySelector('#cf-stats-method [data-cf-method="leads"]').textContent = leadsMethod(period);
    node.querySelector('[data-cf-crm-period]').textContent = periodLine(period);
    if (stats.socialState === 'noright') {
      for (const id of ['views', 'clicks', 'leads']) setMetric(node, id, 'Нужно право «Аналитика: просмотр»');
      dailyUnavailable(node, 'График по дням — по праву «Аналитика: просмотр».');
      node.querySelector('[data-cf-filter-note]').textContent = notes.join(' ');
      return; // Значения уже говорят «Нужно право…» — строка источника не повторяет.
    }
    const data = stats.social;
    if (!data) {
      for (const id of ['views', 'clicks', 'leads']) setMetric(node, id, 'Не загрузилось');
      // CF29: явная ошибка (400 crmPeriod/timezone, 403 и прочие) — не успех и не ноль; причина названа у графика,
      // строка источника по R2 при сбое пуста.
      dailyUnavailable(node, `Статистика не загрузилась — графика нет. Обновите страницу позже. Причина: ${stats.socialError || 'ошибка запроса'}.`);
      node.querySelector('[data-cf-filter-note]').textContent = notes.join(' ');
      return;
    }
    // Просмотры, переходы и дневной ряд принадлежат аккаунту площадки: формату или цели их не приписываем.
    const platformKey = f.platform ? Object.keys(data.platforms || {}).find((id) => statPlatform(id) === f.platform) : undefined;
    const platform = platformKey ? data.platforms[platformKey] : null;
    if (split) {
      for (const id of ['views', 'clicks']) setMetric(node, id, 'Нет разбивки по формату/ОВП');
      dailyUnavailable(node, 'Нет разбивки по формату/ОВП: дневные просмотры и переходы считаются по аккаунту площадки целиком.');
      notes.push('Просмотры, переходы и график — по аккаунту площадки, по формату и цели ОВП не разбиваются.');
    } else if (f.platform) {
      const views = platform?.totals?.views, clicks = platform?.totals?.link_clicks;
      setMetric(node, 'views', typeof views === 'number' ? number(views) : 'Нет данных');
      setMetric(node, 'clicks', typeof clicks === 'number' ? number(clicks) : 'Нет данных');
      if (platform) { stats.dailyPlatform = platformKey; renderDaily(node, data, month); node.querySelector('#cf-daily-platform').disabled = true; }
      else dailyUnavailable(node, 'По этой площадке статистики соцсетей нет — графика нет.');
    } else {
      renderDaily(node, data, month);
      const views = data.socialAggregate?.views;
      setMetric(node, 'views', typeof views === 'number' ? number(views) : 'Нет данных');
      const clicks = Object.values(data.platforms || {}).map((item) => item?.totals?.link_clicks).filter((value) => typeof value === 'number');
      setMetric(node, 'clicks', clicks.length ? number(clicks.reduce((a, b) => a + b, 0)) : 'Нет данных');
    }
    const all = Array.isArray(data.crm?.posts) ? data.crm.posts : [];
    const onPlatform = all.filter((item) => !f.platform || statPlatform(item.platform) === f.platform);
    const unknownRows = onPlatform.filter((item) => (f.format && !known(STAT_FORMATS, item.format)) || (f.role && !known(STAT_ROLES, item.ovpRole))).length;
    const posts = onPlatform.filter((item) => (!f.format || known(STAT_FORMATS, item.format) === f.format) && (!f.role || known(STAT_ROLES, item.ovpRole) === f.role));
    const leads = posts.filter((item) => item.attribution === 'exact').reduce((sum, item) => sum + (Number(item.leads) || 0), 0);
    // «unknown» — у публикации нет ни адреса, ни метки: ноль заявок по ней был бы не измерением, а незнанием.
    const linkable = posts.some((item) => item.attribution === 'exact' || item.attribution === 'none_in_period');
    setMetric(node, 'leads', unconfirmed ? 'Период не подтверждён' : !all.length ? 'Нет известных публикаций' : !posts.length ? 'Нет совпадений' : linkable ? number(leads) : 'Связь не определяется');
    if (split && unknownRows) notes.push(`Публикаций без ${f.format ? 'известного формата' : 'известной цели ОВП'}: ${unknownRows} — их заявки в отбор не входят.`);
    if (count && posts.some((item) => item.attribution === 'unknown')) notes.push('Публикации без подтверждённой связи с заявками показаны, но их заявки не суммируются.');
    node.querySelector('[data-cf-filter-note]').textContent = notes.join(' ');
    const updated = Object.values(data.platforms || {}).map((item) => item?.lastCollectedAt).filter(Boolean).sort().at(-1);
    let stamp = '';
    if (updated) stamp = checkedText(updated, data.timezone || '');
    source.textContent = `Статистика соцсетей: ${stamp ? `обновлено ${stamp}` : 'сбор не подключён или данных нет'}`;
    const kindOf = (item) => `${STAT_FORMATS.find(([id]) => id === known(STAT_FORMATS, item.format))?.[1] || 'формат неизвестен'} · ${STAT_ROLES.find(([id]) => id === known(STAT_ROLES, item.ovpRole))?.[1] || 'ОВП неизвестна'}`;
    const leadsSpan = period?.state === 'project' ? `за ${ruDate(period.period.from)}–${ruDate(period.period.to)} по поясу проекта ${period.period.timezone}`
      : unconfirmed ? 'не показаны: период CRM не подтверждён' : 'за месяц по UTC';
    if (posts.length) list.innerHTML = `<table class="cf-table"><caption>Известные публикации (не только за этот месяц) и их заявки ${esc(leadsSpan)}${count ? ' — по фильтрам' : ''}${posts.length > 50 ? `; показаны 50 из ${posts.length}` : ''}</caption>
      <thead><tr><th scope="col">Площадка</th><th scope="col">Дата выхода (UTC)</th><th scope="col">Ссылка</th><th scope="col">Формат · ОВП</th><th scope="col">Заявки</th><th scope="col">Материал</th></tr></thead><tbody>
      ${posts.slice(0, 50).map((item) => `<tr><td data-label="Площадка">${esc(data.platforms?.[item.platform]?.label || item.platform)}</td><td data-label="Дата выхода (UTC)">${esc(utcDay(item.publishedAt))}</td>
        <td data-label="Ссылка">${/^https:\/\//.test(item.url || '') ? `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">открыть</a>` : '—'}</td>
        <td data-label="Формат · ОВП">${esc(kindOf(item))}</td>
        <td data-label="Заявки">${unconfirmed ? 'Период не подтверждён' : item.attribution === 'exact' ? esc(item.leads) : item.attribution === 'none_in_period' ? '0 (связь есть, заявок за месяц нет)' : 'Связь не подтверждена'}</td>
        <td data-label="Материал">${provenId(item.autopostingId) ? `<button type="button" class="plain-button" data-cf-open-post="${provenId(item.autopostingId)}" data-cf-company="${esc(code)}">Открыть материал</button>` : '<span class="cf-note">Карточка не связана</span>'}</td></tr>`).join('')}</tbody></table>`;
    else if (all.length) list.innerHTML = `<p class="cf-note" data-cf-posts-empty>Нет публикаций по выбранным фильтрам.${unknownRows ? ` Без ${f.format ? 'известного формата' : 'известной цели ОВП'}: ${unknownRows}.` : ''} <button type="button" class="plain-button" data-cf-filter-reset>Сбросить фильтры</button></p>`;
  }
  async function renderStats(container, ctx) {
    if (!canRead(ctx)) { container.innerHTML = '<div class="card"><p>Статистика контента доступна по праву «Автопостинг: просмотр».</p></div>'; return; }
    const code = String(ctx.selectedProjectId || '').toLowerCase(), epoch = ++stats.epoch;
    // Новый рендер (в том числе смена проекта) начинает без фильтров; смена месяца их сохраняет.
    stats.filter = {platform: '', format: '', role: ''}; stats.calendar = null; stats.social = null; stats.socialState = '';
    const select = (id, all, list) => `<select id="cf-${id}" class="cf-daily-select" data-cf-filter="${id}"><option value="">${esc(all)}</option>${list.map(([value, text]) => `<option value="${value}">${esc(text)}</option>`).join('')}</select>`;
    container.innerHTML = `<div class="content-header"><h2>Статистика контента</h2></div>
      <div data-cf-stats><label class="cf-month-pick">Месяц<input id="cf-stats-month" type="month"></label>
      <details class="card cf-stats-filters" data-cf-filters><summary>Фильтры<span data-cf-filter-count></span></summary>
        <div class="cf-daily-controls">${field('filterPlatform', 'Площадка', select('filterPlatform', 'Все площадки', []))}
          ${field('filterFormat', 'Формат', select('filterFormat', 'Все форматы', STAT_FORMATS))}${field('filterRole', 'Цель ОВП', select('filterRole', 'Все цели', STAT_ROLES))}
          <button type="button" class="plain-button" data-cf-filter-reset disabled>Сбросить</button></div>
        <p class="cf-note" data-cf-filter-note role="status"></p></details>
      <div class="cf-metrics">${METRICS.map(([id, label, short]) => `<div class="card cf-metric" data-cf-metric="${id}"><span class="cf-metric-label">${esc(label)}</span>
        <strong data-cf-value>Загружаем…</strong><span class="cf-note">${esc(short)}</span></div>`).join('')}</div>
      <section class="card cf-daily" data-cf-daily aria-labelledby="cf-daily-title"><h3 id="cf-daily-title">По дням</h3>
        <div class="cf-daily-controls">${field('dailyPlatform', 'Площадка', '<select id="cf-dailyPlatform" class="cf-daily-select" disabled></select>').replace('id="cf-dailyPlatform"', 'id="cf-daily-platform"').replace('for="cf-dailyPlatform"', 'for="cf-daily-platform"')}
          ${field('dailyMetric', 'Показатель', `<select id="cf-dailyMetric" class="cf-daily-select" disabled>${DAILY_METRICS.map(([id, text]) => `<option value="${id}">${esc(text)}</option>`).join('')}</select>`).replace('id="cf-dailyMetric"', 'id="cf-daily-metric"').replace('for="cf-dailyMetric"', 'for="cf-daily-metric"')}</div>
        <p class="cf-note" data-cf-daily-note role="status"></p><div data-cf-daily-chart></div><details class="cf-daily-table" data-cf-daily-table hidden></details></section>
      <p id="cf-stats-source" class="cf-note"></p><p class="cf-note" data-cf-crm-period></p>${methodMarkup()}<p class="cf-note" data-cf-open-status role="status"></p><div data-cf-posts></div>
      <p class="cf-note">Ход внедрения раздела — <a href="#content-factory/progress">история этапов внедрения</a>.</p></div>`;
    const input = container.querySelector('#cf-stats-month');
    input.addEventListener('change', () => { if (/^\d{4}-\d{2}$/.test(input.value)) void loadStats(container, ctx, input.value); });
    const statsNode = container.querySelector('[data-cf-stats]');
    bindHints(statsNode);
    for (const id of ['#cf-daily-platform', '#cf-daily-metric']) statsNode.querySelector(id).addEventListener('change', () => {
      if (id === '#cf-daily-platform') stats.dailyPlatform = statsNode.querySelector(id).value;
      if (!stats.data || stats.data.companyCode !== stats.code || stats.code !== code) return;
      // CF19: при фильтре по формату/ОВП графика нет; при фильтре площадки — только её ряд.
      if (stats.filter.format || stats.filter.role) return;
      renderDaily(statsNode, stats.data, stats.month);
      if (stats.filter.platform) statsNode.querySelector('#cf-daily-platform').disabled = true;
    });
    const ready = () => stats.code === code && String(ctx.selectedProjectId || '').toLowerCase() === code && stats.socialState && stats.socialState !== 'loading';
    statsNode.querySelector('[data-cf-filters]').addEventListener('change', (event) => {
      const id = event.target.dataset.cfFilter; if (!id) return;
      stats.filter[{filterPlatform: 'platform', filterFormat: 'format', filterRole: 'role'}[id]] = event.target.value;
      if (ready()) applyStats(statsNode);
    });
    statsNode.addEventListener('click', (event) => {
      if (event.target.closest('[data-cf-filter-reset]')) {
        stats.filter = {platform: '', format: '', role: ''};
        for (const node of statsNode.querySelectorAll('[data-cf-filter]')) node.value = '';
        if (ready()) applyStats(statsNode);
        return;
      }
      const button = event.target.closest('[data-cf-open-post]'); if (!button) return;
      const id = provenId(Number(button.dataset.cfOpenPost)), status = statsNode.querySelector('[data-cf-open-status]');
      // Смена компании или устаревший ответ: кнопка прежней компании ничего не открывает.
      if (!id || !canRead(ctx) || button.dataset.cfCompany !== code || stats.code !== code || String(ctx.selectedProjectId || '').toLowerCase() !== code) {
        status.textContent = 'Список устарел: выбрана другая компания. Обновите статистику.'; return; }
      status.textContent = `Открываем материал №${id} в Контент-плане…`;
      openMaterial(ctx, code, id);
    });
    let timezone = '';
    try { timezone = (await ctx.crmQuery('/media-mentor/inputs', {companyCode: code})).timezone || ''; } catch { timezone = ''; }
    if (epoch !== stats.epoch) return;
    input.value = monthNow(timezone);
    await loadStats(container, ctx, input.value);
  }

  /* ---------- Строка действий Контент-плана ---------- */
  let barBound = false, barCtx = null, composeEpoch = 0;
  /* CF2 (клиент): составление плана на месяц выполняет сервер (очередь задач). Контракт сверен с Codex
     01.10.2026: POST/GET /media-mentor/generation, GET /:id, POST /:id/drafts. Здесь нет шаблонных
     «предложений», автоповтора, согласования, расписания и публикации. Предложения задачи неизменяемы;
     правка — только после создания черновика, в существующем редакторе материалов. */
  const ACTIVE = new Set(['queued', 'running']);
  const GEN_UNAVAILABLE = new Set([404, 405, 501]);
  const gen = {epoch: 0, timer: null, delay: 3000, code: '', month: '', jobs: [], data: null, unavailable: false, loadError: '',
    pendingRequestId: null, busy: false, draftsBusy: false, views: new Map(), viewJobId: null, message: '', resend: false};
  /* CF19: выбор, скрытые площадки, квитанции черновиков и сообщение переноса — отдельно для каждой задачи:
     предложения разных попыток одного месяца не смешиваются. */
  const jobView = (id) => {
    const key = String(id);
    if (!gen.views.has(key)) gen.views.set(key, {selection: new Set(), hidden: new Set(), drafts: new Map(), archivedDrafts: new Map(), draftMessage: ''});
    return gen.views.get(key);
  };
  const resetViews = () => { gen.views.clear(); gen.viewJobId = null; };
  const requestId = () => {
    try { if (window.crypto?.randomUUID) return window.crypto.randomUUID(); } catch {}
    return 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  };
  const monthTitle = (month) => {
    try { return new Date(month + '-01T00:00:00Z').toLocaleDateString('ru-RU', {month: 'long', year: 'numeric', timeZone: 'UTC'}).replace(/\s*г\.$/, ''); }
    catch { return month; }
  };
  const dayTitle = (date) => {
    try { return new Date(date + 'T00:00:00Z').toLocaleDateString('ru-RU', {day: 'numeric', month: 'long', weekday: 'short', timeZone: 'UTC'}); }
    catch { return date; }
  };
  /* Основание предложения приходит служебными метками «вид:значение». Клиенту показываются только известные виды
     понятной подписью; неизвестные и пустые метки скрываются, а не выводятся как есть. */
  const BASIS = {event: 'Событие', priority: 'Приоритет месяца', occasion: 'Повод покупки', question: 'Вопрос покупателя', proof: 'Доказательство'};
  const basisLabels = (list) => (Array.isArray(list) ? list : []).map((entry) => {
    const match = /^([a-z_]+):([\s\S]*)$/.exec(String(entry ?? ''));
    const value = match ? match[2].trim() : '';
    return match && Object.hasOwn(BASIS, match[1]) && value ? `${BASIS[match[1]]} — ${value}` : '';
  }).filter(Boolean);
  // CF3-R1: цель ОВП подписывается так же, как на доске и в окне публикации.
  const OVP_LABEL = {reach: 'Охват', affection: 'Влюбление', sale: 'Продажи'};
  const label = (list, id) => (Array.isArray(list) ? list.find((item) => item.id === id)?.label : '') || id || '—';
  const latestJob = () => [...gen.jobs].filter((job) => job && job.month === gen.month)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.id).localeCompare(String(a.id), 'en', {numeric: true}))[0] || null;
  const sortedJobs = () => [...gen.jobs].filter((job) => job && job.month === gen.month)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.id).localeCompare(String(a.id), 'en', {numeric: true}));
  // Показываемый план: выбранный прежний готовый — или последняя задача. Очередь и запуск считаются только по последней.
  const viewedJob = () => {
    if (gen.viewJobId === null) return null;
    const job = gen.jobs.find((item) => item && String(item.id) === gen.viewJobId && item.month === gen.month && item.status === 'succeeded');
    return job && job !== latestJob() ? job : null;
  };
  const shownJob = () => viewedJob() || latestJob();
  const jobWhen = (job) => { const ms = Date.parse(job?.createdAt || ''); return Number.isNaN(ms) ? 'время неизвестно' : new Date(ms).toLocaleString('ru-RU', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}); };
  const STATUS_TEXT = {queued: 'В очереди на сервере.', running: 'Составляется на сервере.', needs_input: 'Нужны уточнения вводных.',
    succeeded: 'Готово.', failed: 'Не удалось составить план.'};
  function stopPolling() { clearTimeout(gen.timer); gen.timer = null; }
  function schedulePoll(panel) {
    stopPolling();
    const job = latestJob();
    if (!job || !ACTIVE.has(job.status)) { gen.delay = 3000; return; }
    gen.timer = setTimeout(() => { gen.timer = null; void loadJobs(panel); }, gen.delay);
    gen.delay = Math.min(15000, gen.delay + 3000);
  }
  async function loadJobs(panel) {
    const ctx = barCtx, epoch = gen.epoch, code = gen.code, month = gen.month;
    if (!panel || panel.hidden || !panel.isConnected) { stopPolling(); return; }
    try {
      const data = await ctx.crmQuery('/media-mentor/generation', {companyCode: code, month});
      if (epoch !== gen.epoch) return;
      if (!data || data.companyCode !== code || !Array.isArray(data.jobs)) throw new Error('Ответ другой компании или неверный формат');
      gen.jobs = data.jobs.filter((job) => job && job.month === month);
      gen.unavailable = false; gen.loadError = '';
      if (gen.viewJobId !== null && !viewedJob()) { gen.viewJobId = null; gen.message = 'Выбранный прежний план больше не в списке задач месяца — показана последняя задача.'; }
    } catch (error) {
      if (epoch !== gen.epoch) return;
      if (GEN_UNAVAILABLE.has(error.status)) gen.unavailable = true;
      else gen.loadError = `Не удалось получить состояние: ${error.message}`;
    }
    renderGeneration(panel);
    schedulePoll(panel);
  }
  function inputsChanged(job) {
    const data = gen.data, snap = job?.inputs;
    if (!data || !snap || typeof snap !== 'object') return false;
    return [[snap.briefRevision, data.brief.revision], [snap.profileRevision, data.inputs.profile.revision], [snap.monthRevision, data.monthData.revision]]
      .some(([was, now]) => Number.isInteger(was) && Number.isInteger(now) && was !== now);
  }
  /* Куда вести по вопросу сервера. Часовой пояс — не вводная модуля, а существующее поле компании
     (companies.timezone, «Актуальность» → «Часовой пояс»): его вопрос ведёт туда, а не в «Настройки модуля». */
  const TIMEZONE_TARGETS = new Set(['profile.timezone', 'timezone', 'company.timezone']);
  function questionTarget(target) {
    const value = String(target || '');
    if (TIMEZONE_TARGETS.has(value)) return {text: 'Актуальность → «Часовой пояс» (данные компании)', href: '#company-information'};
    if (value.startsWith('month.')) {
      // CF7: вопрос месяца ведёт в пожелания именно этого месяца этой компании и подсвечивает нужную группу.
      const part = value.slice('month.'.length), query = new URLSearchParams({company: gen.code, month: gen.month});
      if (FOCUS_FIELDS.has(part)) query.set('focus', part);
      const names = {formats: ' → «Форматы публикаций»', roles: ' → «Цели публикаций (ОВП)»', platforms: ' → «Площадки и объём»'};
      return {text: `Настройки модуля → «Пожелания на месяц» ${monthTitle(gen.month)}${names[part] || ''}`, href: `#content-factory/settings?${query}`};
    }
    if (value.startsWith('profile.') || value.startsWith('brief.')) return {text: 'Настройки модуля → «О бизнесе и покупателях»', href: '#content-factory/settings'};
    return {text: 'Настройки модуля', href: '#content-factory/settings'};
  }
  function proposalsMarkup(job, edit) {
    const data = gen.data, proposals = Array.isArray(job.proposals) ? job.proposals : [], v = jobView(job.id);
    if (!proposals.length) return '<p class="cf-note">Сервер не вернул ни одного предложения.</p>';
    const platforms = [...new Set(proposals.map((item) => item.platform))];
    const visible = proposals.filter((item) => !v.hidden.has(item.platform));
    const byDate = new Map();
    for (const item of visible) { if (!byDate.has(item.date)) byDate.set(item.date, []); byDate.get(item.date).push(item); }
    const dates = [...byDate.keys()].sort();
    const selectable = (item) => edit && !v.drafts.has(item.ideaId);
    const filters = `<fieldset class="cf-gen-filter"><legend>Площадки</legend>${platforms.map((id) => `<label class="cf-check"><input type="checkbox" data-cf-gen-platform="${esc(id)}"${v.hidden.has(id) ? '' : ' checked'}>${esc(label(data.platforms, id))}</label>`).join('')}</fieldset>`;
    const days = dates.map((date) => {
      const items = byDate.get(date), names = [...new Set(items.map((item) => label(data.platforms, item.platform)))];
      return `<details class="cf-gen-day" data-cf-gen-day="${esc(date)}"><summary>${esc(dayTitle(date))} · ${items.length} ${items.length === 1 ? 'предложение' : items.length < 5 ? 'предложения' : 'предложений'} · ${esc(names.join(', '))}</summary>
        <ul class="cf-gen-items">${items.map((item) => {
          const draft = v.drafts.get(item.ideaId);
          const warnings = Array.isArray(item.warnings) ? item.warnings : [];
          const basis = basisLabels(item.basis);
          return `<li class="cf-gen-item" data-cf-proposal="${esc(item.ideaId)}" data-cf-job="${esc(job.id)}">
            <div class="cf-gen-head">${selectable(item) ? `<input type="checkbox" data-cf-gen-select="${esc(item.ideaId)}" aria-label="Выбрать: ${esc(item.topic)}"${v.selection.has(item.ideaId) ? ' checked' : ''}>` : ''}
              <strong>${esc(item.topic)}</strong></div>
            <p class="cf-note">${esc(label(data.platforms, item.platform))} · ${esc(label(data.formats, item.format))} · ОВП: ${esc(OVP_LABEL[item.role] || label(data.roles, item.role))}</p>
            ${item.hook ? `<p>Первая фраза: ${esc(item.hook)}</p>` : ''}
            ${item.text ? `<details><summary>Черновой текст</summary><p class="cf-gen-text">${esc(item.text)}</p></details>` : ''}
            ${item.mentorNote ? `<p class="cf-note">Съёмка: ${esc(item.mentorNote)}</p>` : ''}
            ${basis.length ? `<p class="cf-note">Основание: ${esc(basis.join('; '))}</p>` : ''}
            ${warnings.length ? `<ul class="cf-warning">${warnings.map((w) => `<li>${esc(w.message || w.code)}</li>`).join('')}</ul>` : ''}
            ${draft ? (v.archivedDrafts.has(item.ideaId)
              ? `<p class="cf-gen-draft">Черновик №${esc(draft)} удалён из плана. Вернуть можно в «Удалённых материалах» на доске. <button class="plain-button" type="button" data-cf-gen-open="${esc(draft)}">Показать</button></p>`
              : `<p class="cf-gen-draft">Черновик №${esc(draft)} создан. <button class="plain-button" type="button" data-cf-gen-open="${esc(draft)}">Открыть черновик</button></p>`) : ''}
          </li>`;
        }).join('')}</ul></details>`;
    }).join('');
    const selectedVisible = visible.filter((item) => v.selection.has(item.ideaId)).length;
    const actions = edit ? `<div class="cf-actions">
        <button class="plain-button" type="button" data-cf-gen="select-visible">Выбрать видимые</button>
        <button class="plain-button" type="button" data-cf-gen="clear">Снять выбор</button>
        <button class="plain-button" type="button" data-cf-gen="drafts"${v.selection.size && !gen.draftsBusy ? '' : ' disabled'}>Создать черновики (${v.selection.size})</button></div>
      <p class="cf-note">Черновики появляются на доске Контент-плана: без согласования, расписания и публикации. Править их — в окне публикации.</p>` : '';
    return `${filters}<p class="cf-note">Показано ${visible.length} из ${proposals.length}${v.selection.size ? `; выбрано ${v.selection.size}${selectedVisible !== v.selection.size ? `, из них видно ${selectedVisible}` : ''}` : ''}.</p>
      <div class="cf-gen-days">${days || '<p class="cf-note">По выбранным площадкам предложений нет.</p>'}</div>${actions}
      <p class="cf-note" data-cf-gen-draft-state role="status">${esc(v.draftMessage)}</p>`;
  }
  function jobMarkup(job, edit) {
    if (gen.unavailable) return '<p class="cf-warning">Составление плана на сервере пока не подключено. Ничего не запущено и не создано.</p>';
    if (!job) return `${gen.loadError ? `<p class="crm-error" role="alert">${esc(gen.loadError)}</p>` : ''}<p class="cf-note">План на ${esc(monthTitle(gen.month))} ещё не составлялся.</p>`;
    const known = Object.hasOwn(STATUS_TEXT, job.status);
    const attempts = Number.isInteger(job.attempts) && Number.isInteger(job.maxAttempts) && job.attempts > 0 ? ` Попытка ${job.attempts} из ${job.maxAttempts}.` : '';
    const executor = job.executor && typeof job.executor === 'object'
      ? (job.executor.kind === 'test' ? '<p class="cf-warning">Тестовый исполнитель (QA): это проверка цепочки, не результат модели.</p>'
        : job.executor.kind === 'api' && job.executor.model ? `<p class="cf-note">Модель: ${esc(job.executor.model)}.</p>` : '') : '';
    const coverage = job.status === 'succeeded' && job.coverage && Number.isInteger(job.coverage.proposed)
      ? `<p class="cf-note">Предложено ${esc(job.coverage.proposed)}${Number.isInteger(job.coverage.requested) ? ` из ${esc(job.coverage.requested)} по пожеланиям месяца` : ''}.</p>` : '';
    const stale = inputsChanged(job) ? '<p class="cf-warning">Вводные изменились после составления. Предложения сделаны по прежней версии; при необходимости составьте план заново.</p>' : '';
    let body = '';
    if (job.status === 'needs_input') {
      const questions = Array.isArray(job.questions) ? job.questions : [];
      const targets = questions.map((q) => questionTarget(q.target));
      const onlyCompany = targets.length > 0 && targets.every((item) => item.href === '#company-information');
      body = `<ul class="cf-list">${questions.map((q, index) => `<li>${esc(q.text)}${q.required ? ' <strong>(обязательно)</strong>' : ''} <span class="cf-note">— <a href="${targets[index].href}" data-cf-question-target="${esc(q.target)}">${esc(targets[index].text)}</a></span></li>`).join('') || '<li>Сервер не уточнил, каких данных не хватает.</li>'}</ul>
        <p>${onlyCompany ? '' : '<a href="#content-factory/settings">Перейти в «Настройки модуля»</a>. '}После правки составьте план заново.</p>`;
    } else if (job.status === 'failed') {
      body = `<p class="crm-error" role="alert">${esc(job.errorMessage || 'Сервер не сообщил причину.')}</p>
        ${job.retryable === true && edit ? '<p class="cf-note">Повтор возможен: нажмите «Составить план» ещё раз. Автоматически повтор не запускается.</p>' : '<p class="cf-note">Повтор этой задачи сервер не предлагает.</p>'}`;
    } else if (job.status === 'succeeded') body = proposalsMarkup(job, edit);
    // CF19: прежний готовый план показывается вместо предложений последней задачи; состояние последней остаётся сверху.
    const viewed = viewedJob();
    if (viewed) body = `${job.status === 'succeeded' ? '<p class="cf-note">Предложения последней задачи скрыты, пока открыт прежний план.</p>' : body}
      <section class="cf-gen-viewed" data-cf-gen-viewed="${esc(viewed.id)}" aria-label="Прежний план"><p class="cf-warning"><strong>Прежний план от ${esc(jobWhen(viewed))}</strong> — предыдущий результат этого месяца, не последняя задача.
        <button class="plain-button" type="button" data-cf-gen="view-latest">Вернуться к последней задаче</button></p>
        ${Number.isInteger(viewed.coverage?.proposed) ? `<p class="cf-note">Предложено ${esc(viewed.coverage.proposed)}${Number.isInteger(viewed.coverage.requested) ? ` из ${esc(viewed.coverage.requested)}` : ''}.</p>` : ''}
        ${inputsChanged(viewed) ? '<p class="cf-warning">Вводные изменились после составления этого плана.</p>' : ''}${proposalsMarkup(viewed, edit)}</section>`;
    return `${gen.loadError ? `<p class="crm-error" role="alert">${esc(gen.loadError)}</p>` : ''}
      <p class="cf-gen-status" data-cf-gen-status="${esc(job.status)}"><strong>${esc(known ? STATUS_TEXT[job.status] : `Состояние задачи неизвестно: ${job.status}`)}</strong>${esc(ACTIVE.has(job.status) || job.status === 'failed' ? attempts : '')}</p>
      ${executor}${coverage}${stale}${body}${historyMarkup(job)}`;
  }
  // CF19: свёрнутый список прежних попыток и планов этого проекта и месяца.
  function historyMarkup(latest) {
    const earlier = sortedJobs().filter((job) => job !== latest);
    if (!earlier.length) return '';
    const viewed = viewedJob(), ready = earlier.filter((job) => job.status === 'succeeded' && Array.isArray(job.proposals) && job.proposals.length).length;
    return `<details class="cf-gen-history" data-cf-gen-history${viewed ? ' open' : ''}><summary>Предыдущие попытки и планы месяца (${earlier.length}${ready ? `, готовых ${ready}` : ''})</summary>
      <ul class="cf-list">${earlier.map((job) => {
        const known = Object.hasOwn(STATUS_TEXT, job.status), count = Array.isArray(job.proposals) ? job.proposals.length : 0;
        const action = job === viewed ? '<span class="cf-note">показан выше</span>'
          : job.status === 'succeeded' && count ? `<button class="plain-button" type="button" data-cf-gen-view="${esc(job.id)}">Показать план</button>` : '';
        return `<li data-cf-gen-history-job="${esc(job.id)}">${esc(jobWhen(job))} · ${esc(known ? STATUS_TEXT[job.status] : job.status)}${count ? ` · предложений ${count}` : ''} ${action}</li>`;
      }).join('')}</ul></details>`;
  }
  function renderGeneration(panel) {
    const box = panel.querySelector('[data-cf-gen-job]'), state = panel.querySelector('[data-cf-gen-state]'), start = panel.querySelector('[data-cf-gen="start"]');
    if (!box) return;
    const ctx = barCtx, edit = canEdit(ctx), job = latestJob(), active = job && ACTIVE.has(job.status);
    const missing = panel.dataset.missing === 'true';
    if (start) {
      start.disabled = gen.busy || gen.unavailable || active || missing || !edit;
      start.textContent = `Составить план на ${monthTitle(gen.month)}`;
    }
    const resend = panel.querySelector('[data-cf-gen="resend"]');
    if (resend) { resend.hidden = !gen.resend; resend.disabled = gen.busy; }
    state.textContent = gen.message;
    // Перерисовка не сбрасывает раскрытые дни.
    const open = new Set([...box.querySelectorAll('[data-cf-gen-day][open]')].map((node) => node.dataset.cfGenDay));
    box.innerHTML = jobMarkup(job, edit);
    for (const node of box.querySelectorAll('[data-cf-gen-day]')) if (open.has(node.dataset.cfGenDay)) node.open = true;
  }
  async function startGeneration(panel, reuse) {
    const ctx = barCtx;
    if (gen.busy || !canEdit(ctx)) return;
    const epoch = gen.epoch, code = gen.code, month = gen.month;
    const clientRequestId = reuse && gen.pendingRequestId ? gen.pendingRequestId : requestId();
    gen.pendingRequestId = clientRequestId; gen.busy = true; gen.resend = false; gen.message = 'Отправляем задачу на сервер…';
    renderGeneration(panel);
    try {
      const result = await ctx.crmQuery('/media-mentor/generation', {companyCode: code}, ctx.csrfOptions('POST', {clientRequestId, month}));
      if (epoch !== gen.epoch) return;
      if (!result || result.companyCode !== code || !result.job || result.job.month !== month) throw Object.assign(new Error('Ответ другой компании или месяца'), {status: 0, scope: true});
      gen.pendingRequestId = null;
      gen.jobs = [result.job, ...gen.jobs.filter((job) => job.id !== result.job.id)];
      gen.message = ACTIVE.has(result.job.status) ? 'Задача принята сервером. Статус обновляется автоматически.' : '';
      gen.delay = 3000;
    } catch (error) {
      if (epoch !== gen.epoch) return;
      if (GEN_UNAVAILABLE.has(error.status)) { gen.pendingRequestId = null; gen.unavailable = true; gen.message = 'Составление плана на сервере пока не подключено. Ничего не запущено.'; }
      else if (error.status === 409) {
        gen.pendingRequestId = null;
        gen.message = error.code === 'GENERATION_ACTIVE' ? 'Для этого месяца уже идёт составление. Дождитесь результата.'
          : error.code === 'REQUEST_CONFLICT' ? 'Вводные изменились после первой отправки. Нажмите «Составить план» ещё раз.' : `Сервер отклонил запуск: ${error.message}`;
        void loadJobs(panel);
      } else if (error.scope) { gen.pendingRequestId = null; gen.message = 'Ответ сервера не подходит к выбранной компании или месяцу. Обновите раздел.'; }
      else if (!error.status || error.status >= 500) {
        // Ответ потерян: задача могла быть принята. Повтор с тем же ключом не создаст вторую.
        gen.resend = true;
        gen.message = `Ответ сервера не получен (${error.message}). Задача могла быть принята — «Отправить ещё раз» повторит тот же запрос.`;
      } else { gen.pendingRequestId = null; gen.message = `Не удалось запустить: ${error.message}`; }
    } finally {
      if (epoch === gen.epoch) { gen.busy = false; renderGeneration(panel); schedulePoll(panel); }
    }
  }
  async function createDrafts(panel) {
    const ctx = barCtx, job = shownJob(), v = job && jobView(job.id);
    if (gen.draftsBusy || !canEdit(ctx) || !job || job.status !== 'succeeded' || !v.selection.size) return;
    const epoch = gen.epoch, code = gen.code, ids = [...v.selection];
    gen.draftsBusy = true; v.draftMessage = 'Создаём черновики…'; renderGeneration(panel);
    try {
      const result = await ctx.crmQuery(`/media-mentor/generation/${encodeURIComponent(job.id)}/drafts`, {companyCode: code}, ctx.csrfOptions('POST', {proposalIds: ids}));
      if (epoch !== gen.epoch) return;
      if (!result || result.companyCode !== code || String(result.jobId) !== String(job.id) || !Array.isArray(result.drafts)) throw Object.assign(new Error('Ответ не подходит к задаче'), {scope: true});
      for (const draft of result.drafts) if (draft && ids.includes(draft.proposalId) && Number.isSafeInteger(draft.postId)) {
        v.drafts.set(draft.proposalId, draft.postId); v.selection.delete(draft.proposalId);
        // CF5: повтор переноса возвращает прежнюю карточку; удалённая так и остаётся удалённой — восстанавливают её отдельно.
        if (draft.archivedAt) v.archivedDrafts.set(draft.proposalId, draft.archivedAt); else v.archivedDrafts.delete(draft.proposalId);
      }
      const created = Number.isInteger(result.createdCount) ? result.createdCount : 0, existing = result.drafts.length - created, removed = result.drafts.filter((draft) => draft && draft.archivedAt).length;
      const missing = ids.filter((id) => !v.drafts.has(id)).length;
      v.draftMessage = `Создано черновиков: ${created}.${existing > 0 ? ` Уже были созданы раньше: ${existing}.` : ''}${removed ? ` Из них удалены из плана: ${removed} — вернуть можно в «Удалённых материалах» на доске.` : ''}${missing ? ` Не подтверждены сервером: ${missing}.` : ''} Это действие ничего не согласует и не ставит в расписание; состояние каждого черновика — на доске Контент-плана.`;
      window.dispatchEvent(new window.CustomEvent('sb:content-factory-drafts', {detail: {companyCode: code}}));
    } catch (error) {
      if (epoch !== gen.epoch) return;
      /* Не получив ответа (сеть, таймаут, 5xx), нельзя утверждать, что записи нет: сервер мог создать черновики
         до потери ответа. Результат неизвестен; повтор безопасен — сервер вернёт уже созданные, дублей не будет. */
      v.draftMessage = GEN_UNAVAILABLE.has(error.status) ? 'Перенос в черновики на сервере пока не подключён. Черновики не созданы.'
        : error.scope ? 'Ответ сервера не подходит к этой задаче. Результат неизвестен — черновики не отмечены как созданные; обновите раздел.'
          : !error.status || error.status >= 500 ? `Ответ сервера не получен (${error.message}). Черновики могли быть созданы. Нажмите «Создать черновики» ещё раз — сервер вернёт уже созданные, дублей не будет.`
            : `Сервер отклонил запрос: ${error.message}. Черновики по этому запросу не созданы.`;
    } finally {
      if (epoch === gen.epoch) { gen.draftsBusy = false; renderGeneration(panel); }
    }
  }
  function bindGeneration(panel) {
    if (panel.dataset.cfGenBound) return;
    panel.dataset.cfGenBound = 'true';
    panel.addEventListener('click', (event) => {
      const action = event.target.closest('[data-cf-gen]')?.dataset.cfGen;
      if (action === 'start') void startGeneration(panel, false);
      if (action === 'resend') void startGeneration(panel, true);
      if (action === 'drafts') void createDrafts(panel);
      if ((action === 'select-visible' || action === 'clear') && shownJob()) {
        const job = shownJob(), v = jobView(job.id);
        if (action === 'clear') v.selection.clear();
        else for (const item of job.proposals || []) if (!v.hidden.has(item.platform) && !v.drafts.has(item.ideaId)) v.selection.add(item.ideaId);
        renderGeneration(panel);
      }
      if (action === 'view-latest') { gen.viewJobId = null; gen.message = ''; renderGeneration(panel); }
      const view = event.target.closest('[data-cf-gen-view]');
      if (view) {
        const id = view.dataset.cfGenView, job = gen.jobs.find((item) => item && String(item.id) === id && item.month === gen.month && item.status === 'succeeded');
        gen.viewJobId = job && job !== latestJob() ? id : null;
        gen.message = gen.viewJobId ? `Открыт прежний план от ${jobWhen(job)}. Новая задача и её состояние — выше.` : 'Этот план недоступен — показана последняя задача.';
        renderGeneration(panel);
        panel.querySelector('[data-cf-gen-viewed]')?.scrollIntoView?.({block: 'start'});
      }
      const open = event.target.closest('[data-cf-gen-open]');
      if (open) window.dispatchEvent(new window.CustomEvent('sb:content-factory-open-draft', {detail: {companyCode: gen.code, postId: Number(open.dataset.cfGenOpen)}}));
    });
    panel.addEventListener('change', (event) => {
      const select = event.target.closest('[data-cf-gen-select]'), platform = event.target.closest('[data-cf-gen-platform]');
      const job = shownJob(), v = job && jobView(job.id);
      // Отметка относится к задаче, в карточке которой нажата: другая задача её не получает.
      if (select && v && select.closest('[data-cf-job]')?.dataset.cfJob === String(job.id)) { if (select.checked) v.selection.add(select.dataset.cfGenSelect); else v.selection.delete(select.dataset.cfGenSelect); renderGeneration(panel); }
      if (platform && v) { if (platform.checked) v.hidden.delete(platform.dataset.cfGenPlatform); else v.hidden.add(platform.dataset.cfGenPlatform); renderGeneration(panel); }
      if (event.target.id === 'cf-gen-month' && /^\d{4}-\d{2}$/.test(event.target.value)) void compose(panel, event.target.value);
    });
  }
  async function compose(panel, requestedMonth) {
    const ctx = barCtx, epoch = ++composeEpoch, code = String(ctx.selectedProjectId || '').toLowerCase();
    stopPolling();
    gen.epoch++;
    const sameScope = gen.code === code && (!requestedMonth || requestedMonth === gen.month);
    Object.assign(gen, {code, jobs: sameScope ? gen.jobs : [], unavailable: false, loadError: '', busy: false, draftsBusy: false, resend: false,
      pendingRequestId: sameScope ? gen.pendingRequestId : null, message: '', delay: 3000});
    if (!sameScope) resetViews();
    panel.hidden = false;
    panel.innerHTML = '<p class="cf-note">Собираем сводку вводных…</p>';
    bindGeneration(panel);
    try {
      const [mentor, inputs] = await Promise.all([ctx.crmQuery('/media-mentor', {companyCode: code}), ctx.crmQuery('/media-mentor/inputs', {companyCode: code})]);
      const target = requestedMonth || monthNow(inputs.timezone);
      const month = await ctx.crmQuery(`/media-mentor/inputs/months/${target}`, {companyCode: code});
      if (epoch !== composeEpoch || mentor.companyCode !== code || inputs.companyCode !== code || month.companyCode !== code) return;
      gen.month = month.month;
      gen.data = {brief: mentor.brief, inputs, monthData: month, platforms: inputs.vocabulary?.platforms || [],
        formats: inputs.vocabulary?.formats || mentor.vocabulary?.formats || [], roles: inputs.vocabulary?.roles || mentor.vocabulary?.roles || []};
      const b = mentor.brief.fields, p = inputs.profile.fields;
      const missing = [['продукт', b.product], ['ситуацию и задачу покупателя', (b.pains || []).length], ['аудиторию', b.audience]].filter(([, v]) => !v).map(([name]) => name);
      const genders = p.genders.length === 2 ? 'женщины и мужчины' : p.genders.length ? (p.genders[0] === 'women' ? 'женщины' : 'мужчины') : 'пол не указан';
      const age = p.ageFrom === null && p.ageTo === null ? 'возраст без ограничения' : `возраст ${p.ageFrom ?? ''}–${p.ageTo ?? ''}`;
      panel.dataset.missing = String(Boolean(missing.length));
      // CF7: выбранные форматы и цели месяца видны до запуска; пустой выбор — «все подходящие».
      const mi = month.inputs || {}, limitsHref = `#content-factory/settings?${new URLSearchParams({company: code, month: month.month, focus: 'formats'})}`;
      const limits = gen.data.formats.length && gen.data.roles.length
        ? `<p class="cf-gen-limits" data-cf-gen-limits>Ограничения месяца: форматы — ${esc(choiceText(gen.data.formats, 'formats', mi.formats))}; цели (ОВП) — ${esc(choiceText(gen.data.roles, 'roles', mi.roles))}. <a href="${esc(limitsHref)}">Изменить</a></p>
          ${Array.isArray(mi.platforms) && mi.perDay && shortsConflict(mi) ? '<p class="cf-warning" data-cf-gen-shorts>Для YouTube Shorts в выбранных форматах нет «Reels / Shorts / клип» — план попросит уточнение и не будет составлен, пока выбор не исправлен.</p>' : ''}` : '';
      panel.innerHTML = `<h3>Составить план и предложения месяца</h3>
        ${missing.length ? `<p class="cf-warning">Сначала заполните: ${esc(missing.join(', '))}. <a href="#content-factory/settings">Перейти в «Настройки модуля»</a>.</p>` : ''}
        <details class="cf-summary-box"><summary>Вводные: ${esc(b.product || 'продукт не указан')}</summary>
        <dl class="cf-summary"><div><dt>Продукт</dt><dd>${esc(b.product || '—')}</dd></div>
          <div><dt>Ситуация покупателя</dt><dd>${esc((b.pains || []).join('; ') || '—')}</dd></div>
          <div><dt>Аудитория</dt><dd>${esc(b.audience || '—')} · ${esc(genders)} · ${esc(age)}</dd></div>
          <div><dt>Месяц ${esc(month.month)}</dt><dd>${month.publicationCount ? `${esc(month.publicationCount)} публикаций по пожеланиям месяца` : 'пожелания месяца не заданы'}</dd></div></dl>
        <p><a href="#content-factory/settings">Изменить вводные</a></p></details>
        ${limits}
        <div class="cf-actions cf-gen-launch"><label class="cf-month-pick">Месяц <input id="cf-gen-month" type="month" value="${esc(month.month)}"></label>
          ${canEdit(ctx) ? '<button class="plain-button" type="button" data-cf-gen="start">Составить план</button><button class="plain-button" type="button" data-cf-gen="resend" hidden>Отправить ещё раз</button>' : '<span class="cf-note">Запуск доступен с правом «Автопостинг: правка».</span>'}</div>
        <p class="cf-note" data-cf-gen-state role="status"></p>
        <div data-cf-gen-job aria-live="polite"><p class="cf-note">Проверяем состояние составления…</p></div>
        <p class="cf-note">Ничего не согласуется, не планируется и не публикуется автоматически.</p>`;
      renderGeneration(panel);
      await loadJobs(panel);
    } catch (error) {
      if (epoch === composeEpoch) panel.innerHTML = `<p class="crm-error" role="alert">Не удалось собрать сводку: ${esc(error.message)}</p>`;
    }
  }
  function createPublication(bar) {
    const doc = bar.ownerDocument, go = () => {
      const editor = doc.getElementById('autoposting-editor'), select = doc.getElementById('autoposting-select');
      const status = bar.querySelector('[data-factory-bar-status]');
      if (!editor) { status.textContent = 'Редактор материалов ещё загружается. Повторите через мгновение.'; return; }
      editor.open = true;
      // Открытый материал не подменяется: при выбранной карточке фокус на выборе «Новый черновик».
      if (select && select.value !== '') { select.focus(); status.textContent = 'Выберите «Новый черновик» в списке материалов.'; }
      else { doc.getElementById('autoposting-title')?.focus(); status.textContent = 'Новый черновик: заполните название и материал. Ничего не публикуется до согласования и назначения времени.'; }
    };
    if (!/^#content-factory\/plan(?:\?|$)/.test(doc.defaultView.location.hash)) { barCtx?.navigate?.('content-factory/plan'); setTimeout(go, 0); }
    else go();
  }
  function bindPlanBar(bar, ctx) {
    barCtx = ctx;
    // Смена компании закрывает сводку и останавливает опрос: состояние прежней компании не показывается.
    const panel = bar?.querySelector('#content-factory-compose'), code = String(ctx?.selectedProjectId || '').toLowerCase();
    if (panel && gen.code && gen.code !== code) {
      stopPolling(); gen.epoch++; composeEpoch++; gen.code = ''; gen.jobs = []; resetViews();
      panel.hidden = true; panel.innerHTML = '';
    }
    if (barBound || !bar) return;
    barBound = true;
    bar.addEventListener('click', (event) => {
      const action = event.target.closest('[data-factory-action]')?.dataset.factoryAction;
      if (action === 'compose') void compose(bar.querySelector('#content-factory-compose'));
      if (action === 'create') createPublication(bar);
    });
  }

  sb.contentFactory = {bindPlanBar, monthNow};
  sb.registerView('content-factory-settings', {title: 'Настройки модуля', render: renderSettings,
    onProjectChange: (ctx) => { const node = document.querySelector('[data-view="content-factory-settings"]') || document.querySelector('#view'); if (node) renderSettings(node, ctx); }});
  sb.registerView('content-factory-stats', {title: 'Статистика контента', render: renderStats,
    onProjectChange: (ctx) => { const node = document.querySelector('[data-view="content-factory-stats"]') || document.querySelector('#view'); if (node) void renderStats(node, ctx); }});
})();
