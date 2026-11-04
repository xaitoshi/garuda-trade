import { artState, knightView, uiStatus, type UiStatus } from "./knight";
import type { ChallengeState } from "./types";

export interface KnightCard {
  key: string;
  /** The challenge shown for this knight: the live one if there is one, else the latest. */
  c: ChallengeState;
  status: UiStatus;
  battles: number;
  bosses: number;
  bestReturn: number | undefined;
  idLabel: string;
}

const live = (c: ChallengeState) => c.status === "active" && c.lifecycle === "active";

/** One card per knight (demo accounts carry no knight, so each is its own card). Newest activity first. */
export function groupKnights(list: ChallengeState[]): KnightCard[] {
  const groups = new Map<string, ChallengeState[]>();
  for (const c of list) {
    const key = c.knightId ?? `acct:${c.id}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const cards: KnightCard[] = [];
  for (const [key, cs] of groups) {
    const sorted = [...cs].sort((a, b) => b.createdAt - a.createdAt);
    const show = sorted.find(live) ?? sorted.find((c) => c.status === "wounded") ?? sorted[0]!;
    const rets = cs.map((c) => c.risk.profitLoss / c.risk.startingBalance);
    cards.push({
      key,
      c: show,
      status: uiStatus(show),
      battles: cs.length,
      bosses: cs.filter((c) => c.status === "passed" && c.stage === "evaluation").length,
      bestReturn: rets.length ? Math.max(...rets) : undefined,
      idLabel: show.knightId ? `#${show.knightId.slice(-4).toUpperCase()}` : "DEMO",
    });
  }
  return cards.sort((a, b) => b.c.lastActivityAt - a.c.lastActivityAt);
}

export const FILTERS = ["all", "active", "wounded", "ascended", "funded"] as const;
export type Filter = (typeof FILTERS)[number];

export const matches = (k: KnightCard, f: Filter): boolean => f === "all" || k.status === f || (f === "active" && k.status === "dormant");

export function summary(cards: KnightCard[]) {
  return {
    knights: cards.length,
    active: cards.filter((k) => k.status === "active").length,
    wounded: cards.filter((k) => k.status === "wounded").length,
    funded: cards.filter((k) => k.status === "funded" || k.status === "ascended").length,
  };
}

export { artState, knightView };
