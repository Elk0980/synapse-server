/* Съёмка (№98 · В): суфлёр и «Поделиться». Работает без сети и ничего не пишет на сервер.
   Суфлёр: весь сценарий или реплики одного актёра, скорость, старт/пауза касанием, стоп, назад,
   зеркало, размер шрифта. «Поделиться»: на телефоне navigator.share, на ПК Telegram/WhatsApp/VK
   и «Скопировать» для MAX; PNG и PDF с выделенными цветом репликами актёра. */
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
      const label = frame.type === 'line' ? `${own ? '▶ ' + frame.actor.toUpperCase() : frame.actor}: ${frame.text}`
        : frame.type === 'insert' ? `[Вставка: ${frame.text}]` : `(${frame.text})`;
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

  /* Выбор актёра и «Поделиться» рядом с ним. state — общий объект {actor} карточки и суфлёра. */
  function shareControls({parsed, title, state = {actor: parsed.actors[0] || ''}, onActor}) {
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
    const menu = h('div', {class: 'shoot-share__menu', hidden: true, role: 'menu'},
      h('a', {role: 'menuitem', target: '_blank', rel: 'noopener', 'data-share': 'telegram', text: 'Telegram'}),
      h('a', {role: 'menuitem', target: '_blank', rel: 'noopener', 'data-share': 'whatsapp', text: 'WhatsApp'}),
      h('a', {role: 'menuitem', target: '_blank', rel: 'noopener', 'data-share': 'vk', text: 'ВКонтакте',
        onclick: () => copy('Текст скопирован: вставьте его в сообщение ВКонтакте')}),
      h('button', {type: 'button', role: 'menuitem', 'data-share': 'copy', text: 'Скопировать (для MAX)', onclick: () => copy('Текст скопирован — вставьте в MAX')}),
      h('button', {type: 'button', role: 'menuitem', 'data-share': 'png', text: 'Картинка PNG', onclick: () => shareFile('png')}),
      h('button', {type: 'button', role: 'menuitem', 'data-share': 'pdf', text: 'PDF', onclick: () => shareFile('pdf')}));
    const refreshLinks = () => {
      const cabinet = `${root.location.origin}/cabinet.html`;
      menu.querySelector('[data-share=telegram]').href = `https://t.me/share/url?url=${enc(text('**'))}`;
      menu.querySelector('[data-share=whatsapp]').href = `https://wa.me/?text=${enc(text('*'))}`;
      menu.querySelector('[data-share=vk]').href = `https://vk.com/share.php?url=${enc(cabinet)}&title=${enc(title || 'Сценарий')}&comment=${enc(text(''))}`;
    };
    const button = h('button', {type: 'button', class: 'plain-button shoot-share__button', 'aria-haspopup': 'menu', 'aria-label': 'Поделиться сценарием', text: '⤴ Поделиться',
      onclick: async () => {
        if (mobile()) {
          try { await root.navigator.share({title, text: text('**')}); say('Отправлено'); return; }
          catch (error) { if (error?.name === 'AbortError') return; }
        }
        refreshLinks(); menu.hidden = !menu.hidden;
      }});
    const select = parsed.hasRoles ? h('select', {class: 'shoot-share__actor', 'aria-label': 'Актёр',
      onchange: (event) => { state.actor = event.target.value; refreshLinks(); onActor?.(state.actor); }},
      onActor ? h('option', {value: '', text: 'Весь сценарий', selected: !state.actor}) : null,
      parsed.actors.map((name) => h('option', {value: name, text: name, selected: name === state.actor}))) : null;
    return h('div', {class: 'shoot-share'}, select, button, menu, status);
  }

  function open({parsed, title}) {
    const doc = root.document;
    const state = {actor: '', speed: 4, font: 44, mirror: false, playing: false, pos: 0};
    let frame = 0, last = 0, lock = null;
    const text = h('div', {class: 'prompter__text'});
    const viewport = h('div', {class: 'prompter__viewport', 'aria-label': 'Текст суфлёра. Коснитесь, чтобы запустить или остановить', onclick: () => toggle()}, text);
    const speedLabel = h('span', {class: 'prompter__value', 'aria-live': 'polite'});
    const fontLabel = h('span', {class: 'prompter__value'});
    const playButton = h('button', {type: 'button', 'data-act': 'play', onclick: () => toggle()});
    const btn = (act, label, aria, fn) => h('button', {type: 'button', 'data-act': act, 'aria-label': aria, text: label, onclick: fn});
    const overlay = h('div', {class: 'prompter', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Суфлёр'},
      h('div', {class: 'prompter__bar'},
        shareControls({parsed, title, state, onActor: () => { layout(); stop(); }}),
        h('span', {class: 'prompter__group'}, btn('slower', '−', 'Медленнее', () => setSpeed(-1)), speedLabel, btn('faster', '+', 'Быстрее', () => setSpeed(1))),
        h('span', {class: 'prompter__group'}, btn('smaller', 'A−', 'Мельче', () => setFont(-6)), fontLabel, btn('bigger', 'A+', 'Крупнее', () => setFont(6))),
        btn('mirror', '⇋ Зеркало', 'Зеркальный режим', () => { state.mirror = !state.mirror; render(); }),
        btn('back', '↑ Назад', 'Назад', () => { state.pos = Math.max(0, state.pos - viewport.clientHeight * 0.3 - 3 * state.font); render(); }),
        btn('stop', '■ Стоп', 'Стоп', () => stop()), playButton,
        btn('close', '✕', 'Закрыть суфлёр', () => close())),
      viewport);
    function layout() {
      const rows = [];
      parsed.frames.forEach((item, index) => {
        if (state.actor && !(item.type === 'line' && item.actor === state.actor)) return;
        const prev = parsed.frames[index - 1];
        if (state.actor && prev) rows.push(h('p', {class: 'prompter__cue', text: prev.type === 'line' ? `${prev.actor}: ${prev.text}` : `(${prev.text})`}));
        const own = item.type === 'line' && (!state.actor || item.actor === state.actor);
        rows.push(h('p', {class: `prompter__line${own && state.actor ? ' prompter__line--own' : ''}`},
          item.type === 'line' ? h('b', {text: `${item.actor}: `}) : null, item.type === 'line' ? item.text : `(${item.text})`));
      });
      text.replaceChildren(...rows, h('p', {class: 'prompter__end', text: '— конец —'}));
      state.pos = 0; render();
    }
    function render() {
      text.style.fontSize = `${state.font}px`;
      text.style.transform = `translateY(${-Math.round(state.pos)}px)${state.mirror ? ' scaleX(-1)' : ''}`;
      overlay.classList.toggle('is-mirror', state.mirror); overlay.classList.toggle('is-playing', state.playing);
      speedLabel.textContent = `Скорость ${state.speed}`; fontLabel.textContent = `${state.font}px`;
      playButton.textContent = state.playing ? '❚❚ Пауза' : '▶ Старт';
    }
    function tick(now) {
      if (!state.playing) return;
      const dt = last ? Math.min(0.1, Math.max(0, (now - last) / 1000)) : 0; last = now;
      const max = Math.max(0, text.scrollHeight - viewport.clientHeight * 0.5);
      state.pos = Math.min(max || Infinity, state.pos + state.speed * 18 * dt);
      if (max && state.pos >= max) state.playing = false;
      render();
      if (state.playing) frame = root.requestAnimationFrame(tick);
    }
    function toggle() {
      state.playing = !state.playing; last = 0; render();
      if (state.playing) frame = root.requestAnimationFrame(tick); else root.cancelAnimationFrame(frame);
    }
    function stop() { state.playing = false; root.cancelAnimationFrame(frame); state.pos = 0; render(); }
    const setSpeed = (delta) => { state.speed = Math.min(15, Math.max(1, state.speed + delta)); render(); };
    const setFont = (delta) => { state.font = Math.min(120, Math.max(20, state.font + delta)); render(); };
    const keys = (event) => {
      if (event.key === 'Escape') close();
      else if (event.key === ' ' && event.target === doc.body) { event.preventDefault(); toggle(); }
      else if (event.key === 'ArrowUp') { state.pos = Math.max(0, state.pos - 3 * state.font); render(); }
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
    return {close, overlay, state, toggle};
  }

  return {open, shareControls, pdfFromJpeg, renderCanvas};
});
