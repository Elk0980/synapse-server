'use strict';
/* «Задачи» сотрудника (№98 · Д), модуль 'tasks' контракта А. Та же доска CRM, отфильтрованная по человеку:
   /content/people/my-board и /my-board/action. Порядок, пауза и «Удалённые» — личные, задача доски не стирается. */
(() => {
  const node = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
  const STATUS = { inbox: 'Входящие', planned: 'Запланировано', in_progress: 'В работе', done: 'Сделано', cancelled: 'Отменено' };
  const PRIORITY = { urgent: 'Срочно', high: 'Высокий', normal: 'Обычный', low: 'Низкий' };
  const FROM = { system: 'От системы', manager: 'От руководителя', me: 'Я поставил Хью' };
  const SECTIONS = [['assigned', 'Мне поставили'], ['hugh', 'Я поставил Хью'], ['deleted', 'Удалённые']];
  const definition = {
    title: 'Задачи',
    async mount(el, ctx) {
      let board = null, section = ['assigned', 'hugh', 'deleted'].includes(ctx.route?.params?.get('section')) ? ctx.route.params.get('section') : 'assigned', busy = false, dragId = null;
      const root = node('section', 'sbt'), head = node('div', 'sbt-head'), tabs = node('div', 'sbt-tabs'), list = node('ol', 'sbt-list'), notice = node('p', 'sbc-notice');
      tabs.setAttribute('role', 'tablist'); notice.setAttribute('role', 'status');
      head.append(node('h1', '', 'Задачи'));
      const ask = node('button', 'sbt-primary', 'Поставить задачу Хью'); ask.type = 'button';
      ask.onclick = () => openChat(null, 'Сделай ');
      head.append(ask);
      if (ctx.user?.role === 'owner') { const all = node('a', 'plain-button', 'Вся доска'); all.href = '/board.html'; head.append(all); }
      root.append(head, node('p', 'sbt-hint', 'Ваши задачи с общей доски компании. Порядок меняется перетаскиванием или стрелками; пауза и удаление видны только вам, данные задачи сохраняются.'), tabs, notice, list);
      el.replaceChildren(root);
      function openChat(task, prefill) {
        if (window.SynapseHughChat?.open({ task: task ? { id: task.id, title: task.title } : null, prefill })) return;
        ctx.openHughChat?.();
      }
      async function act(body, done) {
        if (busy) return; busy = true; notice.textContent = 'Сохраняю…';
        try { board = await ctx.api.post('people/my-board/action', body); notice.textContent = done || ''; render(); }
        catch (error) { notice.textContent = error?.status === 403 ? 'Нет права менять задачи.' : error?.status === 409 ? 'Задача изменилась. Обновите список.' : 'Не сохранилось. Повторите.'; }
        finally { busy = false; }
      }
      const move = (id, delta) => {
        const ids = board[section].map(t => t.id), from = ids.indexOf(id), to = from + delta;
        if (from < 0 || to < 0 || to >= ids.length) return;
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        act({ op: 'order', section, order: ids }, 'Порядок сохранён.');
      };
      function item(task, index, total) {
        const li = node('li', `sbt-item${task.paused ? ' sbt-item--paused' : ''}`); li.dataset.id = task.id;
        const live = section !== 'deleted';
        if (live) {
          li.draggable = true;
          li.ondragstart = e => { dragId = task.id; li.classList.add('sbt-item--drag'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(task.id)); };
          li.ondragend = () => { dragId = null; li.classList.remove('sbt-item--drag'); };
          li.ondragover = e => { if (dragId && dragId !== task.id) { e.preventDefault(); li.classList.add('sbt-item--over'); } };
          li.ondragleave = () => li.classList.remove('sbt-item--over');
          li.ondrop = e => {
            e.preventDefault(); li.classList.remove('sbt-item--over');
            const ids = board[section].map(t => t.id), from = ids.indexOf(dragId), to = ids.indexOf(task.id);
            if (from < 0 || to < 0 || from === to) return;
            ids.splice(to, 0, ids.splice(from, 1)[0]); act({ op: 'order', section, order: ids }, 'Порядок сохранён.');
          };
        }
        const main = node('div', 'sbt-item__main');
        const title = node('strong', 'sbt-item__title', task.title);
        const meta = node('div', 'sbt-item__meta');
        meta.append(node('span', `sbt-chip sbt-chip--${task.status}`, STATUS[task.status] || task.status));
        if (task.priority && task.priority !== 'normal') meta.append(node('span', `sbt-chip sbt-chip--${task.priority}`, PRIORITY[task.priority] || task.priority));
        if (task.paused) meta.append(node('span', 'sbt-chip sbt-chip--paused', 'На паузе'));
        meta.append(node('span', 'sbt-muted', `№${task.id} · ${FROM[task.from] || ''}${task.due_date ? ` · срок ${task.due_date}` : ''}${task.subtask_count ? ` · подзадачи ${task.subtask_done}/${task.subtask_count}` : ''}`));
        main.append(title, meta);
        const actions = node('div', 'sbt-item__actions');
        const button = (label, handler, cls = 'plain-button', aria) => { const b = node('button', cls, label); b.type = 'button'; if (aria) b.setAttribute('aria-label', aria); b.onclick = handler; actions.append(b); return b; };
        if (live) {
          button('↑', () => move(task.id, -1), 'plain-button sbt-arrow', `Выше: ${task.title}`).disabled = index === 0;
          button('↓', () => move(task.id, 1), 'plain-button sbt-arrow', `Ниже: ${task.title}`).disabled = index === total - 1;
          button(task.paused ? 'Продолжить' : 'Пауза', () => act({ op: task.paused ? 'resume' : 'pause', taskId: task.id }, task.paused ? 'Задача снова в работе.' : 'Задача на паузе.'));
          button('Чат с Хью', () => openChat(task));
          button('Удалить', () => act({ op: 'delete', taskId: task.id }, 'Перенесено в «Удалённые». Данные задачи сохранены.'), 'plain-button sbt-danger');
        } else button('Вернуть', () => act({ op: 'restore', taskId: task.id }, 'Задача возвращена.'));
        li.append(main, actions);
        return li;
      }
      function render() {
        tabs.replaceChildren();
        for (const [key, label] of SECTIONS) {
          const tab = node('button', 'sbt-tab', `${label} · ${board?.[key]?.length ?? 0}`); tab.type = 'button';
          tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(key === section));
          tab.onclick = () => { section = key; render(); }; tabs.append(tab);
        }
        list.replaceChildren();
        const rows = board?.[section] || [];
        rows.forEach((task, index) => list.append(item(task, index, rows.length)));
        if (!rows.length) list.append(node('li', 'sbt-empty', section === 'hugh' ? 'Вы ещё не ставили задач Хью. Напишите в чат: «Хью, сделай …».' : section === 'deleted' ? 'Удалённых задач нет.' : 'Назначенных вам задач нет.'));
      }
      render();
      try { board = await ctx.api.get('people/my-board'); if (!ctx.signal?.aborted) render(); }
      catch (error) { notice.textContent = error?.status === 403 ? 'Нет доступа к своим задачам в этой компании. Доступ выдаёт владелец.' : 'Не удалось загрузить задачи. Обновите экран.'; }
    }
  };
  if (window.SynapseModules?.register) window.SynapseModules.register('tasks', definition);
  else (window.SynapseModulesQueue = window.SynapseModulesQueue || []).push(['tasks', definition]);
})();
