import { z } from "zod";

export const DeliveryStatus = z.enum(["SCHEDULED", "FAILED", "SUCCEEDED", "PENDING"]);
export const DeliveryMethod = z.enum(["EMAIL", "LINK", "PHONE"]);

export const RecipientInput = z.object({
  name: z.string().min(1).optional(),
  email: z.email().optional(),
  phone: z.string().min(5).optional().describe("Include the country code with +, e.g. +33612345678"),
  amount: z.number().positive().describe("Reward value in the order currency, e.g. 25 for 25.00"),
});

export const RewardDraftInput = z.object({
  recipients: z.array(RecipientInput).min(1).max(100),
  currency_code: z.string().length(3).optional().describe("ISO 4217, e.g. EUR. Defaults to the organization currency."),
  campaign_id: z.string().optional().describe("Tremendous campaign ID. Either campaign_id or products is required."),
  products: z.array(z.string()).optional().describe("Product IDs the recipient can choose from. Overrides the campaign's products."),
  funding_source_id: z.string().default("BALANCE").describe("Funding source ID, or BALANCE / INVOICE / INVOICE_THEN_BALANCE."),
  delivery_method: DeliveryMethod.default("EMAIL"),
  deliver_at: z.string().optional().describe("YYYY-MM-DD, within the next year. Delivered at 12pm org time."),
  language: z.string().length(2).optional(),
  sender_name: z.string().optional(),
  subject_line: z.string().optional(),
  message: z.string().optional(),
});
export type RewardDraft = z.infer<typeof RewardDraftInput>;

/** errors: Tremendous would reject (part of) the batch. warnings: probably a mistake. */
export function validateDraft(d: RewardDraft): { errors: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!d.campaign_id && !d.products?.length) problems.push("Set campaign_id or products.");
  d.recipients.forEach((r, i) => {
    const who = r.email ?? r.phone ?? r.name ?? `#${i + 1}`;
    if (d.delivery_method === "EMAIL" && !r.email) problems.push(`Recipient ${who}: EMAIL delivery needs an email.`);
    if (d.delivery_method === "PHONE" && !r.phone) problems.push(`Recipient ${who}: PHONE delivery needs a phone number.`);
    if (!r.email && !r.phone && !r.name) problems.push(`Recipient #${i + 1}: give at least a name, email or phone.`);
  });
  const seen = new Set<string>();
  for (const r of d.recipients) {
    const k = (r.email ?? r.phone ?? "").toLowerCase();
    if (k && seen.has(k)) warnings.push(`Recipient ${k} appears more than once.`);
    if (k) seen.add(k);
  }
  return { errors: problems, warnings };
}

export function draftTotal(d: RewardDraft): number {
  return Math.round(d.recipients.reduce((s, r) => s + r.amount, 0) * 100) / 100;
}
