import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { Candle } from "../lib/types";
import { sma } from "../lib/trade";

export interface PriceMark {
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
}

/** A resting order drawn on the chart as a tag that can be dragged to a new price or cancelled. */
export interface ChartOrder {
  id: string;
  price: number;
  label: string;
  kind: "buy" | "sell" | "tp" | "sl" | "stop";
}

const GREEN = "#3ce362";
const RED = "#ff4953";
const t = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

/**
 * `onNeedMore` is called when the user scrolls close to the oldest bar; when the parent then supplies a longer history
 * (older bars prepended) the view stays where it was instead of jumping.
 */
export function PriceChart({ candles, marks, resetKey, height = 440, onNeedMore, orders = [], onCancelOrder, onMoveOrder, fmt = (p: number) => p.toFixed(2) }: {
  candles: Candle[];
  marks: PriceMark[];
  resetKey: string;
  height?: number;
  onNeedMore?: () => void;
  orders?: ChartOrder[];
  onCancelOrder?: (id: string) => void;
  onMoveOrder?: (id: string, price: number) => void;
  fmt?: (p: number) => string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const cs = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vol = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ma = useRef<ISeriesApi<"Line"> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const fitted = useRef<string>("");
  const first = useRef<number | null>(null);
  const more = useRef(onNeedMore);
  more.current = onNeedMore;
  // order tags: positioned every frame from the series' price scale, so they follow scrolling and zooming
  const tags = useRef(new Map<string, HTMLDivElement>());
  const ordersRef = useRef(orders);
  ordersRef.current = orders;
  const drag = useRef<{ id: string; pointer: number; startY: number; price: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState<{ id: string; price: number } | null>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const s = cs.current;
      if (s) {
        for (const o of ordersRef.current) {
          const el = tags.current.get(o.id);
          if (!el) continue;
          const p = drag.current?.id === o.id ? drag.current.price : o.price;
          const y = s.priceToCoordinate(p);
          el.style.visibility = y === null ? "hidden" : "visible";
          if (y !== null) el.style.transform = `translateY(${Math.round(y)}px)`;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const pointerPrice = (clientY: number) => {
    const r = host.current?.getBoundingClientRect();
    const s = cs.current;
    if (!r || !s) return null;
    const p = s.coordinateToPrice(clientY - r.top);
    return p === null ? null : Number(Number(p).toPrecision(6));
  };
  const startDrag = (e: React.PointerEvent, o: ChartOrder) => {
    if (!onMoveOrder || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: o.id, pointer: e.pointerId, startY: e.clientY, price: o.price, moved: false };
    chart.current?.applyOptions({ handleScroll: false, handleScale: false });
  };
  const moveDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    if (!d.moved && Math.abs(e.clientY - d.startY) < 3) return;
    const p = pointerPrice(e.clientY);
    if (p === null || !(p > 0)) return;
    d.moved = true;
    d.price = p;
    setDragging({ id: d.id, price: p });
  };
  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    chart.current?.applyOptions({ handleScroll: true, handleScale: { mouseWheel: true } });
    setDragging(null);
    const o = ordersRef.current.find((x) => x.id === d.id);
    if (d.moved && o && d.price !== o.price) onMoveOrder?.(d.id, d.price);
  };

  useEffect(() => {
    if (!host.current) return;
    const c = createChart(host.current, {
      height,
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8b8e98", fontFamily: "Inter, system-ui, sans-serif", fontSize: 11, attributionLogo: true },
      grid: { vertLines: { visible: false }, horzLines: { color: "#ffffff0a" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.06, bottom: 0.22 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "#ffffff30", labelBackgroundColor: "#2a2c32" }, horzLine: { color: "#ffffff30", labelBackgroundColor: "#2a2c32" } },
      handleScale: { mouseWheel: true },
      localization: { locale: "en-US" },
    });
    cs.current = c.addSeries(CandlestickSeries, {
      upColor: GREEN, downColor: RED, borderUpColor: GREEN, borderDownColor: RED, wickUpColor: GREEN, wickDownColor: RED, priceLineColor: GREEN,
      // keep resting orders (TP, SL, stops, limits) in view: the price scale stretches to include them
      autoscaleInfoProvider: (base: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
        const r = base();
        const ps = ordersRef.current.map((o) => o.price).filter((x) => x > 0);
        if (!r || !ps.length) return r;
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...ps), maxValue: Math.max(r.priceRange.maxValue, ...ps) } };
      },
    });
    vol.current = c.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    ma.current = c.addSeries(LineSeries, { color: "#ffffff55", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    chart.current = c;
    c.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (r && r.from < 10) more.current?.();
    });
    return () => {
      c.remove();
      chart.current = cs.current = vol.current = ma.current = null;
      lines.current = [];
      fitted.current = "";
      first.current = null;
    };
  }, [height]);

  useEffect(() => {
    if (!cs.current || !vol.current || !ma.current || candles.length === 0) return;
    // older bars were prepended: shift the view by as many bars so it does not jump
    const ts = chart.current?.timeScale();
    // keep the same stretch of time on screen when older bars arrive
    const grew = fitted.current === resetKey && first.current !== null && candles[0]!.time < first.current;
    const view = grew ? ts?.getVisibleRange() : null;
    first.current = candles[0]!.time;
    cs.current.setData(candles.map((k) => ({ time: t(k.time), open: k.open, high: k.high, low: k.low, close: k.close })));
    vol.current.setData(candles.map((k) => ({ time: t(k.time), value: k.volume, color: k.close >= k.open ? "rgba(60,227,98,.28)" : "rgba(255,73,83,.28)" })));
    ma.current.setData(sma(candles, 10).map((p) => ({ time: t(p.time), value: p.value })));
    if (fitted.current !== resetKey) {
      // open on the latest ~120 bars, with the rest to scroll back into
      const n = candles.length;
      if (n > 130) ts?.setVisibleLogicalRange({ from: n - 120, to: n + 2 });
      else ts?.fitContent();
      fitted.current = resetKey;
    } else if (view) {
      ts?.setVisibleRange(view);
    }
    // still parked at the oldest bar (the user scrolled past it while this batch loaded): ask for the next one
    const t0 = setTimeout(() => {
      const r = chart.current?.timeScale().getVisibleLogicalRange();
      if (r && r.from < 10) more.current?.();
    }, 50);
    return () => clearTimeout(t0);
  }, [candles, resetKey]);

  useEffect(() => {
    const s = cs.current;
    if (!s) return;
    for (const l of lines.current) s.removePriceLine(l);
    lines.current = marks
      .filter((m) => Number.isFinite(m.price) && m.price > 0)
      .map((m) => s.createPriceLine({ price: m.price, color: m.color, lineWidth: 1, lineStyle: m.dashed === false ? LineStyle.Solid : LineStyle.Dashed, axisLabelVisible: true, title: m.title }));
  }, [marks, candles.length]);

  return (
    <div className="chart-wrap" style={{ position: "relative", height }}>
      <div ref={host} className="chart-host" style={{ height }} data-testid="price-chart" />
      {orders.length > 0 && (
        <div className="chart-orders">
          {orders.map((o) => (
            <div
              key={o.id}
              ref={(el) => void (el ? tags.current.set(o.id, el) : tags.current.delete(o.id))}
              className={`co ${o.kind}${dragging?.id === o.id ? " dragging" : ""}${onMoveOrder ? " movable" : ""}`}
              onPointerDown={(e) => startDrag(e, o)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              title={onMoveOrder ? "Drag to move the order" : undefined}
              data-testid="chart-order"
            >
              <span className="co-tag">
                {onMoveOrder && <i className="co-grip" aria-hidden />}
                <span>{o.label}</span>
                <b>{fmt(dragging?.id === o.id ? dragging.price : o.price)}</b>
                {onCancelOrder && (
                  <button type="button" aria-label={`Cancel ${o.label}`} onClick={() => onCancelOrder(o.id)}>
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
