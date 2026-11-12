import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * The landing's scroll reveal, for every other page: panels, cards, headings and table rows rise in as they come into
 * view, siblings one after another. Content that arrives later (API data) is picked up as it is added.
 * Only runs where motion is allowed; nothing is hidden before this has started.
 */
const SELECTOR = [
  "h1", "h2.pt", ".hd", ".hdr", ".info-hd", ".stepper", ".promo", ".tabrow",
  ".panel:not(.gate)", ".hud", ".cd", ".kc", ".tr", ".pc", ".ptf", ".sum > div",
  "tbody tr", ".mkt-group", ".faq-list details",
].join(",");

export function useRevealAll() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (pathname === "/" || window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    const main = document.querySelector("main");
    if (!main) return;
    const seen = new WeakSet<Element>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.05 });
    const scan = () => {
      const fresh = [...main.querySelectorAll<HTMLElement>(SELECTOR)].filter((el) => !seen.has(el));
      const order = new Map<Element | null, number>();
      for (const el of fresh) {
        seen.add(el);
        const n = order.get(el.parentElement) ?? 0;
        order.set(el.parentElement, n + 1);
        el.style.setProperty("--ri", String(Math.min(n, 8)));
        el.classList.add("rv-x");
        io.observe(el);
      }
    };
    document.documentElement.classList.add("reveal-all");
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(main, { childList: true, subtree: true });
    return () => { io.disconnect(); mo.disconnect(); document.documentElement.classList.remove("reveal-all"); };
  }, [pathname]);
}
