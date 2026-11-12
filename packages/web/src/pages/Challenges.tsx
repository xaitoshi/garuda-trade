import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, errorText } from "../lib/api";
import { usePoll } from "../lib/hooks";
import { useSession } from "../lib/session";
import { STEP_TEXT, usePurchase } from "../lib/usePurchase";
import { eligibilityFor } from "../lib/eligibility";
import { LEVELS, randomKnightName, type KnightLevel } from "../lib/knight";
import { pct, shortAddr, usd } from "../lib/format";
import type { Rules, TierId, TierSpec } from "../lib/types";
import { Check, KnightImg, Lock, Logo, Spark } from "../components/Art";
import { WalletButton } from "../components/TopBar";

const TINT: Record<string, string> = { demo: "188,182,184", squire: "217,211,212", knight: "143,133,255", paladin: "90,190,255", ascended: "255,150,30" };
const PAID: TierId[] = ["squire", "knight", "paladin", "ascended"];
const lvl = (t: TierId): KnightLevel => (LEVELS.findIndex((l) => l.tier === t) + 1) as KnightLevel;

export function Challenges() {
  const { rules, signedIn, health, connected, wallet: address, walletLabel } = useSession();
  const [params] = useSearchParams();
  const nav = useNavigate();
  // The free Demo card sits with the paid tiers on the Challenges tab (there is no separate Demo tab any more).
  const [tab, setTab] = useState<"challenges" | "revive">(params.get("tab") === "revive" ? "revive" : "challenges");
  const [sel, setSel] = useState<TierId | null>((params.get("tier") as TierId | null) ?? null);
  const [name, setName] = useState(() => randomKnightName());
  const [agree, setAgree] = useState(false);
  const [minted, setMinted] = useState<{ challengeId: string; tier: TierId; name: string } | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoErr, setDemoErr] = useState<string | null>(null);
  const buy = usePurchase();
  const payRef = useRef<HTMLDivElement>(null);

  const list = usePoll(() => api.challenges(), 15_000, "ch-list", signedIn);
  const wounded = (list.data ?? []).filter((c) => c.status === "wounded");

  useEffect(() => {
    if (sel && payRef.current) payRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [sel]);

  if (!rules) return <main><div className="panel gate"><p className="mute">{health ? "Loading rules..." : "Connecting to the Garuda API..."}</p></div></main>;
  const tiers = rules.tiers;
  const common = rules.common;
  const chosen = sel && sel !== "demo" ? tiers[sel] : undefined;
  const elig = chosen ? eligibilityFor(chosen.id) : undefined;

  async function startDemo() {
    setDemoBusy(true);
    setDemoErr(null);
    try {
      const c = await api.createDemo(undefined, address ?? undefined);
      nav(`/terminal/${c.id}`);
    } catch (e) {
      setDemoErr(errorText(e));
      setDemoBusy(false);
    }
  }

  async function pay() {
    if (!chosen || !elig) return;
    const knightName = name.trim().slice(0, 24) || undefined;
    try {
      const order = await buy.run(() => api.quoteChallenge(chosen.id, knightName));
      setMinted({ challengeId: order.challengeId ?? "", tier: chosen.id, name: knightName ?? "Sir Unnamed" });
    } catch {
      /* buy.error shows it */
    }
  }

  const step = minted ? 3 : sel && sel !== "demo" ? 2 : 1;
  const connectedOk = connected && signedIn;

  return (
    <main className="pg-challenges" data-testid="challenges">
      <button className="promo" onClick={() => { setTab("challenges"); setSel("ascended"); }}>
        <KnightImg level={4} variant="card" fill alt="" />
        <div className="promo-shade" />
        <div className="promo-copy">
          <h3>Ascended Trial: our biggest account</h3>
          <p>{usd(tiers.ascended.accountSize)} account. {pct(common.profitSplit, 0)} profit split.</p>
        </div>
        <span className="wbtn">View challenge</span>
      </button>
      <div className="tabrow">
        <div className="seg2" role="tablist">
          {(["challenges", "revive"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {tab === "revive" ? (
        <div className="panel" style={{ padding: 24 }}>
          <div className="lbl">Wounded knights</div>
          {wounded.length === 0 ? <p className="mute" style={{ marginTop: 10 }}>{connectedOk ? "None of your knights are wounded." : "Sign in to see knights that can be revived."}</p> : (
            <div className="revive-list">
              {wounded.map((c) => (
                <Link key={c.id} to={`/revive/${c.id}`} className="rl-row">
                  <KnightImg level={lvl(c.tier)} state="wounded" size={44} />
                  <b>{c.knight}</b>
                  <span className="mute">{tiers[c.tier].name} Trial · {usd(c.risk.startingBalance)}</span>
                  <span className="chip">Revive {usd(tiers[c.tier].reviveFee, 2)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="cards">
          <TierCard
            id="demo"
            spec={tiers.demo}
            rules={rules}
            pill={{ kind: "", text: "Open to all" }}
            note="Doesn't mint a knight"
            btn={demoBusy ? "Starting..." : "Start Demo"}
            onPick={connectedOk ? () => void startDemo() : undefined}
            disabled={demoBusy}
            needWallet={!connectedOk}
          />
          {PAID.map((t) => {
              const spec = tiers[t];
              const e = eligibilityFor(t);
              return (
                <TierCard
                  key={t}
                  id={t}
                  spec={spec}
                  rules={rules}
                  pill={e.pill}
                  locked={e.locked}
                  selected={sel === t}
                  note={`Mints a ${LEVELS[lvl(t) - 1]!.name} knight. Funded at ${spec.name} Lv.1`}
                  btn={e.locked ? "Locked" : "Mint & start"}
                  onPick={e.locked ? undefined : () => { setMinted(null); buy.reset(); setSel(t); }}
                />
              );
            })}
        </div>
      )}
      {demoErr && <div className="dn note" style={{ textAlign: "center", marginTop: 12 }}>{demoErr}</div>}

      {tab !== "revive" && (
        <>
          <div className="stepper" ref={payRef} style={{ margin: "44px 0 18px" }}>
            <div className={`s ${step > 1 ? "done" : "on"}`}><b>{step > 1 ? "✓" : "1"}</b>Choose</div>
            <i className="ln" />
            <div className={`s ${step === 2 ? "on" : step > 2 ? "done" : ""}`}><b>{step > 2 ? "✓" : "2"}</b>Pay</div>
            <i className="ln" />
            <div className={`s ${step === 3 ? "on" : ""}`}><b>3</b>Reveal</div>
          </div>
          <div className="row2">
            <PayPanel
              chosen={chosen}
              name={name}
              setName={setName}
              agree={agree}
              setAgree={setAgree}
              onPay={() => void pay()}
              buy={buy}
              done={Boolean(minted)}
              walletName={walletLabel ?? undefined}
              address={address ?? undefined}
              signedIn={connectedOk}
              chain={health?.chain}
            />
            <Reveal tier={minted?.tier ?? chosen?.id} minted={minted} rules={rules} name={name} spec={chosen} />
          </div>
        </>
      )}
    </main>
  );
}

function TierCard({ id, spec, rules, pill, note, btn, locked, selected, onPick, disabled, needWallet }: { id: TierId; spec: TierSpec; rules: Rules; pill: { kind: string; text: string }; note: string; btn: string; locked?: boolean; selected?: boolean; onPick?: () => void; disabled?: boolean; needWallet?: boolean }) {
  const c = rules.common;
  const demo = id === "demo";
  return (
    <div className={`cd ${locked ? "lk" : ""} ${selected ? "sel" : ""} ${demo ? "demo" : "bleed"}`} style={{ ["--t" as string]: TINT[id] }} data-testid={`tier-${id}`}>
      {!demo && <KnightImg level={lvl(id)} variant="card" fill alt="" />}
      <div className="cd-shade" />
      <div className="cd-body">
      <div className="ic">
        {demo ? (
          <div className="demo-ic"><Logo h={30} /></div>
        ) : null}
        {locked && <span className="lkb"><Lock /></span>}
      </div>
      <div className="cn">{demo ? "Demo Account" : `${spec.name} Trial`}</div>
      <div className="cp">
        <b>{demo ? "$0" : usd(spec.fee)}</b>
        <span>{demo ? "Free" : "One-Time"}</span>
      </div>
      <span className={`pill ${pill.kind}`}>
        {pill.kind === "lock" && <Lock />}
        {pill.kind === "ok" && <Check />}
        {pill.text}
      </span>
      <div className="hr" />
      <Row k="Account size" v={`${spec.accountSize.toLocaleString("en-US")} USDC`} />
      <Row k="Profit target" v={pct(c.profitTargetPct, 0)} />
      <Row k="Max drawdown" v={pct(c.maxDrawdownPct, 0)} />
      <Row k="Drawdown type" v="static" />
      <Row k="Daily loss limit" v={pct(c.dailyLossPct, 0)} />
      <Row k={demo ? "Funding upon completion" : "Profit split"} v={demo ? "No" : pct(c.profitSplit, 0)} />
      <Row k="Time limit" v="None" />
      <button className={`cbtn ${locked ? "dis" : ""}`} disabled={locked || disabled || (!onPick && !needWallet)} onClick={onPick} data-testid={`pick-${id}`}>
        {locked && <Lock />} {needWallet && demo ? "Connect to start" : btn}
      </button>
      <div className="cnote">{note}</div>
      </div>
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="rw">
    <span>{k}</span>
    <b>{v}</b>
  </div>
);

function PayPanel({ chosen, name, setName, agree, setAgree, onPay, buy, done, walletName, address, signedIn, chain }: {
  chosen: TierSpec | undefined; name: string; setName: (s: string) => void; agree: boolean; setAgree: (b: boolean) => void; onPay: () => void;
  buy: ReturnType<typeof usePurchase>; done: boolean; walletName?: string; address?: string; signedIn: boolean; chain: unknown;
}) {
  const fee = buy.quote?.amountUsd ?? chosen?.fee ?? 0;
  const net = typeof chain === "object" && chain ? (chain as { cluster: string }).cluster : chain === "stub" ? "stub" : null;
  const can = Boolean(chosen) && agree && signedIn && !buy.busy && !done;
  return (
    <div className="panel co" data-testid="pay-panel">
      <div className="lbl">Step 2</div>
      <h3>Pay with USDC</h3>
      <div className="wl">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <i className="chain" />
          <span className="mono" style={{ fontSize: 13 }}>{address ? shortAddr(address) : "Not connected"}</span>
        </div>
        {address ? <span className="mute" style={{ fontSize: 13 }}>{walletName}</span> : <WalletButton />}
      </div>
      {chosen ? (
        <>
          <label className="nm-field">
            <span className="lbl">Name your knight</span>
            <span className="nm-row">
              <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} disabled={done || buy.busy} data-testid="knight-name" />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setName(randomKnightName())} disabled={done || buy.busy} aria-label="Random name">Roll</button>
            </span>
          </label>
          <div className="line"><span>{chosen.name} Trial · {usd(chosen.accountSize / 1000)}k</span><b>{usd(chosen.fee, 2)}</b></div>
          <div className="line"><span>Network fee</span><b>~$0.01 in SOL</b></div>
          <div className="line tot"><span style={{ alignSelf: "center" }}>Total</span><b>{usd(fee, 2)} <span className="mute" style={{ fontSize: 14, fontWeight: 400 }}>USDC</span></b></div>
          <div className="line"><span>You receive</span><b>1 knight NFT + {usd(chosen.accountSize / 1000)}k sim account</b></div>
        </>
      ) : (
        <p className="mute" style={{ margin: "6px 0 18px" }}>Pick a trial above. Fees are paid in USDC; the knight is minted to your wallet once the payment confirms.</p>
      )}
      <label className="cb">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} data-testid="agree" />
        <u />
        <span>I accept the Terms and understand this is a simulated account.</span>
      </label>
      <button className="btn btn-fire" style={{ width: "100%" }} disabled={!can} onClick={onPay} data-testid="pay-btn">
        {buy.busy ? STEP_TEXT[buy.step] : done ? "Paid" : chosen ? `Pay ${usd(fee, fee % 1 ? 2 : 0)} USDC` : "Choose a trial"}
      </button>
      {net && <div className="dim note mono" style={{ marginTop: 10 }}>{net === "stub" ? "Stub server: the payment is simulated, no wallet transfer happens." : `Solana ${net}: test USDC only. Real-money checkout is not open.`}</div>}
      {!signedIn && <div className="mute note" style={{ marginTop: 10 }}>Sign in (email or wallet) to pay.</div>}
      {buy.error && <div className="dn note" style={{ marginTop: 10 }} role="alert" data-testid="pay-error">{buy.error}</div>}
    </div>
  );
}

function Reveal({ tier, minted, rules, name, spec }: { tier: TierId | undefined; minted: { challengeId: string; tier: TierId; name: string } | null; rules: Rules; name: string; spec: TierSpec | undefined }) {
  const level = (tier && tier !== "demo" ? lvl(tier) : 1) as KnightLevel;
  const t = tier && tier !== "demo" ? rules.tiers[tier] : undefined;
  const [copied, setCopied] = useState(false);
  const shown = minted ? minted.name : name;
  async function share() {
    try {
      await navigator.clipboard.writeText(`${shown} just woke up on Garuda: ${t?.name ?? ""} Trial knight.`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  }
  return (
    <div className="panel rv dots" data-testid="reveal">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div className="lbl">Step 3</div>
          <h2 className="pt" style={{ marginTop: 6 }}>{minted ? "Your knight awakens." : "Your knight awaits."}</h2>
        </div>
        <span className="slot-tag" style={{ position: "static" }}>{minted ? "REVEAL" : "PREVIEW"}</span>
      </div>
      <div className="rv-grid">
        <div className="portal">
          <KnightImg level={level} state={minted ? "victory" : "dormant"} fill alt="" />
          <div className="portal-shade" />
          <Spark size={28} style={{ position: "absolute", left: 16, top: 16, zIndex: 2 }} />
          <Spark size={18} color="#ffc24a" style={{ position: "absolute", right: 18, top: 28, zIndex: 2 }} />
        </div>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div>
              <div className="mono dim" style={{ fontSize: 11 }}>{minted?.challengeId ? `#${minted.challengeId.slice(-6)}` : "UNMINTED"}</div>
              <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-.04em" }} data-testid="reveal-name">{shown || "Sir Unnamed"}</div>
            </div>
            <span className="st active">{LEVELS[level - 1]!.name}</span>
          </div>
          <div className="traits">
            <div className="trait rare"><span>Tier</span><b>{LEVELS[level - 1]!.name}</b></div>
            <div className="trait"><span>Account</span><b>{(minted ? t : spec) ? usd((t ?? spec)!.accountSize) : "-"}</b></div>
            <div className="trait"><span>Rules</span><b>{pct(rules.common.profitTargetPct, 0)} / {pct(rules.common.dailyLossPct, 0)} / {pct(rules.common.maxDrawdownPct, 0)}</b></div>
            <div className="trait"><span>Status</span><b>{minted ? "Active" : "Waiting for payment"}</b></div>
          </div>
          <div className="rb">
            <button className="btn btn-ghost btn-sm" onClick={() => void share()} disabled={!minted}>{copied ? "Copied" : "Share"}</button>
            {minted && minted.challengeId ? (
              <Link className="btn btn-fire btn-sm" style={{ flex: 1 }} to={`/terminal/${minted.challengeId}`} data-testid="enter-battle">Enter battle</Link>
            ) : (
              <span className="btn btn-fire btn-sm" style={{ flex: 1, opacity: 0.4 }}>Enter battle</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

