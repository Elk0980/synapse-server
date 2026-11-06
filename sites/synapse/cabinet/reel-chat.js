'use strict';
/* №166 · Рилс на согласование в общем чате компании и итоги публикации.
   Сообщения kind='reel-approval' (карточка) и kind='reel-published' (итоги) пишет content из CRM; здесь только показ
   и две кнопки. «Согласовано» = существующее согласование версии публикации, «Нужны правки» = существующий requestEdit
   «Материалов». Права, компания и CSRF проверяются на сервере; кнопки по правам кабинета — только подсказка.
   Чат ничего не публикует: публикацию ставят в план в «Постинге». Ссылки — только https из ответа CRM. */
(() => {
  const node = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined && text !== null) n.textContent = text; return n; };
  const safe = value => { if (typeof value !== 'string' || !value.trim()) return ''; try { const url = new URL(value, location.href); return (url.protocol === 'https:' || url.origin === location.origin) && /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; } };
  const time = value => { const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ru-RU', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };
  const parse = value => { try { const data = JSON.parse(value || 'null'); return data && typeof data === 'object' ? data : null; } catch { return null; } };
  const can = (ctx, permission) => typeof ctx.can === 'function' ? ctx.can(permission) : ctx.user?.role === 'owner' || (ctx.permissions || []).includes(permission);
  const button = (text, className) => { const b = node('button', className, text); b.type = 'button'; return b; };
  const human = error => error?.status === 403 ? 'Нет права на это действие в этой компании.'
    : error?.status === 409 ? (error.message || 'Карточка изменилась. Обновите чат.')
    : error?.status === 400 ? (error.message || 'Проверьте данные.')
    : 'Связь не подтвердила результат. Повтор безопасен: второе решение не создаётся.';
  const CLASS = { pending: 'wait', returned: 'wait', approved: 'ok', scheduled: 'ok', publishing: 'ok', published: 'ok', partial: 'warn', changes_requested: 'warn', superseded: 'off', stale: 'off', unavailable: 'off' };

  /* Плеер карточки. Отдельная функция: когда общий рендер видео чата (ветка claude/chat-links-video) будет в main, её можно заменить им. */
  function player(url) {
    const box = node('div', 'rc-player');
    if (!url) { box.append(node('p', 'rc-muted', 'Файл ролика недоступен')); return box; }
    const video = node('video'); video.controls = true; video.playsInline = true; video.setAttribute('playsinline', ''); video.preload = 'metadata';
    // Отдельного файла обложки у роликов нет: кадр 0,1 с служит постером (как в сетке «Материалов»).
    video.src = `${url}#t=0.1`; video.setAttribute('aria-label', 'Рилс на согласование');
    box.append(video); return box;
  }

  function card(message, env) {
    const { ctx } = env; let data = parse(message.payload) || {}, busy = false;
    const li = node('li', 'sbc-msg sbc-msg--reel'); li.dataset.reelApproval = String(data.approvalId || '');
    const author = node('strong', '', message.author_name), box = node('div', 'rc-card');
    const media = player(safe(data.mediaUrl)), body = node('div', 'rc-body');
    const title = node('h3', 'rc-title'), caption = node('p', 'rc-caption'), chips = node('ul', 'rc-chips'), status = node('p', 'rc-status');
    const who = node('p', 'rc-muted'), note = node('p', 'rc-note'), actions = node('div', 'rc-actions');
    note.setAttribute('role', 'status');
    const publishBtn = button('Опубликовать сейчас', 'rc-btn rc-btn--ok'), laterBtn = button('Опубликовать в …', 'rc-btn');
    const approveBtn = button('Согласовано', 'rc-btn rc-btn--ok'), changesBtn = button('Нужны правки', 'rc-btn rc-btn--warn'), postingBtn = button('Открыть в «Постинге»', 'rc-btn');
    body.append(title, caption, chips, status, who, actions, note); box.append(media, body);
    li.append(author, box, node('time', '', time(message.created_at)));
    const video = () => media.querySelector('video');
    function paint() {
      title.replaceChildren(document.createTextNode(data.title || 'Рилс'), node('span', 'rc-version', ` v${data.version ?? 1}`));
      caption.textContent = data.caption || ''; caption.hidden = !data.caption;
      chips.replaceChildren(...(data.platforms || []).map(p => node('li', '', p.label || p.id)));
      status.className = `rc-status rc-status--${CLASS[data.status] || 'wait'}`;
      const date = data.status === 'scheduled' && data.scheduledAt ? ` на ${time(data.scheduledAt)}` : '';
      status.textContent = (data.statusLabel || 'Ждёт согласования') + date;
      const lines = [`Отправил(а): ${data.requestedBy?.name || message.author_name}${data.requestedAt ? ', ' + time(data.requestedAt) : ''}`];
      if (data.approvedBy) lines.push(`Согласовал(а): ${data.approvedBy}${data.approvedAt ? ', ' + time(data.approvedAt) : ''}`);
      if (data.returned) lines.push(`Вернул(а) на доработку: ${data.returned.byName || '—'}${data.returned.comment ? ' — ' + data.returned.comment : ''}`);
      if (data.edit) lines.push(`Правки: ${data.edit.byName || '—'}${data.edit.at ? ', ' + time(data.edit.at) : ''} — «${data.edit.comment}»${data.edit.taskId ? ` · задача №${data.edit.taskId} на доске` : ''}`);

      who.textContent = lines.join('\n');
      const open = data.open === true, mayApprove = can(ctx, 'autoposting.approve'), mayEdit = can(ctx, 'autoposting.edit');
      const list = [];
      if (open && mayApprove) list.push(approveBtn);
      if (open && mayEdit) list.push(changesBtn);
      if (mayEdit && data.status === 'approved') list.push(publishBtn, laterBtn);
      if (!open && mayEdit && data.postId && ['approved', 'scheduled'].includes(data.status) && window.SbCabinet?.openPostingDraft) list.push(postingBtn);
      actions.replaceChildren(...list); actions.hidden = !list.length;
      if (open && !mayApprove && !mayEdit) note.textContent = 'Согласует владелец или сотрудник с правом согласования публикаций.';
      for (const b of list) b.disabled = busy;
    }
    publishBtn.onclick = () => act('publish', {});
    laterBtn.onclick = () => {
      if (li.querySelector('[data-publish-date]')) return;
      const form = node('form', 'rc-actions'), date = node('input'), submit = button('Опубликовать в …', 'rc-btn');
      date.type = 'datetime-local';date.required = true;date.dataset.publishDate = '';date.setAttribute('aria-label', 'Дата и время публикации');submit.type = 'submit';
      form.append(date, submit);body.append(form);
      form.onsubmit = async event => {event.preventDefault();if(!date.value)return;await act('publish', {scheduledAt:new Date(date.value).toISOString()});if(data.status==='scheduled')form.remove();};
    };
    const path = action => `crm/autoposting/reels/${Number(data.reelId)}/chat-approvals/${Number(data.approvalId)}/${action}`;
    async function act(action, body) {
      if (busy) return false; busy = true; paint(); note.textContent = action === 'publish' ? 'Планирую публикацию…' : action === 'approve' ? 'Согласовываю…' : 'Отправляю правки…';
      try {
        const result = await ctx.api.post(path(action), body);
        if (result?.approval && result.approval.id === data.approvalId) data = { ...data, ...result.approval, approvalId: result.approval.id };
        note.textContent = action === 'publish' ? 'Публикация поставлена в план.' : action === 'approve' ? 'Согласовано. Публикация — по плану в «Постинге».' : `Правки отправлены${data.edit?.taskId ? ` — задача №${data.edit.taskId}` : ''}.`;
        env.reload?.(); return true;
      } catch (error) { note.textContent = human(error); return false; }
      finally { busy = false; paint(); }
    }
    approveBtn.onclick = () => { void act('approve', {}); };
    changesBtn.onclick = () => openChanges();
    postingBtn.onclick = () => window.SbCabinet.openPostingDraft(ctx, data.postId);

    /* «Нужны правки»: текст, по желанию — кадр из плеера (момент правки) или свой скриншот. */
    function openChanges() {
      if (busy || li.querySelector('.rc-dialog')) return;
      const overlay = node('div', 'rc-dialog'), panel = node('form', 'rc-dialog__panel');
      overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', 'Нужны правки');
      const text = node('textarea'); text.required = true; text.maxLength = 1800; text.rows = 4; text.placeholder = 'Что поправить? Например: убрать первые 2 секунды, ярче титр';
      const label = node('label', 'rc-field'); label.append(node('span', '', 'Что нужно поправить'), text);
      const frame = button('Кадр из плеера', 'rc-btn'), file = node('input'), fileLabel = node('label', 'rc-btn rc-file');
      file.type = 'file'; file.accept = 'image/jpeg,image/png,image/webp'; fileLabel.append(document.createTextNode('Свой скриншот'), file);
      const preview = node('div', 'rc-shot'), hint = node('p', 'rc-muted'), status = node('p', 'rc-note'), row = node('div', 'rc-actions');
      status.setAttribute('role', 'status');
      const send = node('button', 'rc-btn rc-btn--warn', 'Отправить правки'), cancel = button('Отмена', 'rc-btn'); send.type = 'submit';
      row.append(send, cancel);
      hint.textContent = 'Без отмеченного момента правка относится ко всему ролику. Правка уходит задачей монтажа на доску.';
      panel.append(node('h3', 'rc-title', 'Нужны правки'), label, (() => { const tools = node('div', 'rc-actions'); tools.append(frame, fileLabel); return tools; })(), preview, hint, row, status);
      overlay.append(panel); li.append(overlay); text.focus();
      let shot = null, moment = null;
      const show = (blob, caption) => {
        shot = blob; preview.replaceChildren();
        if (blob && typeof URL.createObjectURL === 'function') { const img = node('img'); img.alt = caption; img.src = URL.createObjectURL(blob); preview.append(img); }
        preview.append(node('span', 'rc-muted', caption));
      };
      frame.onclick = () => {
        const v = video();
        if (!v || !(v.videoWidth > 0)) { status.textContent = 'Сначала запустите ролик и остановите на нужном моменте.'; return; }
        moment = v.currentTime;
        try {
          const canvas = document.createElement('canvas'); canvas.width = v.videoWidth; canvas.height = v.videoHeight;
          canvas.getContext('2d').drawImage(v, 0, 0);
          canvas.toBlob(blob => show(blob, `Кадр ${moment.toFixed(1)} с`), 'image/jpeg', 0.85);
        } catch { show(null, `Момент ${moment.toFixed(1)} с (кадр не сохранился)`); }
      };
      file.onchange = () => { const f = file.files?.[0]; if (!f) return; if (!/^image\/(jpeg|png|webp)$/.test(f.type) || f.size > 10 * 1024 * 1024) { status.textContent = 'Нужна картинка JPEG, PNG или WebP до 10 МБ.'; return; } show(f, f.name); };
      const close = () => { overlay.remove(); changesBtn.focus?.(); };
      cancel.onclick = close;
      overlay.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
      panel.onsubmit = async event => {
        event.preventDefault(); if (busy) return;
        const comment = text.value.trim(); if (!comment) { status.textContent = 'Напишите, что поправить.'; return; }
        send.disabled = true; status.textContent = 'Отправляю…';
        const body = { comment }, v = video(), duration = v && Number.isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration * 1000) : null;
        if (duration) body.durationMs = duration;
        if (moment !== null && duration) { body.startMs = Math.max(0, Math.round(moment * 1000) - 1000); body.endMs = Math.min(duration, Math.round(moment * 1000) + 2000); }
        try {
          if (shot) {
            if (typeof ctx.api.raw !== 'function') throw Object.assign(Error('Скриншот не загружается в этой версии кабинета'), { status: 400 });
            const type = /^image\/(jpeg|png|webp)$/.test(shot.type) ? shot.type : 'image/jpeg';
            const response = await ctx.api.raw('POST', 'publishing-assets', shot, { headers: { 'Content-Type': type } });
            if (!response.ok) throw Object.assign(Error(response.status === 403 ? 'Нет права загружать скриншот' : 'Скриншот не загрузился'), { status: response.status === 403 ? 403 : 400 });
            const asset = await response.json(); if (!safe(asset?.url)) throw Object.assign(Error('Сервер не вернул адрес скриншота'), { status: 400 });
            body.screenshotUrl = asset.url;
          }
        } catch (error) { status.textContent = human(error); send.disabled = false; return; }
        const ok = await act('changes', body);
        if (ok) close(); else { status.textContent = note.textContent; send.disabled = false; }
      };
    }
    paint();
    return { el: li, update(next) { const value = parse(next.payload); if (value) { data = value; paint(); } } };
  }

  function result(message) {
    const data = parse(message.payload) || {}, li = node('li', 'sbc-msg sbc-msg--system rc-result');
    li.append(node('strong', '', message.author_name || 'Synapse · публикация'));
    const items = Array.isArray(data.items) ? data.items : [];
    const head = (message.text || '').split('\n')[0];
    li.append(node('p', 'rc-result__head', head));
    const list = node('ul', 'rc-result__list');
    for (const item of items) {
      const row = node('li', `rc-result__item rc-result__item--${item.state === 'published' ? 'ok' : 'warn'}`);
      row.append(node('b', '', `${item.label || item.platformId}: `));
      const url = item.state === 'published' ? safe(item.url) : '';
      if (url) {
        const a = node('a', '', url); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; row.append(a);
        if (item.source === 'receipt') row.append(node('span', 'rc-muted', ' (ссылка подтверждена вручную)'));
      } else if (item.state === 'published') {
        row.append(document.createTextNode(`опубликовано, ссылка недоступна (${item.source === 'onlypult' ? `ID задания Onlypult ${item.providerPostId}` : item.externalId ? `ID ${item.externalId}` : 'ID неизвестен'})`));
      } else row.append(document.createTextNode(`${item.state === 'uncertain' ? 'результат не подтверждён' : item.state === 'cancelled' ? 'не отправлено' : 'ошибка публикации'} — ${item.error || 'без подробностей'}`));
      list.append(row);
    }
    if (!items.length) list.append(node('li', '', message.text || ''));
    li.append(list, node('time', '', time(message.created_at)));
    return { el: li, update() {} };
  }

  window.SynapseReelChat = {
    supports: message => message?.kind === 'reel-approval' || message?.kind === 'reel-published',
    render: (message, env) => message.kind === 'reel-approval' ? card(message, env) : result(message)
  };
})();
