// Builds the MCP server: tools + the two MCP Apps UI resources.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { PROJECT_DIR, VERSION } from "./config.js";
import { REWARDS_VIEW, SEND_VIEW, type Ctx } from "./context.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";

const DIST = (file: string) => fileURLToPath(new URL(`../dist/${file}`, import.meta.url));

async function readView(file: string): Promise<string> {
  try {
    return await readFile(DIST(file), "utf8");
  } catch {
    return `<!doctype html><meta charset="utf-8"><p>UI not built. Run <code>npm run build</code> in ${PROJECT_DIR}.</p>`;
  }
}

export function createServer(ctx: Ctx): McpServer {
  const server = new McpServer(
    { name: "tremendous", version: VERSION },
    {
      instructions:
        `Tremendous rewards (${ctx.config.env === "production" ? "PRODUCTION: real money" : "SANDBOX: fake money"}). ` +
        "To send rewards: call review_rewards first so the user sees the draft, then send_rewards with the same draft_id. " +
        "To see who received rewards: list_rewards. Orders in PENDING APPROVAL can be approved with approve_order.",
    },
  );

  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);

  for (const [name, uri, file, description] of [
    ["Rewards dashboard", REWARDS_VIEW, "rewards.html", "Who received rewards: totals, filters and per-reward actions"],
    ["Send rewards", SEND_VIEW, "send.html", "Editable review of a reward batch with a Send button"],
  ] as const) {
    registerAppResource(server, name, uri, { description }, async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: await readView(file) }],
    }));
  }

  return server;
}
