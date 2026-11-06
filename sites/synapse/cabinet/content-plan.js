(() => {
  'use strict';
  /* №98 Б «Контент → Контент-план» — модуль 'content-plan' по контракту А
     (specs/098-content-shell/contracts/module-registry.md). Анкета (автосохранение частями), план по анкете
     через Хью (существующая подсказка Медиа-наставника), краткий вид и полный табличный («как Google Таблица»),
     импорт CSV/XLSX из PR 496, согласование галочками → «к СММ». Хранилище — существующий план /media-mentor.
     Публикаций здесь нет. Всё, что пришло с сервера, выводится как текст. */
  const sb = window.SbCabinet = window.SbCabinet || {};
  const CRM = 'crm/media-mentor', SUGGEST = 'media-mentor-suggest';
  const Q = [['goals', 'Цели', 'Чего ждём от контента: записи, узнаваемость, доверие…'],
    ['audience', 'Аудитория', 'Кто смотрит, их ситуация и вопросы'],
    ['tone', 'Тон', 'Например: дружески, с юмором, без канцелярита'],
    ['rubrics', 'Рубрики', 'По строке на рубрику'],
    ['frequency', 'Частота', 'Например: 7 рилсов в неделю, Telegram ежедневно'],
    ['onCamera', 'Кто в кадре', 'Мастера, администратор, клиенты (с согласия)…'],
    ['constraints', 'Ограничения', 'Чего нельзя показывать и говорить']];
  const STAGE = {none: 'Плана ещё нет', approval: 'На согласовании', smm: 'Согласовано — к СММ, в «Съёмке»'};
  const VSTATUS = {approved: 'Согласовано', pending: 'На согласовании', rejected: 'На доработке', empty: 'Нет подписи', excluded: 'Исключено'};
  const PROD = {planned: 'Запланировано', shot: 'Отснято', editing: 'В монтаже', draft: 'Черновик'};
  const REEL = ['topic', 'hook', 'script', 'broll', 'style', 'props', 'filmingBy'];
  const LABEL = {topic: 'Тема', hook: 'Хук — первые 1–2 с', script: 'Сценарий (строка «Имя: реплика»)', broll: 'Вставки (B-roll)',
    style: 'Стиль', props: 'Реквизит', filmingBy: 'Кто снимает', caption: 'Подпись к публикации'};
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const day = (iso) => { try { return new Date(iso + 'T00:00:00Z').toLocaleDateString('ru-RU', {day: '2-digit', month: '2-digit', weekday: 'short', timeZone: 'UTC'}); } catch { return iso; } };
  const isoIn = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  /* Сценарий по ролям: «Имя: реплика». Строка без имени — действие/ремарка. */
  const roles = (script) => String(script || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const m = /^([^:]{1,40}):\s*(.+)$/.exec(line);
    return m ? {actor: m[1].trim(), line: m[2]} : {actor: '', line};
  });
  const caption = (idea) => idea.variants?.[idea.platform]?.text || Object.values(idea.variants || {}).find((v) => v.text)?.text || '';
  const rolesTable = (lines) => `<table class="cp-script"><tbody>${lines.map((l) => `<tr><th scope="row">${esc(l.actor || '—')}</th><td>${esc(l.line)}</td></tr>`).join('')}</tbody></table>`;
  /* Макет Влада 07.11: значки площадок — цветные кружки с подписью, без логотипов. */
  const NET = {telegram: ['TG', '#229ed9'], vk: ['VK', '#0077ff'], youtube_shorts: ['YT', '#e62117'], youtube: ['YT', '#e62117'],
    tiktok: ['TT', '#111'], instagram: ['IG', '#d6249f'], max: ['MAX', '#6b4eff'], two_gis: ['2Г', '#2f9e44']};
  /* «Сценарий по секундам» строится только из сценария плана. Строка «0–2 с | Кто | Реплика | В кадре | Действие | Титр»
     (копия из Google Таблицы) раскладывается по колонкам; иначе — время в начале строки (если есть) и «Имя: реплика»,
     «Кадр:»/«В кадре:», «Титр:», «Вставка:»/«[…]»/«Действие:». Пустые колонки не показываются. */
  const SEC = ['Время', 'Кто говорит', 'Реплика', 'В кадре', 'Действие / монтаж', 'Титр'];
  const TIME = /^(\d+(?:[.,]\d+)?(?:\s*[–—-]\s*\d+(?:[.,]\d+)?)?\s*с(?:ек)?\.?)(?:\s*[·|:—–-]\s*|\s+)/i;
  const seconds = (script) => String(script || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((raw) => {
    if (raw.includes('|')) { const c = raw.split('|').map((x) => x.trim()); if (!TIME.test(c[0] + ' ')) c.unshift(''); return SEC.map((_, i) => c[i] || ''); }
    const row = ['', '', '', '', '', '']; let rest = raw; const t = TIME.exec(rest);
    if (t) { row[0] = t[1]; rest = rest.slice(t[0].length).trim(); }
    let m;
    if ((m = /^(?:в кадре|кадр|план)\s*[:—-]\s*(.+)$/i.exec(rest))) row[3] = m[1];
    else if ((m = /^(?:титр|текст на экране)\s*[:—-]\s*(.+)$/i.exec(rest))) row[5] = m[1];
    else if ((m = /^(?:вставка|b-?roll|перебивка|действие|монтаж)\s*[:—-]\s*(.+)$/i.exec(rest)) || (m = /^\[(.+)\]$/.exec(rest))) row[4] = m[1];
    else if ((m = /^([^:]{1,40}):\s*(.+)$/.exec(rest))) { row[1] = m[1].trim(); row[2] = m[2]; }
    else row[4] = rest;
    return row;
  });
  function secondsTable(script) {
    const rows = seconds(script); if (!rows.length) return '';
    const cols = SEC.map((_, i) => i).filter((i) => rows.some((r) => r[i]));
    return `<div class="cp-secs"><b>Сценарий по секундам</b><table class="cp-sec"><thead><tr>${cols.map((i) => `<th scope="col">${SEC[i]}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${cols.map((i) => `<td data-label="${SEC[i]}">${esc(r[i])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  /* Доступ к API только через ctx контракта А: компания, CSRF и сессия добавляются оболочкой. */
  const io = (ctx) => ({
    get: (path) => ctx.api.get(CRM + path),
    put: (path, body) => ctx.api.put(CRM + path, body),
    post: (path, body) => ctx.api.post(CRM + path, body),
    suggest: (body) => ctx.api.post(SUGGEST, body)
  });
  /* Прежний импорт PR 496 ждёт контекст вида кабинета — даём ему узкий переходник поверх ctx.api. */
  const legacyCtx = (ctx) => ({
    identity: {role: ctx.user?.role, permissions: ctx.can('autoposting.edit') ? ['autoposting.edit'] : []},
    csrfOptions: (method, body) => ({method, body}),
    crmQuery: (path, params, options = {}) => ctx.api[(options.method || 'GET') === 'GET' ? 'get' : options.method.toLowerCase()](
      'crm' + path, ...(options.method && options.method !== 'GET' ? [options.body] : []))
  });

  let state = null, epoch = 0;
  const sortKey = ctx => `sb-content-plan:${ctx.user?.id || ctx.user?.login || 'user'}:${ctx.companyCode}:sort`;
  const savedSort = ctx => { try { const value = localStorage.getItem(sortKey(ctx)); return ['date','platform','status'].includes(value) ? value : 'date'; } catch { return 'date'; } };
  const sheetLink = value => { try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'docs.google.com' && !u.port && !u.username && !u.password && /^\/spreadsheets\/d\/[\w-]+(?:\/|$)/.test(u.pathname) ? u.href : ''; } catch { return ''; } };

  async function mount(container, ctx) {
    const mine = ++epoch, code = String(ctx.companyCode || '').toLowerCase(), api = io(ctx);
    if (!code) { container.innerHTML = '<p class="cp-note">Выберите компанию.</p>'; return; }
    container.innerHTML = '<p class="cp-note" role="status">Загружаем контент-план…</p>';
    try {
      const [mentor, questionnaire, signoffs, settings] = await Promise.all([api.get(''), api.get('/questionnaire'), api.get('/plan/signoffs'),
        // Настройки → Контент (агент А) могут быть ещё не выпущены: экран работает и без них.
        Promise.resolve().then(() => ctx.settings?.content?.get()).catch(() => null)]);
      if (mine !== epoch || ctx.signal?.aborted) return;
      const view = ctx.route?.params?.get?.('view') === 'full' ? 'full' : 'short';
      state = {code, ctx, api, container, mentor, questionnaire, signoffs, settings: settings || null,
        tab: 'plan', qOpen: false, qMode: 'edit', sort: savedSort(ctx), sortOpen: false, editDrafts: new Map(), view, open: state?.code === code ? state.open : new Set(), pending: {}, saving: null, suggestion: null};
      draw();
    } catch (error) {
      if (mine === epoch && !ctx.signal?.aborted) container.innerHTML = `<p class="cp-error" role="alert">${esc(error.status === 403
        ? 'Нет доступа к контент-плану этой компании.' : error.message || 'Не удалось загрузить контент-план')}</p>`;
    }
  }

  function approversNote() {
    const {settings, signoffs: s, ctx} = state, ids = settings?.settings?.approverUserIds || [];
    const names = ids.map((id) => settings.candidates?.find((c) => c.id === id)?.name || `#${id}`);
    const set = ctx.can('settings.edit') ? ' <button type="button" class="plain-button cp-small" data-cp="settings">Настроить</button>' : '';
    if (!settings) return `<p class="cp-note">Кто согласует, задаётся в «Настройках → Контент». Пока согласует владелец.${set}</p>`;
    if (!ids.length) return `<p class="cp-note">В «Настройках → Контент» согласующие не выбраны — согласует владелец.${set}</p>`;
    return `<p class="cp-note">Согласуют по «Настройкам → Контент»: ${esc(names.join(', '))}.${set}</p>${s.approversSource === 'stub'
      ? '<p class="cp-warn">Сервер не принял выбранных согласующих (нет права «согласование контент-плана» в этой компании) — пока согласует владелец.</p>' : ''}`;
  }

  function draw() {
    const drafts = state.editDrafts; state.container.querySelectorAll('[data-edit] textarea').forEach(n => drafts.set(n.closest('[data-edit]').dataset.edit + ':' + n.name,n.value));
    const {mentor, questionnaire: q, signoffs: s, ctx, container} = state, edit = ctx.can('autoposting.edit');
    const owner = ctx.identity?.role === 'owner' || ctx.user?.role === 'owner';
    const vocab = mentor.vocabulary || {platforms: []}, platformLabel = (id) => vocab.platforms.find((p) => p.id === id)?.label || id;
    const allDays = mentor.plan?.days || [], states = mentor.variants || [];
    const statusOf = (idea) => { const list = states.filter((v) => v.ideaId === idea.ideaId);
      return list.find((v) => v.status === 'rejected')?.status || list.find((v) => v.status === 'pending')?.status
        || list.find((v) => v.status === 'approved')?.status || list[0]?.status || 'empty'; };
    const platforms = (idea) => Object.keys(idea.variants || {[idea.platform]: 1}).map(platformLabel).join(', ');
    const status = (idea) => { const st = statusOf(idea);
      /* Влад 06.11: у строки один статус. Пока не согласовано — статус согласования; после — ход работы (Отснято, В монтаже). */
      const prod = st === 'approved' && ['shot', 'editing'].includes(idea.productionStatus) ? idea.productionStatus : '';
      return `<span class="cp-st" data-status="${esc(prod || st)}">${esc(prod ? PROD[prod] : (VSTATUS[st] || st))}</span>`; };
    /* №141: есть план (хоть одна строка) — сразу краткий вид плана, анкета свёрнута в одну строку внизу.
       Плана нет — порядок прежний: анкета сверху и открыта, пока не заполнена. */
    const days = allDays.filter(idea => state.tab === 'drafts' ? idea.productionStatus === 'draft' : idea.productionStatus !== 'draft').slice().sort((a,b) => {
      const primary = state.sort === 'platform' ? platforms(a).localeCompare(platforms(b),'ru') : state.sort === 'status' ? statusOf(a).localeCompare(statusOf(b),'ru') : 0;
      return primary || String(a.date || '').localeCompare(String(b.date || '')) || String(a.ideaId).localeCompare(String(b.ideaId));
    });
    const sheetUrl = sheetLink(state.settings?.settings?.contentPlanSheetUrl);
    const head = `<nav class="cp-tabs cp-head" aria-label="Планы"><div role="tablist" aria-label="Список публикаций">
      <button type="button" role="tab" data-cp-tab="plan" aria-selected="${state.tab === 'plan'}" aria-controls="cp-publications">Контент-план</button>
      <button type="button" role="tab" data-cp-tab="drafts" aria-selected="${state.tab === 'drafts'}" aria-controls="cp-publications">Черновики</button>
      ${edit ? '<button type="button" class="cp-new" data-cp="questionnaire">+ Новый</button>' : ''}</div>
      </nav>`;
    /* №186: анкеты нет на вкладке. Окно поверх открывают «+ Новый» (новый план) и ⚙ (настройка текущего). На телефоне — на весь экран:
       «←» и крестик сверху, главная кнопка закреплена внизу. Поля сохраняются сами, как раньше. */
    const questionnaire = !state.qOpen ? '' : `<div class="cp-modal" data-cp-modal role="dialog" aria-modal="true" aria-labelledby="cp-q-title">
      <div class="cp-modal-bar"><button type="button" class="cp-back" data-cp-close aria-label="Назад к контент-плану">←</button>
        <h3 id="cp-q-title">${state.qMode === 'new' ? 'Новый контент-план' : 'Настройка контент-плана'} · анкета <span data-cp-q-count>заполнено ${q.filled} из ${q.total}</span></h3>
        <button type="button" class="cp-x" data-cp-close aria-label="Закрыть">✕</button></div>
      <div class="cp-modal-body cp-q">
        <p class="cp-note">Можно заполнять частями и дополнять потом: каждое поле сохраняется само. ${esc((q.rules || []).join(' '))}</p>
        <form class="cp-q-form" data-cp-form>${Q.map(([key, label, hint]) => `<label>${label}<textarea data-q="${key}" rows="2" maxlength="2000" placeholder="${esc(hint)}" ${edit ? '' : 'readonly'}>${esc(q.fields[key])}</textarea></label>`).join('')}
          <fieldset data-cp-platforms tabindex="-1"><legend>Площадки</legend>${vocab.platforms.map((p) => `<label class="cp-check"><input type="checkbox" data-q-platform="${esc(p.id)}" ${q.fields.platforms.includes(p.id) ? 'checked' : ''} ${edit ? '' : 'disabled'}> ${esc(p.label)}</label>`).join('')}</fieldset>
        </form><p class="cp-note" data-cp-saved role="status">${q.updatedAt ? `Сохранено${q.updatedBy ? ' · ' + esc(q.updatedBy) : ''}` : 'Ещё не сохранялась'}</p>
        ${edit ? '<div data-cp-suggest></div><div data-cp-import></div>' : ''}</div>
      <div class="cp-modal-foot">${edit ? `<div class="cp-gen"><label><span>Начало</span><input type="date" data-cp-start value="${isoIn(1)}"></label>
          <label><span>Дней</span><select data-cp-days><option>7</option><option>14</option></select></label>
          <button type="button" class="plain-button" data-cp="generate">Сформировать план через Хью</button></div>`
        : '<button type="button" class="plain-button" data-cp-close>Закрыть</button>'}</div></div>`;
    const approve = `<section class="cp-card cp-approve"><h3>Согласование</h3>
        ${s.planRevision ? `<ul class="cp-approvers">${s.approvers.map((a) => `<li><label class="cp-check"><input type="checkbox" data-signoff="${esc(a.slot)}" ${a.checked ? 'checked' : ''} ${a.canCheck ? '' : 'disabled'}> ${esc(a.label)}${a.userId && a.userId === ctx.user?.id ? ' (вы)' : ''}</label>
          <span class="cp-note">${a.checked ? `✓ ${esc(a.actorName)}` : 'ждёт отметки'}</span></li>`).join('')}</ul>
          ${s.emptyIdeas.length ? `<p class="cp-warn">Без подписи — не войдут в согласование: ${s.emptyIdeas.length}. Откройте строку и заполните подпись.</p>` : ''}`
          : '<p class="cp-note">Согласовывать пока нечего: сначала сформируйте или импортируйте план.</p>'}
        ${approversNote()}<p class="cp-note">Согласовано материалов: ${s.approvedIdeas} из ${s.ideas}. Когда отметят все — план уходит к СММ и в «Съёмку».</p></section>`;
    const plan = `<section class="cp-plan" id="cp-publications" role="tabpanel" aria-label="${state.tab === 'drafts' ? 'Черновики' : 'Контент-план'}"><div class="cp-list-head"><h3>Публикации</h3>
      <div class="cp-tools"><button type="button" class="cp-gear" data-cp="settings-plan" aria-label="Выбор и настройка контент-плана" title="Выбор и настройка контент-плана" aria-haspopup="dialog">⚙</button>
      ${sheetUrl ? `<a class="cp-sheet-link" href="${esc(sheetUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Открыть Google Таблицу" title="Google Таблица">▦</a>` : ''}
      <div class="cp-sort"><button type="button" data-cp-sort-toggle aria-label="Сортировать публикации" aria-expanded="${state.sortOpen}" aria-controls="cp-sort-menu">⇅</button>
      <div id="cp-sort-menu" role="group" aria-label="Сортировка" ${state.sortOpen ? '' : 'hidden'}>${[['date','По дате'],['platform','По площадке'],['status','По статусу']].map(([value,label])=>`<button type="button" data-cp-sort="${value}" aria-pressed="${state.sort === value}">${state.sort === value ? '✓ ' : ''}${label}</button>`).join('')}</div></div></div></div>
      ${!days.length ? `<p class="cp-note">${allDays.length ? 'В этом списке пока нет публикаций.' : 'Плана пока нет. Нажмите «+ Новый», чтобы заполнить анкету и сформировать план.'}</p>` : ''}
      ${state.view === 'full' ? sheet(days, platforms, status) : `${days.length ? '<div class="cp-thead" aria-hidden="true"><span>Дата</span><span>Тема</span><span>Площадки</span><span>Статус</span><span></span></div>' : ''}
      <ol class="cp-list">${days.map((idea) => {
        /* Макет Влада 07.11: дата и статус; тема со стрелкой ▾/▴ (не кнопка-стрелка — раскрывает вся карточка, кроме кнопок);
           ниже «Сменить статус ▾» и значки площадок. На ПК те же элементы стоят колонками таблицы. */
        const open = state.open.has(idea.ideaId), st = statusOf(idea);
        return `<li class="cp-row" data-idea="${esc(idea.ideaId)}"><div class="cp-top"><span class="cp-date">${esc(day(idea.date))}</span>${status(idea)}</div>
          <button type="button" class="cp-line" data-toggle aria-expanded="${open}"><span class="cp-topic">${esc(idea.topic)}</span><span class="cp-chev" aria-hidden="true">${open ? '▴' : '▾'}</span></button>
          ${open ? full(idea, edit, st, status) : ''}
          <div class="cp-acts">${owner && mentor.plan?.revision && st !== 'empty' && st !== 'excluded' ? `<button type="button" class="cp-act" data-cp-menu aria-haspopup="menu" aria-expanded="${state.menuOpen === idea.ideaId}">Сменить статус ▾</button>` : ''}${nets(idea, platformLabel)}</div>
          ${owner && state.menuOpen === idea.ideaId ? rowMenu(idea, st) : ''}</li>`; }).join('')}</ol>`}</section>`;
    container.innerHTML = `<section class="cp" data-cp-layout="plan">${head}
      ${plan}${approve}
      <p class="cp-error" data-cp-error role="alert" hidden></p>${questionnaire}</section>`;
    container.querySelectorAll('[data-edit] textarea').forEach(n => { const key = n.closest('[data-edit]').dataset.edit + ':' + n.name; if (drafts.has(key)) n.value = drafts.get(key); });
    wire();
    if (!sheetUrl && ctx.user?.role === 'owner') {
      const hint = document.createElement('button'); hint.type = 'button'; hint.className = 'plain-button'; hint.textContent = 'Указать таблицу'; hint.onclick = () => ctx.navigate('settings/content');
      container.querySelector('.cp-q')?.append(hint);
    }
    if (edit) installImport();
  }

  /* Полный план — одна строка на рилс, как в таблице «КОНТЕНТ ПЛАН»; на телефоне строки становятся карточками. */
  function sheet(days, platforms, status) {
    const cols = ['№', 'Дата', 'Площадки', 'Тема', 'Хук (1–2 с)', 'Вставки (B-roll)', 'Стиль', 'Сценарий по ролям', 'Реквизит', 'Кто снимает', 'Статус'];
    const cell = (i, html) => `<td data-label="${esc(cols[i])}">${html}</td>`;
    return `<div class="cp-sheet-wrap"><table class="cp-sheet"><thead><tr>${cols.map((c) => `<th scope="col">${c}</th>`).join('')}</tr></thead><tbody>
      ${days.map((idea, index) => { const lines = roles(idea.script);
        return `<tr data-idea="${esc(idea.ideaId)}">${cell(0, `<button type="button" class="cp-link" data-open-row>№${index + 1}</button>`)}${cell(1, esc(day(idea.date)))}
        ${cell(2, esc(platforms(idea)))}${cell(3, `<b>${esc(idea.topic)}</b>`)}${cell(4, esc(idea.hook))}${cell(5, esc(idea.broll))}${cell(6, esc(idea.style))}
        ${cell(7, lines.length ? rolesTable(lines) : '')}${cell(8, esc(idea.props))}${cell(9, esc(idea.filmingBy))}${cell(10, status(idea))}</tr>`; }).join('')}
      </tbody></table></div>`;
  }

  /* Площадки, на которые запланирован рилс: версии идеи без исключённых. Нет площадок — нет значков. */
  function nets(idea, label) {
    const ids = Object.keys(idea.variants || {}).filter((id) => !idea.variants[id]?.excluded);
    if (!ids.length) return '';
    return `<span class="cp-nets" role="img" aria-label="Площадки: ${esc(ids.map(label).join(', '))}">${ids.map((id) => {
      const [abbr, color] = NET[id] || [String(id).slice(0, 3).toUpperCase(), '#667085'];
      return `<span class="cp-nb" style="background:${color}" title="${esc(label(id))}">${esc(abbr)}</span>`; }).join('')}</span>`;
  }

  /* Макет Влада 06–07.11: «Сменить статус ▾» → этапы с неяркими цветами. Решение по одной идее (scope: idea) через
     существующий media-mentor decideVariants: «Согласовано» = approved (дальше рилс идёт в «Съёмку»),
     «На согласовании» = withdrawn (отмена согласования), «Внести правки» → поле и «Отправить» = rejected с комментарием.
     Согласует владелец; остальным кнопка не показывается, сервер проверяет право сам. */
  function rowMenu(idea, st) {
    const busy = state.rowBusy === idea.ideaId ? ' disabled' : '', fixing = state.fixOpen === idea.ideaId;
    const item = (stg, attr, label, current, off) => `<button type="button" role="menuitemradio" class="cp-stg" data-stg="${stg}" ${attr} aria-checked="${current}"${off || busy}>${label}</button>`;
    return `<div class="cp-pop"><div class="cp-menu" role="menu" aria-label="Сменить статус">
        ${item('wait', 'data-cp-decide="withdrawn"', 'На согласовании', st === 'pending', st === 'approved' ? '' : ' disabled')}
        ${item('ok', 'data-cp-decide="approved"', 'Согласовано', st === 'approved', st === 'approved' ? ' disabled' : '')}
        ${item('fix', 'data-cp-fix aria-expanded="' + fixing + '"', 'Внести правки', st === 'rejected', '')}</div>
      ${fixing ? `<form class="cp-fix" data-cp-fix-form><b>Внести правки</b><textarea name="comment" rows="3" required aria-label="Правка" placeholder="Напишите правку: что изменить в сценарии..."></textarea>
        <div class="cp-fix-btns"><button type="submit" class="plain-button"${busy}>Отправить</button><button type="button" class="cp-act" data-cp-fix-cancel>Закрыть</button></div></form>` : ''}</div>`;
  }

  async function decide(ideaId, decision, comment) {
    const {api, mentor} = state; state.rowBusy = ideaId; draw();
    try {
      await api.post('/plan/variants/decision', {planRevision: mentor.plan.revision, briefRevision: mentor.brief.revision,
        scope: 'idea', ideaId, decision, comment: comment || ''});
      state.fixOpen = null; state.menuOpen = null; state.rowBusy = null; await mount(state.container, state.ctx);
    } catch (err) { state.rowBusy = null; draw(); error(err.status === 403 ? 'Согласовывать и возвращать на доработку может владелец кабинета.' : err.message); }
  }

  /* Полный вид: поля идеи, которые есть в плане (чего нет — не показываем), затем «Сценарий по секундам» и детали рилса. */
  function full(idea, edit, st, status) {
    const {mentor} = state, vocab = mentor.vocabulary || {};
    const block = (key, value) => value ? `<div><dt>${LABEL[key]}</dt><dd>${esc(value)}</dd></div>` : '';
    const comments = [...new Set((mentor.variants || []).filter((v) => v.ideaId === idea.ideaId && v.comment)
      .map((v) => (v.actorName ? v.actorName + ': ' : '') + v.comment))];
    const asset = idea.assetId && (mentor.brief?.fields?.assets || []).find((a) => a.id === idea.assetId);
    const fields = [['Дата', esc(day(idea.date))], ['Формат', esc((vocab.formats || []).find((f) => f.id === idea.format)?.label || idea.format || '')],
      ['Съёмка', esc(idea.filmingBy || '')], ['Статус', status(idea)], ['Комментарии', comments.map(esc).join('<br>')],
      ['Исходники', asset ? esc(asset.title) : '']].filter(([, v]) => v);
    return `<div class="cp-full"><dl class="cp-fgrid">${fields.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
      ${secondsTable(idea.script)}<dl>
      ${block('hook', idea.hook)}${block('broll', idea.broll)}${block('style', idea.style)}
      ${block('props', idea.props)}${block('caption', caption(idea))}
      ${idea.mentorNote ? `<div><dt>Задание Хью</dt><dd>${esc(idea.mentorNote)}</dd></div>` : ''}</dl>
      ${edit ? `<details class="cp-edit"><summary>Изменить</summary><form data-edit="${esc(idea.ideaId)}">
        ${[...REEL, 'caption'].map((key) => `<label>${LABEL[key]}<textarea name="${key}" rows="${key === 'script' ? 6 : 2}">${esc(key === 'caption' ? caption(idea) : idea[key] || '')}</textarea></label>`).join('')}
        <button type="submit" class="plain-button">Сохранить строку</button><p class="cp-note">После правки строка снова уходит на согласование.</p></form></details>` : ''}</div>`;
  }

  const error = (message) => { const node = state.container.querySelector('[data-cp-error]'); if (node) { node.hidden = !message; node.textContent = message || ''; } };

  /* Автосохранение анкеты: одно поле — одна правка, запросы идут строго по очереди с последней ревизией. */
  function queueSave(patch) {
    Object.assign(state.pending, patch);
    clearTimeout(state.timer);
    state.timer = setTimeout(flush, 700);
  }
  async function flush() {
    if (!state || state.saving || !Object.keys(state.pending).length) return;
    const mine = state, fields = mine.pending; mine.pending = {};
    const saved = mine.container.querySelector('[data-cp-saved]');
    if (saved) saved.textContent = 'Сохраняем…';
    mine.saving = (async () => {
      try {
        mine.questionnaire = await mine.api.put('/questionnaire', {revision: mine.questionnaire.revision, fields});
        const count = `заполнено ${mine.questionnaire.filled} из ${mine.questionnaire.total}`;
        if (saved) saved.textContent = `Сохранено · ${count}`;
        // №128: счётчик в заголовке анкеты обновляется вместе со статусом, без перезагрузки модуля.
        const head = mine.container.querySelector('[data-cp-q-count]');
        if (head) head.textContent = count;
      } catch (err) {
        if (saved) saved.textContent = err.status === 409 ? 'Анкету изменил другой человек — обновите страницу.' : `Не сохранено: ${err.message}`;
        if (err.status !== 409) mine.pending = {...fields, ...mine.pending};
      } finally { mine.saving = null; if (state === mine && Object.keys(mine.pending).length) queueSave({}); }
    })();
  }

  async function savePlan(days, reason) {
    const {mentor, api, ctx, container} = state;
    days = [...days].sort((a, b) => a.date.localeCompare(b.date));
    await api.put('/plan', {planRevision: mentor.plan?.revision || 0, briefRevision: mentor.brief.revision, days, reason});
    await mount(container, ctx);
  }

  /* Пустые поля брифа дополняются из анкеты; заполненные подтверждённые поля не переписываются.
     №136: площадки анкеты только добавляются в бриф — прежние не снимаются, чтобы строки уже
     сохранённого плана по ним оставались допустимыми; Хью получает только площадки анкеты. */
  const visiblePlatforms = () => { const boxes = [...state.container.querySelectorAll('[data-q-platform]')];
    return boxes.length ? boxes.filter((box) => box.checked).map((box) => box.dataset.qPlatform) : [...(state.questionnaire.fields?.platforms || [])]; };
  async function briefFromQuestionnaire() {
    const {mentor, questionnaire: q, api} = state, b = mentor.brief.fields || {}, patch = {};
    if (!b.goal && q.fields.goals) patch.goal = q.fields.goals;
    if (!b.audience && q.fields.audience) patch.audience = q.fields.audience;
    const known = b.platforms || [], missing = visiblePlatforms().filter((p) => !known.includes(p));
    if (missing.length) patch.platforms = [...known, ...missing];
    if (!Object.keys(patch).length) return;
    state.mentor = await api.put('/brief', {revision: mentor.brief.revision, brief: patch, reason: 'Пустые поля брифа дополнены из анкеты контент-плана'});
  }

  /* №128: площадки выбираются чекбоксами в анкете — подсказка ведёт туда, а не в «бриф», которого на экране нет. */
  const NO_PLATFORMS = 'Отметьте площадки в анкете выше.';
  function askPlatforms(node) {
    node.innerHTML = `<p class="cp-warn" role="alert">${NO_PLATFORMS}</p>`;
    const box = state.container.querySelector('[data-cp-platforms]');
    if (!box) return;
    (box.querySelector('input:not([disabled])') || box).focus();
  }

  async function generate(button) {
    const mine = state, node = mine.container.querySelector('[data-cp-suggest]');
    button.disabled = true; node.innerHTML = '<p class="cp-note" role="status">Хью составляет план… это может занять до минуты.</p>';
    try {
      clearTimeout(mine.timer); await flush(); await mine.saving;
      if (state !== mine) return;
      // №136: площадки — только из видимой анкеты; скрытый бриф не в счёт. Пусто — модель не вызывается.
      const platforms = visiblePlatforms();
      if (!platforms.length) { askPlatforms(node); return; }
      await briefFromQuestionnaire();
      const request = {startDate: mine.container.querySelector('[data-cp-start]').value,
        days: Number(mine.container.querySelector('[data-cp-days]').value)};
      let answer;
      try { answer = await mine.api.suggest({...request, platforms}); }
      catch (err) {
        // Сервер до №136 не знает поле platforms: повтор без него, лишние площадки отсекаются ниже.
        if (!/лишние поля/i.test(err.message || '')) throw err;
        answer = await mine.api.suggest(request);
      }
      if (state !== mine) return;
      if (Array.isArray(answer.items)) answer = {...answer, items: answer.items.filter((i) => platforms.includes(i.platform))};
      if (answer.status === 'brief_incomplete') { askPlatforms(node); return; }
      mine.suggestion = answer.status === 'ok' ? answer.items : [];
      node.innerHTML = mine.suggestion.length ? `<p class="cp-note">${esc(answer.notice || '')}</p><ol class="cp-suggest">${mine.suggestion.map((i) =>
        `<li><b>${esc(day(i.date))}</b> · ${esc(i.platform)} · ${esc(i.topic)}${i.hook ? `<br><span class="cp-note">Хук: ${esc(i.hook)}</span>` : ''}</li>`).join('')}</ol>
        <button type="button" class="plain-button" data-cp="accept">Добавить ${mine.suggestion.length} в план</button>`
        : `<p class="cp-warn">${esc(answer.notice || 'Хью не предложил материалов.')}</p>`;
      node.querySelector('[data-cp="accept"]')?.addEventListener('click', accept);
    } catch (err) { if (state === mine) node.innerHTML = `<p class="cp-error" role="alert">${esc(err.message || 'Не удалось сформировать план')}</p>`; }
    finally { button.disabled = false; }
  }

  /* Подпись версии — из хука и темы: без текста версия не согласуется и не попадает в счётчик пятницы. */
  async function accept() {
    const items = state.suggestion.map((i) => ({date: i.date, platform: i.platform, format: i.format, role: i.role, topic: i.topic,
      hook: i.hook || '', assetId: i.assetId || '', mentorNote: i.mentorNote || '',
      variants: {[i.platform]: {text: [i.hook, i.topic].filter(Boolean).join('\n\n')}}}));
    try { await savePlan([...(state.mentor.plan?.days || []), ...items], 'План сформирован Хью по анкете'); }
    catch (err) { error(err.message); }
  }

  /* Импорт CSV/XLSX — существующий модуль PR 496; добавленные строки сразу сохраняются в план. */
  function installImport() {
    const host = state.container.querySelector('[data-cp-import]'), mine = state;
    if (!host || !sb.reelPlanImport?.install) return;
    const anchor = document.createElement('div'); host.append(anchor);
    sb.reelPlanImport.install({node: host, data: mine.mentor, ctx: legacyCtx(mine.ctx), code: mine.code, form: anchor,
      collectDays: () => mine.mentor.plan?.days || [], isCurrent: () => state === mine,
      appendDays: (items) => { savePlan([...(mine.mentor.plan?.days || []), ...items], 'Импорт плана из CSV/XLSX').catch((err) => error(err.message)); }});
  }

  async function saveRow(form) {
    const id = form.dataset.edit, data = Object.fromEntries(new FormData(form));
    const days = state.mentor.plan.days.map((idea) => {
      if (idea.ideaId !== id) return idea;
      const next = {...idea};
      for (const key of REEL) next[key] = key === 'script' ? data[key].replace(/\r\n?/g, '\n') : data[key].trim();
      const platform = idea.variants?.[idea.platform] ? idea.platform : Object.keys(idea.variants || {})[0] || idea.platform;
      next.variants = {...idea.variants, [platform]: {...(idea.variants?.[platform] || {}), text: data.caption.trim()}};
      return next;
    });
    try { await savePlan(days, 'Строка плана изменена'); } catch (err) { error(err.message); }
  }

  async function signoff(input) {
    const {api, ctx, container, signoffs: s} = state; input.disabled = true;
    try {
      await api.post('/plan/signoffs', {planRevision: s.planRevision, briefRevision: s.briefRevision, slot: input.dataset.signoff, checked: input.checked});
      await mount(container, ctx);
    } catch (err) { input.checked = !input.checked; input.disabled = false; error(err.message); }
  }

  function openQuestionnaire(mode, opener) {
    state.qOpen = true; state.qMode = mode; state.qOpener = opener?.dataset?.cp || 'questionnaire';
    document.body.classList.add('cp-modal-open'); viewportPin(true); draw();
    state.container.querySelector('[data-cp-modal] textarea:not([readonly])')?.focus();
  }
  /* iPhone: при клавиатуре окно браузера сдвигается вверх и шапка анкеты уезжает за экран.
     Окно держим ровно в видимой области (visualViewport) — шапка всегда сверху, кнопка над клавиатурой. */
  function viewportPin(on) {
    const vv = window.visualViewport, root = document.documentElement;
    if (!vv) return;
    if (!on) { vv.removeEventListener('resize', pinSync); vv.removeEventListener('scroll', pinSync);
      root.style.removeProperty('--cp-vvh'); root.style.removeProperty('--cp-vvt'); return; }
    vv.addEventListener('resize', pinSync); vv.addEventListener('scroll', pinSync); pinSync();
  }
  function pinSync() {
    const vv = window.visualViewport, root = document.documentElement;
    root.style.setProperty('--cp-vvh', vv.height + 'px'); root.style.setProperty('--cp-vvt', vv.offsetTop + 'px');
  }
  function closeQuestionnaire() {
    if (!state) return;
    // Набранное, но ещё не ушедшее на сервер, остаётся в данных: сохранение продолжится само.
    Object.assign(state.questionnaire.fields, state.pending);
    state.qOpen = false; document.body.classList.remove('cp-modal-open'); viewportPin(false); draw();
    state.container.querySelector(`[data-cp="${state.qOpener}"]`)?.focus();
  }

  function wire() {
    const root = state.container, ctx = state.ctx;
    root.querySelectorAll('[data-q]').forEach((field) => field.addEventListener('input', () => queueSave({[field.dataset.q]: field.value})));
    root.querySelectorAll('[data-q-platform]').forEach((box) => box.addEventListener('change', () =>
      queueSave({platforms: [...root.querySelectorAll('[data-q-platform]:checked')].map((b) => b.dataset.qPlatform)})));
    /* Макет 07.11: раскрывает нажатие на любое место карточки, кроме кнопок, ссылок, полей и уже открытого полного вида. */
    root.querySelectorAll('.cp-row').forEach((row) => row.addEventListener('click', (event) => {
      const t = event.target;
      if (!t.closest('[data-toggle]') && t.closest('button, a, input, textarea, select, label, summary, form, .cp-full, .cp-pop')) return;
      if (!t.closest('[data-toggle]') && String(window.getSelection?.() || '')) return;
      const id = row.dataset.idea; state.open.has(id) ? state.open.delete(id) : state.open.add(id); draw();
      root.querySelector(`[data-idea="${id}"] [data-toggle]`)?.focus();
    }));
    root.querySelectorAll('[data-open-row]').forEach((button) => button.addEventListener('click', () => {
      state.open.add(button.closest('[data-idea]').dataset.idea); state.view = 'short'; draw();
    }));
    root.querySelectorAll('[data-cp-view]').forEach((button) => button.addEventListener('click', () => { state.view = button.dataset.cpView; draw(); }));
    root.querySelectorAll('[data-edit]').forEach((form) => form.addEventListener('submit', (event) => { event.preventDefault(); void saveRow(form); }));
    root.querySelectorAll('[data-signoff]').forEach((input) => input.addEventListener('change', () => void signoff(input)));
    root.querySelectorAll('[data-cp-menu]').forEach((button) => button.addEventListener('click', () => {
      const id = button.closest('[data-idea]').dataset.idea; state.menuOpen = state.menuOpen === id ? null : id; state.fixOpen = null; draw();
      root.querySelector('.cp-menu [role="menuitemradio"]:not([disabled])')?.focus(); }));
    root.querySelectorAll('[data-cp-decide]').forEach((button) => button.addEventListener('click', () =>
      void decide(button.closest('[data-idea]').dataset.idea, button.dataset.cpDecide)));
    root.querySelectorAll('[data-cp-fix]').forEach((button) => button.addEventListener('click', () => {
      const id = button.closest('[data-idea]').dataset.idea; state.fixOpen = state.fixOpen === id ? null : id; draw();
      root.querySelector('[data-cp-fix-form] textarea')?.focus(); }));
    root.querySelectorAll('[data-cp-fix-cancel]').forEach((button) => button.addEventListener('click', () => { state.fixOpen = null; state.menuOpen = null; draw(); }));
    root.querySelectorAll('[data-cp-fix-form]').forEach((form) => form.addEventListener('submit', (event) => { event.preventDefault();
      const comment = form.querySelector('textarea').value.trim(); if (!comment) { form.querySelector('textarea').focus(); return; }
      void decide(form.closest('[data-idea]').dataset.idea, 'rejected', comment); }));
    root.querySelector('[data-cp="questionnaire"]')?.addEventListener('click', (event) => openQuestionnaire('new', event.currentTarget));
    root.querySelector('[data-cp="settings-plan"]')?.addEventListener('click', (event) => openQuestionnaire('edit', event.currentTarget));
    root.querySelectorAll('[data-cp-close]').forEach((button) => button.addEventListener('click', closeQuestionnaire));
    root.querySelector('[data-cp="generate"]')?.addEventListener('click', (event) => void generate(event.currentTarget));
    root.querySelector('[data-cp="settings"]')?.addEventListener('click', () => ctx.navigate('settings/content'));
    root.querySelectorAll('[data-cp-tab]').forEach(button => button.onclick = () => { state.tab = button.dataset.cpTab; draw(); root.querySelector(`[data-cp-tab="${state.tab}"]`)?.focus(); });
    root.querySelector('[data-cp-sort-toggle]')?.addEventListener('click', () => { state.sortOpen = !state.sortOpen; draw(); root.querySelector('[data-cp-sort-toggle]')?.focus(); });
    root.querySelectorAll('[data-cp-sort]').forEach(button => button.onclick = () => {
      state.sort = button.dataset.cpSort; state.sortOpen = false; try { localStorage.setItem(sortKey(ctx),state.sort); } catch { /* сортировка работает в текущем сеансе */ } draw(); root.querySelector('[data-cp-sort-toggle]')?.focus();
    });
    root.onkeydown = event => { if (event.key === 'Escape' && state?.qOpen) { event.preventDefault(); closeQuestionnaire(); return; }
      if (event.key === 'Escape' && state?.menuOpen) { const id = state.menuOpen; state.menuOpen = null; state.fixOpen = null; draw();
        root.querySelector(`[data-idea="${id}"] [data-cp-menu]`)?.focus(); return; }
      if (event.key === 'Escape' && state?.sortOpen) { state.sortOpen = false; draw(); root.querySelector('[data-cp-sort-toggle]')?.focus(); } };
  }

  /* №186: на телефоне при фокусе в поле ввода нижнее меню не должно висеть над полем. Класс на body, правило — в workspace.css (≤760px). */
  if (!window.__sbKeyboardNav) {
    window.__sbKeyboardNav = true;
    const field = (n) => n && n.matches && n.matches('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]),textarea,select');
    const sync = () => document.body.classList.toggle('kbd-open', field(document.activeElement));
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', () => setTimeout(sync, 0));
  }

  const definition = {title: 'Контент-план', mount,
    unmount() { epoch++; if (state) clearTimeout(state.timer); state = null; document.body.classList.remove('cp-modal-open'); viewportPin(false); }};
  sb.contentPlan = {definition, roles};
  // Реестр каркаса (контракт А). Без реестра — очередь SynapseModulesQueue: реестр А разбирает её при загрузке.
  if (typeof window.SynapseModules?.register === 'function') window.SynapseModules.register('content-plan', definition);
  else (window.SynapseModulesQueue = window.SynapseModulesQueue || []).push(['content-plan', definition]);
})();
