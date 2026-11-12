// Read-only tools. They never move money.
import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { type Ctx, REWARDS_VIEW, SEND_VIEW, envLabel, fmtTotals, guard, money, result } from "../context.js";
import { DEFAULT_MAX_SCAN, queryRewards } from "../rewards-query.js";
import { DeliveryStatus, RewardDraftInput, draftTotal, validateDraft } from "../schemas.js";
import type { Order, Reward } from "../types.js";

const RO = { readOnlyHint: true, openWorldHint: true } as const;
const MAX_ROWS = 1000;

interface FundingSource {
  id: string;
  method: string;
  type?: string;
  status?: string;
  usage_permissions?: string[];
  meta?: { available_amount?: number; pending_amount?: number; currency_code?: string; [k: string]: unknown };
}
interface Campaign { id: string; name: string; description?: string; products?: string[] }
interface Product {
  id: string;
  name: string;
  category: string;
  subcategory?: string;
  currency_codes: string[];
  countries: { abbr: string }[];
  skus?: { min: number; max: number; currency_code?: string }[];
}

export async function fetchFundingSources(ctx: Ctx) {
  const { funding_sources } = await ctx.client.get<{ funding_sources: FundingSource[] }>("/funding_sources");
  return funding_sources
    .filter((f) => f.status !== "deleted")
    .map((f) => ({
      id: f.id,
      method: f.method,
      type: f.type,
      status: f.status,
      usage_permissions: f.usage_permissions,
      available: f.meta?.available_amount,
      pending: f.meta?.pending_amount,
      currency: f.meta?.currency_code,
      label: describeFunding(f),
    }));
}

function describeFunding(f: FundingSource): string {
  const m = f.meta ?? {};
  if (f.method === "balance") return `Balance (${money(m.available_amount, m.currency_code)} available)`;
  if (f.method === "credit_card") return `Card ${m.network ?? ""} •••• ${m.last4 ?? "?"}`.replace(/\s+/g, " ");
  if (f.method === "bank_account") return `Bank ${m.bank_name ?? ""} ${m.account_number_mask ?? ""}`.trim();
  if (f.method === "invoice") return `Invoice${f.type ? ` (${f.type})` : ""}`;
  return f.method;
}

export async function fetchCampaigns(ctx: Ctx): Promise<Campaign[]> {
  const { campaigns } = await ctx.client.get<{ campaigns: Campaign[] }>("/campaigns");
  return campaigns.map((c) => ({ id: c.id, name: c.name, description: c.description, products: c.products }));
}

function rewardLine(r: Reward) {
  const who = r.recipient?.name ? `${r.recipient.name} <${r.recipient.email ?? r.recipient.phone ?? "?"}>` : (r.recipient?.email ?? r.recipient?.phone ?? "?");
  return `${r.id} · ${who} · ${money(r.value?.denomination, r.value?.currency_code)} · ${r.delivery?.method ?? "?"}/${r.delivery?.status ?? "?"} · ${r.created_at?.slice(0, 10) ?? ""}`;
}

function orderLine(o: Order) {
  const total = o.payment?.total !== undefined ? money(o.payment.total, o.payment.currency_code) : "";
  return `${o.id} · ${o.status} · ${o.created_at.slice(0, 10)} · ${(o.rewards ?? []).length} reward(s) ${total}${o.external_id ? ` · ext ${o.external_id}` : ""}`;
}

export function registerReadTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    "get_account",
    {
      title: "Tremendous account",
      description: "Show the connected Tremendous organization, the environment (SANDBOX or PRODUCTION) and the funding sources with their balances. Call this first to know which account you act on.",
      inputSchema: z.object({}),
      annotations: RO,
    },
    () => guard(async () => {
      const [orgs, funding] = await Promise.all([
        ctx.client.get<{ organizations: { id: string; name: string; website?: string; status?: string }[] }>("/organizations"),
        fetchFundingSources(ctx),
      ]);
      const text = [
        `Environment: ${envLabel(ctx)}`,
        `Organizations: ${orgs.organizations.map((o) => `${o.name} (${o.id})`).join(", ") || "none"}`,
        "Funding sources:",
        ...funding.map((f) => `- ${f.id}: ${f.label}`),
      ].join("\n");
      return result(text, { environment: envLabel(ctx), organizations: orgs.organizations, funding_sources: funding });
    }),
  );

  server.registerTool(
    "list_funding_sources",
    {
      title: "List funding sources",
      description: "List the funding sources (balance, card, bank, invoice) that can pay for rewards. Balances in this list can be a little stale.",
      inputSchema: z.object({}),
      annotations: RO,
    },
    () => guard(async () => {
      const funding = await fetchFundingSources(ctx);
      return result(funding.map((f) => `${f.id}: ${f.label}`).join("\n") || "No funding sources.", { funding_sources: funding });
    }),
  );

  server.registerTool(
    "list_products",
    {
      title: "List reward products",
      description: "List the reward products (gift cards, PayPal, Visa, charity, ...) in the catalog. Filter by country/currency and by a name search. Use product IDs in send_rewards.products.",
      inputSchema: z.object({
        country: z.string().optional().describe("Comma-separated ISO alpha-2 codes, e.g. FR,DE"),
        currency: z.string().optional().describe("Comma-separated currency codes, e.g. EUR"),
        search: z.string().optional().describe("Case-insensitive substring of the product name"),
        category: z.string().optional().describe("e.g. merchant_card, paypal, visa_card, charity"),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      annotations: RO,
    },
    ({ country, currency, search, category, limit }) => guard(async () => {
      const { products } = await ctx.client.get<{ products: Product[] }>("/products", { country, currency });
      const filtered = products
        .filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase()))
        .filter((p) => !category || p.category === category);
      const rows = filtered.slice(0, limit).map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        subcategory: p.subcategory,
        currencies: p.currency_codes,
        countries: p.countries.map((c) => c.abbr),
        skus: p.skus,
      }));
      const text = `${filtered.length} product(s)${filtered.length > limit ? `, showing ${limit}` : ""}:\n` +
        rows.map((p) => `${p.id} · ${p.name} · ${p.category} · ${p.currencies.join("/")}`).join("\n");
      return result(text, { total: filtered.length, products: rows });
    }),
  );

  server.registerTool(
    "list_campaigns",
    {
      title: "List campaigns",
      description: "List Tremendous campaigns (reward templates with products, message and branding). Use a campaign_id in send_rewards.",
      inputSchema: z.object({}),
      annotations: RO,
    },
    () => guard(async () => {
      const campaigns = await fetchCampaigns(ctx);
      return result(campaigns.map((c) => `${c.id} · ${c.name}`).join("\n") || "No campaigns.", { campaigns });
    }),
  );

  server.registerTool(
    "get_campaign",
    {
      title: "Get campaign",
      description: "Get one campaign with its products and email settings.",
      inputSchema: z.object({ id: z.string() }),
      annotations: RO,
    },
    ({ id }) => guard(async () => {
      const { campaign } = await ctx.client.get<{ campaign: Record<string, unknown> }>(`/campaigns/${encodeURIComponent(id)}`);
      return result(JSON.stringify(campaign, null, 2), { campaign });
    }),
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description: "List orders, newest first. Filter by creation date range, campaign, external_id, or status (for example PENDING APPROVAL to find orders that wait for approval).",
      inputSchema: z.object({
        since: z.string().optional().describe("ISO 8601 date or datetime, inclusive"),
        until: z.string().optional().describe("ISO 8601 date or datetime, inclusive"),
        campaign_id: z.string().optional(),
        external_id: z.string().optional(),
        status: z.enum(["CANCELED", "OPEN", "EXECUTED", "FAILED", "PENDING APPROVAL", "PENDING INTERNAL PAYMENT APPROVAL", "PENDING SETTLEMENT"]).optional()
          .describe("Filtered after fetching: the API has no status filter, so up to `limit` orders are scanned."),
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: RO,
    },
    ({ since, until, campaign_id, external_id, status, limit, offset }) => guard(async () => {
      const res = await ctx.client.get<{ orders: Order[]; total_count: number }>("/orders", {
        offset, limit, campaign_id, external_id, "created_at[gte]": since, "created_at[lte]": until,
      });
      const orders = status ? res.orders.filter((o) => o.status === status) : res.orders;
      const text = `${orders.length} order(s) (of ${res.total_count} matching the date/campaign filters):\n` + orders.map(orderLine).join("\n");
      return result(text, { total_count: res.total_count, orders });
    }),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Get one order with its status, payment and rewards.",
      inputSchema: z.object({ id: z.string().describe("Tremendous order ID. To find an order by external_id, use list_orders with external_id.") }),
      annotations: RO,
    },
    ({ id }) => guard(async () => {
      const { order } = await ctx.client.get<{ order: Order }>(`/orders/${encodeURIComponent(id)}`);
      return result([orderLine(order), ...(order.rewards ?? []).map((r) => `  ${rewardLine(r)}`)].join("\n"), { order });
    }),
  );

  server.registerTool(
    "get_reward",
    {
      title: "Get reward",
      description: "Get one reward: recipient, value, delivery method and delivery status.",
      inputSchema: z.object({ id: z.string() }),
      annotations: RO,
    },
    ({ id }) => guard(async () => {
      const { reward } = await ctx.client.get<{ reward: Reward }>(`/rewards/${encodeURIComponent(id)}`);
      return result(rewardLine(reward), { reward });
    }),
  );

  registerAppTool(
    server,
    "list_rewards",
    {
      title: "Who received rewards",
      description:
        "Find which people received rewards. Filter by recipient email or name (substring), date range, campaign and delivery status. " +
        "Returns one summary per recipient (count and total) and the reward rows, and shows an interactive table. " +
        "Tremendous cannot filter by recipient, so this scans up to max_scan rewards (newest first); if `truncated` is true, call again with offset=next_offset.",
      inputSchema: z.object({
        email: z.string().optional(),
        name: z.string().optional(),
        since: z.string().optional().describe("ISO 8601 date or datetime, inclusive"),
        until: z.string().optional().describe("ISO 8601 date or datetime, inclusive"),
        campaign_id: z.string().optional(),
        delivery_status: DeliveryStatus.optional(),
        max_scan: z.number().int().min(1).max(20000).default(DEFAULT_MAX_SCAN),
        offset: z.number().int().min(0).optional(),
      }),
      annotations: RO,
      _meta: { ui: { resourceUri: REWARDS_VIEW } },
    },
    (args) => guard(async () => {
      const r = await queryRewards(ctx.client, args);
      const lines = [
        `${envLabel(ctx)} · ${r.rows.length} reward(s) to ${r.recipients.length} recipient(s), total ${fmtTotals(r.totals)}.`,
        `Scanned ${r.scanned} of ${r.total_available} ${r.source}.${r.truncated ? ` Truncated: call again with offset=${r.next_offset}.` : ""}`,
        ...r.recipients.slice(0, 50).map((s) => `- ${s.name ? `${s.name} <${s.email ?? s.recipient}>` : s.recipient}: ${s.rewards} reward(s), ${fmtTotals(s.totals)}, last ${s.last_at?.slice(0, 10) ?? "?"}`),
        r.recipients.length > 50 ? `… ${r.recipients.length - 50} more recipient(s) in structured data.` : "",
      ].filter(Boolean);
      // Keep the structured payload bounded; the summary above covers every match.
      const rows = r.rows.slice(0, MAX_ROWS);
      return result(lines.join("\n"), { environment: envLabel(ctx), filters: args, ...r, rows, rows_omitted: r.rows.length - rows.length });
    }),
  );

  registerAppTool(
    server,
    "review_rewards",
    {
      title: "Review rewards before sending",
      description:
        "Prepare a batch of rewards WITHOUT sending anything. Checks the recipients, amounts, campaign/products and funding source, " +
        "and shows an editable review form with a Send button. Use this before send_rewards. Returns a draft_id to pass to send_rewards.",
      inputSchema: RewardDraftInput,
      annotations: RO,
      _meta: { ui: { resourceUri: SEND_VIEW } },
    },
    (draft) => guard(async () => {
      const [funding, campaigns] = await Promise.all([fetchFundingSources(ctx), fetchCampaigns(ctx).catch(() => [])]);
      const { errors, warnings } = validateDraft(draft);
      if (draft.campaign_id && campaigns.length && !campaigns.some((c) => c.id === draft.campaign_id)) {
        errors.push(`Campaign ${draft.campaign_id} does not exist in this account.`);
      }
      const total = draftTotal(draft);
      const draft_id = crypto.randomUUID().slice(0, 8);
      const campaign = campaigns.find((c) => c.id === draft.campaign_id);
      const text = [
        `${envLabel(ctx)} · DRAFT ${draft_id} (nothing sent yet)`,
        `${draft.recipients.length} reward(s), total ${money(total, draft.currency_code ?? "")} via ${draft.delivery_method}, paid by ${draft.funding_source_id}` +
          (campaign ? `, campaign "${campaign.name}"` : draft.products?.length ? `, products ${draft.products.join(",")}` : ""),
        ...draft.recipients.map((r) => `- ${r.name ?? ""} ${r.email ?? r.phone ?? ""}: ${money(r.amount, draft.currency_code ?? "")}`.replace(/\s+/g, " ")),
        ...errors.map((e) => `ERROR: ${e}`),
        ...warnings.map((w) => `WARNING: ${w}`),
        errors.length ? "Fix the errors before sending." : `To send, the user clicks Send in the form, or call send_rewards with draft_id "${draft_id}" and the same fields.`,
      ].join("\n");
      return result(text, { environment: envLabel(ctx), draft_id, draft, total, errors, warnings, funding_sources: funding, campaigns });
    }),
  );
}
