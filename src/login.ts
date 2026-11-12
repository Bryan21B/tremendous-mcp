// One-time Tremendous login (OAuth 2.0 authorization code).
// Usage: op run --env-file=.env.op -- npm run login
//
// Tremendous only accepts https redirect URIs. When the redirect URI is
// https://localhost:<port>/..., the script listens there with a self-signed
// certificate (made once with openssl). The browser warns that the connection
// is not private; continue to localhost and the script gets the code itself.
//
// Fallback: copy the callback address (it has ?code=...) and press Enter; the
// script reads the clipboard. Chrome can keep the authorize address in the
// address bar when the redirect fails: find the callback in chrome://history.
//
// The tokens go to ~/.config/tremendous-mcp/tokens.<env>.json (0600). No token is printed.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { dirname, join } from "node:path";
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
  const ac = new AbortController();
  const listener = startCallbackServer((c) => ac.abort(c));
  console.log("1. Your browser opens the Tremendous login. Log in and allow access.");
  if (listener) {
    console.log("2. The browser then warns that the connection to localhost is not private.");
    console.log("   Click Advanced, then Proceed to localhost. This script then gets the code by itself.");
    console.log(`3. If that does not work, copy the address that starts with ${redirectBase}?code=...`);
    console.log("   (Chrome: find it in chrome://history) and press Enter here.\n");
  } else {
    console.log(`2. The browser then shows an error page on ${new URL(config.redirectUri).host}. This is expected.`);
    console.log(`3. Copy the address that starts with ${redirectBase}?code=... If the address bar does not show it,`);
    console.log("   find it in your browser history (Chrome: chrome://history). Then press Enter here.\n");
  }
  spawnSync("open", [auth.toString()]);
  console.log(`If the browser did not open, go to:\n${auth}\n`);
  code = await promptForCode(ac.signal);
  listener?.close();
}

/** Ask for the callback address until it is valid, or until the signal carries a code from the listener. */
async function promptForCode(signal: AbortSignal): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      let typed: string;
      try {
        typed = (
          await rl.question("Waiting for the browser, or press Enter after you copied the address (q to quit)... ", {
            signal,
          })
        ).trim();
      } catch {
        console.log("\nReceived the code from the browser.");
        return signal.reason as string;
      }
      if (typed === "q") process.exit(1);
      const r = parseCallback(typed || spawnSync("pbpaste", { encoding: "utf8" }).stdout.trim());
      if ("code" in r) return r.code;
      console.error(`\n${r.problem}\n`);
      if (r.fatal) process.exit(1);
    }
  } finally {
    rl.close();
  }
}

/**
 * Listen on the https://localhost redirect URI with a self-signed certificate.
 * Returns null when the redirect URI is not local https, or when openssl is missing.
 */
function startCallbackServer(onCode: (code: string) => void): Server | null {
  const uri = new URL(config.redirectUri);
  if (uri.protocol !== "https:" || !["localhost", "127.0.0.1"].includes(uri.hostname)) return null;
  const tls = localCertificate();
  if (!tls) return null;
  const page = (title: string, text: string) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:2rem"><h1 style="font-size:1.2rem">${title}</h1><p>${text}</p></body>`;
  const server = createServer(tls, (req, res) => {
    const url = new URL(req.url ?? "/", config.redirectUri);
    if (url.pathname !== uri.pathname) {
      res.writeHead(404).end();
      return;
    }
    const r = parseCallback(url.toString());
    if ("code" in r) {
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(page("Code received", "Go back to the terminal to finish the login. You can close this tab."));
      onCode(r.code);
    } else {
      res
        .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
        .end(page("Login failed", r.problem.replace(/</g, "&lt;")));
      console.error(`\n${r.problem}`);
      if (r.fatal) process.exit(1);
    }
  });
  server.on("error", (e) =>
    console.error(`\nCannot listen on ${uri.host} (${(e as Error).message}). Copy the address instead.`),
  );
  server.listen(Number(uri.port || 443), uri.hostname === "localhost" ? "127.0.0.1" : uri.hostname);
  return server;
}

/** Self-signed certificate for localhost, made once with openssl and kept next to the tokens. */
function localCertificate(): { key: Buffer; cert: Buffer } | null {
  const dir = join(dirname(config.tokenFile), "tls");
  const key = join(dir, "localhost-key.pem");
  const cert = join(dir, "localhost-cert.pem");
  if (!existsSync(key) || !existsSync(cert)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const r = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "3650",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    if (r.status !== 0) return null;
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

console.log("Exchanging the code with Tremendous...");
let tokens: Awaited<ReturnType<typeof requestToken>>;
try {
  tokens = await requestToken({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri });
} catch (e) {
  console.error(`Tremendous refused the code: ${(e as Error).message}`);
  console.error(
    "Check the client ID and secret, and that the redirect URI matches the app exactly. Codes expire after a few minutes: run the login again.",
  );
  process.exit(1);
}
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
