import { useEffect, type RefObject } from "react";

/**
 * Scroll reveal for a page: every element matching `selector` inside `root` gets `.in` the first time it is well
 * inside the viewport. Siblings get `--i` (their index among matched siblings) so CSS can stagger them. The root gets
 * `.reveal-ready` only once this runs, so without JavaScript, or with reduced motion, nothing is ever hidden.
 */
export function useReveal(root: RefObject<HTMLElement | null>, selector: string) {
  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    const items = [...el.querySelectorAll<HTMLElement>(selector)];
    const counts = new Map<Element | null, number>();
    for (const it of items) {
      const n = counts.get(it.parentElement) ?? 0;
      it.style.setProperty("--i", String(n));
      counts.set(it.parentElement, n + 1);
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.12 });
    // anything already on screen when the page opens reveals at once, in order
    items.forEach((it) => io.observe(it));
    el.classList.add("reveal-ready");
    return () => { io.disconnect(); el.classList.remove("reveal-ready"); };
  }, [root, selector]);
}
