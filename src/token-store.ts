// Stores the Tremendous OAuth tokens in a 0600 file and refreshes them.
//
// Tremendous refresh tokens are SINGLE-USE: every refresh returns a new refresh
// token and the old one stops working. Claude Desktop and Claude Code can each
// run a server process, so two processes could refresh at the same time and
// lock the user out. To prevent that:
//   - a file lock serializes refreshes across processes,
//   - inside the lock we re-read the file (another process may have refreshed),
//   - the new tokens are written (atomically) before they are used,
//   - in one process, concurrent callers share a single refresh promise.
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { PROJECT_DIR } from "./config.js";

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  scope?: string;
  /** Unix seconds. */
  created_at: number;
  /** Seconds. */
  expires_in: number;
}

export type TokenRequester = (body: Record<string, string>) => Promise<StoredTokens>;

export class NotLoggedInError extends Error {
  constructor(message = `Not logged in to Tremendous. Run \`npm run login\` in ${PROJECT_DIR}.`) {
    super(message);
    this.name = "NotLoggedInError";
  }
}

const EXPIRY_MARGIN_S = 60;

export function isExpired(t: StoredTokens, nowS = Date.now() / 1000): boolean {
  if (!t.expires_in) return false;
  return nowS >= t.created_at + t.expires_in - EXPIRY_MARGIN_S;
}

export function normalizeTokenResponse(body: Record<string, unknown>): StoredTokens {
  if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
    throw new Error("Tremendous token response has no access_token or refresh_token.");
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    token_type: typeof body.token_type === "string" ? body.token_type : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
    created_at: typeof body.created_at === "number" ? body.created_at : Math.floor(Date.now() / 1000),
    expires_in: typeof body.expires_in === "number" ? body.expires_in : 0,
  };
}

export class TokenStore {
  private inflight: Promise<StoredTokens> | null = null;

  constructor(
    private readonly file: string,
    private readonly requestToken: TokenRequester,
  ) {}

  async read(): Promise<StoredTokens | null> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as StoredTokens;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async save(tokens: StoredTokens): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }

  /** A usable access token. Refreshes first when it is expired. */
  async getAccessToken(): Promise<string> {
    const t = await this.read();
    if (!t) throw new NotLoggedInError();
    if (!isExpired(t)) return t.access_token;
    return (await this.refresh(t.access_token)).access_token;
  }

  /**
   * Refresh the tokens. `staleAccessToken` is the token the caller saw fail or
   * expire: if the file already holds a different, valid token, another caller
   * refreshed first and we use that instead of burning the refresh token again.
   */
  refresh(staleAccessToken?: string): Promise<StoredTokens> {
    if (!this.inflight) {
      this.inflight = this.refreshLocked(staleAccessToken).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async refreshLocked(staleAccessToken?: string): Promise<StoredTokens> {
    const current = await this.read();
    if (!current) throw new NotLoggedInError();
    const release = await lockfile.lock(this.file, {
      retries: { retries: 20, minTimeout: 100, maxTimeout: 1000 },
      stale: 30_000,
    });
    try {
      const fresh = await this.read();
      if (!fresh) throw new NotLoggedInError();
      if (fresh.access_token !== staleAccessToken && !isExpired(fresh)) return fresh;
      let next: StoredTokens;
      try {
        next = await this.requestToken({ grant_type: "refresh_token", refresh_token: fresh.refresh_token });
      } catch (e) {
        throw new NotLoggedInError(
          `Tremendous token refresh failed (${(e as Error).message}). Run \`npm run login\` in ${PROJECT_DIR}.`,
        );
      }
      await this.save(next);
      return next;
    } finally {
      await release();
    }
  }
}

/** POST to the Tremendous token endpoint with the client credentials. */
export function makeTokenRequester(tokenUrl: string, clientId: string, clientSecret: string): TokenRequester {
  return async (body) => {
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ...body, client_id: clientId, client_secret: clientSecret }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return normalizeTokenResponse(JSON.parse(text));
  };
}
