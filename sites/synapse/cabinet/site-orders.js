(() => {
"use strict";
/* Заявки и клиентские боты: только владелец, компании из явного списка.
   Сайт выбирается по компании, не из ввода; смена компании отбрасывает старые ответы. */
const cabinet = window.SbCabinet = window.SbCabinet || {};
const SITE_BY_COMPANY = Object.freeze({ "palitra-love": "palitra", alvi: "alvi" });
const STATUS = Object.freeze({
  accepted: ["Принята, личное уведомление не отправлялось", "accepted"],
  notified: ["Личное уведомление доставлено в Telegram", "notified"],
  notify_uncertain: ["Личное уведомление не подтверждено", "uncertain"],
  notify_failed: ["Личное уведомление не доставлено", "failed"]
});
const KIND = Object.freeze({ cart: "Корзина", request: "Форма" });
const CHANNEL = Object.freeze({ phone: "Звонок", telegram: "Telegram", whatsapp: "WhatsApp", max: "MAX" });
const groupSummary = (notify) => {
  if (!notify) return "";
  if (notify.status === "sent") return `Доставлено${notify.finishedAt ? ` ${when(notify.finishedAt)}` : ""}`;
  if (["pending", "sending"].includes(notify.status)) return "Уведомление отправляется…";
  if (notify.status === "uncertain") return "Доставка не подтверждена. Сообщение могло дойти; повтор может создать дубль.";
  if (notify.status === "error") return `Не доставлено${notify.error ? `: ${notify.error}` : ""}.`;
  return notify.configured ? "Заявка сохранена; уведомление в группу ещё не отправлялось." : "Рабочая группа не подключена. Заявка сохранена.";
};
// Состояние обработки менеджером (кнопки в Telegram бота Palitra) — отдельно от статуса уведомления.
const WORK = Object.freeze({ new: "Новая", in_work: "В работе", done: "Выполнена", cancelled: "Отменена" });
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
const recipientSummary = (recipient, site) => {
  if (!recipient.configured) return "Получатель не настроен: личные уведомления не уходят.";
  if (site === "palitra") {
    const test = recipient.lastTest;
    if (test && ["pending", "sending"].includes(test.status)) return "Ручная проверка: проверочное сообщение отправляется…";
    const at = test?.finishedAt || test?.createdAt || recipient.verifiedAt;
    const prefix = `Последняя ручная проверка${at ? ` ${when(at)}` : " (дата не сохранена)"}`;
    const note = " Доставка конкретных заявок показана отдельно в списке ниже.";
    if (recipient.lastTestError) return `${prefix}: не прошла — ${recipient.lastTestError}.${note}`;
    if (test?.status === "sent" || recipient.verifiedAt) return `${prefix}: успешно.${note}`;
    if (test?.status === "uncertain") return `${prefix}: доставка проверочного сообщения не подтверждена.${note}`;
    return `Получатель сохранён; успешной ручной проверки пока нет.${note}`;
  }
  if (recipient.verifiedAt) return `Получатель подтверждён проверкой ${when(recipient.verifiedAt)}.`;
  if (recipient.lastTestError) return recipient.transport === "client_bot"
    ? `Проверка не прошла: ${recipient.lastTestError}. Получатель должен быть привязан к клиентскому боту компании (см. ниже).`
    : `Проверка не прошла: ${recipient.lastTestError}. Получатель должен написать боту @synapse_sb_bot команду /start.`;
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
    if (!site) { container.insertAdjacentHTML("beforeend", '<div class="card"><p>Модуль доступен для Palitra и ALVI. Выберите компанию в переключателе.</p></div>'); return; }
    if (site === "alvi") container.insertAdjacentHTML("beforeend", '<div class="card"><p>Здесь настраивается получатель и переписка клиентского бота ALVI. Публичный приём заявок с сайта пока не подключён. Настройка получателя сама по себе не включает бота.</p></div>');
    const base = `/content/${site}`;
    const controller = new AbortController();
    const api = (url, options = {}) => context.apiJson(url, { ...options, signal: controller.signal });
    const mutation = (method, body) => ({ method, headers: { "X-CSRF-Token": context.identity.csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const panel = document.createElement("div");
    panel.className = "site-orders";
    panel.innerHTML = `<section class="card site-orders__recipient"><h2>Получатель личных уведомлений в Telegram</h2>
      <p class="site-orders__warning" data-orders-warning hidden></p>
      <p data-recipient-summary>Загрузка…</p>
      <p data-group-summary hidden></p>
      <form class="site-orders__form" data-recipient-form><label>Telegram ID личного чата<input name="telegramChatId" inputmode="numeric" pattern="[0-9]{5,20}" maxlength="20" autocomplete="off" placeholder="числовой ID, не имя пользователя"></label>
      <label>Подпись<input name="label" maxlength="80" autocomplete="off" placeholder="например, менеджер"></label>
      <div class="site-orders__actions"><button type="submit">Сохранить получателя</button><button type="button" data-recipient-test>Отправить проверочное сообщение</button><button type="button" data-orders-refresh>Обновить</button></div>
      <p role="status" data-recipient-status></p></form>
      <p class="site-orders__hint">Бот пишет только тем, кто сам начал с ним диалог: для прежнего канала получатель один раз отправляет /start боту @synapse_sb_bot, для клиентского бота компании — привязывается кодом ниже. Сохранение ничего не отправляет; проверка отправляет одно служебное сообщение.</p></section>
      <div data-client-bot-box></div>
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
    // Блок клиентского бота (client-dialogs.js): обновляется вместе с заявками по кнопке и после смены получателя. Без фонового опроса.
    let botPanel = null;
    const refreshBot = () => { if (botPanel && alive()) void botPanel.refresh(); };
    // Страницы по курсору: список копится, «Показать ещё» запрашивает id < nextCursor; одна догрузка за раз.
    let shown = [], nextCursor = null, loadingMore = false;
    const setBusy = (value) => { busy = value; for (const control of form.querySelectorAll("input, button")) control.disabled = value; form.setAttribute("aria-busy", String(value)); };
    const showRecipient = (recipient) => {
      if (!alive()) return;
      summary.textContent = recipientSummary(recipient, site);
      summary.dataset.state = !recipient.configured ? "missing" : recipient.verifiedAt ? "verified" : "unverified";
      const group = panel.querySelector("[data-group-summary]");
      group.hidden = !recipient.group?.enabled;
      group.textContent = recipient.group?.configured ? "Рабочая группа подключена. Доставка каждой заявки в группу показана отдельно ниже." : "Рабочая группа не подключена; заявки сохраняются в ЛК. Настройте группу в чате проекта, затем отправьте нужные уведомления из списка.";
      if (document.activeElement !== form.elements.telegramChatId) form.elements.telegramChatId.value = recipient.telegramChatId || "";
      if (document.activeElement !== form.elements.label) form.elements.label.value = recipient.label || "";
      testButton.hidden = !recipient.configured;
      const count = Number(recipient.unnotifiedOrders) || 0;
      warning.hidden = count === 0;
      warning.textContent = count ? `${count} заявок сохранены без личного уведомления. Настройте и проверьте получателя, затем отправьте их повторно из списка.` : "";
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
          <p class="site-order__contact">${h(order.name)}${order.contactChannel ? ` · ${h(CHANNEL[order.contactChannel] || order.contactChannel)}: ${h(order.contact)}` : ""}${order.phone ? ` · <a href="tel:${h(order.phone.replace(/[^\d+]/g, ""))}">${h(order.phone)}</a>` : ""}</p>
          ${order.deliveryAddress ? `<p class="site-order__delivery">Доставка: ${h(order.deliveryAddress)}${order.deliveryDate ? ` · ${h(order.deliveryDate)}` : ""}${order.deliveryInterval ? ` · ${h(order.deliveryInterval)}` : ""}</p>` : ""}
          ${items}${order.comment ? `<p class="site-order__comment">${h(order.comment)}</p>` : ""}
          <p class="site-order__notify">Личное уведомление: ${h(explainNotify(order))}</p>
          ${order.groupNotify ? `<p class="site-order__group-notify">Рабочая группа: ${h(groupSummary(order.groupNotify))}</p>` : ""}
          ${order.work && order.work.status !== "new" ? `<span class="site-order__work site-order__work--${h(order.work.status)}">Обработка: ${h(WORK[order.work.status] || order.work.status)}${order.work.updatedAt ? ` · ${h(when(order.work.updatedAt))}` : ""}</span>` : ""}`;
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
        if (order.groupNotify?.configured && ["missing_binding", "not_queued", "error", "uncertain"].includes(order.groupNotify.status)) {
          const button = document.createElement("button");
          button.type = "button"; button.className = "site-order__renotify-group";
          button.textContent = order.groupNotify.status === "uncertain" ? "Повторить в группу (возможен дубль)" : "Отправить в рабочую группу";
          button.addEventListener("click", async () => {
            if (busy || !alive()) return;
            if (order.groupNotify.status === "uncertain" && !window.confirm(`Заявка №${order.id}: сообщение могло дойти в группу. Отправить повторно?`)) return;
            setBusy(true); button.disabled = true;
            try {
              const result = await api(`${base}/orders/${encodeURIComponent(order.id)}/renotify-group`, mutation("POST"));
              if (!alive()) return;
              if (result?.order?.id === order.id) { shown = shown.map((row) => row.id === order.id ? result.order : row); showOrders(shown); }
              status.textContent = `Уведомление по заявке №${order.id} поставлено в очередь рабочей группы.`;
            } catch (error) { if (alive()) status.textContent = error.status === 409 ? "Группа не подключена или уведомление уже отправляется." : "Не удалось поставить уведомление в очередь группы."; }
            finally { if (alive()) { setBusy(false); load({ quiet: true }); } }
          });
          article.append(button);
        }
        if (site === "palitra" && order.checklist?.items) {
          const checks = document.createElement("section");
          checks.className = "site-order__checklist";
          checks.innerHTML = '<h3>Ручная отметка менеджера</h3><p class="site-order__check-hint">Отметьте после отправки клиенту.</p>';
          for (const item of order.checklist.items) {
            const row = document.createElement("div"); row.className = "site-order__check";
            row.innerHTML = `<span>${item.checked ? "✓ " : ""}${h(item.label)}</span><small>${item.updatedAt
              ? `${item.checked ? "Отмечено" : "Отметка снята"}: ${h(item.actor?.label || "Менеджер")} · ${h(when(item.updatedAt))}` : "Пока не отмечено"}</small>`;
            const button = document.createElement("button"); button.type = "button"; button.dataset.checklistItem = item.key;
            button.textContent = item.checked ? "Снять отметку" : "Отметить отправку";
            button.setAttribute("aria-label", `${button.textContent}: ${item.label}`);
            button.addEventListener("click", async () => {
              if (busy || !alive()) return;
              setBusy(true); button.disabled = true;
              const url = `${base}/orders/${encodeURIComponent(order.id)}/checklist`;
              const apply = (result) => { if (result?.order?.id === order.id) { shown = shown.map((value) => value.id === order.id ? result.order : value); showOrders(shown); } };
              try {
                const result = await api(url, mutation("PUT", { item: item.key, checked: !item.checked, revision: item.revision }));
                if (!alive()) return;
                apply(result); status.textContent = item.checked ? "Ручная отметка снята." : "Ручная отметка сохранена.";
              } catch (error) {
                if (!alive()) return;
                if (error.status === 409) {
                  try { const fresh = await api(url); if (!alive()) return; apply(fresh); status.textContent = "Отметка уже изменена. Показано актуальное состояние."; }
                  catch { if (alive()) status.textContent = "Отметка уже изменена. Обновите список перед повтором."; }
                } else status.textContent = "Не удалось сохранить отметку. Повторите действие.";
              } finally { if (alive()) { setBusy(false); button.disabled = false; } }
            });
            row.append(button); checks.append(row);
          }
          if (order.checklist.history?.length) {
            const history = document.createElement("details");
            history.innerHTML = `<summary>История отметок</summary><ul>${order.checklist.history.map((event) => `<li>${h(event.key === "photo" ? "Фото" : "Памятка")}: ${event.checked ? "отмечено" : "отметка снята"} · ${h(event.actor?.label || "Менеджер")} · ${h(when(event.createdAt))}</li>`).join("")}</ul>`;
            checks.append(history);
          }
          article.append(checks);
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
        refreshBot();
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
    form.querySelector("[data-orders-refresh]").addEventListener("click", () => { if (!busy) { load(); refreshBot(); } });
    // Смена компании или уход с вида: незавершённые запросы отменяются, ответы не применяются.
    const observer = new MutationObserver(() => { if (!alive()) { controller.abort(); observer.disconnect(); } });
    observer.observe(container, { childList: true });
    // Клиентский бот компании: состояние, привязка менеджера, канал заявок, переписка.
    const botBox = panel.querySelector("[data-client-bot-box]");
    botPanel = cabinet.clientDialogs ? cabinet.clientDialogs.render(botBox, context, { site, alive, api, mutation, onTransportChange: () => load({ quiet: true }) }) : null;
    await load();
  }
});
})();
