/* Значок и название установленного приложения (PWA / «Домой» на iPhone).
   Синапс — у владельца и всех компаний; прежний значок Хью и прежние названия — только если
   ВСЕ компании пользователя palitra-love. Решение только оформительское: не влияет на права и данные. */
(() => {
  "use strict";
  const PALITRA = "palitra-love";
  // Пары «Синапс ↔ Palitra» по имени файла; путь до файла (brand/, ../brand/) сохраняется.
  const PAIRS = [
    ["manifest.webmanifest", "manifest-palitra.webmanifest"],
    ["people.webmanifest", "people-palitra.webmanifest"],
    ["synapse-icon-32.png", "hugh-icon-32.png"],
    ["synapse-icon-180.png", "hugh-icon-180.png"]
  ];
  const variantFor = (profile) => {
    if (!profile || typeof profile !== "object" || profile.role === "owner") return "synapse";
    const ids = (Array.isArray(profile.companies) ? profile.companies : [])
      .map((company) => (company && typeof company === "object" ? company.id : company));
    return ids.length > 0 && ids.every((id) => id === PALITRA) ? "palitra" : "synapse";
  };
  const swap = (href, variant) => {
    if (typeof href !== "string") return href;
    const [base, query = ""] = href.split(/(?=[?#])/);
    for (const [synapse, palitra] of PAIRS) {
      const from = variant === "palitra" ? synapse : palitra;
      const to = variant === "palitra" ? palitra : synapse;
      if (base === from || base.endsWith("/" + from)) return base.slice(0, base.length - from.length) + to + query;
    }
    return href;
  };
  let variant = "synapse";
  const applyLinks = () => {
    for (const link of document.querySelectorAll('link[rel="manifest"], link[rel="icon"], link[rel="apple-touch-icon"]')) {
      const current = link.getAttribute("href");
      const next = swap(current, variant);
      if (next !== current) link.setAttribute("href", next);
    }
    // iOS берёт название ярлыка из этого meta. data-palitra-content хранит прежнее значение;
    // пустое значение означает, что раньше meta не было.
    const title = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (title) {
      if (!title.hasAttribute("data-synapse-content")) title.setAttribute("data-synapse-content", title.getAttribute("content") || "");
      const palitraTitle = title.getAttribute("data-palitra-content");
      const value = variant === "palitra" && palitraTitle !== null ? palitraTitle : title.getAttribute("data-synapse-content");
      if (value) {
        if (title.getAttribute("content") !== value) title.setAttribute("content", value);
        if (title.getAttribute("name") !== "apple-mobile-web-app-title") title.setAttribute("name", "apple-mobile-web-app-title");
      } else if (title.getAttribute("name") === "apple-mobile-web-app-title") {
        title.setAttribute("name", "apple-mobile-web-app-title-disabled");
      }
    } else {
      const disabled = document.querySelector('meta[name="apple-mobile-web-app-title-disabled"]');
      if (disabled && variant !== "palitra") disabled.setAttribute("name", "apple-mobile-web-app-title");
    }
  };
  const apply = (profile) => {
    variant = variantFor(profile);
    applyLinks();
    return variant;
  };
  // Кабинет сам переключает manifest (доска владельца ↔ кабинет): держим выбранный вариант.
  new MutationObserver(() => { if (variant === "palitra") applyLinks(); })
    .observe(document.head, { subtree: true, attributes: true, attributeFilter: ["href"] });

  const check = async () => {
    try {
      const response = await fetch("/content/whoami", { credentials: "same-origin", cache: "no-store" });
      if (response.ok) { apply(await response.json()); return true; }
      if (response.status === 401) apply(null);
    } catch (error) { /* значок остаётся прежним */ }
    return false;
  };
  // После входа страница не сообщает событие: проверяем повторно после отправки формы.
  document.addEventListener("submit", () => {
    let attempts = 0;
    const retry = () => { void check().then((ok) => { if (!ok && ++attempts < 4) setTimeout(retry, 1200); }); };
    setTimeout(retry, 800);
  }, true);
  window.SynapseAppIdentity = Object.freeze({ variantFor, swap, apply, check });
  void check();
})();
