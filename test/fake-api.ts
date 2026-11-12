// In-memory fake of the parts of the Tremendous API the server uses.
import { TremendousClient } from "../src/client.js";
import type { Order, Reward } from "../src/types.js";

export function makeRewards(n: number, start = Date.UTC(2026, 10, 1)): Reward[] {
  // Newest first, one per hour, alternating recipients.
  return Array.from({ length: n }, (_, i) => ({
    id: `R${String(i).padStart(6, "0")}`,
    order_id: `O${String(i).padStart(6, "0")}`,
    created_at: new Date(start - i * 3600_000).toISOString(),
    value: { denomination: 10 + (i % 3), currency_code: "EUR" },
    recipient: { name: `Person ${i % 4}`, email: `person${i % 4}@example.com` },
    delivery: { method: "EMAIL", status: i % 10 === 0 ? "FAILED" : "SUCCEEDED" },
  }));
}

export interface FakeApi {
  fetch: typeof fetch;
  calls: { method: string; path: string; query: Record<string, string>; body?: unknown }[];
  orders: Map<string, { order: Order; body: string }>;
}

export function fakeApi(rewards: Reward[] = makeRewards(30), opts: { failOrderFor?: string; status402After?: number } = {}): FakeApi {
  const calls: FakeApi["calls"] = [];
  const orders = new Map<string, { order: Order; body: string }>();
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  let created = 0;

  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v2/, "");
    const query = Object.fromEntries(url.searchParams);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? "GET";
    calls.push({ method, path, query, body });
    const offset = Number(query.offset ?? 0);
    const limit = Number(query.limit ?? 100);

    if (method === "GET" && path === "/rewards") return json(200, { rewards: rewards.slice(offset, offset + limit), total_count: rewards.length });
    if (method === "GET" && path === "/orders") {
      const all: Order[] = rewards
        .filter((r) => (!query["created_at[gte]"] || r.created_at! >= query["created_at[gte]"]) && (!query["created_at[lte]"] || r.created_at! <= query["created_at[lte]"]))
        .map((r) => ({ id: r.order_id!, created_at: r.created_at!, status: "EXECUTED", campaign_id: "CAMP1", rewards: [r] }));
      return json(200, { orders: all.slice(offset, offset + limit), total_count: all.length });
    }
    if (method === "GET" && path === "/funding_sources") return json(200, { funding_sources: [{ id: "BAL1", method: "balance", status: "active", meta: { available_amount: 1000, currency_code: "EUR" } }] });
    if (method === "GET" && path === "/campaigns") return json(200, { campaigns: [{ id: "CAMP1", name: "Thank you", products: ["P1"] }] });
    if (method === "GET" && path === "/organizations") return json(200, { organizations: [{ id: "ORG1", name: "Acme sandbox" }] });
    if (method === "POST" && path === "/orders") {
      const ext = body.external_id as string;
      const existing = orders.get(ext);
      if (existing) return existing.body === JSON.stringify(body) ? json(201, { order: existing.order }) : json(409, { errors: { message: "Conflict", payload: {} } });
      if (opts.failOrderFor && body.reward.recipient.email === opts.failOrderFor) return json(400, { errors: { message: "Invalid email", payload: { reward: { recipient: { email: "invalid" } } } } });
      if (opts.status402After !== undefined && created >= opts.status402After) return json(402, { errors: { message: "Insufficient funds", payload: {} } });
      created++;
      const order: Order = { id: `NEW${created}`, external_id: ext, created_at: new Date().toISOString(), status: "EXECUTED", rewards: [{ id: `NR${created}`, delivery: { method: body.reward.delivery.method, status: "PENDING" } }] };
      orders.set(ext, { order, body: JSON.stringify(body) });
      return json(200, { order });
    }
    if (method === "POST" && /^\/order_approvals\/[^/]+\/(approve|reject)$/.test(path)) return json(200, { order: { id: path.split("/")[2], created_at: "", status: path.endsWith("approve") ? "EXECUTED" : "CANCELED" } });
    if (method === "POST" && /^\/rewards\/[^/]+\/(resend|cancel)$/.test(path)) return json(200, {});
    return json(404, { errors: { message: `No route ${method} ${path}`, payload: {} } });
  };
  return { fetch: impl as typeof fetch, calls, orders };
}

export function fakeClient(api: FakeApi) {
  const tokens = { getAccessToken: async () => "tok", refresh: async () => ({ access_token: "tok2", refresh_token: "r", created_at: 0, expires_in: 0 }) };
  return new TremendousClient("https://testflight.tremendous.com/api/v2", tokens, api.fetch, async () => {});
}
