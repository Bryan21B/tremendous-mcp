import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isExpired, NotLoggedInError, type StoredTokens, TokenStore } from "../src/token-store.js";

const now = () => Math.floor(Date.now() / 1000);
const tokens = (n: number, expired = false): StoredTokens => ({
  access_token: `a${n}`,
  refresh_token: `r${n}`,
  created_at: expired ? now() - 10_000 : now(),
  expires_in: 7200,
});

async function setup(initial?: StoredTokens) {
  const dir = await mkdtemp(join(tmpdir(), "trem-"));
  const file = join(dir, "tokens.json");
  if (initial) await writeFile(file, JSON.stringify(initial));
  let n = 1;
  const used: string[] = [];
  const requester = vi.fn(async (body: Record<string, string>) => {
    used.push(body.refresh_token);
    await new Promise((r) => setTimeout(r, 20));
    return tokens(++n);
  });
  return { file, requester, used };
}

describe("TokenStore", () => {
  it("throws NotLoggedInError without a token file", async () => {
    const { file, requester } = await setup();
    await expect(new TokenStore(file, requester).getAccessToken()).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it("returns the stored token when it is still valid", async () => {
    const { file, requester } = await setup(tokens(1));
    expect(await new TokenStore(file, requester).getAccessToken()).toBe("a1");
    expect(requester).not.toHaveBeenCalled();
  });

  it("refreshes an expired token, saves the rotated refresh token with mode 0600", async () => {
    const { file, requester } = await setup(tokens(1, true));
    expect(await new TokenStore(file, requester).getAccessToken()).toBe("a2");
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.refresh_token).toBe("r2");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("concurrent callers in one process share one refresh", async () => {
    const { file, requester } = await setup(tokens(1, true));
    const store = new TokenStore(file, requester);
    const got = await Promise.all([store.getAccessToken(), store.getAccessToken(), store.getAccessToken()]);
    expect(new Set(got)).toEqual(new Set(["a2"]));
    expect(requester).toHaveBeenCalledTimes(1);
  });

  it("two stores (two processes) never use the same refresh token twice", async () => {
    const { file, requester, used } = await setup(tokens(1, true));
    const a = new TokenStore(file, requester);
    const b = new TokenStore(file, requester);
    const [x, y] = await Promise.all([a.getAccessToken(), b.getAccessToken()]);
    expect(x).toBe(y);
    expect(used).toEqual(["r1"]);
  });

  it("after a 401 on a valid-looking token, refresh(stale) rotates once", async () => {
    const { file, requester } = await setup(tokens(1));
    const store = new TokenStore(file, requester);
    expect((await store.refresh("a1")).access_token).toBe("a2");
    // A second caller that also saw a1 fail gets a2 without another refresh.
    expect((await store.refresh("a1")).access_token).toBe("a2");
    expect(requester).toHaveBeenCalledTimes(1);
  });

  it("isExpired honours the 60 s margin", () => {
    expect(isExpired({ ...tokens(1), created_at: 1000, expires_in: 100 }, 1039)).toBe(false);
    expect(isExpired({ ...tokens(1), created_at: 1000, expires_in: 100 }, 1041)).toBe(true);
  });
});
