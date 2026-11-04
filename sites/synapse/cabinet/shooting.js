/* Контент → Съёмка (№98 · В). Список согласованных рилсов, карточка с общим планом по кадрам и
   «Загрузить материал». Суфлёр/«Поделиться» (shooting-prompter.js) и раскадровка
   (shooting-board.js) подключаются к карточке, если загружены. Контракт оболочки — «Контракт А». */
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
  const date = (value) => value ? new Date(`${value}T00:00:00Z`).toLocaleDateString('ru-RU', {day: '2-digit', month: '2-digit', weekday: 'short', timeZone: 'UTC'}) : '—';
  const today = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10); // Бангкок
  const statusChip = (status) => h('span', {class: `shoot-chip shoot-chip--${status}`, text: S.script.STATUS[status] || status});

  class ShootingView {
    constructor(root, ctx) {
      this.root = root; this.ctx = ctx; this.code = ctx.companyCode; this.alive = true;
      this.csrf = ctx.csrfToken ?? ctx.api?.csrfToken ?? null;
      this.route = ctx.route || {path: ''};
      if (activeCompany && activeCompany !== this.code) {
        for (const [key, job] of active) if (job.companyCode !== this.code) { job.controller.abort(); active.delete(key); }
      }
      activeCompany = this.code;
    }
    destroy() { this.alive = false; this.prompter?.close?.(); if (current === this) current = null; }
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
    show() {
      const ideaId = decodeURIComponent(this.route?.path || '').split('/')[0];
      if (ideaId) this.renderCard(ideaId); else this.renderList();
    }
    async load() {
      const [snapshot, shooting, settings] = await Promise.all([
        this.ctx.crm('/media-mentor', {companyCode: this.code}),
        this.ctx.api.get('shooting/reels'),
        this.ctx.settings?.content?.get?.().catch(() => null) ?? null]);
      this.snapshot = snapshot; this.shooting = shooting; this.settings = settings?.settings || {};
      this.list = S.script.reels(snapshot, shooting.reels || {});
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
    open(ideaId) { this.ctx.navigate(ideaId ? `content/shooting/${encodeURIComponent(ideaId)}` : 'content/shooting'); }

    storageNote() {
      const storage = this.shooting.storage || {};
      if (storage.canUpload === false) return h('p', {class: 'shoot-warning', role: 'status', text: storage.reason});
      return h('p', {class: 'muted shoot-storage', text: `Место для материалов: занято ${S.upload.size(storage.usedBytes || 0)} из ${S.upload.size(storage.quotaBytes || 0)}`});
    }
    renderList() {
      const configured = Number.isInteger(this.settings.deadlineDays) && this.settings.shootingWeekdays?.length;
      const items = this.list.map((reel) => {
        const plan = S.script.schedule(reel.idea.date, this.settings);
        const late = plan.deadline && plan.deadline < today() && reel.status === 'approved';
        return h('li', {class: `shoot-row${late ? ' shoot-row--late' : ''}`},
          h('button', {type: 'button', class: 'shoot-row__open', onclick: () => this.open(reel.idea.ideaId)},
            h('span', {class: 'shoot-row__num', text: `№${reel.number}`}),
            h('span', {class: 'shoot-row__main'},
              h('strong', {text: reel.idea.topic || 'Без темы'}),
              h('span', {class: 'shoot-row__meta', text: [`Выход ${date(plan.publishDate)}`,
                plan.shootDate ? `съёмка ${date(plan.shootDate)}` : 'день съёмки не задан',
                plan.deadline ? `дедлайн ${date(plan.deadline)}` : ''].filter(Boolean).join(' · ')}),
              late ? h('span', {class: 'shoot-row__late', text: 'Дедлайн прошёл, материалов нет'}) : null),
            statusChip(reel.status)));
      });
      this.root.replaceChildren(h('div', {class: 'shoot'},
        h('header', {class: 'shoot-head'}, h('h1', {text: 'Съёмка'}),
          h('p', {class: 'muted', text: 'Согласованные рилсы контент-плана по порядку. Откройте рилс: что снять, суфлёр и загрузка материала.'})),
        configured ? null : h('p', {class: 'shoot-warning'}, 'День съёмки и дедлайн не заданы. ',
          h('a', {href: '#settings/content', onclick: (event) => { event.preventDefault(); this.ctx.navigate('settings/content'); }, text: 'Настройки → Контент'})),
        this.storageNote(),
        items.length ? h('ol', {class: 'shoot-list'}, items)
          : h('div', {class: 'card shoot-empty'}, h('p', {text: 'Согласованных рилсов пока нет.'}),
            h('p', {class: 'muted', text: 'Рилсы появятся здесь после согласования в «Контент-плане».'}))));
    }

    renderCard(ideaId) {
      const reel = this.list.find((item) => item.idea.ideaId === ideaId);
      if (!reel) {
        this.root.replaceChildren(h('div', {class: 'shoot card'}, h('p', {text: 'Рилс не найден среди согласованных в этой компании.'}),
          h('button', {type: 'button', class: 'plain-button', onclick: () => this.open(''), text: '← Все рилсы'})));
        return;
      }
      const {idea} = reel;
      const parsed = S.script.parse(idea.script, idea);
      const plan = S.script.schedule(idea.date, this.settings);
      this.card = {reel, parsed};
      const body = h('div', {class: 'shoot-card__body'});
      const tabs = [['plan', 'Общий план'], ...(S.board ? [['board', 'Раскадровка']] : [])];
      const tabBar = h('div', {class: 'shoot-tabs', role: 'tablist'}, tabs.map(([key, label]) =>
        h('button', {type: 'button', role: 'tab', 'data-tab': key, 'aria-selected': String(key === 'plan'), text: label,
          onclick: () => this.showTab(key, body, tabBar)})));
      const statusSelect = this.shooting.canEdit ? h('select', {'aria-label': 'Статус рилса', class: 'shoot-status',
        onchange: (event) => this.setStatus(ideaId, event.target.value)},
        Object.entries(S.script.STATUS).map(([key, label]) => h('option', {value: key, selected: key === reel.status, text: label}))) : statusChip(reel.status);
      this.root.replaceChildren(h('div', {class: 'shoot shoot-card'},
        h('button', {type: 'button', class: 'link-button shoot-back', onclick: () => this.open(''), text: '← Все рилсы'}),
        h('header', {class: 'shoot-head'},
          h('h1', {text: `Рилс №${reel.number} · ${idea.topic || 'Без темы'}`}),
          h('p', {class: 'shoot-row__meta', text: [`Выход ${date(plan.publishDate)}`, plan.shootDate ? `съёмка ${date(plan.shootDate)}` : 'день съёмки не задан',
            plan.deadline ? `дедлайн ${date(plan.deadline)}` : '', idea.filmingBy ? `снимает: ${idea.filmingBy}` : ''].filter(Boolean).join(' · ')}),
          h('div', {class: 'shoot-head__actions'}, statusSelect,
            S.prompter ? h('button', {type: 'button', class: 'plain-button', 'data-prompter-open': '', text: 'Суфлёр',
              onclick: () => { this.prompter = S.prompter.open({parsed, title: `Рилс №${reel.number} · ${idea.topic || ''}`}); }}) : null,
            S.prompter?.shareControls ? S.prompter.shareControls({parsed, title: `Рилс №${reel.number} · ${idea.topic || ''}`}) : null)),
        idea.hook ? h('p', {class: 'shoot-hook'}, h('strong', {text: 'Хук 1–2 с: '}), idea.hook) : null,
        parsed.source === 'hook' ? h('p', {class: 'muted', text: 'Сценария по ролям ещё нет — показаны хук и тема. Сценарий заполняется в полном виде контент-плана.'}) : null,
        tabBar, body));
      this.showTab('plan', body, tabBar);
      this.refreshUploads(ideaId);
    }
    showTab(key, body, tabBar) {
      tabBar.querySelectorAll('[role=tab]').forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.tab === key)));
      if (key === 'board' && S.board) { body.replaceChildren(S.board.render({view: this, ...this.card, h})); return; }
      const {parsed} = this.card;
      body.replaceChildren(
        parsed.props.length ? h('p', {class: 'shoot-props'}, h('strong', {text: 'Реквизит: '}), parsed.props.join(', ')) : null,
        h('ol', {class: 'shoot-frames'}, parsed.frames.map((frame) => h('li', {class: `shoot-frame shoot-frame--${frame.type}`, 'data-frame': frame.n},
          h('div', {class: 'shoot-frame__text'},
            h('span', {class: 'shoot-frame__kind', text: {line: 'Реплика', insert: 'Вставка', action: 'Действие'}[frame.type]}),
            frame.actor ? h('strong', {text: `${frame.actor}: `}) : null, frame.text,
            frame.props.length ? h('span', {class: 'shoot-frame__props', text: `Реквизит: ${frame.props.join(', ')}`}) : null),
          this.uploadSlot(frame.n)))),
        h('section', {class: 'shoot-other', 'data-frame': 'other'}, h('h2', {text: 'Другое / дополнительно'}),
          h('p', {class: 'muted', text: 'Можно загрузить больше нужного и в любом порядке.'}), this.uploadSlot(null)),
        h('section', {class: 'shoot-drafts'}, h('h2', {text: 'Черновик монтажа'}), h('div', {'data-drafts': ''})));
      this.renderUploads();
    }

    uploadSlot(frame) {
      const storage = this.shooting.storage || {};
      const reason = !this.shooting.canEdit ? 'Нет права загружать материалы' : !this.transport() ? 'Загрузка недоступна: обновите кабинет'
        : storage.canUpload === false ? storage.reason : '';
      const input = h('input', {type: 'file', accept: 'video/*,image/jpeg,image/png,.mov,.mp4', multiple: true, hidden: true,
        onchange: (event) => { [...event.target.files].forEach((file) => this.startUpload(file, frame)); event.target.value = ''; }});
      return h('div', {class: 'shoot-slot', 'data-slot': frame ?? 'other'},
        h('button', {type: 'button', class: 'plain-button shoot-upload', disabled: Boolean(reason), title: reason || null,
          onclick: () => input.click(), text: 'Загрузить материал'}), input,
        reason && this.shooting.canEdit ? h('span', {class: 'shoot-slot__reason', text: reason}) : null,
        h('ul', {class: 'shoot-files', 'data-files': frame ?? 'other'}));
    }
    startUpload(file, frame) {
      const {idea} = this.card.reel, key = `${this.code}|${idea.ideaId}|${file.name}|${file.size}|${frame}`;
      if (active.get(key) && !active.get(key).error) return; // после ошибки тот же файл продолжает с принятого байта
      const job = {key, companyCode: this.code, ideaId: idea.ideaId, frame, name: file.name, size: file.size, offset: 0, error: '', controller: new AbortController()};
      active.set(key, job);
      this.renderUploads();
      S.upload.upload({file, ideaId: idea.ideaId, frame, companyCode: this.code, ...this.transport(), signal: job.controller.signal,
        onProgress: (offset, size, state) => { job.offset = offset; job.waiting = Boolean(state.waiting); current?.renderUploads(); }})
        .then(() => { active.delete(key); current?.refreshUploads(idea.ideaId); })
        .catch((error) => { job.error = error.name === 'AbortError' ? 'Загрузка отменена' : error.message; current?.renderUploads(); });
    }
    async refreshUploads(ideaId) {
      if (this.card?.reel.idea.ideaId !== ideaId) return;
      try { this.detail = await this.ctx.api.get(`shooting/reels/${encodeURIComponent(ideaId)}`); } catch { this.detail = this.detail || {uploads: []}; }
      if (this.alive) this.renderUploads();
    }
    renderUploads() {
      if (!this.alive || !this.card) return;
      const ideaId = this.card.reel.idea.ideaId;
      const stored = (this.detail?.uploads || []).filter((item) => item.status === 'stored');
      this.root.querySelectorAll('[data-files]').forEach((list) => {
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
      });
      const drafts = this.root.querySelector('[data-drafts]');
      if (drafts) {
        const items = stored.filter((item) => item.kind === 'draft');
        drafts.replaceChildren(items.length ? h('ul', {class: 'shoot-files'}, items.map((item) => h('li', {class: 'shoot-file'},
          item.mime.startsWith('video/') ? h('video', {src: item.fileUrl, controls: true, preload: 'metadata', playsinline: true}) : null,
          h('a', {href: item.fileUrl, target: '_blank', rel: 'noopener', text: `${item.name} · ${S.upload.size(item.size)}`}))))
          : h('p', {class: 'muted', text: 'Монтажёр загрузит черновик сюда. Пока черновика нет.'}));
      }
    }
    async setStatus(ideaId, status) {
      try { await this.ctx.api.put(`shooting/reels/${encodeURIComponent(ideaId)}/status`, {status}); this.card.reel.status = status; }
      catch (error) { window.alert?.(`Статус не сохранён: ${error.message}`); }
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
      current.prompter?.close?.(); current.card = null; current.detail = null;
      current.route = route || {path: ''}; current.show();
    }
  };
  S.view = {ShootingView, definition, active};
  if (window.SynapseModules?.register) window.SynapseModules.register(ID, definition);
  else (window.SynapseModulesQueue = window.SynapseModulesQueue || []).push([ID, definition]); // очередь контракта А
})();
