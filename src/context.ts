import type { TremendousClient } from "./client.js";
import type { Config } from "./config.js";

export interface Ctx {
  client: TremendousClient;
  config: Pick<Config, "env">;
}

export const REWARDS_VIEW = "ui://tremendous/rewards.html";
export const SEND_VIEW = "ui://tremendous/send.html";

export const envLabel = (ctx: Ctx) => (ctx.config.env === "production" ? "PRODUCTION" : "SANDBOX");

/** Tool result with a text summary (for hosts without UI) and structured data. */
export function result(text: string, data?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    ...(data ? { structuredContent: data } : {}),
  };
}

/** Run a tool body; turn thrown errors into an MCP error result instead of a protocol error. */
export async function guard<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof errorResult>> {
  try {
    return await fn();
  } catch (e) {
    return errorResult((e as Error).message);
  }
}

export function errorResult(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

export function money(amount: number | undefined, currency = "") {
  return amount === undefined ? "?" : `${amount.toFixed(2)} ${currency}`.trim();
}

export function fmtTotals(t: Record<string, number>) {
  const parts = Object.entries(t).map(([c, v]) => money(v, c));
  return parts.length ? parts.join(", ") : "0";
}
