(() => {
"use strict";
/* Заявки с сайта Palitra: список заявок, получатель уведомлений в Telegram, проверка получателя,
   явный повтор уведомления. Только владелец и только компания palitra-love; сайт в маршрутах
   фиксирован (palitra) и не выводится из ввода. Смена компании закрывает вид и отбрасывает ответы. */
const cabinet = window.SbCabinet = window.SbCabinet || {};
const SITE_BY_COMPANY = Object.freeze({ "palitra-love": "palitra" });
const STATUS = Object.freeze({
  accepted: ["Принята, уведомление не отправлялось", "accepted"],
  notified: ["Уведомление доставлено в Telegram", "notified"],
  notify_uncertain: ["Доставка не подтверждена", "uncertain"],
  notify_failed: ["Уведомление не доставлено", "failed"]
});
const KIND = Object.freeze({ cart: "Корзина", request: "Форма" });
const rub = (kopecks) => `${Math.floor(kopecks / 100).toLocaleString("ru-RU")}${kopecks % 100 ? `,${String(kopecks % 100).padStart(2, "0")}` : ""} ₽`;
const when = (iso) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(date); };
let version = 0;

const explainNotify = (order) => {
  const notify = order.notify;
  if (order.status === "notify_uncertain") return "Сообщение могло дойти до получателя, подтверждения от Telegram нет. Повторная отправка может создать дубль — повторяйте только после проверки чата.";
  if (order.status === "notify_failed") return `Не доставлено${notify?.error ? `: ${notify.error}` : ""}. Можно отправить повторно после исправления получателя.`;
  if (order.status === "accepted") return notify && ["pending", "sending"].includes(notify.status) ? "Уведомление отправляется…" : "Заявка сохранена, уведомление не отправлялось — получатель не был настроен.";
  return notify?.finishedAt ? `Доставлено ${when(notify.finishedAt)}` : "";
};
const recipientSummary = (recipient) => {
  if (!recipient.configured) return "Получатель не настроен: заявки сохраняются, уведомления никому не уходят.";
  if (recipient.verifiedAt) return `Получатель подтверждён проверкой ${when(recipient.verifiedAt)}.`;
  if (recipient.lastTestError) return `Проверка не прошла: ${recipient.lastTestError}. Получатель должен написать боту @synapse_sb_bot команду /start.`;
  if (recipient.lastTest && ["pending", "sending"].includes(recipient.lastTest.status)) return "Проверочное сообщение отправляется…";
  return "Получатель сохранён, но ещё не подтверждён проверкой.";
};

cabinet.registerView("site-orders", { title: "Заявки с сайта",
  onProjectChange(context) { this.render(document.querySelector('[data-view="site-orders"]'), context); },
  async render(container, context) {
    const current = ++version;
    const code = context.selectedProjectId;
    const site = SITE_BY_COMPANY[code];
    const h = context.escapeHTML;
    const alive = () => current === version && context.selectedProjectId === code && container.isConnected;
    container.innerHTML = '<div class="content-header"><h1>Заявки с сайта</h1></div>';
    if (context.identity.role !== "owner") { container.insertAdjacentHTML("beforeend", '<div class="card"><p>Доступно только владельцу.</p></div>'); return; }
    if (!site) { container.insertAdjacentHTML("beforeend", '<div class="card"><p>Заявки с сайта ведутся только для Palitra. Выберите компанию Palitra в переключателе.</p></div>'); return; }
    const base = `/content/${site}`;
    const controller = new AbortController();
    const api = (url, options = {}) => context.apiJson(url, { ...options, signal: controller.signal });
    const mutation = (method, body) => ({ method, headers: { "X-CSRF-Token": context.identity.csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const panel = document.createElement("div");
    panel.className = "site-orders";
    panel.innerHTML = `<section class="card site-orders__recipient"><h2>Получатель уведомлений в Telegram</h2>
      <p class="site-orders__warning" data-orders-warning hidden></p>
      <p data-recipient-summary>Загрузка…</p>
      <form class="site-orders__form" data-recipient-form><label>Telegram ID личного чата<input name="telegramChatId" inputmode="numeric" pattern="[0-9]{5,20}" maxlength="20" autocomplete="off" placeholder="числовой ID, не имя пользователя"></label>
      <label>Подпись<input name="label" maxlength="80" autocomplete="off" placeholder="например, менеджер"></label>
      <div class="site-orders__actions"><button type="submit">Сохранить получателя</button><button type="button" data-recipient-test>Отправить проверочное сообщение</button><button type="button" data-orders-refresh>Обновить</button></div>
      <p role="status" data-recipient-status></p></form>
      <p class="site-orders__hint">Бот пишет только тем, кто сам начал с ним диалог: получатель должен один раз отправить /start боту @synapse_sb_bot. Сохранение ничего не отправляет; проверка отправляет одно служебное сообщение.</p></section>
      <section class="card"><h2>Заявки</h2><div data-orders-list aria-live="polite">Загрузка…</div>
      <div class="site-orders__more"><button type="button" data-orders-more hidden>Показать ещё</button><p role="status" data-orders-more-status></p></div></section>`;
    container.append(panel);
    const summary = panel.querySelector("[data-recipient-summary]");
    const warning = panel.querySelector("[data-orders-warning]");
    const form = panel.querySelector("[data-recipient-form]");
    const status = form.querySelector("[data-recipient-status]");
    const list = panel.querySelector("[data-orders-list]");
    const testButton = form.querySelector("[data-recipient-test]");
    const moreButton = panel.querySelector("[data-orders-more]");
    const moreStatus = panel.querySelector("[data-orders-more-status]");
    let busy = false;
    // Страницы по курсору: список копится, «Показать ещё» запрашивает id < nextCursor; одна догрузка за раз.
    let shown = [], nextCursor = null, loadingMore = false;
    const setBusy = (value) => { busy = value; for (const control of form.querySelectorAll("input, button")) control.disabled = value; form.setAttribute("aria-busy", String(value)); };
    const showRecipient = (recipient) => {
      if (!alive()) return;
      summary.textContent = recipientSummary(recipient);
      summary.dataset.state = !recipient.configured ? "missing" : recipient.verifiedAt ? "verified" : "unverified";
      if (document.activeElement !== form.elements.telegramChatId) form.elements.telegramChatId.value = recipient.telegramChatId || "";
      if (document.activeElement !== form.elements.label) form.elements.label.value = recipient.label || "";
      testButton.hidden = !recipient.configured;
      const count = Number(recipient.unnotifiedOrders) || 0;
      warning.hidden = count === 0;
      warning.textContent = count ? `${count} заявок сохранены без уведомления. Настройте и проверьте получателя, затем отправьте их повторно из списка.` : "";
    };
    const showOrders = (orders) => {
      if (!alive()) return;
      moreButton.hidden = nextCursor === null;
      moreButton.disabled = loadingMore;
      if (!orders.length) { list.textContent = "Заявок пока нет."; return; }
      list.replaceChildren(...orders.map((order) => {
        const [label, cls] = STATUS[order.status] || ["Неизвестный статус", "unknown"];
        const article = document.createElement("article");
        article.className = `site-order site-order--${cls}`;
        const items = order.items.length
          ? `<ul class="site-order__items">${order.items.map((item) => `<li>${h(item.title)} × ${h(item.qty)} — ${item.price === null ? "цена уточняется" : h(rub(item.price * item.qty))}</li>`).join("")}</ul>
             <p class="site-order__total">Итого по известным ценам: ${h(rub(order.knownTotal))}${order.unknownCount ? ` · ${h(order.unknownCount)} поз. уточняются` : ""}</p>`
          : '<p class="site-order__items">Заявка с формы, без корзины.</p>';
        article.innerHTML = `<header class="site-order__head"><b>№${h(order.id)}</b> · ${h(when(order.createdAt))} · ${h(KIND[order.kind] || order.kind)}
          <span class="site-order__status site-order__status--${cls}">${h(label)}</span></header>
          <p class="site-order__contact">${h(order.name)} · <a href="tel:${h(order.phone.replace(/[^\d+]/g, ""))}">${h(order.phone)}</a></p>
          ${items}${order.comment ? `<p class="site-order__comment">${h(order.comment)}</p>` : ""}
          <p class="site-order__notify">${h(explainNotify(order))}</p>`;
        if (["accepted", "notify_uncertain", "notify_failed"].includes(order.status) && !(order.notify && ["pending", "sending"].includes(order.notify.status))) {
          const button = document.createElement("button");
          button.type = "button"; button.className = "site-order__renotify";
          button.textContent = order.status === "notify_uncertain" ? "Отправить повторно (возможен дубль)" : "Отправить уведомление";
          button.addEventListener("click", async () => {
            if (busy || !alive()) return;
            if (order.status === "notify_uncertain" && !window.confirm(`Заявка №${order.id}: доставка не подтверждена, сообщение могло дойти. Отправить повторно?`)) return;
            setBusy(true); button.disabled = true; status.textContent = `Отправляем уведомление по заявке №${order.id}…`;
            try {
              const result = await api(`${base}/orders/${encodeURIComponent(order.id)}/renotify`, mutation("POST"));
              if (!alive()) return;
              // Backend возвращает свежую заявку: применяем её к строке сразу — строки за пределами свежей
              // страницы (>100) при тихом перечитывании не обновляются и остались бы с прежней кнопкой.
              if (result && result.order && result.order.id === order.id) {
                shown = shown.map((row) => (row.id === order.id ? result.order : row));
                showOrders(shown);
              }
              status.textContent = `Уведомление по заявке №${order.id} поставлено в очередь.`;
            }
            catch (error) { if (alive()) status.textContent = error.status === 409 ? "Получатель не настроен или уведомление уже отправляется." : "Не удалось поставить уведомление в очередь."; }
            finally { if (alive()) { setBusy(false); load({ quiet: true }); } }
          });
          article.append(button);
        }
        return article;
      }));
    };
    const load = async ({ quiet = false } = {}) => {
      if (!quiet) list.textContent = "Загрузка…";
      try {
        // Перечитывается столько, сколько показано, но не больше серверного максимума 100.
        // Показанное сверх свежей страницы не теряется: старые строки и курсор остаются прежними.
        const limit = Math.min(100, Math.max(50, shown.length));
        const data = await api(`${base}/orders?limit=${limit}`);
        if (!alive()) return;
        const fresh = data.orders;
        const oldest = fresh.length ? fresh[fresh.length - 1].id : null;
        const tail = oldest === null ? [] : shown.filter((order) => order.id < oldest);
        shown = fresh.concat(tail);
        nextCursor = tail.length ? nextCursor : (data.nextCursor ?? null);
        showRecipient(data.recipient); showOrders(shown);
        if (!quiet) status.textContent = "";
      } catch (error) {
        if (!alive() || error.name === "AbortError") return;
        list.textContent = error.status === 403 ? "Доступно только владельцу." : "Не удалось загрузить заявки.";
        summary.textContent = "Не удалось загрузить получателя.";
      }
    };
    moreButton.addEventListener("click", async () => {
      if (loadingMore || nextCursor === null || !alive()) return;
      loadingMore = true; moreButton.disabled = true; moreStatus.textContent = "Загружаем более старые заявки…";
      const cursor = nextCursor;
      try {
        const data = await api(`${base}/orders?limit=50&beforeId=${encodeURIComponent(cursor)}`);
        if (!alive() || cursor !== nextCursor) return;
        const known = new Set(shown.map((order) => order.id));
        shown = shown.concat(data.orders.filter((order) => !known.has(order.id)));
        nextCursor = data.nextCursor ?? null;
        showOrders(shown);
        moreStatus.textContent = nextCursor === null ? "Показаны все заявки." : "";
      } catch (error) {
        if (!alive() || error.name === "AbortError") return;
        moreStatus.textContent = "Не удалось загрузить старые заявки. Попробуйте ещё раз.";
      } finally {
        if (alive()) { loadingMore = false; moreButton.disabled = false; moreButton.hidden = nextCursor === null; }
      }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || !alive()) return;
      const telegramChatId = form.elements.telegramChatId.value.trim(), label = form.elements.label.value.trim();
      if (!/^\d{5,20}$/.test(telegramChatId)) { status.textContent = "Укажите числовой Telegram ID личного чата (5–20 цифр). Имя пользователя не подходит."; form.elements.telegramChatId.focus(); return; }
      setBusy(true); status.textContent = "Сохраняем получателя…";
      try {
        const recipient = await api(`${base}/order-recipient`, mutation("PUT", { telegramChatId, label }));
        if (!alive()) return;
        showRecipient(recipient);
        status.textContent = recipient.verifiedAt ? "Получатель сохранён." : "Получатель сохранён. Подтверждение сбрасывается при смене чата — отправьте проверочное сообщение.";
      } catch (error) { if (alive()) status.textContent = error.status === 400 ? "Сервер не принял Telegram ID." : "Не удалось сохранить получателя."; }
      finally { if (alive()) setBusy(false); }
    });
    testButton.addEventListener("click", async () => {
      if (busy || !alive()) return;
      setBusy(true); status.textContent = "Отправляем проверочное сообщение…";
      try {
        const result = await api(`${base}/order-recipient/test`, mutation("POST"));
        if (!alive()) return;
        showRecipient(result.recipient);
        status.textContent = "Проверочное сообщение поставлено в очередь. Результат появится ниже через несколько секунд.";
        // Результат доставки приходит через мост позже: перечитываем статус ограниченное число раз.
        for (let attempt = 0; attempt < 12 && alive(); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          if (!alive()) return;
          const recipient = await api(`${base}/order-recipient`);
          if (!alive()) return;
          showRecipient(recipient);
          if (recipient.verifiedAt || recipient.lastTestError) { status.textContent = recipient.verifiedAt ? "Проверка прошла: получатель подтверждён." : "Проверка не прошла — см. причину выше."; break; }
        }
      } catch (error) { if (alive()) status.textContent = error.status === 409 ? "Сначала сохраните получателя." : "Не удалось отправить проверочное сообщение."; }
      finally { if (alive()) setBusy(false); }
    });
    form.querySelector("[data-orders-refresh]").addEventListener("click", () => { if (!busy) load(); });
    // Смена компании или уход с вида: незавершённые запросы отменяются, ответы не применяются.
    const observer = new MutationObserver(() => { if (!alive()) { controller.abort(); observer.disconnect(); } });
    observer.observe(container, { childList: true });
    await load();
  }
});
})();
