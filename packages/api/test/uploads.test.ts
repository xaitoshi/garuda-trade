import { describe, expect, it } from "vitest";
import { createTestDb } from "@garuda/db";
import { InMemoryUploadStore, PgUploadStore, UPLOAD_MAX_BYTES, buildApp, sniffImage, type UploadStore } from "../src/index.js";
import { makeRig } from "./helpers.js";

// 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x1a, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(14)]);

const setup = (store: UploadStore = new InMemoryUploadStore()) => {
  const app = buildApp({ service: makeRig().svc, rateLimits: false, uploads: store });
  const up = (data: string) => app.inject({ method: "POST", url: "/social/uploads", payload: { data } });
  return { app, up };
};

describe("/calledit uploads", () => {
  it("sniffs png, jpg, gif and webp and refuses everything else", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(JPG)).toBe("image/jpeg");
    expect(sniffImage(GIF)).toBe("image/gif");
    expect(sniffImage(WEBP)).toBe("image/webp");
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
    expect(sniffImage(Buffer.from("%PDF-1.4"))).toBeUndefined();
  });

  it("stores an image, serves it back with its real type, and dedupes identical files", async () => {
    const { app, up } = setup();
    const r = await up(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(r.statusCode).toBe(201);
    const b = r.json();
    expect(b).toMatchObject({ mime: "image/png", size: PNG.length });
    expect(b.url).toBe(`/social/uploads/${b.id}`);
    const g = await app.inject({ method: "GET", url: b.url });
    expect(g.statusCode).toBe(200);
    expect(g.headers["content-type"]).toBe("image/png");
    expect(g.headers["x-content-type-options"]).toBe("nosniff");
    expect(g.headers["access-control-allow-origin"]).toBe("*");
    expect(Buffer.compare(g.rawPayload, PNG)).toBe(0);
    expect((await up(PNG.toString("base64"))).json().id).toBe(b.id);
    expect((await up(`data:image/jpeg;base64,${JPG.toString("base64")}`)).json().mime).toBe("image/jpeg");
  });

  it("validates type server side: a renamed SVG or HTML file is refused even when it claims to be a PNG", async () => {
    const { up } = setup();
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>").toString("base64");
    const r = await up(`data:image/png;base64,${svg}`);
    expect(r.statusCode).toBe(415);
    expect(r.json().error).toBe("unsupported_image");
    expect((await up(`data:image/gif;base64,${PNG.toString("base64")}`)).statusCode).toBe(415);
    expect((await up("not base64 !!")).statusCode).toBe(400);
    expect((await up("")).statusCode).toBe(400);
  });

  it("caps uploads at 5 MB", async () => {
    const { up } = setup();
    const big = Buffer.concat([PNG, Buffer.alloc(UPLOAD_MAX_BYTES)]);
    const r = await up(`data:image/png;base64,${big.toString("base64")}`);
    expect([413]).toContain(r.statusCode);
  });

  it("404s unknown ids", async () => {
    const { app } = setup();
    expect((await app.inject({ method: "GET", url: "/social/uploads/AAAAAAAAAAAAAAAAAAAA" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/social/uploads/..%2f..%2fetc" })).statusCode).toBe(404);
  });

  it("PgUploadStore keeps the bytes in Postgres", async () => {
    const t = await createTestDb();
    try {
      const { app, up } = setup(new PgUploadStore(t.db));
      const b = (await up(`data:image/png;base64,${PNG.toString("base64")}`)).json();
      const g = await app.inject({ method: "GET", url: b.url });
      expect(g.headers["content-type"]).toBe("image/png");
      expect(Buffer.compare(g.rawPayload, PNG)).toBe(0);
      expect((await up(PNG.toString("base64"))).json().id).toBe(b.id);
    } finally {
      await t.close();
    }
  });
});
