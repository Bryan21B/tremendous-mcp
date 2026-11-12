// Drives the real MCP server through an MCP client over an in-memory transport,
// with the Tremendous API faked. Checks the tool surface, annotations, the UI
// resources, and the send flow (idempotency, partial failure, 402 stop).
import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/server.js";
import { fakeApi, fakeClient, type FakeApi } from "./fake-api.js";

async function connect(api: FakeApi = fakeApi()) {
  const server = createServer({ client: fakeClient(api), config: { env: "sandbox" } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return { client, api };
}

const text = (r: { content?: unknown }) => ((r.content as { text: string }[])[0]?.text ?? "");

const draft = {
  campaign_id: "CAMP1",
  currency_code: "EUR",
  recipients: [
    { name: "Ada", email: "ada@example.com", amount: 25 },
    { name: "Bob", email: "bob@example.com", amount: 15 },
  ],
};

describe("tool surface", () => {
  it("lists every tool with the right safety annotations", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const write = ["send_rewards", "resend_reward", "cancel_reward", "generate_reward_link", "approve_order", "reject_order"];
    const read = ["get_account", "list_funding_sources", "list_products", "list_campaigns", "get_campaign", "list_orders", "get_order", "get_reward", "list_rewards", "review_rewards"];
    expect(Object.keys(byName).sort()).toEqual([...write, ...read].sort());
    for (const n of write) expect(byName[n].annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    for (const n of read) expect(byName[n].annotations).toMatchObject({ readOnlyHint: true });
    expect((byName.list_rewards._meta as any).ui.resourceUri).toBe("ui://tremendous/rewards.html");
    expect((byName.review_rewards._meta as any).ui.resourceUri).toBe("ui://tremendous/send.html");
  });

  it("serves both UI resources as MCP App HTML", async () => {
    const { client } = await connect();
    for (const uri of ["ui://tremendous/rewards.html", "ui://tremendous/send.html"]) {
      const r = await client.readResource({ uri });
      expect(r.contents[0].mimeType).toBe("text/html;profile=mcp-app");
      expect((r.contents[0] as { text: string }).text).toMatch(/<html|<!doctype/i);
    }
  });
});

describe("reading", () => {
  it("get_account shows the environment and balance", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "get_account", arguments: {} });
    expect(text(r)).toMatch(/SANDBOX/);
    expect(text(r)).toMatch(/1000\.00 EUR available/);
  });

  it("list_rewards summarizes by recipient", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "list_rewards", arguments: { email: "person2" } });
    const sc = r.structuredContent as any;
    expect(sc.recipients).toHaveLength(1);
    expect(sc.rows.length).toBeGreaterThan(0);
    expect(text(r)).toMatch(/person2@example.com/);
  });

  it("review_rewards never writes and flags problems", async () => {
    const { client, api } = await connect();
    const r = await client.callTool({ name: "review_rewards", arguments: { recipients: [{ name: "No email", amount: 10 }] } });
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
    const sc = r.structuredContent as any;
    expect(sc.errors.join(" ")).toMatch(/campaign_id or products/);
    expect(sc.errors.join(" ")).toMatch(/EMAIL delivery needs an email/);
    expect(sc.draft_id).toMatch(/^[a-f0-9]{8}$/);
  });
});

describe("sending", () => {
  it("creates one order per recipient with external_id from draft_id", async () => {
    const { client, api } = await connect();
    const r = await client.callTool({ name: "send_rewards", arguments: { ...draft, draft_id: "abc123" } });
    const posts = api.calls.filter((c) => c.method === "POST" && c.path === "/orders");
    const ids = posts.map((p) => (p.body as any).external_id);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^mcp-abc123-[0-9a-f]{10}$/);
    expect(new Set(ids).size).toBe(2);
    expect((posts[0].body as any).reward).toMatchObject({ campaign_id: "CAMP1", value: { denomination: 25, currency_code: "EUR" }, recipient: { email: "ada@example.com" }, delivery: { method: "EMAIL" } });
    expect((posts[0].body as any).payment).toEqual({ funding_source_id: "BALANCE" });
    expect(text(r)).toMatch(/2 sent/);
  });

  it("sending the same draft twice does not pay twice", async () => {
    const { client, api } = await connect();
    await client.callTool({ name: "send_rewards", arguments: { ...draft, draft_id: "same1" } });
    const again = await client.callTool({ name: "send_rewards", arguments: { ...draft, draft_id: "same1" } });
    expect(api.orders.size).toBe(2);
    expect(text(again)).toMatch(/2 already sent/);
  });

  it("a retry with a changed recipient list never pays the same person twice", async () => {
    // Ada fails (bad email), Bob is paid. The retry drops Ada: Bob must NOT be paid again.
    const api = fakeApi(undefined, { failOrderFor: "ada@example.com" });
    const { client } = await connect(api);
    await client.callTool({ name: "send_rewards", arguments: { ...draft, draft_id: "retry1" } });
    const retry = await client.callTool({ name: "send_rewards", arguments: { ...draft, recipients: [draft.recipients[1]], draft_id: "retry1" } });
    expect(api.orders.size).toBe(1);
    expect((retry.structuredContent as any).rows[0].outcome).toBe("already_sent");
    // Reordered and with a new recipient added: only the new one is paid.
    const third = await client.callTool({ name: "send_rewards", arguments: { ...draft, recipients: [{ email: "cy@example.com", amount: 5 }, draft.recipients[1]], draft_id: "retry1" } });
    expect((third.structuredContent as any).rows.map((r: any) => r.outcome)).toEqual(["sent", "already_sent"]);
    expect(api.orders.size).toBe(2);
  });

  it("changing the amount for an already-paid recipient conflicts instead of paying again", async () => {
    const { client, api } = await connect();
    await client.callTool({ name: "send_rewards", arguments: { ...draft, draft_id: "amt001" } });
    const r = await client.callTool({ name: "send_rewards", arguments: { ...draft, recipients: [{ ...draft.recipients[0], amount: 99 }], draft_id: "amt001" } });
    expect((r.structuredContent as any).rows[0].error).toMatch(/409/);
    expect(api.orders.size).toBe(2);
  });

  it("intentional duplicate recipients get distinct external_ids", async () => {
    const { client, api } = await connect();
    await client.callTool({ name: "send_rewards", arguments: { ...draft, recipients: [draft.recipients[0], draft.recipients[0]], draft_id: "dup001" } });
    expect(api.orders.size).toBe(2);
  });

  it("refuses to send an invalid draft", async () => {
    const { client, api } = await connect();
    const r = await client.callTool({ name: "send_rewards", arguments: { recipients: [{ email: "a@b.co", amount: 5 }], draft_id: "bad01" } });
    expect(r.isError).toBe(true);
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("reports a per-row failure and continues", async () => {
    const { client } = await connect(fakeApi(undefined, { failOrderFor: "ada@example.com" }));
    const r = await client.callTool({ name: "send_rewards", arguments: { ...draft, draft_id: "part01" } });
    const rows = (r.structuredContent as any).rows;
    expect(rows.map((x: any) => x.outcome)).toEqual(["failed", "sent"]);
    expect(r.isError).toBeFalsy();
  });

  it("stops after 402 insufficient funds", async () => {
    const { client, api } = await connect(fakeApi(undefined, { status402After: 0 }));
    const r = await client.callTool({ name: "send_rewards", arguments: { ...draft, draft_id: "poor01" } });
    expect(api.calls.filter((c) => c.method === "POST").length).toBe(1);
    expect((r.structuredContent as any).rows[1].error).toMatch(/Not attempted/);
    expect(r.isError).toBe(true);
  });
});

describe("approvals and reward actions", () => {
  it("approve_order and reject_order call /order_approvals", async () => {
    const { client, api } = await connect();
    expect(text(await client.callTool({ name: "approve_order", arguments: { id: "O9" } }))).toMatch(/approved; status now EXECUTED/);
    expect(text(await client.callTool({ name: "reject_order", arguments: { id: "O9" } }))).toMatch(/rejected/);
    expect(api.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/order_approvals/O9/approve", "/order_approvals/O9/reject"]);
  });

  it("resend_reward rejects email and phone together", async () => {
    const { client, api } = await connect();
    const r = await client.callTool({ name: "resend_reward", arguments: { id: "R1", updated_email: "x@y.co", updated_phone: "+33600000000" } });
    expect(r.isError).toBe(true);
    expect(api.calls.length).toBe(0);
  });
});
