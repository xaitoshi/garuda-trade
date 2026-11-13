import { useEffect, useRef, useState } from "react";

/** One full pass of /brand/garuda-loader.svg (its CSS animation runs on a 2000ms loop). */
const LOOP = 2000;

/**
 * The dotted Garuda mark pulsing over the chart while its candles load. It always plays at least one full pass and
 * only ever stops at the end of a pass, so a fast answer never cuts the animation off half way.
 */
export function ChartLoader({ loading }: { loading: boolean }) {
  const [shown, setShown] = useState(loading);
  const [leaving, setLeaving] = useState(false);
  const [run, setRun] = useState(0);
  const t0 = useRef(performance.now());

  useEffect(() => {
    if (loading) {
      setLeaving(false);
      if (!shown) {
        t0.current = performance.now();
        setRun((r) => r + 1);
        setShown(true);
      }
      return;
    }
    if (!shown) return;
    const spent = performance.now() - t0.current;
    const wait = Math.max(1, Math.ceil(spent / LOOP)) * LOOP - spent;
    const a = setTimeout(() => setLeaving(true), wait);
    const b = setTimeout(() => setShown(false), wait + 220);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [loading, shown]);

  if (!shown) return null;
  return (
    <div className={`chart-loader${leaving ? " out" : ""}`} role="status" aria-label="Loading chart" data-testid="chart-loader">
      {/* the animation starts when the image is ready: count the passes from there */}
      <img key={run} src="/brand/garuda-loader.svg" alt="" width={34} height={58} onLoad={() => (t0.current = performance.now())} draggable={false} />
    </div>
  );
}
