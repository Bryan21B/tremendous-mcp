// Non-secret settings. The environment defaults to the Tremendous sandbox
// (testflight). Set TREMENDOUS_ENV=production to move real money.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Repository root (one level above build/ or src/). Used in setup hints. */
export const PROJECT_DIR = resolve(import.meta.dirname, "..");

export type TremendousEnv = "sandbox" | "production";

export interface Config {
  env: TremendousEnv;
  host: string;
  apiBase: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  redirectUri: string;
  tokenFile: string;
}

const HOSTS: Record<TremendousEnv, string> = {
  sandbox: "https://testflight.tremendous.com",
  production: "https://api.tremendous.com",
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = (env.TREMENDOUS_ENV ?? "sandbox").toLowerCase();
  if (raw !== "sandbox" && raw !== "production") {
    throw new Error(`TREMENDOUS_ENV must be "sandbox" or "production", not "${raw}".`);
  }
  const host = HOSTS[raw];
  const dir = env.TREMENDOUS_TOKEN_DIR ?? join(homedir(), ".config", "tremendous-mcp");
  return {
    env: raw,
    host,
    apiBase: `${host}/api/v2`,
    authorizeUrl: `${host}/oauth/authorize`,
    tokenUrl: `${host}/oauth/token`,
    scopes: env.TREMENDOUS_SCOPES ?? "default",
    // Tremendous only accepts https redirect URIs. Nothing has to listen there:
    // the login reads the code from the address the browser ends on.
    redirectUri: env.TREMENDOUS_REDIRECT_URI ?? "https://localhost:8787/callback",
    tokenFile: join(dir, `tokens.${raw}.json`),
  };
}

export function readClientCredentials(env: NodeJS.ProcessEnv = process.env): { clientId: string; clientSecret: string } {
  const clientId = env.TREMENDOUS_CLIENT_ID?.trim();
  const clientSecret = env.TREMENDOUS_CLIENT_SECRET?.trim();
  const missing = [!clientId && "TREMENDOUS_CLIENT_ID", !clientSecret && "TREMENDOUS_CLIENT_SECRET"].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `Missing ${missing.join(", ")}. Set them in the environment, or launch through 1Password: op run --env-file=.env.op -- node build/index.js`,
    );
  }
  if (clientId!.startsWith("op://") || clientSecret!.startsWith("op://")) {
    throw new Error("Client credentials are unresolved 1Password references (op://...). Launch through `op run --env-file=.env.op -- ...`.");
  }
  return { clientId: clientId!, clientSecret: clientSecret! };
}
