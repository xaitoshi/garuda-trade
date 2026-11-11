import { useEffect, useState } from "react";
import type { ChallengeState, LevelUpRecord } from "../lib/types";
import { levelOfTier, tierLevelLabel } from "../lib/knight";
import { usd } from "../lib/format";
import { KnightImg, Spark } from "./Art";

const seenKey = (id: string) => `garuda.levelup.seen.${id}`;
/** Only celebrate level ups that are recent; an old history entry seen on a new device stays quiet. */
const FRESH_MS = 3 * 24 * 3_600_000;

/** Which level up to celebrate: the newest one this browser has not shown yet. */
export function pendingCelebration(c: Pick<ChallengeState, "id" | "scaling">, seen: number, now = Date.now()): LevelUpRecord | undefined {
  const h = c.scaling?.history ?? [];
  const last = h[h.length - 1];
  if (!last || h.length <= seen || now - last.ts > FRESH_MS) return undefined;
  return last;
}

/** Level up and graduation celebration on the funded terminal. */
export function LevelUpCelebration({ c }: { c: ChallengeState }) {
  const [rec, setRec] = useState<LevelUpRecord | undefined>();
  const count = c.scaling?.history.length ?? 0;
  useEffect(() => {
    let seen = 0;
    try {
      seen = Number(localStorage.getItem(seenKey(c.id)) ?? 0) || 0;
    } catch {
      /* storage blocked: still celebrate once per load */
    }
    setRec(pendingCelebration(c, seen));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id, count]);
  if (!rec) return null;
  const close = () => {
    try {
      localStorage.setItem(seenKey(c.id), String(count));
    } catch {
      /* ignore */
    }
    setRec(undefined);
  };
  const graduated = rec.toTier !== rec.fromTier;
  return (
    <div className="lvl-up" role="dialog" aria-label={graduated ? "Graduation" : "Level up"} data-testid="level-up" onClick={close}>
      <div className="panel lvl-card dots" onClick={(e) => e.stopPropagation()}>
        <Spark color="#ffc24a" size={22} style={{ position: "absolute", left: 30, top: 26 }} />
        <Spark color="#8fd3ff" size={16} style={{ position: "absolute", right: 36, top: 44 }} />
        <div className="eyebrow">{graduated ? "Graduation" : "Level up"}</div>
        <h2 className="pt">{graduated ? `Welcome to ${tierLevelLabel(rec.toTier, rec.toLevel)}.` : `${tierLevelLabel(rec.toTier, rec.toLevel)}.`}</h2>
        <div className="lvl-art">
          <KnightImg level={levelOfTier(rec.toTier)} state="victory" size={150} alt="" />
        </div>
        <p className="mute">
          {tierLevelLabel(rec.fromTier, rec.fromLevel)} {usd(rec.fromSize, 2)} › {tierLevelLabel(rec.toTier, rec.toLevel)} {usd(rec.toSize, 2)}. Your drawdown floor and daily limit now follow the new size.
          {graduated ? " Your knight NFT took the new tier and art." : ""}
        </p>
        <button className="btn btn-fire" onClick={close} data-testid="level-up-ok">
          Keep trading
        </button>
      </div>
    </div>
  );
}
