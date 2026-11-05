'use strict';
/* «Чаты» и личный чат с Хью (№98 · Д). Модули контракта А: 'chats' и 'hugh-chat'.
   Сервер: /content/people/team-chat (PR 480/493 + комнаты), права и компания проверяются там. */
(() => {
  const node = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
  // Ссылки в тексте: только http(s), target=_blank, rel=noopener noreferrer; остальное — текст без HTML.
  // Видео из хранилища ЭТОЙ компании (…/content/publishing-assets/<код>/<имя>.mp4|.webm) дополнительно показывается плеером.
  const ASSET_ORIGIN = 'https://synapse.synapsebusiness.ru';
  const ownVideo = (url, companyCode) => {
    const m = companyCode && url.origin === ASSET_ORIGIN && /^\/content\/publishing-assets\/([^/]+)\/[^/]+\.(?:mp4|webm)$/i.exec(url.pathname);
    try { return Boolean(m) && decodeURIComponent(m[1]) === companyCode; } catch { return false; }
  };
  const richText = (target, value, companyCode) => {
    const text = String(value ?? ''), re = /https?:\/\/[^\s<>"']+/giu, seen = new Set(); let last = 0, match;
    while ((match = re.exec(text))) {
      let raw = match[0];
      while (/[.,;:!?)»\]]$/u.test(raw) && !(raw.endsWith(')') && raw.includes('('))) raw = raw.slice(0, -1);
      let url; try { url = new URL(raw); } catch { continue; }
      if (!/^https?:$/.test(url.protocol)) continue;
      if (match.index > last) target.append(document.createTextNode(text.slice(last, match.index)));
      const link = document.createElement('a'); link.className = 'sbc-link'; link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = raw; target.append(link);
      last = match.index + raw.length; re.lastIndex = last;
      if (ownVideo(url, companyCode)) seen.add(url.href);
    }
    if (last < text.length) target.append(document.createTextNode(text.slice(last)));
    return [...seen].map(href => { const v = document.createElement('video'); v.className = 'sbc-video'; v.controls = true; v.setAttribute('playsinline', ''); v.preload = 'metadata'; v.src = href; return v; });
  };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9_.:-]/g, '');
  const time = value => { const d = new Date(value); return Number.isNaN(d) ? '' : d.toLocaleString('ru-RU', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };
  const human = error => error?.status === 403 ? 'Нет доступа к этому чату.' : error?.status === 401 ? 'Сессия закончилась. Войдите снова.' : 'Связь не подтвердила результат. Повтор той же отправки безопасен.';

  // Один разговор: используется и в «Чатах», и в плавающей панели. Хью отвечает по обращению (сервер).
  function conversation(host, ctx, { room, title, hint, task, onClearTask, placeholder }) {
    const box = node('section', 'sbc-conv');
    const head = node('header', 'sbc-conv__head'), list = node('ol', 'sbc-messages'), notice = node('p', 'sbc-notice');
    const older = node('button', 'plain-button sbc-older', 'Ранние сообщения'); older.type = 'button'; older.hidden = true;
    head.append(node('h2', 'sbc-conv__title', title));
    if (hint) head.append(node('p', 'sbc-conv__hint', hint));
    let taskBar = null, taskLabel = null;
    if (task) {
      taskBar = node('div', 'sbc-taskbar');
      taskBar.hidden = true; taskBar.style.display = 'none'; taskLabel = node('span');
      taskBar.append(taskLabel, node('small', '', 'Уточнения попадут в задачу комментарием.'));
      const clear = node('button', 'plain-button', 'Обычный чат'); clear.type = 'button'; clear.onclick = () => onClearTask?.();
      taskBar.append(clear); head.append(taskBar);
    }
    list.setAttribute('role', 'log'); list.setAttribute('aria-live', 'polite'); notice.setAttribute('role', 'status');
    const form = node('form', 'sbc-compose'), text = node('textarea'), send = node('button', 'sbc-send', '➤');
    text.rows = 2; text.maxLength = 8000; text.required = true; text.placeholder = placeholder || 'Сообщение. Чтобы позвать Хью: «Хью, …»';
    text.setAttribute('aria-label', 'Сообщение'); send.type = 'submit'; send.setAttribute('aria-label', 'Отправить');
    form.append(text, send); box.append(head, older, list, notice, form); host.replaceChildren(box);
    const companyCode = ctx.companyCode, taskId = task?.id || null, initialViewer = ctx.user?.id;
    const messages = new Map(); let pending = null, busy = false, viewer = null, stopped = false;
    let identityEpoch = 0, loadEpoch = 0, prefill = '';
    const validViewer = id => Number.isSafeInteger(id) && id > 0;
    const draftKey = id => `sbc:v2:${id}:${companyCode}:${room}:${taskId || ''}`;
    const persist = (id, value) => { if (validViewer(id)) { try { sessionStorage.setItem(draftKey(id), JSON.stringify(value)); } catch {} } };
    const save = () => persist(viewer, { text: text.value, pending });
    const compose = () => {
      text.readOnly = busy || !validViewer(viewer) || Boolean(pending); send.disabled = busy || !validViewer(viewer);
      if (taskBar) {
        const ownTask = validViewer(viewer) && viewer === initialViewer;
        taskLabel.textContent = ownTask ? `Чат по задаче №${taskId}: ${task.title || ''}` : '';
        taskBar.hidden = !ownTask; taskBar.style.display = ownTask ? '' : 'none';
      }
    };
    const pendingFits = value => value && typeof value.text === 'string' && typeof value.clientMessageId === 'string'
      && value.room === room && (value.taskId || null) === taskId;
    function changeViewer(id) {
      if (viewer === id) return false;
      save(); identityEpoch++; viewer = id; messages.clear(); pending = null; text.value = '';
      if (validViewer(id)) {
        try { const saved = JSON.parse(sessionStorage.getItem(draftKey(id)) || 'null'); if (saved) { text.value = typeof saved.text === 'string' ? saved.text : ''; pending = saved.pending || null; } } catch {}
        if (prefill && id === initialViewer && !text.value && !pending) { text.value = prefill; prefill = ''; save(); }
      }
      compose(); return true;
    }
    function suspend() { changeViewer(null); render(); }
    function confirmed(id, sent) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(draftKey(id)) || 'null');
        if (saved?.pending?.clientMessageId === sent.clientMessageId) persist(id, { text: '', pending: null });
      } catch {}
    }
    compose();
    function render() {
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      list.replaceChildren();
      for (const m of [...messages.values()].sort((a, b) => a.id - b.id)) {
        const li = node('li', m.user_id === 0 ? 'sbc-msg sbc-msg--hugh' : m.user_id === viewer ? 'sbc-msg sbc-msg--own' : 'sbc-msg');
        if (m.kind === 'hugh-merge') li.classList.add('sbc-msg--merge');
        const body = node('span', 'sbc-msg__text'), videos = richText(body, m.text, companyCode);
        if (videos.length) li.classList.add('sbc-msg--video');
        li.append(node('strong', '', m.author_name), body, ...videos, node('time', '', time(m.created_at)));
        if (m.task_id && m.kind !== 'hugh-merge') li.append(node('span', 'sbc-msg__task', m.kind === 'hugh-task' ? `Я поставил Хью · задача №${m.task_id}` : `Задача №${m.task_id} на доске`));
        else if (m.ref_task_id && m.kind === 'task-note') li.append(node('span', 'sbc-msg__task', m.command_state === 'done' ? `Комментарий в задаче №${m.ref_task_id}` : 'Комментарий ещё не подтверждён'));
        else if (m.command_state === 'pending') li.append(node('span', 'sbc-msg__task', 'Задача ещё не подтверждена — повторите отправку'));
        if (m.answerAudit && m.answerAudit.status !== 'approved') li.append(node('small', '', m.answerAudit.status === 'refused' ? 'Запрос отклонён' : 'Передано на проверку'));
        list.append(li);
      }
      if (!messages.size) list.append(node('li', 'sbc-empty', room.startsWith('hugh:') ? 'Здесь ваш личный чат с Хью: запросы, уточнения по задачам и ответы. Его видите только вы.' : 'Сообщений пока нет.'));
      if (atBottom) list.scrollTop = list.scrollHeight;
    }
    async function load(before) {
      const request = ++loadEpoch; let data;
      try { data = await ctx.api.get('people/team-chat', { room, before }); }
      catch (error) { if (!stopped && request === loadEpoch && [401, 403].includes(error?.status)) suspend(); throw error; }
      if (stopped || ctx.signal?.aborted || request !== loadEpoch) return null;
      if (!validViewer(data.viewerId) || data.room !== undefined && data.room !== room) {
        suspend(); throw Object.assign(Error('Сессия не подтверждена'), { status: 401 });
      }
      const previous = viewer, changed = changeViewer(data.viewerId);
      if (changed && before) return load();
      for (const m of data.messages) messages.set(m.id, m);
      if (before || messages.size <= data.messages.length) older.hidden = !data.hasMore;
      render();
      notice.textContent = previous !== null && changed ? 'Аккаунт изменился. Проверьте черновик перед отправкой.'
        : pending ? 'Есть неподтверждённая отправка. Нажмите ➤, чтобы проверить её результат.' : '';
      return { viewerId: viewer, changed };
    }
    older.onclick = () => load(Math.min(...messages.keys())).catch(e => { notice.textContent = human(e); });
    form.onsubmit = async event => {
      event.preventDefault(); if (busy || !validViewer(viewer) || !text.value.trim()) return;
      const owner = viewer, epoch = identityEpoch;
      busy = true; compose(); notice.textContent = 'Отправляю…';
      try {
        const snapshot = await ctx.api.get('whoami');
        if (stopped || ctx.signal?.aborted) return;
        if (!validViewer(snapshot?.userId) || typeof snapshot.csrfToken !== 'string' || !snapshot.csrfToken.trim()) {
          suspend(); throw Object.assign(Error('Сессия не подтверждена'), { status: 401 });
        }
        if (snapshot.userId !== owner || viewer !== owner || identityEpoch !== epoch) {
          suspend(); await load(); notice.textContent = 'Аккаунт изменился. Проверьте черновик перед отправкой.'; return;
        }
        pending ||= { text: text.value.trim(), clientMessageId: uid(), room, ...(taskId ? { taskId } : {}) };
        save();
        if (!pendingFits(pending)) throw Object.assign(Error('Сохранённая отправка относится к другому чату'), { status: 409 });
        const sent = pending;
        const data = await ctx.api.post('people/team-chat', sent, undefined, { csrfToken: snapshot.csrfToken });
        if (data.message?.user_id !== owner) throw Object.assign(Error('Не подтверждён отправитель'), { status: 502 });
        confirmed(owner, sent);
        if (stopped || ctx.signal?.aborted || viewer !== owner || identityEpoch !== epoch) return;
        pending = null; text.value = ''; save(); notice.textContent = '';
        const loaded = await load();
        if (loaded?.viewerId === owner) { messages.set(data.message.id, data.message); render(); list.scrollTop = list.scrollHeight; }
      } catch (error) {
        if (!stopped && !ctx.signal?.aborted) { if ([401, 403].includes(error?.status)) suspend(); notice.textContent = human(error); }
      } finally { busy = false; compose(); }
    };
    text.oninput = save;
    text.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit(); };
    const timer = setInterval(() => { if (!document.hidden && !busy) load().catch(() => {}); }, 5000);
    const stop = () => { stopped = true; clearInterval(timer); save(); };
    ctx.signal?.addEventListener('abort', stop, { once: true });
    load().catch(e => { notice.textContent = e?.status === 403 ? 'Нет доступа к этому чату.' : 'Не удалось загрузить чат. Обновите экран.'; render(); });
    return { stop, focus: () => text.focus(), prefill(value) {
      prefill = value;
      if (viewer === initialViewer && validViewer(viewer) && !text.value && !pending) { text.value = value; prefill = ''; save(); }
      text.focus();
    } };
  }

  // Плавающая панель: лог пользователя с Хью. Открывать с контекстом задачи — SynapseHughChat.open({task}).
  let nextOpen = null;
  window.SynapseHughChat = {
    open(options = {}) {
      nextOpen = { task: options.task && Number.isSafeInteger(options.task.id) ? { id: options.task.id, title: String(options.task.title || '') } : null, prefill: String(options.prefill || '') };
      const dock = window.SynapseModules?.chat;
      if (!dock) return false;
      if (dock.isOpen()) dock.companyChanged(); else dock.open();
      return true;
    }
  };
  const hughChat = {
    title: 'Личный чат с Хью',
    async mount(el, ctx) {
      const opened = nextOpen; nextOpen = null;
      const rooms = await ctx.api.get('people/team-chat/rooms');
      if (ctx.signal?.aborted) return;
      if (!rooms.hugh) { el.replaceChildren(node('p', 'sbc-notice', 'Личный чат с Хью доступен исполнителям задач компании. Доступ выдаёт владелец.')); return; }
      const start = task => {
        el._sbc?.stop();
        el._sbc = conversation(el, ctx, { room: rooms.hugh, title: 'Хью · личный чат', hint: 'Видите только вы. Хью сведёт ваш запрос с похожими запросами коллег по проекту.',
          task, onClearTask: () => start(null), placeholder: task ? 'Уточнение к задаче…' : 'Спросите или поручите: «Сделай …», «Измени …»' });
      };
      start(opened?.task || null);
      if (opened?.prefill) el._sbc.prefill(opened.prefill);
    },
    unmount(el) { el._sbc?.stop(); }
  };

  const chats = {
    title: 'Чаты',
    async mount(el, ctx) {
      const shell = node('div', 'sbc-chats'), side = node('aside', 'sbc-rooms'), main = node('div', 'sbc-main');
      side.append(node('h1', 'sbc-rooms__title', 'Чаты'), node('p', 'sbc-rooms__company', ctx.companyName || ''));
      const nav = node('nav', 'sbc-rooms__list'); nav.setAttribute('aria-label', 'Чаты компании'); side.append(nav);
      shell.append(side, main); el.replaceChildren(shell);
      main.append(node('p', 'sbc-notice', 'Загрузка…'));
      const rooms = await ctx.api.get('people/team-chat/rooms');
      if (ctx.signal?.aborted) return;
      const entries = [{ room: 'common', name: 'Общий чат компании', hint: 'Видят все сотрудники компании. Хью читает и отвечает, только когда к нему обращаются: «Хью, …».' },
        ...rooms.people.map(p => ({ room: p.room, name: p.name, hint: 'Личный чат. Видите только вы двое. Хью отвечает по обращению «Хью, …», ответ видите только вы.' })),
        // Без доступа к задачам лога Хью нет (№127): сервер отдаёт hugh: null.
        ...(rooms.hugh ? [{ room: rooms.hugh, name: 'Хью · мой личный чат', hint: 'Видите только вы. Здесь ваши запросы и уточнения Хью.' }] : [])];
      let current = null;
      const open = entry => {
        current?.stop(); shell.classList.add('sbc-chats--open');
        for (const b of nav.children) b.setAttribute('aria-current', String(b.dataset.room === entry.room));
        const holder = node('div', 'sbc-holder'), back = node('button', 'plain-button sbc-back', '← Чаты'); back.type = 'button';
        back.onclick = () => { shell.classList.remove('sbc-chats--open'); };
        main.replaceChildren(back, holder);
        current = conversation(holder, ctx, { room: entry.room, title: entry.name, hint: entry.hint });
      };
      for (const entry of entries) {
        const b = node('button', 'sbc-room'); b.type = 'button'; b.dataset.room = entry.room;
        b.append(node('span', 'sbc-room__name', entry.name), node('small', '', entry.room === 'common' ? 'Вся команда' : entry.room.startsWith('hugh:') ? 'Лог · только вы' : 'Личный чат'));
        b.onclick = () => open(entry); nav.append(b);
      }
      if (!rooms.people.length) nav.insertBefore(node('p', 'sbc-muted', 'Других сотрудников компании пока нет.'), nav.children[1]);
      const wanted = ctx.route?.params?.get('room');
      open(entries.find(e => e.room === wanted) || entries[0]);
      if (!wanted && window.matchMedia?.('(max-width: 720px)').matches) shell.classList.remove('sbc-chats--open');
      el._sbc = { stop: () => current?.stop() };
    },
    unmount(el) { el._sbc?.stop(); }
  };
  const register = (id, definition) => {
    if (window.SynapseModules?.register) window.SynapseModules.register(id, definition);
    else (window.SynapseModulesQueue = window.SynapseModulesQueue || []).push([id, definition]);
  };
  register('chats', chats);
  register('hugh-chat', hughChat);
})();
