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

const dateRu = value => value ? value.split("-").reverse().join(".") : "без даты";
const STATE = {pending: "ждёт монтажа", in_progress: "в монтаже", done: "готово", cancelled: "отменено"};

function create(el, ctx) {
  const canEdit = ctx.can("autoposting.edit");
  const state = {filters: {from: "", to: "", platform: ""}, reels: [], open: null, platform: "", version: null, busy: false, epoch: 0};
  const api = {
    list: () => ctx.api.get("crm/autoposting/reels", state.filters),
    get: id => ctx.api.get("crm/autoposting/reels/" + id),
    adopt: postId => ctx.api.post("crm/autoposting/reels", {postId}),
    publication: (id, body) => ctx.api.post("crm/autoposting/reels/" + id + "/publication", body)
  };
  el.classList.add("mt-view");
  el.innerHTML = `<header class="mt-head"><h1>Материалы</h1><p class="muted">Смонтированные рилсы: предпросмотр по площадкам, скачивание, публикация и правки.</p></header>
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
  function close() {state.open = null;$("[data-detail]").hidden = true;$("[data-grid]").hidden = false;$("[data-filters]").hidden = false;}
  const currentVersion = () => (state.open.versions || []).find(v => v.version === state.version) || state.open.currentVersion;
  function renderDetail() {
    const reel = state.open, version = currentVersion(), media = safeUrl(version?.mediaUrl), node = $("[data-detail]");
    $("[data-grid]").hidden = true;$("[data-filters]").hidden = true;node.hidden = false;
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
          </div>
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
  function openPost(postId) {
    sb.pendingMaterialOpen = {companyCode: ctx.companyCode, postId, source: "materials"};
    ctx.navigate("content-factory/plan");
    setTimeout(() => window.dispatchEvent(new CustomEvent("sb:content-factory-open-draft", {detail: {companyCode: ctx.companyCode, postId, source: "materials"}})), 0);
  }
  async function edit() {
    if (state.busy) return;state.busy = true;
    try {
      const reel = await ensureReel();if (ctx.signal.aborted) return;
      sb.reelEditor.open(el, {ctx, reel, version: state.version, onChange: next => {state.open = next;state.version = next.currentVersion?.version ?? state.version;renderDetail();}});
    } catch (error) {detailStatus("Не удалось открыть редактор: " + (error?.message || "ошибка"));}
    finally {state.busy = false;}
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
    else if (target.hasAttribute("data-back")) close();
    else if (target.hasAttribute("data-publish")) void publish();
    else if (target.hasAttribute("data-open-post")) openPost(state.open.postId);
    else if (target.hasAttribute("data-edit")) void edit();
  });
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
