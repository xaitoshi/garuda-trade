import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { Candle } from "../lib/types";
import { sma } from "../lib/trade";

export interface PriceMark {
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
}

const GREEN = "#3ce362";
const RED = "#ff4953";
const t = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

/**
 * `onNeedMore` is called when the user scrolls close to the oldest bar; when the parent then supplies a longer history
 * (older bars prepended) the view stays where it was instead of jumping.
 */
export function PriceChart({ candles, marks, resetKey, height = 440, onNeedMore }: { candles: Candle[]; marks: PriceMark[]; resetKey: string; height?: number; onNeedMore?: () => void }) {
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
    cs.current = c.addSeries(CandlestickSeries, { upColor: GREEN, downColor: RED, borderUpColor: GREEN, borderDownColor: RED, wickUpColor: GREEN, wickDownColor: RED, priceLineColor: GREEN });
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
    const view = ts?.getVisibleLogicalRange();
    const added = fitted.current === resetKey && first.current !== null ? candles.findIndex((k) => k.time === first.current) : 0;
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
    } else if (added > 0 && view) {
      ts?.setVisibleLogicalRange({ from: view.from + added, to: view.to + added });
    }
  }, [candles, resetKey]);

  useEffect(() => {
    const s = cs.current;
    if (!s) return;
    for (const l of lines.current) s.removePriceLine(l);
    lines.current = marks
      .filter((m) => Number.isFinite(m.price) && m.price > 0)
      .map((m) => s.createPriceLine({ price: m.price, color: m.color, lineWidth: 1, lineStyle: m.dashed === false ? LineStyle.Solid : LineStyle.Dashed, axisLabelVisible: true, title: m.title }));
  }, [marks, candles.length]);

  return <div ref={host} className="chart-host" style={{ height }} data-testid="price-chart" />;
}
