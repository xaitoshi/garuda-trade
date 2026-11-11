import { describe, expect, it } from "vitest";
import { TweetLookup, buildApp, snowflakeMs, type FetchLike } from "../src/index.js";
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
});
