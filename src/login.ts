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

let pasted: string;
if (!process.stdin.isTTY) {
  // Non-interactive: print the address, read the callback address from stdin.
  console.log(`AUTHORIZE_URL ${auth}`);
  const rl = createInterface({ input: process.stdin });
  pasted = (await new Promise<string>((res) => rl.once("line", res))).trim();
  rl.close();
} else {
  console.log("1. Your browser opens the Tremendous login. Log in and allow access.");
  console.log(`2. The browser then shows an error page on ${new URL(config.redirectUri).host}. This is expected.`);
  console.log("3. Copy the full address from the address bar (Cmd+L, Cmd+C).");
  console.log("4. Come back here and press Enter. (Or paste the address, then press Enter.)\n");
  spawnSync("open", [auth.toString()]);
  console.log(`If the browser did not open, go to:\n${auth}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question("Press Enter after you copied the address... ")).trim();
  rl.close();
  pasted = typed || spawnSync("pbpaste", { encoding: "utf8" }).stdout.trim();
}

const redirectBase = config.redirectUri.split("?")[0];
if (!pasted.startsWith(redirectBase)) {
  console.error(
    `The address does not start with ${redirectBase}. Run \`npm run login\` again and copy the address of the error page.`,
  );
  process.exit(1);
}
const back = new URL(pasted);
if (back.searchParams.get("error")) {
  console.error(
    `Tremendous returned an error: ${back.searchParams.get("error")} ${back.searchParams.get("error_description") ?? ""}`,
  );
  process.exit(1);
}
if (back.searchParams.get("state") !== state) {
  console.error("The state value does not match. Run `npm run login` again and copy the newest address.");
  process.exit(1);
}
const code = back.searchParams.get("code");
if (!code) {
  console.error("The address has no code.");
  process.exit(1);
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
