/* Контент → Съёмка (№98 · В; макет Влада 07.11, задача доски №206). «Согласованные рилсы»: шапка CfKit
   (календарь, ▦ Google Таблица, ⇅ сортировка) и полоса дат, карточка как в Контент-плане — дата и этап,
   название с ▾ (нажатие раскрывает полный вид по сценам), «Суфлёр» и «Раскадровка» отдельными окнами,
   «Загрузить материал» и значки площадок. Суфлёр — shooting-prompter.js, раскадровка — shooting-board.js.
   CfKit необязателен: без него шапка и этап рисуются простым запасным видом. Контракт оболочки — «Контракт А». */
(() => {
  'use strict';
  const S = window.SbShooting = window.SbShooting || {};
  const ID = 'content-shooting';
  const active = new Map(); // загрузки живут дольше экрана: уход в другой раздел их не обрывает
  let activeCompany = '';
  let current = null; // открытый экран: прогресс загрузок, начатых до перемонтирования, рисуется в нём

  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  }
  const kit = () => (window.CfKit && window.CfKit.version ? window.CfKit : null);
  const date = (value) => value ? new Date(`${value}T00:00:00Z`).toLocaleDateString('ru-RU', {day: '2-digit', month: '2-digit', weekday: 'short', timeZone: 'UTC'}) : '—';
  /* Дата карточки как в макете: «Вт 03.11» — день недели с заглавной и число без запятой. */
  const shortDay = (value) => {
    if (!value) return '—';
    const d = new Date(`${value}T00:00:00Z`);
    const wd = d.toLocaleDateString('ru-RU', {weekday: 'short', timeZone: 'UTC'}).replace('.', '');
    return `${wd.charAt(0).toUpperCase()}${wd.slice(1)} ${d.toLocaleDateString('ru-RU', {day: '2-digit', month: '2-digit', timeZone: 'UTC'})}`;
  };
  const today = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10); // Бангкок
  const sheetLink = (value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'docs.google.com' && /^\/spreadsheets\/d\/[\w-]+(?:\/|$)/.test(url.pathname) ? url.href : '';
    } catch { return ''; }
  };
  /* Значки площадок — как в Контент-плане (цветные кружки с подписью, без логотипов). */
  const NET = {telegram: ['TG', '#229ed9'], vk: ['VK', '#0077ff'], youtube_shorts: ['YT', '#e62117'], youtube: ['YT', '#e62117'],
    tiktok: ['TT', '#111'], instagram: ['IG', '#d6249f'], max: ['MAX', '#6b4eff'], two_gis: ['2Г', '#2f9e44']};
  /* Порядок значков — как в макете и Контент-плане: TG · VK · YT · TT · IG, прочие — в конце. */
  const NET_ORDER = ['telegram', 'vk', 'youtube_shorts', 'youtube', 'tiktok', 'instagram', 'max', 'two_gis'];
  const netRank = (id) => { const i = NET_ORDER.indexOf(id); return i < 0 ? NET_ORDER.length : i; };
  const SORTS = [
    {id: 'shoot', label: 'Дата съёмки'},
    {id: 'status', label: 'Статус: отснято → запланировано'},
    {id: 'nomaterial', label: 'Сначала без материалов'},
    {id: 'number', label: 'Номер'}];
  const STATUS_ORDER = {shot: 0, editing: 1, edit_rework: 2, edit_review: 3, ready: 4, scheduled: 5, planned: 6};
  const SORT_KEY = 'content-shooting';

  function stageNode(stage) {
    const k = kit();
    if (k) {
      const box = document.createElement('span');
      box.innerHTML = k.stageChip(stage);
      return box.firstElementChild;
    }
    return h('span', {class: `shoot-chip shoot-chip--${stage}`, 'data-stage': stage, text: S.script.STAGE_LABEL[stage] || stage});
  }

  class ShootingView {
    constructor(root, ctx) {
      this.root = root; this.ctx = ctx; this.code = ctx.companyCode; this.alive = true;
      this.csrf = ctx.csrfToken ?? ctx.api?.csrfToken ?? null;
      this.route = ctx.route || {path: ''};
      this.opened = new Set(); this.details = new Map(); this.calendarOpen = false;
      if (activeCompany && activeCompany !== this.code) {
        for (const [key, job] of active) if (job.companyCode !== this.code) { job.controller.abort(); active.delete(key); }
      }
      activeCompany = this.code;
      // CfKit подгружается загрузчиком Контент-завода; пришёл позже — шапка перерисовывается в общем виде.
      this.onKit = () => { if (this.alive && this.list && !this.root.querySelector('.cfk-head')) this.renderList(); };
      window.addEventListener('cfkit:ready', this.onKit);
    }
    destroy() {
      this.alive = false; this.prompter?.close?.(); this.board?.close?.();
      window.removeEventListener('cfkit:ready', this.onKit);
      if (current === this) current = null;
    }
    /* Байты загрузки: CSRF из контекста (контракт А) или api.raw оболочки, который сам добавляет
       companyCode, CSRF и signal. Нет ни того ни другого — кнопки выключены с понятной причиной. */
    transport() {
      if (this.csrf) return {headers: {'X-CSRF-Token': this.csrf}};
      const raw = this.ctx.api?.raw;
      if (typeof raw !== 'function') return null;
      // Сигнатура из просьбы к А (комментарий 481 в №98): raw(method, path, body, headers, params) → Response.
      return {headers: {}, fetchImpl: async (url, init = {}) => {
        const target = String(url).replace(/^\/content\//, '').split('?')[0];
        const {'X-CSRF-Token': _csrf, ...headers} = init.headers || {};
        try {
          const result = await raw(init.method || 'GET', target, init.body, headers);
          return result && typeof result.json === 'function' ? result : {ok: true, status: 200, json: async () => result};
        } catch (error) {
          if (!error?.status) throw error;
          return {ok: false, status: error.status, json: async () => ({error: error.message, details: error.details || {code: error.code, upload: error.upload}})};
        }
      }};
    }
    async load() {
      const [snapshot, shooting, settings] = await Promise.all([
        this.ctx.crm('/media-mentor', {companyCode: this.code}),
        this.ctx.api.get('shooting/reels'),
        this.ctx.settings?.content?.get?.().catch(() => null) ?? null]);
      this.snapshot = snapshot; this.shooting = shooting; this.settings = settings?.settings || {};
      const now = today();
      this.list = S.script.reels(snapshot, shooting.reels || {}).filter((reel) => S.script.onShoot(reel, now));
    }
    async start() {
      this.root.replaceChildren(h('div', {class: 'shoot', 'aria-busy': 'true'}, h('p', {class: 'muted', text: 'Загружаем план съёмки…'})));
      try { await this.load(); } catch (error) {
        if (!this.alive) return;
        this.root.replaceChildren(h('div', {class: 'shoot card'}, h('p', {class: 'crm-error', role: 'alert', text: `Не удалось открыть съёмку: ${error.message}`}),
          h('button', {type: 'button', class: 'plain-button', onclick: () => this.start(), text: 'Повторить'})));
        return;
      }
      if (!this.alive) return;
      this.show();
    }
    /* Подпуть #content/shooting/<ideaId> раскрывает карточку этого рилса в списке. */
    show() {
      const ideaId = decodeURIComponent(this.route?.path || '').split('/')[0];
      if (ideaId) this.opened.add(ideaId);
      this.renderList();
      if (!ideaId) return;
      const card = this.cardNode(ideaId);
      if (!card) {
        this.root.querySelector('.shoot')?.prepend(h('p', {class: 'shoot-warning', role: 'status', text: 'Рилс не найден среди согласованных в этой компании.'}));
        return;
      }
      this.refreshUploads(ideaId);
      card.scrollIntoView?.({block: 'start'});
    }
    cardNode(ideaId) { return [...this.root.querySelectorAll('.shoot-row')].find((node) => node.dataset.idea === ideaId) || null; }

    plan(reel) { return S.script.schedule(reel.idea.date, this.settings); }
    dayOf(reel) { const plan = this.plan(reel); return plan.shootDate || plan.publishDate; }
    sorted() {
      const k = kit();
      const sort = this.sort || (k ? k.getSort(SORT_KEY, SORTS) : 'shoot');
      const byDay = (a, b) => String(this.dayOf(a)).localeCompare(String(this.dayOf(b))) || a.number - b.number;
      const list = this.list.slice();
      if (sort === 'number') return list.sort((a, b) => a.number - b.number);
      if (sort === 'status') return list.sort((a, b) => (STATUS_ORDER[S.script.stageOf(a)] ?? 9) - (STATUS_ORDER[S.script.stageOf(b)] ?? 9) || byDay(a, b));
      if (sort === 'nomaterial') return list.sort((a, b) => Number((a.takes || 0) > 0) - Number((b.takes || 0) > 0) || byDay(a, b));
      return list.sort(byDay);
    }
    header() {
      const k = kit();
      const sheetUrl = sheetLink(this.settings.contentPlanSheetUrl);
      if (!k) {
        return h('header', {class: 'shoot-head'}, h('h1', {text: 'Согласованные рилсы'}));
      }
      /* Макет: на телефоне «Согласованные рилсы», на ПК «Съёмка · рилсы по порядку из согласованного плана». */
      this.head = k.header({title: 'Согласованные рилсы', actions: ['calendar', 'sheet', 'sort'], sheetUrl,
        extraHtml: '<span class="shoot-head__lead">· рилсы по порядку из согласованного плана</span>',
        sortOptions: SORTS, sortKey: SORT_KEY, calendarOpen: this.calendarOpen,
        onSort: (id) => { this.sort = id; this.renderList(); },
        onCalendar: (open) => { this.calendarOpen = open; this.strip?.setOpen(open); }});
      const title = this.head.querySelector?.('.cfk-title');
      if (title) {
        title.replaceChildren(h('span', {class: 'shoot-head__phone', text: 'Согласованные рилсы'}), h('span', {class: 'shoot-head__pc', text: 'Съёмка'}));
      }
      return this.head;
    }
    dateStrip() {
      const k = kit();
      if (!k) return null;
      const marked = new Set(this.list.map((reel) => this.dayOf(reel)).filter(Boolean));
      /* Пояс компании: из кабинета, иначе из /media-mentor нового сервера (company.timeZone). Нет нигде — время устройства
         с честной подписью; прежнее «Asia/Irkutsk по умолчанию» было догадкой. */
      const timeZone = this.ctx.company?.timeZone || this.snapshot?.company?.timeZone || this.ctx.timeZone || '';
      this.strip = k.dateStrip({tz: timeZone === 'Asia/Irkutsk' ? 'Иркутское время' : timeZone ? `Время компании: ${timeZone}` : 'Время устройства', timeZone: timeZone || undefined, marked,
        onSelect: (picked) => this.jumpTo(k.dayKey(picked))});
      if (this.calendarOpen) this.strip.setOpen(true);
      return this.strip;
    }
    /* Выбор дня в полосе дат перематывает список к первому рилсу этого дня или позже. */
    jumpTo(key) {
      const rows = [...this.root.querySelectorAll('.shoot-row')];
      const target = rows.find((row) => row.dataset.day && row.dataset.day >= key) || rows[rows.length - 1];
      rows.forEach((row) => row.classList.toggle('is-picked', row === target && row.dataset.day === key));
      target?.scrollIntoView?.({block: 'start', behavior: 'smooth'});
    }

    renderList() {
      const configured = Number.isInteger(this.settings.deadlineDays) && this.settings.shootingWeekdays?.length;
      const items = this.sorted().map((reel) => this.row(reel));
      const storage = this.shooting.storage || {};
      this.root.replaceChildren(h('div', {class: 'shoot'},
        this.header(), this.dateStrip(),
        configured ? null : h('p', {class: 'shoot-warning'}, 'День съёмки и дедлайн не заданы. ',
          h('a', {href: '#settings/content', onclick: (event) => { event.preventDefault(); this.ctx.navigate('settings/content'); }, text: 'Настройки → Контент'})),
        storage.canUpload === false ? h('p', {class: 'shoot-warning', role: 'status', text: storage.reason}) : null,
        items.length ? h('ol', {class: 'shoot-list'}, items)
          : h('div', {class: 'card shoot-empty'}, h('p', {text: 'Согласованных рилсов пока нет.'}),
            h('p', {class: 'muted', text: 'Рилсы появятся здесь после согласования в «Контент-плане».'})),
        storage.quotaBytes ? h('p', {class: 'muted shoot-storage', text: `Место для материалов: занято ${S.upload.size(storage.usedBytes || 0)} из ${S.upload.size(storage.quotaBytes || 0)}`}) : null));
      this.renderUploads();
    }

    title(reel) { return `№${reel.number} ${reel.idea.topic || 'Без темы'}`; }
    nets(idea) {
      const vocab = this.snapshot?.vocabulary?.platforms || [];
      const label = (id) => vocab.find((item) => item.id === id)?.label || id;
      const ids = Object.keys(idea.variants && typeof idea.variants === 'object' ? idea.variants : {}).filter((id) => !idea.variants[id]?.excluded);
      if (!ids.length && idea.platform) ids.push(idea.platform);
      if (!ids.length) return null;
      ids.sort((a, b) => netRank(a) - netRank(b));
      return h('span', {class: 'shoot-nets', role: 'img', 'aria-label': `Площадки: ${ids.map(label).join(', ')}`},
        ids.map((id) => {
          const [abbr, color] = NET[id] || [String(id).slice(0, 3).toUpperCase(), '#667085'];
          return h('span', {class: 'shoot-nb', style: `background:${color}`, title: label(id), text: abbr});
        }));
    }
    row(reel) {
      const {idea} = reel, plan = this.plan(reel), stage = S.script.stageOf(reel);
      const open = this.opened.has(idea.ideaId);
      const late = plan.deadline && plan.deadline < today() && stage === 'planned' && !(reel.takes > 0);
      const when = plan.shootDate ? `Съёмка ${date(plan.shootDate)} · выход ${date(plan.publishDate)}`
        : `Выход ${date(plan.publishDate)} · день съёмки не задан`;
      const hint = late ? `${when} · дедлайн прошёл, материалов нет` : when;
      const parsed = S.script.parse(idea.script, idea);
      const node = h('li', {class: `shoot-row${open ? ' is-open' : ''}${late ? ' shoot-row--late' : ''}`, 'data-idea': idea.ideaId,
        'data-day': this.dayOf(reel) || '', 'data-stage': stage},
        h('div', {class: 'shoot-row__top'}, h('span', {class: `shoot-row__meta${late ? ' is-late' : ''}`, title: hint}, shortDay(this.dayOf(reel)),
          late ? h('span', {class: 'shoot-sr', text: ' · дедлайн прошёл, материалов нет'}) : null), stageNode(stage)),
        h('button', {type: 'button', class: 'shoot-row__line', 'aria-expanded': String(open), 'data-toggle': ''},
          h('span', {class: 'shoot-row__topic', text: this.title(reel)}), h('span', {class: 'shoot-row__chev', 'aria-hidden': 'true', text: open ? '▴' : '▾'})),
        open ? this.full(reel, parsed, plan) : null,
        h('div', {class: 'shoot-pair'},
          h('button', {type: 'button', class: 'shoot-pair__btn', 'data-prompter-open': '', disabled: !S.prompter, title: S.prompter ? null : 'Суфлёр не загрузился — обновите кабинет',
            text: 'Суфлёр', onclick: () => this.openPrompter(reel, parsed)}),
          h('button', {type: 'button', class: 'shoot-pair__btn', 'data-board-open': '', disabled: !S.board, title: S.board ? null : 'Раскадровка не загрузилась — обновите кабинет',
            text: 'Раскадровка', onclick: () => this.openBoard(reel, parsed)})),
        h('div', {class: 'shoot-row__acts'}, this.uploadSlot(idea.ideaId, null, 'Загрузить материал'), this.nets(idea)));
      // Нажатие в любом месте карточки (кроме кнопок, ссылок и загрузок) раскрывает или сворачивает полный вид.
      node.addEventListener('click', (event) => {
        if (event.target.closest('button:not([data-toggle]), a, input, select, textarea, label, progress, video')) return;
        this.toggle(idea.ideaId);
      });
      return node;
    }
    toggle(ideaId) {
      if (this.opened.has(ideaId)) this.opened.delete(ideaId); else this.opened.add(ideaId);
      const old = this.cardNode(ideaId), reel = this.list.find((item) => item.idea.ideaId === ideaId);
      if (!old || !reel) return;
      old.replaceWith(this.row(reel));
      this.renderUploads();
      if (this.opened.has(ideaId)) this.refreshUploads(ideaId);
    }
    /* specs/225-cf-theme-sources: ссылка «📁 Исходники» темы из /media-mentor (ideaLinks). Только https; нет — строки нет. */
    folderLink(ideaId) {
      const value = this.snapshot?.ideaLinks?.[ideaId]?.sourcesUrl;
      let href = '';
      try { const u = new URL(String(value || '')); href = u.protocol === 'https:' && u.hostname && !u.username && !u.password ? u.href : ''; } catch { href = ''; }
      return href ? h('a', {class: 'shoot-link', href, target: '_blank', rel: 'noopener noreferrer', 'data-sources-link': '', text: '📁 Открыть папку'}) : '';
    }
    /* Полный вид: сведения рилса, сцены «Сцена №N» (у каждой — своя загрузка), «До съёмки» после сцен. */
    full(reel, parsed, plan) {
      const {idea} = reel;
      const fields = [['Дата', shortDay(this.dayOf(reel))], ['Формат', reel.kind || 'Рилс'], ['Статус', stageNode(S.script.stageOf(reel))], ['Выход', date(plan.publishDate)],
        ['Съёмка', plan.shootDate ? date(plan.shootDate) : 'день не задан'],
        ['Дедлайн', plan.deadline ? date(plan.deadline) : 'не задан'], ['Снимает', idea.filmingBy || ''],
        ['Хук 1–2 с', idea.hook || ''], ['Реквизит', parsed.props.join(', ') || idea.props || ''],
        ['Исходники', this.folderLink(idea.ideaId)]].filter(([, value]) => value);
      return h('div', {class: 'shoot-full'},
        h('dl', {class: 'shoot-full__grid'}, fields.flatMap(([key, value]) => [h('dt', {text: key}), typeof value === 'string' ? h('dd', {text: value}) : h('dd', {}, value)])),
        h('b', {class: 'shoot-full__head', text: 'Сценарий по секундам'}),
        parsed.source === 'hook' ? h('p', {class: 'muted', text: 'Сценария по ролям ещё нет — показаны хук и тема. Сценарий заполняется в полном виде контент-плана.'}) : null,
        h('ol', {class: 'shoot-frames'}, parsed.frames.map((frame) => h('li', {class: `shoot-frame shoot-frame--${frame.type}`, 'data-frame': frame.n},
          h('div', {class: 'shoot-frame__text'},
            h('p', {class: 'shoot-frame__head'}, h('b', {text: `Сцена №${frame.n}`}), frame.time ? ` · ${frame.time}` : '',
              frame.actor ? ` · ${frame.actor}` : frame.type === 'insert' ? ' · вставка' : ''),
            h('p', {class: 'shoot-frame__say', text: frame.type === 'line' ? `«${frame.text}»` : frame.text}),
            frame.shot && frame.shot !== frame.text ? h('p', {class: 'shoot-frame__more', text: `В кадре: ${frame.shot}`}) : null,
            frame.action && frame.action !== frame.text ? h('p', {class: 'shoot-frame__more', text: `Действие: ${frame.action}`}) : null,
            frame.title && frame.title !== frame.text ? h('p', {class: 'shoot-frame__more', text: `Титр: «${frame.title}»`}) : null,
            frame.props.length ? h('p', {class: 'shoot-frame__more', text: `Реквизит: ${frame.props.join(', ')}`}) : null),
          this.uploadSlot(idea.ideaId, frame.n, 'Загрузить')))),
        parsed.before.length ? h('div', {class: 'shoot-before'}, h('b', {text: 'До съёмки'}), parsed.before.map((text) => h('p', {text}))) : null,
        h('div', {class: 'shoot-drafts'}, h('b', {text: 'Черновик монтажа'}), h('div', {'data-drafts': idea.ideaId})));
    }

    openPrompter(reel, parsed) {
      if (!S.prompter) return;
      this.prompter?.close?.();
      this.prompter = S.prompter.open({parsed, title: `Суфлёр №${reel.number}`, subtitle: reel.idea.topic || '', backLabel: '← Съёмка'});
    }
    openBoard(reel, parsed) {
      if (!S.board) return;
      this.board?.close?.();
      this.board = S.board.open({view: this, reel, parsed, h});
    }

    uploadSlot(ideaId, frame, label) {
      const storage = this.shooting.storage || {};
      const reason = !this.shooting.canEdit ? 'Нет права загружать материалы' : !this.transport() ? 'Загрузка недоступна: обновите кабинет'
        : storage.canUpload === false ? storage.reason : '';
      const input = h('input', {type: 'file', accept: 'video/*,image/jpeg,image/png,.mov,.mp4', multiple: true, hidden: true,
        onchange: (event) => { [...event.target.files].forEach((file) => this.startUpload(file, frame, ideaId)); event.target.value = ''; }});
      return h('div', {class: `shoot-slot${frame === null ? ' shoot-slot--main' : ''}`, 'data-slot': frame ?? 'other'},
        h('button', {type: 'button', class: `shoot-upload${frame === null ? ' shoot-upload--main' : ''}`, disabled: Boolean(reason), title: reason || null,
          onclick: () => input.click(), text: label}), input,
        reason && this.shooting.canEdit ? h('span', {class: 'shoot-slot__reason', text: reason}) : null,
        h('ul', {class: 'shoot-files', 'data-files': frame ?? 'other', 'data-idea': ideaId}));
    }
    startUpload(file, frame, ideaId) {
      const key = `${this.code}|${ideaId}|${file.name}|${file.size}|${frame}`;
      if (active.get(key) && !active.get(key).error) return; // после ошибки тот же файл продолжает с принятого байта
      const job = {key, companyCode: this.code, ideaId, frame, name: file.name, size: file.size, offset: 0, error: '', controller: new AbortController()};
      active.set(key, job);
      this.renderUploads();
      S.upload.upload({file, ideaId, frame, companyCode: this.code, ...this.transport(), signal: job.controller.signal,
        onProgress: (offset, size, state) => { job.offset = offset; job.waiting = Boolean(state.waiting); current?.renderUploads(); }})
        .then(() => { active.delete(key); current?.refreshUploads(ideaId); })
        .catch((error) => { job.error = error.name === 'AbortError' ? 'Загрузка отменена' : error.message; current?.renderUploads(); });
    }
    async refreshUploads(ideaId) {
      try { this.details.set(ideaId, await this.ctx.api.get(`shooting/reels/${encodeURIComponent(ideaId)}`)); }
      catch { if (!this.details.has(ideaId)) this.details.set(ideaId, {uploads: []}); }
      if (this.alive) this.renderUploads();
      return this.details.get(ideaId);
    }
    /* Списки файлов во всех открытых местах (карточки и окно раскадровки) по рилсу и кадру. */
    renderUploads() {
      if (!this.alive) return;
      const scopes = [this.root, this.board?.overlay].filter(Boolean);
      scopes.forEach((scope) => scope.querySelectorAll('[data-files]').forEach((list) => {
        const ideaId = list.dataset.idea;
        const stored = (this.details.get(ideaId)?.uploads || []).filter((item) => item.status === 'stored');
        const slot = list.dataset.files === 'other' ? null : Number(list.dataset.files);
        const rows = stored.filter((item) => item.kind === 'take' && item.frame === slot).map((item) => h('li', {class: 'shoot-file'},
          h('a', {href: item.fileUrl, target: '_blank', rel: 'noopener', text: item.name}), h('span', {class: 'muted', text: ` ${S.upload.size(item.size)}`})));
        const jobs = [...active.values()].filter((job) => job.ideaId === ideaId && job.companyCode === this.code && job.frame === slot).map((job) => {
          const percent = Math.floor((job.offset / job.size) * 100);
          return h('li', {class: 'shoot-file shoot-file--active'}, h('span', {text: job.name}),
            h('progress', {max: String(job.size), value: String(job.offset), 'aria-label': `Загрузка ${job.name}`}),
            h('span', {class: job.error ? 'crm-error' : 'muted', text: job.error || `${percent} % · ${S.upload.size(job.offset)} из ${S.upload.size(job.size)}${job.waiting ? ' · ждём связь' : ''}`}),
            job.error ? h('button', {type: 'button', class: 'link-button', text: 'Убрать', onclick: () => { active.delete(job.key); this.renderUploads(); }}) : null);
        });
        list.replaceChildren(...rows, ...jobs);
      }));
      this.root.querySelectorAll('[data-drafts]').forEach((drafts) => {
        const items = (this.details.get(drafts.dataset.drafts)?.uploads || []).filter((item) => item.status === 'stored' && item.kind === 'draft');
        drafts.replaceChildren(items.length ? h('ul', {class: 'shoot-files'}, items.map((item) => h('li', {class: 'shoot-file'},
          item.mime?.startsWith('video/') ? h('video', {src: item.fileUrl, controls: true, preload: 'metadata', playsinline: true}) : null,
          h('a', {href: item.fileUrl, target: '_blank', rel: 'noopener', text: `${item.name} · ${S.upload.size(item.size)}`}))))
          : h('p', {class: 'muted', text: 'Монтажёр загрузит черновик сюда. Пока черновика нет.'}));
      });
    }
  }

  window.addEventListener('beforeunload', (event) => {
    if ([...active.values()].some((job) => !job.error)) { event.preventDefault(); event.returnValue = ''; }
  });
  const definition = {
    title: 'Съёмка',
    mount(root, ctx) { const view = new ShootingView(root, ctx); root.__shooting = view; current = view; return view.start(); },
    unmount(root) { root.__shooting?.destroy(); root.__shooting = null; },
    // Смена подпути внутри «Съёмки» (#content/shooting/<ideaId>) — без повторной загрузки плана.
    onRoute(route) {
      if (!current?.alive || !current.list) return;
      current.prompter?.close?.(); current.board?.close?.();
      current.route = route || {path: ''}; current.show();
    }
  };
  S.view = {ShootingView, definition, active, SORTS};
  if (window.SynapseModules?.register) window.SynapseModules.register(ID, definition);
  else (window.SynapseModulesQueue = window.SynapseModulesQueue || []).push([ID, definition]); // очередь контракта А
})();
