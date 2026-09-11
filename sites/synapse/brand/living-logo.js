/* Decorative identity only. Never infer network, assistant or task status. */
(() => {
  "use strict";
  const active = new Set();
  const observer = "IntersectionObserver" in window ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      entry.target.dataset.sbVisible = String(entry.isIntersecting);
    }
  }, { threshold: 0 }) : null;

  const findOrbs = (node) => {
    if (node.nodeType !== 1) return [];
    return [...(node.matches(".sb-orb") ? [node] : []), ...node.querySelectorAll(".sb-orb")];
  };
  const add = (node) => {
    for (const orb of findOrbs(node)) {
      if (active.has(orb)) continue;
      active.add(orb);
      if (observer) observer.observe(orb);
      else orb.dataset.sbVisible = "true";
    }
  };
  const remove = (node) => {
    for (const orb of findOrbs(node)) {
      if (orb.isConnected) continue;
      observer?.unobserve(orb);
      active.delete(orb);
    }
  };
  const syncVisibility = () => {
    document.documentElement.classList.toggle("sb-motion-paused", document.hidden || !!navigator.connection?.saveData);
  };
  syncVisibility();
  document.addEventListener("visibilitychange", syncVisibility);
  navigator.connection?.addEventListener?.("change", syncVisibility);
  add(document.body);
  new MutationObserver(records => {
    for (const record of records) {
      record.removedNodes.forEach(remove);
      record.addedNodes.forEach(add);
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
