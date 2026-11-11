import { describe, expect, it } from "vitest";
import { MediaProxy, TweetLookup, buildApp, snowflakeMs, type FetchLike } from "../src/index.js";
import { makeRig } from "./helpers.js";

const ok = (body: unknown, type = "application/json"): Awaited<ReturnType<FetchLike>> => ({
  ok: true,
  status: 200,
  json: async () => body,
  arrayBuffer: async () => new TextEncoder().encode("img").buffer as ArrayBuffer,
  headers: { get: (k: string) => (k === "content-type" ? type : null) },
});

describe("GET /social/tweets/:id", () => {
  it("derives the post time from the snowflake id", () => {
    expect(new Date(snowflakeMs("1585841080431321088")).toISOString()).toBe("2022-10-28T03:49:11.734Z");
  });

  it("returns text, author and an inlined avatar from the embed endpoint", async () => {
    const calls: string[] = [];
    const f: FetchLike = async (url) => {
      calls.push(url);
      if (url.includes("syndication")) {
        return ok({ text: "BTC bottom is in https://t.co/x &amp; we go", display_text_range: [0, 44], entities: { urls: [{ url: "https://t.co/x", display_url: "x.com/a" }] }, user: { name: "Caller", screen_name: "caller", profile_image_url_https: "https://pbs.twimg.com/a_normal.jpg", is_blue_verified: true } });
      }
      return ok(null, "image/jpeg");
    };
    const app = buildApp({ service: makeRig().svc, rateLimits: false, tweets: new TweetLookup(f) });
    const r = await app.inject({ method: "GET", url: "/social/tweets/1585841080431321088" });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ source: "syndication", handle: "caller", name: "Caller", verified: true, text: "BTC bottom is in x.com/a & we go" });
    expect(b.avatar).toMatch(/^data:image\/jpeg;base64,/);
    expect(calls[1]).toBe("https://pbs.twimg.com/a_bigger.jpg");
  });

  it("falls back to the id-derived time when X does not answer", async () => {
    const f: FetchLike = async () => ({ ...ok(null), ok: false, status: 404 });
    const app = buildApp({ service: makeRig().svc, rateLimits: false, tweets: new TweetLookup(f) });
    const b = (await app.inject({ method: "GET", url: "/social/tweets/1585841080431321088" })).json();
    expect(b).toEqual({ id: "1585841080431321088", postedAt: 1666928951734, source: "id" });
  });

  it("rejects non-numeric ids", async () => {
    const app = buildApp({ service: makeRig().svc, rateLimits: false, tweets: new TweetLookup(async () => ok({})) });
    expect((await app.inject({ method: "GET", url: "/social/tweets/abc" })).statusCode).toBe(400);
  });

  it("returns post photos (and video thumbnails) from the embed endpoint", async () => {
    const f: FetchLike = async (url) =>
      url.includes("syndication")
        ? ok({ text: "chart https://t.co/m", entities: { media: [{ url: "https://t.co/m" }] }, user: { screen_name: "c" }, mediaDetails: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/HWCNB_dXsAA9WZW.jpg", original_info: { width: 1200, height: 675 } }, { type: "video", media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg" }, { type: "photo", media_url_https: "https://evil.example/x.jpg" }] })
        : ok(null, "image/jpeg");
    const b = (await buildApp({ service: makeRig().svc, rateLimits: false, tweets: new TweetLookup(f) }).inject({ method: "GET", url: "/social/tweets/1585841080431321088" })).json();
    expect(b.text).toBe("chart");
    expect(b.media).toEqual([
      { url: "https://pbs.twimg.com/media/HWCNB_dXsAA9WZW.jpg", type: "photo", width: 1200, height: 675 },
      { url: "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg", type: "video" },
    ]);
  });

  it("falls back to FxTwitter, then VxTwitter, when the embed endpoint has nothing", async () => {
    const seen: string[] = [];
    const fx: FetchLike = async (url) => {
      seen.push(new URL(url).host);
      if (url.includes("syndication")) return { ...ok(null), ok: false, status: 429 };
      if (url.includes("fxtwitter")) return ok({ code: 200, tweet: { text: "SOL bottom https://t.co/z", author: { name: "F", screen_name: "f", avatar_url: "https://pbs.twimg.com/profile_images/1/a_200x200.jpg" }, media: { all: [{ type: "photo", url: "https://pbs.twimg.com/media/ABC.jpg?name=orig", width: 10, height: 5 }] } } });
      return ok(null, "image/jpeg");
    };
    const a = (await buildApp({ service: makeRig().svc, rateLimits: false, tweets: new TweetLookup(fx) }).inject({ method: "GET", url: "/social/tweets/1585841080431321088" })).json();
    expect(a).toMatchObject({ source: "fxtwitter", text: "SOL bottom", handle: "f", media: [{ url: "https://pbs.twimg.com/media/ABC.jpg", type: "photo" }] });
    expect(seen).toContain("pbs.twimg.com");

    const vx: FetchLike = async (url) => {
      if (url.includes("syndication") || url.includes("fxtwitter")) throw new Error("ECONNRESET");
      if (url.includes("vxtwitter")) return ok({ text: "HYPE", user_name: "V", user_screen_name: "v", media_extended: [{ type: "image", url: "https://pbs.twimg.com/media/V.png", size: { width: 4, height: 3 } }, { type: "video", thumbnail_url: "https://pbs.twimg.com/amplify_video_thumb/9/img/t.jpg" }] });
      return { ...ok(null), ok: false, status: 404 };
    };
    const v = (await buildApp({ service: makeRig().svc, rateLimits: false, tweets: new TweetLookup(vx) }).inject({ method: "GET", url: "/social/tweets/1585841080431321088" })).json();
    expect(v).toMatchObject({ source: "vxtwitter", text: "HYPE", handle: "v" });
    expect(v.media.map((m: { type: string }) => m.type)).toEqual(["photo", "video"]);
  });
});

describe("GET /social/media", () => {
  const img = (type = "image/jpeg"): Awaited<ReturnType<FetchLike>> => ({ ...ok(null, type), arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 1, 2]).buffer as ArrayBuffer });

  it("proxies pbs.twimg.com photos at the medium size with open CORS", async () => {
    const calls: string[] = [];
    const app = buildApp({ service: makeRig().svc, rateLimits: false, media: new MediaProxy(async (u) => (calls.push(u), img())) });
    const r = await app.inject({ method: "GET", url: `/social/media?u=${encodeURIComponent("https://pbs.twimg.com/media/HWCNB_dXsAA9WZW.jpg")}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/jpeg");
    expect(r.headers["access-control-allow-origin"]).toBe("*");
    expect(r.rawPayload.length).toBe(5);
    expect(calls).toEqual(["https://pbs.twimg.com/media/HWCNB_dXsAA9WZW?format=jpg&name=medium"]);
    await app.inject({ method: "GET", url: `/social/media?u=${encodeURIComponent("https://pbs.twimg.com/media/HWCNB_dXsAA9WZW.jpg")}` });
    expect(calls.length).toBe(1); // cached
  });

  it("only fetches X's image CDN and only returns images", async () => {
    const calls: string[] = [];
    const app = buildApp({ service: makeRig().svc, rateLimits: false, media: new MediaProxy(async (u) => (calls.push(u), img("text/html"))) });
    for (const u of ["https://evil.example/media/a.jpg", "http://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com.evil.example/media/a.jpg", "https://pbs.twimg.com/profile_images/1/a.jpg", "file:///etc/passwd"]) {
      expect((await app.inject({ method: "GET", url: `/social/media?u=${encodeURIComponent(u)}` })).statusCode).toBe(404);
    }
    expect(calls).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/social/media?u=${encodeURIComponent("https://pbs.twimg.com/media/a.jpg")}` })).statusCode).toBe(404);
  });
});
