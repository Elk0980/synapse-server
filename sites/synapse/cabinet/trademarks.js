(() => {
  "use strict";
  const API = "/content/synapse-business/trademarks";
  let markdown = "";
  let loaded = false;
  let cabinetContext;

  const inline = (value, escapeHTML) => escapeHTML(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  const renderMarkdown = (source, escapeHTML) => {
    const blocks = [];
    let list = [];
    const flushList = () => {
      if (list.length) blocks.push(`<ul>${list.map((item) => `<li>${inline(item, escapeHTML)}</li>`).join("")}</ul>`);
      list = [];
    };
    for (const rawLine of source.replace(/\r/g, "").split("\n")) {
      const line = rawLine.trim();
      const item = line.match(/^[-*]\s+(.+)/);
      if (item) { list.push(item[1]); continue; }
      flushList();
      if (!line) continue;
      const heading = line.match(/^(#{1,6})\s+(.+)/);
      if (heading) blocks.push(`<h${heading[1].length}>${inline(heading[2], escapeHTML)}</h${heading[1].length}>`);
      else if (line.startsWith("> ")) blocks.push(`<blockquote>${inline(line.slice(2), escapeHTML)}</blockquote>`);
      else blocks.push(`<p>${inline(line, escapeHTML)}</p>`);
    }
    flushList();
    return blocks.join("");
  };

  const showDocument = (panel, context) => {
    panel.querySelector("[data-trademarks-document]").innerHTML = renderMarkdown(markdown, context.escapeHTML);
    panel.querySelector("[data-trademarks-preview]").hidden = false;
    panel.querySelector("[data-trademarks-form]").hidden = true;
  };

  window.SbCabinet.registerView("trademarks", {
    async render(panel, context) {
      if (context.identity.role !== "owner" || loaded) return;
      cabinetContext = context;
      const document = panel.querySelector("[data-trademarks-document]");
      document.textContent = "Загрузка…";
      try {
        const data = await context.apiJson(API);
        markdown = data.markdown;
        loaded = true;
        showDocument(panel, context);
      } catch (error) {
        document.textContent = error.message;
      }
    }
  });

  document.addEventListener("click", (event) => {
    const edit = event.target.closest("[data-trademarks-edit]");
    const cancel = event.target.closest("[data-trademarks-cancel]");
    if (!edit && !cancel) return;
    const panel = document.getElementById("trademarks-view");
    if (edit) {
      panel.querySelector("[data-trademarks-textarea]").value = markdown;
      panel.querySelector("[data-trademarks-status]").textContent = "";
      panel.querySelector("[data-trademarks-preview]").hidden = true;
      panel.querySelector("[data-trademarks-form]").hidden = false;
      panel.querySelector("[data-trademarks-textarea]").focus();
    } else {
      showDocument(panel, cabinetContext);
    }
  });

  document.addEventListener("submit", async (event) => {
    if (!event.target.matches("[data-trademarks-form]")) return;
    event.preventDefault();
    const form = event.target;
    const status = form.querySelector("[data-trademarks-status]");
    const button = form.querySelector('button[type="submit"]');
    status.textContent = "Сохраняю…";
    button.disabled = true;
    try {
      const context = cabinetContext;
      const next = form.querySelector("[data-trademarks-textarea]").value;
      await context.apiJson(API, context.csrfOptions("PUT", { markdown: next }));
      markdown = next;
      showDocument(document.getElementById("trademarks-view"), context);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
})();
