import type { TierId } from "./types";

/**
 * Tier eligibility on the buy page. Every tier is open to buy (rulebook section 16): there is no knight-level gate,
 * and every paid challenge mints a knight of the purchased tier. Kept as a function so the cards read one place.
 */
export interface Eligibility {
  locked: boolean;
  /** Pill text and style on the tier card. */
  pill: { kind: "" | "ok" | "lock"; text: string };
  reason?: string;
}

export function eligibilityFor(_tier: TierId): Eligibility {
  return { locked: false, pill: { kind: "", text: "Open to all" } };
}
