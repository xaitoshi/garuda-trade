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

const GREEN = "#3ddc97";
const RED = "#ff5f6d";
const t = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

export function PriceChart({ candles, marks, resetKey, height = 440 }: { candles: Candle[]; marks: PriceMark[]; resetKey: string; height?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const cs = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vol = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ma = useRef<ISeriesApi<"Line"> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const fitted = useRef<string>("");

  useEffect(() => {
    if (!host.current) return;
    const c = createChart(host.current, {
      height,
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#5f5a5b", fontFamily: "GM, monospace", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: "#242122" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.06, bottom: 0.22 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "#3b3738", labelBackgroundColor: "#242122" }, horzLine: { color: "#3b3738", labelBackgroundColor: "#242122" } },
      handleScale: { mouseWheel: true },
    });
    cs.current = c.addSeries(CandlestickSeries, { upColor: GREEN, downColor: RED, borderUpColor: GREEN, borderDownColor: RED, wickUpColor: GREEN, wickDownColor: RED, priceLineColor: "#ff5f01" });
    vol.current = c.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    ma.current = c.addSeries(LineSeries, { color: "#bbb4fb", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = cs.current = vol.current = ma.current = null;
      lines.current = [];
      fitted.current = "";
    };
  }, [height]);

  useEffect(() => {
    if (!cs.current || !vol.current || !ma.current || candles.length === 0) return;
    cs.current.setData(candles.map((k) => ({ time: t(k.time), open: k.open, high: k.high, low: k.low, close: k.close })));
    vol.current.setData(candles.map((k) => ({ time: t(k.time), value: k.volume, color: k.close >= k.open ? "rgba(61,220,151,.28)" : "rgba(255,95,109,.28)" })));
    ma.current.setData(sma(candles, 10).map((p) => ({ time: t(p.time), value: p.value })));
    if (fitted.current !== resetKey) {
      chart.current?.timeScale().fitContent();
      fitted.current = resetKey;
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
