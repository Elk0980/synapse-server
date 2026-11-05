/* Полотно блок-схемы. Изменение layout — только при завершённом перетаскивании/изменении размеров. */
'use strict';

(() => {
  const ZONES = ['source', 'client', 'staff', 'admin', 'common'];
  const MIN_ZOOM = .15, MAX_ZOOM = 2, PAD = 24, HEADER = 70, CARD_WIDTH = 360;
  const ROLE_MIN_HEIGHT = 3500, GAP = 240, RESIZE_GAP = 48;
  let prefs = { tool: 'move', zoom: null, left: null, top: null };
  const viewPrefs = new Map();
  let active = null, pendingToolbar = null;
  const plain = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const number = (value, fallback, min = 0, max = 32000) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const editable = (target) => !!target?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
  const snapshot = (geometry) => ({ width: geometry.width, height: geometry.height,
    zones: Object.fromEntries(Object.entries(geometry.zones).map(([id, zone]) => [id, { ...zone }])),
    nodes: Object.fromEntries(Object.entries(geometry.nodes).map(([id, node]) => [id, { ...node }])) });
  const effectiveTool = () => active?.space ? 'hand' : prefs.tool;
  const roleZone = (node) => ZONES.includes(node?.role) ? node.role : 'common';

  function toolbar(ctx) {
    const { h } = ctx;
    const button = (action, label, title) => h('button', { type: 'button', class: 'fc-tool', dataset: { canvasAction: action },
      text: label, title, onclick: () => {
        if (!active) return;
        if (action === 'move' || action === 'hand') setTool(action);
        else if (action === 'minus') zoomTo(scale() / 1.2);
        else if (action === 'plus') zoomTo(scale() * 1.2);
        else if (action === 'fit') fit();
      } });
    const bar = h('div', { class: 'fc-toolbar', role: 'toolbar', 'aria-label': 'Инструменты полотна' },
      h('div', { class: 'fc-toolbar__group' }, button('move', '↖ Перемещение', 'Перемещение карточек — V'), button('hand', '✋ Рука', 'Перемещение полотна — H')),
      h('div', { class: 'fc-toolbar__group' }, button('minus', '−', 'Уменьшить масштаб'),
        h('output', { class: 'fc-zoom', 'aria-label': 'Масштаб полотна', 'aria-live': 'polite', text: `${Math.round((prefs.zoom || .45) * 100)}%` }),
        button('plus', '+', 'Увеличить масштаб'), button('fit', 'Вместить', 'Вместить схему по ширине')),
      h('span', { class: 'fc-toolbar__hint', text: 'ЛКМ — карточка · Space / средняя / правая с перетаскиванием — полотно' }));
    pendingToolbar = bar;
    updateToolbar(bar);
    return bar;
  }

  function updateToolbar(bar = active?.toolbar) {
    if (!bar) return;
    for (const button of bar.querySelectorAll('[data-canvas-action]')) {
      const action = button.dataset.canvasAction;
      if (action === 'move' || action === 'hand') {
        const selected = effectiveTool() === action;
        button.classList.toggle('is-active', selected); button.setAttribute('aria-pressed', String(selected));
      }
    }
    const output = bar.querySelector('.fc-zoom');
    if (output) output.textContent = `${Math.round(scale() * 100)}%`;
  }

  function setTool(tool) {
    if (!active || !['move', 'hand'].includes(tool)) return;
    cancelGesture(); active.ctx.cancelConnection?.(); prefs.tool = tool;
    // Явное нажатие Move/V включает редактирование через Root, первое attach режим не меняет.
    if (tool === 'move' && active.ctx.mode !== 'edit') active.ctx.ensureEdit?.();
    updateCursor(); updateToolbar();
  }

  function scale() { return prefs.zoom || .45; }

  function zoneDefaults(id) {
    const separate = !!active?.ctx.scope;
    if (id === 'source') return { x: 160, y: 160, width: separate ? 1000 : 3480, height: 560 };
    if (id === 'common') return { x: 160, y: 4700, width: separate ? 1000 : 3480, height: 900 };
    return { x: separate ? 160 : 160 + ['client', 'staff', 'admin'].indexOf(id) * (1000 + GAP), y: 960, width: 1000, height: ROLE_MIN_HEIGHT };
  }

  function measuredHeight(el) {
    const measured = el.offsetHeight || el.getBoundingClientRect().height / scale();
    return measured > 0 ? measured : 100 + el.querySelectorAll('.node-action').length * 75;
  }

  function measure() {
    const a = active;
    if (!a || a.gesture) return a ? snapshot(a.geometry) : null;
    const global = plain(a.ctx.flow.layout), saved = a.ctx.scope ? plain(plain(global.views)[a.ctx.scope]) : global;
    const savedZones = plain(saved.zones), savedNodes = { ...plain(global.nodes), ...plain(saved.nodes) };
    const geometry = { width: number(saved.width, 4200, 1000), height: number(saved.height, 6400, 1000), zones: Object.create(null), nodes: Object.create(null) };
    for (const [id, element] of a.zoneElements) {
      const original = plain(plain(global.zones)[id]);
      const fallback = { ...zoneDefaults(id), ...(Number.isFinite(original.width) ? { width: original.width } : {}),
        ...(Number.isFinite(original.height) ? { height: original.height } : {}) }, stored = plain(savedZones[id]);
      geometry.zones[id] = { x: number(stored.x, fallback.x), y: number(stored.y, fallback.y),
        width: number(stored.width, fallback.width, 600, 6000), height: number(stored.height, fallback.height, 400, 12000) };
    }
    for (const [zoneId, zone] of Object.entries(geometry.zones)) {
      const items = [...a.nodeElements].filter(([id]) => roleZone(a.nodeById.get(id)) === zoneId);
      const isRow = zoneId === 'source' || zoneId === 'common';
      let rowY = 32, rowHeight = 0;
      const columns = Math.max(1, Math.floor((zone.width - 2 * PAD - 72 + 140) / (CARD_WIDTH + 140)));
      items.forEach(([id, el], index) => {
        const stored = plain(savedNodes[id]), height = measuredHeight(el);
        const column = isRow ? index % columns : 0;
        if (isRow && index > 0 && column === 0) { rowY += rowHeight + 100; rowHeight = 0; }
        let defaultX = 72 + column * (CARD_WIDTH + 140), defaultY = rowY;
        // Меню — новая виртуальная карточка. Первое отображение не сдвигает уже расставленные страницы.
        if (a.nodeById.get(id)?.kind === 'menu' && !Number.isFinite(stored.x) && !Number.isFinite(stored.y)) {
          defaultX = 72; defaultY = 32;
          const neighbours = Object.values(geometry.nodes).filter((item) => item.zone === zoneId);
          for (let tries = 0; tries <= neighbours.length; tries++) {
            const collisions = neighbours.filter((other) => intersects({ x: defaultX, y: defaultY, width: CARD_WIDTH, height }, other, 100));
            if (!collisions.length) break;
            defaultX = Math.max(...collisions.map((other) => other.x + other.width + 100));
          }
        }
        const x = number(stored.x, defaultX);
        const y = number(stored.y, defaultY);
        geometry.nodes[id] = { x, y, width: CARD_WIDTH, height, zone: zoneId };
        rowHeight = Math.max(rowHeight, height);
        if (!isRow) rowY += height + 100;
        zone.width = Math.max(zone.width, x + CARD_WIDTH + 2 * PAD);
        zone.height = Math.max(zone.height, y + height + HEADER + PAD + 40);
      });
    }
    // Общее ниже всех ролей, если пользователь ещё не задал его положение.
    if (geometry.zones.common && !Number.isFinite(plain(savedZones.common).y)) {
      geometry.zones.common.y = Math.max(4460, ...['client', 'staff', 'admin'].map((id) => {
        const zone = geometry.zones[id]; return zone ? zone.y + zone.height : 0;
      })) + GAP;
    }
    a.geometry = geometry; expandCanvas(); paint();
    return snapshot(geometry);
  }

  function expandCanvas() {
    if (!active) return;
    const g = active.geometry;
    for (const zone of Object.values(g.zones)) {
      g.width = Math.max(g.width, zone.x + zone.width + 200);
      g.height = Math.max(g.height, zone.y + zone.height + 300);
    }
  }

  function paint() {
    const a = active;
    if (!a) return;
    const g = a.geometry, zoom = scale();
    Object.assign(a.board.style, { width: `${g.width}px`, height: `${g.height}px`, transform: `scale(${zoom})`, transformOrigin: '0 0' });
    a.board.dataset.zoom = String(zoom);
    Object.assign(a.spacer.style, { width: `${g.width * zoom}px`, height: `${g.height * zoom}px` });
    for (const [id, element] of a.zoneElements) {
      const zone = g.zones[id]; if (!zone) continue;
      Object.assign(element.style, { left: `${zone.x}px`, top: `${zone.y}px`, width: `${zone.width}px`, height: `${zone.height}px` });
    }
    for (const [id, element] of a.nodeElements) {
      const node = g.nodes[id]; if (!node) continue;
      Object.assign(element.style, { left: `${node.x}px`, top: `${node.y}px`, width: `${CARD_WIDTH}px` });
    }
    updateCursor(); updateToolbar(); a.ctx.redraw?.();
  }

  function updateCursor() {
    if (!active) return;
    active.viewport.dataset.canvasTool = effectiveTool();
    active.viewport.classList.toggle('fc-is-panning', active.gesture?.kind === 'pan' && active.gesture.moved);
    active.viewport.classList.toggle('fc-is-dragging', !!active.gesture?.moved && active.gesture.kind !== 'pan');
  }

  function zoomTo(value, clientPoint) {
    const a = active; if (!a) return;
    const old = scale(), rect = a.viewport.getBoundingClientRect();
    const x = clientPoint ? clientPoint.x - rect.left : (a.viewport.clientWidth || rect.width || 800) / 2;
    const y = clientPoint ? clientPoint.y - rect.top : (a.viewport.clientHeight || rect.height || 600) / 2;
    const worldX = (a.viewport.scrollLeft + x) / old, worldY = (a.viewport.scrollTop + y) / old;
    prefs.zoom = Math.round(clamp(value, MIN_ZOOM, MAX_ZOOM) * 1000) / 1000;
    paint(); a.viewport.scrollLeft = Math.max(0, worldX * scale() - x); a.viewport.scrollTop = Math.max(0, worldY * scale() - y);
    rememberScroll();
  }

  function fit(initial = false) {
    const a = active; if (!a) return;
    const width = a.viewport.clientWidth || a.viewport.getBoundingClientRect().width;
    if (!width) { prefs.zoom = .45; paint(); return; }
    const right = Math.max(1, ...Object.values(a.geometry.zones).map((zone) => zone.x + zone.width)) + 160;
    prefs.zoom = Math.round(clamp((width - 32) / right, MIN_ZOOM, MAX_ZOOM) * 1000) / 1000;
    paint(); a.viewport.scrollLeft = 0;
    const roleTop = Math.min(...['client', 'staff', 'admin'].map((id) => a.geometry.zones[id]?.y ?? 960));
    a.viewport.scrollTop = Math.max(0, (initial ? roleTop - 50 : 0) * scale());
    rememberScroll();
  }

  function rememberScroll() {
    if (!active) return;
    prefs.left = active.viewport.scrollLeft; prefs.top = active.viewport.scrollTop;
  }

  function intersects(first, second, gap = 0) {
    return first.x < second.x + second.width + gap && first.x + first.width + gap > second.x &&
      first.y < second.y + second.height + gap && first.y + first.height + gap > second.y;
  }

  function minimumZone(id) {
    const a = active;
    let width = 600, height = 600;
    for (const node of Object.values(a.geometry.nodes)) if (node.zone === id) {
      width = Math.max(width, node.x + node.width + 2 * PAD);
      height = Math.max(height, node.y + node.height + HEADER + PAD + 24);
    }
    return { width, height };
  }

  function startPointer(event) {
    const a = active;
    if (!a || a.gesture || event.isPrimary === false || ![0, 1, 2].includes(event.button)) return;
    const input = editable(event.target);
    const isPan = event.button === 1 || event.button === 2 || effectiveTool() === 'hand';
    if (input && event.button !== 1 && event.button !== 2) return;
    const base = { pointer: event.pointerId, button: event.button, startX: event.clientX, startY: event.clientY,
      left: a.viewport.scrollLeft, top: a.viewport.scrollTop, moved: false, target: event.target, before: snapshot(a.geometry) };
    if (isPan) {
      a.gesture = { ...base, kind: 'pan' };
      if (event.button !== 2) { event.preventDefault(); event.stopPropagation(); }
    } else {
      if (a.ctx.mode !== 'edit') return;
      if (event.target.closest('.route-port, .node-inlet, .node-action, input, select, textarea, [contenteditable]')) return;
      const resize = event.target.closest('[data-zone-resize]');
      const zoneHeader = event.target.closest('.flow-zone__header');
      const dragHeader = event.target.closest('.node__open, .fc-node-handle');
      const nodeElement = dragHeader?.closest('.node[data-node]');
      if (resize) a.gesture = { ...base, kind: 'resize', id: resize.dataset.zoneResize, axis: resize.dataset.resizeAxis || 'both' };
      else if (nodeElement && a.geometry.nodes[nodeElement.dataset.node]) a.gesture = { ...base, kind: 'node', id: nodeElement.dataset.node };
      else if (zoneHeader) a.gesture = { ...base, kind: 'zone', id: zoneHeader.closest('.flow-zone')?.dataset.zone };
      else return;
    }
    updateCursor();
  }

  function movePointer(event) {
    const a = active, gesture = a?.gesture;
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY;
    if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
    if (!gesture.moved) {
      gesture.moved = true; a.ctx.cancelConnection?.();
      // До порога drag capture нельзя: браузер перенаправит обычный click заголовка в viewport.
      try { a.viewport.setPointerCapture?.(event.pointerId); } catch (_) { /* document listeners сохраняют drag без capture. */ }
    }
    event.preventDefault(); event.stopPropagation();
    if (gesture.kind === 'pan') {
      a.viewport.scrollLeft = Math.max(0, gesture.left - dx); a.viewport.scrollTop = Math.max(0, gesture.top - dy);
      updateCursor(); rememberScroll(); return;
    }
    const worldX = (dx + a.viewport.scrollLeft - gesture.left) / scale();
    const worldY = (dy + a.viewport.scrollTop - gesture.top) / scale();
    if (gesture.kind === 'node') {
      const before = gesture.before.nodes[gesture.id], node = a.geometry.nodes[gesture.id];
      const zone = a.geometry.zones[node.zone];
      node.x = clamp(before.x + worldX, 0, Math.max(0, zone.width - 2 * PAD - node.width));
      node.y = clamp(before.y + worldY, 0, Math.max(0, zone.height - HEADER - PAD - node.height));
    } else if (gesture.kind === 'zone') {
      const before = gesture.before.zones[gesture.id], zone = a.geometry.zones[gesture.id];
      const candidate = { ...zone, x: Math.max(0, before.x + worldX), y: Math.max(0, before.y + worldY) };
      if (!Object.entries(a.geometry.zones).some(([id, other]) => id !== gesture.id && intersects(candidate, other, RESIZE_GAP))) {
        zone.x = candidate.x; zone.y = candidate.y;
      }
    } else if (gesture.kind === 'resize') {
      const before = gesture.before.zones[gesture.id], zone = a.geometry.zones[gesture.id], min = minimumZone(gesture.id);
      const candidate = { ...zone, width: gesture.axis === 'height' ? before.width : clamp(before.width + worldX, min.width, Math.max(6000, min.width)),
        height: gesture.axis === 'width' ? before.height : clamp(before.height + worldY, min.height, Math.max(6000, min.height)) };
      // Расширение упирается в соседнюю зону, не двигает её и не прячет карточки.
      for (const [id, other] of Object.entries(a.geometry.zones)) {
        if (id === gesture.id || !intersects(candidate, other, RESIZE_GAP)) continue;
        if (other.x >= before.x + min.width + RESIZE_GAP) candidate.width = Math.max(min.width, Math.min(candidate.width, other.x - before.x - RESIZE_GAP));
        if (other.y >= before.y + min.height + RESIZE_GAP) candidate.height = Math.max(min.height, Math.min(candidate.height, other.y - before.y - RESIZE_GAP));
      }
      if (!Object.entries(a.geometry.zones).some(([id, other]) => id !== gesture.id && intersects(candidate, other, RESIZE_GAP))) {
        zone.width = candidate.width; zone.height = candidate.height;
      }
    }
    expandCanvas(); paint();
  }

  function commitGesture(gesture) {
    const a = active;
    if (!a || gesture.kind === 'pan') return;
    const key = gesture.kind === 'node' ? 'nodes' : 'zones';
    const before = gesture.before[key][gesture.id], current = a.geometry[key][gesture.id];
    const props = key === 'nodes' ? ['x', 'y'] : ['x', 'y', 'width', 'height'];
    if (!props.some((prop) => before[prop] !== current[prop])) return;
    const layout = plain(a.ctx.flow.layout);
    if (layout !== a.ctx.flow.layout) a.ctx.flow.layout = layout;
    let saved = layout;
    if (a.ctx.scope) {
      const views = plain(layout.views); if (views !== layout.views) layout.views = views;
      saved = plain(views[a.ctx.scope]); if (saved !== views[a.ctx.scope]) views[a.ctx.scope] = saved;
    }
    const entries = plain(saved[key]); if (entries !== saved[key]) saved[key] = entries;
    const item = { ...plain(entries[gesture.id]) };
    for (const prop of props) item[prop] = Math.round(current[prop]);
    Object.defineProperty(entries, gesture.id, { value: item, configurable: true, enumerable: true, writable: true });
    saved.width = Math.round(a.geometry.width); saved.height = Math.round(a.geometry.height);
    a.ctx.changed?.();
  }

  function endPointer(event) {
    const a = active, gesture = a?.gesture;
    if (!gesture || event.pointerId !== gesture.pointer) return;
    a.gesture = null;
    if (gesture.moved || (gesture.kind === 'pan' && gesture.button === 0)) {
      a.suppressClick = { until: Date.now() + 500 };
      if (gesture.button === 2 && gesture.moved) a.suppressContextUntil = Date.now() + 500;
      event.preventDefault();
    }
    if (gesture.moved) commitGesture(gesture);
    try { a.viewport.releasePointerCapture?.(event.pointerId); } catch (_) { /* Не нужен для commit. */ }
    rememberScroll(); updateCursor(); updateToolbar();
  }

  function cancelGesture() {
    const a = active, gesture = a?.gesture;
    if (!gesture) return;
    a.gesture = null;
    if (gesture.kind !== 'pan') { a.geometry = gesture.before; paint(); }
    else { a.viewport.scrollLeft = gesture.left; a.viewport.scrollTop = gesture.top; }
    try { a.viewport.releasePointerCapture?.(gesture.pointer); } catch (_) { /* Отмена безопасна и без capture. */ }
    if (gesture.moved) a.suppressClick = { until: Date.now() + 500 };
    rememberScroll(); updateCursor();
  }

  function attach(ctx) {
    dispose();
    if (!ctx?.board || !ctx.viewport || !ctx.flow) return null;
    const key = ctx.scope || 'all', tool = prefs.tool;
    if (!viewPrefs.has(key)) viewPrefs.set(key, { tool, zoom: null, left: null, top: null });
    prefs = viewPrefs.get(key); prefs.tool = tool;
    const board = ctx.board, viewport = ctx.viewport;
    let spacer = board.parentElement?.classList.contains('fc-spacer') ? board.parentElement : null;
    if (!spacer) { spacer = document.createElement('div'); spacer.className = 'fc-spacer'; board.before(spacer); spacer.append(board); }
    const cleanups = [], generated = [];
    active = { ctx, board, viewport, spacer, cleanups, generated, space: false, gesture: null, suppressClick: null, suppressContextUntil: 0,
      toolbar: board.closest('.flow-wrap')?.querySelector('.fc-toolbar') || pendingToolbar,
      zoneElements: new Map([...board.querySelectorAll('.flow-zone[data-zone]')].map((el) => [el.dataset.zone, el])),
      nodeElements: new Map([...board.querySelectorAll('.node[data-node]')].map((el) => [el.dataset.node, el])),
      nodeById: new Map((Array.isArray(ctx.nodes) ? ctx.nodes : []).map((node) => [String(node.id), node])), geometry: { width: 4200, height: 6400, zones: {}, nodes: {} } };
    board.classList.add('fc-board'); viewport.classList.add('fc-viewport');
    const listen = (target, type, handler, options) => { target.addEventListener(type, handler, options); cleanups.push(() => target.removeEventListener(type, handler, options)); };
    for (const [id, element] of active.zoneElements) {
      element.classList.add('fc-zone');
      if (ctx.mode !== 'edit') continue;
      for (const [axis, className, label] of [['both', 'fc-resize', 'Изменить размер зоны'], ['width', 'fc-resize-width', 'Изменить ширину зоны'], ['height', 'fc-resize-height', 'Изменить высоту зоны']]) {
        const handle = document.createElement('div'); handle.className = className; handle.dataset.zoneResize = id; handle.dataset.resizeAxis = axis;
        handle.setAttribute('title', label); handle.setAttribute('aria-hidden', 'true'); element.append(handle); generated.push(handle);
      }
    }
    for (const [id, element] of active.nodeElements) {
      element.style.width = `${CARD_WIDTH}px`;
      if (ctx.mode !== 'edit') continue;
      const handle = document.createElement('span'); handle.className = 'fc-node-handle'; handle.textContent = '⠿';
      handle.title = 'Переместить карточку'; handle.setAttribute('aria-hidden', 'true'); element.append(handle); generated.push(handle);
    }
    listen(viewport, 'pointerdown', startPointer, true);
    listen(document, 'pointermove', movePointer, { capture: true, passive: false });
    listen(document, 'pointerup', endPointer, true);
    listen(document, 'pointercancel', (event) => { if (event.pointerId === active?.gesture?.pointer) cancelGesture(); }, true);
    listen(viewport, 'click', (event) => { if (active?.suppressClick && Date.now() < active.suppressClick.until) { event.preventDefault(); event.stopImmediatePropagation(); active.suppressClick = null; } }, true);
    listen(viewport, 'contextmenu', (event) => {
      if ((active?.gesture?.button === 2 && active.gesture.moved) || Date.now() < (active?.suppressContextUntil || 0)) { event.preventDefault(); event.stopPropagation(); }
    }, true);
    listen(viewport, 'wheel', (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault(); zoomTo(scale() * Math.exp(-event.deltaY * .002), { x: event.clientX, y: event.clientY });
    }, { passive: false });
    listen(viewport, 'scroll', rememberScroll, { passive: true });
    listen(document, 'keydown', (event) => {
      if (!active || editable(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.code === 'Space') { if (!active.space) { active.space = true; active.ctx.cancelConnection?.(); updateCursor(); updateToolbar(); } event.preventDefault(); }
      else if (event.code === 'KeyV') { setTool('move'); event.preventDefault(); }
      else if (event.code === 'KeyH') { setTool('hand'); event.preventDefault(); }
      else if (event.code === 'Escape' && active.gesture) { cancelGesture(); event.preventDefault(); event.stopPropagation(); }
    });
    listen(document, 'keyup', (event) => { if (active && event.code === 'Space') { active.space = false; updateCursor(); updateToolbar(); } });
    listen(window, 'blur', () => { cancelGesture(); if (active) { active.space = false; updateCursor(); updateToolbar(); } });
    measure();
    if (prefs.zoom === null) fit(true); else { paint(); viewport.scrollLeft = prefs.left || 0; viewport.scrollTop = prefs.top || 0; }
    if (typeof ResizeObserver !== 'undefined') {
      let scheduled = false;
      const observer = new ResizeObserver(() => { if (scheduled || !active || active.gesture) return; scheduled = true;
        queueMicrotask(() => { scheduled = false; if (active?.board === board && !active.gesture) measure(); }); });
      for (const node of active.nodeElements.values()) observer.observe(node);
      cleanups.push(() => observer.disconnect());
    }
    if (document.fonts?.ready) document.fonts.ready.then(() => { if (active?.board === board) measure(); });
    return { scale, measure, fit, zoomTo, setTool };
  }

  function dispose() {
    if (!active) return;
    cancelGesture(); rememberScroll();
    const previous = active; active = null;
    for (const cleanup of previous.cleanups) cleanup();
    for (const element of previous.generated) element.remove();
    previous.viewport.classList.remove('fc-is-panning', 'fc-is-dragging');
  }

  window.BoardFlowCanvas = Object.freeze({ attach, dispose, toolbar, measure, scale, fit, zoomTo, setTool });
})();
