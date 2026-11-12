// One-time Tremendous login (OAuth 2.0 authorization code).
// Usage: op run --env-file=.env.op -- npm run login
//
// Tremendous only accepts https redirect URIs, so there is no local callback
// server. After you allow access, the browser goes to the redirect URI
// (https://localhost:8787/callback by default) and shows an error page because
// nothing listens there. That is expected: the code is in the address bar.
// Copy the address, come back, press Enter: the script reads the clipboard.
// The tokens go to ~/.config/tremendous-mcp/tokens.<env>.json (0600). No token is printed.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { loadConfig, readClientCredentials } from "./config.js";
import { makeTokenRequester, TokenStore } from "./token-store.js";

const config = loadConfig();
const { clientId, clientSecret } = readClientCredentials();
const requestToken = makeTokenRequester(config.tokenUrl, clientId, clientSecret);
const store = new TokenStore(config.tokenFile, requestToken);
const state = randomBytes(16).toString("base64url");

const auth = new URL(config.authorizeUrl);
auth.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: config.redirectUri,
  response_type: "code",
  scope: config.scopes,
  state,
}).toString();

console.log(`Environment: ${config.env.toUpperCase()} (${config.host})`);
console.log(`Redirect URI (must be registered in the Tremendous app): ${config.redirectUri}\n`);

const redirectBase = config.redirectUri.split("?")[0];

/** Checks a callback address. Returns the code, or why the address is not usable. */
function parseCallback(address: string): { code: string } | { problem: string; fatal?: boolean } {
  if (!address) return { problem: "The clipboard is empty." };
  if (address.includes("/oauth/authorize")) {
    return {
      problem:
        "This is the Tremendous login address, not the callback. Finish the login and click Allow/Authorize first. " +
        `The browser must end on ${redirectBase}?code=...`,
    };
  }
  if (!address.startsWith(redirectBase)) {
    return { problem: `The address does not start with ${redirectBase}. Copy the address of the error page.` };
  }
  const back = new URL(address);
  if (back.searchParams.get("error")) {
    const reason = `${back.searchParams.get("error")} ${back.searchParams.get("error_description") ?? ""}`.trim();
    return { problem: `Tremendous returned an error: ${reason}`, fatal: true };
  }
  if (back.searchParams.get("state") !== state) {
    return { problem: "The state value does not match: this address comes from an older login attempt." };
  }
  const code = back.searchParams.get("code");
  return code ? { code } : { problem: "The address has no code." };
}

let code: string;
if (!process.stdin.isTTY) {
  // Non-interactive: print the address, read the callback address from stdin.
  console.log(`AUTHORIZE_URL ${auth}`);
  const rl = createInterface({ input: process.stdin });
  const r = parseCallback((await new Promise<string>((res) => rl.once("line", res))).trim());
  rl.close();
  if (!("code" in r)) {
    console.error(r.problem);
    process.exit(1);
  }
  code = r.code;
} else {
  console.log("1. Your browser opens the Tremendous login. Log in and allow access.");
  console.log(`2. The browser then shows an error page on ${new URL(config.redirectUri).host}. This is expected.`);
  console.log(`   Its address starts with ${redirectBase}?code=...`);
  console.log("3. Copy that full address from the address bar (Cmd+L, Cmd+C).");
  console.log("4. Come back here and press Enter. (Or paste the address, then press Enter.)\n");
  spawnSync("open", [auth.toString()]);
  console.log(`If the browser did not open, go to:\n${auth}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const typed = (await rl.question("Press Enter after you copied the address (or type q to quit)... ")).trim();
    if (typed === "q") process.exit(1);
    const r = parseCallback(typed || spawnSync("pbpaste", { encoding: "utf8" }).stdout.trim());
    if ("code" in r) {
      code = r.code;
      break;
    }
    console.error(`\n${r.problem}\n`);
    if (r.fatal) process.exit(1);
  }
  rl.close();
}

console.log("Exchanging the code with Tremendous...");
const tokens = await requestToken({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri });
await store.save(tokens);
console.log(
  `Saved tokens to ${config.tokenFile} (access token expires in ${tokens.expires_in || "?"}s, scope: ${tokens.scope ?? config.scopes}).`,
);

const res = await fetch(`${config.apiBase}/organizations`, {
  headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json" },
});
if (res.ok) {
  const { organizations } = (await res.json()) as { organizations: { name: string; id: string }[] };
  console.log(`Connected to: ${organizations.map((o) => `${o.name} (${o.id})`).join(", ")}`);
} else {
  console.log(`Warning: test call GET /organizations returned ${res.status}.`);
}
