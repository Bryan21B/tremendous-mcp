// Live end-to-end check against the Tremendous SANDBOX over stdio, as a host would.
// Usage: op run --env-file=.env.op -- npm run smoke -- you+test@example.com [CAMPAIGN_ID]
// Refuses to run against production.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

if ((process.env.TREMENDOUS_ENV ?? "sandbox") !== "sandbox") {
  console.error("smoke only runs with TREMENDOUS_ENV=sandbox.");
  process.exit(2);
}
const [email, campaignArg] = process.argv.slice(2);
if (!email) { console.error("Usage: npm run smoke -- <test email> [campaign_id]"); process.exit(2); }

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL("./index.js", import.meta.url).pathname], env: process.env as Record<string, string> }));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = (r.content as { text: string }[])[0]?.text ?? "";
  console.log(`\n## ${name}${r.isError ? " (ERROR)" : ""}\n${t.slice(0, 1200)}`);
  return r;
};

console.log((await client.listTools()).tools.map((t) => t.name).join(", "));
await call("get_account");
const campaigns = (await call("list_campaigns")).structuredContent as { campaigns: { id: string }[] };
const campaign_id = campaignArg ?? campaigns.campaigns[0]?.id;
if (!campaign_id) { console.error("No campaign in the sandbox. Create one in the Tremendous dashboard or pass a campaign_id."); process.exit(1); }

const draft = { campaign_id, recipients: [{ name: "Smoke test", email, amount: 1 }] };
const review = (await call("review_rewards", draft)).structuredContent as { draft_id: string };
await call("send_rewards", { ...draft, draft_id: review.draft_id });
await call("send_rewards", { ...draft, draft_id: review.draft_id }); // must say "already sent"
await call("list_rewards", { email });
await call("list_orders", { status: "PENDING APPROVAL", limit: 20 });
await client.close();
