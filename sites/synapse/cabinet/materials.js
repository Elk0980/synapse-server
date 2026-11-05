(() => {
"use strict";
/* Контент → Материалы (агент Г, задача №98). Модуль «content-materials» по контракту А:
   сетка смонтированных рилсов, фильтры, предпросмотр в маске площадки, «Скачать», «Создать публикацию».
   Данные: CRM /autoposting/reels (права autoposting.view/edit проверяет сервер). Публикацию модуль не отправляет:
   «Создать публикацию» делает черновик существующего автопостинга, дальше его согласование и план. */
const sb = window.SbCabinet = window.SbCabinet || {};
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const safeUrl = value => {try {const url = new URL(value, location.href);return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";} catch (_) {return "";}};
/* Ориентировочные безопасные зоны 9:16 в процентах кадра: шапка, низ с подписью, правая колонка кнопок.
   Это наша разметка по интерфейсам площадок, а не официальные значения: точный вид зависит от версии приложения. */
const PLATFORMS = [
  {id: "instagram", label: "Instagram Reels", top: 12, bottom: 22, rail: 14, railFrom: 48, head: "Reels", buttons: ["♡", "💬", "➤", "⋯"]},
  {id: "tiktok", label: "TikTok", top: 10, bottom: 20, rail: 16, railFrom: 40, head: "Подписки · Рекомендации", buttons: ["◉", "♡", "💬", "⤴"]},
  {id: "youtube_shorts", label: "YouTube Shorts", top: 10, bottom: 24, rail: 15, railFrom: 46, head: "Shorts", buttons: ["👍", "👎", "💬", "⤴"]},
  {id: "vk", label: "VK Клипы", top: 11, bottom: 21, rail: 15, railFrom: 46, head: "Клипы", buttons: ["♡", "💬", "⤴", "⋯"]},
  {id: "telegram", label: "Telegram", top: 12, bottom: 14, rail: 0, railFrom: 0, head: "Канал · история", buttons: []},
  {id: "max", label: "MAX", top: 11, bottom: 14, rail: 0, railFrom: 0, head: "MAX · история", buttons: []}
];
const platformOf = id => PLATFORMS.find(item => item.id === id) || PLATFORMS[0];
function maskHtml(id) {
  const p = platformOf(id);
  const rail = p.rail ? `<div class="mt-mask__rail" style="right:0;top:${p.railFrom}%;width:${p.rail}%;bottom:${p.bottom}%">${p.buttons.map(b => `<span>${esc(b)}</span>`).join("")}</div>` : "";
  return `<div class="mt-mask" data-mask="${esc(p.id)}" aria-hidden="true">
    <div class="mt-mask__zone mt-mask__top" style="height:${p.top}%"><span>${esc(p.head)}</span></div>
    ${rail}
    <div class="mt-mask__zone mt-mask__bottom" style="height:${p.bottom}%"><i></i><b></b><b class="short"></b><em>подпись и ник</em></div>
    <div class="mt-mask__safe" style="top:${p.top}%;bottom:${p.bottom}%;right:${p.rail}%"><em>безопасная зона</em></div></div>`;
}
sb.reelMask = {PLATFORMS, html: maskHtml, label: id => platformOf(id).label};

/* Открыть черновик публикации в «Постинге» — одно место и для «Материалов», и для карточки рилса в чате (№166). */
sb.openPostingDraft = (ctx, postId) => {
  sb.pendingMaterialOpen = {companyCode: ctx.companyCode, postId, source: "materials"};
  ctx.navigate("content-factory/plan");
  setTimeout(() => window.dispatchEvent(new CustomEvent("sb:content-factory-open-draft", {detail: {companyCode: ctx.companyCode, postId, source: "materials"}})), 0);
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9_.:-]/g, "");
const dateRu = value => value ? value.split("-").reverse().join(".") : "без даты";
const STATE = {pending: "ждёт монтажа", in_progress: "в монтаже", done: "готово", cancelled: "отменено"};

function create(el, ctx) {
  const canEdit = ctx.can("autoposting.edit");
  const state = {filters: {from: "", to: "", platform: ""}, reels: [], open: null, platform: "", version: null, busy: false, epoch: 0};
  const api = {
    list: () => ctx.api.get("crm/autoposting/reels", state.filters),
    get: id => ctx.api.get("crm/autoposting/reels/" + id),
    adopt: postId => ctx.api.post("crm/autoposting/reels", {postId}),
    publication: (id, body) => ctx.api.post("crm/autoposting/reels/" + id + "/publication", body),
    post: id => ctx.api.get("crm/autoposting/posts/" + id),
    toChat: (id, body) => ctx.api.post("crm/autoposting/reels/" + id + "/chat-approvals", body)
  };
  el.classList.add("mt-view");
  el.innerHTML = `<header class="mt-head"><h1>Материалы</h1><p class="muted">Смонтированные рилсы: предпросмотр по площадкам, скачивание, публикация и правки.</p>
      ${canEdit ? `<button type="button" class="plain-button primary mt-upload-open" data-upload-open>Загрузить ролик</button>` : ""}</header>
    ${canEdit ? `<form class="mt-upload" data-upload hidden>
      <h2>Новый ролик</h2>
      <p class="muted">Готовый смонтированный MP4 или WebM до 60 МБ. Ролик появится в сетке как v1; на площадки ничего не уходит.</p>
      <label>Файл<input type="file" name="file" accept="video/mp4,video/webm,.mp4,.webm" required></label>
      <label>Название<input type="text" name="title" maxlength="200" required placeholder="Например: №2 «Первый визит» v2"></label>
      <label>Дата выхода<input type="date" name="releaseDate"></label>
      <fieldset class="mt-targets"><legend>Площадки</legend>${PLATFORMS.map(p => `<label><input type="checkbox" name="platforms" value="${p.id}"> ${esc(p.label)}</label>`).join("")}</fieldset>
      <p class="mt-status" role="status" data-upload-status></p>
      <div class="mt-actions"><button type="submit" class="plain-button primary" data-upload-submit>Загрузить</button><button type="button" class="plain-button" data-upload-cancel>Отмена</button></div>
    </form>` : ""}
    <form class="mt-filters" data-filters>
      <label>Выход с<input type="date" name="from"></label><label>по<input type="date" name="to"></label>
      <label>Площадка<select name="platform"><option value="">Все площадки</option>${PLATFORMS.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join("")}</select></label>
      <button class="plain-button" type="reset">Сбросить</button></form>
    <p class="mt-status" role="status" data-status></p>
    <ul class="mt-grid" data-grid></ul>
    <section class="mt-detail" data-detail hidden></section>`;
  const $ = selector => el.querySelector(selector);
  const status = text => {$("[data-status]").textContent = text || "";};
  const fail = error => status(error?.status === 403 ? "Нет доступа к материалам этой компании." : "Не удалось загрузить: " + (error?.message || "ошибка сети"));

  async function load() {
    const epoch = ++state.epoch;status("Загружаем материалы…");
    try {
      const result = await api.list();if (epoch !== state.epoch || ctx.signal.aborted) return;
      if (String(result.companyCode).toLowerCase() !== String(ctx.companyCode).toLowerCase()) return;
      state.reels = Array.isArray(result.reels) ? result.reels : [];renderGrid();
      status(state.reels.length ? `Роликов: ${state.reels.length}` : "Смонтированных рилсов по этим фильтрам нет. Ролики появляются после монтажа или из видео контент-плана.");
    } catch (error) {if (!ctx.signal.aborted) fail(error);}
  }
  function renderGrid() {
    $("[data-grid]").innerHTML = state.reels.map(reel => {
      const media = safeUrl(reel.currentVersion?.mediaUrl);
      return `<li class="mt-card"><button type="button" class="mt-card__open" data-open="${esc(reel.key)}" aria-label="Открыть ${esc(reel.title)}">
        <span class="mt-thumb">${media ? `<video muted playsinline preload="metadata" src="${esc(media)}#t=0.5"></video>` : ""}<span class="mt-badge">v${esc(reel.currentVersion?.version ?? 1)}</span>${reel.openEdits ? `<span class="mt-badge mt-badge--edit">правок: ${esc(reel.openEdits)}</span>` : ""}</span>
        <span class="mt-card__body"><strong>${esc(reel.title)}</strong><span class="muted">Выход: ${esc(dateRu(reel.releaseDate))}${reel.source === "plan" ? " · из контент-плана" : ""}</span>
        <span class="mt-chips">${(reel.platforms || []).map(id => `<span>${esc(platformOf(id).label)}</span>`).join("")}</span></span></button></li>`;
    }).join("");
  }
  async function open(key) {
    const summary = state.reels.find(reel => reel.key === key);if (!summary) return;
    state.open = {...summary, versions: [summary.currentVersion].filter(Boolean), log: []};
    state.platform = summary.platforms?.[0] || PLATFORMS[0].id;state.version = summary.currentVersion?.version ?? 1;
    renderDetail();
    if (summary.id) {
      try {const full = await api.get(summary.id);if (state.open?.key !== key || ctx.signal.aborted) return;state.open = full;state.version = full.currentVersion?.version ?? 1;renderDetail();}
      catch (error) {if (!ctx.signal.aborted) fail(error);}
    }
  }
  function close() {state.open = null;$("[data-detail]").hidden = true;$("[data-grid]").hidden = false;$("[data-filters]").hidden = false;const opener = $("[data-upload-open]");if (opener) opener.hidden = false;}
  const currentVersion = () => (state.open.versions || []).find(v => v.version === state.version) || state.open.currentVersion;
  function renderDetail() {
    const reel = state.open, version = currentVersion(), media = safeUrl(version?.mediaUrl), node = $("[data-detail]");
    $("[data-grid]").hidden = true;$("[data-filters]").hidden = true;node.hidden = false;
    if (!state.busy) toggleUpload(false);const opener = $("[data-upload-open]");if (opener) opener.hidden = true;
    const versions = reel.versions || [];
    node.innerHTML = `<button type="button" class="plain-button mt-back" data-back>← Все материалы</button>
      <h2 tabindex="-1" data-title>${esc(reel.title)}</h2>
      <p class="muted">Выход: ${esc(dateRu(reel.releaseDate))} · версия v${esc(version?.version ?? 1)}${version?.note ? " · " + esc(version.note) : ""}</p>
      <div class="mt-layout">
        <div class="mt-phone"><div class="mt-screen">${media ? `<video controls playsinline preload="metadata" src="${esc(media)}" data-player></video>` : "<p>Файл не найден</p>"}${maskHtml(state.platform)}</div>
          <label class="mt-toggle"><input type="checkbox" data-mask-toggle checked> Показывать маску площадки</label></div>
        <div class="mt-side">
          <fieldset class="mt-platforms"><legend>Площадка</legend>${PLATFORMS.map(p => `<label><input type="radio" name="mt-platform" value="${p.id}"${p.id === state.platform ? " checked" : ""}> ${esc(p.label)}</label>`).join("")}</fieldset>
          <p class="muted mt-note">Тёмные зоны — где лягут шапка, подпись и кнопки ${esc(platformOf(state.platform).label)}. Титры и лицо держите в безопасной зоне. Зоны ориентировочные.</p>
          ${versions.length > 1 ? `<label>Версия<select data-version>${versions.map(v => `<option value="${v.version}"${v.version === state.version ? " selected" : ""}>v${v.version}${v.editId ? " · правка №" + esc(v.editId) : ""}</option>`).join("")}</select></label>` : ""}
          <div class="mt-actions">
            ${media ? `<a class="plain-button" href="${esc(media)}" download="${esc(reel.title)} v${esc(version?.version ?? 1)}.mp4" data-download>Скачать</a>` : ""}
            ${canEdit ? (reel.id ? `<button type="button" class="plain-button primary" data-publish>Создать публикацию</button>` : `<button type="button" class="plain-button" data-open-post>Открыть публикацию в «Постинге»</button>`) : ""}
            ${canEdit && sb.reelEditor ? `<button type="button" class="plain-button" data-edit>Редактировать</button>` : ""}
            ${canEdit ? `<button type="button" class="plain-button primary" data-chat-open>Отправить на согласование в чат</button>` : ""}
          </div>
          ${canEdit ? `<form class="mt-chat" data-chat-form hidden>
            <h3>Согласование в чате</h3>
            <p class="muted">В общем чате компании появится карточка с роликом v${esc(version?.version ?? 1)}: её можно посмотреть и нажать «Согласовано» или «Нужны правки». Ничего не публикуется — время публикации ставят в «Постинге».</p>
            <label>Подпись к публикации<textarea name="text" rows="4" maxlength="20000" placeholder="Текст, который выйдет под рилсом"></textarea></label>
            <fieldset class="mt-targets" data-chat-targets><legend>Площадки</legend>${PLATFORMS.map(p => `<label><input type="checkbox" value="${p.id}"${(reel.platforms?.length ? reel.platforms : [state.platform]).includes(p.id) ? " checked" : ""}> ${esc(p.label)}</label>`).join("")}</fieldset>
            <div class="mt-actions"><button type="submit" class="plain-button primary" data-chat-submit>Отправить в чат</button><button type="button" class="plain-button" data-chat-cancel>Отмена</button></div>
            <p class="mt-status" role="status" data-chat-status></p>
          </form>` : ""}
          ${canEdit && reel.id ? `<fieldset class="mt-targets" data-targets><legend>Площадки публикации</legend>${PLATFORMS.map(p => `<label><input type="checkbox" value="${p.id}"${(reel.platforms?.length ? reel.platforms : [state.platform]).includes(p.id) ? " checked" : ""}> ${esc(p.label)}</label>`).join("")}</fieldset>` : ""}
          <p class="mt-status" role="status" data-detail-status></p>
          ${(reel.edits || []).length ? `<h3>Правки</h3><ul class="mt-edits">${reel.edits.map(e => `<li><strong>№${esc(e.id)}</strong> к v${esc(e.baseVersion)} · ${esc(STATE[e.status] || e.status)}${e.resultVersion ? " → v" + esc(e.resultVersion) : ""}<br><span class="muted">${esc(e.kind === "request" ? e.comment : "список правок монтажа" + (e.comment ? ": " + e.comment : ""))}</span></li>`).join("")}</ul>` : ""}
        </div></div>`;
    node.querySelector("[data-title]").focus({preventScroll: true});
  }
  const detailStatus = text => {const target = el.querySelector("[data-detail-status]");if (target) target.textContent = text;};
  async function ensureReel() {
    if (state.open.id) return state.open;
    const adopted = await api.adopt(state.open.postId);state.open = adopted;return adopted;
  }
  async function publish() {
    if (state.busy) return;const targets = [...el.querySelectorAll("[data-targets] input:checked")].map(input => input.value);
    if (!targets.length) {detailStatus("Отметьте хотя бы одну площадку публикации.");return;}
    state.busy = true;detailStatus("Создаём черновик публикации…");
    try {
      const result = await api.publication(state.open.id, {version: state.version, platformIds: targets});if (ctx.signal.aborted) return;
      state.open = result.reel;renderDetail();
      detailStatus(`Черновик публикации №${result.post.id} создан. Ничего не отправлено: подпись, согласование и время — в «Постинге».`);
      const link = document.createElement("button");link.type = "button";link.className = "plain-button";link.textContent = "Открыть в «Постинге»";
      link.addEventListener("click", () => openPost(result.post.id));el.querySelector("[data-detail-status]").append(" ", link);
    } catch (error) {detailStatus(error?.code === "PROFILE_CHANGED" ? "Данные компании изменились — обновите страницу и повторите." : "Не удалось создать публикацию: " + (error?.message || "ошибка"));}
    finally {state.busy = false;}
  }
  const openPost = postId => sb.openPostingDraft(ctx, postId);
  /* №166: рилс на согласование в общий чат компании. Сервер привязывает версию к черновику публикации,
     переводит его «на согласование» и создаёт запрос; карточку в чат пишет content. Повтор того же ключа не дублирует. */
  const chatStatus = text => {const target = el.querySelector("[data-chat-status]");if (target) target.textContent = text || "";};
  async function openChat() {
    const form = el.querySelector("[data-chat-form]");if (!form) return;
    form.hidden = false;form.dataset.key = uid();chatStatus("");form.elements.text.focus({preventScroll: true});
    const postId = state.open.postId;
    if (postId && !form.elements.text.value) {
      try {const post = await api.post(postId);if (!ctx.signal.aborted && state.open?.postId === postId && !form.elements.text.value) form.elements.text.value = post.text || "";}
      catch (_) {/* подпись можно ввести вручную */}
    }
  }
  async function sendToChat(event) {
    event.preventDefault();if (state.busy) return;
    const form = event.target, platformIds = [...form.querySelectorAll("[data-chat-targets] input:checked")].map(input => input.value);
    if (!platformIds.length) {chatStatus("Отметьте хотя бы одну площадку.");return;}
    const text = form.elements.text.value.trim();
    state.busy = true;form.querySelector("[data-chat-submit]").disabled = true;chatStatus("Отправляем в общий чат компании…");
    try {
      const reel = await ensureReel();if (ctx.signal.aborted) return;
      const result = await api.toChat(reel.id, {clientRequestId: form.dataset.key || uid(), version: state.version, platformIds, ...(text ? {text} : {})});
      if (ctx.signal.aborted) return;
      const approval = result.approval;
      chatStatus(`Отправлено в общий чат компании: «${approval.title}» v${approval.version}. Статус: ${approval.statusLabel}.`);
      const link = document.createElement("button");link.type = "button";link.className = "plain-button";link.textContent = "Открыть чат";
      link.addEventListener("click", () => ctx.navigate("chats?room=common"));el.querySelector("[data-chat-status]").append(" ", link);
      form.dataset.key = uid();
    } catch (error) {
      chatStatus(error?.code === "CAPTION_REQUIRED" || error?.details?.code === "CAPTION_REQUIRED" ? "Добавьте подпись к публикации: без неё площадки не примут рилс."
        : error?.status === 403 ? "Нет права отправлять материалы этой компании на согласование." : "Не удалось отправить: " + (error?.message || "ошибка сети") + ". Повтор безопасен.");
    } finally {state.busy = false;const submit = el.querySelector("[data-chat-submit]");if (submit) submit.disabled = false;}
  }
  async function edit() {
    if (state.busy) return;state.busy = true;
    try {
      const reel = await ensureReel();if (ctx.signal.aborted) return;
      sb.reelEditor.open(el, {ctx, reel, version: state.version, onChange: next => {state.open = next;state.version = next.currentVersion?.version ?? state.version;renderDetail();}});
    } catch (error) {detailStatus("Не удалось открыть редактор: " + (error?.message || "ошибка"));}
    finally {state.busy = false;}
  }
  /* Загрузка готового ролика владельцем или редактором (№145): тот же путь, что у агента монтажа, но под сессией кабинета.
     1) POST publishing-assets — сырой файл, сервер проверяет формат и лимит 60 МБ, отдаёт {url, sha256};
     2) POST crm/autoposting/reels {title, releaseDate, platforms, mediaUrl, sha256, durationMs} — ролик v1. Сервер не менялся. */
  const UPLOAD_TYPES = {"video/mp4": "MP4", "video/webm": "WebM"}, UPLOAD_LIMIT = 60 * 1024 * 1024;
  const uploadStatus = text => {const target = el.querySelector("[data-upload-status]");if (target) target.textContent = text || "";};
  const fileType = file => UPLOAD_TYPES[file.type] ? file.type : /\.mp4$/i.test(file.name) ? "video/mp4" : /\.webm$/i.test(file.name) ? "video/webm" : "";
  function checkFile(file) {
    if (!file) return "Выберите файл ролика.";
    if (!fileType(file)) return "Это не видео: нужен файл MP4 или WebM.";
    if (!file.size) return "Файл пустой.";
    if (file.size > UPLOAD_LIMIT) return `Файл ${(file.size / 1048576).toFixed(1)} МБ — больше лимита 60 МБ. Сожмите ролик и повторите.`;
    return "";
  }
  /* Длительность читаем из метаданных в браузере; если не прочиталась за 5 с — отправляем без неё, сервер это допускает. */
  const durationOf = file => new Promise(resolve => {
    if (typeof URL.createObjectURL !== "function") return resolve(null);
    let url = "";const done = value => {if (url) URL.revokeObjectURL(url);resolve(Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : null);};
    try {
      const video = document.createElement("video");video.preload = "metadata";video.muted = true;
      const timer = setTimeout(() => done(null), 5000);
      video.onloadedmetadata = () => {clearTimeout(timer);done(video.duration);};
      video.onerror = () => {clearTimeout(timer);done(null);};
      url = URL.createObjectURL(file);video.src = url;
    } catch (_) {done(null);}
  });
  function toggleUpload(show) {
    const form = el.querySelector("[data-upload]");if (!form) return;
    form.hidden = !show;el.querySelector("[data-upload-open]").hidden = show;
    if (show) {form.querySelector("[name=title]").focus({preventScroll: true});} else {form.reset();uploadStatus("");}
  }
  const uploadError = async response => {
    let message = "";try {const data = await response.json();message = data?.error || data?.message || "";} catch (_) {}
    if (response.status === 413) return "Файл больше лимита 60 МБ: сервер его не принял.";
    if (response.status === 415) return message || "Сервер не распознал файл как видео MP4/WebM.";
    if (response.status === 403) return "Нет права загружать ролики в эту компанию.";
    return message ? `Не удалось загрузить файл: ${message}` : `Не удалось загрузить файл (ответ ${response.status}).`;
  };
  async function upload(event) {
    event.preventDefault();if (state.busy) return;
    const form = event.target, fields = form.elements, file = fields.file.files?.[0];
    const problem = checkFile(file);if (problem) {uploadStatus(problem);return;}
    const title = fields.title.value.trim();if (!title) {uploadStatus("Введите название ролика.");return;}
    const platforms = [...form.querySelectorAll("[name=platforms]:checked")].map(input => input.value);
    if (!platforms.length) {uploadStatus("Отметьте хотя бы одну площадку.");return;}
    if (typeof ctx.api.raw !== "function") {uploadStatus("Загрузка недоступна: обновите кабинет.");return;}
    state.busy = true;form.querySelector("[data-upload-submit]").disabled = true;
    try {
      uploadStatus(`Загружаем файл (${(file.size / 1048576).toFixed(1)} МБ)…`);
      const [durationMs, response] = await Promise.all([durationOf(file), ctx.api.raw("POST", "publishing-assets", file, {headers: {"Content-Type": fileType(file)}})]);
      if (ctx.signal.aborted) return;
      if (!response.ok) {uploadStatus(await uploadError(response));return;}
      const asset = await response.json();
      if (!safeUrl(asset?.url)) {uploadStatus("Сервер не вернул адрес файла. Повторите позже.");return;}
      uploadStatus("Файл принят, создаём карточку ролика…");
      const body = {title, releaseDate: fields.releaseDate.value || "", platforms, mediaUrl: asset.url, sha256: typeof asset.sha256 === "string" ? asset.sha256 : ""};
      if (durationMs) body.durationMs = durationMs;
      const reel = await ctx.api.post("crm/autoposting/reels", body);if (ctx.signal.aborted) return;
      state.reels = [reel, ...state.reels.filter(item => item.key !== reel.key)];renderGrid();
      toggleUpload(false);status(`Ролик «${reel.title}» загружен как v${reel.currentVersion?.version ?? 1}. Роликов: ${state.reels.length}.`);
    } catch (error) {
      if (ctx.signal.aborted) return;
      uploadStatus(error?.status === 413 ? "Файл больше лимита 60 МБ: сервер его не принял." : error?.status === 403 ? "Нет права загружать ролики в эту компанию."
        : error?.status ? `Не удалось сохранить ролик: ${error.message || "ответ " + error.status}` : "Ошибка сети: файл не отправлен. Проверьте соединение и повторите.");
    } finally {state.busy = false;const submit = el.querySelector("[data-upload-submit]");if (submit) submit.disabled = false;}
  }
  const uploadForm = el.querySelector("[data-upload]");
  if (uploadForm) {
    uploadForm.addEventListener("submit", upload);
    uploadForm.addEventListener("change", event => {
      if (event.target.name !== "file") return;const file = event.target.files?.[0];
      uploadStatus(file ? checkFile(file) : "");
      if (file && !uploadForm.elements.title.value) uploadForm.elements.title.value = file.name.replace(/\.(mp4|webm)$/i, "").slice(0, 200);
    });
  }
  const onFilter = () => {
    const fields = $("[data-filters]").elements;state.filters = {from: fields.from.value, to: fields.to.value, platform: fields.platform.value};
    if (state.filters.from && state.filters.to && state.filters.from > state.filters.to) {status("Дата «с» позже даты «по».");return;}
    void load();
  };
  $("[data-filters]").addEventListener("change", onFilter);
  $("[data-filters]").addEventListener("reset", () => setTimeout(onFilter, 0));
  $("[data-filters]").addEventListener("submit", event => event.preventDefault());
  el.addEventListener("click", event => {
    const target = event.target.closest("button,a");if (!target || !el.contains(target)) return;
    if (target.dataset.open) void open(target.dataset.open);
    else if (target.hasAttribute("data-upload-open")) toggleUpload(true);
    else if (target.hasAttribute("data-upload-cancel")) {if (!state.busy) toggleUpload(false);}
    else if (target.hasAttribute("data-back")) close();
    else if (target.hasAttribute("data-publish")) void publish();
    else if (target.hasAttribute("data-open-post")) openPost(state.open.postId);
    else if (target.hasAttribute("data-edit")) void edit();
    else if (target.hasAttribute("data-chat-open")) void openChat();
    else if (target.hasAttribute("data-chat-cancel")) {if (!state.busy) {const form = el.querySelector("[data-chat-form]");form.hidden = true;chatStatus("");}}
  });
  el.addEventListener("submit", event => {if (event.target.matches("[data-chat-form]")) void sendToChat(event);});
  el.addEventListener("change", event => {
    if (event.target.name === "mt-platform") {
      state.platform = event.target.value;const screen = el.querySelector(".mt-screen");
      screen.querySelector(".mt-mask").outerHTML = maskHtml(state.platform);
      el.querySelector(".mt-note").textContent = `Тёмные зоны — где лягут шапка, подпись и кнопки ${platformOf(state.platform).label}. Титры и лицо держите в безопасной зоне. Зоны ориентировочные.`;
      el.querySelector(".mt-mask").hidden = !el.querySelector("[data-mask-toggle]").checked;
    } else if (event.target.matches("[data-mask-toggle]")) el.querySelector(".mt-mask").hidden = !event.target.checked;
    else if (event.target.matches("[data-version]")) {state.version = Number(event.target.value);renderDetail();}
  });
  const initial = /^(reel|post)\/(\d+)$/.exec(ctx.route?.path || "");
  return load().then(() => {if (initial) void open(initial[1] + ":" + initial[2]);});
}

const definition = {title: "Материалы", mount: (el, ctx) => create(el, ctx), unmount: el => {el.classList.remove("mt-view");}};
(window.SynapseModulesQueue = window.SynapseModulesQueue || []).push(["content-materials", definition]);
})();
