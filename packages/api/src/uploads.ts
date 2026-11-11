/**
 * Image uploads for /calledit: a fallback when a post's photo does not load (or any time someone wants their own
 * screenshot on the card). Stored in Postgres (calledit_uploads, base64 text) next to everything else; in memory without
 * DATABASE_URL. The type is decided by the file's magic bytes, never by what the client claims, and capped at 5 MB.
 * Identical files dedupe by sha256 so re-uploads return the same id.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Db } from "@garuda/db";
import { RateLimiter, type Limit } from "./rate-limit.js";
import { ServiceError } from "./service.js";

export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export type UploadMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface Upload {
  id: string;
  mime: UploadMime;
  bytes: Buffer;
  sha256: string;
  ipHash?: string;
  createdAt: number;
}

export interface UploadStore {
  put(u: Upload): Promise<Upload>;
  get(id: string): Promise<Upload | undefined>;
}

/** Sniff the real type from the first bytes. Anything else (SVG, HTML, PDF...) is refused. */
export function sniffImage(b: Uint8Array): UploadMime | undefined {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (b.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return "image/gif";
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return undefined;
}

export class InMemoryUploadStore implements UploadStore {
  private rows = new Map<string, Upload>();
  async put(u: Upload) {
    for (const r of this.rows.values()) if (r.sha256 === u.sha256) return r;
    this.rows.set(u.id, u);
    return u;
  }
  async get(id: string) {
    return this.rows.get(id);
  }
}

export class PgUploadStore implements UploadStore {
  constructor(private readonly db: Db) {}
  async put(u: Upload) {
    const prev = (await this.db.query<{ id: string }>("SELECT id FROM calledit_uploads WHERE sha256 = $1", [u.sha256])).rows[0];
    if (prev) return (await this.get(prev.id))!;
    try {
      await this.db.query("INSERT INTO calledit_uploads (id, mime, data_b64, size, sha256, ip_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)", [u.id, u.mime, u.bytes.toString("base64"), u.bytes.length, u.sha256, u.ipHash ?? null, u.createdAt]);
      return u;
    } catch (e) {
      const again = (await this.db.query<{ id: string }>("SELECT id FROM calledit_uploads WHERE sha256 = $1", [u.sha256])).rows[0];
      if (again) return (await this.get(again.id))!;
      throw e;
    }
  }
  async get(id: string) {
    const r = (await this.db.query<{ id: string; mime: string; data_b64: string; sha256: string; ip_hash: string | null; created_at: string | number }>("SELECT id, mime, data_b64, sha256, ip_hash, created_at FROM calledit_uploads WHERE id = $1", [id])).rows[0];
    if (!r) return undefined;
    return { id: r.id, mime: r.mime as UploadMime, bytes: Buffer.from(r.data_b64, "base64"), sha256: r.sha256, ipHash: r.ip_hash ?? undefined, createdAt: Number(r.created_at) };
  }
}

const ID = /^[A-Za-z0-9_-]{16,32}$/;

/**
 * POST /social/uploads  {data: "data:image/png;base64,..." or plain base64}  ->  {id, url, mime, size}
 * GET  /social/uploads/:id  ->  the image bytes (immutable, CORS open so the card canvas can draw it)
 */
export function registerUploadRoutes(app: FastifyInstance, store: UploadStore, o: { now?: () => number; limit?: Limit | false } = {}) {
  const now = o.now ?? Date.now;
  const limiter = o.limit === false ? undefined : new RateLimiter(o.limit ?? { limit: 20, windowMs: 60 * 60_000 }, now);

  app.post<{ Body: { data?: unknown } }>("/social/uploads", { bodyLimit: Math.ceil(UPLOAD_MAX_BYTES * 1.4) + 4096 }, async (req, reply) => {
    if (limiter) {
      const d = limiter.check(`upload:${req.ip}`);
      if (!d.allowed) {
        reply.header("Retry-After", Math.max(1, Math.ceil(d.resetMs / 1000)));
        throw new ServiceError(429, "rate_limited", "Too many uploads. Try again later.");
      }
    }
    const raw = req.body?.data;
    if (typeof raw !== "string" || !raw) throw new ServiceError(400, "invalid_upload", "Send the image as base64 in `data`");
    const m = raw.match(/^data:([a-z/+.-]+);base64,(.*)$/s);
    const b64 = (m ? m[2]! : raw).replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new ServiceError(400, "invalid_upload", "That is not valid base64");
    const bytes = Buffer.from(b64, "base64");
    if (!bytes.length) throw new ServiceError(400, "invalid_upload", "The file is empty");
    if (bytes.length > UPLOAD_MAX_BYTES) throw new ServiceError(413, "upload_too_large", "Images can be up to 5 MB");
    const mime = sniffImage(bytes);
    if (!mime) throw new ServiceError(415, "unsupported_image", "Use a PNG, JPG, WEBP or GIF image");
    if (m && m[1] !== mime && !(m[1] === "image/jpg" && mime === "image/jpeg")) throw new ServiceError(415, "unsupported_image", "The file type does not match its contents");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const saved = await store.put({ id: randomBytes(12).toString("base64url"), mime, bytes, sha256, ipHash: createHash("sha256").update(`calledit:${req.ip}`).digest("hex").slice(0, 16), createdAt: now() });
    reply.status(201);
    return { id: saved.id, url: `/social/uploads/${saved.id}`, mime: saved.mime, size: saved.bytes.length };
  });

  app.get<{ Params: { id: string } }>("/social/uploads/:id", async (req, reply) => {
    if (!ID.test(req.params.id)) throw new ServiceError(404, "not_found", "No such image");
    const u = await store.get(req.params.id);
    if (!u) throw new ServiceError(404, "not_found", "No such image");
    reply.header("Content-Type", u.mime);
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    return reply.send(u.bytes);
  });
}
