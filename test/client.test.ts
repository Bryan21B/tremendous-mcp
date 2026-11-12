import { describe, expect, it, vi } from "vitest";
import { TremendousClient, TremendousError } from "../src/client.js";

const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function client(responses: Response[]) {
  const seen: string[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(String((init?.headers as Record<string, string>).Authorization));
    return responses.shift()!;
  });
  const tokens = { getAccessToken: vi.fn(async () => "old"), refresh: vi.fn(async () => ({ access_token: "new", refresh_token: "r", created_at: 0, expires_in: 0 })) };
  const sleep = vi.fn(async () => {});
  return { c: new TremendousClient("https://x.test/api/v2", tokens, fetchImpl as unknown as typeof fetch, sleep), seen, tokens, sleep, fetchImpl };
}

describe("TremendousClient", () => {
  it("refreshes once on 401 and retries with the new token", async () => {
    const { c, seen, tokens } = client([res(401), res(200, { ok: 1 })]);
    expect(await c.get("/x")).toEqual({ ok: 1 });
    expect(seen).toEqual(["Bearer old", "Bearer new"]);
    expect(tokens.refresh).toHaveBeenCalledWith("old");
  });

  it("does not loop on a second 401", async () => {
    const { c } = client([res(401), res(401, { errors: { message: "bad" } })]);
    await expect(c.get("/x")).rejects.toMatchObject({ status: 401 });
  });

  it("backs off on 429 using Retry-After", async () => {
    const { c, sleep } = client([res(429, {}, { "Retry-After": "2" }), res(200, { ok: 1 })]);
    await c.get("/x");
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it.each([
    [402, /Insufficient funds/],
    [409, /external_id already exists/],
    [400, /validation error.*bad email/],
  ])("maps %i to a readable error", async (status, re) => {
    const { c } = client([res(status, { errors: { message: "bad email", payload: {} } })]);
    const err = await c.post("/orders", {}).catch((e) => e);
    expect(err).toBeInstanceOf(TremendousError);
    expect(err.message).toMatch(re);
  });

  it("returns the HTTP status so callers can detect idempotent replays (201)", async () => {
    const { c } = client([res(201, { order: { id: "O1" } })]);
    expect((await c.request("POST", "/orders", {}, {})).status).toBe(201);
  });
});
