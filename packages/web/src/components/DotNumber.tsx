import { useEffect, useRef, useState } from "react";

/**
 * An odometer figure (the NumberFlow / Stripe pattern): every digit is a vertical strip 0-9 that rolls to its value
 * once the figure is well inside the viewport, each digit a little after the one to its left, with a soft fade at the
 * top and bottom of each strip. Prefix and suffix ($, %, k) stay put.
 * Screen readers read the plain value; reduced-motion users get it without the roll.
 */
// inline so section rules like `.strip span` (small grey captions) never restyle the figure
const RESET: React.CSSProperties = { display: "inline", font: "inherit", color: "inherit", letterSpacing: "inherit", margin: 0, fontVariantNumeric: "tabular-nums" };
const EASE = "cubic-bezier(.22,.7,.24,1)";
const DIGITS = "0123456789";
const FADE = "linear-gradient(transparent, #000 18%, #000 82%, transparent)";

export function DotNumber({ value, className }: { value: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [rolled, setRolled] = useState(false);
  const [still, setStill] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setStill(true); return; }
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      requestAnimationFrame(() => setRolled(true));
    }, { rootMargin: "0px 0px -15% 0px", threshold: 1 });
    io.observe(el);
    return () => io.disconnect();
  }, [value]);

  if (still) return <span className={className} style={RESET}>{value}</span>;
  let k = 0;
  return (
    <span ref={ref} className={className} aria-label={value} role="img" style={{ ...RESET, display: "inline-flex", alignItems: "baseline" }}>
      {[...value].map((c, i) => {
        if (!DIGITS.includes(c)) return <span key={i} aria-hidden style={RESET}>{c}</span>;
        const order = k++;
        return (
          <span key={i} aria-hidden style={{ ...RESET, display: "inline-block", position: "relative", height: "1.05em", lineHeight: "1.05em", overflow: "hidden", WebkitMaskImage: FADE, maskImage: FADE }}>
            <span style={{ ...RESET, visibility: "hidden" }}>{c}</span>
            <span style={{ ...RESET, display: "flex", flexDirection: "column", position: "absolute", left: 0, top: 0,
              transform: `translateY(${rolled ? -Number(c) * 1.05 : 0}em)`, transition: `transform 1100ms ${EASE} ${order * 90}ms` }}>
              {[...DIGITS].map((n) => <span key={n} style={{ ...RESET, display: "block", height: "1.05em" }}>{n}</span>)}
            </span>
          </span>
        );
      })}
    </span>
  );
}
