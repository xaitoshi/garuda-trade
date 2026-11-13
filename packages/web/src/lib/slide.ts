// Sliding selection indicators, the way Pilot moves its nav pill and side picker: each segmented control gets its
// active child's box as CSS variables, and a ::before in pilot-theme.css glides between positions. One observer
// covers every control on every page, so components keep their plain `.on` markup.
const SELECTOR = ".tabs, .mnav, .seg, .seg2, .tabs2, .tb, .tf, .flt, .sw";
const ACTIVE = ":scope > .on, :scope > .active, :scope > button.chip.on";

function place(el: HTMLElement) {
  const on = el.querySelector<HTMLElement>(ACTIVE);
  if (!on) {
    el.style.setProperty("--sw", "0px");
    return;
  }
  const s = el.style;
  s.setProperty("--sx", `${on.offsetLeft}px`);
  s.setProperty("--sy", `${on.offsetTop}px`);
  s.setProperty("--sw", `${on.offsetWidth}px`);
  s.setProperty("--sh", `${on.offsetHeight}px`);
  // Enable the transition only after the first placement, so a page never animates in from the left edge.
  if (!el.dataset.slide) requestAnimationFrame(() => (el.dataset.slide = "ready"));
}

export function installSlidingIndicators() {
  let queued = false;
  const all = () => {
    queued = false;
    document.querySelectorAll<HTMLElement>(SELECTOR).forEach(place);
  };
  const schedule = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(all);
    }
  };
  new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  window.addEventListener("resize", schedule);
  document.fonts?.ready.then(schedule);
  schedule();
}
