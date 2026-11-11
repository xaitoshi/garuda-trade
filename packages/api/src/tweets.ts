/**
 * Public tweet lookup for the /calledit page. Reads X's public embed endpoint (cdn.syndication.twimg.com, the one the
 * official embed widget uses), so no X API key is needed. That endpoint only answers CORS for platform.twitter.com,
 * hence this proxy. The avatar is inlined as a data URL so the browser can draw it into a downloadable PNG card.
 */
export interface TweetCard {
  id: string;
  /** Post time in ms, derived from the snowflake id (exact to the millisecond). */
  postedAt: number;
  text?: string;
  name?: string;
  handle?: string;
  avatar?: string;
  verified?: boolean;
  /** "syndication" when X returned the post, "id" when only the id-derived time is known. */
  source: "syndication" | "id";
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer>; headers: { get(k: string): string | null } }>;

const TWITTER_EPOCH = 1288834974657n;
export const snowflakeMs = (id: string): number => Number((BigInt(id) >> 22n) + TWITTER_EPOCH);

/** Token the embed widget sends; the endpoint rejects requests without a plausible one. */
export const syndicationToken = (id: string): string => ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");

const TTL_MS = 10 * 60_000;
const MAX_CACHE = 500;

export class TweetLookup {
  private cache = new Map<string, { at: number; p: Promise<TweetCard> }>();
  constructor(
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = Date.now,
  ) {}

  get(id: string): Promise<TweetCard> {
    const t = this.now();
    const hit = this.cache.get(id);
    if (hit && t - hit.at < TTL_MS) return hit.p;
    if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    const p = this.load(id);
    this.cache.set(id, { at: t, p });
    return p;
  }

  private async load(id: string): Promise<TweetCard> {
    const base: TweetCard = { id, postedAt: snowflakeMs(id), source: "id" };
    try {
      const r = await this.fetchImpl(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${syndicationToken(id)}`, {
        signal: AbortSignal.timeout(6000),
        headers: { "user-agent": "Mozilla/5.0 (Garuda calledit)" },
      });
      if (!r.ok) return base;
      const j = (await r.json()) as {
        __typename?: string;
        text?: string;
        display_text_range?: [number, number];
        entities?: { urls?: { url: string; expanded_url?: string; display_url?: string }[]; media?: { url: string }[] };
        user?: { name?: string; screen_name?: string; profile_image_url_https?: string; is_blue_verified?: boolean; verified?: boolean };
        tweet?: unknown;
      };
      if (!j || typeof j.text !== "string") return base;
      let text = j.text;
      if (j.display_text_range) text = Array.from(text).slice(j.display_text_range[0], j.display_text_range[1]).join("");
      for (const u of j.entities?.urls ?? []) text = text.split(u.url).join(u.display_url ?? u.expanded_url ?? u.url);
      for (const m of j.entities?.media ?? []) text = text.split(m.url).join("");
      text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
      const avatarUrl = j.user?.profile_image_url_https?.replace("_normal.", "_bigger.");
      return {
        ...base,
        source: "syndication",
        text,
        name: j.user?.name,
        handle: j.user?.screen_name,
        verified: Boolean(j.user?.is_blue_verified || j.user?.verified),
        avatar: avatarUrl ? await this.inline(avatarUrl) : undefined,
      };
    } catch {
      return base;
    }
  }

  private async inline(url: string): Promise<string | undefined> {
    if (!/^https:\/\/pbs\.twimg\.com\//.test(url)) return undefined;
    try {
      const r = await this.fetchImpl(url, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return undefined;
      const type = r.headers.get("content-type") ?? "image/jpeg";
      if (!type.startsWith("image/")) return undefined;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 200_000) return undefined;
      return `data:${type};base64,${buf.toString("base64")}`;
    } catch {
      return undefined;
    }
  }
}
