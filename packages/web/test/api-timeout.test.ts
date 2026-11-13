import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, isTransient, READ_TIMEOUT_MS } from "../src/lib/api";

const hang = (_url: unknown, init?: RequestInit) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("api reads time out", () => {
  it("a read that never answers fails with a timeout ApiError after READ_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(hang));
    const p = api.challenge("ch_x").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1);
    const e = await p;
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe("timeout");
    expect((e as ApiError).status).toBe(0);
    expect(isTransient(e)).toBe(true);
  });

  it("writes are not aborted by the read timeout", async () => {
    vi.useFakeTimers();
    const f = vi.fn(hang);
    vi.stubGlobal("fetch", f);
    let settled = false;
    void api.createDemo().then(() => (settled = true), () => (settled = true));
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS * 3);
    expect(settled).toBe(false);
    expect((f.mock.calls[0]![1] as RequestInit).signal).toBeUndefined();
  });

  it("4xx answers are real errors, 5xx and network failures are transient", () => {
    expect(isTransient(new ApiError(403, "not_owner", "x"))).toBe(false);
    expect(isTransient(new ApiError(404, "challenge_not_found", "x"))).toBe(false);
    expect(isTransient(new ApiError(502, "http_502", "x"))).toBe(true);
    expect(isTransient(new ApiError(0, "network", "x"))).toBe(true);
  });
});
