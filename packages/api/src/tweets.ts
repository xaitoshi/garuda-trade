/**
 * Public tweet lookup for the /calledit page. Reads X's public embed endpoint (cdn.syndication.twimg.com, the one the
 * official embed widget uses), so no X API key is needed. That endpoint only answers CORS for platform.twitter.com,
 * hence this proxy. When it has nothing (rate limits, region blocks, odd post types) the lookup falls back to the public
 * FxTwitter and VxTwitter JSON APIs. The avatar is inlined as a data URL so the browser can draw it into a downloadable
 * PNG card. Post photos (and video thumbnails) are returned as pbs.twimg.com URLs and served to the browser through
 * GET /social/media (MediaProxy), so the image loads same-site with CORS and can be drawn onto the card canvas.
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
  /** Photos in the post (video and GIF posts give their thumbnail). Original pbs.twimg.com URLs, max 4. */
  media?: TweetMedia[];
  /** Where the post came from: X's embed endpoint, a public fallback, or "id" when only the id-derived time is known. */
  source: "syndication" | "fxtwitter" | "vxtwitter" | "id";
}

export interface TweetMedia {
  url: string;
  type: "photo" | "video" | "gif";
  width?: number;
  height?: number;
  alt?: string;
}

/** Only X's image CDN is fetched or proxied. */
export const isTwitterImage = (u: string): boolean => /^https:\/\/pbs\.twimg\.com\/(media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb|card_img)\/[A-Za-z0-9_\-./]+(\?[A-Za-z0-9=&_.-]*)?$/.test(u);

const cleanMedia = (list: (TweetMedia | undefined)[]): TweetMedia[] | undefined => {
  const out = list.filter((m): m is TweetMedia => Boolean(m && isTwitterImage(m.url))).slice(0, 4);
  return out.length ? out : undefined;
};

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
    for (const src of [() => this.syndication(id), () => this.fx(id), () => this.vx(id)]) {
      let got: (Partial<TweetCard> & { avatarUrl?: string }) | undefined;
      try {
        got = await src();
      } catch {
        got = undefined;
      }
      if (!got || typeof got.text !== "string") continue;
      const { avatarUrl, ...rest } = got;
      return { ...base, ...rest, avatar: avatarUrl ? await this.inline(avatarUrl) : undefined };
    }
    return base;
  }

  private async json(url: string): Promise<unknown> {
    const r = await this.fetchImpl(url, { signal: AbortSignal.timeout(6000), headers: { "user-agent": "Mozilla/5.0 (Garuda calledit)" } });
    return r.ok ? r.json() : undefined;
  }

  private async syndication(id: string) {
    const j = (await this.json(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${syndicationToken(id)}`)) as {
      text?: string;
      display_text_range?: [number, number];
      entities?: { urls?: { url: string; expanded_url?: string; display_url?: string }[]; media?: { url: string }[] };
      user?: { name?: string; screen_name?: string; profile_image_url_https?: string; is_blue_verified?: boolean; verified?: boolean };
      mediaDetails?: { type?: string; media_url_https?: string; ext_alt_text?: string; original_info?: { width?: number; height?: number } }[];
      photos?: { url?: string; width?: number; height?: number }[];
      video?: { poster?: string };
    } | undefined;
    if (!j || typeof j.text !== "string") return undefined;
    let text = j.text;
    if (j.display_text_range) text = Array.from(text).slice(j.display_text_range[0], j.display_text_range[1]).join("");
    for (const u of j.entities?.urls ?? []) text = text.split(u.url).join(u.display_url ?? u.expanded_url ?? u.url);
    for (const m of j.entities?.media ?? []) text = text.split(m.url).join("");
    text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
    const fromDetails = (j.mediaDetails ?? []).map((m): TweetMedia | undefined =>
      m.media_url_https ? { url: m.media_url_https, type: m.type === "video" ? "video" : m.type === "animated_gif" ? "gif" : "photo", width: m.original_info?.width, height: m.original_info?.height, alt: m.ext_alt_text || undefined } : undefined,
    );
    const fromPhotos = (j.photos ?? []).map((p): TweetMedia | undefined => (p.url ? { url: p.url, type: "photo", width: p.width, height: p.height } : undefined));
    return {
      source: "syndication" as const,
      text,
      name: j.user?.name,
      handle: j.user?.screen_name,
      verified: Boolean(j.user?.is_blue_verified || j.user?.verified),
      media: cleanMedia(fromDetails.length ? fromDetails : fromPhotos.length ? fromPhotos : [j.video?.poster ? { url: j.video.poster, type: "video" } : undefined]),
      avatarUrl: j.user?.profile_image_url_https?.replace("_normal.", "_bigger."),
    };
  }

  private async fx(id: string) {
    const j = (await this.json(`https://api.fxtwitter.com/status/${id}`)) as {
      tweet?: {
        text?: string;
        author?: { name?: string; screen_name?: string; avatar_url?: string };
        media?: { all?: { type?: string; url?: string; thumbnail_url?: string; width?: number; height?: number; altText?: string }[] };
      };
    } | undefined;
    const t = j?.tweet;
    if (!t || typeof t.text !== "string") return undefined;
    return {
      source: "fxtwitter" as const,
      text: t.text.replace(/\s*https:\/\/t\.co\/\w+$/, "").trim(),
      name: t.author?.name,
      handle: t.author?.screen_name,
      media: cleanMedia((t.media?.all ?? []).map((m): TweetMedia | undefined => {
        const url = m.type === "photo" ? m.url?.replace(/\?name=orig$/, "") : m.thumbnail_url;
        return url ? { url, type: m.type === "video" ? "video" : m.type === "gif" ? "gif" : "photo", width: m.width, height: m.height, alt: m.altText || undefined } : undefined;
      })),
      avatarUrl: t.author?.avatar_url?.replace("_200x200.", "_bigger."),
    };
  }

  private async vx(id: string) {
    const j = (await this.json(`https://api.vxtwitter.com/Twitter/status/${id}`)) as {
      text?: string;
      user_name?: string;
      user_screen_name?: string;
      user_profile_image_url?: string;
      media_extended?: { type?: string; url?: string; thumbnail_url?: string; size?: { width?: number; height?: number }; altText?: string }[];
    } | undefined;
    if (!j || typeof j.text !== "string") return undefined;
    return {
      source: "vxtwitter" as const,
      text: j.text.replace(/\s*https:\/\/t\.co\/\w+$/, "").trim(),
      name: j.user_name,
      handle: j.user_screen_name,
      media: cleanMedia((j.media_extended ?? []).map((m): TweetMedia | undefined => {
        const url = m.type === "image" ? m.url : m.thumbnail_url;
        return url ? { url, type: m.type === "video" ? "video" : m.type === "gif" ? "gif" : "photo", width: m.size?.width, height: m.size?.height, alt: m.altText || undefined } : undefined;
      })),
      avatarUrl: j.user_profile_image_url?.replace("_normal.", "_bigger."),
    };
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

const MEDIA_MAX_BYTES = 6_000_000;

/**
 * Serves post photos to the browser from the Garuda API (GET /social/media?u=...). Same answer on every network: no
 * hotlink, referrer or tracker-blocker surprises on pbs.twimg.com, and the response carries CORS so the /calledit card
 * can draw it onto a canvas without tainting it. Only pbs.twimg.com image paths are fetched; a small LRU keeps hot ones.
 */
export class MediaProxy {
  private cache = new Map<string, { at: number; type: string; body: Buffer }>();
  constructor(
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 64,
  ) {}

  /** Normalise to the "medium" rendition (about 1200px, a few hundred KB): plenty for the page and the card. */
  static sized(u: string): string {
    const url = new URL(u);
    if (url.pathname.startsWith("/media/")) {
      const m = url.pathname.match(/^(\/media\/[A-Za-z0-9_-]+)\.(jpg|jpeg|png|webp)$/);
      const fmt = m ? (m[2] === "jpeg" ? "jpg" : m[2]) : url.searchParams.get("format") ?? "jpg";
      return `https://pbs.twimg.com${m ? m[1] : url.pathname}?format=${fmt}&name=medium`;
    }
    return `https://pbs.twimg.com${url.pathname}`;
  }

  async get(u: string): Promise<{ type: string; body: Buffer } | undefined> {
    if (!isTwitterImage(u)) return undefined;
    const key = MediaProxy.sized(u);
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < 6 * 3600_000) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    for (const url of key === u ? [key] : [key, u]) {
      try {
        const r = await this.fetchImpl(url, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) continue;
        const type = (r.headers.get("content-type") ?? "").split(";")[0]!.trim();
        if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) continue;
        const body = Buffer.from(await r.arrayBuffer());
        if (!body.length || body.length > MEDIA_MAX_BYTES) continue;
        if (this.cache.size >= this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
        const v = { at: this.now(), type, body };
        this.cache.set(key, v);
        return v;
      } catch {
        /* try the next rendition */
      }
    }
    return undefined;
  }
}
