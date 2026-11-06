(() => {
"use strict";
/* Контент-завод → Монтаж (вид content-materials; №98 Г, макет Влада 07.11 — задача доски №207).
   Лента «время сверху вниз»: выше стартовой точки — опубликованные; экран открывается на том, что сейчас у монтажёра
   (смонтированные, отснятые, в монтаже); ниже «↓ впереди» — рилсы плана ещё без материалов.
   Данные только из API кабинета: ролики CRM /autoposting/reels, план /media-mentor, публикации /autoposting/posts,
   загрузки съёмки /shooting/reels, ссылки компании /company-information. Этап выводится из этих данных и сам на клиенте
   не меняется. Публикацию модуль не отправляет: «Создать публикацию» делает черновик автопостинга. */
const sb = window.SbCabinet = window.SbCabinet || {};
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const safeUrl = value => {try {const url = new URL(value, location.href);return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";} catch (_) {return "";}};
const httpsUrl = value => {try {const url = new URL(String(value || ""));return url.protocol === "https:" && !url.username && !url.password ? url.href : "";} catch (_) {return "";}};
/* Ориентировочные безопасные зоны 9:16 в процентах кадра: шапка, низ с подписью, правая колонка кнопок.
   Это наша разметка по интерфейсам площадок, а не официальные значения: точный вид зависит от версии приложения. */
const PLATFORMS = [
  {id: "instagram", short: "IG", label: "Instagram Reels", top: 12, bottom: 22, rail: 14, railFrom: 48, head: "Reels", buttons: ["♡", "💬", "➤", "⋯"]},
  {id: "tiktok", short: "TT", label: "TikTok", top: 10, bottom: 20, rail: 16, railFrom: 40, head: "Подписки · Рекомендации", buttons: ["◉", "♡", "💬", "⤴"]},
  {id: "youtube_shorts", short: "YT", label: "YouTube Shorts", top: 10, bottom: 24, rail: 15, railFrom: 46, head: "Shorts", buttons: ["👍", "👎", "💬", "⤴"]},
  {id: "vk", short: "VK", label: "VK Клипы", top: 11, bottom: 21, rail: 15, railFrom: 46, head: "Клипы", buttons: ["♡", "💬", "⤴", "⋯"]},
  {id: "telegram", short: "TG", label: "Telegram", top: 12, bottom: 14, rail: 0, railFrom: 0, head: "Канал · история", buttons: []},
  {id: "max", short: "MAX", label: "MAX", top: 11, bottom: 14, rail: 0, railFrom: 0, head: "MAX · история", buttons: []}
];
const platformOf = id => PLATFORMS.find(item => item.id === id) || PLATFORMS[0];
/* Площадки плана и публикаций приводятся к id «Материалов»: youtube → youtube_shorts, telegram_channel → telegram. */
const normPlatform = value => {
  const id = String(value || "").toLowerCase();
  if (id.startsWith("instagram")) return "instagram";
  if (id.startsWith("tiktok")) return "tiktok";
  if (id.startsWith("youtube")) return "youtube_shorts";
  if (id.startsWith("vk")) return "vk";
  if (id.startsWith("telegram")) return "telegram";
  if (id.startsWith("max")) return "max";
  return "";
};
const platformList = list => [...new Set((list || []).map(normPlatform).filter(Boolean))].sort((a, b) => PLATFORMS.findIndex(p => p.id === a) - PLATFORMS.findIndex(p => p.id === b));
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

/* Этапы — общая цепочка CfKit. Если CfKit не загрузился, подписи те же (без цвета). */
const STAGE_LABEL = {draft: "Черновик", script_review: "Сценарий на согласовании", script_rework: "Сценарий на доработке", planned: "Запланировано",
  shot: "Отснято", editing: "В монтаже", edit_review: "Монтаж на согласовании", edit_rework: "Монтаж на доработке", ready: "Готово к выходу",
  scheduled: "Запланировано к выходу", published: "Опубликовано", publish_error: "Ошибка публикации", unpublished: "Снято с публикации"};
const kit = () => window.CfKit && window.CfKit.version ? window.CfKit : null;
const chip = id => kit() ? kit().stageChip(id) : `<span class="cfk-chip" data-stage="${esc(id)}">${esc(STAGE_LABEL[id] || id)}</span>`;
/* Группы ленты: выше — вышедшие; сейчас — у монтажёра; впереди — ещё без материалов. */
const ABOVE = new Set(["published", "unpublished"]);
const CUT = new Set(["edit_review", "edit_rework", "ready", "scheduled", "publish_error", "published", "unpublished"]);
const AT_EDITOR = new Set(["shot", "editing"]);
const groupOf = stage => ABOVE.has(stage) ? "above" : CUT.has(stage) || AT_EDITOR.has(stage) ? "now" : "ahead";
const STAGE_RANK = {edit_review: 0, edit_rework: 0, ready: 0, scheduled: 0, publish_error: 0, shot: 1, editing: 2, planned: 3, script_review: 3, script_rework: 3, draft: 3, published: 4, unpublished: 4};
const SORTS = [{id: "date", label: "Дата выхода"}, {id: "stage", label: "Этап: смонтировано → отснято → в монтаже → без материалов"}, {id: "uploads", label: "Новые загрузки сверху"}, {id: "number", label: "Номер"}];

const WD = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const dayOf = value => {const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;};
const dateShort = value => {const d = dayOf(value);return d ? `${WD[d.getDay()]} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}` : "";};
const dateRu = value => value ? value.split("-").reverse().join(".") : "без даты";
const timeIn = (iso, timeZone) => {
  if (!iso) return "";
  try {return new Intl.DateTimeFormat("ru-RU", {timeZone: timeZone || undefined, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"}).format(new Date(iso)).replace(/^./, ch => ch.toUpperCase());}
  catch (_) {return String(iso).slice(0, 16).replace("T", " ");}
};
const STATE = {pending: "ждёт монтажа", in_progress: "в монтаже", done: "готово", cancelled: "отменено"};

/* Публикация площадки по данным автопостинга: подтверждение вне ЛК (receipt) или доставка. */
function platformPublication(posts, platform) {
  for (const post of posts) {
    const receipt = (post.externalReceipts || []).find(item => normPlatform(item.platform) === platform && !item.stale);
    if (receipt) return {state: "published", url: httpsUrl(receipt.url), at: receipt.publishedAt, post};
    const delivery = (post.deliveries || []).find(item => normPlatform(item.channelId) === platform);
    if (delivery?.status === "published") return {state: "published", url: httpsUrl(delivery.url), at: delivery.finishedAt, post};
  }
  for (const post of posts) {
    const targets = platformList(post.platformIds);
    if (!targets.includes(platform)) continue;
    const delivery = (post.deliveries || []).find(item => normPlatform(item.channelId) === platform);
    if (delivery?.status === "publishing" || post.status === "publishing") return {state: "publishing", post};
    if (["failed", "needs_review"].includes(delivery?.status) || ["failed", "needs_review"].includes(post.status)) return {state: "error", post};
    if (post.status === "published" && !(post.deliveries || []).length) return {state: "published", url: "", at: post.updatedAt, post};
    if (post.status === "scheduled") return {state: "scheduled", at: post.scheduledAt, post};
    return {state: "draft", post};
  }
  return {state: "none"};
}
/* Этап по публикациям: вышло хоть на одной площадке → «Опубликовано»; ошибка → «Ошибка публикации»; дата стоит → «Запланировано к выходу». */
function publicationStage(posts) {
  const live = posts.filter(post => !post.deleted && !post.archive?.archivedAt && post.status !== "cancelled");
  if (live.some(post => (post.externalReceipts || []).some(item => !item.stale) || (post.deliveries || []).some(item => item.status === "published") || (post.status === "published" && !(post.deliveries || []).length))) return "published";
  if (live.some(post => ["failed", "needs_review"].includes(post.status))) return "publish_error";
  if (live.some(post => post.status === "scheduled")) return "scheduled";
  return "";
}

function create(el, ctx) {
  const canEdit = ctx.can("autoposting.edit");
  const sameCompany = data => data && (!data.companyCode || String(data.companyCode).toLowerCase() === String(ctx.companyCode).toLowerCase());
  const state = {reels: [], mentor: null, posts: [], shooting: {}, settings: null, info: null, items: [], sort: "date", open: null, item: null,
    platform: "", version: null, busy: false, epoch: 0, uploadIdea: null};
  const api = {
    list: () => ctx.api.get("crm/autoposting/reels"),
    get: id => ctx.api.get("crm/autoposting/reels/" + id),
    adopt: postId => ctx.api.post("crm/autoposting/reels", {postId}),
    publication: (id, body) => ctx.api.post("crm/autoposting/reels/" + id + "/publication", body)
  };
  /* Дополнительные данные необязательны: без плана или публикаций экран показывает ролики как есть. */
  const optional = promise => Promise.resolve().then(() => promise()).catch(() => null);
  el.classList.add("mt-view");
  el.innerHTML = `<div class="mt-top" data-top></div><div data-dates></div>
    <p class="mt-status" role="status" data-status></p>
    <ul class="mt-list" data-grid aria-label="Рилсы монтажа"></ul>
    ${canEdit ? `<div class="mt-modal" data-upload-modal hidden><form class="mt-modal__box mt-upload" data-upload hidden role="dialog" aria-modal="true" aria-labelledby="mt-upload-title">
      <header class="mt-modal__head"><h2 id="mt-upload-title">Загрузить ролик</h2><button type="button" class="mt-x" data-upload-cancel aria-label="Закрыть">✕</button></header>
      <label>Файл<input type="file" name="file" accept="video/mp4,video/webm,.mp4,.webm" required></label>
      <p class="muted mt-hint">Готовый смонтированный MP4 или WebM до 60 МБ. На площадки ничего не уходит.</p>
      <label>К какому рилсу из плана?<select name="idea" data-upload-idea></select></label>
      <p class="muted mt-hint" data-upload-link-note></p>
      <label>Название<input type="text" name="title" maxlength="200" required placeholder="Например: №2 «Первый визит»"></label>
      <label>Дата выхода<input type="date" name="releaseDate"></label>
      <fieldset class="mt-targets"><legend>Площадки</legend>${PLATFORMS.map(p => `<label><input type="checkbox" name="platforms" value="${p.id}"> ${esc(p.label)}</label>`).join("")}</fieldset>
      <p class="mt-status" role="status" data-upload-status></p>
      <div class="mt-actions"><button type="submit" class="plain-button primary" data-upload-submit>Загрузить</button><button type="button" class="plain-button" data-upload-cancel>Отмена</button></div>
    </form></div>` : ""}
    <div class="mt-modal" data-detail-modal hidden><section class="mt-modal__box mt-detail" data-detail hidden role="dialog" aria-modal="true" aria-labelledby="mt-detail-title"></section></div>`;
  const $ = selector => el.querySelector(selector);
  const status = text => {$("[data-status]").textContent = text || "";};
  const fail = error => status(error?.status === 403 ? "Нет доступа к монтажу этой компании." : "Не удалось загрузить: " + (error?.message || "ошибка сети"));

  /* ---------- Шапка: «Монтаж», «Загрузить ролик», календарь ▦ ⇅ в одну строку ---------- */
  let head = null, strip = null;
  const uploadButton = canEdit ? `<button type="button" class="plain-button primary mt-upload-open" data-upload-open>Загрузить ролик</button>` : "";
  function renderHead() {
    const K = kit(), top = $("[data-top]");
    const sheetUrl = state.settings?.settings?.contentPlanSheetUrl || "";
    if (!K) {
      top.innerHTML = `<div class="cfk-head"><div class="cfk-head-row"><h2 class="cfk-title">Монтаж</h2>${uploadButton}</div></div>`;
      return;
    }
    if (!head) {
      state.sort = K.getSort("materials", SORTS);
      head = K.header({title: "Монтаж", extraHtml: uploadButton, actions: ["calendar", "sheet", "sort"], sheetUrl, sortOptions: SORTS, sortKey: "materials",
        onSort: id => {state.sort = id;renderGrid();}, onCalendar: open => strip?.setOpen(open)});
      top.replaceChildren(head);
      strip = K.dateStrip({tz: zoneLabel(state.timeZone), timeZone: state.timeZone || undefined, marked: markedDates(), onSelect: date => scrollToDate(K.dayKey(date))});
      $("[data-dates]").replaceChildren(strip);
    } else strip?.setMarked(markedDates());
  }
  const zoneLabel = zone => zone === "Asia/Irkutsk" ? "Иркутское время" : zone ? "Часовой пояс компании: " + zone : "Время устройства";
  const markedDates = () => [...new Set(state.items.map(item => item.date).filter(Boolean))];
  function scrollToDate(key) {
    const list = $("[data-grid]"), rows = [...list.querySelectorAll(".mt-card[data-date]")];
    const target = rows.find(row => row.dataset.date === key) || rows.find(row => row.dataset.date && row.dataset.date > key) || rows.at(-1);
    if (!target) return;
    const top = target.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop - 4;
    if (typeof list.scrollTo === "function") list.scrollTo({top, behavior: "smooth"}); else list.scrollTop = top;
  }

  /* ---------- Данные ---------- */
  async function load() {
    const epoch = ++state.epoch;status("Загружаем монтаж…");
    try {
      const [result, mentor, posts, shooting, settings, info] = await Promise.all([api.list(),
        optional(() => ctx.api.get("crm/media-mentor")), optional(() => ctx.api.get("crm/autoposting/posts")), optional(() => ctx.api.get("shooting/reels")),
        optional(() => ctx.settings?.content?.get()), optional(() => ctx.api.get("crm/company-information"))]);
      if (epoch !== state.epoch || ctx.signal.aborted) return;
      if (String(result.companyCode).toLowerCase() !== String(ctx.companyCode).toLowerCase()) return;
      state.reels = Array.isArray(result.reels) ? result.reels : [];
      state.mentor = sameCompany(mentor) ? mentor : null;
      state.posts = sameCompany(posts) && Array.isArray(posts?.posts) ? posts.posts : [];
      state.shooting = sameCompany(shooting) && shooting?.reels && typeof shooting.reels === "object" ? shooting.reels : {};
      state.settings = settings || null;
      state.info = sameCompany(info) ? info : null;
      /* Пояс: кабинет (ctx.company) → /media-mentor нового сервера (company.timeZone) → сведения компании → настройки. */
      state.timeZone = ctx.company?.timeZone || state.mentor?.company?.timeZone || state.info?.profile?.timezone || state.settings?.settings?.timezone || "";
      build();status("");renderHead();renderGrid();
    } catch (error) {if (!ctx.signal.aborted) {renderHead();fail(error);}}
  }
  /* Позиции ленты: видео-рилсы плана (номер = номер строки плана) и ролики без связи с планом. Связь ролика с рилсом плана —
     только серверная: ролик → публикация автопостинга (postId) → planLink.ideaId. По названию и дате не угадываем. */
  function build() {
    const days = state.mentor?.plan?.days || [], variants = state.mentor?.variants || [];
    const wholePlan = state.mentor?.approval?.status === "approved";
    const postById = new Map(state.posts.map(post => [post.id, post]));
    const postsByIdea = new Map();
    state.posts.forEach(post => {const id = post.planLink?.ideaId;if (id) (postsByIdea.get(id) || postsByIdea.set(id, []).get(id)).push(post);});
    const reelsByIdea = new Map(), loose = [];
    const ideaIds = new Set(days.map(day => day.ideaId));
    for (const reel of state.reels) {
      // Новый сервер хранит связь ролика с идеей сам (reel.ideaId / planLink, specs/209); старый — только через публикацию.
      const ideaId = reel.ideaId || reel.planLink?.ideaId || postById.get(reel.postId)?.planLink?.ideaId;
      if (ideaId && ideaIds.has(ideaId)) (reelsByIdea.get(ideaId) || reelsByIdea.set(ideaId, []).get(ideaId)).push(reel);
      else loose.push(reel);
    }
    const video = idea => {
      const kinds = [idea.format, ...Object.values(idea.variants || {}).map(v => v?.format)];
      const places = [idea.platform, ...Object.keys(idea.variants || {})];
      return kinds.some(f => f === "reel" || f === "story") || places.some(p => ["tiktok", "youtube", "youtube_shorts"].includes(p)) || String(idea.script || "").trim() !== "";
    };
    const items = [];
    days.forEach((idea, index) => {
      const linked = reelsByIdea.get(idea.ideaId) || [];
      // Черновик плана с роликом (загружен «вне плана») остаётся в Монтаже: иначе ролик пропал бы из ленты.
      if (!linked.length && (!video(idea) || idea.productionStatus === "draft")) return;
      // Основной ролик рилса: свой ролик «Материалов» с наибольшим числом версий, иначе видео из карточки плана.
      const reel = linked.slice().sort((a, b) => (b.source === "materials") - (a.source === "materials") || (b.versionCount || 1) - (a.versionCount || 1))[0] || null;
      const posts = postsByIdea.get(idea.ideaId) || [];
      const shot = state.shooting[idea.ideaId] || {};
      const own = variants.filter(v => v.ideaId === idea.ideaId).map(v => v.status);
      // Этап, вычисленный сервером по фактам (idea.stage), главнее клиентской догадки; без него — прежний расчёт.
      let stage = STAGE_LABEL[idea.stage] ? idea.stage : publicationStage(posts);
      if (!stage && reel) stage = reel.openEdits ? "edit_rework" : "edit_review";
      if (!stage) {
        const production = shot.manualStatus || idea.productionStatus || shot.status;
        if (production === "editing") stage = "editing";
        else if (production === "shot") stage = "shot";
      }
      if (!stage) stage = own.includes("rejected") ? "script_rework" : own.includes("pending") ? "script_review" : own.includes("approved") || wholePlan ? "planned" : "script_review";
      items.push({key: reel ? reel.key : "idea:" + idea.ideaId, ideaId: idea.ideaId, number: index + 1, title: idea.topic || "Без темы", date: idea.date || "",
        stage, reel, posts, publications: Array.isArray(idea.publications) ? idea.publications : null,
        platforms: platformList([...Object.keys(idea.variants || {}), idea.platform, ...(reel?.platforms || [])])});
    });
    for (const reel of loose) {
      const post = postById.get(reel.postId);const posts = post ? [post] : [];
      const stage = publicationStage(posts) || (reel.openEdits ? "edit_rework" : "edit_review");
      items.push({key: reel.key, ideaId: null, number: null, title: reel.title, date: reel.releaseDate || "", stage, reel, posts, platforms: platformList(reel.platforms)});
    }
    items.forEach(item => {item.group = groupOf(item.stage);item.uploadedAt = item.reel?.currentVersion?.createdAt || "";});
    state.items = items;
  }
  const byDate = (a, b) => (a.date || "9999").localeCompare(b.date || "9999") || (a.number ?? 1e9) - (b.number ?? 1e9) || String(a.key).localeCompare(String(b.key));
  const GROUP_ORDER = {above: 0, now: 1, ahead: 2};
  function sorted() {
    const list = state.items.slice();
    if (state.sort === "stage") return list.sort((a, b) => STAGE_RANK[a.stage] - STAGE_RANK[b.stage] || byDate(a, b));
    if (state.sort === "uploads") return list.sort((a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || "") || (b.reel ? 1 : 0) - (a.reel ? 1 : 0) || byDate(a, b));
    if (state.sort === "number") return list.sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9) || byDate(a, b));
    return list.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || byDate(a, b));
  }
  const hasCut = item => item.reel && CUT.has(item.stage) && safeUrl(item.reel.currentVersion?.mediaUrl);
  function cardHtml(item) {
    const media = hasCut(item) ? safeUrl(item.reel.currentVersion.mediaUrl) : "";
    const thumb = media ? `<span class="mt-thumb"><video muted playsinline preload="metadata" src="${esc(media)}#t=0.5"></video></span>` : `<span class="mt-thumb mt-thumb--empty" aria-hidden="true">✂</span>`;
    const version = item.reel?.currentVersion ? ` · v${esc(item.reel.currentVersion.version ?? 1)}` : "";
    const when = item.date ? `${esc(dateShort(item.date))}${version}` : `${item.number ? "дата — по плану" : "без даты"}${version}`;
    const note = AT_EDITOR.has(item.stage) ? "Идёт монтаж" : item.group === "ahead" ? "Материалы не загружены" : "";
    const title = `${item.number ? `№${item.number} ` : ""}${item.title}`;
    const body = `${thumb}<span class="mt-card__body"><strong class="mt-card__title">${esc(title)}</strong><span class="mt-card__date">${when}</span>
      <span class="mt-card__foot"><span class="mt-card__st">${chip(item.stage)}${note ? `<span class="mt-card__note">${note}</span>` : ""}</span>
      <span class="mt-card__pf">${item.platforms.map(id => esc(platformOf(id).short)).join(" · ")}</span></span></span>`;
    const clickable = item.reel || (canEdit && AT_EDITOR.has(item.stage));
    const attrs = `data-group="${item.group}" data-stage="${esc(item.stage)}" data-date="${esc(item.date)}"`;
    return clickable
      ? `<li class="mt-card" ${attrs}><button type="button" class="mt-card__open" ${item.reel ? `data-open="${esc(item.key)}"` : `data-upload-for="${esc(item.ideaId)}"`} aria-label="${esc(item.reel ? "Открыть " + title : "Загрузить ролик к " + title)}">${body}</button></li>`
      : `<li class="mt-card" ${attrs}><div class="mt-card__open mt-card__open--static">${body}</div></li>`;
  }
  function renderGrid() {
    const list = $("[data-grid]");
    const items = sorted();
    list.innerHTML = items.map(cardHtml).join("");
    if (!items.length) status("Пока нет рилсов: они появятся из контент-плана и после загрузки ролика.");
    const K = kit();
    if (K && items.length) {
      const feed = state.sort === "date";
      K.feedStart(list, {isAbove: node => feed && node.dataset.group === "above", aboveLabel: "↑ выше — опубликованные",
        ...(feed ? {aheadSelector: '[data-group="ahead"]', aheadLabel: "↓ впереди — ещё без материалов"} : {})});
    }
  }

  /* ---------- Окно публикации ---------- */
  const modal = (name, show) => {const wrap = $(`[data-${name}-modal]`);if (wrap) {wrap.hidden = !show;document.body.classList.toggle("mt-modal-open", Boolean(el.querySelector(".mt-modal:not([hidden])")));}};
  let returnFocus = null;
  async function open(key) {
    const item = state.items.find(entry => entry.key === key) || null;
    const summary = item?.reel || state.reels.find(reel => reel.key === key);if (!summary) return;
    returnFocus = document.activeElement;
    state.item = item;state.open = {...summary, versions: [summary.currentVersion].filter(Boolean), log: []};
    const targets = item?.platforms?.length ? item.platforms : platformList(summary.platforms);
    state.platform = targets[0] || PLATFORMS[0].id;state.version = summary.currentVersion?.version ?? 1;
    renderDetail();
    if (summary.id) {
      try {const full = await api.get(summary.id);if (state.open?.key !== key || ctx.signal.aborted) return;state.open = full;state.version = full.currentVersion?.version ?? 1;renderDetail();}
      catch (error) {if (!ctx.signal.aborted) detailStatus("Не удалось обновить ролик: " + (error?.message || "ошибка сети"));}
    }
  }
  function close() {
    state.open = null;state.item = null;$("[data-detail]").hidden = true;modal("detail", false);
    const opener = $("[data-upload-open]");if (opener) opener.hidden = false;
    if (returnFocus?.isConnected) returnFocus.focus?.({preventScroll: true});
  }
  const currentVersion = () => (state.open.versions || []).find(v => v.version === state.version) || state.open.currentVersion;
  /* Ссылка на страницу сообщества/канала из ссылок компании (CRM socials) — когда ссылку на сам пост получить нельзя. */
  function communityUrl(platform) {
    const socials = Array.isArray(state.info?.profile?.socials) ? state.info.profile.socials : [];
    const types = {vk: ["vk"], telegram: ["telegram_channel", "telegram"], max: ["max"], instagram: ["instagram"], tiktok: ["tiktok"], youtube_shorts: ["youtube"]}[platform] || [];
    for (const type of types) {const found = socials.find(item => item.type === type && httpsUrl(item.url));if (found) return httpsUrl(found.url);}
    return "";
  }
  /* Публикация площадки из ответа нового сервера (idea.publications: platform, status, url, publishedAt). */
  const SERVER_PUB = {published: "published", scheduled: "scheduled", publishing: "publishing", error: "error", draft: "draft"};
  function serverPublication(list, platform) {
    const own = (Array.isArray(list) ? list : []).filter(entry => normPlatform(entry?.platform) === platform);
    const entry = own.find(item => item.status === "published" && httpsUrl(item.url)) || own.find(item => item.status === "published") || own[0];
    const kind = entry && SERVER_PUB[entry.status];
    return kind ? {state: kind, url: httpsUrl(entry.url), at: kind === "published" ? entry.publishedAt : null} : null;
  }
  function publicationRow(platform, posts, publications) {
    let pub = platformPublication(posts, platform);
    const server = serverPublication(publications, platform);
    // Сервер видит и публикации ролика, связанные с идеей без переноса плана: берём его факт, если у кабинета своего нет
    // или у кабинета нет ссылки на вышедший пост.
    if (server && (pub.state === "none" || (server.state === "published" && (pub.state !== "published" || !pub.url))))
      pub = {...pub, ...server, url: server.url || pub.url || "", at: server.at || pub.at};
    const tz = pub.post?.timezone || state.timeZone;
    const label = `<b>${esc(platformOf(platform).short)}</b>`;
    if (pub.state === "published") {
      const at = pub.at ? ` · ${esc(timeIn(pub.at, tz))}` : "";
      if (pub.url) return `<li data-pub="${platform}" data-pub-state="post">${label}<a href="${esc(pub.url)}" target="_blank" rel="noopener noreferrer">вышло ↗</a><span class="muted">${at}</span></li>`;
      const community = communityUrl(platform);
      if (community) return `<li data-pub="${platform}" data-pub-state="community">${label}<a href="${esc(community)}" target="_blank" rel="noopener noreferrer">вышло · сообщество ↗</a><span class="muted">${at}</span></li>`;
      return `<li data-pub="${platform}" data-pub-state="later">${label}<span>вышло · ссылка позже</span><span class="muted">${at}</span></li>`;
    }
    const text = {publishing: "отправляется", error: "ошибка — проверьте в «Постинге»", scheduled: `запланировано${pub.at ? " · " + esc(timeIn(pub.at, tz)) : ""}`, draft: "черновик публикации", none: "не опубликовано"}[pub.state];
    return `<li data-pub="${platform}" data-pub-state="${pub.state}">${label}<span class="muted">${text}</span></li>`;
  }
  function captionFor(posts, platform) {
    for (const post of posts) {const text = post.captions?.[platform] || "";if (text.trim()) return text;}
    for (const post of posts) {if (String(post.text || "").trim()) return post.text;}
    return "";
  }
  function renderDetail() {
    const reel = state.open, item = state.item, version = currentVersion(), media = safeUrl(version?.mediaUrl), node = $("[data-detail]");
    node.hidden = false;modal("detail", true);
    if (!state.busy) toggleUpload(false);const opener = $("[data-upload-open]");if (opener) opener.hidden = true;
    const versions = reel.versions || [];
    const posts = item?.posts || [];
    const stage = item?.stage || "edit_review";
    const targets = item?.platforms?.length ? item.platforms : platformList(reel.platforms);
    const switcher = platformList(["instagram", "tiktok", "youtube_shorts", "vk", "telegram", ...targets]);
    const title = `${item?.number ? `№${item.number} ` : ""}${item?.title || reel.title}`;
    const caption = captionFor(posts, state.platform);
    const published = stage === "published";
    node.innerHTML = `<header class="mt-modal__head"><h2 id="mt-detail-title" tabindex="-1" data-title>${esc(title)}</h2><button type="button" class="mt-x" data-back aria-label="Закрыть">✕</button></header>
      <p class="mt-detail__meta"><span class="muted">${esc(item?.date ? dateShort(item.date) : dateRu(reel.releaseDate))} · версия v${esc(version?.version ?? 1)}${version?.note ? " · " + esc(version.note) : ""}</span> ${chip(stage)}</p>
      <div class="mt-layout">
        <div class="mt-phone">
          <fieldset class="mt-platforms" aria-label="Маска площадки">${switcher.map(id => `<label title="${esc(platformOf(id).label)}"><input type="radio" name="mt-platform" value="${id}"${id === state.platform ? " checked" : ""}><span>${esc(platformOf(id).short)}</span></label>`).join("")}</fieldset>
          <div class="mt-screen">${media ? `<video controls playsinline preload="metadata" src="${esc(media)}" data-player></video>` : "<p>Файл не найден</p>"}${maskHtml(state.platform)}</div>
          <label class="mt-toggle"><input type="checkbox" data-mask-toggle checked> Маска площадки</label>
          <p class="muted mt-note">Тёмные зоны — где лягут шапка, подпись и кнопки ${esc(platformOf(state.platform).label)}. Зоны ориентировочные.</p>
        </div>
        <div class="mt-side">
          <h3>Публикация по площадкам</h3>
          <ul class="mt-pubs" data-pubs>${targets.map(id => publicationRow(id, posts, item?.publications)).join("") || `<li class="muted">Площадки не выбраны</li>`}</ul>
          <h3 data-caption-head>Текст публикации · ${esc(platformOf(state.platform).short)}</h3>
          <p class="mt-caption${caption ? "" : " muted"}" data-caption>${caption ? esc(caption) : "Текста публикации пока нет."}</p>
          ${versions.length > 1 ? `<label class="mt-version">Версия<select data-version>${versions.map(v => `<option value="${v.version}"${v.version === state.version ? " selected" : ""}>v${v.version}${v.editId ? " · правка №" + esc(v.editId) : ""}</option>`).join("")}</select></label>` : ""}
          <div class="mt-actions">
            ${media ? `<a class="plain-button" href="${esc(media)}" download="${esc(reel.title)} v${esc(version?.version ?? 1)}.mp4" data-download>Скачать</a>` : ""}
            ${canEdit ? (sb.reelEditor ? `<button type="button" class="plain-button" data-edit>Редактировать</button>` : `<button type="button" class="plain-button" disabled aria-disabled="true" title="Редактор монтажа скоро">Редактировать · скоро</button>`) : ""}
            ${canEdit && !published ? (reel.id ? `<button type="button" class="plain-button primary" data-publish>Создать публикацию</button>` : `<button type="button" class="plain-button" data-open-post>Открыть публикацию в «Постинге»</button>`) : ""}
          </div>
          ${canEdit && reel.id && !published ? `<fieldset class="mt-targets" data-targets><legend>Площадки публикации</legend>${PLATFORMS.map(p => `<label><input type="checkbox" value="${p.id}"${(targets.length ? targets : [state.platform]).includes(p.id) ? " checked" : ""}> ${esc(p.label)}</label>`).join("")}</fieldset>` : ""}
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
    close();ctx.navigate("content-factory/plan");
    setTimeout(() => window.dispatchEvent(new CustomEvent("sb:content-factory-open-draft", {detail: {companyCode: ctx.companyCode, postId, source: "materials"}})), 0);
  }
  async function edit() {
    if (state.busy) return;state.busy = true;
    try {
      const reel = await ensureReel();if (ctx.signal.aborted) return;
      /* Редактор открывается внутри окна ролика: его слой над окном, ✕ редактора возвращает к «Редактировать». */
      // №204: номер и рилс плана — для заголовка «№N · vK» и дорожек сцен/исходников съёмки.
      const idea = (state.mentor?.plan?.days || []).find(day => state.item?.ideaId && day.ideaId === state.item.ideaId) || null;
      sb.reelEditor.open($("[data-detail-modal]"), {ctx, reel, version: state.version, number: state.item?.number ?? null, idea, onChange: next => {state.open = next;state.version = next.currentVersion?.version ?? state.version;renderDetail();}});
    } catch (error) {detailStatus("Не удалось открыть редактор: " + (error?.message || "ошибка"));}
    finally {state.busy = false;}
  }

  /* ---------- «Загрузить ролик» (№145): тот же путь, что у агента монтажа, но под сессией кабинета ----------
     1) POST publishing-assets — сырой файл, сервер проверяет формат и лимит 60 МБ, отдаёт {url, sha256};
     2) POST crm/autoposting/reels {title, releaseDate, platforms, mediaUrl, sha256, durationMs} — ролик v1.
     Выбор «К какому рилсу из плана?» подставляет тему, дату и площадки рилса.
     Пакет H (specs/209-cf-stages): новый сервер принимает ideaId (следующая версия ролика этого рилса через addVersion)
     и offPlan:true («Новый — вне плана» → черновик в Контент-плане, пока план на согласовании). Признак нового сервера —
     plan.stageFacts (или company.timeZoneSource без плана) в ответе /media-mentor; старому эти поля не отправляются,
     иначе он ответит 400 «лишние поля». */
  const linksIdeas = () => Boolean(state.mentor?.plan?.stageFacts) || Boolean(state.mentor?.company && Object.hasOwn(state.mentor.company, "timeZoneSource"));
  const OFF_PLAN = {PLAN_DECIDED: "план уже согласован целиком — черновик не добавлен, чтобы не сбросить решение", PLAN_ABSENT: "контент-плана ещё нет",
    PLAN_REJECTED: "план отклонён", NO_PLATFORM: "в плане не выбрана площадка", NOT_CONFIGURED: "план на сервере не подключён"};
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
  const planChoices = () => {
    const plan = state.items.filter(item => item.ideaId && item.group !== "above");
    const atEditor = plan.filter(item => AT_EDITOR.has(item.stage)).sort(byDate), rest = plan.filter(item => !AT_EDITOR.has(item.stage)).sort(byDate);
    return {atEditor, rest};
  };
  const ideaLabel = item => `№${item.number} ${item.title}${item.date ? " · " + dateShort(item.date) : ""} · ${STAGE_LABEL[item.stage] || item.stage}`;
  function fillIdeas(preselect) {
    const select = el.querySelector("[data-upload-idea]");if (!select) return;
    const {atEditor, rest} = planChoices();
    select.innerHTML = (atEditor.length ? `<optgroup label="Отснято и в монтаже">${atEditor.map(item => `<option value="${esc(item.ideaId)}">${esc(ideaLabel(item))}</option>`).join("")}</optgroup>` : "")
      + (rest.length ? `<optgroup label="Остальные рилсы плана">${rest.map(item => `<option value="${esc(item.ideaId)}">${esc(ideaLabel(item))}</option>`).join("")}</optgroup>` : "")
      + `<option value="">Новый — вне плана</option>`;
    select.value = preselect && [...atEditor, ...rest].some(item => item.ideaId === preselect) ? preselect : atEditor[0]?.ideaId || "";
    applyIdea(select.value);
  }
  function applyIdea(ideaId) {
    const form = el.querySelector("[data-upload]");if (!form) return;
    const item = state.items.find(entry => entry.ideaId === ideaId && ideaId);
    const note = el.querySelector("[data-upload-link-note]");
    if (item) {
      form.elements.title.value = `№${item.number} ${item.title}`.slice(0, 200);
      form.elements.releaseDate.value = item.date || "";
      form.querySelectorAll("[name=platforms]").forEach(input => {input.checked = item.platforms.includes(input.value);});
      note.textContent = linksIdeas()
        ? (item.reel ? `Ролик станет следующей версией (v${(item.reel.versionCount || item.reel.currentVersion?.version || 1) + 1}) ролика №${item.number}.` : `Ролик станет первой версией ролика №${item.number}.`)
        : "Ролик сохранится отдельной карточкой с темой, датой и площадками этого рилса. Следующей версией той же карточки он станет после обновления сервера.";
    } else {
      if (state.uploadIdea) {form.elements.title.value = "";form.elements.releaseDate.value = "";form.querySelectorAll("[name=platforms]").forEach(input => {input.checked = false;});}
      note.textContent = linksIdeas() ? "Ролик вне плана: в Контент-плане появится черновик рилса (если план ещё на согласовании)." : "Ролик вне плана появится в Монтаже отдельной карточкой.";
    }
    state.uploadIdea = item ? ideaId : null;
  }
  function toggleUpload(show, ideaId) {
    const form = el.querySelector("[data-upload]");if (!form) return;
    form.hidden = !show;modal("upload", show);el.querySelector("[data-upload-open]").hidden = show;
    if (show) {fillIdeas(ideaId);form.querySelector("[name=file]").focus({preventScroll: true});} else {form.reset();state.uploadIdea = null;uploadStatus("");}
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
      const chosen = state.uploadIdea ? state.items.find(item => item.ideaId === state.uploadIdea) : null, linked = linksIdeas();
      if (linked) {if (chosen) body.ideaId = chosen.ideaId;else body.offPlan = true;}
      const reel = await ctx.api.post("crm/autoposting/reels", body);if (ctx.signal.aborted) return;
      state.reels = [reel, ...state.reels.filter(item => item.key !== reel.key)];build();renderHead();renderGrid();
      toggleUpload(false);
      const message = uploadResult(reel, chosen, linked);
      // Связь с планом меняет этапы и может добавить черновик в план — перечитываем данные, затем показываем итог.
      if (linked) await load();
      if (!ctx.signal.aborted) status(message);
    } catch (error) {
      if (ctx.signal.aborted) return;
      uploadStatus(error?.status === 413 ? "Файл больше лимита 60 МБ: сервер его не принял." : error?.status === 403 ? "Нет права загружать ролики в эту компанию."
        : error?.status ? `Не удалось сохранить ролик: ${error.message || "ответ " + error.status}` : "Ошибка сети: файл не отправлен. Проверьте соединение и повторите.");
    } finally {state.busy = false;const submit = el.querySelector("[data-upload-submit]");if (submit) submit.disabled = false;}
  }
  function uploadResult(reel, chosen, linked) {
    const version = reel.appended ? reel.appendedVersion ?? reel.currentVersion?.version : reel.currentVersion?.version ?? 1;
    if (!linked) return `Ролик «${reel.title}» загружен как v${version}.`;
    const number = chosen?.number ? `№${chosen.number}` : "рилсу плана";
    if (reel.appended) return `Добавлено как v${version} к ${number}.`;
    if (chosen && reel.ideaId) return `Загружено как v${version} — первая версия ролика ${number}.`;
    if (reel.offPlan?.created) return `Ролик «${reel.title}» загружен как v${version}; черновик в Контент-плане.`;
    if (reel.offPlan) return `Ролик «${reel.title}» загружен как v${version} без связи с планом: ${OFF_PLAN[reel.offPlan.reason] || reel.offPlan.message || "черновик не добавлен"}.`;
    return `Ролик «${reel.title}» загружен как v${version}.`;
  }
  const uploadForm = el.querySelector("[data-upload]");
  if (uploadForm) {
    uploadForm.addEventListener("submit", upload);
    uploadForm.addEventListener("change", event => {
      if (event.target.name === "idea") {applyIdea(event.target.value);return;}
      if (event.target.name !== "file") return;const file = event.target.files?.[0];
      uploadStatus(file ? checkFile(file) : "");
      if (file && !uploadForm.elements.title.value) uploadForm.elements.title.value = file.name.replace(/\.(mp4|webm)$/i, "").slice(0, 200);
    });
  }
  el.addEventListener("click", event => {
    if (event.target.matches?.(".mt-modal")) {if (event.target.hasAttribute("data-detail-modal")) close();else if (!state.busy) toggleUpload(false);return;}
    const target = event.target.closest("button,a");if (!target || !el.contains(target)) return;
    if (target.dataset.open) void open(target.dataset.open);
    else if (target.dataset.uploadFor) toggleUpload(true, target.dataset.uploadFor);
    else if (target.hasAttribute("data-upload-open")) toggleUpload(true);
    else if (target.hasAttribute("data-upload-cancel")) {if (!state.busy) toggleUpload(false);}
    else if (target.hasAttribute("data-back")) close();
    else if (target.hasAttribute("data-publish")) void publish();
    else if (target.hasAttribute("data-open-post")) openPost(state.open.postId);
    else if (target.hasAttribute("data-edit")) void edit();
  });
  el.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.target.closest?.(".re-editor")) return;
    if (!$("[data-detail-modal]").hidden) close();else if (uploadForm && !uploadForm.hidden && !state.busy) toggleUpload(false);
  });
  el.addEventListener("change", event => {
    if (event.target.name === "mt-platform") {
      /* Смена маски не перерисовывает плеер: позиция воспроизведения сохраняется. */
      state.platform = event.target.value;const label = platformOf(state.platform);
      el.querySelector(".mt-mask").outerHTML = maskHtml(state.platform);
      el.querySelector(".mt-mask").hidden = !el.querySelector("[data-mask-toggle]").checked;
      el.querySelector(".mt-note").textContent = `Тёмные зоны — где лягут шапка, подпись и кнопки ${label.label}. Зоны ориентировочные.`;
      el.querySelector("[data-caption-head]").textContent = `Текст публикации · ${label.short}`;
      const caption = captionFor(state.item?.posts || [], state.platform), node = el.querySelector("[data-caption]");
      node.textContent = caption || "Текста публикации пока нет.";node.classList.toggle("muted", !caption);
    }
    else if (event.target.matches("[data-mask-toggle]")) el.querySelector(".mt-mask").hidden = !event.target.checked;
    else if (event.target.matches("[data-version]")) {state.version = Number(event.target.value);renderDetail();}
  });
  const initial = /^(reel|post)\/(\d+)$/.exec(ctx.route?.path || "");
  /* CfKit подключает content-factory.js; если он ещё грузится — ждём событие «cfkit:ready» (не дольше 1,5 с). */
  const kitReady = () => kit() ? Promise.resolve() : new Promise(resolve => {
    const done = () => {window.removeEventListener("cfkit:ready", done);clearTimeout(timer);resolve();};
    const timer = setTimeout(done, 1500);window.addEventListener("cfkit:ready", done);
  });
  return kitReady().then(load).then(() => {if (initial) void open(initial[1] + ":" + initial[2]);});
}

const definition = {title: "Монтаж", mount: (el, ctx) => create(el, ctx), unmount: el => {el.classList.remove("mt-view");document.body.classList.remove("mt-modal-open");}};
(window.SynapseModulesQueue = window.SynapseModulesQueue || []).push(["content-materials", definition]);
})();
