(() => {
"use strict";
/* Окно «Редактировать» ролика в Монтаже (макет 07.11, пакет F №204). Браузер не монтирует видео: человек отмечает
   отрезок «от … до …» на дорожках и пишет «Хью, измени: …»; запрос уходит существующим маршрутом
   POST crm/autoposting/reels/:id/edits (kind=request) и задачей для агента монтажа. Новая версия vK+1 появляется,
   когда агент загрузит её (specs/102-reel-materials/plan.md).
   «Исходники ▾» показывает реальные загрузки съёмки (GET shooting/reels/:ideaId, kind=take) по сценам сценария;
   нажатие на дубль добавляет в запрос «заменить 0:12–0:18 на сцену 3 дубль 2». «＋» — та же загрузка частями, что на «Съёмке».
   «Ручные правки ▾» (по умолчанию свёрнуто) — прежние правки списком EDL v1: разделить, удалить кусок, переставить
   (← → или перетаскивание клипа), громкость/«без звука» клипа звука, скорость. Черновик хранится в этом браузере,
   «Отправить в монтаж» — тот же маршрут правки с kind=edl. */
const sb = window.SbCabinet = window.SbCabinet || {};
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const safeUrl = value => {try {const url = new URL(value, location.href);return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";} catch (_) {return "";}};
const MIN = 100;
const len = clip => clip.outMs - clip.inMs;
/* Операции EDL v1 — чистые функции, тот же формат, что проверяет сервер (validateEdl). Порядок массива = порядок на дорожке. */
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
  sourceAt(track, atMs) {const hit = ops.locate(track, atMs);return hit ? track[hit.index].inMs + hit.offset : null;}
};

/* Время: «0:12», «0:12,5»; разбор принимает «0:12», «0:12.5», «12», «12,5». */
function clock(ms) {
  const tenths = Math.round(Math.max(0, ms) / 100), whole = Math.floor(tenths / 10), frac = tenths % 10;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}${frac ? "," + frac : ""}`;
}
function parseClock(text) {
  const value = String(text ?? "").trim().replace(",", ".");if (!value) return null;
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(value);if (!m) return null;
  const seconds = (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}
/* Сцены из «Сценария по секундам»: время «0–2 с» у каждой сцены — клипы по нему; без времени — поровну на длительность. */
const RANGE = /(\d+(?:[.,]\d+)?)\s*[–—-]\s*(\d+(?:[.,]\d+)?)/;
function parseScenes(idea) {
  if (!idea) return [];
  const parser = window.SbShooting?.script?.parse;
  const frames = parser ? parser(idea.script, idea).frames : String(idea.script || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    .map((text, i) => ({n: i + 1, text, time: "", title: ""}));
  return (parser && !String(idea.script || "").trim() ? [] : frames).map(frame => {
    const m = RANGE.exec(frame.time || "");
    return {n: frame.n, label: frame.text || "", title: frame.title || "", fromMs: m ? Math.round(Number(m[1].replace(",", ".")) * 1000) : null,
      toMs: m ? Math.round(Number(m[2].replace(",", ".")) * 1000) : null};
  });
}
function layoutScenes(scenes, durationMs) {
  if (!scenes.length || !durationMs) return [];
  const timed = scenes.every(s => s.fromMs !== null && s.toMs > s.fromMs && s.fromMs < durationMs);
  const step = durationMs / scenes.length;
  return scenes.map((s, i) => timed ? {...s, fromMs: Math.min(s.fromMs, durationMs), toMs: Math.min(s.toMs, durationMs)}
    : {...s, fromMs: Math.round(i * step), toMs: Math.round((i + 1) * step)});
}
const sec = ms => (Math.round(ms / 100) / 10).toLocaleString("ru-RU", {minimumFractionDigits: 1});
const SPEEDS = [1, 1.25, 1.5];
/* Черновик ручных правок — только удобство этого браузера: хранилище может быть недоступно, поэтому всё в try/catch. */
const draftKey = (code, reel, version) => `sb-reel-edl:${code}:${reel}:v${version}`;
const readDraft = key => {try {const value = JSON.parse(localStorage.getItem(key) || "null");return value?.v === 1 && Array.isArray(value.video) && value.video.length ? value : null;} catch (_) {return null;}};
const writeDraft = (key, value) => {try {value ? localStorage.setItem(key, JSON.stringify(value)) : localStorage.removeItem(key);} catch (_) {}};
const requestId = () => (crypto.randomUUID?.() || String(Date.now()) + Math.random().toString(16).slice(2)).slice(0, 80);

function open(host, {ctx, reel, version, onChange, number = null, idea = null}) {
  host.querySelector(".re-editor")?.remove();
  let current = reel;
  const versionOf = v => (current.versions || []).find(item => item.version === v) || null;
  let base = versionOf(version) || current.currentVersion || {version: version || 1};
  let duration = base.durationMs || 0, busy = false, sources = false;
  let mark = {from: null, to: null}, take = null, shooting = null, shootingError = "";
  let manual = false, key = "", edl = null, selected = {track: "video", index: 0};
  const takeDurations = new Map(), canUpload = ctx.can?.("autoposting.edit") !== false;
  const scenes = parseScenes(idea);
  const root = document.createElement("section");
  root.className = "re-editor";root.setAttribute("role", "dialog");root.setAttribute("aria-modal", "true");root.setAttribute("aria-labelledby", "re-title");
  root.innerHTML = `<header class="re-head"><h2 id="re-title" tabindex="-1" data-title></h2><button type="button" class="re-x" data-close aria-label="Закрыть редактор">✕</button></header>
    <div class="re-body">
      <div class="re-stage"><div class="re-screen"><video playsinline preload="metadata" data-player></video>
        <span class="re-time" data-clock>0:00</span><button type="button" class="re-play" data-play aria-label="Смотреть">▶</button></div></div>
      <div class="re-side">
        <div class="re-row re-srcbar"><button type="button" class="plain-button" data-sources aria-expanded="false">Исходники ▾</button><span class="muted re-hint">дорожки с отснятыми дублями</span></div>
        <div class="re-tl" data-tl>
          <div class="re-ruler" data-ruler aria-hidden="true"></div>
          <div class="re-track re-track--video"><span class="re-track__name">Видео<span class="re-track__src"> · монтаж</span></span><div class="re-lane" data-lane="video"></div></div>
          <div class="re-track re-track--titles"><span class="re-track__name">Титры</span><div class="re-lane" data-lane="titles"></div></div>
          <div class="re-track re-track--audio"><span class="re-track__name">Звук</span><div class="re-lane" data-lane="audio"></div></div>
          <span class="re-sel" data-sel hidden></span><span class="re-ph" data-ph></span>
        </div>
        <div class="re-src" data-src hidden></div>
        <div class="re-row re-mark"><span class="muted">Отметить</span>
          <label><span class="re-sr">Начало отрезка</span><span aria-hidden="true">от</span><input type="text" inputmode="decimal" autocomplete="off" placeholder="0:00" data-mark="from"></label>
          <label><span class="re-sr">Конец отрезка</span><span aria-hidden="true">до</span><input type="text" inputmode="decimal" autocomplete="off" placeholder="0:00" data-mark="to"></label></div>
        <p class="re-take" data-take hidden></p>
        <label class="re-ask"><span class="re-sr">Что изменить</span><textarea rows="3" maxlength="1800" data-ask placeholder="Хью, измени: …"></textarea></label>
        <div class="re-row"><button type="button" class="plain-button primary" data-send>Отправить Хью</button><button type="button" class="plain-button" data-clear>Отменить отметку</button></div>
        <div class="re-row re-manbar"><button type="button" class="plain-button" data-manual aria-expanded="false" aria-controls="re-manual">Ручные правки ▾</button><span class="muted re-hint">разделить, удалить, переставить, звук, скорость</span></div>
        <div class="re-man" id="re-manual" data-man hidden>
          <div class="re-edl" data-edl></div>
          <div class="re-ops"><button type="button" class="plain-button" data-op="split">Разделить здесь</button><button type="button" class="plain-button" data-op="remove">Удалить кусок</button>
            <button type="button" class="plain-button" data-op="left" aria-label="Переставить левее">←</button><button type="button" class="plain-button" data-op="right" aria-label="Переставить правее">→</button></div>
          <div class="re-row re-gain" data-gain-row></div>
          <div class="re-row re-speed"><label>Скорость<select data-speed>${SPEEDS.map(v => `<option value="${v}">${String(v).replace(".", ",")}×</option>`).join("")}</select></label><span class="re-total" data-total></span></div>
          <label class="re-comment"><span class="re-sr">Комментарий к правкам</span><input type="text" maxlength="500" autocomplete="off" data-comment placeholder="Комментарий к правкам (необязательно)"></label>
          <div class="re-foot"><button type="button" class="plain-button" data-op="reset">Сбросить правки</button><button type="button" class="plain-button primary" data-op="submit">Отправить в монтаж</button></div>
        </div>
        <p class="re-status" role="status" data-status></p>
        <p class="muted re-note" data-note></p>
        <div class="re-vers" data-versions></div>
      </div></div>`;
  host.append(root);
  const $ = selector => root.querySelector(selector), player = $("[data-player]");
  const status = text => {$("[data-status]").textContent = text;};
  const nextVersion = () => Math.max(0, ...(current.versions || []).map(v => v.version), current.currentVersion?.version || 0) + 1;
  const title = () => `Редактировать · ${number ? "№" + number : current.title || "ролик"} · v${base.version}`;

  function renderHead() {
    $("[data-title]").textContent = title();
    const vs = (current.versions?.length ? current.versions : [current.currentVersion]).filter(Boolean);
    $("[data-versions]").innerHTML = `<b>Версии</b>${vs.map(v => `<button type="button" class="re-ver${v.version === base.version ? " is-on" : ""}" data-version="${esc(v.version)}" aria-pressed="${v.version === base.version}">v${esc(v.version)}</button>`).join("")}`;
    $("[data-note]").textContent = `Хью соберёт новую версию — она придёт в чат и появится здесь как v${nextVersion()}; этап станет «Монтаж на согласовании».`;
  }
  function loadVersion() {
    const media = safeUrl(base.mediaUrl);
    duration = base.durationMs || 0;
    if (media) player.src = media;else player.removeAttribute("src");
    $("[data-play]").hidden = !media;
    if (!media) status("Файл этой версии не найден.");
  }
  const pct = ms => duration ? Math.max(0, Math.min(100, ms / duration * 100)) : 0;
  const box = (fromMs, toMs, cls, label, tip) => `<span class="re-clip ${cls}" style="left:${pct(fromMs)}%;width:${Math.max(0.5, pct(toMs) - pct(fromMs))}%" title="${esc(tip)}">${esc(label)}</span>`;
  function renderTracks() {
    const lanes = {video: $("[data-lane=video]"), titles: $("[data-lane=titles]"), audio: $("[data-lane=audio]")};
    if (!duration) {
      $("[data-ruler]").innerHTML = "";
      lanes.video.innerHTML = `<span class="re-empty">Загружаем длительность ролика…</span>`;lanes.titles.innerHTML = lanes.audio.innerHTML = "";renderMarks();return;
    }
    $("[data-ruler]").innerHTML = `<span>0:00</span><span>${clock(Math.round(duration / 2000) * 1000)}</span><span>${clock(duration)}</span>`;
    const laid = layoutScenes(scenes, duration);
    lanes.video.innerHTML = laid.length ? laid.map(s => box(s.fromMs, s.toMs, "re-clip--video", s.n, `Сцена №${s.n}${s.label ? ": " + s.label : ""}`)).join("")
      : box(0, duration, "re-clip--video", "ролик", "Сцен в сценарии нет — весь ролик одним клипом");
    const titled = laid.filter(s => s.title);
    lanes.titles.innerHTML = titled.length ? titled.map(s => box(s.fromMs, s.toMs, "re-clip--title", "Т", `Титр сцены №${s.n}: ${s.title}`)).join("")
      : `<span class="re-empty">титров в сценарии нет</span>`;
    lanes.audio.innerHTML = box(0, duration, "re-clip--audio", "звук ролика", "Звуковая дорожка ролика");
    renderMarks();
  }
  /* Отметка и курсор лежат над дорожками; при «Исходниках» дорожка «Видео · монтаж» тонкая, отметка остаётся над ней. */
  function renderMarks() {
    const sel = $("[data-sel]"), ph = $("[data-ph]");
    const hasMark = duration && mark.from !== null && mark.to !== null && mark.to > mark.from;
    sel.hidden = !hasMark;
    if (hasMark) {sel.style.setProperty("--a", pct(mark.from) / 100);sel.style.setProperty("--w", (pct(mark.to) - pct(mark.from)) / 100);}
    ph.hidden = !duration;ph.style.setProperty("--a", pct((player.currentTime || 0) * 1000) / 100);
    // Над тонкой строкой «монтаж» отметка и курсор привязаны к самой дорожке, а не к высоте подписи.
    const laneEl = root.querySelector("[data-lane=video]"), top = laneEl.offsetTop || 0;
    if (sources && top) {sel.style.top = top - 2 + "px";sel.style.height = laneEl.offsetHeight + 4 + "px";ph.style.top = top - 4 + "px";ph.style.height = laneEl.offsetHeight + 8 + "px";}
    else {sel.style.top = sel.style.height = ph.style.top = ph.style.height = "";}
    $("[data-clock]").textContent = `${clock((player.currentTime || 0) * 1000).replace(/,\d$/, "")}${duration ? " / " + clock(duration).replace(/,\d$/, "") : ""}`;
  }
  function setMark(from, to, fill = true) {
    mark = {from, to};
    if (fill) {$("[data-mark=from]").value = from === null ? "" : clock(from);$("[data-mark=to]").value = to === null ? "" : clock(to);}
    renderMarks();renderTake();
  }
  const markText = () => `${clock(mark.from)}–${clock(mark.to)}`;
  const takeText = t => t.scene ? `сцену ${t.scene} дубль ${t.number}` : `дубль ${t.number} из «Другое»`;
  function renderTake() {
    const node = $("[data-take]");node.hidden = !take;
    if (take) node.innerHTML = `Заменить ${mark.from !== null && mark.to > mark.from ? esc(markText()) : "выделенный отрезок"} на ${esc(takeText(take))} <button type="button" class="re-link" data-untake>убрать</button>`;
  }

  /* ---------- Исходники: реальные загрузки съёмки по сценам ---------- */
  async function loadShooting() {
    if (!idea?.ideaId) return;
    try {
      const data = await ctx.api.get(`shooting/reels/${encodeURIComponent(idea.ideaId)}`);
      if (ctx.signal.aborted || !root.isConnected) return;
      if (data?.companyCode && String(data.companyCode).toLowerCase() !== String(ctx.companyCode).toLowerCase()) return;
      shooting = (data?.uploads || []).filter(u => u.kind === "take" && u.status === "stored" && u.fileUrl);shootingError = "";
    } catch (error) {if (!ctx.signal.aborted) {shootingError = "Исходники не загрузились: " + (error?.message || "ошибка сети");shooting = shooting || [];}}
    renderSources();
  }
  function takesBy(scene) {return (shooting || []).filter(u => u.frame === scene).sort((a, b) => a.id - b.id);}
  function measure(upload) {
    if (takeDurations.has(upload.id)) return;takeDurations.set(upload.id, null);
    const url = safeUrl(upload.fileUrl);if (!url) return;
    const probe = document.createElement("video");probe.preload = "metadata";probe.muted = true;
    probe.addEventListener("loadedmetadata", () => {if (Number.isFinite(probe.duration)) {takeDurations.set(upload.id, Math.round(probe.duration));if (sources) renderSources();}probe.removeAttribute("src");}, {once: true});
    probe.src = url;
  }
  function renderSources() {
    const node = $("[data-src]");
    if (!idea?.ideaId) {node.innerHTML = `<p class="muted">Ролик не связан с рилсом плана — исходников съёмки нет.</p>`;return;}
    if (shooting === null) {node.innerHTML = `<p class="muted">Загружаем исходники…</p>`;return;}
    const rows = scenes.length ? scenes.map(s => s.n) : [];
    const other = takesBy(null);
    const why = !canUpload ? "Нет права загружать материалы" : !window.SbShooting?.upload ? "Загрузка съёмки недоступна: обновите кабинет" : !transport() ? "Загрузка недоступна: обновите кабинет" : "";
    const row = (scene, label) => {
      const list = takesBy(scene);list.forEach(measure);
      return `<div class="re-track re-track--take"><span class="re-track__name">${esc(label)}</span><div class="re-takes">${list.map((u, i) => {
        const on = take && take.id === u.id, secs = takeDurations.get(u.id);
        return `<button type="button" class="re-take-btn${on ? " is-on" : ""}" data-take-id="${esc(u.id)}" data-scene="${esc(scene ?? "")}" data-number="${i + 1}" aria-pressed="${on}" title="${esc(`${scene ? "Сцена " + scene : "Другое"}, дубль ${i + 1}: ${u.name}`)}">д${i + 1}${secs ? ` · ${secs} с` : ""}</button>`;
      }).join("")}<label class="re-take-add${why ? " is-off" : ""}" title="${esc(why || "Загрузить ещё дубль")}"><input type="file" accept="video/*,.mov,.mp4" data-add="${esc(scene ?? "")}"${why ? " disabled" : ""}><span aria-hidden="true">＋</span><span class="re-sr">Загрузить ещё дубль${scene ? " сцены " + scene : ""}</span></label></div></div>`;
    };
    node.innerHTML = (rows.length ? rows.map(n => row(n, `Сц.${n}`)).join("") : `<p class="muted">В сценарии нет сцен — дубли показываются в «Другое».</p>`)
      + (other.length || !rows.length ? row(null, "Другое") : "")
      + `<p class="muted re-src-note">Нажмите дубль — он встанет вместо выделенного отрезка; «＋» — загрузить ещё.${shootingError ? " " + esc(shootingError) : ""}</p>`;
  }
  /* Байты загрузки — как на «Съёмке»: CSRF из контекста или api.raw оболочки. */
  function transport() {
    const csrf = ctx.csrfToken ?? ctx.api?.csrfToken ?? null;
    if (csrf) return {headers: {"X-CSRF-Token": csrf}};
    const raw = ctx.api?.raw;if (typeof raw !== "function") return null;
    return {headers: {}, fetchImpl: async (url, init = {}) => {
      const target = String(url).replace(/^\/content\//, "").split("?")[0];
      const {"X-CSRF-Token": _csrf, ...headers} = init.headers || {};
      try {const result = await raw(init.method || "GET", target, init.body, headers);return result && typeof result.json === "function" ? result : {ok: true, status: 200, json: async () => result};}
      catch (error) {if (!error?.status) throw error;return {ok: false, status: error.status, json: async () => ({error: error.message, details: error.details || {code: error.code, upload: error.upload}})};}
    }};
  }
  async function addTake(file, scene) {
    const way = transport(), up = window.SbShooting?.upload;if (!file || !way || !up || !idea?.ideaId) return;
    status(`Загружаем «${file.name}»…`);
    try {
      await up.upload({file, ideaId: idea.ideaId, frame: scene, companyCode: ctx.companyCode, ...way, signal: ctx.signal,
        onProgress: (offset, size) => {if (root.isConnected) status(`Загружаем «${file.name}»: ${size ? Math.floor(offset / size * 100) : 0} %`);}});
      if (ctx.signal.aborted) return;status(`«${file.name}» загружен.`);await loadShooting();
    } catch (error) {if (!ctx.signal.aborted) status("Не загружено: " + (error?.message || "ошибка сети"));}
  }
  function toggleSources() {
    sources = !sources;root.classList.toggle("is-sources", sources);
    const button = $("[data-sources]");button.textContent = sources ? "Исходники ▴" : "Исходники ▾";button.setAttribute("aria-expanded", String(sources));
    $("[data-src]").hidden = !sources;
    if (sources) {renderSources();if (shooting === null) void loadShooting();}
    renderMarks();
  }

  /* ---------- Ручные правки: EDL v1 к выбранной версии ---------- */
  function loadEdl() {
    key = draftKey(ctx.companyCode, current.id, base.version);
    edl = readDraft(key) || (duration ? ops.initial(duration) : null);selected = {track: "video", index: 0};
  }
  const pristine = () => !edl || JSON.stringify(edl) === JSON.stringify(ops.initial(duration || ops.total(edl.video)));
  const edlTrack = () => edl[selected.track];
  function renderEdl() {
    const strip = $("[data-edl]");
    if (!edl) {strip.innerHTML = `<p class="muted">Загружаем длительность ролика…</p>`;$("[data-gain-row]").innerHTML = "";$("[data-total]").textContent = "";return;}
    const lane = (name, label) => `<div class="re-track re-track--edl"><span class="re-track__name">${label}</span><ol class="re-clips">${edl[name].map((clip, i) => {
      const on = selected.track === name && selected.index === i;
      return `<li style="flex-grow:${len(clip)}"><button type="button" draggable="true" data-track="${name}" data-index="${i}" class="re-eclip re-eclip--${name}${on ? " is-on" : ""}${clip.muted ? " is-muted" : ""}"
        aria-pressed="${on}" aria-label="${label}, клип ${i + 1}: ${clock(clip.inMs)}–${clock(clip.outMs)}" title="${esc(`${clock(clip.inMs)}–${clock(clip.outMs)} исходника`)}">${sec(len(clip))} с${name === "audio" ? (clip.muted ? " · без звука" : ` · ${Math.round(clip.gain * 100)}%`) : ""}</button></li>`;
    }).join("")}</ol></div>`;
    strip.innerHTML = lane("video", "Видео") + lane("audio", "Звук");
    const clip = edl.audio[selected.index];
    $("[data-gain-row]").innerHTML = selected.track === "audio" && clip
      ? `<label class="re-vol">Громкость<input type="range" min="0" max="200" step="5" value="${Math.round(clip.gain * 100)}" data-field="gain"${clip.muted ? " disabled" : ""}><output data-gain-out>${Math.round(clip.gain * 100)}%</output></label>
         <label class="re-check"><input type="checkbox" data-field="muted"${clip.muted ? " checked" : ""}> Без звука</label>`
      : `<span class="muted re-hint">Выберите клип звука — появятся громкость и «Без звука».</span>`;
    $("[data-speed]").value = String(edl.speed);
    $("[data-total]").textContent = `Итог: ${sec(ops.total(edl.video) / edl.speed)} с${edl.speed !== 1 ? ` (скорость ${String(edl.speed).replace(".", ",")}×)` : ""}`;
  }
  const update = next => {edl = next;writeDraft(key, edl);renderEdl();};
  /* Место на дорожке по текущему кадру исходника; если кадр вырезан — 0 (разделить там нельзя, будет подсказка). */
  const timelineNow = name => {
    const src = (player.currentTime || 0) * 1000;let start = 0;
    for (const clip of edl[name]) {if (src >= clip.inMs && src < clip.outMs) return start + src - clip.inMs;start += len(clip);}
    return 0;
  };
  function op(name) {
    if (!edl) {status("Сначала дождитесь длительности ролика.");return;}
    const t = selected.track, list = edlTrack();
    if (name === "split") {const next = ops.split(list, timelineNow(t));if (next === list) {status("Поставьте курсор внутрь клипа (не ближе 0,1 с к краю) и нажмите «Разделить здесь».");return;}status("");update({...edl, [t]: next});}
    else if (name === "remove") {
      const next = ops.remove(list, selected.index, t === "video");
      if (next === list) {status("На видеодорожке должен остаться хотя бы один клип.");return;}
      status("");selected.index = Math.max(0, Math.min(selected.index, next.length - 1));update({...edl, [t]: next});
    } else if (name === "left" || name === "right") {
      const delta = name === "left" ? -1 : 1, next = ops.move(list, selected.index, delta);if (next === list) return;
      selected.index += delta;update({...edl, [t]: next});
    } else if (name === "reset") {writeDraft(key, null);edl = duration ? ops.initial(duration) : null;selected = {track: "video", index: 0};$("[data-comment]").value = "";renderEdl();status("Ручные правки сброшены.");}
    else if (name === "submit") void submitEdl();
  }
  async function submitEdl() {
    if (busy) return;
    if (pristine()) {status("Ручных правок пока нет.");return;}
    if (!current.id) {status("Ролик ещё не взят в Монтаж — откройте его заново.");return;}
    const comment = $("[data-comment]").value.trim().slice(0, 500), sent = edl, sentKey = key, version = base.version;
    busy = true;status("Отправляем в монтаж…");$("[data-op=submit]").disabled = true;
    try {
      const result = await ctx.api.post(`crm/autoposting/reels/${current.id}/edits`, {clientRequestId: requestId(), baseVersion: version, kind: "edl", edl: sent, comment});
      if (ctx.signal.aborted || !root.isConnected) return;
      const edit = result.edit || {};
      writeDraft(sentKey, null);
      notifyHugh(ctx, current, edit, `Правки монтажа к ${number ? "№" + number : "«" + current.title + "»"} v${version} отправлены${edit.taskId ? ` (задача №${edit.taskId})` : ""}${comment ? ": " + comment : ""}.`);
      if (result.reel) {current = result.reel;base = versionOf(base.version) || base;onChange?.(result.reel);}
      if (key === sentKey) {edl = duration ? ops.initial(duration) : null;selected = {track: "video", index: 0};$("[data-comment]").value = "";}
      renderHead();renderEdl();
      status(`Список правок отправлен в монтаж${edit.taskId ? `: задача №${edit.taskId}` : ""}. Новая версия придёт в чат и появится здесь как v${nextVersion()}.`);
    } catch (error) {if (!ctx.signal.aborted) status("Не отправлено: " + (error?.message || "ошибка сети") + ". Правки сохранены в этом браузере.");}
    finally {busy = false;$("[data-op=submit]").disabled = false;}
  }
  function toggleManual() {
    manual = !manual;root.classList.toggle("is-manual", manual);
    const button = $("[data-manual]");button.textContent = manual ? "Ручные правки ▴" : "Ручные правки ▾";button.setAttribute("aria-expanded", String(manual));
    $("[data-man]").hidden = !manual;if (manual) renderEdl();
  }

  /* ---------- Отметка перетаскиванием по дорожкам, нажатие — курсор ---------- */
  const lane = () => root.querySelector("[data-lane=video]").getBoundingClientRect();
  const msAt = clientX => {const r = lane();return r.width ? Math.round(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration / 100) * 100 : 0;};
  let drag = null;
  $("[data-tl]").addEventListener("pointerdown", event => {
    if (!duration || event.button > 0) return;
    drag = {start: msAt(event.clientX), x: event.clientX, moved: false};
    try {event.currentTarget.setPointerCapture?.(event.pointerId);} catch (_) {}
  });
  $("[data-tl]").addEventListener("pointermove", event => {
    if (!drag) return;if (Math.abs(event.clientX - drag.x) > 4) drag.moved = true;
    if (drag.moved) {const at = msAt(event.clientX);setMark(Math.min(drag.start, at), Math.max(drag.start, at));}
  });
  const endDrag = event => {
    if (!drag) return;const d = drag;drag = null;
    if (!d.moved) {player.currentTime = d.start / 1000;renderMarks();return;}
    const at = msAt(event.clientX), from = Math.min(d.start, at), to = Math.max(d.start, at);
    if (to - from < MIN) {setMark(null, null);return;}
    setMark(from, to);$("[data-ask]").focus({preventScroll: true});
  };
  $("[data-tl]").addEventListener("pointerup", endDrag);
  $("[data-tl]").addEventListener("pointercancel", () => {drag = null;});

  function readMarkFields() {
    const from = parseClock($("[data-mark=from]").value), to = parseClock($("[data-mark=to]").value);
    mark = {from, to};renderMarks();renderTake();
  }
  function validMark() {
    return mark.from !== null && mark.to !== null && mark.to > mark.from && (!duration || mark.to <= duration + 50);
  }
  async function send() {
    if (busy) return;
    readMarkFields();
    if (!validMark()) {status("Отметьте отрезок: «от» меньше «до», в пределах ролика.");return;}
    const text = $("[data-ask]").value.trim();
    if (!text && !take) {status("Напишите, что изменить, или выберите дубль в «Исходниках».");return;}
    if (!current.id) {status("Ролик ещё не взят в Монтаж — откройте его заново.");return;}
    const replace = take ? `Заменить ${markText()} на ${takeText(take)} (исходник «${take.name}», загрузка №${take.id}).` : "";
    const comment = [replace, text].filter(Boolean).join(" ").slice(0, 2000);
    busy = true;status("Отправляем Хью…");$("[data-send]").disabled = true;
    try {
      const result = await ctx.api.post(`crm/autoposting/reels/${current.id}/edits`, {clientRequestId: requestId(), baseVersion: base.version, kind: "request",
        startMs: mark.from, endMs: Math.min(mark.to, duration || mark.to), comment});
      if (ctx.signal.aborted || !root.isConnected) return;
      const edit = result.edit || {};
      notifyHugh(ctx, current, edit, `Хью, измени ${number ? "№" + number : "«" + current.title + "»"} v${base.version}, ${markText()}: ${comment}`);
      if (result.reel) {current = result.reel;base = versionOf(base.version) || base;onChange?.(result.reel);}
      $("[data-ask]").value = "";take = null;setMark(null, null);if (sources) renderSources();renderHead();
      status(`Отправлено Хью${edit.taskId ? `: задача №${edit.taskId}` : ""}. Новая версия придёт в чат и появится здесь как v${nextVersion()}.`);
    } catch (error) {if (!ctx.signal.aborted) status("Не отправлено: " + (error?.message || "ошибка сети") + ". Текст остался в поле.");}
    finally {busy = false;$("[data-send]").disabled = false;}
  }

  root.addEventListener("click", event => {
    const button = event.target.closest("button");if (!button || !root.contains(button)) return;
    if (button.hasAttribute("data-close")) return close();
    if (button.hasAttribute("data-play") || button === player) {if (player.paused) void player.play()?.catch?.(() => {});else player.pause();return;}
    if (button.hasAttribute("data-sources")) return toggleSources();
    if (button.hasAttribute("data-manual")) return toggleManual();
    if (button.dataset.op) return op(button.dataset.op);
    if (button.dataset.track) {
      selected = {track: button.dataset.track, index: Number(button.dataset.index)};
      const clip = edlTrack()[selected.index];if (clip) {try {player.currentTime = clip.inMs / 1000;} catch (_) {}renderMarks();}
      renderEdl();root.querySelector(`[data-track="${selected.track}"][data-index="${selected.index}"]`)?.focus({preventScroll: true});return;
    }
    if (button.hasAttribute("data-send")) return void send();
    if (button.hasAttribute("data-clear")) {take = null;setMark(null, null);if (sources) renderSources();status("");return;}
    if (button.hasAttribute("data-untake")) {take = null;renderTake();renderSources();return;}
    if (button.dataset.takeId) {
      const id = Number(button.dataset.takeId), upload = (shooting || []).find(u => u.id === id);
      take = take && take.id === id ? null : {id, scene: button.dataset.scene ? Number(button.dataset.scene) : null, number: Number(button.dataset.number), name: upload?.name || ""};
      renderSources();renderTake();
      if (take && !validMark()) status("Отметьте на дорожке отрезок, который заменить этим дублем.");
      return;
    }
    if (button.dataset.version) {
      const next = versionOf(Number(button.dataset.version));if (!next || next.version === base.version) return;
      player.pause();base = next;take = null;setMark(null, null);loadVersion();loadEdl();renderHead();renderTracks();renderEdl();status("");
    }
  });
  root.addEventListener("change", event => {
    const t = event.target;
    if (t.dataset.mark) readMarkFields();
    else if (t.dataset.field === "gain" && edl) update({...edl, audio: ops.set(edl.audio, selected.index, {gain: Math.max(0, Math.min(200, Number(t.value))) / 100})});
    else if (t.dataset.field === "muted" && edl) update({...edl, audio: ops.set(edl.audio, selected.index, {muted: t.checked})});
    else if (t.matches("[data-speed]") && edl) {const v = Number(t.value);if (SPEEDS.includes(v)) {update({...edl, speed: v});player.playbackRate = v;}}
    else if (t.dataset.add !== undefined && t.files?.[0]) {const file = t.files[0];t.value = "";void addTake(file, t.dataset.add === "" ? null : Number(t.dataset.add));}
  });
  root.addEventListener("input", event => {
    const t = event.target;if (t.dataset.field === "gain") {const out = root.querySelector("[data-gain-out]");if (out) out.textContent = `${t.value}%`;}
  });
  /* Перетаскивание клипа на место другого клипа той же дорожки — то же «переставить», что ← →. */
  let dragged = null;
  root.addEventListener("dragstart", event => {const b = event.target.closest?.("[data-track]");if (b) {dragged = {track: b.dataset.track, index: Number(b.dataset.index)};try {event.dataTransfer?.setData("text/plain", "clip");} catch (_) {}}});
  root.addEventListener("dragover", event => {if (dragged && event.target.closest?.(`[data-track="${dragged.track}"]`)) event.preventDefault();});
  root.addEventListener("drop", event => {
    const b = event.target.closest?.("[data-track]");if (!dragged || !b || b.dataset.track !== dragged.track || !edl) {dragged = null;return;}event.preventDefault();
    const list = [...edl[dragged.track]], [clip] = list.splice(dragged.index, 1), to = Number(b.dataset.index);list.splice(to, 0, clip);
    selected = {track: dragged.track, index: to};dragged = null;update({...edl, [selected.track]: list});
  });
  root.addEventListener("dragend", () => {dragged = null;});
  player.addEventListener("click", () => {if (player.paused) void player.play()?.catch?.(() => {});else player.pause();});
  player.addEventListener("play", () => {$("[data-play]").hidden = true;});
  player.addEventListener("pause", () => {$("[data-play]").hidden = !safeUrl(base.mediaUrl);});
  player.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(player.duration) && player.duration > 0) {const measured = Math.round(player.duration * 1000);if (!duration || Math.abs(measured - duration) > 500) {const fresh = pristine();duration = measured;if (!edl || fresh) edl = readDraft(key) || ops.initial(duration);renderTracks();renderEdl();}}
  });
  player.addEventListener("timeupdate", renderMarks);
  root.addEventListener("keydown", event => {if (event.key === "Escape") {event.stopPropagation();close();}});
  ctx.signal.addEventListener("abort", () => {player.pause?.();root.remove();}, {once: true});
  function close() {player.pause?.();root.remove();host.querySelector("[data-edit]")?.focus();}
  loadVersion();loadEdl();renderHead();renderTracks();renderEdl();
  $("#re-title").focus({preventScroll: true});
  return {root, close, get mark() {return {...mark};}, get take() {return take ? {...take} : null;}, get version() {return base.version;}, get edl() {return edl;}, get selected() {return {...selected};}};
}
/* Запись в личный чат пользователя с Хью: точка «hugh-chat» слушает это событие.
   Сервер хранит тот же журнал в правках ролика, поэтому запись не теряется, если чат ещё не открыт. */
function notifyHugh(ctx, reel, edit, text) {
  window.dispatchEvent(new CustomEvent("synapse:hugh-chat", {detail: {companyCode: ctx.companyCode, source: "content-materials", reelId: reel.id, editId: edit.id, taskId: edit.taskId, text}}));
}
sb.reelEditor = {open, ops, clock, parseClock, parseScenes, layoutScenes};
})();
