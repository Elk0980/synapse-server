(() => {
"use strict";
/* Клиентский Telegram-бот Palitra в ЛК владельца: состояние бота, привязка менеджера одноразовым кодом,
   канал уведомлений о заявках и переписка клиентов (только чтение: менеджер отвечает в Telegram через
   «Ответить»). Встраивается в вид «Заявки с сайта» (site-orders.js) и живёт в его жизненном цикле:
   смена компании или уход с вида останавливают запросы и не применяют устаревшие ответы. */
const cabinet = window.SbCabinet = window.SbCabinet || {};
const WHO = Object.freeze({ client: "Клиент", operator: "Менеджер", system: "Бот" });
const DELIVERY = Object.freeze({
  in: { received: "", pending: "пересылается менеджеру", sending: "пересылается менеджеру", sent: "у менеджера в Telegram",
    uncertain: "не подтверждено, дошло ли до менеджера", failed: "менеджеру не доставлено" },
  out: { received: "", pending: "отправляется", sending: "отправляется", sent: "доставлено клиенту",
    uncertain: "доставка не подтверждена — проверьте переписку в Telegram", failed: "клиенту не доставлено" },
});
const FILE_STATUS = Object.freeze({ pending: "файл ещё загружается", too_large: "файл не сохранён: слишком большой", unavailable: "файл не сохранён: недоступен боту",
  quota_exceeded: "файл не сохранён: исчерпан лимит хранилища бота" });
const TRANSPORT = Object.freeze({ project_bot: "бот Synapse (прежний канал)", client_bot: "бот Palitra" });
const when = (iso) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(date); };

function render(container, context, { site, alive, api, mutation, onTransportChange = () => {} }) {
  const h = context.escapeHTML;
  const base = `/content/${site}`;
  container.innerHTML = `<section class="card client-bot" data-client-bot><h2>Клиентский бот в Telegram</h2>
      <p data-bot-summary>Загрузка…</p>
      <div class="client-bot__actions">
        <button type="button" data-bot-code hidden>Создать код привязки менеджера</button>
        <button type="button" data-bot-transport hidden></button>
        <button type="button" data-bot-revoke hidden>Отключить менеджера</button>
      </div>
      <div class="client-bot__code" data-bot-code-box hidden></div>
      <p role="status" data-bot-status></p>
      <details class="client-bot__events"><summary>Журнал бота</summary><ul data-bot-events></ul></details></section>
    <section class="card client-dialogs" data-client-dialogs hidden><h2>Переписка с клиентами</h2>
      <p class="client-dialogs__hint">Менеджер отвечает клиентам в Telegram кнопкой «Ответить». Здесь — копия переписки и статусы доставки.</p>
      <div class="client-dialogs__layout"><div data-dialog-list aria-live="polite">Загрузка…</div><div class="client-dialogs__thread" data-dialog-thread hidden></div></div>
      <div class="client-dialogs__more"><button type="button" data-dialog-more hidden>Показать ещё</button></div></section>`;
  const summary = container.querySelector("[data-bot-summary]");
  const codeButton = container.querySelector("[data-bot-code]");
  const transportButton = container.querySelector("[data-bot-transport]");
  const revokeButton = container.querySelector("[data-bot-revoke]");
  const codeBox = container.querySelector("[data-bot-code-box]");
  const status = container.querySelector("[data-bot-status]");
  const events = container.querySelector("[data-bot-events]");
  const dialogsCard = container.querySelector("[data-client-dialogs]");
  const list = container.querySelector("[data-dialog-list]");
  const thread = container.querySelector("[data-dialog-thread]");
  const more = container.querySelector("[data-dialog-more]");
  let state = null, busy = false, dialogs = [], nextCursor = null, openId = null, openVersion = 0;
  const setBusy = (value) => { busy = value; for (const button of [codeButton, transportButton, revokeButton]) button.disabled = value; };

  const describe = (bot) => {
    if (!bot.enabled) return "Бот не подключён: на сервере не задано имя бота. Заявки и уведомления работают прежним способом.";
    const parts = [`Бот @${bot.username}.`];
    parts.push(bot.bridge?.ready ? `Сервис chat подтвердил бота ${when(bot.bridge.checkedAt)}.`
      : `Сервис chat не подтвердил бота${bot.bridge?.error ? `: ${bot.bridge.error}` : ""} — ссылки в Telegram после заявки не выдаются.`);
    if (!bot.operator.bound) parts.push("Менеджер ещё не привязан: сообщения клиентов сохраняются, но в Telegram их никто не получает.");
    else parts.push(`Менеджер привязан ${when(bot.operator.boundAt)} (Telegram ID ${bot.operator.telegramUserId})${bot.operator.matchesRecipient ? "" : " — не совпадает с получателем заявок"}.`);
    parts.push(`Уведомления о заявках: ${TRANSPORT[bot.transport] || bot.transport}.`);
    if (bot.unread) parts.push(`Непрочитанных сообщений: ${bot.unread}.`);
    if (bot.deliveryProblems) parts.push(`Сообщений с неподтверждённой или неудачной доставкой: ${bot.deliveryProblems}.`);
    if (bot.storage?.limitBytes) parts.push(`Файлы: ${Math.round(bot.storage.usedBytes / 1048576)} из ${Math.round(bot.storage.limitBytes / 1048576)} МБ.`);
    return parts.join(" ");
  };
  const showState = (bot) => {
    if (!alive()) return;
    state = bot;
    summary.textContent = describe(bot);
    summary.dataset.state = !bot.enabled ? "disabled" : bot.operator.bound ? "ready" : "unbound";
    codeButton.hidden = !bot.enabled;
    codeButton.textContent = bot.operator.bound ? "Перепривязать менеджера новым кодом" : "Создать код привязки менеджера";
    revokeButton.hidden = !bot.operator.bound;
    const toClient = bot.transport !== "client_bot";
    transportButton.hidden = !bot.enabled || (toClient && !bot.transportReady?.ok);
    transportButton.textContent = toClient ? "Присылать заявки ботом Palitra" : "Вернуть заявки на бот Synapse";
    transportButton.dataset.target = toClient ? "client_bot" : "project_bot";
    events.replaceChildren(...(bot.events || []).map((event) => {
      const item = document.createElement("li");
      item.textContent = `${when(event.createdAt)} · ${event.detail || event.kind}`;
      return item;
    }));
    dialogsCard.hidden = !bot.enabled;
  };
  const loadState = async () => {
    try { showState(await api(`${base}/client-bot`)); }
    catch (error) { if (alive() && error.name !== "AbortError") summary.textContent = "Не удалось загрузить состояние бота."; }
  };

  codeButton.addEventListener("click", async () => {
    if (busy || !alive()) return;
    setBusy(true); status.textContent = "Создаём одноразовый код…";
    try {
      const code = await api(`${base}/client-bot/operator-code`, mutation("POST"));
      if (!alive()) return;
      // Код показывается один раз и не сохраняется в браузере; он действует 10 минут и только для Telegram ID получателя.
      codeBox.hidden = false;
      codeBox.innerHTML = `<p>Передайте менеджеру. Код действует до ${h(when(code.expiresAt))} и подходит только для Telegram ID получателя заявок.</p>
        <p><a href="${h(code.deepLink)}" target="_blank" rel="noopener noreferrer">Открыть бота и привязаться</a> или отправьте боту: <code data-bot-command>${h(code.command)}</code></p>`;
      status.textContent = "Код создан. Прежний неиспользованный код больше не действует.";
      await loadState();
    } catch (error) {
      if (alive()) status.textContent = error.status === 409 ? (error.message || "Сначала сохраните получателя заявок.") : "Не удалось создать код.";
    } finally { if (alive()) setBusy(false); }
  });
  transportButton.addEventListener("click", async () => {
    if (busy || !alive()) return;
    const transport = transportButton.dataset.target;
    const warning = transport === "client_bot"
      ? "Новые заявки будут приходить менеджеру ботом Palitra. Уже отправленные заявки повторно не рассылаются. Продолжить?"
      : "Новые заявки будут приходить прежним ботом Synapse. Продолжить?";
    if (!window.confirm(warning)) return;
    setBusy(true); status.textContent = "Меняем канал уведомлений…";
    try {
      await api(`${base}/order-recipient/transport`, mutation("PUT", { transport }));
      if (!alive()) return;
      status.textContent = "Канал изменён. Отправьте проверочное сообщение получателю, чтобы подтвердить доставку новым каналом.";
      await loadState();
      onTransportChange();
    } catch (error) { if (alive()) status.textContent = error.status === 409 ? (error.message || "Бот ещё не готов.") : "Не удалось изменить канал."; }
    finally { if (alive()) setBusy(false); }
  });
  revokeButton.addEventListener("click", async () => {
    if (busy || !alive()) return;
    if (!window.confirm("Отключить менеджера от бота? Сообщения клиентов перестанут приходить ему в Telegram, заявки вернутся на прежний канал.")) return;
    setBusy(true); status.textContent = "Отключаем менеджера…";
    try {
      showState(await api(`${base}/client-bot/revoke-operator`, mutation("POST")));
      codeBox.hidden = true; codeBox.textContent = "";
      if (alive()) status.textContent = "Менеджер отключён.";
      onTransportChange();
    } catch (error) { if (alive()) status.textContent = "Не удалось отключить менеджера."; }
    finally { if (alive()) setBusy(false); }
  });

  const attachmentHtml = (file) => {
    const label = `${h(file.name)}${file.size ? ` · ${h(Math.max(1, Math.round(file.size / 1024)))} КБ` : ""}`;
    // Заменённое клиентом вложение показывается только как прежняя версия, не как текущий файл.
    if (file.superseded) {
      const old = file.status === "stored" ? `<a href="${h(`${base}/client-dialogs/attachments/${encodeURIComponent(file.id)}`)}" target="_blank" rel="noopener">${label}</a>` : label;
      return `<p class="client-file client-file--replaced">📎 Прежняя версия (клиент заменил вложение ${h(when(file.supersededAt))}): ${old}</p>`;
    }
    if (file.status !== "stored") return `<p class="client-file client-file--missing">📎 ${label} — ${h(FILE_STATUS[file.status] || "файл не сохранён")}${file.error ? ` (${h(file.error)})` : ""}</p>`;
    const url = `${base}/client-dialogs/attachments/${encodeURIComponent(file.id)}`;
    if (/^image\//.test(file.mime)) return `<a class="client-file" href="${h(url)}" target="_blank" rel="noopener"><img src="${h(url)}" alt="${h(file.name)}" loading="lazy"></a>`;
    if (/^audio\//.test(file.mime)) return `<audio class="client-file" controls preload="none" src="${h(url)}" aria-label="${h(file.name)}"></audio>`;
    if (/^video\//.test(file.mime)) return `<video class="client-file" controls preload="none" src="${h(url)}" aria-label="${h(file.name)}"></video>`;
    return `<a class="client-file" href="${h(url)}" download>📎 ${label}</a>`;
  };
  const messageHtml = (message) => {
    const direction = message.direction === "out" ? "out" : "in";
    const delivery = message.direction === "system" ? "" : (DELIVERY[direction][message.deliveryStatus] || "");
    const problem = ["uncertain", "failed"].includes(message.deliveryStatus);
    const versions = message.versions.length ? `<details class="client-message__versions"><summary>${message.versions.some((v) => v.kind === "operator_edit_not_sent") ? "Исправлено в Telegram, клиенту не отправлено" : "Изменено клиентом"}</summary>
      <ul>${message.versions.map((v) => `<li>${h(when(v.createdAt))}: ${h(v.text)}${v.kind === "operator_edit_not_sent" ? " (не отправлено клиенту)" : " (прежний текст)"}</li>`).join("")}</ul></details>` : "";
    return `<article class="client-message client-message--${h(message.direction)}${problem ? " client-message--problem" : ""}">
      <header><b>${h(WHO[message.authorType] || message.authorType)}</b> · ${h(when(message.createdAt))}${delivery ? ` · <span class="client-message__delivery">${h(delivery)}</span>` : ""}</header>
      ${message.text ? `<p class="client-message__text">${h(message.text)}</p>` : ""}
      ${message.attachments.map(attachmentHtml).join("")}
      ${problem && message.deliveryError ? `<p class="client-message__error">${h(message.deliveryError)}</p>` : ""}${versions}</article>`;
  };
  const openDialog = async (id) => {
    const version = ++openVersion;
    openId = id;
    thread.hidden = false;
    thread.textContent = "Загрузка переписки…";
    try {
      const data = await api(`${base}/client-dialogs/${encodeURIComponent(id)}`);
      if (!alive() || version !== openVersion) return;
      const d = data.dialog;
      thread.innerHTML = `<header class="client-dialogs__head"><h3>${h(d.name)}${d.username ? ` <span>@${h(d.username)}</span>` : ""}</h3>
        <p>Диалог №${h(d.id)}${d.source ? ` · источник: ${h(d.source)}` : ""}${data.order ? ` · заявка №${h(data.order.id)}` : ""}</p></header>
        <div class="client-dialogs__messages">${data.messages.map(messageHtml).join("") || "<p>Сообщений нет.</p>"}</div>`;
      if (d.unread) {
        await api(`${base}/client-dialogs/${encodeURIComponent(id)}/read`, mutation("POST"));
        if (!alive()) return;
        dialogs = dialogs.map((row) => (row.id === d.id ? { ...row, unread: 0 } : row));
        showDialogs();
      }
    } catch (error) {
      if (alive() && version === openVersion && error.name !== "AbortError") thread.textContent = "Не удалось загрузить переписку.";
    }
  };
  const showDialogs = () => {
    if (!alive()) return;
    more.hidden = nextCursor === null;
    if (!dialogs.length) { list.textContent = "Клиенты ещё не писали боту."; return; }
    const items = dialogs.map((dialog) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `client-dialog${dialog.id === openId ? " client-dialog--open" : ""}`;
      button.dataset.dialogId = String(dialog.id);
      button.innerHTML = `<b>${h(dialog.name)}</b>${dialog.unread ? ` <span class="client-dialog__unread" aria-label="Непрочитанных: ${h(dialog.unread)}">${h(dialog.unread)}</span>` : ""}
        <span class="client-dialog__meta">${dialog.orderId ? `заявка №${h(dialog.orderId)} · ` : ""}${h(when(dialog.lastMessageAt))}</span>
        <span class="client-dialog__last">${h(dialog.lastMessage || "")}</span>`;
      button.addEventListener("click", () => { openDialog(dialog.id); showDialogs(); });
      return button;
    });
    list.replaceChildren(...items);
  };
  const loadDialogs = async ({ append = false } = {}) => {
    try {
      const data = await api(`${base}/client-dialogs?limit=50${append && nextCursor !== null ? `&beforeId=${encodeURIComponent(nextCursor)}` : ""}`);
      if (!alive()) return;
      if (append) { const known = new Set(dialogs.map((row) => row.id)); dialogs = dialogs.concat(data.dialogs.filter((row) => !known.has(row.id))); }
      else dialogs = data.dialogs;
      nextCursor = data.nextCursor ?? null;
      showDialogs();
    } catch (error) { if (alive() && error.name !== "AbortError") list.textContent = "Не удалось загрузить переписку."; }
  };
  more.addEventListener("click", () => { if (alive() && nextCursor !== null) loadDialogs({ append: true }); });
  const refresh = async () => { await loadState(); if (alive() && state?.enabled) { await loadDialogs(); if (openId !== null) await openDialog(openId); } };
  return { refresh, ready: refresh() };
}

cabinet.clientDialogs = { render };
})();
