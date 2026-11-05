/* Shared, bounded free layout (Zero Block style). Editors persist only the returned numeric model.
   No network, no storage, no style strings from the model: only finite numbers become inline px values. */
(function (global) {
  'use strict';
  const MAX = 20000, MAX_ITEMS = 1000, MIN_SIZE = 8, DRAG_THRESHOLD = 4, STACK_GAP = 12;
  const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
  const KEYS = ['x', 'y', 'width', 'height'];
  const INTERACTIVE = 'input,textarea,select,option,[draggable="true"],[contenteditable=""],[contenteditable="true"]';
  const bindings = new WeakMap();
  const noop = function () {};
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const fnToString = Function.prototype.toString;
  const NATIVE_OBJECT = /^function Object\(\) \{\s*\[native code\]\s*\}$/;
  /* The built-in Object.prototype of some realm (this page, an iframe, a VM): it has no prototype of its own and its
     data property `constructor` is the native Object function whose `prototype` points back to it. A hand-made
     null-root prototype (Object.create(Object.create(null))), a class or a bound/proxied constructor does not pass. */
  function realmObjectPrototype(proto) {
    if (Object.getPrototypeOf(proto) !== null) return false;
    const ctor = field(proto, 'constructor');
    if (typeof ctor !== 'function' || field(ctor, 'prototype') !== proto || field(ctor, 'name') !== 'Object') return false;
    try { return NATIVE_OBJECT.test(fnToString.call(ctor)); } catch (_) { return false; }
  }
  // Plain data: an ordinary Object of any realm or an explicit Object.create(null); arrays, classes, custom prototypes refused.
  function plain(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === null || realmObjectPrototype(proto);
  }
  // Only an own data property counts. Inherited values and accessors give undefined; a getter is never invoked.
  function field(object, key) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && own(descriptor, 'value') ? descriptor.value : undefined;
  }
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const clamp = (v, min, max = MAX) => Math.min(max, Math.max(min, v));
  const round = (v) => Math.round(v * 1000) / 1000;
  function item(v) {
    if (!plain(v)) return null;
    const box = {};
    for (const key of KEYS) { const value = field(v, key); if (!finite(value)) return null; box[key] = value; }
    return { x: round(clamp(box.x, 0)), y: round(clamp(box.y, 0)), width: round(clamp(box.width, 1)), height: round(clamp(box.height, 1)) };
  }
  // anyEnabled: also read a switched-off layout (its boxes are kept for re-enabling and for hidden objects).
  function read(value, anyEnabled) {
    if (!plain(value)) return null;
    const enabled = field(value, 'enabled'), width = field(value, 'width'), height = field(value, 'height'), raw = field(value, 'items');
    if (!(enabled === true || (anyEnabled && enabled === false)) || !finite(width) || !finite(height) || width <= 0 || height <= 0 || !plain(raw)) return null;
    const ids = Object.keys(raw);
    if (ids.length > MAX_ITEMS) return null;
    const items = {};
    for (const id of ids) {
      const box = ID.test(id) ? item(field(raw, id)) : null;
      if (!box) return null;
      Object.defineProperty(items, id, { value: box, enumerable: true, writable: true, configurable: true });
    }
    return { enabled: true, width: round(clamp(width, 1)), height: round(clamp(height, 1)), items };
  }
  const normalize = (value) => read(value, false);
  function clone(value) {
    const copy = { enabled: value.enabled, width: value.width, height: value.height, items: {} };
    for (const [id, box] of Object.entries(value.items)) copy.items[id] = { ...box };
    return copy;
  }
  function updateItem(value, id, patch) {
    const next = normalize(value);
    if (!next || typeof id !== 'string' || !ID.test(id) || !own(next.items, id) || !plain(patch)) return null;
    const changes = {};
    for (const key of Object.keys(patch)) {
      const v = field(patch, key);
      if (!KEYS.includes(key) || !finite(v)) return null;
      changes[key] = v;
    }
    next.items[id] = item({ ...next.items[id], ...changes });
    next.height = Math.min(MAX, Math.max(next.height, next.items[id].y + next.items[id].height));
    return next;
  }
  function children(root) {
    const found = new Map();
    for (const child of Array.from(root.children || [])) {
      const id = child.getAttribute('data-free-id');
      if (!id || !ID.test(id) || found.has(id)) continue;
      found.set(id, child);
    }
    return found;
  }
  /* Content box of a container in its own CSS pixels plus the external visual scale (zoomed stage, transformed parent). */
  function frameOf(root) {
    if (!root || typeof root.getBoundingClientRect !== 'function') return null;
    const rect = root.getBoundingClientRect(), outer = root.offsetWidth || root.clientWidth;
    const s = outer > 0 && rect.width > 0 ? rect.width / outer : 0;
    if (!(s > 0)) return null;
    let pl = 0, pt = 0, pr = 0;
    try {
      const view = (root.ownerDocument && root.ownerDocument.defaultView) || global;
      const cs = view.getComputedStyle(root);
      pl = parseFloat(cs.paddingLeft) || 0; pt = parseFloat(cs.paddingTop) || 0; pr = parseFloat(cs.paddingRight) || 0;
    } catch (_) { /* synthetic DOM without computed styles: no padding */ }
    const width = (root.clientWidth || 0) - pl - pr;
    if (!(width > 0)) return null;
    return { s, width, left: rect.left + ((root.clientLeft || 0) + pl) * s, top: rect.top + ((root.clientTop || 0) + pt) * s,
      scrollLeft: root.scrollLeft || 0, scrollTop: root.scrollTop || 0 };
  }
  // Rendered box of a node in content-box units, clipped horizontally into the canvas; null when not rendered.
  function boxOf(frame, node) {
    if (!node || typeof node.getBoundingClientRect !== 'function') return null;
    const r = node.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    const left = (r.left - frame.left) / frame.s + frame.scrollLeft, top = (r.top - frame.top) / frame.s + frame.scrollTop;
    const x = Math.max(0, left), right = Math.min(frame.width, left + r.width / frame.s);
    if (!(right - x >= 1)) return null;
    return item({ x, y: Math.max(0, top), width: right - x, height: r.height / frame.s });
  }
  /* Measures exactly where the given nodes are now, relative to the container's content box. Call it on the normal
     (non-free) layout before moving nodes into a scene, so the first free render has no jump. Items of the previous
     layout that are not rendered now (hidden objects) are kept and rescaled when the canvas width changed. */
  function captureNodes(container, entries, previous) {
    const frame = frameOf(container);
    if (!frame) return null;
    const prior = read(previous, true);
    const items = {};
    if (prior) {
      const ratio = frame.width / prior.width;
      for (const [id, box] of Object.entries(prior.items)) items[id] = ratio === 1 ? { ...box }
        : item({ x: box.x * ratio, y: box.y * ratio, width: box.width * ratio, height: box.height * ratio });
    }
    for (const [id, node] of Array.from(entries || [])) {
      if (typeof id !== 'string' || !ID.test(id)) continue;
      const box = boxOf(frame, node);
      if (box) items[id] = box;
    }
    let height = 1;
    for (const box of Object.values(items)) height = Math.max(height, box.y + box.height);
    return normalize({ enabled: true, width: frame.width, height: Math.min(MAX, height), items });
  }
  function capture(root, previous) {
    if (!root || typeof root.getBoundingClientRect !== 'function') return null;
    return captureNodes(root, children(root), previous);
  }
  // Numeric custom properties let decoration (the K01 categories strip) reach the screen edge that its box touches.
  const ROOT_STYLE = ['position', 'height', '--free-scale', '--free-offset'];
  const ITEM_STYLE = ['position', 'left', 'top', 'width', 'height', 'margin', 'max-width', 'min-width', 'max-height', 'min-height', 'box-sizing', 'transform', 'transform-origin',
    '--free-left', '--free-right'];
  // A child that must take exactly the object's box (the real button inside an editor wrapper, a form's open/close button).
  const FILL_STYLE = ['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'box-sizing', 'flex-shrink'];
  const RESIZE_DIRS = Object.freeze([['nw', 'вверх и влево'], ['n', 'вверх'], ['ne', 'вверх и вправо'], ['e', 'вправо'], ['se', 'вниз и вправо'], ['s', 'вниз'],
    ['sw', 'вниз и влево'], ['w', 'влево']]);
  // Per-object minimum size from data-free-min (e.g. 44 for buttons), otherwise MIN_SIZE.
  function minOf(node) {
    const raw = node && node.getAttribute ? node.getAttribute('data-free-min') : null;
    const value = raw !== null && /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
    return value >= 1 && value <= 400 ? value : MIN_SIZE;
  }
  // Resize from any edge/corner: the opposite edge stays where it was; never below the minimum, never left/above the canvas.
  function resized(box, dir, dx, dy, min) {
    let { x, y, width, height } = box;
    if (dir.includes('e')) width = Math.max(min, width + dx);
    if (dir.includes('s')) height = Math.max(min, height + dy);
    if (dir.includes('w')) { const right = x + width; const nx = clamp(x + dx, 0, Math.max(0, right - min)); width = Math.max(min, right - nx); x = nx; }
    if (dir.includes('n')) { const bottom = y + height; const ny = clamp(y + dy, 0, Math.max(0, bottom - min)); height = Math.max(min, bottom - ny); y = ny; }
    return { x, y, width, height };
  }
  function saveStyles(node, keys) {
    return keys.map((key) => [key, node.style.getPropertyValue(key), node.style.getPropertyPriority(key)]);
  }
  function restoreStyles(node, saved) {
    for (const [key, value, priority] of saved) {
      if (value) node.style.setProperty(key, value, priority); else node.style.removeProperty(key);
    }
  }
  /* bind({ root, layout, editing, onChange, onSelect, onComplete, complete, maxScale, selected }) → dispose().
     complete:true places direct children that have a stable id but no saved box (a new block, a part shown again,
     a product-only object) below the existing items, in memory; onComplete(layout) lets an editor persist that.
     maxScale caps proportional scaling; a capped canvas is centred. */
  function bind(options = {}) {
    const { root, layout, editing = false, onChange, onSelect, onComplete } = options || {};
    if (!root || !root.style || typeof root.getBoundingClientRect !== 'function') return noop;
    const old = bindings.get(root); if (old) old();
    let current = normalize(layout);
    if (!current) return noop;
    const autoComplete = options.complete === true;
    const maxScale = finite(options.maxScale) && options.maxScale > 0 ? options.maxScale : Infinity;
    const doc = root.ownerDocument || global.document;
    const records = new Map(), controls = new Map();
    const originalRoot = saveStyles(root, ROOT_STYLE), hadRootClass = root.classList.contains('free-layout-root');
    const hadEditingClass = root.classList.contains('free-layout-editing');
    let disposed = false, observer = null, active = null, pending = null, scale = 1, offset = 0, completed = false, completionQueued = false;
    let selected = typeof options.selected === 'string' ? options.selected : '';
    let clickGuard = null;
    root.classList.add('free-layout-root');
    if (editing) root.classList.add('free-layout-editing');
    root.style.setProperty('position', 'relative');
    function adopt(id, node) {
      const fills = Array.from(node.querySelectorAll ? node.querySelectorAll('[data-free-fill]') : []).map((fill) => ({ fill, saved: saveStyles(fill, FILL_STYLE) }));
      records.set(id, { node, saved: saveStyles(node, ITEM_STYLE), fills, min: minOf(node) });
      if (!editing) return;
      const control = doc.createElement('div'); control.className = 'free-layout-controls';
      control.setAttribute('data-free-control', id);
      const add = (mode, dir, label, text) => {
        const handle = doc.createElement('button'); handle.type = 'button';
        handle.className = `free-layout-handle free-layout-handle--${mode}`; handle.setAttribute('data-free-handle', mode);
        if (dir) handle.setAttribute('data-free-dir', dir);
        handle.setAttribute('aria-label', label); handle.setAttribute('title', `${label}. Стрелки — 1 пиксель, Shift — 10.`);
        handle.textContent = text; control.appendChild(handle);
      };
      add('move', '', 'Переместить элемент', '✥');
      for (const [dir, words] of RESIZE_DIRS) add('resize', dir, `Изменить размер: край ${words}`, '');
      controls.set(id, control); root.appendChild(control);
    }
    for (const [id, node] of children(root)) if (own(current.items, id)) adopt(id, node);
    function geometry(width) {
      const s = Math.min(width / current.width, maxScale);
      return { s, offset: Math.max(0, (width - current.width * s) / 2) };
    }
    // New objects get their natural size and are stacked under the rendered items; existing boxes never move.
    function completeMissing(width) {
      if (!autoComplete || completed) return;
      const missing = Array.from(children(root)).filter(([id]) => !own(current.items, id));
      if (!missing.length) { completed = true; return; }
      const frame = frameOf(root);
      if (!frame) return;
      completed = true;
      const { s, offset: off } = geometry(width);
      let y = 0;
      for (const [id] of records) { const box = current.items[id]; if (box) y = Math.max(y, box.y + box.height + STACK_GAP); }
      const next = clone(current), adopted = [];
      for (const [id, node] of missing) {
        if (Object.keys(next.items).length >= MAX_ITEMS) break;
        const box = boxOf(frame, node);
        if (!box) continue;
        const placed = item({ x: Math.max(0, (box.x - off) / s), y, width: Math.max(MIN_SIZE, box.width / s), height: Math.max(1, box.height / s) });
        if (!placed) continue;
        next.items[id] = placed; y = placed.y + placed.height + STACK_GAP;
        next.height = Math.min(MAX, Math.max(next.height, placed.y + placed.height));
        adopted.push([id, node]);
      }
      if (!adopted.length) return;
      current = normalize(next);
      for (const [id, node] of adopted) adopt(id, node);
      if (typeof onComplete === 'function' && !completionQueued) {
        completionQueued = true;
        Promise.resolve().then(() => { completionQueued = false; if (!disposed) onComplete(clone(current)); });
      }
    }
    function render() {
      if (disposed) return;
      const width = root.clientWidth;
      if (!(width > 0)) return;
      completeMissing(width);
      ({ s: scale, offset } = geometry(width));
      let height = current.height;
      for (const [id] of records) { const box = current.items[id]; if (box) height = Math.max(height, box.y + box.height); }
      root.style.setProperty('height', `${round(Math.min(MAX, height) * scale)}px`);
      root.style.setProperty('--free-scale', String(round(scale) || 1)); root.style.setProperty('--free-offset', `${round(offset)}px`);
      for (const [id, record] of records) {
        const box = current.items[id]; if (!box) continue;
        const style = record.node.style;
        style.setProperty('position', 'absolute'); style.setProperty('left', `${round(offset + box.x * scale)}px`);
        style.setProperty('top', `${round(box.y * scale)}px`); style.setProperty('width', `${box.width}px`);
        style.setProperty('height', `${box.height}px`); style.setProperty('margin', '0');
        style.setProperty('max-width', 'none'); style.setProperty('min-width', '0'); style.setProperty('max-height', 'none'); style.setProperty('min-height', '0');
        style.setProperty('box-sizing', 'border-box');
        style.setProperty('transform-origin', '0 0'); style.setProperty('transform', `scale(${scale})`);
        style.setProperty('--free-left', `${box.x}px`); style.setProperty('--free-right', `${round(current.width - box.x - box.width)}px`);
        for (const { fill } of record.fills) {
          fill.style.setProperty('width', '100%'); fill.style.setProperty('height', '100%'); fill.style.setProperty('min-width', '0'); fill.style.setProperty('min-height', '0');
          fill.style.setProperty('max-width', 'none'); fill.style.setProperty('max-height', 'none'); fill.style.setProperty('box-sizing', 'border-box'); fill.style.setProperty('flex-shrink', '0');
        }
        const control = controls.get(id);
        if (control) {
          control.style.setProperty('left', `${round(offset + box.x * scale)}px`); control.style.setProperty('top', `${round(box.y * scale)}px`);
          control.style.setProperty('width', `${round(box.width * scale)}px`); control.style.setProperty('height', `${round(box.height * scale)}px`);
          control.classList.toggle('is-selected', id === selected);
          // Only the selected object's resize handles are in the tab order; every move handle stays reachable.
          for (const handle of control.querySelectorAll('[data-free-handle="resize"]')) handle.tabIndex = id === selected ? 0 : -1;
        }
      }
    }
    function select(id) {
      if (selected === id) return;
      selected = id; render();
      if (typeof onSelect === 'function') onSelect(id);
    }
    function emit() { if (!disposed && typeof onChange === 'function') onChange(clone(current)); }
    function addGestureListeners() {
      global.addEventListener('pointermove', move, { capture: true, passive: false });
      global.addEventListener('pointerup', end, true); global.addEventListener('pointercancel', cancel, true);
      global.addEventListener('keydown', escape, true);
    }
    function removeGestureListeners() {
      global.removeEventListener('pointermove', move, true); global.removeEventListener('pointerup', end, true);
      global.removeEventListener('pointercancel', cancel, true); global.removeEventListener('keydown', escape, true);
    }
    // The click that ends a real drag must not also press the dragged button or toggle a form.
    function swallowNextClick() {
      if (clickGuard) global.removeEventListener('click', clickGuard, true);
      clickGuard = (event) => { event.preventDefault(); event.stopPropagation(); };
      global.addEventListener('click', clickGuard, true);
      const guard = clickGuard;
      global.setTimeout(() => { global.removeEventListener('click', guard, true); if (clickGuard === guard) clickGuard = null; }, 0);
    }
    function finish(commit) {
      if (pending) { pending = null; if (!active) removeGestureListeners(); }
      if (!active) return;
      const gesture = active; active = null; removeGestureListeners();
      try { gesture.capture.releasePointerCapture(gesture.pointerId); } catch (_) {}
      if (!commit) current = gesture.before;
      render();
      if (gesture.changed) swallowNextClick();
      if (commit && gesture.changed) emit();
    }
    function start(id, mode, pointerId, clientX, clientY, captureNode, dir = 'se') {
      const rect = root.getBoundingClientRect(), externalScale = rect.width / (root.offsetWidth || root.clientWidth);
      const ratio = scale * externalScale;
      if (!(ratio > 0)) return false;
      active = { id, mode, dir, pointerId, clientX, clientY, ratio, before: clone(current), changed: false, capture: captureNode, min: (records.get(id) || {}).min || MIN_SIZE };
      try { captureNode.setPointerCapture(pointerId); } catch (_) {}
      return true;
    }
    function move(event) {
      if (disposed) return;
      if (pending && !active && event.pointerId === pending.pointerId) {
        if (Math.hypot(event.clientX - pending.clientX, event.clientY - pending.clientY) < DRAG_THRESHOLD) return;
        const { id, pointerId, clientX, clientY, node } = pending; pending = null;
        if (!start(id, 'move', pointerId, clientX, clientY, node)) { removeGestureListeners(); return; }
      }
      if (!active || event.pointerId !== active.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      const dx = (event.clientX - active.clientX) / active.ratio;
      const dy = (event.clientY - active.clientY) / active.ratio;
      const initial = active.before.items[active.id];
      const patch = active.mode === 'resize' ? resized(initial, active.dir, dx, dy, active.min)
        : { x: clamp(initial.x + dx, 0, Math.max(0, active.before.width - MIN_SIZE)), y: clamp(initial.y + dy, 0) };
      const next = updateItem(active.before, active.id, patch);
      if (!next) return;
      current = next;
      const box = current.items[active.id]; current.height = Math.min(MAX, Math.max(active.before.height, box.y + box.height));
      active.changed = KEYS.some((key) => box[key] !== initial[key]); render();
    }
    function end(event) {
      if (pending && !active && event.pointerId === pending.pointerId) {
        // A click without a drag only selects; the move handle then takes arrow keys (not when a field was clicked).
        const { id, focusHandle } = pending; finish(false);
        const handle = focusHandle && controls.get(id) ? controls.get(id).querySelector('[data-free-handle="move"]') : null;
        if (handle) { try { handle.focus({ preventScroll: true }); } catch (_) { handle.focus(); } }
        return;
      }
      if (!active || event.pointerId !== active.pointerId) return;
      move(event); finish(true);
    }
    function cancel(event) {
      if (pending && event.pointerId === pending.pointerId) { finish(false); return; }
      if (active && event.pointerId === active.pointerId) { event.stopPropagation(); finish(false); }
    }
    function escape(event) {
      if (event.key !== 'Escape' || !(active || pending)) return;
      event.preventDefault(); event.stopPropagation(); finish(false);
    }
    function ownHandle(target) {
      const handle = target && target.closest ? target.closest('[data-free-handle]') : null;
      const control = handle && handle.parentNode;
      return control && control.parentNode === root && controls.get(control.getAttribute('data-free-control')) === control ? handle : null;
    }
    function down(event) {
      if (disposed || active || pending || (event.button !== undefined && event.button !== 0)) return;
      const nearestRoot = event.target && event.target.closest ? event.target.closest('.free-layout-root') : null;
      if (nearestRoot && nearestRoot !== root) return;
      const handle = ownHandle(event.target);
      if (!handle) {
        const node = event.target && event.target.closest ? event.target.closest('[data-free-id]') : null;
        if (!node || node.parentNode !== root || !records.has(node.getAttribute('data-free-id'))) return;
        const id = node.getAttribute('data-free-id');
        select(id);
        // Zero Block style: drag the object itself; fields, selects and native drag handles keep their own behaviour.
        const interactive = event.target.closest(INTERACTIVE);
        if (interactive && node.contains(interactive)) return;
        pending = { id, node, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, focusHandle: true };
        addGestureListeners();
        return;
      }
      const id = handle.parentNode.getAttribute('data-free-control'), mode = handle.getAttribute('data-free-handle');
      const dir = RESIZE_DIRS.some(([d]) => d === handle.getAttribute('data-free-dir')) ? handle.getAttribute('data-free-dir') : 'se';
      event.preventDefault(); event.stopPropagation();
      if (!start(id, mode, event.pointerId, event.clientX, event.clientY, handle, dir)) return;
      addGestureListeners();
      select(id);
    }
    function key(event) {
      const handle = ownHandle(event.target);
      if (!handle || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Escape') { finish(false); return; }
      const id = handle.parentNode.getAttribute('data-free-control'), box = current.items[id], step = event.shiftKey ? 10 : 1;
      const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
      const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -step : step;
      const resize = handle.getAttribute('data-free-handle') === 'resize';
      let patch;
      if (resize) {
        // Arrows move the edge(s) this handle stands for; a corner handle takes both axes.
        const dir = handle.getAttribute('data-free-dir') || 'se', min = (records.get(id) || {}).min || MIN_SIZE;
        const axisDir = horizontal ? (dir.includes('w') ? 'w' : dir.includes('e') ? 'e' : '') : (dir.includes('n') ? 'n' : dir.includes('s') ? 's' : '');
        if (!axisDir) return;
        patch = resized(box, axisDir, horizontal ? delta : 0, horizontal ? 0 : delta, min);
      } else patch = { [horizontal ? 'x' : 'y']: box[horizontal ? 'x' : 'y'] + delta };
      const next = updateItem(current, id, patch);
      if (!next) return;
      const unchanged = KEYS.every((k) => next.items[id][k] === box[k]);
      current = next; current.height = Math.min(MAX, Math.max(current.height, next.items[id].y + next.items[id].height));
      select(id); render();
      if (!unchanged) emit();
    }
    if (editing) {
      root.addEventListener('pointerdown', down, true); root.addEventListener('keydown', key, true);
    }
    render();
    if (typeof global.ResizeObserver === 'function') { observer = new global.ResizeObserver(render); observer.observe(root); }
    function dispose() {
      if (disposed) return;
      finish(false); disposed = true;
      if (observer) observer.disconnect();
      if (editing) { root.removeEventListener('pointerdown', down, true); root.removeEventListener('keydown', key, true); }
      removeGestureListeners();
      for (const control of controls.values()) control.remove();
      for (const record of records.values()) { restoreStyles(record.node, record.saved); for (const { fill, saved } of record.fills) restoreStyles(fill, saved); }
      restoreStyles(root, originalRoot);
      if (!hadRootClass) root.classList.remove('free-layout-root');
      if (!hadEditingClass) root.classList.remove('free-layout-editing');
      if (bindings.get(root) === dispose) bindings.delete(root);
    }
    bindings.set(root, dispose); return dispose;
  }
  /* One button-link policy for the editor and the app: only an absolute http:// or https:// URL with a host, without
     credentials, whitespace, control characters or backslashes. Everything else (relative, scheme-relative,
     «https:host», javascript:, data:, file:, mailto: …) gives ''. */
  const ABSOLUTE_HTTP = /^https?:\/\/[^/\\?#@]/i;
  const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\\\s]/;
  function safeUrl(value) {
    if (typeof value !== 'string') return '';
    const source = value.trim();
    if (!source || source.length > 2048 || !ABSOLUTE_HTTP.test(source) || FORBIDDEN_CHARS.test(source)) return '';
    let url;
    try { url = new URL(source); } catch (_) { return ''; }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return '';
    return url.href;
  }
  global.SynapseButtonLink = Object.freeze({ version: 1, safeUrl });
  global.SynapseFreeLayout = Object.freeze({ version: 4, normalize, capture, captureNodes, updateItem, bind,
    limits: Object.freeze({ max: MAX, maxItems: MAX_ITEMS, minSize: MIN_SIZE }) });
})(window);

/* Palitra Love: editable texts of the install / notification windows (project root `notificationTexts`).
   Shared by the editor and the app (browser global SynapseNotificationCopy) and by Node checks (CommonJS).
   Canon: notification-copy-spec.json from Root (schema 1, SHA256 65b393d37ecbc829fa8e28e647f49d1d1ecdc23580be827ae86186ae9eaae20a):
   36 keys with exact defaults, labels and maxLength; unknown keys rejected; '' preserved; fallback to the default only for an
   absent or null key on read; a stored null is rejected on validation; total ≤ 65536 UTF-8 bytes of the JSON of the whole map.
   Characters: LF/CR/TAB allowed only in 400/2000 fields, forbidden in 120/160 fields; every other C0/C1 control and < > rejected.
   Text is rendered with textContent only — no HTML, links or actions. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.SynapseNotificationCopy = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const KEYS = Object.freeze([
    "installTitle",
    "notificationTitle",
    "installClientText",
    "installStaffText",
    "installedText",
    "installButton",
    "installHelpButton",
    "installBusyText",
    "deviceHeading",
    "enableButton",
    "disableButton",
    "laterButton",
    "neverButton",
    "pushUnavailableText",
    "iosInstallText",
    "permissionDeniedText",
    "subscribedText",
    "unsubscribedText",
    "permissionPromptText",
    "unconfirmedText",
    "subscribeErrorText",
    "closeLabel",
    "iosStep1",
    "iosStep2",
    "iosStep3",
    "iosStep4",
    "androidStep1",
    "androidStep2",
    "androidStep3",
    "desktopStep1",
    "desktopStep2",
    "desktopStep3",
    "guideExampleText",
    "guideImageButton",
    "guideSourceLabel",
    "guideBackButton"]);
  const DEFAULTS = Object.freeze({
    installTitle: "Заказ всегда под рукой",
    notificationTitle: "Уведомления Palitra Love",
    installClientText: "Добавьте Palitra Love на главный экран, чтобы возвращаться в чат и отслеживать заказ. Это необязательно.",
    installStaffText: "Закрепите приложение, чтобы быстро открывать заказы и переписку.",
    installedText: "Приложение уже открыто с главного экрана. Выберите, хотите ли получать уведомления на этом устройстве.",
    installButton: "Установить приложение",
    installHelpButton: "Как добавить на главный экран",
    installBusyText: "Подтвердите в браузере…",
    deviceHeading: "Уведомления на этом устройстве",
    enableButton: "Включить уведомления",
    disableButton: "Отключить уведомления",
    laterButton: "Позже",
    neverButton: "Больше не предлагать",
    pushUnavailableText: "Push-уведомления пока не подключены. Заказы и сообщения проверяйте в приложении. Установка сама по себе push не включает.",
    iosInstallText: "Для push на iPhone/iPad сначала добавьте приложение на экран Домой и откройте его оттуда (iOS/iPadOS 16.4 или новее).",
    permissionDeniedText: "Уведомления запрещены в браузере. Откройте настройки этого сайта → «Уведомления» и разрешите их, если хотите получать push.",
    subscribedText: "Уведомления подключены на этом устройстве.",
    unsubscribedText: "Уведомления отключены на этом устройстве.",
    permissionPromptText: "Подтвердите разрешение браузера.",
    unconfirmedText: "Подписка не подтверждена сервером. Push пока не включён.",
    subscribeErrorText: "Не удалось подключить уведомления. Можно продолжить без них.",
    closeLabel: "Закрыть предложение",
    iosStep1: "Откройте эту страницу в Safari. Если вы пришли из Telegram или другой соцсети, откройте ссылку во внешнем браузере Safari.",
    iosStep2: "Нажмите «Ещё» (…) внизу справа, затем «Поделиться». В другом виде Safari кнопка «Поделиться» может быть сразу на панели.",
    iosStep3: "Выберите «На экран Домой». Если пункта нет, прокрутите список действий ниже.",
    iosStep4: "Оставьте «Открывать как веб-приложение» включённым, нажмите «Добавить». Открывайте Palitra Love с нового значка.",
    androidStep1: "Откройте страницу в Chrome и нажмите меню ⋮ вверху справа.",
    androidStep2: "Выберите «Установить приложение» или «Добавить на главный экран». Название пункта зависит от версии Chrome.",
    androidStep3: "Подтвердите установку и открывайте Palitra Love с нового значка.",
    desktopStep1: "Откройте меню браузера ⋮ или ….",
    desktopStep2: "Выберите «Установить приложение» или «Приложения» → «Установить этот сайт как приложение».",
    desktopStep3: "Подтвердите установку и открывайте Palitra Love с нового значка.",
    guideExampleText: "Пример интерфейса; название сайта и пункты меню могут отличаться. У вас будет Palitra Love.",
    guideImageButton: "Увеличить изображение",
    guideSourceLabel: "Официальная инструкция",
    guideBackButton: "Вернуться к шагам"});
  const LABELS = Object.freeze({
    installTitle: "Заголовок установки",
    notificationTitle: "Заголовок уведомлений",
    installClientText: "Текст установки для клиента",
    installStaffText: "Текст установки для сотрудника",
    installedText: "Текст установленного приложения",
    installButton: "Кнопка установки",
    installHelpButton: "Кнопка инструкции",
    installBusyText: "Ожидание установки",
    deviceHeading: "Заголовок устройства",
    enableButton: "Кнопка включения",
    disableButton: "Кнопка отключения",
    laterButton: "Кнопка позже",
    neverButton: "Кнопка больше не предлагать",
    pushUnavailableText: "Push недоступен",
    iosInstallText: "Установка перед Push на iPhone",
    permissionDeniedText: "Разрешение запрещено",
    subscribedText: "Подключено",
    unsubscribedText: "Отключено",
    permissionPromptText: "Запрос разрешения",
    unconfirmedText: "Подписка не подтверждена",
    subscribeErrorText: "Ошибка подключения",
    closeLabel: "Подпись закрытия",
    iosStep1: "iPhone — шаг 1",
    iosStep2: "iPhone — шаг 2",
    iosStep3: "iPhone — шаг 3",
    iosStep4: "iPhone — шаг 4",
    androidStep1: "Android — шаг 1",
    androidStep2: "Android — шаг 2",
    androidStep3: "Android — шаг 3",
    desktopStep1: "Компьютер — шаг 1",
    desktopStep2: "Компьютер — шаг 2",
    desktopStep3: "Компьютер — шаг 3",
    guideExampleText: "Подпись примеров",
    guideImageButton: "Кнопка увеличения скриншота",
    guideSourceLabel: "Ссылка на источник",
    guideBackButton: "Кнопка возврата из изображения"});
  const MAX_LENGTH = Object.freeze({ installTitle: 160, notificationTitle: 160, installClientText: 2000, installStaffText: 2000, installedText: 2000, installButton: 120, installHelpButton: 120, installBusyText: 120, deviceHeading: 160, enableButton: 120, disableButton: 120, laterButton: 120, neverButton: 120, pushUnavailableText: 2000, iosInstallText: 2000, permissionDeniedText: 2000, subscribedText: 2000, unsubscribedText: 2000, permissionPromptText: 2000, unconfirmedText: 2000, subscribeErrorText: 2000, closeLabel: 120, iosStep1: 400, iosStep2: 400, iosStep3: 400, iosStep4: 400, androidStep1: 400, androidStep2: 400, androidStep3: 400, desktopStep1: 400, desktopStep2: 400, desktopStep3: 400, guideExampleText: 400, guideImageButton: 120, guideSourceLabel: 120, guideBackButton: 120 });
  const MAX_UTF8_BYTES = 65536;
  // Editor grouping only (derived from maxLength): 160 titles, 120 buttons, 2000 texts, 400 steps.
  const GROUP_BY_LIMIT = { 160: 'title', 120: 'button', 2000: 'text', 400: 'step' };
  const GROUP_OF = Object.freeze(Object.fromEntries(KEYS.map((key) => [key, GROUP_BY_LIMIT[MAX_LENGTH[key]]])));
  const GROUPS = Object.freeze(Object.fromEntries(['title', 'button', 'text', 'step'].map((group) => [group, Object.freeze(KEYS.filter((key) => GROUP_OF[key] === group))])));
  const LIMITS = Object.freeze({ title: 160, button: 120, text: 2000, step: 400, totalBytes: MAX_UTF8_BYTES });
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  // Same plain-data contract as the free layout: ordinary Object of any realm or Object.create(null); own data properties only.
  function field(object, key) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && own(descriptor, 'value') ? descriptor.value : undefined;
  }
  function plain(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    if (proto === null) return true;
    if (Object.getPrototypeOf(proto) !== null) return false;
    const ctor = field(proto, 'constructor');
    if (typeof ctor !== 'function' || field(ctor, 'prototype') !== proto || field(ctor, 'name') !== 'Object') return false;
    try { return /^function Object\(\) \{\s*\[native code\]\s*\}$/.test(Function.prototype.toString.call(ctor)); } catch (_) { return false; }
  }
  const length = (s) => Array.from(s).length;   // characters = Unicode code points (JSON Schema maxLength semantics)
  const utf8 = (s) => { let n = 0; for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; } return n; };
  const SINGLE_LINE_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f<>]/;
  const MULTI_LINE_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f<>]/;   // TAB \u0009, LF \u000a, CR \u000d allowed
  /* One value for one key: '' when valid, otherwise a Russian reason. */
  function checkValue(key, value) {
    if (!own(MAX_LENGTH, key)) return 'Неизвестное поле';
    if (typeof value !== 'string') return 'Значение должно быть текстом';
    const max = MAX_LENGTH[key], multi = max === 400 || max === 2000;
    if (length(value) > max) return `Не длиннее ${max} символов`;
    if (/[<>]/.test(value)) return 'Символы < и > недопустимы: только обычный текст, без HTML';
    if ((multi ? MULTI_LINE_FORBIDDEN : SINGLE_LINE_FORBIDDEN).test(value)) return multi ? 'Недопустимые управляющие символы' : 'Без переносов строк, табуляции и управляющих символов';
    return '';
  }
  const totalBytes = (map) => utf8(JSON.stringify(map));
  /* Strict check of a stored/written object: absent → ok (all defaults); unknown keys, null values, accessors → errors. */
  function validate(input) {
    if (input === undefined) return { ok: true, value: null, errors: [] };
    if (!plain(input)) return { ok: false, value: null, errors: [{ key: '', message: 'notificationTexts должен быть простым объектом' }] };
    const errors = [], value = {};
    for (const key of Object.keys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!own(MAX_LENGTH, key)) { errors.push({ key, message: 'Неизвестное поле' }); continue; }
      if (!descriptor || !own(descriptor, 'value')) { errors.push({ key, message: 'Только обычное значение (не вычисляемое)' }); continue; }
      if (descriptor.value === null) { errors.push({ key, message: 'null не сохраняется: удалите поле, чтобы вернуть стандартный текст' }); continue; }
      const message = checkValue(key, descriptor.value);
      if (message) errors.push({ key, message }); else value[key] = descriptor.value;
    }
    if (!errors.length) {
      const total = totalBytes(value);
      if (total > MAX_UTF8_BYTES) errors.push({ key: '', message: `Все тексты вместе не больше ${MAX_UTF8_BYTES} байт UTF-8 (сейчас ${total})` });
    }
    return errors.length ? { ok: false, value: null, errors } : { ok: true, value, errors: [] };
  }
  /* Next stored object after editing one key: a string is stored as is ('' included); undefined removes the key (default).
     An invalid stored object (unknown keys, null, …) makes the editor read-only, so nothing foreign is overwritten. */
  function withValue(input, key, next) {
    const current = validate(input);
    if (!current.ok) return { ok: false, value: null, errors: current.errors };
    const value = { ...(current.value || {}) };
    if (next === undefined) delete value[key];
    else {
      const message = checkValue(key, next);
      if (message) return { ok: false, value: null, errors: [{ key, message }] };
      value[key] = next;
    }
    const checked = validate(value);
    return checked.ok ? { ok: true, value: Object.keys(value).length ? value : null, errors: [] } : checked;
  }
  /* Texts to show: every key present; a valid stored string wins ('' stays ''); absent or null → default. An invalid
     value of a known key also shows the default (the app never renders an unchecked string). */
  function resolve(input) {
    const out = {};
    const source = plain(input) ? input : null;
    for (const key of KEYS) {
      const value = source ? field(source, key) : undefined;
      out[key] = typeof value === 'string' && !checkValue(key, value) ? value : DEFAULTS[key];
    }
    return Object.freeze(out);
  }
  return Object.freeze({ version: 2, specSchema: 1, KEYS, GROUPS, GROUP_OF, LIMITS, MAX_LENGTH, MAX_UTF8_BYTES, DEFAULTS, LABELS, checkValue, validate, withValue,
    resolve, totalBytes, utf8Length: utf8 });
});

/* Проекты Синапс → Palitra Love → Palitra Love Заказы — локальная доска макетов (14.10.2026). Vanilla JS, без библиотек и сети, кроме собственного /api/project.
   Источник данных — только сервер: GET /api/project (без кеша), PUT /api/project полной копией с исходной revision.
   Правки сохраняются автоматически (400 мс), сохранения идут строго по одному, следующие правки не теряются; 409 —
   конфликт без перезаписи. Пользовательские тексты выводятся только через textContent. Демо-формы ничего не отправляют. */
'use strict';

(() => {
  const projectApi = window.ProjectFormsAPI || (['localhost','127.0.0.1','[::1]'].includes(location.hostname) ? { native: false, request: (_resource, options = {}) => fetch('/api/project', options) } : null);
  if (!projectApi) throw new Error('Адаптер проекта не загружен');
  // Проверенный адрес сайта (черновик Palitra); открывается только по явному нажатию.
  const SITE_URL = 'https://palitra-love.ru/';
  const DEBOUNCE_MS = 400;
  const ROLES = [{ id: 'client', label: 'Клиент' }, { id: 'staff', label: 'Сотрудник' }, { id: 'admin', label: 'Админ' }];
  const REVIEW = [['pending', 'Без решения'], ['keep', 'Оставить'], ['change', 'Изменить'], ['remove', 'Убрать']];
  const REVIEW_LABEL = Object.fromEntries(REVIEW);
  const MENUS = {
    // Пункта «Сайт» в меню нет ни у одной роли (решение Влада 14.10.2026); главная — первым пунктом (MENU_HOME).
    client: [['Каталог', 'K02'], ['Ваши заказы', 'K04'], ['Оставить отзыв', 'K08']],
    staff: [['Фото', 'S06'], ['Каталог редактор', 'S07'], ['Заказы', 'S02']],
    admin: [['Фото', 'A06'], ['Каталог редактор', 'A07'], ['Заказы', 'A02'], ['Отчёты', 'A08']],
  };
  const MENU_HOME = { client: 'K01', staff: 'S01', admin: 'A01' };
  const MENU_HOME_LABEL = { client: 'Главная', staff: 'Главное меню', admin: 'Главное меню' };
  const CHANNELS = [
    { id: 'telegram', label: 'Telegram', short: 'Telegram', type: 'text', placeholder: 'Номер телефона или @никнейм' },
    { id: 'whatsapp', label: 'WhatsApp', short: 'WhatsApp', type: 'tel', placeholder: 'Номер телефона' },
    { id: 'max', label: 'MAX', short: 'MAX', type: 'tel', placeholder: 'Номер телефона' },
    { id: 'call', label: 'Звонок', short: 'Телефон', type: 'tel', placeholder: 'Номер телефона' },
    { id: 'vk', label: 'ВКонтакте', short: 'ВКонтакте', type: 'text', placeholder: 'Ссылка или имя профиля' },
  ];
  const channelById = (id) => CHANNELS.find((c) => c.id === id) || null;
  const TYPE_LABEL = { hero: 'Шапка', button: 'Кнопка', text: 'Текст', website: 'Сайт', helpform: 'Форма подбора',
    order: 'Заказ', chat: 'Чат', input: 'Поле ввода', form: 'Форма', status: 'Статусы', customer: 'Клиент', sales: 'Этап продаж', contactnotice: 'Нужно связаться' };
  // Блоки только для менеджера (сотрудник/админ): на экранах клиента в просмотре не показываются.
  const MANAGER_ONLY = new Set(['sales', 'contactnotice']);
  // Редактируемые поля по типу блока: [ключ, подпись, вид поля].
  const FIELDS = {
    hero: [['title', 'Заголовок'], ['subtitle', 'Подзаголовок', 'area']],
    button: [['label', 'Надпись'], ['target', 'Переход', 'target']],
    text: [['title', 'Заголовок (необязательно)'], ['text', 'Текст', 'area']],
    website: [['label', 'Подпись'], ['src', 'Скриншот или локальный снимок (.html)'], ['url', 'Адрес сайта']],
    helpform: [['toggleLabel', 'Надпись кнопки раскрытия', 'toggle'], ['title', 'Заголовок'], ['subtitle', 'Подзаголовок', 'area'], ['nameLabel', 'Подпись поля имени'],
      ['messengerLabel', 'Подпись канала связи'], ['contactLabel', 'Подпись контакта'], ['submitLabel', 'Текст кнопки'], ['target', 'После заполнения перейти', 'target']],
    order: [['clientName', 'Имя клиента (шаблон)'], ['orderNumber', 'Номер заказа'], ['title', 'Заголовок'], ['status', 'Статус'],
      ['details', 'Подробности', 'area'], ['target', 'Переход', 'target']],
    chat: [['clientName', 'Имя клиента в шапке (шаблон)'], ['orderNumber', 'Номер заказа в шапке'], ['target', 'Кнопка «Заказ №…» ведёт на', 'target'],
      ['title', 'Заголовок'], ['messages', 'Сообщения (по строке; «--- текст» — разделитель)', 'messages'], ['placeholder', 'Подсказка поля']],
    input: [['label', 'Подпись'], ['placeholder', 'Подсказка']],
    form: [['title', 'Заголовок'], ['subtitle', 'Подзаголовок', 'area'], ['submitLabel', 'Текст кнопки'], ['target', 'После заполнения перейти', 'target']],
    status: [['title', 'Заголовок'], ['values', 'Значения (по одному в строке)', 'lines']],
    customer: [['title', 'Заголовок'], ['clientName', 'Имя клиента (шаблон)'], ['preferredChannel', 'Предпочтительный канал (шаблон)', 'channel'],
      ['contact', 'Контакт (шаблон, без реальных данных)'], ['target', '«Вернуться в чат приложения» ведёт на', 'target']],
    sales: [['title', 'Заголовок'], ['stages', 'Этапы (по строке: название | подсказка)', 'stages']],
    contactnotice: [['title', 'Заголовок'], ['text', 'Текст', 'area'], ['waitMinutes', 'Порог ожидания', 'wait']],
  };
  const SAVE_TEXT = { idle: 'Загрузка…', saved: 'Сохранено', pending: 'Сохраняется…', saving: 'Сохраняется…', error: 'Ошибка сохранения', conflict: 'Ошибка: конфликт' };
  // Новые блоки: нейтральные заготовки без реальных контактов, заявок и переходов (target пустой).
  const NEW_BLOCK = {
    hero: () => ({ type: 'hero', title: 'Новый заголовок', subtitle: '' }),
    text: () => ({ type: 'text', title: '', text: 'Новый текст' }),
    button: () => ({ type: 'button', label: 'Новая кнопка', target: '' }),
    helpform: () => ({ type: 'helpform', phoneOnly: false, title: 'Форма подбора', subtitle: '', nameLabel: 'Имя', messengerLabel: 'Как с вами связаться', contactLabel: 'Контакт', submitLabel: 'Отправить' }),
    order: () => ({ type: 'order', title: 'Заказ', status: 'Статус', details: '', target: '' }),
    chat: () => ({ type: 'chat', title: 'Чат', messages: [], placeholder: 'Сообщение' }),
    input: () => ({ type: 'input', label: 'Поле', placeholder: '' }),
    form: () => ({ type: 'form', title: 'Новая форма', subtitle: '', submitLabel: 'Продолжить', target: '', fields: [] }),
    status: () => ({ type: 'status', title: 'Статус', values: ['Первый статус'] }),
    website: () => ({ type: 'website', label: 'Сайт', src: '', url: '' }),
    customer: () => ({ type: 'customer', title: 'Клиент', clientName: 'Имя клиента', preferredChannel: 'telegram', contact: '', manager: true, target: '' }),
    sales: () => ({ type: 'sales', title: 'Этап продаж', manager: true, defaultStage: 'new', stages: [
      { id: 'new', label: 'Новый запрос', hint: 'Ответьте в чате приложения и уточните повод и дату.' },
      { id: 'selection', label: 'Подбор', hint: 'Предложите варианты и уточните бюджет.' },
      { id: 'offer', label: 'Предложение', hint: 'Пришлите состав и сумму на согласование.' },
      { id: 'agreed', label: 'Согласовано', hint: 'Подтвердите дату и способ получения.' }] }),
    contactnotice: () => ({ type: 'contactnotice', title: 'Нужно связаться с клиентом',
      text: 'Клиент не написал в чат. Свяжитесь с ним удобным для него способом.', waitMinutes: 5, manager: true }),
  };
  /* Оформление текста: block.textStyles = { поле: { font, size, bold, italic, underline, align, color, lineHeight } } —
     только явно изменённые свойства, только из этих списков и диапазонов; шрифт — id из списка, не CSS пользователя. */
  const FONTS = [
    ['system', 'Системный', "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"],
    ['inter', 'Inter', "'Inter', system-ui, sans-serif"],
    ['roboto', 'Roboto', "'Roboto', system-ui, sans-serif"],
    ['open-sans', 'Open Sans', "'Open Sans', system-ui, sans-serif"],
    ['montserrat', 'Montserrat', "'Montserrat', system-ui, sans-serif"],
    ['nunito-sans', 'Nunito Sans', "'Nunito Sans', system-ui, sans-serif"],
    ['lora', 'Lora', "'Lora', Georgia, serif"],
  ];
  const FONT_FAMILY = Object.fromEntries(FONTS.map(([id, , family]) => [id, family]));
  const ALIGNS = [['left', 'По левому краю'], ['center', 'По центру'], ['right', 'По правому краю'], ['justify', 'По ширине']];
  const TEXT_FIELDS = {
    hero: [['title', 'Заголовок'], ['subtitle', 'Подзаголовок']],
    button: [['label', 'Надпись кнопки']],
    text: [['title', 'Заголовок'], ['text', 'Текст']],
    website: [['label', 'Подпись']],
    helpform: [['toggleLabel', 'Кнопка раскрытия'], ['title', 'Заголовок'], ['subtitle', 'Подзаголовок'], ['nameLabel', 'Подпись «Имя»'],
      ['messengerLabel', 'Подпись канала связи'], ['contactLabel', 'Подпись контакта'], ['submitLabel', 'Кнопка отправки']],
    order: [['clientName', 'Имя клиента'], ['title', 'Заголовок'], ['status', 'Статус'], ['details', 'Подробности']],
    chat: [['clientName', 'Имя клиента'], ['title', 'Заголовок'], ['messages', 'Сообщения'], ['placeholder', 'Подсказка поля']],
    input: [['label', 'Подпись'], ['placeholder', 'Подсказка поля']],
    form: [['title', 'Заголовок'], ['subtitle', 'Подзаголовок'], ['submitLabel', 'Кнопка формы']],
    status: [['title', 'Заголовок'], ['values', 'Значения']],
    customer: [['title', 'Заголовок'], ['clientName', 'Имя клиента']],
    sales: [['title', 'Заголовок']],
    contactnotice: [['title', 'Заголовок'], ['text', 'Текст']],
  };
  TEXT_FIELDS.helpform.push(['hint', 'Пояснение формы'], ['namePlaceholder', 'Подсказка имени'], ['contactPlaceholder', 'Подсказка контакта']);
  // Жирность по умолчанию (как в CSS превью): честное состояние кнопки «Жирный», пока свойство не задано явно.
  const BOLD_DEFAULT = new Set(['hero.title', 'button.label', 'text.title', 'helpform.toggleLabel', 'helpform.title', 'helpform.nameLabel',
    'helpform.messengerLabel', 'helpform.contactLabel', 'helpform.submitLabel', 'order.title', 'order.status', 'chat.title', 'input.label', 'status.title',
    'order.clientName', 'chat.clientName', 'customer.clientName', 'sales.title', 'contactnotice.title']);
  // Поля оформления выбранного блока: кнопка раскрытия — только у сворачиваемой формы; у снимка сайта (iframe) полей нет.
  const textFieldsOf = (block) => (block.type === 'website' && mobileSite(block) ? []
    : [...(TEXT_FIELDS[block.type] || []).filter(([key]) => !(block.type === 'helpform' && key === 'toggleLabel' && block.collapsible !== true)),
      ...(['helpform', 'form'].includes(block.type) && Array.isArray(block.fields) ? block.fields.filter((field) => field?.id && !field.hidden).map((field) => [`field:${field.id}`, `Поле: ${str(field.label) || field.id}`]) : [])]);
  const COLOR = /^#[0-9a-f]{6}$/i;
  function cleanTextStyle(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    if (Object.hasOwn(FONT_FAMILY, s.font)) out.font = s.font;
    if (Number.isFinite(s.size) && s.size >= 10 && s.size <= 72) out.size = Math.round(s.size);
    for (const key of ['bold', 'italic', 'underline']) if (typeof s[key] === 'boolean') out[key] = s[key];
    if (ALIGNS.some(([v]) => v === s.align)) out.align = s.align;
    if (typeof s.color === 'string' && COLOR.test(s.color)) out.color = s.color.toLowerCase();
    if (Number.isFinite(s.lineHeight) && s.lineHeight >= 1 && s.lineHeight <= 2.5) out.lineHeight = Math.round(s.lineHeight * 100) / 100;
    return out;
  }
  // Стиль поля → реальные элементы этого поля в превью (data-text-field); остальной блок и инспектор не затрагиваются.
  function applyBlockTextStyles(block, root) {
    const styles = block.textStyles && typeof block.textStyles === 'object' ? block.textStyles : null;
    if (!styles) return;
    for (const [field] of textFieldsOf(block)) {
      if (!Object.hasOwn(styles, field)) continue;
      const s = cleanTextStyle(styles[field]);
      for (const el of root.querySelectorAll(`[data-text-field="${CSS.escape(field)}"]`)) {
        if (s.font) el.style.fontFamily = FONT_FAMILY[s.font];
        if (s.size) el.style.fontSize = `${s.size}px`;
        if (typeof s.bold === 'boolean') el.style.fontWeight = s.bold ? '700' : '400';
        if (typeof s.italic === 'boolean') el.style.fontStyle = s.italic ? 'italic' : 'normal';
        if (typeof s.underline === 'boolean') el.style.textDecoration = s.underline ? 'underline' : 'none';
        // Надписи кнопок — отдельный span на всю ширину (flex: 1), поэтому выравнивание работает и внутри flex-кнопки.
        if (s.align) el.style.textAlign = s.align;
        if (s.color) {
          el.style.color = s.color;
          // Подсказка поля ввода: цвет ::placeholder задаёт CSS через переменную (только когда цвет выбран явно).
          if (el.tagName === 'INPUT') { el.style.setProperty('--ph-color', s.color); el.dataset.phColor = ''; }
        }
        if (s.lineHeight) el.style.lineHeight = String(s.lineHeight);
      }
    }
  }
  const ROLE_PREFIX = { client: 'K', staff: 'S', admin: 'A' };
  const NODE_ROLES = [['client', 'Клиент'], ['staff', 'Сотрудник'], ['admin', 'Админ'], ['source', 'Источник'], ['common', 'Общее']];

  const $ = (id) => document.getElementById(id);
  const ui = { sidebar: $('sidebar'), stage: $('stage'), inspector: $('inspector'), workspace: $('workspace'), save: $('save'), banner: $('banner'), toast: $('toast') };
  const state = { project: null, mode: 'view', tab: 'screens', flowRole: 'client', frameId: 'K01', blockId: null, nodeId: null, showDesktop: false,
    menuOpen: false, works: false, pane: 'stage', showRemoved: false, save: 'idle', saveError: '', conflict: null, loadError: '',
    // Только интерфейс (не проект): открытые формы «Новая страница»/«Добавить узел» и текущее перетаскивание.
    newPage: null, newNode: null, drag: null, connection: null, menuRole: null,
    // Выбранное поле «Оформления текста»: { blockId, key } — держится, пока выбран тот же блок.
    textField: null,
    // «Путь заказа» (только интерфейс): вид блок-схемы, выбор, фильтры типов связей, возврат из формы, временно скрытый список.
    flowView: 'journey', journeySel: null, journeyFilter: { button: true, form: true, message: true, stage: true }, journeyReturn: null,
    journeyTempLeft: false, jConnect: null, jNewType: 'message' };
  const local = { help: new Map(), chat: new Map(), inputs: new Map(), note: '' };   // значения демо-форм и черновики — только память страницы, не проект
  /* Демо-сценарий одного клиента — только память страницы: не проект, не сервер, никаких внешних отправок. Форма подбора
     запоминает имя, канал и контакт и отмечает в чате новый запрос (без автоответа: в приложении автоответ приходит только после
     первого сообщения клиента в чате, а не от самой заявки); пока клиент не написал в чат, менеджер видит
     «Нужно связаться». Канал работы, этап продаж и заметки менеджер меняет вручную. Перезагрузка страницы сбрасывает всё. */
  const demo = { clientName: '', preferredChannel: '', contact: '', formSent: false, clientHasWritten: false, workChannel: 'app',
    messages: [], notes: [], stage: '', stageSource: '', selected: null, submittedAt: null };
  let noticeTimer = 0;

  /* ---------- боковые панели: скрыть/показать и закрепить (только интерфейс этого браузера, не проект) ----------
     Закреплённая панель остаётся открытой при переходах между экранами; незакреплённая сворачивается при открытии
     экрана (openFrame). «Скрыть» работает и у закреплённой; «Закрепить» открывает панель. Хранится в localStorage. */
  const PANEL_KEY = 'boardPanelPrefs';
  const PANEL_TEXT = { left: { name: 'список', Name: 'Список' }, right: { name: 'инспектор', Name: 'Инспектор' } };
  const panels = (() => {
    const base = { left: { open: true, pinned: true }, right: { open: true, pinned: true } };
    try {
      const saved = JSON.parse(window.localStorage.getItem(PANEL_KEY) || 'null');
      for (const side of ['left', 'right']) {
        if (saved && saved[side] && typeof saved[side] === 'object') {
          base[side].open = saved[side].open !== false;
          base[side].pinned = saved[side].pinned !== false;
        }
      }
    } catch (_) { /* хранилище недоступно — значения по умолчанию */ }
    return base;
  })();
  function savePanels() { try { window.localStorage.setItem(PANEL_KEY, JSON.stringify(panels)); } catch (_) { /* не обязательно */ } }
  // Только «рамка» панелей: атрибуты и подписи кнопок; содержимое списка и инспектора (и поля ввода) не пересоздаётся.
  function applyPanels() {
    for (const side of ['left', 'right']) {
      const p = panels[side], t = PANEL_TEXT[side];
      // «Путь заказа» на ПК может временно скрыть список (без записи в настройки панелей).
      const open = p.open && !(side === 'left' && journeyLeftHidden());
      ui.workspace.dataset[side] = open ? 'open' : 'hidden';
      const panel = document.getElementById(`panel-${side}`);
      if (panel) panel.dataset.state = open ? 'open' : 'hidden';
      for (const button of document.querySelectorAll(`.panel-controls [data-panel-toggle="${side}"]`)) {
        const label = open ? `Скрыть ${t.name}` : `Показать ${t.name}`;
        button.setAttribute('aria-pressed', String(open)); button.setAttribute('aria-label', label); button.title = label;
      }
      for (const button of document.querySelectorAll(`[data-panel-pin="${side}"]`)) {
        const label = p.pinned ? `Открепить ${t.name}` : `Закрепить ${t.name}`;
        button.setAttribute('aria-pressed', String(p.pinned)); button.setAttribute('aria-label', label); button.title = label;
      }
    }
    if (state.tab === 'flow') requestAnimationFrame(state.flowView === 'journey' ? drawJourney : drawEdges);
  }
  function setPanel(side, changes) {
    Object.assign(panels[side], changes);
    savePanels();
    applyPanels();
  }
  for (const button of document.querySelectorAll('[data-panel-toggle]')) {
    button.addEventListener('click', () => {
      const side = button.dataset.panelToggle;
      // Временно скрытый «Путём заказа» список просто показывается снова; сохранённые настройки не меняются.
      if (side === 'left' && journeyLeftHidden()) { state.journeyTempLeft = false; applyPanels(); return; }
      setPanel(side, { open: !panels[side].open });
    });
  }
  for (const button of document.querySelectorAll('[data-panel-pin]')) {
    button.addEventListener('click', () => { const side = button.dataset.panelPin; const pinned = !panels[side].pinned; if (side === 'left') state.journeyTempLeft = false; setPanel(side, pinned ? { pinned, open: true } : { pinned }); });
  }
  // Действие в центре (открыт другой экран): незакреплённые панели сворачиваются.
  function autoCollapsePanels() {
    let changedPanels = false;
    for (const side of ['left', 'right']) if (!panels[side].pinned && panels[side].open) { panels[side].open = false; changedPanels = true; }
    if (changedPanels) { savePanels(); applyPanels(); }
  }
  let uid = 0;
  const nextId = (prefix) => `${prefix}-${Date.now().toString(36)}${(uid++).toString(36)}`;

  /* ---------- DOM-помощники: тексты только textContent ---------- */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = String(value);
      else if (key === 'value') el.value = String(value);
      else if (key === 'checked' || key === 'disabled' || key === 'readOnly' || key === 'selected') el[key] = Boolean(value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    return el;
  }
  let toastTimer = 0;
  function toast(text) {
    ui.toast.textContent = text; ui.toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 3200);
  }
  const narrow = () => window.matchMedia('(max-width: 1023px)').matches;
  const safeUrl = (value) => { try { const url = new URL(String(value || ''), location.href); return url.protocol === 'https:' && !url.username && !url.password && ['palitra-love.ru','palitra-love-draft-1.synapsebusiness.ru','t.me','wa.me','vk.com'].includes(url.hostname) ? url.href : ''; } catch (_) { return ''; } };
  const str = (value) => (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value));
  const isLinkButton = (block) => block?.type === 'button' && block.action === 'link';
  // Единая политика ссылок кнопки — в общем модуле (тот же код в приложении). Без модуля ссылка не открывается.
  const safeButtonUrl = (value) => (window.SynapseButtonLink && typeof window.SynapseButtonLink.safeUrl === 'function' ? window.SynapseButtonLink.safeUrl(value) : '');
  function activateButton(block) {
    if (state.mode === 'edit') return;
    if (!isLinkButton(block)) { go(block.target); return; }
    const url = safeButtonUrl(block.url);
    if (url) window.open(url, '_blank', 'noopener,noreferrer'); else toast('Укажите корректную ссылку в настройках кнопки.');
  }

  /* ---------- модель ---------- */
  const frames = () => (state.project && Array.isArray(state.project.frames) ? state.project.frames : []);
  const frameById = (id) => frames().find((frame) => frame.id === id) || null;
  const currentFrame = () => frameById(state.frameId);
  const flow = () => {
    const p = state.project;
    if (!p.flow || typeof p.flow !== 'object') p.flow = { nodes: [], edges: [] };
    if (!Array.isArray(p.flow.nodes)) p.flow.nodes = [];
    if (!Array.isArray(p.flow.edges)) p.flow.edges = [];
    return p.flow;
  };
  const nodeById = (id) => flow().nodes.find((node) => node.id === id) || (menuNodeRole(id) ? menuNode(menuNodeRole(id)) : null);
  const blocksOf = (frame) => { if (!Array.isArray(frame.blocks)) frame.blocks = []; return frame.blocks; };
  const blockById = (frame, id) => (frame ? blocksOf(frame).find((block) => block.id === id) || null : null);
  const nodeLabel = (node) => { const frame = node.frame ? frameById(node.frame) : null; return frame ? str(frame.title) : str(node.label); };
  // Заголовок экрана меняется — подписи связанных узлов схемы тоже (одна модель).
  function setFrameTitle(frame, title) {
    frame.title = title;
    for (const node of flow().nodes) if (node.frame === frame.id) node.label = title;
  }
  /* Переходы приложения ↔ связи схемы. Узел экрана — узел с node.frame === id экрана (предпочтительно с тем же id).
     Связь, созданная переходом блока, помечена blockId и принадлежит этому блоку; ручные связи схемы не трогаются. */
  function frameNodeId(frameId) {
    if (!frameId) return null;
    const nodes = flow().nodes.filter((node) => node.frame === frameId);
    return (nodes.find((node) => node.id === frameId) || nodes[0] || {}).id || null;
  }
  function findBlock(blockId) {
    for (const frame of frames()) { const block = blockById(frame, blockId); if (block) return { frame, block }; }
    return null;
  }
  const blockEdgeLabel = (block) => (block.type === 'chat' ? (block.orderNumber ? `Заказ №${str(block.orderNumber)}` : 'Заказ')
    : block.type === 'customer' ? 'Вернуться в чат приложения' : ['form', 'helpform'].includes(block.type) ? str(block.submitLabel) || 'Продолжить' : str(block.label || block.title));
  // Цель перехода блока изменена: своя связь обновляется/создаётся; пустая цель, @site/@works или самосвязь — связь снимается.
  function syncBlockEdge(frame, block) {
    const edges = flow().edges;
    const index = edges.findIndex((edge) => edge.blockId === block.id);
    const target = isLinkButton(block) ? '' : str(block.target);
    const from = frameNodeId(frame.id), to = target && !target.startsWith('@') ? frameNodeId(target) : null;
    if (!from || !to || from === to) { if (index >= 0) edges.splice(index, 1); return; }
    if (index >= 0) Object.assign(edges[index], { from, to, label: blockEdgeLabel(block) });
    else edges.push({ from, to, label: blockEdgeLabel(block), blockId: block.id });
  }
  // Подпись блока изменена: подпись его связи тоже (если связь есть).
  function syncBlockEdgeLabel(block) {
    const edge = flow().edges.find((item) => item.blockId === block.id);
    if (edge) edge.label = blockEdgeLabel(block);
  }
  function setBlockTarget(frame, block, value) {
    if (value === frame.id) { toast('Выберите другую страницу.'); return false; }
    if (value && !['@site', '@works'].includes(value) && (!frameById(value) || frameById(value).hidden)) { toast('Такой доступной страницы нет.'); return false; }
    block.target = value; syncBlockEdge(frame, block); return true;
  }
  const editHistory = { past: [], future: [], present: '', lastKey: '', lastAt: 0, restoring: false };
  function projectSnapshot() { return JSON.stringify({ ...state.project, revision: 0 }); }
  function updateHistoryButtons() {
    const undo = $('undo'), redo = $('redo');
    if (undo) undo.disabled = !editHistory.past.length || Boolean(state.conflict) || state.authLocked || !state.project;
    if (redo) redo.disabled = !editHistory.future.length || Boolean(state.conflict) || state.authLocked || !state.project;
  }
  function recordEdit() {
    if (!state.project || editHistory.restoring) return;
    const snapshot = projectSnapshot();
    if (snapshot === editHistory.present) return;
    const active = document.activeElement, typing = active && /^(INPUT|TEXTAREA)$/.test(active.tagName) && !['checkbox', 'radio'].includes(active.type);
    const key = typing ? `${state.frameId}:${state.blockId}:${state.nodeId}:${active.id}` : '';
    if (editHistory.present && (!key || key !== editHistory.lastKey || Date.now() - editHistory.lastAt > 700)) {
      editHistory.past.push(editHistory.present); if (editHistory.past.length > 50) editHistory.past.shift();
    }
    editHistory.present = snapshot; editHistory.future = []; editHistory.lastKey = key; editHistory.lastAt = Date.now(); updateHistoryButtons();
    markUserEdit();
  }
  /* Рамка объекта, который появился из-за только что записанной правки (добавлен блок, показана часть формы, включено
     свободное размещение), — часть той же правки: текущий снимок истории дополняется без новой записи и без очистки
     Redo. Признак правки живёт до конца текущей задачи браузера (микрозадачи успевают, таймеры — нет), поэтому
     просмотр, Undo/Redo и reload ничего не записывают. */
  let userEditTick = false;
  function markUserEdit() { if (userEditTick) return; userEditTick = true; setTimeout(() => { userEditTick = false; }, 0); }
  function absorbIntoLastEdit(apply) {
    if (!userEditTick || !state.project || state.conflict || state.authLocked || editHistory.restoring) return false;
    apply();
    editHistory.present = projectSnapshot();
    setSave('pending'); clearTimeout(saveTimer); saveTimer = setTimeout(flush, DEBOUNCE_MS);
    return true;
  }
  function restoreHistory(direction) {
    if (state.conflict || state.authLocked || !state.project) return;
    const source = direction === 'undo' ? editHistory.past : editHistory.future;
    const target = direction === 'undo' ? editHistory.future : editHistory.past;
    if (!source.length) return;
    target.push(projectSnapshot());
    const revision = state.project.revision;
    state.project = JSON.parse(source.pop()); state.project.revision = revision;
    editHistory.present = projectSnapshot(); editHistory.lastKey = '';
    if (!frameById(state.frameId)) state.frameId = frames()[0]?.id || null;
    if (!blockById(currentFrame(), state.blockId)) state.blockId = null;
    if (!nodeById(state.nodeId)) state.nodeId = null;
    renderAll(); editHistory.restoring = true; changed(); editHistory.restoring = false; updateHistoryButtons();
    toast(direction === 'undo' ? 'Изменение отменено' : 'Изменение возвращено');
  }

  /* ---------- сохранение: debounce, строго по одному, без потери правок ---------- */
  let saveTimer = 0, saving = false, again = false;
  function changed() {
    if (state.conflict || state.authLocked) return;
    recordEdit();
    setSave('pending');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, DEBOUNCE_MS);
  }
  async function flush() {
    if (state.conflict || !state.project) return;
    if (saving) { again = true; return; }
    saving = true; again = false;
    setSave('saving');
    const body = JSON.stringify(state.project);
    let next = 'saved';
    try {
      const res = await projectApi.request('project', { method: 'PUT', cache: 'no-store', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body });
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (res.status === 409) {
        state.conflict = data && data.project && typeof data.project === 'object' ? data.project : { revision: null };
        next = 'conflict';
      } else if (!res.ok || !data || !Number.isFinite(data.revision)) {
        throw new Error(data && data.error ? String(data.error) : `ответ сервера ${res.status}`);
      } else {
        // Сохранена ровно отправленная копия; правки, сделанные во время запроса, уйдут следующим PUT с новой revision.
        state.project.revision = data.revision;
        next = again ? 'pending' : 'saved';
      }
    } catch (error) {
      state.saveError = error && error.message ? error.message : 'нет связи с сервером';
      next = 'error';
    } finally {
      saving = false;
      setSave(next);
      renderBanner();
      // «Путь заказа» при конфликте сразу становится только просмотром (без портов и полей правки).
      if (next === 'conflict' && state.tab === 'flow' && state.flowView === 'journey') { jCancel(false); renderStage(); renderInspector(); }
      if (next === 'pending') flush();
    }
  }
  function setSave(value) {
    state.save = value;
    ui.save.dataset.state = value;
    ui.save.textContent = SAVE_TEXT[value] || value;
    ui.save.title = value === 'error' ? state.saveError : '';
  }
  function renderBanner() {
    const banner = ui.banner;
    banner.replaceChildren();
    if (state.authLocked) {
      banner.append(h('p', { text: state.loadError || 'Сессия закончилась. Правки сохранены только в памяти этой страницы. Войдите тем же пользователем, чтобы продолжить.' }),
        h('div', { class: 'banner__actions' }, h('button', { type: 'button', class: 'btn btn--main', text: 'Проверить вход', onclick: recoverAccess })));
      banner.dataset.kind = 'error'; banner.hidden = false; return;
    }
    if (state.conflict) {
      const rev = state.conflict.revision;
      banner.append(h('p', { text: `Проект уже изменён в другом окне${Number.isFinite(rev) ? ` (ревизия ${rev})` : ''}. Последние правки здесь не сохранены и сервер не перезаписан.` }),
        h('div', { class: 'banner__actions' },
          h('button', { type: 'button', class: 'btn', text: 'Скачать мои правки (JSON)', onclick: exportJson }),
          h('button', { type: 'button', class: 'btn btn--main', text: 'Загрузить актуальную версию', onclick: adoptLatest })));
      banner.dataset.kind = 'error'; banner.hidden = false; return;
    }
    if (state.save === 'error') {
      banner.append(h('p', { text: `Не удалось сохранить: ${state.saveError}. Правки остались на странице.` }),
        h('div', { class: 'banner__actions' }, h('button', { type: 'button', class: 'btn btn--main', text: 'Повторить сохранение', onclick: () => { renderBanner(); flush(); } })));
      banner.dataset.kind = 'error'; banner.hidden = false; return;
    }
    if (state.loadError) {
      banner.append(h('p', { text: `Проект не загрузился: ${state.loadError}` }),
        h('div', { class: 'banner__actions' }, h('button', { type: 'button', class: 'btn btn--main', text: 'Загрузить снова', onclick: load })));
      banner.dataset.kind = 'error'; banner.hidden = false; return;
    }
    banner.hidden = true;
  }
  async function recoverAccess() {
    try {
      const response = await projectApi.request('project');
      const data = await response.json();
      if (state.authLocked) return;
      if (state.conflict) { if (data && Array.isArray(data.frames)) state.conflict = data; setSave('conflict'); renderBanner(); }
      else if (state.project) await flush();
      else await load();
    } catch (error) { toast(error.message || 'Вход пока не подтверждён.'); renderBanner(); }
  }
  async function adoptLatest() {
    if (saving || state.authLocked) return;
    const latest = state.conflict;
    state.conflict = null;
    if (latest && Array.isArray(latest.frames)) { useProject(latest); setSave('saved'); renderBanner(); renderAll(); return; }
    await load();
  }
  function exportJson() {
    if (!state.project || state.authLocked) return;
    const blob = new Blob([JSON.stringify(state.project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: `palitra-board-r${state.project.revision ?? 0}.json` });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  window.addEventListener('beforeunload', (event) => {
    if (saving || state.save === 'pending' || state.save === 'error') { event.preventDefault(); event.returnValue = ''; }
  });

  /* ---------- загрузка ---------- */
  function useProject(project) {
    state.project = project;
    if (typeof project.appTitle !== 'string') project.appTitle = 'Palitra Love заказы';
    if (!frameById(state.frameId)) state.frameId = frameById('K01') ? 'K01' : (frames()[0] ? frames()[0].id : null);
    if (state.blockId && !blockById(currentFrame(), state.blockId)) state.blockId = null;
    if (state.nodeId && !nodeById(state.nodeId)) state.nodeId = null;
    flow();
    editHistory.past = []; editHistory.future = []; editHistory.present = projectSnapshot(); editHistory.lastKey = ''; updateHistoryButtons();
  }
  async function load() {
    state.loadError = '';
    setSave('idle');
    try {
      const res = await projectApi.request('project', { cache: 'no-store', headers: { Accept: 'application/json' } });
      const data = await res.json();
      if (!res.ok || !data || !Array.isArray(data.frames)) throw new Error(`ответ сервера ${res.status}`);
      useProject(data);
      setSave('saved');
    } catch (error) {
      state.loadError = error && error.message ? error.message : 'нет связи с сервером';
      ui.save.textContent = 'Нет данных'; ui.save.dataset.state = 'error';
    }
    renderBanner();
    renderAll();
  }

  window.addEventListener('projectforms-authchange', event => {
    if (event.detail?.restored) {
      state.authLocked = false; ui.workspace.hidden = false; $('export').disabled = false;
      state.saveError = ''; setSave(state.conflict ? 'conflict' : state.project ? 'pending' : 'idle'); updateHistoryButtons(); renderBanner();
      return;
    }
    state.authLocked = true; ui.workspace.hidden = true; $('export').disabled = true;
    for (const dialog of document.querySelectorAll('.versions-dialog')) { try { dialog.close(); } catch (_) {} dialog.remove(); }
    clearTimeout(saveTimer);
    state.saveError = 'Сессия закончилась или изменилась. Правки не отправляются.';
    if (event.detail?.changed) {
      // A new account must not see the previous private model.
      editHistory.past = []; editHistory.future = []; editHistory.present = ''; editHistory.lastKey = ''; editHistory.lastAt = 0;
      state.project = null; state.conflict = null; ui.stage.replaceChildren(); ui.sidebar.replaceChildren(); ui.inspector.replaceChildren();
      state.loadError = 'Пользователь изменился. Откройте редактор заново.';
    }
    setSave('error'); updateHistoryButtons(); renderBanner();
  });
  const versionsButton = $('versions');
  if (versionsButton) {
    versionsButton.hidden = !projectApi.native;
    versionsButton.addEventListener('click', async () => {
      if (!state.project || saving || state.authLocked) return;
      try {
        const response = await projectApi.request('history');
        const data = await response.json(); if (!response.ok) throw new Error(data.error || 'История недоступна');
        const dialog = h('dialog', { class: 'versions-dialog' });
        let restoring = false;
        const close = () => { dialog.close(); dialog.remove(); };
        dialog.append(h('h2', { text: 'История проекта' }), h('p', { text: 'Восстановление создаст новую версию. Текущие серверные версии сохранятся.' }));
        for (const item of data.versions || []) {
          const row = h('div', { class: 'versions-row' }, h('span', { text: `Версия ${item.version} · ${item.created_at}` }));
          row.append(h('button', { type: 'button', class: 'btn', text: 'Восстановить', onclick: async () => {
            if (state.authLocked || !state.project) return;
            if (!window.confirm('Восстановить эту версию? Несохранённые правки здесь будут заменены.')) return;
            if (saving || restoring) return;
            restoring = true;
            const buttons = [...dialog.querySelectorAll('button')]; for (const button of buttons) button.disabled = true;
            try {
            clearTimeout(saveTimer);
            const result = await projectApi.request('restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: state.project.revision, version: item.version }) });
            const body = await result.json();
            if (result.status === 409) { state.conflict = body.project || { revision: null }; setSave('conflict'); renderBanner(); close(); return; }
            if (!result.ok) { toast(body.error || 'Восстановление не выполнено'); return; }
            close(); await load();
            } catch (error) { toast(error.message || 'Восстановить версию не удалось. Правки остались на странице.'); }
            finally { restoring = false; for (const button of buttons) button.disabled = false; }
          }})); dialog.append(row);
        }
        dialog.append(h('button', { type: 'button', class: 'btn', text: 'Закрыть', onclick: close }));
        dialog.addEventListener('cancel', () => dialog.remove()); document.body.append(dialog); dialog.showModal();
      } catch (error) { toast(error.message); }
    });
  }

  /* ---------- верхняя панель и вкладки узкого экрана ---------- */
  // Атрибуты data-tab/mode/pane на контейнерах хранят состояние для CSS.
  // Переключение разрешено только кнопкам: клик поля не должен пересоздавать инспектор.
  const CONTROLS = { tab: 'button.seg__btn[data-tab]', mode: 'button.seg__btn[data-mode]', pane: 'button.panes__btn[data-pane]' };
  function renderTop() {
    const product = $('open-product');
    if (product) {
      const role = (state.tab === 'flow' ? state.flowRole : currentFrame()?.role) || 'client';
      product.href = role === 'client'
        ? 'https://palitra-love.ru/love-app/shop.html#K01'
        : 'https://synapse.synapsebusiness.ru/cabinet/palitra-orders/cabinet.html';
      product.title = role === 'client' ? 'Открыть клиентское приложение с главной страницы' : 'Открыть кабинет сотрудника';
    }
    for (const button of document.querySelectorAll(CONTROLS.tab)) button.setAttribute('aria-pressed', String(button.dataset.tab === state.tab));
    for (const button of document.querySelectorAll(CONTROLS.mode)) button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
    for (const button of document.querySelectorAll(CONTROLS.pane)) button.setAttribute('aria-pressed', String(button.dataset.pane === state.pane));
    ui.workspace.dataset.pane = state.pane;
    ui.workspace.dataset.tab = state.tab;
    document.body.dataset.mode = state.mode;
  }
  document.addEventListener('click', (event) => {
    const tab = event.target.closest(CONTROLS.tab);
    if (tab) {
      if (tab.dataset.tab === 'flow' && state.journeyReturn && state.flowView === 'journey') { returnToJourney(); return; }
      if (tab.dataset.tab === 'flow' && state.tab !== 'flow') state.flowRole = frameById(state.frameId)?.role || state.flowRole;
      if (tab.dataset.tab === 'flow' && state.tab !== 'flow' && state.flowView === 'journey') enterJourney();
      if (tab.dataset.tab !== 'flow') jCancel(false);
      state.tab = tab.dataset.tab; state.menuOpen = false; state.works = false; renderAll(); return;
    }
    const mode = event.target.closest(CONTROLS.mode);
    if (mode) { state.mode = mode.dataset.mode; state.menuOpen = false; renderAll(); return; }
    const pane = event.target.closest(CONTROLS.pane);
    if (pane) { state.pane = pane.dataset.pane; renderTop(); if (state.tab === 'flow' && state.pane === 'stage') requestAnimationFrame(drawEdges); }
  });
  $('export').addEventListener('click', exportJson);
  $('undo')?.addEventListener('click', () => restoreHistory('undo'));
  $('redo')?.addEventListener('click', () => restoreHistory('redo'));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && jCancel()) { event.preventDefault(); return; }
    if (event.key === 'Escape' && state.connection) { cancelConnection(); return; }
    if (event.key === 'Escape' && (state.menuOpen || state.works)) { state.menuOpen = false; state.works = false; renderStage(); }
    if ((event.ctrlKey || event.metaKey) && !/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) && !event.target.isContentEditable) {
      if (event.key.toLowerCase() === 'z') { event.preventDefault(); restoreHistory(event.shiftKey ? 'redo' : 'undo'); }
      else if (event.key.toLowerCase() === 'y') { event.preventDefault(); restoreHistory('redo'); }
    }
  });

  function renderAll({ keepConnection = false } = {}) {
    if (!keepConnection) cancelConnection(false);
    renderTop();
    renderSidebar();
    renderStage();
    renderInspector();
    applyPanels();
  }

  /* ---------- список экранов ---------- */
  function renderSidebar() {
    const box = ui.sidebar;
    box.replaceChildren();
    if (!state.project) { box.append(h('p', { class: 'muted pad', text: 'Проект ещё не загружен.' })); return; }
    const list = (device) => ROLES.map((role) => {
      const items = frames().filter((frame) => (frame.role === role.id) && (!frame.hidden || state.showRemoved) && ((frame.device === 'desktop') === (device === 'desktop')));
      if (!items.length) return null;
      return h('section', { class: 'group' },
        h('h3', { class: 'group__title', text: role.label }),
        h('ul', { class: 'group__list' }, items.map((frame) => h('li', {},
          h('button', { type: 'button', class: `frame-link${frame.id === state.frameId && state.tab === 'screens' ? ' is-current' : ''}`,
            onclick: () => {
              if (state.tab === 'flow') switchFlowRole(frame.role, { nodeId: flow().nodes.find((node) => node.frame === frame.id)?.id });
              else openFrame(frame.id);
              if (narrow()) { state.pane = 'stage'; renderTop(); }
            } },
            h('span', { class: 'frame-link__id', text: frame.id }),
            h('span', { class: 'frame-link__title', text: `${frame.hidden ? 'Убрана · ' : ''}${str(frame.title) || 'Без названия'}` }),
            reviewDots(frame))))));
    });
    // Отдельный заметный вход: тексты окон установки и уведомлений приложения.
    box.append(h('button', { type: 'button', class: `btn notice-entry${state.tab === 'notices' ? ' is-current' : ''}`, 'aria-pressed': String(state.tab === 'notices'),
      dataset: { noticeEntry: '' }, onclick: openNotices }, h('span', { class: 'notice-entry__icon', 'aria-hidden': 'true', text: '🔔' }), h('span', { text: 'Окна и уведомления' })));
    box.append(h('div', { class: 'sidebar__head' }, h('h2', { text: 'Экраны' }), h('span', { class: 'muted', text: 'телефон' })));
    if (state.mode === 'edit') box.append(newPageControl());
    box.append(...list('mobile').filter(Boolean));
    const desktopCount = frames().filter((frame) => frame.device === 'desktop').length;
    box.append(h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: state.showDesktop, onchange: (event) => { state.showDesktop = event.target.checked; renderSidebar(); if (state.tab === 'flow') renderStage(); } }),
      h('span', { text: `Показать ПК-экраны${desktopCount ? ` (${desktopCount})` : ''}` })));
    if (state.showDesktop) {
      const desktop = list('desktop').filter(Boolean);
      box.append(h('div', { class: 'sidebar__desktop' }, h('div', { class: 'sidebar__head' }, h('h2', { text: 'ПК' })),
        desktop.length ? desktop : h('p', { class: 'muted pad', text: 'ПК-экранов пока нет.' })));
    }
    if (state.mode === 'edit' && frames().some((frame) => frame.hidden)) box.append(h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: state.showRemoved, onchange: (event) => { state.showRemoved = event.target.checked; renderSidebar(); } }),
      h('span', { text: 'Показать убранные страницы' })));
  }
  /* «Новая страница» (только в редактировании): короткая форма прямо в списке, без prompt. Ввод не перерисовывает
     список; ID — следующий свободный номер роли (K/S/A) с учётом всех экранов, в том числе ПК, и узлов схемы. */
  function newPageControl() {
    if (!state.newPage) {
      return h('button', { type: 'button', class: 'btn btn--small sidebar__new', text: '+ Новая страница',
        onclick: () => { state.newPage = { title: '', role: state.tab === 'flow' ? state.flowRole : 'client', device: 'mobile', error: '' }; renderSidebar(); ui.sidebar.querySelector('.new-page input')?.focus(); } });
    }
    const draft = state.newPage;
    const error = h('p', { class: 'form-error', role: 'alert', text: draft.error });
    const titleId = nextId('np'), roleId = nextId('np'), deviceId = nextId('np');
    return h('form', { class: 'new-page', novalidate: true, onsubmit: (event) => {
      event.preventDefault();
      const title = draft.title.trim();
      if (!title) { draft.error = 'Введите название страницы.'; error.textContent = draft.error; ui.sidebar.querySelector('.new-page input')?.focus(); return; }
      createFrame(title, draft.role, draft.device);
    } },
      h('label', { for: titleId, text: 'Название' }),
      h('input', { id: titleId, type: 'text', value: draft.title, maxlength: '120', oninput: (event) => { draft.title = event.target.value; } }),
      h('label', { for: roleId, text: 'Роль' }),
      h('select', { id: roleId, onchange: (event) => { draft.role = event.target.value; } }, ROLES.map((role) => h('option', { value: role.id, selected: role.id === draft.role, text: role.label }))),
      h('label', { for: deviceId, text: 'Устройство' }),
      h('select', { id: deviceId, onchange: (event) => { draft.device = event.target.value; } },
        h('option', { value: 'mobile', selected: draft.device !== 'desktop', text: 'Телефон' }), h('option', { value: 'desktop', selected: draft.device === 'desktop', text: 'ПК' })),
      error,
      h('div', { class: 'ins-actions' },
        h('button', { type: 'submit', class: 'btn btn--main btn--small', text: 'Создать' }),
        h('button', { type: 'button', class: 'btn btn--small', text: 'Отмена', onclick: () => { state.newPage = null; renderSidebar(); } })));
  }
  function nextFrameId(role) {
    const prefix = ROLE_PREFIX[role] || 'K';
    const taken = new Set([...frames().map((frame) => frame.id), ...flow().nodes.map((node) => node.id)]);
    let max = 0;
    for (const id of taken) { const match = new RegExp(`^${prefix}(\\d+)$`).exec(String(id)); if (match) max = Math.max(max, Number(match[1])); }
    let n = max + 1, id;
    do { id = `${prefix}${String(n).padStart(2, '0')}`; n += 1; } while (taken.has(id));
    return id;
  }
  function createFrame(title, role, device) {
    const id = nextFrameId(role);
    frames().push({ id, role, title, device: device === 'desktop' ? 'desktop' : 'mobile', kind: 'custom', review: 'pending', blocks: [] });
    flow().nodes.push({ id, label: title, role, frame: id });
    state.newPage = null;
    changed();
    openFrame(id);
    toast(`Страница ${id} создана`);
  }
  // Сводка решений по блокам экрана: изменить / убрать.
  function reviewDots(frame) {
    const blocks = blocksOf(frame);
    const change = blocks.filter((b) => b.review === 'change').length, remove = blocks.filter((b) => b.review === 'remove').length;
    if (!change && !remove) return null;
    return h('span', { class: 'frame-link__marks' },
      change ? h('span', { class: 'mark mark--change', title: 'Изменить', text: String(change) }) : null,
      remove ? h('span', { class: 'mark mark--remove', title: 'Убрать', text: String(remove) }) : null);
  }
  /* «Назад» в шапке превью: история переходов только в памяти страницы (не проект и не window.history). Любой переход
     на другой экран (кнопка, меню, список, схема) запоминает предыдущий экран и его прокрутку. Переход на экран, который
     уже есть в истории, обрезает историю до него — без «пинг-понга» вкладок и петель; поэтому в истории нет ни текущего
     экрана, ни повторов. «Назад» записей не добавляет, устаревшие ID (экрана больше нет) пропускаются. */
  const navHistory = [];
  const canGoBack = () => navHistory.some((entry) => entry.id !== state.frameId && frameById(entry.id));
  function goBack() {
    while (navHistory.length) {
      const entry = navHistory.pop();
      if (entry.id !== state.frameId && frameById(entry.id)) { openFrame(entry.id, { back: true, scrollTop: entry.top }); return; }
    }
    renderStage();
  }
  function openFrame(id, { back = false, scrollTop = 0 } = {}) {
    const frame = frameById(id);
    if (!frame) { toast(`Экран ${id || '—'} не найден в проекте`); return; }
    const prev = state.frameId;
    if (!back && prev !== id && prev && frameById(prev)) {
      // Обычный переход записывает фактический предыдущий экран, даже если новый уже посещали.
      // Возврат отдельным действием back=true не добавляет запись и не создаёт «пинг-понг».
      const prevBody = state.tab === 'screens' ? ui.stage.querySelector('.app-body') : null;
      navHistory.push({ id: prev, top: prevBody ? prevBody.scrollTop : 0 });
    }
    state.frameId = id; state.blockId = null; state.menuOpen = false; state.menuRole = null; state.works = false; state.tab = 'screens';
    if (frame.device === 'desktop') state.showDesktop = true;
    if (!narrow()) autoCollapsePanels();
    renderAll();
    const body = ui.stage.querySelector('.app-body');
    if (body) body.scrollTop = back ? scrollTop : 0;
  }

  /* ---------- свободное размещение (как Zero Block): только числовой freeLayout экрана или формы подбора ----------
     Выключенный или отсутствующий freeLayout — прежняя разметка без изменений. Включение измеряет объекты там, где они
     сейчас нарисованы, поэтому первый свободный кадр совпадает с обычным. Новые объекты без сохранённой рамки
     ставятся под существующими и сохраняются только в режиме редактирования. Служебное меню, «Назад» и шапка
     приложения объектами полотна не являются. */
  let freeBindings = [], freeSelected = null, freeFocus = null;
  // Нарисованные в прошлый раз объекты каждого холста и рамки, поставленные только в памяти (без записи в модель).
  const freeDrawn = new Map(), freeMemory = new WeakMap();
  const freeKey = (scope, ownerId) => `${scope}:${ownerId}`;
  function freeView(owner) {
    const memory = freeMemory.get(owner);
    return memory && memory.base === owner.freeLayout ? memory.layout : owner.freeLayout;
  }
  const FREE_MAX_SCALE = 1;
  const freeEnabled = (owner) => window.SynapseFreeLayout?.normalize(owner?.freeLayout)?.enabled === true;
  const FREE_PART_LABEL = { title: 'Заголовок', subtitle: 'Подзаголовок', nameLabel: 'Подпись имени', nameInput: 'Поле имени',
    channelLabel: 'Подпись канала связи', channelInput: 'Выбор канала связи', contactLabel: 'Подпись контакта', contactInput: 'Поле контакта',
    hint: 'Пояснение', extras: 'Дополнительные поля', consent: 'Согласие на обработку данных', submit: 'Кнопка отправки' };
  const CONSENT_TEXT = 'Согласен(на) на обработку персональных данных для связи по заявке';
  function disposeFreeLayouts() { for (const dispose of freeBindings) dispose(); freeBindings = []; }
  function freeScene(nodes, scope, ownerId) {
    // Только классы: оформление полотна — в общем CSS (flex-колонка; несохранённые объекты не растягиваются по высоте).
    return h('div', { class: scope === 'frame' ? 'frame-free-scene' : 'form-free-scene', dataset: { freeScope: scope, freeOwner: ownerId } }, nodes);
  }
  // Категории K01 в свободном режиме — отдельные объекты; полоса-фон под ними — свой объект «Фон категорий».
  function freeFrameContent(frame, blocks) {
    if (!freeEnabled(frame)) return blocks;
    const flat = blocks.flatMap((node) => node.classList.contains('celebration-categories')
      ? [h('div', { class: 'celebration-backdrop', 'aria-hidden': 'true', dataset: { freeId: 'frame:categories' } }), ...node.children] : [node]);
    const managed = flat.filter((node) => node.dataset.freeId);
    if (!managed.length) return flat;
    const scene = freeScene(managed, 'frame', frame.id), first = flat.indexOf(managed[0]);
    return flat.flatMap((node, index) => index === first ? [scene] : node.dataset.freeId ? [] : [node]);
  }
  function freeRoot(frame, block) {
    if (block) return ui.stage.querySelector(`.blk[data-block="${CSS.escape(String(block.id))}"] form.helpform`);
    return ui.stage.querySelector('.app-body');
  }
  const freeSceneOf = (scope, ownerId) => [...ui.stage.querySelectorAll('[data-free-scope]')]
    .find((node) => node.dataset.freeScope === scope && node.dataset.freeOwner === String(ownerId)) || null;
  // Объекты ровно в том виде, как нарисованы сейчас: блоки, надпись, полоса категорий и каждая категория; части формы.
  function freeEntries(root, block) {
    const entries = [];
    for (const node of root.children) {
      if (!block && node.classList.contains('celebration-categories')) {
        entries.push(['frame:categories', node]);
        for (const child of node.children) if (child.dataset.freeId) entries.push([child.dataset.freeId, child]);
      } else if (node.dataset.freeId) {
        // Сворачиваемая форма: рамка объекта — это кнопка раскрытия, даже если форма сейчас открыта.
        const toggle = !block && node.querySelector(':scope > .helpform-wrap > .helpform-toggle');
        entries.push([node.dataset.freeId, toggle || node]);
      }
    }
    return entries;
  }
  function captureFreeLayout(frame, block) {
    const api = window.SynapseFreeLayout;
    if (!api?.captureNodes || state.tab !== 'screens') return null;
    const owner = block || frame;
    const root = freeRoot(frame, block);
    if (!root) return null;
    if (block) {
      const panel = root.closest('.helpform-panel');
      if (panel?.hidden) {
        panel.hidden = false; panel.previousElementSibling?.setAttribute('aria-expanded', 'true');
        const saved = local.help.get(`${frame.id}:${block.id}`); if (saved) saved.expanded = true;
      }
    }
    // Измерение до любого переноса узлов: первый свободный кадр не прыгает.
    const scene = root.querySelector(':scope > [data-free-scope]') || root;
    const layout = api.captureNodes(scene, freeEntries(scene, block), owner.freeLayout);
    return layout && Object.keys(layout.items).length ? layout : null;
  }
  function restoreFreeFocus() {
    const focus = freeFocus; freeFocus = null;
    if (!focus) return;
    const control = [...(freeSceneOf(focus.scope, focus.ownerId)?.children || [])].find((node) => node.dataset.freeControl === focus.id);
    // Та же ручка: режим и, для изменения размера, тот же край/угол.
    const handle = control && [...control.children].find((node) => node.dataset.freeHandle === focus.mode && (node.dataset.freeDir || '') === (focus.dir || ''));
    if (handle) handle.focus({ preventScroll: true });
  }
  function attachFreeLayouts() {
    if (!state.project || state.tab !== 'screens' || !window.SynapseFreeLayout) return;
    const frame = currentFrame(); if (!frame) return;
    const editing = state.mode === 'edit';
    for (const root of ui.stage.querySelectorAll('[data-free-scope]')) {
      const block = root.dataset.freeScope === 'block' ? blockById(frame, root.dataset.freeOwner) : null;
      const owner = block || frame; if (!freeEnabled(owner)) continue;
      const scope = block ? 'block' : 'frame';
      const selected = editing && freeSelected?.scope === scope && freeSelected.ownerId === owner.id ? freeSelected.id : '';
      const live = () => currentFrame() === frame && (!block || blockById(frame, block.id) === block) && freeEnabled(owner);
      const key = freeKey(scope, owner.id), previouslyDrawn = freeDrawn.get(key) || new Set();
      freeDrawn.set(key, new Set([...root.children].map((node) => node.dataset.freeId).filter(Boolean)));
      freeBindings.push(window.SynapseFreeLayout.bind({ root, layout: owner.freeLayout, editing, complete: true, maxScale: FREE_MAX_SCALE, selected,
        onSelect: (id) => {
          freeSelected = { scope, ownerId: owner.id, id };
          if (block) state.blockId = block.id;
          else if (blockById(frame, id)) state.blockId = id;
          renderInspector();
        },
        // Объект без рамки ставится под остальными. В модель рамка попадает только вместе с правкой, из-за которой объект
        // появился; иначе (просмотр, Undo/Redo, reload, давно нарисованный объект) — только память до первого перемещения.
        onComplete: editing ? (layout) => {
          if (!live()) return;
          const stored = window.SynapseFreeLayout.normalize(owner.freeLayout);
          if (!stored) return;
          const fresh = Object.keys(layout.items).filter((id) => !Object.hasOwn(stored.items, id) && !previouslyDrawn.has(id));
          const base = owner.freeLayout;
          const absorbed = fresh.length && absorbIntoLastEdit(() => {
            for (const id of fresh) stored.items[id] = { ...layout.items[id] };
            stored.height = Math.max(stored.height, ...fresh.map((id) => layout.items[id].y + layout.items[id].height));
            owner.freeLayout = stored;
          });
          freeMemory.set(owner, { base: absorbed ? owner.freeLayout : base, layout });
          if (!ui.inspector.contains(document.activeElement)) renderInspector();
        } : null,
        onChange: (layout) => {
          if (!live()) return;
          const handle = document.activeElement?.closest?.('[data-free-handle]');
          freeFocus = handle && root.contains(handle) ? { scope, ownerId: owner.id, id: handle.parentNode.dataset.freeControl, mode: handle.dataset.freeHandle, dir: handle.dataset.freeDir || '' } : null;
          owner.freeLayout = layout; changed(); renderStage(); renderInspector();
        } }));
    }
    restoreFreeFocus();
  }
  function freeItemLabel(frame, block, id) {
    if (block) return FREE_PART_LABEL[id] || id;
    if (id === 'frame:eyebrow') return 'Надпись над заголовком';
    if (id === 'frame:categories') return 'Фон категорий';
    const category = /^frame:category:(\d+)$/.exec(id);
    if (category) {
      const item = Array.isArray(frame.categories) ? frame.categories[Number(category[1])] : null;
      const label = str(item?.label).replace(/\s+/g, ' ').trim();
      return `Категория ${Number(category[1]) + 1}${label ? ` · ${label}` : ''}`;
    }
    const owned = blockById(frame, id);
    if (!owned) return `${id} · блока нет`;
    const text = str(owned.label ?? owned.title ?? owned.toggleLabel ?? owned.text).replace(/\s+/g, ' ').trim();
    return `${TYPE_LABEL[owned.type] || owned.type}${text ? ` · ${text.slice(0, 40)}` : ''}`;
  }
  function freeLayoutInspector(frame, block = null) {
    const owner = block || frame, api = window.SynapseFreeLayout, scope = block ? 'block' : 'frame';
    const box = h('section', { class: 'fb-settings' }, h('h3', { class: 'ins-sub', text: block ? 'Свободное размещение внутри формы' : 'Свободное размещение блоков' }));
    box.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: freeEnabled(owner), disabled: !api,
      onchange: (event) => {
        if (event.target.checked) {
          // Повторное включение возвращает прежние координаты; первое — измеряет текущий вид без сдвигов.
          const layout = api.normalize({ ...(owner.freeLayout || {}), enabled: true }) || captureFreeLayout(frame, block);
          if (!layout) { renderStage(); renderInspector(); toast('Откройте экран и форму, чтобы разместить элементы.'); return; }
          owner.freeLayout = layout;
        } else owner.freeLayout = { ...(owner.freeLayout || {}), enabled: false };
        freeSelected = null; edited(); renderInspector();
      } }), h('span', { text: 'Размещать в любой точке полотна' })));
    if (!freeEnabled(owner)) return box;
    const layout = api.normalize(freeView(owner)), ids = Object.keys(layout.items);
    const scene = freeSceneOf(scope, owner.id);
    const drawn = new Set([...(scene?.children || [])].map((node) => node.dataset.freeId).filter(Boolean));
    const selected = freeSelected?.scope === scope && freeSelected.ownerId === owner.id && ids.includes(freeSelected.id) ? freeSelected.id : ids[0];
    box.append(h('p', { class: 'hint', text: 'Перетащите элемент курсором или тяните ✥ и ↘ у выбранного. Стрелки на выбранной ручке — 1 пиксель, Shift — 10. Скрытые элементы сохраняют своё место.' }));
    if (selected) {
      box.append(selectField('Элемент', selected, ids.map((id) => [id, `${freeItemLabel(frame, block, id)}${drawn.has(id) ? '' : ' · скрыт'}`]), (id) => {
        freeSelected = { scope, ownerId: owner.id, id }; renderStage(); renderInspector();
      }));
      const drawnNode = [...(scene?.children || [])].find((node) => node.dataset.freeId === selected);
      const minSize = /^\d{1,3}$/.test(drawnNode?.dataset.freeMin || '') ? Number(drawnNode.dataset.freeMin) : (api.limits.minSize || 1);
      for (const [key, label] of [['x', 'X'], ['y', 'Y'], ['width', 'Ширина'], ['height', 'Высота']]) {
        const id = nextId('free-value'), item = layout.items[selected];
        const input = h('input', { id, type: 'number', min: key === 'x' || key === 'y' ? '0' : String(minSize), max: '20000', step: '1', value: Math.round(item[key]),
          dataset: { freeField: key },
          oninput: (event) => {
            if (event.target.value === '') return;
            const value = Number(event.target.value); if (!Number.isFinite(value)) return;
            if ((key === 'width' || key === 'height') && value < minSize) return;   // кнопки не меньше 44 px
            const next = api.updateItem(freeView(owner), selected, { [key]: value });
            if (next) { owner.freeLayout = next; edited(); }
          } });
        box.append(h('div', { class: 'ins-field' }, h('label', { for: id, text: label }), input));
      }
    }
    box.append(h('button', { type: 'button', class: 'btn btn--small', text: 'Вернуть обычное расположение', onclick: () => {
      owner.freeLayout = { ...owner.freeLayout, enabled: false }; freeSelected = null; edited(); renderInspector();
    } }));
    return box;
  }

  /* ---------- «Окна и уведомления»: тексты окон установки и уведомлений приложения (project.notificationTexts) ----------
     Только тексты: заголовки, пояснения, подписи кнопок и шаги установки. Схема, лимиты и стандартные тексты — в общем модуле
     SynapseNotificationCopy (тот же код получает приложение). Пустая строка сохраняется как пустой текст; «Вернуть
     стандартный» удаляет поле, и приложение снова показывает стандартный текст. Вывод только через textContent; кнопки
     предпросмотра ничего не делают. Публикацию в приложение выполняет Root отдельно. */
  const noticeCopy = () => window.SynapseNotificationCopy || null;
  const NOTICE_GROUPS = [['title', 'Заголовки'], ['button', 'Кнопки'], ['text', 'Тексты окон'], ['step', 'Шаги установки']];
  function openNotices() {
    state.tab = 'notices'; state.menuOpen = false; state.menuRole = null; state.nodeId = null; state.works = false;
    if (narrow()) state.pane = 'stage';
    renderAll();
  }
  function noticeTexts() {
    const api = noticeCopy();
    return api ? api.resolve(state.project?.notificationTexts) : {};
  }
  function renderNoticePreview() {
    const api = noticeCopy();
    if (!api) return h('p', { class: 'muted pad', text: 'Модуль текстов окон не загружен.' });
    const t = noticeTexts();
    const txt = (tag, key, cls = '') => h(tag, { class: `notice-copy__${tag === 'h3' ? 'title' : 'text'}${cls ? ` ${cls}` : ''}`, dataset: { copyKey: key }, text: t[key] });
    const btn = (key, main = false) => h('button', { type: 'button', class: `app-btn app-btn--small${main ? '' : ' app-btn--ghost'}`, tabindex: '-1', 'aria-disabled': 'true', dataset: { copyKey: key }, text: t[key] });
    const close = () => h('button', { type: 'button', class: 'notice-copy__close', tabindex: '-1', 'aria-disabled': 'true', dataset: { copyKey: 'closeLabel' }, text: t.closeLabel });
    const card = (name, label, ...kids) => h('section', { class: 'notice-copy__card', dataset: { noticePreview: name }, 'aria-label': label },
      h('p', { class: 'notice-copy__label', text: label }), ...kids);
    const steps = (keys) => h('ol', { class: 'notice-copy__steps' }, keys.map((key) => h('li', { dataset: { copyKey: key }, text: t[key] })));
    return h('div', { class: 'stage__inner notice-copy-stage' },
      h('div', { class: 'stage__caption' }, h('span', { class: 'chip', text: 'Окна' }), h('span', { class: 'stage__title', text: 'Окна и уведомления' }),
        h('span', { class: 'muted', text: 'Предпросмотр текстов. Кнопки здесь ничего не делают.' })),
      h('div', { class: 'notice-copy' },
        card('install-client', 'Установка · клиент', h('div', { class: 'notice-copy__head' }, txt('h3', 'installTitle'), close()),
          txt('p', 'installClientText'), txt('p', 'iosInstallText', 'notice-copy__note'),
          h('div', { class: 'notice-copy__actions' }, btn('installButton', true), btn('installHelpButton'), btn('laterButton'), btn('neverButton'))),
        card('install-staff', 'Установка · сотрудник', h('div', { class: 'notice-copy__head' }, txt('h3', 'installTitle'), close()),
          txt('p', 'installStaffText'), h('div', { class: 'notice-copy__actions' }, btn('installButton', true), btn('installHelpButton'), btn('laterButton')),
          h('p', { class: 'notice-copy__busy' }, h('span', { class: 'muted', text: 'Во время установки кнопка: ' }), h('span', { dataset: { copyKey: 'installBusyText' }, text: t.installBusyText }))),
        card('guide', 'Как установить', txt('h3', 'deviceHeading'),
          h('p', { class: 'notice-copy__os', text: 'iPhone' }), steps(['iosStep1', 'iosStep2', 'iosStep3', 'iosStep4']),
          h('p', { class: 'notice-copy__os', text: 'Android' }), steps(['androidStep1', 'androidStep2', 'androidStep3']),
          h('p', { class: 'notice-copy__os', text: 'Компьютер' }), steps(['desktopStep1', 'desktopStep2', 'desktopStep3']),
          h('div', { class: 'notice-copy__example' }, h('div', { class: 'notice-copy__image', text: 'Инструкция со скриншотами доступна в приложении' }),
            txt('p', 'guideExampleText'), txt('p', 'guideSourceLabel', 'notice-copy__note')),
          h('div', { class: 'notice-copy__actions' }, btn('guideImageButton'), btn('guideBackButton'))),
        card('notifications', 'Уведомления', h('div', { class: 'notice-copy__head' }, txt('h3', 'notificationTitle'), close()),
          txt('p', 'permissionPromptText'), h('div', { class: 'notice-copy__actions' }, btn('enableButton', true), btn('laterButton'), btn('neverButton')),
          h('p', { class: 'notice-copy__os', text: 'Состояния' }),
          h('ul', { class: 'notice-copy__states' }, ['subscribedText', 'unsubscribedText', 'unconfirmedText', 'permissionDeniedText', 'pushUnavailableText', 'subscribeErrorText']
            .map((key) => h('li', { dataset: { copyKey: key }, text: t[key] }))),
          h('div', { class: 'notice-copy__actions' }, btn('disableButton'))),
        card('installed', 'Установлено', txt('h3', 'deviceHeading'), txt('p', 'installedText'), txt('p', 'subscribedText', 'notice-copy__note'),
          h('div', { class: 'notice-copy__actions' }, btn('disableButton'), btn('enableButton', true)))));
  }
  function noticeInspector() {
    const api = noticeCopy();
    const section = h('section', { class: 'ins-card notice-inspector' }, h('h2', { text: 'Окна и уведомления' }));
    if (!api) { section.append(h('p', { class: 'hint', text: 'Модуль текстов окон не загружен: правка недоступна.' })); return section; }
    section.append(h('p', { class: 'hint', text: 'Тексты окон установки приложения и уведомлений. Сохраняются автоматически и появляются в приложении при следующем открытии. Пустое поле — пустой текст; «Вернуть стандартный» — снова стандартный текст.' }));
    const stored = api.validate(state.project.notificationTexts);
    const editing = state.mode === 'edit';
    if (!stored.ok) {
      section.append(h('p', { class: 'form-error', role: 'alert', text: `Тексты окон в проекте не прошли проверку (${stored.errors.map((e) => `${e.key || 'объект'}: ${e.message}`).join('; ')}). Правка заблокирована, чтобы не перезаписать чужие данные.` }));
    } else if (!editing) section.append(h('p', { class: 'muted', text: 'Чтобы изменить тексты, включите «Редактировать».' }));
    const t = api.resolve(state.project.notificationTexts);
    const own = stored.ok && stored.value ? stored.value : {};
    for (const [group, title] of NOTICE_GROUPS) {
      section.append(h('h3', { class: 'ins-sub', text: `${title} · до ${api.LIMITS[group]} символов` }));
      for (const key of api.GROUPS[group]) {
        const id = nextId('copy'), limit = api.LIMITS[group], multi = group === 'text' || group === 'step';
        const error = h('p', { class: 'notice-field__error', role: 'alert', dataset: { copyError: key } });
        const count = h('span', { class: 'notice-field__count' });
        const badge = h('span', { class: 'notice-field__badge', dataset: { copyBadge: key } });
        const reset = h('button', { type: 'button', class: 'btn btn--quiet btn--small', text: 'Вернуть стандартный', dataset: { copyReset: key }, disabled: !editing || !stored.ok,
          onclick: () => {
            const next = api.withValue(state.project.notificationTexts, key, undefined);
            if (!next.ok) { error.textContent = next.errors[0].message; return; }
            applyNoticeTexts(next.value); renderInspector();
          } });
        const describe = (value, isOwn) => {
          count.textContent = `${Array.from(value).length} / ${limit}`;
          badge.textContent = !isOwn ? 'стандартный текст' : value === '' ? 'пусто (своё)' : 'свой текст';
          badge.dataset.state = !isOwn ? 'default' : value === '' ? 'empty' : 'own';
          reset.hidden = !isOwn;
        };
        const field = h(multi ? 'textarea' : 'input', { id, ...(multi ? { rows: group === 'text' ? 3 : 2 } : { type: 'text' }), value: t[key], maxlength: String(limit * 2),
          disabled: !editing || !stored.ok, dataset: { copyField: key }, 'aria-describedby': `${id}-meta`,
          oninput: (event) => {
            const value = event.target.value;
            const next = api.withValue(state.project.notificationTexts, key, value);
            if (!next.ok) {
              error.textContent = next.errors.map((e) => e.message).join('; ');
              event.target.setAttribute('aria-invalid', 'true');
              return;   // модель не меняется: недопустимый текст не сохраняется
            }
            error.textContent = ''; event.target.removeAttribute('aria-invalid');
            applyNoticeTexts(next.value);
            describe(value, true);
          } });
        describe(t[key], Object.prototype.hasOwnProperty.call(own, key));
        section.append(h('div', { class: 'ins-field notice-field', dataset: { copyRow: key } },
          h('label', { for: id, text: api.LABELS[key] }), field,
          h('div', { class: 'notice-field__meta', id: `${id}-meta` }, badge, count, reset), error));
      }
    }
    return section;
  }
  // Новое значение текстов окон: null — полей нет (все стандартные); в модели никогда не хранится null.
  function applyNoticeTexts(value) {
    if (value === null) delete state.project.notificationTexts; else state.project.notificationTexts = value;
    renderStage(); changed();
  }

  /* ---------- превью экрана ---------- */
  function renderStage() {
    // Перерисовка (например, при наборе в инспекторе) не сбрасывает прокрутку экрана и схемы.
    const keep = (selector) => { const el = ui.stage.querySelector(selector); return el ? { top: el.scrollTop, left: el.scrollLeft } : null; };
    const body = keep('.app-body'), scheme = keep('.flow-scroll'), journey = keep('.journey-scroll'), stage = { top: ui.stage.scrollTop, left: ui.stage.scrollLeft };
    const sameFrame = ui.stage.dataset.frame === String(state.frameId) && ui.stage.dataset.tab === state.tab &&
      (state.tab !== 'flow' || (ui.stage.dataset.flowRole === state.flowRole && ui.stage.dataset.flowView === state.flowView));
    disposeFreeLayouts();
    window.BoardFlowCanvas?.dispose();
    journeyObserver?.disconnect(); journeyObserver = null;
    const isJourney = state.tab === 'flow' && state.flowView === 'journey';
    ui.stage.replaceChildren(!state.project ? h('p', { class: 'muted pad', text: state.loadError ? 'Нет данных проекта.' : 'Загружаем проект…' })
      : state.tab === 'flow' ? (isJourney ? renderJourney() : renderFlow()) : state.tab === 'notices' ? renderNoticePreview() : renderPreview());
    if (state.project && state.tab === 'screens' && state.journeyReturn) ui.stage.prepend(journeyReturnBar());
    ui.stage.dataset.frame = String(state.frameId); ui.stage.dataset.tab = state.tab; ui.stage.dataset.flowRole = state.flowRole; ui.stage.dataset.flowView = state.flowView;
    if (state.project && state.tab === 'flow' && !isJourney && window.BoardFlowCanvas) {
      window.BoardFlowCanvas.attach({ board: ui.stage.querySelector('.flow'), viewport: ui.stage.querySelector('.flow-scroll'),
        flow: flow(), scope: state.flowRole, mode: state.mode, nodes: [...flow().nodes, menuNode(state.flowRole)], changed, redraw: drawEdges, cancelConnection, h, nextId, ensureEdit: enableCanvasEdit });
    }
    attachFreeLayouts();
    if (sameFrame) {
      const restore = (selector, pos) => { const el = ui.stage.querySelector(selector); if (el && pos) { el.scrollTop = pos.top; el.scrollLeft = pos.left; } };
      restore('.app-body', body); if (!window.BoardFlowCanvas) restore('.flow-scroll', scheme);
      restore('.journey-scroll', journey);
      ui.stage.scrollTop = stage.top; ui.stage.scrollLeft = stage.left;
    }
    if (state.project && isJourney) { drawJourney(); observeJourney(); }
    else if (state.project && state.tab === 'flow') requestAnimationFrame(drawEdges);
  }
  function celebrationIcon(kind) {
    const icon = svg('svg', { class: 'celebration-category__icon', viewBox: '0 0 40 40', width: '40', height: '40', 'aria-hidden': 'true', focusable: 'false' });
    const paths = {
      gift: ['M10 18h20v15H10z','M8 13h24v5H8z','M20 13v20','M20 13c-8 0-10-8-5-8 4 0 5 8 5 8z','M20 13c8 0 10-8 5-8-4 0-5 8-5 8z'],
      heart: ['M20 32S6 23 6 14c0-8 10-10 14-3 4-7 14-5 14 3 0 9-14 18-14 18z'],
      star: ['M20 5l4 10 11 1-8 7 2 11-9-6-9 6 2-11-8-7 11-1z'],
      birthday: ['M10 31h20v-10H10z','M12 21v-6h16v6','M15 15V9m5 6V8m5 7V9','M10 26h20'],
      baby: ['M10 14h19a10 10 0 0 1-10 12h-1a10 10 0 0 1-8-12z','M20 14V7a9 9 0 0 1 9 7','M10 14H7l-3-5','M15 27v3m10-4v4','M13 32h4m6 0h4'],
      event: ['M10 18h20v15H10z','M8 13h24v5H8z','M20 13v20','M20 13c-8 0-10-8-5-8 4 0 5 8 5 8z','M20 13c8 0 10-8 5-8-4 0-5 8-5 8z']
    };
    for (const d of paths[kind] || paths.event) icon.append(svg('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.15', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    return icon;
  }
  function renderPreview() {
    const frame = currentFrame();
    if (!frame) return h('p', { class: 'muted pad', text: 'Выберите экран в списке.' });
    const device = frame.device === 'desktop' ? 'desktop' : 'mobile';
    const tabs = orderTabsOf(frame);
    const blocks = tabs ? orderTabsView(frame, tabs) : blocksOf(frame).map((block) => blockView(frame, block)).filter(Boolean);
    const celebration = frame.presentation === 'celebration';
    if (celebration) {
      for (const block of blocks) {
        const button = block.querySelector('.helpform-toggle') || (block.classList.contains('blk--button') ? block.querySelector('.app-btn') : null);
        if (!button) continue;
        button.classList.add('celebration-cta');
        button.querySelector('.order-toggle__chev')?.remove();
        const leading = svg('svg', { class: 'celebration-cta__icon', viewBox: '0 0 24 24', width: '20', height: '20', 'aria-hidden': 'true', focusable: 'false' });
        const path = button.classList.contains('helpform-toggle') ? 'M12 3l2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4z' : 'M5 8h14l1 13H4z M8 8V6a4 4 0 0 1 8 0v2';
        leading.append(svg('path', { d: path, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        const arrow = svg('svg', { class: 'celebration-cta__arrow order-toggle__chev', viewBox: '0 0 24 24', width: '20', height: '20', 'aria-hidden': 'true', focusable: 'false' });
        arrow.append(svg('path', { d: 'M4 12h16m-6-6 6 6-6 6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        button.prepend(leading); button.append(arrow);
      }
      blocks.unshift(h('p', { class: 'celebration-eyebrow', dataset: { freeId: 'frame:eyebrow' }, text: str(frame.eyebrow ?? 'ЭСТЕТИКА В ДЕТАЛЯХ') }));
      const categories = Array.isArray(frame.categories) ? frame.categories.slice(0, 3) : [];
      if (categories.length) blocks.push(h('div', { class: 'celebration-categories' }, categories.map((item, index) => h('button', {
        type: 'button', class: 'celebration-category', dataset: { freeId: `frame:category:${index}` }, onclick: () => { if (state.mode === 'edit') { state.blockId = null; renderInspector(); } else if (frameById(item.target)) go(item.target); }
      }, celebrationIcon(item.icon || ['gift','heart','star'][index]), h('span', { text: str(item.label) })))));
    }
    // Экран из одной мобильной версии сайта: страница сайта занимает всё тело под неподвижной шапкой приложения.
    const siteOnly = blocks.length === 1 && blocks[0].classList.contains('blk--mobile-site');
    const menu = state.menuOpen ? roleMenu(frame) : null;
    const works = state.works ? worksPanel() : null;
    return h('div', { class: 'stage__inner' },
      h('div', { class: 'stage__caption' },
        h('span', { class: 'chip', text: frame.id }),
        h('span', { class: 'stage__title', text: str(frame.title) || 'Без названия' }),
        h('span', { class: 'muted', text: `${device === 'desktop' ? 'ПК · 900px' : 'Телефон · 390px'}${state.mode === 'edit' ? ' · нажмите на блок, чтобы изменить' : ''}` })),
      h('div', { class: `device device--${device}${celebration ? ' device--celebration' : ''}` },
        h('div', { class: 'app-header' },
          h('button', { type: 'button', class: 'app-burger', 'aria-label': 'Меню', 'aria-expanded': String(state.menuOpen),
            onclick: () => {
              state.menuOpen = !state.menuOpen; state.works = false;
              state.menuRole = state.menuOpen && state.mode === 'edit' ? frame.role : null;
              renderStage(); renderInspector();
              if (state.menuRole) revealMenuInspector();
            } }, h('span'), h('span'), h('span')),
          // «Назад» — справа от меню (меню не сдвигается); шапка вне блоков, поэтому и в редактировании нажатие работает.
          h('button', { type: 'button', class: 'app-back', 'aria-label': 'Назад', title: 'Назад', hidden: !canGoBack(), onclick: goBack }, backIcon()),
          h('span', { class: 'app-title', text: str(state.project.appTitle) })),
        h('div', { class: `app-body${siteOnly ? ' app-body--website' : ''}` }, blocks.length ? freeFrameContent(frame, blocks) : h('p', { class: 'app-empty', text: 'На экране пока нет блоков.' })),
        menu, works));
  }
  function defaultMenuItems(role) {
    const defaults = [...(frameById(MENU_HOME[role]) ? [[MENU_HOME_LABEL[role], MENU_HOME[role]]] : []), ...(MENUS[role] || [])];
    const items = defaults.filter(([, id]) => { const f = frameById(id); return f && !f.hidden && f.role === role && f.menuVisible !== false; });
    for (const f of frames()) if (f.role === role && !f.hidden && f.menuVisible === true && !items.some(([, id]) => id === f.id)) items.push([f.title, f.id]);
    return items.map(([label, id]) => [frameById(id).menuLabel || label, id]).sort((a, b) => {
      const rank = (entry) => Number.isFinite(frameById(entry[1]).menuOrder) ? frameById(entry[1]).menuOrder : items.findIndex(([, id]) => id === entry[1]);
      return rank(a) - rank(b);
    });
  }
  const menuNodeRole = (id) => ROLES.find((role) => `menu:${role.id}` === id)?.id || null;
  function menuNode(role) { return { id: `menu:${role}`, role, kind: 'menu', label: `Меню · ${str(effectiveMenu(role).title) || flowRoleLabel(role)}` }; }
  function effectiveMenu(role) {
    const stored = state.project?.menus && Object.hasOwn(state.project.menus, role) ? state.project.menus[role] : null;
    if (stored && typeof stored === 'object' && !Array.isArray(stored) && Array.isArray(stored.items)) return stored;
    return { id: `menu:${role}`, type: 'menu', title: flowRoleLabel(role), items: defaultMenuItems(role).map(([label, target]) => ({ id: `menu:${role}:${target}`, label, target, hidden: false })) };
  }
  function visibleMenuItems(role) {
    return effectiveMenu(role).items.filter((item) => item && typeof item.id === 'string' && !item.hidden &&
      frameById(item.target)?.role === role && !frameById(item.target).hidden);
  }
  function menuItems(role) { return visibleMenuItems(role).map((item) => [str(item.label), item.target]); }
  function editMenu(role, update, { rebuild = false } = {}) {
    if (state.mode !== 'edit' || !ROLES.some((item) => item.id === role)) return;
    if (!state.project.menus || typeof state.project.menus !== 'object' || Array.isArray(state.project.menus)) state.project.menus = {};
    if (!Object.hasOwn(state.project.menus, role) || !Array.isArray(state.project.menus[role]?.items)) {
      const menu = effectiveMenu(role);
      state.project.menus[role] = JSON.parse(JSON.stringify(menu));
    }
    update(state.project.menus[role]);
    renderStage(); changed(); if (rebuild) renderInspector();
  }
  function revealMenuInspector() {
    if (!panels.right.open) { panels.right.open = true; savePanels(); applyPanels(); }
    if (narrow()) { state.pane = 'inspector'; renderTop(); }
  }
  function selectMenu(role) {
    state.menuRole = role; state.blockId = null;
    if (state.tab === 'flow') { state.nodeId = `menu:${role}`; for (const el of ui.stage.querySelectorAll('.node')) el.classList.toggle('is-selected', el.dataset.node === state.nodeId); }
    renderInspector(); revealMenuInspector();
  }
  function applyMenuStyle(style, el) {
    const s = cleanTextStyle(style);
    if (s.font) el.style.fontFamily = FONT_FAMILY[s.font];
    if (s.size) el.style.fontSize = `${s.size}px`;
    if (typeof s.bold === 'boolean') el.style.fontWeight = s.bold ? '700' : '400';
    if (typeof s.italic === 'boolean') el.style.fontStyle = s.italic ? 'italic' : 'normal';
    if (typeof s.underline === 'boolean') el.style.textDecoration = s.underline ? 'underline' : 'none';
    if (s.align) el.style.textAlign = s.align;
    if (s.color) el.style.color = s.color;
    if (s.lineHeight) el.style.lineHeight = String(s.lineHeight);
    return el;
  }
  const ordersTarget = (target) => frameById(target)?.kind === 'orders';
  function orderNotificationBadge(target) {
    if (!ordersTarget(target)) return null;
    const count = frameById(target)?.role !== 'client' && noticeActive() ? 1 : 0; // Только демонстрация менеджеру из памяти; серверных уведомлений здесь нет.
    return h('span', { class: 'notification-count', dataset: { notificationSource: 'orders.unread' },
      'aria-label': `Уведомлений по заказам: ${count}`, text: String(count) });
  }
  function roleMenu(frame) {
    const role = MENUS[frame.role] ? frame.role : 'client';
    const menu = effectiveMenu(role), items = visibleMenuItems(role);
    return h('div', { class: 'app-menu', role: 'dialog', 'aria-label': 'Меню' },
      h('div', { class: 'app-menu__panel' },
        applyMenuStyle(menu.textStyles?.title, h('p', { class: 'app-menu__role', text: str(menu.title) })),
        state.mode === 'edit' ? h('button', { type: 'button', class: 'btn btn--small', text: 'Редактировать меню', onclick: () => selectMenu(role) }) : null,
        items.map((item) => applyMenuStyle(item.textStyles?.label, h('button', { type: 'button', class: `app-menu__item${item.target === frame.id ? ' is-current' : ''}`, dataset: { menuItem: item.id },
          onclick: () => { if (state.mode === 'edit') selectMenu(role); else { state.menuOpen = false; go(item.target); } } },
          h('span', { class: 'app-menu__label', text: str(item.label) }), orderNotificationBadge(item.target), h('span', { class: 'app-menu__id', text: item.target }))))),
      h('button', { type: 'button', class: 'app-menu__shade', 'aria-label': 'Закрыть меню', onclick: () => { state.menuOpen = false; renderStage(); } }));
  }
  function worksPanel() {
    return h('div', { class: 'app-sheet', role: 'dialog', 'aria-label': 'Наши работы' },
      h('div', { class: 'app-sheet__head' }, h('strong', { text: 'Наши работы' }),
        h('button', { type: 'button', class: 'app-sheet__close', 'aria-label': 'Закрыть', text: '×', onclick: () => { state.works = false; renderStage(); } })),
      h('p', { class: 'app-sheet__note', text: 'Пример раздела в макете: здесь будут фото работ. Отдельного экрана каталога нет.' }),
      h('div', { class: 'app-sheet__grid' }, [1, 2, 3, 4].map((n) => h('div', { class: 'app-sheet__tile' }, h('span', { text: `Работа ${n}` })))));
  }
  function go(target) {
    if (target === '@site') { window.open(SITE_URL, '_blank', 'noopener'); return; }
    if (target === '@works') { state.works = true; state.menuOpen = false; renderStage(); return; }
    if (frameById(target)?.hidden) { toast('Страница убрана. Её можно вернуть в редакторе.'); return; }
    openFrame(target);
  }
  /* Списки заказов (frame.orderTabs = { active, history }, только у кадров с этими метаданными): первые два блока —
     переключатели «Активные»/«История» (подписи из block.label), остальные блоки — список текущей ветки. Список стоит
     сразу под кнопкой своей ветки, кнопка соседней ветки — ниже. Открыта ровно одна ветка — та, что совпадает с
     текущим экраном: нажатие на другую ведёт на её экран обычным go(), на открытую — ничего не закрывает.
     Отдельного состояния нет: открытая ветка = state.frameId. */
  function orderTabsOf(frame) {
    const meta = frame.orderTabs;
    if (!meta || typeof meta !== 'object' || typeof meta.active !== 'string' || typeof meta.history !== 'string') return null;
    if (frame.id !== meta.active && frame.id !== meta.history) return null;
    const blocks = blocksOf(frame);
    const active = blocks.find((b) => b.type === 'button' && b.orderGroup === 'active')
      || blocks.find((b) => b.type === 'button' && b.target === meta.active);
    const history = blocks.find((b) => b.type === 'button' && b.orderGroup === 'history')
      || blocks.find((b) => b.type === 'button' && b.target === meta.history);
    if (!active || !history || active === history) return null;
    // Роль переключателя не зависит от места блока в списке: перетаскивание не превращает карточку в кнопку.
    const branches = [['active', meta.active, active], ['history', meta.history, history]];
    branches.sort((a, b) => blocks.indexOf(a[2]) - blocks.indexOf(b[2]));
    return { branches, rest: blocks.filter((b) => b !== active && b !== history) };
  }
  // Декоративная стрелка: вниз у закрытой ветки, вверх у открытой (поворот в CSS по aria-expanded).
  function chevron() {
    const icon = svg('svg', { class: 'order-toggle__chev', viewBox: '0 0 24 24', width: '20', height: '20', 'aria-hidden': 'true', focusable: 'false' });
    icon.append(svg('path', { d: 'M6 9l6 6 6-6', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    return icon;
  }
  function backIcon() {
    const icon = svg('svg', { viewBox: '0 0 24 24', width: '22', height: '22', 'aria-hidden': 'true', focusable: 'false' });
    icon.append(svg('path', { d: 'M15 5l-7 7 7 7', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    return icon;
  }
  function orderTabsView(frame, tabs) {
    const out = [];
    for (const [key, target, block] of tabs.branches) {
      const open = frame.id === target;
      const groupId = `order-group-${frame.id}-${key}`;
      const toggle = h('button', { type: 'button', class: 'order-toggle', 'aria-expanded': String(open), 'aria-controls': open ? groupId : null,
        onclick: () => { if (isLinkButton(block)) activateButton(block); else if (block.target && block.target !== frame.id) go(block.target); } },
        h('span', { class: 'order-toggle__label', dataset: { textField: 'label' }, text: str(block.label ?? (key === 'active' ? 'Активные' : 'История')) }),
        chevron());
      const view = blockView(frame, block, toggle);
      if (view) out.push(view);
      if (open) {
        const items = tabs.rest.map((item) => blockView(frame, item)).filter(Boolean);
        out.push(h('div', { class: 'order-group', id: groupId, role: 'region', 'aria-label': str(block.label) || key },
          items.length ? items : h('p', { class: 'app-empty', text: 'Здесь пока пусто.' })));
      }
    }
    return out;
  }
  function blockView(frame, block, content = null) {
    const removed = block.review === 'remove';
    const presentationHidden = block.presentationHidden === true;
    if ((removed || presentationHidden) && state.mode === 'view') return null;
    const editing = state.mode === 'edit';
    // Демо-условия показа: в просмотре блок скрыт, в редактировании виден с пояснением (чтобы его можно было править).
    const hiddenWhy = demoHiddenReason(frame, block);
    if (hiddenWhy && !editing) return null;
    const site = mobileSite(block);
    const wrap = h('div', { class: `blk blk--${block.type}${site ? ' blk--mobile-site' : ''}${removed ? ' is-removed' : ''}${presentationHidden ? ' is-presentation-hidden' : ''}${editing && state.blockId === block.id ? ' is-selected' : ''}`, dataset: { block: block.id, freeId: block.id, ...(block.type === 'button' || block.type === 'helpform' && block.collapsible === true ? { freeMin: '44' } : {}) } },
      presentationHidden && editing ? h('p', { class: 'blk__demo-note', text: 'Скрыт в просмотре · блок сохранён' }) : null,
      hiddenWhy ? h('p', { class: 'blk__demo-note', text: hiddenWhy }) : null,
      content || blockContent(frame, block));
    // Нажатия внутри iframe до страницы доски не доходят: в редактировании блок выбирается тонкой полосой сверху
    // (или из списка блоков в инспекторе); в просмотре полосы нет и прокрутку сайта ничего не перекрывает.
    if (editing && site) wrap.prepend(h('button', { type: 'button', class: 'site-frame-edit', text: 'Изменить блок сайта' }));
    if (editing) {
      wrap.prepend(dragHandle(frame, block, 'blk__handle'));
      bindDrop(wrap, frame, block);
      if (block.review && block.review !== 'pending') wrap.prepend(h('span', { class: `blk__badge blk__badge--${block.review}`, text: REVIEW_LABEL[block.review] || block.review }));
      // В редактировании нажатие только выбирает блок: кнопки и ссылки макета не срабатывают.
      // Исключение — кнопка раскрытия формы подбора: она и выбирает блок, и раскрывает форму, чтобы видеть её содержимое.
      wrap.addEventListener('click', (event) => {
        const toggle = event.target && event.target.closest ? event.target.closest('.helpform-toggle') : null;
        if (toggle && wrap.contains(toggle)) { selectBlock(block.id); return; }
        event.preventDefault(); event.stopPropagation(); selectBlock(block.id);
      }, true);
    }
    applyBlockTextStyles(block, wrap);
    return wrap;
  }
  function blockContent(frame, block) {
    switch (block.type) {
      case 'hero':
        return h('div', { class: 'hero' }, h('h1', { class: 'hero__title', dataset: { textField: 'title' }, text: str(block.title) }),
          block.subtitle ? h('p', { class: 'hero__sub', dataset: { textField: 'subtitle' }, text: str(block.subtitle) }) : null);
      case 'button':
        return h('button', { type: 'button', class: `app-btn${!isLinkButton(block) && ordersTarget(block.target) ? ' has-notification-count' : ''}`, dataset: { freeFill: '' }, onclick: () => activateButton(block) },
          h('span', { class: 'app-btn__label', dataset: { textField: 'label' }, text: str(block.label ?? 'Кнопка') }, isLinkButton(block) ? null : orderNotificationBadge(block.target)));
      case 'text':
        return h('div', { class: 'text' }, block.title ? h('h2', { class: 'text__title', dataset: { textField: 'title' }, text: str(block.title) }) : null,
          h('p', { class: 'text__body', dataset: { textField: 'text' }, text: str(block.text) }));
      case 'website': return websiteBlock(block);
      case 'helpform': return helpForm(frame, block);
      case 'form': return customForm(frame, block);
      case 'order': return orderBlock(frame, block);
      case 'chat': return chatBlock(frame, block);
      case 'customer': return customerBlockView(frame, block);
      case 'sales': return salesBlock(frame, block);
      case 'contactnotice': return noticeBlock(frame, block);
      case 'input':
        return customInput(frame, block);
      case 'status':
        return h('div', { class: 'statuses' }, block.title ? h('h2', { class: 'text__title', dataset: { textField: 'title' }, text: str(block.title) }) : null,
          h('div', { class: 'statuses__list' }, (Array.isArray(block.values) ? block.values : []).map((value, index) =>
            h('span', { class: `status${(Array.isArray(block.values) && block.values.includes(block.defaultValue) ? value === block.defaultValue : index === 0) ? ' is-active' : ''}`, dataset: { textField: 'values' }, text: str(value) }))));
      default:
        return h('p', { class: 'app-empty', text: `Блок «${str(block.type)}» не поддерживается доской.` });
    }
  }
  /* Мобильная версия сайта (presentation 'mobile-site'): статический read-only снимок страницы, подготовленный Root, —
     только относительный .html того же адреса доски (без схем javascript:/data:, без чужого origin и выхода через ..).
     sandbox="allow-scripts" — только локальный JS снимка (фильтры); без allow-same-origin/forms/popups/top-navigation. */
  function localSiteSrc(value) {
    const src = str(value).trim();
    if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || /^[\\/]/.test(src) || src.includes('\\') || src.split(/[?#]/)[0].split('/').includes('..')) return '';
    if (!/\.html$/i.test(src.split(/[?#]/)[0])) return '';
    try {
      const url = new URL(src, location.href);
      return url.origin === location.origin && /^https?:$/.test(url.protocol) && /^assets\/catalog-mobile\.html(?:[?][a-zA-Z0-9_=&.-]*)?$/.test(src) ? src : '';
    } catch (_) { return ''; }
  }
  const mobileSite = (block) => block.type === 'website' && block.presentation === 'mobile-site' && Boolean(localSiteSrc(block.src));
  // Скриншот существующего сайта (не живой iframe: макет не отправляет настоящих заявок); сайт — только по явному нажатию.
  function websiteBlock(block) {
    if (mobileSite(block)) {
      return h('iframe', { class: 'site-frame', src: localSiteSrc(block.src), title: 'Каталог Palitra Love — мобильная версия',
        sandbox: 'allow-scripts', referrerpolicy: 'no-referrer' });
    }
    const url = safeUrl(block.url);
    return h('figure', { class: 'site' },
      block.src ? h('img', { class: 'site__img', src: /^assets\/[a-zA-Z0-9_./-]+\.(?:png|jpe?g|webp|gif|svg)$/i.test(str(block.src)) && !str(block.src).includes('..') ? str(block.src) : '', alt: str(block.label) || 'Скриншот сайта', loading: 'lazy' }) : h('div', { class: 'site__none', text: 'Скриншот не указан' }),
      h('figcaption', { class: 'site__bar' }, h('span', { dataset: { textField: 'label' }, text: str(block.label) }),
        url ? h('button', { type: 'button', class: 'app-btn app-btn--small', text: 'Открыть сайт ↗', onclick: () => window.open(url, '_blank', 'noopener') }) : null));
  }
  /* ---------- демо-сценарий клиента (только память страницы) ---------- */
  const isManagerFrame = (frame) => frame.role === 'staff' || frame.role === 'admin';
  const clientNameOf = (block) => demo.clientName || str(block.clientName);
  function demoHiddenReason(frame, block) {
    if (MANAGER_ONLY.has(block.type) && block.manager !== false && !isManagerFrame(frame)) return 'Виден только менеджеру — в просмотре клиента скрыт.';
    if (block.type === 'contactnotice' && demo.clientHasWritten) return 'Скрыто в просмотре: клиент уже написал в чат приложения.';
    if (block.type === 'contactnotice' && !isNoticeDue(block)) return 'Появится после заполнения формы, если клиент не напишет в чат за установленное время.';
    return '';
  }
  // Локальная проверка макета: начало отсчёта — форма, а не открытие чата или автоприветствие.
  const noticeBlocks = () => frames().flatMap((frame) => blocksOf(frame).filter((b) => b.type === 'contactnotice' && b.review !== 'remove').map((b) => ({ frame, block: b })));
  const isNoticeDue = (block) => demo.formSent && !demo.clientHasWritten && Number.isFinite(block.waitMinutes) && block.waitMinutes > 0
    && Number.isFinite(demo.submittedAt) && Date.now() - demo.submittedAt >= block.waitMinutes * 60000;
  const noticeActive = () => noticeBlocks().some(({ block }) => isNoticeDue(block));
  function scheduleNotice() {
    clearTimeout(noticeTimer);
    if (!demo.formSent || demo.clientHasWritten) return;
    const delays = noticeBlocks().map(({ block }) => Number.isFinite(block.waitMinutes) && block.waitMinutes > 0
      ? demo.submittedAt + block.waitMinutes * 60000 - Date.now() : 0).filter((value) => value > 0);
    if (delays.length) noticeTimer = setTimeout(() => {
      // Не заменяем форму, пока человек вводит текст. При переходе экран покажет актуальное состояние.
      if (state.mode === 'view' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) renderStage();
      scheduleNotice();
    }, Math.min(...delays) + 20);
  }
  // Заказы уведомления — номера заказов на тех же экранах, где стоит «Нужно связаться».
  function noticeOrderNumbers() {
    const numbers = new Set();
    for (const { frame } of noticeBlocks()) for (const b of blocksOf(frame)) if (b.type === 'order' && b.orderNumber) numbers.add(str(b.orderNumber));
    return numbers;
  }
  // Данные клиента: после формы подбора — из памяти страницы, иначе — шаблон блока «Клиент» (без реальных контактов).
  function customerInfo(frame, block) {
    const base = block || blocksOf(frame).find((b) => b.type === 'customer')
      || frames().flatMap((f) => blocksOf(f)).find((b) => b.type === 'customer') || {};
    const channel = channelById(demo.formSent ? demo.preferredChannel : str(base.preferredChannel)) || CHANNELS[0];
    return { name: demo.clientName || str(base.clientName), channel, contact: demo.formSent ? demo.contact : str(base.contact), target: str(base.target) };
  }
  /* Ссылка связи только из распознанного контакта и только на известные адреса; иначе null (кнопка недоступна).
     Telegram: @ник → t.me/ник, телефон → t.me/+цифры; WhatsApp → wa.me/цифры; звонок → tel:+цифры; ВКонтакте — только
     vk.com/…; у MAX надёжной ссылки нет — только копирование контакта. Текст сообщения в ссылку не подставляется. */
  function contactLink(channelId, raw) {
    const value = str(raw).trim();
    if (!value) return null;
    let phone = /^\+?[\d\s()-]{7,22}$/.test(value) ? value.replace(/\D/g, '') : '';
    if (phone.length === 11 && phone[0] === '8') phone = `7${phone.slice(1)}`;
    const phoneOk = phone.length >= 10 && phone.length <= 15;
    if (channelId === 'telegram') {
      const nick = /^(?:@|(?:https:\/\/)?t\.me\/)?([a-zA-Z][a-zA-Z0-9_]{4,31})\/?$/.exec(value);
      if (nick && !phoneOk) return `https://t.me/${nick[1]}`;
      return phoneOk ? `https://t.me/+${phone}` : null;
    }
    if (channelId === 'whatsapp') return phoneOk ? `https://wa.me/${phone}` : null;
    if (channelId === 'call') return phoneOk ? `tel:+${phone}` : null;
    if (channelId === 'vk') {
      const vk = /^(?:(?:https:\/\/)?(?:www\.|m\.)?vk\.com\/)?([a-zA-Z][a-zA-Z0-9_.]{1,63})\/?$/.exec(value);
      return vk ? `https://vk.com/${vk[1]}` : null;
    }
    return null;
  }
  function channelIcon(id) {
    const icon = svg('svg', { class: 'ch-icon', viewBox: '0 0 24 24', width: '18', height: '18', 'aria-hidden': 'true', focusable: 'false' });
    const line = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    if (id === 'telegram') icon.append(svg('path', { d: 'M21 4.5L3 11.4l6 2.3 2.2 6 3.3-4.1 5 3.6zM9 13.7l12-9.2', ...line }));
    else if (id === 'whatsapp') icon.append(svg('path', { d: 'M4 20l1.4-4A8.5 8.5 0 1 1 8.4 18.7zM9 9.2c.3 2.6 2.4 4.9 5.6 5.8l1.2-1.4-1.9-1-.8.8c-1-.4-2-1.4-2.4-2.4l.8-.8-1-1.9z', ...line }));
    else if (id === 'call') icon.append(svg('path', { d: 'M6.5 3.5h3l1.5 4-2 1.3a11 11 0 0 0 6.2 6.2l1.3-2 4 1.5v3a2 2 0 0 1-2.2 2A16 16 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z', ...line }));
    else if (id === 'app') icon.append(svg('path', { d: 'M4 5.5h16v10H9l-5 4z', ...line }));
    else {
      icon.append(svg('rect', { x: '2.5', y: '4.5', width: '19', height: '15', rx: '4', ...line }));
      const text = svg('text', { x: '12', y: '15.2', 'text-anchor': 'middle', 'font-size': id === 'vk' ? '8.5' : '7', 'font-weight': '700', fill: 'currentColor' });
      text.textContent = id === 'vk' ? 'VK' : 'MAX';
      icon.append(text);
    }
    return icon;
  }
  // Копирование — только по явному нажатию; при отказе браузера успех не заявляется.
  function copyContact(text) {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') { toast('Копирование недоступно — выделите контакт вручную.'); return; }
    navigator.clipboard.writeText(text).then(() => toast('Контакт скопирован'), () => toast('Не удалось скопировать — выделите контакт вручную.'));
  }
  /* Кнопка «Связаться · канал»: открывает ссылку только по нажатию (https — новое окно с noopener, звонок — tel:).
     Нажатие не отмечает, что связь состоялась: исход внешнего разговора доска не знает. */
  function contactAction(info) {
    const editing = state.mode === 'edit';
    const ch = info.channel, contact = str(info.contact).trim();
    const kids = () => [channelIcon(ch.id), h('span', { text: `Связаться · ${ch.short}` })];
    const box = h('div', { class: 'contact' });
    if (!contact) {
      box.append(h('button', { type: 'button', class: 'app-btn app-btn--ghost contact__btn', disabled: true }, kids()),
        h('p', { class: 'contact__hint', text: 'Контакт появится после заполнения формы' }));
      return box;
    }
    box.append(h('p', { class: 'contact__value' }, h('span', { class: 'muted', text: `${ch.label}: ` }), h('span', { class: 'contact__raw', text: contact })));
    const href = contactLink(ch.id, contact);
    if (ch.id === 'max') {
      box.append(h('button', { type: 'button', class: 'app-btn app-btn--ghost contact__btn', disabled: editing, onclick: () => copyContact(contact) }, kids()),
        h('p', { class: 'contact__hint', text: 'Надёжной ссылки MAX нет: кнопка копирует контакт для ручной связи.' }));
    } else if (href) {
      const external = href.startsWith('https://');
      box.append(h('a', { class: 'app-btn app-btn--ghost contact__btn', href, target: external ? '_blank' : null, rel: external ? 'noopener noreferrer' : null }, kids()),
        h('button', { type: 'button', class: 'contact__copy', disabled: editing, text: 'Скопировать контакт', onclick: () => copyContact(contact) }));
    } else {
      box.append(h('button', { type: 'button', class: 'app-btn app-btn--ghost contact__btn', disabled: true }, kids()),
        h('p', { class: 'contact__hint', text: 'Контакт не распознан для ссылки — свяжитесь вручную.' }),
        h('button', { type: 'button', class: 'contact__copy', disabled: editing, text: 'Скопировать контакт', onclick: () => copyContact(contact) }));
    }
    return box;
  }
  const workChannelLabel = (info) => (demo.workChannel !== 'app' && demo.workChannel === info.channel.id ? info.channel.label : 'Чат приложения');
  // Карточка заказа: имя клиента сверху, заголовок под ним; в карточке экрана заказа — номер, выбранный в списке.
  function orderBlock(frame, block) {
    const own = str(block.orderNumber), sel = demo.selected;
    const swap = frame.kind === 'detail' && sel && own && sel.number !== own;
    const title = !swap ? str(block.title) : str(block.title).includes(`№${own}`) ? str(block.title).split(`№${own}`).join(`№${sel.number}`) : `${str(block.title)} · №${sel.number}`;
    const status = swap && sel.status ? sel.status : str(block.status);
    const number = swap ? sel.number : own;
    const name = clientNameOf(block);
    const badge = isManagerFrame(frame) && number && noticeActive() && noticeOrderNumbers().has(own);
    return h('button', { type: 'button', class: 'order', onclick: () => { if (number) demo.selected = { number, status }; go(block.target); } },
      name ? h('span', { class: 'order__client', dataset: { textField: 'clientName' }, text: name }) : null,
      h('span', { class: 'order__head' }, h('strong', { dataset: { textField: 'title' }, text: title }),
        status ? h('span', { class: 'order__status', dataset: { textField: 'status' }, text: status }) : null),
      badge ? h('span', { class: 'order__badge', text: 'Связаться с клиентом' }) : null,
      block.details ? h('span', { class: 'order__details', dataset: { textField: 'details' }, text: str(block.details) }) : null,
      h('span', { class: 'order__more', text: 'Открыть →' }));
  }
  /* Чат: шапка с именем клиента и кнопкой «Заказ №…» (переход блока); история проекта + локальные сообщения этой
     страницы. Отправитель — по роли текущего экрана (клиент / менеджер). Заметки о внешней связи видит только менеджер.
     В редактировании поле и «Отправить» недоступны: там нажатие выбирает блок. */
  function chatBlock(frame, block) {
    const editing = state.mode === 'edit', manager = isManagerFrame(frame);
    const key = `${frame.id}:${block.id}`;
    const messages = Array.isArray(block.messages) ? block.messages : [];
    const name = clientNameOf(block);
    const number = (demo.selected && demo.selected.number) || str(block.orderNumber);
    const title = block.title ? h(name ? 'span' : 'h2', { class: name ? 'chat__title' : 'text__title', dataset: { textField: 'title' }, text: str(block.title) }) : null;
    const head = name || (number && block.target)
      ? h('div', { class: 'chat__head' },
        h('div', { class: 'chat__who' }, name ? h('strong', { class: 'chat__client', dataset: { textField: 'clientName' }, text: name }) : null, title),
        number && block.target ? h('button', { type: 'button', class: 'chat__order', onclick: () => go(block.target) }, `Заказ №${number}`) : null)
      : title;
    const who = (from) => (from === 'client' ? demo.clientName || 'Клиент' : 'Менеджер');
    // Одна лента по времени: разделители, сообщения, автоответ и (только у менеджера) заметки о внешней связи.
    const localItems = demo.messages.map((m) => {
      if (m.kind === 'note') return manager ? h('p', { class: 'chat__note', text: `Заметка менеджера · ${m.channel}: ${m.text}` }) : null;
      if (m.kind === 'divider') return h('p', { class: 'chat__divider chat__divider--local', dataset: { textField: 'messages' }, text: m.text });
      return h('p', { class: `chat__msg is-${m.from}${m.auto ? ' is-auto' : ''}`, dataset: { textField: 'messages' } },
        m.auto ? h('span', { class: 'chat__auto', text: 'Автоответ' }) : null, `${who(m.from)}: ${m.text}`);
    });
    const input = h('input', { class: 'app-input', type: 'text', dataset: { textField: 'placeholder' }, placeholder: str(block.placeholder), value: local.chat.get(key) || '',
      readOnly: editing, 'aria-label': manager ? 'Ответ клиенту (макет)' : 'Сообщение (макет)', autocomplete: 'off', oninput: (event) => { local.chat.set(key, event.target.value); } });
    const compose = h('form', { class: 'chat__compose', novalidate: true, onsubmit: (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (editing || !text) return;
      demo.messages.push({ kind: 'message', from: manager ? 'manager' : 'client', text });
      if (!manager) demo.clientHasWritten = true;
      local.chat.set(key, '');
      renderStage();
      const next = ui.stage.querySelector(`.blk[data-block="${CSS.escape(String(block.id))}"] .chat__compose input`);
      if (next) { next.focus(); next.scrollIntoView({ block: 'nearest' }); }
    } }, input, h('button', { type: 'submit', class: 'app-btn app-btn--small', text: 'Отправить', disabled: editing }));
    return h('div', { class: 'chat' }, head,
      h('div', { class: 'chat__list' }, messages.map((m) => (m && m.kind === 'divider'
        ? h('p', { class: 'chat__divider', dataset: { textField: 'messages' }, text: str(m.text) })
        : h('p', { class: 'chat__msg', dataset: { textField: 'messages' }, text: str(m && m.text) }))), localItems),
      compose,
      h('p', { class: 'chat__demo', text: 'Макет: сообщения остаются только на этой странице и никуда не отправляются.' }));
  }
  /* Клиент: на экране клиента — только имя. У менеджера — канал, «Вернуться в чат приложения» (главный путь),
     «Связаться · канал», выбор «Общаемся», результат общения (заметка) — всё в памяти страницы. */
  function customerBlockView(frame, block) {
    const editing = state.mode === 'edit';
    const info = customerInfo(frame, block);
    const out = h('div', { class: 'customer' },
      block.title ? h('p', { class: 'customer__title', dataset: { textField: 'title' }, text: str(block.title) }) : null,
      h('p', { class: 'customer__name', dataset: { textField: 'clientName' }, text: info.name || 'Имя появится после заполнения формы' }));
    if (!isManagerFrame(frame)) return out;
    if (demo.workChannel !== 'app' && demo.workChannel !== info.channel.id) demo.workChannel = 'app';
    const workId = nextId('cu'), noteId = nextId('cu');
    const note = h('textarea', { id: noteId, class: 'app-input', rows: '2', value: local.note, disabled: editing, placeholder: 'Например: договорились созвониться вечером',
      oninput: (event) => { local.note = event.target.value; } });
    out.append(
      h('p', { class: 'customer__row' }, h('span', { class: 'muted', text: 'Предпочтительный канал: ' }), channelIcon(info.channel.id), h('strong', { text: info.channel.label })),
      info.target ? h('button', { type: 'button', class: 'app-btn customer__chat', onclick: () => go(info.target) }, channelIcon('app'), h('span', { text: 'Вернуться в чат приложения' })) : null,
      contactAction(info),
      h('label', { class: 'field', for: workId }, h('span', { class: 'field__label', text: 'Общаемся' })),
      h('select', { id: workId, class: 'app-input', disabled: editing, onchange: (event) => { demo.workChannel = event.target.value; renderStage(); } },
        h('option', { value: 'app', selected: demo.workChannel === 'app', text: 'Чат приложения' }),
        h('option', { value: info.channel.id, selected: demo.workChannel === info.channel.id, text: info.channel.label })),
      h('label', { class: 'field', for: noteId }, h('span', { class: 'field__label', text: 'Результат общения' })),
      note,
      h('button', { type: 'button', class: 'app-btn app-btn--small app-btn--ghost customer__save', text: 'Сохранить заметку', disabled: editing, onclick: () => {
        const text = local.note.trim();
        if (!text) { toast('Напишите результат общения.'); return; }
        const entry = { channel: workChannelLabel(info), text };
        demo.notes.push(entry);
        demo.messages.push({ kind: 'note', ...entry });
        local.note = '';
        renderStage();
        toast('Заметка сохранена на этой странице (в макете, без сервера).');
      } }),
      demo.notes.length ? h('ul', { class: 'customer__notes' }, demo.notes.map((n) => h('li', {}, h('span', { class: 'customer__note-ch', text: n.channel }), h('span', { text: n.text })))) : null);
    return out;
  }
  // Этапы продаж (не статусы выполнения заказа): id/подпись/подсказка, только корректные и без повторов id.
  function salesStages(block) {
    const seen = new Set();
    return (Array.isArray(block.stages) ? block.stages : []).filter((s) => s && typeof s.id === 'string' && s.id && !seen.has(s.id) && seen.add(s.id))
      .map((s) => ({ id: s.id, label: str(s.label) || s.id, hint: str(s.hint) }));
  }
  function salesBlock(frame, block) {
    const editing = state.mode === 'edit';
    const stages = salesStages(block);
    const title = block.title ? h('h2', { class: 'text__title', dataset: { textField: 'title' }, text: str(block.title) }) : null;
    if (!stages.length) return h('div', { class: 'sales' }, title, h('p', { class: 'app-empty', text: 'Этапы не заданы.' }));
    const current = stages.find((s) => s.id === demo.stage) || stages.find((s) => s.id === block.defaultStage) || stages[0];
    const index = stages.indexOf(current);
    const selectId = nextId('sales');
    return h('div', { class: 'sales' }, title,
      h('ol', { class: 'sales__chips', 'aria-label': 'Этапы продаж' }, stages.map((s, i) => h('li', {
        class: `sales__chip${i < index ? ' is-done' : ''}${i === index ? ' is-current' : ''}`, 'aria-current': i === index ? 'step' : null, text: s.label }))),
      h('label', { class: 'field', for: selectId }, h('span', { class: 'field__label', text: 'Текущий этап' })),
      h('select', { id: selectId, class: 'app-input', disabled: editing, onchange: (event) => {
        demo.stage = event.target.value;
        demo.stageSource = workChannelLabel(customerInfo(frame, null));
        renderStage();
        ui.stage.querySelector(`.blk[data-block="${CSS.escape(String(block.id))}"] select`)?.focus();
      } }, stages.map((s) => h('option', { value: s.id, selected: s === current, text: s.label }))),
      current.hint ? h('p', { class: 'sales__hint' }, h('strong', { text: 'Что сделать: ' }), current.hint) : null,
      h('p', { class: 'sales__source', text: demo.stageSource ? `Этап изменён вручную · общались: ${demo.stageSource}` : 'Этап меняется вручную; статусы выполнения заказа — отдельно.' }));
  }
  function noticeBlock(frame, block) {
    const info = customerInfo(frame, null);
    const wait = Number.isFinite(block.waitMinutes) && block.waitMinutes > 0
      ? `Через ${block.waitMinutes} мин после формы, если клиент не напишет в чат. Здесь проверяется только макет.`
      : 'Ожидание отключено, пока не задано число минут.';
    return h('div', { class: 'notice', role: 'note' },
      h('span', { class: 'notice__badge', text: 'Связаться с клиентом' }),
      block.title ? h('h2', { class: 'text__title', dataset: { textField: 'title' }, text: str(block.title) }) : null,
      block.text ? h('p', { class: 'notice__text', dataset: { textField: 'text' }, text: str(block.text) }) : null,
      info.name ? h('p', { class: 'notice__client' }, h('span', { class: 'muted', text: 'Клиент: ' }), h('strong', { text: info.name })) : null,
      h('ol', { class: 'notice__path', 'aria-label': 'Порядок действий' },
        ['Чат приложения', 'Нет ответа', `Связаться · ${info.channel.short}`, 'Этап и заметка'].map((step) => h('li', { text: step }))),
      contactAction(info),
      h('p', { class: 'notice__wait', text: wait }));
  }
  /* Форма подбора: имя и контакт только в памяти страницы; ничего не отправляется и не сохраняется в проект. */
  function helpForm(frame, block) {
    const key = `${frame.id}:${block.id}`;
    if (!local.help.has(key)) local.help.set(key, { name: '', channel: 'telegram', contact: '', state: '', message: '' });
    const v = local.help.get(key);
    if (!v.extra) v.extra = {};
    const ids = { name: `${key}-name`, channel: `${key}-channel`, contact: `${key}-contact` };
    const phoneOnly = block.phoneOnly === true;
    const hiddenParts = new Set((Array.isArray(block.hiddenParts) ? block.hiddenParts : []).filter((part) => ['name', 'channel', 'contact', 'hint'].includes(part)));
    const showPart = (part) => !hiddenParts.has(part) && !(phoneOnly && ['channel', 'hint'].includes(part));
    const allowed = window.BoardFormBuilder?.enabledChannels(block, CHANNELS) || (!showPart('channel') ? [channelById('call')] : CHANNELS);
    if (!allowed.some((c) => c.id === v.channel)) v.channel = allowed[0].id;
    const channel = () => allowed.find((c) => c.id === v.channel) || allowed[0];
    const contactPlaceholder = () => str(block.contactPlaceholder ?? block.contactPlaceholders?.[v.channel] ?? channel().placeholder);
    const contact = h('input', { id: ids.contact, class: 'app-input', type: channel().type, dataset: { textField: 'contactPlaceholder', freeId: 'contactInput' }, placeholder: contactPlaceholder(), value: v.contact,
      autocomplete: 'off', oninput: (event) => { v.contact = event.target.value; } });
    const status = h('p', { class: `form-status${v.state ? ` is-${v.state}` : ''}`, role: 'status', text: v.message });
    const after = h('div', { class: 'form-after' });
    const showAfter = () => {
      after.replaceChildren();
      if (v.state === 'ok' && frameById('K07')) after.append(h('button', { type: 'button', class: 'app-btn app-btn--ghost', text: 'Открыть чат заявки', onclick: () => openFrame('K07') }));
    };
    showAfter();
    const partOrder = window.BoardFormBuilder?.partOrder?.(block) || [...new Set([...(Array.isArray(block.partOrder) ? block.partOrder.filter((part) => ['name', 'channel', 'contact', 'hint'].includes(part)) : []), 'name', 'channel', 'contact', 'hint'])];
    const partNodes = {
      name: [
        showPart('name') ? h('label', { class: 'field', for: ids.name, dataset: { freeId: 'nameLabel' } }, h('span', { class: 'field__label', dataset: { textField: 'nameLabel' }, text: str(block.nameLabel ?? 'Имя') })) : null,
        showPart('name') ? h('input', { id: ids.name, class: 'app-input', type: 'text', autocomplete: 'off', dataset: { textField: 'namePlaceholder', freeId: 'nameInput' }, placeholder: str(block.namePlaceholder), value: v.name, oninput: (event) => { v.name = event.target.value; } }) : null,
      ],
      channel: [
        showPart('channel') ? h('label', { class: 'field', for: ids.channel, dataset: { freeId: 'channelLabel' } }, h('span', { class: 'field__label', dataset: { textField: 'messengerLabel' }, text: str(block.messengerLabel ?? 'Канал связи') })) : null,
        !showPart('channel') ? null : h('select', { id: ids.channel, class: 'app-input', dataset: { freeId: 'channelInput' }, onchange: (event) => {
          v.channel = event.target.value; const c = channel(); contact.type = c.type; contact.placeholder = contactPlaceholder();
        } }, allowed.map((c) => h('option', { value: c.id, selected: c.id === v.channel, text: c.label }))),
      ],
      contact: [
        showPart('contact') ? h('label', { class: 'field', for: ids.contact, dataset: { freeId: 'contactLabel' } }, h('span', { class: 'field__label', dataset: { textField: 'contactLabel' }, text: str(block.contactLabel ?? (phoneOnly ? 'Номер телефона' : 'Контакт')) })) : null,
        showPart('contact') ? contact : null,
      ],
      hint: !showPart('hint') ? null : h('p', { class: 'helpform__hint', dataset: { textField: 'hint', freeId: 'hint' }, text: block.hint == null ? 'Продолжим в чате. Контакт пригодится, если не сможем связаться здесь.' : str(block.hint) }),
    };
    const extrasNode = window.BoardFormBuilder?.render({ block, h, values: v.extra, nextId, editing: state.mode === 'edit' }) || null;
    const form = h('form', { class: 'helpform', novalidate: true, onsubmit: (event) => {
      event.preventDefault();
      if (state.mode === 'edit') return;   // в редактировании форма не «отправляется» (живой сценарий — в просмотре)
      const extraError = window.BoardFormBuilder?.validate(block, v.extra);
      if (showPart('name') && block.nameRequired !== false && !v.name.trim() || showPart('contact') && block.contactRequired !== false && !v.contact.trim()) { v.state = 'error'; v.message = 'Заполните имя и контакт.'; }
      else if (extraError) { v.state = 'error'; v.message = extraError; }
      else {
        // Только память страницы (демо): имя, канал и контакт; в проект и на сервер не пишется. Повторная отправка
        // тех же данных не дублирует отметку. Автоответа от самой заявки нет (в приложении он приходит только после первого
        // сообщения клиента в чате). Клиент ещё не писал в чат — менеджер видит «Нужно связаться».
        const name = v.name.trim(), contactValue = v.contact.trim();
        const same = demo.formSent && demo.clientName === name && demo.contact === contactValue && demo.preferredChannel === v.channel;
        Object.assign(demo, { clientName: name, contact: contactValue, preferredChannel: v.channel, formSent: true, workChannel: 'app' });
        if (!same) {
          demo.clientHasWritten = false; demo.submittedAt = Date.now();
          demo.messages.push({ kind: 'divider', text: 'Новый запрос на подбор' });
        }
        v.state = 'ok'; v.message = 'Макет: запрос сохранён только на этой странице. Реальная заявка не отправляется, автоответа от формы нет.';
        scheduleNotice();
      }
      status.textContent = v.message; status.className = `form-status is-${v.state}`; showAfter();
      if (v.state === 'ok' && block.target) go(block.target);
    } },
      block.title ? h('h2', { class: 'text__title', dataset: { textField: 'title', freeId: 'title' }, text: str(block.title) }) : null,
      block.subtitle ? h('p', { class: 'helpform__sub', dataset: { textField: 'subtitle', freeId: 'subtitle' }, text: str(block.subtitle) }) : null,
      // Дополнительные поля стоят прямо перед пояснением, как в прежней форме: порядок по умолчанию даёт прежний вид.
      partOrder.flatMap((part) => part === 'hint' && partNodes.hint ? [extrasNode, partNodes.hint] : [partNodes[part]]),
      partNodes.hint ? null : extrasNode,
      // Согласие есть в боевой форме приложения; в свободном режиме показываем его как объект, чтобы его можно было разместить.
      freeEnabled(block) ? h('label', { class: 'helpform-consent', dataset: { freeId: 'consent' } },
        h('input', { type: 'checkbox', tabindex: '-1', 'aria-label': CONSENT_TEXT }), h('span', { text: CONSENT_TEXT })) : null,
      h('button', { type: 'submit', class: 'app-btn', dataset: { freeId: 'submit', freeMin: '44' } }, h('span', { class: 'app-btn__label', dataset: { textField: 'submitLabel' }, text: str(block.submitLabel ?? 'Отправить') })),
      status, after);
    const extras = form.querySelector('.form-fields'); if (extras) extras.dataset.freeId = 'extras';
    if (freeEnabled(block)) {
      const nodes = [...form.children].filter((node) => node.dataset.freeId);
      if (nodes.length) { const scene = freeScene([], 'block', block.id); form.insertBefore(scene, nodes[0]); for (const node of nodes) scene.append(node); }
    }
    if (block.collapsible !== true) return form;
    /* Сворачиваемая форма (helpform.collapsible): сверху кнопка раскрытия, под ней та же форма. Открыто/закрыто — только
       память страницы (по умолчанию закрыто), в проект не пишется; форма при переключении не пересоздаётся, поэтому
       введённые имя и контакт остаются. */
    const panelId = `${key}-panel`;
    const panel = h('div', { class: 'helpform-panel', id: panelId, hidden: !v.expanded }, form);
    // В свободном размещении рамка блока = кнопка раскрытия (data-free-fill): её размер меняют ручки, раскрытая форма — ниже.
    const toggle = h('button', { type: 'button', class: 'app-btn helpform-toggle', 'aria-expanded': String(Boolean(v.expanded)), 'aria-controls': panelId, dataset: { freeFill: '', freePart: 'toggle' },
      onclick: () => {
        v.expanded = !v.expanded;
        panel.hidden = !v.expanded;
        toggle.setAttribute('aria-expanded', String(v.expanded));
      } },
      h('span', { class: 'helpform-toggle__label', dataset: { textField: 'toggleLabel' }, text: str(block.toggleLabel ?? 'Подобрать индивидуально') }), chevron());
    return h('div', { class: 'helpform-wrap', dataset: { freeFill: '' } }, toggle, panel);
  }

  function customInput(frame, block) {
    const key = `${frame.id}:${block.id}`;
    if (!local.inputs.has(key)) local.inputs.set(key, {});
    const content = window.BoardFormBuilder?.render({ block: { type: 'form', fields: [{ id: 'value', type: block.inputType || 'text', label: block.label,
      placeholder: block.placeholder, required: block.required === true, options: block.options }] }, h, values: local.inputs.get(key), nextId, editing: state.mode === 'edit' });
    if (!content) return h('input', { class: 'app-input', type: 'text', placeholder: str(block.placeholder) });
    const label = content.querySelector('[data-text-field]'); if (label) label.dataset.textField = 'label';
    const control = content.querySelector('input,textarea,select'); if (control) control.dataset.textField = 'placeholder';
    return content;
  }
  function customForm(frame, block) {
    const key = `${frame.id}:${block.id}`;
    if (!local.help.has(key)) local.help.set(key, { extra: {}, state: '', message: '' });
    const v = local.help.get(key); if (!v.extra) v.extra = {};
    const status = h('p', { class: 'form-status', role: 'status', text: v.message });
    return h('form', { class: 'helpform custom-form', novalidate: true, onsubmit: (event) => {
      event.preventDefault(); if (state.mode === 'edit') return;
      const error = window.BoardFormBuilder?.validate(block, v.extra) || '';
      v.message = error || 'Форма заполнена. Это проверка макета.'; v.state = error ? 'error' : 'ok';
      status.textContent = v.message; status.className = `form-status is-${v.state}`;
      if (!error && block.target) go(block.target);
    } }, block.title ? h('h2', { class: 'text__title', dataset: { textField: 'title' }, text: str(block.title) }) : null,
      block.subtitle ? h('p', { dataset: { textField: 'subtitle' }, text: str(block.subtitle) }) : null,
      window.BoardFormBuilder?.render({ block, h, values: v.extra, nextId, editing: state.mode === 'edit' }),
      h('button', { type: 'submit', class: 'app-btn' }, h('span', { class: 'app-btn__label', dataset: { textField: 'submitLabel' }, text: str(block.submitLabel) })), status);
  }

  /* ---------- блок-схема ---------- */
  function enableCanvasEdit() { if (state.mode !== 'edit') { state.mode = 'edit'; renderAll(); } }
  const flowRoleLabel = (role) => role === 'client' ? 'Пользователь' : ROLES.find((item) => item.id === role)?.label || role;
  const nodeRole = (node) => frameById(node?.frame)?.role || node?.role;
  function switchFlowRole(role, { nodeId = null } = {}) {
    if (!ROLES.some((item) => item.id === role)) return;
    const pending = state.connection;
    state.flowRole = role; state.tab = 'flow'; state.flowView = 'screens'; state.blockId = null; state.menuRole = menuNodeRole(nodeId); state.newNode = null; jCancel(false);
    const selected = nodeById(nodeId) || flow().nodes.find((node) => nodeRole(node) === role && frameById(node.frame) && !frameById(node.frame).hidden);
    state.nodeId = selected?.id || null;
    if (selected?.frame) {
      state.frameId = selected.frame;
      if (frameById(selected.frame)?.device === 'desktop') state.showDesktop = true;
    }
    renderAll({ keepConnection: Boolean(pending) });
    if (pending) for (const el of ui.stage.querySelectorAll('.node.has-frame')) if (el.dataset.frame !== pending.frameId) el.classList.add('is-connect-target');
  }
  function roleFlowNodes() {
    const candidates = flow().nodes.filter((node) => state.showDesktop || frameById(node.frame)?.device !== 'desktop');
    const selected = new Set(candidates.filter((node) => nodeRole(node) === state.flowRole).map((node) => node.id));
    const shared = new Set(candidates.filter((node) => !ROLES.some((role) => role.id === nodeRole(node))).map((node) => node.id));
    for (const node of candidates) if (shared.has(node.id) && node.flowScope === state.flowRole) selected.add(node.id);
    // Общие шаги и источники выводятся только рядом с той ролью, к которой они ведут.
    let added = true;
    while (added) {
      added = false;
      for (const edge of flow().edges) {
        if (edge.blockId && (findBlock(edge.blockId)?.block.review === 'remove' || isLinkButton(findBlock(edge.blockId)?.block))) continue;
        for (const [from, to] of [[edge.from, edge.to], [edge.to, edge.from]]) if (selected.has(from) && shared.has(to) && !selected.has(to)) { selected.add(to); added = true; }
      }
    }
    return [...candidates.filter((node) => selected.has(node.id)), menuNode(state.flowRole)];
  }
  function renderFlow() {
    const f = flow();
    const visibleNodes = roleFlowNodes();
    const byRole = (role) => visibleNodes.filter((node) => nodeRole(node) === role);
    const known = new Set(['source', 'client', 'staff', 'admin']);
    const common = visibleNodes.filter((node) => !known.has(nodeRole(node)));
    const box = (node) => {
      const frame = node.frame ? frameById(node.frame) : null;
      const actions = frame ? routeBlocks(frame) : [];
      return h('div', { class: `node node--${known.has(node.role) ? node.role : 'common'}${state.nodeId === node.id ? ' is-selected' : ''}${frame ? ' has-frame' : ''}${node.kind === 'condition' ? ' node--condition' : ''}`,
        dataset: { node: node.id, frame: frame ? frame.id : '', ...(node.kind === 'menu' ? { menuRole: node.role } : {}) }, onclick: (event) => {
          if (event.target.closest('button')) return;
          if (state.connection) finishConnection(node.id); else clickNode(node);
        } },
        frame ? h('button', { type: 'button', class: 'node-inlet node-inlet--left', dataset: { inletSide: 'left' }, 'aria-label': `Связать с экраном ${frame.id} слева`, title: 'Сюда ведёт переход',
          onclick: () => { if (state.connection) finishConnection(node.id); else clickNode(node); } }, '○') : null,
        frame ? h('button', { type: 'button', class: 'node-inlet node-inlet--right', dataset: { inletSide: 'right' }, 'aria-label': `Связать с экраном ${frame.id} справа`, title: 'Сюда ведёт переход',
          onclick: () => { if (state.connection) finishConnection(node.id); else clickNode(node); } }, '○') : null,
        h('button', { type: 'button', class: 'node__open', onclick: () => { if (state.connection) finishConnection(node.id); else clickNode(node); } },
        node.kind === 'condition' ? h('span', { class: 'node__kind', text: 'Условие' }) : null,
        h('span', { class: 'node__label', text: nodeLabel(node) || node.id }),
        h('span', { class: 'node__meta', text: frame ? frame.id : node.frame ? `${node.frame} (нет экрана)` : '' }),
        node.review && node.review !== 'pending' ? h('span', { class: `node__review node__review--${node.review}`, text: REVIEW_LABEL[node.review] || node.review }) : null),
        node.kind === 'menu' ? h('div', { class: 'node-actions' }, effectiveMenu(node.role).items.filter((item) => item && typeof item.id === 'string').map((item) => menuRouteRow(node, item)))
        : frame ? h('div', { class: 'node-actions' }, actions.length ? actions.map((block) => routeRow(node, frame, block))
          : h('p', { class: 'node-actions__empty', text: 'На странице пока нет кнопок перехода' })) : null);
    };
    const board = h('div', { class: 'flow' });
    const lines = svg('svg', { class: 'flow__svg', 'aria-hidden': 'true' });
    const defs = svg('defs');
    const marker = svg('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    marker.append(svg('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#8a8f74' }));
    defs.append(marker); lines.append(defs);
    if (window.BoardFlowCanvas) {
      const zone = (id, label, items) => h('section', { class: 'flow-zone', dataset: { zone: id }, 'aria-label': `Зона ${label}` },
        h('header', { class: 'flow-zone__header' }, h('h3', { class: 'flow__label', text: label })),
        h('div', { class: 'flow-zone__content' }, items.map(box)));
      board.append(...[lines, byRole('source').length ? zone('source', 'Источники', byRole('source')) : null,
        zone(state.flowRole, flowRoleLabel(state.flowRole), byRole(state.flowRole)), common.length ? zone('common', 'Общее', common) : null].filter(Boolean));
    } else board.append(lines,
      h('div', { class: 'flow__row flow__row--source' }, h('p', { class: 'flow__label', text: 'Источники' }), h('div', { class: 'flow__nodes' }, byRole('source').map(box))),
      h('div', { class: 'flow__cols flow__cols--single' }, ROLES.filter((role) => role.id === state.flowRole).map((role) => h('div', { class: `flow__col flow__col--${role.id}` },
        h('p', { class: 'flow__label', text: role.label }), h('div', { class: 'flow__stack' }, byRole(role.id).map(box))))),
      h('div', { class: 'flow__row flow__row--common' }, h('p', { class: 'flow__label', text: 'Общее' }), h('div', { class: 'flow__nodes' }, common.map(box))));
    return h('div', { class: 'flow-wrap' }, jFlowViewSwitch(),
      h('div', { class: 'flow-roles', role: 'group', 'aria-label': 'Чья блок-схема' }, ROLES.map((role) => h('button', {
        type: 'button', class: `flow-role${state.flowRole === role.id ? ' is-active' : ''}`, dataset: { flowRole: role.id },
        'aria-pressed': String(state.flowRole === role.id), text: flowRoleLabel(role.id), onclick: () => switchFlowRole(role.id)
      }))), window.BoardFlowCanvas?.toolbar({ h, nextId, mode: state.mode, ensureEdit: enableCanvasEdit }),
      h('p', { class: 'flow-help', text: state.mode === 'edit'
      ? 'ЛКМ — перемещение карточки за заголовок; средняя кнопка или Пробел + ЛКМ — полотно. ● → ○ — переход. Тяните угол зоны, чтобы расширить её. Esc — отмена.'
      : 'Перемещайте полотно правой или средней кнопкой мыши. «Перемещение» (V) включает расстановку карточек и изменение схемы.' }),
      state.mode === 'edit' ? newNodeControl() : null, h('div', { class: 'flow-scroll' }, board));
  }

  const ROUTE_TYPES = new Set(['button', 'order', 'chat', 'customer', 'form', 'helpform']);
  const routeBlocks = (frame) => blocksOf(frame).filter((block) => ROUTE_TYPES.has(block.type) && block.presentationHidden !== true);
  function menuEdges() {
    return ROLES.flatMap(({ id: role }) => visibleMenuItems(role).map((item) => ({ from: `menu:${role}`,
      to: flow().nodes.find((node) => node.frame === item.target)?.id, label: str(item.label), menuRole: role, menuItemId: item.id })).filter((edge) => edge.to));
  }
  const diagramEdges = () => [...flow().edges.filter((edge) => { const owner = edge.blockId ? findBlock(edge.blockId)?.block : null; return !owner || owner.presentationHidden !== true && !isLinkButton(owner); }), ...menuEdges()];
  function menuRouteRow(node, item) {
    const inactive = Boolean(item.hidden), frame = frameById(item.target);
    const port = h('button', { type: 'button', class: 'route-port', dataset: { routePort: item.id, sourceNode: node.id, menuItem: item.id },
      text: '●', disabled: state.mode !== 'edit' || inactive, 'aria-label': `Связать пункт меню «${str(item.label)}»`, title: 'Потяните к странице этой роли',
      onclick: (event) => {
        event.stopPropagation(); if (Date.now() < suppressPortClickUntil) return;
        if (state.connection?.menuItemId === item.id) cancelConnection(); else startMenuConnection(node.role, item, port);
      } });
    port.addEventListener('pointerdown', (event) => {
      if ((event.button !== undefined && event.button !== 0) || port.disabled) return;
      event.preventDefault(); event.stopPropagation(); startMenuConnection(node.role, item, port);
      connectionPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    });
    const label = applyMenuStyle(item.textStyles?.label, h('button', { type: 'button', class: 'node-action__label', text: str(item.label) || 'Без названия',
      onclick: () => { state.mode = 'edit'; renderTop(); renderStage(); selectMenu(node.role); } }));
    return h('div', { class: `node-action${inactive ? ' is-disabled' : ''}`, dataset: { menuItem: item.id } }, label,
      h('span', { class: 'node-action__target', text: inactive ? 'Скрыт' : frame?.role === node.role && !frame.hidden ? `→ ${item.target}` : 'Не связано' }), port);
  }
  function startMenuConnection(role, item, port) {
    if (state.mode !== 'edit' || item.hidden) return;
    cancelConnection(false);
    state.connection = { source: `menu:${role}`, blockId: item.id, menuItemId: item.id, menuRole: role, frameId: '', x: null, y: null };
    port.classList.add('is-connecting');
    for (const el of ui.stage.querySelectorAll('.node.has-frame')) if (frameById(el.dataset.frame)?.role === role) el.classList.add('is-connect-target');
    toast('Выберите страницу для этого пункта меню.');
  }
  function routeRow(node, frame, block) {
    const inactive = block.review === 'remove' || frame.hidden;
    const target = frameById(block.target);
    const label = blockEdgeLabel(block) || TYPE_LABEL[block.type] || 'Кнопка';
    if (isLinkButton(block)) return h('div', { class: `node-action${inactive ? ' is-disabled' : ''}`, dataset: { routeBlock: block.id } },
      h('button', { type: 'button', class: 'node-action__label', text: label, onclick: () => { state.mode = 'edit'; openFrame(frame.id); selectBlock(block.id); } }),
      h('span', { class: 'node-action__target', text: inactive ? 'Убрана' : safeButtonUrl(block.url) ? `↗ ${new URL(safeButtonUrl(block.url)).hostname}` : 'Ссылка не задана' }));
    const port = h('button', { type: 'button', class: 'route-port', dataset: { routePort: block.id, sourceNode: node.id },
      disabled: state.mode !== 'edit' || inactive, 'aria-label': `Связать кнопку «${label}»`, title: inactive ? 'Блок убран' : 'Потяните к следующей странице', text: '●',
      onclick: (event) => { event.stopPropagation(); if (Date.now() < suppressPortClickUntil) return;
        if (state.connection?.blockId === block.id) cancelConnection(); else startConnection(node, frame, block, port); } });
    port.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0 || port.disabled) return;
      event.preventDefault(); event.stopPropagation(); startConnection(node, frame, block, port);
      connectionPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    });
    return h('div', { class: `node-action${inactive ? ' is-disabled' : ''}`, dataset: { routeBlock: block.id } },
      h('button', { type: 'button', class: 'node-action__label', title: 'Открыть кнопку в редакторе', text: label,
        onclick: () => { if (state.connection) { finishConnection(node.id); return; }
          state.mode = 'edit'; openFrame(frame.id); selectBlock(block.id); } }),
        target && target.role !== state.flowRole && !inactive ? h('button', { type: 'button', class: 'node-action__target node-action__cross-role',
          text: `→ ${target.id} · ${flowRoleLabel(target.role)}`, title: 'Перейти к связанной схеме',
          onclick: () => switchFlowRole(target.role, { nodeId: flow().nodes.find((item) => item.frame === target.id)?.id }) })
        : h('span', { class: 'node-action__target', text: inactive ? 'Убрана' : target ? `→ ${target.id}${['form', 'helpform'].includes(block.type) ? ' · после формы' : ''}` : block.target === '@site' ? '↗ Сайт' : block.target === '@works' ? 'Наши работы' : 'Не связано' }), port);
  }
  let connectionPointer = null, suppressPortClickUntil = 0;
  function cancelConnection(redraw = true) {
    state.connection = null; connectionPointer = null;
    for (const el of ui.stage.querySelectorAll('.is-connecting, .is-connect-target')) el.classList.remove('is-connecting', 'is-connect-target');
    ui.stage.querySelector('.connection-draft')?.remove();
    if (redraw && state.tab === 'flow') requestAnimationFrame(drawEdges);
  }
  function startConnection(node, frame, block, port) {
    if (state.mode !== 'edit' || block.review === 'remove' || block.presentationHidden === true || isLinkButton(block) || !node.frame) return;
    cancelConnection(false);
    state.connection = { source: node.id, frameId: frame.id, blockId: block.id, x: null, y: null };
    port.classList.add('is-connecting');
    for (const el of ui.stage.querySelectorAll('.node.has-frame')) if (el.dataset.frame !== frame.id) el.classList.add('is-connect-target');
    toast('Выберите следующую страницу или потяните линию к ней.');
  }
  function finishConnection(targetId) {
    const draft = state.connection, target = nodeById(targetId);
    if (!draft) return;
    if (!target?.frame || !frameById(target.frame) || frameById(target.frame).hidden) { toast('Кнопка связывается с доступной страницей. Выберите карточку страницы.'); return; }
    if (draft.menuItemId) {
      if (frameById(target.frame).role !== draft.menuRole) { toast('Выберите страницу этой же роли.'); return; }
      const item = effectiveMenu(draft.menuRole).items.find((entry) => entry.id === draft.menuItemId);
      if (!item || item.hidden) { cancelConnection(); return; }
      cancelConnection(false); state.nodeId = draft.source; state.menuRole = draft.menuRole;
      editMenu(draft.menuRole, (menu) => { const current = menu.items.find((entry) => entry.id === draft.menuItemId); if (current) current.target = target.frame; });
      renderInspector(); toast(`Пункт меню ведёт на ${target.frame}`); return;
    }
    const owner = findBlock(draft.blockId);
    if (!owner || owner.frame.id !== draft.frameId || owner.block.review === 'remove' || isLinkButton(owner.block)) { cancelConnection(); return; }
    if (target.frame === owner.frame.id) { toast('Выберите другую страницу.'); return; }
    owner.block.target = target.frame;
    syncBlockEdge(owner.frame, owner.block);
    cancelConnection(false); state.nodeId = draft.source;
    edgeChanged(); toast(`Переход сохранён: ${blockEdgeLabel(owner.block)} → ${target.frame}`);
  }
  document.addEventListener('pointermove', (event) => {
    if (!state.connection || !connectionPointer || event.pointerId !== connectionPointer.id) return;
    if (Math.hypot(event.clientX - connectionPointer.x, event.clientY - connectionPointer.y) > 5) connectionPointer.moved = true;
    state.connection.x = event.clientX; state.connection.y = event.clientY;
    const scroll = ui.stage.querySelector('.flow-scroll');
    if (scroll) { const r = scroll.getBoundingClientRect();
      if (event.clientX > r.right - 40) scroll.scrollLeft += 18; else if (event.clientX < r.left + 40) scroll.scrollLeft -= 18;
      if (event.clientY > r.bottom - 40) scroll.scrollTop += 18; else if (event.clientY < r.top + 40) scroll.scrollTop -= 18;
    }
    drawEdges();
  });
  document.addEventListener('pointerup', (event) => {
    if (!state.connection || !connectionPointer || event.pointerId !== connectionPointer.id) return;
    const moved = connectionPointer.moved; connectionPointer = null;
    suppressPortClickUntil = Date.now() + 300;
    if (!moved) return; // Нажатие на порт оставляет режим «выбрать страницу» для мыши и клавиатуры.
    const element = document.elementFromPoint?.(event.clientX, event.clientY) || event.target;
    const target = element?.closest?.('.node[data-node]');
    if (target) finishConnection(target.dataset.node); else { cancelConnection(); toast('Линия не изменена: отпустите её на странице.'); }
  });
  document.addEventListener('pointercancel', () => cancelConnection());
  /* «Добавить узел» (только в редактировании схемы): название, роль, вид «Шаг»/«Условие». Ввод не перерисовывает схему. */
  function newNodeControl() {
    if (!state.newNode) {
      return h('div', { class: 'flow-tools' }, h('button', { type: 'button', class: 'btn btn--small', text: '+ Добавить узел',
        onclick: () => { state.newNode = { label: '', role: state.flowRole, kind: 'step', error: '' }; renderStage(); ui.stage.querySelector('.new-node input')?.focus(); } }));
    }
    const draft = state.newNode;
    const error = h('p', { class: 'form-error', role: 'alert', text: draft.error });
    const ids = { label: nextId('nn'), role: nextId('nn'), kind: nextId('nn') };
    return h('form', { class: 'flow-tools new-node', novalidate: true, onsubmit: (event) => {
      event.preventDefault();
      const label = draft.label.trim();
      if (!label) { draft.error = 'Введите название узла.'; error.textContent = draft.error; ui.stage.querySelector('.new-node input')?.focus(); return; }
      const taken = new Set(flow().nodes.map((node) => node.id));
      let n = flow().nodes.length + 1, id;
      do { id = `N${String(n).padStart(2, '0')}`; n += 1; } while (taken.has(id));
      flow().nodes.push({ id, label, role: draft.role, kind: draft.kind === 'condition' ? 'condition' : 'step', review: 'pending', note: '',
        ...(!ROLES.some((role) => role.id === draft.role) ? { flowScope: state.flowRole } : {}) });
      if (ROLES.some((role) => role.id === draft.role)) state.flowRole = draft.role;
      state.newNode = null; state.nodeId = id;
      renderStage(); renderInspector(); changed();
    } },
      h('div', { class: 'ins-field' }, h('label', { for: ids.label, text: 'Название узла' }),
        h('input', { id: ids.label, type: 'text', value: draft.label, maxlength: '120', oninput: (event) => { draft.label = event.target.value; } })),
      h('div', { class: 'ins-field' }, h('label', { for: ids.role, text: 'Роль' }),
        h('select', { id: ids.role, onchange: (event) => { draft.role = event.target.value; } }, NODE_ROLES.map(([v, text]) => h('option', { value: v, selected: v === draft.role, text })))),
      h('div', { class: 'ins-field' }, h('label', { for: ids.kind, text: 'Вид' }),
        h('select', { id: ids.kind, onchange: (event) => { draft.kind = event.target.value; } },
          h('option', { value: 'step', selected: draft.kind !== 'condition', text: 'Шаг' }), h('option', { value: 'condition', selected: draft.kind === 'condition', text: 'Условие' }))),
      error,
      h('div', { class: 'ins-actions' }, h('button', { type: 'submit', class: 'btn btn--main btn--small', text: 'Добавить' }),
        h('button', { type: 'button', class: 'btn btn--small', text: 'Отмена', onclick: () => { state.newNode = null; renderStage(); } })));
  }
  function clickNode(node) {
    if (node.kind === 'menu') {
      if (state.mode === 'view') { openFrame(MENU_HOME[node.role]); state.menuOpen = true; renderStage(); }
      else selectMenu(node.role);
      return;
    }
    state.menuRole = null;
    if (state.mode === 'view') {
      if (node.frame && frameById(node.frame)) { openFrame(node.frame); return; }
      state.nodeId = node.id; renderStage(); renderInspector(); return;
    }
    state.nodeId = node.id;
    for (const el of ui.stage.querySelectorAll('.node')) el.classList.toggle('is-selected', el.dataset.node === node.id);
    renderInspector();
    if (narrow()) { state.pane = 'inspector'; renderTop(); }
  }
  // Ортогональные соединители по фактическим позициям узлов; размер SVG — по содержимому схемы.
  function drawEdges() {
    const board = ui.stage.querySelector('.flow');
    if (!board || !state.project) return;
    const lines = board.querySelector('.flow__svg');
    for (const el of [...lines.querySelectorAll('.edge')]) el.remove();
    const base = board.getBoundingClientRect();
    const scale = Number(board.dataset.zoom) || 1;
    lines.setAttribute('width', board.scrollWidth); lines.setAttribute('height', board.scrollHeight);
    const bounds = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: (r.left - base.left) / scale, right: (r.right - base.left) / scale, top: (r.top - base.top) / scale, bottom: (r.bottom - base.top) / scale,
        cx: (r.left - base.left + r.width / 2) / scale, cy: (r.top - base.top + r.height / 2) / scale };
    };
    const rect = (id) => bounds(board.querySelector(`.node[data-node="${CSS.escape(String(id))}"]`));
    // Сторона точки выводится из расположения связанных карточек; она не хранится как самостоятельная настройка.
    for (const port of board.querySelectorAll('.route-port')) {
      const edge = diagramEdges().find((item) => (item.blockId || item.menuItemId) === port.dataset.routePort), source = rect(port.dataset.sourceNode), target = edge ? rect(edge.to) : null;
      let left = Boolean(source && target && target.cx < source.cx);
      if (state.connection?.blockId === port.dataset.routePort && state.connection.x !== null && source) left = (state.connection.x - base.left) / scale < source.cx;
      port.classList.toggle('is-left', left);
    }
    diagramEdges().forEach((edge, index) => {
      const a = rect(edge.from), b = rect(edge.to);
      if (!a || !b) return;
      const owner = edge.menuItemId ? { block: effectiveMenu(edge.menuRole).items.find((item) => item.id === edge.menuItemId), frame: {} } : edge.blockId ? findBlock(edge.blockId) : null;
      if (owner?.block.review === 'remove' || owner?.frame.hidden || frameById(nodeById(edge.to)?.frame)?.hidden) return;
      let d, lx, ly;
      const shift = ((index % 5) - 2) * 4;   // небольшое смещение, чтобы параллельные линии не сливались
      if (owner) {
        const port = bounds(board.querySelector(`[data-route-port="${CSS.escape(String(edge.blockId || edge.menuItemId))}"]`));
        const targetSide = a.cx >= b.cx ? 'right' : 'left';
        const inlet = bounds(board.querySelector(`.node[data-node="${CSS.escape(String(edge.to))}"] .node-inlet[data-inlet-side="${targetSide}"]`));
        if (!port || !inlet) return;
        const gutter = Math.max(a.right, b.right) + 22 + (index % 5) * 6;
        if (Math.abs(a.left - b.left) < 10) {
          d = `M${port.cx},${port.cy} H${gutter} V${inlet.cy} H${inlet.cx}`;
          lx = gutter + 4; ly = (port.cy + inlet.cy) / 2;
        } else {
          const left = b.cx < a.cx, bend = Math.max(48, Math.abs(inlet.cx - port.cx) / 2) + Math.abs(shift);
          d = `M${port.cx},${port.cy} C${port.cx + (left ? -bend : bend)},${port.cy} ${inlet.cx + (left ? bend : -bend)},${inlet.cy} ${inlet.cx},${inlet.cy}`;
          lx = (port.cx + inlet.cx) / 2; ly = (port.cy + inlet.cy) / 2 - 6;
        }
      } else if (b.top >= a.bottom - 1) {
        const y1 = a.bottom, y2 = b.top, my = (y1 + y2) / 2 + shift;
        d = `M${a.cx},${y1} V${my} H${b.cx} V${y2}`; lx = (a.cx + b.cx) / 2; ly = my - 4;
      } else if (b.bottom <= a.top + 1) {
        const y1 = a.top, y2 = b.bottom, my = (y1 + y2) / 2 + shift;
        d = `M${a.cx},${y1} V${my} H${b.cx} V${y2}`; lx = (a.cx + b.cx) / 2; ly = my - 4;
      } else {
        const right = b.left >= a.right;
        const x1 = right ? a.right : a.left, x2 = right ? b.left : b.right, mx = (x1 + x2) / 2 + shift;
        d = `M${x1},${a.cy} H${mx} V${b.cy} H${x2}`; lx = mx + 4; ly = (a.cy + b.cy) / 2 - 4;
      }
      const group = svg('g', { class: `edge${owner ? ' edge--button' : ''}`, 'data-block-id': edge.blockId || '', 'data-menu-item': edge.menuItemId || '', 'data-from': edge.from, 'data-to': edge.to });
      if (state.mode === 'edit') { const hit = svg('path', { d, class: 'edge__hit' });
        hit.addEventListener('click', () => { state.nodeId = edge.from; clickNode(nodeById(edge.from)); }); group.append(hit); }
      group.append(svg('path', { d, class: 'edge__line', 'marker-end': 'url(#arrow)' }));
      if (edge.label) { const text = svg('text', { x: lx, y: ly, class: 'edge__label', 'text-anchor': 'middle' }); text.textContent = str(edge.label); group.append(text); }
      lines.append(group);
    });
    lines.querySelector('.connection-draft')?.remove();
    if (state.connection && state.connection.x !== null) {
      const port = bounds(board.querySelector(`[data-route-port="${CSS.escape(state.connection.blockId)}"]`));
      if (port) { const x = (state.connection.x - base.left) / scale, y = (state.connection.y - base.top) / scale;
        const direction = x < port.cx ? -1 : 1;
        lines.append(svg('path', { class: 'connection-draft', d: `M${port.cx},${port.cy} C${port.cx + 50 * direction},${port.cy} ${x - 50 * direction},${y} ${x},${y}`, 'marker-end': 'url(#arrow)' })); }
    }
  }
  let resizeTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.tab === 'flow') { if (state.flowView === 'journey') drawJourney(); else drawEdges(); } }, 120); });

  /* ---------- перетаскивание блоков (только в редактировании) ----------
     Тянется только ручка «⋮⋮» (не поля и не тело блока). Мышь — native drag&drop, касание/перо — pointer-события той же
     ручки. Принимаются только блоки того же текущего экрана; устаревший или чужой ID — без изменений. Одно перемещение —
     одно изменение модели и одно автосохранение. */
  function dragHandle(frame, block, className) {
    const handle = h('button', { type: 'button', class: `drag-handle ${className}`, draggable: 'true', 'aria-label': 'Перетащить блок', title: 'Перетащить блок', text: '⋮⋮' });
    handle.addEventListener('dragstart', (event) => {
      state.drag = { frameId: frame.id, blockId: block.id };
      try {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', block.id);
        const row = handle.closest('[data-drop-block]');
        if (row && typeof event.dataTransfer.setDragImage === 'function') event.dataTransfer.setDragImage(row, 16, 16);
      } catch (_) { /* перетаскивание работает и без картинки */ }
      document.body.classList.add('is-dragging');
    });
    handle.addEventListener('dragend', endDrag);
    handle.addEventListener('pointerdown', (event) => startPointerDrag(event, frame, block, handle));
    return handle;
  }
  const dropAfter = (y, el) => { const r = el.getBoundingClientRect(); return y > r.top + r.height / 2; };
  function clearDropMarks() { for (const el of document.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after'); }
  function markDrop(el, after) { clearDropMarks(); el.classList.add(after ? 'drop-after' : 'drop-before'); }
  function endDrag() { state.drag = null; clearDropMarks(); document.body.classList.remove('is-dragging'); }
  function bindDrop(el, frame, block) {
    el.dataset.dropBlock = block.id; el.dataset.dropFrame = frame.id;
    el.addEventListener('dragover', (event) => {
      const drag = state.drag;
      if (!drag || drag.frameId !== frame.id || drag.blockId === block.id) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      markDrop(el, dropAfter(event.clientY, el));
    });
    el.addEventListener('dragleave', (event) => { if (!el.contains(event.relatedTarget)) el.classList.remove('drop-before', 'drop-after'); });
    el.addEventListener('drop', (event) => {
      const drag = state.drag;
      if (!drag) return;
      event.preventDefault(); event.stopPropagation();
      const after = el.classList.contains('drop-after');
      endDrag();
      moveBlockTo(drag.frameId, drag.blockId, block.id, after);
    });
  }
  function startPointerDrag(event, frame, block, handle) {
    if (event.pointerType === 'mouse' || state.mode !== 'edit') return;
    event.preventDefault();
    state.drag = { frameId: frame.id, blockId: block.id };
    try { handle.setPointerCapture(event.pointerId); } catch (_) { /* без захвата — по движению пальца */ }
    let target = null, after = false;
    const move = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const row = el && el.closest('[data-drop-block]');
      target = null; clearDropMarks();
      if (row && row.dataset.dropFrame === frame.id && row.dataset.dropBlock !== block.id) { after = dropAfter(e.clientY, row); markDrop(row, after); target = row.dataset.dropBlock; }
    };
    const stop = (apply) => () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onCancel);
      const goal = target;
      endDrag();
      if (apply && goal) moveBlockTo(frame.id, block.id, goal, after);
    };
    const onUp = stop(true), onCancel = stop(false);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onCancel);
  }
  function moveBlockTo(frameId, blockId, targetId, after) {
    const frame = frameById(frameId);
    if (!frame || frame.id !== state.frameId || blockId === targetId || state.mode !== 'edit') return;
    const blocks = blocksOf(frame);
    const before = blocks.map((b) => b.id).join('\n');
    const from = blocks.findIndex((b) => b.id === blockId);
    if (from < 0 || !blocks.some((b) => b.id === targetId)) return;
    const [moved] = blocks.splice(from, 1);
    const to = blocks.findIndex((b) => b.id === targetId) + (after ? 1 : 0);
    blocks.splice(to, 0, moved);
    if (blocks.map((b) => b.id).join('\n') === before) return;
    state.blockId = blockId;
    renderStage(); renderInspector(); changed();
  }

  /* ---------- инспектор ---------- */
  function selectBlock(id) {
    state.blockId = id; state.menuRole = null;
    for (const el of ui.stage.querySelectorAll('.blk')) el.classList.toggle('is-selected', el.dataset.block === id);
    renderInspector();
    if (narrow()) { state.pane = 'inspector'; renderTop(); }
  }
  // Правка текста: модель → превью/список/схема без перерисовки самого инспектора (фокус и курсор не теряются).
  function edited({ sidebar = false } = {}) {
    renderStage();
    if (sidebar) renderSidebar();
    changed();
  }
  function textField(label, value, onInput, { area = false, rows = 3, disabled = false } = {}) {
    const id = nextId('f');
    const input = area ? h('textarea', { id, rows, value, disabled, oninput: (event) => onInput(event.target.value) })
      : h('input', { id, type: 'text', value, disabled, oninput: (event) => onInput(event.target.value) });
    return h('div', { class: 'ins-field' }, h('label', { for: id, text: label }), input);
  }
  function selectField(label, value, options, onChange) {
    const id = nextId('f');
    return h('div', { class: 'ins-field' }, h('label', { for: id, text: label }),
      h('select', { id, onchange: (event) => onChange(event.target.value) }, options.map(([v, text]) => h('option', { value: v, selected: v === value, text }))));
  }
  function targetOptions(current, sourceId = '') {
    const options = [['', '— нет —'], ['@site', 'Сайт Palitra Love (новое окно)'], ['@works', '«Наши работы» (пример)'],
      ...frames().filter((frame) => frame.id !== sourceId && !frame.hidden).map((frame) => [frame.id, `${frame.id} · ${str(frame.title)}`])];
    if (current && !options.some(([v]) => v === current)) options.push([current, `${current} (нет такого экрана)`]);
    return options;
  }
  function renderInspector() {
    const box = ui.inspector;
    box.replaceChildren();
    if (!state.project) return;
    const role = state.menuRole || menuNodeRole(state.nodeId);
    if (role) { box.append(menuInspector(role)); return; }
    if (state.tab === 'flow') { box.append(state.flowView === 'journey' ? journeyInspector() : nodeInspector()); return; }
    if (state.tab === 'notices') { box.append(noticeInspector()); return; }
    const frame = currentFrame();
    if (!frame) { box.append(h('p', { class: 'muted pad', text: 'Выберите экран.' })); return; }
    const editing = state.mode === 'edit';
    const block = editing ? blockById(frame, state.blockId) : null;
    if (block) box.append(blockInspector(frame, block));
    box.append(frameInspector(frame, editing));
  }
  function menuInspector(role) {
    const section = h('section', { class: 'ins-card menu-inspector', dataset: { menuRole: role } },
      h('h2', { text: `Меню · ${flowRoleLabel(role)}` }),
      h('p', { class: 'hint', text: 'Это меню общее для всех экранов этой роли. Каждый пункт связан со страницей на блок-схеме.' }));
    if (state.mode === 'edit') {
      section.append(textField('Название приложения в шапке', str(state.project.appTitle), (value) => { state.project.appTitle = value; edited(); }));
      if (window.BoardMenuBuilder) section.append(window.BoardMenuBuilder.renderEditor({ h, role, getMenu: () => effectiveMenu(role), frames,
        change: (update, options) => editMenu(role, update, options) }));
    } else section.append(h('ul', {}, visibleMenuItems(role).map((item) => h('li', { text: `${str(item.label)} → ${item.target}` }))));
    section.append(h('button', { type: 'button', class: 'btn btn--quiet btn--small', text: 'К блок-схеме меню', onclick: () => {
      state.menuRole = role; switchFlowRole(role, { nodeId: `menu:${role}` }); selectMenu(role);
    } }));
    return section;
  }
  function blockInspector(frame, block) {
    const fields = FIELDS[block.type] || [];
    const section = h('section', { class: 'ins-card ins-card--block' },
      h('div', { class: 'ins-card__head' }, h('h2', { text: TYPE_LABEL[block.type] || block.type }),
        h('button', { type: 'button', class: 'btn btn--quiet btn--small', text: 'Снять выбор', onclick: () => { state.blockId = null; renderStage(); renderInspector(); } })),
      h('p', { class: 'muted', text: `Блок ${block.id}` }));
    section.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: block.presentationHidden !== true, onchange: event => { block.presentationHidden = !event.target.checked; edited(); } }), h('span', { text: 'Показывать в просмотре' })));
    if (block.type === 'button') {
      section.append(selectField('Действие кнопки', isLinkButton(block) ? 'link' : 'page', [['page', 'Перейти на экран'], ['link', 'Открыть ссылку']], (value) => {
        block.action = value; syncBlockEdge(frame, block); edited(); renderInspector();
      }));
      if (isLinkButton(block)) {
        const urlError = h('p', { class: 'hint', role: 'alert', text: safeButtonUrl(block.url) ? '' : 'Укажите полную ссылку http:// или https:// без логина и пароля.' });
        section.append(textField('Ссылка', str(block.url), (value) => {
          block.url = value; urlError.textContent = safeButtonUrl(value) ? '' : 'Укажите полную ссылку http:// или https:// без логина и пароля.'; edited();
        }), urlError);
      }
    }
    for (const [key, label, kind] of fields) {
      if (kind === 'target' && isLinkButton(block)) continue;
      // Надпись кнопки раскрытия — только у сворачиваемой формы (collapsible задаёт Root в модели).
      if (kind === 'toggle') {
        if (window.BoardFormBuilder) continue;
        if (block.collapsible === true) section.append(textField(label, str(block[key]) || 'Подобрать индивидуально', (value) => { block[key] = value; edited(); }));
        continue;
      }
      if (kind === 'target') {
        // Переход блока = связь схемы этого блока (создаётся, переносится или снимается вместе с целью).
        const configured = str(block[key]);
        const choices = block.type === 'helpform' ? [['', 'Чат заявки (по умолчанию)'], ...frames()
          .filter((target) => target.id !== frame.id && target.role === 'client' && target.device !== 'desktop' && !target.hidden)
          .map((target) => [target.id, `${target.id} · ${target.title}`])]
          : targetOptions(configured, frame.id);
        if (block.type === 'helpform' && configured && !choices.some(([id]) => id === configured))
          choices.push([configured, `${configured} — переход после заявки не подключён`]);
        const control = selectField(label, configured, choices, (value) => {
          if (setBlockTarget(frame, block, value)) edited(); else control.querySelector('select').value = str(block[key]); });
        section.append(control);
      } else if (kind === 'channel') {
        const current = str(block[key]);
        const options = CHANNELS.map((c) => [c.id, c.label]);
        if (current && !channelById(current)) options.push([current, `${current} (неизвестный канал)`]);
        section.append(selectField(label, current || 'telegram', options, (value) => { block[key] = value; edited(); }));
      } else if (kind === 'stages') {
        section.append(textField(label, salesStages(block).map((s) => (s.hint ? `${s.label} | ${s.hint}` : s.label)).join('\n'), (value) => {
          block[key] = parseStages(value, salesStages(block)); edited(); refreshInitialChoice(block);
        }, { area: true, rows: 5 }));
      } else if (kind === 'wait') {
        const id = nextId('wait'); const input = h('input', { id, type: 'number', min: '1', max: '1440', step: '1', value: Number.isFinite(block[key]) ? block[key] : '',
          oninput: () => { const n = Number(input.value); if (input.value === '') block[key] = null;
            else if (Number.isInteger(n) && n >= 1 && n <= 1440) block[key] = n; else return;
            edited(); scheduleNotice(); } });
        section.append(h('div', { class: 'ins-field' }, h('label', { for: id, text: 'Минут без ответа после формы' }), input));
      } else if (kind === 'lines') {
        section.append(textField(label, (Array.isArray(block[key]) ? block[key] : []).map(str).join('\n'), (value) => {
          block[key] = value.split('\n').map((line) => line.trim()).filter(Boolean); edited(); refreshInitialChoice(block);
        }, { area: true, rows: 4 }));
      } else if (kind === 'messages') {
        const toText = (list) => (Array.isArray(list) ? list : []).map((m) => (m && m.kind === 'divider' ? `--- ${str(m.text)}` : str(m && m.text))).join('\n');
        section.append(textField(label, toText(block[key]), (value) => {
          block[key] = value.split('\n').filter((line) => line.trim()).map((line) => (/^---\s?/.test(line)
            ? { kind: 'divider', text: line.replace(/^---\s?/, '') } : { kind: 'message', text: line }));
          edited();
        }, { area: true, rows: 6 }));
      } else {
        section.append(textField(label, str(block[key]), (value) => {
          block[key] = value;
          if (key === 'label' || key === 'title' || key === 'orderNumber' || key === 'submitLabel') syncBlockEdgeLabel(block);
          edited();
        }, { area: kind === 'area' }));
      }
    }
    if (block.type === 'website' && safeUrl(block.url)) {
      section.append(h('button', { type: 'button', class: 'btn btn--small', text: 'Открыть сайт в новой вкладке ↗', onclick: () => window.open(safeUrl(block.url), '_blank', 'noopener') }));
    }
    const formSettings = window.BoardFormBuilder?.inspector({ block, h, textField, selectField, edited, refresh: renderInspector, channels: CHANNELS, nextId });
    if (formSettings) section.append(formSettings);
    if (block.type === 'helpform') section.append(freeLayoutInspector(frame, block));
    if (['status', 'sales'].includes(block.type)) {
      const options = block.type === 'status' ? (block.values || []).map((value) => [value, value]) : salesStages(block).map((stage) => [stage.id, stage.label]);
      const property = block.type === 'status' ? 'defaultValue' : 'defaultStage';
      const control = selectField(block.type === 'status' ? 'Статус при открытии' : 'Первый этап', block[property] || options[0]?.[0] || '', options, (value) => { block[property] = value; if (block.type === 'sales') demo.stage = ''; edited(); });
      control.classList.add('initial-choice'); section.append(control);
    }
    const typography = textStyleSection(block);
    if (typography) section.append(typography);
    section.append(selectField('Решение', block.review || 'pending', [['keep', 'Оставить'], ['change', 'Изменить'], ['remove', 'Убрать'], ['pending', 'Без решения']],
      (value) => { block.review = value; edited({ sidebar: true }); renderInspector(); }),
    textField('Заметка', str(block.note), (value) => { block.note = value; changed(); }, { area: true, rows: 3 }),
    // «Убрать» обратимо: это то же решение review='remove', блок и его данные остаются в проекте.
    h('div', { class: 'ins-actions' }, h('button', { type: 'button', class: 'btn btn--small', text: 'Дублировать блок', onclick: () => duplicateBlock(frame, block) }), block.review === 'remove'
      ? h('button', { type: 'button', class: 'btn btn--small', text: 'Вернуть блок', onclick: () => { block.review = 'pending'; edited({ sidebar: true }); renderInspector(); } })
      : h('button', { type: 'button', class: 'btn btn--small btn--danger', text: 'Убрать блок', onclick: () => { block.review = 'remove'; edited({ sidebar: true }); renderInspector(); } })),
    block.review === 'remove' ? h('p', { class: 'hint', text: '«Убрать» не удаляет блок: в редактировании он полупрозрачный, в просмотре скрыт.' }) : null);
    return section;
  }
  function refreshInitialChoice(block) {
    const select = ui.inspector.querySelector('.initial-choice select');
    if (!select) return;
    const options = block.type === 'status' ? (block.values || []).map((value) => [value, value]) : salesStages(block).map((stage) => [stage.id, stage.label]);
    const property = block.type === 'status' ? 'defaultValue' : 'defaultStage';
    const selected = options.some(([value]) => value === block[property]) ? block[property] : options[0]?.[0] || '';
    select.replaceChildren(...options.map(([value, text]) => h('option', { value, text, selected: value === selected })));
  }
  /* «Оформление текста» выбранного поля блока. Значения по умолчанию — фактические (computed) стили этого текста в
     превью, а если текста сейчас нет — значения CSS доски. В модель пишутся только явно изменённые свойства; поля
     меняют модель и превью (edited), инспектор не пересоздаётся. Пересборка — только при смене «Какой текст» и сбросе. */
  const FALLBACK_SIZE = { 'hero.title': 24, 'text.title': 17, 'helpform.title': 17, 'chat.title': 17, 'status.title': 17, 'order.status': 13 };
  const FALLBACK_COLOR = { 'hero.subtitle': '#6d6a60', 'helpform.subtitle': '#6d6a60', 'order.details': '#6d6a60', 'text.text': '#3d3b33' };
  const ALIGN_ICON = { left: 'M4 6h16M4 10h10M4 14h16M4 18h10', center: 'M4 6h16M7 10h10M4 14h16M7 18h10',
    right: 'M4 6h16M10 10h10M4 14h16M10 18h10', justify: 'M4 6h16M4 10h16M4 14h16M4 18h16' };
  const previewTextEl = (block, field) => ui.stage.querySelector(`.blk[data-block="${CSS.escape(String(block.id))}"] [data-text-field="${CSS.escape(field)}"]`);
  function toHex(color) {
    const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(String(color || ''));
    return m ? `#${m.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}` : null;
  }
  function textDefaults(block, field) {
    const id = `${block.type}.${field}`;
    const out = { size: FALLBACK_SIZE[id] || 15, bold: BOLD_DEFAULT.has(id), italic: false, underline: false,
      align: block.type === 'hero' || block.type === 'button' ? 'center' : 'left', color: FALLBACK_COLOR[id] || '#26261f', lineHeight: null, present: false };
    const el = previewTextEl(block, field);
    if (el) {
      const cs = getComputedStyle(el);
      const size = parseFloat(cs.fontSize);
      if (size) out.size = Math.round(size);
      out.bold = (Number(cs.fontWeight) || 400) >= 600;
      out.italic = cs.fontStyle === 'italic' || cs.fontStyle.startsWith('oblique');
      out.underline = /underline/.test(cs.textDecorationLine || cs.textDecoration || '');
      out.align = { start: 'left', left: 'left', center: 'center', right: 'right', end: 'right', justify: 'justify' }[cs.textAlign] || out.align;
      out.color = toHex(cs.color) || out.color;
      const line = parseFloat(cs.lineHeight);
      if (/px$/.test(cs.lineHeight) && line && size) out.lineHeight = Math.round((line / size) * 100) / 100;
      out.present = true;
    }
    // Подсказка поля ввода серая (цвет ::placeholder браузера), а не цвет текста поля.
    if (field === 'placeholder') out.color = '#757575';
    return out;
  }
  function textStyleSection(block) {
    const fields = textFieldsOf(block);
    if (!fields.length) return null;
    if (!state.textField || state.textField.blockId !== block.id || !fields.some(([key]) => key === state.textField.key)) {
      state.textField = { blockId: block.id, key: fields[0][0] };
    }
    const field = state.textField.key;
    const stored = () => cleanTextStyle(block.textStyles && typeof block.textStyles === 'object' ? block.textStyles[field] : null);
    // undefined — свойство снимается (возвращается CSS по умолчанию); пустое поле — ключ удаляется, пустой textStyles — тоже.
    const setStyle = (prop, value) => {
      if (!block.textStyles || typeof block.textStyles !== 'object' || Array.isArray(block.textStyles)) block.textStyles = {};
      const next = stored();
      if (value === undefined) delete next[prop]; else next[prop] = value;
      const clean = cleanTextStyle(next);
      if (Object.keys(clean).length) block.textStyles[field] = clean; else delete block.textStyles[field];
      if (!Object.keys(block.textStyles).length) delete block.textStyles;
      edited();
    };
    const s = stored(), d = textDefaults(block, field);
    const ids = { size: nextId('ts'), line: nextId('ts'), color: nextId('ts'), styleLabel: nextId('ts'), alignLabel: nextId('ts') };

    const pick = selectField('Какой текст', field, fields, (value) => {
      state.textField = { blockId: block.id, key: value };
      renderInspector();
      ui.inspector.querySelector('.ts__pick select')?.focus();
    });
    pick.classList.add('ts__pick');

    const font = selectField('Шрифт', s.font || 'system', FONTS.map(([id, label]) => [id, label]), (value) => setStyle('font', value === 'system' ? undefined : value));
    for (const option of font.querySelectorAll('option')) option.style.fontFamily = FONT_FAMILY[option.value] || '';

    const clampSize = (n) => Math.min(72, Math.max(10, Math.round(n)));
    const size = h('input', { id: ids.size, type: 'number', min: '10', max: '72', step: '1', inputmode: 'numeric', value: s.size ?? d.size,
      oninput: () => { const n = Number(size.value); if (size.value.trim() !== '' && Number.isInteger(n) && n >= 10 && n <= 72) setStyle('size', n); },
      onchange: () => {
        const n = Number(size.value);
        if (size.value.trim() === '' || !Number.isFinite(n)) { size.value = String(stored().size ?? d.size); return; }
        const value = clampSize(n); size.value = String(value);
        if (stored().size !== value) setStyle('size', value);
      } });
    const stepSize = (delta) => { const value = clampSize((Number(size.value) || stored().size || d.size) + delta); size.value = String(value); setStyle('size', value); };

    const toggle = (prop, label, glyph) => {
      const button = h('button', { type: 'button', class: `ts-tool ts-tool--${prop}`, 'aria-pressed': String(s[prop] ?? d[prop]), 'aria-label': label, title: label, text: glyph,
        onclick: () => { const next = button.getAttribute('aria-pressed') !== 'true'; button.setAttribute('aria-pressed', String(next)); setStyle(prop, next); } });
      return button;
    };
    const alignButtons = ALIGNS.map(([value, label]) => {
      const icon = svg('svg', { viewBox: '0 0 24 24', width: '18', height: '18', 'aria-hidden': 'true', focusable: 'false' });
      icon.append(svg('path', { d: ALIGN_ICON[value], fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' }));
      const button = h('button', { type: 'button', class: 'ts-tool', 'aria-pressed': String((s.align || d.align) === value), 'aria-label': label, title: label,
        onclick: () => { for (const other of alignButtons) other.setAttribute('aria-pressed', String(other === button)); setStyle('align', value); } }, icon);
      return button;
    });

    const color = h('input', { id: ids.color, class: 'ts__color', type: 'color', value: s.color || d.color,
      oninput: () => { if (COLOR.test(color.value)) setStyle('color', color.value.toLowerCase()); } });
    const line = h('input', { id: ids.line, type: 'number', min: '1', max: '2.5', step: '0.05', inputmode: 'decimal', value: s.lineHeight ?? '',
      placeholder: d.lineHeight ? `${d.lineHeight} (как в макете)` : 'обычный',
      oninput: () => {
        if (line.value.trim() === '') { if (stored().lineHeight !== undefined) setStyle('lineHeight', undefined); return; }
        const n = Number(line.value);
        if (Number.isFinite(n) && n >= 1 && n <= 2.5) setStyle('lineHeight', n);
      },
      onchange: () => {
        if (line.value.trim() === '') return;
        const n = Number(line.value);
        const value = Number.isFinite(n) ? Math.min(2.5, Math.max(1, Math.round(n * 100) / 100)) : stored().lineHeight;
        line.value = value === undefined ? '' : String(value);
        if (value !== undefined && stored().lineHeight !== value) setStyle('lineHeight', value);
      } });

    return h('div', { class: 'ts' },
      h('h3', { class: 'ins-sub', text: 'Оформление текста' }),
      pick,
      d.present ? null : h('p', { class: 'hint', text: 'Сейчас этот текст пустой — оформление сохранится и появится вместе с текстом.' }),
      font,
      h('div', { class: 'ins-field' }, h('label', { for: ids.size, text: 'Размер, px' }),
        h('div', { class: 'ts__row' },
          h('button', { type: 'button', class: 'ts-tool', 'aria-label': 'Меньше', title: 'Меньше', text: '−', onclick: () => stepSize(-1) }),
          size,
          h('button', { type: 'button', class: 'ts-tool', 'aria-label': 'Больше', title: 'Больше', text: '+', onclick: () => stepSize(1) }))),
      h('div', { class: 'ins-field' }, h('span', { class: 'ts__label', id: ids.styleLabel, text: 'Начертание' }),
        h('div', { class: 'ts__tools', role: 'group', 'aria-labelledby': ids.styleLabel },
          toggle('bold', 'Жирный', 'Ж'), toggle('italic', 'Курсив', 'К'), toggle('underline', 'Подчёркнутый', 'Ч'))),
      h('div', { class: 'ins-field' }, h('span', { class: 'ts__label', id: ids.alignLabel, text: 'Выравнивание' }),
        h('div', { class: 'ts__tools', role: 'group', 'aria-labelledby': ids.alignLabel }, alignButtons)),
      h('div', { class: 'ins-field' }, h('label', { for: ids.color, text: 'Цвет' }),
        h('div', { class: 'ts__row' }, color,
          h('button', { type: 'button', class: 'btn btn--quiet btn--small', text: 'Как в макете', onclick: () => {
            if (stored().color !== undefined) setStyle('color', undefined);
            color.value = textDefaults(block, field).color;
          } }))),
      h('div', { class: 'ins-field' }, h('label', { for: ids.line, text: 'Межстрочный интервал (1–2,5)' }), line),
      h('div', { class: 'ins-actions' }, h('button', { type: 'button', class: 'btn btn--small ts__reset', text: 'Сбросить оформление этого текста', onclick: () => {
        if (block.textStyles && typeof block.textStyles === 'object' && Object.hasOwn(block.textStyles, field)) {
          delete block.textStyles[field];
          if (!Object.keys(block.textStyles).length) delete block.textStyles;
          edited();
        }
        renderInspector();
        ui.inspector.querySelector('.ts__reset')?.focus();
      } })));
  }
  /* «Название | подсказка» по строке → этапы. id сохраняется у этапа с той же подписью, иначе у этапа на той же
     позиции; новый id — stage-N без повторов. Пустые строки пропускаются. */
  function parseStages(text, previous) {
    const used = new Set(), out = [];
    const lines = String(text).split('\n').map((line) => line.trim()).filter(Boolean);
    lines.forEach((line, index) => {
      const cut = line.indexOf('|');
      const label = (cut >= 0 ? line.slice(0, cut) : line).trim(), hint = cut >= 0 ? line.slice(cut + 1).trim() : '';
      if (!label) return;
      const byLabel = previous.find((s) => s.label === label && !used.has(s.id));
      const byIndex = previous[index] && !used.has(previous[index].id) && !lines.some((l) => l.split('|')[0].trim() === previous[index].label) ? previous[index] : null;
      let id = (byLabel || byIndex || {}).id;
      if (!id) { let n = out.length + 1; do { id = `stage-${n}`; n += 1; } while (used.has(id) || previous.some((s) => s.id === id)); }
      used.add(id);
      out.push({ id, label, hint });
    });
    return out;
  }
  function frameInspector(frame, editing) {
    const section = h('section', { class: 'ins-card' },
      h('div', { class: 'ins-card__head' }, h('h2', { text: `Экран ${frame.id}` }), h('span', { class: 'muted', text: `${ROLES.find((r) => r.id === frame.role)?.label || frame.role} · ${frame.device === 'desktop' ? 'ПК' : 'телефон'}${frame.kind ? ` · ${frame.kind}` : ''}` })));
    if (!editing) {
      section.append(h('p', { class: 'ins-title', text: str(frame.title) }),
        h('p', { class: 'hint', text: 'Чтобы менять тексты, порядок блоков и решения, включите «Редактировать».' }));
    } else {
      section.append(textField('Название экрана', str(frame.title), (value) => { setFrameTitle(frame, value); edited({ sidebar: true }); }),
        textField('Название приложения (шапка всех экранов)', str(state.project.appTitle), (value) => { state.project.appTitle = value; edited(); }));
      section.append(freeLayoutInspector(frame));
      section.append(selectField('Оформление экрана', frame.presentation === 'celebration' ? 'celebration' : '', [['', 'Обычный экран'], ['celebration', 'Праздник · фото']], value => { frame.presentation = value; edited(); renderInspector(); }));
      if (frame.presentation === 'celebration') {
        section.append(textField('Надпись над заголовком', str(frame.eyebrow), value => { frame.eyebrow = value; edited(); }));
        for (let i = 0; i < Math.min(3, frame.categories?.length || 0); i++) {
          section.append(textField(`Категория ${i + 1}`, str(frame.categories[i].label), value => { frame.categories[i].label = value; edited(); }),
            selectField(`Иконка категории ${i + 1}`, str(frame.categories[i].icon || ['gift','heart','star'][i]), [['gift','Подарок'],['heart','Сердце'],['star','Звезда'],['birthday','Торт'],['baby','Коляска'],['event','Событие']], value => { frame.categories[i].icon = value; edited(); }),
            selectField(`Переход категории ${i + 1}`, str(frame.categories[i].target), [['', 'Не связано'], ...frames().filter(f => !f.hidden).map(f => [f.id, `${f.id} · ${f.title}`])], value => { frame.categories[i].target = value; edited(); }));
        }
      }
      section.append(h('button', { type: 'button', class: 'btn btn--small', text: 'Дублировать страницу', onclick: () => duplicateFrame(frame) }));
      section.append(selectField('Кому доступна страница', frame.role, ROLES.map((role) => [role.id, role.label]), (value) => {
        frame.role = value; for (const node of flow().nodes) if (node.frame === frame.id) node.role = value; edited({ sidebar: true }); renderInspector();
      }), selectField('Формат экрана', frame.device === 'desktop' ? 'desktop' : 'mobile', [['mobile', 'Телефон'], ['desktop', 'ПК']], (value) => {
        frame.device = value; state.showDesktop ||= value === 'desktop'; edited({ sidebar: true });
      }));
      const visible = menuItems(frame.role).some(([, id]) => id === frame.id);
      section.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: visible, onchange: (event) => {
        frame.menuVisible = event.target.checked;
        if (state.project.menus?.[frame.role]) editMenu(frame.role, (menu) => {
          const entries = menu.items.filter((item) => item.target === frame.id);
          for (const item of entries) item.hidden = !event.target.checked;
          if (event.target.checked && !entries.length) menu.items.push({ id: nextId(`menu:${frame.role}:item`), label: frame.menuLabel || frame.title, target: frame.id, hidden: false });
        });
        else edited();
      } }),
        h('span', { text: 'Показывать страницу в меню приложения' })),
        textField('Название пункта меню', str(state.project.menus?.[frame.role]?.items?.find((item) => item.target === frame.id)?.label ?? frame.menuLabel), (value) => {
          frame.menuLabel = value;
          if (state.project.menus?.[frame.role]) editMenu(frame.role, (menu) => { for (const item of menu.items) if (item.target === frame.id) item.label = value; });
          else edited();
        }),
        h('button', { type: 'button', class: 'btn btn--small', text: frame.hidden ? 'Вернуть страницу' : 'Убрать страницу', onclick: () => {
          frame.hidden = !frame.hidden; state.showRemoved ||= frame.hidden; edited({ sidebar: true }); renderInspector();
        } }));
    }
    const blocks = blocksOf(frame);
    const row = (block, ...kids) => {
      const li = h('li', { class: `ins-block${state.blockId === block.id && editing ? ' is-selected' : ''}${block.review === 'remove' ? ' is-removed' : ''}` },
        editing ? dragHandle(frame, block, 'ins-block__handle') : null, ...kids);
      if (editing) bindDrop(li, frame, block);
      return li;
    };
    const list = h('ol', { class: 'ins-blocks' }, blocks.map((block, index) => row(block,
      h('button', { type: 'button', class: 'ins-block__pick', disabled: !editing, onclick: () => selectBlock(block.id) },
        h('span', { class: 'ins-block__type', text: TYPE_LABEL[block.type] || block.type }),
        h('span', { class: 'ins-block__text', text: str(block.title || block.label || block.text || block.status || '') }),
        block.review && block.review !== 'pending' ? h('span', { class: `mark mark--${block.review}`, text: REVIEW_LABEL[block.review] }) : null,
        block.note ? h('span', { class: 'ins-block__note', text: `Заметка: ${str(block.note)}` }) : null),
      editing ? h('span', { class: 'ins-block__move' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Выше', text: '↑', disabled: index === 0, onclick: () => moveBlock(frame, index, -1) }),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Ниже', text: '↓', disabled: index === blocks.length - 1, onclick: () => moveBlock(frame, index, 1) })) : null)));
    section.append(h('h3', { class: 'ins-sub', text: `Блоки (${blocks.length})` }),
      ...(editing && blocks.length > 1 ? [h('p', { class: 'hint', text: 'Перетаскивайте блоки за ⋮⋮ (здесь или в превью); стрелки ↑↓ тоже работают.' })] : []),
      blocks.length ? list : h('p', { class: 'muted', text: 'Блоков нет.' }));
    if (editing) {
      const typeId = nextId('add');
      const type = h('select', { id: typeId }, Object.keys(NEW_BLOCK).map((key) => h('option', { value: key, selected: key === 'text', text: TYPE_LABEL[key] || key })));
      section.append(h('div', { class: 'ins-add' },
        h('label', { for: typeId, text: 'Добавить блок' }),
        h('div', { class: 'ins-add__row' }, type,
          h('button', { type: 'button', class: 'btn btn--small btn--main', text: 'Добавить', onclick: () => { const make = NEW_BLOCK[type.value]; if (make) addBlock(frame, make()); } }))));
    }
    return section;
  }
  function moveBlock(frame, index, delta) {
    const blocks = blocksOf(frame), to = index + delta;
    if (to < 0 || to >= blocks.length) return;
    [blocks[index], blocks[to]] = [blocks[to], blocks[index]];
    renderStage(); renderInspector(); changed();
  }
  function addBlock(frame, data) {
    const block = { id: nextId(`${frame.id}-b`), review: 'pending', note: '', ...data };
    blocksOf(frame).push(block);
    state.blockId = block.id;
    renderStage(); renderInspector(); renderSidebar(); changed();
  }
  function duplicateBlock(frame, original) {
    const block = JSON.parse(JSON.stringify(original)); block.id = nextId(`${frame.id}-b`); block.review = 'pending';
    blocksOf(frame).splice(blocksOf(frame).indexOf(original) + 1, 0, block);
    syncBlockEdge(frame, block); state.blockId = block.id;
    renderStage(); renderInspector(); renderSidebar(); changed(); toast('Копия блока добавлена рядом');
  }
  function duplicateFrame(original) {
    const frame = JSON.parse(JSON.stringify(original)); frame.id = nextFrameId(original.role); frame.title = `${original.title} · копия`; frame.menuVisible = false; frame.hidden = false;
    for (const block of frame.blocks) { block.id = nextId(`${frame.id}-b`); if (block.target === original.id) block.target = ''; }
    frames().splice(frames().indexOf(original) + 1, 0, frame);
    flow().nodes.push({ id: frame.id, frame: frame.id, role: frame.role, label: frame.title });
    for (const block of frame.blocks) syncBlockEdge(frame, block);
    state.showDesktop ||= frame.device === 'desktop'; openFrame(frame.id); changed(); toast('Страница скопирована вместе с блоками и оформлением');
  }
  function nodeInspector() {
    const node = state.nodeId ? nodeById(state.nodeId) : null;
    if (!node) {
      return h('section', { class: 'ins-card' }, h('h2', { text: 'Блок-схема' }),
        h('p', { class: 'hint', text: state.mode === 'edit' ? 'Нажмите на узел, чтобы изменить подпись, заметку и решение.' : 'Нажмите на узел с экраном, чтобы открыть его в просмотре.' }),
        h('p', { class: 'muted', text: `Узлов: ${flow().nodes.length}, связей: ${flow().edges.length}` }));
    }
    const frame = node.frame ? frameById(node.frame) : null;
    const section = h('section', { class: 'ins-card' },
      h('div', { class: 'ins-card__head' }, h('h2', { text: 'Узел схемы' }), h('span', { class: 'muted', text: node.id })));
    const editing = state.mode === 'edit';
    if (editing) {
      section.append(textField(frame ? `Подпись (= название экрана ${frame.id})` : 'Подпись', nodeLabel(node), (value) => {
        if (frame) setFrameTitle(frame, value); else node.label = value;
        const el = ui.stage.querySelector(`.node[data-node="${CSS.escape(node.id)}"] .node__label`);
        if (el) el.textContent = value || node.id;
        if (frame) renderSidebar();
        requestAnimationFrame(drawEdges);
        changed();
      }));
      if ('review' in node) section.append(selectField('Решение', node.review || 'pending', [['keep', 'Оставить'], ['change', 'Изменить'], ['remove', 'Убрать'], ['pending', 'Без решения']],
        (value) => { node.review = value; renderStage(); changed(); }));
      section.append(textField('Заметка', str(node.note), (value) => { node.note = value; changed(); }, { area: true }));
    } else {
      section.append(h('p', { class: 'ins-title', text: nodeLabel(node) }), node.note ? h('p', { class: 'ins-note', text: str(node.note) }) : null);
    }
    if (editing) section.append(transitionsEditor(node));
    const out = flow().edges.filter((edge) => (editing ? edge.to === node.id : edge.from === node.id || edge.to === node.id));
    if (out.length) {
      section.append(h('h3', { class: 'ins-sub', text: editing ? 'Входящие связи' : 'Связи' }), h('ul', { class: 'ins-edges' }, out.map((edge) => {
        const other = nodeById(edge.from === node.id ? edge.to : edge.from);
        return h('li', { text: `${edge.from === node.id ? '→' : '←'} ${other ? nodeLabel(other) || other.id : (edge.from === node.id ? edge.to : edge.from)}${edge.label ? ` (${str(edge.label)})` : ''}` });
      })));
    }
    if (frame) section.append(h('button', { type: 'button', class: 'btn btn--main', text: `Открыть экран ${frame.id}`, onclick: () => { state.mode = 'view'; openFrame(frame.id); if (narrow()) { state.pane = 'stage'; renderTop(); } } }));
    return section;
  }

  /* «Переходы» выбранного узла (только редактирование): исходящие связи — куда (существующий узел), подпись, удаление;
     добавление новой. Связь кнопки (blockId) меняет и сам переход кнопки: цель — только узел с экраном, подпись —
     надпись кнопки, удаление — пустой переход. Ручные связи — только схема. Ввод подписи не пересоздаёт поля. */
  function transitionsEditor(node) {
    const box = h('div', { class: 'ins-transitions' }, h('h3', { class: 'ins-sub', text: 'Переходы' }));
    const others = flow().nodes.filter((item) => item.id !== node.id);
    const optionsFor = (current) => {
      const options = others.map((item) => [item.id, `${nodeLabel(item) || item.id}${item.frame ? ` · ${item.frame}` : ''}`]);
      if (current && !options.some(([v]) => v === current)) options.unshift([current, `${current} (нет такого узла)`]);
      return options;
    };
    const outgoing = flow().edges.filter((edge) => edge.from === node.id);
    if (!outgoing.length) box.append(h('p', { class: 'muted', text: 'Исходящих переходов нет.' }));
    for (const edge of outgoing) {
      const owner = edge.blockId ? findBlock(edge.blockId) : null;
      const labelId = nextId('edge');
      box.append(h('div', { class: 'edge-row' },
        owner ? h('p', { class: 'edge-row__owner', text: `Переход блока «${blockEdgeLabel(owner.block) || TYPE_LABEL[owner.block.type] || owner.block.type}» на экране ${owner.frame.id}` }) : null,
        selectField('Куда', edge.to, optionsFor(edge.to), (value) => setEdgeTarget(edge, value)),
        h('div', { class: 'ins-field' }, h('label', { for: labelId, text: 'Подпись (например «Да» / «Нет»)' }),
          h('input', { id: labelId, type: 'text', value: str(edge.label), oninput: (event) => setEdgeLabel(edge, event.target.value) })),
        h('button', { type: 'button', class: 'btn btn--small btn--danger', text: 'Удалить связь', onclick: () => removeEdge(edge) })));
    }
    if (others.length) {
      const addId = nextId('edge');
      const target = h('select', { id: addId }, others.map((item) => h('option', { value: item.id, text: `${nodeLabel(item) || item.id}${item.frame ? ` · ${item.frame}` : ''}` })));
      box.append(h('div', { class: 'ins-add' }, h('label', { for: addId, text: 'Новый переход в' }),
        h('div', { class: 'ins-add__row' }, target, h('button', { type: 'button', class: 'btn btn--small btn--main', text: 'Добавить переход', onclick: () => addEdge(node.id, target.value) }))));
    }
    return box;
  }
  function edgeChanged({ inspector = true } = {}) {
    if (state.tab === 'flow') {
      const scroll = ui.stage.querySelector('.flow-scroll'), left = scroll?.scrollLeft || 0, top = scroll?.scrollTop || 0;
      renderStage(); const next = ui.stage.querySelector('.flow-scroll'); if (next) { next.scrollLeft = left; next.scrollTop = top; }
    } else requestAnimationFrame(drawEdges);
    if (inspector) renderInspector();
    changed();
  }
  function setEdgeTarget(edge, to) {
    const target = nodeById(to);
    if (!target) { toast('Такого узла нет на схеме.'); renderInspector(); return; }
    if (to === edge.from) { toast('Связь узла с самим собой не добавляется.'); renderInspector(); return; }
    const owner = edge.blockId ? findBlock(edge.blockId) : null;
    if (owner) {
      if (!target.frame || !frameById(target.frame)) { toast('Переход кнопки может вести только на узел с экраном.'); renderInspector(); return; }
      owner.block.target = target.frame;
    }
    edge.to = to;
    edgeChanged();
  }
  function setEdgeLabel(edge, value) {
    edge.label = value;
    const owner = edge.blockId ? findBlock(edge.blockId) : null;
    if (owner && owner.block.type === 'button') owner.block.label = value;
    if (owner && ['form', 'helpform'].includes(owner.block.type)) owner.block.submitLabel = value;
    if (owner) { const row = ui.stage.querySelector(`[data-route-block="${CSS.escape(owner.block.id)}"] .node-action__label`); if (row) row.textContent = blockEdgeLabel(owner.block); }
    requestAnimationFrame(drawEdges);   // только линии и подписи схемы: поле ввода остаётся тем же
    changed();
  }
  function removeEdge(edge) {
    const edges = flow().edges, index = edges.indexOf(edge);
    if (index < 0) return;
    const owner = edge.blockId ? findBlock(edge.blockId) : null;
    if (owner) owner.block.target = '';
    edges.splice(index, 1);
    edgeChanged();
  }
  function addEdge(from, to) {
    if (!nodeById(from) || !nodeById(to)) { toast('Выберите существующий узел.'); return; }
    if (from === to) { toast('Связь узла с самим собой не добавляется.'); return; }
    if (flow().edges.some((edge) => edge.from === from && edge.to === to && !edge.blockId)) { toast('Такой переход уже есть.'); return; }
    flow().edges.push({ from, to, label: '' });
    edgeChanged();
  }

  /* ---------- «Путь заказа»: 8 этапов сверху вниз × 3 роли (flow.journey, version 1) ----------
     Описательный вид одного заказа поверх существующей модели. В проекте хранится только flow.journey: тексты ячеек,
     ссылки на существующие экраны/блоки и типизированные описательные связи. flow.nodes/edges/layout, block.target,
     роли и устройства экранов здесь не меняются. Отсутствующий journey показывается стандартным и попадает в проект
     только первой реальной правкой (одна запись истории); неизвестная версия или повреждённые данные — только просмотр,
     без перезаписи. Цвета задаются типом связи, фильтры и выбор — только интерфейс этой страницы. Метки
     «Есть в приложении / Частично / Не настроено» — возможности опубликованного кода, не статус реального заказа. */
  const J_STAGES = [['request', 'Заявка'], ['work', 'В работе — беседа и подбор'], ['payment', 'Оплата'], ['photo', 'Фото перед отправкой'],
    ['transit', 'В пути'], ['delivered', 'Доставлено'], ['review', 'Фото и отзыв клиента'], ['reminder', 'Напомнить о ближайшей дате']];
  const J_ROLES = [['client', 'Клиент'], ['staff', 'Менеджер'], ['admin', 'Администратор']];
  const J_TYPES = [['button', 'Переход по кнопке', 'К'], ['form', 'Отправка / передача формы', 'Ф'], ['message', 'Сообщение / чат', 'С'], ['stage', 'Смена этапа / подтверждение', 'Э']];
  const J_TYPE = Object.fromEntries(J_TYPES.map(([id, label, letter]) => [id, { label, letter }]));
  const J_TYPE_COLOR = { button: '#2563c9', form: '#1f8a4c', message: '#7a45c2', stage: '#c2600e' };
  const J_STAGE_INDEX = Object.fromEntries(J_STAGES.map(([id], index) => [id, index]));
  const J_ROLE_INDEX = Object.fromEntries(J_ROLES.map(([id], index) => [id, index]));
  const J_STAGE_LABEL = Object.fromEntries(J_STAGES), J_ROLE_LABEL = Object.fromEntries(J_ROLES);
  const J_LIMIT = { action: 240, next: 160, label: 120, links: 3, edges: 120, bytes: 65536, depth: 12 };
  const J_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/, J_EDGE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/;
  // Те же запреты ключей, что у сервера (project-forms validateModel), чтобы описание пути никогда не ломало сохранение.
  const J_FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor', 'innerHTML', 'outerHTML', 'html', 'script', 'onclick', 'onerror', 'style', 'css']);
  const J_MULTI_FORBIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/, J_SINGLE_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f]/;
  const J_LEVEL = { works: 'Есть в приложении', partial: 'Частично', planned: 'Не настроено · план', none: 'Не настроено' };
  /* Факты возможностей согласованного выпуска схемы и приложения, не live-настройки и не статус заказа. По умолчанию в
     приложении 6 стадий, не 8: колонка «В приложении» показывает, чему соответствует этап схемы. */
  const J_FACTS = {
    request: { app: 'Новая заявка', cells: { client: ['works', ''], staff: ['works', ''], admin: ['works', ''] } },
    work: { app: 'Подтверждение связи с клиентом и согласования деталей', cells: { client: ['works', ''], staff: ['works', ''], admin: ['works', ''] } },
    payment: { app: 'Согласование и оплата; подтверждает менеджер', cells: { client: ['partial', 'Платёжной интеграции в приложении нет: оплату подтверждает менеджер.'],
      staff: ['works', 'Подтверждение вручную; платёжной интеграции нет.'], admin: ['works', ''] } },
    photo: { app: 'Готовим заказ; подтверждение отправки фото', cells: { client: ['works', 'Чат поддерживает вложения; фактическую доставку фото проверяют участники.'],
      staff: ['works', 'Чат поддерживает вложения; фактическую доставку фото проверяют участники.'], admin: ['works', ''] } },
    transit: { app: 'Часть общего этапа «Доставка / выдача»', cells: { client: ['partial', 'Отдельного этапа «В пути» нет.'],
      staff: ['partial', 'Отдельного этапа «В пути» нет: это часть «Доставка / выдача».'], admin: ['partial', 'Отдельного этапа «В пути» нет.'] } },
    delivered: { app: 'Подтверждение фактической передачи заказа', cells: { client: ['works', ''], staff: ['works', ''], admin: ['works', ''] } },
    review: { app: 'Отзыв запрошен; получение фото и отзыва проверяется отдельно', cells: { client: ['partial', 'Экран отзыва: «Отправка отзыва пока недоступна», поля и кнопки выключены.'],
      staff: ['partial', 'Отдельная форма отзыва не подключена; ответ и фото можно получить в чате.'], admin: ['none', 'Отдельного раздела собранных отзывов нет; переписка доступна в чате.'] } },
    reminder: { app: 'Нет поля даты, требования и планировщика', cells: {
      client: ['planned', 'Напоминаний о дате нет. Напоминание о молчании (5 мин) — другое. Схема не создаёт сообщений и таймеров.'],
      staff: ['planned', 'Поля ближайшей даты нет. Схема не создаёт сообщений и таймеров.'], admin: ['planned', 'Правила напоминаний нет. Схема не создаёт сообщений и таймеров.'] } },
  };
  // Стандартное наполнение. Отсутствующий блок сохраняет точную ссылку и показывается как отсутствующий, без подмены экраном.
  const J_DEFAULT_CELLS = [
    ['request', 'client', 'Оставляет заявку в форме «Поможем выбрать»', 'Продолжает разговор в чате заявки', [['K01', 'K01-b6']]],
    ['request', 'staff', 'Видит новую заявку в списке заказов и отвечает клиенту в чате', 'Уточнить повод, дату и бюджет', [['S02', 'S02-b1'], ['S05', 'S05-b1']]],
    ['request', 'admin', 'Видит все заявки в списке заказов', '', [['A02', 'A02-b1']]],
    ['work', 'client', 'Обсуждает повод, дату и варианты в чате', 'Согласовать состав и сумму', [['K07', 'K07-b1']]],
    ['work', 'staff', 'Ведёт беседу и подбор, подтверждает контакт и детали', 'Перевести заказ на этап «Оплата»', [['S05', 'S05-b1'], ['S04', 'S04-b2']]],
    ['work', 'admin', 'Видит переписку и статус заказа', '', [['A05', 'A05-b1']]],
    ['payment', 'client', 'Оплачивает заказ по договорённости с менеджером', 'Ждёт подтверждения оплаты', [['K06', 'K06-b1']]],
    ['payment', 'staff', 'Подтверждает оплату вручную', 'Собрать заказ и сфотографировать', [['S04', 'S04-b2']]],
    ['payment', 'admin', 'Видит статус оплаты', '', [['A04', 'A04-b2']]],
    ['photo', 'client', 'Получает фото заказа в чате', 'Подтвердить или попросить правку', [['K07', 'K07-b1']]],
    ['photo', 'staff', 'Отправляет фото перед отправкой в чат', 'Передать заказ в доставку', [['S05', 'S05-b1']]],
    ['photo', 'admin', 'Видит фото в истории чата', '', [['A05', 'A05-b1']]],
    ['transit', 'client', 'Видит статус «Доставка / выдача»', 'Получить заказ', [['K06', 'K06-b1']]],
    ['transit', 'staff', 'Отмечает передачу в доставку (этап «Доставка / выдача»)', 'Подтвердить вручение', [['S04', 'S04-b2']]],
    ['transit', 'admin', 'Видит статус заказа', '', [['A04', 'A04-b2']]],
    ['delivered', 'client', 'Получает заказ; история доступна после завершения заказа', 'Поделиться фото и отзывом', [['K06', 'K06-b1']]],
    ['delivered', 'staff', 'Подтверждает вручение', 'Запросить фото и отзыв', [['S04', 'S04-b2']]],
    ['delivered', 'admin', 'Видит подтверждение вручения в карточке заказа', '', [['A04', 'A04-b2']]],
    ['review', 'client', 'Видит запрос отзыва; отправить отзыв в приложении пока нельзя', '', [['K08']]],
    ['review', 'staff', 'Запрашивает фото и отзыв в чате', 'Узнать ближайшую дату клиента', [['S05', 'S05-b1']]],
    ['review', 'admin', 'Просмотр отзывов не настроен', '', []],
    ['reminder', 'client', 'Напоминание о ближайшей дате — запланировано', '', []],
    ['reminder', 'staff', 'Записать ближайшую дату клиента — поля даты нет', '', []],
    ['reminder', 'admin', 'Правило напоминания о дате — запланировано', '', [['A10']]],
  ];
  // [id, тип, откуда, куда, подпись, запланировано, экран, блок]
  const J_DEFAULT_EDGES = [
    ['j1', 'form', 'request.client', 'request.staff', 'Отправка формы подбора', false, 'K01', 'K01-b6'],
    ['j2', 'message', 'request.staff', 'work.client', 'Ответ менеджера в чате', false, 'S05', 'S05-b1'],
    ['j3', 'message', 'work.client', 'work.staff', 'Беседа и подбор в чате', false, 'K07', 'K07-b1'],
    ['j4', 'stage', 'work.staff', 'payment.staff', 'Этап «Оплата»', false, 'S04', 'S04-b2'],
    ['j5', 'message', 'payment.staff', 'payment.client', 'Сумма и способ оплаты в чате', false, 'S05', 'S05-b1'],
    ['j6', 'stage', 'payment.staff', 'photo.staff', 'Оплата подтверждена', false, 'S04', 'S04-b2'],
    ['j7', 'message', 'photo.staff', 'photo.client', 'Фото перед отправкой', false, 'S05', 'S05-b1'],
    ['j8', 'stage', 'photo.staff', 'transit.staff', 'Передано в доставку', false, 'S04', 'S04-b2'],
    ['j9', 'stage', 'transit.staff', 'transit.client', 'Статус виден клиенту', false, 'K06', 'K06-b1'],
    ['j10', 'stage', 'transit.staff', 'delivered.staff', 'Вручение подтверждено', false, 'S04', 'S04-b2'],
    ['j11', 'button', 'delivered.client', 'review.client', 'После завершения: кнопка «Оставить отзыв»', false, 'K05', 'K05-b2'],
    ['j12', 'message', 'delivered.staff', 'review.client', 'Запрос фото и отзыва', false, 'S05', 'S05-b1'],
    ['j13', 'form', 'review.client', 'review.staff', 'Отправка отзыва — пока недоступна', true, 'K08', ''],
    ['j14', 'stage', 'review.staff', 'reminder.staff', 'Записать ближайшую дату', true, '', ''],
    ['j15', 'stage', 'reminder.admin', 'reminder.staff', 'Правило напоминания', true, '', ''],
    ['j16', 'message', 'reminder.staff', 'reminder.client', 'Напоминание о ближайшей дате', true, '', ''],
  ];
  const jKey = (stage, role) => `${stage}.${role}`;
  const jParse = (key) => { const [stage, role] = String(key).split('.'); return { stage, role }; };
  function jPlain(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    if (Object.getOwnPropertySymbols(value).length) return false;
    return Object.getOwnPropertyNames(value).every((key) => { const d = Object.getOwnPropertyDescriptor(value, key); return d && 'value' in d && d.enumerable; });
  }
  // Ошибка текста или ''. Длина — в символах (code points); переносы строк только в многострочных полях.
  function jTextError(value, max, multi = false) {
    if (typeof value !== 'string') return 'не текст';
    if (Array.from(value).length > max) return `длиннее ${max} символов`;
    if ((multi ? J_MULTI_FORBIDDEN : J_SINGLE_FORBIDDEN).test(value)) return multi ? 'служебные символы не допускаются' : 'перенос строки и служебные символы не допускаются';
    return '';
  }
  const jRefError = (ref) => {
    if (!jPlain(ref) || typeof ref.frameId !== 'string' || !J_ID.test(ref.frameId)) return 'неверная ссылка на экран';
    if (ref.blockId !== undefined && (typeof ref.blockId !== 'string' || !J_ID.test(ref.blockId))) return 'неверная ссылка на блок';
    return '';
  };
  function jBadStructure(value, depth = 0) {
    if (depth > J_LIMIT.depth) return 'слишком глубокая вложенность';
    if (Array.isArray(value)) { for (const item of value) { const bad = jBadStructure(item, depth + 1); if (bad) return bad; } return ''; }
    if (value && typeof value === 'object') {
      if (!jPlain(value)) return 'не простой объект';
      for (const key of Object.keys(value)) {
        if (J_FORBIDDEN_KEYS.has(key) || /^on[a-z]+$/i.test(key)) return `запрещённый ключ «${key.slice(0, 40)}»`;
        const bad = jBadStructure(value[key], depth + 1); if (bad) return bad;
      }
      return '';
    }
    if (typeof value === 'number' && !Number.isFinite(value)) return 'неверное число';
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return 'неверное значение';
    return '';
  }
  /* Строгая проверка flow.journey. status: absent | ok | unsupported (новее v1) | invalid. Неизвестные дополнительные
     поля внутри v1 (метаданные будущих версий) сохраняются как есть; ошибки — только просмотр без перезаписи. */
  function normalizeJourney(raw) {
    if (raw === undefined) return { status: 'absent', view: journeyView(defaultJourneyData()) };
    const invalid = (message) => ({ status: 'invalid', error: message });
    if (!jPlain(raw)) return invalid('путь заказа — не объект');
    if (raw.version !== 1) return Number.isSafeInteger(raw.version) && raw.version > 1 ? { status: 'unsupported', version: raw.version } : invalid('неизвестная версия');
    const bad = jBadStructure(raw); if (bad) return invalid(bad);
    let bytes = 0;
    try { bytes = new TextEncoder().encode(JSON.stringify(raw)).length; } catch (_) { return invalid('данные не сериализуются'); }
    if (bytes > J_LIMIT.bytes) return invalid(`данные пути больше ${J_LIMIT.bytes} байт`);
    if (raw.cells !== undefined) {
      if (!jPlain(raw.cells)) return invalid('cells — не объект');
      for (const [stage, roles] of Object.entries(raw.cells)) {
        if (!Object.hasOwn(J_STAGE_INDEX, stage)) return invalid(`неизвестный этап «${stage.slice(0, 40)}»`);
        if (!jPlain(roles)) return invalid(`этап ${stage} — не объект`);
        for (const [role, cell] of Object.entries(roles)) {
          if (!Object.hasOwn(J_ROLE_INDEX, role)) return invalid(`неизвестная роль «${role.slice(0, 40)}»`);
          if (!jPlain(cell)) return invalid(`ячейка ${stage}.${role} — не объект`);
          for (const [field, max] of [['action', J_LIMIT.action], ['next', J_LIMIT.next]]) {
            if (cell[field] !== undefined) { const error = jTextError(cell[field], max, true); if (error) return invalid(`${stage}.${role}.${field}: ${error}`); }
          }
          if (cell.links !== undefined) {
            if (!Array.isArray(cell.links) || cell.links.length > J_LIMIT.links) return invalid(`${stage}.${role}: не больше ${J_LIMIT.links} форм`);
            for (const link of cell.links) { const error = jRefError(link); if (error) return invalid(`${stage}.${role}: ${error}`); }
          }
        }
      }
    }
    if (raw.edges !== undefined) {
      if (!Array.isArray(raw.edges) || raw.edges.length > J_LIMIT.edges) return invalid(`связей не больше ${J_LIMIT.edges}`);
      const ids = new Set();
      for (const edge of raw.edges) {
        if (!jPlain(edge) || typeof edge.id !== 'string' || !J_EDGE_ID.test(edge.id) || ids.has(edge.id)) return invalid('неверный или повторный id связи');
        ids.add(edge.id);
        if (!Object.hasOwn(J_TYPE, edge.type)) return invalid(`связь ${edge.id}: неизвестный тип`);
        for (const end of ['from', 'to']) {
          const point = edge[end];
          if (!jPlain(point) || !Object.hasOwn(J_STAGE_INDEX, point.stage) || !Object.hasOwn(J_ROLE_INDEX, point.role)) return invalid(`связь ${edge.id}: неверный конец ${end}`);
        }
        if (edge.from.stage === edge.to.stage && edge.from.role === edge.to.role) return invalid(`связь ${edge.id} ведёт сама в себя`);
        if (edge.label !== undefined) { const error = jTextError(edge.label, J_LIMIT.label); if (error) return invalid(`связь ${edge.id}: ${error}`); }
        if (edge.planned !== undefined && typeof edge.planned !== 'boolean') return invalid(`связь ${edge.id}: planned — не да/нет`);
        if (edge.frameId !== undefined && (typeof edge.frameId !== 'string' || !J_ID.test(edge.frameId))) return invalid(`связь ${edge.id}: неверный экран`);
        if (edge.blockId !== undefined && (typeof edge.blockId !== 'string' || !J_ID.test(edge.blockId) || edge.frameId === undefined)) return invalid(`связь ${edge.id}: неверный блок`);
      }
    }
    return { status: 'ok', view: journeyView(raw) };
  }
  // Вид для отрисовки: только проверенные поля; отсутствующая ячейка — пустая.
  function journeyView(data) {
    const cells = {};
    for (const [stage] of J_STAGES) {
      cells[stage] = {};
      for (const [role] of J_ROLES) {
        const cell = data.cells?.[stage]?.[role] || {};
        cells[stage][role] = { action: str(cell.action), next: str(cell.next),
          links: (Array.isArray(cell.links) ? cell.links : []).map((link) => ({ frameId: link.frameId, blockId: link.blockId || '' })) };
      }
    }
    const edges = (Array.isArray(data.edges) ? data.edges : []).map((edge, index) => ({ id: edge.id, number: index + 1, type: edge.type,
      from: { stage: edge.from.stage, role: edge.from.role }, to: { stage: edge.to.stage, role: edge.to.role }, label: str(edge.label),
      planned: edge.planned === true, frameId: str(edge.frameId), blockId: str(edge.blockId) }));
    return { cells, edges };
  }
  function defaultJourneyData() {
    const ref = (frameId, blockId) => {
      const frame = frameId ? frameById(frameId) : null;
      if (!frame) return null;
      return { frameId, ...(blockId ? { blockId } : {}) };
    };
    const cells = {};
    for (const [stage] of J_STAGES) cells[stage] = {};
    for (const [stage, role, action, next, links] of J_DEFAULT_CELLS) cells[stage][role] = { action, next, links: links.map(([f, b]) => ref(f, b)).filter(Boolean) };
    const edges = J_DEFAULT_EDGES.map(([id, type, from, to, label, planned, frameId, blockId]) => {
      const target = ref(frameId, blockId);
      return { id, type, from: jParse(from), to: jParse(to), label, ...(planned ? { planned: true } : {}), ...(target || {}) };
    });
    return { version: 1, cells, edges };
  }
  const journeyRaw = () => (state.project?.flow && typeof state.project.flow === 'object' && Object.hasOwn(state.project.flow, 'journey') ? state.project.flow.journey : undefined);
  const journeyInfo = () => normalizeJourney(journeyRaw());
  const journeyEditable = (info = journeyInfo()) => Boolean(state.project) && state.mode === 'edit' && !state.conflict && !state.authLocked && (info.status === 'ok' || info.status === 'absent');
  /* Единственный путь записи: правка применяется к копии (стандартной, если journey ещё нет), копия проверяется целиком,
     затем заменяет flow.journey и даёт ровно один changed() — одну запись Undo/Redo и одно автосохранение. */
  function journeyEdit(mutate, { stage = true, inspector = false } = {}) {
    const info = journeyInfo();
    if (!journeyEditable(info)) return false;
    const draft = info.status === 'absent' ? defaultJourneyData() : JSON.parse(JSON.stringify(journeyRaw()));
    if (mutate(draft) === false) return false;
    const check = normalizeJourney(draft);
    if (check.status !== 'ok') { toast(`Правка не сохранена: ${check.error || 'данные не прошли проверку'}`); return false; }
    flow().journey = draft;
    if (stage) renderStage();
    if (inspector) renderInspector();
    changed();
    return true;
  }
  function jCellOf(data, key) {
    const { stage, role } = jParse(key);
    if (!jPlain(data.cells)) data.cells = {};
    if (!jPlain(data.cells[stage])) data.cells[stage] = {};
    if (!jPlain(data.cells[stage][role])) data.cells[stage][role] = {};
    return data.cells[stage][role];
  }
  const jEdgeOf = (data, id) => (Array.isArray(data.edges) ? data.edges.find((edge) => edge.id === id) : null) || null;
  const jPointLabel = (point) => `${J_STAGE_INDEX[point.stage] + 1} · ${J_STAGE_LABEL[point.stage]} · ${J_ROLE_LABEL[point.role]}`;
  const jVisible = (edge) => state.journeyFilter[edge.type] !== false;

  // Мини-карточка связанной формы: что это за экран/блок и честная пометка, если отправка не подключена.
  function jFormSummary(link) {
    const frame = frameById(link.frameId);
    if (!frame) return { missing: true, title: `Экран ${link.frameId} не найден`, meta: '', warn: '' };
    const block = link.blockId ? blockById(frame, link.blockId) : null;
    const title = `${frame.id} · ${str(frame.title) || 'Без названия'}`;
    if (link.blockId && !block) return { missing: true, title, meta: `Блок ${link.blockId} не найден`, warn: '' };
    let meta = '', warn = '';
    const fieldLabels = (fields) => (Array.isArray(fields) ? fields : []).filter((field) => field && !field.hidden).map((field) => str(field.label) || field.id);
    if (block) {
      const type = TYPE_LABEL[block.type] || block.type;
      if (block.type === 'helpform') {
        const hidden = new Set(Array.isArray(block.hiddenParts) ? block.hiddenParts : []);
        const base = [['name', block.nameLabel ?? 'Имя'], ['channel', block.messengerLabel ?? 'Канал связи'], ['contact', block.contactLabel ?? 'Контакт']]
          .filter(([part]) => !hidden.has(part) && !(block.phoneOnly === true && part === 'channel')).map(([, label]) => str(label));
        meta = `${type}: ${base.join(' · ')}`;
        if (fieldLabels(block.fields).length) warn = block.phoneOnly === true
          ? 'Включён режим «Только имя и телефон»: дополнительные поля скрыты и не отправляются.'
          : 'Ответы в дополнительных полях сохраняются в комментарии заявки для менеджера.';
        if (hidden.has('name') || hidden.has('contact') || block.nameRequired === false || block.contactRequired === false)
          warn += `${warn ? ' ' : ''}Для отправки заявки имя и контакт обязательны: скрытое поле нужно вернуть.`;
      } else if (block.type === 'form' || block.type === 'input') {
        const labels = block.type === 'form' ? fieldLabels(block.fields) : [str(block.label)];
        meta = `${type}${labels.filter(Boolean).length ? `: ${labels.filter(Boolean).join(' · ')}` : ''}`;
        warn = 'Не подключена: у отдельной формы/поля нет отправки в приложении.';
      } else if (block.type === 'status') { const values = (Array.isArray(block.values) ? block.values : []).slice(0, 3).map(str).filter(Boolean); meta = values.length ? `${type}: ${values.join(' · ')}` : type; }
      else meta = `${type}: ${blockEdgeLabel(block) || str(block.title) || block.id}`;
    } else {
      const types = [...new Set(blocksOf(frame).map((item) => TYPE_LABEL[item.type] || item.type))];
      meta = `Экран: ${types.slice(0, 4).join(', ') || 'без блоков'}`;
      if (blocksOf(frame).some((item) => item.type === 'form' || item.type === 'input')) warn = 'Не подключена: поля ввода этого экрана не отправляются в приложении.';
    }
    if (frame.hidden) warn = `${warn ? `${warn} ` : ''}Экран убран из списка.`;
    return { missing: false, title, meta: Array.from(meta).slice(0, 110).join(''), warn };
  }

  let journeyObserver = null, jDrag = null, jPortGuardUntil = 0, jHoverId = null;
  function jFlowViewSwitch() {
    const option = (view, label) => h('button', { type: 'button', class: `flow-view__btn${state.flowView === view ? ' is-active' : ''}`, 'aria-pressed': String(state.flowView === view),
      dataset: { flowView: view }, text: label, onclick: () => setFlowView(view) });
    return h('div', { class: 'flow-view', role: 'group', 'aria-label': 'Вид блок-схемы' }, option('journey', 'Путь заказа'), option('screens', 'Экраны и переходы'));
  }
  function setFlowView(view) {
    if (state.flowView === view) return;
    jCancel(false);
    state.flowView = view; state.nodeId = null; state.menuRole = null; state.newNode = null;
    if (view === 'journey') enterJourney();
    renderAll();
  }
  // Вход в «Путь заказа» на ПК: список экранов временно сворачивается ради ширины схемы. Сохранённые настройки панелей не меняются.
  function enterJourney() {
    state.menuRole = null;
    state.journeyTempLeft = !narrow() && panels.left.open && window.innerWidth < 1680;
  }
  const journeyLeftHidden = () => Boolean(state.journeyTempLeft) && state.tab === 'flow' && state.flowView === 'journey' && !narrow();

  function renderJourney() {
    const info = journeyInfo();
    const view = info.view || journeyView({});
    const editable = journeyEditable(info);
    if (state.journeySel?.kind === 'edge' && !view.edges.some((edge) => edge.id === state.journeySel.id)) state.journeySel = null;
    const counts = Object.fromEntries(J_TYPES.map(([type]) => [type, view.edges.filter((edge) => edge.type === type).length]));
    const legend = h('div', { class: 'journey-legend', role: 'group', 'aria-label': 'Типы связей' },
      J_TYPES.map(([type, label, letter]) => h('label', { class: `journey-legend__item jtype--${type}`, dataset: { journeyFilter: type } },
        h('input', { type: 'checkbox', checked: state.journeyFilter[type] !== false, onchange: (event) => {
          state.journeyFilter[type] = event.target.checked;   // только вид: модель, формы и сохранение не трогаются
          jRefreshEdges();
        } }),
        h('span', { class: 'journey-legend__swatch', 'aria-hidden': 'true', text: letter }),
        h('span', { text: label }), h('span', { class: 'journey-legend__count', text: `(${counts[type]})` }))),
      h('span', { class: 'journey-legend__note' }, h('span', { class: 'journey-legend__dash', 'aria-hidden': 'true' }), 'пунктир — запланировано · ● начало · ▶ конец'));
    const notes = [];
    if (info.status === 'unsupported') notes.push(h('p', { class: 'journey-note journey-note--error', role: 'alert', text: `Путь заказа сохранён в версии ${info.version}, этот редактор знает только версию 1. Показан только просмотр; сохранённые данные не перезаписываются.` }));
    if (info.status === 'invalid') notes.push(h('p', { class: 'journey-note journey-note--error', role: 'alert', text: `Сохранённый путь заказа не прошёл проверку (${info.error}). Правка выключена, данные не перезаписываются.` }));
    const tools = h('div', { class: 'journey-tools' }, jFlowViewSwitch(), legend,
      editable ? h('label', { class: 'journey-newtype' }, h('span', { text: 'Новая связь:' }),
        h('select', { dataset: { journeyNewType: '' }, onchange: (event) => { state.jNewType = event.target.value; } },
          J_TYPES.map(([type, label]) => h('option', { value: type, selected: state.jNewType === type, text: label })))) : null);
    // Одна строка пояснений: что это за метки, сохранён ли путь, как править; кнопка возврата временно скрытого списка.
    const help = h('p', { class: 'journey-note', dataset: { journeyHelp: info.status } },
      h('span', { text: [
        info.status === 'absent' ? 'Стандартный путь: в проект попадёт только после первой вашей правки.' : '',
        'Метки — возможности опубликованного приложения, не статус заказа; связи с реальными заявками нет.',
        editable ? 'Потяните ● на другую карточку — описательная связь (Esc — отмена).' : info.view ? 'Править — в режиме «Редактировать».' : '',
      ].filter(Boolean).join(' ') }),
      journeyLeftHidden() ? h('button', { type: 'button', class: 'btn btn--quiet btn--small', dataset: { journeyShowList: '' }, text: 'Показать список экранов',
        onclick: () => { state.journeyTempLeft = false; applyPanels(); } }) : null);

    const board = h('div', { class: `journey${editable ? ' is-editable' : ''}`, dataset: { journeyStatus: info.status } });
    const place = (el, row, column) => { el.style.gridRow = String(row); el.style.gridColumn = String(column); return el; };
    board.append(place(h('div', { class: 'journey__colhead journey__colhead--rail', text: 'Этап' }), 1, 1));
    J_ROLES.forEach(([, label], index) => board.append(place(h('div', { class: 'journey__colhead', text: label }), 1, 3 + index * 2)));
    J_STAGES.forEach(([stage, title], index) => {
      const fact = J_FACTS[stage];
      board.append(place(h('div', { class: 'journey__rail', dataset: { journeyStage: stage } },
        h('span', { class: 'journey__num', text: String(index + 1) }), h('span', { class: 'journey__stage', title: `В приложении: ${fact.app}`, text: title })), 3 + index * 2, 1));
      J_ROLES.forEach(([role], column) => board.append(place(jCell(view, stage, role, editable), 3 + index * 2, 3 + column * 2)));
    });
    board.append(h('div', { class: 'journey__pill', hidden: true, 'aria-hidden': 'true' }));
    const lines = svg('svg', { class: 'journey__svg', 'aria-hidden': 'true' });
    board.prepend(lines);
    return h('div', { class: 'flow-wrap journey-wrap' }, tools, ...notes, help,
      h('div', { class: 'journey-scroll', tabindex: '-1' }, board));
  }

  function jCell(view, stage, role, editable) {
    const key = jKey(stage, role), cell = view.cells[stage][role];
    const [level, note] = J_FACTS[stage].cells[role];
    const sel = state.journeySel;
    const selected = sel?.kind === 'cell' && sel.key === key;
    const out = view.edges.filter((edge) => jKey(edge.from.stage, edge.from.role) === key);
    const forms = cell.links.length ? cell.links.map((link) => {
      const summary = jFormSummary(link);
      return h('div', { class: `jform${summary.missing ? ' is-missing' : ''}`, dataset: { jformFrame: link.frameId, jformBlock: link.blockId || '' } },
        h('span', { class: 'jform__title', text: summary.title }),
        summary.meta ? h('span', { class: 'jform__meta', text: summary.meta }) : null,
        summary.warn ? h('span', { class: 'jform__warn', text: summary.warn }) : null,
        summary.missing ? h('span', { class: 'jform__warn', text: 'Не настроено' }) : h('button', { type: 'button', class: 'btn btn--small jform__open', dataset: { journeyOpen: '' },
          text: 'Открыть форму', onclick: (event) => { if (state.jConnect) return; event.stopPropagation(); openJourneyLink(link, key); } }));
    }) : [h('div', { class: 'jform jform--empty' }, h('span', { class: 'jform__warn', text: 'Не настроено' }),
      editable ? h('button', { type: 'button', class: 'btn btn--quiet btn--small', text: 'Выбрать форму', onclick: (event) => {
        if (state.jConnect) return;   // в режиме «выберите карточку» нажатие завершает связь через карточку
        event.stopPropagation(); jSelect({ kind: 'cell', key }); ui.inspector.querySelector('[data-journey-add-link]')?.focus();
      } }) : null)];
    const el = h('article', { class: `jcell jcell--${level}${selected ? ' is-selected' : ''}`, tabindex: '0', role: 'group',
      'aria-label': `Этап ${J_STAGE_INDEX[stage] + 1} · ${J_STAGE_LABEL[stage]} · ${J_ROLE_LABEL[role]}`, dataset: { jcell: key },
      onclick: (event) => {
        if (state.jConnect) { event.preventDefault(); event.stopPropagation(); jFinishConnect(key); return; }
        if (event.target.closest('button, a, input, select, textarea')) return;
        jSelect({ kind: 'cell', key });
      },
      onkeydown: (event) => {
        if (event.target !== el || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        if (state.jConnect) jFinishConnect(key); else jSelect({ kind: 'cell', key });
      } },
      h('div', { class: 'jcell__head' }, h('span', { class: 'jcell__who', text: `Отвечает: ${J_ROLE_LABEL[role]}` }),
        h('span', { class: `jlevel jlevel--${level}`, title: note || J_LEVEL[level], text: J_LEVEL[level] })),
      h('p', { class: `jcell__action${cell.action ? '' : ' is-empty'}`, text: cell.action || 'Действие не описано' }),
      h('div', { class: 'jcell__forms' }, forms),
      cell.next ? h('p', { class: 'jcell__next' }, h('span', { class: 'jcell__next-k', text: 'Дальше: ' }), cell.next) : null,
      out.length ? h('ul', { class: 'jcell__edges', 'aria-label': 'Связи отсюда' }, out.map((edge) => h('li', { class: `jchip jtype--${edge.type}${edge.planned ? ' is-planned' : ''}`, hidden: !jVisible(edge), dataset: { jchip: edge.id } },
        h('button', { type: 'button', class: 'jchip__btn', title: 'Выбрать связь', onclick: (event) => { event.stopPropagation(); if (state.jConnect) { jFinishConnect(key); return; } jSelect({ kind: 'edge', id: edge.id }); } },
          h('span', { class: 'jchip__no', text: `${J_TYPE[edge.type].letter}${edge.number}` }),
          h('span', { text: `→ ${J_ROLE_LABEL[edge.to.role]}${edge.to.stage !== stage ? ` · этап ${J_STAGE_INDEX[edge.to.stage] + 1}` : ''}: ${edge.planned ? 'запланировано · ' : ''}${edge.label || J_TYPE[edge.type].label}` }))))) : null);
    if (editable) {
      const port = h('button', { type: 'button', class: 'jport', dataset: { jport: key }, 'aria-label': `Провести связь от «${J_STAGE_LABEL[stage]} · ${J_ROLE_LABEL[role]}»`, title: 'Потяните к другой карточке',
        text: '●', onclick: (event) => {
          event.stopPropagation();
          if (Date.now() < jPortGuardUntil) return;
          if (state.jConnect?.from === key) { jCancel(); return; }
          if (state.jConnect) { jFinishConnect(key); return; }
          jStartConnect(key);
        } });
      port.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || state.jConnect) return;
        event.preventDefault(); event.stopPropagation();
        jDrag = { from: key, pointer: event.pointerId, x0: event.clientX, y0: event.clientY, x: event.clientX, y: event.clientY, moved: false };
        el.classList.add('is-connect-source');
      });
      el.append(port);
    }
    return el;
  }

  function jSelect(sel) {
    state.journeySel = sel;
    const board = ui.stage.querySelector('.journey');
    if (board) for (const el of board.querySelectorAll('[data-jcell]')) el.classList.toggle('is-selected', sel?.kind === 'cell' && sel.key === el.dataset.jcell);
    jRefreshEdges();
    renderInspector();
    if (narrow() && sel) { state.pane = 'inspector'; renderTop(); }
  }
  function jRefreshEdges() {
    const board = ui.stage.querySelector('.journey');
    if (!board) return;
    const view = journeyInfo().view;
    for (const chip of board.querySelectorAll('[data-jchip]')) {
      const edge = view?.edges.find((item) => item.id === chip.dataset.jchip);
      chip.hidden = !edge || !jVisible(edge);
    }
    drawJourney();
  }
  function jStartConnect(key) {
    if (!journeyEditable()) return;
    state.jConnect = { from: key };
    const board = ui.stage.querySelector('.journey');
    board?.classList.add('is-connecting');
    board?.querySelector(`[data-jcell="${CSS.escape(key)}"]`)?.classList.add('is-connect-source');
    toast('Выберите карточку, куда ведёт связь. Esc — отмена.');
  }
  function jFinishConnect(target) {
    const from = state.jConnect?.from;
    jCancel(false);
    if (!from) return;
    if (from === target) { toast('Связь карточки с самой собой не создаётся.'); drawJourney(); return; }
    jCreateEdge(from, target);
  }
  function jCancel(redraw = true) {
    const had = Boolean(jDrag || state.jConnect);
    jDrag = null; state.jConnect = null;
    const board = ui.stage.querySelector('.journey');
    board?.classList.remove('is-connecting');
    for (const el of ui.stage.querySelectorAll('.is-connect-source, .is-drop-target')) el.classList.remove('is-connect-source', 'is-drop-target');
    board?.querySelector('.jdraft')?.remove();
    if (redraw && had) drawJourney();
    return had;
  }
  function jCreateEdge(fromKey, toKey) {
    const type = Object.hasOwn(J_TYPE, state.jNewType) ? state.jNewType : 'message';
    const id = nextId('je');
    const saved = journeyEdit((data) => {
      if (!Array.isArray(data.edges)) data.edges = [];
      data.edges.push({ id, type, from: jParse(fromKey), to: jParse(toKey), label: J_TYPE[type].label });
    }, { stage: false });
    if (!saved) { drawJourney(); return; }
    state.journeySel = { kind: 'edge', id };
    renderStage(); renderInspector();
    toast(`Связь добавлена: ${jPointLabel(jParse(fromKey))} → ${jPointLabel(jParse(toKey))}`);
  }
  document.addEventListener('pointermove', (event) => {
    if (!jDrag || event.pointerId !== jDrag.pointer) return;
    if (!jDrag.moved && Math.hypot(event.clientX - jDrag.x0, event.clientY - jDrag.y0) < 5) return;
    jDrag.moved = true; jDrag.x = event.clientX; jDrag.y = event.clientY;
    event.preventDefault();
    const scroll = ui.stage.querySelector('.journey-scroll');
    if (scroll) {
      const r = scroll.getBoundingClientRect();
      if (event.clientY > r.bottom - 40) scroll.scrollTop += 16; else if (event.clientY < r.top + 40) scroll.scrollTop -= 16;
      if (event.clientX > r.right - 40) scroll.scrollLeft += 16; else if (event.clientX < r.left + 40) scroll.scrollLeft -= 16;
    }
    const over = document.elementFromPoint?.(event.clientX, event.clientY)?.closest?.('[data-jcell]');
    for (const el of ui.stage.querySelectorAll('.is-drop-target')) if (el !== over) el.classList.remove('is-drop-target');
    if (over && over.dataset.jcell !== jDrag.from) over.classList.add('is-drop-target');
    jDrawDraft();
  }, { passive: false });
  document.addEventListener('pointerup', (event) => {
    if (!jDrag || event.pointerId !== jDrag.pointer) return;
    const drag = jDrag; jDrag = null;
    jPortGuardUntil = Date.now() + 350;
    if (!drag.moved) {   // простое нажатие на ● — режим «выберите карточку» (и для клавиатуры)
      ui.stage.querySelector('.is-connect-source')?.classList.remove('is-connect-source');
      jStartConnect(drag.from); return;
    }
    const target = document.elementFromPoint?.(event.clientX, event.clientY)?.closest?.('[data-jcell]');
    jCancel(false);
    if (target && target.dataset.jcell !== drag.from) jCreateEdge(drag.from, target.dataset.jcell);
    else { drawJourney(); toast('Связь не создана: отпустите линию на другой карточке.'); }
  });
  document.addEventListener('pointercancel', (event) => { if (jDrag && event.pointerId === jDrag.pointer) jCancel(); });
  window.addEventListener('blur', () => { if (jDrag) jCancel(); });

  /* Ортогональные линии по коридорам между колонками и этапами: вертикальные отрезки — только в промежутках между
     колонками, горизонтальные переходы через колонку — только в промежутках между этапами, поэтому линии не идут поверх
     полей и кнопок. Маршруты считаются из положения карточек и нигде не сохраняются. */
  function drawJourney() {
    const board = ui.stage.querySelector('.journey');
    if (!board || !state.project) return;
    const lines = board.querySelector('.journey__svg');
    const info = journeyInfo();
    const view = info.view || { edges: [] };
    const base = board.getBoundingClientRect();
    const rel = (el) => { const r = el.getBoundingClientRect(); return { left: r.left - base.left, right: r.right - base.left, top: r.top - base.top, bottom: r.bottom - base.top }; };
    lines.replaceChildren();
    lines.setAttribute('width', String(board.scrollWidth)); lines.setAttribute('height', String(board.scrollHeight));
    const defs = svg('defs');
    for (const [type] of J_TYPES) {
      const marker = svg('marker', { id: `jarrow-${type}`, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '11', markerHeight: '11', orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' });
      marker.append(svg('path', { d: 'M0,0 L10,5 L0,10 z', fill: J_TYPE_COLOR[type] }));
      defs.append(marker);
    }
    lines.append(defs);
    const cells = new Map([...board.querySelectorAll('[data-jcell]')].map((el) => [el.dataset.jcell, rel(el)]));
    if (cells.size < J_STAGES.length * J_ROLES.length) return;
    const col = J_ROLES.map(([role]) => cells.get(jKey('request', role)));
    const gap = Math.max(16, col[1].left - col[0].right);
    const vCorr = [[col[0].left - gap, col[0].left], [col[0].right, col[1].left], [col[1].right, col[2].left], [col[2].right, col[2].right + gap]];
    const rows = J_STAGES.map(([stage]) => { const r = J_ROLES.map(([role]) => cells.get(jKey(stage, role))); return { top: Math.min(...r.map((x) => x.top)), bottom: Math.max(...r.map((x) => x.bottom)) }; });
    const hGap = rows.length > 1 ? Math.max(14, rows[1].top - rows[0].bottom) : 30;
    const hCorr = rows.map((row, index) => [index ? rows[index - 1].bottom : row.top - hGap, row.top]).concat([[rows[rows.length - 1].bottom, rows[rows.length - 1].bottom + hGap]]);
    const visible = view.edges.filter(jVisible);
    // План маршрута: сторона выхода/входа, вертикальные коридоры и (для перехода через колонку) горизонтальный коридор.
    const plans = visible.map((edge) => {
      const r1 = J_STAGE_INDEX[edge.from.stage], c1 = J_ROLE_INDEX[edge.from.role], r2 = J_STAGE_INDEX[edge.to.stage], c2 = J_ROLE_INDEX[edge.to.role];
      let exit, entry, ve, vt;
      if (c2 > c1) { exit = 'right'; ve = c1 + 1; entry = 'left'; vt = c2; }
      else if (c2 < c1) { exit = 'left'; ve = c1; entry = 'right'; vt = c2 + 1; }
      else { exit = 'right'; ve = c1 + 1; entry = 'right'; vt = c1 + 1; }
      const hk = ve === vt ? null : r2 > r1 ? r2 : r2 < r1 ? r2 + 1 : r1 + 1;
      return { edge, r1, c1, r2, c2, exit, entry, ve, vt, hk, from: jKey(edge.from.stage, edge.from.role), to: jKey(edge.to.stage, edge.to.role) };
    });
    // Точки на сторонах карточек: распределены сверху вниз, порядок — по положению второго конца.
    const sides = new Map();
    const attach = (key, side, plan, end, order) => { const id = `${key}|${side}`; if (!sides.has(id)) sides.set(id, []); sides.get(id).push({ plan, end, order }); };
    for (const plan of plans) { attach(plan.from, plan.exit, plan, 'start', plan.r2 * 10 + plan.c2); attach(plan.to, plan.entry, plan, 'end', plan.r1 * 10 + plan.c1); }
    for (const [id, list] of sides) {
      const [key] = id.split('|'), rect = cells.get(key);
      list.sort((a, b) => a.order - b.order || a.plan.edge.number - b.plan.edge.number);
      const room = Math.max(10, rect.bottom - rect.top - 30 - 46), step = list.length > 1 ? Math.min(18, room / (list.length - 1)) : 0;
      list.forEach((item, index) => { item.plan[item.end === 'start' ? 'sy' : 'ty'] = rect.top + 30 + index * step; });
    }
    for (const plan of plans) {
      const a = cells.get(plan.from), b = cells.get(plan.to);
      plan.sx = plan.exit === 'right' ? a.right : a.left; plan.tx = plan.entry === 'right' ? b.right : b.left;
    }
    // Полосы внутри коридоров: отрезки, которые не пересекаются по длине, делят одну полосу.
    const lanes = (items, start, end, keyOf) => {
      const groups = new Map();
      for (const item of items) { const k = keyOf(item); if (k === null) continue; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(item); }
      for (const [k, list] of groups) {
        list.sort((x, y) => start(x) - start(y));
        const ends = [];
        for (const item of list) {
          let lane = ends.findIndex((last) => last < start(item) - 8);
          if (lane < 0) { lane = ends.length; ends.push(0); }
          ends[lane] = end(item); item.lane = item.lane || {}; item.lane[k] = lane;
        }
        for (const item of list) { item.laneCount = item.laneCount || {}; item.laneCount[k] = ends.length; }
      }
    };
    const vItems = [];
    for (const plan of plans) {
      if (plan.ve === plan.vt) vItems.push({ plan, corr: `v${plan.ve}`, y1: Math.min(plan.sy, plan.ty), y2: Math.max(plan.sy, plan.ty) });
      else {
        const hy = hCorr[plan.hk][0] + (hCorr[plan.hk][1] - hCorr[plan.hk][0]) / 2;
        vItems.push({ plan, corr: `v${plan.ve}`, y1: Math.min(plan.sy, hy), y2: Math.max(plan.sy, hy), part: 'exit' });
        vItems.push({ plan, corr: `v${plan.vt}`, y1: Math.min(plan.ty, hy), y2: Math.max(plan.ty, hy), part: 'entry' });
      }
    }
    lanes(vItems, (item) => item.y1, (item) => item.y2, (item) => item.corr);
    const hItems = plans.filter((plan) => plan.hk !== null).map((plan) => {
      const xa = vCorr[plan.ve][0], xb = vCorr[plan.vt][0];
      return { plan, corr: `h${plan.hk}`, x1: Math.min(xa, xb), x2: Math.max(xa, xb) };
    });
    lanes(hItems, (item) => item.x1, (item) => item.x2, (item) => item.corr);
    const laneX = (item) => {
      const [left, right] = vCorr[Number(item.corr.slice(1))], n = item.laneCount[item.corr], i = item.lane[item.corr];
      const step = n > 1 ? Math.min(9, (right - left - 12) / (n - 1)) : 0;
      return left + (right - left) / 2 + (i - (n - 1) / 2) * step;
    };
    const laneY = (item) => {
      const [top, bottom] = hCorr[Number(item.corr.slice(1))], n = item.laneCount[item.corr], i = item.lane[item.corr];
      const step = n > 1 ? Math.min(7, (bottom - top - 8) / (n - 1)) : 0;
      return top + (bottom - top) / 2 + (i - (n - 1) / 2) * step;
    };
    const sel = state.journeySel?.kind === 'edge' ? state.journeySel.id : null;
    const badges = [];
    const groups = [];
    for (const plan of plans) {
      const own = vItems.filter((item) => item.plan === plan);
      let d, segment;
      if (plan.ve === plan.vt) {
        const x = laneX(own[0]);
        d = `M${plan.sx},${plan.sy} H${x} V${plan.ty} H${plan.tx}`;
        segment = { x, y1: own[0].y1, y2: own[0].y2 };
      } else {
        const hItem = hItems.find((item) => item.plan === plan), y = laneY(hItem);
        const x1 = laneX(own.find((item) => item.part === 'exit')), x2 = laneX(own.find((item) => item.part === 'entry'));
        d = `M${plan.sx},${plan.sy} H${x1} V${y} H${x2} V${plan.ty} H${plan.tx}`;
        const first = { x: x1, y1: Math.min(plan.sy, y), y2: Math.max(plan.sy, y) }, last = { x: x2, y1: Math.min(plan.ty, y), y2: Math.max(plan.ty, y) };
        segment = last.y2 - last.y1 >= first.y2 - first.y1 ? last : first;
      }
      const { edge } = plan;
      const group = svg('g', { class: `jedge jtype--${edge.type}${edge.planned ? ' is-planned' : ''}${sel === edge.id ? ' is-selected' : ''}${sel && sel !== edge.id ? ' is-dim' : ''}`,
        'data-jedge': edge.id, 'data-from': plan.from, 'data-to': plan.to });
      const hit = svg('path', { d, class: 'jedge__hit' });
      const line = svg('path', { d, class: 'jedge__line', stroke: J_TYPE_COLOR[edge.type], 'marker-end': `url(#jarrow-${edge.type})` });
      if (edge.planned) line.setAttribute('stroke-dasharray', '7 5');
      const start = svg('circle', { cx: plan.sx, cy: plan.sy, r: '4.5', class: 'jedge__start', fill: J_TYPE_COLOR[edge.type] });
      // Номер связи на самом длинном вертикальном отрезке; соседние номера раздвигаются.
      let by = (segment.y1 + segment.y2) / 2;
      for (let tries = 0; tries < 12 && badges.some((other) => Math.abs(other.x - segment.x) < 26 && Math.abs(other.y - by) < 18); tries++) by += 18;
      badges.push({ x: segment.x, y: by });
      const text = `${J_TYPE[edge.type].letter}${edge.number}`;
      const badge = svg('g', { class: 'jedge__badge', transform: `translate(${segment.x},${by})` });
      const rect = svg('rect', { x: String(-(text.length * 4 + 6)), y: '-9', width: String(text.length * 8 + 12), height: '18', rx: '9', fill: '#fff', stroke: J_TYPE_COLOR[edge.type] });
      if (edge.planned) rect.setAttribute('stroke-dasharray', '3 2');
      const label = svg('text', { x: '0', y: '4', 'text-anchor': 'middle', fill: J_TYPE_COLOR[edge.type] }); label.textContent = text;
      badge.append(rect, label);
      const title = svg('title'); title.textContent = `${J_TYPE[edge.type].label}${edge.planned ? ' · запланировано' : ''}: ${edge.label || '—'} (${jPointLabel(edge.from)} → ${jPointLabel(edge.to)})`;
      group.append(title, hit, line, start, badge);
      for (const target of [hit, badge]) {
        target.addEventListener('click', (event) => { event.stopPropagation(); if (state.jConnect) return; jSelect({ kind: 'edge', id: edge.id }); });
      }
      group.addEventListener('mouseenter', () => jHover(edge.id));
      group.addEventListener('mouseleave', () => jHover(null));
      groups.push([group, sel === edge.id, segment.x, by]);
    }
    for (const [group] of groups.filter(([, selected]) => !selected)) lines.append(group);
    for (const [group] of groups.filter(([, selected]) => selected)) lines.append(group);
    // Концы выбранной связи — отдельные метки «Начало»/«Конец» на карточках.
    for (const el of board.querySelectorAll('[data-jcell]')) el.classList.remove('is-edge-start', 'is-edge-end');
    const chosen = sel ? plans.find((plan) => plan.edge.id === sel) : null;
    if (chosen) {
      board.querySelector(`[data-jcell="${CSS.escape(chosen.from)}"]`)?.classList.add('is-edge-start');
      board.querySelector(`[data-jcell="${CSS.escape(chosen.to)}"]`)?.classList.add('is-edge-end');
    }
    jShowPill(jHoverId);
    jDrawDraft();
  }
  function jHover(id) {
    jHoverId = id;
    const board = ui.stage.querySelector('.journey');
    if (!board) return;
    for (const el of board.querySelectorAll('.is-hover-end')) el.classList.remove('is-hover-end');
    for (const el of board.querySelectorAll('.jedge.is-hover')) el.classList.remove('is-hover');
    if (id) {
      const group = board.querySelector(`.jedge[data-jedge="${CSS.escape(id)}"]`);
      group?.classList.add('is-hover');
      for (const key of [group?.dataset.from, group?.dataset.to]) if (key) board.querySelector(`[data-jcell="${CSS.escape(key)}"]`)?.classList.add('is-hover-end');
    }
    jShowPill(id);   // подсказка — только при наведении: у выбранной связи подробности в инспекторе, кнопки не закрываются
  }
  function jShowPill(id) {
    const board = ui.stage.querySelector('.journey'), pill = board?.querySelector('.journey__pill');
    if (!pill) return;
    const edge = id ? journeyInfo().view?.edges.find((item) => item.id === id) : null;
    const badge = edge ? board.querySelector(`.jedge[data-jedge="${CSS.escape(id)}"] .jedge__badge`) : null;
    if (!edge || !badge) { pill.hidden = true; return; }
    pill.replaceChildren(h('strong', { text: `${J_TYPE[edge.type].letter}${edge.number} · ${J_TYPE[edge.type].label}${edge.planned ? ' · запланировано' : ''}` }),
      h('span', { text: edge.label || '—' }), h('span', { class: 'journey__pill-ends', text: `Начало: ${jPointLabel(edge.from)}` }), h('span', { class: 'journey__pill-ends', text: `Конец: ${jPointLabel(edge.to)}` }));
    pill.className = `journey__pill jtype--${edge.type}`;
    pill.hidden = false;
    const base = board.getBoundingClientRect(), r = badge.getBoundingClientRect();
    const left = Math.min(Math.max(4, r.left - base.left + r.width / 2 - 130), board.scrollWidth - 268);
    pill.style.left = `${left}px`; pill.style.top = `${r.bottom - base.top + 6}px`;
  }
  function jDrawDraft() {
    const board = ui.stage.querySelector('.journey');
    board?.querySelector('.jdraft')?.remove();
    if (!board || !jDrag?.moved) return;
    const port = board.querySelector(`[data-jport="${CSS.escape(jDrag.from)}"]`);
    if (!port) return;
    const base = board.getBoundingClientRect(), r = port.getBoundingClientRect();
    const x1 = r.left - base.left + r.width / 2, y1 = r.top - base.top + r.height / 2, x2 = jDrag.x - base.left, y2 = jDrag.y - base.top;
    const type = Object.hasOwn(J_TYPE, state.jNewType) ? state.jNewType : 'message';
    board.querySelector('.journey__svg')?.append(svg('path', { class: 'jdraft', d: `M${x1},${y1} L${x2},${y2}`, stroke: J_TYPE_COLOR[type], 'marker-end': `url(#jarrow-${type})` }));
  }
  function observeJourney() {
    journeyObserver?.disconnect(); journeyObserver = null;
    const board = ui.stage.querySelector('.journey');
    if (!board || typeof ResizeObserver === 'undefined') return;
    let scheduled = false;
    journeyObserver = new ResizeObserver(() => { if (scheduled) return; scheduled = true; requestAnimationFrame(() => { scheduled = false; drawJourney(); }); });
    journeyObserver.observe(board);
    for (const el of board.querySelectorAll('[data-jcell]')) journeyObserver.observe(el);
  }

  /* «Открыть форму»: тот же настоящий экран/блок в режиме редактирования (существующие инспектор, Undo/Redo и
     автосохранение). Возврат — кнопкой «К пути заказа» с прежней прокруткой и выбором. */
  function openJourneyLink(link, cellKey) {
    const frame = frameById(link.frameId);
    if (!frame) { toast(`Экран ${link.frameId} не найден в проекте`); return; }
    const scroll = ui.stage.querySelector('.journey-scroll');
    const point = jParse(cellKey);
    state.journeySel = state.journeySel || { kind: 'cell', key: cellKey };
    state.journeyReturn = { sel: state.journeySel, top: scroll?.scrollTop || 0, left: scroll?.scrollLeft || 0, label: jPointLabel(point) };
    jCancel(false);
    state.mode = 'edit';
    openFrame(frame.id);
    if (link.blockId && blockById(frame, link.blockId)) {
      selectBlock(link.blockId);
      ui.stage.querySelector(`.blk[data-block="${CSS.escape(link.blockId)}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }
  function returnToJourney() {
    const back = state.journeyReturn;
    state.journeyReturn = null;
    state.tab = 'flow'; state.flowView = 'journey'; state.menuOpen = false; state.works = false; state.menuRole = null; state.nodeId = null; state.blockId = null;
    if (back) state.journeySel = back.sel;
    enterJourney();
    renderAll(); applyPanels();
    const scroll = ui.stage.querySelector('.journey-scroll');
    if (scroll && back) { scroll.scrollTop = back.top; scroll.scrollLeft = back.left; }
    requestAnimationFrame(drawJourney);
  }
  function journeyReturnBar() {
    const back = state.journeyReturn;
    return h('div', { class: 'journey-return', role: 'region', 'aria-label': 'Возврат к пути заказа' },
      h('button', { type: 'button', class: 'btn btn--main btn--small', dataset: { journeyReturn: '' }, text: '← К пути заказа', onclick: returnToJourney }),
      h('span', { class: 'muted', text: `Открыто из «Путь заказа»: ${back.label}. Роль и устройство экрана в приложении схемой не меняются.` }));
  }

  /* ---------- инспектор «Пути заказа» ---------- */
  function journeyInspector() {
    const info = journeyInfo();
    const editable = journeyEditable(info);
    const view = info.view;
    const section = h('section', { class: 'ins-card journey-inspector' });
    if (!view) {
      section.append(h('h2', { text: 'Путь заказа' }), h('p', { class: 'form-error', role: 'alert', text: info.status === 'unsupported'
        ? `Версия ${info.version} не поддерживается этим редактором. Данные сохранятся без изменений.` : `Данные пути не прошли проверку: ${info.error}. Данные сохранятся без изменений.` }));
      return section;
    }
    const sel = state.journeySel;
    if (sel?.kind === 'edge') { const edge = view.edges.find((item) => item.id === sel.id); if (edge) return jEdgeInspector(section, edge, view, editable); }
    if (sel?.kind === 'cell') return jCellInspector(section, sel.key, view, editable);
    section.append(h('h2', { text: 'Путь заказа' }),
      h('p', { class: 'hint', text: 'Один заказ сверху вниз: 8 этапов и передачи между Клиентом, Менеджером и Администратором. Нажмите на карточку или связь.' }),
      h('p', { class: 'muted', text: `Связей: ${view.edges.length}. Схема описательная: она не создаёт заявок, сообщений, таймеров и не меняет переходы кнопок, роли и права.` }),
      h('h3', { class: 'ins-sub', text: 'Что есть в опубликованном приложении' }),
      h('ul', { class: 'journey-facts' }, J_STAGES.map(([stage, title], index) => h('li', {}, h('strong', { text: `${index + 1}. ${title}: ` }), J_FACTS[stage].app))));
    if (!editable && info.status !== 'invalid') section.append(h('p', { class: 'muted', text: 'Чтобы менять тексты, формы и связи, включите «Редактировать».' }));
    return section;
  }
  // Текстовое поле с проверкой: недопустимый текст не попадает в модель, ошибка показывается рядом.
  function jTextInput(label, value, max, multi, editable, save, extra = {}) {
    const id = nextId('jf');
    const error = h('p', { class: 'form-error', role: 'alert' });
    const count = h('span', { class: 'muted journey-count', text: `${Array.from(value).length} / ${max}` });
    const field = h(multi ? 'textarea' : 'input', { id, ...(multi ? { rows: '3' } : { type: 'text' }), value, disabled: !editable, maxlength: String(max * 2), ...extra,
      oninput: (event) => {
        const next = event.target.value, problem = jTextError(next, max, multi);
        count.textContent = `${Array.from(next).length} / ${max}`;
        if (problem) { error.textContent = `Не сохранено: ${problem}.`; event.target.setAttribute('aria-invalid', 'true'); return; }
        error.textContent = ''; event.target.removeAttribute('aria-invalid');
        save(next);
      } });
    return h('div', { class: 'ins-field' }, h('label', { for: id, text: label }), field, count, error);
  }
  function jFrameOptions(current) {
    const options = [['', '— не выбрано —'], ...frames().filter((frame) => !frame.hidden || frame.id === current)
      .map((frame) => [frame.id, `${frame.id} · ${str(frame.title) || 'Без названия'} · ${J_ROLE_LABEL[frame.role] || frame.role}${frame.device === 'desktop' ? ' · ПК' : ''}`])];
    if (current && !frameById(current)) options.push([current, `${current} (нет такого экрана)`]);
    return options;
  }
  function jBlockOptions(frameId, current) {
    const frame = frameById(frameId);
    const options = [['', '— весь экран —'], ...(frame ? blocksOf(frame).map((block) => [block.id, `${TYPE_LABEL[block.type] || block.type}: ${blockEdgeLabel(block) || str(block.title) || block.id}`]) : [])];
    if (current && !options.some(([value]) => value === current)) options.push([current, `${current} (нет такого блока)`]);
    return options;
  }
  function jSelectField(label, value, options, editable, onChange, extra = {}) {
    const id = nextId('jf');
    return h('div', { class: 'ins-field' }, h('label', { for: id, text: label }),
      h('select', { id, disabled: !editable, ...extra, onchange: (event) => onChange(event.target.value) }, options.map(([v, text]) => h('option', { value: v, selected: v === value, text }))));
  }
  function jCellInspector(section, key, view, editable) {
    const { stage, role } = jParse(key), cell = view.cells[stage][role];
    const [level, note] = J_FACTS[stage].cells[role];
    section.append(h('div', { class: 'ins-card__head' }, h('h2', { text: `${J_STAGE_INDEX[stage] + 1} · ${J_STAGE_LABEL[stage]}` }),
      h('button', { type: 'button', class: 'btn btn--quiet btn--small', text: 'Снять выбор', onclick: () => jSelect(null) })),
      h('p', { class: 'ins-title', text: `Отвечает: ${J_ROLE_LABEL[role]}${role === 'staff' ? ' (роль staff)' : ''}` }),
      h('p', { class: `journey-fact jlevel--${level}` }, h('strong', { text: `${J_LEVEL[level]}. ` }), `В приложении: ${J_FACTS[stage].app}.${note ? ` ${note}` : ''}`),
      h('p', { class: 'muted', text: 'Метка — возможности опубликованного приложения по коду, не статус реального заказа.' }));
    section.append(jTextInput('Действие', cell.action, J_LIMIT.action, true, editable, (value) => journeyEdit((data) => { jCellOf(data, key).action = value; }), { dataset: { journeyField: 'action' } }));
    section.append(jTextInput('Дальше', cell.next, J_LIMIT.next, true, editable, (value) => journeyEdit((data) => { jCellOf(data, key).next = value; }), { dataset: { journeyField: 'next' } }));
    section.append(h('h3', { class: 'ins-sub', text: 'Связанные формы и экраны' }),
      h('p', { class: 'muted', text: 'Ссылка только показывает, где это настраивается. Роль, устройство и права экрана в приложении она не меняет.' }));
    cell.links.forEach((link, index) => {
      const summary = jFormSummary(link);
      const update = (patch) => journeyEdit((data) => {
        const target = jCellOf(data, key);
        const links = Array.isArray(target.links) ? target.links : [];
        if (!links[index]) return false;
        if (patch === null) links.splice(index, 1); else { Object.assign(links[index], patch); if (!links[index].blockId) delete links[index].blockId; }
        target.links = links;
      }, { inspector: true });
      const frame = frameById(link.frameId);
      section.append(h('div', { class: 'journey-link', dataset: { journeyLink: String(index) } },
        jSelectField('Экран', link.frameId, jFrameOptions(link.frameId).filter(([v]) => v), editable, (value) => update({ frameId: value, blockId: '' })),
        jSelectField('Блок', link.blockId, jBlockOptions(link.frameId, link.blockId), editable, (value) => update({ blockId: value })),
        summary.meta ? h('p', { class: 'muted', text: summary.meta }) : null,
        summary.warn || summary.missing ? h('p', { class: 'jform__warn', text: summary.missing ? `${summary.title}${summary.meta ? `. ${summary.meta}` : ''}. Не настроено.` : summary.warn }) : null,
        frame ? h('p', { class: 'muted', text: `Экран приложения: ${J_ROLE_LABEL[frame.role] || frame.role}, ${frame.device === 'desktop' ? 'ПК' : 'телефон'}. Схема это не меняет.` }) : null,
        h('div', { class: 'ins-actions' },
          !summary.missing ? h('button', { type: 'button', class: 'btn btn--main btn--small', text: 'Открыть форму', onclick: () => openJourneyLink(link, key) }) : null,
          editable ? h('button', { type: 'button', class: 'btn btn--small btn--danger', text: 'Убрать ссылку', onclick: () => update(null) }) : null)));
    });
    if (!cell.links.length) section.append(h('p', { class: 'jform__warn', text: 'Не настроено: форма не выбрана.' }));
    if (editable && cell.links.length < J_LIMIT.links) {
      section.append(jSelectField('Добавить форму или экран', '', jFrameOptions(''), true, (value) => {
        if (!value) return;
        journeyEdit((data) => { const target = jCellOf(data, key); target.links = Array.isArray(target.links) ? target.links : []; target.links.push({ frameId: value }); }, { inspector: true });
      }, { dataset: { journeyAddLink: '' } }));
    }
    const outgoing = view.edges.filter((edge) => jKey(edge.from.stage, edge.from.role) === key), incoming = view.edges.filter((edge) => jKey(edge.to.stage, edge.to.role) === key);
    const list = (title, edges, arrow) => edges.length ? [h('h3', { class: 'ins-sub', text: title }), h('ul', { class: 'journey-edge-list' }, edges.map((edge) => h('li', {},
      h('button', { type: 'button', class: `jchip__btn jtype--${edge.type}`, onclick: () => jSelect({ kind: 'edge', id: edge.id }) },
        h('span', { class: 'jchip__no', text: `${J_TYPE[edge.type].letter}${edge.number}` }), `${arrow} ${jPointLabel(arrow === '→' ? edge.to : edge.from)}: ${edge.planned ? 'запланировано · ' : ''}${edge.label || J_TYPE[edge.type].label}`))))] : [];
    section.append(...list('Связи отсюда', outgoing, '→'), ...list('Связи сюда', incoming, '←'));
    if (editable) section.append(h('p', { class: 'muted', text: 'Новая связь: потяните ● с этой карточки на другую.' }));
    return section;
  }
  function jEdgeInspector(section, edge, view, editable) {
    const update = (patch, options = { inspector: true }) => journeyEdit((data) => {
      const target = jEdgeOf(data, edge.id); if (!target) return false;
      for (const [k, v] of Object.entries(patch)) { if (v === undefined || v === '') delete target[k]; else target[k] = v; }
      if (target.frameId === undefined) delete target.blockId;
    }, options);
    const point = (end) => {
      const current = edge[end];
      return h('div', { class: 'journey-end', dataset: { journeyEnd: end } },
        h('p', { class: 'ins-sub', text: end === 'from' ? 'Начало (●)' : 'Конец (▶)' }),
        jSelectField('Этап', current.stage, J_STAGES.map(([id, title], index) => [id, `${index + 1} · ${title}`]), editable,
          (value) => { if (value === edge[end === 'from' ? 'to' : 'from'].stage && current.role === edge[end === 'from' ? 'to' : 'from'].role) { toast('Начало и конец не могут совпадать.'); renderInspector(); return; }
            update({ [end]: { stage: value, role: current.role } }); }),
        jSelectField('Роль', current.role, J_ROLES, editable,
          (value) => { if (current.stage === edge[end === 'from' ? 'to' : 'from'].stage && value === edge[end === 'from' ? 'to' : 'from'].role) { toast('Начало и конец не могут совпадать.'); renderInspector(); return; }
            update({ [end]: { stage: current.stage, role: value } }); }));
    };
    section.append(h('div', { class: 'ins-card__head' }, h('h2', { text: `Связь ${J_TYPE[edge.type].letter}${edge.number}` }),
      h('button', { type: 'button', class: 'btn btn--quiet btn--small', text: 'Снять выбор', onclick: () => jSelect(null) })),
      h('p', { class: `journey-edge-ends jtype--${edge.type}` }, h('span', { text: `● ${jPointLabel(edge.from)}` }), h('span', { text: `▶ ${jPointLabel(edge.to)}` })),
      h('p', { class: 'muted', text: 'Описательная связь пути заказа. Она не меняет переходы кнопок, не отправляет сообщений и не запускает автоматику.' }));
    section.append(jSelectField('Тип', edge.type, J_TYPES.map(([id, label]) => [id, label]), editable, (value) => update({ type: value }), { dataset: { journeyEdgeType: '' } }));
    const plannedId = nextId('jf');
    section.append(h('label', { class: 'check', for: plannedId }, h('input', { id: plannedId, type: 'checkbox', checked: edge.planned, disabled: !editable, dataset: { journeyPlanned: '' },
      onchange: (event) => update({ planned: event.target.checked ? true : undefined }) }), h('span', { text: 'Запланировано (пунктир): в приложении этого пока нет' })));
    section.append(jTextInput('Подпись', edge.label, J_LIMIT.label, false, editable, (value) => update({ label: value }, { inspector: false }), { dataset: { journeyEdgeLabel: '' } }));
    section.append(point('from'), point('to'));
    section.append(h('h3', { class: 'ins-sub', text: 'Где это в приложении (необязательно)' }),
      jSelectField('Экран', edge.frameId, jFrameOptions(edge.frameId), editable, (value) => update({ frameId: value || undefined, blockId: undefined })),
      edge.frameId ? jSelectField('Блок', edge.blockId, jBlockOptions(edge.frameId, edge.blockId), editable, (value) => update({ blockId: value || undefined })) : null);
    const linkedFrame = edge.frameId ? frameById(edge.frameId) : null;
    const linkedBlock = linkedFrame && edge.blockId ? blockById(linkedFrame, edge.blockId) : null;
    const owner = linkedBlock ? { frame: linkedFrame, block: linkedBlock } : null;
    if (edge.blockId && !linkedBlock) section.append(h('p', { class: 'hint', role: 'status',
      text: `Блок ${edge.blockId} не найден на экране ${edge.frameId || '—'}. Выберите существующий блок этого экрана.` }));
    if (owner && ROUTE_TYPES.has(owner.block.type)) {
      const target = isLinkButton(owner.block) ? 'внешняя ссылка' : owner.block.target ? `→ ${owner.block.target}` : 'переход не задан';
      section.append(h('p', { class: 'hint', text: `Настоящий переход «${blockEdgeLabel(owner.block) || TYPE_LABEL[owner.block.type]}» на экране ${owner.frame.id}: ${target}. Он меняется только в «Экраны и переходы» или в инспекторе блока; эта связь его не трогает.` }),
        h('div', { class: 'ins-actions' },
          h('button', { type: 'button', class: 'btn btn--small', text: 'Открыть в «Экраны и переходы»', onclick: () => switchFlowRole(owner.frame.role, { nodeId: frameNodeId(owner.frame.id) }) }),
          h('button', { type: 'button', class: 'btn btn--small', text: 'Открыть блок', onclick: () => openJourneyLink({ frameId: owner.frame.id, blockId: owner.block.id }, jKey(edge.from.stage, edge.from.role)) })));
    } else if (edge.frameId && frameById(edge.frameId)) {
      section.append(h('button', { type: 'button', class: 'btn btn--small', text: 'Открыть экран', onclick: () => openJourneyLink({ frameId: edge.frameId, blockId: edge.blockId }, jKey(edge.from.stage, edge.from.role)) }));
    }
    if (editable) section.append(h('button', { type: 'button', class: 'btn btn--small btn--danger', dataset: { journeyDeleteEdge: '' }, text: 'Удалить связь', onclick: () => {
      state.journeySel = null;
      journeyEdit((data) => { const index = Array.isArray(data.edges) ? data.edges.findIndex((item) => item.id === edge.id) : -1; if (index < 0) return false; data.edges.splice(index, 1); }, { inspector: true });
    } }));
    return section;
  }

  applyPanels();
  renderAll();
  load();
})();
