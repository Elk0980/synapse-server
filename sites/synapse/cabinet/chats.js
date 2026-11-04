'use strict';
/* «Чаты» и личный чат с Хью (№98 · Д). Модули контракта А: 'chats' и 'hugh-chat'.
   Сервер: /content/people/team-chat (PR 480/493 + комнаты), права и компания проверяются там. */
(() => {
  const node = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
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
    let taskBar = null;
    if (task) {
      taskBar = node('div', 'sbc-taskbar');
      taskBar.append(node('span', '', `Чат по задаче №${task.id}: ${task.title || ''}`), node('small', '', 'Уточнения попадут в задачу комментарием.'));
      const clear = node('button', 'plain-button', 'Обычный чат'); clear.type = 'button'; clear.onclick = () => onClearTask?.();
      taskBar.append(clear); head.append(taskBar);
    }
    list.setAttribute('role', 'log'); list.setAttribute('aria-live', 'polite'); notice.setAttribute('role', 'status');
    const form = node('form', 'sbc-compose'), text = node('textarea'), send = node('button', 'sbc-send', '➤');
    text.rows = 2; text.maxLength = 8000; text.required = true; text.placeholder = placeholder || 'Сообщение. Чтобы позвать Хью: «Хью, …»';
    text.setAttribute('aria-label', 'Сообщение'); send.type = 'submit'; send.setAttribute('aria-label', 'Отправить');
    form.append(text, send); box.append(head, older, list, notice, form); host.replaceChildren(box);
    const messages = new Map(); let pending = null, busy = false, viewer = null, stopped = false;
    const draftKey = `sbc:${ctx.companyCode}:${room}:${task?.id || ''}`;
    try { const saved = JSON.parse(sessionStorage.getItem(draftKey) || 'null'); if (saved) { text.value = saved.text || ''; pending = saved.pending || null; } } catch {}
    const save = () => { try { sessionStorage.setItem(draftKey, JSON.stringify({ text: text.value, pending })); } catch {} };
    function render() {
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      list.replaceChildren();
      for (const m of [...messages.values()].sort((a, b) => a.id - b.id)) {
        const li = node('li', m.user_id === 0 ? 'sbc-msg sbc-msg--hugh' : m.user_id === viewer ? 'sbc-msg sbc-msg--own' : 'sbc-msg');
        if (m.kind === 'hugh-merge') li.classList.add('sbc-msg--merge');
        li.append(node('strong', '', m.author_name), node('span', 'sbc-msg__text', m.text), node('time', '', time(m.created_at)));
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
      const data = await ctx.api.get('people/team-chat', { room, before });
      if (stopped || ctx.signal?.aborted) return;
      viewer = data.viewerId;
      for (const m of data.messages) messages.set(m.id, m);
      if (before || messages.size <= data.messages.length) older.hidden = !data.hasMore;
      render();
    }
    older.onclick = () => load(Math.min(...messages.keys())).catch(e => { notice.textContent = human(e); });
    form.onsubmit = async event => {
      event.preventDefault(); if (busy || !text.value.trim()) return;
      pending ||= { text: text.value.trim(), clientMessageId: uid(), room, ...(task ? { taskId: task.id } : {}) };
      busy = true; send.disabled = true; text.readOnly = true; save(); notice.textContent = 'Отправляю…';
      try {
        const data = await ctx.api.post('people/team-chat', pending);
        messages.set(data.message.id, data.message); pending = null; text.value = ''; save(); notice.textContent = '';
        await load(); list.scrollTop = list.scrollHeight;
      } catch (error) { if (!ctx.signal?.aborted) notice.textContent = human(error); }
      finally { busy = false; send.disabled = false; text.readOnly = Boolean(pending); }
    };
    text.oninput = save;
    text.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit(); };
    if (pending) { text.readOnly = true; notice.textContent = 'Есть неподтверждённая отправка. Нажмите ➤, чтобы проверить её результат.'; }
    const timer = setInterval(() => { if (!document.hidden && !busy) load().catch(() => {}); }, 5000);
    const stop = () => { stopped = true; clearInterval(timer); save(); };
    ctx.signal?.addEventListener('abort', stop, { once: true });
    load().catch(e => { notice.textContent = e?.status === 403 ? 'Нет доступа к этому чату.' : 'Не удалось загрузить чат. Обновите экран.'; render(); });
    return { stop, focus: () => text.focus(), prefill(value) { if (!text.value) text.value = value; text.focus(); } };
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
        { room: rooms.hugh, name: 'Хью · мой личный чат', hint: 'Видите только вы. Здесь ваши запросы и уточнения Хью.' }];
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
