import { assertDevnetUrl } from "./cluster.js";

export interface JsonRpc {
  call(method: string, params?: unknown[]): Promise<unknown>;
}

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = "RpcError";
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Minimal Solana JSON-RPC client over fetch (devnet only). Mocked in tests by passing `fetch`. */
export class HttpRpc implements JsonRpc {
  private id = 0;
  constructor(
    readonly url: string,
    private readonly fetchFn: FetchLike = fetch as unknown as FetchLike,
  ) {
    assertDevnetUrl(url);
  }

  async call(method: string, params: unknown[] = []): Promise<unknown> {
    const res = await this.fetchFn(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
    });
    if (!res.ok) throw new RpcError(method, res.status, `HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } };
    if (body.error) throw new RpcError(method, body.error.code, body.error.message ?? "rpc error");
    return body.result;
  }
}
