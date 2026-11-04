(() => {
"use strict";
/* Упрощённый редактор рилса (агент Г, №98). Браузер не рендерит видео: результат — список правок (EDL v1)
   к версии ролика. «Отправить в монтаж» и «Хью, измени…» создают правку и задачу для Claude-агента монтажа;
   новая версия появляется, когда агент загрузит её (см. specs/102-reel-materials/plan.md). */
const sb = window.SbCabinet = window.SbCabinet || {};
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const MIN = 100;
const sec = ms => (Math.round(ms / 100) / 10).toLocaleString("ru-RU", {minimumFractionDigits: 1});
const len = clip => clip.outMs - clip.inMs;
/* Операции над дорожкой — чистые функции: порядок массива = порядок на дорожке. */
const ops = {
  initial: durationMs => ({v: 1, video: [{inMs: 0, outMs: durationMs}], audio: [{inMs: 0, outMs: durationMs, gain: 1, muted: false}], captions: [], coverMs: null, speed: 1}),
  total: track => track.reduce((sum, clip) => sum + len(clip), 0),
  locate(track, atMs) {let start = 0;for (let i = 0; i < track.length; i++) {if (atMs < start + len(track[i])) return {index: i, offset: atMs - start};start += len(track[i]);}return null;},
  split(track, atMs) {
    const hit = ops.locate(track, atMs);if (!hit || hit.offset < MIN || len(track[hit.index]) - hit.offset < MIN) return track;
    const clip = track[hit.index], cut = clip.inMs + hit.offset;
    return [...track.slice(0, hit.index), {...clip, outMs: cut}, {...clip, inMs: cut}, ...track.slice(hit.index + 1)];
  },
  remove: (track, index, keepOne) => keepOne && track.length < 2 ? track : track.filter((_, i) => i !== index),
  move(track, index, delta) {const to = index + delta;if (to < 0 || to >= track.length) return track;const next = [...track];[next[index], next[to]] = [next[to], next[index]];return next;},
  trim(track, index, inMs, outMs, limit) {
    const a = Math.max(0, Math.min(Math.round(inMs), limit - MIN)), b = Math.min(limit, Math.max(Math.round(outMs), a + MIN));
    return track.map((clip, i) => i === index ? {...clip, inMs: a, outMs: b} : clip);
  },
  set: (track, index, patch) => track.map((clip, i) => i === index ? {...clip, ...patch} : clip),
  /* Время дорожки → время исходника: для предпросмотра правок и миниатюр отмеченного отрезка. */
  sourceAt(track, atMs) {const hit = ops.locate(track, atMs);return hit ? track[hit.index].inMs + hit.offset : null;}
};
const draftKey = (code, reel, version) => `sb-reel-edl:${code}:${reel}:v${version}`;
const readDraft = key => {try {const value = JSON.parse(localStorage.getItem(key) || "null");return value?.v === 1 ? value : null;} catch (_) {return null;}};
const writeDraft = (key, value) => {try {value ? localStorage.setItem(key, JSON.stringify(value)) : localStorage.removeItem(key);} catch (_) {}};
const requestId = () => (crypto.randomUUID?.() || String(Date.now()) + Math.random().toString(16).slice(2)).slice(0, 80);

function open(host, {ctx, reel, version, onChange}) {
  host.querySelector(".re-editor")?.remove();
  const base = reel.versions.find(v => v.version === version) || reel.currentVersion;
  const key = draftKey(ctx.companyCode, reel.id, base.version);
  let duration = base.durationMs || 0, edl = readDraft(key) || (duration ? ops.initial(duration) : null);
  let selected = {track: "video", index: 0}, busy = false, preview = false, mark = {from: null, to: null};
  const root = document.createElement("section");
  root.className = "re-editor";root.setAttribute("role", "dialog");root.setAttribute("aria-modal", "true");root.setAttribute("aria-labelledby", "re-title");
  root.innerHTML = `<header class="re-head"><h2 id="re-title" tabindex="-1">Редактировать · ${esc(reel.title)} · v${esc(base.version)}</h2><button type="button" class="plain-button" data-close aria-label="Закрыть редактор">×</button></header>
    <div class="re-body"><div class="re-stage"><video playsinline preload="auto" src="${esc(base.mediaUrl)}" data-player></video>
      <div class="re-transport"><button type="button" class="plain-button" data-play>▶</button><span data-clock>0,0 с</span>
        <label class="re-inline"><input type="checkbox" data-preview> Смотреть с правками</label></div></div>
      <div class="re-tools">
        <div class="re-row"><button type="button" class="plain-button" data-op="split">Разделить здесь</button><button type="button" class="plain-button" data-op="remove">Удалить кусок</button>
          <button type="button" class="plain-button" data-op="left" aria-label="Переставить левее">←</button><button type="button" class="plain-button" data-op="right" aria-label="Переставить правее">→</button></div>
        <div class="re-row" data-clip-fields></div>
        <div class="re-row"><label>Скорость<select data-speed><option value="1">1×</option><option value="1.25">1,25×</option><option value="1.5">1,5×</option></select></label>
          <button type="button" class="plain-button" data-op="cover">Обложка = этот кадр</button><span class="muted" data-cover></span></div>
        <details class="re-captions"><summary>Титры</summary><ul data-captions></ul><button type="button" class="plain-button" data-op="caption">+ Титр с этого места</button></details>
        <div class="re-row re-mark"><span>Отметить</span><label>от<input type="number" min="0" step="0.1" inputmode="decimal" data-mark="from"></label>
          <label>до<input type="number" min="0" step="0.1" inputmode="decimal" data-mark="to"></label>
          <button type="button" class="plain-button" data-op="mark-now">от/до = сейчас</button><button type="button" class="plain-button primary" data-op="mark" aria-label="Отметить отрезок">✓</button></div>
      </div></div>
    <div class="re-tracks" data-tracks></div>
    <footer class="re-foot"><label class="re-grow">Комментарий к правкам<input type="text" maxlength="500" data-comment placeholder="Необязательно"></label>
      <button type="button" class="plain-button" data-op="reset">Сбросить правки</button><button type="button" class="plain-button primary" data-op="submit">Отправить в монтаж</button></footer>
    <p class="re-status" role="status" data-status></p>
    <section class="re-ask" data-ask hidden aria-labelledby="re-ask-title"><h3 id="re-ask-title">Отмеченный отрезок</h3><div class="re-frames" data-frames></div>
      <label>Хью, измени…<textarea rows="3" maxlength="2000" data-ask-text placeholder="Например: убери паузу, сделай титр крупнее"></textarea></label>
      <div class="re-row"><button type="button" class="plain-button" data-op="ask-cancel">Отмена</button><button type="button" class="plain-button primary" data-op="ask-send">Отправить Хью</button></div></section>`;
  host.append(root);
  const $ = selector => root.querySelector(selector), player = $("[data-player]");
  const status = text => {$("[data-status]").textContent = text;};
  const save = () => writeDraft(key, edl);
  const track = () => edl[selected.track];
  function renderTracks() {
    if (!edl) {$("[data-tracks]").innerHTML = "<p class='muted'>Загружаем длительность ролика…</p>";return;}
    const total = ops.total(edl.video) || 1;
    const lane = (name, title) => `<div class="re-lane"><span class="re-lane__name">${title}</span><ol class="re-clips">${edl[name].map((clip, i) =>
      `<li style="flex-grow:${len(clip)}"><button type="button" draggable="true" data-track="${name}" data-index="${i}" class="re-clip${selected.track === name && selected.index === i ? " is-selected" : ""}${clip.muted ? " is-muted" : ""}"
        aria-pressed="${selected.track === name && selected.index === i}" aria-label="${title}, клип ${i + 1}: ${sec(clip.inMs)}–${sec(clip.outMs)} с">${sec(len(clip))} с${name === "audio" ? (clip.muted ? " · без звука" : ` · ${Math.round(clip.gain * 100)}%`) : ""}</button></li>`).join("")}</ol></div>`;
    $("[data-tracks]").innerHTML = lane("video", "Видео") + lane("audio", "Звук") + `<p class="muted re-total">Итог: ${sec(total / edl.speed)} с${edl.speed !== 1 ? ` (скорость ${String(edl.speed).replace(".", ",")}×)` : ""}</p>`;
    const clip = track()[selected.index];
    $("[data-clip-fields]").innerHTML = clip ? `<label>Начало, с<input type="number" step="0.1" min="0" value="${clip.inMs / 1000}" data-field="in"></label><label>Конец, с<input type="number" step="0.1" min="0" value="${clip.outMs / 1000}" data-field="out"></label>${selected.track === "audio" ?
      `<label>Громкость<input type="range" min="0" max="200" step="5" value="${Math.round(clip.gain * 100)}" data-field="gain"></label><label class="re-inline"><input type="checkbox" data-field="muted"${clip.muted ? " checked" : ""}> Без звука</label>` : ""}` : "";
    $("[data-speed]").value = String(edl.speed);
    $("[data-cover]").textContent = edl.coverMs === null ? "обложка не выбрана" : `обложка: ${sec(edl.coverMs)} с`;
    $("[data-captions]").innerHTML = edl.captions.map((c, i) => `<li><input type="text" maxlength="120" value="${esc(c.text)}" data-caption="${i}" aria-label="Текст титра ${i + 1}"> <span class="muted">${sec(c.startMs)}–${sec(c.endMs)} с</span> <button type="button" class="plain-button" data-caption-remove="${i}" aria-label="Удалить титр ${i + 1}">×</button></li>`).join("");
  }
  const update = next => {edl = next;save();renderTracks();};
  const timelineNow = () => {
    // Позиция на дорожке видео по текущему времени исходника; если кадр вырезан — начало ближайшего клипа.
    const src = player.currentTime * 1000;let start = 0;
    for (const clip of edl.video) {if (src >= clip.inMs && src < clip.outMs) return start + src - clip.inMs;start += len(clip);}
    return 0;
  };
  function op(name) {
    if (!edl) return;
    const limit = duration || ops.total(edl.video);
    if (name === "split") {const at = selected.track === "audio" ? audioTimelineNow() : timelineNow();const next = ops.split(track(), at);if (next === track()) status("Разделить можно внутри клипа, не ближе 0,1 с к краю.");update({...edl, [selected.track]: next});}
    else if (name === "remove") {const next = ops.remove(track(), selected.index, selected.track === "video");if (next === track()) status("На видеодорожке должен остаться хотя бы один клип.");selected.index = Math.max(0, Math.min(selected.index, next.length - 1));update({...edl, [selected.track]: next});}
    else if (name === "left" || name === "right") {const delta = name === "left" ? -1 : 1, next = ops.move(track(), selected.index, delta);if (next !== track()) selected.index += delta;update({...edl, [selected.track]: next});}
    else if (name === "cover") update({...edl, coverMs: Math.round(Math.min(timelineNow(), ops.total(edl.video)))});
    else if (name === "caption") {const at = Math.round(timelineNow()), end = Math.min(ops.total(edl.video), at + 2000);if (end - at < MIN) return;update({...edl, captions: [...edl.captions, {startMs: at, endMs: end, text: "Текст титра"}]});root.querySelector(`[data-caption="${edl.captions.length - 1}"]`)?.focus();}
    else if (name === "reset") {writeDraft(key, null);edl = ops.initial(limit);selected = {track: "video", index: 0};renderTracks();status("Правки сброшены.");}
    else if (name === "mark-now") {const t = Math.round(player.currentTime * 10) / 10, from = $("[data-mark=from]"), to = $("[data-mark=to]");if (from.value === "" || (to.value !== "" && Number(from.value) < t)) {if (from.value === "") from.value = t;else to.value = t;} else to.value = t;}
    else if (name === "mark") void askOpen();
    else if (name === "ask-cancel") {$("[data-ask]").hidden = true;}
    else if (name === "ask-send") void askSend();
    else if (name === "submit") void submit();
  }
  const audioTimelineNow = () => {const src = player.currentTime * 1000;let start = 0;for (const clip of edl.audio) {if (src >= clip.inMs && src < clip.outMs) return start + src - clip.inMs;start += len(clip);}return 0;};
  async function askOpen() {
    const from = Number($("[data-mark=from]").value), to = Number($("[data-mark=to]").value), limit = (duration || 0) / 1000;
    if (!Number.isFinite(from) || !Number.isFinite(to) || $("[data-mark=from]").value === "" || to <= from || (limit && to > limit + 0.05)) {status("Укажите отрезок: «от» меньше «до», в пределах ролика.");return;}
    mark = {from: Math.round(from * 1000), to: Math.round(to * 1000)};
    const ask = $("[data-ask]");ask.hidden = false;$("[data-frames]").innerHTML = "<p class='muted'>Готовим кадры…</p>";$("[data-ask-text]").focus();
    $("[data-frames]").innerHTML = (await sb.reelEditor.frames(base.mediaUrl, mark.from, mark.to)).map(f => `<figure>${f.src ? `<img src="${f.src}" alt="Кадр ${sec(f.ms)} с">` : "<span class='re-noframe'></span>"}<figcaption>${sec(f.ms)} с</figcaption></figure>`).join("");
  }
  async function askSend() {
    const text = $("[data-ask-text]").value.trim();if (!text) {status("Напишите, что изменить.");return;}
    await send({kind: "request", startMs: mark.from, endMs: mark.to, comment: text}, edit => {
      $("[data-ask]").hidden = true;$("[data-ask-text]").value = "";
      status(`Задача №${edit.taskId} для монтажа создана, запрос сохранён в вашем чате с Хью. Когда правка будет готова, Хью напишет «исправлено» и появится новая версия.`);
      notifyHugh(ctx, reel, edit, `Хью, измени «${reel.title}» v${base.version}, ${sec(mark.from)}–${sec(mark.to)} с: ${text}`);
    });
  }
  async function submit() {
    const initial = JSON.stringify(ops.initial(duration || ops.total(edl.video)));
    if (JSON.stringify(edl) === initial) {status("Правок пока нет.");return;}
    await send({kind: "edl", edl, comment: $("[data-comment]").value.trim()}, edit => {
      writeDraft(key, null);status(`Список правок отправлен в монтаж: задача №${edit.taskId}. Новая версия появится после монтажа.`);
      notifyHugh(ctx, reel, edit, `Правки монтажа к «${reel.title}» v${base.version} отправлены (задача №${edit.taskId}).`);
    });
  }
  async function send(body, done) {
    if (busy) return;busy = true;status("Отправляем…");
    try {
      const result = await ctx.api.post(`crm/autoposting/reels/${reel.id}/edits`, {clientRequestId: requestId(), baseVersion: base.version, ...body});
      if (ctx.signal.aborted) return;done(result.edit);onChange?.(result.reel);
    } catch (error) {status("Не отправлено: " + (error?.message || "ошибка сети") + ". Правки сохранены в этом браузере.");}
    finally {busy = false;}
  }
  root.addEventListener("click", event => {
    const button = event.target.closest("button");if (!button) return;
    if (button.hasAttribute("data-close")) return close();
    if (button.dataset.track) {selected = {track: button.dataset.track, index: Number(button.dataset.index)};const clip = track()[selected.index];if (clip) player.currentTime = clip.inMs / 1000;renderTracks();return;}
    if (button.dataset.captionRemove !== undefined) {update({...edl, captions: edl.captions.filter((_, i) => i !== Number(button.dataset.captionRemove))});return;}
    if (button.dataset.op) op(button.dataset.op);
    if (button.hasAttribute("data-play")) {if (player.paused) void player.play()?.catch?.(() => {});else player.pause();}
  });
  root.addEventListener("change", event => {
    const t = event.target, clip = edl && track()[selected.index], limit = duration || (edl && ops.total(edl.video)) || 0;
    if (t.dataset.field === "in" || t.dataset.field === "out") update({...edl, [selected.track]: ops.trim(track(), selected.index, t.dataset.field === "in" ? Number(t.value) * 1000 : clip.inMs, t.dataset.field === "out" ? Number(t.value) * 1000 : clip.outMs, limit)});
    else if (t.dataset.field === "gain") update({...edl, audio: ops.set(edl.audio, selected.index, {gain: Number(t.value) / 100})});
    else if (t.dataset.field === "muted") update({...edl, audio: ops.set(edl.audio, selected.index, {muted: t.checked})});
    else if (t.matches("[data-speed]")) {update({...edl, speed: Number(t.value)});player.playbackRate = edl.speed;}
    else if (t.dataset.caption !== undefined) update({...edl, captions: ops.set(edl.captions, Number(t.dataset.caption), {text: t.value.slice(0, 120)})});
    else if (t.matches("[data-preview]")) preview = t.checked;
  });
  /* Перетаскивание клипа на место другого — то же «переставить», что кнопки ← →. */
  let dragged = null;
  root.addEventListener("dragstart", event => {const b = event.target.closest?.("[data-track]");if (b) {dragged = {track: b.dataset.track, index: Number(b.dataset.index)};event.dataTransfer?.setData("text/plain", "clip");}});
  root.addEventListener("dragover", event => {if (dragged && event.target.closest?.(`[data-track="${dragged.track}"]`)) event.preventDefault();});
  root.addEventListener("drop", event => {
    const b = event.target.closest?.("[data-track]");if (!dragged || !b || b.dataset.track !== dragged.track) return;event.preventDefault();
    const list = [...edl[dragged.track]], [clip] = list.splice(dragged.index, 1), to = Number(b.dataset.index);list.splice(to, 0, clip);
    selected = {track: dragged.track, index: to};dragged = null;update({...edl, [selected.track]: list});
  });
  player.addEventListener("loadedmetadata", () => {
    if (!duration && Number.isFinite(player.duration)) {duration = Math.round(player.duration * 1000);if (!edl) edl = ops.initial(duration);renderTracks();}
  });
  player.addEventListener("timeupdate", () => {
    $("[data-clock]").textContent = sec(player.currentTime * 1000) + " с";
    if (!preview || !edl) return;
    const src = player.currentTime * 1000, i = edl.video.findIndex(c => src >= c.inMs && src < c.outMs - 40);
    if (i === -1) {const next = edl.video.find(c => c.inMs > src);if (next) player.currentTime = next.inMs / 1000;else player.pause();}
  });
  const onKey = event => {if (event.key === "Escape") {event.stopPropagation();close();}};
  root.addEventListener("keydown", onKey);
  ctx.signal.addEventListener("abort", () => root.remove(), {once: true});
  function close() {player.pause();root.remove();host.querySelector("[data-edit]")?.focus();}
  renderTracks();$("#re-title").focus({preventScroll: true});
  return {root, get edl() {return edl;}, close};
}
/* Миниатюры отмеченного отрезка: до 6 кадров через canvas. Чужой источник или ошибка — подписи времени без картинки. */
async function frames(url, fromMs, toMs) {
  const count = Math.min(6, Math.max(2, Math.ceil((toMs - fromMs) / 1000) + 1)), times = Array.from({length: count}, (_, i) => Math.round(fromMs + (toMs - fromMs) * i / (count - 1)));
  const video = document.createElement("video");video.muted = true;video.preload = "auto";video.crossOrigin = "anonymous";video.src = url;
  const seek = ms => new Promise(resolve => {const done = ok => {video.removeEventListener("seeked", on);clearTimeout(timer);resolve(ok);};const on = () => done(true);const timer = setTimeout(() => done(false), 3000);video.addEventListener("seeked", on);try {video.currentTime = ms / 1000;} catch (_) {done(false);}});
  const out = [];
  for (const ms of times) {
    let src = "";
    try {if (await seek(ms) && video.videoWidth) {const canvas = document.createElement("canvas");canvas.width = 108;canvas.height = Math.round(108 * video.videoHeight / video.videoWidth);canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);src = canvas.toDataURL("image/jpeg", 0.7);}} catch (_) {src = "";}
    out.push({ms, src});
  }
  video.removeAttribute("src");return out;
}
/* Запись в личный чат пользователя с Хью: точка «hugh-chat» агента Д слушает это событие.
   Сервер хранит тот же журнал в правках ролика, поэтому запись не теряется, если чат ещё не открыт. */
function notifyHugh(ctx, reel, edit, text) {
  window.dispatchEvent(new CustomEvent("synapse:hugh-chat", {detail: {companyCode: ctx.companyCode, source: "content-materials", reelId: reel.id, editId: edit.id, taskId: edit.taskId, text}}));
}
sb.reelEditor = {open, ops, frames};
})();
