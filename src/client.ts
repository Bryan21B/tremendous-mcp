// Thin Tremendous REST client: bearer auth, one refresh-and-retry on 401,
// backoff on 429, and readable errors.
import type { TokenStore } from "./token-store.js";

type QueryValue = string | number | boolean | undefined;
export type Query = Record<string, QueryValue>;

export class TremendousError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "TremendousError";
  }
}

const MAX_429_RETRIES = 3;

export function explainError(status: number, body: unknown): string {
  const errors = (body as { errors?: { message?: string; payload?: unknown } } | undefined)?.errors;
  const detail = errors?.message
    ? `${errors.message}${errors.payload ? ` ${JSON.stringify(errors.payload)}` : ""}`
    : typeof body === "string"
      ? body.slice(0, 300)
      : JSON.stringify(body ?? "").slice(0, 300);
  switch (status) {
    case 400:
      return `Tremendous rejected the request (400 validation error): ${detail}`;
    case 401:
      return `Tremendous refused the credentials (401). Run \`npm run login\` again. ${detail}`;
    case 402:
      return `Insufficient funds on the funding source (402): ${detail}`;
    case 403:
      return `Not allowed (403). Your Tremendous role or OAuth scope does not permit this: ${detail}`;
    case 404:
      return `Not found (404): ${detail}`;
    case 409:
      return `Conflict (409): an order with this external_id already exists with different parameters. ${detail}`;
    case 422:
      return `Tremendous cannot do this for this object (422): ${detail}`;
    case 429:
      return `Rate limited by Tremendous (429). Try again in a minute.`;
    default:
      return `Tremendous API error ${status}: ${detail}`;
  }
}

export interface TremendousResponse<T> {
  status: number;
  data: T;
}

export class TremendousClient {
  constructor(
    private readonly apiBase: string,
    private readonly tokens: Pick<TokenStore, "getAccessToken" | "refresh">,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  get<T>(path: string, query: Query = {}): Promise<T> {
    return this.request<T>("GET", path, query).then((r) => r.data);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, {}, body).then((r) => r.data);
  }

  async request<T>(method: string, path: string, query: Query = {}, body?: unknown): Promise<TremendousResponse<T>> {
    const url = new URL(this.apiBase + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));

    let token = await this.tokens.getAccessToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        token = (await this.tokens.refresh(token)).access_token;
        continue;
      }
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        /* keep text */
      }
      if (!res.ok) throw new TremendousError(res.status, explainError(res.status, parsed), parsed);
      return { status: res.status, data: parsed as T };
    }
  }
}
