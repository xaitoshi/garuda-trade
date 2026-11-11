import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ColorType, CrosshairMode, CandlestickSeries, LineStyle, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import {
  TIMEFRAMES,
  UPLOAD_TYPES,
  cashtagOf,
  checkUpload,
  fetchBars,
  fetchTweet,
  fmtAge,
  fmtPct,
  fmtPrice,
  isUploadId,
  mediaSrc,
  parseTweetUrl,
  pickTimeframe,
  priceAt,
  resolveAsset,
  statsFor,
  uploadImage,
  uploadSrc,
  windowFor,
  type Asset,
  type Bar,
  type CallStats,
  type Side,
  type Timeframe,
  type TweetInfo,
} from "../lib/calledit";
import { renderCard } from "../lib/calledit-card";
import { XMarketsButton } from "../components/XMarkets";

const EXAMPLES: { label: string; tweet: string; ticker: string; side: Side }[] = [
  { label: "@pedrosilva shorts $SOL", tweet: "https://x.com/pedrosilva/status/2111427300243693614", ticker: "SOL", side: "short" },
  { label: "@Yxng100k shorts $BTC", tweet: "https://x.com/Yxng100k/status/2103277872026620378", ticker: "BTC", side: "short" },
  { label: "@MavenHL on the $HYPE bottom", tweet: "https://x.com/MavenHL/status/2112853001446604976", ticker: "HYPE", side: "long" },
];

const TIERS = [
  ["$5K", "$39"],
  ["$10K", "$79"],
  ["$15K", "$119"],
  ["$25K", "$200"],
] as const;

interface Result {
  tweet: TweetInfo;
  handle?: string;
  asset: Asset;
  tf: Timeframe;
  bars: Bar[];
  stats: CallStats;
  now: number;
}

const ts = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

export function CalledIt() {
  const [params, setParams] = useSearchParams();
  const [tweetIn, setTweetIn] = useState(params.get("tweet") ?? "");
  const [tickerIn, setTickerIn] = useState(params.get("ticker") ?? "");
  const [side, setSide] = useState<Side>(params.get("side") === "short" ? "short" : "long");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [card, setCard] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const initialImg = params.get("img");
  const [upload, setUpload] = useState<{ id?: string; src: string; busy?: boolean } | null>(isUploadId(initialImg) ? { id: initialImg, src: uploadSrc(initialImg) } : null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [mediaBroken, setMediaBroken] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const run = useRef(0);

  const load = useCallback(async (tweetRaw: string, tickerRaw: string, sideIn: Side, tfId?: string) => {
    const parsed = parseTweetUrl(tweetRaw);
    if (!parsed) {
      setErr("That does not look like an X post link. Paste something like x.com/user/status/123...");
      return;
    }
    const my = ++run.current;
    setBusy(true);
    setErr(null);
    setCard(null);
    try {
      const tweet = await fetchTweet(parsed.id);
      const now = Date.now();
      if (tweet.postedAt > now) throw new Error("That post is from the future. Check the link.");
      const ticker = tickerRaw.trim() || cashtagOf(tweet.text) || "";
      if (!ticker) throw new Error("No $ticker in that post. Add one, like BTC or a contract address.");
      const asset = await resolveAsset(ticker);
      const tf = TIMEFRAMES.find((t) => t.id === tfId) ?? pickTimeframe(now - tweet.postedAt);
      const { start, end } = windowFor(tweet.postedAt, now, tf);
      const bars = await fetchBars(asset, tf, start, end);
      if (bars.length < 3) throw new Error(`No ${asset.symbol} price history around that post. It may predate the market.`);
      if (bars[0]!.time > tweet.postedAt) throw new Error(`${asset.symbol} has no candles from before this post on ${asset.sourceLabel}.`);
      const entry = await priceAt(asset, bars, tweet.postedAt, tf);
      const stats = entry ? statsFor(bars, tweet.postedAt, entry, tf.ms, sideIn) : undefined;
      if (!stats) throw new Error("Could not price the call. Try another timeframe.");
      if (my !== run.current) return;
      setMediaBroken(false);
      setRes({ tweet, handle: tweet.handle ?? parsed.handle, asset, tf, bars, stats, now });
      if (!tickerRaw.trim()) setTickerIn(asset.kind === "perp" ? asset.symbol : ticker);
      setParams((p) => {
        const n = new URLSearchParams(p);
        n.set("tweet", tweetRaw.trim());
        n.set("ticker", tickerRaw.trim() || ticker);
        if (sideIn === "short") n.set("side", "short");
        else n.delete("side");
        if (tfId) n.set("tf", tfId);
        else n.delete("tf");
        return n;
      }, { replace: true });
    } catch (e) {
      if (my === run.current) {
        setErr((e as Error).message || "Something broke. Try again.");
        setRes(null);
      }
    } finally {
      if (my === run.current) setBusy(false);
    }
  }, [setParams]);

  // Shared links reproduce the chart on open.
  useEffect(() => {
    const t = params.get("tweet");
    if (t) void load(t, params.get("ticker") ?? "", params.get("side") === "short" ? "short" : "long", params.get("tf") ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tweetPhoto = res?.tweet.media?.[0];
  const shownImage = upload?.src ?? (tweetPhoto && !mediaBroken ? mediaSrc(tweetPhoto.url) : undefined);

  useEffect(() => {
    if (!res) return;
    let live = true;
    void renderCard({ ...res, tfMs: res.tf.ms, url: shareUrl(), image: shownImage })
      .then((cv) => live && setCard(cv.toDataURL("image/png")))
      .catch(() => live && setCard(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res, shownImage, upload?.id]);

  const setImgParam = (id: string | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (id) n.set("img", id);
      else n.delete("img");
      return n;
    }, { replace: true });

  const pickFile = (f: File | undefined) => {
    if (!f) return;
    setUploadErr(null);
    const bad = checkUpload(f);
    if (bad) {
      setUploadErr(bad);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setUploadErr("Could not read that file.");
    reader.onload = async () => {
      const dataUrl = String(reader.result);
      setUpload({ src: dataUrl, busy: true });
      try {
        const saved = await uploadImage(dataUrl);
        setUpload({ id: saved.id, src: dataUrl });
        setImgParam(saved.id);
      } catch (e) {
        setUpload({ src: dataUrl });
        setUploadErr(`${(e as Error).message} The image is on your card, but shared links will not include it.`);
      }
    };
    reader.readAsDataURL(f);
  };

  const clearUpload = () => {
    setUpload(null);
    setUploadErr(null);
    setImgParam(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const shareUrl = () => {
    const u = new URL("/calledit", window.location.origin);
    for (const k of ["tweet", "ticker", "side", "tf", "img"]) {
      const v = new URLSearchParams(window.location.search).get(k);
      if (v) u.searchParams.set(k, v);
    }
    return u.toString();
  };

  const intent = useMemo(() => {
    if (!res) return "#";
    const who = res.handle ? `@${res.handle}` : "This call";
    const won = res.stats.callPct >= 0;
    const what = res.stats.side === "short" ? "the top" : "the bottom";
    const text = won
      ? `${who} called ${what} on $${res.asset.symbol}. ${fmtPct(res.stats.callPct)} since the post.\n\nReceipts pinned to the exact candle on Garuda (@garuda_markets):`
      : `${who} tried to call ${what} on $${res.asset.symbol}. ${fmtPct(res.stats.callPct)} since the post.\n\nReceipts pinned to the exact candle on Garuda (@garuda_markets):`;
    return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl())}`;
  }, [res]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (tweetIn.trim() !== (params.get("tweet") ?? "")) clearUpload();
    void load(tweetIn, tickerIn, side);
  };

  const download = () => {
    if (!card || !res) return;
    const a = document.createElement("a");
    a.href = card;
    a.download = `garuda-calledit-${res.asset.symbol.toLowerCase()}-${res.tweet.id}.png`;
    a.click();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl());
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked: the address bar has the same link */
    }
  };

  return (
    <main className="ci">
      <section className="ci-hero">
        <div className="eyebrow">Called it</div>
        <h1 className="pt">Pin the tweet. Show the receipts.</h1>
        <p className="ci-sub">Paste any X post and a ticker. We pin it to the exact candle it went out on and show the move since. No screenshots, no excuses.</p>
        <form className="ci-form" onSubmit={submit}>
          <label className="ci-field ci-field-url">
            <span className="lbl">X post link</span>
            <input value={tweetIn} onChange={(e) => setTweetIn(e.target.value)} placeholder="https://x.com/someone/status/1234..." inputMode="url" autoComplete="off" spellCheck={false} data-testid="ci-tweet" />
          </label>
          <label className="ci-field ci-field-tk">
            <span className="lbl">Ticker or contract</span>
            <input value={tickerIn} onChange={(e) => setTickerIn(e.target.value)} placeholder="BTC, SOL, HYPE or CA" autoComplete="off" spellCheck={false} data-testid="ci-ticker" />
          </label>
          <div className="ci-field ci-field-side">
            <span className="lbl">The call</span>
            <div className="ci-side-toggle" role="radiogroup" aria-label="Call direction">
              {(["long", "short"] as const).map((v) => (
                <button key={v} type="button" role="radio" aria-checked={side === v} className={side === v ? "on" : ""} onClick={() => setSide(v)}>
                  {v === "long" ? "Bottom" : "Top"}
                </button>
              ))}
            </div>
          </div>
          <button className="btn btn-fire" type="submit" disabled={busy} data-testid="ci-go">
            {busy ? "Pinning..." : "Pin it"}
          </button>
        </form>
        <div className="ci-examples">
          <span className="dim">Try</span>
          {EXAMPLES.map((x) => (
            <button
              key={x.tweet}
              type="button"
              className="chip"
              onClick={() => {
                setTweetIn(x.tweet);
                setTickerIn(x.ticker);
                setSide(x.side);
                clearUpload();
                void load(x.tweet, x.ticker, x.side);
              }}
            >
              {x.label}
            </button>
          ))}
        </div>
        {err && <div className="ci-err" role="alert">{err}</div>}
      </section>

      {res && (
        <section className="ci-result" data-testid="ci-result">
          <div className="panel ci-chart">
            <div className="ph">
              <span className="ci-sym">
                {res.asset.logo && <img src={res.asset.logo} alt="" width={20} height={20} onError={(e) => (e.currentTarget.style.display = "none")} />}
                <b>{res.asset.symbol}/USD</b>
                <span className="dim">{res.asset.sourceLabel}</span>
              </span>
              <span className="ci-tfs">
                {TIMEFRAMES.map((t) => (
                  <button key={t.id} type="button" className={`chip${t.id === res.tf.id ? " on" : ""}`} onClick={() => void load(tweetIn || params.get("tweet") || "", tickerIn, res.stats.side, t.id)} disabled={busy}>
                    {t.id}
                  </button>
                ))}
              </span>
            </div>
            <CallChart res={res} />
          </div>

          <aside className="ci-side">
            <div className="panel ci-tweet">
              <div className="ci-author">
                {res.tweet.avatar ? <img src={res.tweet.avatar} alt="" /> : <span className="ci-av">{(res.handle ?? "?").slice(0, 1).toUpperCase()}</span>}
                <div>
                  <b>{res.tweet.name ?? (res.handle ? `@${res.handle}` : "Unknown poster")}</b>
                  <span className="mute">{res.handle ? `@${res.handle}` : "on X"}</span>
                </div>
                <a className="ci-x" href={`https://x.com/${res.handle ?? "i/web"}/status/${res.tweet.id}`} target="_blank" rel="noreferrer" aria-label="Open on X">
                  X
                </a>
              </div>
              {res.tweet.text ? <p className="ci-text">{res.tweet.text}</p> : <p className="ci-text mute">Could not load the post text. The time is still exact: it is baked into the post id.</p>}
              {shownImage && (
                <figure className="ci-media" data-testid="ci-media">
                  <img
                    key={shownImage}
                    src={shownImage}
                    alt={upload ? "Uploaded image" : tweetPhoto?.alt ?? "Image from the post"}
                    onError={() => {
                      if (upload) setUploadErr("That image could not be shown. Try another file.");
                      else setMediaBroken(true);
                    }}
                  />
                  {upload?.busy && <figcaption className="mono dim">Uploading...</figcaption>}
                  {tweetPhoto?.type === "video" && !upload && <figcaption className="mono dim">Video thumbnail</figcaption>}
                </figure>
              )}
              {mediaBroken && !upload && <p className="ci-media-note mute" data-testid="ci-media-broken">The image in this post did not load. Upload it here and it goes on your card.</p>}
              <div className="ci-upload">
                <button type="button" className="chip" onClick={() => fileRef.current?.click()} disabled={upload?.busy} data-testid="ci-upload">
                  {upload ? "Replace image" : tweetPhoto && !mediaBroken ? "Use my own image" : "Upload image"}
                </button>
                {upload && !upload.busy && (
                  <button type="button" className="chip" onClick={clearUpload}>
                    {tweetPhoto ? "Use the post image" : "Remove image"}
                  </button>
                )}
                <span className="dim">PNG, JPG, WEBP or GIF up to 5 MB</span>
                <input ref={fileRef} type="file" accept={UPLOAD_TYPES.join(",")} hidden onChange={(e) => pickFile(e.target.files?.[0])} data-testid="ci-upload-input" />
              </div>
              {uploadErr && <div className="ci-err ci-upload-err" role="alert">{uploadErr}</div>}
              <div className="ci-when mono dim">
                {new Date(res.tweet.postedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} · {fmtAge(res.now - res.tweet.postedAt)} ago
              </div>
            </div>

            <div className="panel ci-stats">
              <div className={`ci-big ${res.stats.callPct >= 0 ? "up" : "dn"}`} data-testid="ci-change">{fmtPct(res.stats.callPct)}</div>
              <div className="ci-big-sub">{res.stats.side === "short" ? `on the ${res.asset.symbol} short since this call` : "since this call"}</div>
              <dl>
                <div><dt>At the post</dt><dd>{fmtPrice(res.stats.entry)}</dd></div>
                <div><dt>Now</dt><dd>{fmtPrice(res.stats.now)}</dd></div>
                <div><dt>Best since</dt><dd className={res.stats.bestPct >= 0 ? "up" : "dn"}>{fmtPct(res.stats.bestPct)}</dd></div>
                <div><dt>Worst since</dt><dd className={res.stats.worstPct >= 0 ? "up" : "dn"}>{fmtPct(res.stats.worstPct)}</dd></div>
              </dl>
            </div>

            <div className="ci-actions">
              <a className="btn btn-fire" href={intent} target="_blank" rel="noreferrer" data-testid="ci-share">Share on X</a>
              <button className="btn btn-ghost" type="button" onClick={download} disabled={!card} data-testid="ci-download">Download card</button>
              <button className="btn btn-ghost" type="button" onClick={() => void copy()}>{copied ? "Link copied" : "Copy link"}</button>
            </div>
          </aside>

          {card && (
            <div className="ci-card">
              <div className="lbl">Your card</div>
              <img src={card} alt={`Called it card: ${res.asset.symbol} ${fmtPct(res.stats.callPct)}`} data-testid="ci-card" />
            </div>
          )}
        </section>
      )}

      {!res && !busy && (
        <section className="ci-how">
          {[
            ["01", "Paste the post", "Any public X link. The post time is baked into its id, down to the millisecond."],
            ["02", "We pin the candle", "Live candles from Hyperliquid for majors and GeckoTerminal for any Solana or EVM contract."],
            ["03", "Flex the receipts", "Download the card or share the link. It rebuilds the chart for whoever opens it."],
          ].map(([n, h, p]) => (
            <div className="panel ci-step" key={n}>
              <span className="fire mono">{n}</span>
              <b>{h}</b>
              <p className="mute">{p}</p>
            </div>
          ))}
        </section>
      )}

      <section className="panel ci-cta">
        <div>
          <div className="eyebrow">Garuda challenges</div>
          <h2 className="pt">Called it? Prove it with a funded Garuda challenge.</h2>
          <p className="mute">Tweets are cheap. Trade a simulated account against the live Phoenix book, hit the 10% target, keep the profit split.</p>
        </div>
        <div className="ci-tiers">
          {TIERS.map(([size, fee]) => (
            <Link key={size} to="/challenges" className="ci-tier">
              <b>{size}</b>
              <span className="mute">{fee}</span>
            </Link>
          ))}
          <Link to="/challenges" className="ci-tier ci-tier-free">
            <b>Demo</b>
            <span className="up">Free</span>
          </Link>
        </div>
        <div className="cta-row">
          <Link to="/challenges" className="btn btn-fire">Start a challenge</Link>
          <XMarketsButton />
        </div>
      </section>
    </main>
  );
}

function CallChart({ res }: { res: Result }) {
  const host = useRef<HTMLDivElement>(null);
  const pin = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const c = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8b8e98", fontFamily: "Inter, system-ui, sans-serif", fontSize: 11, attributionLogo: true },
      grid: { vertLines: { visible: false }, horzLines: { color: "#ffffff0a" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.14, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "#ffffff30", labelBackgroundColor: "#2a2c32" }, horzLine: { color: "#ffffff30", labelBackgroundColor: "#2a2c32" } },
      localization: { locale: "en-US", priceFormatter: (p: number) => fmtPrice(p).replace("$", "") },
    });
    const s = c.addSeries(CandlestickSeries, { upColor: "#3ddc97", downColor: "#ff5f6d", borderVisible: false, wickUpColor: "#3ddc97", wickDownColor: "#ff5f6d", priceLineColor: "#948f90" });
    chart.current = c;
    series.current = s;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  useEffect(() => {
    const c = chart.current;
    const s = series.current;
    if (!c || !s) return;
    const { bars, tweet, stats, tf } = res;
    s.setData(bars.map((b) => ({ time: ts(b.time), open: b.open, high: b.high, low: b.low, close: b.close })));
    const callBar = bars.find((b) => b.time <= tweet.postedAt && tweet.postedAt < b.time + tf.ms) ?? bars.find((b) => b.time > tweet.postedAt) ?? bars[bars.length - 1]!;
    const line = s.createPriceLine({ price: stats.entry, color: "#f2f2f3aa", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "call" });
    c.timeScale().fitContent();

    const place = () => {
      const el = pin.current;
      if (!el) return;
      const x = c.timeScale().timeToCoordinate(ts(callBar.time));
      const y = s.priceToCoordinate(stats.entry);
      if (x === null || y === null) {
        el.style.opacity = "0";
        return;
      }
      el.style.opacity = "1";
      el.style.transform = `translate(${x}px, ${y}px)`;
    };
    place();
    const raf = requestAnimationFrame(place);
    c.timeScale().subscribeVisibleLogicalRangeChange(place);
    c.timeScale().subscribeSizeChange(place);
    return () => {
      cancelAnimationFrame(raf);
      c.timeScale().unsubscribeVisibleLogicalRangeChange(place);
      c.timeScale().unsubscribeSizeChange(place);
      s.removePriceLine(line);
    };
  }, [res]);

  return (
    <div className="ci-chart-wrap">
      <div ref={host} className="ci-chart-host" data-testid="ci-chart" />
      <div ref={pin} className="ci-pin" aria-hidden>
        <span className="ci-pin-line" />
        {res.tweet.avatar ? <img src={res.tweet.avatar} alt="" /> : <i>{(res.handle ?? "?").slice(0, 1).toUpperCase()}</i>}
        <span className="ci-pin-tag">
          {res.handle ? `@${res.handle}` : "The call"} <b>{fmtPrice(res.stats.entry)}</b>
        </span>
      </div>
    </div>
  );
}
