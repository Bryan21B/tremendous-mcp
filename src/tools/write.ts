// Tools that move money or cannot be undone. All carry destructiveHint so the
// host asks the user before each call. There is no extra step-up auth (decided
// with the user); retries are made safe with Tremendous's external_id.
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { TremendousError } from "../client.js";
import { type Ctx, envLabel, errorResult, guard, money, result } from "../context.js";
import { RewardDraftInput, type RewardDraft, validateDraft } from "../schemas.js";
import type { Order } from "../types.js";

const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

export interface SendRow {
  index: number;
  recipient: string;
  amount: number;
  external_id: string;
  outcome: "sent" | "already_sent" | "pending_approval" | "failed";
  order_id?: string;
  order_status?: string;
  reward_id?: string;
  link?: string;
  error?: string;
}

export function buildOrderBody(d: RewardDraft, index: number, externalId: string) {
  const r = d.recipients[index];
  const meta = Object.fromEntries(
    Object.entries({ sender_name: d.sender_name, subject_line: d.subject_line, message: d.message }).filter(([, v]) => v),
  );
  return {
    external_id: externalId,
    payment: { funding_source_id: d.funding_source_id },
    reward: {
      ...(d.campaign_id ? { campaign_id: d.campaign_id } : {}),
      ...(d.products?.length ? { products: d.products } : {}),
      value: { denomination: r.amount, ...(d.currency_code ? { currency_code: d.currency_code } : {}) },
      recipient: Object.fromEntries(Object.entries({ name: r.name, email: r.email, phone: r.phone }).filter(([, v]) => v)),
      delivery: { method: d.delivery_method },
      ...(d.deliver_at ? { deliver_at: d.deliver_at } : {}),
      ...(d.language ? { language: d.language } : {}),
      ...(Object.keys(meta).length ? { meta } : {}),
    },
  };
}

/**
 * external_id for each row, keyed on WHO is paid, not on the row position.
 * If a retry drops, reorders or inserts recipients, everyone keeps the same
 * external_id, so Tremendous returns the existing order instead of paying twice.
 * The amount is NOT in the key: changing it on the same draft gives a 409
 * conflict instead of a second payment. Intentional duplicates get a counter.
 */
export function externalIds(d: RewardDraft, draftId: string): string[] {
  const seen = new Map<string, number>();
  return d.recipients.map((r) => {
    const contact = r.email?.trim().toLowerCase() || r.phone?.replace(/[^\d+]/g, "") || r.name?.trim().toLowerCase() || "";
    const n = (seen.get(contact) ?? 0) + 1;
    seen.set(contact, n);
    const h = createHash("sha256").update(contact).digest("hex").slice(0, 10);
    return `mcp-${draftId}-${h}${n > 1 ? `-${n}` : ""}`;
  });
}

export async function sendRewards(ctx: Ctx, d: RewardDraft, draftId: string): Promise<SendRow[]> {
  const rows: SendRow[] = [];
  const ids = externalIds(d, draftId);
  // Sequential on purpose: easier to read the result, and gentler on rate limits.
  for (let i = 0; i < d.recipients.length; i++) {
    const r = d.recipients[i];
    const external_id = ids[i];
    const base = { index: i + 1, recipient: r.email ?? r.phone ?? r.name ?? `#${i + 1}`, amount: r.amount, external_id };
    try {
      const res = await ctx.client.request<{ order: Order }>("POST", "/orders", {}, buildOrderBody(d, i, external_id));
      const order = res.data.order;
      const reward = order.rewards?.[0];
      rows.push({
        ...base,
        outcome: res.status === 201 ? "already_sent" : order.status.startsWith("PENDING") ? "pending_approval" : "sent",
        order_id: order.id,
        order_status: order.status,
        reward_id: reward?.id,
        link: reward?.delivery?.link,
      });
    } catch (e) {
      rows.push({ ...base, outcome: "failed", error: (e as Error).message });
      // Out of money: the next orders would fail the same way.
      if (e instanceof TremendousError && e.status === 402) {
        for (let j = i + 1; j < d.recipients.length; j++) {
          const rr = d.recipients[j];
          rows.push({ index: j + 1, recipient: rr.email ?? rr.phone ?? rr.name ?? `#${j + 1}`, amount: rr.amount, external_id: ids[j], outcome: "failed", error: "Not attempted: insufficient funds." });
        }
        break;
      }
    }
  }
  return rows;
}

export function registerWriteTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    "send_rewards",
    {
      title: "Send rewards",
      description:
        "SEND rewards: this spends money and emails/texts the recipients. It cannot be undone once a reward is redeemed. " +
        "Creates one Tremendous order per recipient. Prefer calling review_rewards first and let the user confirm. " +
        "draft_id makes retries safe: with the same draft_id, a recipient who was already paid is not paid again (even if you remove, reorder or add other recipients), so after a partial failure retry with the same draft_id.",
      inputSchema: RewardDraftInput.extend({
        draft_id: z.string().regex(/^[A-Za-z0-9_-]{4,40}$/).describe("The draft_id from review_rewards (or any unique string). Reuse it on retry."),
      }),
      annotations: { ...DESTRUCTIVE, idempotentHint: true },
    },
    ({ draft_id, ...draft }) => guard(async () => {
      const { errors } = validateDraft(draft);
      if (errors.length) return errorResult(`Nothing sent. Fix these first:\n${errors.join("\n")}`);
      const rows = await sendRewards(ctx, draft, draft_id);
      const count = (o: SendRow["outcome"]) => rows.filter((r) => r.outcome === o).length;
      const text = [
        `${envLabel(ctx)} · draft ${draft_id}: ${count("sent")} sent, ${count("pending_approval")} pending approval, ${count("already_sent")} already sent earlier, ${count("failed")} failed.`,
        ...rows.map((r) => `${r.index}. ${r.recipient} ${money(r.amount, draft.currency_code ?? "")} → ${r.outcome}${r.order_id ? ` (order ${r.order_id}, ${r.order_status})` : ""}${r.link ? ` link: ${r.link}` : ""}${r.error ? ` — ${r.error}` : ""}`),
      ].join("\n");
      return { ...result(text, { environment: envLabel(ctx), draft_id, rows }), isError: count("failed") === rows.length };
    }),
  );

  server.registerTool(
    "resend_reward",
    {
      title: "Resend reward",
      description: "Resend a reward email/SMS. Tremendous only allows this after a delivery failure (delivery_status FAILED). Optionally correct the email (EMAIL rewards) or the phone (PHONE rewards), not both.",
      inputSchema: z.object({
        id: z.string().describe("Reward ID"),
        updated_email: z.email().optional().describe("Send to this corrected email instead"),
        updated_phone: z.string().optional().describe("Send to this corrected phone instead"),
      }),
      annotations: DESTRUCTIVE,
    },
    ({ id, updated_email, updated_phone }) => guard(async () => {
      if (updated_email && updated_phone) return errorResult("Give updated_email or updated_phone, not both.");
      const body = Object.fromEntries(Object.entries({ updated_email, updated_phone }).filter(([, v]) => v));
      await ctx.client.post(`/rewards/${encodeURIComponent(id)}/resend`, Object.keys(body).length ? body : undefined);
      return result(`${envLabel(ctx)} · Reward ${id} resent${updated_email ? ` to ${updated_email}` : updated_phone ? ` to ${updated_phone}` : ""}.`, { id, resent: true });
    }),
  );

  server.registerTool(
    "cancel_reward",
    {
      title: "Cancel reward",
      description: "Cancel a reward and refund its value. Tremendous only allows this for rewards that are not redeemed and not expired (typically after a delivery failure).",
      inputSchema: z.object({ id: z.string().describe("Reward ID") }),
      annotations: DESTRUCTIVE,
    },
    ({ id }) => guard(async () => {
      await ctx.client.post(`/rewards/${encodeURIComponent(id)}/cancel`);
      return result(`${envLabel(ctx)} · Reward ${id} canceled.`, { id, canceled: true });
    }),
  );

  server.registerTool(
    "generate_reward_link",
    {
      title: "Generate reward link",
      description: "Create a new redemption link for a LINK-delivery reward (other rewards return 403). WARNING: anyone with this link can redeem the reward. Share it only with the recipient.",
      inputSchema: z.object({ id: z.string().describe("Reward ID") }),
      annotations: DESTRUCTIVE,
    },
    ({ id }) => guard(async () => {
      const { reward } = await ctx.client.post<{ reward: { id: string; link: string } }>(`/rewards/${encodeURIComponent(id)}/generate_link`);
      return result(`${envLabel(ctx)} · Redemption link for ${id} (bearer link, do not share widely): ${reward.link}`, { reward });
    }),
  );

  for (const action of ["approve", "reject"] as const) {
    server.registerTool(
      `${action}_order`,
      {
        title: action === "approve" ? "Approve order" : "Reject order",
        description:
          (action === "approve"
            ? "Approve an order in status PENDING APPROVAL so Tremendous executes it and sends the reward(s). "
            : "Reject an order in status PENDING APPROVAL; its rewards are not sent. ") +
          'Needs "Allow approvals via API" in Tremendous Team settings → Order approvals, otherwise Tremendous answers 403. Use list_orders with status "PENDING APPROVAL" to find them.',
        inputSchema: z.object({ id: z.string().describe("Order ID") }),
        annotations: DESTRUCTIVE,
      },
      ({ id }) => guard(async () => {
        const { order } = await ctx.client.post<{ order: Order }>(`/order_approvals/${encodeURIComponent(id)}/${action}`);
        return result(`${envLabel(ctx)} · Order ${id} ${action === "approve" ? "approved" : "rejected"}; status now ${order.status}.`, { order });
      }),
    );
  }
}
