#!/usr/bin/env node
// stdio entry point for Claude Desktop / Claude Code.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { TremendousClient } from "./client.js";
import { loadConfig, readClientCredentials } from "./config.js";
import { createServer } from "./server.js";
import { TokenStore, makeTokenRequester } from "./token-store.js";

const config = loadConfig();

// Read credentials lazily so the server still starts (and lists its tools)
// when they are missing; each tool call then returns the setup error.
const store = new TokenStore(config.tokenFile, (body) => {
  const { clientId, clientSecret } = readClientCredentials();
  return makeTokenRequester(config.tokenUrl, clientId, clientSecret)(body);
});
const client = new TremendousClient(config.apiBase, store);

serveStdio(() => createServer({ client, config }));
