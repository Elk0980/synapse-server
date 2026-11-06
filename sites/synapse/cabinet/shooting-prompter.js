/* Съёмка (№98 · В; макет Влада 07.11, №206): суфлёр и «Поделиться». Работает без сети и ничего не пишет на сервер.
   Суфлёр — окно во весь экран: выбор актёра («Все»), одна кнопка ▶/⏸, скорость 1×/1.2×/1.5×/2×, полоса
   прокрутки справа. «Поделиться»: на телефоне navigator.share, на ПК Telegram/WhatsApp/VK и «MAX · Скопировать»;
   форматы Текст, PNG и PDF с выделенными цветом репликами актёра. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SbShooting = root.SbShooting || {}).prompter = api;
})(typeof window !== 'undefined' ? window : globalThis, (root) => {
  'use strict';
  const S = () => root.SbShooting || {};
  const h = (tag, attrs = {}, ...children) => {
    const node = root.document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value; else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value); else node.setAttribute(key, value === true ? '' : value);
    }
    children.flat().forEach((child) => child !== null && child !== undefined && node.append(child));
    return node;
  };
  const enc = (value) => encodeURIComponent(value);
  const mobile = () => typeof root.navigator?.share === 'function' && Boolean(root.matchMedia?.('(pointer: coarse)')?.matches);

  /* PDF из JPEG без библиотек: одна страница шириной A4, высота по картинке. Кириллицу
     рисует canvas, поэтому шрифты в PDF не нужны. */
  function pdfFromJpeg(jpeg, width, height) {
    const pageW = 595, pageH = Math.round(height * pageW / width);
    const text = (value) => new TextEncoder().encode(value);
    const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
      [`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, '\nendstream'],
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
    const parts = [text('%PDF-1.4\n')], offsets = [];
    let size = parts[0].length;
    objects.forEach((body, index) => {
      offsets.push(size);
      const chunk = [text(`${index + 1} 0 obj\n`), ...(Array.isArray(body) ? body : [body]).map((p) => typeof p === 'string' ? text(p) : p), text('\nendobj\n')];
      chunk.forEach((p) => { parts.push(p); size += p.length; });
    });
    const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}` +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
    parts.push(text(xref));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0; parts.forEach((p) => { out.set(p, at); at += p.length; });
    return out;
  }

  /* Картинка сценария: реплики актёра на жёлтой подложке и жирным, остальное обычным. */
  function renderCanvas(parsed, actor, title) {
    const canvas = root.document.createElement('canvas');
    const g = canvas.getContext?.('2d');
    if (!g) return null;
    const W = 1080, pad = 64, size = 38, lineH = 54, maxW = W - pad * 2;
    const rows = [];
    const wrap = (value, bold) => {
      g.font = `${bold ? 700 : 400} ${size}px system-ui, sans-serif`;
      const out = []; let line = '';
      for (const word of String(value).split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (g.measureText(next).width > maxW - 24 && line) { out.push(line); line = word; } else line = next;
      }
      if (line) out.push(line);
      return out;
    };
    for (const frame of parsed.frames) {
      const own = frame.type === 'line' && frame.actor === actor;
      const label = `Сцена №${frame.n}  ` + (frame.type === 'line' ? `${own ? '▶ ' + frame.actor.toUpperCase() : frame.actor}: ${frame.text}`
        : frame.type === 'insert' ? `[Вставка: ${frame.text}]` : `(${frame.text})`);
      rows.push({lines: wrap(label, own), own});
    }
    const height = pad * 2 + 80 + rows.reduce((n, r) => n + r.lines.length * lineH + 18, 0);
    canvas.width = W; canvas.height = height;
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, height);
    g.fillStyle = '#111111'; g.font = `700 ${size + 6}px system-ui, sans-serif`; g.fillText(title || 'Сценарий', pad, pad + 30);
    let y = pad + 80;
    for (const row of rows) {
      const block = row.lines.length * lineH;
      if (row.own) { g.fillStyle = '#ffe866'; g.fillRect(pad - 12, y - 4, maxW + 24, block + 8); }
      g.fillStyle = row.own ? '#000000' : '#333333'; g.font = `${row.own ? 700 : 400} ${size}px system-ui, sans-serif`;
      row.lines.forEach((line, i) => g.fillText(line, pad, y + (i + 1) * lineH - 14));
      y += block + 18;
    }
    return canvas;
  }
  const blobOf = (canvas, type) => new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
  async function fileFor(kind, parsed, actor, title) {
    const canvas = renderCanvas(parsed, actor, title);
    if (!canvas || typeof canvas.toBlob !== 'function') throw new Error('Картинка недоступна в этом браузере — используйте текст');
    const name = `scenario-${(actor || 'all').replace(/[^\p{L}\p{N}]+/gu, '-')}`;
    if (kind === 'png') return new root.File([await blobOf(canvas, 'image/png')], `${name}.png`, {type: 'image/png'});
    const jpeg = new Uint8Array(await (await blobOf(canvas, 'image/jpeg')).arrayBuffer());
    return new root.File([pdfFromJpeg(jpeg, canvas.width, canvas.height)], `${name}.pdf`, {type: 'application/pdf'});
  }
  function download(file) {
    const url = root.URL.createObjectURL(file);
    const link = h('a', {href: url, download: file.name}); root.document.body.append(link); link.click(); link.remove();
    setTimeout(() => root.URL.revokeObjectURL(url), 30000);
  }

  /* Значок «Поделиться» — три точки, соединённые линиями (как в телефонах). */
  const SHARE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" stroke="currentColor" aria-hidden="true">'
    + '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>'
    + '<path d="M8.6 10.5l6.8-4M8.6 13.5l6.8 4" stroke-width="2" fill="none"/></svg>';

  /* Выбор актёра («Все» — весь сценарий) и «Поделиться» рядом. state — общий объект {actor} с суфлёром.
     Телефон — системное меню navigator.share; ПК — Telegram / WhatsApp / VK / «MAX · Скопировать»
     и форматы Текст / PNG / PDF. */
  function shareControls({parsed, title, state = {actor: ''}, onActor}) {
    const status = h('span', {class: 'shoot-share__status', role: 'status'});
    const say = (message) => { status.textContent = message; };
    const text = (bold) => S().script.shareText(parsed, state.actor, {title, bold});
    const copy = async (message) => {
      try { await root.navigator.clipboard.writeText(text('**')); say(message); } catch { say('Не удалось скопировать — выделите текст в суфлёре'); }
    };
    const shareFile = async (kind) => {
      try {
        const file = await fileFor(kind, parsed, state.actor, title);
        if (mobile() && root.navigator.canShare?.({files: [file]})) await root.navigator.share({files: [file], title});
        else { download(file); say(`${kind.toUpperCase()} сохранён — отправьте его актёру`); }
      } catch (error) { if (error?.name !== 'AbortError') say(error.message); }
    };
    const who = h('span', {class: 'shoot-share__who'});
    const menu = h('div', {class: 'shoot-share__menu', hidden: true, role: 'menu', 'aria-label': 'Поделиться репликами'},
      h('b', {class: 'shoot-share__label'}, 'Поделиться репликами', who),
      h('div', {class: 'shoot-share__row'},
        h('a', {role: 'menuitem', target: '_blank', rel: 'noopener', 'data-share': 'telegram', text: 'Telegram'}),
        h('a', {role: 'menuitem', target: '_blank', rel: 'noopener', 'data-share': 'whatsapp', text: 'WhatsApp'}),
        h('a', {role: 'menuitem', target: '_blank', rel: 'noopener', 'data-share': 'vk', text: 'VK',
          onclick: () => copy('Текст скопирован: вставьте его в сообщение ВКонтакте')}),
        h('button', {type: 'button', role: 'menuitem', 'data-share': 'copy', text: 'MAX · Скопировать', onclick: () => copy('Текст скопирован — вставьте в MAX')})),
      h('span', {class: 'shoot-share__label'}, 'Формат'),
      h('div', {class: 'shoot-share__row'},
        h('button', {type: 'button', role: 'menuitem', 'data-share': 'text', text: 'Текст', onclick: () => copy('Текст скопирован — вставьте в сообщение')}),
        h('button', {type: 'button', role: 'menuitem', 'data-share': 'png', text: 'PNG', onclick: () => shareFile('png')}),
        h('button', {type: 'button', role: 'menuitem', 'data-share': 'pdf', text: 'PDF', onclick: () => shareFile('pdf')})),
      status);
    const refreshLinks = () => {
      const cabinet = `${root.location.origin}/cabinet.html`;
      who.textContent = state.actor ? ` · ${state.actor}` : ' · весь сценарий';
      menu.querySelector('[data-share=telegram]').href = `https://t.me/share/url?url=${enc(text('**'))}`;
      menu.querySelector('[data-share=whatsapp]').href = `https://wa.me/?text=${enc(text('*'))}`;
      menu.querySelector('[data-share=vk]').href = `https://vk.com/share.php?url=${enc(cabinet)}&title=${enc(title || 'Сценарий')}&comment=${enc(text(''))}`;
    };
    const button = h('button', {type: 'button', class: 'shoot-share__button', 'aria-haspopup': 'menu', 'aria-label': 'Поделиться репликами', title: 'Поделиться репликами',
      onclick: async () => {
        if (mobile()) {
          try { await root.navigator.share({title, text: text('**')}); say('Отправлено'); return; }
          catch (error) { if (error?.name === 'AbortError') return; }
        }
        refreshLinks(); menu.hidden = !menu.hidden;
        button.setAttribute('aria-expanded', String(!menu.hidden));
      }});
    button.innerHTML = SHARE_ICON;
    const select = parsed.hasRoles ? h('select', {class: 'shoot-share__actor', 'aria-label': 'Актёр',
      onchange: (event) => { state.actor = event.target.value; refreshLinks(); onActor?.(state.actor); }},
      h('option', {value: '', text: 'Все', selected: !state.actor}),
      parsed.actors.map((name) => h('option', {value: name, text: name, selected: name === state.actor}))) : null;
    return h('div', {class: 'shoot-share'}, select, button, menu);
  }

  const SPEEDS = [1, 1.2, 1.5, 2];
  const BASE = 72; // px/с при 1× — прежняя скорость суфлёра по умолчанию (4 × 18)

  /* Суфлёр — окно во весь экран: «← Съёмка», справа актёр и «Поделиться»; сцены «Сцена №N», реплики
     выбранного актёра выделены (▶ ИМЯ), остальные приглушены; одна кнопка ▶/⏸, скорость 1× → 1.2× → 1.5× → 2×,
     полоса прокрутки справа показывает место в сценарии и тянется. Прокрутка — прежняя: translateY по кадрам. */
  function open({parsed, title, subtitle = '', backLabel = '← Съёмка'}) {
    const doc = root.document;
    const narrow = (root.innerWidth || 1024) < 600;
    const state = {actor: '', speed: 0, font: narrow ? 30 : 40, playing: false, pos: 0};
    let frame = 0, last = 0, lock = null, drag = null;
    const text = h('div', {class: 'prompter__text'});
    const viewport = h('div', {class: 'prompter__viewport', 'aria-label': 'Текст суфлёра. Коснитесь, чтобы запустить или остановить', onclick: () => toggle()}, text);
    const thumb = h('span', {class: 'prompter__thumb'});
    const track = h('div', {class: 'prompter__track', role: 'scrollbar', 'aria-orientation': 'vertical', 'aria-label': 'Место в сценарии — можно тянуть',
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', tabindex: '0'}, thumb);
    const playButton = h('button', {type: 'button', class: 'prompter__play', 'data-act': 'play', onclick: () => toggle()});
    const speedButton = h('button', {type: 'button', class: 'prompter__speed', 'data-act': 'speed', 'aria-label': 'Скорость', title: 'Скорость: 1× → 1.2× → 1.5× → 2×',
      onclick: () => { state.speed = (state.speed + 1) % SPEEDS.length; render(); }});
    const overlay = h('div', {class: 'prompter', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Суфлёр'},
      h('div', {class: 'prompter__bar'},
        h('button', {type: 'button', class: 'prompter__back', 'data-act': 'close', text: backLabel, onclick: () => close()}),
        h('span', {class: 'prompter__title', title: subtitle || null}, h('b', {text: title || 'Суфлёр'}), subtitle ? h('span', {text: ` ${subtitle}`}) : null),
        shareControls({parsed, title: [title, subtitle].filter(Boolean).join(' · '), state, onActor: () => layout()})),
      h('div', {class: 'prompter__body'}, viewport, track),
      h('div', {class: 'prompter__controls'}, playButton, h('span', {class: 'prompter__sp'}), speedButton));
    const maxPos = () => Math.max(0, text.scrollHeight - viewport.clientHeight * 0.5);
    function layout() {
      const rows = parsed.frames.map((item) => {
        const own = Boolean(state.actor) && item.type === 'line' && item.actor === state.actor;
        const dim = Boolean(state.actor) && !own;
        const say = item.type === 'line'
          ? (own ? [h('b', {class: 'prompter__who', text: `▶ ${item.actor.toUpperCase()}: `}), h('b', {text: item.text})] : [h('span', {class: 'prompter__who', text: `${item.actor}: `}), item.text])
          : [`(${item.text})`];
        return h('p', {class: `prompter__line${own ? ' prompter__line--own' : ''}${dim ? ' prompter__line--dim' : ''}`, 'data-scene': item.n},
          h('b', {class: 'prompter__scene', text: `Сцена №${item.n} `}), ...say);
      });
      text.replaceChildren(...rows, h('p', {class: 'prompter__end', text: '— конец —'}));
      render();
    }
    function render() {
      text.style.fontSize = `${state.font}px`;
      text.style.transform = `translateY(${-Math.round(state.pos)}px)`;
      overlay.classList.toggle('is-playing', state.playing);
      playButton.textContent = state.playing ? '⏸' : '▶';
      playButton.setAttribute('aria-label', state.playing ? 'Пауза' : 'Старт');
      speedButton.textContent = `${SPEEDS[state.speed]}×`;
      const max = maxPos(), view = viewport.clientHeight || 0, total = text.scrollHeight || 0;
      const ratio = max ? Math.min(1, state.pos / max) : 0;
      const size = total ? Math.max(8, Math.min(100, (view / total) * 100)) : 100;
      thumb.style.height = `${size}%`;
      thumb.style.top = `${ratio * (100 - size)}%`;
      track.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    }
    function tick(now) {
      if (!state.playing) return;
      const dt = last ? Math.min(0.1, Math.max(0, (now - last) / 1000)) : 0; last = now;
      const max = maxPos();
      state.pos = Math.min(max || Infinity, state.pos + SPEEDS[state.speed] * BASE * dt);
      if (max && state.pos >= max) state.playing = false;
      render();
      if (state.playing) frame = root.requestAnimationFrame(tick);
    }
    function toggle() {
      state.playing = !state.playing; last = 0; render();
      if (state.playing) frame = root.requestAnimationFrame(tick); else root.cancelAnimationFrame(frame);
    }
    const seek = (pos) => { state.pos = Math.max(0, Math.min(maxPos(), pos)); render(); };
    /* Полоса прокрутки: нажатие ставит место, перетаскивание ведёт его; суфлёр при этом не останавливается. */
    const fromPointer = (event) => {
      const box = track.getBoundingClientRect();
      const ratio = box.height ? (event.clientY - box.top) / box.height : 0;
      seek(Math.max(0, Math.min(1, ratio)) * maxPos());
    };
    track.addEventListener('pointerdown', (event) => {
      drag = event.pointerId ?? 1; track.setPointerCapture?.(drag); fromPointer(event); event.preventDefault();
    });
    track.addEventListener('pointermove', (event) => { if (drag !== null) fromPointer(event); });
    const endDrag = () => { if (drag !== null) track.releasePointerCapture?.(drag); drag = null; };
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);
    viewport.addEventListener('wheel', (event) => { event.preventDefault(); seek(state.pos + event.deltaY); }, {passive: false});
    const keys = (event) => {
      if (event.key === 'Escape') close();
      else if (event.key === ' ' && (event.target === doc.body || event.target === overlay)) { event.preventDefault(); toggle(); }
      else if (event.key === 'ArrowUp') seek(state.pos - 3 * state.font);
      else if (event.key === 'ArrowDown') seek(state.pos + 3 * state.font);
    };
    function close() {
      state.playing = false; root.cancelAnimationFrame(frame); doc.removeEventListener('keydown', keys);
      lock?.release?.().catch?.(() => {}); lock = null;
      if (doc.fullscreenElement === overlay) doc.exitFullscreen?.().catch?.(() => {});
      overlay.remove(); doc.body.classList.remove('prompter-open');
    }
    doc.body.append(overlay); doc.body.classList.add('prompter-open');
    doc.addEventListener('keydown', keys);
    overlay.requestFullscreen?.()?.catch?.(() => {});
    root.navigator?.wakeLock?.request?.('screen').then((value) => { lock = value; }).catch(() => {});
    layout();
    return {close, overlay, state, toggle, seek};
  }

  return {open, shareControls, pdfFromJpeg, renderCanvas, SPEEDS};
});
