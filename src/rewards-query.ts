// "Who received rewards?" Tremendous has no recipient or date filter on
// GET /rewards, so we page through results (500 per call) and filter here.
// With a date range or a campaign we page GET /orders instead, which supports
// created_at[gte|lte] and campaign_id, and flatten each order's rewards.
import type { TremendousClient } from "./client.js";
import type { DeliveryStatus, Order, OrderStatus, Reward } from "./types.js";

export interface RewardFilters {
  email?: string;
  name?: string;
  since?: string;
  until?: string;
  campaign_id?: string;
  delivery_status?: DeliveryStatus;
  /** Max rewards to scan (not to return). */
  max_scan?: number;
  /** Continue a previous scan from this offset in the underlying list. */
  offset?: number;
}

export interface RewardRow {
  id: string;
  order_id?: string;
  created_at?: string;
  recipient_name?: string;
  recipient_email?: string;
  recipient_phone?: string;
  amount?: number;
  currency?: string;
  delivery_method?: string;
  delivery_status?: string;
  order_status?: OrderStatus;
  campaign_id?: string | null;
}

export interface RecipientSummary {
  recipient: string;
  name?: string;
  email?: string;
  rewards: number;
  totals: Record<string, number>;
  last_at?: string;
}

export interface RewardsResult {
  source: "rewards" | "orders";
  rows: RewardRow[];
  recipients: RecipientSummary[];
  totals: Record<string, number>;
  scanned: number;
  total_available: number;
  next_offset: number | null;
  truncated: boolean;
}

const PAGE = 500;
export const DEFAULT_MAX_SCAN = 5000;

function toRow(r: Reward, order?: Order): RewardRow {
  return {
    id: r.id,
    order_id: r.order_id ?? order?.id,
    created_at: r.created_at ?? order?.created_at,
    recipient_name: r.recipient?.name ?? undefined,
    recipient_email: r.recipient?.email ?? undefined,
    recipient_phone: r.recipient?.phone ?? undefined,
    amount: r.value?.denomination,
    currency: r.value?.currency_code,
    delivery_method: r.delivery?.method,
    delivery_status: r.delivery?.status,
    order_status: order?.status,
    campaign_id: order?.campaign_id,
  };
}

export function matches(row: RewardRow, f: RewardFilters): boolean {
  if (f.email && !(row.recipient_email ?? "").toLowerCase().includes(f.email.toLowerCase())) return false;
  if (f.name && !(row.recipient_name ?? "").toLowerCase().includes(f.name.toLowerCase())) return false;
  if (f.delivery_status && row.delivery_status !== f.delivery_status) return false;
  return true;
}

export function summarize(rows: RewardRow[]): { recipients: RecipientSummary[]; totals: Record<string, number> } {
  const by = new Map<string, RecipientSummary>();
  const totals: Record<string, number> = {};
  for (const r of rows) {
    const key = (r.recipient_email ?? r.recipient_phone ?? r.recipient_name ?? "unknown").toLowerCase();
    const s = by.get(key) ?? { recipient: key, name: r.recipient_name, email: r.recipient_email, rewards: 0, totals: {} };
    s.rewards++;
    const cur = r.currency ?? "?";
    if (typeof r.amount === "number") {
      s.totals[cur] = round2((s.totals[cur] ?? 0) + r.amount);
      totals[cur] = round2((totals[cur] ?? 0) + r.amount);
    }
    if (r.created_at && (!s.last_at || r.created_at > s.last_at)) s.last_at = r.created_at;
    by.set(key, s);
  }
  const recipients = [...by.values()].sort((a, b) => (b.last_at ?? "").localeCompare(a.last_at ?? ""));
  return { recipients, totals };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function queryRewards(client: TremendousClient, f: RewardFilters): Promise<RewardsResult> {
  const maxScan = Math.max(1, f.max_scan ?? DEFAULT_MAX_SCAN);
  const useOrders = Boolean(f.since || f.until || f.campaign_id);
  let offset = f.offset ?? 0;
  let scanned = 0;
  let totalAvailable = 0;
  const rows: RewardRow[] = [];

  for (;;) {
    const limit = Math.min(PAGE, maxScan - scanned);
    let batch: RewardRow[];
    let pageSize: number;
    if (useOrders) {
      const res = await client.get<{ orders: Order[]; total_count: number }>("/orders", {
        offset,
        limit,
        campaign_id: f.campaign_id,
        "created_at[gte]": f.since,
        "created_at[lte]": f.until,
      });
      totalAvailable = res.total_count ?? 0;
      pageSize = res.orders.length;
      batch = res.orders.flatMap((o) => (o.rewards ?? []).map((r) => toRow(r, o)));
    } else {
      const res = await client.get<{ rewards: Reward[]; total_count: number }>("/rewards", { offset, limit });
      totalAvailable = res.total_count ?? 0;
      pageSize = res.rewards.length;
      batch = res.rewards.map((r) => toRow(r));
    }
    offset += pageSize;
    scanned += pageSize;
    for (const row of batch) if (matches(row, f)) rows.push(row);

    const exhausted = pageSize < limit || offset >= totalAvailable;
    if (exhausted) {
      return { source: useOrders ? "orders" : "rewards", rows, ...summarize(rows), scanned, total_available: totalAvailable, next_offset: null, truncated: false };
    }
    if (scanned >= maxScan) {
      return { source: useOrders ? "orders" : "rewards", rows, ...summarize(rows), scanned, total_available: totalAvailable, next_offset: offset, truncated: true };
    }
  }
}
